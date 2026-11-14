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
import type { DeviceCall } from '../src/devices/index.ts';
import { SystemClock } from '../src/app/clock.ts';
import { PhotoInbox, type PhotoInboxOptions } from '../src/photo-inbox.ts';

const capture = (id: string, intent: 'glance' | 'detail') =>
  ({ op: 'capture', id, intent, deadlineMs: 1000 }) as const;

/** 连着垫片的收件箱：下发即 `encode`，表达不了就当作 unsupported。 */
function testInboxOptions(v1: V1Session): PhotoInboxOptions {
  return {
    clock: new SystemClock(),
    dir: '',
    timeoutMs: 60_000,
    confirmTimeoutMs: 60_000,
    log: () => {},
    send: (call: DeviceCall) => v1.encode(call) !== null,
  };
}

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

test('glance：在途时到的第一帧图就是它，且只认这一帧', () => {
  const v1 = new V1Session();
  v1.encode(capture('g1', 'glance'));
  assert.equal(v1.image(), 'g1');
  // 一趟 glance 只回一帧：认领之后即使**没人调 forget**，也不再伸手抢图。
  // 否则这次请求结束后，用户自己拍的图都会被当成它的迟到图吃掉。
  assert.equal(v1.image(), null);
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

test('新请求不清上一次的取消残留：那一帧仍旧归已作废的 id', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  v1.encode({ op: 'capture.cancel', id: 'd1' });
  // 高清已取消、JPEG 还在链路上时紧接着来了一趟 glance：
  // 那一帧必须先被旧 id 吃掉，不能当成本次请求的结果。
  v1.encode(capture('g2', 'glance'));
  assert.equal(v1.image(), 'd1');
  assert.equal(v1.image(), 'g2');
});

test('新请求不清上一次的公告：公告过的那一帧仍旧归旧 id', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  v1.status({ ev: 'hq_image' });
  v1.encode(capture('g2', 'glance'));
  assert.equal(v1.image(), 'd1');
  assert.equal(v1.image(), 'g2');
});

test('取消之后设备报了失败：残留清掉，不会吃掉下一帧', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  v1.encode({ op: 'capture.cancel', id: 'd1' });
  // 设备确认这趟结束了 → 不会再有迟到的图
  assert.deepEqual(v1.status({ ev: 'hq_failed', reason: 'cancelled' }).event, {
    kind: 'capture.failed',
    id: 'd1',
    code: 'cancelled',
  });
  assert.equal(v1.image(), null);
});

test('取消的 id 对不上：不下发，免得把新请求在设备侧取消掉', () => {
  const v1 = new V1Session();
  v1.encode(capture('g1', 'glance'));
  // 上一次的取消迟到了：设备侧此刻的在途请求是 g1，绝不能发 hq_cancel
  assert.equal(v1.encode({ op: 'capture.cancel', id: 'old' }), null);
  assert.equal(v1.image(), 'g1');
});

test('forget 只清在途：公告与取消的残留照旧等那一帧', () => {
  const v1 = new V1Session();
  v1.encode(capture('d1', 'detail'));
  v1.status({ ev: 'hq_image' });
  v1.forget('d1'); // 请求结算了（`enqueueCapture` 就是在这时 forget 的）
  assert.equal(v1.image(), 'd1', '公告过的那一帧还在链路上，不能被忘掉');

  const v2 = new V1Session();
  v2.encode(capture('d2', 'detail'));
  v2.encode({ op: 'capture.cancel', id: 'd2' });
  v2.forget('d2'); // 收件箱在 cancel 之后立刻结算，生产会顺手 forget
  assert.equal(v2.image(), 'd2', '取消后迟到的图仍旧要吃掉');
});

test('宠物 look 结束之后，用户自己拍的图还能起一轮识图', async () => {
  const v1 = new V1Session();
  const inbox = new PhotoInbox(testInboxOptions(v1));
  const look = inbox.request({ id: 'pet-1', intent: 'glance', needsUser: false });
  assert.equal(inbox.deliver(v1.image(), Buffer.from([1, 2, 3])), true);
  assert.equal((await look).ok, true);
  // 这里**故意不 forget**：成功那一趟的图已经到过，垫片自己就该结束这趟 glance，
  // 不能靠调用方记得收尾。
  const id = v1.image();
  assert.equal(id, null, '用户自己拍的图不属于任何请求');
  assert.equal(inbox.deliver(id, Buffer.from([4, 5, 6])), false, '应当起一轮识图');
  inbox.dispose();
});

test('宠物 look 没有回图就结束：之后用户拍的图也不被吃掉', async () => {
  const v1 = new V1Session();
  const inbox = new PhotoInbox(testInboxOptions(v1));
  const look = inbox.request({ id: 'pet-2', intent: 'glance', needsUser: false });
  inbox.dispose(); // 兜底超时 / 连接结束：等待者被清掉
  assert.equal((await look).ok, false);
  v1.forget('pet-2');
  assert.equal(v1.image(), null);
  assert.equal(inbox.deliver(null, Buffer.from([7])), false, '应当起一轮识图');
});

test('v1 失败原因 → 失败码', () => {
  assert.equal(v1FailureCode('cancelled'), 'cancelled');
  assert.equal(v1FailureCode('busy'), 'busy');
  assert.equal(v1FailureCode('no_shutter'), 'timeout');
  assert.equal(v1FailureCode('no_arm'), 'timeout');
  assert.equal(v1FailureCode('p2p'), 'failed');
  assert.equal(v1FailureCode('send'), 'failed');
});
