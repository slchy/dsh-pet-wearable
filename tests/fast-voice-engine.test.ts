/**
 * 两条快车道引擎的契约测试。
 *
 * 内核只认 `FastVoiceEngine.respond()` 产出的 `EngineEvent`（见 `engine-contract.ts`），
 * Live 与 Cascade 的差别**只允许**在这一层下面。所以除了各自的细节，这里还钉一条
 * 「同构」：同样的内容，两条引擎给出同一套事件词汇、同一个 `fullText` ——
 * 内核那边没有 `分支=omni` / `分支=stream` 两段代码可写。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getEventListeners } from 'node:events';

import type { EngineEvent, FastVoiceEngine, TurnInput } from '../src/engine-contract.ts';
import type { AgentProvider, AgentReplyView, TtsProvider, TurnContext } from '../src/providers.ts';
import { AgentEngineAdapter } from '../src/engines/index.ts';
import { CascadeVoiceEngine } from '../src/engines/cascade-voice-engine.ts';
import { LiveVoiceEngine } from '../src/engines/live-voice-engine.ts';
import { createAbortGate, EventQueue, spokenFromStream } from '../src/engines/stream-utils.ts';
import { FrontedAgent } from '../src/fronted-agent.ts';

const TURN: TurnInput = {
  text: '你好呀',
  no: 1,
  baseCommitSeq: 0,
  startedAtMs: 0,
  hasImage: false,
};

/** 收完一条引擎事件流 */
async function drain(
  engine: FastVoiceEngine,
  signal: AbortSignal = new AbortController().signal,
): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const event of engine.respond(TURN, signal)) {
    out.push(event);
  }
  return out;
}

function types(events: readonly EngineEvent[]): string[] {
  return events.map((event) => event.type);
}

function audioBytes(events: readonly EngineEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === 'audio') {
      total += event.pcm.length;
    }
  }
  return total;
}

function textOf(events: readonly EngineEvent[]): string {
  let out = '';
  for (const event of events) {
    if (event.type === 'text') {
      out += event.delta;
    }
  }
  return out;
}

function doneText(events: readonly EngineEvent[]): string {
  const last = events[events.length - 1];
  assert.ok(last !== undefined && last.type === 'done', '最后一条必须是 done');
  return last.fullText;
}

/** 流式 TTS：每收到一段文本就出一块音频（模拟真实 provider 的边生成边合成） */
function streamTts(seen: string[]): TtsProvider {
  return {
    name: 'stream',
    sampleRate: 24_000,
    async *synthesize(text) {
      seen.push(`whole:${text}`);
      yield Buffer.alloc(480);
    },
    async *synthesizeStream(chunks) {
      for await (const chunk of chunks) {
        seen.push(`stream:${chunk}`);
        yield Buffer.alloc(240);
      }
    },
  };
}

/** 整段 TTS：只实现 `synthesize`（旧 provider 的形状） */
function wholeTts(seen: string[]): TtsProvider {
  return {
    name: 'whole',
    sampleRate: 24_000,
    async *synthesize(text) {
      seen.push(`whole:${text}`);
      yield Buffer.alloc(480);
    },
  };
}

/** 内层 agent 的最小实现：这两条适配器不碰内层，给个能构造的对象就够 */
function stubInner(): AgentProvider {
  return {
    name: 'stub',
    async reply(text) {
      return { text, speech: text };
    },
  };
}

/** 假的快模型：把 `pieces` 当成 SSE 的逐字增量回出去（形状与真 provider 一致） */
function sseFetch(pieces: readonly string[]): typeof fetch {
  return (() => Promise.resolve(new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const piece of pieces) {
          const data = JSON.stringify({ choices: [{ delta: { content: piece } }] });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200 },
  ))) as unknown as typeof fetch;
}

// ------------------------------------------------------------------ Live

test('LiveVoiceEngine：逐块 audio + 文本增量 + done', async () => {
  let said = '';
  const engine = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => ({
      sampleRate: 24_000,
      transcript: () => said,
      chunks: (async function* generate() {
        said = '你好';
        yield Buffer.alloc(480);
        said = '你好呀';
        yield Buffer.alloc(960);
      })(),
    }),
    discard: () => {},
    interrupt: () => {},
  });

  const events = await drain(engine);
  assert.deepEqual(types(events), ['meta', 'audio', 'text', 'audio', 'text', 'done']);
  assert.equal(audioBytes(events), 1440);
  assert.equal(textOf(events), '你好呀', '转写是活的：增长多少补多少增量');
  assert.equal(doneText(events), '你好呀');
});

test('LiveVoiceEngine：拿不到认领就给 done（零音频，但不许不给结论）', async () => {
  const engine = new LiveVoiceEngine({
    willServe: () => false,
    claim: () => null,
    discard: () => {},
  });
  const events = await drain(engine);
  assert.deepEqual(types(events), ['done']);
  assert.equal(doneText(events), '');
});

