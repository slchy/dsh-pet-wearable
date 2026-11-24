/**
 * 纯级联 agent：路由不进 live，投机双轨、预跑、账本、toEngine 都在这条管线上。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVENTS } from '../src/events.ts';
import { CascadeAgent, type CascadeAgentOptions } from '../src/pipelines/cascade-agent.ts';
import type { EngineEvent, TurnInput } from '../src/engine-contract.ts';
import type { TurnTicket } from '../src/kernel.ts';
import type { AgentImage, AgentProvider, AgentReplyView, TtsProvider } from '../src/providers.ts';

type ForbiddenLane =
  | 'attachAudioLane'
  | 'willServeAudio'
  | 'noteServedTurn'
  | 'injectAnsweredTurn';

type LaneAbsent<T> = [T] extends [never] ? true : never;

const laneMethodsAbsent: LaneAbsent<ForbiddenLane & keyof CascadeAgent> = true;

function sse(tokens: string[]): Response {
  const body = tokens
    .map((token) => `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface InnerCall {
  readonly text: string;
  readonly note: string | undefined;
  readonly image: boolean;
}

function fakeInner(): {
  agent: AgentProvider;
  calls: InnerCall[];
  push: (text: string) => void;
} {
  const calls: InnerCall[] = [];
  let sink: ((text: string) => void) | null = null;
  const agent: AgentProvider = {
    name: 'dsh',
    attachLiveSink: (next) => { sink = next; },
    reply: async (text, image, note): Promise<AgentReplyView> => {
      calls.push({ text, note, image: image !== undefined });
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
  };
  return {
    agent,
    calls,
    push: (text) => { sink?.(text); },
  };
}

function cascade(
  inner: AgentProvider,
  fetchImpl: typeof fetch,
  extra: Partial<CascadeAgentOptions> = {},
): CascadeAgent {
  return new CascadeAgent({
    inner,
    apiKey: 'k',
    fetchImpl,
    log: () => {},
    speculate: false,
    ...extra,
  });
}

function turnOf(text: string, ticket?: { no: number; gen: number }): TurnInput {
  return {
    text,
    no: ticket?.no ?? 1,
    baseCommitSeq: 0,
    startedAtMs: 0,
    hasImage: false,
    ...(ticket === undefined ? {} : { ticket }),
  };
}

async function collect(source: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function textOf(events: readonly EngineEvent[]): string {
  return events
    .filter((event): event is Extract<EngineEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.delta)
    .join('');
}

function messagesOf(init: RequestInit | undefined): Array<{ role?: string; content?: string }> {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  return body.messages ?? [];
}

/** 先吐出若干 token，下一次读取再把流打断。用来造「已经开口之后模型断了」。 */
function sseThenError(tokens: string[], message: string): Response {
  const encoder = new TextEncoder();
  const payload = tokens
    .map((token) => `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`)
    .join('');
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(payload));
        return;
      }
      controller.error(new Error(message));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function quietTts(sampleRate = 24000): TtsProvider {
  return {
    name: 'quiet',
    sampleRate,
    async *synthesize() {
      yield Buffer.from([1]);
    },
    async *synthesizeStream(chunks) {
      for await (const piece of chunks) {
        if (piece === '') continue;
        yield Buffer.from(piece);
      }
    },
  };
}

function metaOf(events: readonly EngineEvent[]): Extract<EngineEvent, { type: 'meta' }> | undefined {
  return events.find((event): event is Extract<EngineEvent, { type: 'meta' }> => event.type === 'meta');
}

function doneOf(events: readonly EngineEvent[]): Extract<EngineEvent, { type: 'done' }> | undefined {
  return events.find((event): event is Extract<EngineEvent, { type: 'done' }> => event.type === 'done');
}

test('纯级联路由：live 不会被选中，硬规则进 dsh，短闲聊走快车道', async () => {
  assert.equal(laneMethodsAbsent, true);

  const chit = fakeInner();
  let system = '';
  let fastCalls = 0;
  const chatter = cascade(chit.agent, async (_url, init) => {
    fastCalls += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    system = body.messages?.[0]?.content ?? '';
    return sse(['[平静]在呢。']);
  });
  const hello = await chatter.reply('你好呀');
  assert.equal(hello.path, 'fast');
  assert.notEqual(hello.path, 'omni');
  assert.equal(hello.speech, '在呢。');
  assert.equal(fastCalls, 1);
  assert.equal(chit.calls.length, 0);
  assert.match(system, /米馍/);
  assert.match(system, /\[\[DELEGATE\]\]/);

  const action = fakeInner();
  let actionFetches = 0;
  const actor = cascade(action.agent, async () => {
    actionFetches += 1;
    return sse(['不该问到']);
  });
  const acted = await actor.reply('提醒我喝水');
  assert.equal(acted.path, 'dsh');
  assert.equal(acted.delegate, 'task');
  assert.equal(actionFetches, 0);
  assert.equal(action.calls[0]?.text, '提醒我喝水');

  const memory = fakeInner();
  let memoryFetches = 0;
  const memorizer = cascade(memory.agent, async () => {
    memoryFetches += 1;
    return sse(['不该问到']);
  });
  const remembered = await memorizer.reply('我姓袁。');
  assert.equal(remembered.path, 'dsh');
  assert.equal(remembered.delegate, 'memory');
  assert.equal(memoryFetches, 0);
  assert.equal(memory.calls[0]?.text, '我姓袁。');

  const awaiting = fakeInner();
  let awaitingFetches = 0;
  const waiter = cascade({
    ...awaiting.agent,
    reply: async (text, image, note) => {
      const answer = text === '提醒我喝水'
        ? { text: '就这件吗？', speech: '就这件吗？' }
        : { text: '好，就这件。', speech: '好，就这件。' };
      awaiting.calls.push({ text, note, image: image !== undefined });
      return answer;
    },
  }, async () => {
    awaitingFetches += 1;
    return sse(['不该问到']);
  });
  await waiter.reply('提醒我喝水');
  const confirmed = await waiter.reply('好的');
  assert.equal(confirmed.path, 'dsh');
  assert.equal(confirmed.delegate, 'answer');
  assert.equal(awaitingFetches, 0);
  assert.deepEqual(awaiting.calls.map((call) => call.text), ['提醒我喝水', '好的']);

  const stick = fakeInner();
  let stickFetches = 0;
  const sticker = cascade({
    ...stick.agent,
    reply: async (text, image, note) => {
      stick.calls.push({ text, note, image: image !== undefined });
      return { text: '已经记下了。', speech: '已经记下了。' };
    },
  }, async () => {
    stickFetches += 1;
    return sse(['不该问到']);
  });
  await sticker.reply('提醒我开会');
  const follow = await sticker.reply('讲讲梗概');
  assert.equal(follow.path, 'dsh');
  assert.equal(follow.delegate, 'task');
  assert.equal(stickFetches, 0);
  assert.equal(stick.calls[1]?.text, '讲讲梗概');

  const pictured = fakeInner();
  let imageFetches = 0;
  const seer = cascade(pictured.agent, async () => {
    imageFetches += 1;
    return sse(['不该问到']);
  });
  const seen = await seer.reply('看看这个', { mimeType: 'image/png', data: 'abc' });
  assert.equal(seen.path, 'dsh');
  assert.equal(seen.delegate, 'task');
  assert.equal(imageFetches, 0);
  assert.equal(pictured.calls[0]?.image, true);
});

test('投机：快车道胜出就取消并回滚 dsh，慢车道增量不进 TTS', async () => {
  const inner = fakeInner();
  let cancelled = 0;
  let rolled = 0;
  const agent = cascade({
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
    rollbackTurn: () => { rolled += 1; },
    reply: async (text, image, note) => {
      inner.push('慢车道已经开始说话了');
      return inner.agent.reply(text, image, note);
    },
  }, async () => sse(['我在呢。']), { speculate: true });
  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });

  const reply = await agent.reply('你好呀');
  await delay(0);

  assert.equal(reply.path, 'fast');
  assert.equal(reply.speech, '我在呢。');
  assert.deepEqual(seen, ['我在呢。']);
  assert.equal(cancelled, 1);
  assert.equal(rolled, 1);
  assert.equal(inner.calls.length, 1);
});

