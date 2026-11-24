/**
 * 内核意图的**唯一执行路径**（Wave 5C）。
 *
 * 这一组全部按生产装配跑：`DialogRuntime` + `TurnRunner` + `FrontedAgent` +
 * `trackActivity`。它钉的是四件**静默**的事 —— 出错的现场都只是「多播了一遍」
 * 或「少走了一段」，日志里不报错：
 *
 * 1. **Item A：单次执行**。`speaking` 期间用户开口，`audio.stop` / `cancelTurn` /
 *    `dropPrefetch` / `settleTurn` 各只能发生一次。以前 `DialogRuntime` 没绑端口，
 *    内核声明的意图一个都没执行 —— 表现是「插话不断音、dsh 白跑」。
 * 2. **反证**：把端口摘掉（`attachPorts(null)`）之后同一条插话**一个 `audio.stop`
 *    都不发**。这证明它唯一的执行者就是内核的 `stopDeviceAudio` 意图，
 *    而不是某个 `SessionCore` 里的第二套路径。
 * 3. **Item B：因果屏障只有一道**。开轮前录进 ASR 的旧段（`commitSeq <=
 *    baseCommitSeq`）既不停音频、也不取消上游、也不进攒句；开轮后的新话才构成插话。
 * 4. **账本合一**。结算（`truncated`）写回 `FrontedAgent` 的账本；重连时新的
 *    `DialogRuntime` 从同一份账本播种 `ledger.lastLane`，不会忘记上一轮是谁答的。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SystemClock } from '../src/app/clock.ts';
import { DialogRuntime } from '../src/app/dialog.ts';
import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import type { DialogFsmContext } from '../src/dialog-fsm.ts';
import type { FastVoiceEngine } from '../src/engine-contract.ts';
import type { LiveAudioLane } from '../src/engines/live-voice-engine.ts';
import { FrontedAgent } from '../src/fronted-agent.ts';
import { newActivityState, trackActivity } from '../src/keepalive.ts';
import { isPreTurnCommit } from '../src/kernel.ts';
import { CascadeAgent } from '../src/pipelines/cascade-agent.ts';
import { LiveOrchestrator } from '../src/pipelines/live-orchestrator.ts';
import type {
  AgentAudioAnswer,
  AgentProvider,
  AgentReplyView,
  DelegateReason,
  TtsProvider,
} from '../src/providers.ts';
import type { DownlinkSink } from '../src/transport.ts';

/** v1 设备：没有 `played`，播放等待走估算（测试不想等 3 s 余量） */
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

/**
 * 0.6 s 的音频（24 kHz / 16 bit）。
 *
 * 长度不是随便取的：`truncated` 的容差是 300 ms（`TRUNCATED_EPSILON_MS`），
 * 0.6 s 在开头就被打断才判得出「用户少听了一段」；同时它短到播放等待只占几百毫秒，
 * 测试不用真等一条完整回答。
 */
const PCM = Buffer.alloc(28_800, 1);

const TTS: TtsProvider = {
  name: 'fake',
  sampleRate: 24_000,
  // 不给 `synthesizeStream`：走 `pump` 分支（整段合成），时序最好预测
  async* synthesize() { yield PCM; },
};

const DOWNLINK: DownlinkSink = { sendAudio: () => {}, sendControl: () => {} };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** 轮询到条件成立；超时返回 false，让断言给出「根本没发生过」而不是挂住。 */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await sleep(5);
  }
  return check();
}

interface Wiring {
  /** 交给 `DialogRuntime` 的那一份（`trackActivity(FrontedAgent(...))`） */
  readonly agent: AgentProvider;
  /** 内层那一份：账本、`dropPrefetch` 都看它 */
  readonly fronted: FrontedAgent;
  /** 内层 dsh 收到的取消（带票据） */
  readonly cancels: Array<{ readonly no: number; readonly gen: number } | undefined>;
  /** `dropPrefetch` 收到的理由 */
  readonly drops: string[];
}

