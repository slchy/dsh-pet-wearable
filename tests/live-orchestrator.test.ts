/**
 * Pure Live 编排：omni 是唯一前台，dsh 只在后台跑，插话不取消已答应的任务。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AudioFrame, EngineEvent, TurnInput } from '../src/engine-contract.ts';
import type { LiveAudioLane } from '../src/engines/live-voice-engine.ts';
import {
  LiveOrchestrator,
  decideLiveTurn,
  type LiveOrchestratorOptions,
  type LiveTurnFacts,
} from '../src/pipelines/live-orchestrator.ts';
import {
  LIVE_BACKEND_TASK_DIRECTIVE,
  buildLiveAckPrompt,
  buildLiveReportPrompt,
} from '../src/persona.ts';
import type {
  AgentAudioAnswer,
  AgentImage,
  AgentProvider,
  AgentReplyView,
  BackgroundTaskReport,
  DelegateReason,
  InjectKind,
  TtsProvider,
  TurnContext,
} from '../src/providers.ts';
import type { AsrRefiner } from '../src/runtime/asr-refine.ts';

const PCM = Buffer.from([1, 2, 3, 4]);
const TTS_PCM = Buffer.from([9, 9]);

interface ReplyCall {
  readonly text: string;
  readonly image?: AgentImage;
  readonly note?: string;
  readonly turn?: TurnContext;
}

interface Held {
  readonly resolve: (value: AgentReplyView) => void;
}

function must<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, what);
  return value;
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function turnOf(text: string, extra: Partial<TurnInput> = {}): TurnInput {
  return {
    no: 1,
    baseCommitSeq: 0,
    startedAtMs: 0,
    hasImage: false,
    ...extra,
    text,
  };
}

async function collect(source: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function audioOf(events: readonly EngineEvent[]): Buffer[] {
  return events
    .filter((event): event is Extract<EngineEvent, { type: 'audio' }> => event.type === 'audio')
    .map((event) => event.pcm);
}

function metas(events: readonly EngineEvent[]): Array<Extract<EngineEvent, { type: 'meta' }>> {
  return events.filter((event): event is Extract<EngineEvent, { type: 'meta' }> => event.type === 'meta');
}

function doneOf(events: readonly EngineEvent[]): Extract<EngineEvent, { type: 'done' }> {
  const last = events[events.length - 1];
  assert.ok(last !== undefined && last.type === 'done', '最后一条必须是 done');
  return last;
}

/** 委派注记里的低权重提示。改写查询只能出现在这行之后。 */
const DELEGATE_HINT_MARK =
  '【前台对用户意图的猜测（仅供参考，可能听岔或跑偏；若与用户原话或最近前台对话冲突，例如用户在纠正或质疑编造，一律以用户原话和上文为准）】';

function assertDelegateHint(note: string | undefined, rewritten: string): void {
  assert.ok(note !== undefined && note.includes(`${DELEGATE_HINT_MARK}\n${rewritten}`));
}

function fakeDsh(initial?: Partial<AgentReplyView>): {
  agent: AgentProvider;
  calls: ReplyCall[];
  cancelCount: () => number;
  announcer: () => ((speech: string, emotion?: string) => void) | null;
  hold: () => void;
  release: () => void;
  setResult: (view: AgentReplyView) => void;
} {
  const calls: ReplyCall[] = [];
  const pending: Held[] = [];
  let holding = false;
  let cancels = 0;
  let announcer: ((speech: string, emotion?: string) => void) | null = null;
  let result: AgentReplyView = {
    text: initial?.text ?? '后台结论',
    speech: initial?.speech ?? initial?.text ?? '后台结论',
    ...(initial?.emotion === undefined ? {} : { emotion: initial.emotion }),
  };
  const agent: AgentProvider = {
    name: 'dsh',
    sessionId: 'sess-live',
    setAnnouncer(cb) {
      announcer = cb;
    },
    cancelTurn() {
      cancels += 1;
    },
    reply(text, image, note, turn) {
      calls.push({ text, image, note, turn });
      if (!holding) return Promise.resolve(result);
      return new Promise((resolve) => {
        pending.push({ resolve });
      });
    },
  };
  return {
    agent,
    calls,
    cancelCount: () => cancels,
    announcer: () => announcer,
    hold() {
      holding = true;
    },
    release() {
      const waiters = pending.splice(0, pending.length);
      holding = false;
      for (const waiter of waiters) waiter.resolve(result);
    },
    setResult(view) {
      result = view;
    },
  };
}

function scriptedTts(): { tts: TtsProvider; texts: string[] } {
  const texts: string[] = [];
  const tts: TtsProvider = {
    name: 'fake-tts',
    sampleRate: 16_000,
    async *synthesize(text: string) {
      texts.push(text);
      yield TTS_PCM;
    },
  };
  return { tts, texts };
}

interface LaneOpts {
  readonly healthy?: boolean;
  readonly background?: boolean;
  readonly canAnswerText?: boolean;
  readonly speakResult?: AgentAudioAnswer | null;
  readonly queuedResult?: () => AgentAudioAnswer | null;
  /** 每次 `claim()` 新造一份，避免上一次的音频流被读完后第二次认领变成零字节。 */
  readonly answer?: () => AgentAudioAnswer | null;
  /** 不传则 `answerFromText` 返回 null（真正不可用）。 */
  readonly textAnswer?: (userText: string) => AgentAudioAnswer | null;
}

function audioAnswer(
  chunks: Buffer[],
  transcript: string,
  delegate?: { readonly reason: DelegateReason; readonly text: string | null },
): AgentAudioAnswer {
  return {
    sampleRate: 24_000,
    transcript: () => transcript,
    ...(delegate === undefined
      ? {}
      : {
        delegateReason: () => delegate.reason,
        delegateText: () => delegate.text,
      }),
    chunks: (async function* iterate() {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

function fakeLane(opts: LaneOpts = {}): LiveAudioLane & {
  feeds: Array<{ pcm: Buffer; voiced: boolean | undefined }>;
  discards: number;
  interrupts: number;
  claims: number;
  textAnswers: number;
  injects: Array<{ user: string; said: string; kind: InjectKind | undefined }>;
  speaks: Array<{ prompt: string; kind?: 'ack' | 'announce'; taskId?: string; query?: string }>;
  backgroundCancels: number;
  healthy: boolean;
  backgroundOk: boolean;
} {
  const feeds: Array<{ pcm: Buffer; voiced: boolean | undefined }> = [];
  const injects: Array<{ user: string; said: string; kind: InjectKind | undefined }> = [];
  const speaks: Array<{ prompt: string; kind?: 'ack' | 'announce'; taskId?: string; query?: string }> = [];
  const lane = {
    feeds,
    discards: 0,
    interrupts: 0,
    claims: 0,
    textAnswers: 0,
    injects,
    speaks,
    backgroundCancels: 0,
    healthy: opts.healthy ?? true,
    backgroundOk: opts.background ?? true,
    willServe(): boolean {
      return lane.healthy;
    },
    claim(): AgentAudioAnswer | null {
      lane.claims += 1;
      if (opts.answer === undefined) return audioAnswer([PCM], '嗯，在的。');
      return opts.answer();
    },
    canAnswerText(): boolean {
      return opts.canAnswerText === true;
    },
    answerFromText(userText: string): AgentAudioAnswer | null {
      lane.textAnswers += 1;
      if (opts.textAnswer === undefined) return null;
      return opts.textAnswer(userText);
    },
    discard(): void {
      lane.discards += 1;
    },
    interrupt(): void {
      lane.interrupts += 1;
    },
    feed(pcm: Buffer, voiced?: boolean): void {
      feeds.push({ pcm, voiced });
    },
    injectAnswer(userText: string, said: string, kind?: InjectKind): void {
      injects.push({ user: userText, said, kind });
    },
    canSpeakBackground(): boolean {
      return lane.backgroundOk;
    },
    speakFromText(
      promptText: string,
      meta?: { readonly taskId?: string; readonly query?: string },
    ): AgentAudioAnswer | null {
      speaks.push({ prompt: promptText, taskId: meta?.taskId, query: meta?.query });
      if (opts.speakResult === undefined) return audioAnswer([PCM], '说完了');
      return opts.speakResult;
    },
    enqueueSpeech(
      promptText: string,
      meta?: { readonly kind?: 'ack' | 'announce'; readonly taskId?: string; readonly query?: string },
    ): AgentAudioAnswer | null {
      speaks.push({ prompt: promptText, kind: meta?.kind, taskId: meta?.taskId, query: meta?.query });
      if (opts.queuedResult !== undefined) return opts.queuedResult();
      if (opts.speakResult !== undefined) return opts.speakResult;
      if (!lane.healthy && !lane.backgroundOk && opts.canAnswerText !== true) return null;
      return audioAnswer([PCM], meta?.kind === 'ack' ? '好，我查查。' : '说完了');
    },
    cancelBackgroundSpeech(): void {
      lane.backgroundCancels += 1;
    },
  };
  return lane;
}

function orch(
  inner: AgentProvider,
  tts: TtsProvider,
  lane: LiveAudioLane | null,
  extra: Partial<LiveOrchestratorOptions> = {},
): LiveOrchestrator {
  const host = new LiveOrchestrator({ inner, tts, log: () => {}, ...extra });
  if (lane !== null) host.attachAudioLane(lane);
  return host;
}

interface SsotProbe {
  readonly trace: string[];
  readonly toolOutputs: Array<{ callId: string; output: string }>;
  readonly snapshots: string[];
  readonly deletedItems: string[][];
}

function answerWithIds(
  chunks: Buffer[],
  transcript: string,
  extra: {
    readonly delegate?: { readonly reason: DelegateReason; readonly text: string | null };
    readonly callId?: string | null;
    readonly userItemId?: string | null;
    readonly assistantItemIds?: readonly string[];
  } = {},
): AgentAudioAnswer {
  return {
    ...audioAnswer(chunks, transcript, extra.delegate),
    delegateCallId: () => extra.callId ?? null,
    userItemId: () => extra.userItemId ?? null,
    assistantItemIds: () => [...(extra.assistantItemIds ?? [])],
  };
}

/** 带工具回执、单槽快照和删项的假车道。旧测试继续用没有这些方法的 {@link fakeLane}。 */
function ssotLane(opts: LaneOpts = {}): ReturnType<typeof fakeLane> & SsotProbe {
  const lane = fakeLane(opts);
  const trace: string[] = [];
  const toolOutputs: Array<{ callId: string; output: string }> = [];
  const snapshots: string[] = [];
  const deletedItems: string[][] = [];
  const enqueue = lane.enqueueSpeech;
  if (enqueue === undefined) throw new Error('单槽假车道缺少 enqueueSpeech');
  const speak = enqueue.bind(lane);
  lane.enqueueSpeech = (promptText, meta) => {
    trace.push('speak');
    return speak(promptText, meta);
  };
  return Object.assign(lane, {
    trace,
    toolOutputs,
    snapshots,
    deletedItems,
    sendFunctionCallOutput(callId: string, output: string): void {
      trace.push('tool');
      toolOutputs.push({ callId, output });
    },
    updateDynamicContext(snapshot: string): void {
      trace.push('snapshot');
      snapshots.push(snapshot);
    },
    deleteItems(itemIds: readonly string[]): void {
      trace.push('delete');
      deletedItems.push([...itemIds]);
    },
  });
}

function lastSnapshot(lane: { readonly snapshots: readonly string[] }): string {
  return lane.snapshots[lane.snapshots.length - 1] ?? '';
}

test('普通 live 轮只播 omni 音频，不叫 dsh，也不合成', async () => {
  const dsh = fakeDsh();
  const voice = scriptedTts();
  const lane = fakeLane({ answer: () => audioAnswer([PCM, Buffer.from([5])], '今天不错。') });
  const host = orch(dsh.agent, voice.tts, lane);
  const engine = host.toEngine();
  const frame: AudioFrame = {
    pcm: Buffer.from([7]),
    voiced: true,
    silenceMs: 0,
    gateSeq: 1,
    tsMs: 0,
  };
  engine.onAudioFrame?.(frame);

  assert.equal(engine.mode, 'live');
  assert.equal(engine.isHealthy(), true);
  assert.equal(host.willServeAudio('你好'), true);
  assert.equal(host.name, 'dsh');
  assert.equal(host.sessionId, 'sess-live');

  const events = await collect(engine.respond(turnOf('你好', {
    ticket: { no: 3, gen: 1 },
  }), new AbortController().signal));

  assert.deepEqual(audioOf(events), [PCM, Buffer.from([5])]);
  assert.equal(doneOf(events).fullText, '今天不错。');
  assert.equal(doneOf(events).speech, '今天不错。');
  assert.deepEqual(metas(events).map((meta) => meta.path), ['omni']);
  assert.equal(dsh.calls.length, 0);
  assert.equal(voice.texts.length, 0);
  assert.equal(lane.claims, 1);
  assert.deepEqual(lane.feeds, [{ pcm: Buffer.from([7]), voiced: true }]);
  assert.equal(host.lastLedgerLane(), 'live');
  await settle();
  assert.equal(dsh.calls.length, 0);
});

test('omni tool_call 垫话后异步派单，轮次不等 dsh，完成后再交给 taskReporter', async () => {
  const dsh = fakeDsh({ text: '[开心]明天晴', speech: '明天晴', emotion: 'happy' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([PCM], '我帮你看看。', { reason: 'delegate', text: '明天的天气' }),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane, {
    memory: (text) => `记得和「${text}」有关的事`,
  });
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const announcer: string[] = [];
  host.setAnnouncer((speech) => {
    announcer.push(speech);
  });

  const events = await collect(host.toEngine().respond(turnOf('你好', { note: '设备在线' }), new AbortController().signal));

  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 0);
  assert.equal(voice.texts.length, 0);
  assert.deepEqual(audioOf(events), [PCM]);
  const delegate = events.find((event) => event.type === 'delegate');
  assert.ok(delegate !== undefined && delegate.type === 'delegate');
  assert.equal(delegate.reason, 'delegate');
  const handed = metas(events).find((meta) => meta.nonBlocking === true);
  assert.deepEqual(handed, { type: 'meta', path: 'omni', delegate: 'delegate', nonBlocking: true });
  assert.equal(doneOf(events).fullText, '我帮你看看。');

  const call = must(dsh.calls[0], '后台调用');
  assert.equal(call.text, '你好');
  assert.equal(call.turn, undefined);
  const note = call.note ?? '';
  assertDelegateHint(note, '明天的天气');
  const directiveAt = note.indexOf(LIVE_BACKEND_TASK_DIRECTIVE);
  const memoryAt = note.indexOf('记得和「你好」有关的事');
  const hintAt = note.indexOf(DELEGATE_HINT_MARK);
  const userNoteAt = note.indexOf('设备在线');
  assert.ok(directiveAt >= 0 && memoryAt > directiveAt && hintAt > memoryAt && userNoteAt > hintAt);

  dsh.release();
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 1);
  assert.equal(announcer.length, 0);
  const report = must(reports[0], '汇报');
  assert.equal(report.source, 'tool_call');
  assert.equal(report.query, call.text);
  assert.equal(report.summary, '明天晴');
  assert.equal(report.emotion, 'happy');
  assert.equal(report.taskId.startsWith('bg-'), true);
});

test('omni tool_call 零音频时排队用提示词让 omni 自己补一句，不调外部 TTS', async () => {
  const dsh = fakeDsh();
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([], '', { reason: 'delegate', text: null }),
    queuedResult: () => audioAnswer([PCM], '好，我查查。'),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(turnOf('帮我查天气'), new AbortController().signal));

  assert.deepEqual(voice.texts, [], 'live 路径不得调用外部 TTS');
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.equal(lane.speaks[0]?.prompt, buildLiveAckPrompt('delegate', '帮我查天气'));
  assert.deepEqual(audioOf(events), [PCM]);
  const audio = events.find((event) => event.type === 'audio');
  assert.ok(audio !== undefined && audio.type === 'audio');
  assert.equal(audio.sampleRate, 24_000);
  const handed = metas(events).find((meta) => meta.nonBlocking === true);
  assert.equal(handed?.delegate, 'delegate');
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '查询').text, '帮我查天气');
  assert.equal(doneOf(events).speech, '好，我查查。');
  dsh.release();
  await settle();
});

