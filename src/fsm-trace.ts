/**
 * 会话档案的**时序与状态轮转**审计。
 *
 * 这不是评测任务做没做成（那是 τ² 的 reward），而是问：这一场里
 * 「停嘴 → ASR → 开轮 → 首块 → 播完」这条链，和 `listening → thinking → speaking →
 * listening` 这套状态轮转，**有没有一处不符合设计**。
 *
 * 判据全部来自代码里已经写死的事实，不引入新策略：
 *
 * | 规则 | 依据 |
 * |---|---|
 * | 轮次不许嵌套、必须成对 | `TurnRunner.run` 由 `serialChain` 串行，`beginTurn` 只从 listening 开 |
 * | 状态转移只走白名单 | `DialogFsm.transition` 的调用点 |
 * | `closed` 之后不再动 | `transition` 里的吸收态 |
 * | `tts.first` 必须落在本轮、且在 `speaking` 之后 | `emit` 里先 `audioStarted` 再下发 |
 * | 插话必须带 `audio.stop` | `SessionCore` 的 `bargeIn` 分支 |
 * | 一轮不许挂太久 | `DEFAULT_TIMEOUT_MS` + 播放上限 |
 *
 * 缺仪表**不算违规**：老档案没有 `dialog.state` 事件，那就把状态相关的几条标成
 * `skipped`，不拿「没记录」冒充「没问题」（与 `latency-report` 的 null 口径一致）。
 */

import { computeTurns } from './latency-report.ts';

/** 档案里的一行（`events.jsonl`）。字段随事件而变，这里只钉住复查要用的。 */
export interface TraceEvent {
  readonly t: number;
  readonly ev: string;
  readonly [key: string]: unknown;
}

export interface Violation {
  /** 出事时刻（相对连接开始的毫秒） */
  readonly at: number;
  /** 规则代号，测试和报告都按它对齐 */
  readonly rule: string;
  readonly detail: string;
}

/** 一轮的分段（与 `latency-report` / `bench/replay` 同一套口径） */
export interface TurnSpan {
  readonly no: number;
  readonly startAt: number;
  readonly endAt: number | null;
  readonly interrupted: boolean;
  /** 停嘴（`gate.close.t - gapMs`）→ 首块；缺仪表为 null */
  readonly stopToFirstMs: number | null;
  /** `asr.sentence` → 开轮 */
  readonly sentenceToTurnMs: number | null;
  /** 开轮 → 首块 */
  readonly turnToFirstMs: number | null;
}

export interface AuditResult {
  readonly turns: readonly TurnSpan[];
  readonly violations: readonly Violation[];
  /** 没跑到的规则（缺仪表） */
  readonly skipped: readonly string[];
  readonly states: number;
}

export interface AuditOptions {
  /** 一轮从开轮到结束最多允许多久（默认 45 s：`DEFAULT_TIMEOUT_MS` 60 s 内，留余量） */
  readonly maxTurnMs?: number;
  /** 停嘴到首块最多允许多久（默认 15 s；超了就是"用户以为它聋了"） */
  readonly maxStopToFirstMs?: number;
  /** 被判为插话后，`audio.stop` 必须在这么久内发出（默认 500 ms） */
  readonly bargeStopWithinMs?: number;
}

const DEFAULT_MAX_TURN_MS = 45_000;
const DEFAULT_MAX_STOP_TO_FIRST_MS = 15_000;
const DEFAULT_BARGE_STOP_WITHIN_MS = 500;