test('LiveVoiceEngine：tool_call → delegate 带 rewrittenQuery', async () => {
  const engine = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => ({
      sampleRate: 24_000,
      transcript: () => '我看看。',
      chunks: (async function* generate() {
        yield Buffer.alloc(480);
      })(),
      delegateReason: () => 'delegate',
      delegateText: () => '把客厅的灯关掉',
    }),
    discard: () => {},
  });

  const events = await drain(engine);
  assert.deepEqual(types(events), ['meta', 'audio', 'text', 'delegate', 'done']);
  const delegate = events[3]!;
  assert.equal(delegate.type, 'delegate');
  if (delegate.type === 'delegate') {
    assert.equal(delegate.reason, 'delegate');
    assert.equal(delegate.rewrittenQuery, '把客厅的灯关掉');
  }
  assert.equal(doneText(events), '我看看。', '垫音也是这一轮说出去的话');
});

test('LiveVoiceEngine：barge_in 走 interrupt，delegated/superseded 走 discard', () => {
  const calls: string[] = [];
  const engine = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => null,
    discard: () => { calls.push('discard'); },
    interrupt: () => { calls.push('interrupt'); },
  });

  engine.abortSpeculation('barge_in');
  engine.abortSpeculation('delegated');
  engine.abortSpeculation('superseded');
  assert.deepEqual(calls, ['interrupt', 'discard', 'discard'],
    '插话要留着已播的半句，委派/顶替要把整条回复删掉');

  // 车道没有 interrupt 时，插话退回 discard —— 不能什么都不做
  const fallback: string[] = [];
  const bare = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => null,
    discard: () => { fallback.push('discard'); },
  });
  bare.abortSpeculation('barge_in');
  assert.deepEqual(fallback, ['discard']);
});

test('LiveVoiceEngine：上行帧直通车道，健康度只报事实', () => {
  const fed: Array<{ voiced: boolean | undefined; bytes: number }> = [];
  let healthy = true;
  const engine = new LiveVoiceEngine({
    willServe: () => healthy,
    claim: () => null,
    discard: () => {},
    feed: (pcm, voiced) => { fed.push({ voiced, bytes: pcm.length }); },
  });

  assert.equal(engine.isHealthy(), true);
  engine.onAudioFrame({ pcm: Buffer.alloc(320), voiced: false, silenceMs: 200, gateSeq: 3, tsMs: 1000 });
  assert.deepEqual(fed, [{ voiced: false, bytes: 320 }], 'voiced 必须原样透传（门控后的人声态）');

  healthy = false;
  assert.equal(engine.isHealthy(), false);
});

test('LiveVoiceEngine：中止后不再产音频，也不给 done', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  // 默认是空操作：万一引擎压根没读第二块，调用它也不会炸
  let release: () => void = () => {};
  const engine = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => ({
      sampleRate: 24_000,
      transcript: () => '半句',
      chunks: (async function* generate() {
        yield Buffer.alloc(480);
        // 真实车道上这里可能挂在 `waitLive()` 上：中止必须能把它甩掉
        await new Promise<void>((resolve) => { release = () => { resolve(); }; });
        yield Buffer.alloc(480);
      })(),
    }),
    discard: () => {},
    interrupt: () => {},
  });

  const events: EngineEvent[] = [];
  for await (const event of engine.respond(TURN, controller.signal)) {
    events.push(event);
    if (event.type === 'audio') {
      controller.abort();
    }
  }
  release();

  assert.deepEqual(types(events), ['meta', 'audio', 'text'], '中止之后一块音频都不许再出');
  assert.equal(types(events).includes('done'), false);
});

// ------------------------------------------------------------------ Cascade

test('CascadeVoiceEngine：流式 TTS 把增量一出来就送过去', async () => {
  const seen: string[] = [];
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    tts: streamTts(seen),
    ask: async (_turn, emit) => {
      emit('你好');
      emit('呀。');
      return { text: '你好呀。', speech: '你好呀。' };
    },
  });

  const events = await drain(engine);
  assert.deepEqual(seen, ['stream:你好', 'stream:呀。'], '不等整段回来才开合成');
  assert.equal(textOf(events), '你好呀。');
  assert.ok(audioBytes(events) > 0);
  assert.equal(doneText(events), '你好呀。');
  assert.equal(types(events).includes('delegate'), false);
});

test('CascadeVoiceEngine：没有流式合成时等整段，用 speech 而不是 text', async () => {
  const seen: string[] = [];
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    tts: wholeTts(seen),
    ask: async (_turn, emit) => {
      emit('原始');
      // 整段合成必须拿清洗后的 `speech`：`text` 里的 markdown 会被 TTS 念出来
      return { text: '**原始**', speech: '原始' };
    },
  });

  const events = await drain(engine);
  assert.deepEqual(seen, ['whole:原始']);
  assert.equal(textOf(events), '原始');
  assert.equal(doneText(events), '**原始**', 'done 给原始文本（记账用）');
  assert.ok(audioBytes(events) > 0);
});

