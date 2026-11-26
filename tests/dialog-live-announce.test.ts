/**
 * Pure Live 后台播报：`speakAnnounce` 的三条出口，以及插话 / 双击把自定义口和
 * 逐字 TTS 一起掐掉。
 *
 * 时间全走 {@link VirtualClock}。`ANNOUNCE_QUIET_MS`（800）是 `src/app/dialog.ts`
 * 里那把安静尺子；这里提前到同一时刻，不睡墙钟。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnnounceItem } from '../src/app/dialog.ts';
import { DialogRuntime } from '../src/app/dialog.ts';
import type { DeviceCall, DeviceCapabilities } from '../src/devices/primitives.ts';
import type { FastVoiceEngine } from '../src/engine-contract.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';
import type { AgentProvider, AgentReplyView, TtsProvider } from '../src/providers.ts';
import type { DownlinkSink } from '../src/transport.ts';

/** 与 `src/app/dialog.ts` 的 `ANNOUNCE_QUIET_MS` 相同。 */
const QUIET_MS = 800;

const CAPS = (listenStart: boolean): DeviceCapabilities => ({
  audioIn: 'pcm16',
  capture: {},
  presence: false,
  power: false,
  summon: false,
  listenStart,
  played: false,
  ignorePhrases: [],
});

const DOWNLINK: DownlinkSink = {
  sendAudio: () => {},
  sendControl: () => {},
};

type SpeakOutcome = 'spoken' | 'defer' | 'fallback';

interface RigOptions {
  readonly speak?: (item: AnnounceItem) => Promise<SpeakOutcome>;
  readonly synthesize?: (text: string, emotion?: string) => AsyncIterable<Buffer>;
  readonly reply?: AgentProvider['reply'];
  readonly engine?: FastVoiceEngine;
  readonly drop?: (why: string) => void;
  readonly mic?: boolean;
  /** 替换默认的「立刻开麦」。用来把 partial / dispose 插进 awaitMicOpen 的恢复点。 */
  readonly awaitMicOpen?: () => Promise<boolean>;
  /** 设备有 `detail` 拍照档，用来把 capture 排进串行队列。 */
  readonly captureDetail?: boolean;
  /** Pure Live 下传 `false`，禁止播报退回外部 TTS。 */
  readonly allowTtsFallback?: boolean;
  /** 出队前消重：命中返回 `true` 表示这条已经被前台代播 / 已播报 / 已取消。 */
  readonly shouldSkipAnnounce?: (item: AnnounceItem) => boolean;
}

interface Rig {
  readonly clock: VirtualClock;
  readonly runtime: DialogRuntime;
  readonly speeches: string[];
  readonly items: AnnounceItem[];
  readonly synth: Array<{ readonly text: string; readonly emotion?: string }>;
  readonly announces: Array<{ readonly pending: boolean; readonly spoken: boolean }>;
  readonly logs: string[];
  readonly notes: Array<string | undefined>;
  readonly asked: string[];
  readonly fallbacks: Array<{ readonly item: AnnounceItem; readonly interrupted: boolean }>;
  readonly replies: { n: number };
  readonly counters: { cancels: number };
  readonly deviceCalls: DeviceCall[];
}

