/**
 * 播完以设备为准 —— 但设备回执只能**延后**，不能提前。
 *
 * 真机实测：某个 v2 设备声明了 `played`，却在下行最后一批字节收到时就回执
 * （4.58 s 的音频、1 s 就报播完）。按它收尾会让尾音还在放、状态已经回到
 * `listening` —— 那段播放里的插话就不再算插话。
 *
 * 现在的口径：估算时长是**下限**，`played` 只能把它拖后；上限只用来兜
 * 「事件永远不来」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Cancel, Clock } from '../src/app/clock.ts';
import { DialogFsm } from '../src/dialog-fsm.ts';
import type { AgentProvider, TtsProvider } from '../src/providers.ts';
import { TurnRunner } from '../src/turn-runner.ts';

/** 1 秒的音频（24 kHz、16 bit）—— 估算和 played 的差别要看得见 */
const ONE_SECOND = Buffer.alloc(48_000, 1);

const clock: Clock = {
  now: () => performance.now(),
  localHour: () => 12,
  after: (ms, fn): Cancel => {
    const timer = setTimeout(fn, ms);
    return () => { clearTimeout(timer); };
  },
  every: (ms, fn): Cancel => {
    const timer = setInterval(fn, ms);
    return () => { clearInterval(timer); };
  },
};

function rig(
  deviceReportsPlayed: boolean,
  playedGraceMs = 300,
): {
  start: () => Promise<{ interrupted: boolean } | null>;
  devicePlayed: () => void;
} {
  const agent: AgentProvider = {
    name: 'fake',
    reply: async () => ({ text: '[平静]好', speech: '好' }),
  };
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async* synthesize() { yield ONE_SECOND; },
    async* synthesizeStream() { yield ONE_SECOND; },
  };
  const runner = new TurnRunner({
    clock,
    agent,
    tts,
    downlink: { sendAudio: () => {}, sendControl: () => {} },
    fsm: new DialogFsm(() => {}),
    playbackTailMs: 0,
    deviceReportsPlayed,
    playedGraceMs,
    onTurnFinished: () => {},
    onLiveAvailable: () => {},
    log: () => {},
  });
  return {
    start: async () => await runner.run('你好'),
    devicePlayed: () => { runner.devicePlayed(); },
  };
}

test('设备提前报 played：不能提前收尾，仍等估算时长', async () => {
  const r = rig(true);
  const started = clock.now();
  const running = r.start();
  // 100 ms 就回执（真实 1 s 音频还没播完）
  await new Promise((resolve) => setTimeout(resolve, 100));
  r.devicePlayed();
  const result = await running;
  const spent = clock.now() - started;

  assert.ok(result);
  assert.ok(spent >= 950, `回执早于估算时不能提前走，实际 ${Math.round(spent)} ms`);
  assert.equal(result.interrupted, false, '设备报完播不算插话');
});

test('设备晚于估算才报 played：等设备，可以拖后', async () => {
  const r = rig(true);
  const started = clock.now();
  const running = r.start();
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  r.devicePlayed();
  const result = await running;
  const spent = clock.now() - started;

  assert.ok(result);
  assert.ok(spent >= 1_350, `设备说还没播完就得等，实际 ${Math.round(spent)} ms`);
});

test('设备不报 played：保留按时长估算的兜底', async () => {
  const r = rig(false);
  const started = clock.now();
  const result = await r.start();
  const spent = clock.now() - started;

  assert.ok(result);
  assert.ok(spent >= 950, `没有 played 就得等估算的 1 s，实际 ${Math.round(spent)} ms`);
  assert.ok(spent < 1_300, `没有 played 就不该多等余量之外的时间，实际 ${Math.round(spent)} ms`);
});

test('设备报 played 但事件丢了：估算 + 余量是上限，不会挂死', async () => {
  const r = rig(true);
  const started = clock.now();
  const result = await r.start(); // 谁都不调 devicePlayed
  const spent = clock.now() - started;

  assert.ok(result, '事件丢了也必须能走完');
  assert.ok(spent >= 1_250, `上限到了才走，实际 ${Math.round(spent)} ms`);
  assert.ok(spent < 2_000, '不能无限等');
});
