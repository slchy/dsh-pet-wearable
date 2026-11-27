/**
 * Pure Live 的后台任务总线。
 *
 * 前台对话和 dsh 执行拆开：`dispatch` 收的是本轮要交给 dsh 的查询（早规则、
 * tool_call、识图、静默记忆），`ingestExternalAnnouncement` 收的是 dsh 自己
 * `run_in_background` / 子代理跑完后的 `onAnnounce`。两条路都收成
 * `BackgroundTaskReport`，由唯一前台决定什么时候说。
 *
 * 工人循环一次只跑一个 `runner.execute`，避免单会话 dsh RPC 叠在一起。
 * 循环晚一个微任务才取队列，这样同一个同步回合里先到的 `early_rule` 和后到的
 * `tool_call` 能合成一次调用，而不是打成两轮。
 */
import { cleanForSpeech } from './agent.ts';
import { asEmotion, DEFAULT_EMOTION, parseEmotion } from './emotion.ts';
import type { AgentImage, BackgroundTaskReport, BackgroundTaskSource } from './providers.ts';

/** 给前台的逐字稿超过这个长度时，`summary` 只留这么多码点，全文在 `verbatim`。 */
const SUMMARY_LIMIT = 160;
const DEFAULT_MAX_QUEUE = 16;
const FAILURE_SUMMARY = '刚才那个任务没跑成，稍后可以再让我试一次。';

const VERBATIM_TAG = /[\[【]\s*VERBATIM\s*[\]】]/;
/**
 * 首行原意标签。只认文本开头那一个，标签本身必须在同一行。
 *
 * 括号、冒号中英文都行，标签内外允许空白。后面的一个换行或空格是分隔，
 * 不算进正文。内容 trim 后为空则当作没有原意。
 */
const CANONICAL_USER_TAG =
  /^\s*[\[【][^\S\r\n]*原意[^\S\r\n]*[:：][^\S\r\n]*([^\r\n\]】]*?)[^\S\r\n]*[\]】][^\S\r\n]*(?:\r?\n)?/u;
const LONG_DIGITS = /\d{5,}/;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
/** 订单号一类：1–4 个大写字母接至少 4 位数字，例如 `W8665881`、`AB1234`。 */
const ORDER_ID = /[A-Z]{1,4}\d{4,}/;
/**
 * 显式端口：`端口 8766`、`端口:8080`、`port=80`、`:8766`。
 * 不把 `2026年` 或 `晚上8点15分` 当成端口（冒号后至少 4 位，才避开钟点）。
 */
const EXPLICIT_PORT = /(?:端口|port)\s*[:：=]?\s*\d{2,5}\b|:\d{4,5}\b/iu;
/** semver：`v2.3.1`、`2.3.1`、`1.0.0-beta.1`。 */
const SEMVER = /\bv?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/u;
const CODE_EXT = 'ts|tsx|js|jsx|mjs|cjs|py|yml|yaml|json|toml|md|go|rs|sh|java|kt|swift|css|html|vue|c|cpp|h';
/** 至少含一个 `/` 或 `\` 的代码路径。单独的 `main.ts` 不算。 */
const CODE_PATH = new RegExp(
  `(?:[\\w+@-]+[/\\\\])+[\\w+@.-]+\\.(?:${CODE_EXT})\\b|(?:[A-Za-z]:[/\\\\])[\\w+@.-]+\\.(?:${CODE_EXT})\\b`,
);

/**
 * 后台结果里有没有必须逐字念的字面量。
 *
 * 普通短句（天气、闹钟、年份、钟点）返回 false，交给全双工自己说。
 * 端口、版本号、订单号、路径、显式 `[VERBATIM]`、超长正文返回 true，走逐字朗读。
 */
export function needsVerbatimRead(text: string): boolean {
  if (VERBATIM_TAG.test(text)) return true;
  if (LONG_DIGITS.test(text)) return true;
  if (IPV4.test(text)) return true;
  if (CODE_PATH.test(text)) return true;
  if (ORDER_ID.test(text)) return true;
  if (EXPLICIT_PORT.test(text)) return true;
  if (SEMVER.test(text)) return true;
  const trimmed = text.trim();
  // 码元数 ≤ 180 时码点数只可能更少，不必把字符串展开。
  if (trimmed.length <= 180) return false;
  return [...trimmed].length > 180;
}

/** 去掉 `[VERBATIM]` / `【VERBATIM】`，其余字符原样留下。 */
export function stripVerbatimTag(text: string): string {
  return text.replace(/[\[【]\s*VERBATIM\s*[\]】]/g, '');
}

/** dsh 异步移交后只回这一行：`[ASYNC]` / `【ASYNC】`。 */
const ASYNC_DISPATCH_TAG = /^\s*[\[【]\s*ASYNC\s*[\]】]\s*$/iu;

/**
 * 文本剥掉可选情绪标签后是不是纯异步移交标记。
 *
 * `[ASYNC]` 有 5 个字，`parseEmotion` 的标签括号只认 1–4 个字，不会把它当情绪；
 * 但 `[开心][ASYNC]` 会先剥掉 `[开心]`。这里按剥完的结果判断。
 */
export function isAsyncDispatchTag(text: string): boolean {
  if (typeof text !== 'string') return false;
  const { rest } = parseEmotion(text);
  return ASYNC_DISPATCH_TAG.test(rest.trim());
}

