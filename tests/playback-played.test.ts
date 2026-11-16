/**
 * 播完以设备为准。
 *
 * `speaking` 什么时候结束，过去是按下发字节数估的（`字节 / 采样率 + 尾量`）。
 * 这个估算必然偏保守：网络抖动、设备缓冲、TTS 首包慢都会让真实出声晚于估算，
 * 于是插话窗口比实际短。
 *
 * 现在：**设备声明了 `played` 能力就等设备说**（`caps.played`）。估算时长退化成
 * 上限 —— 事件丢了顶多多等一会儿，不会把这一轮挂死。
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

function rig(deviceReportsPlayed: boolean): {
  start: () => Promise<{ interrupted: boolean } | null>;
  devicePlayed: () => void;
  runner: TurnRunner;
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
    onTurnFinished: () => {},
    onLiveAvailable: () => {},
    log: () => {},
  });
  return {
    start: async () => await runner.run('你好'),
    devicePlayed: () => { runner.devicePlayed(); },
    runner,
  };
}

test('设备报 played：不等估算时长，收到就结束这一轮', async () => {
  const r = rig(true);
  const started = clock.now();
  const running = r.start();
  // 100 ms 后设备说播完了（真实 1 秒音频还没"播完"）
  await new Promise((resolve) => setTimeout(resolve, 100));
  r.devicePlayed();
  const result = await running;
  const spent = clock.now() - started;

  assert.ok(result);
  assert.ok(spent < 700, `应当按 played 立刻结束，实际等了 ${Math.round(spent)} ms`);
  assert.equal(result.interrupted, false, '设备报完播不算插话');
});

test('设备不报 played：保留按时长估算的兜底', async () => {
  const r = rig(false);
  const started = clock.now();
  const result = await r.start();
  const spent = clock.now() - started;

  assert.ok(result);
  assert.ok(spent >= 950, `没有 played 就得等估算的 1 s，实际 ${Math.round(spent)} ms`);
});

test('设备报 played 但事件丢了：估算时长是上限，不会挂死', async () => {
  const r = rig(true);
  const started = clock.now();
  const result = await r.start(); // 谁都不调 devicePlayed
  const spent = clock.now() - started;

  assert.ok(result, '事件丢了也必须能走完');
  assert.ok(spent >= 950, `上限到了才走，实际 ${Math.round(spent)} ms`);
  assert.ok(spent < 2_500, '不能无限等');
});
