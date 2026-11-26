/**
 * 内核可观测性：`TurnReport` 的纯函数、内核落账、`TurnRunner` 的唯一结算出口，
 * 以及延迟报告的两处补丁（`judge.decide` / `llm.first` / `commit_seq`）。
 *
 * 这些断言守的是**「这一轮到底发生了什么」**能不能被复算：
 * - 缺失值必须是 `null`，不能拿 `0` / `-1` 冒充（否则历史基线被伪造）；
 * - 失败轮 / 打断轮 / 关闭轮都必须**恰好**结算一次（以前失败轮连 `turnEnded` 都没发）；
 * - `turn.report` 必须晚于 `turn.end`，且每轮恰好一条；
 * - 跨时钟的 `tts_first_ms` 不能是负数（`CascadeAgent` 的 `Date.now` vs 宿主单调时钟）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AsrFront, type AsrFrontPorts } from '../src/voice/asr-front.ts';
import { DialogFsm } from '../src/dialog-fsm.ts';
import type { EngineEvent, FastVoiceEngine, TurnInput } from '../src/engine-contract.ts';
import { EVENTS } from '../src/events.ts';
import { initialKernelState, reduceKernel, step, type KernelState } from '../src/kernel.ts';
import { computeTurns, parseEvents } from '../src/latency-report.ts';
import { CascadeAgent } from '../src/pipelines/cascade-agent.ts';
import { LiveOrchestrator } from '../src/pipelines/live-orchestrator.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';
import type { AgentProvider, TtsProvider } from '../src/providers.ts';
import { SemanticGate } from '../src/assembler/semantic-gate.ts';
import {
  buildTurnReport,
  resolveTurnStatus,
  turnReportToArchiveFields,
  type TurnReport,
} from '../src/turn-report.ts';
import { TurnRunner, type TurnResult } from '../src/turn-runner.ts';

// ---------------------------------------------------------------- 纯函数

const fullInput = {
  ticket: { no: 3, gen: 1 },
  baseCommitSeq: 7,
  status: 'interrupted' as const,
  path: 'fast' as const,
  lane: 'cascade' as const,
  delegated: true,
  delegateReason: 'task' as const,
  nonBlockingDelegate: true,
  interrupted: true,
  interruptReason: 'bargeIn' as const,
  interruptWhy: '插话「等等」→ 代次 1',
  error: null,
  stale: true,
  truncated: true,
  reflect: false,
  inject: 'none' as const,
  heardMs: 1_200,
  totalAudioMs: 4_000,
  audioBytes: 192_000,
  saidChars: 12,
  startedAtMs: 1_000,
  firstAudioAtMs: 1_350,
  playedAtMs: 2_400,
  endedAtMs: 2_500,
  agentMs: 300,
  llmFirstMs: 120,
  firstTextMs: 130,
  ttsFirstMs: 90,
  dshSession: 'sess-x',
};

test('buildTurnReport：缺省字段一律 null，绝不拿 0 / -1 冒充', () => {
  const report = buildTurnReport({
    ticket: { no: 1, gen: 0 },
    status: 'completed',
    inject: 'spoken',
    startedAtMs: 0,
    endedAtMs: 0,
  });
  assert.equal(report.baseCommitSeq, null);
  assert.equal(report.path, null);
  assert.equal(report.lane, null);
  assert.equal(report.delegateReason, null);
  assert.equal(report.interruptReason, null);
  assert.equal(report.interruptWhy, null);
  assert.equal(report.error, null);
  assert.equal(report.firstAudioAtMs, null);
  assert.equal(report.playedAtMs, null);
  assert.equal(report.agentMs, null);
  assert.equal(report.llmFirstMs, null);
  assert.equal(report.firstTextMs, null);
  assert.equal(report.ttsFirstMs, null);
  assert.equal(report.turnToAudioMs, null, '没出声就不能有「开轮→首块」');
  assert.equal(report.dshSession, null);
  // 计数类字段的 0 是事实（这一轮就是没发字节），不是缺失标记
  assert.equal(report.audioBytes, 0);
  assert.equal(report.saidChars, 0);
  assert.equal(report.heardMs, 0);
  assert.equal(report.totalAudioMs, 0);
});

test('buildTurnReport：负数 / NaN / Infinity 一律收成 null', () => {
  const report = buildTurnReport({
    ticket: { no: 2, gen: 0 },
    status: 'completed',
    inject: 'spoken',
    startedAtMs: 100,
    endedAtMs: 200,
    firstAudioAtMs: 50, // 早于开轮 = 跨时钟/抖动，不允许算出「-50 ms」
    playedAtMs: Number.NaN,
    agentMs: -1,
    llmFirstMs: Number.POSITIVE_INFINITY,
    firstTextMs: -5,
    ttsFirstMs: Number.NaN,
    heardMs: Number.NaN,
  });
  assert.equal(report.turnToAudioMs, null, '负的「开轮→首块」不许伪造 0');
  assert.equal(report.playedAtMs, null);
  assert.equal(report.agentMs, null);
  assert.equal(report.llmFirstMs, null);
  assert.equal(report.firstTextMs, null);
  assert.equal(report.ttsFirstMs, null);
  assert.equal(report.heardMs, 0, '计数类字段非有限时退回 0（不是 null）');
});

test('resolveTurnStatus：失败 > 关闭 > 打断 > 完成', () => {
  assert.equal(resolveTurnStatus({ failed: true, closed: true, interrupted: true }), 'failed');
  assert.equal(resolveTurnStatus({ failed: false, closed: true, interrupted: true }), 'closed');
  assert.equal(resolveTurnStatus({ failed: false, closed: false, interrupted: true }), 'interrupted');
  assert.equal(resolveTurnStatus({ failed: false, closed: false, interrupted: false }), 'completed');
});

test('turnReportToArchiveFields：扁平 snake_case、显式 null、played_ms 派生', () => {
  const report = buildTurnReport(fullInput);
  const fields = turnReportToArchiveFields(report);
  assert.equal(fields['turn'], 3);
  assert.equal(fields['gen'], 1);
  assert.equal(fields['base_commit_seq'], 7);
  assert.equal(fields['status'], 'interrupted');
  assert.equal(fields['path'], 'fast');
  assert.equal(fields['lane'], 'cascade');
  assert.equal(fields['delegated'], true);
  assert.equal(fields['delegate_reason'], 'task');
  assert.equal(fields['non_blocking_delegate'], true);
  assert.equal(fields['interrupt_reason'], 'bargeIn');
  assert.equal(fields['interrupt_why'], '插话「等等」→ 代次 1');
  assert.equal(fields['error'], null, '显式 null 也要写出来（省略分不清「没量到」和「没这个字段」）');
  assert.equal(fields['stale'], true);
  assert.equal(fields['truncated'], true);
  assert.equal(fields['reflect'], false);
  assert.equal(fields['inject'], 'none');
  assert.equal(fields['heard_ms'], 1_200);
  assert.equal(fields['total_audio_ms'], 4_000);
  assert.equal(fields['audio_bytes'], 192_000);
  assert.equal(fields['said_chars'], 12);
  assert.equal(fields['agent_ms'], 300);
  assert.equal(fields['llm_first_ms'], 120);
  assert.equal(fields['first_text_ms'], 130);
  assert.equal(fields['tts_first_ms'], 90);
  assert.equal(fields['turn_to_audio_ms'], 350);
  assert.equal(fields['played_ms'], 1_050, 'played_ms = 播完回执 − 首块下发');
  assert.equal(fields['dsh_session'], 'sess-x');
  assert.equal('turn' in fields, true);

  const noPlay = turnReportToArchiveFields(buildTurnReport({
    ticket: { no: 4, gen: 0 },
    status: 'completed',
    inject: 'spoken',
    startedAtMs: 0,
    firstAudioAtMs: 100,
    endedAtMs: 200,
  }));
  assert.equal(noPlay['played_ms'], null, '没回执时 played_ms 必须是 null，不是 0');
});

// ---------------------------------------------------------------- 内核落账

test('kernel.turnReport：只写 ledger.lastReport，不改相位、不产 Effect', () => {
  const before = reduceKernel(initialKernelState(), [
    { type: 'beginTurn', atMs: 1_000, baseCommitSeq: 2 },
    { type: 'audioStarted', ticket: { no: 1, gen: 0 } },
  ]).state;
  const report = buildTurnReport({
    ticket: { no: 1, gen: 0 },
    baseCommitSeq: 2,
    status: 'completed',
    inject: 'spoken',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
  });
  const [after, effects] = step(before, { type: 'turnReport', report });
  assert.deepEqual(effects, [], '快照不是判定，一个意图都不能有');
  assert.deepEqual(after.dialog, before.dialog, '相位、票据一个字都不许动');
  assert.deepEqual(after.playback, before.playback);
  assert.equal(after.ledger.lastReport, report);
  assert.equal(after.ledger.lastSettled, before.ledger.lastSettled);
});

test('kernel.turnReport：连接进了吸收态 closed 之后仍能落账，且相位不变', () => {
  const closed = reduceKernel(initialKernelState(), [{ type: 'closed' }]).state;
  assert.equal(closed.dialog.phase, 'closed');
  const report = buildTurnReport({
    ticket: { no: 1, gen: 0 },
    status: 'failed',
    error: 'boom',
    inject: 'none',
    startedAtMs: 0,
    endedAtMs: 10,
  });
  const [after, effects] = step(closed, { type: 'turnReport', report });
  assert.equal(after.dialog.phase, 'closed', 'closed 是吸收态，落账也不许拉回来');
  assert.deepEqual(effects, []);
  assert.equal(after.ledger.lastReport?.status, 'failed');
  assert.equal(after.ledger.lastReport?.error, 'boom');
});

test('kernel.turnEnded：清空播放区时也重置 playedAtMs（不留上一轮的回执）', () => {
  const [before] = [
    reduceKernel(initialKernelState(), [
      { type: 'beginTurn', atMs: 0 },
      { type: 'audioSent', mediaMs: 1_000, atMs: 10 },
      { type: 'devicePlayed', atMs: 1_100 },
    ]).state,
  ];
  assert.equal(before.playback.playedAtMs, 1_100);
  const [after] = step(before, { type: 'turnEnded', ticket: { no: 1, gen: 0 }, atMs: 1_200 });
  assert.equal(after.playback.ticket, null);
  assert.equal(after.playback.playedAtMs, null, '空播放区里不许残留「播完时刻」');
});

// ---------------------------------------------------------------- TurnRunner 集成

const LOUD = Buffer.alloc(480, 1);

function scripted(events: readonly EngineEvent[], onAbortWait = false): FastVoiceEngine {
  return {
    mode: 'cascade',
    isHealthy: () => true,
    abortSpeculation: () => {},
    async *respond(_turn: TurnInput, signal: AbortSignal) {
      for (const ev of events) {
        yield ev;
      }
      if (onAbortWait) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => { resolve(); }, { once: true });
        });
      }
    },
  };
}

interface Harness {
  readonly runner: TurnRunner;
  readonly fsm: DialogFsm;
  readonly vclock: VirtualClock;
  readonly payloads: Array<{ name: string; data: Record<string, unknown> }>;
  /** 内核真实转移的事件名序列（`turnReport` 必须晚于 `turnEnded`） */
  readonly kernelSeq: string[];
  run(): Promise<TurnResult | null>;
  settle(): Promise<void>;
}

