/**
 * 两条主管道的端到端：真实 DialogRuntime + KernelRuntime + TurnRunner 单泵。
 *
 * Live 用真 OmniShadow（假 socket）和挂起的 dsh。Cascade 用假的快模型与流式 TTS。
 * 时间走 VirtualClock，安静窗就是 dialog 里那 800 ms，不睡墙钟。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DialogRuntime, type AnnounceItem } from '../src/app/dialog.ts';
import type { DeviceCall, DeviceCapabilities } from '../src/devices/primitives.ts';
import { EVENTS } from '../src/events.ts';
import type { FastVoiceEngine } from '../src/engine-contract.ts';
import { OmniShadow } from '../src/omni-shadow.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';
import {
  CascadeAgent,
  type CascadeAgentOptions,
  type CascadeEngineOptions,
  LiveOrchestrator,
  type LiveOrchestratorOptions,
} from '../src/pipelines/index.ts';
import type { RealtimeSocket } from '../src/qwen-realtime-asr.ts';
import type {
  AgentProvider,
  AgentReplyView,
  TtsProvider,
} from '../src/providers.ts';
import type { DownlinkSink } from '../src/transport.ts';

/** 与 `src/app/dialog.ts` 的 `ANNOUNCE_QUIET_MS` 相同。 */
const QUIET_MS = 800;
/** 24 kHz 下 96 字节 ≈ 2 ms，播放等待只占一个 100 ms 轮询。 */
const PCM = Buffer.alloc(96, 1);

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

interface Sent {
  type: string;
  item?: { role?: string; content?: Array<{ text?: string }> };
}

class FakeSocket {
  readyState = 0;
  readonly sent: Sent[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...args: unknown[]) => void);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }

  count(type: string): number {
    return this.sent.filter((frame) => frame.type === type).length;
  }
}

interface TimelineEvent {
  readonly name: string;
  readonly fields?: Record<string, unknown>;
}

interface DshCall {
  readonly text: string;
  readonly note?: string;
}

