/**
 * 生产形状的接线：`notifyState` 盖不盖得住 `TurnRunner` 里的转移、外层 agent 转不转发取消。
 *
 * 这两件事在单测里都「绿」过，但单测绕过了生产包装：
 * - `floor-arbiter.test.ts` 直接调 `AppSession.onDialogState`，不问状态机什么时候通知；
 * - `turn-ticket.test.ts` 把裸 `AgentProvider` 交给 `TurnRunner`，不问
 *   `trackActivity(FrontedAgent(...))` 这一层会不会把票据和 `cancelTurn` 吞掉。
 *
 * 所以这里按生产装配来：`DialogRuntime` + `AppSession` 一起跑一轮，agent 包两层。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SystemClock } from '../src/app/clock.ts';
import { DialogRuntime } from '../src/app/dialog.ts';
import { AppSession } from '../src/app/session.ts';
import { DialogFsm } from '../src/dialog-fsm.ts';
import type { DialogState } from '../src/dialog-fsm.ts';
import type { FastVoiceEngine } from '../src/engine-contract.ts';
import type { LiveAudioLane } from '../src/engines/live-voice-engine.ts';
import { FrontedAgent } from '../src/fronted-agent.ts';
import { newActivityState, trackActivity } from '../src/keepalive.ts';
import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import type {
  AgentPort,
  DevicePort,
  Voice,
} from '../src/pet/brain/types.ts';
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
import { TurnRunner } from '../src/turn-runner.ts';

const clock = new SystemClock();

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

/** 1 ms 的音频（24 kHz、16 bit）—— 只要够触发 `speaking`，不占真实时间 */
const TINY_PCM = Buffer.alloc(48, 1);

const tts: TtsProvider = {
  name: 'fake',
  sampleRate: 24_000,
  async* synthesize() { yield TINY_PCM; },
  async* synthesizeStream() { yield TINY_PCM; },
};

const downlink: DownlinkSink = { sendAudio: () => {}, sendControl: () => {} };

function petStubs(): { voice: Voice; device: DevicePort; agent: AgentPort } {
  return {
    voice: { speak: async () => 'done', stop: () => {} } as unknown as Voice,
    device: { call: async () => ({ ok: true }) } as unknown as DevicePort,
    agent: { reply: async () => ({ speech: '', emotion: 'calm' }) } as unknown as AgentPort,
  };
}

/** 轮询到条件成立；超时返回 false，让断言给出「根本没发生过」而不是挂住 */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

test('生产装配：一轮走完话筒要放空，中途要通知到 thinking / speaking', async () => {
  const { voice, device, agent: petAgent } = petStubs();
  const app = new AppSession({
    clock,
    caps: CAPS,
    voice,
    device,
    agent: petAgent,
    pet: false,
  });

  const states: DialogState[] = [];
  const runtime = new DialogRuntime({
    clock,
    caps: CAPS,
    agent: {
      name: 'fake',
      reply: async (): Promise<AgentReplyView> => ({ text: '好', speech: '好' }),
    },
    tts,
    downlink,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
      onDialogState: (state) => {
        states.push(state);
        app.onDialogState(state);
      },
    },
    log: () => {},
  });

  // 内核意图的**唯一执行者**就是这份生产端口（`stopDeviceAudio` / `invalidateTurn` /
  // `abortEngine` / `settleTurn`）。没绑上 = 插话不断音、dsh 白跑，而且一条日志都没有。
  assert.notEqual(
    runtime.core.runtime.ports,
    null,
    '生产装配必须给内核绑好端口',
  );

  app.userPartial();
  app.userFinal('你好');
  runtime.dispatch({ type: 'utterance', text: '你好' });

  await until(() => clock.now() > 0 && app.floor.owner === null);

  assert.ok(states.includes('thinking'), `没通知到 thinking，实际：${JSON.stringify(states)}`);
  assert.ok(states.includes('speaking'), `没通知到 speaking，实际：${JSON.stringify(states)}`);
  assert.equal(
    app.floor.owner,
    null,
    '一轮结束话筒必须放空（否则宠物的 floorFree 永远不成立、announce 也抢不动 reply）',
  );
  runtime.dispose();
  app.close();
});

