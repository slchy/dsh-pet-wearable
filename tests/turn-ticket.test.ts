/**
 * 轮次令牌贯通到 agent 层：**插话 / 连接结束走同一条取消管道**。
 *
 * 以前插话只停声音，上游 dsh 那一轮照跑（钱照花、历史里留一条用户没听过的回答）。
 * 现在取消由 `DialogFsm.onInvalidate` 发出来，带着本轮 `{no, gen}` 传到
 * `agent.cancelTurn(ticket)` —— 票据是唯一令牌，迟到的取消靠它丢弃。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Cancel, Clock } from '../src/app/clock.ts';
import { DialogFsm, type TurnTicket } from '../src/dialog-fsm.ts';
import type { AgentProvider, TtsProvider } from '../src/providers.ts';
import { TurnRunner } from '../src/turn-runner.ts';

const LOUD = Buffer.alloc(480, 1);

const clock: Clock = {
  now: () => performance.now(),
  localHour: () => 12,
  after: (ms, fn): Cancel => {
    const timer = setTimeout(fn, ms);
    return () => { clearTimeout(timer); };
  },
  every: (ms, fn): Cancel => {
    const timer = setInterval(fn, ms);
    return () => { clearInterval(timer); };
  },
};

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function rig(): {
  fsm: DialogFsm;
  cancelled: Array<TurnTicket | undefined>;
  start: () => Promise<unknown>;
  release: () => void;
} {
  const fsm = new DialogFsm(() => {});
  const cancelled: Array<TurnTicket | undefined> = [];
  let release: () => void = () => {};

  const agent: AgentProvider = {
    name: 'fake',
    // 一轮永远不自己结束：等测试放行（模拟 dsh 还在跑）
    reply: async () => await new Promise((resolve) => {
      release = () => { resolve({ text: '[平静]好', speech: '好' }); };
    }),
    cancelTurn: (ticket) => {
      cancelled.push(ticket);
    },
  };
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async* synthesize() { yield LOUD; },
    async* synthesizeStream() { yield LOUD; },
  };
  const runner = new TurnRunner({
    clock,
    agent,
    tts,
    downlink: { sendAudio: () => {}, sendControl: () => {} },
    fsm,
    playbackTailMs: 0,
    onTurnFinished: () => {},
    onLiveAvailable: () => {},
    log: () => {},
  });
  return { fsm, cancelled, start: () => runner.run('你好'), release: () => { release(); } };
}

test('插话 → 带着本轮票据取消上游', async () => {
  const r = rig();
  const running = r.start();
  await tick();

  const ticket = r.fsm.ticket();
  r.fsm.audioStarted(ticket); // thinking → speaking，插话只在这个状态成立
  assert.equal(r.fsm.bargeIn('用户插话'), true);

  assert.equal(r.cancelled.length, 1, '插话必须让上游知道这一轮不要了');
  assert.deepEqual(r.cancelled[0], { no: 1, gen: 0 }, '票据是 DialogFsm 发的那个');

  r.release();
  await running;
});

test('连接结束也走同一条管道（同样带票据）', async () => {
  const r = rig();
  const running = r.start();
  await tick();

  r.fsm.close();
  assert.equal(r.cancelled.length, 1);
  assert.equal(r.cancelled[0]?.no, 1);

  r.release();
  await running;
});

test('没插话没断连就不该有人调取消', async () => {
  const r = rig();
  const running = r.start();
  await tick();
  r.release();
  await running;
  assert.deepEqual(r.cancelled, [], '正常走完的一轮不该取消上游');
});