function rig(options: RigOptions = {}): Rig {
  const clock = new VirtualClock();
  const speeches: string[] = [];
  const items: AnnounceItem[] = [];
  const synth: Array<{ readonly text: string; readonly emotion?: string }> = [];
  const announces: Array<{ readonly pending: boolean; readonly spoken: boolean }> = [];
  const logs: string[] = [];
  const notes: Array<string | undefined> = [];
  const asked: string[] = [];
  const fallbacks: Array<{ readonly item: AnnounceItem; readonly interrupted: boolean }> = [];
  const replies = { n: 0 };
  const counters = { cancels: 0 };
  const deviceCalls: DeviceCall[] = [];

  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async *synthesize(text: string, emotion?: string): AsyncGenerator<Buffer> {
      synth.push({ text, ...(emotion === undefined ? {} : { emotion }) });
      const extra = options.synthesize;
      if (extra !== undefined) {
        yield* extra(text, emotion);
      }
    },
  };

  const agent: AgentProvider = {
    name: 'fake',
    reply: (text, image, note, context) => {
      replies.n += 1;
      notes.push(note);
      asked.push(text);
      if (options.reply !== undefined) {
        return options.reply(text, image, note, context);
      }
      return Promise.resolve({ text: '好', speech: '好' });
    },
    ...(options.drop === undefined ? {} : { dropPrefetch: options.drop }),
  };

  const caps = CAPS(options.mic === true);
  const runtime = new DialogRuntime({
    clock,
    caps: options.captureDetail === true
      ? { ...caps, capture: { detail: { needsUser: false } } }
      : caps,
    agent,
    tts,
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    downlink: DOWNLINK,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    speakAnnounce: async (item) => {
      items.push(item);
      speeches.push(item.speech);
      if (options.speak !== undefined) {
        return options.speak(item);
      }
      return 'spoken';
    },
    cancelAnnounce: () => { counters.cancels += 1; },
    onFallbackAnnounceSpoken: (item, interrupted) => {
      fallbacks.push({ item, interrupted });
    },
    ...(options.allowTtsFallback === undefined ? {} : { allowTtsFallback: options.allowTtsFallback }),
    ...(options.shouldSkipAnnounce === undefined
      ? {}
      : { shouldSkipAnnounce: options.shouldSkipAnnounce }),
    env: {
      call: (call) => {
        deviceCalls.push(call);
        return true;
      },
      assemble: () => {},
      end: () => {},
      onAnnounce: (pending, spoken) => { announces.push({ pending, spoken }); },
      ...(options.mic === true
        ? {
          announceMic: {
            listenStart: true,
            micOpenTimeoutMs: 1_500,
            listenMs: 3_000,
            call: (call: DeviceCall) => { deviceCalls.push(call); },
            awaitMicOpen: options.awaitMicOpen ?? (async () => true),
          },
        }
        : {}),
    },
    log: (line) => { logs.push(line); },
  });

  return {
    clock, runtime, speeches, items, synth, announces, logs, notes, asked, fallbacks, replies, counters,
    deviceCalls,
  };
}

/** 测试里把一次 await 停住。闭包赋值不进 CFA，所以 resolve 的类型保持可调用。 */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error('deferred 尚未挂上'); };
  const promise = new Promise<T>((res) => { resolve = res; });
  return {
    promise,
    resolve: (value) => { resolve(value); },
  };
}

/** 一块极短的 PCM：`speakCanned` 记得出过声，播放等待只占一个 100 ms 轮询。 */
async function* oneChunk(): AsyncGenerator<Buffer> {
  yield Buffer.alloc(2, 1);
}

test('speakAnnounce 返回 spoken：走自定义口，不调用 TTS，结束时 onAnnounce(false, true)', async () => {
  const item: AnnounceItem = {
    speech: '订票好了',
    emotion: 'happy',
    taskId: 'book',
    query: '帮我订票',
  };
  const r = rig();
  try {
    r.runtime.enqueueAnnounce(item);
    await r.clock.drain();

    assert.equal(r.items.length, 1);
    assert.equal(r.items[0], item);
    assert.equal(r.synth.length, 0, 'spoken 不得再走 TTS');
    assert.deepEqual(r.announces.at(-1), { pending: false, spoken: true });
  } finally {
    r.runtime.dispose();
  }
});

test('speakAnnounce 先 defer 再 spoken：条目留在队首，空窗后重试，defer 时不算出过声', async () => {
  await assertDefer(false);
});

test('开麦分支上 defer 同样排回队首，空窗后按原顺序重试', async () => {
  await assertDefer(true);
});