function harness(engine: FastVoiceEngine): Harness {
  const vclock = new VirtualClock();
  const payloads: Array<{ name: string; data: Record<string, unknown> }> = [];
  const kernelSeq: string[] = [];
  const fsm = new DialogFsm(() => {}, { now: () => vclock.now() });
  fsm.runtime.subscribe((_prev, _next, event) => { kernelSeq.push(event.type); });
  const agent: AgentProvider = {
    name: 'fake',
    sessionId: 'sess-test',
    reply: async () => { throw new Error('注入了引擎就不该调 agent.reply'); },
  };
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async *synthesize() { yield LOUD; },
  };
  const runner = new TurnRunner({
    clock: vclock,
    agent,
    tts,
    downlink: { sendAudio: () => {}, sendControl: () => {} },
    fsm,
    playbackTailMs: 0,
    engine,
    onEvent: (name, data) => { payloads.push({ name, data: data ?? {} }); },
    onTurnFinished: () => {},
    log: () => {},
  });
  return {
    runner,
    fsm,
    vclock,
    payloads,
    kernelSeq,
    run: () => runner.run('你好'),
    settle: async () => { await vclock.runUntil(vclock.now() + 500); },
  };
}

function reportOf(h: Harness, turn: number): Record<string, unknown> {
  const found = h.payloads.filter((p) => p.name === EVENTS.turnReport && p.data['turn'] === turn);
  assert.equal(found.length, 1, `第 ${turn} 轮必须恰好一条 turn.report，实际 ${found.length}`);
  return found[0]!.data;
}

