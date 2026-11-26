/**
 * Pure Live 数据面的唯一真相源。
 *
 * 前台轮次、后台任务、Omni 动态上下文，以前散在编排器的 Map 和字符串拼接里。
 * 这里收成一台纯 Mealy 机：`reduceLiveSession(state, event)` 给出下一份不可变状态，
 * 以及还没执行的意图（回工具结果、删 Omni 项、刷新快照、纠偏字幕、投递汇报）。
 * 没有 IO、没有计时器、没有 WebSocket；同一串事件在任何机器上得到同一份结果。
 *
 * 快照文本只在这里投影。空快照必须是空串：纯闲聊不往 Omni 的 instructions 上贴段落。
 * 静默记忆（`memory_silent` / `delivered: 'silent'`）不进这份快照，避免写记忆扰动前台。
 */
import type { BackgroundTaskReport, BackgroundTaskSource } from '../providers.ts';

/** 一条前台轮次。同一 `epoch` 里 `turnNo` 唯一；重连后再从 1 编号也不会撞上一代。 */
export interface LiveTurnRecord {
  readonly turnNo: number;
  readonly epoch: number;
  readonly ticket?: { readonly no: number; readonly gen: number };
  readonly rawAsr: string;
  readonly canonicalUser?: string;
  readonly lane: 'live' | 'dsh';
  readonly assistantSpoken: string;
  readonly truncated: boolean;
  readonly endedAtMs: number;
  readonly omniUserItemId?: string | null;
  readonly omniAssistantItemIds: readonly string[];
  readonly toolCallId?: string | null;
  readonly taskId?: string;
}

/** 后台结论有没有送到用户耳朵里。`pending` 才会进未播列表。 */
export type LiveTaskDelivery = 'pending' | 'spoken' | 'interrupted' | 'silent' | 'dropped';

/**
 * 任务执行态。终态是 `completed` / `failed` / `cancelled`，进去之后不能再回到
 * `queued` / `running`。取消之后迟到的完成也进不来。
 */
export type LiveTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 一条后台任务。`epoch` 是创建时的连接代际，重连后的投影不再认它。 */
export interface LiveTaskRecord {
  readonly taskId: string;
  readonly turnNo?: number;
  readonly epoch: number;
  readonly source: BackgroundTaskSource;
  readonly query: string;
  readonly canonicalUser?: string;
  readonly toolCallId?: string | null;
  readonly state: LiveTaskState;
  readonly executed: boolean;
  readonly unverifiedReplyCleared?: boolean;
  readonly summary?: string;
  readonly verbatim?: string;
  readonly needsConfirm?: string;
  readonly emotion?: string;
  readonly delivered: LiveTaskDelivery;
  readonly updatedSeq: number;
}

/** 会话数据面。`lastSnapshot` 是已经投影给 Omni 的那一槽，文本没变就不再发。 */
export interface LiveSessionState {
  readonly epoch: number;
  readonly seq: number;
  readonly turns: readonly LiveTurnRecord[];
  readonly tasks: Readonly<Record<string, LiveTaskRecord>>;
  readonly taskOrder: readonly string[];
  readonly lastSnapshot: string;
  readonly lastAnsweredLane: 'live' | 'dsh' | null;
}

export type LiveSessionEvent =
  | { readonly type: 'lane.replaced' }
  | {
    readonly type: 'turn.delegated';
    readonly turnNo: number;
    readonly rawAsr: string;
    readonly query: string;
    readonly taskId: string;
    readonly toolCallId?: string | null;
    readonly omniUserItemId?: string | null;
    readonly omniAssistantItemIds?: readonly string[];
    readonly nowMs?: number;
  }
  | {
    readonly type: 'turn.early_guarded';
    readonly turnNo: number;
    readonly rawAsr: string;
    readonly query: string;
    readonly taskId: string;
    readonly omniAssistantItemIds?: readonly string[];
  }
  | {
    readonly type: 'turn.recorded';
    readonly turnNo: number;
    readonly rawAsr: string;
    readonly lane: 'live' | 'dsh';
    readonly assistantSpoken: string;
    readonly endedAtMs: number;
    readonly ticket?: { readonly no: number; readonly gen: number };
    readonly omniUserItemId?: string | null;
    readonly omniAssistantItemIds?: readonly string[];
    readonly toolCallId?: string | null;
    readonly taskId?: string;
  }
  | {
    readonly type: 'turn.reconciled';
    readonly ticket: { readonly no: number; readonly gen: number };
    readonly truncated: boolean;
    readonly endedAtMs?: number;
  }
  | {
    readonly type: 'task.lifecycle';
    readonly taskId: string;
    readonly status: 'queued' | 'upgraded' | 'running' | 'cancelled';
    readonly turnNo?: number;
    readonly source?: BackgroundTaskSource;
    readonly query?: string;
    readonly silent?: boolean;
  }
  | { readonly type: 'task.cancelled_all' }
  | {
    readonly type: 'task.completed';
    readonly report: BackgroundTaskReport;
    readonly turnNo?: number;
    readonly canonicalUser?: string;
    readonly silent?: boolean;
  }
  | {
    readonly type: 'task.failed';
    readonly report: BackgroundTaskReport;
    readonly turnNo?: number;
  }
  | {
    readonly type: 'announce.settled';
    readonly taskId?: string;
    readonly outcome: 'spoken' | 'interrupted';
    readonly query?: string;
    readonly summary?: string;
  };

/** 解释器去执行的意图。这个文件只声明，不发送。 */
export type LiveSessionEffect =
  | { readonly type: 'send_tool_output'; readonly callId: string; readonly output: string }
  | { readonly type: 'delete_omni_items'; readonly itemIds: readonly string[] }
  | { readonly type: 'sync_omni_snapshot'; readonly snapshot: string }
  | { readonly type: 'emit_ui_asr_replace'; readonly text: string; readonly previous?: string }
  | {
    readonly type: 'deliver_report';
    readonly report: BackgroundTaskReport;
    readonly previousUserText?: string;
    readonly canonicalUser?: string;
    readonly turnNo?: number;
  };

interface Reduced {
  readonly state: LiveSessionState;
  readonly effects: readonly LiveSessionEffect[];
}