async function assertDefer(mic: boolean): Promise<void> {
  let n = 0;
  const r = rig({
    mic,
    speak: async () => {
      n += 1;
      return n === 1 ? 'defer' : 'spoken';
    },
  });
  try {
    r.runtime.enqueueAnnounce('第一条');
    r.runtime.enqueueAnnounce('第二条');
    await r.clock.drain();

    assert.deepEqual(r.speeches, ['第一条'], 'defer 必须停住循环，不能接着念下一条');
    assert.equal(r.synth.length, 0);
    assert.ok(
      r.announces.every((event) => event.spoken === false),
      `defer 时 spokeAny 必须是 false，实际 ${JSON.stringify(r.announces)}`,
    );
    assert.ok(
      r.logs.some((line) => line.includes('前台车道正忙')),
      `应记下排回队首，实际 ${JSON.stringify(r.logs)}`,
    );

    await r.clock.runUntil(r.clock.now() + QUIET_MS);

    assert.deepEqual(
      r.speeches,
      ['第一条', '第一条', '第二条'],
      '被推迟的那条要留在队首，空窗后先重试它，再念后到的',
    );
    assert.equal(r.synth.length, 0);
    assert.deepEqual(r.announces.at(-1), { pending: false, spoken: true });
  } finally {
    r.runtime.dispose();
  }
}

test('verbatim 绕过 speakAnnounce，走 TTS，并通知 onFallbackAnnounceSpoken(item, false)', async () => {
  const item: AnnounceItem = {
    speech: '端口是 8080。',
    verbatim: true,
    emotion: 'calm',
    taskId: 'port',
  };
  const r = rig({ synthesize: oneChunk });
  try {
    r.runtime.enqueueAnnounce(item);
    await r.clock.drain();
    await r.clock.runUntil(r.clock.now() + 200);

    assert.equal(r.speeches.length, 0, 'verbatim 不得交给 speakAnnounce');
    assert.equal(r.synth.length, 1);
    assert.equal(r.synth[0]?.text, item.speech);
    assert.equal(r.synth[0]?.emotion, 'calm');
    assert.equal(r.fallbacks.length, 1);
    assert.equal(r.fallbacks[0]?.item, item);
    assert.equal(r.fallbacks[0]?.interrupted, false);
    assert.deepEqual(r.announces.at(-1), { pending: false, spoken: true });
  } finally {
    r.runtime.dispose();
  }
});

test('speakAnnounce 返回 fallback：退回 TTS，并通知 onFallbackAnnounceSpoken(item, false)', async () => {
  const item: AnnounceItem = {
    speech: '后台结论是三张票。',
    taskId: 'tickets',
    emotion: 'happy',
  };
  const r = rig({
    speak: async () => 'fallback',
    synthesize: oneChunk,
  });
  try {
    r.runtime.enqueueAnnounce(item);
    await r.clock.drain();
    await r.clock.runUntil(r.clock.now() + 200);

    assert.deepEqual(r.speeches, [item.speech]);
    assert.equal(r.items[0], item);
    assert.equal(r.synth.length, 1);
    assert.equal(r.synth[0]?.text, item.speech);
    assert.equal(r.synth[0]?.emotion, 'happy');
    assert.equal(r.fallbacks.length, 1);
    assert.equal(r.fallbacks[0]?.item, item);
    assert.equal(r.fallbacks[0]?.interrupted, false);
  } finally {
    r.runtime.dispose();
  }
});