test('生产装配：插话要把取消送到 dsh，票据就是状态机发的那一张', async () => {
  const seenTickets: Array<{ readonly no: number; readonly gen: number } | undefined> = [];
  const cancels: Array<{ readonly no: number; readonly gen: number } | undefined> = [];
  const interrupts = { count: 0 };
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (_text, _image, _note, turn) => {
      seenTickets.push(turn?.ticket);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    cancelTurn: (ticket) => { cancels.push(ticket); },
    interruptTurn: () => { interrupts.count += 1; },
  };
  // 生产的两层：trackActivity 外面包 FrontedAgent（`apiKey: ''` = 快车道关，直接交给 dsh）
  const agent = trackActivity(
    new FrontedAgent({ inner, apiKey: '', cancelMode: 'interrupt', log: () => {} }),
    newActivityState(Date.now()),
  );
  const fsm = new DialogFsm(() => {});
  const runner = new TurnRunner({
    clock,
    agent,
    tts,
    downlink,
    fsm,
    playbackTailMs: 0,
    onTurnFinished: () => {},
    onLiveAvailable: () => {},
    log: () => {},
  });

  const running = runner.run('你好');
  assert.ok(await until(() => fsm.state === 'speaking'), `没进 speaking，实际 ${fsm.state}`);
  const ticket = fsm.ticket();
  assert.equal(fsm.bargeIn('插话'), true, 'speaking 期间插话要成立');
  await running;

  assert.deepEqual(
    seenTickets[0],
    { no: ticket.no, gen: ticket.gen },
    '票据必须一路传到内层 dsh（否则 session 层没法按代次丢过期取消）',
  );
  assert.ok(
    cancels.some((c) => c !== undefined && c.no === ticket.no && c.gen === ticket.gen),
    `插话必须调内层 cancelTurn，实际：${JSON.stringify(cancels)}`,
  );
  assert.equal(interrupts.count, 0, '插话只走 rpc 取消，不该 SIGINT 杀进程');
});

/**
 * 0.6 s 音频（24 kHz / 16 bit）。插话要落在 `speaking` 的播放等待里，
 * 1 ms 的块会在轮询醒来之前就播完。
 */
const LONG_PCM = Buffer.alloc(28_800, 1);

function longTts(): TtsProvider {
  return {
    name: 'fake-long',
    sampleRate: 24_000,
    async* synthesize() { yield LONG_PCM; },
  };
}

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

/**
 * `main.ts` 的外层：`trackActivity` 包住管线 agent，热路径引擎另注 `DialogOptions.engine`。
 * 话筒归属仍由 `AppSession.onDialogState` 跟着状态机走。
 */
function openSession(
  agent: AgentProvider,
  voice: TtsProvider,
  engine: FastVoiceEngine,
): { app: AppSession; runtime: DialogRuntime; states: DialogState[] } {
  const { voice: petVoice, device, agent: petAgent } = petStubs();
  const app = new AppSession({
    clock,
    caps: CAPS,
    voice: petVoice,
    device,
    agent: petAgent,
    pet: false,
  });
  const states: DialogState[] = [];
  const runtime = new DialogRuntime({
    clock,
    caps: CAPS,
    agent,
    tts: voice,
    engine,
    downlink,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
      onDialogState: (state) => {
        states.push(state);
        app.onDialogState(state);
      },
    },
    log: () => {},
  });
  return { app, runtime, states };
}

/** 回答音频已经在播（回执那段 `speaking` 不算）。 */
function answerPlaying(runtime: DialogRuntime): boolean {
  return runtime.core.fsm.state === 'speaking'
    && !runtime.core.fsm.speakingIsReceiptOnly
    && runtime.core.runtime.state.playback.sentMediaMs > 0;
}

