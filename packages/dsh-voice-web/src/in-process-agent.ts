/**
 * 进程内 dsh agent：直接调宿主 `SessionController`，不再拉起 `dsh` 子进程。
 *
 * 跟 `VoiceAgent` 对齐的只有策略（提示词、情绪、清洗、放手后的播报/回注）。
 * 会话指针是用户看得见的那一条，撤回**不会**偷偷 fork 走。
 *
 * follow 必须先于 prompt 拉开，并等到开场 `snapshot` 记下 `cursor`，
 * 否则 prompt 触发的早到增量会在没人读流的窗口里丢掉。
 */
import { randomUUID } from 'node:crypto';

import type { AnnounceStore } from './voice/announce-store.ts';
import type { TurnTicket } from './voice/dialog-fsm.ts';
import { cleanForSpeech, parseEmotion } from './voice/emotion.ts';
import type { AgentImage, AgentProvider, AgentReplyView, TurnContext } from './voice/providers.ts';

/**
 * 空闲看门狗默认时长：这么久没有任何属于本轮的帧才判死。
 *
 * 不能再看墙钟总时长：跑一次 3–20 分钟的 `pwsh` 编译/构建时宿主一直在干活，
 * 只是不往 follow 里吐帧。60 s 死等会把正在编译的轮次掐掉，语音侧报失败、
 * dsh 网页端还在跑（脑裂）。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** 总时长硬上限默认关闭，长编译/长构建才能跑完。 */
const DEFAULT_MAX_DURATION_MS = 0;

/** 宿主侧取消这一轮时抛的错。上游据此记 `cancelled` 而不是 `failed`。 */
export function createTurnAbortedError(): Error {
  const error = new Error('任务已在宿主侧取消');
  error.name = 'AbortError';
  (error as Error & { code?: string }).code = 'TURN_ABORTED';
  return error;
}

export function isTurnAbortedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' && code === 'TURN_ABORTED';
}

const EMPTY_REPLY: AgentReplyView = {
  text: '',
  speech: '',
  emotion: 'calm',
  path: 'dsh',
};

/** 浏览器提交的 prompt 片段。图片字节由宿主提升成持久引用。 */
export type HostPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly name?: string };

/** `session.list` 的一行。`origin === 'subagent'` 的不进用户可见列表。 */
export interface HostSessionSummary {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly origin?: string;
  readonly agentAvailable?: boolean;
  readonly running?: boolean;
  readonly blank?: boolean;
  readonly parentSessionId?: string;
  readonly cwd?: string;
  readonly projections?: {
    readonly kind?: 'cached' | 'sequenced';
    readonly asOfSeq?: number;
    readonly values?: Readonly<Record<string, unknown>>;
  };
}

/**
 * `follow` 的一帧。
 *
 * 正规形状是 `snapshot` / `event` / `assistant-stream`（见 session-controller 的
 * `SessionFollowFrame`）。这里把字段留宽，是为了同时认 `assistant/stream`、
 * `assistantStream`、`turn/done`、`idle` 这些线上会漂的别名。
 */
export interface HostSessionFollowFrame {
  readonly type: string;
  readonly cursor?: number;
  readonly seq?: number;
  readonly time?: number;
  readonly header?: unknown;
  readonly records?: readonly unknown[];
  readonly hasMore?: boolean;
  readonly projections?: unknown;
  readonly assistantStream?: unknown;
  readonly event?: unknown;
  readonly frame?: unknown;
  readonly data?: unknown;
  readonly chunk?: unknown;
  readonly delta?: string;
  readonly text?: string;
  readonly status?: string;
  readonly sessionId?: string;
}