test('空闲总线上 omni 的 rewrittenQuery 只作注记参考，dsh 主查询仍是用户原话', async () => {
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([PCM], '行，我去查。', { reason: 'delegate', text: '把天气查清楚' }),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  const events = await collect(host.toEngine().respond(
    turnOf('查一下天气', { no: 7, note: '原注' }),
    new AbortController().signal,
  ));
  await settle();

  assert.equal(doneOf(events).speech, '行，我去查。');
  assert.equal(dsh.calls.length, 1);
  const call = must(dsh.calls[0], '唯一一次');
  assert.equal(call.text, '查一下天气');
  const note = call.note ?? '';
  assertDelegateHint(note, '把天气查清楚');
  assert.ok(note.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  assert.ok(note.includes('原注'));
  assert.ok(note.indexOf('原注') > note.indexOf(DELEGATE_HINT_MARK));
  await settle();
  assert.equal(dsh.calls.length, 1);

  dsh.release();
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 1);
  assert.equal(must(reports[0], '汇报').source, 'tool_call');
  assert.equal(must(reports[0], '汇报').query, '查一下天气');
});

test('用户质疑编造时，跑偏的 rewrittenQuery 只作注记参考，上文对话完整保留', async () => {
  const dsh = fakeDsh({ text: '那是我编的', speech: '那是我编的' });
  dsh.hold();
  const voice = scriptedTts();
  const scripts: Array<{ readonly speech: string; readonly rewritten: string | null }> = [
    { speech: '《骑士之声》是一部电影。', rewritten: null },
    { speech: '我可能记混了。', rewritten: null },
    { speech: '我再看看。', rewritten: '查询《潜行者》剧情' },
  ];
  let cursor = 0;
  const lane = fakeLane({
    answer: () => {
      const script = scripts[cursor] ?? { speech: '嗯', rewritten: null };
      cursor += 1;
      return audioAnswer(
        [PCM],
        script.speech,
        script.rewritten === null ? undefined : { reason: 'delegate', text: script.rewritten },
      );
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane, {
    memory: () => '长期记忆：在聊塔可夫斯基',
  });
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const engine = host.toEngine();
  await collect(engine.respond(turnOf('我让你给我介绍一下塔可夫斯基。', { no: 7 }), new AbortController().signal));
  await collect(engine.respond(turnOf('哪来的《骑士之声》？', { no: 8 }), new AbortController().signal));
  await collect(engine.respond(turnOf('你又在编', {
    no: 9,
    note: '用户在纠正',
  }), new AbortController().signal));
  await settle();

  assert.equal(dsh.calls.length, 1);
  const call = must(dsh.calls[0], '质疑轮');
  assert.equal(call.text, '你又在编');
  assert.equal(call.text.includes('潜行者'), false);
  const note = call.note ?? '';
  assertDelegateHint(note, '查询《潜行者》剧情');
  const directiveAt = note.indexOf(LIVE_BACKEND_TASK_DIRECTIVE);
  const memoryAt = note.indexOf('长期记忆：在聊塔可夫斯基');
  const dialogAt = note.indexOf('【最近前台对话（仅供理解代词与指代，不要重复回答）】');
  const hintAt = note.indexOf(DELEGATE_HINT_MARK);
  const userNoteAt = note.indexOf('用户在纠正');
  assert.ok(
    directiveAt >= 0
    && memoryAt > directiveAt
    && dialogAt > memoryAt
    && hintAt > dialogAt
    && userNoteAt > hintAt,
  );
  const dialog = note.slice(dialogAt, hintAt);
  const user1 = dialog.indexOf('用户：我让你给我介绍一下塔可夫斯基。');
  const asst1 = dialog.indexOf('米馍：《骑士之声》是一部电影。');
  const user2 = dialog.indexOf('用户：哪来的《骑士之声》？');
  const asst2 = dialog.indexOf('米馍：我可能记混了。');
  assert.ok(user1 >= 0 && asst1 > user1 && user2 > asst1 && asst2 > user2);
  assert.equal(dialog.includes('你又在编'), false, '正在派的这一轮还不是前文');
  assert.equal(dialog.includes('查询《潜行者》剧情'), false, '跑偏的改写不能写进前文');
  assert.equal(note.includes('用户原话：「'), false);

  dsh.release();
  await settle();
  assert.equal(must(reports[0], '汇报').query, '你又在编');
});

test('像长期事实的话后台静默记，omni 马上答，不发汇报', async () => {
  const dsh = fakeDsh({ text: '记下了', speech: '记下了' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({ answer: () => audioAnswer([PCM], '好，记住了。') });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  const events = await collect(host.toEngine().respond(turnOf('我叫张三'), new AbortController().signal));
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).fullText, '好，记住了。');
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '静默记忆').text, '我叫张三');
  assert.ok(must(dsh.calls[0], '指令').note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  assert.equal(reports.length, 0);
  assert.equal(voice.texts.length, 0);

  dsh.release();
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 0);
});

