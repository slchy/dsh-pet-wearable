/**
 * 长任务期间用户提问的两种情形（ADR-004 §7「并发策略」）：
 *
 * ```text
 * | 用户说的 | 判定     | 动作                  |
 * | 「好了吗」| 状态查询 | 本地应答，**不占 CLI** |
 * ```
 *
 * 这条是**体验的底线**：它干活时用户问「好了吗」，如果按普通一轮处理，那句话
 * 会排到这一轮之后 —— 几分钟后才被回答，那正是用户重复问、重复打断的起点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STATUS_REPLY, fillerLine, isStatusQuery } from '../src/filler.ts';
import { SessionCore } from '../src/session-core.ts';
import { DialogFsm } from '../src/dialog-fsm.ts';

const noop = (): void => {};

function newCore(): SessionCore {
  return new SessionCore({ imageQuestion: '你看到了什么？', log: noop });
}

/** 把它推到 thinking（一轮已经开跑、还没出声） */
function toThinking(core: SessionCore): void {
  assert.ok(core.fsm.beginTurn());
  assert.equal(core.fsm.state, 'thinking');
}

test('状态查询：常见问法都认得', () => {
  for (const text of [
    '好了吗', '好了吗？', '你好了吗', '还没好吗', '到哪了', '还要多久',
    '在忙什么', '怎么样了', '快了吗', '做完了吗',
    // 真机 05:40:45 漏掉的这一句：动词位必须通配
    '你查好了吗？', '你搜到了吗', '看完了吗', '找到了吗',
  ]) {
    assert.equal(isStatusQuery(text), true, `应当认出：「${text}」`);
  }
});

test('状态查询：带内容的问题不算（那是新任务，要交给模型）', () => {
  for (const text of [
    '那件事好了吗',           // 有指代内容
    '帮我把这个文件改一下好了吗',
    '你看看这台机器上还有哪些 harness',
    '你好',
    '',
  ]) {
    assert.equal(isStatusQuery(text), false, `不该当成状态查询：「${text}」`);
  }
});

test('thinking 期间问「好了吗」→ 本地应答，不开新的一轮', () => {
  const core = newCore();
  toThinking(core);
  const effects = core.dispatch({ type: 'utterance', text: '好了吗' });

  assert.deepEqual(effects, [{ type: 'say', text: STATUS_REPLY }]);
  assert.equal(core.fsm.state, 'thinking', '本地应答不该改动状态机');
  assert.equal(core.turn, 1, '不该开新的一轮');
});

test('listening 期间问「好了吗」→ 照常开一轮（那时它闲着，可以直接答）', () => {
  const core = newCore();
  const effects = core.dispatch({ type: 'utterance', text: '好了吗' });

  assert.ok(effects.some((effect) => effect.type === 'turn'), '闲着时应当正常成轮');
  assert.equal(effects.some((effect) => effect.type === 'say'), false, '不该用本地应答');
});

test('speaking 期间说「好了吗」→ 仍算插话（正在播就该停）', () => {
  const core = newCore();
  const ticket = core.fsm.beginTurn();
  assert.ok(ticket);
  core.fsm.audioStarted(ticket);
  assert.equal(core.fsm.state, 'speaking');

  const effects = core.dispatch({ type: 'partial', text: '好了' });
  assert.ok(
    effects.some((effect) => effect.type === 'call' && effect.call.op === 'audio.stop'),
    '播报中说话要停播',
  );
});

test('兜底确认语说满就安静', () => {
  assert.equal(fillerLine(0), '我查一下。');
  assert.equal(fillerLine(1), '还在跑，稍等。');
  assert.equal(fillerLine(2), null, '说满就不该再插');
  assert.equal(fillerLine(-1), null);
});

test('本地应答的措辞：说"还在跑"，不编造剩余时间', () => {
  assert.ok(STATUS_REPLY.includes('还在跑'));
  assert.equal(/\d+\s*(秒|分钟)/.test(STATUS_REPLY), false, '不该编一个具体时间');
});

/** 只是为了让 DialogFsm 的 import 有用；状态机自己已由 session-core 覆盖。 */
test('状态机初始是 listening', () => {
  assert.equal(new DialogFsm(noop).state, 'listening');
});
