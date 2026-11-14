/**
 * `PhotoInbox` 的单测：它把一次 `capture` 变成可等待、可取消、有兜底超时的请求。
 *
 * 这里钉的都是**真机上踩过**的判定：
 * - 等图期间不属于请求的图不能冒充原图（实测交付过 17 KB 的糊图）
 * - 设备上报失败要立刻返回，不能让云端干等到自己的兜底超时
 * - 取消之后迟到的原图不该再起一轮识图
 *
 * 图属于哪个请求由线协议层给出 id（v1 的判法见 `wire-v1.test.ts`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DeviceCall, DeviceEvent } from '../src/devices/index.ts';
import { PhotoInbox, type CaptureRequest, type PhotoOutcome } from '../src/photo-inbox.ts';

interface Harness {
  readonly inbox: PhotoInbox;
  readonly sent: DeviceCall[];
  readonly logs: string[];
}

function newInbox(overrides: {
  timeoutMs?: number;
  confirmTimeoutMs?: number;
  accept?: boolean;
} = {}): Harness {
  const sent: DeviceCall[] = [];
  const logs: string[] = [];
  const inbox = new PhotoInbox({
    dir: '',
    timeoutMs: overrides.timeoutMs ?? 200,
    confirmTimeoutMs: overrides.confirmTimeoutMs ?? 200,
    log: (line) => { logs.push(line); },
    send: (call) => { sent.push(call); return overrides.accept ?? true; },
  });
  return { inbox, sent, logs };
}

const detail = (overrides: Partial<CaptureRequest> = {}): CaptureRequest => ({
  id: 'c1',
  intent: 'detail',
  needsUser: true,
  ...overrides,
});

const glance = (overrides: Partial<CaptureRequest> = {}): CaptureRequest => ({
  id: 'g1',
  intent: 'glance',
  needsUser: false,
  ...overrides,
});

const waiting = (id: string, say?: string): DeviceEvent => ({
  kind: 'capture.waiting',
  id,
  ...(say === undefined ? {} : { say }),
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

test('没人等时收到不属于任何请求的图：返回 false，交给调用方起一轮识图', () => {
  const { inbox } = newInbox();
  assert.equal(inbox.deliver(null, Buffer.from([1, 2])), false);
});

test('下发的 capture 带 id / 意图 / 兜底时长', () => {
  const { inbox, sent } = newInbox({ timeoutMs: 111, confirmTimeoutMs: 222 });
  void inbox.request(detail());
  assert.deepEqual(sent[0], { op: 'capture', id: 'c1', intent: 'detail', deadlineMs: 222 });
  inbox.dispose();
  void inbox.request(glance());
  assert.deepEqual(sent[1], { op: 'capture', id: 'g1', intent: 'glance', deadlineMs: 111 });
  inbox.dispose();
});

test('设备表达不了这次 capture：立刻 unsupported', async () => {
  const { inbox } = newInbox({ accept: false });
  assert.deepEqual(await inbox.request(glance()), { ok: false, failure: { code: 'unsupported' } });
  assert.equal(inbox.isWaiting, false);
});

test('不用人动手：图按 id 到了就交付', async () => {
  const { inbox } = newInbox();
  const pending = inbox.request(glance());
  assert.equal(inbox.deliver('g1', Buffer.from([5])), true);
  assert.deepEqual(await pending, { ok: true, jpeg: Buffer.from([5]) });
});

test('设备一直没消息：兜底超时报 timeout', async () => {
  const { inbox } = newInbox({ timeoutMs: 30 });
  assert.deepEqual(await inbox.request(glance()), { ok: false, failure: { code: 'timeout' } });
  assert.equal(inbox.isWaiting, false);
});

test('要人动手：capture.waiting 的提示只念一次；不属于请求的图被丢弃', async () => {
  const { inbox } = newInbox();
  const pending = inbox.request(detail());
  assert.equal(inbox.waitingId, 'c1');

  assert.equal(inbox.onEvent(waiting('c1', '请按快门')), '请按快门');
  assert.equal(inbox.onEvent(waiting('c1', '请按快门')), null);
  // 别的请求的事件不算
  assert.equal(inbox.onEvent(waiting('other', '别念')), null);

  // 等图期间不属于请求的图（小米按快门时 SPP 顺手回的低清图）：吃掉，但不交付
  assert.equal(inbox.deliver(null, Buffer.from([9, 9, 9])), true);
  assert.equal(inbox.isWaiting, true);

  assert.equal(inbox.deliver('c1', Buffer.from([7, 7])), true);
  assert.deepEqual(await pending, { ok: true, jpeg: Buffer.from([7, 7]) });
});

test('capture.waiting 不带 say：不念任何东西', () => {
  const { inbox } = newInbox();
  void inbox.request(detail());
  assert.equal(inbox.onEvent(waiting('c1')), null);
  inbox.dispose();
});

test('设备上报失败立刻返回（带上设备的原因），不等兜底超时', async () => {
  const { inbox } = newInbox({ confirmTimeoutMs: 10_000 });
  const pending = inbox.request(detail());
  assert.equal(
    inbox.onEvent({ kind: 'capture.failed', id: 'c1', code: 'timeout', say: '没按快门' }),
    null,
  );
  assert.deepEqual(await pending, { ok: false, failure: { code: 'timeout', say: '没按快门' } });
});

test('别的请求的失败事件不影响当前请求', () => {
  const { inbox } = newInbox();
  void inbox.request(detail());
  inbox.onEvent({ kind: 'capture.failed', id: 'old', code: 'failed' });
  assert.equal(inbox.isWaiting, true);
  inbox.dispose();
});

test('取消要人动手的流程：下发 capture.cancel 并立刻返回 cancelled', async () => {
  const { inbox, sent } = newInbox();
  const pending = inbox.request(detail());
  inbox.cancel('用户改主意');
  assert.deepEqual(await pending, { ok: false, failure: { code: 'cancelled' } });
  assert.deepEqual(sent.at(-1), { op: 'capture.cancel', id: 'c1' });
});

test('取消不用人动手的流程：不下发取消', async () => {
  const { inbox, sent } = newInbox();
  const pending = inbox.request(glance());
  inbox.cancel('用户改主意');
  assert.deepEqual(await pending, { ok: false, failure: { code: 'cancelled' } });
  assert.deepEqual(sent.map((call) => call.op), ['capture']);
});

test('取消之后迟到的图（带旧 id）：吃掉，不回落成识图轮', () => {
  const { inbox, logs } = newInbox();
  void inbox.request(detail());
  inbox.cancel('用户改主意');
  assert.equal(inbox.deliver('c1', Buffer.from([1])), true);
  assert.ok(logs.some((line) => line.includes('迟到的图')));
});

test('已有请求在等：第二次直接 busy，不排队', async () => {
  const { inbox } = newInbox();
  void inbox.request(detail());
  const second: PhotoOutcome = await inbox.request(detail({ id: 'c2' }));
  assert.deepEqual(second, { ok: false, failure: { code: 'busy' } });
  inbox.dispose();
});

test('timeoutFor：按要不要人动手给兜底时长', () => {
  const { inbox } = newInbox({ timeoutMs: 1, confirmTimeoutMs: 2 });
  assert.equal(inbox.timeoutFor(false), 1);
  assert.equal(inbox.timeoutFor(true), 2);
});

test('dispose：连接结束时把等待者清掉', async () => {
  const { inbox } = newInbox({ confirmTimeoutMs: 10_000 });
  const pending = inbox.request(detail());
  inbox.dispose();
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? undefined : outcome.failure.code, 'cancelled');
  assert.equal(inbox.isWaiting, false);
  await wait(1);
});