/** 生产的两层包装：`trackActivity` 外面包 `FrontedAgent`（`apiKey: ''` = 直接交给 dsh）。 */
function productionAgent(): Wiring {
  const cancels: Array<{ readonly no: number; readonly gen: number } | undefined> = [];
  const drops: string[] = [];
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => {
      await sleep(20);
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    cancelTurn: (ticket) => { cancels.push(ticket); },
  };
  const fronted = new FrontedAgent({ inner, apiKey: '', log: () => {} });
  // 探针：`dropPrefetch` 是 `abortEngine` 端口的落点，包一层只为数调用次数
  const original = fronted.dropPrefetch.bind(fronted);
  fronted.dropPrefetch = (why: string): void => {
    drops.push(why);
    original(why);
  };
  const agent = trackActivity(fronted, newActivityState(Date.now()));
  return { agent, fronted, cancels, drops };
}

interface Rig {
  readonly runtime: DialogRuntime;
  /** 下发的设备操作（`op`） */
  readonly calls: string[];
  readonly logs: string[];
  /** `assemble` 被叫过几次（开轮前旧段一次都不该叫） */
  readonly assembles: () => number;
}

function makeRuntime(
  wiring: Wiring,
  ticketContext?: DialogFsmContext,
): Rig {
  const calls: string[] = [];
  const logs: string[] = [];
  let assembles = 0;
  const runtime = new DialogRuntime({
    clock: new SystemClock(),
    caps: CAPS,
    agent: wiring.agent,
    tts: TTS,
    downlink: DOWNLINK,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    ...(ticketContext === undefined ? {} : { ticketContext }),
    env: {
      call: (call) => {
        calls.push(call.op);
        return true;
      },
      assemble: () => { assembles += 1; },
      end: () => {},
    },
    log: (line) => { logs.push(line); },
  });
  return { runtime, calls, logs, assembles: () => assembles };
}

const stopCount = (rig: Rig): number => rig.calls.filter((op) => op === 'audio.stop').length;

/**
 * 真正的回答音频已经在播了（不是回执那段 `speaking`）。
 *
 * 委派轮会先播一句回执（「我看看。」），它同样进 `speaking`、同样有 0.6 s 音频。
 * 这一组测的是**对着回答插话**，所以必须等到媒体游标真的动过：
 * 否则插话落在回执上，内核会说「一个字都没听到」，`truncated` 判不出来。
 * 回执被回答顶掉的时候本身也会发一次 `audio.stop`，所以下面的断言都按**增量**算。
 */
const answerPlaying = (rig: Rig): boolean =>
  !rig.runtime.core.fsm.speakingIsReceiptOnly
  && rig.runtime.core.runtime.state.playback.sentMediaMs > 0;


// ---------------------------------------------------------------- Item A