function endOf(h: Harness, turn = 1): Record<string, unknown> {
  const found = h.payloads.filter((p) => p.name === EVENTS.turnEnd);
  assert.ok(found.length >= turn, `缺第 ${turn} 条 turn.end`);
  return found[turn - 1]!.data;
}

test('TurnRunner 正常轮（fast）：恰好一份报告、晚于 turnEnded、旧 turn.end 字段齐全', async () => {
  const h = harness(scripted([
    { type: 'meta', path: 'fast', firstTokenMs: 120 },
    { type: 'text', delta: '你好。' },
    { type: 'audio', pcm: LOUD, sampleRate: 24_000 },
    { type: 'done', fullText: '你好。', speech: '你好。' },
  ]));
  const pending = h.run();
  await h.settle();
  const result = await pending;
  assert.ok(result);
  assert.equal(result.interrupted, false);

  // 内核：恰好一次 turnEnded、恰好一次 turnReport，且顺序正确
  assert.equal(h.kernelSeq.filter((t) => t === 'turnEnded').length, 1);
  assert.equal(h.kernelSeq.filter((t) => t === 'turnReport').length, 1);
  assert.ok(
    h.kernelSeq.indexOf('turnReport') > h.kernelSeq.indexOf('turnEnded'),
    `turnReport 必须在 turnEnded 之后：${h.kernelSeq.join(',')}`,
  );
  const endAt = h.payloads.findIndex((p) => p.name === EVENTS.turnEnd);
  const reportAt = h.payloads.findIndex((p) => p.name === EVENTS.turnReport);
  assert.ok(reportAt > endAt, '档案里 turn.report 也要晚于 turn.end');

  // 旧 turn.end 零变化：字段都在、语义不动
  const end = endOf(h);
  assert.equal(end['failed'], undefined, '成功轮不该带 failed');
  assert.equal(end['interrupted'], false);
  assert.equal(end['truncated'], false);
  assert.equal(end['path'], 'fast');
  assert.equal(end['delegate'], undefined);
  assert.equal(end['said'], '你好。');
  assert.equal(end['said_chars'], 3);
  assert.equal(typeof end['dsh_ms'], 'number');
  assert.equal(end['dsh_session'], 'sess-test');

  // 新报告：结构完整
  const report = reportOf(h, 1);
  assert.equal(report['status'], 'completed');
  assert.equal(report['path'], 'fast');
  assert.equal(report['lane'], 'cascade');
  assert.equal(report['llm_first_ms'], 120);
  assert.equal(report['first_text_ms'], 0, '第一个文本增量就在开轮同一刻');
  assert.equal(report['tts_first_ms'], null, '引擎没报合成起点时如实记 null');
  assert.equal(report['turn_to_audio_ms'], 0);
  assert.equal(report['played_ms'], null);
  assert.equal(report['dsh_session'], 'sess-test');
  assert.equal(report['inject'], 'spoken');
  assert.equal(report['said_chars'], 3);

  const kernelReport = h.fsm.runtime.state.ledger.lastReport;
  assert.ok(kernelReport);
  assert.equal(kernelReport.status, 'completed');
  assert.equal(kernelReport.ticket.no, 1);
  assert.equal(h.fsm.runtime.state.ledger.lastSettled?.ticket.no, 1);
});