const MAX_TURNS = 12;
const MAX_TERMINALS = 4;
const MAX_CORRECTIONS = 3;
const DEFAULT_SNAPSHOT_CHARS = 800;
const DEFAULT_DIALOG_TURNS = 4;

/** 去重口径：只留中文、字母、数字，空白与标点都不参与 2-gram。 */
const COMPACT_DROP = /[^\p{L}\p{N}]+/gu;

const SNAPSHOT_TITLE = '【当前后台任务与已核实事实（唯一真相源：未标注 completed 的一律视为尚未执行，禁止声称已办成）】';
const DIALOG_TITLE = '【最近前台对话（仅供理解代词与指代，不要重复回答）】';

/** 工具回执里的原句。Omni 在快照出现 completed 之前不许把「交代了」说成「做完了」。 */
const ACCEPTED_NOTE = '已交后台执行，尚未完成。在【当前后台任务与已核实事实】出现 completed 前，禁止声称已执行或编造结果。';

/** 空会话。`epoch` 从 0 起，第一次 `lane.replaced` 才变成 1，和后台总线的代际同一方向。 */
export function initialLiveSessionState(): LiveSessionState {
  return {
    epoch: 0,
    seq: 0,
    turns: [],
    tasks: {},
    taskOrder: [],
    lastSnapshot: '',
    lastAnsweredLane: null,
  };
}

/**
 * 推进一步。事件本身不带时钟，调用方把已经发生的事实送进来。
 * 快照字符串没变时不重复发 `sync_omni_snapshot`。
 */
export function reduceLiveSession(state: LiveSessionState, event: LiveSessionEvent): Reduced {
  const applied = applyEvent(state, event);
  if (applied === null) return { state, effects: [] };
  const snapshot = projectOmniSnapshot(applied.state);
  if (snapshot === state.lastSnapshot) return applied;
  return {
    state: { ...applied.state, lastSnapshot: snapshot },
    effects: insertSync(applied.effects, { type: 'sync_omni_snapshot', snapshot }),
  };
}

/**
 * Omni 动态上下文那一槽。
 *
 * 只投影**当前代际**的非静默任务：全部仍在 `queued` / `running` 的，加上最近 4 条终态。
 * 另外附上最近 3 条「核实说法 ≠ ASR 原文」的轮次。两边都空就返回 `''`。
 * 逐字稿不进这里：精确数字走播报通道，避免 Omni 改写端口号和订单号。
 */
export function projectOmniSnapshot(state: LiveSessionState, maxChars = DEFAULT_SNAPSHOT_CHARS): string {
  const facts = snapshotFacts(state);
  if (facts.length === 0) return '';
  const budget = maxChars <= 0 ? 0 : Math.floor(maxChars);
  if (budget <= 0) return '';
  const kept: string[] = [];
  for (const fact of facts) {
    const next = joinSnapshot([...kept, fact]);
    if (codePointLength(next) > budget) break;
    kept.push(fact);
  }
  if (kept.length === 0) return clipCodePoints(joinSnapshot([facts[0] ?? '']), budget);
  return joinSnapshot(kept);
}

/** 给后台 dsh 看的最近前台对话。用户行优先用核实后的说法。 */
export function projectDshRecentDialog(state: LiveSessionState, limit = DEFAULT_DIALOG_TURNS): string {
  const picked = recentDialogTurns(state.turns, limit);
  if (picked.length === 0) return '';
  const lines: string[] = [];
  for (const turn of picked) appendDialogLines(lines, turn);
  if (lines.length === 0) return '';
  return `${DIALOG_TITLE}\n${lines.join('\n')}`;
}

/** 最近一句真正说出口的助手回复走的是哪条车道。没有则 `null`。 */
export function projectLastAnsweredLane(state: LiveSessionState): 'live' | 'dsh' | null {
  return state.lastAnsweredLane;
}

/**
 * 当前代际里已经跑完（成功或失败）、还没播出去的非静默任务。
 * 旧的 mock 车道不支持动态上下文时，用这份列表把结论补进下一轮。
 */
export function listUnspokenReports(state: LiveSessionState): readonly LiveTaskRecord[] {
  const out: LiveTaskRecord[] = [];
  for (const taskId of state.taskOrder) {
    const task = state.tasks[taskId];
    if (task === undefined) continue;
    if (task.epoch !== state.epoch || isSilentTask(task)) continue;
    if (task.delivered !== 'pending') continue;
    if (task.state !== 'completed' && task.state !== 'failed') continue;
    out.push(task);
  }
  return out;
}

/**
 * 前台这一轮是不是已经把某条后台结论讲给用户了。
 *
 * 现场：用户问「搜好没？」时后台刚好完成，`live-session-store` 把完整结论写进
 * Omni 单槽，`connection.ts` 也把同一条推入播报队列。Omni 读单槽讲了 25.6 s，
 * 回 `listening` 后队列不知道前台已经讲过，又重播 29.76 s。
 *
 * 判据用**去空白/标点后的 2-gram 重叠**，不是字符集合：集合会把「大贱/大剑」
 * 这种只差一个字的句子判成覆盖；2-gram 要求连续两个字都出现。短回执（「好的」
 * 「还在查，等下。」）先被 8 字门槛挡住，进度敷衍再被低重叠挡住。
 *
 * 长报告被 Omni 浓缩复述时命中率会掉到 30% 以下，所以还有第二条宽松路径：
 * 至少命中 6 个 2-gram，并且占**短侧**（复述或总结哪边更短）四分之一以上。
 */
export function foregroundCoveredReport(assistantSpoken: string, summary: string): boolean {
  const spokenCompact = compactOverlapText(assistantSpoken);
  const summaryCompact = compactOverlapText(summary);
  if (codePointLength(spokenCompact) < 8 || summaryCompact === '') return false;
  const summaryBigrams = bigramsOf(summaryCompact);
  if (summaryBigrams.size === 0) return false;
  const spokenBigrams = bigramsOf(spokenCompact);
  let hits = 0;
  for (const gram of summaryBigrams) {
    if (spokenBigrams.has(gram)) hits += 1;
  }
  if (hits < 3) return false;
  if (hits / summaryBigrams.size >= 0.30) return true;
  return hits >= 6 && hits / Math.min(summaryBigrams.size, spokenBigrams.size) >= 0.25;
}