test('Item A：插话的意图只执行一次 —— audio.stop / cancelTurn / dropPrefetch / settleTurn', async () => {
  const wiring = productionAgent();
  const rig = makeRuntime(wiring);
  try {
    assert.notEqual(
      rig.runtime.core.runtime.ports,
      null,
      '生产装配必须绑好内核端口（没端口 = 内核意图一个都不执行）',
    );

    rig.runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(await until(() => answerPlaying(rig)), '回答音频要先真的下发（回执那段不算）');

    const ticket = rig.runtime.core.fsm.ticket();
    // 回执被回答顶掉时已发过一次 `audio.stop`，这里只看插话带来的增量
    const stopsBefore = stopCount(rig);
    rig.runtime.dispatch({ type: 'partial', text: '停一下' });

    assert.equal(
      stopCount(rig) - stopsBefore,
      1,
      `插话只能带来一次 audio.stop（多发 = 有第二条执行路径）；实际 ${JSON.stringify(rig.calls)}`,
    );
    assert.equal(wiring.cancels.length, 1, `cancelTurn 只能叫一次；实际 ${JSON.stringify(wiring.cancels)}`);
    assert.deepEqual(
      { no: wiring.cancels[0]?.no, gen: wiring.cancels[0]?.gen },
      { no: ticket.no, gen: ticket.gen },
      '取消必须带这一轮的票据（session 层靠它丢过期的取消）',
    );
    assert.deepEqual(
      wiring.drops,
      ['内核中止(barge_in)'],
      `abortEngine 要真的落到 agent 的 dropPrefetch 上；实际 ${JSON.stringify(wiring.drops)}`,
    );
    // 结算也走端口：内核判「少听了一段」，同一份事实还要写回 agent 的账本
    assert.equal(
      rig.runtime.core.runtime.state.ledger.lastOutcome?.truncated,
      true,
      `内核应当判出少听了；实际 ${JSON.stringify(rig.runtime.core.runtime.state.ledger)}`,
    );
    assert.equal(
      wiring.fronted.ledgerTurns.at(-1)?.truncated,
      true,
      `settleTurn 端口要把结算写回账本；实际 ${JSON.stringify(wiring.fronted.ledgerTurns)}`,
    );

    assert.equal(rig.runtime.core.fsm.state, 'listening', '插话成立 → 回到 listening');
    await until(() => rig.runtime.idle);
  } finally {
    rig.runtime.dispose();
  }
});

test('Item A 反证：摘掉端口之后，同一条插话一个 audio.stop 都不发', async () => {
  const wiring = productionAgent();
  const rig = makeRuntime(wiring);
  try {
    rig.runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(await until(() => answerPlaying(rig)), '回答音频要先真的下发（回执那段不算）');

    // 只留状态推进，没有任何执行者 —— 这就是「内核意图的唯一出口」的对照组
    rig.runtime.core.runtime.attachPorts(null);
    const stopsBefore = stopCount(rig);
    rig.runtime.dispatch({ type: 'partial', text: '停一下' });

    assert.equal(
      stopCount(rig) - stopsBefore,
      0,
      'audio.stop 只由内核的 stopDeviceAudio 意图执行；摘了端口它就不该再出现',
    );
    assert.deepEqual(wiring.cancels, [], '没有端口就没有人取消上游');
    assert.equal(
      rig.runtime.core.fsm.state,
      'listening',
      '相位照样推进（端口只决定要不要执行副作用，不决定判定）',
    );
    await until(() => rig.runtime.idle);
  } finally {
    rig.runtime.dispose();
  }
});

// ---------------------------------------------------------------- Item B

test('Item B：开轮前录的旧段不停音频、不取消上游、不进攒句；开轮后的新话才构成插话', async () => {
  let seq = 5;
  const wiring = productionAgent();
  const rig = makeRuntime(wiring, { baseCommitSeq: () => seq });
  try {
    rig.runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(await until(() => answerPlaying(rig)), '回答音频要先真的下发（回执那段不算）');
    assert.equal(
      rig.runtime.core.fsm.ticket().baseCommitSeq,
      5,
      '票据要锁存开轮瞬间的水位线',
    );

    const stopsBefore = stopCount(rig);

    // 开轮前录的那段迟到转写：中间结果与定稿都只能归档
    const stalePartial = rig.runtime.dispatch({ type: 'partial', text: '旧段', commitSeq: 3 });
    assert.deepEqual(stalePartial, [{ type: 'drop', why: 'pre-turn' }]);
    const staleSentence = rig.runtime.dispatch({ type: 'sentence', text: '旧段', commitSeq: 5 });
    assert.deepEqual(staleSentence, [{ type: 'drop', why: 'pre-turn' }]);

    assert.equal(stopCount(rig), stopsBefore, '旧段不许停音频（否则自己后半句会杀掉自己）');
    assert.deepEqual(wiring.cancels, [], '旧段不许取消上游');
    assert.equal(rig.assembles(), 0, '旧段不许进攒句（否则凭空多出一轮）');
    assert.equal(rig.runtime.core.fsm.state, 'speaking', '旧段不影响相位');

    // 开轮之后才录进 ASR 的一句：这才是插话
    seq = 7;
    assert.deepEqual(rig.runtime.dispatch({ type: 'partial', text: '等等', commitSeq: 7 }), []);
    assert.equal(stopCount(rig) - stopsBefore, 1, `新话要停音频；实际 ${JSON.stringify(rig.calls)}`);
    assert.equal(wiring.cancels.length, 1, '新话要取消上游');
    assert.equal(rig.runtime.core.fsm.state, 'listening');
    assert.ok(rig.logs.some((line) => line.includes('开轮前录的那段定稿')), '旧段被拦下要有痕迹');
    await until(() => rig.runtime.idle);
  } finally {
    rig.runtime.dispose();
  }
});