test('投机：超时或 [[DELEGATE]] 时把缓冲的 dsh 增量放出来', async () => {
  const delegated = fakeInner();
  const delegateAgent = cascade({
    ...delegated.agent,
    reply: async (text, image, note) => {
      delegated.push('早就说出来的前半句');
      return delegated.agent.reply(text, image, note);
    },
  }, async () => sse(['[[', 'DELEGATE]]']), { speculate: true });
  const delegateSeen: string[] = [];
  delegateAgent.attachLiveSink((text) => { delegateSeen.push(text); });
  const delegatedReply = await delegateAgent.reply('你好呀');
  assert.equal(delegatedReply.path, 'dsh');
  assert.equal(delegatedReply.delegate, 'delegate');
  assert.equal(delegatedReply.speech, '慢车道答复。');
  assert.deepEqual(delegateSeen, ['早就说出来的前半句']);

  const timed = fakeInner();
  const timeoutAgent = cascade({
    ...timed.agent,
    reply: async (text, image, note) => {
      timed.push('超时前就到了');
      return timed.agent.reply(text, image, note);
    },
  }, (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    signal.addEventListener('abort', () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error('aborted'));
    });
  }), { speculate: true, timeoutMs: 40 });
  const timeoutSeen: string[] = [];
  timeoutAgent.attachLiveSink((text) => { timeoutSeen.push(text); });
  const timeoutReply = await timeoutAgent.reply('你好呀');
  assert.equal(timeoutReply.path, 'dsh');
  assert.equal(timeoutReply.delegate, 'timeout');
  assert.equal(timeoutReply.speech, '慢车道答复。');
  assert.deepEqual(timeoutSeen, ['超时前就到了']);
});

test('预跑与投机不看音频车道，作废会掐掉在途请求', async () => {
  let calls = 0;
  let aborted = false;
  const hanging: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    calls += 1;
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  });
  const inner = fakeInner();
  const agent = cascade(inner.agent, hanging, { speculate: false });
  const engine = agent.toEngine({
    name: 'tts',
    sampleRate: 24000,
    async *synthesize() { yield Buffer.from([0]); },
  });

  assert.equal(engine.mode, 'cascade');
  assert.equal(engine.isHealthy(), true);
  assert.equal(agent.speculatePartial('你'), false);
  assert.equal(calls, 0);
  assert.equal(engine.onAsrPartial?.('你好呀朋友啊', 3), undefined);
  assert.equal(calls, 1);
  engine.onAsrFinal?.('你好呀朋友啊', 4);
  assert.equal(calls, 1, '定稿确认同一句，不再问一次');
  engine.abortSpeculation('superseded');
  await delay(0);
  assert.equal(aborted, true);

  let claimed = 0;
  const claimAgent = cascade(fakeInner().agent, async () => {
    claimed += 1;
    return sse(['在呢。']);
  }, { speculate: false });
  assert.equal(claimAgent.prefetch('你好呀'), true);
  assert.equal(claimed, 1);
  const reply = await claimAgent.reply('你好呀');
  assert.equal(reply.path, 'fast');
  assert.equal(claimed, 1, '一字不差就认领预跑');

  let actionPrefetch = 0;
  const actionAgent = cascade(fakeInner().agent, async () => {
    actionPrefetch += 1;
    return sse(['不该被认领']);
  }, { speculate: false });
  assert.equal(actionAgent.prefetch('提醒我喝水'), true, '没有音频车道可咨询，短动作句也会预跑');
  assert.equal(actionPrefetch, 1);
  const acted = await actionAgent.reply('提醒我喝水');
  assert.equal(acted.path, 'dsh');
  assert.equal(actionPrefetch, 1);

  const off = new CascadeAgent({
    inner: fakeInner().agent,
    apiKey: '',
    log: () => {},
    fetchImpl: async () => sse(['不该问到']),
  });
  assert.equal(off.toEngine({
    name: 'tts',
    sampleRate: 16000,
    async *synthesize() { yield Buffer.alloc(0); },
  }).isHealthy(), false);
});

test('账本与 lastLedgerLane 同步，结算按票据改回那一轮', async () => {
  const inner = fakeInner();
  const agent = cascade(inner.agent, async () => sse(['在呢。']), { speculate: false });
  await agent.reply('你好呀', undefined, undefined, { ticket: { no: 1, gen: 1 } });
  assert.equal(agent.lastLedgerLane(), 'cascade');
  await agent.reply('提醒我喝水', undefined, undefined, { ticket: { no: 2, gen: 1 } });
  assert.equal(agent.lastLedgerLane(), 'dsh');

  agent.reconcileTurnOutcome({
    ticket: { no: 1, gen: 1 },
    truncated: true,
    endedAtMs: 1234,
  });
  const turns = agent.ledgerTurns;
  const first = turns.find((item) => item.ticket?.no === 1);
  const second = turns.find((item) => item.ticket?.no === 2);
  assert.equal(first?.lane, 'cascade');
  assert.equal(first?.truncated, true);
  assert.equal(first?.endedAtMs, 1234);
  assert.equal(first?.assistantText, '在呢。');
  assert.equal(second?.lane, 'dsh');
  assert.equal(second?.truncated, false);
  assert.equal(agent.lastLedgerLane(), 'dsh');

  agent.reconcileTurnOutcome({
    ticket: { no: 2, gen: 9 },
    truncated: true,
    endedAtMs: 1,
  });
  assert.equal(agent.ledgerTurns.find((item) => item.ticket?.no === 2)?.truncated, false);
  assert.equal(agent.lastLedgerLane(), 'dsh');
});

test('委派轮插话放手，显式「算了」才取消；放手的答案回注账本', async () => {
  const inner = fakeInner();
  let cancelled = 0;
  let detached = 0;
  const gate: { resolve: ((reply: AgentReplyView) => void) | null } = { resolve: null };
  const agent = cascade({
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
    detachTurn: () => { detached += 1; },
    reply: () => new Promise<AgentReplyView>((resolve) => { gate.resolve = resolve; }),
  }, async () => sse(['不该问到']));
  const ticket = { no: 2, gen: 1 };
  const pending = agent.reply('查一下订单', undefined, undefined, {
    ticket,
    forceDelegate: 'delegate',
    receiptSpoken: true,
  });
  await delay(20);
  agent.cancelTurn(ticket);
  gate.resolve?.({ text: '查完了。', speech: '查完了。' });
  await pending;
  assert.equal(detached, 1);
  assert.equal(cancelled, 0);

  let explicit = 0;
  const detachedSink: {
    cb: ((userText: string, answer: string, spoken: boolean) => void) | null;
  } = { cb: null };
  const busy = cascade({
    name: 'dsh',
    dshBusy: () => true,
    cancelTurn: () => { explicit += 1; },
    setDetachedAnswerSink: (cb) => { detachedSink.cb = cb; },
    reply: async () => ({ text: '不该再问。', speech: '不该再问。' }),
  }, async () => sse(['不该问到']));
  const cancelledReply = await busy.reply('算了。');
  assert.equal(explicit, 1);
  assert.equal(cancelledReply.speech, '好，不查了。');
  assert.equal(cancelledReply.path, 'fast');
  detachedSink.cb?.('提醒我喝水', '[开心]已经记下了。', false);
  assert.equal(busy.lastLedgerLane(), 'dsh');
  assert.equal(busy.ledgerTurns.at(-1)?.assistantText, '已经记下了。');
  assert.equal(busy.ledgerTurns.at(-1)?.userText, '提醒我喝水');
});

test('攒满之前的快车道轮次，委派时补进 dsh 注记', async () => {
  const inner = fakeInner();
  const agent = cascade(inner.agent, async () => sse(['在呢。']), {
    speculate: false,
    keepTurns: 1,
  });
  await agent.reply('你好呀');
  await agent.reply('提醒我喝水');
  assert.equal(inner.calls.length, 1);
  assert.match(inner.calls[0]?.note ?? '', /用户: 你好呀/);
  assert.match(inner.calls[0]?.note ?? '', /你: 在呢。/);
});