function compactOverlapText(text: string): string {
  return text.replace(COMPACT_DROP, '');
}

function bigramsOf(compact: string): ReadonlySet<string> {
  const chars = [...compact];
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

function applyEvent(state: LiveSessionState, event: LiveSessionEvent): Reduced | null {
  switch (event.type) {
    case 'lane.replaced':
      return applyLaneReplaced(state);
    case 'turn.delegated':
      return applyDelegated(state, event);
    case 'turn.early_guarded':
      return applyEarlyGuarded(state, event);
    case 'turn.recorded':
      return applyRecorded(state, event);
    case 'turn.reconciled':
      return applyReconciled(state, event);
    case 'task.lifecycle':
      return applyLifecycle(state, event);
    case 'task.cancelled_all':
      return applyCancelAll(state);
    case 'task.completed':
      return applyCompleted(state, event);
    case 'task.failed':
      return applyFailed(state, event);
    case 'announce.settled':
      return applyAnnounceSettled(state, event);
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

/**
 * 连接换了。代际加一，旧 item id 就地忘掉（新连接上删不到，也不该删）。
 * 上一代还标着 `pending` 的未播标记收成 `dropped`，不把旧结论灌进新 Omni。
 * 在途任务不改成 cancelled：总线重连同样只推进代际，答应过的活还在跑。
 */
function applyLaneReplaced(state: LiveSessionState): Reduced {
  const seq = state.seq + 1;
  const tasks = dropPendingDeliveries(state, seq);
  const turns = state.turns.length === 0 ? state.turns : state.turns.map(clearOmniIds);
  return {
    state: {
      ...state,
      epoch: state.epoch + 1,
      seq,
      turns,
      tasks,
    },
    effects: [],
  };
}

function applyDelegated(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.delegated' }>,
): Reduced | null {
  const seq = state.seq + 1;
  const existing = state.tasks[event.taskId];
  const task = existing !== undefined && isTerminal(existing.state)
    ? supplementTerminal(existing, event, seq)
    : taskForDelegated(state, event, existing, seq);
  const tasks = sameTask(existing, task) ? state.tasks : putTask(state.tasks, task);
  const order = tasks === state.tasks ? state.taskOrder : withTaskId(state.taskOrder, task.taskId);
  const turn = mergeDelegatedTurn(state, event);
  const turns = placeTurn(state.turns, turn);
  const effects: LiveSessionEffect[] = [];
  // 工具协议必须回执，否则这轮 function call 会一直挂着。终态只是不再改状态。
  if (isCallId(event.toolCallId)) {
    effects.push({
      type: 'send_tool_output',
      callId: event.toolCallId,
      output: acceptedToolOutput(event.taskId),
    });
  }
  if (effects.length === 0 && tasks === state.tasks && turns === state.turns) return null;
  const unchanged = tasks === state.tasks && turns === state.turns;
  return {
    state: unchanged ? state : { ...state, seq, tasks, taskOrder: order, turns },
    effects,
  };
}

function applyEarlyGuarded(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.early_guarded' }>,
): Reduced | null {
  const index = findTurn(state.turns, state.epoch, event.turnNo);
  const current = index >= 0 ? state.turns[index] : undefined;
  const existing = state.tasks[event.taskId];
  const itemIds = deleteIds(current, event.omniAssistantItemIds, existing);
  const seq = state.seq + 1;
  const task = taskForEarly(state, event, existing, itemIds.length > 0, seq);
  const tasks = sameTask(existing, task) ? state.tasks : putTask(state.tasks, task);
  const order = tasks === state.tasks ? state.taskOrder : withTaskId(state.taskOrder, task.taskId);
  const turn = mergeEarlyTurn(state, event, current, itemIds.length > 0);
  const turns = placeTurn(state.turns, turn);
  const effects: LiveSessionEffect[] = [];
  if (itemIds.length > 0) effects.push({ type: 'delete_omni_items', itemIds });
  if (effects.length === 0 && tasks === state.tasks && turns === state.turns) return null;
  const bumped = tasks !== state.tasks || turns !== state.turns;
  return {
    state: {
      ...state,
      seq: bumped ? seq : state.seq,
      tasks,
      taskOrder: order,
      turns,
    },
    effects,
  };
}

function applyRecorded(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.recorded' }>,
): Reduced | null {
  const turn = turnFromRecorded(state, event);
  const index = findTurn(state.turns, state.epoch, event.turnNo);
  const current = index >= 0 ? state.turns[index] : undefined;
  const lastAnsweredLane = turn.assistantSpoken.trim() !== '' ? turn.lane : state.lastAnsweredLane;
  const seq = state.seq + 1;
  // 前台已经把结论讲出来时，后台任务不必再进空窗播报队列（否则就是双讲）。
  // 这一步必须在「没变就早退」之前算：turn 本身可能和上次完全相同，
  // 变的只有任务投递状态和随之刷新的单槽快照。
  const tasks = markForegroundCoveredTasks(state, turn, seq);
  const turnChanged = current === undefined || !sameTurn(current, turn);
  if (!turnChanged && tasks === state.tasks && lastAnsweredLane === state.lastAnsweredLane) {
    return null;
  }
  return {
    state: {
      ...state,
      seq,
      turns: turnChanged ? placeTurn(state.turns, turn) : state.turns,
      tasks,
      lastAnsweredLane,
    },
    effects: [],
  };
}

/**
 * 前台代播消重。只认当前代际、非静默、已跑完、还没播过的任务。
 * 返回同一份 `tasks` 表示没有变化（调用方据此保持早退语义）。
 */
function markForegroundCoveredTasks(
  state: LiveSessionState,
  turn: LiveTurnRecord,
  seq: number,
): Readonly<Record<string, LiveTaskRecord>> {
  if (turn.lane !== 'live' || turn.truncated || turn.assistantSpoken.trim() === '') {
    return state.tasks;
  }
  let tasks: Record<string, LiveTaskRecord> | null = null;
  for (const taskId of state.taskOrder) {
    const task = state.tasks[taskId];
    if (task === undefined || task.epoch !== state.epoch || isSilentTask(task)) continue;
    if (task.state !== 'completed' && task.state !== 'failed') continue;
    if (task.delivered !== 'pending') continue;
    const summary = task.summary?.trim();
    if (summary === undefined || summary === '') continue;
    if (!foregroundCoveredReport(turn.assistantSpoken, summary)) continue;
    if (tasks === null) tasks = { ...state.tasks };
    tasks[taskId] = { ...task, delivered: 'spoken', updatedSeq: seq };
  }
  return tasks ?? state.tasks;
}

/** 只改票据完全相同的最后一条。对不上就原样返回，连序号都不动。 */
function applyReconciled(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.reconciled' }>,
): Reduced | null {
  const index = findTicket(state.turns, event.ticket);
  if (index < 0) return null;
  const turn = state.turns[index];
  if (turn === undefined) return null;
  const endedAtMs = event.endedAtMs ?? turn.endedAtMs;
  if (turn.truncated === event.truncated && turn.endedAtMs === endedAtMs) return null;
  const next: LiveTurnRecord = { ...turn, truncated: event.truncated, endedAtMs };
  return {
    state: { ...state, seq: state.seq + 1, turns: replaceAt(state.turns, index, next) },
    effects: [],
  };
}

function applyLifecycle(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.lifecycle' }>,
): Reduced | null {
  if (event.status === 'upgraded') return applyUpgraded(state, event);
  const existing = state.tasks[event.taskId];
  if (existing !== undefined && isTerminal(existing.state)) return null;
  if (event.status === 'cancelled') return applyCancelOne(state, event, existing);
  if (event.status === 'running') return applyRunning(state, event, existing);
  return applyQueued(state, event, existing);
}

function applyUpgraded(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.lifecycle' }>,
): Reduced | null {
  const existing = state.tasks[event.taskId];
  if (existing === undefined || existing.state !== 'queued') return null;
  if (event.query === undefined || event.query === existing.query) return null;
  const seq = state.seq + 1;
  const next: LiveTaskRecord = { ...existing, query: event.query, updatedSeq: seq };
  return {
    state: { ...state, seq, tasks: putTask(state.tasks, next) },
    effects: [],
  };
}

function applyCancelAll(state: LiveSessionState): Reduced | null {
  const seq = state.seq + 1;
  let tasks: Record<string, LiveTaskRecord> | null = null;
  for (const taskId of state.taskOrder) {
    const task = state.tasks[taskId];
    if (task === undefined || isSilentTask(task)) continue;
    if (task.state !== 'queued' && task.state !== 'running') continue;
    if (tasks === null) tasks = { ...state.tasks };
    tasks[taskId] = {
      ...task,
      state: 'cancelled',
      executed: false,
      delivered: 'dropped',
      updatedSeq: seq,
    };
  }
  if (tasks === null) return null;
  return { state: { ...state, seq, tasks }, effects: [] };
}

function applyCompleted(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.completed' }>,
): Reduced | null {
  const existing = state.tasks[event.report.taskId];
  // 终态不可逆。取消后迟到的成功直接丢掉，避免把「哥已取消」改写成已核实。
  if (existing !== undefined && isTerminal(existing.state)) return null;
  const silent = isSilentReport(event.report.source, event.silent, existing);
  const canonical = trimmed(event.canonicalUser);
  const seq = state.seq + 1;
  const turnNo = event.turnNo ?? existing?.turnNo;
  const epoch = existing?.epoch ?? state.epoch;
  const located = turnNo === undefined ? undefined : locateTurn(state.turns, epoch, turnNo);
  const task = taskForCompleted(event, existing, {
    seq,
    silent,
    canonical,
    turnNo,
    epoch,
  });
  const tasks = putTask(state.tasks, task);
  const order = withTaskId(state.taskOrder, task.taskId);
  let turns = state.turns;
  const effects: LiveSessionEffect[] = [];
  if (canonical !== undefined && located !== undefined) {
    if (located.turn.canonicalUser !== canonical) {
      turns = replaceAt(turns, located.index, { ...located.turn, canonicalUser: canonical });
    }
    if (canonical !== located.turn.rawAsr.trim()) {
      effects.push({
        type: 'emit_ui_asr_replace',
        text: canonical,
        previous: located.turn.rawAsr,
      });
    }
  }
  if (!silent) {
    effects.push(deliverEffect(event.report, {
      turnNo,
      canonicalUser: canonical,
      previousUserText: located?.turn.rawAsr,
    }));
  }
  return {
    state: { ...state, seq, tasks, taskOrder: order, turns },
    effects,
  };
}

function applyFailed(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.failed' }>,
): Reduced | null {
  const existing = state.tasks[event.report.taskId];
  if (existing !== undefined && isTerminal(existing.state)) return null;
  const silent = isSilentReport(event.report.source, undefined, existing);
  const seq = state.seq + 1;
  const turnNo = event.turnNo ?? existing?.turnNo;
  const task = taskForFailed(state, event, existing, seq, silent, turnNo);
  const tasks = putTask(state.tasks, task);
  const order = withTaskId(state.taskOrder, task.taskId);
  const located = turnNo === undefined ? undefined : locateTurn(state.turns, task.epoch, turnNo);
  const effects: LiveSessionEffect[] = [];
  if (!silent) {
    effects.push(deliverEffect(event.report, {
      turnNo,
      previousUserText: located?.turn.rawAsr,
    }));
  }
  return {
    state: { ...state, seq, tasks, taskOrder: order },
    effects,
  };
}

function applyAnnounceSettled(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'announce.settled' }>,
): Reduced | null {
  if (event.taskId === undefined) return null;
  const existing = state.tasks[event.taskId];
  if (existing === undefined) {
    const summary = trimmed(event.summary);
    if (event.outcome !== 'spoken' || summary === undefined) return null;
    const seq = state.seq + 1;
    const task = createTask({
      taskId: event.taskId,
      epoch: state.epoch,
      source: 'dsh_background',
      query: event.query?.trim() || '后台任务',
      state: 'completed',
      executed: true,
      summary,
      delivered: 'spoken',
      updatedSeq: seq,
    });
    return {
      state: {
        ...state,
        seq,
        tasks: putTask(state.tasks, task),
        taskOrder: withTaskId(state.taskOrder, task.taskId),
      },
      effects: [],
    };
  }
  if (isSilentTask(existing)) return null;
  if (existing.delivered === event.outcome) return null;
  const seq = state.seq + 1;
  const next: LiveTaskRecord = { ...existing, delivered: event.outcome, updatedSeq: seq };
  return {
    state: { ...state, seq, tasks: putTask(state.tasks, next) },
    effects: [],
  };
}

function applyCancelOne(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.lifecycle' }>,
  existing: LiveTaskRecord | undefined,
): Reduced | null {
  if (existing === undefined) return null;
  if (existing.state !== 'queued' && existing.state !== 'running') return null;
  const seq = state.seq + 1;
  const silent = isSilentTask(existing) || event.silent === true || event.source === 'memory_silent';
  const next: LiveTaskRecord = {
    ...existing,
    state: 'cancelled',
    executed: false,
    delivered: silent ? 'silent' : 'dropped',
    updatedSeq: seq,
  };
  return { state: { ...state, seq, tasks: putTask(state.tasks, next) }, effects: [] };
}

function applyRunning(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.lifecycle' }>,
  existing: LiveTaskRecord | undefined,
): Reduced | null {
  const silent = isSilentReport(event.source, event.silent, existing);
  if (existing === undefined) {
    const seq = state.seq + 1;
    const task = createTask({
      taskId: event.taskId,
      turnNo: event.turnNo,
      epoch: state.epoch,
      source: event.source ?? 'tool_call',
      query: event.query ?? '',
      state: 'running',
      executed: false,
      delivered: silent ? 'silent' : 'pending',
      updatedSeq: seq,
    });
    return {
      state: {
        ...state,
        seq,
        tasks: putTask(state.tasks, task),
        taskOrder: withTaskId(state.taskOrder, task.taskId),
      },
      effects: [],
    };
  }
  if (existing.state !== 'queued') return null;
  const seq = state.seq + 1;
  const next: LiveTaskRecord = {
    ...existing,
    state: 'running',
    executed: false,
    delivered: silent || isSilentTask(existing) ? 'silent' : 'pending',
    turnNo: event.turnNo ?? existing.turnNo,
    updatedSeq: seq,
  };
  if (sameTask(existing, next)) return null;
  return { state: { ...state, seq, tasks: putTask(state.tasks, next) }, effects: [] };
}

function applyQueued(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.lifecycle' }>,
  existing: LiveTaskRecord | undefined,
): Reduced | null {
  const silent = isSilentReport(event.source, event.silent, existing);
  if (existing === undefined) {
    const seq = state.seq + 1;
    const task = createTask({
      taskId: event.taskId,
      turnNo: event.turnNo,
      epoch: state.epoch,
      source: event.source ?? 'tool_call',
      query: event.query ?? '',
      state: 'queued',
      executed: false,
      delivered: silent ? 'silent' : 'pending',
      updatedSeq: seq,
    });
    return {
      state: {
        ...state,
        seq,
        tasks: putTask(state.tasks, task),
        taskOrder: withTaskId(state.taskOrder, task.taskId),
      },
      effects: [],
    };
  }
  // 已经在跑就不能退回排队，查询也冻住。
  if (existing.state !== 'queued') return null;
  const seq = state.seq + 1;
  const next: LiveTaskRecord = {
    ...existing,
    query: event.query ?? existing.query,
    turnNo: event.turnNo ?? existing.turnNo,
    delivered: silent || isSilentTask(existing) ? 'silent' : existing.delivered === 'silent' ? 'silent' : 'pending',
    updatedSeq: seq,
  };
  if (sameTask(existing, next)) return null;
  return { state: { ...state, seq, tasks: putTask(state.tasks, next) }, effects: [] };
}

function taskForDelegated(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.delegated' }>,
  existing: LiveTaskRecord | undefined,
  seq: number,
): LiveTaskRecord {
  if (existing === undefined) {
    return createTask({
      taskId: event.taskId,
      turnNo: event.turnNo,
      epoch: state.epoch,
      source: 'tool_call',
      query: event.query,
      toolCallId: event.toolCallId,
      state: 'queued',
      executed: false,
      delivered: 'pending',
      updatedSeq: seq,
    });
  }
  const toolCallId = supplementCallId(existing.toolCallId, event.toolCallId);
  const turnNo = existing.turnNo ?? event.turnNo;
  if (toolCallId === existing.toolCallId && turnNo === existing.turnNo) return existing;
  return { ...existing, toolCallId, turnNo, updatedSeq: seq };
}

/** 终态只补缺的票据字段，不把状态拉回去，也不改查询。 */
function supplementTerminal(
  existing: LiveTaskRecord,
  event: Extract<LiveSessionEvent, { type: 'turn.delegated' }>,
  seq: number,
): LiveTaskRecord {
  const toolCallId = supplementCallId(existing.toolCallId, event.toolCallId);
  const turnNo = existing.turnNo ?? event.turnNo;
  if (toolCallId === existing.toolCallId && turnNo === existing.turnNo) return existing;
  return { ...existing, toolCallId, turnNo, updatedSeq: seq };
}

function taskForEarly(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.early_guarded' }>,
  existing: LiveTaskRecord | undefined,
  clearedNow: boolean,
  seq: number,
): LiveTaskRecord {
  const unverifiedReplyCleared = clearedNow || existing?.unverifiedReplyCleared === true;
  if (existing === undefined) {
    return createTask({
      taskId: event.taskId,
      turnNo: event.turnNo,
      epoch: state.epoch,
      source: 'early_rule',
      query: event.query,
      state: 'queued',
      executed: false,
      unverifiedReplyCleared,
      delivered: 'pending',
      updatedSeq: seq,
    });
  }
  if (isTerminal(existing.state) || existing.state === 'running') {
    if (existing.unverifiedReplyCleared === true || !clearedNow) return existing;
    return { ...existing, unverifiedReplyCleared: true, updatedSeq: seq };
  }
  const query = existing.source === 'tool_call' ? existing.query : event.query;
  const next: LiveTaskRecord = {
    ...existing,
    turnNo: existing.turnNo ?? event.turnNo,
    query,
    executed: false,
    unverifiedReplyCleared,
    delivered: isSilentTask(existing) ? 'silent' : 'pending',
    updatedSeq: seq,
  };
  return sameTask(existing, next) ? existing : next;
}

function taskForCompleted(
  event: Extract<LiveSessionEvent, { type: 'task.completed' }>,
  existing: LiveTaskRecord | undefined,
  patch: {
    readonly seq: number;
    readonly silent: boolean;
    readonly canonical: string | undefined;
    readonly turnNo: number | undefined;
    readonly epoch: number;
  },
): LiveTaskRecord {
  return createTask({
    taskId: event.report.taskId,
    turnNo: patch.turnNo,
    epoch: patch.epoch,
    source: existing?.source ?? event.report.source,
    query: existing !== undefined && existing.query !== '' ? existing.query : event.report.query,
    canonicalUser: patch.canonical ?? existing?.canonicalUser,
    toolCallId: existing?.toolCallId,
    state: 'completed',
    executed: true,
    unverifiedReplyCleared: existing?.unverifiedReplyCleared,
    summary: event.report.summary,
    verbatim: event.report.verbatim,
    needsConfirm: event.report.needsConfirm,
    emotion: event.report.emotion ?? existing?.emotion,
    delivered: patch.silent ? 'silent' : 'pending',
    updatedSeq: patch.seq,
  });
}

function taskForFailed(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'task.failed' }>,
  existing: LiveTaskRecord | undefined,
  seq: number,
  silent: boolean,
  turnNo: number | undefined,
): LiveTaskRecord {
  return createTask({
    taskId: event.report.taskId,
    turnNo,
    epoch: existing?.epoch ?? state.epoch,
    source: existing?.source ?? event.report.source,
    query: existing !== undefined && existing.query !== '' ? existing.query : event.report.query,
    canonicalUser: existing?.canonicalUser,
    toolCallId: existing?.toolCallId,
    state: 'failed',
    executed: false,
    unverifiedReplyCleared: existing?.unverifiedReplyCleared,
    summary: event.report.summary,
    verbatim: event.report.verbatim,
    needsConfirm: event.report.needsConfirm,
    emotion: event.report.emotion ?? existing?.emotion,
    delivered: silent ? 'silent' : 'pending',
    updatedSeq: seq,
  });
}

function mergeDelegatedTurn(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.delegated' }>,
): LiveTurnRecord {
  const index = findTurn(state.turns, state.epoch, event.turnNo);
  const current = index >= 0 ? state.turns[index] : undefined;
  if (current === undefined) {
    return {
      turnNo: event.turnNo,
      epoch: state.epoch,
      rawAsr: event.rawAsr,
      lane: 'live',
      assistantSpoken: '',
      truncated: false,
      endedAtMs: event.nowMs ?? 0,
      ...(event.omniUserItemId !== undefined ? { omniUserItemId: event.omniUserItemId } : {}),
      omniAssistantItemIds: copyIds(event.omniAssistantItemIds),
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      taskId: event.taskId,
    };
  }
  const toolCallId = supplementCallId(current.toolCallId, event.toolCallId);
  const next: LiveTurnRecord = {
    ...current,
    rawAsr: current.rawAsr !== '' ? current.rawAsr : event.rawAsr,
    ...(event.omniUserItemId !== undefined ? { omniUserItemId: event.omniUserItemId } : {}),
    omniAssistantItemIds: event.omniAssistantItemIds !== undefined
      ? copyIds(event.omniAssistantItemIds)
      : current.omniAssistantItemIds,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    taskId: current.taskId ?? event.taskId,
  };
  return sameTurn(current, next) ? current : next;
}

function mergeEarlyTurn(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.early_guarded' }>,
  current: LiveTurnRecord | undefined,
  cleared: boolean,
): LiveTurnRecord {
  if (current === undefined) {
    return {
      turnNo: event.turnNo,
      epoch: state.epoch,
      rawAsr: event.rawAsr,
      lane: 'live',
      assistantSpoken: '',
      truncated: false,
      endedAtMs: 0,
      omniAssistantItemIds: [],
      taskId: event.taskId,
    };
  }
  const next: LiveTurnRecord = {
    ...current,
    rawAsr: current.rawAsr !== '' ? current.rawAsr : event.rawAsr,
    omniAssistantItemIds: cleared ? [] : current.omniAssistantItemIds,
    taskId: current.taskId ?? event.taskId,
  };
  return sameTurn(current, next) ? current : next;
}

function turnFromRecorded(
  state: LiveSessionState,
  event: Extract<LiveSessionEvent, { type: 'turn.recorded' }>,
): LiveTurnRecord {
  const index = findTurn(state.turns, state.epoch, event.turnNo);
  const current = index >= 0 ? state.turns[index] : undefined;
  const ticket = event.ticket !== undefined
    ? { no: event.ticket.no, gen: event.ticket.gen }
    : current?.ticket;
  const toolCallId = event.toolCallId !== undefined ? event.toolCallId : current?.toolCallId;
  const taskId = event.taskId !== undefined ? event.taskId : current?.taskId;
  return {
    turnNo: event.turnNo,
    epoch: state.epoch,
    ...(ticket !== undefined ? { ticket } : {}),
    rawAsr: event.rawAsr,
    ...(current?.canonicalUser !== undefined ? { canonicalUser: current.canonicalUser } : {}),
    lane: event.lane,
    assistantSpoken: event.assistantSpoken,
    truncated: current?.truncated ?? false,
    endedAtMs: event.endedAtMs,
    ...(event.omniUserItemId !== undefined
      ? { omniUserItemId: event.omniUserItemId }
      : current?.omniUserItemId !== undefined
        ? { omniUserItemId: current.omniUserItemId }
        : {}),
    omniAssistantItemIds: event.omniAssistantItemIds !== undefined
      ? copyIds(event.omniAssistantItemIds)
      : (current?.omniAssistantItemIds ?? []),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

interface TaskDraft {
  readonly taskId: string;
  readonly turnNo?: number;
  readonly epoch: number;
  readonly source: BackgroundTaskSource;
  readonly query: string;
  readonly canonicalUser?: string;
  readonly toolCallId?: string | null;
  readonly state: LiveTaskState;
  readonly executed: boolean;
  readonly unverifiedReplyCleared?: boolean;
  readonly summary?: string;
  readonly verbatim?: string;
  readonly needsConfirm?: string;
  readonly emotion?: string;
  readonly delivered: LiveTaskDelivery;
  readonly updatedSeq: number;
}

function createTask(draft: TaskDraft): LiveTaskRecord {
  return {
    taskId: draft.taskId,
    ...(draft.turnNo !== undefined ? { turnNo: draft.turnNo } : {}),
    epoch: draft.epoch,
    source: draft.source,
    query: draft.query,
    ...(draft.canonicalUser !== undefined ? { canonicalUser: draft.canonicalUser } : {}),
    ...(draft.toolCallId !== undefined ? { toolCallId: draft.toolCallId } : {}),
    state: draft.state,
    executed: draft.executed,
    ...(draft.unverifiedReplyCleared !== undefined ? { unverifiedReplyCleared: draft.unverifiedReplyCleared } : {}),
    ...(draft.summary !== undefined ? { summary: draft.summary } : {}),
    ...(draft.verbatim !== undefined ? { verbatim: draft.verbatim } : {}),
    ...(draft.needsConfirm !== undefined ? { needsConfirm: draft.needsConfirm } : {}),
    ...(draft.emotion !== undefined ? { emotion: draft.emotion } : {}),
    delivered: draft.delivered,
    updatedSeq: draft.updatedSeq,
  };
}

function snapshotFacts(state: LiveSessionState): readonly string[] {
  const active: string[] = [];
  const terminals: LiveTaskRecord[] = [];
  for (const taskId of state.taskOrder) {
    const task = state.tasks[taskId];
    if (task === undefined || task.epoch !== state.epoch || isSilentTask(task)) continue;
    if (task.state === 'queued' || task.state === 'running') {
      active.push(taskLine(task));
      continue;
    }
    if (isTerminal(task.state)) terminals.push(task);
  }
  terminals.sort((a, b) => a.updatedSeq - b.updatedSeq);
  const recentTerminals = terminals.slice(-MAX_TERMINALS).map(taskLine);
  const corrections: string[] = [];
  for (let i = state.turns.length - 1; i >= 0 && corrections.length < MAX_CORRECTIONS; i -= 1) {
    const turn = state.turns[i];
    if (turn === undefined || turn.epoch !== state.epoch) continue;
    const canonical = turn.canonicalUser?.trim() ?? '';
    if (canonical === '' || canonical === turn.rawAsr.trim()) continue;
    corrections.push(correctionLine(turn, canonical));
  }
  corrections.reverse();
  return [...active, ...recentTerminals, ...corrections];
}

function taskLine(task: LiveTaskRecord): string {
  const head = task.turnNo === undefined
    ? `任务 ${task.taskId}`
    : `任务 ${task.taskId} | 轮次 ${task.turnNo}`;
  return `- ${head} | 查询：${oneLine(task.query)} | ${statusClause(task)}`;
}

function statusClause(task: LiveTaskRecord): string {
  if (task.state === 'queued' || task.state === 'running') {
    const extra = task.unverifiedReplyCleared === true ? '，此前口头回复未经执行核实' : '';
    return `状态=${task.state}（未执行完${extra}）`;
  }
  if (task.state === 'completed') {
    return `状态=completed（已核实，${deliveryLabel(task.delivered)}） | 结论：${oneLine(task.summary ?? '')}${confirmClause(task)}`;
  }
  if (task.state === 'failed') {
    return `状态=failed（未成功，${deliveryLabel(task.delivered)}） | 说明：${oneLine(task.summary ?? '')}`;
  }
  return '状态=cancelled（哥已取消，未执行完）';
}

function confirmClause(task: LiveTaskRecord): string {
  if (task.needsConfirm === undefined || task.needsConfirm.trim() === '') return '';
  return ` | 待确认：${oneLine(task.needsConfirm)}`;
}

function deliveryLabel(delivered: LiveTaskDelivery): string {
  switch (delivered) {
    case 'pending':
      return '尚未播报给哥';
    case 'spoken':
      return '已口头告知哥';
    case 'interrupted':
      return '播报被打断';
    case 'dropped':
      return '未再播报';
    case 'silent':
      return '不播报';
    default: {
      const neverDelivery: never = delivered;
      return neverDelivery;
    }
  }
}

function correctionLine(turn: LiveTurnRecord, canonical: string): string {
  return `- 已核实说法：第${turn.turnNo}轮「${oneLine(turn.rawAsr)}」→「${oneLine(canonical)}」`;
}

function joinSnapshot(facts: readonly string[]): string {
  return [SNAPSHOT_TITLE, ...facts].join('\n');
}

function recentDialogTurns(turns: readonly LiveTurnRecord[], limit: number): readonly LiveTurnRecord[] {
  if (limit <= 0) return [];
  const picked: LiveTurnRecord[] = [];
  for (let i = turns.length - 1; i >= 0 && picked.length < limit; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const user = (turn.canonicalUser ?? turn.rawAsr).trim();
    const assistant = turn.assistantSpoken.trim();
    if (user === '' && assistant === '') continue;
    picked.push(turn);
  }
  picked.reverse();
  return picked;
}

function appendDialogLines(lines: string[], turn: LiveTurnRecord): void {
  const user = (turn.canonicalUser ?? turn.rawAsr).trim();
  const assistant = turn.assistantSpoken.trim();
  if (user === '' && assistant === '') return;
  if (user !== '') lines.push(`用户：${user}`);
  if (assistant !== '' || turn.truncated) {
    lines.push(`米馍：${assistant}${turn.truncated ? '（被打断）' : ''}`);
  }
}

function dropPendingDeliveries(
  state: LiveSessionState,
  seq: number,
): Readonly<Record<string, LiveTaskRecord>> {
  let tasks: Record<string, LiveTaskRecord> | null = null;
  for (const taskId of state.taskOrder) {
    const task = state.tasks[taskId];
    if (task === undefined || task.delivered !== 'pending') continue;
    if (tasks === null) tasks = { ...state.tasks };
    tasks[taskId] = { ...task, delivered: 'dropped', updatedSeq: seq };
  }
  return tasks ?? state.tasks;
}

function clearOmniIds(turn: LiveTurnRecord): LiveTurnRecord {
  const userCleared = turn.omniUserItemId === null;
  if (userCleared && turn.omniAssistantItemIds.length === 0) return turn;
  return { ...turn, omniUserItemId: null, omniAssistantItemIds: [] };
}

/**
 * 已清空过的轮次不再删第二遍。新记到账本上的助手项仍然要删：
 * 那些才是后又冒出来的未核实回复。
 */
function deleteIds(
  turn: LiveTurnRecord | undefined,
  incoming: readonly string[] | undefined,
  existing: LiveTaskRecord | undefined,
): readonly string[] {
  const stored = turn?.omniAssistantItemIds ?? [];
  const alreadyCleared = existing?.unverifiedReplyCleared === true && stored.length === 0;
  if (alreadyCleared) return [];
  return dedupeIds([...stored, ...(incoming ?? [])]);
}

function deliverEffect(
  report: BackgroundTaskReport,
  extra: {
    readonly turnNo: number | undefined;
    readonly canonicalUser?: string | undefined;
    readonly previousUserText?: string | undefined;
  },
): LiveSessionEffect {
  return {
    type: 'deliver_report',
    report,
    ...(extra.previousUserText !== undefined ? { previousUserText: extra.previousUserText } : {}),
    ...(extra.canonicalUser !== undefined ? { canonicalUser: extra.canonicalUser } : {}),
    ...(extra.turnNo !== undefined ? { turnNo: extra.turnNo } : {}),
  };
}

function acceptedToolOutput(taskId: string): string {
  return JSON.stringify({
    taskId,
    status: 'accepted_running',
    executed: false,
    note: ACCEPTED_NOTE,
  });
}

function insertSync(effects: readonly LiveSessionEffect[], sync: LiveSessionEffect): readonly LiveSessionEffect[] {
  const index = effects.findIndex((effect) => effect.type === 'deliver_report');
  if (index === -1) return [...effects, sync];
  return [...effects.slice(0, index), sync, ...effects.slice(index)];
}

function locateTurn(
  turns: readonly LiveTurnRecord[],
  epoch: number,
  turnNo: number,
): { readonly index: number; readonly turn: LiveTurnRecord } | undefined {
  const index = findTurn(turns, epoch, turnNo);
  if (index < 0) return undefined;
  const turn = turns[index];
  if (turn === undefined) return undefined;
  return { index, turn };
}

function findTurn(turns: readonly LiveTurnRecord[], epoch: number, turnNo: number): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn !== undefined && turn.epoch === epoch && turn.turnNo === turnNo) return i;
  }
  return -1;
}

