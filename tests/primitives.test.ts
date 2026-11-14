/**
 * 原语层：能力解析（`Hello` 自报）与「能不能发」的判定。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canCaptureUnprompted,
  captureMode,
  parseCapabilities,
  supportsCall,
  V1_BASELINE,
  XIAOMI_GLASSES_CAPABILITIES,
} from '../src/devices/index.ts';

test('parseCapabilities：完整自报（雷鸟 X3 Pro 的 Hello）', () => {
  assert.deepEqual(parseCapabilities({
    audioIn: 'pcm16',
    capture: { glance: { needsUser: false }, detail: { needsUser: false } },
    presence: true,
    power: true,
    summon: true,
    listenStart: true,
    played: true,
    ignorePhrases: [],
  }), {
    audioIn: 'pcm16',
    capture: { glance: { needsUser: false }, detail: { needsUser: false } },
    presence: true,
    power: true,
    summon: true,
    listenStart: true,
    played: true,
    ignorePhrases: [],
  });
});

test('parseCapabilities：只给 audioIn，其余按「没有」', () => {
  assert.deepEqual(parseCapabilities({ audioIn: 'msbc' }), {
    audioIn: 'msbc',
    capture: {},
    presence: false,
    power: false,
    summon: false,
    listenStart: false,
    played: false,
    ignorePhrases: [],
  });
});

test('parseCapabilities：audioIn 缺失或不认识 → null', () => {
  assert.equal(parseCapabilities({}), null);
  assert.equal(parseCapabilities({ audioIn: 'opus' }), null);
  assert.equal(parseCapabilities(null), null);
  assert.equal(parseCapabilities('pcm16'), null);
});

test('parseCapabilities：不认识的字段与非法值被忽略', () => {
  const caps = parseCapabilities({
    audioIn: 'pcm16',
    capture: { glance: { needsUser: false }, zoom: { needsUser: false }, detail: 'yes' },
    presence: 'true',
    ignorePhrases: ['嘿 Siri', 3],
    future: 1,
  });
  assert.ok(caps);
  assert.deepEqual(caps.capture, { glance: { needsUser: false } });
  assert.equal(caps.presence, false);
  assert.deepEqual(caps.ignorePhrases, ['嘿 Siri']);
});

test('captureMode / canCaptureUnprompted：按意图读能力', () => {
  assert.deepEqual(captureMode(XIAOMI_GLASSES_CAPABILITIES, 'detail'), { needsUser: true });
  assert.equal(captureMode(V1_BASELINE, 'detail'), null);
  assert.equal(canCaptureUnprompted(XIAOMI_GLASSES_CAPABILITIES, 'glance'), true);
  // 要人按快门的档不能用于主动拍照
  assert.equal(canCaptureUnprompted(XIAOMI_GLASSES_CAPABILITIES, 'detail'), false);
  assert.equal(canCaptureUnprompted(V1_BASELINE, 'detail'), false);
});

test('supportsCall：停播 / 停麦 / 挂断 / 取消永远可以发', () => {
  for (const call of [
    { op: 'audio.stop' },
    { op: 'listen.stop' },
    { op: 'session.end' },
    { op: 'capture.cancel', id: 'x' },
  ] as const) {
    assert.equal(supportsCall(V1_BASELINE, call), true, call.op);
  }
});

test('supportsCall：listen.start 看能力，capture 看意图', () => {
  assert.equal(supportsCall(V1_BASELINE, { op: 'listen.start', maxMs: 5000 }), false);
  assert.equal(
    supportsCall({ ...V1_BASELINE, listenStart: true }, { op: 'listen.start', maxMs: 5000 }),
    true,
  );
  const detail = { op: 'capture', id: 'c', intent: 'detail', deadlineMs: 1 } as const;
  assert.equal(supportsCall(V1_BASELINE, detail), false);
  assert.equal(supportsCall(XIAOMI_GLASSES_CAPABILITIES, detail), true);
});