test('CascadeVoiceEngine：delegated → delegate 事件，空 speech 不开合成', async () => {
  const seen: string[] = [];
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    tts: wholeTts(seen),
    ask: async () => ({ text: '', speech: '', delegated: true, delegateReason: 'delegate' }),
  });

  const events = await drain(engine);
  assert.deepEqual(types(events), ['delegate', 'meta', 'done']);
  const delegate = events[0]!;
  assert.equal(delegate.type, 'delegate');
  if (delegate.type === 'delegate') {
    assert.equal(delegate.reason, 'delegate');
    assert.equal(delegate.rewrittenQuery, null, '级联这边没有 omni 那句改写，交给 dsh 原话');
  }
  assert.deepEqual(seen, [], '空文本合成会被服务端拒，干脆不发');
  assert.equal(doneText(events), '');
});

test('CascadeVoiceEngine：AbortSignal 中断后立刻收尾，不再产事件', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    tts: streamTts([]),
    ask: async (_turn, emit, signal) => {
      emit('第一句');
      // 真实实现会被 `signal` 打断；这里模拟「等到中止才回来」
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
      return { text: '不该用到这句', speech: '不该用到这句' };
    },
  });

  const events: EngineEvent[] = [];
  for await (const event of engine.respond(TURN, controller.signal)) {
    events.push(event);
    if (event.type === 'text') {
      controller.abort();
    }
  }

  assert.equal(types(events).includes('done'), false, '中止的一轮没有结论要交');
  assert.deepEqual(types(events), ['text'], '中止后音频也不许再出');
});

test('CascadeVoiceEngine：上行中间结果/定稿/放弃投机都是同步转发', () => {
  const got: string[] = [];
  const engine = new CascadeVoiceEngine({
    isReady: () => false,
    tts: wholeTts([]),
    ask: async () => ({ text: '', speech: '' }),
    onPartial: (text) => { got.push(`partial:${text}`); },
    onFinal: (text) => { got.push(`final:${text}`); },
    onAbort: (reason) => { got.push(`abort:${reason}`); },
  });

  assert.equal(engine.isHealthy(), false, '健康度只报 isReady 的事实');
  engine.onAsrPartial?.('你', 7);
  engine.onAsrFinal?.('你好', 8);
  engine.abortSpeculation('superseded');
  assert.deepEqual(got, ['partial:你', 'final:你好', 'abort:superseded']);
});

// ------------------------------------------------------------------ 同构

test('两条引擎的事件流同构：同一套词汇、同一个 fullText', async () => {
  let said = '';
  const live = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => ({
      sampleRate: 24_000,
      transcript: () => said,
      chunks: (async function* generate() {
        said = '你好';
        yield Buffer.alloc(480);
        said = '你好呀';
        yield Buffer.alloc(480);
      })(),
    }),
    discard: () => {},
  });
  const cascade = new CascadeVoiceEngine({
    isReady: () => true,
    tts: streamTts([]),
    ask: async (_turn, emit) => {
      emit('你好');
      emit('呀');
      return { text: '你好呀', speech: '你好呀' };
    },
  });

  const a = await drain(live);
  const b = await drain(cascade);

  assert.deepEqual([...new Set(types(a))].sort(), [...new Set(types(b))].sort());
  assert.equal(doneText(a), doneText(b));
  assert.equal(textOf(a), textOf(b));
  assert.ok(audioBytes(a) > 0 && audioBytes(b) > 0);
  for (const event of [...a, ...b]) {
    assert.ok(['audio', 'text', 'delegate', 'meta', 'done'].includes(event.type));
  }
});

// ------------------------------------------------------------------ 生产接线

test('FrontedAgent.toLiveEngine：没挂车道给 null，挂了给可用的 Live 引擎', async () => {
  const idle = new FrontedAgent({ inner: stubInner(), apiKey: '' });
  assert.equal(idle.toLiveEngine(), null, '没挂车道 = 这条腿不存在');

  const agent = new FrontedAgent({ inner: stubInner(), apiKey: '' });
  let said = '';
  agent.attachAudioLane({
    willServe: () => true,
    claim: () => ({
      sampleRate: 24_000,
      transcript: () => said,
      chunks: (async function* generate() {
        said = '你好呀';
        yield Buffer.alloc(480);
      })(),
    }),
    discard: () => {},
  });

  const engine = agent.toLiveEngine();
  assert.ok(engine !== null);
  assert.equal(engine.mode, 'live');
  assert.equal(engine.isHealthy(), true);

  const events = await drain(engine);
  assert.deepEqual(types(events), ['meta', 'audio', 'text', 'done']);
  assert.equal(doneText(events), '你好呀');
});

