import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outcomeOf, TRUNCATED_EPSILON_MS } from '../src/engine-contract.ts';

test('播完了：不 stale、不 truncated，heard == total', () => {
  const out = outcomeOf({ stale: false, firstAudioAtMs: 1000, nowMs: 3400, totalAudioMs: 2400 });
  assert.deepEqual(out, { stale: false, truncated: false, heardMs: 2400, totalAudioMs: 2400 });
});

test('插话落在最后一个字之后：stale 但**不算少听**', () => {
  // 真机 `20261123-002440` 第 3 轮：19.44 s 音频正好播完，用户 26 ms 后才开口。
  // 这一轮必须回注记忆（用户听全了），同时老轮绝不能越权去动 FSM。
  const out = outcomeOf({
    stale: true,
    firstAudioAtMs: 1000,
    nowMs: 1000 + 19_440,
    totalAudioMs: 19_440,
  });
  assert.equal(out.stale, true);
  assert.equal(out.truncated, false, 'heard == total 就该判听全了');
});

test('播了一半被打断：truncated', () => {
  const out = outcomeOf({ stale: true, firstAudioAtMs: 1000, nowMs: 2200, totalAudioMs: 4000 });
  assert.equal(out.truncated, true);
  assert.equal(out.heardMs, 1200);
});

test('离尾巴不到容差也算听全（设备缓冲/回执抖动）', () => {
  const out = outcomeOf({
    stale: true,
    firstAudioAtMs: 0,
    nowMs: 4000 - TRUNCATED_EPSILON_MS + 1,
    totalAudioMs: 4000,
  });
  assert.equal(out.truncated, false);
});

test('一个字都没发出去：heard=0、但不判少听 —— 「没播」不是「少听」', () => {
  // 真机 `20261123-053719` 第 2 轮：dsh 答出了《其主之声》，`audio_s=0.00`。
  // 内容 100% 没被污染，该回注（口径叫 unspoken），不该被当成"用户少听了一段"。
  const out = outcomeOf({ stale: true, firstAudioAtMs: -1, nowMs: 5000, totalAudioMs: 0 });
  assert.deepEqual(out, { stale: true, truncated: false, heardMs: 0, totalAudioMs: 0 });
});

test('heard 不会被推到超过音频总长', () => {
  const out = outcomeOf({ stale: false, firstAudioAtMs: 0, nowMs: 99_999, totalAudioMs: 1000 });
  assert.equal(out.heardMs, 1000);
  assert.equal(out.truncated, false);
});

test('媒体游标比墙钟更小：慢生成轮次不把"送得慢"算成"听得多"', () => {
  // dsh 边生成边念：14 s 音频吐了 8 s 才吐完，用户第 5 秒插话。
  // 旧口径（纯墙钟）说听了 5 s；实际送到设备的媒体时长只有 2 s。
  // 高估的后果是判成"听全了"→ 该回注的答案被吞（`053719` 第 2 轮丢《其主之声》）。
  const out = outcomeOf({
    stale: true,
    firstAudioAtMs: 1000,
    nowMs: 6000,
    totalAudioMs: 14_000,
    sentMediaMs: 2000,
  });
  assert.equal(out.heardMs, 2000, '取媒体游标，不是墙钟差');
  assert.equal(out.truncated, true);

  // 反过来：媒体早就送完了，墙钟还没走完 —— 仍以墙钟为上界（声音播不了比实时快）
  const cached = outcomeOf({
    stale: true,
    firstAudioAtMs: 1000,
    nowMs: 3000,
    totalAudioMs: 14_000,
    sentMediaMs: 14_000,
  });
  assert.equal(cached.heardMs, 2000, 'elapsed 是物理上限');
});

test('没给媒体游标时退化成旧口径（回放对账不漂）', () => {
  const withOut = outcomeOf({ stale: false, firstAudioAtMs: 1000, nowMs: 3400, totalAudioMs: 2400 });
  const withMedia = outcomeOf({
    stale: false,
    firstAudioAtMs: 1000,
    nowMs: 3400,
    totalAudioMs: 2400,
    sentMediaMs: 2400,
  });
  assert.deepEqual(withMedia, withOut);
});