/** 宿主 `SessionController` 里语音这条链路真正会碰到的方法。不依赖那个包。 */
export interface HostSessionController {
  list(
    request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly HostSessionSummary[] }>;
  create(
    request: { readonly cwd?: string; readonly sessionId?: string; readonly agentPreset?: string },
  ): Promise<{ readonly sessionId: string }>;
  prompt(
    request: {
      readonly requestId: string;
      readonly sessionId: string;
      readonly mode: 'queue' | 'steer';
      readonly content: readonly HostPromptPart[];
      readonly clientTimeZone?: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>;
  cancel(
    request: { readonly sessionId: string },
  ): { readonly accepted: true } | Promise<{ readonly accepted: true }>;
  follow(
    request: {
      readonly address: { readonly kind: 'session'; readonly sessionId: string };
      readonly assistantStream?: true;
      readonly maxMessages?: number;
    },
    signal: AbortSignal,
  ): AsyncIterable<HostSessionFollowFrame>;
}

export interface InProcessDshAgentOptions {
  readonly controller: HostSessionController;
  /** 传给 `session.create` 的 cwd。 */
  readonly workDir: string;
  /**
   * 可选的固定 id。不是「已经绑定」——第一次 `ensureSession` 时交给
   * `create({ cwd, sessionId })` 幂等收养，再用返回值绑定。
   * 显式 `bindSession` / 成功收养之后作废，不能再被「新建会话」收养回来。
   */
  readonly sessionId?: string;
  readonly log?: (line: string) => void;
  readonly announceStore?: AnnounceStore | null;
  /**
   * 空闲看门狗：这么久没有任何属于本轮的帧、也没有活跃的 `job` / `subagent`
   * 才判死。默认 2 分钟；`<= 0` 关闭。
   */
  readonly idleTimeoutMs?: number;
  /**
   * 可选的轮次总时长硬上限。默认 `0` = 不设短墙钟上限，长编译/长构建稳过；
   * 只有调用方显式传 `> 0` 才启用。
   */
  readonly maxDurationMs?: number;
  /** 可选时钟，单测用来把看门狗压到毫秒级。 */
  readonly now?: () => number;
}

interface NormalizedEvent {
  readonly type: string;
  readonly seq: number | null;
  readonly data: Record<string, unknown> | undefined;
  readonly sessionId: string | null;
}

/**
 * 一轮 in-flight。`reply` 在等的是 `active`；放手之后挪到 `background`，
 * 调用方先返回，帧继续读到 `turn/end`。
 */
class TurnState {
  readonly abort = new AbortController();
  readonly startedAt: number;
  readonly sessionId: string;
  readonly userText: string;
  readonly ticket: TurnTicket | null;
  readonly opened: Promise<void>;
  readonly early: Promise<void>;
  readonly done: Promise<void>;

  /** 最近一次收到属于本轮的非 `snapshot` 帧的时刻。看门狗只认它。 */
  lastActivityAt: number;
  baseline = -1;
  sawSnapshot = false;
  streamed = '';
  committed: string | null = null;
  firstTokenMs: number | null = null;
  detached = false;
  cancelled = false;
  settled = false;
  /** 宿主侧取消（`turn/end` `reason.kind === 'aborted' | 'cancelled'`）。 */
  hostAborted = false;
  /** 已经把 `prompt` 交给宿主。这之前收到的终态帧属于上一轮。 */
  promptDispatched = false;
  /** 打开 follow 时会话还忙：先到的终态帧可能是队列里上一轮的收尾。 */
  awaitingPriorTurnEnd = false;
  sawTurnStart = false;
  error: Error | null = null;
  /** 当前续期中的看门狗句柄，`finally` 里清掉。 */
  watchdog: ReturnType<typeof setTimeout> | null = null;

  private openResolve: (() => void) | null = null;
  private earlyResolve: (() => void) | null = null;
  private doneResolve: (() => void) | null = null;

  constructor(
    sessionId: string,
    userText: string,
    ticket: TurnTicket | null,
    now: () => number,
  ) {
    this.sessionId = sessionId;
    this.userText = userText;
    this.ticket = ticket;
    this.startedAt = now();
    this.lastActivityAt = this.startedAt;
    this.opened = new Promise((resolve) => {
      this.openResolve = resolve;
    });
    this.early = new Promise((resolve) => {
      this.earlyResolve = resolve;
    });
    this.done = new Promise((resolve) => {
      this.doneResolve = resolve;
    });
  }

  touch(at: number): void {
    if (at > this.lastActivityAt) this.lastActivityAt = at;
  }

  releaseOpened(): void {
    const resolve = this.openResolve;
    if (resolve === null) return;
    this.openResolve = null;
    resolve();
  }

  releaseEarly(): void {
    const resolve = this.earlyResolve;
    if (resolve === null) return;
    this.earlyResolve = null;
    resolve();
  }

  releaseDone(): void {
    const resolve = this.doneResolve;
    if (resolve === null) return;
    this.doneResolve = null;
    resolve();
  }
}

interface JobFact {
  readonly jobId: string;
  readonly kind: string;
  readonly label: string;
  readonly startedAt: number;
  readonly owner: string;
}

interface SettledFact {
  readonly kind: string;
  readonly label: string;
  readonly settledAt: number;
}

interface ChildFact {
  readonly childId: string;
  readonly label: string;
  readonly at: number;
}

const TASK_RECENT_MS = 120_000;
const TASK_RECENT_MAX = 4;
const TASK_LABEL_MAX = 28;

/** 从 follow 帧里的 `job/*`、`subagent/catalog` 攒一句给快车道的事实。 */
class TaskMemo {
  private readonly running = new Map<string, JobFact>();
  private readonly recent: SettledFact[] = [];
  private readonly children = new Map<string, ChildFact>();
  private readonly mainSessionId: () => string | null;

  constructor(mainSessionId: () => string | null) {
    this.mainSessionId = mainSessionId;
  }

  /** 宿主还有在跑的 `job` / 派出去没回结果的子代理。看门狗据此续命。 */
  hasActiveWork(): boolean {
    return this.running.size > 0 || this.children.size > 0;
  }

  observe(sessionId: string, type: string, data: Record<string, unknown> | undefined): void {
    if (type === 'job/registered') {
      const jobId = typeof data?.['jobId'] === 'string' ? data['jobId'] : '';
      if (jobId === '') return;
      this.running.set(jobId, {
        jobId,
        kind: typeof data?.['kind'] === 'string' ? data['kind'] : 'job',
        label: typeof data?.['label'] === 'string' ? data['label'] : '(无描述)',
        startedAt: typeof data?.['startedAt'] === 'number' ? data['startedAt'] : Date.now(),
        owner: sessionId,
      });
      this.children.delete(sessionId);
      return;
    }
    if (type === 'job/settled') {
      const jobId = typeof data?.['jobId'] === 'string' ? data['jobId'] : '';
      const job = this.running.get(jobId);
      if (job === undefined) return;
      this.running.delete(jobId);
      this.recent.unshift({
        kind: job.kind,
        label: job.label,
        settledAt: typeof data?.['settledAt'] === 'number' ? data['settledAt'] : Date.now(),
      });
      if (this.recent.length > TASK_RECENT_MAX) this.recent.length = TASK_RECENT_MAX;
      return;
    }
    if (type === 'subagent/catalog') {
      const childId = typeof data?.['childId'] === 'string' ? data['childId'] : '';
      const label = typeof data?.['label'] === 'string' ? data['label'] : '';
      if (childId === '') return;
      this.children.set(childId, {
        childId,
        label,
        at: typeof data?.['childCreatedAt'] === 'number' ? data['childCreatedAt'] : Date.now(),
      });
      return;
    }
    if (type === 'turn/start' && sessionId === this.mainSessionId()) {
      this.children.clear();
      return;
    }
    /*
     * 宿主 aborted 时 `job/settled` 可能永远不来。轮次收尾后还留着「在跑」的
     * 记录，`hasActiveWork()` 就永远为真，看门狗再也不会判死。正常有
     * `job/settled` 时这里早就删掉了，只剩 aborted 的残渣。
     */
    if (type === 'turn/end' && sessionId === this.mainSessionId()) {
      this.children.clear();
      for (const [jobId, job] of this.running) {
        if (job.owner === sessionId) this.running.delete(jobId);
      }
    }
  }

  describe(): string {
    const now = Date.now();
    const jobs = [...this.running.values()].sort((a, b) => a.startedAt - b.startedAt);
    const main = this.mainSessionId();
    const parts: string[] = [];
    for (const job of jobs) {
      const who = job.owner === main ? '' : '子代理的 ';
      parts.push(`${who}${job.kind}「${clipTask(job.label)}」已跑 ${taskSeconds(now - job.startedAt)}`);
    }
    for (const child of this.children.values()) {
      parts.push(`子代理「${clipTask(child.label)}」已派出、还没回结果`);
    }
    if (parts.length > 0) {
      return `后台任务：在跑 ${parts.length} 个 —— ${parts.join('；')}。`;
    }
    const last = this.recent[0];
    if (last !== undefined && now - last.settledAt <= TASK_RECENT_MS) {
      return `后台任务：现在没有在跑的；刚结束 ${last.kind}「${clipTask(last.label)}」`
        + `（${taskSeconds(now - last.settledAt)}前）。`;
    }
    return '后台任务：现在没有任何后台任务在跑，也没刚结束的。';
  }
}

export class InProcessDshAgent implements AgentProvider {
  readonly name = 'dsh';

  private readonly controller: HostSessionController;
  private readonly workDir: string;
  private readonly log: (line: string) => void;
  private readonly announceStore: AnnounceStore | null;
  private readonly tasks: TaskMemo;
  private readonly idleTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly now: () => number;

  /** 构造时带来的 id，仅用于首次未绑定时的初始收养；显式指定或清空后作废。 */
  private configuredId: string | null;
  private boundSessionId: string | null = null;
  /** 换绑或销毁时 +1。在途 open 只有 epoch 仍等于进入时的值才可以写回 `boundSessionId`。 */
  private openEpoch = 0;
  private opening: Promise<string> | null = null;
  private active: TurnState | null = null;
  private background: TurnState | null = null;
  private tail: Promise<void> = Promise.resolve();
  private liveSink: ((text: string) => void) | null = null;
  private announcer: ((speech: string, emotion?: string) => void) | null = null;
  private detachedSink: ((userText: string, answer: string, spoken: boolean) => void) | null = null;
  private disposed = false;

  constructor(options: InProcessDshAgentOptions) {
    this.controller = options.controller;
    this.workDir = options.workDir;
    const configured = options.sessionId?.trim();
    this.configuredId = configured === undefined || configured === '' ? null : configured;
    this.log = options.log ?? (() => {});
    this.announceStore = options.announceStore ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.now = options.now ?? (() => Date.now());
    this.tasks = new TaskMemo(() => this.boundSessionId);
  }

  /** 当前绑定的会话。还没 `ensureSession` / `bindSession` 时是 null。 */
  get sessionId(): string | null {
    return this.boundSessionId;
  }

  /** 对 UI 暴露的目标会话：优先返回已绑定 ID，启动首轮前返回待收养的持久化 ID。 */
  get targetSessionId(): string | null {
    return this.boundSessionId ?? this.configuredId;
  }

  /**
   * 已绑定就直接返回。否则 `create({ cwd })`，构造时给过 id 就一并带上让宿主收养。
   * 进入时记下 `openEpoch`：中途换绑或销毁则丢掉这次结果，不把过期 id 交出去。
   */
  async ensureSession(): Promise<string> {
    if (this.disposed) throw new Error('InProcessDshAgent 已关闭');
    if (this.boundSessionId !== null) return this.boundSessionId;
    const pending = this.opening;
    if (pending !== null) return pending;
    const myEpoch = this.openEpoch;
    const created = this.openBoundSession();
    this.opening = created;
    try {
      const id = await created;
      if (this.disposed || this.openEpoch !== myEpoch) {
        throw new Error(this.disposed ? 'InProcessDshAgent 已关闭' : '会话绑定已变更');
      }
      return id;
    } finally {
      if (this.opening === created) this.opening = null;
    }
  }

  /**
   * 换绑定的会话。在途的那一轮（含已经放手、还在后台收尾的）按旧 id 取消，
   * 避免下一轮还挂在旧 follow 上。
   * `null` 是解绑：即使当前还没绑上，也必须丢掉构造时的 id，不能再收养回来。
   */
  bindSession(sessionId: string | null): void {
    const trimmed = sessionId === null ? '' : sessionId.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next === this.boundSessionId && this.configuredId === null) return;
    this.openEpoch += 1;
    this.opening = null;
    this.cancelInFlight();
    this.boundSessionId = next;
    this.configuredId = null;
  }

  /** 用户可见会话：去掉子代理，按 `updatedAt` 从新到旧，最多 `limit` 条。 */
  async listSessions(limit = 30): Promise<readonly HostSessionSummary[]> {
    if (this.disposed) throw new Error('InProcessDshAgent 已关闭');
    const page = await this.controller.list({}, new AbortController().signal);
    const visible = page.items.filter((item) => item.origin !== 'subagent');
    visible.sort((left, right) => right.updatedAt - left.updatedAt);
    const cap = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
    return visible.slice(0, cap);
  }

  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.announcer = cb;
  }