test('speakAnnounce 进行中被 partial 插话：立刻 cancelAnnounce，第二条等到这轮结束', async () => {
  let releaseSpeak: (outcome: SpeakOutcome) => void = () => {};
  const speakGate = new Promise<SpeakOutcome>((resolve) => {
    releaseSpeak = resolve;
  });
  let releaseReply: (view: AgentReplyView) => void = () => {};
  const replyGate = new Promise<AgentReplyView>((resolve) => {
    releaseReply = resolve;
  });
  let n = 0;
  const r = rig({
    speak: async () => {
      n += 1;
      if (n === 1) {
        return speakGate;
      }
      return 'spoken';
    },
    reply: () => replyGate,
  });
  try {
    r.runtime.enqueueAnnounce('第一条汇报');
    r.runtime.enqueueAnnounce('第二条汇报');
    await r.clock.drain();
    assert.deepEqual(r.speeches, ['第一条汇报']);

    r.runtime.dispatch({ type: 'partial', text: '等一下' });
    assert.equal(r.counters.cancels, 1, 'partial 必须在 speakAnnounce 还挂着的时候就掐自定义口');

    r.runtime.dispatch({ type: 'utterance', text: '我想问别的' });
    await r.clock.drain();
    assert.equal(r.runtime.core.phase, 'thinking', '用户这轮要占住话筒，播报不能插进来');
    assert.deepEqual(r.speeches, ['第一条汇报']);

    releaseSpeak('spoken');
    await r.clock.drain();
    assert.deepEqual(r.speeches, ['第一条汇报'], '插话之后循环要停，不能接着念第二条');
    assert.deepEqual(r.announces.at(-1), { pending: true, spoken: true });

    await r.clock.runUntil(r.clock.now() + QUIET_MS);
    assert.deepEqual(r.speeches, ['第一条汇报'], '用户这轮还没结束时，空窗重试也不该把第二条放出去');
    assert.equal(r.runtime.core.phase, 'thinking');

    releaseReply({ text: '好', speech: '好' });
    await r.clock.drain();
    assert.equal(r.runtime.core.phase, 'listening');
    assert.deepEqual(r.speeches, ['第一条汇报', '第二条汇报']);
    assert.deepEqual(r.announces.at(-1), { pending: false, spoken: true });
  } finally {
    r.runtime.dispose();
  }
});

test('clearAnnounce 清空队列，同时 cancelAnnounce 与 cancelCanned，并清掉 announceTail', async () => {
  const first: AnnounceItem = {
    speech: '航班是下午三点十五分，座位12A。',
    verbatim: true,
    taskId: 'flight',
  };
  const second = '第二条不要播';
  const r = rig({ synthesize: oneChunk });
  try {
    r.runtime.enqueueAnnounce(first);
    r.runtime.enqueueAnnounce(second);
    await r.clock.drain();
    assert.equal(r.synth.length, 1, '第一条已经交给 TTS，取消才留得下残句');
    assert.equal(r.speeches.length, 0);

    r.runtime.dispatch({ type: 'partial', text: '等一下' });
    assert.ok(
      r.logs.some((line) => line.includes('没念完')),
      `插话时应记下汇报残句，实际 ${JSON.stringify(r.logs)}`,
    );

    let canned = 0;
    const original = r.runtime.runner.cancelCanned.bind(r.runtime.runner);
    r.runtime.runner.cancelCanned = (): void => {
      canned += 1;
      original();
    };
    const cancelsBefore = r.counters.cancels;
    r.runtime.clearAnnounce();
    assert.equal(canned, 1, '双击要掐 TTS 旁白');
    assert.equal(r.counters.cancels, cancelsBefore + 1, '双击要掐自定义后台口');

    await r.clock.runUntil(r.clock.now() + 2_000);
    r.runtime.dispatch({ type: 'utterance', text: '结果呢' });
    await r.clock.runUntil(r.clock.now() + 2_000);

    assert.equal(r.notes.length, 1, '下一轮要真的开起来，否则残句断言是空的');
    assert.equal(r.asked[0], '结果呢');
    assert.equal(
      r.notes[0],
      undefined,
      'clearAnnounce 应把 announceTail 清掉，下一轮不该再带「只念了一半」',
    );
    assert.equal(
      r.speeches.includes(second),
      false,
      '队列里的第二条必须被清掉',
    );
    assert.equal(
      r.synth.some((chunk) => chunk.text === second),
      false,
      '被清掉的第二条不得再走 TTS',
    );
  } finally {
    r.runtime.dispose();
  }
});