test('「别查了」取消在跑的后台任务并丢掉 omni；插话不取消', async () => {
  const dsh = fakeDsh({ text: '天气晴', speech: '天气晴' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([PCM], '我去查。', { reason: 'delegate', text: '天气' }),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const engine = host.toEngine();

  await collect(engine.respond(turnOf('查一下天气', { no: 4 }), new AbortController().signal));
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(dsh.cancelCount(), 0);

  engine.abortSpeculation('barge_in');
  assert.equal(lane.interrupts, 1);
  assert.equal(lane.discards, 0);
  assert.equal(dsh.cancelCount(), 0);
  host.cancelTurn({ no: 4, gen: 1 });
  host.dropPrefetch('内核中止(barge_in)');
  assert.equal(lane.interrupts, 2);
  assert.equal(dsh.cancelCount(), 0);

  dsh.release();
  await settle();
  assert.equal(reports.length, 1, '插话之后后台结果仍然要汇报');

  dsh.hold();
  dsh.setResult({ text: '第二件', speech: '第二件' });
  await collect(engine.respond(turnOf('查一下订单', { no: 5 }), new AbortController().signal));
  await settle();
  assert.equal(dsh.calls.length, 2);

  const cancelEvents = await collect(engine.respond(turnOf('别查了', { no: 6 }), new AbortController().signal));
  assert.equal(dsh.cancelCount(), 1);
  assert.equal(lane.discards, 1);
  assert.equal(lane.claims, 2);
  assert.deepEqual(voice.texts, [], '取消确认走 omni 队列，不得调用外部 TTS');
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.equal(lane.speaks[0]?.prompt, buildLiveAckPrompt('cancel', '别查了'));
  assert.deepEqual(audioOf(cancelEvents), [PCM]);
  assert.deepEqual(metas(cancelEvents), [{ type: 'meta', path: 'omni' }]);
  assert.equal(doneOf(cancelEvents).speech, '好，我查查。');

  dsh.release();
  await settle();
  assert.equal(reports.length, 1, '取消之后迟到的结果不再汇报');
  assert.equal(host.cancelBackgroundTasks(), false);
});

test('abortSpeculation 的另两个原因只丢弃 omni，不取消后台', async () => {
  const dsh = fakeDsh();
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([PCM], '垫一句', { reason: 'delegate', text: null }),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const engine = host.toEngine();
  await collect(engine.respond(turnOf('查一下路况'), new AbortController().signal));
  await settle();

  engine.abortSpeculation('delegated');
  assert.equal(lane.discards, 1);
  assert.equal(lane.interrupts, 0);
  assert.equal(dsh.cancelCount(), 0);
  engine.abortSpeculation('superseded');
  host.dropPrefetch('内核中止(superseded)');
  assert.equal(lane.discards, 3);
  assert.equal(dsh.cancelCount(), 0);
  dsh.release();
  await settle();
});

test('dsh 自己的 setAnnouncer 经总线交给 taskReporter；没人接时才退回 announcer', async () => {
  const dsh = fakeDsh();
  const voice = scriptedTts();
  const lane = fakeLane();
  const host = orch(dsh.agent, voice.tts, lane);
  const reports: BackgroundTaskReport[] = [];
  const spoken: Array<{ speech: string; emotion: string | undefined }> = [];
  host.setAnnouncer((speech, emotion) => {
    spoken.push({ speech, emotion });
  });

  const push = dsh.announcer();
  assert.ok(push !== null, '构造时要把 announcer 接到 dsh 上');
  push('子代理跑完了', 'happy');
  assert.equal(reports.length, 0);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0]?.speech, '子代理跑完了');
  assert.equal(spoken[0]?.emotion, 'happy');

  host.setTaskReporter((report) => {
    reports.push(report);
  });
  push('[得意]闹钟设好了', 'proud');
  assert.equal(spoken.length, 1);
  assert.equal(reports.length, 1);
  const report = must(reports[0], '外部播报');
  assert.equal(report.source, 'dsh_background');
  assert.equal(report.summary, '闹钟设好了');
  assert.equal(report.emotion, 'proud');
  assert.equal(report.query, '');
});

test('speakBackgroundReport 按车道状态返回 defer / fallback / spoken，并且只回注一次', async () => {
  const dsh = fakeDsh({ text: '端口是 8080', speech: '端口是 8080' });
  const voice = scriptedTts();
  const lane = fakeLane();
  const host = orch(dsh.agent, voice.tts, lane);
  const reports: BackgroundTaskReport[] = [];
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  // Pure Live 下哪怕 verbatim: true 也走 omni 同嗓子播报，绝不切去外部 TTS
  assert.equal(await host.speakBackgroundReport(
    { speech: '端口是 8080', verbatim: true, taskId: 'v', query: '查端口' },
    async () => ({ spokenBytes: 10, interrupted: false, transcript: '端口是 8080' }),
  ), 'spoken');
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.prompt, buildLiveReportPrompt({
    query: '查端口',
    summary: '端口是 8080',
    verbatim: true,
  }));
  lane.speaks.length = 0;

  const bareDsh = fakeDsh();
  const bare = new LiveOrchestrator({ inner: bareDsh.agent, tts: voice.tts, log: () => {} });
  assert.equal(await bare.speakBackgroundReport(
    { speech: '没车道' },
    async () => ({ spokenBytes: 10, interrupted: false, transcript: '' }),
  ), 'fallback');

  lane.backgroundOk = false;
  assert.equal(await host.speakBackgroundReport(
    { speech: '忙', taskId: 'busy' },
    async () => ({ spokenBytes: 10, interrupted: false, transcript: '' }),
  ), 'defer');
  assert.equal(lane.speaks.length, 0);

  lane.backgroundOk = true;
  const quiet = fakeLane({ speakResult: null });
  host.attachAudioLane(quiet);
  assert.equal(await host.speakBackgroundReport(
    { speech: '此刻不能说', taskId: 'later' },
    async () => ({ spokenBytes: 10, interrupted: false, transcript: '' }),
  ), 'defer');
  assert.equal(quiet.speaks.length, 1);

  host.attachAudioLane(lane);
  const prompt = buildLiveReportPrompt({
    query: '天气',
    summary: '明天晴',
    needsConfirm: '要提醒你吗',
  });
  const spoken = await host.speakBackgroundReport(
    { speech: '明天晴', taskId: 'task-1', query: '天气', needsConfirm: '要提醒你吗' },
    async () => ({ spokenBytes: 80, interrupted: false, transcript: '明天晴' }),
  );
  assert.equal(spoken, 'spoken');
  assert.equal(must(lane.speaks[0], '提示').prompt, prompt);
  assert.equal(lane.speaks[0]?.taskId, 'task-1');
  host.noteFallbackAnnounceSpoken({ speech: '明天晴', taskId: 'task-1', query: '天气' }, false);
  assert.equal(lane.injects.length, 0, 'omni 已经说完的，不再 spoken 回注第二遍');

  const dropped = await host.speakBackgroundReport(
    { speech: '没声', taskId: 'task-drop', query: '电量' },
    async () => ({ spokenBytes: 0, interrupted: false, transcript: '' }),
  );
  assert.equal(dropped, 'fallback');
  host.noteFallbackAnnounceSpoken({ speech: '没声', taskId: 'task-drop', query: '电量' }, false);
  assert.equal(lane.injects.length, 1, 'fallback 还没标记注入，要按 spoken 回注');
  assert.deepEqual(lane.injects[0], { user: '电量', said: '没声', kind: 'spoken' });

  const pushed = dsh.announcer();
  assert.ok(pushed !== null);
  pushed('跑完了');
  await settle();
  assert.equal(reports.length, 1);
  const pending = must(reports[0], '待说的汇报');

  const next = await collect(host.toEngine().respond(turnOf('跑完没'), new AbortController().signal));
  assert.equal(doneOf(next).fullText, '嗯，在的。');
  assert.equal(lane.injects.length, 2);
  assert.deepEqual(lane.injects[1], {
    user: pending.query,
    said: pending.summary,
    kind: 'unspoken',
  });

  await collect(host.toEngine().respond(turnOf('再说一遍'), new AbortController().signal));
  assert.equal(lane.injects.length, 2, '同一个 taskId 只按 unspoken 回注一次');

  host.noteFallbackAnnounceSpoken({ speech: '另一件', query: '日程' }, false);
  assert.equal(lane.injects.length, 3);
  assert.equal(lane.injects[2]?.kind, 'spoken');
  assert.equal(lane.injects[2]?.user, '日程');
  host.noteFallbackAnnounceSpoken({ speech: '被打断', query: '日程', taskId: 'cut' }, true);
  assert.equal(lane.injects.length, 3);

  host.cancelBackgroundSpeech();
  assert.equal(lane.backgroundCancels, 1);
});

