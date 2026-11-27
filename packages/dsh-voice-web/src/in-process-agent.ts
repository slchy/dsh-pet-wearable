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
import type { AgentAnnouncer, AgentImage, AgentProvider, AgentReplyView, TurnContext } from './voice/providers.ts';

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

/**
 * 常驻自发轮看门口断线后的重连间隔。短到用户察觉不到，又不至于在宿主重启时
 * 打出一串重连。
 */
const WATCHER_RETRY_MS = 500;

/**
 * 同一子代理的 `agent-message` 播报后，多久内到达的 `subagent-settled` 视为重复通知。
 *
 * 可续写子代理完成时，宿主先发 `agent-message`（带正文），约 300 ms 后补一条
 * `subagent-settled`（只是形式通知）。后者没有新增结论，再念一遍就是复述。
 */
const SETTLED_DEDUP_WINDOW_MS = 60_000;

/**
 * 记住多少个语音侧 `requestId`。只用来认出「这一轮是我们自己 prompt 的」——
 * 太久以前的 id 不可能再出现在 in-flight 的轮次里，留 32 条足够。
 */
const VOICE_RPC_CAP = 32;

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

/**
 * 宿主 `jobController`：只认「杀掉一个后台 `job`」这一件事。
 *
 * `cancelTurn()` 拿它停 `bash` / `pwsh` 的 `run_in_background` 作业；没有这个
 * 服务时任务会继续在宿主机上跑，但语音侧至少不会假装已经停掉。
 */
export interface HostJobController {
  kill(request: { readonly sessionId: string; readonly jobId: string }): unknown;
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
  /** 可选：停后台 `job` 用。缺了只影响「取消得干不干净」。 */
  readonly jobController?: HostJobController | null;
  /**
   * 常驻「自发轮」看门狗：dsh 把 `subagent` / 后台 `job` 跑完之后会自己开一轮
   * 把结果说出来，那一轮没有语音侧发起的 prompt。开了这个开关才会把它的正文
   * 转成播报。
   *
   * 默认 `false`：单测每轮只备一条 `follow` 脚本，多一条常驻 follow 会打乱脚本队列。
   */
  readonly watchSpontaneous?: boolean;
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
  /**
   * 这一轮派过 `subagent` / `subagent_fork`。dsh 的 async-first 模式会在派活后
   * 立刻结束主轮，结果稍后由它自己开一轮说 —— 所以这种轮次不是终态答案。
   */
  spawnedSubagent = false;
  /** 这一轮注册过的后台 `job`（`run_in_background: true`）。 */
  readonly startedJobIds = new Set<string>();
  /** 已经结算的后台 `job`；`job/settled` 可能永远不来（aborted）。 */
  readonly settledJobIds = new Set<string>();
  /**
   * 异步移交绑定的目标 id：`subagent/catalog` 的 `childId`、`send_message` 的
   * `agent_id`，或第一个注册的后台 `jobId`。回调时用它精确归并结算。
   */
  asyncTargetId: string | null = null;
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

  /** 主轮结束时还有没结算的异步活：`subagent` 没回结果，或 `job` 还没 `job/settled`。 */
  hasUnsettledAsyncWork(): boolean {
    if (this.spawnedSubagent) return true;
    for (const jobId of this.startedJobIds) {
      if (!this.settledJobIds.has(jobId)) return true;
    }
    return false;
  }