test('有引擎时 abortEngine 只调用 abortSpeculation；没有引擎时仍落到 dropPrefetch', async () => {
  const aborts: string[] = [];
  const drops: string[] = [];
  let respond = 0;
  const engine: FastVoiceEngine = {
    mode: 'cascade',
    isHealthy: () => true,
    abortSpeculation: (reason) => { aborts.push(reason); },
    async *respond() { respond += 1; },
  };
  const wired = rig({
    engine,
    drop: (why) => { drops.push(why); },
  });
  const bareDrops: string[] = [];
  const bare = rig({
    drop: (why) => { bareDrops.push(why); },
  });
  try {
    wired.runtime.dispatch({ type: 'utterance', text: '你好' });
    await wired.clock.drain();
    assert.equal(respond, 1, '注入的引擎要进 TurnRunner，轮次不能再绕回 agent.reply');
    assert.equal(wired.replies.n, 0);
    assert.deepEqual(drops, []);

    const ports = wired.runtime.core.runtime.ports;
    assert.ok(ports !== null);
    ports.abortEngine('barge_in');
    assert.deepEqual(aborts, ['barge_in']);
    assert.deepEqual(drops, [], 'cascade 的 abortSpeculation 自己会转 dropPrefetch，这里不能再打一遍');

    const barePorts = bare.runtime.core.runtime.ports;
    assert.ok(barePorts !== null);
    barePorts.abortEngine('barge_in');
    assert.deepEqual(bareDrops, ['内核中止(barge_in)']);
  } finally {
    wired.runtime.dispose();
    bare.runtime.dispose();
  }
});

test('dispose 会掐掉正在念的旁白', () => {
  const r = rig();
  let calls = 0;
  const original = r.runtime.runner.cancelCanned.bind(r.runtime.runner);
  r.runtime.runner.cancelCanned = (): void => {
    calls += 1;
    original();
  };
  r.runtime.dispose();
  assert.equal(calls, 1);
  r.runtime.dispose();
  assert.equal(calls, 1, '重复 dispose 不再掐一次');
});

test('dispose 或 closed 之后，排队的轮次不再开跑', async () => {
  const replyGate = deferred<AgentReplyView>();
  const r = rig({
    reply: () => replyGate.promise,
  });
  try {
    r.runtime.dispatch({ type: 'utterance', text: '第一句' });
    await r.clock.drain();
    assert.equal(r.replies.n, 1);
    r.runtime.dispatch({ type: 'utterance', text: '第二句' });
    r.runtime.dispose();
    replyGate.resolve({ text: '好', speech: '好' });
    await r.clock.drain();
    assert.equal(r.replies.n, 1, '连接已经 dispose，排队的下一轮不该再问模型');
  } finally {
    r.runtime.dispose();
  }
});

test('closed 之后排队的拍照不再下发', async () => {
  const replyGate = deferred<AgentReplyView>();
  const r = rig({
    captureDetail: true,
    reply: () => replyGate.promise,
  });
  try {
    r.runtime.dispatch({ type: 'utterance', text: '你好' });
    r.runtime.dispatch({ type: 'utterance', text: '看清这个标签' });
    await r.clock.drain();
    assert.equal(r.replies.n, 1);
    r.runtime.core.fsm.close();
    replyGate.resolve({ text: '好', speech: '好' });
    await r.clock.drain();
    await r.clock.runUntil(r.clock.now() + 500);
    assert.equal(r.replies.n, 1);
    assert.equal(
      r.logs.some((line) => line.includes('已下发')),
      false,
      `关闭后不该再武装拍照，实际 ${JSON.stringify(r.logs)}`,
    );
    assert.equal(r.clock.pending, 0, '拍照兜底定时器不该再挂着');
  } finally {
    r.runtime.dispose();
  }
});

test('awaitMicOpen 恢复后：连接已 dispose 就不念', async () => {
  const micGate = deferred<boolean>();
  const r = rig({
    mic: true,
    synthesize: oneChunk,
    awaitMicOpen: () => micGate.promise,
  });
  try {
    r.runtime.enqueueAnnounce('汇报一句');
    await r.clock.drain();
    r.runtime.dispose();
    micGate.resolve(true);
    await r.clock.drain();
    assert.equal(r.speeches.length, 0);
    assert.equal(r.synth.length, 0);
  } finally {
    r.runtime.dispose();
  }
});

test('awaitMicOpen 恢复后：相位已离开 listening 就不念', async () => {
  const micGate = deferred<boolean>();
  const r = rig({
    mic: true,
    synthesize: oneChunk,
    awaitMicOpen: () => micGate.promise,
  });
  try {
    r.runtime.enqueueAnnounce('汇报一句');
    await r.clock.drain();
    assert.ok(r.runtime.core.fsm.beginTurn());
    micGate.resolve(true);
    await r.clock.drain();
    assert.equal(r.speeches.length, 0);
    assert.equal(r.synth.length, 0);
    assert.equal(r.runtime.core.fsm.state, 'thinking');
  } finally {
    r.runtime.dispose();
  }
});