test('识图：omni 健康时异步派单并应声；坏了就同步问 dsh', async () => {
  const image = {
    bytes: Buffer.from('jpeg-bytes'),
    mime: 'image/jpeg',
  };
  const photo = turnOf('这是什么', {
    no: 2,
    hasImage: true,
    image,
    note: '刚拍的',
    ticket: { no: 2, gen: 1 },
  });

  const dsh = fakeDsh({ text: '一只猫', speech: '一只猫' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({ answer: () => audioAnswer([PCM], '不该播这句') });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(photo, new AbortController().signal));

  assert.equal(lane.discards, 1);
  assert.equal(lane.claims, 0);
  assert.deepEqual(voice.texts, [], '识图应声走 omni 队列，不调外部 TTS');
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.equal(lane.speaks[0]?.prompt, buildLiveAckPrompt('photo', '这是什么'));
  assert.deepEqual(metas(events), [{
    type: 'meta',
    path: 'omni',
    delegate: 'task',
    nonBlocking: true,
  }]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.equal(dsh.calls.length, 1);
  const handed = must(dsh.calls[0], '识图派单');
  assert.equal(handed.text, '这是什么');
  assert.deepEqual(handed.image, {
    mimeType: 'image/jpeg',
    data: Buffer.from('jpeg-bytes').toString('base64'),
  });
  assert.ok(handed.note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  assert.ok(handed.note?.includes('刚拍的'));
  assert.equal(handed.turn, undefined);
  dsh.release();
  await settle();

  lane.healthy = false;
  lane.backgroundOk = true;
  dsh.hold();
  const still = await collect(host.toEngine().respond(turnOf('这又是什么', {
    no: 9,
    hasImage: true,
    image,
    note: '第二张',
  }), new AbortController().signal));
  assert.equal(doneOf(still).speech, '好，我查查。');
  assert.equal(dsh.calls.length, 2);
  assert.equal(must(dsh.calls[1], '第二张').text, '这又是什么');
  dsh.release();
  await settle();

  lane.backgroundOk = false;
  dsh.setResult({ text: '同步看见一只猫', speech: '同步看见一只猫' });
  const broken = await collect(host.toEngine().respond(photo, new AbortController().signal));
  assert.equal(lane.claims, 0);
  assert.deepEqual(metas(broken), [{ type: 'meta', path: 'dsh', delegate: 'task' }]);
  assert.equal(doneOf(broken).fullText, '同步看见一只猫');
  assert.equal(doneOf(broken).speech, '同步看见一只猫');
  assert.deepEqual(voice.texts, [], '同步兜底也不得调用外部 TTS');
  const sync = must(dsh.calls[2], '同步识图');
  assert.equal(sync.note, '刚拍的');
  assert.deepEqual(sync.turn, { ticket: { no: 2, gen: 1 } });
  assert.equal(host.lastLedgerLane(), 'dsh');

  const down = orch(dsh.agent, voice.tts, null);
  const fallen = await collect(down.toEngine().respond(
    turnOf('在吗'),
    new AbortController().signal,
  ));
  assert.deepEqual(metas(fallen), [{ type: 'meta', path: 'dsh' }]);
  assert.equal(doneOf(fallen).speech, '同步看见一只猫');
  assert.equal(down.lastLedgerLane(), 'dsh');
  assert.equal(down.toEngine().isHealthy(), false);
  assert.equal(down.willServeAudio('在吗'), false);
});

test('车道所有权：旧连接的断开不能摘掉新连接', () => {
  const dsh = fakeDsh();
  const voice = scriptedTts();
  const host = orch(dsh.agent, voice.tts, null);
  const first = fakeLane();
  const second = fakeLane();
  host.attachAudioLane(first);
  assert.equal(host.willServeAudio(''), true);

  host.attachAudioLane(null, first);
  assert.equal(host.willServeAudio(''), false);

  host.attachAudioLane(second);
  host.attachAudioLane(null, first);
  assert.equal(host.willServeAudio(''), true);
  host.attachAudioLane(null, second);
  assert.equal(host.willServeAudio(''), false);
});

test('同步兜底进行中，插话才取消这一次 dsh；后台任务不受 cancelTurn 影响', async () => {
  const dsh = fakeDsh({ text: '兜底', speech: '兜底一句' });
  dsh.hold();
  const voice = scriptedTts();
  const host = orch(dsh.agent, voice.tts, null);
  const engine = host.toEngine();
  const pending = engine.respond(turnOf('在吗', { ticket: { no: 1, gen: 2 } }), new AbortController().signal);
  const iter = pending[Symbol.asyncIterator]();
  const first = iter.next();
  await settle();
  assert.equal(dsh.calls.length, 1);
  host.cancelTurn({ no: 1, gen: 2 });
  assert.equal(dsh.cancelCount(), 1);
  dsh.release();
  const step = await first;
  assert.equal(step.done, false);
  assert.equal(step.value?.type, 'meta');
  await iter.return?.();
});

test('换上新车道才清除去重；同一条车道的 turn 去重还在', async () => {
  const dsh = fakeDsh({ text: '晴', speech: '晴' });
  const voice = scriptedTts();
  const laneA = fakeLane({
    answer: () => audioAnswer([PCM], '我去查。', { reason: 'delegate', text: null }),
  });
  const host = orch(dsh.agent, voice.tts, laneA);
  const engine = host.toEngine();

  await collect(engine.respond(turnOf('查一下天气', { no: 1 }), new AbortController().signal));
  await settle();
  assert.equal(dsh.calls.length, 1);

  host.attachAudioLane(laneA);
  await collect(engine.respond(turnOf('查一下天气', { no: 1 }), new AbortController().signal));
  await settle();
  assert.equal(dsh.calls.length, 1, '同一条车道再挂一次，不能把本连接的去重清掉');

  const stranger = fakeLane();
  host.attachAudioLane(null, stranger);
  await collect(engine.respond(turnOf('查一下天气', { no: 1 }), new AbortController().signal));
  await settle();
  assert.equal(dsh.calls.length, 1, '对不上的旧连接不能重置新车道的去重');

  const laneB = fakeLane({
    answer: () => audioAnswer([PCM], '再查。', { reason: 'delegate', text: null }),
  });
  host.attachAudioLane(laneB);
  await collect(engine.respond(turnOf('查一下天气', { no: 1 }), new AbortController().signal));
  await settle();
  assert.equal(dsh.calls.length, 2, '新连接的 turn=1 不能被旧会话已完成的任务吞掉');
});

test('换车道丢掉上一连接还没注入的汇报，已注入的 taskId 也不再粘着', async () => {
  const dsh = fakeDsh();
  const voice = scriptedTts();
  const laneA = fakeLane();
  const host = orch(dsh.agent, voice.tts, laneA);
  const reports: BackgroundTaskReport[] = [];
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  const push = dsh.announcer();
  assert.ok(push !== null);
  push('上一连接的结论');
  host.noteFallbackAnnounceSpoken({ speech: '旧结论', taskId: 'sticky', query: '旧问题' }, false);
  assert.equal(laneA.injects.length, 1);

  host.attachAudioLane(laneA);
  host.noteFallbackAnnounceSpoken({ speech: '旧结论', taskId: 'sticky', query: '旧问题' }, false);
  assert.equal(laneA.injects.length, 1, '同一条车道不能把已注入标记清掉');

  const laneB = fakeLane();
  host.attachAudioLane(laneB);
  const events = await collect(host.toEngine().respond(turnOf('在吗'), new AbortController().signal));
  assert.equal(doneOf(events).fullText, '嗯，在的。');
  assert.equal(laneB.injects.length, 0, '新车道不回注上一连接还堆着的汇报');
  assert.equal(reports.length, 1);

  host.noteFallbackAnnounceSpoken({ speech: '旧结论', taskId: 'sticky', query: '旧问题' }, false);
  assert.equal(laneB.injects.length, 1, '换车道清掉兼容去重后，同一 taskId 可以再注');
  assert.equal(laneB.injects[0]?.kind, 'spoken');
});

test('后台注记带上最近四轮前台对话，打断标在米馍句尾', async () => {
  const dsh = fakeDsh({ text: '8.6 分', speech: '8.6 分' });
  dsh.hold();
  const voice = scriptedTts();
  const replies = [
    '《银翼回声》是林远山的故事。',
    '林远山离开了主城。',
    '边城很冷。',
    '他没有再回来。',
    '故事停在雪夜里。',
  ];
  let cursor = 0;
  const lane = fakeLane({
    answer: () => audioAnswer([PCM], replies[cursor++] ?? '嗯'),
  });
  const host = orch(dsh.agent, voice.tts, lane, {
    memory: () => '长期记忆：喜欢科幻',
  });
  const engine = host.toEngine();
  const said = [
    ['聊聊《银翼回声》', 1],
    ['林远山后来怎样', 2],
    ['边城呢', 3],
    ['他回来了吗', 4],
    ['后来呢', 5],
  ] as const;
  for (const [text, no] of said) {
    await collect(engine.respond(turnOf(text, {
      no,
      ticket: { no, gen: 1 },
    }), new AbortController().signal));
  }
  host.reconcileTurnOutcome({ ticket: { no: 2, gen: 1 }, truncated: true, endedAtMs: 40 });

  await collect(engine.respond(turnOf('帮我查一下它的豆瓣评分', {
    no: 6,
    note: '原注记',
  }), new AbortController().signal));
  await settle();

  const note = must(dsh.calls[0], '评分查询').note ?? '';
  const header = '【最近前台对话（仅供理解代词与指代，不要重复回答）】';
  const dialogAt = note.indexOf(header);
  const memoryAt = note.indexOf('长期记忆：喜欢科幻');
  const directiveAt = note.indexOf(LIVE_BACKEND_TASK_DIRECTIVE);
  const userNoteAt = note.indexOf('原注记');
  assert.ok(directiveAt >= 0 && memoryAt > directiveAt && dialogAt > memoryAt && userNoteAt > dialogAt);
  const dialog = note.slice(dialogAt, userNoteAt);
  assert.equal(dialog.includes('聊聊《银翼回声》'), false, '只带最近四轮，更早的一轮要丢掉');
  assert.ok(dialog.includes('用户：林远山后来怎样'));
  assert.ok(dialog.includes('米馍：林远山离开了主城。（被打断）'));
  assert.ok(dialog.includes('用户：边城呢'));
  assert.ok(dialog.includes('米馍：边城很冷。'));
  assert.ok(dialog.includes('用户：后来呢'));
  assert.ok(dialog.includes('米馍：故事停在雪夜里。'));
  assert.equal(dialog.includes('帮我查一下它的豆瓣评分'), false, '正在派的这一轮还不是前文');
  assert.equal(dsh.calls.length, 1);
  dsh.release();
  await settle();
});

test('没封段时 answerFromText 有答案就不降级 dsh', async () => {
  const dsh = fakeDsh({ text: '不该走兜底', speech: '不该走兜底' });
  const voice = scriptedTts();
  const lane = fakeLane({
    healthy: false,
    canAnswerText: true,
    textAnswer: (userText) => {
      assert.equal(userText, '在吗');
      return audioAnswer([PCM, Buffer.from([5])], '在的。');
    },
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(turnOf('在吗'), new AbortController().signal));

  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 1);
  assert.equal(dsh.calls.length, 0);
  assert.equal(voice.texts.length, 0);
  assert.deepEqual(audioOf(events), [PCM, Buffer.from([5])]);
  const audio = events.find((event) => event.type === 'audio');
  assert.ok(audio !== undefined && audio.type === 'audio');
  assert.equal(audio.sampleRate, 24_000);
  assert.deepEqual(
    events.filter((event) => event.type === 'text'),
    [{ type: 'text', delta: '在的。' }],
  );
  assert.deepEqual(metas(events).map((meta) => meta.path), ['omni']);
  assert.equal(doneOf(events).fullText, '在的。');
  assert.equal(doneOf(events).speech, '在的。');
  assert.equal(host.lastLedgerLane(), 'live');
});

test('answerFromText 的 tool_call 与封段认领同一条派单和零音频垫话', async () => {
  const dsh = fakeDsh();
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    healthy: false,
    textAnswer: () => audioAnswer([], '', { reason: 'delegate', text: '明天的天气' }),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(turnOf('在吗'), new AbortController().signal));

  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 1);
  assert.deepEqual(voice.texts, [], 'answerFromText 零音频垫话也走 omni 队列，不调外部 TTS');
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.equal(lane.speaks[0]?.query, '在吗');
  assert.equal(lane.speaks[0]?.prompt, buildLiveAckPrompt('delegate', '在吗'));
  assert.deepEqual(audioOf(events), [PCM]);
  const delegate = events.find((event) => event.type === 'delegate');
  assert.ok(delegate !== undefined && delegate.type === 'delegate');
  assert.equal(delegate.reason, 'delegate');
  assert.equal(delegate.rewrittenQuery, '明天的天气');
  const handed = metas(events).find((meta) => meta.nonBlocking === true);
  assert.equal(handed?.delegate, 'delegate');
  assert.deepEqual(metas(events).map((meta) => meta.path), ['omni', 'omni']);
  assert.equal(doneOf(events).speech, '好，我查查。');
  await settle();
  assert.equal(dsh.calls.length, 1);
  const delegated = must(dsh.calls[0], '查询');
  assert.equal(delegated.text, '在吗');
  assertDelegateHint(delegated.note, '明天的天气');
  assert.ok(delegated.note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  dsh.release();
  await settle();
});

test('answerFromText 返回 null 才同步问 dsh', async () => {
  const dsh = fakeDsh({ text: '兜底在', speech: '兜底在' });
  const voice = scriptedTts();
  const lane = fakeLane({
    healthy: false,
    textAnswer: () => null,
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(
    turnOf('在吗', { note: '会话' }),
    new AbortController().signal,
  ));

  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 1);
  assert.equal(lane.discards, 0);
  assert.deepEqual(metas(events), [{ type: 'meta', path: 'dsh' }]);
  assert.equal(doneOf(events).speech, '兜底在');
  assert.deepEqual(voice.texts, [], '兜底也不得调用外部 TTS');
  assert.equal(host.lastLedgerLane(), 'dsh');
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '同步').note, '会话');
  assert.equal(must(dsh.calls[0], '同步').text, '在吗');
});

