/**
 * `MicController` 的宽限与等麦。时间走 `VirtualClock`，不必真等 1.5 s。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SystemClock } from '../src/app/clock.ts';
import type { DeviceCall } from '../src/devices/primitives.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';
import {
  CAPTURE_GRACE_MS,
  INITIAL_LISTEN_MS,
  MicController,
  type MicPorts,
} from '../src/voice/mic-phase.ts';

interface MicHarness {
  readonly clock: VirtualClock;
  readonly mic: MicController;
  readonly calls: DeviceCall[];
  readonly opened: () => number;
  setWearing(wearing: boolean | null): void;
  setClosed(closed: boolean): void;
}

/** `sendCall` 模拟设备层：字节交出去之后才 `noteListenSent`。 */
function harness(wearing: boolean | null = null): MicHarness {
  const clock = new VirtualClock();
  const calls: DeviceCall[] = [];
  let opened = 0;
  let worn = wearing;
  let closed = false;
  let mic!: MicController;
  const ports: MicPorts = {
    clock,
    wearing: () => worn,
    connClosed: () => closed,
    sendCall: (call) => {
      calls.push(call);
      mic.noteListenSent(call);
      return true;
    },
    onOpened: () => { opened += 1; },
  };
  mic = new MicController(ports);
  return {
    clock,
    mic,
    calls,
    opened: () => opened,
    setWearing: (next) => { worn = next; },
    setClosed: (next) => { closed = next; },
  };
}

test('CAPTURE_GRACE_MS 到期才发 listen.start', async () => {
  const { clock, mic, calls } = harness(null);
  mic.armCaptureWatch(false);
  await clock.runUntil(CAPTURE_GRACE_MS - 1);
  assert.equal(calls.length, 0, '宽限期没走完不能唤醒');
  await clock.runUntil(CAPTURE_GRACE_MS);
  assert.deepEqual(calls, [{ op: 'listen.start', maxMs: INITIAL_LISTEN_MS }]);
  assert.equal(mic.phase, 'opening');
});

test('宽限期内有音频帧就取消唤醒', async () => {
  const { clock, mic, calls, opened } = harness(null);
  mic.armCaptureWatch(false);
  assert.equal(clock.pending, 1);
  mic.noteUplinkAudio();
  assert.equal(mic.phase, 'open');
  assert.equal(opened(), 1);
  assert.equal(clock.pending, 0, '首帧必须取消宽限定时器');
  await clock.runUntil(CAPTURE_GRACE_MS);
  assert.equal(calls.length, 0);
});

test('wearing === false 到期也不唤醒', async () => {
  const { clock, mic, calls } = harness(false);
  mic.armCaptureWatch(false);
  await clock.runUntil(CAPTURE_GRACE_MS);
  assert.equal(calls.length, 0);
  assert.equal(mic.phase, 'watching');
});

test('beginClose() 挡住 listen.start', async () => {
  const { clock, mic, calls } = harness(true);
  mic.armCaptureWatch(false);
  mic.beginClose();
  assert.equal(mic.listenStartBlocked(), true);
  await clock.runUntil(CAPTURE_GRACE_MS);
  assert.equal(calls.length, 0, '正在关的连接不能再开麦');

  const blocked = harness(true);
  blocked.mic.beginClose();
  blocked.mic.armCaptureWatch(false);
  assert.equal(blocked.mic.phase, 'idle');
  assert.equal(blocked.clock.pending, 0);
});

test('absorb() 立刻以 false 叫醒等麦的人', { timeout: 1_000 }, async () => {
  const { clock, mic } = harness(null);
  mic.noteListenSent({ op: 'listen.start', maxMs: INITIAL_LISTEN_MS });
  assert.equal(mic.phase, 'opening');
  const pending = mic.awaitMicOpen(60_000);
  assert.equal(clock.pending, 1);
  mic.absorb();
  assert.equal(mic.phase, 'closed');
  assert.equal(await pending, false);
  assert.equal(clock.pending, 0, '吸收态必须取消等麦超时');
});

test('SystemClock 下 absorb 清掉宽限定时器', () => {
  // SystemClock.after 会 unref，getActiveResourcesInfo 看不到这只句柄。
  // 包一层全局定时器，确认 absorb 真的 clearTimeout，而不是把回调留到 1.5 s 后。
  const armed = new Set<unknown>();
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const timer = origSet(fn, ms);
    armed.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
    armed.delete(timer);
    return origClear(timer);
  }) as typeof clearTimeout;
  try {
    const clock = new SystemClock();
    const mic = new MicController({
      clock,
      wearing: () => null,
      connClosed: () => false,
      sendCall: () => true,
      onOpened: () => {},
    });
    const before = armed.size;
    mic.armCaptureWatch(false);
    assert.equal(armed.size, before + 1);
    mic.absorb();
    assert.equal(armed.size, before, 'onClose 路径必须 clearTimeout，不能留下 1.5 s 句柄');
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  }
});