/**
 * 剥掉开头的 `[原意: …]` / `【原意：…】`。
 *
 * 没有这个标签时原样返回 `{ body: text }`。标签里的字 trim 后为空，
 * 就只剥标签、不带 `canonicalUser`。
 */
export function parseCanonicalUserTag(text: string): {
  readonly canonicalUser?: string;
  readonly body: string;
} {
  const match = CANONICAL_USER_TAG.exec(text);
  if (match === null) return { body: text };
  const matched = match[0] ?? '';
  if (matched === '') return { body: text };
  const canonicalUser = (match[1] ?? '').trim();
  const body = text.slice(matched.length);
  if (canonicalUser === '') return { body };
  return { canonicalUser, body };
}

/** 按码点截断。没超过上限时返回原字符串。 */
export function clipSummary(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max)).join('');
}

/**
 * 后台任务状态。
 *
 * 只允许：
 * - queued → running | cancelled
 * - running → completed | failed | cancelled
 *
 * completed / failed / cancelled 是终态。取消或 `dispose` 之后 runner 才回来的
 * 结果直接丢掉，不再发 `BackgroundTaskReport`。
 */
export type BackgroundTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTaskRequest {
  /** 关联的对话轮次号（用于 early_rule 与 tool_call 去重；可选） */
  readonly turnNo?: number;
  readonly query: string;
  readonly source: BackgroundTaskSource;
  readonly image?: AgentImage;
  readonly note?: string;
  /** 触发这条任务那一整句的高精度人声 PCM，可选透传给执行器。 */
  readonly utterancePcm?: Buffer;
  /** 为真时不触发任何播报/前台汇报（用于 `memory_silent` 后台静默写入 MEMORY.md） */
  readonly silent?: boolean;
}

export interface BackgroundTaskHandle {
  readonly taskId: string;
  readonly turnNo?: number;
  readonly source: BackgroundTaskSource;
  readonly silent: boolean;
  readonly deduplicated: boolean;
  state(): BackgroundTaskState;
}

