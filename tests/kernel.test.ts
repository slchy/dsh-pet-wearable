/**
 * 内核：纯 Mealy 机 + 解释器 + 唯一相位真相源。
 *
 * - 判定（能不能打断、这份回答归谁、听全了没有、该不该回注）全在 `kernel.ts` 的纯函数里；
 * - 执行（发 `audio.stop`、作废、回注）全在 `kernel-runtime.ts` 的端口后面；
 * - 相位（`DialogFsm` 那套 `listening/thinking/speaking/...`）也在 `kernel.ts` 的
 *   `dialog` 区域，门面只读不存。
 *
 * 这里测试守四件事，对应用户定的硬标准：
 *
 * 1. **可离线 reduce 复现**：同一串事件在任何机器上 reduce 出同一份状态与意图。
 * 2. **乱序不变性**：把事件之间的到达顺序/时刻打乱，只要出生证（`commitSeq`/票据）不变，
 *    内核不会产出自打断、幽灵轮次或卡死。
 * 3. **换引擎零改内核**：引擎形态（live / cascade）不进内核状态，喂同样的事件得到
 *    同样的结果 —— 内核只认 `EngineEvent` 与因果坐标。
 * 4. **单一状态**：`DialogFsm` 的 getter 与 `KernelRuntime.state.dialog` 永远是同一份，
 *    回注口气（`inject`）也只有内核算一次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  initialKernelState,
  isPreTurnCommit,
  reduceKernel,
  step,
  type Effect,
  type KernelEvent,
  type KernelState,
} from '../src/kernel.ts';
import {
  applyEffects,
  KernelRuntime,
  type KernelPorts,
  type KernelSettlement,
} from '../src/kernel-runtime.ts';
import { DialogFsm, type DialogState, type TurnTicket } from '../src/dialog-fsm.ts';

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

test('打断当场结算过的轮次，协程跑到尾巴再报时不能重算一遍', () => {
  // `TurnRunner` 在打断那一刻就喂了 `ticketInvalidated`+`turnEnded` 拿到结算；
  // 它自己那条 `async` 跑到尾巴还会再喂一次 `turnEnded`。此时播放区已经清空，
  // 若拿空播放区重算，就会把"少听了一半"变成"听了 0 秒、也没少听"→ 该吞的答案被回注。
  const events: KernelEvent[] = [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 1000 },
    { type: 'fsmPhase', phase: 'speaking' },
    { type: 'audioSent', mediaMs: 4000, atMs: 1100 },
    { type: 'userSpeech', commitSeq: 5, final: false, atMs: 2100 },
    { type: 'ticketInvalidated', ticket: ticket(1, 0, 0) },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 2600 },
  ];
  const { effects } = reduceKernel(initialKernelState(), events);
  const settles = effects.filter((e) => e.type === 'settleTurn');
  assert.equal(settles.length, 2, '一次来自打断当场，一次来自协程收尾（幂等重述）');
  const first = settles[0];
  const second = settles[1];
  if (first?.type !== 'settleTurn' || second?.type !== 'settleTurn') return;
  assert.deepEqual(second.outcome, first.outcome, '两次必须是同一份结算');
  assert.equal(first.outcome.truncated, true, '4 s 的东西听了 1 s');
  assert.equal(second.reflect, false, '少听了就不该回注');
});

// ---------------------------------------------------------------- 回注口气（inject）

/** 取唯一一条结算意图 */
function onlySettle(effects: readonly Effect[]): Extract<Effect, { type: 'settleTurn' }> {
  const settle = effects.find((e) => e.type === 'settleTurn');
  assert.ok(settle, '这一轮必须结算');
  return settle as Extract<Effect, { type: 'settleTurn' }>;
}