test('FrontedAgent.toCascadeEngine：复用快模型与提示词，产出可用的 Cascade 引擎', async () => {
  const seen: string[] = [];
  const agent = new FrontedAgent({
    inner: stubInner(),
    apiKey: 'test-key',
    fetchImpl: sseFetch(['[开心]你好呀。']),
  });

  const idle = new FrontedAgent({ inner: stubInner(), apiKey: '' });
  assert.equal(idle.toCascadeEngine(wholeTts([])).isHealthy(), false, '健康度只看有没有 key');

  const engine = agent.toCascadeEngine(wholeTts(seen));
  assert.equal(engine.mode, 'cascade');
  assert.equal(engine.isHealthy(), true);
  assert.equal(typeof engine.onAsrPartial, 'function');
  assert.equal(typeof engine.onAsrFinal, 'function');

  const events = await drain(engine);
  assert.equal(textOf(events), '[开心]你好呀。', '逐字增量原样下行（记账 / 对齐用）');
  assert.equal(doneText(events), '[开心]你好呀。');
  // 整段合成拿的是清洗后的 `speech`：情绪标签先剥掉，不会被念成「方括号开心」
  assert.deepEqual(seen, ['whole:你好呀。']);
  assert.ok(audioBytes(events) > 0);

  // 放弃投机是同步转发：没有在途请求时也必须安全
  engine.abortSpeculation('barge_in');
  engine.abortSpeculation('delegated');
});

function metaOf(events: readonly EngineEvent[]): Extract<EngineEvent, { type: 'meta' }>[] {
  return events.filter((event): event is Extract<EngineEvent, { type: 'meta' }> => event.type === 'meta');
}

function lastDone(events: readonly EngineEvent[]): Extract<EngineEvent, { type: 'done' }> {
  const last = events[events.length - 1];
  assert.ok(last !== undefined && last.type === 'done', '最后一条必须是 done');
  return last;
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

// ------------------------------------------------------------------ 热路径字段

test('LiveVoiceEngine：认领成功带 meta path=omni，音频带 sampleRate，done.speech 是转写', async () => {
  let said = '';
  const engine = new LiveVoiceEngine({
    willServe: () => true,
    claim: () => ({
      sampleRate: 16_000,
      transcript: () => said,
      chunks: (async function* generate() {
        said = '在呢';
        yield Buffer.alloc(320);
      })(),
    }),
    discard: () => {},
  });

  const events = await drain(engine);
  const meta = metaOf(events);
  assert.equal(meta.length, 1);
  assert.equal(meta[0]?.path, 'omni');
  const audio = events.find((event) => event.type === 'audio');
  assert.ok(audio !== undefined && audio.type === 'audio');
  assert.equal(audio.sampleRate, 16_000);
  const done = lastDone(events);
  assert.equal(done.fullText, '在呢');
  assert.equal(done.speech, '在呢');
});

test('CascadeVoiceEngine：流式失败退回整段合成，并改写 firstSynthAtMs', async () => {
  const seen: string[] = [];
  const logs: string[] = [];
  let now = 1_000;
  const stamps: number[] = [];
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    clock: () => {
      now += 100;
      stamps.push(now);
      return now;
    },
    log: (line) => { logs.push(line); },
    tts: {
      name: 'flaky',
      sampleRate: 16_000,
      async *synthesize(text) {
        seen.push(`whole:${text}`);
        yield Buffer.alloc(480);
      },
      async *synthesizeStream() {
        throw new Error('Please ensure input text is valid.');
      },
    },
    ask: async (_turn, emit) => {
      emit('[平静]在，哥。');
      return {
        text: '[平静]在，哥。',
        speech: '在，哥。',
        emotion: 'calm',
        path: 'fast',
        firstTokenMs: 42,
      };
    },
  });

  const events = await drain(engine);
  assert.deepEqual(seen, ['whole:在，哥。']);
  assert.ok(logs.some((line) => line.includes('退回整段合成')));
  const audio = events.find((event) => event.type === 'audio');
  assert.ok(audio !== undefined && audio.type === 'audio');
  assert.equal(audio.sampleRate, 16_000);
  const meta = metaOf(events);
  assert.equal(meta.length, 1);
  assert.equal(meta[0]?.path, 'fast');
  assert.equal(meta[0]?.firstTokenMs, 42);
  // 首个增量先记了一次钟，回落整段必须改写成最后那次（新的起点）
  assert.ok(stamps.length >= 2);
  assert.equal(meta[0]?.firstSynthAtMs, stamps[stamps.length - 1]);
  assert.notEqual(meta[0]?.firstSynthAtMs, stamps[0]);
  const done = lastDone(events);
  assert.equal(done.fullText, '[平静]在，哥。');
  assert.equal(done.speech, '在，哥。');
});