// ---------------------------------------------------------------- 账本合一

test('账本合一：结算写回 FrontedAgent，重连时新内核从账本播种上一轮车道', async () => {
  const wiring = productionAgent();
  const first = makeRuntime(wiring);
  try {
    first.runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(await until(() => answerPlaying(first)), '回答音频要先真的下发（回执那段不算）');
    const ticket = first.runtime.core.fsm.ticket();

    first.runtime.dispatch({ type: 'partial', text: '停一下' });
    assert.ok(
      await until(() => first.runtime.idle),
      '被插话的那一轮要收干净（否则串行链还挂着）',
    );

    const settled = wiring.fronted.ledgerTurns.at(-1);
    assert.equal(
      settled?.truncated,
      true,
      `账本要收到「用户少听了一段」；实际 ${JSON.stringify(settled ?? null)}`,
    );
    assert.deepEqual(
      settled?.ticket,
      { no: ticket.no, gen: ticket.gen },
      '结算按票据认领那一笔（认错了会改到别的轮次头上）',
    );
    assert.equal(
      first.runtime.core.runtime.state.ledger.lastOutcome?.truncated,
      true,
      '内核账本与外部账本必须是同一份事实',
    );
  } finally {
    first.runtime.dispose();
  }

  // 重连：新的 `DialogRuntime` 新建内核，唯一的记性来自 agent 的账本
  const second = makeRuntime(wiring);
  try {
    assert.equal(
      second.runtime.core.runtime.state.ledger.lastLane,
      'dsh',
      '重连后内核要记得上一轮是 dsh（否则顺着它的追问的一句会被当成闲聊抢答）',
    );
  } finally {
    second.runtime.dispose();
  }
});

// ---------------------------------------------------------------- 级联 / 直播