test('toEngine 流式合成吐出 meta / text / audio / 多步 done', async () => {
  const synth: Array<{ text: string; emotion: string | undefined }> = [];
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24000,
    async *synthesize(text, emotion) {
      synth.push({ text, emotion });
      yield Buffer.from([9]);
    },
    async *synthesizeStream(chunks) {
      for await (const piece of chunks) {
        if (piece === '') continue;
        yield Buffer.from(piece);
      }
    },
  };
  const fast = cascade(fakeInner().agent, async () => sse(['[开心]我在', '呢。']), { speculate: false });
  const fastEvents = await collect(fast.toEngine(tts).respond(turnOf('你好呀'), new AbortController().signal));
  const fastMeta = fastEvents.find((event): event is Extract<EngineEvent, { type: 'meta' }> => event.type === 'meta');
  const fastDone = fastEvents.find((event): event is Extract<EngineEvent, { type: 'done' }> => event.type === 'done');
  const fastAudio = fastEvents.filter((event): event is Extract<EngineEvent, { type: 'audio' }> => event.type === 'audio');
  assert.ok(fastMeta);
  assert.equal(fastMeta.path, 'fast');
  assert.equal(typeof fastMeta.firstTokenMs, 'number');
  assert.equal(typeof fastMeta.firstSynthAtMs, 'number');
  assert.equal(textOf(fastEvents), '[开心]我在呢。');
  assert.ok(fastAudio.length >= 1);
  assert.ok(fastAudio.every((event) => event.sampleRate === 24000));
  assert.equal(fastDone?.speech, '我在呢。');
  assert.match(fastDone?.fullText ?? '', /我在呢。/);
  assert.equal(fastEvents.at(-2)?.type, 'meta');
  assert.equal(fastEvents.at(-1)?.type, 'done');
  assert.equal(synth.length, 0);

  let sink: ((text: string) => void) | null = null;
  const slow: AgentProvider = {
    name: 'dsh',
    attachLiveSink: (next) => { sink = next; },
    reply: async () => {
      sink?.('先说第一句。');
      sink?.('再说第二句。');
      return {
        text: '再说第二句。',
        speech: '再说第二句。',
        firstTokenMs: 17,
      };
    },
  };
  const stepAgent = cascade(slow, async () => {
    throw new Error('动作句不该问快车道');
  });
  const stepEvents = await collect(
    stepAgent.toEngine(tts).respond(turnOf('提醒我喝水'), new AbortController().signal),
  );
  const stepMeta = stepEvents.find((event): event is Extract<EngineEvent, { type: 'meta' }> => event.type === 'meta');
  const stepDone = stepEvents.find((event): event is Extract<EngineEvent, { type: 'done' }> => event.type === 'done');
  const stepAudio = stepEvents.filter((event): event is Extract<EngineEvent, { type: 'audio' }> => event.type === 'audio');
  assert.equal(textOf(stepEvents), '先说第一句。再说第二句。');
  assert.equal(stepDone?.speech, '先说第一句。再说第二句。');
  assert.notEqual(stepDone?.speech, '再说第二句。');
  assert.match(stepDone?.fullText ?? '', /先说第一句。/);
  assert.equal(stepMeta?.path, 'dsh');
  assert.equal(stepMeta?.delegate, 'task');
  assert.equal(stepMeta?.firstTokenMs, 17);
  assert.equal(typeof stepMeta?.firstSynthAtMs, 'number');
  assert.ok(stepAudio.length >= 2);
  assert.ok(stepAudio.every((event) => event.sampleRate === 24000));
  assert.equal(stepEvents.at(-1)?.type, 'done');
});

test('toEngine 流式合成抛错时退回整段 synthesize，这一轮仍结束', async () => {
  const synth: Array<{ text: string; emotion: string | undefined }> = [];
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 16000,
    async *synthesize(text, emotion) {
      synth.push({ text, emotion });
      yield Buffer.from([7, 7]);
    },
    async *synthesizeStream() {
      throw new Error('stream down');
    },
  };
  const agent = cascade(fakeInner().agent, async () => sse(['[开心]我在呢。']), { speculate: false });
  const events = await collect(agent.toEngine(tts).respond(turnOf('你好呀'), new AbortController().signal));
  const done = events.find((event): event is Extract<EngineEvent, { type: 'done' }> => event.type === 'done');
  const audio = events.filter((event): event is Extract<EngineEvent, { type: 'audio' }> => event.type === 'audio');
  assert.deepEqual(synth, [{ text: '我在呢。', emotion: 'happy' }]);
  assert.equal(audio.length, 1);
  assert.equal(audio[0]?.sampleRate, 16000);
  assert.equal(done?.speech, '我在呢。');
  assert.equal(events.at(-1)?.type, 'done');
});

test('toEngine 的 AbortSignal 中途停流，并取消本轮、丢掉预跑', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectInner: (error: Error) => void = () => {};
    let innerCancelled = 0;
    const inner: AgentProvider = {
      name: 'dsh',
      attachLiveSink: () => {},
      reply: () => new Promise<AgentReplyView>((_resolve, reject) => { rejectInner = reject; }),
      cancelTurn: () => {
        innerCancelled += 1;
        rejectInner(new Error('cancelled'));
      },
    };
    class SpyAgent extends CascadeAgent {
      readonly drops: string[] = [];
      readonly cancels: Array<TurnTicket | undefined> = [];

      override dropPrefetch(why: string): void {
        this.drops.push(why);
        super.dropPrefetch(why);
      }

      override cancelTurn(ticket?: TurnTicket): void {
        this.cancels.push(ticket);
        super.cancelTurn(ticket);
      }
    }
    const agent = new SpyAgent({
      inner,
      apiKey: 'k',
      log: () => {},
      speculate: true,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) return;
        signal.addEventListener('abort', () => { reject(new Error('aborted')); });
      }),
    });
    const tts: TtsProvider = {
      name: 'fake',
      sampleRate: 24000,
      async *synthesize() { yield Buffer.alloc(2); },
      async *synthesizeStream(chunks) {
        for await (const piece of chunks) yield Buffer.from(piece);
      },
    };
    const ac = new AbortController();
    let settled = false;
    const pending = collect(agent.toEngine(tts).respond(
      turnOf('你好呀', { no: 1, gen: 2 }),
      ac.signal,
    )).then((events) => {
      settled = true;
      return events;
    });
    await delay(20);
    assert.equal(settled, false, '打断之前这一轮还停在流里');
    ac.abort();
    assert.deepEqual(agent.drops, ['barge_in']);
    assert.equal(agent.cancels.length, 1);
    assert.equal(agent.cancels[0]?.no, 1);
    assert.equal(agent.cancels[0]?.gen, 2);
    assert.equal(innerCancelled, 1);
    await Promise.race([
      pending,
      delay(800).then(() => Promise.reject(new Error('respond hung'))),
    ]);
    await delay(30);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('CascadeAgent 上没有音频直出那一组方法', () => {
  const agent = new CascadeAgent({
    inner: fakeInner().agent,
    apiKey: 'k',
    log: () => {},
    fetchImpl: async () => sse(['嗯。']),
  });
  const names = ['attachAudioLane', 'willServeAudio', 'noteServedTurn', 'injectAnsweredTurn'] as const;
  for (const name of names) {
    assert.equal(name in agent, false, name);
    assert.equal(Object.prototype.hasOwnProperty.call(CascadeAgent.prototype, name), false, name);
  }
  assert.equal(laneMethodsAbsent, true);
});

