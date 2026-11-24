import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConversationLedger } from '../src/conversation-ledger.ts';

test('lastAnsweredLane 跳过「一个字都没念」的轮次', () => {
  // 真机 `20261123-053719` 第 2 轮：dsh 答出了《其主之声》，`audio_s=0.00`。
  // 那一轮不算「答过」—— 拿它当"上一轮"会让刚发生的事凭空消失。
  const ledger = new ConversationLedger();
  ledger.record({ userText: '问一', assistantText: '答案一', lane: 'dsh', truncated: false, endedAtMs: 1 });
  ledger.record({ userText: '问二', assistantText: '', lane: 'cascade', truncated: false, endedAtMs: 2 });
  assert.equal(ledger.lastAnsweredLane(), 'dsh');
});

test('空账本返回 null（没有上文，路由不该靠猜）', () => {
  const ledger = new ConversationLedger();
  assert.equal(ledger.lastAnsweredLane(), null);
  assert.equal(ledger.lastAnswered(), null);
});

test('只留最近 N 轮：账本是判断用的，不是归档', () => {
  const ledger = new ConversationLedger(3);
  for (let i = 0; i < 5; i += 1) {
    ledger.record({ userText: `问${i}`, assistantText: `答${i}`, lane: 'live', truncated: false, endedAtMs: i });
  }
  assert.equal(ledger.size, 3);
  assert.deepEqual(ledger.recent(2).map((t) => t.userText), ['问3', '问4']);
});

test('recent(n) 不越界', () => {
  const ledger = new ConversationLedger();
  ledger.record({ userText: '问', assistantText: '答', lane: 'dsh', truncated: false, endedAtMs: 1 });
  assert.equal(ledger.recent(6).length, 1);
  assert.equal(ledger.recent(0).length, 0);
});

// ---------------------------------------------------------------- 后到结算的对账

test('reconcileOutcome 改的是对上票据的那一轮，顺序与别的轮次都不动', () => {
  const ledger = new ConversationLedger();
  ledger.record({
    userText: '问一',
    assistantText: '答一',
    lane: 'dsh',
    truncated: false,
    endedAtMs: 10,
    ticket: { no: 1, gen: 0 },
  });
  ledger.record({
    userText: '问二',
    assistantText: '答二',
    lane: 'dsh',
    truncated: false,
    endedAtMs: 20,
    ticket: { no: 2, gen: 0 },
  });

  assert.equal(ledger.reconcileOutcome({ no: 1, gen: 0 }, true, 33), true);
  const turns = ledger.recent(2);
  assert.deepEqual(turns.map((t) => t.userText), ['问一', '问二'], '就地改，不新记一笔、不打乱顺序');
  assert.equal(turns[0]?.truncated, true, '少听没少听要落定');
  assert.equal(turns[0]?.endedAtMs, 33);
  assert.equal(turns[1]?.truncated, false, '没对上的一轮一个字段都不许动');
  assert.equal(turns[1]?.endedAtMs, 20);
});

test('reconcileOutcome 认不出票据就返回 false：同车道也不行', () => {
  // 真机风险：omni 的结算晚到，账本里已经有一轮同车道的 dsh 回答 ——
  // 只按车道找就会把 truncate 写到别人头上。
  const ledger = new ConversationLedger();
  ledger.record({
    userText: '问一',
    assistantText: '答一',
    lane: 'dsh',
    truncated: false,
    endedAtMs: 10,
    ticket: { no: 1, gen: 0 },
  });
  ledger.record({
    userText: '问二',
    assistantText: '答二',
    lane: 'dsh',
    truncated: false,
    endedAtMs: 20,
    ticket: { no: 2, gen: 0 },
  });
  const before = ledger.recent(2).map((t) => ({ ...t }));

  assert.equal(ledger.reconcileOutcome({ no: 9, gen: 0 }, true, 99), false, '没这一轮');
  assert.equal(
    ledger.reconcileOutcome({ no: 2, gen: 1 }, true, 99),
    false,
    'no 对上但 gen 不对：那是被插话作废的另一条谱系',
  );
  assert.deepEqual(ledger.recent(2), before, '两次都必须一个字段都不改');
});

test('reconcileOutcome 不给 endedAtMs 就保留原时刻；没带票的轮次永远不被认领', () => {
  const ledger = new ConversationLedger();
  ledger.record({
    userText: '问',
    assistantText: '答',
    lane: 'live',
    truncated: false,
    endedAtMs: 42,
    ticket: { no: 1, gen: 0 },
  });
  ledger.record({ userText: '', assistantText: '宠物开口', lane: 'pet', truncated: false, endedAtMs: 50 });

  assert.equal(ledger.reconcileOutcome({ no: 1, gen: 0 }, true), true);
  const settled = ledger.recent(2)[0];
  assert.equal(settled?.truncated, true);
  assert.equal(settled?.endedAtMs, 42, '没给新时刻就照旧');

  // pet 轮没有票据（也不是内核轮次）：任何结算都不许认领它
  assert.equal(ledger.reconcileOutcome({ no: 2, gen: 0 }, true, 99), false);
  assert.equal(ledger.recent(1)[0]?.truncated, false, '宠物开口那条不许被改写');
});