function findTicket(
  turns: readonly LiveTurnRecord[],
  ticket: { readonly no: number; readonly gen: number },
): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.ticket !== undefined && turn.ticket.no === ticket.no && turn.ticket.gen === ticket.gen) {
      return i;
    }
  }
  return -1;
}

function placeTurn(turns: readonly LiveTurnRecord[], turn: LiveTurnRecord): readonly LiveTurnRecord[] {
  const index = findTurn(turns, turn.epoch, turn.turnNo);
  if (index >= 0) {
    const current = turns[index];
    if (current !== undefined && sameTurn(current, turn)) return turns;
    return replaceAt(turns, index, turn);
  }
  const appended = [...turns, turn];
  return appended.length <= MAX_TURNS ? appended : appended.slice(appended.length - MAX_TURNS);
}

function replaceAt<T>(items: readonly T[], index: number, next: T): readonly T[] {
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

function putTask(
  tasks: Readonly<Record<string, LiveTaskRecord>>,
  task: LiveTaskRecord,
): Readonly<Record<string, LiveTaskRecord>> {
  return { ...tasks, [task.taskId]: task };
}

function withTaskId(order: readonly string[], taskId: string): readonly string[] {
  for (const id of order) {
    if (id === taskId) return order;
  }
  return [...order, taskId];
}

function isTerminal(state: LiveTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function isSilentTask(task: LiveTaskRecord): boolean {
  return task.source === 'memory_silent' || task.delivered === 'silent';
}

function isSilentReport(
  source: BackgroundTaskSource | undefined,
  silent: boolean | undefined,
  existing: LiveTaskRecord | undefined,
): boolean {
  if (silent === true || source === 'memory_silent') return true;
  return existing !== undefined && isSilentTask(existing);
}

function isCallId(callId: string | null | undefined): callId is string {
  return typeof callId === 'string' && callId !== '';
}

function supplementCallId(
  current: string | null | undefined,
  incoming: string | null | undefined,
): string | null | undefined {
  if (current !== undefined && current !== null && current !== '') return current;
  return incoming !== undefined ? incoming : current;
}

function trimmed(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const value = text.trim();
  return value === '' ? undefined : value;
}

function copyIds(ids: readonly string[] | undefined): readonly string[] {
  return ids === undefined ? [] : [...ids];
}

function dedupeIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function oneLine(text: string): string {
  return text.split(/\s+/).filter((part) => part !== '').join(' ');
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

function clipCodePoints(text: string, max: number): string {
  if (max <= 0) return '';
  let out = '';
  let count = 0;
  for (const char of text) {
    if (count >= max) break;
    out += char;
    count += 1;
  }
  return out;
}

function sameTask(existing: LiveTaskRecord | undefined, next: LiveTaskRecord): boolean {
  if (existing === undefined) return false;
  return existing.taskId === next.taskId
    && existing.turnNo === next.turnNo
    && existing.epoch === next.epoch
    && existing.source === next.source
    && existing.query === next.query
    && existing.canonicalUser === next.canonicalUser
    && existing.toolCallId === next.toolCallId
    && existing.state === next.state
    && existing.executed === next.executed
    && existing.unverifiedReplyCleared === next.unverifiedReplyCleared
    && existing.summary === next.summary
    && existing.verbatim === next.verbatim
    && existing.needsConfirm === next.needsConfirm
    && existing.emotion === next.emotion
    && existing.delivered === next.delivered;
}

function sameTurn(a: LiveTurnRecord, b: LiveTurnRecord): boolean {
  return a.turnNo === b.turnNo
    && a.epoch === b.epoch
    && a.ticket?.no === b.ticket?.no
    && a.ticket?.gen === b.ticket?.gen
    && a.rawAsr === b.rawAsr
    && a.canonicalUser === b.canonicalUser
    && a.lane === b.lane
    && a.assistantSpoken === b.assistantSpoken
    && a.truncated === b.truncated
    && a.endedAtMs === b.endedAtMs
    && a.omniUserItemId === b.omniUserItemId
    && a.toolCallId === b.toolCallId
    && a.taskId === b.taskId
    && sameIds(a.omniAssistantItemIds, b.omniAssistantItemIds);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