test('回注口气三态：听全了 spoken、一个字没播 unspoken、少听了一段 none', () => {
  // (a) 听全了：4 s 的音频，播够了才结束
  const spoken = reduceKernel(initialKernelState(), [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 1000 },
    { type: 'audioSent', mediaMs: 4000, atMs: 1100 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 5100 },
  ]);
  const a = onlySettle(spoken.effects);
  assert.equal(a.inject, 'spoken');
  assert.equal(a.reflect, true, '听全了才叫"他知道这件事"');
  assert.equal(a.outcome.truncated, false);
  assert.equal(spoken.state.ledger.lastSettled?.inject, 'spoken', '账本与意图同源');

  // (b) 有结论但一个字都没播出去（委派轮在出声前被插话）：still 要告知上下文，
  //     但不是"他听到了"。真机 `20261123-053719` 第 2 轮就是这种。
  const unspoken = reduceKernel(initialKernelState(), [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 1000 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 9000 },
  ]);
  const b = onlySettle(unspoken.effects);
  assert.equal(b.inject, 'unspoken');
  assert.equal(b.reflect, false, '没播出去过 ≠ 用户听到了');
  assert.equal(b.outcome.truncated, false, '「没播」不是「少听」');
  assert.equal(unspoken.state.ledger.lastSettled?.inject, 'unspoken');

  // (c) 播了一半被打断：不注
  const truncated = reduceKernel(initialKernelState(), [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 1000 },
    { type: 'audioSent', mediaMs: 4000, atMs: 1100 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 2100 },
  ]);
  const c = onlySettle(truncated.effects);
  assert.equal(c.inject, 'none');
  assert.equal(c.reflect, false);
  assert.equal(c.outcome.truncated, true);
  assert.equal(truncated.state.ledger.lastSettled?.inject, 'none');
});

test('插话当场结算也带 inject（与协程收尾的那次一字不差）', () => {
  const { effects } = reduceKernel(initialKernelState(), [
    { type: 'turnStarted', ticket: ticket(1, 0, 0), atMs: 1000 },
    { type: 'audioStarted', ticket: ticket(1, 0, 0) },
    { type: 'audioSent', mediaMs: 4000, atMs: 1100 },
    { type: 'bargeIn', why: '插话', atMs: 2100 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 2600 },
  ]);
  const settles = effects.filter((e) => e.type === 'settleTurn');
  assert.equal(settles.length, 2);
  const [first, second] = settles;
  if (first?.type !== 'settleTurn' || second?.type !== 'settleTurn') return;
  assert.equal(first.inject, 'none', '4 s 只听 1 s：不注');
  assert.equal(second.inject, first.inject, '收尾那次必须照抄，不许拿空播放区重算');
});

// ---------------------------------------------------------------- KernelRuntime：端口执行

function recordingPorts(sink: string[]): KernelPorts {
  return {
    stopDeviceAudio: () => { sink.push('stop'); },
    invalidateTurn: (t) => { sink.push(`invalidate:${t.no}/${t.gen}`); },
    abortEngine: (reason) => { sink.push(`abort:${reason}`); },
    settleTurn: (turn) => {
      sink.push(
        `settle:${turn.inject}:${turn.truncated ? 'trunc' : 'full'}:${turn.reflect ? 'reflect' : 'keep'}`,
      );
    },
  };
}

test('KernelRuntime.dispatchAndApply：一批意图按序落到端口，settleTurn 带 inject', () => {
  const calls: string[] = [];
  const runtime = new KernelRuntime(initialKernelState(), recordingPorts(calls));

  runtime.dispatchAndApply({ type: 'beginTurn', atMs: 1000, baseCommitSeq: 2, startedAtMs: 1000 });
  const current = runtime.state.dialog.ticket;
  assert.ok(current, 'beginTurn 必须铸票');
  runtime.dispatchAndApply({ type: 'audioStarted', ticket: current });
  runtime.dispatchAndApply({ type: 'audioSent', mediaMs: 4000, atMs: 1100 });
  runtime.dispatchAndApply({ type: 'bargeIn', why: '插话', atMs: 2100 });

  assert.deepEqual(calls, [
    'stop',
    'invalidate:1/0',
    'abort:barge_in',
    'settle:none:trunc:keep',
  ], '顺序与旧内核一致：先停、再作废、再放弃投机、最后结算');
  assert.equal(runtime.state.dialog.phase, 'listening');
});