/**
 * `DialogFsm` 允许的转移。
 *
 * 直接照抄 `dialog-fsm.ts` 的调用点：`beginTurn` / `beginAwaitShot` / `abortAwaitShot` /
 * `audioStarted` / `receiptStarted` / `receiptEnded` / `audioDone` / `requestEnd` /
 * `bargeIn` / `close`。多一条少一条这里都会红 —— 这正是「状态轮转是否可靠」要看的。
 *
 * `speaking → thinking` 只来自 `receiptEnded()`：委派轮的回执在 `thinking` 期间
 * 出声，靠进 `speaking` 才可打断（见 `DialogFsm` 顶部约束 1）。真回答的音频
 * 结束走的是 `audioDone`，落点是 `listening` / `ending`，不会到 `thinking`。
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  listening: ['thinking', 'awaiting_shot', 'ending', 'closed'],
  awaiting_shot: ['thinking', 'listening', 'ending', 'closed'],
  thinking: ['speaking', 'listening', 'ending', 'closed'],
  speaking: ['listening', 'thinking', 'ending', 'closed'],
  ending: ['closed'],
  closed: [],
};

/**
 * 这一条 `agent.lane` 是不是「该 omni 答却退回级联」。
 *
 * `agent.lane` 的格式换过一代（见 `docs/state-machines.md` §5.6），判据必须两种都认：
 *
 * - **新格式** `{has_lane, lane_ok, ok, lane, why}`：`text_ok` 已经被移除，老的
 *   `lane_ok:false && text_ok:true` 永远不成立 —— 这条规则曾因此**静默失明**。
 *   现在看两件事：路由自己说 `why === 'live-down'`（车道挂了、退到级联），
 *   或者「车道确实挂着（`has_lane`）、没接住（`lane_ok:false`）、选的又不是 dsh」。
 * - **旧格式** 只有 `{lane_ok, text_ok}`（没有 `lane` 字段）：`text_ok:false`
 *   表示这一句本来就不归快车道（超字数 / 含数字 / 像长期事实），那一直是交给
 *   dsh 的，不算违约；只有 `lane_ok:false && text_ok:true` 才是车道没接住。
 *
 * 正常交给 dsh 的路由（`action` / `memorable` / `dsh-awaiting` / `stick-to-dsh` /
 * `no-fast-lane`）不会命中：它们的 `lane === 'dsh'`，用户只会听到一副嗓子。
 */
function isLaneFallback(lane: TraceEvent): boolean {
  if (typeof lane['why'] === 'string') {
    if (lane['why'] === 'live-down') {
      return true;
    }
    return lane['has_lane'] === true && lane['lane_ok'] === false && lane['lane'] !== 'dsh';
  }
  return lane['lane'] === undefined && lane['lane_ok'] === false && lane['text_ok'] === true;
}