export interface BackgroundTaskRunner {
  /**
   * 跑一条任务。`signal` abort 或 `cancelRunning` 之后这个 Promise 必须 settle，
   * 总线要等它结束才取下一条；settle 时任务若已不是 running，结果会被丢掉。
   */
  execute(req: {
    readonly taskId: string;
    readonly query: string;
    readonly image?: AgentImage;
    readonly note?: string;
    readonly silent: boolean;
    /** 整句高精度人声；调用方没给就不带这个键。 */
    readonly utterancePcm?: Buffer;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly text: string;
    readonly speech?: string;
    readonly emotion?: string;
    /**
     * dsh 已把这条任务异步派给 `subagent` / 后台 `job`，本轮只是「已接下」而非终态。
     * 工人循环必须立刻放开，等 dsh 自己的回调轮经 `ingestExternalAnnouncement` 结算。
     */
    readonly asyncDispatched?: boolean;
    /** 异步移交的底层目标 id（`subagent` 的 `childId`/`agent_id` 或 `jobId`）。 */
    readonly asyncTargetId?: string;
  }>;
  /** 显式取消正在运行的底层 dsh 轮次/后台任务 */
  cancelRunning?(reason: string): void;
}

/**
 * 总线状态迁移。监听抛错会被吃掉，不能打断工人循环。
 *
 * `completed` / `failed` 的 `report` 只在这条任务要播报时带上：
 * 静默任务、以及洗完没有可说正文的完成，都不带。
 */
export type BackgroundTaskLifecycleEvent =
  | {
      readonly type: 'queued';
      readonly taskId: string;
      readonly turnNo?: number;
      readonly source: BackgroundTaskSource;
      readonly query: string;
      readonly silent: boolean;
    }
  | {
      readonly type: 'upgraded';
      readonly taskId: string;
      readonly turnNo?: number;
      readonly source: BackgroundTaskSource;
      readonly query: string;
      readonly silent: boolean;
    }
  | {
      readonly type: 'running';
      readonly taskId: string;
      readonly turnNo?: number;
      readonly source: BackgroundTaskSource;
      readonly query: string;
      readonly silent: boolean;
    }
  | {
      readonly type: 'completed';
      readonly taskId: string;
      readonly turnNo?: number;
      readonly source: BackgroundTaskSource;
      readonly query: string;
      readonly silent: boolean;
      readonly report?: BackgroundTaskReport;
    }
  | {
      readonly type: 'failed';
      readonly taskId: string;
      readonly turnNo?: number;
      readonly source: BackgroundTaskSource;
      readonly query: string;
      readonly silent: boolean;
      readonly error: string;
      readonly report?: BackgroundTaskReport;
    }
  | {
      readonly type: 'cancelled';
      readonly taskId: string;
      readonly turnNo?: number;
      readonly source: BackgroundTaskSource;
      readonly query: string;
      readonly silent: boolean;
      readonly reason: string;
    };

export interface BackgroundTaskBusOptions {
  readonly runner: BackgroundTaskRunner;
  readonly onReport: (report: BackgroundTaskReport) => void;
  /** 状态迁移通知。抛错只记日志，不影响入队、执行和播报。 */
  readonly onLifecycle?: (event: BackgroundTaskLifecycleEvent) => void;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** 队列上限（防异常洪峰，默认 16）。只数还在排队的，不算正在跑的那条。 */
  readonly maxQueue?: number;
}

interface TaskRecord {
  readonly taskId: string;
  readonly turnNo?: number;
  /** 创建时的 `sessionEpoch`。上一代的轮次不能挡住重连后的同号轮。 */
  readonly epoch: number;
  query: string;
  readonly source: BackgroundTaskSource;
  image?: AgentImage;
  note?: string;
  utterancePcm?: Buffer;
  readonly silent: boolean;
  state: BackgroundTaskState;
  controller: AbortController | null;
  /** 异步移交的目标 id：回调带同一个 id 时一次结清同目标的全部挂起任务。 */
  asyncTargetId?: string;
}

interface Spoken {
  readonly clean: string;
  readonly emotion: string;
  readonly verbatim: boolean;
  /** 模型纠正后的用户原话。没有 `[原意]`，或标签是空的，就不带。 */
  readonly canonicalUser?: string;
}

function isSilentRequest(req: BackgroundTaskRequest): boolean {
  return req.silent === true || req.source === 'memory_silent';
}

function canMove(from: BackgroundTaskState, to: BackgroundTaskState): boolean {
  if (from === 'queued') return to === 'running' || to === 'cancelled';
  if (from === 'running') return to === 'completed' || to === 'failed' || to === 'cancelled';
  return false;
}

function move(task: TaskRecord, to: BackgroundTaskState): boolean {
  if (!canMove(task.state, to)) return false;
  task.state = to;
  return true;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 上游因宿主侧取消抛出的错（`InProcessDshAgent` 的 `TURN_ABORTED` 走这里）。 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const code = (err as { code?: unknown }).code;
  return code === 'ABORT_ERR' || code === 'TURN_ABORTED';
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`);
}

/** 去掉空白后的 2-gram 集合，用来判断两条查询是不是在说同一件事。 */
function bigramsOf(text: string): ReadonlySet<string> {
  const chars = [...text.replace(/\s+/g, '')];
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

function overlapScore(query: string, haystack: ReadonlySet<string>): number {
  let hits = 0;
  for (const gram of bigramsOf(query)) {
    if (haystack.has(gram)) hits += 1;
  }
  return hits;
}

function readResult(result: unknown): { text: string; speech?: string; emotion?: string } {
  if (typeof result !== 'object' || result === null) return { text: '' };
  const record = result as { text?: unknown; speech?: unknown; emotion?: unknown };
  return {
    text: typeof record.text === 'string' ? record.text : '',
    speech: typeof record.speech === 'string' ? record.speech : undefined,
    emotion: typeof record.emotion === 'string' ? record.emotion : undefined,
  };
}

function readAsyncDispatched(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  return (result as { asyncDispatched?: unknown }).asyncDispatched === true;
}

/** 异步移交的目标 id（去空白；空串 / 非字符串都当没有）。 */
function readAsyncTargetId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const value = (result as { asyncTargetId?: unknown }).asyncTargetId;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 同目标的多条任务合并成一条播报时，查询按派发顺序去重后用 `；` 连起来。 */
function combineQueries(tasks: readonly TaskRecord[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const task of tasks) {
    const query = task.query.trim();
    if (query === '' || seen.has(query)) continue;
    seen.add(query);
    parts.push(query);
  }
  return parts.join('；');
}

/**
 * `[原意]` 和 `[VERBATIM]` 都比情绪标签长，`parseEmotion` 的括号只认 1–4 个字，剥不掉。
 * 原意若留在正文里会被朗读，也会混进 `summary` / `verbatim`；逐字标签若挡在
 * `[开心]` 前面，情绪会丢。所以先剥原意，再剥逐字标签，然后解析情绪。
 * 原意优先用 `text` 里非空的那条，没有再看 `speech`。
 */
function speakable(text: string, speech: string | undefined, emotionHint: string | undefined): Spoken {
  const fromText = parseCanonicalUserTag(text);
  const fromSpeech = speech === undefined ? undefined : parseCanonicalUserTag(speech);
  const canonicalUser = fromText.canonicalUser ?? fromSpeech?.canonicalUser;
  const textBody = fromText.body;
  const speechBody = fromSpeech?.body;
  const parsed = parseEmotion(stripVerbatimTag(textBody));
  let body = parsed.rest;
  let emotion = parsed.emotion;
  if (speechBody !== undefined && speechBody.trim() !== '') {
    const parsedSpeech = parseEmotion(stripVerbatimTag(speechBody));
    body = parsedSpeech.rest;
    if (parsedSpeech.emotion !== DEFAULT_EMOTION) emotion = parsedSpeech.emotion;
  }
  if (emotionHint !== undefined) emotion = asEmotion(emotionHint);
  const verbatim = needsVerbatimRead(textBody)
    || (speechBody !== undefined && speechBody !== textBody && needsVerbatimRead(speechBody));
  const clean = cleanForSpeech(body);
  if (canonicalUser === undefined) return { clean, emotion, verbatim };
  return { clean, emotion, verbatim, canonicalUser };
}

export class BackgroundTaskBus {
  private readonly runner: BackgroundTaskRunner;
  private readonly onReport: (report: BackgroundTaskReport) => void;
  private readonly onLifecycle: ((event: BackgroundTaskLifecycleEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxQueue: number;

  /**
   * 工人循环相位。三个平级布尔收成这一份，避免「已释放但仍在排空」。
   *
   * 合法迁移只有：`idle → scheduled → draining → idle|scheduled`，
   * 以及任意态 → `disposed`（吸收态，不可再离开）。
   */
  private phase: 'idle' | 'scheduled' | 'draining' | 'disposed' = 'idle';
  private seq = 0;
  private running: TaskRecord | null = null;
  private readonly reportable: TaskRecord[] = [];
  private readonly silentQueue: TaskRecord[] = [];
  /**
   * 已经交给 dsh 异步执行、还在等回调的活。
   *
   * 它们没有占住 `running` 槽（那槽一放开，`drain()` 才能取下一件），
   * 但状态仍是 `running`：`hasActiveReportable` / `activeCount` 都得算上，
   * 取消时也要在这里一起摘掉。
   */
  private readonly asyncPending: TaskRecord[] = [];
  /**
   * 要播报的任务按 turnNo 留到 completed，失败和取消会摘掉，同一会话里才能再派。
   * 进程级总线跨重连还在，轮次却从 1 重新编号；`resetSession()` 必须把这里清掉。
   */
  private readonly byTurn = new Map<number, TaskRecord>();
  /** 每次 `resetSession()` 加一。去重只认当前这一代。 */
  private sessionEpoch = 0;

  constructor(options: BackgroundTaskBusOptions) {
    this.runner = options.runner;
    this.onReport = options.onReport;
    this.onLifecycle = options.onLifecycle;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    const requested = options.maxQueue;
    this.maxQueue = requested !== undefined && requested > 0 ? requested : DEFAULT_MAX_QUEUE;
  }

  dispatch(req: BackgroundTaskRequest): BackgroundTaskHandle {
    if (this.phase === 'disposed') return this.deadHandle(req);
    const existing = this.findLive(req);
    if (existing !== undefined) {
      // 已经 running / completed 的查询冻住。tool_call 的改写只在还排队时生效，
      // 所以调用方不能先把 early_rule 推进微任务再等 Omni。
      const upgraded = existing.state === 'queued' && req.source === 'tool_call';
      if (upgraded) {
        existing.query = req.query;
        if (req.note !== undefined) existing.note = req.note;
        if (req.utterancePcm !== undefined) existing.utterancePcm = req.utterancePcm;
      }
      this.writeLog(
        `  后台    去重 ${existing.taskId} turn=${String(req.turnNo)}${upgraded ? ' 升级查询' : ''}`,
      );
      if (upgraded) {
        this.emitLifecycle({ type: 'upgraded', ...this.taskLifecycle(existing) });
      }
      return this.toHandle(existing, true);
    }
    if (this.queuedCount() >= this.maxQueue) {
      this.writeLog(`  后台    队列已满（${this.maxQueue}），丢弃`);
      return this.deadHandle(req);
    }
    const task = this.create(req);
    this.remember(task);
    if (task.silent) this.silentQueue.push(task);
    else this.reportable.push(task);
    this.writeLog(
      `  后台    入队 ${task.taskId} ${task.source}${task.silent ? ' 静默' : ''} turn=${task.turnNo ?? '-'}`,
    );
    this.emitLifecycle({ type: 'queued', ...this.taskLifecycle(task) });
    this.kick();
    return this.toHandle(task, false);
  }

  /**
   * dsh 自己的后台作业 / 子代理跑完了。不进队列（那边已经执行完），
   * 只把正文收成和 `dispatch` 一样的汇报。
   *
   * `targetId` 是回调轮带回来的目标 id（`subagent` 的 `senderSessionId` 或 `jobId`）：
   * 同一次回调可能对应多条挂起任务（同一个可续写子代理被 `send_message` 连续唤醒），
   * 带 id 时按 id 精确归并结算；不带时仍按旧的查询重合 / FIFO 配对。
   */
  ingestExternalAnnouncement(rawText: string, emotion?: string, query?: string, targetId?: string): void {
    if (this.phase === 'disposed') return;
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      this.writeLog('  后台    外部播报为空，忽略');
      return;
    }
    // dsh 派发后的 `[ASYNC]` 回执不是结论，绝不能当成一次播报
    if (isAsyncDispatchTag(rawText)) {
      this.writeLog('  后台    异步移交标记，忽略');
      return;
    }
    const spoken = speakable(rawText, undefined, emotion);
    if (spoken.clean === '') {
      this.writeLog('  后台    外部播报为空，忽略');
      return;
    }
    const normalizedTarget = typeof targetId === 'string' ? targetId.trim() : '';
    if (normalizedTarget !== '') {
      if (this.settleByTarget(normalizedTarget, spoken)) return;
    }
    if (this.asyncPending.length > 0) {
      const task = this.takeMatchingAsyncPending(
        spoken.clean,
        spoken.canonicalUser,
        query,
        normalizedTarget !== '',
      );
      if (task !== undefined && move(task, 'completed')) {
        this.dropTurn(task);
        const report = this.toReport(task.taskId, task.source, task.query, spoken, task.turnNo);
        this.writeLog(`  后台    异步回调完成 ${task.taskId} → ${preview(report.summary)}`);
        this.emitLifecycle({ type: 'completed', ...this.taskLifecycle(task), report });
        this.deliver(report);
        return;
      }
    }
    const taskId = this.allocateId();
    this.writeLog(`  后台    外部播报 ${taskId} → ${preview(spoken.clean)}`);
    this.deliver(this.toReport(taskId, 'dsh_background', query ?? '', spoken));
  }

  /**
   * 按目标 id 归并结算。
   *
   * 同一个可续写子代理被 `send_message` 连续唤醒时，语音侧为每卷各排了一条任务；
   * dsh 只回调一次、带回合并后的总结。这里把同目标的任务一次结清：第一条正常播报
   * （`query` 合并成 `'卷一；卷二；卷三'`），其余只发 `completed` 生命周期、
   * 不重复出声，消除幽灵 `running`。
   *
   * @returns true = 这次回调属于这个目标，调用方不要再走普通外部播报。
   */
  private settleByTarget(targetId: string, spoken: Spoken): boolean {
    const matched = this.takeAsyncPendingByTarget(targetId);
    if (matched.length === 0) return false;
    const running = matched.filter((task) => task.state === 'running');
    const primary = running[0];
    if (primary === undefined) return true;
    const combinedQuery = combineQueries(running);
    if (!move(primary, 'completed')) return true;
    this.dropTurn(primary);
    const report = this.toReport(primary.taskId, primary.source, combinedQuery, spoken, primary.turnNo);
    this.writeLog(
      `  后台    异步回调完成 ${primary.taskId}（同目标 ${running.length} 条） → ${preview(report.summary)}`,
    );
    this.emitLifecycle({ type: 'completed', ...this.taskLifecycle(primary), query: combinedQuery, report });
    this.deliver(report);
    for (const sibling of running.slice(1)) {
      if (!move(sibling, 'completed')) continue;
      this.dropTurn(sibling);
      this.emitLifecycle({ type: 'completed', ...this.taskLifecycle(sibling) });
    }
    return true;
  }

  /** 从 `asyncPending` 按派发顺序摘出所有绑到同一个目标的任务。 */
  private takeAsyncPendingByTarget(targetId: string): TaskRecord[] {
    const matched: TaskRecord[] = [];
    const keep: TaskRecord[] = [];
    for (const task of this.asyncPending) {
      if (task.asyncTargetId === targetId) matched.push(task);
      else keep.push(task);
    }
    if (matched.length === 0) return matched;
    this.asyncPending.length = 0;
    this.asyncPending.push(...keep);
    return matched;
  }

  /**
   * 从 `asyncPending` 里挑一条最可能是这次回调的任务。
   *
   * 只有一条就直接认领。多条时按 **2-gram 重合度** 打分（查询 vs 回调里的
   * query / 原意 / 正文）；最高分仍为 0（完全不重合）就按 FIFO 取最早那条 ——
   * 回调没带 query 时，dsh 通常按派发顺序结算。
   *
   * `onlyUnbound` 用于「回调带了 targetId、但没有任何任务绑到这个目标」：
   * 此时只能认领未绑定目标的任务，绝不能把已绑到别的目标的在跑任务错算完成。
   */
  private takeMatchingAsyncPending(
    clean: string,
    canonicalUser: string | undefined,
    query: string | undefined,
    onlyUnbound = false,
  ): TaskRecord | undefined {
    const candidates = onlyUnbound
      ? this.asyncPending.filter((task) => task.asyncTargetId === undefined)
      : this.asyncPending;
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) {
      const only = candidates[0];
      if (only === undefined) return undefined;
      this.removeAsyncPending(only);
      return only;
    }
    const haystack = bigramsOf(`${query ?? ''} ${canonicalUser ?? ''} ${clean}`);
    let best: TaskRecord | undefined;
    let bestScore = 0;
    for (const task of candidates) {
      const score = overlapScore(task.query, haystack);
      if (score > bestScore) {
        bestScore = score;
        best = task;
      }
    }
    const picked = best ?? candidates[0];
    if (picked === undefined) return undefined;
    this.removeAsyncPending(picked);
    return picked;
  }

  private removeAsyncPending(task: TaskRecord): void {
    const index = this.asyncPending.indexOf(task);
    if (index >= 0) this.asyncPending.splice(index, 1);
  }

  /** 正在跑的或还在排队的里面，有没有要向用户汇报的任务。 */
  hasActiveReportable(): boolean {
    const running = this.running;
    if (running !== null && running.state === 'running' && !running.silent) return true;
    if (this.asyncPending.some((task) => task.state === 'running' && !task.silent)) return true;
    return this.reportable.some((task) => task.state === 'queued');
  }

  /**
   * 排队中 + 正在跑。终态不算。
   *
   * `cancelAll` 把 `running.state` 写成 `cancelled` 之后，`runTask` 的 `finally`
   * 还没把槽位摘掉。这里只认 `queued` / `running`，不能见槽位非空就 +1，
   * 否则取消瞬间会把已经取消的那条再算成活跃。
   */
  activeCount(): number {
    let n = this.queuedCount();
    const running = this.running;
    if (running !== null && (running.state === 'queued' || running.state === 'running')) n += 1;
    for (const task of this.asyncPending) {
      if (task.state === 'running') n += 1;
    }
    return n;
  }

  /**
   * 停掉要播报的排队任务和正在跑的那条。
   *
   * `memory_silent` 默认不动：用户说「别查了」取消的是在等的答案，不是后台写记忆。
   * 传入 `includeSilent` 才把静默任务一起停掉。
   * 返回 true 当且仅当至少取消了一条要播报的任务。
   */
  cancelAll(reason = 'user_cancel', options?: { readonly includeSilent?: boolean }): boolean {
    if (this.phase === 'disposed') return false;
    const n = this.stopTasks(reason, options?.includeSilent === true, true);
    if (n > 0) this.writeLog(`  后台    取消 ${n} 个播报任务（${reason}）`);
    return n > 0;
  }

  /**
   * 设备重连、对话轮次从 1 重新编号时调用。可重复调用。
   *
   * 已完成的 `turnNo` 若一直留在 `byTurn`，新会话的第 1–N 轮会被当成重复任务丢掉。
   * 只清索引并推进代际：在跑的和还在排队的继续跑，不取消，也不释放总线。
   */
  resetSession(): void {
    this.byTurn.clear();
    this.sessionEpoch += 1;
  }

  /**
   * 连接断开时调用。幂等。
   *
   * 只停「还往这条连接上送汇报」。在途的 dsh 轮次不在这里 `cancelRunning`：
   * 作业可能还会自己跑完，结果留给离线补播。信号仍然 abort，迟到的
   * resolution 不会再变成这条连接的汇报。
   */
  dispose(): void {
    if (!this.movePhase('disposed')) return;
    this.stopTasks('dispose', true, false);
    this.writeLog('  后台    已释放');
  }

  private deadHandle(req: BackgroundTaskRequest): BackgroundTaskHandle {
    const silent = isSilentRequest(req);
    return {
      taskId: this.allocateId(),
      turnNo: req.turnNo,
      source: req.source,
      silent,
      deduplicated: false,
      state: () => 'cancelled',
    };
  }

  private create(req: BackgroundTaskRequest): TaskRecord {
    return {
      taskId: this.allocateId(),
      turnNo: req.turnNo,
      query: req.query,
      source: req.source,
      image: req.image,
      note: req.note,
      utterancePcm: req.utterancePcm,
      silent: isSilentRequest(req),
      epoch: this.sessionEpoch,
      state: 'queued',
      controller: null,
    };
  }

  private toHandle(task: TaskRecord, deduplicated: boolean): BackgroundTaskHandle {
    return {
      taskId: task.taskId,
      turnNo: task.turnNo,
      source: task.source,
      silent: task.silent,
      deduplicated,
      state: () => task.state,
    };
  }

  private findLive(req: BackgroundTaskRequest): TaskRecord | undefined {
    if (isSilentRequest(req) || req.turnNo === undefined) return undefined;
    const found = this.byTurn.get(req.turnNo);
    if (found === undefined) return undefined;
    if (found.epoch !== this.sessionEpoch) {
      this.byTurn.delete(req.turnNo);
      return undefined;
    }
    if (found.state === 'queued' || found.state === 'running' || found.state === 'completed') {
      return found;
    }
    this.byTurn.delete(req.turnNo);
    return undefined;
  }

  private remember(task: TaskRecord): void {
    if (task.silent || task.turnNo === undefined) return;
    this.byTurn.set(task.turnNo, task);
  }

  private dropTurn(task: TaskRecord): void {
    if (task.turnNo === undefined) return;
    if (this.byTurn.get(task.turnNo) === task) this.byTurn.delete(task.turnNo);
  }

  private allocateId(): string {
    this.seq += 1;
    return `bg-${this.seq}`;
  }

  private queuedCount(): number {
    return this.reportable.length + this.silentQueue.length;
  }

  /** 重新读吸收态。两次检查之间的纯函数调用不会被当成「相位可能变了」。 */
  private isDisposed(): boolean {
    return this.phase === 'disposed';
  }

  /**
   * 相位迁移。非法边（含 `disposed` 再离开）直接拒绝，调用方不得继续排空。
   */
  private movePhase(next: 'idle' | 'scheduled' | 'draining' | 'disposed'): boolean {
    const from = this.phase;
    if (from === 'disposed' || from === next) return false;
    const allowed = next === 'disposed'
      || (from === 'idle' && next === 'scheduled')
      || (from === 'scheduled' && next === 'draining')
      || (from === 'draining' && (next === 'idle' || next === 'scheduled'));
    if (!allowed) return false;
    this.phase = next;
    return true;
  }

  private kick(): void {
    // 正在 `draining` 时不能改成 `scheduled`：那会让当前循环提前退出，
    // 并让下一条微任务跟还没结束的 `execute` 叠在一起。新任务留在队列里，
    // 由这一轮循环或 `finally` 接走。
    if (this.phase !== 'idle') return;
    if (!this.movePhase('scheduled')) return;
    this.queueDrain();
  }

  private queueDrain(): void {
    queueMicrotask(() => {
      void this.drain().catch((err: unknown) => {
        this.writeLog(`  后台    循环异常：${errorText(err)}`);
      });
    });
  }

  private async drain(): Promise<void> {
    // `dispose()` 若赶在微任务之前把 `scheduled` 收成吸收态，这里进不了 `draining`。
    if (!this.movePhase('draining')) return;
    try {
      while (this.phase === 'draining') {
        const task = this.reportable.shift() ?? this.silentQueue.shift();
        if (task === undefined) break;
        if (task.state !== 'queued') continue;
        try {
          await this.runTask(task);
        } catch (err) {
          this.writeLog(`  后台    循环异常：${errorText(err)}`);
        }
      }
    } finally {
      if (this.phase !== 'draining') return;
      if (this.queuedCount() > 0) {
        if (this.movePhase('scheduled')) this.queueDrain();
      } else {
        this.movePhase('idle');
      }
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    if (this.phase === 'disposed' || task.state !== 'queued') return;
    const controller = new AbortController();
    task.controller = controller;
    if (!move(task, 'running')) {
      task.controller = null;
      return;
    }
    this.running = task;
    this.emitLifecycle({ type: 'running', ...this.taskLifecycle(task) });
    try {
      const result = await this.runner.execute({
        taskId: task.taskId,
        query: task.query,
        image: task.image,
        note: task.note,
        silent: task.silent,
        ...(task.utterancePcm === undefined ? {} : { utterancePcm: task.utterancePcm }),
        signal: controller.signal,
      });
      if (readAsyncDispatched(result)) {
        this.handoffAsync(task, readAsyncTargetId(result));
        return;
      }
      this.finishOk(task, result);
    } catch (err) {
      // 宿主侧取消不算失败：不播「刚才那个任务没跑成」。
      if (isAbortError(err)) this.finishCancelled(task, 'host_aborted');
      else this.finishErr(task, err);
    } finally {
      if (this.running === task) this.running = null;
      task.controller = null;
    }
  }

  /**
   * dsh 说这一轮只是「已派出去」。保留 `running`、从活跃槽里摘掉，让 `drain()`
   * 立刻取下一件 —— 主对话零阻塞。真正的结算在 `ingestExternalAnnouncement`。
   *
   * 等待期间被取消 / 总线被释放时什么都不做：那条已经按取消处理了。
   */
  private handoffAsync(task: TaskRecord, asyncTargetId: string | undefined): void {
    if (this.isDisposed() || task.state !== 'running') return;
    task.controller = null;
    if (asyncTargetId !== undefined) task.asyncTargetId = asyncTargetId;
    // 静默记忆写入不需要等外部播报回调结算，也不得占用播报任务的回调配对槽。
    if (task.silent) {
      if (!move(task, 'completed')) return;
      this.dropTurn(task);
      this.writeLog(`  后台    静默异步移交完成 ${task.taskId}`);
      this.emitLifecycle({ type: 'completed', ...this.taskLifecycle(task) });
      return;
    }
    this.asyncPending.push(task);
    this.writeLog(`  后台    异步移交 ${task.taskId}（等待 dsh 后台回调）`);
  }

  private finishOk(task: TaskRecord, result: unknown): void {
    if (task.state !== 'running' || this.isDisposed()) return;
    const raw = readResult(result);
    const spoken = speakable(raw.text, raw.speech, raw.emotion);
    if (task.state !== 'running' || this.isDisposed()) return;
    if (!move(task, 'completed')) return;
    const report = task.silent || spoken.clean === ''
      ? undefined
      : this.toReport(task.taskId, task.source, task.query, spoken, task.turnNo);
    if (task.silent) {
      this.writeLog(`  后台    静默完成 ${task.taskId}（不播报）`);
    } else if (report === undefined) {
      this.writeLog(`  后台    完成 ${task.taskId} 但清洗后为空，不播报`);
    } else {
      this.writeLog(`  后台    完成 ${task.taskId} → ${preview(report.summary)}`);
    }
    this.emitLifecycle(
      report === undefined
        ? { type: 'completed', ...this.taskLifecycle(task) }
        : { type: 'completed', ...this.taskLifecycle(task), report },
    );
    if (report !== undefined) this.deliver(report);
  }

  /**
   * 上游因宿主侧取消收尾：记 `cancelled`、摘掉同轮索引，**不发失败汇报**。
   * 用户自己按了停止，再说「刚才那个任务没跑成」是噪音。
   */
  private finishCancelled(task: TaskRecord, reason: string): void {
    if (task.state !== 'running' || this.phase === 'disposed') return;
    if (!move(task, 'cancelled')) return;
    this.dropTurn(task);
    this.writeLog(`  后台    取消 ${task.taskId}（${reason}）`);
    this.emitLifecycle({ type: 'cancelled', ...this.taskLifecycle(task), reason });
  }

  private finishErr(task: TaskRecord, err: unknown): void {
    if (task.state !== 'running' || this.phase === 'disposed') return;
    if (!move(task, 'failed')) return;
    this.dropTurn(task);
    const error = errorText(err);
    const report = task.silent ? undefined : this.failureReport(task);
    if (task.silent) {
      this.writeLog(`  后台    静默失败 ${task.taskId}：${error}（不播报）`);
    } else {
      this.writeLog(`  后台    失败 ${task.taskId}：${error}`);
    }
    this.emitLifecycle(
      report === undefined
        ? { type: 'failed', ...this.taskLifecycle(task), error }
        : { type: 'failed', ...this.taskLifecycle(task), error, report },
    );
    if (report !== undefined) this.deliver(report);
  }

  private toReport(
    taskId: string,
    source: BackgroundTaskSource,
    query: string,
    spoken: Spoken,
    turnNo?: number,
  ): BackgroundTaskReport {
    const summary = spoken.verbatim ? clipSummary(spoken.clean, SUMMARY_LIMIT) : spoken.clean;
    const report: BackgroundTaskReport = spoken.verbatim
      ? {
          taskId,
          source,
          query,
          summary,
          verbatim: spoken.clean,
          emotion: spoken.emotion,
        }
      : { taskId, source, query, summary, emotion: spoken.emotion };
    return this.withMeta(report, turnNo, spoken.canonicalUser);
  }

  private failureReport(task: TaskRecord): BackgroundTaskReport {
    return this.withMeta({
      taskId: task.taskId,
      source: task.source,
      query: task.query,
      summary: FAILURE_SUMMARY,
    }, task.turnNo, undefined);
  }

  /**
   * `turnNo` / `canonicalUser` 由并行改动加在 `BackgroundTaskReport` 上。
   * 这里只在有值时挂上，避免把空原意或未编号的轮次写成 `undefined`。
   */
  private withMeta(
    report: BackgroundTaskReport,
    turnNo: number | undefined,
    canonicalUser: string | undefined,
  ): BackgroundTaskReport {
    const meta: { turnNo?: number; canonicalUser?: string } = {};
    if (turnNo !== undefined) meta.turnNo = turnNo;
    if (canonicalUser !== undefined && canonicalUser !== '') meta.canonicalUser = canonicalUser;
    if (meta.turnNo === undefined && meta.canonicalUser === undefined) return report;
    return Object.assign({}, report, meta);
  }

  private taskLifecycle(task: TaskRecord): {
    readonly taskId: string;
    readonly turnNo?: number;
    readonly source: BackgroundTaskSource;
    readonly query: string;
    readonly silent: boolean;
  } {
    const base = {
      taskId: task.taskId,
      source: task.source,
      query: task.query,
      silent: task.silent,
    };
    if (task.turnNo === undefined) return base;
    return { ...base, turnNo: task.turnNo };
  }

  private emitLifecycle(event: BackgroundTaskLifecycleEvent): void {
    if (this.onLifecycle === undefined) return;
    try {
      this.onLifecycle(event);
    } catch (err) {
      this.writeLog(`  后台    生命周期回调异常：${errorText(err)}`);
    }
  }

  private deliver(report: BackgroundTaskReport): void {
    try {
      this.onReport(report);
    } catch (err) {
      this.writeLog(`  后台    汇报回调异常：${errorText(err)}`);
    }
  }

  /** @returns 这次实际取消掉的「要播报」任务数。静默任务不算。 */
  private stopTasks(reason: string, includeSilent: boolean, cancelRunner: boolean): number {
    let reportableCancelled = this.cancelQueued(this.reportable, reason);
    if (includeSilent) this.cancelQueued(this.silentQueue, reason);
    let cancelledLive = false;
    const running = this.running;
    if (running !== null && running.state === 'running' && (!running.silent || includeSilent)) {
      if (move(running, 'cancelled')) {
        this.dropTurn(running);
        running.controller?.abort(reason);
        this.emitLifecycle({ type: 'cancelled', ...this.taskLifecycle(running), reason });
        if (!running.silent) reportableCancelled += 1;
        cancelledLive = true;
      }
    }
    const pending = this.cancelAsyncPending(reason, includeSilent);
    reportableCancelled += pending.reportable;
    // 只有真取消了底层活才叫 `cancelRunning`；空取消不打扰 dsh。
    if (!cancelledLive && pending.total === 0) return reportableCancelled;
    if (cancelRunner) {
      try {
        this.runner.cancelRunning?.(reason);
      } catch (err) {
        this.writeLog(`  后台    取消底层任务失败：${errorText(err)}`);
      }
    }
    return reportableCancelled;
  }

  /**
   * 取消还在等 dsh 回调的任务。静默任务默认留着（除非 `includeSilent`）。
   *
   * @returns `total` 本次取消条数（驱动 `cancelRunning`），`reportable` 其中要播报的。
   */
  private cancelAsyncPending(
    reason: string,
    includeSilent: boolean,
  ): { readonly total: number; readonly reportable: number } {
    let total = 0;
    let reportable = 0;
    const keep: TaskRecord[] = [];
    for (const task of this.asyncPending) {
      if (task.silent && !includeSilent) {
        keep.push(task);
        continue;
      }
      if (task.state !== 'running' || !move(task, 'cancelled')) {
        keep.push(task);
        continue;
      }
      this.dropTurn(task);
      this.emitLifecycle({ type: 'cancelled', ...this.taskLifecycle(task), reason });
      total += 1;
      if (!task.silent) reportable += 1;
    }
    this.asyncPending.length = 0;
    this.asyncPending.push(...keep);
    return { total, reportable };
  }

  private cancelQueued(queue: TaskRecord[], reason: string): number {
    let n = 0;
    const keep: TaskRecord[] = [];
    for (const task of queue) {
      if (task.state !== 'queued' || !move(task, 'cancelled')) {
        keep.push(task);
        continue;
      }
      this.dropTurn(task);
      this.emitLifecycle({ type: 'cancelled', ...this.taskLifecycle(task), reason });
      if (!task.silent) n += 1;
    }
    queue.length = 0;
    for (const task of keep) queue.push(task);
    return n;
  }

  private writeLog(line: string): void {
    try {
      this.log(`${this.now()} ${line}`);
    } catch {
      // 日志自己抛错不能把工人循环带走。
    }
  }
}