test('CascadeVoiceEngine：流式零音频块也退回整段合成', async () => {
  const seen: string[] = [];
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    clock: () => 50,
    tts: {
      name: 'silent-stream',
      sampleRate: 24_000,
      async *synthesize(text) {
        seen.push(`whole:${text}`);
        yield Buffer.alloc(480);
      },
      async *synthesizeStream(chunks) {
        for await (const chunk of chunks) {
          seen.push(`stream:${chunk}`);
        }
      },
    },
    ask: async (_turn, emit) => {
      emit('有正文');
      return { text: '有正文', speech: '有正文', path: 'dsh', firstTokenMs: 7 };
    },
  });

  const events = await drain(engine);
  assert.deepEqual(seen, ['stream:有正文', 'whole:有正文']);
  assert.ok(audioBytes(events) > 0);
  const done = lastDone(events);
  assert.equal(done.speech, '有正文');
});

test('CascadeVoiceEngine：多步流式的 done.speech 是全部增量，meta 带首字与合成起点', async () => {
  const seen: string[] = [];
  let now = 2_000;
  const engine = new CascadeVoiceEngine({
    isReady: () => true,
    clock: () => {
      now += 10;
      return now;
    },
    tts: streamTts(seen),
    ask: async (_turn, emit) => {
      emit('[平静]哦，是六四一四。');
      emit('我改一下。');
      emit('[平静]改好了，');
      emit('现在送到六四一四室。');
      return {
        text: '[平静]改好了，现在送到六四一四室。',
        speech: '改好了，现在送到六四一四室。',
        path: 'dsh',
        firstTokenMs: 15,
        delegateReason: 'delegate',
      };
    },
  });

  const events = await drain(engine);
  assert.deepEqual(seen, [
    'stream:[平静]哦，是六四一四。',
    'stream:我改一下。',
    'stream:[平静]改好了，',
    'stream:现在送到六四一四室。',
  ]);
  for (const event of events) {
    if (event.type === 'audio') {
      assert.equal(event.sampleRate, 24_000);
    }
  }
  const meta = metaOf(events);
  assert.equal(meta[0]?.path, 'dsh');
  assert.equal(meta[0]?.firstTokenMs, 15);
  assert.equal(meta[0]?.firstSynthAtMs, 2_010);
  assert.equal(meta[0]?.delegate, 'delegate');
  const done = lastDone(events);
  assert.equal(done.fullText, '[平静]改好了，现在送到六四一四室。');
  assert.equal(
    done.speech,
    '哦，是六四一四。我改一下。改好了，现在送到六四一四室。',
  );
});

// ------------------------------------------------------------------ AgentEngineAdapter

interface AdapterRig {
  readonly engine: AgentEngineAdapter;
  readonly streamed: string[];
  readonly whole: string[];
  readonly logs: string[];
  readonly willServeCalls: string[];
  readonly replies: Array<{
    text: string;
    turn: TurnContext | undefined;
    image: { mimeType: string; data: string } | undefined;
  }>;
  sink: ((text: string) => void) | null;
}

