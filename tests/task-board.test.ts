/**
 * 后台作业状态（`job/registered` / `job/settled` / `subagent/catalog`）。
 *
 * 这些事实是**快车道照实说「还在跑 / 刚跑完」的唯一依据**。判错的后果不是慢，
 * 而是对着用户编进度 —— 所以每一条都要有测试钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TaskBoard } from '../src/task-board.ts';

const MAIN = 'main-session';

function board(clock: { now: number }): TaskBoard {
  return new TaskBoard(() => MAIN, () => clock.now);
}

test('作业注册后在跑，结算后变「刚结束」', () => {
  const clock = { now: 1_000 };
  const b = board(clock);

  assert.match(b.describe(), /没有任何后台任务/);

  b.observe(MAIN, 'job/registered', {
    jobId: 'bash-1', kind: 'bash', label: 'sleep 20', startedAt: 1_000,
  });
  clock.now = 13_000;
  assert.match(b.describe(), /在跑 1 个/);
  assert.match(b.describe(), /bash「sleep 20」已跑 12 秒/);

  b.observe(MAIN, 'job/settled', { jobId: 'bash-1', settledAt: 13_000 });
  clock.now = 16_000;
  const after = b.describe();
  assert.match(after, /现在没有在跑的/);
  assert.match(after, /刚结束 bash「sleep 20」（3 秒前）/);
});

test('结算记录会过期：两分钟后再问就是「没有」', () => {
  const clock = { now: 0 };
  const b = board(clock);
  b.observe(MAIN, 'job/registered', { jobId: 'j', kind: 'bash', label: 'x', startedAt: 0 });
  b.observe(MAIN, 'job/settled', { jobId: 'j', settledAt: 0 });
  clock.now = 60_000;
  assert.match(b.describe(), /刚结束/);
  clock.now = 121_000;
  assert.match(b.describe(), /没有任何后台任务/);
});

test('子代理的作业单独标出来 —— 它带的是自己的 sessionId', () => {
  const clock = { now: 0 };
  const b = board(clock);
  b.observe('child-1', 'job/registered', {
    jobId: 'bash-2', kind: 'bash', label: 'sleep 20', startedAt: 0,
  });
  clock.now = 5_000;
  assert.match(b.describe(), /子代理的 bash「sleep 20」已跑 5 秒/);
});

test('派出子代理也算在跑；子代理自己的作业报上来后不重复计', () => {
  const clock = { now: 0 };
  const b = board(clock);
  b.observe(MAIN, 'subagent/catalog', {
    version: 0, childId: 'child-1', childCreatedAt: 0, label: '算加法',
  });
  assert.match(b.describe(), /子代理「算加法」已派出、还没回结果/);

  // 子代理自己的作业报上来后，不再重复计一个「已派出」
  b.observe('child-1', 'job/registered', { jobId: 'b', kind: 'bash', label: 'sleep 1', startedAt: 0 });
  assert.equal((b.describe().match(/子代理/g) ?? []).length, 1);
  assert.match(b.describe(), /子代理的 bash「sleep 1」/);

  // 结算 + 主会话又开一轮（结果说出来了）→ 彻底干净
  b.observe('child-1', 'job/settled', { jobId: 'b', settledAt: 0 });
  b.observe(MAIN, 'turn/start', { turn: 2 });
  assert.match(b.describe(), /现在没有在跑的；刚结束/);
});

test('别的会话的 turn/start 不会清掉子代理', () => {
  const clock = { now: 0 };
  const b = board(clock);
  b.observe(MAIN, 'subagent/catalog', { childId: 'c', childCreatedAt: 0, label: '查天气' });
  b.observe('child-1', 'turn/start', { turn: 1 });
  assert.match(b.describe(), /子代理「查天气」/);
});

test('坏载荷不炸，也不留下脏记录', () => {
  const b = board({ now: 0 });
  b.observe(MAIN, 'job/registered', { kind: 'bash' });
  b.observe(MAIN, 'job/settled', { jobId: '不存在' });
  b.observe(MAIN, 'subagent/catalog', {});
  b.observe(MAIN, '未知类型', { whatever: 1 });
  b.observe(MAIN, 'job/registered', undefined);
  assert.match(b.describe(), /没有任何后台任务/);
});

test('描述过长会被截断，不把整条命令塞给模型', () => {
  const b = board({ now: 0 });
  b.observe(MAIN, 'job/registered', {
    jobId: 'j', kind: 'bash', label: 'curl -s https://example.com/a/b/c | grep -o "x" | head -3',
  });
  const text = b.describe();
  assert.ok(text.includes('…'), text);
  assert.ok(!text.includes('head -3'), '尾部应被截掉');
});