test('TurnRunner 正常轮（dsh）：委派原因进报告，llm.first 照旧落档', async () => {
  const h = harness(scripted([
    { type: 'meta', path: 'dsh', delegate: 'task', firstTokenMs: 280 },
    { type: 'audio', pcm: LOUD, sampleRate: 24_000 },
    { type: 'done', fullText: '答案。', speech: '答案。' },
  ]));
  const pending = h.run();
  await h.settle();
  await pending;
  const report = reportOf(h, 1);
  assert.equal(report['path'], 'dsh');
  assert.equal(report['delegate_reason'], 'task');
  assert.equal(report['llm_first_ms'], 280);
  assert.equal(
    h.payloads.find((p) => p.name === EVENTS.llmFirst)?.data['ms'],
    280,
    '既有 llm.first 事件不能丢',
  );
});

test('TurnRunner 正常轮（omni 直出）：llmFirstMs 必须是 null，firstTextMs 可采', async () => {
  const h = harness(scripted([
    { type: 'meta', path: 'omni' },
    { type: 'text', delta: '在的。' },
    { type: 'audio', pcm: LOUD, sampleRate: 24_000 },
    { type: 'done', fullText: '在的。', speech: '在的。' },
  ]));
  const pending = h.run();
  await h.settle();
  await pending;
  const report = reportOf(h, 1);
  assert.equal(report['path'], 'omni');
  assert.equal(report['llm_first_ms'], null, 'omni 直出没有「首 token」这个相位');
  assert.equal(typeof report['first_text_ms'], 'number', 'omni 的转写增量也是文本');
  assert.ok((report['first_text_ms'] as number) >= 0);
});

