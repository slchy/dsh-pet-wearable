/**
 * `PetTiming` 的单测。
 *
 * 这个模块最怕的不是"不开口"，而是**开口太勤** —— 所以断言里有一半是在验证
 * 「不该开口时确实没开口」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_PET_TIMING, PetTiming, type PetSnapshot } from '../src/pet/pet-timing.ts';

const MIN = 60_000;

/** 造一个快照：默认戴着、电量满、中午。 */
function snap(nowMs: number, over: Partial<PetSnapshot> = {}): PetSnapshot {
  return { wearing: true, battery: 80, nowMs, localHour: 12, ...over };
}

test('默认参数是「宁可少说」的一侧', () => {
  assert.ok(DEFAULT_PET_TIMING.greetAfterAwayMs >= 3 * MIN, '离场不足 3 分钟不该打招呼');
  assert.ok(DEFAULT_PET_TIMING.chatterAfterIdleMs >= 15 * MIN, '搭话门槛不该低于 15 分钟');
  assert.ok(DEFAULT_PET_TIMING.minProactiveGapMs > 0, '两个主动动作之间必须有间隔');
});

test('一直在场上、没人说话：不到门槛不开口', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  assert.equal(p.tick(snap(10 * MIN)).kind, 'idle');
  assert.equal(p.tick(snap(19 * MIN)).kind, 'idle');
});

test('闲置到门槛就搭话，且只说一次', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  const move = p.tick(snap(20 * MIN));
  assert.equal(move.kind, 'chatter');
  // 说完之后立刻再判：不该连续开口
  assert.equal(p.tick(snap(20 * MIN + 1000)).kind, 'idle');
});

test('用户说话了：闲置计时重置', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onUserSpoke(18 * MIN);
  assert.equal(p.tick(snap(30 * MIN)).kind, 'idle', '刚聊过不该马上搭话');
  assert.equal(p.tick(snap(18 * MIN + 20 * MIN)).kind, 'chatter');
});

test('离场一会儿就回来：不打招呼', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onPresence(false, 10 * MIN);
  p.onPresence(true, 10 * MIN + 30_000); // 擦了 30 秒眼镜
  assert.equal(p.tick(snap(10 * MIN + 31_000)).kind, 'idle');
});

test('离场够久再回来：打招呼，且只说一次', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onPresence(false, 10 * MIN);
  p.onPresence(true, 20 * MIN);
  const move = p.tick(snap(20 * MIN));
  assert.equal(move.kind, 'greet');
  if (move.kind === 'greet') {
    assert.equal(move.awayMs, 10 * MIN);
  }
  assert.equal(p.tick(snap(20 * MIN + 5000)).kind, 'idle', '同一次回来不该重复打招呼');
});

test('摘下期间永远 idle', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onPresence(false, MIN);
  assert.equal(p.tick(snap(60 * MIN, { wearing: false })).kind, 'idle');
});

test('摘不下 → 读不到（null）按在场处理，不当成离场', () => {
  const p = new PetTiming();
  p.onPresence(null, 0);
  assert.equal(p.tick(snap(20 * MIN, { wearing: null })).kind, 'chatter');
});

test('没戴 → 读不到 → 又读到戴着：不补打招呼', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onPresence(false, 10 * MIN);   // 已知离场
  p.onPresence(null, 11 * MIN);    // 读不到：离场计时作废
  p.onPresence(true, 20 * MIN);    // 重新读到戴着
  assert.equal(p.tick(snap(20 * MIN)).kind, 'idle');
});

test('没戴 → 读不到：离场计时清掉，之后不会冒出 greet', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onPresence(false, 10 * MIN);
  p.onPresence(null, 11 * MIN);
  assert.equal(p.tick(snap(12 * MIN, { wearing: null })).kind, 'idle');
  // 未知按在场处理，闲置从 11 分钟起算 → 20 分钟后是搭话，不是打招呼
  assert.equal(p.tick(snap(31 * MIN, { wearing: null })).kind, 'chatter');
});