test('投机：太短不发、改写作废并重置配额、变长超过两次就沿用', { timeout: 8_000 }, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  let asked = 0;
  let aborts = 0;
  const hanging: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    asked += 1;
    const signal = init?.signal;
    if (signal === undefined || signal === null) {
      reject(new Error('missing signal'));
      return;
    }
    signal.addEventListener('abort', () => {
      aborts += 1;
      reject(new Error('aborted'));
    });
  });
  const agent = cascade(fakeInner().agent, hanging, { speculate: false });
  try {
    try {
      // 去标点后只剩 5 字，不够默认门槛 6，一个请求都不发
      assert.equal(agent.speculatePartial('你'), false);
      assert.equal(agent.speculatePartial('你，好呀朋友'), false);
      assert.equal(asked, 0);
      assert.equal(aborts, 0);

      assert.equal(agent.speculatePartial('你好呀朋友啊'), true);
      assert.equal(asked, 1);
      assert.equal(agent.speculatePartial('你好呀朋友啊'), true, '同一版中间结果沿用，不重发');
      assert.equal(asked, 1);
      assert.equal(aborts, 0);

      assert.equal(agent.speculatePartial('你好呀朋友啊呀'), true, '变长才可能对上定稿，重发');
      assert.equal(asked, 2);
      assert.equal(aborts, 1, '被顶掉的那一趟要当场掐掉');

      assert.equal(agent.speculatePartial('你好呀朋友啊呀呀'), true, '配额两次用满，只能沿用');
      assert.equal(asked, 2);
      assert.equal(aborts, 1);

      assert.equal(agent.speculatePartial('今天天气真不错'), false, '改写不是变长，收掉且不重发');
      assert.equal(asked, 2);
      assert.equal(aborts, 2);

      assert.equal(agent.speculatePartial('今天天气真不错'), true, '改写把配额清零，下一版可以重来');
      assert.equal(asked, 3);
      assert.equal(aborts, 2);
    } finally {
      agent.dropPrefetch('测试结束');
      await delay(30);
    }
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  const prevTrace = process.env['FAST_LANE_TRACE'];
  process.env['FAST_LANE_TRACE'] = '1';
  try {
    const logs: string[] = [];
    let tracedAsks = 0;
    const traced = cascade(fakeInner().agent, async () => {
      tracedAsks += 1;
      return sse(['在呢。']);
    }, { log: (line) => logs.push(line) });
    assert.equal(traced.speculatePartial('喂'), false);
    assert.ok(logs.some((line) => line.includes('中间结果太短')));
    assert.equal(traced.speculatePartial('订单号是123456'), false);
    assert.ok(logs.some((line) => line.includes('不是快车道候选')));
    assert.equal(tracedAsks, 0);
  } finally {
    if (prevTrace === undefined) delete process.env['FAST_LANE_TRACE'];
    else process.env['FAST_LANE_TRACE'] = prevTrace;
  }

  let tuned = 0;
  const short = cascade(fakeInner().agent, async () => {
    tuned += 1;
    return sse(['在呢。']);
  }, { specMinChars: 4 });
  assert.equal(short.speculatePartial('你呀'), false);
  assert.equal(short.speculatePartial('你好呀朋'), true);
  assert.equal(tuned, 1, '门槛跟着 specMinChars 走');

  let partialOff = 0;
  const noPartial = cascade(fakeInner().agent, async () => {
    partialOff += 1;
    return sse(['在呢。']);
  }, { partialSpeculate: false });
  assert.equal(noPartial.speculatePartial('你好呀朋友啊'), false);
  assert.equal(noPartial.prefetch('你好呀'), true);
  assert.equal(partialOff, 1, '关掉中间结果投机之后，定稿预跑还在');
});

test('预跑：定稿确认、同一句不重问，关掉或形态不够就跳过', async () => {
  let asked = 0;
  const agent = cascade(fakeInner().agent, async () => {
    asked += 1;
    return sse(['[平静]在呢。']);
  });
  assert.equal(agent.speculatePartial('你好呀朋友啊'), true);
  assert.equal(agent.prefetch('你好呀，朋友啊'), true, '只差标点，确认在途投机');
  assert.equal(asked, 1);
  assert.equal(agent.prefetch('你好呀，朋友啊'), true, '确认之后同一句不再问');
  assert.equal(asked, 1);
  const claimed = await agent.reply('你好呀，朋友啊');
  assert.equal(asked, 1, 'reply 认领确认过的那一趟');
  assert.equal(claimed.path, 'fast');
  assert.equal(claimed.speech, '在呢。');

  let plain = 0;
  const prefetcher = cascade(fakeInner().agent, async () => {
    plain += 1;
    return sse(['在呢。']);
  });
  assert.equal(prefetcher.prefetch('你好呀'), true);
  assert.equal(prefetcher.prefetch('你好呀'), true);
  assert.equal(plain, 1, '没有在途投机时，同一句预跑也是幂等的');

  let replaced = 0;
  const replacer = cascade(fakeInner().agent, async () => {
    replaced += 1;
    return sse(['在呢。']);
  });
  assert.equal(replacer.speculatePartial('你好呀朋友啊'), true);
  assert.equal(replacer.prefetch('今天天气真不错'), true, '定稿对不上就按定稿重问');
  assert.equal(replaced, 2);

  let disabled = 0;
  const off = cascade(fakeInner().agent, async () => {
    disabled += 1;
    return sse(['在呢。']);
  }, { prefetch: false });
  assert.equal(off.prefetch('你好呀'), false);
  assert.equal(off.speculatePartial('你好呀朋友啊'), false);
  assert.equal(disabled, 0);

  let skipped = 0;
  const gate = cascade(fakeInner().agent, async () => {
    skipped += 1;
    return sse(['在呢。']);
  });
  const tooLong = '今天我们一起去公园散步看花呀哈啊';
  assert.ok(tooLong.replace(/[\s。.,，!！?？、~～…\-—]/g, '').length > 14);
  assert.equal(gate.prefetch('房间号是304'), false);
  assert.equal(gate.prefetch(tooLong), false);
  assert.equal(gate.prefetch('我姓袁'), false);
  assert.equal(skipped, 0);
  assert.equal(gate.prefetch('你好呀'), true);
  assert.equal(skipped, 1);

  let awaitingAsks = 0;
  const waiter = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    reply: async () => ({ text: '就这件吗？', speech: '就这件吗？' }),
  }, async () => {
    awaitingAsks += 1;
    return sse(['不该被预跑']);
  });
  await waiter.reply('提醒我喝水');
  assert.equal(waiter.prefetch('好的'), false, 'dsh 还在等确认，短回话不能预跑');
  assert.equal(awaitingAsks, 0);
  assert.equal(waiter.prefetch('天气呢'), true, '不是在回答上一问，仍可预跑');
  assert.equal(awaitingAsks, 1);

  let capped = 0;
  const full = cascade(fakeInner().agent, async () => {
    capped += 1;
    return sse(['在呢。']);
  }, { keepTurns: 1 });
  await full.reply('你好呀');
  assert.equal(capped, 1);
  assert.equal(full.prefetch('在吗呀'), false, '快车道已经攒满，预跑直接跳过');
  assert.equal(capped, 1);

  let closed = 0;
  const noKey = new CascadeAgent({
    inner: fakeInner().agent,
    apiKey: '',
    log: () => {},
    fetchImpl: async () => {
      closed += 1;
      return sse(['不该问到']);
    },
  });
  assert.equal(noKey.prefetch('你好呀'), false);
  assert.equal(noKey.speculatePartial('你好呀朋友啊'), false);
  const delegated = await noKey.reply('你好呀');
  assert.equal(delegated.path, 'dsh');
  assert.equal(delegated.delegate, 'task');
  assert.equal(closed, 0);
  assert.equal(noKey.toEngine(quietTts()).isHealthy(), false);
});