test('TurnRunner 失败轮：catch 补发 turnEnded、账本落在本轮、恰好一条 failed 报告', async () => {
  let fail = false;
  const engine: FastVoiceEngine = {
    mode: 'cascade',
    isHealthy: () => true,
    abortSpeculation: () => {},
    async *respond() {
      yield { type: 'meta', path: 'fast', firstTokenMs: 30 };
      yield { type: 'audio', pcm: LOUD, sampleRate: 24_000 };
      if (fail) {
        throw new Error('engine boom');
      }
      yield { type: 'done', fullText: '好。', speech: '好。' };
    },
  };
  const h = harness(engine);
  const first = h.run();
  await h.settle();
  await first;
  assert.equal(h.fsm.runtime.state.ledger.lastSettled?.ticket.no, 1);

  fail = true;
  const second = h.run();
  await h.settle();
  const result = await second;
  assert.equal(result, null, '失败轮仍然返回 null');

  // bug 1 修复：账本与播放区都推进到本轮，不再停在上一轮
  const ledger = h.fsm.runtime.state.ledger;
  assert.equal(ledger.lastSettled?.ticket.no, 2, '失败轮必须结算自己（旧实现停在上一轮）');
  assert.equal(h.fsm.runtime.state.playback.ticket, null, '播放区必须清空');
  assert.equal(ledger.lastReport?.status, 'failed');
  assert.equal(ledger.lastReport?.error, 'engine boom');

  const end = endOf(h, 2);
  assert.equal(end['failed'], true);
  assert.equal(typeof end['dsh_ms'], 'number');
  const report = reportOf(h, 2);
  assert.equal(report['status'], 'failed');
  assert.equal(report['error'], 'engine boom');
  assert.equal(report['interrupt_reason'], null, '失败不是打断');
  assert.equal(h.payloads.filter((p) => p.name === EVENTS.turnReport).length, 2, '每轮各一条');
});

test('TurnRunner 打断轮：interrupted 单调、原因 bargeIn、why 非空', async () => {
  const h = harness(scripted([
    { type: 'meta', path: 'fast' },
    { type: 'audio', pcm: Buffer.alloc(48_000, 1), sampleRate: 24_000 }, // 1 s
  ], true));
  const pending = h.run();
  await h.vclock.drain();
  assert.equal(h.fsm.state, 'speaking', '要先出声，插话才成立');
  assert.equal(h.fsm.bargeIn('等等'), true);
  // 再开一轮把票顶掉：弱原因（superseded）不许盖住强原因（bargeIn）
  const next = h.fsm.beginTurn();
  assert.ok(next);
  await h.vclock.drain();
  const result = await pending;

  assert.ok(result);
  assert.equal(result.interrupted, true, '票据被顶掉也要保持 interrupted');
  const report = reportOf(h, 1);
  assert.equal(report['status'], 'interrupted');
  assert.equal(report['interrupted'], true);
  assert.equal(report['interrupt_reason'], 'bargeIn', '首次设定的强原因不许被 superseded 覆盖');
  assert.equal(typeof report['interrupt_why'], 'string');
  assert.ok((report['interrupt_why'] as string).includes('插话'));
  assert.equal(h.fsm.runtime.state.ledger.lastReport?.status, 'interrupted');
});

test('TurnRunner 关闭轮：status=closed、原因 closed，吸收态后仍落账', async () => {
  const h = harness(scripted([
    { type: 'meta', path: 'fast' },
    { type: 'audio', pcm: LOUD, sampleRate: 24_000 },
  ], true));
  const pending = h.run();
  await h.vclock.drain();
  assert.equal(h.fsm.state, 'speaking');
  h.fsm.close();
  await h.vclock.drain();
  await pending;
  assert.equal(h.fsm.state, 'closed');
  const report = reportOf(h, 1);
  assert.equal(report['status'], 'closed');
  assert.equal(report['interrupt_reason'], 'closed');
  assert.equal(h.fsm.runtime.state.ledger.lastReport?.status, 'closed', '关闭之后仍然写入账本');
});

test('TurnRunner 委派 & 非阻塞委派：三个字段完整进入 lastReport 与 turn.report', async () => {
  const h = harness(scripted([
    { type: 'meta', path: 'omni', delegate: 'task', nonBlocking: true },
    { type: 'delegate', reason: 'task', rewrittenQuery: '查天气' },
    { type: 'audio', pcm: LOUD, sampleRate: 24_000 },
    { type: 'done', fullText: '我查查。', speech: '我查查。' },
  ]));
  const pending = h.run();
  await h.settle();
  await pending;
  const report = reportOf(h, 1);
  assert.equal(report['delegated'], true);
  assert.equal(report['delegate_reason'], 'task');
  assert.equal(report['non_blocking_delegate'], true);
  const kernelReport: TurnReport | null = h.fsm.runtime.state.ledger.lastReport;
  assert.ok(kernelReport);
  assert.equal(kernelReport.delegated, true);
  assert.equal(kernelReport.delegateReason, 'task');
  assert.equal(kernelReport.nonBlockingDelegate, true);
  // 非阻塞垫话不是 omni 答完的一轮：不许写 noteServedTurn（这里没有 agent 记录，只验证口径没有崩）
  assert.equal(report['path'], 'omni');
});

