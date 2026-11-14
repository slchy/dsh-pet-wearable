/**
 * v1 垫片：原语 ↔ 控制串 / 状态帧，以及「这帧图属于谁」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  V1Session,
  v1FailureCode,
  XIAOMI_GLASSES_PHRASES,
} from '../src/devices/index.ts';

const capture = (id: string, intent: 'glance' | 'detail') =>
  ({ op: 'capture', id, intent, deadlineMs: 1000 }) as const;

test('原语 → 控制串', () => {
  const v1 = new V1Session();
  assert.equal(v1.encode({ op: 'audio.stop' }), 'stop');
  assert.equal(v1.encode({ op: 'listen.stop' }), 'stop_capture');
  assert.equal(v1.encode({ op: 'session.end' }), 'end_session');
  assert.equal(v1.encode(capture('a', 'glance')), 'take_photo');
  assert.equal(v1.encode(capture('b', 'detail')), 'take_photo_hq');
  assert.equal(v1.encode({ op: 'capture.cancel', id: 'b' }), 'hq_cancel');
});

test('v1 没有开麦动词：listen.start 表达不了', () => {
  assert.equal(new V1Session().encode({ op: 'listen.start', maxMs: 5000 }), null);
});

test('glance：在途时到的第一帧图就是它', () => {
  const v1 = new V1Session();
  v1.encode(capture('g1', 'glance'));
  assert.equal(v1.image(), 'g1');
  v1.forget('g1');
  assert.equal(v1.image(), null);
});

test('detail：公告前的图不属于请求，hq_image 之后那一帧才是', () => {
  const v1 = new V1Session(XIAOMI_GLASSES_PHRASES);
  v1.encode(capture('d1', 'detail'));
  assert.equal(v1.image(), null); // 按快门时 SPP 顺手回的低清图
  assert.deepEqual(v1.status({ ev: 'hq_image' }), { known: true, event: null });
  assert.equal(v1.image(), 'd1');
  // 公告只认领一帧
  assert.equal(v1.image(), null);
});

test('hq_armed：fresh=false 才要等用户，并带上代说的提示', () => {
  const v1 = new V1Session(XIAOMI_GLASSES_PHRASES);
  v1.encode(capture('d1', 'detail'));
  assert.deepEqual(v1.status({ ev: 'hq_armed', fresh: false }), {
    known: true,
    event: { kind: 'capture.waiting', id: 'd1', say: XIAOMI_GLASSES_PHRASES.waitingSay },
  });
  assert.deepEqual(v1.status({ ev: 'hq_armed', fresh: true }), { known: true, event: null });
});

test('没有代说的话：capture.waiting 不带 say', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  assert.deepEqual(v1.status({ ev: 'hq_armed' }).event, { kind: 'capture.waiting', id: 'd1' });
});

test('hq_failed：原因 → 失败码 + 设备给的话', () => {
  const v1 = new V1Session(XIAOMI_GLASSES_PHRASES);
  v1.encode(capture('d1', 'detail'));
  const event = v1.status({ ev: 'hq_failed', reason: 'no_shutter' }).event;
  assert.ok(event && event.kind === 'capture.failed');
  assert.equal(event.id, 'd1');
  assert.equal(event.code, 'timeout');
  assert.ok(event.say?.includes('快门'));

  const p2p = v1.status({ ev: 'hq_failed', reason: 'p2p' }).event;
  assert.ok(p2p && p2p.kind === 'capture.failed' && p2p.say?.includes('相册通道'));
});

test('没有在途请求时的状态帧：认识但不产出事件', () => {
  const v1 = new V1Session(XIAOMI_GLASSES_PHRASES);
  assert.deepEqual(v1.status({ ev: 'hq_armed' }), { known: true, event: null });
  assert.deepEqual(v1.status({ ev: 'hq_failed', reason: 'p2p' }), { known: true, event: null });
});

test('未知状态事件：known=false', () => {
  assert.deepEqual(new V1Session().status({ ev: 'whatever' }), { known: false, event: null });
});

test('取消 detail 后迟到的那一帧图归已作废的 id（让收件箱吃掉），只一次', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  v1.encode({ op: 'capture.cancel', id: 'd1' });
  assert.equal(v1.image(), 'd1');
  assert.equal(v1.image(), null);
});

test('取消 glance 不留尾巴', () => {
  const v1 = new V1Session();
  v1.encode(capture('g1', 'glance'));
  v1.encode({ op: 'capture.cancel', id: 'g1' });
  assert.equal(v1.image(), null);
});

test('新请求清掉上一次的公告与取消残留', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  v1.encode({ op: 'capture.cancel', id: 'd1' });
  v1.encode(capture('g2', 'glance'));
  assert.equal(v1.image(), 'g2');
});

test('v1 失败原因 → 失败码', () => {
  assert.equal(v1FailureCode('cancelled'), 'cancelled');
  assert.equal(v1FailureCode('busy'), 'busy');
  assert.equal(v1FailureCode('no_shutter'), 'timeout');
  assert.equal(v1FailureCode('no_arm'), 'timeout');
  assert.equal(v1FailureCode('p2p'), 'failed');
  assert.equal(v1FailureCode('send'), 'failed');
});
