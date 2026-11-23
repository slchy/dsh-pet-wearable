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