function adapterRig(options: {
  readonly deltas?: readonly string[];
  readonly secondDeltas?: readonly string[];
  readonly reply: AgentReplyView | Error;
  readonly stream?: boolean;
  readonly streamError?: Error;
  readonly willServe?: boolean;
  readonly audio?: readonly string[];
  readonly omniDelegate?: 'delegate';
  readonly delegateText?: string | null;
  readonly second?: AgentReplyView | Error | 'hang';
  readonly hasWillServe?: boolean;
}): AdapterRig {
  const streamed: string[] = [];
  const whole: string[] = [];
  const logs: string[] = [];
  const willServeCalls: string[] = [];
  const replies: Array<{
    text: string;
    turn: TurnContext | undefined;
    image: { mimeType: string; data: string } | undefined;
  }> = [];
  const box: { sink: ((text: string) => void) | null } = { sink: null };
  let calls = 0;

  const agent: AgentProvider = {
    name: 'fake',
    ...(options.hasWillServe === false
      ? {}
      : {
        willServeAudio: (text: string) => {
          willServeCalls.push(text);
          return options.willServe === true;
        },
      }),
    dropPrefetch: (why) => { logs.push(`drop:${why}`); },
    reply: (text, image, _note, turn) => {
      calls += 1;
      replies.push({ text, turn, image });
      if (calls === 1 && options.audio !== undefined) {
        let said = '';
        const chunks = options.audio;
        return Promise.resolve({
          get text(): string { return said; },
          get speech(): string { return said; },
          path: 'omni' as const,
          audio: {
            sampleRate: 24_000,
            transcript: () => said,
            delegateReason: () => options.omniDelegate ?? null,
            delegateText: () => options.delegateText ?? null,
            chunks: (async function* generate() {
              for (const piece of chunks) {
                said += piece;
                yield Buffer.alloc(480);
              }
            })(),
          },
        });
      }
      if (calls >= 2 && options.second === 'hang') {
        return new Promise<AgentReplyView>(() => {});
      }
      if (calls >= 2 && options.second instanceof Error) {
        return Promise.reject(options.second);
      }
      const deliver = async (): Promise<AgentReplyView> => {
        const deltas = calls === 1 ? (options.deltas ?? []) : (options.secondDeltas ?? []);
        for (const delta of deltas) {
          box.sink?.(delta);
          await tick();
        }
        if (calls === 1) {
          if (options.reply instanceof Error) {
            throw options.reply;
          }
          return options.reply;
        }
        if (options.second !== undefined && options.second !== 'hang' && !(options.second instanceof Error)) {
          return options.second;
        }
        if (options.reply instanceof Error) {
          throw options.reply;
        }
        return options.reply;
      };
      return deliver();
    },
  };

  const useStream = options.stream !== false;
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async *synthesize(text) {
      whole.push(text);
      yield Buffer.alloc(480);
    },
    ...(useStream
      ? {
        async *synthesizeStream(chunks: AsyncIterable<string>) {
          for await (const chunk of chunks) {
            streamed.push(chunk);
            if (options.streamError === undefined) {
              yield Buffer.alloc(240);
            }
          }
          if (options.streamError !== undefined) {
            throw options.streamError;
          }
        },
      }
      : {}),
  };
  let clock = 5_000;
  const engine = new AgentEngineAdapter({
    agent,
    tts,
    onLiveAvailable: (next) => { box.sink = next; },
    clock: () => {
      clock += 5;
      return clock;
    },
    log: (line) => { logs.push(line); },
  });
  return {
    engine,
    streamed,
    whole,
    logs,
    willServeCalls,
    replies,
    get sink() { return box.sink; },
    set sink(value) { box.sink = value; },
  };
}

test('AgentEngineAdapter：流式增量进 TTS，多步 speech 对账，meta 带路径与采样率', async () => {
  const rig = adapterRig({
    deltas: ['[平静]哦，是六四一四。', '我改一下。', '[平静]改好了。'],
    reply: {
      text: '[平静]改好了。',
      speech: '改好了。',
      path: 'fast',
      firstTokenMs: 18,
    },
  });
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(TURN, new AbortController().signal)) {
    events.push(event);
  }

  assert.deepEqual(rig.willServeCalls, ['你好呀']);
  assert.deepEqual(rig.streamed, ['[平静]哦，是六四一四。', '我改一下。', '[平静]改好了。']);
  assert.deepEqual(rig.whole, []);
  for (const event of events) {
    if (event.type === 'audio') {
      assert.equal(event.sampleRate, 24_000);
    }
  }
  const meta = metaOf(events);
  assert.equal(meta[0]?.path, 'fast');
  assert.equal(meta[0]?.firstTokenMs, 18);
  assert.equal(typeof meta[0]?.firstSynthAtMs, 'number');
  const done = lastDone(events);
  assert.equal(done.fullText, '[平静]改好了。');
  assert.equal(done.speech, '哦，是六四一四。我改一下。改好了。');
});

test('AgentEngineAdapter：流式失败退回整段合成', async () => {
  const rig = adapterRig({
    deltas: [],
    reply: { text: '[平静]在，哥。', speech: '在，哥。', emotion: 'calm', path: 'dsh' },
    streamError: new Error('Please ensure input text is valid.'),
  });
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(TURN, new AbortController().signal)) {
    events.push(event);
  }

  assert.deepEqual(rig.whole, ['在，哥。']);
  assert.ok(rig.logs.some((line) => line.includes('退回整段合成')));
  assert.equal(lastDone(events).speech, '在，哥。');
  assert.ok(audioBytes(events) > 0);
});

test('AgentEngineAdapter：没有流式通道时走逐句泵，用清洗后的 speech', async () => {
  const rig = adapterRig({
    stream: false,
    deltas: ['[平静]你好。'],
    reply: { text: '[平静]你好。', speech: '你好。', path: 'fast', firstTokenMs: 9 },
  });
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(TURN, new AbortController().signal)) {
    events.push(event);
  }

  assert.deepEqual(rig.streamed, []);
  assert.ok(rig.whole.includes('你好。'), `实际整段：${JSON.stringify(rig.whole)}`);
  assert.equal(metaOf(events)[0]?.path, 'fast');
  assert.equal(metaOf(events)[0]?.firstTokenMs, 9);
  assert.equal(lastDone(events).speech, '你好。');
  const audio = events.find((event) => event.type === 'audio');
  assert.ok(audio !== undefined && audio.type === 'audio');
  assert.equal(audio.sampleRate, 24_000);
});