test('跨时钟：CascadeAgent 用 Date.now、宿主用虚拟时钟，tts_first_ms 仍是同源正数', async () => {
  let big = 1_700_000_000_000;
  let innerSink: ((text: string) => void) | null = null;
  const cascade = new CascadeAgent({
    inner: {
      name: 'fake-dsh',
      attachLiveSink: (sink) => { innerSink = sink; },
      reply: async () => {
        // 真 dsh 也是流式吐字的：引擎的 `markSynth` 由这条增量触发
        innerSink?.('[平静]答');
        return { text: '[平静]答', speech: '答' };
      },
    },
    // 引擎的时钟是 epoch 毫秒，宿主是进程单调毫秒 —— 旧实现两者相减会记负数
    now: () => { big += 7; return big; },
    log: () => {},
  });
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async *synthesize() { yield LOUD; },
    async *synthesizeStream(chunks) {
      for await (const chunk of chunks) {
        void chunk;
        yield LOUD;
      }
    },
  };
  const engine = cascade.toEngine(tts, { now: () => { big += 7; return big; } });
  const h = harness(engine);
  const pending = h.run();
  await h.settle();
  await pending;
  const end = endOf(h);
  const ttsFirst = end['tts_first_ms'];
  assert.equal(typeof ttsFirst, 'number');
  assert.ok((ttsFirst as number) >= 0, `跨时钟不许算出负数，实际 ${String(ttsFirst)}`);
  const report = reportOf(h, 1);
  assert.equal(report['tts_first_ms'], ttsFirst, 'turn.end 与 turn.report 同源');
  assert.equal(typeof report['first_text_ms'], 'number');
});

test('Live fallbackDsh：firstTokenMs 透出进 llm.first 与 lastReport', async () => {
  const inner: AgentProvider = {
    name: 'dsh',
    reply: async () => ({ text: '慢车道答案。', speech: '慢车道答案。', firstTokenMs: 88 }),
  };
  const host = new LiveOrchestrator({ inner, log: () => {} });
  const h = harness(host.toEngine());
  const pending = h.run();
  await h.vclock.drain();
  await pending;
  assert.equal(h.payloads.find((p) => p.name === EVENTS.llmFirst)?.data['ms'], 88);
  const report = reportOf(h, 1);
  assert.equal(report['path'], 'dsh');
  assert.equal(report['llm_first_ms'], 88);
  assert.equal(h.fsm.runtime.state.ledger.lastReport?.llmFirstMs, 88);
});

// ---------------------------------------------------------------- 延迟报告补丁

function jsonl(rows: ReadonlyArray<{ t: number; [key: string]: unknown }>): string {
  return [...rows]
    .sort((a, b) => a.t - b.t)
    .map((row) => JSON.stringify(row))
    .join('\n');
}

/** 一轮的最小骨架：停嘴 → 定稿 → 开轮 → 首块 → 结束 */
function turnRows(options: {
  readonly stop: number;
  readonly asrToTurn: number;
  readonly judge?: ReadonlyArray<{ action: string; waitedMs: number; offset: number }>;
  readonly llmFirstMs?: number;
}): Array<{ t: number; [key: string]: unknown }> {
  const GAP = 2_000;
  const asrAt = options.stop + 300;
  const openAt = asrAt + options.asrToTurn;
  const rows: Array<{ t: number; [key: string]: unknown }> = [
    { t: options.stop + GAP, ev: 'gate.close', gapMs: GAP },
    { t: asrAt, ev: 'asr.sentence', text: '今天风挺大。' },
    { t: openAt, ev: 'turn.start' },
    { t: openAt + 300, ev: 'tts.first', ms: 300 },
    { t: openAt + 800, ev: 'turn.end', interrupted: false, dsh_ms: 120, path: 'fast' },
  ];
  for (const judge of options.judge ?? []) {
    rows.push({
      t: options.stop + judge.offset,
      ev: 'judge.decide',
      action: judge.action,
      waitedMs: judge.waitedMs,
      p: 0.5,
    });
  }
  if (options.llmFirstMs !== undefined) {
    rows.push({ t: openAt + 100, ev: 'llm.first', ms: options.llmFirstMs });
  }
  return rows;
}