  setDetachedAnswerSink(
    cb: ((userText: string, answer: string, spoken: boolean) => void) | null,
  ): void {
    this.detachedSink = cb;
  }

  attachLiveSink(sink: ((text: string) => void) | null): void {
    this.liveSink = sink;
  }

  /** 票据对不上当前在途轮就丢掉，避免迟到的取消杀掉下一轮。 */
  cancelTurn(ticket?: TurnTicket): void {
    const turn = this.matchTurn(ticket);
    if (turn === null) {
      if (ticket !== undefined) {
        this.log(`  取消    票据过期（#${ticket.no}/${ticket.gen}）→ 丢弃`);
      }
      return;
    }
    this.cancelTurnNow(turn);
  }

  /**
   * 不取消宿主那一轮，只放开正在等的调用方。答完后走播报 / 回注，跟 `VoiceAgent` 同一条口。
   */
  detachTurn(ticket?: TurnTicket): void {
    const turn = this.matchTurn(ticket);
    if (turn === null) {
      if (ticket !== undefined) {
        this.log(`  放手    票据过期（#${ticket.no}/${ticket.gen}）→ 丢弃`);
      }
      return;
    }
    if (turn.detached || turn.settled) return;
    turn.detached = true;
    if (this.active === turn) {
      this.background = turn;
      this.active = null;
    }
    this.log('  放手    调用方已摘掉，答案之后从播报口出');
    turn.releaseEarly();
  }

