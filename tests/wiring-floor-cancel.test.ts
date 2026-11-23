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
import { FrontedAgent } from '../src/fronted-agent.ts';
import { newActivityState, trackActivity } from '../src/keepalive.ts';
import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import type {
  AgentPort,
  DevicePort,
  Voice,
} from '../src/pet/brain/types.ts';
import type { AgentProvider, AgentReplyView, TtsProvider } from '../src/providers.ts';
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
