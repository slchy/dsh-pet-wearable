/**
 * v2 线协议：握手降级、事件解析、CaptureImage 分帧。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodeV2Call,
  encodeV2CaptureImage,
  negotiateV2,
  parseV2CaptureImage,
  parseV2Event,
  resolveDeviceLink,
  V2_PROTO,
  V2_WELCOME,
  XIAOMI_V1_DEVICE,
} from '../src/devices/index.ts';

const FULL_CAPS = {
  audioIn: 'pcm16',
  capture: { glance: { needsUser: false }, detail: { needsUser: false } },
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
  played: true,
  ignorePhrases: [],
};

// ------------------------------------------------------------------ 握手

test('negotiateV2：proto 2 且能力合法 → 能力', () => {
  assert.deepEqual(negotiateV2({ proto: 2, capabilities: FULL_CAPS }), FULL_CAPS);
});

test('negotiateV2：更高的 proto 也按 2 说', () => {
  assert.deepEqual(negotiateV2({ proto: 3, capabilities: FULL_CAPS }), FULL_CAPS);
});

test('negotiateV2：不发 Hello、proto 1、缺 proto 都不是 v2', () => {
  assert.equal(negotiateV2(null), null);
  assert.equal(negotiateV2({}), null);
  assert.equal(negotiateV2({ proto: 1, capabilities: FULL_CAPS }), null);
});

test('negotiateV2：proto 2 但能力不合法 → null（不发 Welcome，设备退回 v1）', () => {
  assert.equal(negotiateV2({ proto: 2, capabilities: { audioIn: 'opus' } }), null);
  assert.equal(negotiateV2({ proto: 2 }), null);
});

test('Welcome 只声明 proto 2', () => {
  assert.deepEqual(JSON.parse(V2_WELCOME), { proto: V2_PROTO });
});

test('resolveDeviceLink：v2 自报压过型号提示', () => {
  const link = resolveDeviceLink(
    { proto: 2, deviceId: 'rayneo-1', capabilities: FULL_CAPS },
    'xiaomi-glasses',
  );
  assert.equal(link.proto, 2);
  assert.equal(link.label, 'rayneo-1');
  assert.equal(link.v1, null);
  assert.equal(link.capabilities.audioIn, 'pcm16');
});

test('resolveDeviceLink：没自报的老手机按型号走 v1，带垫片', () => {
  const link = resolveDeviceLink(null, 'xiaomi-glasses');
  assert.equal(link.proto, 1);
  assert.equal(link.label, XIAOMI_V1_DEVICE.label);
  assert.notEqual(link.v1, null);
});

test('resolveDeviceLink：proto 2 但能力坏 → 降级 v1，不拒绝', () => {
  const link = resolveDeviceLink({ proto: 2, capabilities: '坏的' }, 'xiaomi-glasses');
  assert.equal(link.proto, 1);
  assert.equal(link.label, XIAOMI_V1_DEVICE.label);
});

test('resolveDeviceLink：v2 没报 deviceId 也有个名字', () => {
  assert.equal(resolveDeviceLink({ proto: 2, capabilities: FULL_CAPS }).label, 'v2-device');
});

// ------------------------------------------------------------------ 事件

test('parseV2Event：presence 的 null 是「读不到」，不是坏帧', () => {
  assert.deepEqual(parseV2Event({ kind: 'presence', wearing: null }), { kind: 'presence', wearing: null });
  assert.deepEqual(parseV2Event({ kind: 'presence', wearing: true }), { kind: 'presence', wearing: true });
  // 缺字段才是坏帧
  assert.equal(parseV2Event({ kind: 'presence' }), null);
  // 别的类型冒充布尔 → 读不到
  assert.deepEqual(parseV2Event({ kind: 'presence', wearing: 'yes' }), { kind: 'presence', wearing: null });
});

test('parseV2Event：power 百分比越界当读不到', () => {
  assert.deepEqual(parseV2Event({ kind: 'power', percent: 42, charging: true }),
    { kind: 'power', percent: 42, charging: true });
  assert.deepEqual(parseV2Event({ kind: 'power', percent: 120 }),
    { kind: 'power', percent: null, charging: null });
});

test('parseV2Event：summon 只在 opensSession 为 true 时带上', () => {
  assert.deepEqual(parseV2Event({ kind: 'summon' }), { kind: 'summon' });
  assert.deepEqual(parseV2Event({ kind: 'summon', opensSession: false }), { kind: 'summon' });
  assert.deepEqual(parseV2Event({ kind: 'summon', opensSession: true }),
    { kind: 'summon', opensSession: true });
});

test('parseV2Event：capture 事件要有 id；不认识的失败码按 failed', () => {
  assert.equal(parseV2Event({ kind: 'capture.waiting' }), null);
  assert.equal(parseV2Event({ kind: 'capture.waiting', id: '  ' }), null);
  assert.deepEqual(parseV2Event({ kind: 'capture.waiting', id: 'c1', say: '' }),
    { kind: 'capture.waiting', id: 'c1' });
  assert.deepEqual(parseV2Event({ kind: 'capture.failed', id: 'c1', code: 'new-code' }),
    { kind: 'capture.failed', id: 'c1', code: 'failed' });
  assert.deepEqual(parseV2Event({ kind: 'capture.failed', id: 'c1', code: 'timeout', say: '没按上' }),
    { kind: 'capture.failed', id: 'c1', code: 'timeout', say: '没按上' });
});

test('parseV2Event：不认识的 kind 与坏形状 → null', () => {
  assert.equal(parseV2Event({ kind: 'blink' }), null);
  assert.equal(parseV2Event(null), null);
  assert.equal(parseV2Event([1, 2]), null);
  assert.deepEqual(parseV2Event({ kind: 'played' }), { kind: 'played' });
});

// ------------------------------------------------------------------ 帧

test('encodeV2Call：原样 JSON', () => {
  assert.deepEqual(JSON.parse(encodeV2Call({ op: 'listen.start', maxMs: 8000 })),
    { op: 'listen.start', maxMs: 8000 });
});

test('CaptureImage：id + JPEG 分帧往返', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const frame = encodeV2CaptureImage('pet-1', jpeg);
  const parsed = parseV2CaptureImage(frame);
  assert.deepEqual(parsed, { id: 'pet-1', jpeg });
});

test('CaptureImage：坏帧返回 null，不抛', () => {
  assert.equal(parseV2CaptureImage(Buffer.alloc(0)), null);
  assert.equal(parseV2CaptureImage(Buffer.from([3, 0x61, 0x62])), null); // 声明 3 字节 id 但只给了 2
});

test('encodeV2CaptureImage：空 id 与超长 id 都拒绝', () => {
  assert.throws(() => encodeV2CaptureImage('', Buffer.alloc(1)));
  assert.throws(() => encodeV2CaptureImage('x'.repeat(256), Buffer.alloc(1)));
});