  dshBusy(): boolean {
    return this.active !== null || this.background !== null;
  }

  taskStatus(): string {
    return this.tasks.describe();
  }

  /**
   * 固定会话上不 fork。快车道抢答成功时，历史里会留下没被听到的一轮；
   * 调用方用 `'none'` 决定补上下文的措辞。
   */
  rollbackTurn(ticket?: TurnTicket): void {
    const who = ticket === undefined ? '' : ` #${ticket.no}/${ticket.gen}`;
    this.log(`  回溯    跳过：固定绑定的会话不静默 fork${who}`);
  }

  takeRollbackOutcome(): 'ok' | 'failed' | 'none' {
    return 'none';
  }

  /** 丢掉绑定。下一次 `ensureSession` 重新 create，不再收养构造时的 id。 */
  reset(): void {
    this.openEpoch += 1;
    this.opening = null;
    this.cancelInFlight();
    this.boundSessionId = null;
    this.configuredId = null;
    this.log('  会话    已重置，下一轮重新创建');
  }

  /** 取消在途轮并摘掉回调。重复调用无事。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openEpoch += 1;
    this.opening = null;
    this.cancelInFlight();
    this.liveSink = null;
    this.announcer = null;
    this.detachedSink = null;
    this.log('  会话    已关闭');
  }

  reply(
    asrText: string,
    image?: AgentImage,
    note?: string,
    turn?: TurnContext,
  ): Promise<AgentReplyView> {
    const run = this.tail.then(
      () => this.replyOnce(asrText, image, note, turn),
      () => this.replyOnce(asrText, image, note, turn),
    );
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async openBoundSession(): Promise<string> {
    const myEpoch = this.openEpoch;
    const configured = this.configuredId;
    if (configured !== null) {
      // `sessionController.create({ cwd, sessionId })` 只允许复用「同 cwd 且空白」的会话；
      // 跨目录或已有历史轮次的会话直接走 `follow()` / `prompt()` 即可自动恢复，不能再调 `create`。
      let exists = false;
      try {
        const page = await this.controller.list({}, new AbortController().signal);
        exists = page.items.some((item) => item.sessionId === configured && item.origin !== 'subagent');
      } catch {
        exists = false;
      }
      if (exists) {
        if (this.disposed || this.openEpoch !== myEpoch) {
          throw new Error(this.disposed ? 'InProcessDshAgent 已关闭' : '会话绑定已变更');
        }
        if (this.boundSessionId === null) this.boundSessionId = configured;
        this.configuredId = null;
        const bound = this.boundSessionId ?? configured;
        this.log(`  会话    采用已有 ${bound}`);
        return bound;
      }
    }
    if (this.disposed || this.openEpoch !== myEpoch) {
      throw new Error(this.disposed ? 'InProcessDshAgent 已关闭' : '会话绑定已变更');
    }
    const created = await this.controller.create(
      configured === null
        ? { cwd: this.workDir }
        : { cwd: this.workDir, sessionId: configured },
    );
    const id = created.sessionId.trim();
    if (id === '') throw new Error('session.create 没有返回 sessionId');
    if (this.disposed || this.openEpoch !== myEpoch) {
      throw new Error(this.disposed ? 'InProcessDshAgent 已关闭' : '会话绑定已变更');
    }
    if (this.boundSessionId === null) this.boundSessionId = id;
    this.configuredId = null;
    const bound = this.boundSessionId ?? id;
    this.log(`  会话    ${configured === null ? '新建' : '采用'} ${bound}`);
    return bound;
  }

  private async replyOnce(
    asrText: string,
    image: AgentImage | undefined,
    note: string | undefined,
    turnContext: TurnContext | undefined,
  ): Promise<AgentReplyView> {
    if (this.disposed) throw new Error('InProcessDshAgent 已关闭');
    const promptText = formatPrompt(asrText, note);
    const sessionId = await this.ensureSession();
    if (this.disposed) throw new Error('InProcessDshAgent 已关闭');
    const turn = new TurnState(sessionId, promptText, turnContext?.ticket ?? null, this.now);
    this.active = turn;
    this.armWatchdog(turn, this.initialWatchdogDelay(turn));
    try {
      return await this.runTurn(turn, promptText, image);
    } finally {
      this.clearWatchdog(turn);
      if (this.active === turn) this.active = null;
    }
  }

  private initialWatchdogDelay(turn: TurnState): number | null {
    const idle = this.idleTimeoutMs > 0 ? this.idleTimeoutMs : null;
    const max = this.maxDurationMs > 0
      ? Math.max(1, this.maxDurationMs - (this.now() - turn.startedAt))
      : null;
    if (idle === null) return max;
    if (max === null) return idle;
    return Math.min(idle, max);
  }

  /** 续期看门狗。每次到期自己决定「再排一次」还是判死。 */
  private armWatchdog(turn: TurnState, delay: number | null): void {
    this.clearWatchdog(turn);
    if (delay === null) return;
    const timer = setTimeout(() => {
      turn.watchdog = null;
      this.onWatchdogExpired(turn);
    }, Math.max(10, delay));
    timer.unref?.();
    turn.watchdog = timer;
  }

