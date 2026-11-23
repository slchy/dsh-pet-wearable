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