test('分流：超限刷进 dsh、进度问句留在快车道、纯聊天、记忆和空答复', async () => {
  const overInner = fakeInner();
  const overReasons: string[] = [];
  let overFetches = 0;
  const over = cascade(overInner.agent, async () => {
    overFetches += 1;
    return sse(['在呢。']);
  }, { keepTurns: 1, speculate: false });
  over.setDelegateHook((reason) => { overReasons.push(reason); });
  await over.reply('你好呀');
  const forced = await over.reply('在吗呀');
  assert.equal(overFetches, 1, '攒满之后这句不再问快车道');
  assert.equal(forced.path, 'dsh');
  assert.equal(forced.delegate, 'overcap');
  assert.deepEqual(overReasons, ['overcap']);
  assert.match(overInner.calls[0]?.note ?? '', /用户: 你好呀/);
  assert.match(overInner.calls[0]?.note ?? '', /你: 在呢。/);
  assert.match(overInner.calls[0]?.note ?? '', /快车道直接答给用户的/);

  const statusQ = '外面那场雨的结果现在查到了吗呢';
  const blocker = '请告诉我外面那场雨查到了吗呢呀';
  const boring = '今天我们一起去公园散步看花呀哈';
  for (const text of [statusQ, blocker, boring]) {
    assert.ok(text.replace(/[\s。.,，!！?？、~～…\-—]/g, '').length > 14, text);
  }
  assert.ok(statusQ.includes('查到了吗'));
  assert.ok(blocker.includes('请'));

  let statusSystem = '';
  let statusFetches = 0;
  const statusInner = fakeInner();
  const statusAgent = cascade(statusInner.agent, async (_url, init) => {
    statusFetches += 1;
    statusSystem = messagesOf(init)[0]?.content ?? '';
    return sse(['还在查。']);
  }, { taskStatus: () => '正在查天气，还没有结果。' });
  const statusReply = await statusAgent.reply(statusQ);
  assert.equal(statusReply.path, 'fast');
  assert.equal(statusReply.speech, '还在查。');
  assert.equal(statusFetches, 1);
  assert.equal(statusInner.calls.length, 0);
  assert.match(statusSystem, /正在查天气，还没有结果。/);
  assert.match(statusSystem, /在跑就说还在跑/);
  assert.match(statusSystem, /\[\[DELEGATE\]\]/);

  let plainSystem = '';
  const plain = cascade(fakeInner().agent, async (_url, init) => {
    plainSystem = messagesOf(init)[0]?.content ?? '';
    return sse(['还在查。']);
  }, {
    delegateEnabled: false,
    taskStatus: () => '正在查天气，还没有结果。',
  });
  const plainReply = await plain.reply(statusQ);
  assert.equal(plainReply.path, 'fast');
  assert.match(plainSystem, /米馍/);
  assert.match(plainSystem, /直接照那条事实/);
  assert.match(plainSystem, /正在查天气，还没有结果。/);
  assert.doesNotMatch(plainSystem, /\[\[DELEGATE\]\]/);

  let emptyFacts = '';
  const emptyFactsReply = await cascade(fakeInner().agent, async (_url, init) => {
    emptyFacts = messagesOf(init)[0]?.content ?? '';
    return sse(['没在查。']);
  }, { taskStatus: () => '' }).reply(statusQ);
  assert.equal(emptyFactsReply.path, 'fast', '挂了进度回调就会留在快车道，哪怕事实是空的');
  assert.doesNotMatch(emptyFacts, /后台任务/);

  let blockedFetches = 0;
  const blocked = cascade(fakeInner().agent, async () => {
    blockedFetches += 1;
    return sse(['不该问到']);
  }, { taskStatus: () => '正在查天气，还没有结果。' });
  const blockedReply = await blocked.reply(blocker);
  const boringReply = await blocked.reply(boring);
  const blankReply = await blocked.reply('   ');
  assert.equal(blockedReply.delegate, 'task');
  assert.equal(boringReply.delegate, 'task');
  assert.equal(blankReply.delegate, 'task');
  assert.equal(blockedFetches, 0);

  const digits = await cascade(fakeInner().agent, async () => {
    throw new Error('含数字不该问快车道');
  }).reply('房间号是304');
  assert.equal(digits.path, 'dsh');
  assert.equal(digits.delegate, 'task');

  let memorySystem = '';
  const memoryReply = await cascade(fakeInner().agent, async (_url, init) => {
    memorySystem = messagesOf(init)[0]?.content ?? '';
    return sse(['你姓袁。']);
  }, {
    memory: (text) => {
      assert.equal(text, '你好呀');
      return ['他姓袁', '住在杭州'];
    },
  }).reply('你好呀');
  assert.equal(memoryReply.path, 'fast');
  assert.equal(memoryReply.speech, '你姓袁。');
  assert.match(memorySystem, /他姓袁；住在杭州/);
  assert.match(memorySystem, /不要委派/);

  let plainMemory = '';
  await cascade(fakeInner().agent, async (_url, init) => {
    plainMemory = messagesOf(init)[0]?.content ?? '';
    return sse(['你姓袁。']);
  }, {
    delegateEnabled: false,
    memory: () => ['他姓袁'],
  }).reply('你好呀');
  assert.match(plainMemory, /他姓袁/);
  assert.match(plainMemory, /别编/);
  assert.doesNotMatch(plainMemory, /\[\[DELEGATE\]\]/);
  assert.match(plainMemory, /不确定就说不知道/);

  let brokenSystem = '';
  const broken = await cascade(fakeInner().agent, async (_url, init) => {
    brokenSystem = messagesOf(init)[0]?.content ?? '';
    return sse(['在呢。']);
  }, {
    memory: () => { throw new Error('记忆坏了'); },
    taskStatus: () => { throw new Error('状态坏了'); },
  }).reply('你好呀');
  assert.equal(broken.path, 'fast');
  assert.equal(broken.speech, '在呢。');
  assert.match(brokenSystem, /只依据上面的对话/);
  assert.doesNotMatch(brokenSystem, /记忆坏了/);
  assert.doesNotMatch(brokenSystem, /状态坏了/);

  const emptyReasons: string[] = [];
  const emptyInner = fakeInner();
  const emptyAgent = cascade(emptyInner.agent, async () => sse(['[开心]']));
  emptyAgent.setDelegateHook((reason) => { emptyReasons.push(reason); });
  const emptyReply = await emptyAgent.reply('你好呀');
  assert.equal(emptyReply.delegate, 'empty');
  assert.equal(emptyReply.path, 'dsh');
  assert.equal(emptyReply.speech, '慢车道答复。');
  assert.deepEqual(emptyReasons, ['empty']);
  assert.equal(emptyInner.calls.length, 1);

  const blankSpeech = await cascade(fakeInner().agent, async () => sse(['   '])).reply('在吗呀');
  assert.equal(blankSpeech.delegate, 'empty');
  assert.equal(blankSpeech.path, 'dsh');
  assert.equal(blankSpeech.speech, '慢车道答复。');

  const hookLogs: string[] = [];
  const hooked = cascade(fakeInner().agent, async () => {
    throw new Error('动作句不该问快车道');
  }, { log: (line) => hookLogs.push(line) });
  hooked.setDelegateHook(() => { throw new Error('钩子炸了'); });
  const hookedReply = await hooked.reply('提醒我喝水');
  assert.equal(hookedReply.path, 'dsh');
  assert.equal(hookedReply.speech, '慢车道答复。');
  assert.ok(hookLogs.some((line) => line.includes('回执钩子失败') && line.includes('钩子炸了')));

  let audits = 0;
  const audited = await cascade(fakeInner().agent, async () => sse(['在呢。']), {
    audit: () => {
      audits += 1;
      throw new Error('审计炸了');
    },
  }).reply('你好呀');
  assert.equal(audited.path, 'fast');
  assert.equal(audited.speech, '在呢。');
  assert.ok(audits > 0);
});

