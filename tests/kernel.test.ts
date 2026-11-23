/**
 * 内核：纯 Mealy 机 + 解释器。
 *
 * - 判定（能不能打断、这份回答归谁、听全了没有）全在 `kernel.ts` 的纯函数里；
 * - 执行（发 `audio.stop`、作废、回注）全在 `kernel-runtime.ts` 的端口后面。
 *
 * 这里测试守三件事，对应用户定的三条硬标准：
 *
 * 1. **可离线 reduce 复现**：同一串事件在任何机器上 reduce 出同一份状态与意图。
 * 2. **乱序不变性**：把事件之间的到达顺序/时刻打乱，只要出生证（`commitSeq`/票据）不变，
 *    内核不会产出自打断、幽灵轮次或卡死。
 * 3. **换引擎零改内核**：引擎形态（live / cascade）不进内核状态，喂同样的事件得到
 *    同样的结果 —— 内核只认 `EngineEvent` 与因果坐标。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initialKernelState, reduceKernel, step, type KernelEvent } from '../src/kernel.ts';
import type { TurnTicket } from '../src/dialog-fsm.ts';

const ticket = (no: number, gen = 0, baseCommitSeq?: number): TurnTicket =>
  baseCommitSeq === undefined ? { no, gen } : { no, gen, baseCommitSeq };

/** 一轮的标准剧本：开轮（基线 3）→ 出声 → 用户插话 */
function scenario(commitSeq: number): KernelEvent[] {
  return [
    { type: 'asrCommit', commitSeq: 2 },
    { type: 'decodeSettled', commitSeq: 2 },
    { type: 'asrCommit', commitSeq: 3 },
    { type: 'decodeSettled', commitSeq: 3 },
    { type: 'turnStarted', ticket: ticket(1, 0, 3), atMs: 1000 },
    { type: 'fsmPhase', phase: 'speaking' },
    { type: 'audioSent', mediaMs: 6000, atMs: 1100 },
    { type: 'userSpeech', commitSeq, final: false, atMs: 9000 },
  ];
}

test('开轮前录的那段不算插话：它只归档，不产任何意图', () => {
  // 真机 `20261123-053719` 第 2 轮：`seq=3` 在 11473 ms 封段、11583 ms 进 speaking、
  // 11655 ms 那条转写才迟到。按到达时间它是"插话"，按因果它是**开轮前的旧段**。
  const { effects } = reduceKernel(initialKernelState(), scenario(3));
  assert.deepEqual(effects, [], '旧段不许打断，一个意图都不能有');

  const fresh = reduceKernel(initialKernelState(), scenario(4));
  assert.deepEqual(
    fresh.effects.map((e) => e.type),
    ['stopDeviceAudio', 'invalidateTurn', 'abortEngine', 'settleTurn'],
    '开轮之后的新段才构成插话；打断的那一刻要把这一轮结算掉（用户听了多少是后验事实）',
  );
});

test('乱序不变性：到达顺序怎么打乱，因果裁决都一样', () => {
  // 只打乱**允许乱序**的那几条（时间流逝、媒体游标、gate 周期）；
  // `asrCommit`/`turnStarted` 的因果顺序由出生证决定，打乱它等于换了一个故事。
  const base = scenario(4);
  const before = reduceKernel(initialKernelState(), base);

  const jittered: KernelEvent[] = [    base[0]!, base[1]!, base[2]!, base[3]!,
    { type: 'gate', gateSeq: 7 },
    base[4]!,
    base[5]!,
    base[6]!,
    { type: 'gate', gateSeq: 8 },
    base[7]!,
    { type: 'devicePlayed', atMs: 9000 },
  ];
  const after = reduceKernel(initialKernelState(), jittered);
  const types = (e: readonly { type: string }[]): string[] => e.map((x) => x.type);
  assert.deepEqual(types(after.effects), types(before.effects), '意图必须一字不差');
  assert.equal(after.state.dialog.phase, 'listening');
  assert.equal(after.state.playback.firstAudioAtMs, null, '插话之后播放区要清干净');
});

test('乱序不变性：同一条插话重复到达（网络重放）只作废一次', () => {
  const events: KernelEvent[] = [
    ...scenario(4),
    { type: 'userSpeech', commitSeq: 4, final: false, atMs: 9000 },
    { type: 'userSpeech', commitSeq: 4, final: true, atMs: 9100 },
  ];
  const { effects } = reduceKernel(initialKernelState(), events);
  assert.equal(
    effects.filter((e) => e.type === 'invalidateTurn').length,
    1,
    '第二次到达时已经不在 speaking 了，不该再作废一次',
  );
});

