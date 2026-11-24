/**
 * 连接就绪时要不要主动唤醒设备（`listen.start`）。
 *
 * 背景（真机 2026-11-22 19:19:43）：连接就绪 1.5 s 后服务端无条件发
 * `listen.start{maxMs:60000}`，而那一刻设备**未佩戴** —— 整段日志零音频帧、
 * 零 `OpenDevice`，60 s 麦克风白开，模型也不会说话。用户看到的是「莫名其妙
 * 被拉起，却没人说话」。
 *
 * 判据的保守方向在两处是相反的，别搞混：
 * - 这里的 `wearing === null` **放行**（漏开 = 用户长按没反应，比多开一次严重）
 * - ADR-0001 的 `worn` 闸门 `wearing !== true` 则**拦住**（那是主动开口）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldWakeOnReady } from '../src/voice-session.ts';

const base = { hasAudio: false, wearing: null as boolean | null, closed: false, micPending: false };

test('设备在推流就不唤醒（重连场景最常见）', () => {
  assert.equal(shouldWakeOnReady({ ...base, hasAudio: true }), false);
  // 哪怕不知道戴没戴，在推流就说明它在工作
  assert.equal(shouldWakeOnReady({ ...base, hasAudio: true, wearing: true }), false);
});

test('明确未佩戴：不唤醒', () => {
  assert.equal(shouldWakeOnReady({ ...base, wearing: false }), false);
});

test('佩戴：唤醒', () => {
  assert.equal(shouldWakeOnReady({ ...base, wearing: true }), true);
});

test('佩戴未知（null）：放行 —— 漏开的代价更大', () => {
  assert.equal(shouldWakeOnReady({ ...base, wearing: null }), true);
});

test('已经发过 listen.start 或连接已关：都不重复', () => {
  assert.equal(shouldWakeOnReady({ ...base, micPending: true }), false);
  assert.equal(shouldWakeOnReady({ ...base, closed: true }), false);
});