test('KernelRuntime.dispatch 只推进：绑了端口也不执行（避免双份副作用）', () => {
  const calls: string[] = [];
  const runtime = new KernelRuntime(initialKernelState(), recordingPorts(calls));
  runtime.dispatch({ type: 'beginTurn', atMs: 0 });
  const effects = runtime.dispatch({ type: 'closed' });
  assert.deepEqual(effects.map((e) => e.type), ['invalidateTurn'], '意图照常声明');
  assert.deepEqual(calls, [], '纯推演不执行 —— 执行是 dispatchAndApply 的事');
  assert.equal(runtime.state.dialog.phase, 'closed');
});

test('KernelRuntime.subscribe：单点观测真实转移，退订后不再收到', () => {
  const runtime = new KernelRuntime();
  const seen: string[] = [];
  const off = runtime.subscribe((prev, next, event) => {
    seen.push(`${event.type}:${prev.dialog.phase}→${next.dialog.phase}`);
  });
  runtime.dispatch({ type: 'beginTurn', atMs: 0 });
  runtime.dispatch({ type: 'audioStarted', ticket: runtime.state.dialog.ticket ?? { no: 0, gen: 0 } });
  off();
  runtime.dispatch({ type: 'audioDone', ticket: runtime.state.dialog.ticket ?? { no: 0, gen: 0 } });
  assert.deepEqual(seen, ['beginTurn:listening→thinking', 'audioStarted:thinking→speaking']);
});

test('applyEffects 异常隔离：一个意图抛错不影响后面的意图，并留下日志', () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const ports: KernelPorts = {
    ...recordingPorts(calls),
    stopDeviceAudio: () => { throw new Error('设备已经断了'); },
    log: (line) => { lines.push(line); },
  };
  applyEffects(
    [
      { type: 'stopDeviceAudio' },
      { type: 'abortEngine', reason: 'barge_in' },
    ],
    ports,
  );
  assert.deepEqual(calls, ['abort:barge_in'], '后一条照常执行');
  assert.ok(
    lines.some((line) => line.includes('stopDeviceAudio') && line.includes('设备已经断了')),
    `失败要有日志，实际：${JSON.stringify(lines)}`,
  );
});

// ---------------------------------------------------------------- 相位：内核是唯一真相源

test('beginTurn 只在开轮时锁存水位线；thinking 重入沿用同一张票的基线', () => {
  const first = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 1000, baseCommitSeq: 3, startedAtMs: 1000 },
  ]);
  const t1 = first.state.dialog.ticket;
  assert.deepEqual(t1, { no: 1, gen: 0, baseCommitSeq: 3, startedAtMs: 1000 });

  // 出声前吸收窗口：用户在 thinking 期间又说了一句 —— 轮次 +1，但**基线不刷新**
  const second = step(first.state, {
    type: 'beginTurn',
    atMs: 1500,
    baseCommitSeq: 9,
    startedAtMs: 1500,
  });
  assert.equal(second[0].dialog.turn, 2);
  assert.equal(second[0].dialog.phase, 'thinking');
  assert.deepEqual(
    second[0].dialog.ticket,
    { no: 2, gen: 0, baseCommitSeq: 3, startedAtMs: 1000 },
    '同一轮谱系内部的事，重记会把「开轮前录的那段」判据自己刷新掉',
  );
});