test('latency-report：有 judge.decide 时按 action 判「等没等」，不再看 asrToTurn', () => {
  // accept + ②=310 ms：旧代理会误报「等了」
  const accepted = computeTurns(parseEvents(jsonl(turnRows({
    stop: 1_000,
    asrToTurn: 310,
    judge: [{ action: 'accept', waitedMs: 0, offset: 320 }],
  }))));
  assert.equal(accepted[0]?.asrToTurn, 310);
  assert.equal(accepted[0]?.waitedInJudge, false, 'accept 就是没等，哪怕 ② 很大');
  assert.equal(accepted[0]?.judgeWaitedMs, 0);

  // extend + ②=1 ms：旧代理会漏报
  const extended = computeTurns(parseEvents(jsonl(turnRows({
    stop: 1_000,
    asrToTurn: 1,
    judge: [
      { action: 'extend', waitedMs: 200, offset: 300 },
      { action: 'accept', waitedMs: 400, offset: 301 },
    ],
  }))));
  assert.equal(extended[0]?.asrToTurn, 1);
  assert.equal(extended[0]?.waitedInJudge, true, 'extend 就是等了，哪怕 ② 只有 1 ms');
  assert.equal(extended[0]?.judgeWaitedMs, 400, '累计等待取最大/末次');
});

test('latency-report：没有 judge.decide（旧档案）时退回 asrToTurn >= 100', () => {
  const slow = computeTurns(parseEvents(jsonl(turnRows({ stop: 1_000, asrToTurn: 310 }))));
  const fast = computeTurns(parseEvents(jsonl(turnRows({ stop: 5_000, asrToTurn: 70 }))));
  assert.equal(slow[0]?.waitedInJudge, true);
  assert.equal(slow[0]?.judgeWaitedMs, null);
  assert.equal(fast[0]?.waitedInJudge, false);
});

test('latency-report：llm.first 落进 TurnLatency.llmFirstMs', () => {
  const turns = computeTurns(parseEvents(jsonl(turnRows({
    stop: 1_000,
    asrToTurn: 20,
    llmFirstMs: 143,
  }))));
  assert.equal(turns[0]?.llmFirstMs, 143);
});

test('latency-report：turn.report 的 llm_first_ms 是 llm.first 缺席时的退路', () => {
  const rows = turnRows({ stop: 1_000, asrToTurn: 20 });
  rows.push({
    t: 1_300 + 900,
    ev: 'turn.report',
    turn: 1,
    status: 'completed',
    llm_first_ms: 222,
  });
  const turns = computeTurns(parseEvents(jsonl(rows)));
  assert.equal(turns[0]?.llmFirstMs, 222);

  const neither = computeTurns(parseEvents(jsonl(turnRows({ stop: 1_000, asrToTurn: 20 }))));
  assert.equal(neither[0]?.llmFirstMs, null, '两边都没有就记 null，不拿 0 冒充');
});

test('latency-report：commit_seq 命中的那一条才算 ①b（不被最近的 commit 带偏）', () => {
  const rows = [
    { t: 3_066, ev: 'asr.commit', seq: 1 },
    { t: 3_206, ev: 'asr.commit', seq: 2 },
    { t: 3_253, ev: 'asr.sentence', text: '猫和狗哪个？', commit_seq: 2 },
    { t: 3_273, ev: 'turn.start' },
    { t: 3_873, ev: 'tts.first', ms: 600 },
    { t: 4_400, ev: 'turn.end', interrupted: false, dsh_ms: 180, path: 'fast' },
    { t: 5_000, ev: 'gate.close', gapMs: 2_000 },      // 停嘴 3000
  ];
  const turn = computeTurns(parseEvents(jsonl(rows)))[0];
  assert.equal(turn?.commitCount, 2);
  assert.equal(turn?.commitToFinalMs, 47, '3253 − 3206；从第一条算会得到 187');
  assert.equal(turn?.stopToCommitMs, 206, '①a 仍然取最近一条');
  assert.equal(turn?.silenceToAsr, 253);
});

test('latency-report：老档案（无 commit_seq）多封段仍记 null —— 原判据不变', () => {
  const rows = [
    { t: 5_000, ev: 'gate.close', gapMs: 2_000 },
    { t: 5_066, ev: 'asr.commit', seq: 1 },
    { t: 5_206, ev: 'asr.commit', seq: 2 },
    { t: 5_253, ev: 'asr.sentence', text: '猫和狗哪个？' },
    { t: 5_273, ev: 'turn.start' },
    { t: 5_873, ev: 'tts.first', ms: 600 },
    { t: 6_400, ev: 'turn.end', interrupted: false, dsh_ms: 180, path: 'fast' },
  ];
  const turn = computeTurns(parseEvents(jsonl(rows)))[0];
  assert.equal(turn?.commitToFinalMs, null);
});

// ---------------------------------------------------------------- 语义判停 + ASR 出生证