test('AgentEngineAdapter：omni 直出不开流式 TTS，meta path=omni，音频用回答自己的采样率', async () => {
  const rig = adapterRig({
    willServe: true,
    deltas: [],
    reply: { text: '不该走到这里', speech: '不该走到这里' },
    audio: ['我在', '呢。'],
  });
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(TURN, new AbortController().signal)) {
    events.push(event);
  }

  assert.deepEqual(rig.streamed, []);
  assert.deepEqual(rig.whole, []);
  assert.equal(metaOf(events)[0]?.path, 'omni');
  const audios = events.filter((event) => event.type === 'audio');
  assert.equal(audios.length, 2);
  for (const event of audios) {
    if (event.type === 'audio') {
      assert.equal(event.sampleRate, 24_000);
    }
  }
  assert.equal(textOf(events), '我在呢。');
  const done = lastDone(events);
  assert.equal(done.fullText, '我在呢。');
  assert.equal(done.speech, '我在呢。');
});

test('AgentEngineAdapter：带图不问 willServeAudio，流式照常开', async () => {
  const rig = adapterRig({
    willServe: true,
    deltas: ['[平静]我看了，', '是只猫。'],
    reply: { text: '[平静]我看了，是只猫。', speech: '我看了，是只猫。', path: 'dsh' },
  });
  const imageTurn: TurnInput = {
    ...TURN,
    hasImage: true,
    image: { bytes: Buffer.from('img'), mime: 'image/jpeg' },
  };
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(imageTurn, new AbortController().signal)) {
    events.push(event);
  }

  assert.deepEqual(rig.willServeCalls, [], '带图轮次连问都不该问');
  assert.deepEqual(rig.streamed, ['[平静]我看了，', '是只猫。']);
  assert.deepEqual(rig.whole, []);
  assert.equal(rig.replies[0]?.turn, undefined);
  assert.equal(rig.replies[0]?.image?.mimeType, 'image/jpeg');
  assert.equal(rig.replies[0]?.image?.data, Buffer.from('img').toString('base64'));
  assert.equal(lastDone(events).speech, '我看了，是只猫。');
});

test('AgentEngineAdapter：omni 转交走二次 reply，流式成功就不整段再合成', async () => {
  const rig = adapterRig({
    willServe: true,
    reply: { text: '不该用第一次的文本', speech: '不该用第一次的文本' },
    audio: ['行，我这就查。'],
    omniDelegate: 'delegate',
    delegateText: '关灯',
    secondDeltas: ['关好了。'],
    second: {
      text: '关好了。',
      speech: '关好了。',
      path: 'dsh',
      delegate: 'delegate',
      firstTokenMs: 30,
    },
  });
  const turn: TurnInput = {
    ...TURN,
    ticket: { no: 4, gen: 1, baseCommitSeq: 2, startedAtMs: 10 },
  };
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(turn, new AbortController().signal)) {
    events.push(event);
  }

  const delegate = events.find((event) => event.type === 'delegate');
  assert.ok(delegate !== undefined && delegate.type === 'delegate');
  assert.equal(delegate.reason, 'delegate');
  assert.equal(delegate.rewrittenQuery, '关灯');
  const second = rig.replies[1];
  assert.ok(second !== undefined);
  assert.equal(second.text, '关灯\n用户原话：「你好呀」');
  assert.equal(second.turn?.forceDelegate, 'delegate');
  assert.equal(second.turn?.receiptSpoken, true);
  assert.equal(second.turn?.ticket.no, 4);
  assert.deepEqual(rig.streamed, ['关好了。']);
  assert.deepEqual(rig.whole, []);
  const metas = metaOf(events);
  assert.equal(metas[0]?.path, 'omni');
  assert.equal(metas[metas.length - 1]?.path, 'dsh');
  assert.equal(metas[metas.length - 1]?.delegate, 'delegate');
  assert.equal(metas[metas.length - 1]?.firstTokenMs, 30);
  const done = lastDone(events);
  assert.equal(done.fullText, '关好了。');
  assert.equal(done.speech, '关好了。');
});

test('AgentEngineAdapter：转交后被中止且没有后续音频，done.speech 仍是垫话', { timeout: 3000 }, async () => {
  const rig = adapterRig({
    willServe: true,
    reply: { text: '垫话', speech: '垫话' },
    audio: ['行，我这就查。'],
    omniDelegate: 'delegate',
    delegateText: '关灯',
    second: 'hang',
  });
  const controller = new AbortController();
  const events: EngineEvent[] = [];
  for await (const event of rig.engine.respond(TURN, controller.signal)) {
    events.push(event);
    if (event.type === 'delegate') {
      controller.abort();
    }
  }

  assert.ok(rig.logs.some((line) => line.includes('不再等 dsh')));
  assert.deepEqual(rig.whole, []);
  const done = lastDone(events);
  assert.equal(done.speech, '行，我这就查。');
  assert.equal(done.fullText, '行，我这就查。');
});