  private clearWatchdog(turn: TurnState): void {
    if (turn.watchdog === null) return;
    clearTimeout(turn.watchdog);
    turn.watchdog = null;
  }

  /**
   * 看门狗到期。只有「既没有活跃 job/subagent，又持续 `idleTimeoutMs` 零事件」
   * 才是真卡死；真卡死时先把宿主那一轮也取消，避免语音侧报失败而网页端还在跑。
   */
  private onWatchdogExpired(turn: TurnState): void {
    if (turn.detached || turn.settled || turn.cancelled) return;
    if (this.maxDurationMs > 0 && this.now() - turn.startedAt >= this.maxDurationMs) {
      this.cancelHostBestEffort(turn.sessionId);
      turn.error = new Error(`等待 turn 总时长超时（${this.maxDurationMs} ms）`);
      this.log(`  dsh     ${turn.error.message}`);
      this.markDone(turn);
      return;
    }
    if (this.tasks.hasActiveWork()) {
      // 长编译/长构建还在跑，只是不吐帧。续命，不判超时。
      turn.touch(this.now());
      this.armWatchdog(turn, this.initialWatchdogDelay(turn));
      return;
    }
    if (this.idleTimeoutMs <= 0) {
      // 空闲看门狗关着，只剩总时长上限；没到上限就按剩余时间再排一次。
      this.armWatchdog(turn, this.initialWatchdogDelay(turn));
      return;
    }
    const idleFor = this.now() - turn.lastActivityAt;
    if (idleFor < this.idleTimeoutMs) {
      const remainingIdle = Math.max(10, this.idleTimeoutMs - idleFor);
      const remainingMax = this.maxDurationMs > 0
        ? Math.max(10, this.maxDurationMs - (this.now() - turn.startedAt))
        : remainingIdle;
      this.armWatchdog(turn, Math.min(remainingIdle, remainingMax));
      return;
    }
    this.cancelHostBestEffort(turn.sessionId);
    turn.error = new Error(`等待 turn 空闲超时（${this.idleTimeoutMs} ms）`);
    this.log(`  dsh     ${turn.error.message}`);
    this.markDone(turn);
  }

  private cancelHostBestEffort(sessionId: string): void {
    try {
      void Promise.resolve(this.controller.cancel({ sessionId })).catch(() => {});
    } catch {
      // 取消本身失败也不能把看门狗带走。
    }
  }

  private async runTurn(
    turn: TurnState,
    promptText: string,
    image: AgentImage | undefined,
  ): Promise<AgentReplyView> {
    const gate = { live: false };
    const pending: HostSessionFollowFrame[] = [];
    let iterable: AsyncIterable<HostSessionFollowFrame>;
    try {
      iterable = this.controller.follow({
        address: { kind: 'session', sessionId: turn.sessionId },
        assistantStream: true,
        maxMessages: 1,
      }, turn.abort.signal);
    } catch (error) {
      turn.error = asError(error);
      this.markDone(turn);
      throw turn.error;
    }

    const iterator = iterable[Symbol.asyncIterator]();
    void this.pump(turn, iterator, gate, pending).catch((error: unknown) => {
      if (turn.settled) return;
      turn.error = asError(error);
      this.markDone(turn);
    });

    await turn.opened;
    if (turn.hostAborted) throw createTurnAbortedError();
    if (turn.cancelled) return EMPTY_REPLY;
    if (!turn.sawSnapshot) {
      throw turn.error ?? new Error('follow 在收到 snapshot 之前结束');
    }

    // 先开始认帧，再 prompt。prompt 返回前主机就已经把增量推进 follow 了。
    gate.live = true;
    const early = pending.splice(0, pending.length);
    for (const frame of early) {
      if (turn.settled) break;
      this.consumeFrame(turn, frame);
    }

    if (!turn.cancelled && !turn.settled) {
      // 从这一帧起，终态帧才算本轮的；之前的都属于队列里上一轮。
      turn.promptDispatched = true;
      try {
        await this.controller.prompt({
          requestId: randomUUID(),
          sessionId: turn.sessionId,
          mode: 'queue',
          content: promptContent(promptText, image),
        }, turn.abort.signal);
      } catch (error) {
        if (!turn.settled) {
          if (turn.cancelled || isAbortError(error)) this.markDone(turn);
          else {
            turn.error = asError(error);
            this.markDone(turn);
          }
        } else if (turn.error === null && !isAbortError(error)) {
          turn.error = asError(error);
        }
      }
    }

    if (turn.hostAborted) throw createTurnAbortedError();
    if (turn.cancelled) return EMPTY_REPLY;
    if (turn.detached) return EMPTY_REPLY;
    if (turn.error !== null) throw turn.error;
    if (!turn.settled) await this.waitCaller(turn);
    if (turn.hostAborted) throw createTurnAbortedError();
    if (turn.cancelled) return EMPTY_REPLY;
    if (turn.detached) return EMPTY_REPLY;
    if (turn.error !== null) throw turn.error;
    return this.toView(turn);
  }