function audioAnswer(
  chunks: readonly Buffer[],
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

interface PipeRig {
  readonly runtime: DialogRuntime;
  readonly calls: string[];
  readonly logs: string[];
}

/** 生产端口 + 热路径引擎。agent 是 `trackActivity` 包过的那一层。 */
function makePipedRuntime(
  agent: AgentProvider,
  engine: FastVoiceEngine,
  ticketContext?: DialogFsmContext,
): PipeRig {
  const calls: string[] = [];
  const logs: string[] = [];
  const runtime = new DialogRuntime({
    clock: new SystemClock(),
    caps: CAPS,
    agent,
    tts: TTS,
    engine,
    downlink: DOWNLINK,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    ...(ticketContext === undefined ? {} : { ticketContext }),
    env: {
      call: (call) => {
        calls.push(call.op);
        return true;
      },
      assemble: () => {},
      end: () => {},
    },
    log: (line) => { logs.push(line); },
  });
  return { runtime, calls, logs };
}

const pipeStops = (rig: PipeRig): number => rig.calls.filter((op) => op === 'audio.stop').length;

const omniPlaying = (runtime: DialogRuntime): boolean =>
  runtime.core.fsm.state === 'speaking'
  && runtime.core.runtime.state.playback.sentMediaMs > 0;

test('级联：插话按票据把 truncated 写回账本，abortEngine 只 dropPrefetch 一次，audio.stop 一次', async () => {
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => {
      await sleep(20);
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    cancelTurn: () => {},
  };
  const cascade = new CascadeAgent({ inner, apiKey: '', log: () => {} });
  assert.equal(cascade.lastLedgerLane(), null, '开场还没有上一轮');
  const drops: string[] = [];
  const originalDrop = cascade.dropPrefetch.bind(cascade);
  cascade.dropPrefetch = (why: string): void => {
    drops.push(why);
    originalDrop(why);
  };
  const agent = trackActivity(cascade, newActivityState(Date.now()));
  const engine = cascade.toEngine(TTS);
  const aborts: string[] = [];
  const originalAbort = engine.abortSpeculation.bind(engine);
  engine.abortSpeculation = (reason): void => {
    aborts.push(reason);
    originalAbort(reason);
  };
  const rig = makePipedRuntime(agent, engine);
  try {
    assert.notEqual(rig.runtime.core.runtime.ports, null, '生产装配必须绑好内核端口');
    rig.runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(
      await until(() =>
        !rig.runtime.core.fsm.speakingIsReceiptOnly
        && rig.runtime.core.runtime.state.playback.sentMediaMs > 0
        && rig.runtime.core.fsm.state === 'speaking'),
      '回答音频要先真的下发（回执那段不算）',
    );

    const ticket = rig.runtime.core.fsm.ticket();
    const stopsBefore = pipeStops(rig);
    rig.runtime.dispatch({ type: 'partial', text: '停一下' });

    assert.equal(
      pipeStops(rig) - stopsBefore,
      1,
      `插话只能带来一次 audio.stop；实际 ${JSON.stringify(rig.calls)}`,
    );
    assert.deepEqual(aborts, ['barge_in'], `abortEngine 要进引擎一次；实际 ${JSON.stringify(aborts)}`);
    assert.deepEqual(
      drops,
      ['barge_in'],
      `abortSpeculation 要落到 dropPrefetch 一次；实际 ${JSON.stringify(drops)}`,
    );

    const settled = cascade.ledgerTurns.at(-1);
    assert.equal(settled?.truncated, true, `账本要记下少听了；实际 ${JSON.stringify(settled ?? null)}`);
    assert.deepEqual(
      settled?.ticket,
      { no: ticket.no, gen: ticket.gen },
      '结算按票据认领那一笔',
    );
    assert.equal(cascade.lastLedgerLane(), 'dsh', '这一轮是 dsh 答的，账本车道要更新');
    assert.equal(
      rig.runtime.core.runtime.state.ledger.lastOutcome?.truncated,
      true,
      '内核账本与 CascadeAgent 账本必须是同一份事实',
    );
    assert.equal(rig.runtime.core.fsm.state, 'listening');
    await until(() => rig.runtime.idle);
  } finally {
    rig.runtime.dispose();
  }
});

test('直播：播放中插话只 audio.stop 一次并 interrupt 一次，不取消在跑的后台 dsh', async () => {
  const calls = { n: 0 };
  const cancels = { n: 0 };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inner: AgentProvider = {
    name: 'dsh',
    cancelTurn: () => { cancels.n += 1; },
    reply: async (): Promise<AgentReplyView> => {
      calls.n += 1;
      await gate;
      return { text: '后台结论', speech: '后台结论' };
    },
  };
  const interrupts = { n: 0 };
  const lane: LiveAudioLane = {
    willServe: () => true,
    claim: () => audioAnswer([PCM], '我帮你看看。', { reason: 'delegate', text: '明天天气' }),
    discard: () => {},
    interrupt: () => { interrupts.n += 1; },
  };
  const live = new LiveOrchestrator({ inner, tts: TTS, log: () => {} });
  live.attachAudioLane(lane);
  const agent = trackActivity(live, newActivityState(Date.now()));
  const rig = makePipedRuntime(agent, live.toEngine());
  try {
    assert.notEqual(rig.runtime.core.runtime.ports, null, '生产装配必须绑好内核端口');
    rig.runtime.dispatch({ type: 'utterance', text: '明天天气怎么样' });
    assert.ok(
      await until(() => omniPlaying(rig.runtime) && calls.n >= 1),
      `Omni 要在播、后台 dsh 要已经派出去；state=${rig.runtime.core.fsm.state} calls=${calls.n}`,
    );

    const stopsBefore = pipeStops(rig);
    rig.runtime.dispatch({ type: 'partial', text: '停一下' });

    assert.equal(
      pipeStops(rig) - stopsBefore,
      1,
      `插话只能带来一次 audio.stop；实际 ${JSON.stringify(rig.calls)}`,
    );
    assert.equal(interrupts.n, 1, 'abortEngine(barge_in) 要打断 Omni 一次');
    assert.equal(cancels.n, 0, '插话不许取消已经在跑的后台 dsh');
    assert.equal(rig.runtime.core.fsm.state, 'listening');
    await until(() => rig.runtime.idle);
  } finally {
    release();
    rig.runtime.dispose();
    live.dispose();
  }
});

test('直播：开轮前的旧段被 isPreTurnCommit 拦住，audio.stop 与 interrupt 都是 0', async () => {
  const seq = 5;
  const interrupts = { n: 0 };
  const lane: LiveAudioLane = {
    willServe: () => true,
    claim: () => audioAnswer([PCM], '今天不错。'),
    discard: () => {},
    interrupt: () => { interrupts.n += 1; },
  };
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => ({ text: '', speech: '' }),
  };
  const live = new LiveOrchestrator({ inner, tts: TTS, log: () => {} });
  live.attachAudioLane(lane);
  const agent = trackActivity(live, newActivityState(Date.now()));
  const rig = makePipedRuntime(agent, live.toEngine(), { baseCommitSeq: () => seq });
  try {
    rig.runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(await until(() => omniPlaying(rig.runtime)), 'Omni 音频要先下发');
    assert.equal(rig.runtime.core.fsm.ticket().baseCommitSeq, 5, '票据要锁存开轮瞬间的水位线');
    assert.equal(isPreTurnCommit(rig.runtime.core.runtime.state, 3), true);
    assert.equal(isPreTurnCommit(rig.runtime.core.runtime.state, 5), true);
    assert.equal(isPreTurnCommit(rig.runtime.core.runtime.state, 7), false);

    const stopsBefore = pipeStops(rig);
    const stalePartial = rig.runtime.dispatch({ type: 'partial', text: '旧段', commitSeq: 3 });
    assert.deepEqual(stalePartial, [{ type: 'drop', why: 'pre-turn' }]);
    const staleSentence = rig.runtime.dispatch({ type: 'sentence', text: '旧段', commitSeq: 5 });
    assert.deepEqual(staleSentence, [{ type: 'drop', why: 'pre-turn' }]);

    assert.equal(pipeStops(rig) - stopsBefore, 0, '旧段不许停音频');
    assert.equal(interrupts.n, 0, '旧段不许 interrupt Omni');
    assert.equal(rig.runtime.core.fsm.state, 'speaking', '旧段不影响相位');
    assert.ok(rig.logs.some((line) => line.includes('开轮前录的那段定稿')), '旧段被拦下要有痕迹');
    await until(() => rig.runtime.idle);
    assert.equal(pipeStops(rig), stopsBefore, '这一轮自然结束也不该补一次 audio.stop');
    assert.equal(interrupts.n, 0);
  } finally {
    rig.runtime.dispose();
    live.dispose();
  }
});
