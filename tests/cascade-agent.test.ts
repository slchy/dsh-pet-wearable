/**
 * 纯级联 agent：路由不进 live，投机双轨、预跑、账本、toEngine 都在这条管线上。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CascadeAgent, type CascadeAgentOptions } from '../src/pipelines/cascade-agent.ts';
import type { EngineEvent, TurnInput } from '../src/engine-contract.ts';
import type { TurnTicket } from '../src/kernel.ts';
import type { AgentProvider, AgentReplyView, TtsProvider } from '../src/providers.ts';

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