  private async pump(
    turn: TurnState,
    iterator: AsyncIterator<HostSessionFollowFrame>,
    gate: { live: boolean },
    pending: HostSessionFollowFrame[],
  ): Promise<void> {
    try {
      while (!turn.settled) {
        let next: IteratorResult<HostSessionFollowFrame>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (turn.settled || turn.cancelled || isAbortError(error)) {
            if (!turn.settled) this.markDone(turn);
            return;
          }
          throw error;
        }
        if (next.done === true) {
          if (!turn.settled) {
            if (!turn.sawSnapshot && turn.error === null && !turn.cancelled) {
              turn.error = new Error('follow 在收到 snapshot 之前结束');
            }
            this.markDone(turn);
          }
          return;
        }
        const frame = next.value;
        if (!turn.sawSnapshot) {
          if (frame.type !== 'snapshot') continue;
          this.applySnapshot(turn, frame);
          // 先唤醒 runTurn（它要把 live 置上），再拉下一帧。
          // 反过来的话，紧跟着的增量会在 live 还是 false 时被推进 pending，
          // 而 runTurn 已经开始 prompt，那一截就再也不会被当成本轮的增量。
          turn.releaseOpened();
          continue;
        }
        if (frame.type !== 'snapshot') turn.touch(this.now());
        if (!gate.live) {
          pending.push(frame);
          continue;
        }
        this.consumeFrame(turn, frame);
      }
    } catch (error) {
      if (!turn.settled) {
        turn.error = asError(error);
        this.markDone(turn);
      }
    } finally {
      try {
        await iterator.return?.();
      } catch {
        // 流已经因 abort 结束
      }
    }
  }

  private waitCaller(turn: TurnState): Promise<void> {
    if (turn.settled || turn.detached) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      void turn.done.then(finish);
      void turn.early.then(finish);
    });
  }

  private consumeFrame(turn: TurnState, frame: HostSessionFollowFrame): void {
    if (turn.settled) return;
    if (frame.type === 'snapshot') {
      this.applySnapshot(turn, frame);
      return;
    }
    if (isAssistantType(frame.type)) {
      turn.touch(this.now());
      // 队列前面还有旧轮在收尾：不要把旧轮的流式正文混进本轮。
      if (turn.awaitingPriorTurnEnd && !turn.sawTurnStart) return;
      this.consumeAssistant(turn, frame);
      return;
    }
    const event = readEvent(frame);
    if (event === null) return;
    if (event.seq !== null && event.seq <= turn.baseline) return;
    const owner = event.sessionId ?? turn.sessionId;
    this.tasks.observe(owner, event.type, event.data);
    if (event.sessionId !== null && event.sessionId !== turn.sessionId) return;
    turn.touch(this.now());
    if (turn.promptDispatched && (event.type === 'turn/start' || event.type === 'user/message')) {
      turn.sawTurnStart = true;
    }
    if (event.type === 'assistant/message') {
      if (turn.awaitingPriorTurnEnd && !turn.sawTurnStart) return;
      const text = textFromAssistantData(event.data);
      if (text !== '') {
        turn.committed = text;
        if (turn.streamed === '') this.pushFullText(turn, text);
      }
      return;
    }
    if (!isTerminalEvent(event.type, event.data)) return;
    if (!turn.promptDispatched) {
      // prompt 还没发出去，这是宿主上一轮的收尾帧，与本次无关。
      turn.awaitingPriorTurnEnd = false;
      return;
    }
    if (turn.awaitingPriorTurnEnd && !turn.sawTurnStart) {
      // 队列前面那轮刚收尾。继续等本轮的 turn/start / 正文 / turn/end。
      turn.awaitingPriorTurnEnd = false;
      return;
    }
    if (isAbortedTerminal(event.type, event.data) && !turn.cancelled) {
      turn.hostAborted = true;
      // 同时置 cancelled，确保 markDone 不会走 handout 的播报 / 回注。
      turn.cancelled = true;
    }
    this.markDone(turn);
  }

  /** 开场与运行中的 snapshot：只更新基线，以及「打开时会话是否还忙」。 */
  private applySnapshot(turn: TurnState, frame: HostSessionFollowFrame): void {
    if (!turn.sawSnapshot) {
      turn.baseline = cursorOf(frame);
      turn.sawSnapshot = true;
    }
    if (!turn.promptDispatched) turn.awaitingPriorTurnEnd = isSnapshotBusy(frame);
  }

  private consumeAssistant(turn: TurnState, frame: HostSessionFollowFrame): void {
    const payload = frame.frame ?? frame.chunk ?? frame.data;
    if (payload !== undefined) {
      this.consumeStreamPayload(turn, payload, 0);
      return;
    }
    if (typeof frame.delta === 'string') {
      this.pushDelta(turn, frame.delta);
      return;
    }
    if (typeof frame.text === 'string') this.pushDelta(turn, frame.text);
  }

  private consumeStreamPayload(turn: TurnState, payload: unknown, depth: number): void {
    if (depth > 8 || turn.settled) return;
    if (typeof payload === 'string') {
      this.pushDelta(turn, payload);
      return;
    }
    if (Array.isArray(payload)) {
      for (const item of payload) this.consumeStreamPayload(turn, item, depth + 1);
      return;
    }
    const rec = asRecord(payload);
    if (rec === null) return;
    const type = typeof rec['type'] === 'string' ? rec['type'] : '';
    if (type === 'text-delta' || type === 'text_delta') {
      if (typeof rec['text'] === 'string') this.pushDelta(turn, rec['text']);
      return;
    }
    if (type === 'text-chunks' || type === 'text_chunks') {
      const texts = rec['texts'];
      if (Array.isArray(texts)) {
        for (const piece of texts) {
          if (typeof piece === 'string') this.pushDelta(turn, piece);
        }
      }
      return;
    }
    if (
      type === 'chunk'
      || type === 'assistant-stream'
      || type === 'assistant/stream'
      || type === 'assistantStream'
    ) {
      if ('chunk' in rec) this.consumeStreamPayload(turn, rec['chunk'], depth + 1);
      else if (typeof rec['delta'] === 'string') this.pushDelta(turn, rec['delta']);
      else if (typeof rec['text'] === 'string') this.pushDelta(turn, rec['text']);
      return;
    }
    if (type === 'block-end' || type === 'text') {
      const block = type === 'block-end' ? asRecord(rec['block']) : rec;
      if (block !== null && typeof block['text'] === 'string' && (type === 'text' || block['type'] === 'text')) {
        this.pushFullText(turn, block['text']);
      }
      return;
    }
    if (
      type === 'start'
      || type === 'end'
      || type === 'reasoning-delta'
      || type === 'reasoning-chunks'
      || type === 'tool-call-delta'
      || type === 'tool-call-chunks'
      || type === 'usage'
      || type === 'finish'
      || type === 'block-start'
    ) {
      return;
    }
    if (type === '' && typeof rec['text'] === 'string') this.pushDelta(turn, rec['text']);
  }

  private pushDelta(turn: TurnState, delta: string): void {
    if (delta === '' || turn.settled || turn.cancelled) return;
    turn.streamed += delta;
    if (turn.firstTokenMs === null && delta.trim() !== '') {
      turn.firstTokenMs = this.now() - turn.startedAt;
    }
    // 放手之后这条流不再属于当前 TTS，别把后半句灌进下一轮的 sink。
    if (!turn.detached) this.liveSink?.(delta);
  }

  /** 整段文本：只补 sink 还没见过的后缀，避免和 text-delta 各念一遍。 */
  private pushFullText(turn: TurnState, text: string): void {
    if (text === '' || turn.settled) return;
    if (text.startsWith(turn.streamed)) {
      const extra = text.slice(turn.streamed.length);
      if (extra !== '') this.pushDelta(turn, extra);
      return;
    }
    if (turn.streamed === '') this.pushDelta(turn, text);
  }

  private toView(turn: TurnState): AgentReplyView {
    const raw = (turn.committed !== null && turn.committed.trim() !== ''
      ? turn.committed
      : turn.streamed).trim();
    const parsed = parseEmotion(raw);
    const speech = cleanForSpeech(parsed.rest);
    if (speech === '') throw new Error('清洗后没有可朗读的内容');
    if (turn.firstTokenMs === null) {
      return { text: raw, speech, emotion: parsed.emotion, path: 'dsh' };
    }
    return {
      text: raw,
      speech,
      emotion: parsed.emotion,
      path: 'dsh',
      firstTokenMs: turn.firstTokenMs,
    };
  }

  private markDone(turn: TurnState): void {
    if (turn.settled) return;
    turn.settled = true;
    const deliver = turn.detached && !turn.cancelled;
    if (this.background === turn) this.background = null;
    turn.releaseOpened();
    turn.releaseDone();
    turn.releaseEarly();
    if (deliver) this.deliverDetached(turn);
    if (!turn.abort.signal.aborted) turn.abort.abort();
  }

  private deliverDetached(turn: TurnState): void {
    const raw = (turn.committed !== null && turn.committed.trim() !== ''
      ? turn.committed
      : turn.streamed).trim();
    if (raw === '') return;
    const parsed = parseEmotion(raw);
    const speech = cleanForSpeech(parsed.rest);
    const willSpeak = this.announcer !== null && this.active === null && speech !== '';
    try {
      this.detachedSink?.(turn.userText, raw, willSpeak);
    } catch (error) {
      this.log(`  放手    ✗ 回注失败：${asError(error).message}`);
    }
    if (speech === '') return;
    if (this.active !== null) {
      this.log('  放手    答案回来时用户已经问了新问题 → 不补播（已回注记忆）');
      return;
    }
    if (this.announcer === null) {
      const backlog = this.announceStore?.push(speech, parsed.emotion) ?? 0;
      this.log(`  后台    没有连接，存入待补播（积压 ${backlog} 条）`);
      return;
    }
    this.log('  放手    委派轮跑完了 → 答案转成播报');
    try {
      this.announcer(speech, parsed.emotion);
    } catch (error) {
      this.log(`  放手    ✗ 播报失败：${asError(error).message}`);
    }
  }

  private matchTurn(ticket: TurnTicket | undefined): TurnState | null {
    const turns = [this.active, this.background].filter((turn): turn is TurnState => (
      turn !== null && !turn.settled && !turn.cancelled
    ));
    if (ticket === undefined) return turns[0] ?? null;
    for (const turn of turns) {
      if (turn.ticket !== null && turn.ticket.no === ticket.no && turn.ticket.gen === ticket.gen) {
        return turn;
      }
    }
    return null;
  }

  private cancelTurnNow(turn: TurnState): void {
    if (turn.cancelled || turn.settled) return;
    turn.cancelled = true;
    turn.detached = false;
    const sessionId = turn.sessionId;
    try {
      const result = this.controller.cancel({ sessionId });
      void Promise.resolve(result).then(
        () => { this.log(`  取消    已请求取消 ${sessionId} 的在途一轮`); },
        (error: unknown) => { this.log(`  取消    ✗ ${asError(error).message}`); },
      );
    } catch (error) {
      this.log(`  取消    ✗ ${asError(error).message}`);
    }
    this.markDone(turn);
  }

  private cancelInFlight(): void {
    if (this.active !== null) this.cancelTurnNow(this.active);
    if (this.background !== null) this.cancelTurnNow(this.background);
  }
}