test('生产装配（级联）：一轮走完话筒要放空，中途要通知到 thinking / speaking', async () => {
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => ({ text: '好', speech: '好' }),
  };
  const cascade = new CascadeAgent({ inner, apiKey: '', log: () => {} });
  const agent = trackActivity(cascade, newActivityState(Date.now()));
  const { app, runtime, states } = openSession(agent, tts, cascade.toEngine(tts));
  try {
    assert.notEqual(runtime.core.runtime.ports, null, '生产装配必须给内核绑好端口');
    app.userPartial();
    app.userFinal('你好');
    runtime.dispatch({ type: 'utterance', text: '你好' });

    assert.ok(
      await until(() => states.includes('speaking')
        && states.at(-1) === 'listening'
        && app.floor.owner === null),
      `话筒没放空或相位没走完，实际 ${JSON.stringify(states)} owner=${String(app.floor.owner)}`,
    );
    assert.ok(states.includes('thinking'), `没通知到 thinking，实际：${JSON.stringify(states)}`);
    assert.ok(states.includes('speaking'), `没通知到 speaking，实际：${JSON.stringify(states)}`);
    assert.equal(
      app.floor.owner,
      null,
      '一轮结束话筒必须放空（否则宠物的 floorFree 永远不成立、announce 也抢不动 reply）',
    );
  } finally {
    runtime.dispose();
    app.close();
  }
});

test('生产装配（级联）：插话把取消送到 dsh，并经 abortEngine 落到 dropPrefetch', async () => {
  const cancels: Array<{ readonly no: number; readonly gen: number } | undefined> = [];
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    cancelTurn: (ticket) => { cancels.push(ticket); },
  };
  const cascade = new CascadeAgent({ inner, apiKey: '', log: () => {} });
  const drops: string[] = [];
  const originalDrop = cascade.dropPrefetch.bind(cascade);
  cascade.dropPrefetch = (why: string): void => {
    drops.push(why);
    originalDrop(why);
  };
  const agent = trackActivity(cascade, newActivityState(Date.now()));
  const voice = longTts();
  const engine = cascade.toEngine(voice);
  const aborts: string[] = [];
  const originalAbort = engine.abortSpeculation.bind(engine);
  engine.abortSpeculation = (reason): void => {
    aborts.push(reason);
    originalAbort(reason);
  };
  const { app, runtime } = openSession(agent, voice, engine);
  try {
    app.userPartial();
    app.userFinal('你好');
    runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(await until(() => answerPlaying(runtime)), `回答没进 speaking，实际 ${runtime.core.fsm.state}`);

    const ticket = runtime.core.fsm.ticket();
    runtime.dispatch({ type: 'partial', text: '停一下' });

    assert.equal(runtime.core.fsm.state, 'listening', '插话成立 → 回到 listening');
    assert.deepEqual(aborts, ['barge_in'], `abortEngine 要走到引擎的 abortSpeculation；实际 ${JSON.stringify(aborts)}`);
    assert.deepEqual(
      drops,
      ['barge_in'],
      `abortSpeculation 要落到 CascadeAgent.dropPrefetch 一次；实际 ${JSON.stringify(drops)}`,
    );
    assert.equal(cancels.length, 1, `cancelTurn 只能送到 dsh 一次；实际 ${JSON.stringify(cancels)}`);
    assert.equal(cancels[0]?.no, ticket.no);
    assert.equal(cancels[0]?.gen, ticket.gen);
    await until(() => runtime.idle);
  } finally {
    runtime.dispose();
    app.close();
  }
});