test('控制面与物理面拆权：被新轮顶掉但仍然听全了 → stale 且不 truncated → 要回注', () => {
  const events: KernelEvent[] = [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 1000 },
    { type: 'fsmPhase', phase: 'speaking' },
    { type: 'audioSent', mediaMs: 4000, atMs: 1100 },
    // 4 s 音频播完，用户 26 ms 后才开口 —— 真机 `20261123-002440` 第 3 轮
    { type: 'turnStarted', ticket: ticket(2, 0, 0), atMs: 5100 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 5126 },
  ];
  const { effects, state } = reduceKernel(initialKernelState(), events);
  const settle = effects.find((e) => e.type === 'settleTurn');
  assert.ok(settle, '必须结算');
  if (settle?.type !== 'settleTurn') return;
  assert.equal(settle.outcome.stale, true, '控制面：老轮已经无权动 FSM');
  assert.equal(settle.outcome.truncated, false, '内容面：用户听全了');
  assert.equal(settle.reflect, true, '听全了就该回注记忆');
  assert.equal(state.ledger.lastLane, null);
});

test('媒体时间是唯一尺子：听得到的既不能超过送出量，也不能快过实时', () => {
  const base = (events: KernelEvent[]) => reduceKernel(initialKernelState(), events);
  const settleOf = (effects: readonly { type: string }[]) => {
    const s = effects.find((e) => e.type === 'settleTurn');
    if (s === undefined) throw new Error('没结算');
    return s as unknown as { outcome: { heardMs: number; truncated: boolean }; reflect: boolean };
  };

  // (a) 一个字都没送出去：等再久也没"听到"
  const silent = base([
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 0 },
    { type: 'fsmPhase', phase: 'speaking' },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 30_000 },
  ]);
  assert.equal(settleOf(silent.effects).outcome.heardMs, 0);
  assert.equal(settleOf(silent.effects).reflect, false, '没播出去的东西不该回注成"他知道"');

  // (b) 声音播不了比实时快：送得再多，也只能按墙钟走这么多
  const buffered = base([
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 0 },
    { type: 'fsmPhase', phase: 'speaking' },
    { type: 'audioSent', mediaMs: 10_000, atMs: 10 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 2000 },
  ]);
  assert.equal(settleOf(buffered.effects).outcome.heardMs, 1990, 'elapsed 是物理上限');
  assert.equal(settleOf(buffered.effects).outcome.truncated, true);

  // (c) 打断时按"已经送到设备多少"封顶，不是按"计划说多少"
  const midway = base([
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 0 },
    { type: 'fsmPhase', phase: 'speaking' },
    { type: 'audioSent', mediaMs: 500, atMs: 100 },
    { type: 'audioSent', mediaMs: 1200, atMs: 1000 },
    { type: 'userSpeech', commitSeq: 5, final: false, atMs: 1100 },
  ]);
  const settled = settleOf(midway.effects);
  assert.equal(settled.outcome.heardMs, 1000);
  assert.equal(settled.outcome.truncated, false, '1200 ms 的东西听了 1000 ms，容差内算听完');
});

test('换引擎零改内核：引擎形态不进内核状态', () => {
  // 引擎是 live 还是 cascade 只影响它对 `audioSent` 的产出节奏，
  // 内核吃的是同一套 `EngineEvent`（这里退化成 kernel 事件），状态与意图一字不差。
  const live: KernelEvent[] = [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 0 },
    { type: 'audioSent', mediaMs: 1000, atMs: 10 },
    { type: 'audioSent', mediaMs: 2000, atMs: 20 },
  ];
  // 级联：先 TTS 首块晚到，但媒体总量与顺序一样
  const cascade: KernelEvent[] = [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 0 },
    { type: 'audioSent', mediaMs: 1000, atMs: 900 },
    { type: 'audioSent', mediaMs: 2000, atMs: 1200 },
  ];
  const a = reduceKernel(initialKernelState(), live);
  const b = reduceKernel(initialKernelState(), cascade);
  assert.deepEqual(a.state.playback.sentMediaMs, b.state.playback.sentMediaMs);
  assert.deepEqual(a.state.dialog, b.state.dialog);
  assert.deepEqual(a.effects, b.effects);
  // 唯一允许不同的是首块墙钟时刻（那是延迟指标，不是状态）
  assert.notEqual(a.state.playback.firstAudioAtMs, b.state.playback.firstAudioAtMs);
});

test('step 是纯的：同一份输入调两次，结果相同且不改原状态', () => {
  const state = initialKernelState();
  const before = JSON.stringify(state);
  const [a] = step(state, { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 5 });
  const [b] = step(state, { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 5 });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(state), before, '不许原地改');
});