function budget(): Parameters<SemanticGate['allowsFlush']>[2] {
  return {
    extensions: 0,
    unsureExtensions: 0,
    maxExtensions: 1,
    extendMs: 200,
    waitBudget: 400,
    overBudget: false,
  };
}

test('SemanticGate：真的 await 语义时才回调一次 onSemanticWait', async () => {
  let clock = 1_000;
  const seen: Array<{ waitedMs: number; verdict: string; budgetMs: number }> = [];
  const gate = new SemanticGate({
    semanticEndpoint: async () => 'more',
    semanticBudgetMs: 300,
    extendMs: 200,
    fragmentWaitMs: 400,
    hasPredictor: true,
    now: () => { clock += 21; return clock; },
    lastVoicedAtMs: () => 0,
    log: () => {},
    onSemanticWait: (fact) => { seen.push(fact); },
  });
  const decision = await gate.allowsFlush('今天风挺大', 0.5, budget(), () => false);
  assert.equal(decision.action, 'extend');
  assert.equal(seen.length, 1, '只在这一个分支回调一次');
  assert.equal(seen[0]?.verdict, 'more');
  assert.equal(seen[0]?.budgetMs, 300);
  assert.equal(seen[0]?.waitedMs, 21, '两把 now() 之差');
});

test('SemanticGate：高把握的完整句不等语义 → 不回调', async () => {
  let calls = 0;
  let clock = 0;
  const gate = new SemanticGate({
    semanticEndpoint: async () => 'more',
    extendMs: 200,
    fragmentWaitMs: 400,
    hasPredictor: true,
    now: () => { clock += 5; return clock; },
    lastVoicedAtMs: () => 0,
    log: () => {},
    onSemanticWait: () => { calls += 1; },
  });
  const decision = await gate.allowsFlush('今天风挺大。', 0.9, budget(), () => false);
  assert.equal(decision.action, 'flush');
  assert.equal(calls, 0, '0 ms 的分支不许产生事件');
});

test('asr-front：onSentence 在 asr.sentence 上带 commit_seq（两条落档路径都带）', () => {
  const archived: Array<{ name: string; fields?: Record<string, unknown> }> = [];
  const ports: AsrFrontPorts = {
    now: () => 10,
    lastVoicedAtMs: () => 10,
    isSpeaking: () => false,
    generation: () => 0,
    dispatch: () => [],
    notePartial: () => {},
    userPartial: () => {},
    emitAsr: () => {},
    archive: (name, fields) => { archived.push(fields === undefined ? { name } : { name, fields }); },
    decodeSettled: () => {},
  };
  const front = new AsrFront(ports);
  front.onSentence('你好。', 3, 7);
  const sentence = archived.find((entry) => entry.name === EVENTS.asrSentence);
  assert.ok(sentence?.fields);
  assert.equal(sentence.fields['commit_seq'], 7);
  assert.equal(sentence.fields['index'], 3);

  archived.length = 0;
  front.onSentence('没有序号。', 4);
  const noStamp = archived.find((entry) => entry.name === EVENTS.asrSentence);
  assert.ok(noStamp?.fields);
  assert.equal('commit_seq' in noStamp.fields, false, 'ASR 不提供序号时不写这个键');

  // 开轮前旧段那条 `dropped: 'pre-turn'` 落档也要带出生证
  archived.length = 0;
  const preTurn = new AsrFront({
    ...ports,
    // 定稿之后又有新声音 → 不算重复解码，会走到 dispatch
    lastVoicedAtMs: () => 20,
    dispatch: () => [{ type: 'drop', why: 'pre-turn' }],
  });
  preTurn.onSentence('开轮前录的。', 5, 9);
  const dropped = archived.filter((entry) => entry.name === EVENTS.asrSentence);
  const droppedRow = dropped.find((entry) => entry.fields?.['dropped'] === 'pre-turn');
  assert.ok(droppedRow?.fields, `缺 dropped 行：${JSON.stringify(archived)}`);
  assert.equal(droppedRow.fields['commit_seq'], 9);
});

// ---------------------------------------------------------------- 类型层面的护栏

test('TurnReport 的字段是只读快照：写入内核后原对象不被改写', () => {
  const state: KernelState = reduceKernel(initialKernelState(), []).state;
  const report = buildTurnReport({
    ticket: { no: 1, gen: 0 },
    status: 'completed',
    inject: 'spoken',
    startedAtMs: 0,
    endedAtMs: 1,
  });
  const [next] = step(state, { type: 'turnReport', report });
  assert.equal(next.ledger.lastReport, report);
  assert.notEqual(next, state, '状态是新的对象（纯函数），但快照本身按引用锁存');
  assert.equal(state.ledger.lastReport, null, '旧状态不被改写');
});