test('生产装配（直播）：一轮 Omni 走完话筒要放空，中途要通知到 thinking / speaking', async () => {
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => ({ text: '', speech: '' }),
  };
  const lane: LiveAudioLane = {
    willServe: () => true,
    claim: () => audioAnswer([TINY_PCM], '好'),
    discard: () => {},
    interrupt: () => {},
  };
  const live = new LiveOrchestrator({ inner, tts, log: () => {} });
  live.attachAudioLane(lane);
  const agent = trackActivity(live, newActivityState(Date.now()));
  const { app, runtime, states } = openSession(agent, tts, live.toEngine());
  try {
    assert.notEqual(runtime.core.runtime.ports, null, '生产装配必须给内核绑好端口');
    app.userPartial();
    app.userFinal('你好');
    runtime.dispatch({ type: 'utterance', text: '你好' });

    assert.ok(
      await until(() => states.includes('speaking')
        && states.at(-1) === 'listening'
        && app.floor.owner === null),
      `话筒没放空或相位没走完，实际 ${JSON.stringify(states)} owner=${String(app.floor.owner)}`,
    );
    assert.ok(states.includes('thinking'), `没通知到 thinking，实际：${JSON.stringify(states)}`);
    assert.ok(states.includes('speaking'), `没通知到 speaking，实际：${JSON.stringify(states)}`);
    assert.equal(
      app.floor.owner,
      null,
      '一轮结束话筒必须放空（否则宠物的 floorFree 永远不成立、announce 也抢不动 reply）',
    );
  } finally {
    runtime.dispose();
    live.dispose();
    app.close();
  }
});

test('生产装配（直播）：tool_call 异步派 dsh 后立刻放回话筒；插话只打断 Omni，别查了才取消 dsh', async () => {
  const calls = { n: 0 };
  const cancels: Array<{ readonly no: number; readonly gen: number } | undefined> = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inner: AgentProvider = {
    name: 'dsh',
    cancelTurn: (ticket) => { cancels.push(ticket); },
    reply: async (): Promise<AgentReplyView> => {
      calls.n += 1;
      await gate;
      return { text: '后台结论', speech: '后台结论' };
    },
  };
  const interrupts = { n: 0 };
  let claims = 0;
  const lane: LiveAudioLane = {
    willServe: () => true,
    claim: () => {
      claims += 1;
      if (claims === 1) {
        return audioAnswer([TINY_PCM], '我帮你看看。', { reason: 'delegate', text: '明天天气' });
      }
      return audioAnswer([LONG_PCM], '今天不错。');
    },
    discard: () => {},
    interrupt: () => { interrupts.n += 1; },
  };
  const live = new LiveOrchestrator({ inner, tts, log: () => {} });
  live.attachAudioLane(lane);
  const agent = trackActivity(live, newActivityState(Date.now()));
  const { app, runtime, states } = openSession(agent, tts, live.toEngine());
  try {
    app.userPartial();
    app.userFinal('明天天气怎么样');
    runtime.dispatch({ type: 'utterance', text: '明天天气怎么样' });

    assert.ok(
      await until(() => states.includes('speaking')
        && states.at(-1) === 'listening'
        && app.floor.owner === null
        && calls.n >= 1
        && runtime.idle),
      `tool_call 应不等 dsh 就回到 listening 并放回话筒，实际 states=${JSON.stringify(states)}`
      + ` calls=${calls.n} owner=${String(app.floor.owner)} idle=${runtime.idle}`,
    );
    assert.equal(cancels.length, 0, '回到 listening 时后台 dsh 还在跑，不该被取消');

    runtime.dispatch({ type: 'utterance', text: '你好' });
    assert.ok(
      await until(() => answerPlaying(runtime)),
      `下一轮 Omni 要进入播放才能插话，实际 ${runtime.core.fsm.state}`,
    );
    runtime.dispatch({ type: 'partial', text: '等等' });

    assert.equal(interrupts.n, 1, '插话要打断 Omni');
    assert.equal(cancels.length, 0, '插话不许调用 dsh.cancelTurn');
    assert.equal(runtime.core.fsm.state, 'listening');
    assert.ok(await until(() => runtime.idle), '被插话的那一轮要收干净');

    runtime.dispatch({ type: 'utterance', text: '别查了' });
    assert.ok(
      await until(() => cancels.length === 1),
      `「别查了」要调用 dsh.cancelTurn，实际 ${JSON.stringify(cancels)}`,
    );
    assert.equal(calls.n, 1, '取消走的是在跑的那一单，不该再开一轮 dsh');
    await until(() => runtime.idle);
  } finally {
    release();
    runtime.dispose();
    live.dispose();
    app.close();
  }
});

