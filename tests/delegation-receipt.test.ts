/**
 * 委派轮的回执。
 *
 * 真机实测（2026-11-16，v2 设备，9 轮）：交给 `dsh` 的轮次从停嘴到出声
 * **1.8–2.9 s**，中间一片安静；快车道命中的是 1.0–2.0 s。这段空白用一句
 * 四个字的回执填上，否则用户会以为没听见。
 *
 * 四条硬边界：
 * 1. 只有**交给慢车道**才回执（快车道胜出时不说话）
 * 2. 回执要在答案之前下发，而且**不能等它播完**（不排 speechChain）
 * 3. 答案一到就顶掉它，并且先 `audio.stop` 清设备缓冲（两句话不能叠）
 * 4. 回执不留残句 —— 它不是「用户没听完的内容」
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SystemClock } from '../src/app/clock.ts';
import { DialogRuntime } from '../src/app/dialog.ts';
import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import { FrontedAgent } from '../src/fronted-agent.ts';
import { newActivityState, trackActivity } from '../src/keepalive.ts';
import type { AgentProvider, AgentReplyView, TtsProvider } from '../src/providers.ts';
import type { DownlinkSink } from '../src/transport.ts';

const CAPS: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: {},
  presence: false,
  power: false,
  summon: false,
  listenStart: false,
  played: false,
  ignorePhrases: [],
};

const CHUNK = Buffer.alloc(24_000, 1); // 0.5 s @24k/16bit —— 够长，答案会落在回执播放期间

interface Rig {
  readonly runtime: DialogRuntime;
  readonly sends: Array<{ readonly at: number; readonly bytes: number }>;
  readonly calls: string[];
  readonly logs: string[];
  dispose: () => void;
}

/** `innerMs`：dsh 多久才给出答复（回执窗口的长度） */
function rig(innerMs: number): Rig {
  const started = Date.now();
  const sends: Array<{ at: number; bytes: number }> = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => {
      await new Promise((resolve) => { setTimeout(resolve, innerMs); });
      return { text: '订单查到了，明天到。', speech: '订单查到了，明天到。' };
    },
  };
  // 生产形状：trackActivity 外面包 FrontedAgent（`apiKey: ''` = 本地判据直接交给 dsh）
  const agent = trackActivity(
    new FrontedAgent({ inner, apiKey: '', log: (line) => { logs.push(line); } }),
    newActivityState(Date.now()),
  );
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async* synthesize() { yield CHUNK; },
    async* synthesizeStream() { yield CHUNK; },
  };
  const downlink: DownlinkSink = {
    sendAudio: (chunk) => { sends.push({ at: Date.now() - started, bytes: chunk.length }); },
    sendControl: () => {},
  };
  const runtime = new DialogRuntime({
    clock: new SystemClock(),
    caps: CAPS,
    agent,
    tts,
    downlink,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: {
      call: (call) => { calls.push(call.op); return true; },
      assemble: () => {},
      end: () => {},
    },
    log: (line) => { logs.push(line); },
  });
  return { runtime, sends, calls, logs, dispose: () => { runtime.dispose(); } };
}

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
};

test('交给慢车道：先回执，答案到了再顶掉', async () => {
  const r = rig(400);
  try {
    r.runtime.dispatch({ type: 'utterance', text: '帮我查一下订单' });
    await wait(120);

    assert.ok(
      r.sends.length > 0,
      `回执应当立刻下发（dsh 还要 400 ms），实际什么都没发：${JSON.stringify(r.logs)}`,
    );
    assert.ok(
      r.sends[0]!.at < 120,
      `第一块音频应该是回执，实际在 ${r.sends[0]!.at} ms`,
    );
    assert.ok(
      r.logs.some((line) => line.includes('回执')),
      `该有「回执」日志，实际：${JSON.stringify(r.logs)}`,
    );

    await wait(500);
    assert.ok(
      r.calls.includes('audio.stop'),
      `答案来了要先清设备缓冲，否则两句叠在一起；实际调用：${JSON.stringify(r.calls)}`,
    );
    assert.ok(
      r.logs.some((line) => line.includes('被正式回答顶掉')),
      `该有「被顶掉」日志，实际：${JSON.stringify(r.logs)}`,
    );
    assert.equal(
      r.runtime.runner.takeCannedResidue(),
      null,
      '回执不是「用户没听完的内容」，不该留残句',
    );
  } finally {
    r.dispose();
  }
});

test('已经出过声就不再回执', async () => {
  const r = rig(50);
  try {
    r.runtime.dispatch({ type: 'utterance', text: '帮我查一下订单' });
    await wait(300);
    assert.equal(
      r.runtime.runner.speakReceipt('再说一句。'),
      false,
      '这一轮已经出声了，回执没有意义',
    );
  } finally {
    r.dispose();
  }
});

test('快车道胜出：不说话，直接给答案', async () => {
  const logs: string[] = [];
  const sends: number[] = [];
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => {
      await new Promise((resolve) => { setTimeout(resolve, 2_000); });
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    cancelTurn: () => {},
  };
  const agent = new FrontedAgent({
    inner,
    apiKey: 'k',
    log: (line) => { logs.push(line); },
    fetchImpl: async () => new Response(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '嗯，我在呢。' } }] }) + '\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  });
  const runtime = new DialogRuntime({
    clock: new SystemClock(),
    caps: CAPS,
    agent,
    tts: {
      name: 'fake',
      sampleRate: 24_000,
      async* synthesize() { yield CHUNK; },
      async* synthesizeStream() { yield CHUNK; },
    },
    downlink: {
      sendAudio: (chunk) => { sends.push(chunk.length); },
      sendControl: () => {},
    },
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: { call: () => true, assemble: () => {}, end: () => {} },
    log: (line) => { logs.push(line); },
  });
  try {
    runtime.dispatch({ type: 'utterance', text: '你好呀' });
    for (let i = 0; i < 60 && sends.length === 0; i += 1) {
      await wait(20);
    }
    assert.ok(sends.length > 0, '快车道应当直接出声');
    assert.ok(
      !logs.some((line) => line.includes('回执')),
      `快车道胜出不该有回执，实际：${JSON.stringify(logs)}`,
    );
  } finally {
    runtime.dispose();
  }
});
