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
  /** 落进档案的事件（`dialog.state.why` / `turn.end.path` 只能从这里看） */
  readonly payloads: Array<{ name: string; data: Record<string, unknown> }>;
  dispose: () => void;
}

/** `innerMs`：dsh 多久才给出答复（回执窗口的长度） */
function rig(innerMs: number, opts: { receiptChunks?: number; chunkGapMs?: number } = {}): Rig {
  const started = Date.now();
  const sends: Array<{ at: number; bytes: number }> = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const payloads: Array<{ name: string; data: Record<string, unknown> }> = [];
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
    async* synthesize() {
      // 回执默认是一块；要测「插话后还在往下发」就给多块 + 块间间隔
      const count = opts.receiptChunks ?? 1;
      for (let i = 0; i < count; i += 1) {
        if (i > 0 && (opts.chunkGapMs ?? 0) > 0) {
          await new Promise((resolve) => { setTimeout(resolve, opts.chunkGapMs); });
        }
        yield CHUNK;
      }
    },
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
    onEvent: (name, data) => { payloads.push({ name, data: data ?? {} }); },
    env: {
      call: (call) => { calls.push(call.op); return true; },
      assemble: () => {},
      end: () => {},
    },
    log: (line) => { logs.push(line); },
  });
  return {
    runtime, sends, calls, logs, payloads,
    dispose: () => { runtime.dispose(); },
  };
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

test('回执出声期间开口算插话（回执进 speaking，不留 thinking）', async () => {
  const r = rig(1_500);
  try {
    r.runtime.dispatch({ type: 'utterance', text: '帮我查一下订单' });
    await wait(120);
    assert.ok(r.sends.length > 0, `回执应当已经出声，实际：${JSON.stringify(r.logs)}`);
    assert.equal(
      r.runtime.core.fsm.state,
      'speaking',
      `回执是用户听得见的声音，状态必须进 speaking 才可打断，实际 ${r.runtime.core.fsm.state}`,
    );
    assert.ok(
      r.runtime.core.fsm.speakingIsReceiptOnly,
      '这段 speaking 只是回执，真回答还没开始',
    );

    // 用户听完「我看看」不想要了，直接开口
    r.runtime.dispatch({ type: 'partial', text: '不用了' });
    assert.equal(
      r.runtime.core.fsm.state,
      'listening',
      `插话应当成立并回到 listening，实际 ${r.runtime.core.fsm.state}`,
    );
    assert.ok(
      r.calls.includes('audio.stop'),
      `插话要清掉设备里还在念的回执，实际调用：${JSON.stringify(r.calls)}`,
    );

    // 被作废的那一轮不该再出声（否则会盖掉用户的新一句）
    const before = r.sends.length;
    await wait(1_800);
    assert.equal(
      r.sends.length,
      before,
      `插话后作废轮的答案不该再下发，实际又多发了 ${r.sends.length - before} 块`,
    );
  } finally {
    r.dispose();
  }
});

test('插话后回执立刻停发（不能接着在用户说话时播）', async () => {
  // 4 块、块间 80 ms：插话发生时合成还在跑
  const r = rig(3_000, { receiptChunks: 4, chunkGapMs: 80 });
  try {
    r.runtime.dispatch({ type: 'utterance', text: '帮我查一下订单' });
    await wait(120);
    assert.ok(r.sends.length > 0, `回执应当已经出声，实际：${JSON.stringify(r.logs)}`);
    assert.equal(r.runtime.core.fsm.state, 'speaking');

    r.runtime.dispatch({ type: 'partial', text: '不用了' });
    const sentAtBargeIn = r.sends.length;
    await wait(400);
    assert.equal(
      r.sends.length,
      sentAtBargeIn,
      `插话后不该再发回执音频，实际又多发了 ${r.sends.length - sentAtBargeIn} 块`
      + `（audio.stop 只清设备缓冲，合成循环不掐就会接着播）：${JSON.stringify(r.logs)}`,
    );
    assert.equal(r.runtime.core.fsm.state, 'listening');
  } finally {
    r.dispose();
  }
});

test('回执自然播完：退回 thinking，不推进轮次', async () => {
  const r = rig(1_500);
  try {
    r.runtime.dispatch({ type: 'utterance', text: '帮我查一下订单' });
    await wait(120);
    assert.equal(r.runtime.core.fsm.state, 'speaking');
    const ticketNo = r.runtime.core.fsm.turn;

    // CHUNK 是 0.5 s，播完就该退回 thinking（答案还在路上）
    await wait(700);
    assert.equal(
      r.runtime.core.fsm.state,
      'thinking',
      `回执播完要回 thinking 继续等答案，实际 ${r.runtime.core.fsm.state}`,
    );
    assert.equal(r.runtime.core.fsm.turn, ticketNo, '回执不该推进轮次号');
    assert.equal(
      r.runtime.core.fsm.speakingIsReceiptOnly,
      false,
      '回执结束标志要清掉',
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

test('档案里能分出「回执出声」和「答案出声」：dialog.state 带 why，turn.end 带 path', async () => {
  // 没有 why 的话，`thinking → speaking` 在档案里只是个状态名 —— 回执和真答案
  // 长得一样，而两者对「什么时候开始出声」的含义差 ~1 s。
  const r = rig(1_500);
  try {
    r.runtime.dispatch({ type: 'utterance', text: '帮我查一下订单' });
    await wait(200);
    const toSpeaking = r.payloads.filter(
      (p) => p.name === 'dialog.state' && p.data['to'] === 'speaking',
    );
    assert.ok(toSpeaking.length > 0, `该有进入 speaking 的事件，实际 ${JSON.stringify(r.payloads)}`);
    assert.match(
      String(toSpeaking[0]!.data['why']),
      /回执/,
      `第一次进 speaking 是回执，why 必须写明；实际 ${JSON.stringify(toSpeaking[0]!.data)}`,
    );

    await wait(600);
    // `turn.end` 要等 dsh 那一轮（1.5 s）+ 播放结束；轮询而不是拍脑袋等固定时长
    for (let i = 0; i < 80 && !r.payloads.some((p) => p.name === 'turn.end'); i += 1) {
      await wait(50);
    }
    const end = r.payloads.filter((p) => p.name === 'turn.end').at(-1);
    assert.ok(end, `该有一条 turn.end，实际 ${JSON.stringify(r.payloads.map((p) => p.name))}`);
    assert.equal(end.data['path'], 'dsh', '交给慢车道的轮次要记 path=dsh');
    assert.equal(end.data['delegate'], 'task', '本地判据挡住的轮次记 task');
  } finally {
    r.dispose();
  }
});