function formatPrompt(asrText: string, note: string | undefined): string {
  const context = note === undefined ? '' : `（系统注记：${note}）\n`;
  return `${context}哥刚才说：\n${asrText}`;
}

function promptContent(text: string, image: AgentImage | undefined): HostPromptPart[] {
  const content: HostPromptPart[] = [{ type: 'text', text }];
  if (image !== undefined) {
    content.push({ type: 'image', mediaType: image.mimeType, data: image.data });
  }
  return content;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError') return true;
  const code = (error as { code?: unknown }).code;
  return code === 20 || code === 'ABORT_ERR';
}

function cursorOf(frame: HostSessionFollowFrame): number {
  if (typeof frame.cursor === 'number' && Number.isFinite(frame.cursor)) return frame.cursor;
  const rec = asRecord(frame);
  const cursor = rec?.['cursor'];
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return cursor;
  const seq = rec?.['seq'];
  if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
  return -1;
}

function isAssistantType(type: string): boolean {
  return type === 'assistant-stream' || type === 'assistant/stream' || type === 'assistantStream';
}

function readEvent(frame: HostSessionFollowFrame): NormalizedEvent | null {
  if (frame.type === 'event') {
    const inner = asRecord(frame.event);
    if (inner === null) return null;
    return normalizeEvent(inner);
  }
  if (frame.type === 'snapshot' || isAssistantType(frame.type)) return null;
  const rec = asRecord(frame);
  if (rec === null) return null;
  return normalizeEvent(rec);
}