test('插话清票、推进代次，并从 speaking 回 listening', () => {
  const { state } = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0, baseCommitSeq: 1 },
    { type: 'audioStarted', ticket: ticket(1, 0, 1) },
  ]);
  assert.equal(state.dialog.phase, 'speaking');
  const [next] = step(state, { type: 'bargeIn', why: '不用了', atMs: 500 });
  assert.equal(next.dialog.phase, 'listening');
  assert.equal(next.dialog.gen, 1);
  assert.equal(next.dialog.ticket, null);
  assert.equal(next.dialog.endAfterSpeech, false);
  assert.equal(next.dialog.receiptOnly, false);
});

test('插话的因果屏障：开轮前录的那段迟到转写不算插话', () => {
  const opened = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0, baseCommitSeq: 3 },
    { type: 'audioStarted', ticket: ticket(1, 0, 3) },
  ]).state;

  const [stale, staleEffects] = step(opened, {
    type: 'bargeIn',
    why: '迟到的后半句',
    atMs: 900,
    commitSeq: 3,
  });
  assert.deepEqual(staleEffects, [], '开轮前的旧段一个意图都不能有');
  assert.equal(stale.dialog.phase, 'speaking', '也不能把相位动掉');

  const [fresh, freshEffects] = step(opened, {
    type: 'bargeIn',
    why: '真的插话',
    atMs: 900,
    commitSeq: 4,
  });
  assert.equal(fresh.dialog.phase, 'listening');
  assert.deepEqual(freshEffects.map((e) => e.type), [
    'stopDeviceAudio',
    'invalidateTurn',
    'abortEngine',
    'settleTurn',
  ], '一次都没出声的轮次也要结算（inject 会是 unspoken，不是 none）');
});

test('closed 是吸收态：相位拉不回去，只在首次关闭时作废活跃轮次', () => {
  const { state, effects } = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0 },
    { type: 'closed' },
    { type: 'beginTurn', atMs: 10 },
    { type: 'fsmPhase', phase: 'listening' },
    { type: 'turnStarted', ticket: ticket(2), atMs: 20 },
    { type: 'bargeIn', why: '迟到的插话', atMs: 30 },
    { type: 'closed' },
  ]);
  assert.equal(state.dialog.phase, 'closed');
  assert.deepEqual(
    effects.map((e) => e.type),
    ['invalidateTurn'],
    '首次关闭要作废活跃轮次；第二次关闭不再重复',
  );

  // 老档案回放的 `fsmPhase:'closed'` 走同一条路：清票 + 吸收，否则迟到的结算还能认领
  const replayed = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0 },
    { type: 'fsmPhase', phase: 'closed' },
    { type: 'beginTurn', atMs: 10 },
  ]);
  assert.equal(replayed.state.dialog.phase, 'closed');
  assert.equal(replayed.state.dialog.ticket, null);
});

