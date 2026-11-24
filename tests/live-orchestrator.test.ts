/**
 * Pure Live 编排：omni 是唯一前台，dsh 只在后台跑，插话不取消已答应的任务。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AudioFrame, EngineEvent, TurnInput } from '../src/engine-contract.ts';
import type { LiveAudioLane } from '../src/engines/live-voice-engine.ts';
import { LiveOrchestrator, type LiveOrchestratorOptions } from '../src/pipelines/live-orchestrator.ts';
import { LIVE_BACKEND_TASK_DIRECTIVE, buildLiveReportPrompt } from '../src/persona.ts';
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
  readonly speakResult?: AgentAudioAnswer | null;
  /** 每次 `claim()` 新造一份，避免上一次的音频流被读完后第二次认领变成零字节。 */
  readonly answer?: () => AgentAudioAnswer | null;
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
  injects: Array<{ user: string; said: string; kind: InjectKind | undefined }>;
  speaks: Array<{ prompt: string; taskId?: string; query?: string }>;
  backgroundCancels: number;
  healthy: boolean;
  backgroundOk: boolean;
} {
  const feeds: Array<{ pcm: Buffer; voiced: boolean | undefined }> = [];
  const injects: Array<{ user: string; said: string; kind: InjectKind | undefined }> = [];
  const speaks: Array<{ prompt: string; taskId?: string; query?: string }> = [];
  const lane = {
    feeds,
    discards: 0,
    interrupts: 0,
    claims: 0,
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
  assert.equal(call.text, '明天的天气\n用户原话：「你好」');
  assert.equal(call.turn, undefined);
  assert.ok(call.note?.includes(LIVE_BACKEND_TASK_DIRECTIVE));
  assert.ok(call.note?.includes('记得和「明天的天气\n用户原话：「你好」」有关的事'));
  assert.ok(call.note?.includes('设备在线'));

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

test('omni tool_call 零音频时用 TTS 补「我查查。」', async () => {
  const dsh = fakeDsh();
  dsh.hold();
  const voice = scriptedTts();
  const lane = fakeLane({
    answer: () => audioAnswer([], '', { reason: 'delegate', text: null }),
  });
  const host = orch(dsh.agent, voice.tts, lane);
  const events = await collect(host.toEngine().respond(turnOf('帮我查天气'), new AbortController().signal));

  assert.deepEqual(voice.texts, ['我查查。']);
  assert.deepEqual(audioOf(events), [TTS_PCM]);
  const audio = events.find((event) => event.type === 'audio');
  assert.ok(audio !== undefined && audio.type === 'audio');
  assert.equal(audio.sampleRate, 16_000);
  const handed = metas(events).find((meta) => meta.nonBlocking === true);
  assert.equal(handed?.delegate, 'delegate');
  assert.equal(dsh.calls.length, 1);
  assert.equal(must(dsh.calls[0], '查询').text, '帮我查天气');
  assert.equal(doneOf(events).fullText, '');
  dsh.release();
  await settle();
});

test('同一轮 early_rule 和 tool_call 只打一次 dsh', async () => {
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
  assert.equal(must(dsh.calls[0], '唯一一次').text, '查一下天气');
  assert.ok(must(dsh.calls[0], '注记').note?.includes('原注'));
  await settle();
  assert.equal(dsh.calls.length, 1);

  dsh.release();
  await settle();
  assert.equal(dsh.calls.length, 1);
  assert.equal(reports.length, 1);
  assert.equal(must(reports[0], '汇报').source, 'early_rule');
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
  assert.deepEqual(voice.texts, ['好，不查了。']);
  assert.deepEqual(audioOf(cancelEvents), [TTS_PCM]);
  assert.deepEqual(metas(cancelEvents), [{ type: 'meta', path: 'omni' }]);
  assert.equal(doneOf(cancelEvents).speech, '好，不查了。');

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

  assert.equal(await host.speakBackgroundReport(
    { speech: '逐字', verbatim: true, taskId: 'v' },
    async () => ({ spokenBytes: 10, interrupted: false, transcript: '' }),
  ), 'fallback');
  assert.equal(lane.speaks.length, 0);

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

  const dropped = await host.speakBackgroundReport(
    { speech: '没声', taskId: 'task-drop', query: '电量' },
    async () => ({ spokenBytes: 0, interrupted: false, transcript: '' }),
  );
  assert.equal(dropped, 'fallback');
  host.noteFallbackAnnounceSpoken({ speech: '没声', taskId: 'task-drop', query: '电量' }, false);
  assert.equal(lane.injects.length, 0, '已经标过注入的，TTS 兜底不再注第二遍');

  const pushed = dsh.announcer();
  assert.ok(pushed !== null);
  pushed('跑完了');
  await settle();
  assert.equal(reports.length, 1);
  const pending = must(reports[0], '待说的汇报');

  const next = await collect(host.toEngine().respond(turnOf('跑完没'), new AbortController().signal));
  assert.equal(doneOf(next).fullText, '嗯，在的。');
  assert.equal(lane.injects.length, 1);
  assert.deepEqual(lane.injects[0], {
    user: pending.query,
    said: pending.summary,
    kind: 'unspoken',
  });

  await collect(host.toEngine().respond(turnOf('再说一遍'), new AbortController().signal));
  assert.equal(lane.injects.length, 1, '同一个 taskId 只按 unspoken 回注一次');

  host.noteFallbackAnnounceSpoken({ speech: '另一件', query: '日程' }, false);
  assert.equal(lane.injects.length, 2);
  assert.equal(lane.injects[1]?.kind, 'spoken');
  assert.equal(lane.injects[1]?.user, '日程');
  host.noteFallbackAnnounceSpoken({ speech: '被打断', query: '日程', taskId: 'cut' }, true);
  assert.equal(lane.injects.length, 2);

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
  assert.deepEqual(voice.texts, ['我看看。']);
  assert.deepEqual(metas(events), [{
    type: 'meta',
    path: 'omni',
    delegate: 'task',
    nonBlocking: true,
  }]);
  assert.equal(doneOf(events).speech, '我看看。');
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
  assert.equal(doneOf(still).speech, '我看看。');
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
  assert.equal(voice.texts.at(-1), '同步看见一只猫');
  const sync = must(dsh.calls[2], '同步识图');
  assert.equal(sync.note, '刚拍的');
  assert.deepEqual(sync.turn, { ticket: { no: 2, gen: 1 } });
  assert.equal(host.lastLedgerLane(), null);

  const down = orch(dsh.agent, voice.tts, null);
  const fallen = await collect(down.toEngine().respond(
    turnOf('在吗'),
    new AbortController().signal,
  ));
  assert.deepEqual(metas(fallen), [{ type: 'meta', path: 'dsh' }]);
  assert.equal(doneOf(fallen).speech, '同步看见一只猫');
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
