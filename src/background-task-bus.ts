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
    readonly signal: AbortSignal;
  }): Promise<{ readonly text: string; readonly speech?: string; readonly emotion?: string }>;
  /** 显式取消正在运行的底层 dsh 轮次/后台任务 */
  cancelRunning?(reason: string): void;
}

export interface BackgroundTaskBusOptions {
  readonly runner: BackgroundTaskRunner;
  readonly onReport: (report: BackgroundTaskReport) => void;
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
  readonly silent: boolean;
  state: BackgroundTaskState;
  controller: AbortController | null;
}

interface Spoken {
  readonly clean: string;
  readonly emotion: string;
  readonly verbatim: boolean;
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

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`);
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

/**
 * `[VERBATIM]` 比情绪标签长，`parseEmotion` 的括号只认 1–4 个字，剥不掉它。
 * 它若挡在 `[开心]` 前面，情绪会丢，所以先剥逐字标签再解析情绪。
 */
function speakable(text: string, speech: string | undefined, emotionHint: string | undefined): Spoken {
  const parsed = parseEmotion(stripVerbatimTag(text));
  let body = parsed.rest;
  let emotion = parsed.emotion;
  if (speech !== undefined && speech.trim() !== '') {
    const parsedSpeech = parseEmotion(stripVerbatimTag(speech));
    body = parsedSpeech.rest;
    if (parsedSpeech.emotion !== DEFAULT_EMOTION) emotion = parsedSpeech.emotion;
  }
  if (emotionHint !== undefined) emotion = asEmotion(emotionHint);
  const verbatim = needsVerbatimRead(text)
    || (speech !== undefined && speech !== text && needsVerbatimRead(speech));
  return { clean: cleanForSpeech(body), emotion, verbatim };
}

export class BackgroundTaskBus {
  private readonly runner: BackgroundTaskRunner;
  private readonly onReport: (report: BackgroundTaskReport) => void;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxQueue: number;

  private disposed = false;
  private scheduled = false;
  private draining = false;
  private seq = 0;
  private running: TaskRecord | null = null;
  private readonly reportable: TaskRecord[] = [];
  private readonly silentQueue: TaskRecord[] = [];
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
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    const requested = options.maxQueue;
    this.maxQueue = requested !== undefined && requested > 0 ? requested : DEFAULT_MAX_QUEUE;
  }

  dispatch(req: BackgroundTaskRequest): BackgroundTaskHandle {
    if (this.disposed) return this.deadHandle(req);
    const existing = this.findLive(req);
    if (existing !== undefined) {
      const upgraded = existing.state === 'queued' && req.source === 'tool_call';
      if (upgraded) {
        existing.query = req.query;
        if (req.note !== undefined) existing.note = req.note;
      }
      this.writeLog(
        `  后台    去重 ${existing.taskId} turn=${String(req.turnNo)}${upgraded ? ' 升级查询' : ''}`,
      );
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
    this.kick();
    return this.toHandle(task, false);
  }

  /**
   * dsh 自己的后台作业 / 子代理跑完了。不进队列（那边已经执行完），
   * 只把正文收成和 `dispatch` 一样的汇报。
   */
  ingestExternalAnnouncement(rawText: string, emotion?: string, query?: string): void {
    if (this.disposed) return;
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      this.writeLog('  后台    外部播报为空，忽略');
      return;
    }
    const spoken = speakable(rawText, undefined, emotion);
    if (spoken.clean === '') {
      this.writeLog('  后台    外部播报为空，忽略');
      return;
    }
    const taskId = this.allocateId();
    this.writeLog(`  后台    外部播报 ${taskId} → ${preview(spoken.clean)}`);
    this.deliver(this.toReport(taskId, 'dsh_background', query ?? '', spoken));
  }

  /** 正在跑的或还在排队的里面，有没有要向用户汇报的任务。 */
  hasActiveReportable(): boolean {
    const running = this.running;
    if (running !== null && running.state === 'running' && !running.silent) return true;
    return this.reportable.some((task) => task.state === 'queued');
  }

  /** 排队中 + 正在跑。终态不算。 */
  activeCount(): number {
    let n = this.queuedCount();
    const running = this.running;
    if (running !== null && (running.state === 'queued' || running.state === 'running')) n += 1;
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
    if (this.disposed) return false;
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
    if (this.disposed) return;
    this.disposed = true;
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

  private kick(): void {
    if (this.disposed || this.draining || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed) return;
      void this.drain().catch((err: unknown) => {
        this.writeLog(`  后台    循环异常：${errorText(err)}`);
      });
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (!this.disposed) {
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
      this.draining = false;
      if (!this.disposed && this.queuedCount() > 0) this.kick();
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    if (this.disposed || task.state !== 'queued') return;
    const controller = new AbortController();
    task.controller = controller;
    if (!move(task, 'running')) {
      task.controller = null;
      return;
    }
    this.running = task;
    try {
      const result = await this.runner.execute({
        taskId: task.taskId,
        query: task.query,
        image: task.image,
        note: task.note,
        silent: task.silent,
        signal: controller.signal,
      });
      this.finishOk(task, result);
    } catch (err) {
      this.finishErr(task, err);
    } finally {
      if (this.running === task) this.running = null;
      task.controller = null;
    }
  }

  private finishOk(task: TaskRecord, result: unknown): void {
    if (task.state !== 'running' || this.disposed) return;
    const raw = readResult(result);
    const spoken = speakable(raw.text, raw.speech, raw.emotion);
    if (task.state !== 'running' || this.disposed) return;
    if (!move(task, 'completed')) return;
    if (task.silent) {
      this.writeLog(`  后台    静默完成 ${task.taskId}（不播报）`);
      return;
    }
    if (spoken.clean === '') {
      this.writeLog(`  后台    完成 ${task.taskId} 但清洗后为空，不播报`);
      return;
    }
    const report = this.toReport(task.taskId, task.source, task.query, spoken);
    this.writeLog(`  后台    完成 ${task.taskId} → ${preview(report.summary)}`);
    this.deliver(report);
  }

  private finishErr(task: TaskRecord, err: unknown): void {
    if (task.state !== 'running' || this.disposed) return;
    if (!move(task, 'failed')) return;
    this.dropTurn(task);
    if (task.silent) {
      this.writeLog(`  后台    静默失败 ${task.taskId}：${errorText(err)}（不播报）`);
      return;
    }
    this.writeLog(`  后台    失败 ${task.taskId}：${errorText(err)}`);
    this.deliver({
      taskId: task.taskId,
      source: task.source,
      query: task.query,
      summary: FAILURE_SUMMARY,
    });
  }

  private toReport(
    taskId: string,
    source: BackgroundTaskSource,
    query: string,
    spoken: Spoken,
  ): BackgroundTaskReport {
    const summary = spoken.verbatim ? clipSummary(spoken.clean, SUMMARY_LIMIT) : spoken.clean;
    if (spoken.verbatim) {
      return {
        taskId,
        source,
        query,
        summary,
        verbatim: spoken.clean,
        emotion: spoken.emotion,
      };
    }
    return { taskId, source, query, summary, emotion: spoken.emotion };
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
    let reportableCancelled = this.cancelQueued(this.reportable);
    if (includeSilent) this.cancelQueued(this.silentQueue);
    const running = this.running;
    if (running === null || running.state !== 'running') return reportableCancelled;
    if (running.silent && !includeSilent) return reportableCancelled;
    if (!move(running, 'cancelled')) return reportableCancelled;
    this.dropTurn(running);
    running.controller?.abort(reason);
    if (!running.silent) reportableCancelled += 1;
    if (cancelRunner) {
      try {
        this.runner.cancelRunning?.(reason);
      } catch (err) {
        this.writeLog(`  后台    取消底层任务失败：${errorText(err)}`);
      }
    }
    return reportableCancelled;
  }

  private cancelQueued(queue: TaskRecord[]): number {
    let n = 0;
    const keep: TaskRecord[] = [];
    for (const task of queue) {
      if (task.state !== 'queued' || !move(task, 'cancelled')) {
        keep.push(task);
        continue;
      }
      this.dropTurn(task);
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