function normalizeEvent(source: Record<string, unknown>): NormalizedEvent | null {
  const type = source['type'];
  if (typeof type !== 'string' || type === '' || type === 'event' || type === 'snapshot') return null;
  if (isAssistantType(type)) return null;
  const seq = typeof source['seq'] === 'number' && Number.isFinite(source['seq']) ? source['seq'] : null;
  let data = asRecord(source['data']) ?? undefined;
  if (data === undefined && typeof source['status'] === 'string') {
    data = { status: source['status'] };
  }
  const sessionId = typeof source['sessionId'] === 'string' && source['sessionId'] !== ''
    ? source['sessionId']
    : null;
  return { type, seq, data, sessionId };
}

function isTerminalEvent(type: string, data: Record<string, unknown> | undefined): boolean {
  if (
    type === 'turn/end'
    || type === 'turn/done'
    || type === 'turn/complete'
    || type === 'turn/completed'
    || type === 'idle'
  ) {
    return true;
  }
  if (type === 'session/status' || type === 'session.status' || type === 'status') {
    return data?.['status'] === 'idle';
  }
  return false;
}

/** `snapshot` 的 `status` / `projections` 里任一处说会话还在跑。 */
function isSnapshotBusy(frame: HostSessionFollowFrame): boolean {
  if (frame.status === 'running' || frame.status === 'busy') return true;
  const projections = asRecord(frame.projections);
  if (projections === null) return false;
  if (projections['status'] === 'running') return true;
  const values = asRecord(projections['values']);
  if (values === null) return false;
  if (values['running'] === true) return true;
  return values['status'] === 'running';
}

function isAbortReason(value: unknown): boolean {
  return value === 'aborted' || value === 'cancelled' || value === 'canceled';
}

/** 终态事件里的宿主侧取消：`reason.kind` / `reason` 字符串 / `status`。 */
function isAbortedTerminal(type: string, data: Record<string, unknown> | undefined): boolean {
  if (!isTerminalEvent(type, data)) return false;
  const reason = data?.['reason'];
  if (typeof reason === 'string' && isAbortReason(reason)) return true;
  const record = asRecord(reason);
  if (record !== null && isAbortReason(record['kind'])) return true;
  return isAbortReason(data?.['status']);
}

function textFromAssistantData(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return '';
  const message = asRecord(data['message']) ?? data;
  const fromBlocks = textFromContent(message['content']);
  if (fromBlocks !== '') return fromBlocks;
  if (typeof message['text'] === 'string' && message['text'] !== '') return message['text'];
  if (typeof data['text'] === 'string' && data['text'] !== '') return data['text'];
  return textFromCompactStream(data['stream'] ?? message['stream']);
}

function textFromContent(content: unknown): string {
  if (Array.isArray(content)) {
    let out = '';
    for (const block of content) {
      const rec = asRecord(block);
      if (rec !== null && rec['type'] === 'text' && typeof rec['text'] === 'string') out += rec['text'];
    }
    return out;
  }
  const one = asRecord(content);
  if (one !== null && one['type'] === 'text' && typeof one['text'] === 'string') return one['text'];
  return '';
}

function textFromCompactStream(stream: unknown): string {
  if (!Array.isArray(stream)) return '';
  let out = '';
  for (const record of stream) {
    const rec = asRecord(record);
    if (rec === null) continue;
    if (rec['type'] === 'text-chunks' && Array.isArray(rec['texts'])) {
      for (const piece of rec['texts']) {
        if (typeof piece === 'string') out += piece;
      }
      continue;
    }
    if (rec['type'] === 'text-delta' && typeof rec['text'] === 'string') {
      out += rec['text'];
      continue;
    }
    if (rec['type'] === 'chunk') {
      const chunk = asRecord(rec['chunk']);
      if (chunk?.['type'] === 'text-delta' && typeof chunk['text'] === 'string') out += chunk['text'];
    }
  }
  return out;
}

function clipTask(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= TASK_LABEL_MAX ? one : `${one.slice(0, TASK_LABEL_MAX)}…`;
}

function taskSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} 秒`;
}