test('DialogFsm 是 KernelRuntime 的薄门面：getter 与内核对得上，订阅只发一次', () => {
  const fsm = new DialogFsm(() => {}, { baseCommitSeq: () => 5, now: () => 1234 });
  const runtime = fsm.runtime;
  const states: Array<{ state: DialogState; why: string }> = [];
  const invalidations: string[] = [];
  fsm.onState((state, why) => { states.push({ state, why }); });
  fsm.onInvalidate((reason) => { invalidations.push(reason); });

  const ticket1 = fsm.beginTurn();
  assert.deepEqual(ticket1, { no: 1, gen: 0, baseCommitSeq: 5, startedAtMs: 1234 });
  assert.equal(runtime.state.dialog.phase, 'thinking');
  assert.equal(runtime.state.dialog.turn, fsm.turn, '轮次只有一份');
  assert.equal(runtime.state.dialog.gen, fsm.gen, '代次只有一份');
  assert.deepEqual(runtime.state.dialog.ticket, fsm.ticket(), '票据只有一份');

  // 回执：进 speaking（可打断），播完回 thinking
  assert.equal(fsm.receiptStarted(), true);
  assert.equal(fsm.state, 'speaking');
  assert.equal(fsm.speakingIsReceiptOnly, true);
  assert.equal(runtime.state.dialog.phase, 'speaking', '门面不私存相位');
  fsm.receiptEnded();
  assert.equal(fsm.state, 'thinking');
  assert.equal(fsm.speakingIsReceiptOnly, false);

  // 真音频接管
  fsm.audioStarted(fsm.ticket());
  assert.equal(fsm.state, 'speaking');
  assert.equal(runtime.state.dialog.ticket?.no, 1);

  // 插话：代次 +1、票清空、通知作废
  assert.equal(fsm.bargeIn('不用了'), true);
  assert.equal(fsm.state, 'listening');
  assert.equal(fsm.gen, 1);
  assert.equal(runtime.state.dialog.ticket, null, '被插话的票不许留在内核里');
  assert.deepEqual(invalidations, ['bargeIn']);

  // 等快门一族
  assert.ok(fsm.beginAwaitShot());
  assert.equal(fsm.state, 'awaiting_shot');
  fsm.abortAwaitShot('改主意');
  assert.equal(fsm.state, 'listening');

  // 收尾：有音频就等播完
  const ticket2 = fsm.beginTurn();
  assert.ok(ticket2);
  fsm.audioStarted(ticket2);
  fsm.requestEnd();
  assert.equal(fsm.state, 'speaking', '告别语不截断');
  assert.equal(fsm.endAfterSpeech, true);
  fsm.audioDone(ticket2);
  assert.equal(fsm.state, 'ending');

  fsm.close();
  assert.equal(fsm.state, 'closed');
  assert.deepEqual(invalidations, ['bargeIn', 'closed']);

  // closed 之后任何迟到回调都不得把相位拉回去
  assert.equal(fsm.beginTurn(), null);
  fsm.audioStarted(ticket2);
  fsm.audioDone(ticket2);
  fsm.requestEnd();
  assert.equal(fsm.bargeIn('迟到的插话'), false);
  assert.equal(fsm.state, 'closed');
  assert.equal(runtime.state.dialog.phase, 'closed');

  // 状态监听者看到的就是内核的转移序列（没有第二次去重/猜测）
  assert.deepEqual(
    states.map((s) => s.state),
    ['thinking', 'speaking', 'thinking', 'speaking', 'listening', 'awaiting_shot', 'listening', 'thinking', 'speaking', 'ending', 'closed'],
  );
  assert.ok(states.some((s) => s.why.includes('插话')), '插话的原因要能读出来（档案靠它判打断）');
});

test('DialogFsm 可以共享同一个 KernelRuntime（Wave 3 的单实例前提）', () => {
  const runtime = new KernelRuntime();
  const a = new DialogFsm(() => {}, {}, runtime);
  const b = new DialogFsm(() => {}, {}, runtime);
  const ticketA = a.beginTurn();
  assert.ok(ticketA);
  assert.equal(b.state, 'thinking', '另一个门面看到的是同一份状态');
  assert.deepEqual(b.ticket(), a.ticket());
  a.audioStarted(ticketA);
  assert.equal(b.state, 'speaking');
  a.close();
  assert.equal(b.state, 'closed');
});

test('门面转发 commitSeq：开轮前录的那段迟到转写不算插话，返回 false', () => {
  const fsm = new DialogFsm(() => {}, { baseCommitSeq: () => 3, now: () => 0 });
  const ticket1 = fsm.beginTurn();
  assert.ok(ticket1);
  assert.equal(ticket1.baseCommitSeq, 3);
  fsm.audioStarted(ticket1);
  assert.equal(fsm.state, 'speaking');

  assert.equal(fsm.bargeIn('迟到的后半句', 3), false, '旧段不构成插话');
  assert.equal(fsm.state, 'speaking', '相位也不该动');
  assert.equal(fsm.gen, 0);

  assert.equal(fsm.bargeIn('真的插话', 4), true);
  assert.equal(fsm.state, 'listening');
  assert.equal(fsm.gen, 1);
});