  /** 本轮异步移交绑定的目标：优先精确目标，否则取第一个还没结算的后台 job。 */
  resolvedAsyncTargetId(): string | undefined {
    if (this.asyncTargetId !== null && this.asyncTargetId !== '') return this.asyncTargetId;
    for (const jobId of this.startedJobIds) {
      if (!this.settledJobIds.has(jobId)) return jobId;
    }
    return undefined;
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

  /** 在跑的 `job`（按开始时间，早的在前）。取消时按它逐个 `kill`。 */
  activeJobList(): readonly JobFact[] {
    return [...this.running.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 还没回结果的子代理会话 id。取消时按它 `controller.cancel`。 */
  activeChildIds(): readonly string[] {
    return [...this.children.keys()];
  }

  forgetChildren(childIds: readonly string[]): void {
    for (const childId of childIds) this.children.delete(childId);
  }

  forgetJobs(jobIds: readonly string[]): void {
    for (const jobId of jobIds) this.running.delete(jobId);
  }

  /** 换绑 / 重置 / 关闭：旧会话上的事实全部作废。 */
  clearAll(): void {
    this.running.clear();
    this.recent.length = 0;
    this.children.clear();
  }

  /**
   * @param aborted 这条终态帧是宿主侧取消。只有 aborted 才清「还在跑」的事实 ——
   *   正常 `completed` 的 `turn/end` 之后，后台 `job` / 子代理往往还在跑
   *   （dsh 的 async-first 模式），清掉就会让看门狗以为活干完了。
   */
  observe(
    sessionId: string,
    type: string,
    data: Record<string, unknown> | undefined,
    aborted = false,
  ): void {
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
      // 只有 catalog 带真正的 `childId`（= 子代理会话 id，取消时要按它 `cancel`）。
      // `tool/call` 里没有这个 id，所以不在这里造占位：用假 id 取消会打到不存在的会话。
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
    /*
     * 可续写子代理被 `send_message` 重新唤醒时不会再发 `subagent/catalog`。
     * 这里补一条占位，用户说「别查了」时才能按 `sessionId` 取消到它。
     */
    if (type === 'tool/call' && sessionId === this.mainSessionId() && toolNameOf(data) === 'send_message') {
      const targetId = subagentTargetIdFromToolCall(data);
      if (targetId === '' || targetId === this.mainSessionId() || this.children.has(targetId)) return;
      this.children.set(targetId, { childId: targetId, label: '继续子代理', at: Date.now() });
      return;
    }
    if (type === 'subagent/settled' || type === 'subagent/end') {
      const childId = typeof data?.['childId'] === 'string' ? data['childId'] : '';
      if (childId !== '') this.children.delete(childId);
      return;
    }
    /*
     * dsh 唤醒主会话时会把「谁回来了」写进 `source`：那正是子代理交结果的时刻。
     * 以前这里靠「主会话下一次 `turn/start`」清，会把**还在跑**的兄弟子代理一起忘掉。
     */
    if (type === 'user/message' && sessionId === this.mainSessionId()) {
      const source = asRecord(data?.['source']);
      const kind = typeof source?.['kind'] === 'string' ? source['kind'] : '';
      if (kind !== 'subagent-settled' && kind !== 'agent-message') return;
      const childId = typeof source?.['senderSessionId'] === 'string' ? source['senderSessionId'] : '';
      if (childId !== '') this.children.delete(childId);
      return;
    }
    /*
     * 宿主 aborted 时 `job/settled` 可能永远不来。轮次被取消后还留着「在跑」的
     * 记录，`hasActiveWork()` 就永远为真，看门狗再也不会判死。
     */
    if (type === 'turn/end' && sessionId === this.mainSessionId() && aborted) {
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

/** 自发轮是谁开的。只有 `spontaneous`（以及无主轮在跑的 `unknown`）才播报。 */
type WatcherOrigin = 'unknown' | 'voice_prompt' | 'web_user' | 'spontaneous';

/**
 * 常驻看门狗里「当前这一轮」的累加器。
 *
 * 与 `TurnState` 分开：这里不做看门狗 / 票据，只回答「这一轮结束时该不该念」。
 */
interface WatcherTurn {
  seq: number;
  origin: WatcherOrigin;
  /** 唤醒这一轮的用户消息类型：`agent-message` / `subagent-settled` / `tool-jobs` / `schedule`。 */
  sourceKind: string;
  /** 这次唤醒来自哪个子代理 / 后台 job；空串 = 没有具体目标。 */
  sourceTargetId: string;
  committed: string;
  streamed: string;
  spawnedSubagent: boolean;
  readonly startedJobIds: Set<string>;
  readonly settledJobIds: Set<string>;
}

function newWatcherTurn(seq: number): WatcherTurn {
  return {
    seq,
    origin: 'unknown',
    sourceKind: '',
    sourceTargetId: '',
    committed: '',
    streamed: '',
    spawnedSubagent: false,
    startedJobIds: new Set<string>(),
    settledJobIds: new Set<string>(),
  };
}

function watcherHasUnsettledAsync(turn: WatcherTurn): boolean {
  if (turn.spawnedSubagent) return true;
  for (const jobId of turn.startedJobIds) {
    if (!turn.settledJobIds.has(jobId)) return true;
  }
  return false;
}

export class InProcessDshAgent implements AgentProvider {
  readonly name = 'dsh';

  private readonly controller: HostSessionController;
  private readonly workDir: string;
  private readonly log: (line: string) => void;
  private readonly announceStore: AnnounceStore | null;
  private readonly jobController: HostJobController | null;
  private readonly watchSpontaneous: boolean;
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
  private announcer: AgentAnnouncer | null = null;
  private detachedSink: ((userText: string, answer: string, spoken: boolean) => void) | null = null;
  /**
   * 最近一次真正播报过的 `agent-message` 时刻，按子代理 id 记。
   *
   * 可续写子代理完成后，宿主先发 `agent-message` 再在约 300 ms 后补一条
   * `subagent-settled`；后者内容重复，靠它静默抑制。再次 `send_message`
   * 唤醒同一子代理、或取消它时删掉，避免误杀下一波。
   */
  private readonly recentAgentMessageAt = new Map<string, number>();
  /** 语音侧自己发起的 prompt id：看门狗据此认出「这一轮不是自发轮」。 */
  private readonly voiceRpcIds = new Set<string>();
  private watcherAbort: AbortController | null = null;
  private watcherSessionId: string | null = null;
  private watcherRetry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: InProcessDshAgentOptions) {
    this.controller = options.controller;
    this.workDir = options.workDir;
    const configured = options.sessionId?.trim();
    this.configuredId = configured === undefined || configured === '' ? null : configured;
    this.log = options.log ?? (() => {});
    this.announceStore = options.announceStore ?? null;
    this.jobController = options.jobController ?? null;
    this.watchSpontaneous = options.watchSpontaneous === true;
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
    this.stopWatcher();
    this.cancelInFlight();
    this.boundSessionId = next;
    this.configuredId = null;
    this.tasks.clearAll();
    this.recentAgentMessageAt.clear();
    if (next !== null) this.ensureWatcher(next);
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

  setAnnouncer(cb: AgentAnnouncer | null): void {
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

  /**
   * 票据对不上当前在途轮就丢掉，避免迟到的取消杀掉下一轮。
   *
   * 没有票据 = 用户明说「别查了 / 取消任务」：除了停主轮，还要把这一轮派出去的
   * 子代理和后台 `job` 一并停掉 —— 主轮早就结束了（async-first），只停主轮等于
   * 什么都没停。
   */
  cancelTurn(ticket?: TurnTicket): void {
    const turn = this.matchTurn(ticket);
    if (ticket === undefined) this.cancelBackgroundWork();
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
    this.stopWatcher();
    this.cancelInFlight();
    this.boundSessionId = null;
    this.configuredId = null;
    this.tasks.clearAll();
    this.recentAgentMessageAt.clear();
    this.log('  会话    已重置，下一轮重新创建');
  }

  /** 取消在途轮并摘掉回调。重复调用无事。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openEpoch += 1;
    this.opening = null;
    this.stopWatcher();
    this.cancelInFlight();
    this.tasks.clearAll();
    this.recentAgentMessageAt.clear();
    this.voiceRpcIds.clear();
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
        this.ensureWatcher(bound);
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
    this.ensureWatcher(bound);
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
    // 已经绑好的会话不会走 `openBoundSession`，这里再保一次常驻看门狗。
    this.ensureWatcher(sessionId);
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
      // 记在 prompt 之前：常驻看门狗靠它认出「这一轮是我们自己发起的」。
      const requestId = randomUUID();
      this.rememberVoiceRpc(requestId);
      try {
        await this.controller.prompt({
          requestId,
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
    this.tasks.observe(owner, event.type, event.data, isAbortedTerminal(event.type, event.data));
    this.noteAsyncWork(turn, event);
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

  /**
   * dsh 的 async-first：主轮可以派完活立刻结束，结果之后由它自己开一轮说。
   * 这一轮只要留下「还没结算的 subagent / job」，就不能当成终态答案播出去 ——
   * 否则用户只听到一句「已启动后台任务」，真正的结果再也没人念。
   */
  private noteAsyncWork(turn: TurnState, event: NormalizedEvent): void {
    // prompt 之前的帧属于队列里上一轮；开场 snapshot 忙碌时同理，等本轮 turn/start。
    if (!turn.promptDispatched) return;
    if (turn.awaitingPriorTurnEnd && !turn.sawTurnStart) return;
    if (event.type === 'subagent/catalog') {
      // catalog 可能挂在主会话上，也可能带子代理自己的 sessionId，两种都算派过活。
      turn.spawnedSubagent = true;
      const childId = typeof event.data?.['childId'] === 'string' ? event.data['childId'].trim() : '';
      if (childId !== '') {
        turn.asyncTargetId = childId;
        // 新一波任务：不要再被上一波的 `agent-message` 去重记录误杀。
        this.recentAgentMessageAt.delete(childId);
      }
      return;
    }
    if (event.sessionId !== null && event.sessionId !== turn.sessionId) return;
    if (event.type === 'tool/call') {
      const name = toolNameOf(event.data);
      if (isSubagentTool(name)) turn.spawnedSubagent = true;
      if (name === 'send_message') {
        // 可续写子代理：`send_message` 是同一目标的下一波任务，绑定 id 便于回调归并。
        const targetId = subagentTargetIdFromToolCall(event.data);
        if (targetId !== '') {
          turn.asyncTargetId = targetId;
          this.recentAgentMessageAt.delete(targetId);
        }
      }
      return;
    }
    if (event.type === 'job/registered') {
      const jobId = jobIdOf(event.data);
      if (jobId !== '') {
        turn.startedJobIds.add(jobId);
        if (turn.asyncTargetId === null) turn.asyncTargetId = jobId;
      }
      return;
    }
    if (event.type === 'job/settled') {
      const jobId = jobIdOf(event.data);
      if (jobId !== '') turn.settledJobIds.add(jobId);
    }
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
      this.consumeStreamPayload(turn, payload);
      return;
    }
    if (typeof frame.delta === 'string') {
      this.pushDelta(turn, frame.delta);
      return;
    }
    if (typeof frame.text === 'string') this.pushDelta(turn, frame.text);
  }

  private consumeStreamPayload(turn: TurnState, payload: unknown): void {
    walkStreamPayload(
      payload,
      0,
      (text) => { this.pushDelta(turn, text); },
      (text) => { this.pushFullText(turn, text); },
      () => turn.settled,
    );
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
    /*
     * `[ASYNC]` 是 dsh 明说「活派出去了，别等这一轮」；`hasUnsettledAsyncWork()`
     * 兜住「模型忘了写标签」的情况。两种都必须立刻放开主对话 —— 让语音侧
     * 干等一个已经结束的轮次，用户会以为卡死了。
     */
    if (isAsyncTagOnly(raw) || turn.hasUnsettledAsyncWork()) {
      this.log('  dsh     已异步派发后台（subagent/job），立即释放主对话');
      const asyncTargetId = turn.resolvedAsyncTargetId();
      return {
        text: '',
        speech: '',
        emotion: parsed.emotion,
        path: 'dsh',
        asyncDispatched: true,
        ...(asyncTargetId === undefined ? {} : { asyncTargetId }),
      };
    }
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
    // 只有 `[ASYNC]` 的轮次没有内容可念（念出来就是「ASYNC」）；结果之后由看门狗转播。
    const asyncOnly = isAsyncTagOnly(raw);
    const willSpeak = !asyncOnly && this.announcer !== null && this.active === null && speech !== '';
    try {
      this.detachedSink?.(turn.userText, raw, willSpeak);
    } catch (error) {
      this.log(`  放手    ✗ 回注失败：${asError(error).message}`);
    }
    if (speech === '' || asyncOnly) return;
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

  /**
   * 用户明说取消：把这一轮派出去、还在跑的子代理和后台 `job` 一并停掉。
   *
   * async-first 模式下主轮早就结束了，`matchTurn()` 找不到东西可取消 —— 真正
   * 该停的是 `subagent` 会话和 `run_in_background` 作业。
   */
  private cancelBackgroundWork(): void {
    const childIds = this.tasks.activeChildIds();
    const jobs = this.tasks.activeJobList();
    if (childIds.length === 0 && jobs.length === 0) return;
    const cancelledChildren: string[] = [];
    for (const childId of childIds) {
      try {
        const result = this.controller.cancel({ sessionId: childId });
        void Promise.resolve(result).catch(() => {});
        cancelledChildren.push(childId);
      } catch (error) {
        this.log(`  取消    ✗ 子代理 ${childId}：${asError(error).message}`);
      }
    }
    const cancelledJobs: string[] = [];
    if (this.jobController === null) {
      if (jobs.length > 0) this.log(`  取消    ✗ 宿主没有 jobController，停不掉 ${jobs.length} 个后台任务`);
    } else {
      for (const job of jobs) {
        try {
          this.jobController.kill({ sessionId: job.owner, jobId: job.jobId });
          cancelledJobs.push(job.jobId);
        } catch (error) {
          this.log(`  取消    ✗ 后台任务 ${job.jobId}：${asError(error).message}`);
        }
      }
    }
    this.tasks.forgetChildren(cancelledChildren);
    this.tasks.forgetJobs(cancelledJobs);
    for (const childId of cancelledChildren) this.recentAgentMessageAt.delete(childId);
    if (cancelledChildren.length > 0 || cancelledJobs.length > 0) {
      this.log(`  取消    已停掉 ${cancelledChildren.length} 个子代理、${cancelledJobs.length} 个后台任务`);
    }
    if (
      this.active === null
      && this.background === null
      && this.boundSessionId !== null
      && (cancelledChildren.length > 0 || cancelledJobs.length > 0)
    ) {
      this.log('  取消    主对话空闲，后台工作已按用户要求停掉');
    }
  }

  /** 记下语音侧发起的 prompt id；只留最近 `VOICE_RPC_CAP` 条。 */
  private rememberVoiceRpc(requestId: string): void {
    this.voiceRpcIds.add(requestId);
    while (this.voiceRpcIds.size > VOICE_RPC_CAP) {
      const oldest = this.voiceRpcIds.values().next().value;
      if (oldest === undefined) break;
      this.voiceRpcIds.delete(oldest);
    }
  }

  /** 起常驻看门狗（幂等）。只在 `watchSpontaneous` 打开并且已绑定会话时生效。 */
  private ensureWatcher(sessionId: string): void {
    if (!this.watchSpontaneous || this.disposed) return;
    if (this.watcherAbort !== null && this.watcherSessionId === sessionId) return;
    this.stopWatcher();
    const abort = new AbortController();
    this.watcherAbort = abort;
    this.watcherSessionId = sessionId;
    void this.runWatcher(sessionId, abort);
  }

  private stopWatcher(): void {
    const abort = this.watcherAbort;
    this.watcherAbort = null;
    this.watcherSessionId = null;
    if (this.watcherRetry !== null) {
      clearTimeout(this.watcherRetry);
      this.watcherRetry = null;
    }
    if (abort !== null && !abort.signal.aborted) abort.abort();
  }

  /** 流自己结束（宿主重启 / 连接掉了）不能把自发播报永久掐死，短退避后重连。 */
  private scheduleWatcherRetry(sessionId: string, abort: AbortController): void {
    if (this.disposed || abort.signal.aborted) return;
    if (this.watcherAbort !== abort || this.boundSessionId !== sessionId) return;
    if (this.watcherRetry !== null) return;
    const timer = setTimeout(() => {
      this.watcherRetry = null;
      if (this.disposed || abort.signal.aborted) return;
      if (this.watcherAbort !== abort || this.boundSessionId !== sessionId) return;
      void this.runWatcher(sessionId, abort);
    }, WATCHER_RETRY_MS);
    timer.unref?.();
    this.watcherRetry = timer;
  }

  /**
   * 常驻看门狗：只认「dsh 自己开的轮次」。
   *
   * 三种不该念：我们自己 prompt 的轮（`voice_prompt`，正文已经由 `reply()` 出）、
   * 用户在网页里打的字（`web_user`）、以及又一次 `[ASYNC]` / 派活的轮。
   * 其余 `agent-message` / `subagent-settled` / `tool-jobs` / `schedule` 唤醒的
   * 轮次，就是后台任务的结果，念出来。
   */
  private async runWatcher(sessionId: string, abort: AbortController): Promise<void> {
    let iterable: AsyncIterable<HostSessionFollowFrame>;
    try {
      iterable = this.controller.follow({
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: 1,
      }, abort.signal);
    } catch {
      this.scheduleWatcherRetry(sessionId, abort);
      return;
    }
    let baseline = -1;
    let opened = false;
    let turnSeq = 0;
    let turn = newWatcherTurn(0);
    /** 最近一次 `job/settled` 的 id：`tool-jobs` 唤醒没带 `jobId` 时兜底。 */
    let lastSettledJobId = '';
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      while (!abort.signal.aborted) {
        let next: IteratorResult<HostSessionFollowFrame>;
        try {
          next = await iterator.next();
        } catch {
          break;
        }
        if (next.done === true) break;
        const frame = next.value;
        // 打开时还没拿到 snapshot：此刻的帧都是「历史」，别当成新播报。
        if (!opened) {
          if (frame.type !== 'snapshot') continue;
          baseline = cursorOf(frame);
          opened = true;
          continue;
        }
        if (frame.type === 'snapshot') continue;
        if (isAssistantType(frame.type)) {
          this.consumeWatcherAssistant(turn, frame);
          continue;
        }
        const event = readEvent(frame);
        if (event === null) continue;
        if (event.seq !== null && event.seq <= baseline) continue;
        const owner = event.sessionId ?? sessionId;
        const aborted = isAbortedTerminal(event.type, event.data);
        this.tasks.observe(owner, event.type, event.data, aborted);
        // `subagent/catalog` 可能带子代理自己的 sessionId；先记进本轮异步标记并清同目标去重，再按主会话过滤。
        if (event.type === 'subagent/catalog') {
          turn.spawnedSubagent = true;
          const childId = typeof event.data?.['childId'] === 'string' ? event.data['childId'].trim() : '';
          if (childId !== '') this.recentAgentMessageAt.delete(childId);
        }
        // 子代理的事件只喂 TaskMemo（它自己的 `job/*` 也要记），不参与本轮累加与主会话 job 兜底。
        if (event.sessionId !== null && event.sessionId !== sessionId) continue;
        if (event.type === 'job/settled') {
          const settledJobId = jobIdOf(event.data);
          if (settledJobId !== '') lastSettledJobId = settledJobId;
        }
        if (event.type === 'turn/start') {
          turnSeq += 1;
          turn = newWatcherTurn(turnSeq);
          continue;
        }
        if (event.type === 'user/message') {
          this.observeWatcherOrigin(turn, event.data, lastSettledJobId);
          // 兜底 id 只归这一条 `tool-jobs` 通知用，消费完就丢。
          if (turn.sourceKind === 'tool-jobs') lastSettledJobId = '';
          continue;
        }
        if (event.type === 'assistant/message') {
          if (turn.origin === 'voice_prompt' || turn.origin === 'web_user') continue;
          const text = textFromAssistantData(event.data);
          if (text !== '') {
            turn.committed = text;
            if (turn.streamed === '') turn.streamed = text;
          }
          continue;
        }
        this.observeWatcherAsync(turn, event);
        if (!isTerminalEvent(event.type, event.data)) continue;
        if (aborted) {
          turn = newWatcherTurn(turnSeq);
          continue;
        }
        this.emitWatcherTurn(turn);
        turn = newWatcherTurn(turnSeq);
      }
    } finally {
      try {
        await iterator.return?.();
      } catch {
        // 流已经因 abort 结束
      }
    }
    if (!abort.signal.aborted && !this.disposed && this.boundSessionId === sessionId) {
      this.scheduleWatcherRetry(sessionId, abort);
    }
  }

  private observeWatcherOrigin(
    turn: WatcherTurn,
    data: Record<string, unknown> | undefined,
    lastSettledJobId = '',
  ): void {
    const source = asRecord(data?.['source']);
    const kind = typeof source?.['kind'] === 'string' ? source['kind'] : '';
    const rpcId = typeof source?.['rpcId'] === 'string' ? source['rpcId'] : '';
    if (kind === 'user') {
      turn.origin = rpcId !== '' && this.voiceRpcIds.has(rpcId) ? 'voice_prompt' : 'web_user';
      return;
    }
    if (kind === 'agent-message' || kind === 'subagent-settled') {
      turn.origin = 'spontaneous';
      turn.sourceKind = kind;
      turn.sourceTargetId = typeof source?.['senderSessionId'] === 'string'
        ? source['senderSessionId'].trim()
        : '';
      return;
    }
    if (kind === 'tool-jobs') {
      turn.origin = 'spontaneous';
      turn.sourceKind = kind;
      const jobId = typeof source?.['jobId'] === 'string' ? source['jobId'].trim() : '';
      // `source.jobId` 最准；没有就用最近刚 `job/settled` 的那个当兜底。
      turn.sourceTargetId = jobId !== '' ? jobId : lastSettledJobId;
      return;
    }
    if (kind === 'schedule') {
      turn.origin = 'spontaneous';
      turn.sourceKind = kind;
    }
  }

  /** 自发轮自己又派了活：这一轮只是转手，不是结果，别念。 */
  private observeWatcherAsync(turn: WatcherTurn, event: NormalizedEvent): void {
    if (event.type === 'subagent/catalog') {
      turn.spawnedSubagent = true;
      const childId = typeof event.data?.['childId'] === 'string' ? event.data['childId'].trim() : '';
      if (childId !== '') this.recentAgentMessageAt.delete(childId);
      return;
    }
    if (event.type === 'tool/call') {
      const name = toolNameOf(event.data);
      if (isSubagentTool(name)) turn.spawnedSubagent = true;
      if (name === 'send_message') {
        const targetId = subagentTargetIdFromToolCall(event.data);
        if (targetId !== '') this.recentAgentMessageAt.delete(targetId);
      }
      // 回调轮读了哪个 job，就把这次回调精确绑到它上面 —— 覆盖 `job/settled` 的兜底。
      // 不置 `spawnedSubagent`：`job_output` 只是读结果，不是又派了活。
      if ((name === 'job_output' || name === 'job_status') && turn.sourceKind === 'tool-jobs') {
        const jobId = jobIdFromJobOutputCall(event.data);
        if (jobId !== '') turn.sourceTargetId = jobId;
      }
      return;
    }
    if (event.type === 'job/registered') {
      const jobId = jobIdOf(event.data);
      if (jobId !== '') turn.startedJobIds.add(jobId);
      return;
    }
    if (event.type === 'job/settled') {
      const jobId = jobIdOf(event.data);
      if (jobId !== '') turn.settledJobIds.add(jobId);
    }
  }

  private consumeWatcherAssistant(turn: WatcherTurn, frame: HostSessionFollowFrame): void {
    if (turn.origin === 'voice_prompt' || turn.origin === 'web_user') return;
    const payload = frame.frame ?? frame.chunk ?? frame.data;
    if (payload !== undefined) {
      walkStreamPayload(
        payload,
        0,
        (text) => { turn.streamed += text; },
        (text) => { if (text !== '') turn.committed = text; },
        () => false,
      );
      return;
    }
    if (typeof frame.delta === 'string') {
      turn.streamed += frame.delta;
      return;
    }
    if (typeof frame.text === 'string') turn.streamed += frame.text;
  }

  /**
   * 主轮结束（`turn/end`）时决定这一轮要不要念。
   *
   * `origin === 'unknown'` 只在完全没有主轮在跑时才算自发 —— 那多半是看门狗
   * 连上时错过 `user/message` 的那一小段，宁可少念一句，也不要把用户刚问的
   * 那一轮重复播一遍。
   */
  private emitWatcherTurn(turn: WatcherTurn): void {
    if (turn.origin === 'voice_prompt' || turn.origin === 'web_user') return;
    if (turn.origin === 'unknown' && (this.active !== null || this.background !== null)) return;
    /*
     * 可续写子代理：`agent-message` 已经播过正文，300 ms 后的 `subagent-settled`
     * 只是「它结束了」的形式通知。内容重复就不再念第二遍。
     * 没发过 `agent-message` 就失败 / 退出的子代理没有这条记录，仍然要播。
     */
    if (turn.sourceKind === 'subagent-settled' && turn.sourceTargetId !== '') {
      const lastAt = this.recentAgentMessageAt.get(turn.sourceTargetId);
      if (lastAt !== undefined) {
        this.recentAgentMessageAt.delete(turn.sourceTargetId);
        if (this.now() - lastAt <= SETTLED_DEDUP_WINDOW_MS) {
          this.log(`  自发    跳过同子代理重复结算通知（${turn.sourceTargetId}）`);
          return;
        }
      }
    }
    const raw = (turn.committed.trim() !== '' ? turn.committed : turn.streamed).trim();
    if (raw === '') return;
    if (watcherHasUnsettledAsync(turn)) return;
    if (isAsyncTagOnly(raw)) return;
    const parsed = parseEmotion(raw);
    const canonical = CANONICAL_USER_TAG.exec(parsed.rest);
    const canonicalPrefix = canonical !== null ? (canonical[0] ?? '') : '';
    const body = canonicalPrefix !== '' ? parsed.rest.slice(canonicalPrefix.length) : parsed.rest;
    const speech = cleanForSpeech(body);
    if (speech === '') return;
    // 只有真正播出去才算「这个子代理刚被念过」。记满 64 条时顺手删最旧的。
    if (turn.sourceKind === 'agent-message' && turn.sourceTargetId !== '') {
      this.recentAgentMessageAt.set(turn.sourceTargetId, this.now());
      while (this.recentAgentMessageAt.size > 64) {
        const oldest = this.recentAgentMessageAt.keys().next().value;
        if (oldest === undefined) break;
        this.recentAgentMessageAt.delete(oldest);
      }
    }
    const out = canonicalPrefix !== '' ? `${canonicalPrefix.trimEnd()}\n${speech}` : speech;
    this.deliverSpontaneous(out, speech, parsed.emotion, turn.sourceTargetId);
  }

  /** 自发轮的出口：有连接就播（保留原意标签给总线抽 canonicalUser），没连接就攒纯正文进待补播。 */
  private deliverSpontaneous(
    payload: string,
    plainSpeech: string,
    emotion: string,
    targetId?: string,
  ): void {
    if (this.announcer === null) {
      const backlog = this.announceStore?.push(plainSpeech, emotion) ?? 0;
      this.log(`  自发    没有连接，存入待补播（积压 ${backlog} 条）`);
      return;
    }
    this.log('  自发    后台跑完了 → 结果转成播报');
    try {
      this.announcer(payload, emotion, targetId !== undefined && targetId !== '' ? { targetId } : undefined);
    } catch (error) {
      this.log(`  自发    ✗ 播报失败：${asError(error).message}`);
    }
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

/**
 * 递归拆 dsh 的流式载荷。`onDelta` 收增量，`onFullText` 收整段（`text` /
 * `block-end`）。主轮与常驻看门狗共用这一份 —— 两份解析器迟早漂开。
 */
function walkStreamPayload(
  payload: unknown,
  depth: number,
  onDelta: (text: string) => void,
  onFullText: (text: string) => void,
  stopped: () => boolean,
): void {
  if (depth > 8 || stopped()) return;
  if (typeof payload === 'string') {
    onDelta(payload);
    return;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      walkStreamPayload(item, depth + 1, onDelta, onFullText, stopped);
    }
    return;
  }
  const rec = asRecord(payload);
  if (rec === null) return;
  const type = typeof rec['type'] === 'string' ? rec['type'] : '';
  if (type === 'text-delta' || type === 'text_delta') {
    if (typeof rec['text'] === 'string') onDelta(rec['text']);
    return;
  }
  if (type === 'text-chunks' || type === 'text_chunks') {
    const texts = rec['texts'];
    if (Array.isArray(texts)) {
      for (const piece of texts) {
        if (typeof piece === 'string') onDelta(piece);
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
    if ('chunk' in rec) walkStreamPayload(rec['chunk'], depth + 1, onDelta, onFullText, stopped);
    else if (typeof rec['delta'] === 'string') onDelta(rec['delta']);
    else if (typeof rec['text'] === 'string') onDelta(rec['text']);
    return;
  }
  if (type === 'block-end' || type === 'text') {
    const block = type === 'block-end' ? asRecord(rec['block']) : rec;
    if (block !== null && typeof block['text'] === 'string' && (type === 'text' || block['type'] === 'text')) {
      onFullText(block['text']);
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
  if (type === '' && typeof rec['text'] === 'string') onDelta(rec['text']);
}

/** dsh 派子代理的工具名（`subagent_fork` 是同一件事的分叉版，`send_message` 是续写同一个子代理）。 */
function isSubagentTool(name: string): boolean {
  return name === 'subagent' || name === 'subagent_fork' || name === 'send_message';
}

/**
 * `tool/call` 的参数可能在 `arguments` / `args` / `input`，且可能是 JSON 字符串。
 * 解析失败一律当空对象 —— 调用方只关心里面有没有目标 id。
 */
function parseToolArgs(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const keys = ['arguments', 'args', 'input'] as const;
  for (const key of keys) {
    const raw = data?.[key];
    if (typeof raw === 'string') {
      const parsed = asRecord(parseJson(raw));
      if (parsed !== null) return parsed;
      continue;
    }
    const record = asRecord(raw);
    if (record !== null) return record;
  }
  return {};
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readArgId(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** `send_message` 的目标子代理 id：`agent_id` / `agentId` / `sessionId` / `childId`。 */
function subagentTargetIdFromToolCall(data: Record<string, unknown> | undefined): string {
  return readArgId(parseToolArgs(data), ['agent_id', 'agentId', 'sessionId', 'childId']);
}

/** 读后台 job 结果的工具调用里带的 `job_id` / `jobId`。 */
function jobIdFromJobOutputCall(data: Record<string, unknown> | undefined): string {
  return readArgId(parseToolArgs(data), ['job_id', 'jobId']);
}

/** `tool/call` 的载荷里工具名可能叫 `name` / `tool` / `toolName`。 */
function toolNameOf(data: Record<string, unknown> | undefined): string {
  const keys = ['name', 'tool', 'toolName'] as const;
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function jobIdOf(data: Record<string, unknown> | undefined): string {
  const jobId = data?.['jobId'];
  return typeof jobId === 'string' ? jobId : '';
}

/** 保留首行 `[原意: …]` 给上游总线抽 `canonicalUser`，避免被 `cleanForSpeech` 啃掉左括号。 */
const CANONICAL_USER_TAG =
  /^\s*[\[【][^\S\r\n]*原意[^\S\r\n]*[:：][^\S\r\n]*([^\r\n\]】]*?)[^\S\r\n]*[\]】][^\S\r\n]*(?:\r?\n)?/u;

/**
 * `[ASYNC]` / `【ASYNC】`（情绪标签可以写在前面）—— dsh 明说这一轮只是派活，
 * 结果之后自己开一轮说。
 */
function isAsyncTagOnly(raw: string): boolean {
  return /^[\[【]\s*ASYNC\s*[\]】]$/iu.test(parseEmotion(raw).rest.trim());
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
