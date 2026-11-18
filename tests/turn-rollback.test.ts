/**
 * 双向投机的「撤回切点」账本。
 *
 * 这一条对应真机上真实发生过的两件事：
 *
 * 1. **切点必须在入箱之前**。切在 `turn/start − 1`（那一格正是 `agent/inbox/spliced`）
 *    时，fork 出来的新会话会把那句话当待办**重放一遍** —— 探针实测：幽灵句在子会话里
 *    出现 2 次；改成入箱 seq − 1 之后是 0 次。
 * 2. **迟到的作废必须按票据丢掉**。dsh 那一轮的 promise 可能到下下轮才 resolve，
 *    此时账本里已经是新那一轮的切点 —— 不校验票据就会把**下一轮**切掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RollbackLedger } from '../src/session.ts';

const ticket = (no: number, gen = 0) => ({ no, gen });

test('撤回切点：落在入箱之前，不是 turn/start 之前', () => {
  const led = new RollbackLedger();
  led.observe('agent/inbox/spliced', 15, 1, ticket(1)); // 收件箱插入
  led.observe('turn/start', 16, 0, ticket(1));
  assert.equal(led.claim(ticket(1)), true);
  assert.equal(led.peek(), 14, '切点应是入箱 seq − 1；取 15 会把这句话重放一遍');
});

test('撤回切点：没有入箱事件就没有切点', () => {
  const led = new RollbackLedger();
  led.observe('turn/start', 7, 0, ticket(1));
  assert.equal(led.claim(ticket(1)), false);
  assert.equal(led.peek(), null);
});

test('迟到的作废：票据对不上就不动', () => {
  const led = new RollbackLedger();
  led.observe('agent/inbox/spliced', 20, 1, ticket(2));
  led.observe('turn/start', 21, 0, ticket(2));
  assert.equal(led.claim(ticket(1)), false, '第一轮的作废不能拿第二轮的切点去撤');
  assert.equal(led.peek(), null);
  assert.equal(led.claim(ticket(2)), true);
  assert.equal(led.peek(), 19);
});

test('连续多轮：只留最早那个切点，取一次就清空', () => {
  const led = new RollbackLedger();
  led.observe('agent/inbox/spliced', 30, 1, ticket(3));
  led.observe('turn/start', 31, 0, ticket(3));
  assert.equal(led.claim(ticket(3)), true);
  led.observe('agent/inbox/spliced', 40, 1, ticket(4));
  led.observe('turn/start', 41, 0, ticket(4));
  assert.equal(led.claim(ticket(4)), true);
  assert.equal(led.peek(), 29, '两次撤回 fork 一次就够，切到最早那次之前');
  assert.equal(led.take(), 29);
  assert.equal(led.take(), null, '取过就没了，不会重复 fork');
});

test('入箱的「取出」事件（inserted 为空）不算入箱', () => {
  const led = new RollbackLedger();
  led.observe('agent/inbox/spliced', 10, 1, ticket(1));
  led.observe('turn/start', 11, 0, ticket(1)); // 切点 = 9
  led.observe('agent/inbox/spliced', 12, 0, ticket(1)); // 取出，inserted 为空
  led.observe('turn/start', 13, 0, ticket(2));
  assert.equal(
    led.claim(ticket(2)),
    false,
    '这一轮没有入箱记录 → 不给切点。宁可不撤，也别拿上一轮的入箱 seq 切掉真实回答',
  );
  assert.equal(led.peek(), null);
});