test('问钟点时丢掉 omni 编的答案，早派后台，前台只应一声', async () => {
  const dsh = fakeDsh({ text: '下午四点', speech: '下午四点' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([PCM], '晚上八点半'),
    textAnswer: () => audioAnswer([PCM], '晚上八点半'),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  const events = await collect(host.toEngine().respond(turnOf('现在几点了', {
    no: 2,
    note: '钟',
  }), new AbortController().signal));

  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 0);
  assert.equal(lane.discards, 1);
  assert.deepEqual(voice.texts, [], '问钟点应声走 omni 队列，不调外部 TTS');
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.equal(lane.speaks[0]?.prompt, buildLiveAckPrompt('clock', '现在几点了'));
  assert.deepEqual(audioOf(events), [PCM]);
  assert.deepEqual(metas(events), [{
    type: 'meta',
    path: 'omni',
    delegate: 'task',
    nonBlocking: true,
  }]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.equal(host.lastLedgerLane(), 'live');
  await settle();
  assert.equal(dsh.calls.length, 1);
  const call = must(dsh.calls[0], '钟点');
  assert.equal(call.text, '现在几点了');
  assert.ok(call.note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  assert.ok(call.note?.includes('钟'));
  assert.equal(call.note?.includes('【最近前台对话'), false);

  dsh.release();
  await settle();
  assert.equal(reports.length, 1);
  assert.equal(must(reports[0], '汇报').source, 'early_rule');

  const dated = await collect(host.toEngine().respond(
    turnOf('今天几月几号星期几', { no: 3 }),
    new AbortController().signal,
  ));
  assert.equal(lane.claims, 0);
  assert.equal(lane.discards, 2);
  assert.deepEqual(voice.texts, []);
  assert.equal(lane.speaks.length, 2);
  assert.equal(doneOf(dated).speech, '好，我查查。');
  await settle();
  assert.equal(dsh.calls.length, 2);
  assert.equal(must(dsh.calls[1], '日期').text, '今天几月几号星期几');
});

test('没封段但还能按文本答时，问时间也不走 answerFromText', async () => {
  const dsh = fakeDsh({ text: '四点', speech: '四点' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    healthy: false,
    canAnswerText: true,
    textAnswer: () => audioAnswer([PCM], '晚上八点半'),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(
    turnOf('现在几点了'),
    new AbortController().signal,
  ));

  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 0);
  assert.equal(lane.discards, 1);
  assert.deepEqual(voice.texts, []);
  assert.equal(lane.speaks.length, 1);
  assert.equal(doneOf(events).speech, '好，我查查。');
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.ok(must(dsh.calls[0], '早派').note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  dsh.release();
  await settle();
});

test('问时间时车道不可用才同步问 dsh', async () => {
  const dsh = fakeDsh({ text: '下午四点整', speech: '下午四点整' });
  const voice = scriptedTts();
  const lane = fakeLane({
    healthy: false,
    background: false,
    textAnswer: () => audioAnswer([PCM], '晚上八点半'),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(
    turnOf('现在几点了', { note: '只此一次' }),
    new AbortController().signal,
  ));

  assert.equal(lane.discards, 0);
  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 0);
  assert.deepEqual(metas(events), [{ type: 'meta', path: 'dsh' }]);
  assert.equal(doneOf(events).speech, '下午四点整');
  assert.equal(host.lastLedgerLane(), 'dsh');
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '同步').note, '只此一次');
});

test('守卫轮未调工具时拦截未核实音频，改播短应声并补派，闲聊不派', async () => {
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  const voice = scriptedTts();
  const leaked = Buffer.from([7, 7, 7, 7]);
  const lane = fakeLane({
    answer: () => audioAnswer([leaked], '我看看。'),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const engine = host.toEngine();
  const phrases = ['今天天气怎么样', '股价多少', '堵车吗'];
  for (let i = 0; i < phrases.length; i += 1) {
    const text = phrases[i] ?? '';
    const events = await collect(engine.respond(turnOf(text, { no: i + 1 }), new AbortController().signal));
    assert.equal(events.some((ev) => ev.type === 'audio' && ev.pcm.equals(leaked)), false);
    assert.equal(events.some((ev) => ev.type === 'text' && ev.delta.includes('我看看')), false);
    assert.deepEqual(audioOf(events), [PCM]);
    assert.equal(doneOf(events).speech, '好，我查查。');
    assert.ok(metas(events).some((meta) =>
      meta.path === 'omni' && meta.delegate === 'task' && meta.nonBlocking === true));
  }
  assert.equal(lane.discards, phrases.length);
  assert.equal(lane.claims, phrases.length);
  assert.equal(lane.textAnswers, 0);
  assert.equal(lane.speaks.length, phrases.length);
  assert.ok(lane.speaks.every((speak) => speak.kind === 'ack'));
  assert.equal(voice.texts.length, 0);
  await settle();
  assert.deepEqual(dsh.calls.map((call) => call.text), phrases);
  await settle();
  assert.equal(reports.length, phrases.length);
  assert.ok(reports.every((report) => report.source === 'early_rule'));

  const before = dsh.calls.length;
  const discards = lane.discards;
  const speaks = lane.speaks.length;
  const chat = await collect(engine.respond(turnOf('今天心情不错', { no: 8 }), new AbortController().signal));
  const plan = await collect(engine.respond(turnOf('我明天下午三点开会', { no: 9 }), new AbortController().signal));
  assert.deepEqual(audioOf(chat), [leaked]);
  assert.equal(doneOf(chat).speech, '我看看。');
  assert.deepEqual(audioOf(plan), [leaked]);
  assert.equal(doneOf(plan).speech, '我看看。');
  await settle();
  assert.equal(dsh.calls.length, before);
  assert.equal(lane.discards, discards);
  assert.equal(lane.speaks.length, speaks);
});

test('没封段的实时事实走 answerFromText，未委派音频不外泄并补派短应声', async () => {
  const dsh = fakeDsh({ text: '明天有雨', speech: '明天有雨' });
  dsh.hold();
  const voice = scriptedTts();
  const leaked = Buffer.from([8, 8, 8]);
  const lane = fakeLane({
    healthy: false,
    canAnswerText: true,
    textAnswer: (userText) => {
      assert.equal(userText, '今天天气怎么样');
      return audioAnswer([leaked], '我帮你看天气。');
    },
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(
    turnOf('今天天气怎么样', { no: 4 }),
    new AbortController().signal,
  ));

  assert.equal(lane.claims, 0);
  assert.equal(lane.textAnswers, 1);
  assert.equal(lane.discards, 1);
  assert.equal(voice.texts.length, 0);
  assert.equal(events.some((ev) => ev.type === 'audio' && ev.pcm.equals(leaked)), false);
  assert.equal(events.some((ev) => ev.type === 'text' && ev.delta.includes('我帮你看天气')), false);
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.ok(metas(events).some((meta) =>
    meta.path === 'omni' && meta.delegate === 'task' && meta.nonBlocking === true));
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '天气').text, '今天天气怎么样');
  assert.ok(must(dsh.calls[0], '天气').note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  dsh.release();
  await settle();
});

test('源码不接文本级联、不预跑、不撤回', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/pipelines/live-orchestrator.ts', import.meta.url)),
    'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const token of ['FastLlmClient', 'PrefetchSlot', 'speculatePartial', 'rollbackTurn', 'prefetch(']) {
    assert.equal(code.includes(token), false, token);
  }
});

test('decideLiveTurn 把前台分支收成显式种类', () => {
  const base: LiveTurnFacts = {
    text: '你好呀',
    hasImage: false,
    cancelActive: false,
    photoHandOff: false,
    laneCanAnswer: true,
    willServe: true,
    canTryText: true,
  };
  assert.equal(decideLiveTurn({ ...base, text: '别查了', cancelActive: true }), 'cancel_bg');
  assert.equal(decideLiveTurn({ ...base, hasImage: true, photoHandOff: true }), 'photo_delegate');
  assert.equal(decideLiveTurn({ ...base, hasImage: true, photoHandOff: false, willServe: false, canTryText: false, laneCanAnswer: false }), 'fallback_dsh');
  assert.equal(decideLiveTurn({ ...base, text: '现在几点了' }), 'clock_override');
  assert.equal(decideLiveTurn({
    ...base,
    text: '现在几点了',
    laneCanAnswer: false,
    willServe: false,
    canTryText: true,
  }), 'fallback_dsh');
  assert.equal(decideLiveTurn({ ...base, text: '查一下天气' }), 'live_with_bg_guard');
  assert.equal(decideLiveTurn({ ...base, text: '今天天气怎么样' }), 'live_with_bg_guard');
  assert.equal(decideLiveTurn({ ...base, text: '股价多少', willServe: false, canTryText: true }), 'live_with_bg_guard');
  assert.equal(decideLiveTurn({ ...base, text: '如果明天下午不下雨的话我们就去公园走一圈。' }), 'live_direct');
  assert.equal(decideLiveTurn({ ...base, text: '要是今天不下雨我就去跑步。' }), 'live_direct');
  assert.equal(decideLiveTurn({ ...base }), 'live_direct');
  assert.equal(decideLiveTurn({
    ...base,
    text: '查一下天气',
    willServe: false,
    canTryText: false,
    laneCanAnswer: false,
  }), 'fallback_dsh');
});

test('decideLiveTurn 把纠正、核查与实时事实收进守卫轮，闲聊仍直答', () => {
  const base: LiveTurnFacts = {
    text: '你好呀',
    hasImage: false,
    cancelActive: false,
    photoHandOff: false,
    laneCanAnswer: true,
    willServe: true,
    canTryText: true,
  };
  for (const text of [
    '我说的是本古迷',
    '你不是有工具调用能力吗？你去看看那个任务还在跑没有？',
  ]) {
    assert.equal(decideLiveTurn({ ...base, text }), 'live_with_bg_guard', text);
  }
  for (const text of [
    '今天发生了哪些新闻？',
    '本机活跃开发的项目有哪些？',
    '千问 Live 模型支持双语吗？',
    '你知道班公秘吗？',
    '你知道波兰作家莱姆吗？',
    '奇耻之身是什么？',
  ]) {
    assert.equal(decideLiveTurn({ ...base, text }), 'live_with_bg_guard', text);
  }
  for (const text of ['你好呀', '查好没？', '你看过星球大战没？']) {
    assert.equal(decideLiveTurn({ ...base, text }), 'live_direct', text);
  }
});

test('委派 dsh 前用整句 PCM 精转，注记留流式初转参考', async () => {
  const streaming = '你去查一下 d s h 插件的液态。';
  const refinedText = '你去查一下 dsh 插件的生态。';
  const pfcm = Buffer.alloc(16_000, 1);
  const refined: Array<{ pcm: Buffer; streamingText: string }> = [];
  const subtitles: Array<{ text: string; previous: string }> = [];
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  dsh.hold();
  const lane = ssotLane({
    answer: () => audioAnswer([PCM], '我查查。', { reason: 'delegate', text: null }),
  });
  const host = orch(dsh.agent, scriptedTts().tts, lane, {
    refineAsr: async (req) => {
      refined.push({ pcm: req.pcm, streamingText: req.streamingText });
      return refinedText;
    },
    onAsrRefined: (text, previous) => {
      subtitles.push({ text, previous });
    },
  });

  await collect(host.toEngine().respond(
    turnOf(streaming, { no: 1, utterancePcm: pfcm }),
    new AbortController().signal,
  ));
  await settle();

  assert.equal(refined.length, 1);
  assert.equal(refined[0]?.pcm.byteLength, 16_000, '精转必须拿到未切碎的整句 PCM');
  assert.equal(refined[0]?.pcm.equals(pfcm), true);
  assert.equal(refined[0]?.streamingText, streaming);
  const call = must(dsh.calls[0], '委派 dsh');
  assert.equal(call.text, refinedText);
  assert.match(call.note ?? '', /【流式初转参考】你去查一下 d s h 插件的液态。/);
  assert.deepEqual(subtitles, [{ text: refinedText, previous: streaming }]);

  dsh.release();
  await settle();
});

test('闲聊直答不精转；静默记忆写入也不精转', async () => {
  let refineCalls = 0;
  const refiner: AsrRefiner = async () => {
    refineCalls += 1;
    return '改写后的句子';
  };
  const dsh = fakeDsh();
  const chitchat = orch(dsh.agent, scriptedTts().tts, fakeLane(), { refineAsr: refiner });
  await collect(chitchat.toEngine().respond(
    turnOf('你好呀', { utterancePcm: PCM }),
    new AbortController().signal,
  ));
  await settle();
  assert.equal(refineCalls, 0, 'live_direct 不委派，不该精转');
  assert.equal(dsh.calls.length, 0);

  const memorized = orch(dsh.agent, scriptedTts().tts, fakeLane(), { refineAsr: refiner });
  await collect(memorized.toEngine().respond(
    turnOf('记住我喜欢下雨天', { utterancePcm: PCM }),
    new AbortController().signal,
  ));
  await settle();
  assert.equal(refineCalls, 0, 'memory_silent 静默写入不精转');
});

test('精转返回 null 时继续用流式初转委派 dsh', async () => {
  const streaming = '你去查一下 d s h 插件的液态。';
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  dsh.hold();
  const lane = ssotLane({
    answer: () => audioAnswer([PCM], '我查查。', { reason: 'delegate', text: null }),
  });
  const host = orch(dsh.agent, scriptedTts().tts, lane, { refineAsr: async () => null });

  await collect(host.toEngine().respond(
    turnOf(streaming, { no: 1, utterancePcm: Buffer.alloc(16_000, 1) }),
    new AbortController().signal,
  ));
  await settle();

  const call = must(dsh.calls[0], '委派 dsh');
  assert.equal(call.text, streaming);
  assert.equal((call.note ?? '').includes('【流式初转参考】'), false);
  dsh.release();
  await settle();
});

test('dsh 抛 AbortError 时只记取消，不发失败播报，单槽快照为 cancelled', async () => {
  const abortAgent: AgentProvider = {
    name: 'dsh',
    sessionId: 'sess-live',
    reply() {
      const error = new Error('turn aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    },
  };
  const lane = ssotLane({
    answer: () => audioAnswer([PCM], '我查查。', { reason: 'delegate', text: null }),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(abortAgent, scriptedTts().tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  await collect(host.toEngine().respond(
    turnOf('帮我查一下北之战', { no: 1 }),
    new AbortController().signal,
  ));
  await settle();

  assert.equal(reports.length, 0, '宿主侧取消不是失败，不能播「刚才那个任务没跑成」');
  assert.match(lastSnapshot(lane), /状态=cancelled/);
  assert.doesNotMatch(lastSnapshot(lane), /状态=failed/);
});

test('动作轮在 delegate 到达前不派单，到达后主查询仍是用户原话', async () => {
  const dsh = fakeDsh({ text: '晴', speech: '晴' });
  dsh.hold();
  const voice = scriptedTts();
  const gate: { release: (() => void) | null } = { release: null };
  const lane = fakeLane({
    answer: () => ({
      sampleRate: 24_000,
      transcript: () => '我查查。',
      delegateReason: () => 'delegate' as const,
      delegateText: () => '改写后的天气',
      chunks: (async function* waitChunk() {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        yield PCM;
      })(),
    }),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const pending = collect(host.toEngine().respond(
    turnOf('查一下天气', { no: 3 }),
    new AbortController().signal,
  ));
  await settle();
  assert.equal(dsh.calls.length, 0, 'delegate 还没到，不得用原话抢跑');
  const go = gate.release;
  if (go === null) assert.fail('音频流没有挂起');
  go();
  await pending;
  await settle();
  assert.equal(dsh.calls.length, 1);
  const rewritten = must(dsh.calls[0], '改写');
  assert.equal(rewritten.text, '查一下天气');
  assertDelegateHint(rewritten.note, '改写后的天气');
  assert.ok(rewritten.note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  dsh.release();
  await settle();
});

test('同步兜底的取消只认当前票据；dispose 之后不再派单', async () => {
  const dsh = fakeDsh({ text: '兜底', speech: '兜底一句' });
  dsh.hold();
  const voice = scriptedTts();
  const host = orch(dsh.agent, voice.tts, null);
  const pending = host.toEngine().respond(
    turnOf('在吗', { ticket: { no: 1, gen: 2 } }),
    new AbortController().signal,
  );
  const iter = pending[Symbol.asyncIterator]();
  const first = iter.next();
  await settle();
  assert.equal(dsh.calls.length, 1);
  host.cancelTurn({ no: 1, gen: 1 });
  host.cancelTurn({ no: 9, gen: 2 });
  assert.equal(dsh.cancelCount(), 0, '票据对不上不得取消这一次兜底');
  host.cancelTurn({ no: 1, gen: 2 });
  assert.equal(dsh.cancelCount(), 1);
  dsh.release();
  const step = await first;
  assert.equal(step.done, false);
  assert.equal(step.value?.type, 'meta');
  await iter.return?.();

  host.dropPrefetch('barge_in');
  host.dropPrefetch('delegated');
  host.dropPrefetch('superseded');
  host.dispose();
  const after = await collect(host.toEngine().respond(
    turnOf('查一下天气'),
    new AbortController().signal,
  ));
  assert.equal(after.length, 0);
  assert.equal(dsh.calls.length, 1);
  host.cancelTurn({ no: 1, gen: 2 });
  assert.equal(dsh.cancelCount(), 1);
});

test('tool_call 带 callId 时先回执再补句，并刷新单槽，不回注', async () => {
  const dsh = fakeDsh({ text: '空调已打开', speech: '空调已打开' });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([], '', {
          delegate: { reason: 'delegate', text: null },
          callId: 'call_ac',
          userItemId: 'user-ac',
          assistantItemIds: ['asst-ac'],
        });
      }
      return audioAnswer([PCM], '在的。');
    },
    queuedResult: () => audioAnswer([PCM], '好，我查查。'),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  const events = await collect(host.toEngine().respond(
    turnOf('帮我打开空调'),
    new AbortController().signal,
  ));

  const speakAt = lane.trace.indexOf('speak');
  const toolAt = lane.trace.indexOf('tool');
  const snapAt = lane.trace.indexOf('snapshot');
  assert.ok(toolAt >= 0 && speakAt > toolAt, '工具回执必须早于零音频补句');
  assert.ok(snapAt >= 0 && snapAt < speakAt, '单槽快照必须早于零音频补句');
  assert.equal(lane.toolOutputs.length, 1);
  const tool = must(lane.toolOutputs[0], '工具回执');
  assert.equal(tool.callId, 'call_ac');
  const body = JSON.parse(tool.output) as { status?: string; executed?: boolean; taskId?: string };
  assert.equal(body.status, 'accepted_running');
  assert.equal(body.executed, false);
  assert.equal(typeof body.taskId, 'string');
  assert.match(lane.snapshots[0] ?? '', /未执行完/);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.deepEqual(voice.texts, []);
  assert.equal(lane.injects.length, 0);
  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 0);

  dsh.release();
  await settle();
  assert.equal(reports.length, 1);
  await collect(host.toEngine().respond(turnOf('在吗', { no: 2 }), new AbortController().signal));
  assert.equal(lane.injects.length, 0, '单槽车道不得 injectAnswer');
  assert.deepEqual(voice.texts, []);
});

test('守卫轮 Omni 未调工具时立刻删掉未核实助手项，核实后再播报', async () => {
  const dsh = fakeDsh({
    text: '客厅空调实际未开，已经打开',
    speech: '客厅空调实际未开，已经打开',
  });
  dsh.hold();
  const voice = scriptedTts();
  const leaked = Buffer.from([6, 6, 6, 6]);
  const lane = ssotLane({
    answer: () => answerWithIds([leaked], '空调已经打开了26度', {
      userItemId: 'user-h',
      assistantItemIds: ['hallu-1', 'hallu-2'],
    }),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  const events = await collect(host.toEngine().respond(
    turnOf('帮我打开空调', { no: 3 }),
    new AbortController().signal,
  ));

  assert.equal(events.some((ev) => ev.type === 'audio' && ev.pcm.equals(leaked)), false);
  assert.equal(lane.discards, 1);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.ok(metas(events).some((meta) =>
    meta.path === 'omni' && meta.delegate === 'task' && meta.nonBlocking === true));
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.deepEqual(lane.deletedItems, [['hallu-1', 'hallu-2']]);
  assert.match(lastSnapshot(lane), /未执行完/);
  assert.match(lastSnapshot(lane), /此前口头回复未经执行核实/);
  assert.doesNotMatch(lastSnapshot(lane), /空调已经打开了26度/);
  assert.equal(reports.length, 0);
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '早派').text, '帮我打开空调');
  assert.deepEqual(voice.texts, []);
  assert.equal(lane.injects.length, 0);

  dsh.release();
  await settle();
  assert.equal(reports.length, 1);
  const report = must(reports[0], '核实');
  assert.equal(report.source, 'early_rule');
  assert.equal(report.summary, '客厅空调实际未开，已经打开');
  assert.match(lastSnapshot(lane), /客厅空调实际未开，已经打开/);
  assert.match(lastSnapshot(lane), /已核实/);
  assert.equal(lane.injects.length, 0);
  assert.deepEqual(voice.texts, []);
});

test('守卫轮首块音频前已 delegate 时直出应声，不拦截', async () => {
  const dsh = fakeDsh({ text: '晴，二十二度', speech: '晴，二十二度' });
  dsh.hold();
  const voice = scriptedTts();
  const native = Buffer.from([3, 3, 3]);
  const lane = fakeLane({
    answer: () => audioAnswer([native], '我查查。', { reason: 'delegate', text: '明天北京天气' }),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const events = await collect(host.toEngine().respond(
    turnOf('明天北京天气怎么样？', { no: 2 }),
    new AbortController().signal,
  ));

  assert.equal(lane.discards, 0);
  assert.equal(lane.speaks.length, 0);
  assert.deepEqual(audioOf(events), [native]);
  assert.equal(doneOf(events).speech, '我查查。');
  assert.equal(metas(events).some((meta) => meta.delegate === 'task'), false);
  assert.ok(metas(events).some((meta) => meta.delegate === 'delegate' && meta.nonBlocking === true));
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '天气').text, '明天北京天气怎么样？');
  dsh.release();
  await settle();
  assert.equal(reports.length, 1);
  assert.equal(must(reports[0], '工具').source, 'tool_call');
  assert.deepEqual(voice.texts, []);
});

test('守卫轮漏调工具时原音频 0 字节外泄，改为 discard、早规则和短应声', async () => {
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  const voice = scriptedTts();
  const logs: string[] = [];
  const leaked = Buffer.from([9, 8, 7, 6]);
  const phrases = ['英伟达今天股价多少？', '记一下我明天下午三点要开会'];
  const madeUp = ['6.24 美元', '好的，记下了'];
  let n = 0;
  const lane = fakeLane({
    answer: () => {
      const at = n;
      n += 1;
      return audioAnswer([leaked], madeUp[at] ?? '编的');
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane, {
    log: (line) => {
      logs.push(line);
    },
  });
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const engine = host.toEngine();
  for (let i = 0; i < phrases.length; i += 1) {
    const events = await collect(engine.respond(
      turnOf(phrases[i] ?? '', { no: i + 1 }),
      new AbortController().signal,
    ));
    const invented = madeUp[i] ?? '';
    assert.equal(events.some((ev) => ev.type === 'audio' && ev.pcm.equals(leaked)), false);
    assert.equal(events.some((ev) => ev.type === 'text' && ev.delta.includes(invented)), false);
    assert.deepEqual(audioOf(events), [PCM]);
    assert.equal(doneOf(events).speech, '好，我查查。');
    assert.ok(metas(events).some((meta) =>
      meta.path === 'omni' && meta.delegate === 'task' && meta.nonBlocking === true));
    assert.equal(lane.speaks[i]?.kind, 'ack');
    assert.equal(lane.speaks[i]?.query, phrases[i]);
  }
  assert.equal(lane.discards, phrases.length);
  assert.equal(lane.claims, phrases.length);
  assert.equal(voice.texts.length, 0);
  assert.ok(logs.some((line) => line.includes('守卫轮前台未调工具，拦截未核实音频并转交后台')));
  await settle();
  assert.deepEqual(dsh.calls.map((call) => call.text), phrases);
  await settle();
  assert.equal(reports.length, phrases.length);
  assert.ok(reports.every((report) => report.source === 'early_rule'));
});

test('闲聊和条件句不进守卫轮，不拦截，不派 dsh', async () => {
  const dsh = fakeDsh({ text: '不该派', speech: '不该派' });
  const voice = scriptedTts();
  const spoken = Buffer.from([4, 4, 4, 4]);
  const lane = fakeLane({
    answer: () => audioAnswer([spoken], '好呀，一起去。'),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const engine = host.toEngine();
  const phrases = ['今天心情不错', '如果明天下午不下雨的话我们就去公园走一圈。'];
  for (let i = 0; i < phrases.length; i += 1) {
    const events = await collect(engine.respond(
      turnOf(phrases[i] ?? '', { no: i + 1 }),
      new AbortController().signal,
    ));
    assert.deepEqual(audioOf(events), [spoken]);
    assert.equal(doneOf(events).speech, '好呀，一起去。');
    assert.equal(metas(events).some((meta) => meta.delegate === 'task'), false);
  }
  await settle();
  assert.equal(dsh.calls.length, 0);
  assert.equal(lane.discards, 0);
  assert.equal(lane.speaks.length, 0);
  assert.deepEqual(voice.texts, []);
});

test('守卫轮零音频且未调工具时补派并补一句短应声', async () => {
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([], '我瞎编的股价是 6.24'),
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const events = await collect(host.toEngine().respond(
    turnOf('英伟达今天股价多少？', { no: 6 }),
    new AbortController().signal,
  ));

  assert.equal(lane.discards, 0, '没有音频块可拦，discard 留在有声那条路径');
  assert.equal(events.some((ev) => ev.type === 'text' && ev.delta.includes('6.24')), false);
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.ok(metas(events).some((meta) =>
    meta.path === 'omni' && meta.delegate === 'task' && meta.nonBlocking === true));
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '股价').text, '英伟达今天股价多少？');
  dsh.release();
  await settle();
  assert.equal(must(reports[0], '早派').source, 'early_rule');
  assert.deepEqual(voice.texts, []);
});

test('WorkBuddy 原意纠偏写进汇报、单槽快照和下一轮前文', async () => {
  const dsh = fakeDsh({
    text: '[原意: 帮我打开空调]\n客厅空调已开启',
    speech: '客厅空调已开启',
  });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([PCM], '我来处理。', {
          delegate: { reason: 'delegate', text: '打开空调' },
          callId: 'call_fix',
          userItemId: 'user-fix',
          assistantItemIds: ['asst-fix'],
        });
      }
      return audioAnswer([PCM], '我看看天气。');
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  await collect(host.toEngine().respond(
    turnOf('帮我开空掉', { no: 4 }),
    new AbortController().signal,
  ));
  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 0);

  dsh.release();
  await settle();
  const report = must(reports[0], '纠偏汇报');
  assert.equal(report.canonicalUser, '帮我打开空调');
  assert.equal(report.previousUserText, '帮我开空掉');
  assert.equal(report.summary, '客厅空调已开启');
  assert.equal(Object.hasOwn(report, 'canonicalUser'), true);
  assert.equal(Object.hasOwn(report, 'previousUserText'), true);
  assert.equal(report.summary.includes('原意'), false);
  assert.match(lastSnapshot(lane), /客厅空调已开启/);
  assert.match(lastSnapshot(lane), /已核实说法：第4轮「帮我开空掉」→「帮我打开空调」/);

  dsh.hold();
  dsh.setResult({ text: '今天二十度', speech: '今天二十度' });
  await collect(host.toEngine().respond(
    turnOf('今天天气怎么样', { no: 5 }),
    new AbortController().signal,
  ));
  const note = must(dsh.calls[1], '下一轮').note ?? '';
  assert.match(note, /用户：帮我打开空调/);
  assert.equal(note.includes('用户：帮我开空掉'), false);
  assert.match(lastSnapshot(lane), /帮我打开空调/);
  assert.equal(lane.injects.length, 0);
  assert.deepEqual(voice.texts, []);
  dsh.release();
  await settle();
});

test('专名问句提前收进守卫轮：前台未调工具时在首块前拦截丢弃，绝不直答和后台双触发', async () => {
  const dsh = fakeDsh({
    text: '[原意: 你知道 Bangumi 吗？]\nBangumi 番组计划是中文 ACG 社区。',
    speech: 'Bangumi 番组计划是中文 ACG 社区。',
  });
  dsh.hold();
  const voice = scriptedTts();
  const leaked = Buffer.from([7, 7, 7, 7]);
  const lane = fakeLane({
    answer: () => audioAnswer([leaked], '我当然知道《半部论语》，意思是把论语学透一半。'),
  });
  const logs: string[] = [];
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane, {
    log: (line) => {
      logs.push(line);
    },
  });
  host.setTaskReporter((report) => {
    reports.push(report);
  });
  const engine = host.toEngine();

  const events = await collect(engine.respond(
    turnOf('你知道班公秘吗？', { no: 1 }),
    new AbortController().signal,
  ));
  assert.equal(events.some((ev) => ev.type === 'audio' && ev.pcm.equals(leaked)), false, '未核实直答音频不得泄漏');
  assert.equal(events.some((ev) => ev.type === 'text' && ev.delta.includes('半部论语')), false, '未核实文本不得泄漏');
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.equal(lane.discards, 1);
  assert.equal(lane.speaks.length, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  assert.ok(logs.some((line) => line.includes('守卫轮前台未调工具，拦截未核实音频并转交后台')));
  await settle();

  assert.equal(dsh.calls.length, 1);
  const call = must(dsh.calls[0], '专名守卫');
  assert.equal(call.text, '你知道班公秘吗？');
  const note = call.note ?? '';
  assert.ok(note.includes('[原意: 纠正后的用户原话]'));
  assert.equal(note.includes('【听岔复核提示】'), false, '不再走事后听岔复核');

  dsh.release();
  await settle();
  assert.equal(reports.length, 1);
  assert.equal(must(reports[0], '汇报').source, 'early_rule');
  assert.equal(must(reports[0], '汇报').query, '你知道班公秘吗？');
  assert.deepEqual(voice.texts, []);
});

test('直答轮放完后不再事后补派后台，保证前台直答与后台任务严格互斥', async () => {
  const dsh = fakeDsh({ text: '不该派', speech: '不该派' });
  const voice = scriptedTts();
  const spoken = Buffer.from([5, 5, 5, 5]);
  const lane = fakeLane({
    answer: () => audioAnswer([spoken], '《星球大战》我觉得老三部曲最经典。'),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(
    turnOf('你看过星球大战没？', { no: 1 }),
    new AbortController().signal,
  ));

  assert.deepEqual(audioOf(events), [spoken]);
  assert.equal(doneOf(events).speech, '《星球大战》我觉得老三部曲最经典。');
  assert.equal(lane.discards, 0);
  await settle();
  assert.equal(dsh.calls.length, 0);
  assert.deepEqual(voice.texts, []);
});

test('播报完成后单槽改为已口头告知，全程不堆积旁注也不调外部 TTS', async () => {
  const dsh = fakeDsh({ text: '明天晴', speech: '明天晴' });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([PCM], '我去查。', {
          delegate: { reason: 'delegate', text: '明天的天气' },
          callId: 'call_w',
        });
      }
      return audioAnswer([PCM], '在的。');
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  await collect(host.toEngine().respond(
    turnOf('查一下天气', { no: 1 }),
    new AbortController().signal,
  ));
  dsh.release();
  await settle();
  const report = must(reports[0], '天气汇报');
  assert.match(lastSnapshot(lane), /尚未播报给哥/);
  assert.equal(lane.injects.length, 0);

  await collect(host.toEngine().respond(turnOf('在吗', { no: 2 }), new AbortController().signal));
  assert.equal(lane.injects.length, 0, '未播结论只留在单槽里，不得堆成旁注');
  assert.match(lastSnapshot(lane), /尚未播报给哥/);

  const spoken = await host.speakBackgroundReport(
    { speech: report.summary, taskId: report.taskId, query: report.query },
    async () => ({ spokenBytes: 80, interrupted: false, transcript: report.summary }),
  );
  assert.equal(spoken, 'spoken');
  assert.match(lastSnapshot(lane), /已口头告知哥/);
  assert.doesNotMatch(lastSnapshot(lane), /尚未播报给哥/);
  host.noteFallbackAnnounceSpoken(
    { speech: report.summary, taskId: report.taskId, query: report.query },
    false,
  );
  assert.equal(lane.injects.length, 0);

  await collect(host.toEngine().respond(turnOf('再说一遍', { no: 3 }), new AbortController().signal));
  assert.equal(lane.injects.length, 0);
  assert.deepEqual(voice.texts, []);
});

const COVERED_REPORT = '北之战是漫画《大剑》的最终战役，克蕾雅与米里雅率领七剑对抗觉醒者与深渊者，组织真相也随之揭开。';

test('前台 Omni 已读单槽讲完结论后，shouldSkipBackgroundReport 为真且不再二次发声', async () => {
  const dsh = fakeDsh({ text: COVERED_REPORT, speech: COVERED_REPORT });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([PCM], '我查查。', {
          delegate: { reason: 'delegate', text: '北之战' },
          callId: 'call-battle',
        });
      }
      return audioAnswer([PCM], COVERED_REPORT);
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  await collect(host.toEngine().respond(
    turnOf('搜一下北之战', { no: 1 }),
    new AbortController().signal,
  ));
  dsh.release();
  await settle();

  const report = must(reports[0], '后台结论');
  assert.match(lastSnapshot(lane), /尚未播报给哥/);
  assert.equal(host.shouldSkipBackgroundReport({ taskId: report.taskId }), false);
  assert.equal(host.shouldSkipBackgroundReport({ taskId: 'missing' }), false);
  assert.equal(host.shouldSkipBackgroundReport({}), false);

  // 用户问「搜好没？」，Omni 直接读单槽把完整结论讲出来。
  const events = await collect(host.toEngine().respond(
    turnOf('搜好没？', { no: 2 }),
    new AbortController().signal,
  ));
  assert.equal(doneOf(events).speech, COVERED_REPORT);
  assert.match(lastSnapshot(lane), /已口头告知哥/);
  assert.doesNotMatch(lastSnapshot(lane), /尚未播报给哥/);
  assert.equal(host.shouldSkipBackgroundReport({ taskId: report.taskId }), true);

  const speaksBefore = lane.speaks.length;
  let played = 0;
  const outcome = await host.speakBackgroundReport(
    { speech: report.summary, taskId: report.taskId, query: report.query },
    async () => {
      played += 1;
      return { spokenBytes: 0, interrupted: false, transcript: '' };
    },
  );
  assert.equal(outcome, 'spoken', '已代播的条目按已说出口返回，不能再排回队首');
  assert.equal(played, 0, '0 字节：playAudio 一次都不调');
  assert.equal(lane.speaks.length, speaksBefore, '不再向 Omni 排队第二条播报');
  assert.deepEqual(voice.texts, [], '全程不得调用外部 TTS');
});

test('前台只答敷衍话时，后台任务仍会正常播报', async () => {
  const dsh = fakeDsh({ text: COVERED_REPORT, speech: COVERED_REPORT });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([PCM], '我查查。', {
          delegate: { reason: 'delegate', text: '北之战' },
          callId: 'call-battle-2',
        });
      }
      return audioAnswer([PCM], '还在查，等下。');
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  await collect(host.toEngine().respond(
    turnOf('搜一下北之战', { no: 1 }),
    new AbortController().signal,
  ));
  dsh.release();
  await settle();
  const report = must(reports[0], '后台结论');

  await collect(host.toEngine().respond(
    turnOf('搜好没？', { no: 2 }),
    new AbortController().signal,
  ));
  assert.match(lastSnapshot(lane), /尚未播报给哥/);
  assert.equal(host.shouldSkipBackgroundReport({ taskId: report.taskId }), false);

  const outcome = await host.speakBackgroundReport(
    { speech: report.summary, taskId: report.taskId, query: report.query },
    async () => ({ spokenBytes: 80, interrupted: false, transcript: report.summary }),
  );
  assert.equal(outcome, 'spoken');
  assert.equal(lane.speaks.length, 1, '没被前台讲过，空窗要正常播报');
  assert.match(lastSnapshot(lane), /已口头告知哥/);
});

const NV_REPORT = '英伟达最近的三件事。第一，第三季度财报显示数据中心收入同比增长百分之九十四，毛利率维持在七成以上。'
  + '第二，对华出口管制再次收紧，部分高端芯片的交付许可被推迟，公司正在申请新的豁免，并强调会遵守所有适用法规。'
  + '第三，11月12日黄仁勋辞去CEO职务，11月23日复职，期间由临时管理委员会代行职责，管理层剧变引发市场关注。'
  + '补充：公司同时披露了供应链、产能与回购计划的更多细节，具体数据以公司公告为准。';

test('decideLiveTurn 放行已核实实体追问，显式细查仍进守卫轮', () => {
  const base: LiveTurnFacts = {
    text: '你好呀',
    hasImage: false,
    cancelActive: false,
    photoHandOff: false,
    laneCanAnswer: true,
    willServe: true,
    canTryText: true,
  };
  assert.equal(decideLiveTurn({ ...base, text: '黄仁勋离职是怎么回事？' }), 'live_with_bg_guard');
  assert.equal(decideLiveTurn({ ...base, text: '管理层剧变是什么东西？' }), 'live_with_bg_guard');
  assert.equal(decideLiveTurn({
    ...base,
    text: '黄仁勋离职是怎么回事？',
    entityAlreadyVerified: true,
  }), 'live_direct');
  assert.equal(decideLiveTurn({
    ...base,
    text: '去细查一下黄仁勋辞职的原因',
    entityAlreadyVerified: true,
  }), 'live_with_bg_guard');
});

test('冷启动的实体事件问句进守卫轮，编造的「没离职」一字节不外放', async () => {
  const dsh = fakeDsh({ text: '查到了', speech: '查到了' });
  dsh.hold();
  const voice = scriptedTts();
  const leaked = Buffer.from([7, 6, 5, 4]);
  const lane = fakeLane({
    answer: () => audioAnswer([leaked], '黄仁勋没离职，那是谣言。'),
  });
  const host = orch(dsh.agent, voice.tts, lane);

  const events = await collect(host.toEngine().respond(
    turnOf('黄仁勋离职是怎么回事？', { no: 1 }),
    new AbortController().signal,
  ));

  assert.equal(events.some((ev) => ev.type === 'audio' && ev.pcm.equals(leaked)), false);
  assert.equal(events.some((ev) => ev.type === 'text' && ev.delta.includes('没离职')), false);
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.equal(lane.discards, 1);
  assert.equal(lane.speaks[0]?.kind, 'ack');
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '守卫派单').text, '黄仁勋离职是怎么回事？');
  dsh.release();
  await settle();
});

test('已核实的追问直接 live_direct，Omni 读全量单槽作答，不再重复派 dsh', async () => {
  const dsh = fakeDsh({ text: NV_REPORT, speech: NV_REPORT });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([PCM], '我查查。', {
          delegate: { reason: 'delegate', text: '英伟达最近新闻' },
          callId: 'call-nv',
        });
      }
      return audioAnswer([PCM], '他11月12日辞去CEO，11月23日就复职了。');
    },
  });
  const reports: BackgroundTaskReport[] = [];
  const host = orch(dsh.agent, voice.tts, lane);
  host.setTaskReporter((report) => {
    reports.push(report);
  });

  await collect(host.toEngine().respond(
    turnOf('查一下英伟达最近的新闻', { no: 1 }),
    new AbortController().signal,
  ));
  dsh.release();
  await settle();
  const report = must(reports[0], '长报告');
  assert.equal(report.summary.length, 160, '播报摘要仍然是 160 字');
  assert.match(report.verbatim ?? '', /11月12日黄仁勋辞去CEO职务/);
  assert.match(lastSnapshot(lane), /管理层剧变/);
  assert.match(lastSnapshot(lane), /11月23日复职/);

  const before = dsh.calls.length;
  const events = await collect(host.toEngine().respond(
    turnOf('黄仁勋离职是怎么回事？', { no: 2 }),
    new AbortController().signal,
  ));
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).speech, '他11月12日辞去CEO，11月23日就复职了。');
  assert.equal(lane.claims, 2, '第二轮由 Omni 自己认领');
  assert.equal(lane.discards, 0, '已核实的追问不再拦截');
  await settle();
  assert.equal(dsh.calls.length, before, '已核实的追问不得再派 dsh');
});