// ---------------------------------------------------------------- 单一因果谓词

test('isPreTurnCommit：只在有活跃轮次时，≤ 基线的才算旧段', () => {
  const opened = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 1000, baseCommitSeq: 3 },
  ]).state;
  assert.equal(opened.dialog.phase, 'thinking');
  assert.equal(isPreTurnCommit(opened, 3), true, 'thinking：等于基线是开轮前封的那段');
  assert.equal(isPreTurnCommit(opened, 2), true, '更早的更是旧段');
  assert.equal(isPreTurnCommit(opened, 4), false, '开轮之后的新段');
  assert.equal(isPreTurnCommit(opened, undefined), false, '没有出生证就不猜');

  const ticket1 = opened.dialog.ticket;
  assert.ok(ticket1);
  const speaking = step(opened, { type: 'audioStarted', ticket: ticket1 })[0];
  assert.equal(speaking.dialog.phase, 'speaking');
  assert.equal(isPreTurnCommit(speaking, 3), true, 'speaking：同一个判据');
  assert.equal(isPreTurnCommit(speaking, 4), false);

  // 非活跃相位：没有轮次在跑，谈不上"开轮前的旧段"
  for (const phase of ['listening', 'awaiting_shot', 'ending', 'closed'] as const) {
    const state: KernelState = { ...speaking, dialog: { ...speaking.dialog, phase } };
    assert.equal(isPreTurnCommit(state, 0), false, `${phase}：没有活跃轮次`);
    assert.equal(isPreTurnCommit(state, 99), false, `${phase}：新段也不是旧段`);
  }

  // 票上没有水位线（单测 / 装配层没注入）：一律判"不是旧段"
  const noMark = reduceKernel(initialKernelState(), [{ type: 'beginTurn', atMs: 0 }]).state;
  assert.equal(isPreTurnCommit(noMark, 0), false, '没有基线时宁可放过一次插话');
});

test('isPreTurnCommit 与非活跃相位上的 userSpeech 行为一致：反正都不产意图', () => {
  // 回归：旧实现会在 `listening` 里对 `userSpeech` 先判一次旧段。新谓词只在
  // `thinking`/`speaking` 生效 —— 但 `listening` 里本来也打断不了任何东西。
  const listening = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0, baseCommitSeq: 5 },
    { type: 'audioDone', ticket: ticket(1, 0, 5) },
  ]).state;
  assert.equal(listening.dialog.phase, 'listening');
  const [next, effects] = step(listening, {
    type: 'userSpeech',
    commitSeq: 2,
    final: true,
    atMs: 100,
  });
  assert.deepEqual(effects, []);
  assert.equal(next.dialog.phase, 'listening');
});

// ---------------------------------------------------------------- 区域拆分后的新字段

test('initialKernelState(0, lane) 预置账本车道；默认仍是 null', () => {
  assert.equal(initialKernelState().ledger.lastLane, null, '不给就与旧行为一字不差');
  assert.equal(initialKernelState(0, 'dsh').ledger.lastLane, 'dsh');
  const seeded = initialKernelState(7, 'cascade');
  assert.equal(seeded.input.gateSeq, 7);
  assert.equal(seeded.ledger.lastLane, 'cascade');
});