test('快车道已经开口之后出错，就收下已播出的字，不再让 dsh 重说', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const quiet = fakeInner();
    const logs: string[] = [];
    const reasons: string[] = [];
    const quietAgent = cascade(quiet.agent, async () => sseThenError(['我在'], '中途断了'), {
      speculate: false,
      log: (line) => logs.push(line),
    });
    quietAgent.setDelegateHook((reason) => { reasons.push(reason); });
    const quietReply = await quietAgent.reply('你好呀');
    assert.equal(quietReply.path, 'fast');
    assert.equal(quietReply.speech, '我在');
    assert.equal(quietReply.text, '我在');
    assert.equal(quietReply.delegate, undefined);
    assert.equal(quiet.calls.length, 0);
    assert.deepEqual(reasons, []);
    assert.ok(logs.some((line) => line.includes('已播出一部分')));

    const raced = fakeInner();
    let cancelled = 0;
    const seen: string[] = [];
    const racedAgent = cascade({
      ...raced.agent,
      cancelTurn: () => { cancelled += 1; },
      reply: async (text, image, note) => {
        raced.push('慢车道不该被听到');
        return raced.agent.reply(text, image, note);
      },
    }, async () => sseThenError(['我在'], '中途断了'), { speculate: true });
    racedAgent.attachLiveSink((text) => { seen.push(text); });
    const racedReply = await racedAgent.reply('你好呀');
    await delay(20);
    assert.equal(racedReply.path, 'fast');
    assert.equal(racedReply.speech, '我在');
    assert.notEqual(racedReply.speech, '慢车道答复。');
    assert.deepEqual(seen, ['我在']);
    assert.equal(cancelled, 1, '已经开口就掐掉在途 dsh，不能两头一起说');
    assert.equal(raced.calls.length, 1);

    const failed = fakeInner();
    const errReply = await cascade(failed.agent, async () => new Response('no', { status: 503 }), {
      speculate: false,
    }).reply('你好呀');
    assert.equal(errReply.path, 'dsh');
    assert.equal(errReply.delegate, 'error');
    assert.equal(errReply.speech, '慢车道答复。');
    assert.equal(failed.calls.length, 1);

    await delay(20);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('取消：interrupt 与 off、没在忙的算了、回滚失败要写明没听到', async () => {
  const logs: string[] = [];
  let interrupts = 0;
  let cancels = 0;
  const notes: string[] = [];
  const inner: AgentProvider = {
    name: 'dsh',
    attachLiveSink: () => {},
    interruptTurn: () => { interrupts += 1; },
    cancelTurn: () => { cancels += 1; },
    reply: async (_text, _image, note) => {
      notes.push(note ?? '');
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
  };
  const agent = cascade(inner, async () => sse(['在呢。']), {
    speculate: true,
    cancelMode: 'interrupt',
    log: (line) => logs.push(line),
  });
  const first = await agent.reply('你好呀');
  const second = await agent.reply('在吗呀');
  assert.equal(first.path, 'fast');
  assert.equal(second.path, 'fast');
  assert.equal(second.speech, '在呢。');
  await delay(20);
  assert.equal(interrupts, 2);
  assert.equal(cancels, 0);
  assert.ok(logs.some((line) => line.includes('留到下次同步')));
  const flushed = await agent.reply('提醒我喝水');
  assert.equal(flushed.path, 'dsh');
  assert.match(notes.at(-1) ?? '', /用户: 你好呀/);
  assert.match(notes.at(-1) ?? '', /用户: 在吗呀/);

  let offInterrupts = 0;
  let offCancels = 0;
  const offNotes: string[] = [];
  const off = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    interruptTurn: () => { offInterrupts += 1; },
    cancelTurn: () => { offCancels += 1; },
    reply: async (_text, _image, note) => {
      offNotes.push(note ?? '');
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
  }, async () => sse(['在的呀。']), { speculate: true, cancelMode: 'off' });
  const offFast = await off.reply('你好呀');
  await off.reply('在吗呀');
  await off.reply('提醒我喝水');
  assert.equal(offFast.speech, '在的呀。');
  assert.equal(offInterrupts, 0);
  assert.equal(offCancels, 0, 'cancelMode=off 不取消 dsh');
  assert.match(offNotes.at(-1) ?? '', /用户: 你好呀/);

  const boomLogs: string[] = [];
  const boom = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    interruptTurn: () => { throw new Error('掐不掉'); },
    reply: async () => ({ text: '慢。', speech: '慢。' }),
  }, async () => sse(['在呢。']), {
    speculate: true,
    cancelMode: 'interrupt',
    log: (line) => boomLogs.push(line),
  });
  const boomReply = await boom.reply('你好呀');
  assert.equal(boomReply.path, 'fast');
  assert.equal(boomReply.speech, '在呢。');
  assert.ok(boomLogs.some((line) => line.includes('取消失败') && line.includes('掐不掉')));

  let idleCancels = 0;
  const idle = cascade({
    name: 'dsh',
    dshBusy: () => false,
    cancelTurn: () => { idleCancels += 1; },
    attachLiveSink: () => {},
    reply: async () => ({ text: '不该取消。', speech: '不该取消。' }),
  }, async () => sse(['那行，换个话题。']));
  const idleReply = await idle.reply('算了');
  assert.equal(idleCancels, 0);
  assert.equal(idleReply.path, 'fast');
  assert.equal(idleReply.speech, '那行，换个话题。');
  assert.notEqual(idleReply.speech, '好，不查了。');

  const busyLogs: string[] = [];
  const busy = cascade({
    name: 'dsh',
    dshBusy: () => true,
    cancelTurn: () => { throw new Error('取消不了'); },
    reply: async () => ({ text: '不该再问。', speech: '不该再问。' }),
  }, async () => sse(['不该问到']), { log: (line) => busyLogs.push(line) });
  const busyReply = await busy.reply('算了。');
  assert.equal(busyReply.path, 'fast');
  assert.equal(busyReply.speech, '好，不查了。');
  assert.ok(busyLogs.some((line) => line.includes('取消失败') && line.includes('取消不了')));

  const lostLogs: string[] = [];
  const lostNotes: string[] = [];
  let outcomes = 0;
  const lost = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    takeRollbackOutcome: () => {
      outcomes += 1;
      return 'failed';
    },
    reply: async (_text, _image, note) => {
      lostNotes.push(note ?? '');
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
  }, async () => sse(['在呢。']), {
    speculate: false,
    log: (line) => lostLogs.push(line),
  });
  await lost.reply('你好呀');
  await lost.reply('提醒我喝水');
  assert.equal(outcomes, 1);
  assert.match(lostNotes[0] ?? '', /没听到/);
  assert.match(lostNotes[0] ?? '', /用户: 你好呀/);
  assert.match(lostNotes[0] ?? '', /你: 在呢。/);
  assert.ok(lostLogs.some((line) => line.includes('没被听到')));
});

test('已经送进 dsh 的闲聊，下一轮还没记完时要重新带上', async () => {
  const notes: Array<string | undefined> = [];
  const resolvers: Array<(reply: AgentReplyView) => void> = [];
  const inner: AgentProvider = {
    name: 'dsh',
    attachLiveSink: () => {},
    reply: (_text, _image, note) => {
      notes.push(note);
      return new Promise<AgentReplyView>((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  const agent = cascade(inner, async () => sse(['在呢。']), { speculate: false, keepTurns: 8 });
  await agent.reply('你好呀');
  const first = agent.reply('提醒我喝水');
  assert.match(notes[0] ?? '', /用户: 你好呀/);
  assert.match(notes[0] ?? '', /快车道直接答给用户的/);
  const second = agent.reply('再查一下日程');
  assert.match(notes[1] ?? '', /用户: 你好呀/, '上一轮还挂着，这轮要把已经送出的闲聊重新带上');
  assert.match(notes[1] ?? '', /快车道直接答给用户的/);
  const finish = (reply: AgentReplyView): void => {
    const resolve = resolvers.shift();
    assert.ok(resolve);
    resolve(reply);
  };
  finish({ text: '第一句。', speech: '第一句。' });
  finish({ text: '第二句。', speech: '第二句。' });
  const [firstReply, secondReply] = await Promise.all([first, second]);
  assert.equal(firstReply.speech, '第一句。');
  assert.equal(secondReply.speech, '第二句。');
  assert.equal(firstReply.delegate, 'task');
  assert.equal(secondReply.delegate, 'task');
});

test('快车道窗口和 pending 上限会丢掉最老的一轮', async () => {
  const remembered: string[][] = [];
  const remember = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    reply: async () => ({ text: '已经记下了。', speech: '已经记下了。' }),
  }, async (_url, init) => {
    remembered.push(messagesOf(init).map((message) => `${message.role ?? ''}:${message.content ?? ''}`));
    return sse(['在呢。']);
  });
  await remember.reply('提醒我喝水');
  await remember.reply('你好呀');
  const follow = remembered[0] ?? [];
  assert.ok(follow.includes('user:提醒我喝水'));
  assert.ok(follow.includes('assistant:已经记下了。'));
  assert.ok(follow.includes('user:你好呀'));

  const long = '长'.repeat(220);
  let trimmed: Array<{ role?: string; content?: string }> = [];
  const narrow = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    reply: async () => ({ text: long, speech: long }),
  }, async (_url, init) => {
    trimmed = messagesOf(init);
    return sse(['在呢。']);
  }, { windowChars: 200 });
  await narrow.reply('提醒我喝水');
  await narrow.reply('你好呀');
  assert.equal(trimmed.some((message) => (message.content ?? '').includes(long)), false, '超长的 dsh 答复超出窗口后不再送给快车道');
  assert.deepEqual(
    trimmed.filter((message) => message.role === 'user').map((message) => message.content),
    ['你好呀'],
  );
  assert.equal(trimmed.some((message) => message.role === 'assistant'), false);

  const lines = [
    '你好呀', '在吗呀', '吃了没', '今天好', '聊两句', '再说说',
    '忙不忙', '想你了', '哈哈呀', '真好呀', '是吗呀', '好吧呀',
    '行吧呀', '可以呀', '嗯嗯呀', '拜拜呀', '晚安呀',
  ];
  assert.equal(lines.length, 17);
  const bodies: Array<Array<{ role?: string; content?: string }>> = [];
  const audits: Array<{ name: string; data: Record<string, unknown> }> = [];
  const notes: string[] = [];
  const capped = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    reply: async (_text, _image, note) => {
      notes.push(note ?? '');
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
  }, async (_url, init) => {
    bodies.push(messagesOf(init));
    return sse(['在呢。']);
  }, {
    keepTurns: 0,
    speculate: false,
    audit: (name, data) => { audits.push({ name, data }); },
  });
  for (const line of lines) {
    const reply = await capped.reply(line);
    assert.equal(reply.path, 'fast', line);
  }
  const secondUsers = (bodies[1] ?? []).filter((message) => message.role === 'user').map((message) => message.content);
  const secondAssist = (bodies[1] ?? [])
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);
  assert.deepEqual(secondUsers, [lines[0], lines[1]]);
  assert.deepEqual(secondAssist, ['在呢。']);
  const sixthUsers = (bodies[5] ?? []).filter((message) => message.role === 'user').map((message) => message.content);
  assert.equal(sixthUsers.includes(lines[0]), false, '窗口只留 4 轮，最老的一句要退出提示词');
  assert.equal(sixthUsers.includes(lines[1]), true);
  assert.equal(sixthUsers.at(-1), lines[5]);

  await capped.reply('提醒我喝水');
  const note = notes[0] ?? '';
  assert.equal(note.includes(`用户: ${lines[0]}`), false, 'pending 超过 16 轮就丢掉最老的');
  assert.equal(note.includes(`用户: ${lines[1]}`), true);
  assert.equal(note.includes(`用户: ${lines[16]}`), true);
  assert.equal(audits.some((item) => item.name === EVENTS.agentTrim
    && item.data['dropped_turns'] === 1
    && item.data['cap_turns'] === 16), true);
});