export function checkTrace(input: readonly TraceEvent[], options: AuditOptions = {}): AuditResult {
  // 时间序是前提：档案本来是顺序写的，但审计器不该依赖调用方按序传（稳定排序，
  // 同一时刻的事件保持原顺序 —— `turn.end` 与紧随其后的 `dialog.state` 不能颠倒）
  const events = [...input].sort((a, b) => a.t - b.t);
  const maxTurnMs = options.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
  const maxStopToFirst = options.maxStopToFirstMs ?? DEFAULT_MAX_STOP_TO_FIRST_MS;
  const bargeStopWithin = options.bargeStopWithinMs ?? DEFAULT_BARGE_STOP_WITHIN_MS;

  const violations: Violation[] = [];
  const skipped = new Set<string>();
  const bad = (at: number, rule: string, detail: string): void => {
    violations.push({ at: Math.round(at), rule, detail });
  };

  const states = events.filter((e) => e.ev === 'dialog.state');
  const hasStates = states.length > 0;
  for (const rule of [
    'state.whitelist',
    'state.afterClose',
    'state.turnCovered',
    'state.audioBeforeSpeaking',
    'state.settledAfterTurn',
  ]) {
    if (!hasStates) {
      skipped.add(rule);
    }
  }

  // ---------------------------------------------------------------- 状态轮转
  let lastState = 'listening';
  let closedAt: number | null = null;
  for (const e of states) {
    const from = String(e['from'] ?? '');
    const to = String(e['to'] ?? '');
    if (from !== lastState) {
      bad(e.t, 'state.whitelist', `转移的起点对不上：记的是 ${from} → ${to}，实际当前是 ${lastState}`);
    }
    const allowed = ALLOWED[from];
    if (allowed === undefined || !allowed.includes(to)) {
      bad(e.t, 'state.whitelist', `不允许的转移 ${from} → ${to}`);
    }
    if (closedAt !== null) {
      bad(e.t, 'state.afterClose', `closed 之后还在转移：${from} → ${to}`);
    }
    if (to === 'closed') {
      closedAt = e.t;
    }
    lastState = to;
  }
  // `closed` 之后不该再冒出新轮次或新音频
  if (closedAt !== null) {
    for (const e of events) {
      if (e.t <= closedAt) {
        continue;
      }
      if (e.ev === 'turn.start' || e.ev === 'tts.first') {
        bad(e.t, 'state.afterClose', `closed 之后还有 ${e.ev}`);
      }
    }
  }

  // ---------------------------------------------------------------- 轮次配对
  const spans: Array<{ no: number; startAt: number; endAt: number | null; interrupted: boolean }> = [];
  let open: { no: number; startAt: number } | null = null;
  for (const e of events) {
    if (e.ev === 'turn.start') {
      if (open !== null) {
        bad(e.t, 'turn.nested', `第 ${open.no} 轮还没结束就开了新一轮（t=${open.startAt}）`);
        spans.push({ ...open, endAt: null, interrupted: false });
      }
      open = { no: spans.length + 1, startAt: e.t };
    } else if (e.ev === 'turn.end') {
      if (open === null) {
        bad(e.t, 'turn.orphanEnd', 'turn.end 前面没有对应的 turn.start');
        continue;
      }
      spans.push({ ...open, endAt: e.t, interrupted: e['interrupted'] === true });
      open = null;
    }
  }
  if (open !== null) {
    // 收尾时还开着一轮：后面有 close 就是断连打断，否则是挂了
    const closed = events.some((e) => e.ev === 'close' && e.t >= open!.startAt);
    if (!closed) {
      bad(open.startAt, 'turn.unclosed', `第 ${open.no} 轮开了没有结束，也没有断连`);
    }
    spans.push({ ...open, endAt: null, interrupted: closed });
  }

  // ---------------------------------------------------------------- 逐轮检查
  //
  // 分段（停嘴 → 定稿 → 开轮 → 首块）**不在这个文件里算**：唯一实现是
  // `latency-report.computeTurns()`（见 AGENTS.md「一个事实只有一个源」）。
  // 这里只做字段映射 —— 之前手写过一套 `gate.close` / `asr.sentence` / `tts.first`
  // 的配对逻辑，两份算法迟早会漂，而两个工具对「哪一轮慢了」说法不一致时，
  // 没人知道该信哪个。
  //
  // `latencies` 与 `spans` 一一对应：两者都由同一串按时间序的 `turn.start` 生成，
  // `spans` 只是额外记了 `turn.end` / 嵌套，不会漏掉或重排某一轮。
  const latencies = computeTurns(events);
  const turns: TurnSpan[] = [];
  for (const [index, span] of spans.entries()) {
    const latency = latencies[index];
    const nextStartAt = spans[index + 1]?.startAt ?? Number.POSITIVE_INFINITY;
    const loopEnd = span.endAt ?? Number.POSITIVE_INFINITY;
    const inTurn = (ev: string): TraceEvent[] =>
      events.filter((e) => e.ev === ev && e.t >= span.startAt && e.t < loopEnd);

    const first = inTurn('tts.first')[0];
    const turnStates = states.filter((e) => e.t >= span.startAt && e.t < loopEnd);

    // 开轮必须见过 thinking；有音频就必须见过 speaking
    if (hasStates) {
      const seen = new Set(turnStates.map((e) => String(e['to'])));
      if (!seen.has('thinking')) {
        bad(span.startAt, 'state.turnCovered', `第 ${span.no} 轮没有进入 thinking 的记录`);
      }
      if (first !== undefined && !seen.has('speaking')) {
        bad(first.t, 'state.turnCovered', `第 ${span.no} 轮首块时状态没到 speaking`);
      }
      // `tts.first` 之前必须已经进 speaking（顺序不能反）
      const speakAt = turnStates.find((e) => e['to'] === 'speaking')?.t;
      if (first !== undefined && (speakAt === undefined || speakAt > first.t)) {
        bad(first.t, 'state.audioBeforeSpeaking', `第 ${span.no} 轮先出声后进 speaking`);
      }
      // 轮次结束后必须落回 listening/ending/closed。
      // 注意 `turn.end` **写在 `audioDone` 之前**（见 `turn-runner` 的 finally），
      // 所以结束那一刻状态还是 `speaking` —— 要看到它之后真的转出去了，
      // 而不是要求"结束瞬间已经是 listening"。
      if (span.endAt !== null) {
        // 只看**到下一轮开始之前**的那些转移：下一轮自己的 listening→thinking
        // 落在这个窗口里时，不能拿来当"上一轮收没收尾"的证据
        const settleEnd = Math.min(span.endAt + 1_500, nextStartAt);
        // 左闭右开：下一轮的 listening→thinking 与它的 `turn.start` 同一毫秒，
        // 用 `<=` 会把下一轮的转移当成"上一轮停在 thinking"
        const after = states.filter((e) => e.t >= span.endAt! && e.t < settleEnd);
        const settled = after.length > 0 ? String(after[after.length - 1]!['to']) : undefined;
        if (settled !== undefined && !['listening', 'ending', 'closed'].includes(settled)) {
          bad(span.endAt, 'state.settledAfterTurn', `第 ${span.no} 轮结束后状态没落回聆听（停在 ${settled}）`);
        }
      }
    }

    // 时长
    if (span.endAt !== null && span.endAt - span.startAt > maxTurnMs) {
      bad(span.startAt, 'turn.tooLong', `第 ${span.no} 轮持续 ${Math.round(span.endAt - span.startAt)} ms`);
    }

    // 插话必须停音频。
    //
    // 时间锚点是**插话那一刻**，不是轮结束：作废之后这一轮还要等取消回来
    // （委派轮等 dsh 2.5–3.2 s），拿结束时刻 ±500 ms 去找会把正常的 audio.stop
    // 判成缺失（`235949` 回放第 6 轮就是这么误报的）。
    const endedAt = span.endAt;
    if (span.interrupted && endedAt !== null) {
      const barge = events.find((e) => e.ev === 'dialog.state'
        && e.t >= span.startAt
        && e.t <= endedAt
        && String(e['from'] ?? '') === 'speaking'
        && String(e['to'] ?? '') === 'listening'
        && String(e['why'] ?? '').includes('插话'));
      const anchor = barge?.t ?? endedAt;
      const stop = events.find((e) => e.ev === 'call.send'
        && e.t >= anchor - bargeStopWithin
        && e.t <= anchor + bargeStopWithin
        && String(e['json'] ?? '').includes('audio.stop'));
      if (stop === undefined) {
        bad(anchor, 'barge.noAudioStop', `第 ${span.no} 轮被判插话，但没发 audio.stop`);
      }
    }

    // 分段口径直接取 `computeTurns()`：
    // - `firstWordMs`  → 停嘴（`gate.close.t - gapMs`）→ 首块
    // - `asrToTurn`    → `asr.sentence` → `turn.start`
    // - `turnToAudio`  → `turn.start` → 首块
    //
    // 与旧手写逻辑的**有意**差异（都以 `computeTurns` 为准）：
    // - `asr.sentence` 只认「上一轮 `turn.start` 之后」的那句：排队轮不会把上一轮
    //   的句子错认成自己的触发句（旧逻辑只取最近一条，跨轮也照收）。
    // - `gate.close` 一个只给一轮用、且从本轮的句子往后找；`firstWordMs` 在
    //   `① < 0` / `① > gapMs` 时已经是 null（坏样本不参与统计与报警）。
    //   旧逻辑里的 `triggeredClosely ≤ 1500 ms` 启发式随之删除 —— 排队轮的保护
    //   由「gate 不跨轮复用」承担；边缘情况有差异时相信 `computeTurns` 的数。
    const stopToFirstMs = latency?.firstWordMs ?? null;
    turns.push({
      no: span.no,
      startAt: span.startAt,
      endAt: span.endAt,
      interrupted: span.interrupted,
      stopToFirstMs,
      sentenceToTurnMs: latency?.asrToTurn ?? null,
      turnToFirstMs: latency?.turnToAudio ?? null,
    });

    if (stopToFirstMs !== null && stopToFirstMs > maxStopToFirst) {
      bad(span.startAt, 'timing.stopToFirst', `第 ${span.no} 轮停嘴到首块 ${Math.round(stopToFirstMs)} ms`);
    }

    // omni 车道：开着就不许有「该它答却退回级联」的轮次。
    //
    // 判据随 `agent.lane` 的格式换过一代（见 `isLaneFallback`）：新版移除了
    // `text_ok`，老的 `lane_ok:false && text_ok:true` 永远不成立，这条规则曾因此
    // 静默失明。新口径看 `why === 'live-down'`，以及「车道挂着、没接住、又没交给
    // dsh」；正常路由给 dsh 的轮次一律不算 —— 那本来就该 dsh 答，用户只听到一副嗓子。
    const lane = inTurn('agent.lane')[0];
    if (lane !== undefined && isLaneFallback(lane)) {
      bad(lane.t, 'lane.fallback',
        `第 ${span.no} 轮该由 omni 答却退回级联（lane=${String(lane['lane'] ?? '?')}，`
        + `why=${String(lane['why'] ?? '?')}，`
        + `has_lane=${String(lane['has_lane'] ?? '?')}，`
        + `state=${String(lane['state'] ?? '?')}，`
        + `has_resp=${String(lane['has_resp'] ?? '?')}，`
        + `cancelled=${String(lane['cancelled'] ?? '?')}，`
        + `pending=${String(lane['pending'] ?? '?')}）`);
    }
  }

  return { turns, violations, skipped: [...skipped], states: states.length };
}

/** 读一份 `events.jsonl`（一行一个 JSON）。坏行直接抛 —— 档案坏掉不该被当成"没有违规"。 */
export function parseTrace(text: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const value = JSON.parse(trimmed) as TraceEvent;
    if (typeof value.t !== 'number' || typeof value.ev !== 'string') {
      throw new Error(`档案行不像事件：${trimmed.slice(0, 80)}`);
    }
    out.push(value);
  }
  return out;
}