test('invalidateTurn 带原因：插话 bargeIn、关闭 closed，并转发给端口', () => {
  const barge = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0 },
    { type: 'audioStarted', ticket: ticket(1, 0) },
    { type: 'bargeIn', why: '插话', atMs: 10 },
  ]);
  const barged = barge.effects.find((e) => e.type === 'invalidateTurn');
  assert.ok(barged);
  if (barged?.type !== 'invalidateTurn') return;
  assert.equal(barged.reason, 'bargeIn');

  const closed = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 0 },
    { type: 'closed' },
  ]);
  const closing = closed.effects.find((e) => e.type === 'invalidateTurn');
  assert.ok(closing);
  if (closing?.type !== 'invalidateTurn') return;
  assert.equal(closing.reason, 'closed');

  // 端口真的收到第二个参数（装配层据此区分"用户抢话"与"连接断了"）
  const seen: string[] = [];
  const runtime = new KernelRuntime(initialKernelState(), {
    stopDeviceAudio: () => {},
    invalidateTurn: (t, reason) => { seen.push(`${t.no}/${t.gen}:${reason}`); },
    abortEngine: () => {},
    settleTurn: () => {},
  });
  runtime.dispatchAndApply({ type: 'beginTurn', atMs: 0 });
  const first = runtime.state.dialog.ticket;
  assert.ok(first);
  runtime.dispatchAndApply({ type: 'audioStarted', ticket: first });
  runtime.dispatchAndApply({ type: 'bargeIn', why: '插话', atMs: 10 });
  runtime.dispatchAndApply({ type: 'beginTurn', atMs: 20 });
  runtime.dispatchAndApply({ type: 'closed' });
  assert.deepEqual(seen, ['1/0:bargeIn', '2/1:closed'], '作废原因一路透到端口');
});

test('KernelPorts.settleTurn 收到完整结算快照（媒体量 / 车道 / 时刻都在）', () => {
  const settlements: KernelSettlement[] = [];
  const ports: KernelPorts = {
    stopDeviceAudio: () => {},
    invalidateTurn: () => {},
    abortEngine: () => {},
    settleTurn: (turn) => { settlements.push(turn); },
  };
  const runtime = new KernelRuntime(initialKernelState(), ports);
  runtime.dispatchAndApply({ type: 'beginTurn', atMs: 1000, baseCommitSeq: 0 });
  runtime.dispatchAndApply({ type: 'turnAnswered', lane: 'dsh' });
  const current = runtime.state.dialog.ticket;
  assert.ok(current);
  runtime.dispatchAndApply({ type: 'audioStarted', ticket: current });
  runtime.dispatchAndApply({ type: 'audioSent', mediaMs: 4000, atMs: 1100 });
  runtime.dispatchAndApply({ type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 5150 });

  assert.equal(settlements.length, 1, '一次结算只落一次端口');
  const settlement = settlements[0];
  assert.ok(settlement);
  assert.equal(settlement.ticket.no, 1);
  assert.equal(settlement.ticket.gen, 0);
  assert.equal(settlement.truncated, false);
  assert.equal(settlement.reflect, true);
  assert.equal(settlement.inject, 'spoken');
  assert.equal(settlement.heardMs, 4000);
  assert.equal(settlement.totalAudioMs, 4000);
  assert.equal(settlement.lane, 'dsh');
  assert.equal(settlement.endedAtMs, 5150);

  // 账本与端口同源（不是端口层自己又拼了一份）
  const lastSettled = runtime.state.ledger.lastSettled;
  assert.equal(lastSettled?.lane, 'dsh');
  assert.equal(lastSettled?.endedAtMs, 5150);
});

test('幂等重述的结算照抄车道与时刻，与新算的那次一字不差', () => {
  const { effects } = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 1000, baseCommitSeq: 0 },
    { type: 'turnAnswered', lane: 'live' },
    { type: 'audioStarted', ticket: ticket(1, 0, 0) },
    { type: 'audioSent', mediaMs: 1000, atMs: 1100 },
    { type: 'bargeIn', why: '插话', atMs: 2100 },
    { type: 'turnEnded', ticket: ticket(1, 0, 0), atMs: 9000 },
  ]);
  const settles = effects.filter((e) => e.type === 'settleTurn');
  assert.equal(settles.length, 2);
  assert.deepEqual(settles[1], settles[0], '第二次必须是第一次的原样重述（含 lane / endedAtMs）');
});