test('名字、会话和播报钩子原样转发；取消对不上票据就不动', async () => {
  const announcers: Array<((speech: string, emotion?: string) => void) | null> = [];
  const detached: Array<((userText: string, answer: string, spoken: boolean) => void) | null> = [];
  const logs: string[] = [];
  let cancels = 0;
  const inner: AgentProvider = {
    name: '慢车道',
    sessionId: 'sess-7',
    attachLiveSink: () => {},
    setAnnouncer: (cb) => { announcers.push(cb); },
    setDetachedAnswerSink: (cb) => { detached.push(cb); },
    cancelTurn: () => {
      cancels += 1;
      throw new Error('取消炸了');
    },
    reply: async () => ({ text: '慢。', speech: '慢。' }),
  };
  const agent = cascade(inner, async () => sse(['在呢。']), {
    speculate: false,
    log: (line) => logs.push(line),
  });
  assert.equal(agent.name, '慢车道');
  assert.equal(agent.sessionId, 'sess-7');
  const installed = detached[0];
  assert.equal(typeof installed, 'function');
  installed?.('提醒我喝水', '[开心]', false);
  installed?.('   ', '   ', true);
  assert.equal(agent.ledgerTurns.length, 0, '洗完没有字的放手答案不进账');
  installed?.('', '已经记下了。', false);
  assert.equal(agent.ledgerTurns.at(-1)?.userText, '（上一轮被打断的问题）');
  assert.equal(agent.ledgerTurns.at(-1)?.assistantText, '已经记下了。');
  assert.equal(agent.lastLedgerLane(), 'dsh');

  const announce = (): void => {};
  agent.setAnnouncer(announce);
  agent.setAnnouncer(null);
  assert.equal(announcers.at(-2), announce);
  assert.equal(announcers.at(-1), null);
  const replacement = (): void => {};
  agent.setDetachedAnswerSink(replacement);
  agent.setDetachedAnswerSink(null);
  assert.equal(detached.at(-2), replacement);
  assert.equal(detached.at(-1), null);

  const bare = cascade(fakeInner().agent, async () => sse(['嗯。']));
  bare.setAnnouncer(() => {});
  bare.setAnnouncer(null);
  bare.setDetachedAnswerSink(() => {});
  bare.setDetachedAnswerSink(null);
  assert.equal(bare.name, 'dsh');
  assert.equal(bare.sessionId, undefined);

  let early = 0;
  const fresh = cascade({
    ...fakeInner().agent,
    cancelTurn: () => { early += 1; },
  }, async () => sse(['在呢。']));
  fresh.cancelTurn({ no: 1, gen: 1 });
  assert.equal(early, 0, '还没有开轮，过期票据不能取消');

  const ticket = { no: 3, gen: 2 };
  await agent.reply('你好呀', undefined, undefined, { ticket });
  agent.cancelTurn({ no: 3, gen: 9 });
  agent.cancelTurn({ no: 8, gen: 2 });
  assert.equal(cancels, 0);
  agent.cancelTurn(ticket);
  assert.equal(cancels, 1);
  assert.ok(logs.some((line) => line.includes('取消失败') && line.includes('取消炸了')));
  cancels = 0;
  agent.cancelTurn();
  assert.equal(cancels, 1, '不带票据就是取消当前这一轮');
});

test('toEngine 没有流式接口时逐句走 synthesize', async () => {
  const synth: Array<{ text: string; emotion: string | undefined }> = [];
  const tts: TtsProvider = {
    name: 'plain',
    sampleRate: 22050,
    async *synthesize(text, emotion): AsyncGenerator<Buffer> {
      synth.push({ text, emotion });
      yield Buffer.from([1, 2]);
      yield Uint8Array.from([3]) as unknown as Buffer;
    },
  };
  const agent = cascade(fakeInner().agent, async () => sse(['[开心]我在呢。']), { speculate: false });
  const events = await collect(agent.toEngine(tts, { now: () => 50 }).respond(
    turnOf('你好呀'),
    new AbortController().signal,
  ));
  const meta = metaOf(events);
  const done = doneOf(events);
  const audio = events.filter((event): event is Extract<EngineEvent, { type: 'audio' }> => event.type === 'audio');
  assert.deepEqual(synth, [{ text: '我在呢。', emotion: 'happy' }]);
  assert.equal(audio.length, 2);
  assert.ok(audio.every((event) => Buffer.isBuffer(event.pcm) && event.sampleRate === 22050));
  assert.deepEqual(audio[0]?.pcm, Buffer.from([1, 2]));
  assert.deepEqual(audio[1]?.pcm, Buffer.from([3]));
  assert.equal(meta?.path, 'fast');
  assert.equal(meta?.firstSynthAtMs, 50);
  assert.equal(meta?.delegate, undefined);
  assert.equal(done?.speech, '我在呢。');
  assert.equal(events.at(-1)?.type, 'done');
});