function mockDsh(): {
  agent: AgentProvider;
  calls: DshCall[];
  cancelCount: () => number;
  pending: () => number;
  hold: () => void;
  release: () => void;
  setResult: (view: AgentReplyView) => void;
} {
  const calls: DshCall[] = [];
  const waiters: Array<(view: AgentReplyView) => void> = [];
  let holding = false;
  let cancels = 0;
  let result: AgentReplyView = { text: '后台结论', speech: '后台结论' };
  const agent: AgentProvider = {
    name: 'dsh',
    sessionId: 'sess-pipeline',
    cancelTurn() {
      cancels += 1;
    },
    reply(text, _image, note) {
      calls.push({ text, ...(note === undefined ? {} : { note }) });
      if (!holding) return Promise.resolve(result);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
  return {
    agent,
    calls,
    cancelCount: () => cancels,
    pending: () => waiters.length,
    hold() {
      holding = true;
    },
    release() {
      const pending = waiters.splice(0);
      holding = false;
      for (const resolve of pending) resolve(result);
    },
    setResult(view) {
      result = view;
    },
  };
}

function userItemTexts(socket: FakeSocket): string[] {
  const texts: string[] = [];
  for (const frame of socket.sent) {
    if (frame.type !== 'conversation.item.create' || frame.item?.role !== 'user') continue;
    const text = frame.item.content?.[0]?.text;
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

function turnEnds(timeline: readonly TimelineEvent[]): TimelineEvent[] {
  return timeline.filter((event) => event.name === EVENTS.turnEnd);
}

async function advance(clock: VirtualClock, ms: number): Promise<void> {
  await clock.drain();
  await clock.runUntil(clock.now() + ms);
}

interface LiveRig {
  readonly clock: VirtualClock;
  readonly runtime: DialogRuntime;
  readonly live: LiveOrchestrator;
  readonly engine: FastVoiceEngine;
  readonly shadow: OmniShadow;
  readonly socket: FakeSocket;
  readonly dsh: ReturnType<typeof mockDsh>;
  readonly ttsTexts: string[];
  readonly downlink: Buffer[];
  readonly calls: DeviceCall[];
  readonly timeline: TimelineEvent[];
  readonly logs: string[];
  readonly outcomes: Array<{ readonly speech: string; readonly outcome: 'spoken' | 'defer' | 'fallback' }>;
  readonly fallbacks: Array<{ readonly speech: string; readonly interrupted: boolean }>;
  readonly stops: { canned: number; announce: number };
  readonly reconciled: Array<{ readonly truncated: boolean }>;
  seq: number;
}

function openLive(): LiveRig {
  const clock = new VirtualClock();
  const dsh = mockDsh();
  const ttsTexts: string[] = [];
  const downlink: Buffer[] = [];
  const calls: DeviceCall[] = [];
  const timeline: TimelineEvent[] = [];
  const logs: string[] = [];
  const outcomes: Array<{ readonly speech: string; readonly outcome: 'spoken' | 'defer' | 'fallback' }> = [];
  const fallbacks: Array<{ readonly speech: string; readonly interrupted: boolean }> = [];
  const stops = { canned: 0, announce: 0 };
  const reconciled: Array<{ readonly truncated: boolean }> = [];
  const socket = new FakeSocket();
  const log = (line: string): void => {
    logs.push(line);
  };
  const tts: TtsProvider = {
    name: 'fake-tts',
    sampleRate: 24_000,
    async *synthesize(text: string): AsyncGenerator<Buffer> {
      ttsTexts.push(text);
      yield Buffer.from([2, 0]);
    },
  };
  const liveOptions: LiveOrchestratorOptions = {
    inner: dsh.agent,
    tts,
    now: () => clock.now(),
    log,
  };
  const live = new LiveOrchestrator(liveOptions);
  const shadow = new OmniShadow({
    apiKey: 'k',
    serve: 'full',
    now: () => clock.now(),
    log,
    emit: () => {},
    socketFactory: () => socket as unknown as RealtimeSocket,
  });
  shadow.start();
  socket.open();
  socket.message({ type: 'session.updated' });
  live.attachAudioLane(shadow);
  const engine = live.toEngine();
  const box: { runtime?: DialogRuntime } = {};
  const runtime = new DialogRuntime({
    clock,
    caps: CAPS,
    agent: live,
    tts,
    engine,
    downlink: {
      sendAudio: (pcm) => {
        downlink.push(pcm);
      },
      sendControl: () => {},
    } satisfies DownlinkSink,
    imageQuestion: '这是什么',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    onEvent: (name, fields) => {
      timeline.push({ name, ...(fields === undefined ? {} : { fields }) });
    },
    speakAnnounce: async (item) => {
      const current = box.runtime;
      assert.ok(current !== undefined);
      const outcome = await live.speakBackgroundReport(
        item,
        (answer) => current.runner.speakAudioAnswer(answer),
      );
      outcomes.push({ speech: item.speech, outcome });
      return outcome;
    },
    cancelAnnounce: () => {
      stops.announce += 1;
      live.cancelBackgroundSpeech();
    },
    onFallbackAnnounceSpoken: (item, interrupted) => {
      fallbacks.push({ speech: item.speech, interrupted });
      live.noteFallbackAnnounceSpoken({
        speech: item.speech,
        ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
        ...(item.query === undefined ? {} : { query: item.query }),
      }, interrupted);
    },
    env: {
      call: (call) => {
        calls.push(call);
        return true;
      },
      assemble: () => {},
      end: () => {},
    },
    log,
  });
  box.runtime = runtime;
  const originalReconcile = live.reconcileTurnOutcome.bind(live);
  live.reconcileTurnOutcome = (info) => {
    reconciled.push({ truncated: info.truncated });
    originalReconcile(info);
  };
  const originalCanned = runtime.runner.cancelCanned.bind(runtime.runner);
  runtime.runner.cancelCanned = () => {
    stops.canned += 1;
    originalCanned();
  };
  live.setTaskReporter((report) => {
    const item: AnnounceItem = {
      speech: report.verbatim ?? report.summary,
      taskId: report.taskId,
      query: report.query,
      ...(report.emotion === undefined ? {} : { emotion: report.emotion }),
      ...(report.verbatim === undefined ? {} : { verbatim: true }),
      ...(report.needsConfirm === undefined ? {} : { needsConfirm: report.needsConfirm }),
    };
    runtime.enqueueAnnounce(item);
  });
  return {
    clock,
    runtime,
    live,
    engine,
    shadow,
    socket,
    dsh,
    ttsTexts,
    downlink,
    calls,
    timeline,
    logs,
    outcomes,
    fallbacks,
    stops,
    reconciled,
    seq: 0,
  };
}

function closeLive(h: LiveRig): void {
  h.runtime.dispose();
  h.shadow.stop();
  h.live.dispose();
  h.dsh.release();
}

function beginUser(h: LiveRig, text: string, script: { readonly transcript: string; readonly tool?: string }): void {
  h.shadow.restart([Buffer.alloc(32)]);
  h.shadow.feed(Buffer.alloc(64), true);
  h.seq += 1;
  h.shadow.seal(h.seq, 20);
  h.socket.message({ type: 'response.created' });
  if (script.tool !== undefined) {
    h.socket.message({
      type: 'response.function_call_arguments.done',
      arguments: JSON.stringify({ request: script.tool, reason: '需要外部信息' }),
    });
  }
  h.socket.message({ type: 'response.audio_transcript.delta', delta: script.transcript });
  h.socket.message({ type: 'response.audio.delta', delta: PCM.toString('base64') });
  h.runtime.dispatch({ type: 'utterance', text });
}

async function finishUserAudio(h: LiveRig): Promise<void> {
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await advance(h.clock, 300);
}

async function completeUserTurn(
  h: LiveRig,
  text: string,
  script: { readonly transcript: string; readonly tool?: string },
): Promise<void> {
  beginUser(h, text, script);
  await h.clock.drain();
  await finishUserAudio(h);
}

function downlinkBytes(h: LiveRig): number {
  return h.downlink.reduce((sum, chunk) => sum + chunk.length, 0);
}

async function playOmniReport(h: LiveRig, marker: string): Promise<void> {
  const before = h.socket.count('response.create');
  for (let i = 0; i < 8; i += 1) {
    await h.clock.drain();
    const opened = userItemTexts(h.socket).some(
      (text) => text.includes('用一两句口语') && text.includes(marker),
    );
    if (opened && h.socket.count('response.create') > before) {
      h.socket.message({ type: 'response.created' });
      h.socket.message({ type: 'response.audio_transcript.delta', delta: '汇报完了。' });
      h.socket.message({ type: 'response.audio.delta', delta: PCM.toString('base64') });
      await h.clock.drain();
      h.socket.message({ type: 'response.done', response: { status: 'completed' } });
      await advance(h.clock, 300);
      return;
    }
    await advance(h.clock, 400);
  }
  throw new Error(`omni 汇报没有开口（${marker}）\n${h.logs.join('\n')}`);
}

function sse(tokens: string[]): Response {
  const body = tokens
    .map((token) => `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('正常 Live 轮：omni 单泵出声，内核回到 listening，dsh 与 FastLlmClient 都不参与', async () => {
  const h = openLive();
  try {
    assert.equal(h.engine.mode, 'live');
    await completeUserTurn(h, '你好呀', { transcript: '在呢。' });

    assert.equal(h.runtime.core.phase, 'listening');
    assert.equal(h.runtime.core.runtime.state.ledger.lastLane, 'live');
    assert.equal(h.live.lastLedgerLane(), 'live');
    assert.equal(h.dsh.calls.length, 0, '闲聊不得叫 dsh');
    assert.deepEqual(h.ttsTexts, [], '闲聊不得走 TTS，FastLlmClient 也不在这条管线上');
    assert.ok(downlinkBytes(h) > 0, '音频要经过 TurnRunner 单泵下发');
    assert.ok(h.socket.count('response.create') >= 1);
    assert.ok(h.socket.count('input_audio_buffer.commit') >= 1);
    const ended = turnEnds(h.timeline);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.fields?.['path'], 'omni');
    assert.equal(ended[0]?.fields?.['said'], '在呢。');
    assert.equal(h.reconciled.length >= 1, true);
    assert.equal(h.reconciled.every((item) => item.truncated === false), true);
    assert.equal(h.outcomes.length, 0);
  } finally {
    closeLive(h);
  }
});

test('tool_call 不阻塞：空窗后同一副 omni 嗓子汇报，TTS 不参与', async () => {
  const h = openLive();
  try {
    h.dsh.hold();
    h.dsh.setResult({ text: '明天有雨。', speech: '明天有雨。' });
    await completeUserTurn(h, '今天天气怎么样', {
      transcript: '我查查。',
      tool: '查明天的天气',
    });

    assert.equal(h.runtime.core.phase, 'listening', '垫话播完就回到 listening，不等 dsh');
    assert.equal(h.dsh.pending(), 1, 'dsh 还挂在后台');
    assert.equal(h.dsh.cancelCount(), 0);
    assert.equal(h.dsh.calls.length, 1);
    assert.match(h.dsh.calls[0]?.text ?? '', /查明天的天气/);
    assert.match(h.dsh.calls[0]?.text ?? '', /今天天气怎么样/);
    assert.match(h.dsh.calls[0]?.note ?? '', /无头执行/);
    assert.deepEqual(h.ttsTexts, []);
    const leadIn = turnEnds(h.timeline).at(-1);
    assert.equal(leadIn?.fields?.['path'], 'omni');
    assert.equal(h.runtime.core.runtime.state.ledger.lastLane, 'live');

    h.dsh.release();
    await playOmniReport(h, '明天有雨');

    assert.equal(h.runtime.core.phase, 'listening');
    assert.ok(h.outcomes.some((item) => item.outcome === 'spoken' && item.speech.includes('明天有雨')));
    assert.deepEqual(h.ttsTexts, [], '同嗓子汇报不得走 TTS synthesize');
    const prompt = userItemTexts(h.socket).find((text) => text.includes('用一两句口语'));
    assert.ok(prompt !== undefined, 'speakFromText 要写一条 role:user');
    assert.match(prompt ?? '', /明天有雨/);
    assert.equal(h.socket.sent.filter((frame) => frame.type === 'error').length, 0);
  } finally {
    closeLive(h);
  }
});

test('插话不取消后台 dsh；忙时 defer；播报中再插话立刻停', async () => {
  const h = openLive();
  try {
    h.dsh.hold();
    h.dsh.setResult({ text: '明天有雨。', speech: '明天有雨。' });
    beginUser(h, '今天天气怎么样', { transcript: '我查查。', tool: '查明天的天气' });
    await h.clock.drain();
    h.socket.message({ type: 'response.done', response: { status: 'completed' } });
    await h.clock.drain();
    assert.equal(h.runtime.core.phase, 'speaking');
    assert.equal(h.dsh.pending(), 1);
    assert.equal(h.dsh.cancelCount(), 0);

    const stopsBefore = h.calls.filter((call) => call.op === 'audio.stop').length;
    h.runtime.dispatch({ type: 'partial', text: '等一下' });
    assert.equal(h.dsh.cancelCount(), 0, '插话不得 cancelTurn 到后台 dsh');
    assert.equal(h.dsh.pending(), 1, 'dsh 继续跑');
    assert.equal(
      h.calls.filter((call) => call.op === 'audio.stop').length,
      stopsBefore + 1,
      'speaking 插话要下发 audio.stop',
    );
    await advance(h.clock, 300);
    assert.equal(h.runtime.core.phase, 'listening');
    assert.equal(h.dsh.cancelCount(), 0);

    await advance(h.clock, QUIET_MS);
    const creates = h.socket.count('response.create');
    h.shadow.restart([Buffer.alloc(32)]);
    h.shadow.feed(Buffer.alloc(64), true);
    h.seq += 1;
    h.shadow.seal(h.seq, 20);
    h.socket.message({ type: 'response.created' });
    assert.equal(h.shadow.canSpeakBackground(), false, '新一轮 omni 还在生成');
    h.dsh.release();
    await h.clock.drain();

    assert.equal(h.outcomes.at(-1)?.outcome, 'defer');
    assert.equal(h.socket.count('response.create'), creates + 1, 'defer 不得再发 response.create');
    assert.equal(h.socket.sent.filter((frame) => frame.type === 'error').length, 0);
    assert.ok(h.logs.some((line) => line.includes('前台车道正忙')));
    const deferred = h.outcomes.at(-1)?.speech ?? '';

    h.socket.message({ type: 'response.audio_transcript.delta', delta: '在的。' });
    h.socket.message({ type: 'response.audio.delta', delta: PCM.toString('base64') });
    h.runtime.dispatch({ type: 'utterance', text: '你好呀' });
    await h.clock.drain();
    assert.equal(h.dsh.cancelCount(), 0);
    assert.equal(h.dsh.calls.length, 1, '跟进的闲聊不得再派一条 dsh');
    await finishUserAudio(h);
    assert.equal(h.runtime.core.phase, 'listening');
    assert.equal(h.dsh.cancelCount(), 0);

    await playOmniReport(h, '明天有雨');
    assert.ok(h.outcomes.some((item) => item.outcome === 'spoken' && item.speech === deferred));
    assert.deepEqual(h.ttsTexts, []);
    assert.ok(userItemTexts(h.socket).some((text) => text.includes('用一两句口语') && text.includes('明天有雨')));

    const beforeCreates = h.socket.count('response.create');
    const beforeCancels = h.socket.count('response.cancel');
    const beforeCanned = h.stops.canned;
    const beforeAnnounce = h.stops.announce;
    h.runtime.enqueueAnnounce({
      speech: '机票订好了。',
      query: '订机票',
      taskId: 'book-2',
    });
    let barged = false;
    for (let i = 0; i < 8 && !barged; i += 1) {
      await h.clock.drain();
      const opened = userItemTexts(h.socket).some(
        (text) => text.includes('用一两句口语') && text.includes('机票订好了'),
      );
      if (opened && h.socket.count('response.create') > beforeCreates) {
        h.socket.message({ type: 'response.created' });
        h.socket.message({ type: 'response.audio.delta', delta: PCM.toString('base64') });
        await h.clock.drain();
        const bytes = downlinkBytes(h);
        assert.ok(bytes > 0);
        h.runtime.dispatch({ type: 'partial', text: '等一下' });
        assert.equal(h.stops.announce, beforeAnnounce + 1, 'cancelAnnounce 要立刻停 omni 汇报');
        assert.equal(h.stops.canned, beforeCanned + 1, 'cancelCanned 要立刻停下行');
        assert.equal(h.socket.count('response.cancel'), beforeCancels + 1);
        assert.equal(downlinkBytes(h), bytes, '插话之后不得再往下发音频');
        h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
        await advance(h.clock, 300);
        barged = true;
        break;
      }
      await advance(h.clock, 400);
    }
    assert.equal(barged, true, `播报中的插话没有发生\n${h.logs.join('\n')}`);
    assert.deepEqual(h.ttsTexts, []);
  } finally {
    closeLive(h);
  }
});

test('别查了：取消后台 dsh，迟到结果不播，回答好，不查了', async () => {
  const h = openLive();
  try {
    h.dsh.hold();
    h.dsh.setResult({ text: '还在查。', speech: '还在查。' });
    await completeUserTurn(h, '今天天气怎么样', {
      transcript: '我查查。',
      tool: '查明天的天气',
    });
    assert.equal(h.dsh.pending(), 1);
    assert.equal(h.runtime.core.phase, 'listening');

    h.runtime.dispatch({ type: 'utterance', text: '别查了' });
    await advance(h.clock, 500);

    assert.equal(h.dsh.cancelCount(), 1);
    assert.equal(h.dsh.pending(), 1, '取消只掐任务，不替 dsh 把 Promise 结算掉');
    assert.ok(h.ttsTexts.includes('好，不查了。'));
    assert.equal(h.runtime.core.phase, 'listening');
    const ended = turnEnds(h.timeline).at(-1);
    assert.equal(ended?.fields?.['path'], 'omni');
    assert.equal(ended?.fields?.['said'], '好，不查了。');

    h.dsh.setResult({ text: '迟到的港口结论XYZ', speech: '迟到的港口结论XYZ' });
    h.dsh.release();
    await advance(h.clock, QUIET_MS + 800);

    assert.equal(h.outcomes.length, 0, '被取消的任务不得再入播报队列');
    assert.equal(h.ttsTexts.includes('迟到的港口结论XYZ'), false);
    assert.equal(userItemTexts(h.socket).some((text) => text.includes('迟到的港口结论XYZ')), false);
    assert.equal(h.socket.sent.filter((frame) => frame.type === 'error').length, 0);
  } finally {
    closeLive(h);
  }
});

test('静默记忆：立刻用 omni 回答，dsh 后台记下，零汇报', async () => {
  const h = openLive();
  try {
    h.dsh.hold();
    await completeUserTurn(h, '我最喜欢吃辣椒炒肉', { transcript: '好，我记下了。' });

    assert.equal(h.runtime.core.phase, 'listening');
    assert.equal(h.dsh.pending(), 1, '回答不等人记完');
    assert.equal(h.dsh.calls.length, 1);
    assert.equal(h.dsh.calls[0]?.text, '我最喜欢吃辣椒炒肉');
    assert.match(h.dsh.calls[0]?.note ?? '', /无头执行/);
    assert.ok(downlinkBytes(h) > 0);
    assert.equal(turnEnds(h.timeline).at(-1)?.fields?.['path'], 'omni');
    assert.equal(h.outcomes.length, 0);
    assert.deepEqual(h.ttsTexts, []);

    h.dsh.release();
    await advance(h.clock, QUIET_MS + 800);
    assert.equal(h.outcomes.length, 0, 'memory_silent 不得产生汇报');
    assert.deepEqual(h.ttsTexts, []);
    assert.equal(
      userItemTexts(h.socket).some((text) => text.includes('用一两句口语')),
      false,
    );
  } finally {
    closeLive(h);
  }
});

test('逐字汇报：TTS 原文朗读，绕开 speakFromText，并按 spoken 回注', async () => {
  const h = openLive();
  const verbatim = '端口 63993 订单 W8665881';
  try {
    h.dsh.hold();
    await completeUserTurn(h, '查一下订单', { transcript: '我查查。' });
    assert.equal(h.dsh.calls.length, 1);
    assert.equal(h.dsh.calls[0]?.text, '查一下订单');
    assert.equal(h.runtime.core.phase, 'listening');
    const creates = h.socket.count('response.create');

    h.dsh.setResult({ text: verbatim, speech: verbatim });
    h.dsh.release();
    await advance(h.clock, QUIET_MS + 800);

    assert.ok(h.ttsTexts.includes(verbatim), `TTS 要逐字念，实际 ${JSON.stringify(h.ttsTexts)}`);
    assert.equal(
      h.outcomes.some((item) => item.speech === verbatim),
      false,
      'verbatim 不得进 speakFromText',
    );
    assert.equal(h.socket.count('response.create'), creates, '不得为逐字稿再 response.create');
    assert.equal(
      userItemTexts(h.socket).some((text) => text.includes('用一两句口语')),
      false,
    );
    const injected = userItemTexts(h.socket).find((text) => text.includes('已经用语音把下面这段念给他了'));
    assert.ok(injected !== undefined, '要按 spoken 静默回注');
    assert.match(injected ?? '', /63993/);
    assert.match(injected ?? '', /W8665881/);
    assert.equal(h.fallbacks.length, 1);
    assert.equal(h.fallbacks[0]?.interrupted, false);
    assert.equal(h.fallbacks[0]?.speech, verbatim);
    assert.equal(h.runtime.core.phase, 'listening');
  } finally {
    closeLive(h);
  }
});

test('纯级联：快车道流式、动作轮走 dsh 并回落整段 TTS，没有 omni 车道', async () => {
  const clock = new VirtualClock();
  const dsh = mockDsh();
  dsh.setResult({ text: '已经设好提醒。', speech: '已经设好提醒。' });
  const timeline: TimelineEvent[] = [];
  const logs: string[] = [];
  const downlink: Buffer[] = [];
  const synth: string[] = [];
  const streamAttempts: string[] = [];
  let streamFailures = 0;
  let fetches = 0;
  let failStream = false;
  const tts: TtsProvider = {
    name: 'fake-tts',
    sampleRate: 24_000,
    async *synthesize(text: string): AsyncGenerator<Buffer> {
      synth.push(text);
      yield Buffer.from([2, 0]);
    },
    async *synthesizeStream(chunks: AsyncIterable<string>): AsyncGenerator<Buffer> {
      streamAttempts.push('stream');
      if (failStream) {
        streamFailures += 1;
        throw new Error('流式合成失败');
      }
      for await (const piece of chunks) {
        if (piece === '') continue;
        yield Buffer.from([1, 0]);
      }
    },
  };
  const fetchImpl: typeof fetch = async (_url, init) => {
    fetches += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ content?: string }>;
    };
    assert.match(body.messages?.[0]?.content ?? '', /米馍/);
    return sse(['[平静]在呢。']);
  };
  const cascadeOptions: CascadeAgentOptions = {
    inner: dsh.agent,
    apiKey: 'k',
    fetchImpl,
    now: () => clock.now(),
    log: (line) => {
      logs.push(line);
    },
    speculate: false,
    prefetch: false,
  };
  const agent = new CascadeAgent(cascadeOptions);
  assert.equal('attachAudioLane' in agent, false);
  assert.equal('willServeAudio' in agent, false);
  const engineOptions: CascadeEngineOptions = { now: () => clock.now() };
  const engine = agent.toEngine(tts, engineOptions);
  assert.equal(engine.mode, 'cascade');
  const reconciled: Array<{ readonly truncated: boolean; readonly endedAtMs: number }> = [];
  const runtime = new DialogRuntime({
    clock,
    caps: CAPS,
    agent,
    tts,
    engine,
    downlink: {
      sendAudio: (pcm) => {
        downlink.push(pcm);
      },
      sendControl: () => {},
    },
    imageQuestion: '这是什么',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    onEvent: (name, fields) => {
      timeline.push({ name, ...(fields === undefined ? {} : { fields }) });
    },
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
    },
    log: (line) => {
      logs.push(line);
    },
  });
  const original = agent.reconcileTurnOutcome.bind(agent);
  agent.reconcileTurnOutcome = (info) => {
    reconciled.push({ truncated: info.truncated, endedAtMs: info.endedAtMs });
    original(info);
  };
  try {
    runtime.dispatch({ type: 'utterance', text: '你好呀' });
    await advance(clock, 1_000);

    assert.equal(runtime.core.phase, 'listening');
    assert.equal(fetches, 1);
    assert.equal(dsh.calls.length, 0);
    assert.equal(streamAttempts.length, 1);
    assert.equal(streamFailures, 0);
    assert.equal(synth.length, 0, '快车道命中流式 TTS，不得退回整段');
    assert.ok(downlink.length > 0);
    assert.equal(runtime.core.runtime.state.ledger.lastLane, 'cascade');
    assert.equal(agent.lastLedgerLane(), 'cascade');
    assert.equal(agent.ledgerTurns.at(-1)?.lane, 'cascade');
    assert.equal(agent.ledgerTurns.at(-1)?.assistantText, '在呢。');
    assert.equal(agent.ledgerTurns.at(-1)?.truncated, false);
    assert.ok((agent.ledgerTurns.at(-1)?.endedAtMs ?? 0) >= 100, '结算要把账本时刻写成播完的时刻');
    assert.equal(turnEnds(timeline).at(-1)?.fields?.['path'], 'fast');
    assert.equal(turnEnds(timeline).at(-1)?.fields?.['said'], '在呢。');
    assert.equal(reconciled.some((item) => item.truncated === false), true);

    failStream = true;
    runtime.dispatch({ type: 'utterance', text: '提醒我喝水' });
    await advance(clock, 1_000);

    assert.equal(runtime.core.phase, 'listening');
    assert.equal(fetches, 1, '动作句不得再问快模型');
    assert.equal(dsh.calls.length, 1);
    assert.equal(dsh.calls[0]?.text, '提醒我喝水');
    assert.equal(streamFailures, 1);
    assert.ok(logs.some((line) => line.includes('退回整段合成')));
    assert.ok(synth.includes('已经设好提醒。'), `整段回落要念 dsh 的话，实际 ${JSON.stringify(synth)}`);
    assert.equal(runtime.core.runtime.state.ledger.lastLane, 'dsh');
    assert.equal(agent.lastLedgerLane(), 'dsh');
    assert.equal(agent.ledgerTurns.at(-1)?.lane, 'dsh');
    assert.equal(agent.ledgerTurns.at(-1)?.truncated, false);
    const ended = turnEnds(timeline).at(-1);
    assert.equal(ended?.fields?.['path'], 'dsh');
    assert.equal(ended?.fields?.['delegate'], 'task');
    assert.equal('attachAudioLane' in agent, false);
    assert.equal('willServeAudio' in agent, false);
    assert.equal(reconciled.filter((item) => item.truncated === false).length >= 2, true);
  } finally {
    runtime.dispose();
    dsh.release();
  }
});