test('读不到之后直接读到戴着：不打招呼', () => {
  const p = new PetTiming();
  p.onPresence(null, 0);
  p.onPresence(true, 20 * MIN);
  assert.equal(p.tick(snap(20 * MIN)).kind, 'idle');
});

test('深夜不搭话，但离场回来照旧打招呼', () => {
  const quiet = new PetTiming();
  quiet.onPresence(true, 0);
  assert.equal(quiet.tick(snap(60 * MIN, { localHour: 23 })).kind, 'idle');
  assert.equal(quiet.tick(snap(120 * MIN, { localHour: 3 })).kind, 'idle');

  const returned = new PetTiming();
  returned.onPresence(true, 0);
  returned.onPresence(false, MIN);
  returned.onPresence(true, 20 * MIN);
  assert.equal(returned.tick(snap(20 * MIN, { localHour: 2 })).kind, 'greet');
});

test('深夜边界：22 点可以说，23 点不能说，7 点恢复', () => {
  const at = (hour: number) => {
    const p = new PetTiming();
    p.onPresence(true, 0);
    return p.tick(snap(60 * MIN, { localHour: hour })).kind;
  };
  assert.equal(at(22), 'chatter');
  assert.equal(at(23), 'idle');
  assert.equal(at(0), 'idle');
  assert.equal(at(6), 'idle');
  assert.equal(at(7), 'chatter');
});

test('电量低不搭话；读不到电量时不受限', () => {
  const low = new PetTiming();
  low.onPresence(true, 0);
  assert.equal(low.tick(snap(60 * MIN, { battery: 15 })).kind, 'idle');
  assert.equal(low.tick(snap(60 * MIN, { battery: 20 })).kind, 'idle', '等于阈值也算低');

  const unknown = new PetTiming();
  unknown.onPresence(true, 0);
  assert.equal(unknown.tick(snap(60 * MIN, { battery: null })).kind, 'chatter');
});

test('两次主动搭话之间有最小间隔', () => {
  const p = new PetTiming({ chatterAfterIdleMs: 1 * MIN, minProactiveGapMs: 10 * MIN });
  p.onPresence(true, 0);
  assert.equal(p.tick(snap(2 * MIN)).kind, 'chatter');
  // 搭完 idleSince 重置，1 分钟后本可再搭，但最小间隔还没到
  assert.equal(p.tick(snap(3 * MIN)).kind, 'idle');
  assert.equal(p.tick(snap(12 * MIN)).kind, 'chatter');
});

test('敲击等同用户说话：刷新闲置与最小间隔', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  p.onTap(19 * MIN);
  assert.equal(p.tick(snap(20 * MIN)).kind, 'idle');
  assert.equal(p.tick(snap(19 * MIN + 20 * MIN)).kind, 'chatter');
});

test('普通敲击给一个快反射动作，同时刷新闲置', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  assert.deepEqual(p.onTap(19 * MIN), { kind: 'reflect', cue: 'tap-ack' });
  // 反射不算主动开口：最小间隔不刷新，但闲置已重置
  assert.equal(p.tick(snap(20 * MIN)).kind, 'idle');
});

test('会打开语音会话的敲击不当作说话，也不给反射', () => {
  const p = new PetTiming();
  p.onPresence(true, 0);
  assert.deepEqual(p.onTap(19 * MIN, { opensSession: true }), { kind: 'idle' });
  // 闲置没有被重置：20 分钟门槛到了就搭话（随后的发言会由 onUserSpoke 报告）
  assert.equal(p.tick(snap(20 * MIN)).kind, 'chatter');
});

test('只喂快照也能工作（不调 onPresence）', () => {
  const p = new PetTiming();
  assert.equal(p.tick(snap(MIN)).kind, 'idle');
  assert.equal(p.tick(snap(30 * MIN)).kind, 'chatter');
});
