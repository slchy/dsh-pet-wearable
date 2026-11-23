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

import type { EngineEvent, FastVoiceEngine, TurnInput } from '../src/engine-contract.ts';
import type { AgentProvider, TtsProvider } from '../src/providers.ts';
import { CascadeVoiceEngine } from '../src/engines/cascade-voice-engine.ts';
import { LiveVoiceEngine } from '../src/engines/live-voice-engine.ts';
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
  assert.deepEqual(types(events), ['audio', 'text', 'audio', 'text', 'done']);
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
  assert.deepEqual(types(events), ['audio', 'text', 'delegate', 'done']);
  const delegate = events[2]!;
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

  assert.deepEqual(types(events), ['audio', 'text'], '中止之后一块音频都不许再出');
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
  assert.deepEqual(types(events), ['delegate', 'done']);
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
    assert.ok(['audio', 'text', 'delegate', 'done'].includes(event.type));
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
  assert.deepEqual(types(events), ['audio', 'text', 'done']);
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