test('AgentEngineAdapter：中止后不再给 done', { timeout: 3000 }, async () => {
  const streamed: string[] = [];
  const box: { sink: ((text: string) => void) | null } = { sink: null };
  const engine = new AgentEngineAdapter({
    agent: {
      name: 'fake',
      willServeAudio: () => false,
      reply: () => new Promise(() => {}),
    },
    tts: {
      name: 'fake',
      sampleRate: 24_000,
      async *synthesize(text) {
        yield Buffer.from(text);
      },
      async *synthesizeStream(chunks) {
        for await (const chunk of chunks) {
          streamed.push(chunk);
          yield Buffer.alloc(240);
        }
      },
    },
    onLiveAvailable: (next) => { box.sink = next; },
    clock: () => 10,
  });
  const controller = new AbortController();
  const events: EngineEvent[] = [];
  const running = (async () => {
    for await (const event of engine.respond(TURN, controller.signal)) {
      events.push(event);
      if (event.type === 'text') {
        controller.abort();
      }
    }
  })();
  for (let i = 0; i < 20 && box.sink === null; i += 1) {
    await tick();
  }
  const push = box.sink;
  if (push === null) {
    throw new Error('流式 sink 应该在 reply 挂起前装上');
  }
  push('你好');
  await running;

  assert.equal(events.some((event) => event.type === 'done'), false);
  assert.equal(events.some((event) => event.type === 'text'), true);
  assert.deepEqual(streamed, ['你好']);
});

test('AgentEngineAdapter：模型挂了、流式也失败时错误抛出，且没有没人接的 rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const rig = adapterRig({
      deltas: [],
      reply: new Error('模型挂了'),
      streamError: new Error('Please ensure input text is valid.'),
    });
    await assert.rejects(
      async () => {
        for await (const event of rig.engine.respond(TURN, new AbortController().signal)) {
          void event;
        }
      },
      /模型挂了/,
    );
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('AgentEngineAdapter：abortSpeculation 交给 dropPrefetch', () => {
  const rig = adapterRig({
    reply: { text: 'x', speech: 'x' },
  });
  rig.engine.abortSpeculation('barge_in');
  rig.engine.abortSpeculation('delegated');
  rig.engine.abortSpeculation('superseded');
  assert.deepEqual(
    rig.logs.filter((line) => line.startsWith('drop:')),
    ['drop:barge_in', 'drop:delegated', 'drop:superseded'],
  );
});

test('createAbortGate：cancel 摘掉 abort 监听；已中止不再挂新的', async () => {
  const controller = new AbortController();
  const gate = createAbortGate(controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  let settled = false;
  void gate.done.then(() => { settled = true; });
  gate.cancel();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, '摘掉之后这次中止不再兑现已经取消的门');

  const again = createAbortGate(controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await again.done;
});

test('EventQueue：先推后读、先读后推都按到达顺序吐出', async () => {
  const queue = new EventQueue<string>();
  queue.push('a');
  const iter = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iter.next(), { value: 'a', done: false });
  const pending = iter.next();
  queue.push('b');
  assert.deepEqual(await pending, { value: 'b', done: false });
  queue.close();
  assert.equal((await iter.next()).done, true);
  queue.push('c');
  assert.equal((await queue[Symbol.asyncIterator]().next()).done, true);
});

test('spokenFromStream：剥开头情绪并按 TTS 口径清洗', () => {
  assert.equal(spokenFromStream('[开心]**好的**，哥'), '好的，哥');
  assert.equal(spokenFromStream('好的[担心]呀'), '好的呀');
});

test('FrontedAgent.reply：forceDelegate 在 await 之前钉上本轮票据', async () => {
  let detached = 0;
  const held: { release: (() => void) | null } = { release: null };
  const inner: AgentProvider = {
    name: 'dsh',
    reply: (text) => new Promise((resolve) => {
      if (!text.includes('订单')) {
        resolve({ text: '好。', speech: '好。' });
        return;
      }
      held.release = () => resolve({ text: '查到了。', speech: '查到了。' });
    }),
    detachTurn: () => { detached += 1; },
    cancelTurn: () => {},
  };
  const agent = new FrontedAgent({ inner, apiKey: '' });
  await agent.reply('你好呀', undefined, undefined, { ticket: { no: 1, gen: 1 } });
  const next = { no: 2, gen: 2 };
  const pending = agent.reply('帮我查订单', undefined, undefined, {
    ticket: next,
    forceDelegate: 'delegate',
    receiptSpoken: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  agent.cancelTurn(next);
  held.release?.();
  await pending;
  assert.equal(detached, 1, '新票据必须在 delegate 之前钉上，插话才能放手这一轮');
});
