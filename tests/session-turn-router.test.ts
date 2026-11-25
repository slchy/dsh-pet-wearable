/**
 * 轮次机的 INV-8：过期票据、吞尾、新旧轮分家。不碰进程，也不碰真实会话目录。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isMainSession, TurnRouter } from '../src/session/turn-router.ts';

const ticket = (no: number, gen = 1) => ({ no, gen });

test('子会话过不了 openSessionId，轮号也不会被写上', () => {
  assert.equal(isMainSession('child', 'main'), false);
  assert.equal(isMainSession('', 'main'), false);
  assert.equal(isMainSession('main', null), false);
  assert.equal(isMainSession('main', 'main'), true);

  const blocked = new TurnRouter();
  blocked.armForeground(ticket(1), '问');
  blocked.observeTurnBoundary(
    { type: 'turn/start', data: { turn: 9 } },
    'child',
    'main',
    false,
  );
  blocked.detachTurn(undefined, true);
  assert.equal(blocked.view().detachedLease?.turnNo, null, '子会话的 turn/start 不能变成放手轮号');

  const allowed = new TurnRouter();
  allowed.armForeground(ticket(1), '问');
  allowed.observeTurnBoundary(
    { type: 'turn/start', data: { turn: 9 } },
    'main',
    'main',
    false,
  );
  allowed.detachTurn(undefined, true);
  assert.equal(allowed.view().detachedLease?.turnNo, 9);

  const router = new TurnRouter();
  let woke = false;
  void router.armForeground(ticket(1), '问').then(() => { woke = true; });
  router.consumeStatus('idle', 'child', 'main');
  assert.equal(woke, false);
  assert.equal(router.view().turnPhase, 'prompting_rpc');
});

test('过期票据的放手和取消都是空操作', async () => {
  const armed = new TurnRouter();
  let fired = false;
  void armed.armForeground(ticket(1), '问').then(() => { fired = true; });
  const detached = armed.detachTurn(ticket(99), true);
  await Promise.resolve();
  assert.equal(fired, false);
  assert.equal(armed.view().detachedLease, null);
  assert.equal(armed.view().turnPhase, 'prompting_rpc');
  assert.ok(detached.some((effect) => effect.type === 'log' && effect.line.includes('票据过期')));

  const finished = new TurnRouter();
  finished.armForeground(ticket(1), '问');
  finished.finishForeground();
  const late = finished.detachTurn(ticket(1), true);
  assert.equal(finished.view().detachedLease, null);
  assert.equal(finished.view().turnPhase, 'idle');
  assert.ok(late.some((effect) => effect.type === 'log' && effect.line.includes('票据过期')));

  const running = new TurnRouter();
  running.armForeground(ticket(1), '查一下');
  running.detachTurn(undefined, true);
  running.finishForeground();
  assert.equal(running.view().turnPhase, 'detached_running');
  const stale = running.cancelTurn({ ticket: ticket(99, 7), hasProc: true, sessionId: 's' });
  assert.equal(stale.type, 'stale');
  assert.equal(running.view().detachedLease?.userText, '查一下');
  assert.equal(running.view().turnPhase, 'detached_running');

  const dropped = running.cancelTurn({ hasProc: true, sessionId: 's' });
  assert.equal(dropped.type, 'cancel');
  if (dropped.type === 'cancel') assert.equal(dropped.droppedLease, true);
  assert.equal(running.view().detachedLease, null);
  assert.equal(running.view().turnPhase, 'idle');
});

test('迟到的 turn/start 被吞尾吃掉，残余消息不进新轮', async () => {
  const router = new TurnRouter();
  const began = router.consumeStatus('running', 'main', 'main');
  assert.ok(began.some((effect) => effect.type === 'log' && effect.line.includes('自发开了一轮')));
  assert.equal(router.view().spontaneous.isActive, true);

  router.prepareIncomingPrompt();
  assert.equal(router.view().tailSwallow?.phase, 'awaiting_old_turn_start');
  assert.equal(router.view().spontaneous.isActive, false);

  let woke = false;
  void router.armForeground(ticket(2), '新问题').then(() => { woke = true; });
  router.noteTurnStart(4);
  assert.equal(router.view().tailSwallow?.phase, 'awaiting_old_idle');
  assert.equal(router.view().tailSwallow?.turnNo, 4);
  assert.equal(router.acceptAssistantText({ turn: 4 }, '旧自发残余'), false);
  assert.equal(router.view().assistantText, '');

  router.consumeStatus('idle', 'main', 'main');
  await Promise.resolve();
  assert.equal(woke, false, '旧自发轮的 idle 不能叫醒新一轮');
  assert.equal(router.view().tailSwallow, null);
});

test('新旧轮文本分家', () => {
  const router = new TurnRouter();
  router.armForeground(ticket(1), '旧问');
  router.noteTurnStart(1);
  router.detachTurn(undefined, true);

  router.armForeground(ticket(2), '新问');
  router.noteTurnStart(2);
  assert.equal(router.acceptAssistantText({ turn: 1 }, '旧答案'), false);
  assert.equal(router.acceptAssistantText({ turn: 2 }, '新答案'), true);
  assert.equal(router.view().detachedLease?.text, '旧答案');
  assert.equal(router.view().assistantText, '新答案');
  assert.equal(router.view().activeUserText, '新问');
});

test('newerForeground 不吞新轮的 idle', async () => {
  const router = new TurnRouter();
  router.armForeground(ticket(1), '旧问');
  router.noteTurnStart(1);
  router.acceptAssistantText({ turn: 1 }, '旧答案');
  router.detachTurn(undefined, true);

  let woke = false;
  void router.armForeground(ticket(2), '新问').then(() => { woke = true; });
  router.noteTurnStart(2);
  const effects = router.noteTurnEnd(1, { reason: { kind: 'completed' } }, true);
  assert.equal(router.view().tailSwallow, null);
  assert.equal(router.view().turnPhase, 'prompting_rpc');
  assert.ok(effects.some((effect) => effect.type === 'detached-answer'));
  assert.ok(effects.some((effect) => effect.type === 'log' && effect.line.includes('不补播')));

  router.consumeStatus('idle', 'main', 'main');
  await Promise.resolve();
  assert.equal(woke, true, '新轮自己的 idle 必须叫醒等待者');
  assert.equal(router.view().tailSwallow, null);
});

test('空租约不产生回注或播报', () => {
  const bare = new TurnRouter();
  assert.deepEqual(bare.noteTurnEnd(3, undefined, true), []);

  const router = new TurnRouter();
  router.armForeground(ticket(1), '问');
  router.noteTurnStart(1);
  router.detachTurn(undefined, true);
  const effects = router.noteTurnEnd(1, { reason: { kind: 'completed' } }, true);
  assert.equal(
    effects.some((effect) => effect.type === 'detached-answer' || effect.type === 'announce'),
    false,
  );
});

test('finally 只回到 idle 或 detached_running', () => {
  const router = new TurnRouter();
  router.armForeground(ticket(1), 'a');
  router.markAwaitingIdle();
  assert.equal(router.finishForeground(), false);
  assert.equal(router.view().turnPhase, 'idle');

  router.armForeground(ticket(2), 'b');
  router.detachTurn(undefined, true);
  assert.equal(router.finishForeground(), true);
  assert.equal(router.view().turnPhase, 'detached_running');
  assert.equal(router.view().detachedLease?.userText, 'b');
});