test('awaitMicOpen 恢复后：已经 dispose 就不念', async () => {
  const micGate = deferred<boolean>();
  const r = rig({
    mic: true,
    synthesize: oneChunk,
    awaitMicOpen: () => micGate.promise,
  });
  try {
    r.runtime.enqueueAnnounce('汇报一句');
    await r.clock.drain();
    r.runtime.dispose();
    micGate.resolve(true);
    await r.clock.drain();
    assert.equal(r.speeches.length, 0);
    assert.equal(r.synth.length, 0);
  } finally {
    r.runtime.dispose();
  }
});

test('Pure Live（allowTtsFallback=false）：verbatim 仍走 speakAnnounce，fallback 也绝不调外部 TTS', async () => {
  const verbatimItem: AnnounceItem = {
    speech: '端口是 8080，路径是 C:\\tmp\\app.ts',
    verbatim: true,
    emotion: 'calm',
    taskId: 'live-v',
  };
  const r1 = rig({ allowTtsFallback: false, synthesize: oneChunk });
  try {
    r1.runtime.enqueueAnnounce(verbatimItem);
    await r1.clock.drain();
    assert.deepEqual(r1.speeches, [verbatimItem.speech], 'verbatim 必须仍交给 omni speakAnnounce');
    assert.equal(r1.synth.length, 0, 'Pure Live 不得调用外部 TTS');
  } finally {
    r1.runtime.dispose();
  }

  const r2 = rig({ allowTtsFallback: false, speak: async () => 'fallback', synthesize: oneChunk });
  try {
    r2.runtime.enqueueAnnounce({ speech: '断线结果', taskId: 'live-fb' });
    await r2.clock.drain();
    assert.equal(r2.speeches.length, 1);
    assert.equal(r2.synth.length, 0, 'speakAnnounce 返回 fallback 时也不得调用外部 TTS');
    assert.equal(r2.fallbacks.length, 1);
    assert.equal(r2.fallbacks[0]?.interrupted, true);
  } finally {
    r2.runtime.dispose();
  }
});

test('shouldSkipAnnounce 在通知宠物和开麦之前清掉队首已代播条目', async () => {
  const r = rig({
    mic: true,
    shouldSkipAnnounce: (item) => item.taskId === 'done',
  });
  try {
    r.runtime.enqueueAnnounce({ speech: '前台已经讲过的完整结论', taskId: 'done' });
    await r.clock.drain();

    assert.equal(r.speeches.length, 0, '不得再交给 speakAnnounce');
    assert.equal(r.synth.length, 0, '也不得退回外部 TTS');
    assert.equal(
      r.deviceCalls.some((call) => call.op === 'listen.start'),
      false,
      '队列已空就不能再开麦',
    );
    assert.deepEqual(
      r.announces,
      [{ pending: true, spoken: false }],
      '只保留入队时那一次「有货」通知；排空时不得再通知宠物让位',
    );
    assert.equal(r.runtime.idle, true);
  } finally {
    r.runtime.dispose();
  }
});

test('批内中间条已被前台代播时跳过，前后两条照常播', async () => {
  const r = rig({
    shouldSkipAnnounce: (item) => item.taskId === 'mid',
  });
  try {
    r.runtime.enqueueAnnounce({ speech: '第一条汇报', taskId: 'first' });
    r.runtime.enqueueAnnounce({ speech: '中间这条已经讲过了', taskId: 'mid' });
    r.runtime.enqueueAnnounce({ speech: '第三条汇报', taskId: 'last' });
    await r.clock.drain();

    assert.deepEqual(r.speeches, ['第一条汇报', '第三条汇报']);
    assert.equal(r.synth.length, 0);
    assert.deepEqual(r.announces.at(-1), { pending: false, spoken: true });
  } finally {
    r.runtime.dispose();
  }
});