test('已有核实上下文时，显式要求细查仍走守卫轮', async () => {
  const dsh = fakeDsh({ text: NV_REPORT, speech: NV_REPORT });
  dsh.hold();
  const voice = scriptedTts();
  let phase = 0;
  const lane = ssotLane({
    answer: () => {
      phase += 1;
      if (phase === 1) {
        return answerWithIds([PCM], '我查查。', {
          delegate: { reason: 'delegate', text: '英伟达最近新闻' },
          callId: 'call-nv-2',
        });
      }
      return audioAnswer([PCM], '他11月12日辞去CEO，11月23日就复职了。');
    },
  });
  const host = orch(dsh.agent, voice.tts, lane);

  await collect(host.toEngine().respond(
    turnOf('查一下英伟达最近的新闻', { no: 1 }),
    new AbortController().signal,
  ));
  dsh.release();
  await settle();
  assert.match(lastSnapshot(lane), /11月12日黄仁勋辞去CEO职务/);

  const before = dsh.calls.length;
  dsh.hold();
  const events = await collect(host.toEngine().respond(
    turnOf('去细查一下黄仁勋辞职的原因', { no: 2 }),
    new AbortController().signal,
  ));
  assert.deepEqual(audioOf(events), [PCM]);
  assert.equal(doneOf(events).speech, '好，我查查。');
  assert.equal(lane.discards, 1, '显式细查仍要拦下未核实的直答');
  await settle();
  assert.equal(dsh.calls.length, before + 1);
  assert.equal(must(dsh.calls[before], '细查').text, '去细查一下黄仁勋辞职的原因');
  dsh.release();
  await settle();
});