test('toEngine 流式没有音频、整段再失败、播到一半被打断，这一轮都要结束', { timeout: 8_000 }, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let heard = '';
    const synth: Array<{ text: string; emotion: string | undefined }> = [];
    const logs: string[] = [];
    const emptyStream: TtsProvider = {
      name: 'empty',
      sampleRate: 16000,
      async *synthesize(text, emotion) {
        synth.push({ text, emotion });
        yield Buffer.from([8, 8]);
      },
      async *synthesizeStream(chunks) {
        for await (const piece of chunks) heard += piece;
        throw new Error('没有音频到达');
      },
    };
    const agent = cascade(fakeInner().agent, async () => sse(['[开心]我在呢。']), {
      speculate: false,
      log: (line) => logs.push(line),
    });
    const events = await collect(agent.toEngine(emptyStream).respond(
      turnOf('你好呀'),
      new AbortController().signal,
    ));
    assert.match(heard, /我在呢/);
    assert.deepEqual(synth, [{ text: '我在呢。', emotion: 'happy' }]);
    assert.equal(events.filter((event) => event.type === 'audio').length, 1);
    assert.equal(doneOf(events)?.speech, '我在呢。');
    assert.ok(logs.some((line) => line.includes('退回整段合成')));

    const failLogs: string[] = [];
    const bothDown: TtsProvider = {
      name: 'down',
      sampleRate: 16000,
      async *synthesize() {
        throw new Error('整段也挂了');
      },
      async *synthesizeStream() {
        throw new Error('stream down');
      },
    };
    const failed = cascade(fakeInner().agent, async () => sse(['[开心]我在呢。']), {
      speculate: false,
      log: (line) => failLogs.push(line),
    });
    const failedEvents = await collect(failed.toEngine(bothDown).respond(
      turnOf('你好呀'),
      new AbortController().signal,
    ));
    assert.equal(failedEvents.filter((event) => event.type === 'audio').length, 0);
    assert.equal(doneOf(failedEvents)?.speech, '我在呢。');
    assert.equal(failedEvents.at(-1)?.type, 'done');
    assert.ok(failLogs.some((line) => line.includes('整段合成失败')));

    const mid = new AbortController();
    let midPhase = '';
    const midTts: TtsProvider = {
      name: 'mid',
      sampleRate: 24000,
      async *synthesize() {
        yield Buffer.from([1]);
      },
      async *synthesizeStream(chunks) {
        for await (const _piece of chunks) {
          // 等 reply 把字送完再出第一块，避免打断落在开轮之前
        }
        midPhase = 'audio';
        yield Buffer.from([4]);
        midPhase = 'parked';
        await new Promise<void>((resolve) => {
          if (mid.signal.aborted) {
            resolve();
            return;
          }
          mid.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const midAgent = cascade({
      name: 'dsh',
      attachLiveSink: () => {},
      cancelTurn: () => {},
      reply: async () => ({ text: '不该走慢车道。', speech: '不该走慢车道。' }),
    }, async () => sse(['在呢。']), { speculate: false });
    const midPending = collect(midAgent.toEngine(midTts).respond(turnOf('你好呀'), mid.signal));
    for (let i = 0; i < 40 && midPhase !== 'parked'; i += 1) await delay(10);
    assert.equal(midPhase, 'parked');
    mid.abort();
    const midEvents = await midPending;
    await delay(20);
    assert.equal(doneOf(midEvents), undefined, '播到一半被打断，不再补 done');
    assert.match(textOf(midEvents), /在呢/);

    const tail = new AbortController();
    let tailPhase = '';
    const tailSynth: Array<{ text: string; emotion: string | undefined }> = [];
    const tailTts: TtsProvider = {
      name: 'tail',
      sampleRate: 24000,
      async *synthesize(text, emotion) {
        tailSynth.push({ text, emotion });
        tailPhase = 'fallback';
        yield Buffer.from([9]);
        tailPhase = 'parked';
        await new Promise<void>((resolve) => {
          if (tail.signal.aborted) {
            resolve();
            return;
          }
          tail.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async *synthesizeStream() {
        throw new Error('stream down');
      },
    };
    const tailAgent = cascade(fakeInner().agent, async () => sse(['[开心]我在呢。']), { speculate: false });
    const tailPending = collect(tailAgent.toEngine(tailTts).respond(turnOf('你好呀'), tail.signal));
    for (let i = 0; i < 40 && tailPhase !== 'parked'; i += 1) await delay(10);
    assert.equal(tailPhase, 'parked');
    assert.deepEqual(tailSynth, [{ text: '我在呢。', emotion: 'happy' }]);
    tail.abort();
    const tailEvents = await tailPending;
    await delay(20);
    assert.equal(doneOf(tailEvents), undefined);

    const ac = new AbortController();
    ac.abort();
    let replies = 0;
    let lateCancels = 0;
    const late = cascade({
      name: 'dsh',
      attachLiveSink: () => {},
      cancelTurn: () => { lateCancels += 1; },
      reply: async () => {
        replies += 1;
        return { text: '不该开问。', speech: '不该开问。' };
      },
    }, async () => sse(['不该问到']));
    const lateEvents = await collect(late.toEngine(quietTts()).respond(
      turnOf('你好呀', { no: 3, gen: 1 }),
      ac.signal,
    ));
    assert.deepEqual(lateEvents, []);
    assert.equal(replies, 0);
    assert.equal(lateCancels, 0, '还没钉上票据，已中止的信号不能误取消');

    class SinkBoom extends CascadeAgent {
      override attachLiveSink(_next: ((text: string) => void) | null): void {
        throw new Error('出口挂不上');
      }
    }
    const boom = new SinkBoom({
      inner: fakeInner().agent,
      apiKey: 'k',
      log: () => {},
      speculate: false,
      fetchImpl: async () => sse(['在呢。']),
    });
    const boomEvents = await collect(boom.toEngine(quietTts()).respond(
      turnOf('你好呀'),
      new AbortController().signal,
    ));
    await delay(20);
    assert.deepEqual(boomEvents, []);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('toEngine 带图直接交给 dsh；dsh 抛错或只吐情绪标签时照样收尾', async () => {
  const bytes = Buffer.from('pic-bytes');
  const images: Array<AgentImage | undefined> = [];
  const notes: Array<string | undefined> = [];
  let fastAsks = 0;
  const pictured = cascade({
    name: 'dsh',
    attachLiveSink: () => {},
    reply: async (_text, image, note) => {
      images.push(image);
      notes.push(note);
      return { text: '看到了。', speech: '看到了。' };
    },
  }, async () => {
    fastAsks += 1;
    return sse(['不该问到']);
  });
  const seen = await collect(pictured.toEngine(quietTts()).respond({
    ...turnOf('看看这个', { no: 4, gen: 1 }),
    hasImage: true,
    note: '设备注记',
    image: { bytes, mime: 'image/jpeg' },
  }, new AbortController().signal));
  assert.equal(fastAsks, 0);
  assert.equal(images[0]?.mimeType, 'image/jpeg');
  assert.equal(images[0]?.data, bytes.toString('base64'));
  assert.equal(notes[0], '设备注记');
  assert.equal(doneOf(seen)?.speech, '看到了。');
  assert.equal(doneOf(seen)?.fullText, '看到了。');
  assert.equal(metaOf(seen)?.path, 'dsh');
  assert.equal(metaOf(seen)?.delegate, 'task');

  let sink: ((text: string) => void) | null = null;
  const crashed = cascade({
    name: 'dsh',
    attachLiveSink: (next) => { sink = next; },
    reply: async () => {
      sink?.('半句就断了');
      throw new Error('dsh 崩了');
    },
  }, async () => {
    throw new Error('动作句不该问快车道');
  });
  const crashedEvents = await collect(crashed.toEngine(quietTts()).respond(
    turnOf('提醒我喝水'),
    new AbortController().signal,
  ));
  assert.equal(metaOf(crashedEvents), undefined);
  assert.equal(doneOf(crashedEvents)?.fullText, '半句就断了');
  assert.equal(doneOf(crashedEvents)?.speech, '半句就断了');
  assert.equal(crashedEvents.at(-1)?.type, 'done');

  let taggedSink: ((text: string) => void) | null = null;
  const tagged = cascade({
    name: 'dsh',
    attachLiveSink: (next) => { taggedSink = next; },
    reply: async () => {
      taggedSink?.('[开心]');
      return { text: '正文在结构里。', speech: '正文在结构里。' };
    },
  }, async () => {
    throw new Error('动作句不该问快车道');
  });
  const taggedEvents = await collect(tagged.toEngine(quietTts()).respond(
    turnOf('提醒我喝水'),
    new AbortController().signal,
  ));
  assert.equal(doneOf(taggedEvents)?.fullText, '[开心]');
  assert.equal(doneOf(taggedEvents)?.speech, '正文在结构里。');
  assert.equal(metaOf(taggedEvents)?.path, 'dsh');
  assert.equal(metaOf(taggedEvents)?.delegate, 'task');
  assert.equal(metaOf(taggedEvents)?.firstTokenMs, undefined);
});