test('后台播报被掐断：thinking/speaking 期间话筒始终是 reply，回到 listening 才放空', async () => {
  const { voice, device, agent: petAgent } = petStubs();
  const app = new AppSession({
    clock,
    caps: CAPS,
    voice,
    device,
    agent: petAgent,
    pet: false,
  });

  let releaseSpeak: (outcome: 'spoken' | 'defer' | 'fallback') => void = () => {};
  const speakGate = new Promise<'spoken' | 'defer' | 'fallback'>((resolve) => {
    releaseSpeak = resolve;
  });
  let releaseReply: (view: AgentReplyView) => void = () => {};
  const replyGate = new Promise<AgentReplyView>((resolve) => {
    releaseReply = resolve;
  });

  const states: DialogState[] = [];
  const leaks: string[] = [];
  let releasedDuringThink = false;
  const speeches: string[] = [];

  const watch = (where: string): void => {
    const phase = states.at(-1);
    if ((phase === 'thinking' || phase === 'speaking') && app.floor.owner !== 'reply') {
      leaks.push(`${where} @ ${phase} → ${String(app.floor.owner)}`);
    }
  };

  const runtime = new DialogRuntime({
    clock,
    caps: CAPS,
    agent: {
      name: 'fake',
      reply: () => replyGate,
    },
    tts,
    downlink,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    speakAnnounce: (item) => {
      speeches.push(item.speech);
      return speakGate;
    },
    cancelAnnounce: () => {},
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
      // 生产：`DialogRuntime.onAnnounce` → `AppSession.announce`
      onAnnounce: (pending, spoken) => {
        app.announce(pending, spoken);
        if (states.at(-1) === 'thinking' && pending === false) {
          releasedDuringThink = true;
        }
        watch(`announce(${String(pending)},${String(spoken)})`);
      },
      onDialogState: (state) => {
        states.push(state);
        app.onDialogState(state);
        watch(`state ${state}`);
      },
    },
    log: () => {},
  });

  try {
    runtime.enqueueAnnounce('后台结论');
    assert.equal(speeches.length, 1, '播报应该已经开口');
    assert.equal(app.floor.owner, 'announce', '开口时话筒在播报上');

    // 生产顺序（`voice-session` 的 onUtterance）：先定稿移交话筒，再送进状态机。
    // 短句常常没有 partial，话筒会一直停在 announce 上，直到这次移交。
    app.userFinal('我想问别的');
    assert.equal(app.floor.owner, 'reply', '定稿必须从 announce 移交给 reply');
    runtime.dispatch({ type: 'utterance', text: '我想问别的' });
    assert.ok(
      await until(() => runtime.core.fsm.state === 'thinking'),
      `没进 thinking，实际 ${runtime.core.fsm.state}`,
    );
    assert.equal(app.floor.owner, 'reply');

    releaseSpeak('spoken');
    for (let step = 0; step < 8; step += 1) {
      await Promise.resolve();
    }
    assert.equal(releasedDuringThink, true, '播报 finally 必须在 thinking 期间把 pending=false 交回来');
    assert.equal(runtime.core.fsm.state, 'thinking');
    assert.equal(app.floor.owner, 'reply', 'finally 释放 announce 后不能变成 null');

    releaseReply({ text: '好', speech: '好' });
    assert.ok(
      await until(() => {
        watch('poll');
        return states.includes('speaking')
          && states.at(-1) === 'listening'
          && app.floor.owner === null;
      }),
      `话筒没在 listening 放空，states=${JSON.stringify(states)} owner=${String(app.floor.owner)}`
      + ` leaks=${JSON.stringify(leaks)}`,
    );
    assert.deepEqual(leaks, [], `thinking/speaking 期间话筒离开了 reply：${JSON.stringify(leaks)}`);
    assert.ok(states.includes('thinking'));
    assert.ok(states.includes('speaking'));
    assert.equal(app.floor.owner, null, '整轮回到 listening 才放空');
  } finally {
    releaseSpeak('spoken');
    releaseReply({ text: '好', speech: '好' });
    runtime.dispose();
    app.close();
  }
});
