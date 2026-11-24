/**
 * `PhotoInbox.dispose` 是吸收态：之后的 `request` 立刻取消，不再武装定时器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DeviceCall } from '../src/devices/primitives.ts';
import { PhotoInbox, type CaptureRequest } from '../src/photo-inbox.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';

const detail = (): CaptureRequest => ({
  id: 'c1',
  intent: 'detail',
  needsUser: true,
});

test('dispose 之后 request 立刻 cancelled，不再下发、不再武装定时器', async () => {
  const clock = new VirtualClock();
  const sent: DeviceCall[] = [];
  const inbox = new PhotoInbox({
    clock,
    dir: '',
    timeoutMs: 20_000,
    confirmTimeoutMs: 40_000,
    log: () => {},
    send: (call) => { sent.push(call); return true; },
  });

  const inflight = inbox.request(detail());
  assert.equal(clock.pending, 1, '在途请求要有兜底定时器');
  inbox.dispose();
  assert.deepEqual(await inflight, { ok: false, failure: { code: 'cancelled' } });
  assert.equal(clock.pending, 0, 'dispose 必须摘掉在途定时器');

  const again = await inbox.request({ ...detail(), id: 'c2' });
  assert.deepEqual(again, { ok: false, failure: { code: 'cancelled' } });
  assert.equal(sent.length, 1, '第二次不得再下发 capture');
  assert.equal(clock.pending, 0, '吸收态不得再武装定时器');
});
