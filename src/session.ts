/**
 * dsh 会话封装：把一段文本交给 DeepSeek Harness，拿回回复文本。
 *
 * 实测事实（2026-11-05，Oracle aarch64，dsh 0.2.1-rc.2）：
 * - `dsh headless --json -` 从 stdin 读任务，stdout 输出 NDJSON
 * - `{"type":"session","sessionId":"session-…","cwd":"…"}` 给出会话 id
 * - `{"type":"final","text":"…"}` 是最终回复，status 事件里带 usage
 * - `--session-id <id>` 续同一会话；**未知 id 是硬错误**
 *
 * 三条硬约束（都是实测踩出来的，不是推测）：
 *
 * 1. **会话绑定创建目录**。dsh 拒绝在别的目录续会话（"was recorded in X,
 *    not Y"），所以 workDir 必须固定，且每次调用的 cwd 都一致。
 * 2. **上下文膨胀靠压缩，不靠轮换**。`dsh-compaction-basic` 在 base 配置里
 *    默认挂载，token 压力上来会自动把旧历史压成摘要，溢出后还会"先压缩再
 *    重试"。所以这里只持久化 id，不设 maxUses、不主动换会话。
 * 3. **续会话失败必须自愈**。带 id 调用失败时清空记录、重开一次，
 *    否则 agent 会永久卡在一个坏 id 上。
 *
 * 会话文件默认放在 workDir **之外**：workspace-write 沙箱允许 agent 写
 * workDir 内的一切，放里面它就能改自己的会话记录。
 *
 * **同一台机器上跑第二个实例（bench、探针）必须用 `VOICE_AGENT_SESSION` 指到别处。**
 * 默认路径是按用户算的，不是按实例算的：两个实例共用它时，后写的会把先写的
 * 会话 id 盖掉，而会话又绑定创建目录（第 1 条），被盖的那个下一轮恢复失败、
 * 静默开新会话 —— 历史就这么丢了（实测：bench 盖掉过生产的指针）。
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { TurnTicket } from './dialog-fsm.ts';
import { SpontaneousTurn } from './spontaneous.ts';
import { SingleFlight } from './single-flight.ts';
import { TaskBoard } from './task-board.ts';
import { LiveGate, LiveTextRelay, LIVE_TOKEN_THRESHOLD, type LiveEvent, type LiveMessage } from './live-text.ts';

/**
 * 单轮超时。
 *
 * 180 s → 60 s：语音场景里「等三分钟」等于挂了。真机最长一轮 8.27 s
 * （1 步 + 一次 web_search），60 s 给了 7 倍余量；真卡住时用户最多等一分钟，
 * 而不是对着空气说三分钟话。
 *
 * 后台作业不受影响：它们不经 `ask` 等待，结算后由 dsh 自发开一轮（见 `onAnnounce`）。
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 取消在途一轮后，等 dsh 自己收尾的最长时间。
 *
 * 正常情况下 `session/cancel` 之后 dsh 立刻发 `session.status=idle`；这里只是兜底，
 * 免得它不发时 `ask` 一路挂到 60 s。取 2 s —— 取消本身是一次 IPC，不需要更久。
 */
const CANCEL_GRACE_MS = 2_000;

/**
 * 撤回（`session/fork`）等多久就算这次放弃。
 *
 * **这个超时不算冷路径**：fork 是在下一轮发 prompt 之前同步等的，它多慢，用户就多等。
 * 所以只给 2 s —— 超时就当没撤成，照旧续原会话（历史里多一条幽灵轮，用户听不出）。
 * 真机上 fork 是复制一段前缀，正常在几十毫秒量级；日志里会打出实测毫秒数。
 */
const FORK_TIMEOUT_MS = 2_000;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  /**
   * 单次最大输入 = **最后一个 step** 的上下文规模。
   *
   * 一轮里有多个 step（工具调用）时，`inputTokens` 累加起来是"这一轮总共读了
   * 多少 token"（成本口径），而 `contextTokens` 是"当时上下文有多大"（压缩阈值口径）。
   * 监控 12.5 万那条线要看的是后者，累加值永远看不出问题。
   */
  contextTokens?: number;
}

/**
 * 把一个 step 的 usage 折进本轮累计值。
 *
 * 两个口径必须分开：
 * - `inputTokens` / `outputTokens` / `cacheReadTokens` **累加** = 这一轮总共花了多少
 * - `contextTokens` 取**最后一个** step 的输入 = 当时上下文有多大
 *
 * `contextTokens` 必须是 `inputTokens + cacheReadTokens`：DeepSeek 只把**未命中缓存**
 * 的那部分算进 inputTokens，命中的记在 cacheReadTokens 里。真机实测一轮
 * `tokens=144/13 cache=67584`，只取 inputTokens 会得出「上下文 144 token」这种
 * 离谱数字 —— 压缩阈值永远看着没到，实际早就该压了。
 *
 * 混成一个数还会得出两个错误结论之一：要么低估成本，要么永远看不出上下文已经
 * 逼近压缩阈值（累加值一直在涨，反而更像"正常"）。
 */
export function foldStepUsage(acc: TokenUsage | null, step: TokenUsage): TokenUsage {
  const hasContext = step.inputTokens !== undefined || step.cacheReadTokens !== undefined;
  const contextTokens = hasContext
    ? (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0)
    : acc?.contextTokens;
  return {
    inputTokens: (acc?.inputTokens ?? 0) + (step.inputTokens ?? 0),
    outputTokens: (acc?.outputTokens ?? 0) + (step.outputTokens ?? 0),
    cacheReadTokens: (acc?.cacheReadTokens ?? 0) + (step.cacheReadTokens ?? 0),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}

export interface AskResult {
  text: string;
  /** 本次实际使用的会话 id（新会话时是刚拿到的） */
  sessionId: string | null;
  usage: TokenUsage | null;
  durationMs: number;
  /** 首个输出 token 的耗时（ms）。没有流式钩子时缺席 —— 缺了记 undefined，不拿 0 冒充 */
  firstTokenMs?: number;
  /** 是否沿用了已有会话 */
  resumed: boolean;
  /**
   * 这一轮被**放手**了（见 `detachTurn`）：dsh 还在跑，答案之后从播报口出来。
   *
   * 上层看到它就别把空 `text` 当失败 —— 那只是「这一轮不再等它」。
   */
  detached?: boolean;
}

/**
 * 随提示一起下发的图片（ACP `image` content block）。
 *
 * 实测（2026-11-06）：`deepseek-flash` 的 `input_modalities` 是 `["text","image"]`，
 * 而 dsh 的 ACP 层本来就支持 image 块，mimeType 只收
 * png / jpeg / webp / gif，且 data 必须是**标准 base64**（不能带 `data:` 前缀）。
 */
export interface ImageAttachment {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 标准 base64，不带 data URL 前缀 */
  data: string;
}

export interface SessionOptions {
  /**
   * dsh 可执行文件。服务器上 `~/node22/bin` 只在交互式 zsh 的 PATH 里，
   * 非交互式（systemd / ssh 命令）拿不到，所以建议用 DSH_BIN 指定绝对路径。
   */
  program?: string;
  /** 固定工作目录：既是 dsh 的 cwd，也是沙箱的 workspaceRoot */
  workDir: string;
  /**
   * 会话 id 的持久化位置。不给就看环境变量 `VOICE_AGENT_SESSION`，
   * 再没有才是 ~/.voice-agent/session.json（见文件头：第二个实例必须换路径）。
   */
  sessionFile?: string;
  timeoutMs?: number;
  /** 额外的 profile patch 文件（用于挂 MCP 工具等） */
  patch?: string;
  log?: (line: string) => void;
  /**
   * 调用方式。
   *
   * - `headless`：每轮起一个新进程（`dsh headless --json`），简单但每轮多 2–3 s 冷启动。
   * - `sdk`：一个常驻进程通过 stdio JSON-RPC 服务多轮（`dsh --profile sdk`），
   *   省掉进程启动与会话重加载。会话 id 由客户端指定，所以首次自己生成。
   */
  mode?: 'headless' | 'sdk';
  /** sdk 模式必填：provider 路由，实测为 deepseek-official */
  provider?: string;
  /** sdk 模式必填：模型名。实测可用 deepseek-flash / deepseek-v4-pro */
  model?: string;
  /**
   * 流式门槛：这么多 token 之内不流式，超了才把缓冲一次性放出去。
   *
   * 默认 20 —— 语音回复的中位长度就在这附近，短答走流式只会多几次 TTS 调用。
   */
  liveTokenThreshold?: number;
}

export class DshError extends Error {}

/** 透明化之后「原会话」保留多久：过了这段时间连目录一起删 */
export const SUPERSEDED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** 一条「被透明化掉的会话」记录 */
export interface SupersededEntry {
  /** dsh 会话 id */
  readonly id: string;
  /** 透明化时刻（epoch ms） */
  readonly at: number;
  /** 会话目录的绝对路径（删之前会再校验一次它在 dsh 的 sessions 根下） */
  readonly dir: string;
}

/** 比较路径时把 Windows 的 `\` 收成 `/`，并去掉末尾斜杠。 */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 分拣「该删的」和「该留的」。
 *
 * 纯函数，好测：IO 留给调用方（这里只做时间比较）。坏记录（缺字段、路径不像）一律丢掉 ——
 * 一条坏行不该让整份清单失效，更不能让它指向 `rm -rf` 一个奇怪路径。
 */
export function splitSuperseded(
  entries: readonly unknown[],
  now: number,
  sessionsRoot: string,
  ttl = SUPERSEDED_TTL_MS,
): { drop: SupersededEntry[]; keep: SupersededEntry[]; bad: number } {
  const drop: SupersededEntry[] = [];
  const keep: SupersededEntry[] = [];
  let bad = 0;
  // Windows 上 `join` 出来的是反斜杠。先收成 `/` 再比前缀和末段，
  // 否则每一条都会被当成坏记录，过期会话永远删不掉。
  const root = normalizeSlashes(sessionsRoot);
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') { bad += 1; continue; }
    const e = raw as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? e['id'] : '';
    const at = typeof e['at'] === 'number' && Number.isFinite(e['at']) ? e['at'] : 0;
    const dir = typeof e['dir'] === 'string' ? e['dir'] : '';
    if (id === '' || at <= 0 || dir === '') { bad += 1; continue; }
    const dirNorm = normalizeSlashes(dir);
    // 只认 dsh sessions 根下、目录名正好是 id 的那一层。落盘仍用原路径。
    if (root === '' || !dirNorm.startsWith(`${root}/`) || dirNorm.split('/').pop() !== id) {
      bad += 1;
      continue;
    }
    if (now - at >= ttl) drop.push({ id, at, dir });
    else keep.push({ id, at, dir });
  }
  return { drop, keep, bad };
}

/**
 * 「撤回切点」的账本：快车道赢了、而慢车道那一轮**已经答完**时，要把那一轮从
 * dsh 的会话历史里切掉（`session/fork`）。
 *
 * 切点必须落在**入箱之前**：`turn/start` 前面那条 `agent/inbox/spliced`（inserted
 * 非空）就是把这句话塞进收件箱，切在它之后，fork 出来的新会话会把它当待办
 * **重放一遍**（探针实测：切点取 `turn/start − 1` 时幽灵句在新会话里出现 2 次，
 * 取入箱 seq − 1 才干净）。
 *
 * 票据是必须的：那一轮的 promise 可能到下下轮才 resolve，这时账本里已经换成新的
 * 那一轮了 —— 拿错切点去撤会把**下一轮**切掉。
 */
export class RollbackLedger {
  private lastInsert: number | null = null;
  private cut: number | null = null;
  private owner: TurnTicket | null = null;
  private pending: number | null = null;

  /** 吃一条**本会话**的事件（`inserted` = 该事件往收件箱塞了几条，非入箱事件传 0） */
  observe(type: string, seq: number, inserted: number, active: TurnTicket | null): void {
    if (type === 'agent/inbox/spliced') {
      if (inserted > 0) this.lastInsert = seq;
      return;
    }
    if (type === 'turn/start') {
      this.cut = this.lastInsert === null ? null : this.lastInsert - 1;
      this.owner = active;
      this.lastInsert = null;
    }
  }

  /** 认领「这一轮不要了」；票据对不上（迟到的作废）或没有切点时返回 false */
  claim(ticket?: TurnTicket): boolean {
    if (this.cut === null || this.cut < 0) return false;
    // 没有属主票据 = 这一轮不是我们催的（自发轮/后台结算）→ 一律不认，宁可撤不了
    // 也不能拿错切点把**别人**那一轮切掉。
    const mine = this.owner;
    if (mine === null) return false;
    if (ticket !== undefined && (ticket.no !== mine.no || ticket.gen !== mine.gen)) return false;
    this.pending = this.pending === null ? this.cut : Math.min(this.pending, this.cut);
    return true;
  }

  /** 取走待撤回的切点（取一次就清空；连续多轮只会剩下最早那个） */
  take(): number | null {
    const cut = this.pending;
    this.pending = null;
    return cut;
  }

  /**
   * 全清。两种时候必须调：
   * - **fork 成功之后**：账本里的 seq 属于旧会话，留着下次会拿无效切点去 fork 新会话；
   * - **换会话 / reset**：同上。
   */
  reset(): void {
    this.lastInsert = null;
    this.cut = null;
    this.owner = null;
    this.pending = null;
  }

  /** 只读：待撤回的切点（日志用） */
  peek(): number | null {
    return this.pending;
  }
}

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 从 NDJSON 事件流里取会话 id、最终文本、usage 与流式文本。 */
export function parseEvents(stdout: string): {
  sessionId: string | null;
  final: string | null;
  streamed: string;
  usage: TokenUsage | null;
} {
  let sessionId: string | null = null;
  let final: string | null = null;
  let streamed = '';
  let usage: TokenUsage | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue; // 半行/非 JSON，跳过
    }
    const type = e['type'];
    if (type === 'session') {
      const id = e['sessionId'];
      if (typeof id === 'string' && id) sessionId = id;
    } else if (type === 'final') {
      const t = e['text'];
      if (typeof t === 'string') final = t;
    } else if (type === 'text') {
      // --json 模式下 text 是流式增量；final 缺失时用它兜底
      const t = e['text'];
      if (typeof t === 'string') streamed += t;
    } else if (type === 'status') {
      const u = e['usage'];
      if (u && typeof u === 'object') {
        const parsed = u as TokenUsage;
        // 收尾那一次的输入就是上下文规模；同样要含缓存命中部分
        usage = {
          ...parsed,
          contextTokens: (parsed.inputTokens ?? 0) + (parsed.cacheReadTokens ?? 0),
        };
      }
    }
  }

  return { sessionId, final, streamed, usage };
}

/**
 * 主会话一轮的相位。`askSdk` 的 `finally` 只按它归位：
 * `session/prompt` 抛错时不能把 `onIdle` 留在槽上，否则 `isBusy()` 永远为真。
 *
 * - `idle`：没有在等的主轮，也没有放手后还在跑的委派轮
 * - `prompting_rpc`：正在等 `session/prompt` 的响应
 * - `awaiting_idle`：prompt 已被接受，在等这条主会话的 `idle`
 * - `detached_running`：调用方已经放手，dsh 那一轮还在跑
 */
export type DshTurnPhase = 'idle' | 'prompting_rpc' | 'awaiting_idle' | 'detached_running';

export class DshSession {
  private readonly program: string;
  private readonly workDir: string;
  private readonly sessionFile: string;
  private readonly timeoutMs: number;
  private readonly patch?: string;
  private readonly log: (line: string) => void;
  private readonly mode: 'headless' | 'sdk';
  private readonly provider: string;
  private readonly model: string;

  // ---------------------------------------------------------------- sdk 常驻态
  private proc: ChildProcess | null = null;
  /**
   * 常驻进程的代次。每次 spawn 加一。
   *
   * `close` / `error` / `stop()` 的 2s 强杀都抓住自己那一代：旧进程晚到的退出
   * 不能 reject 新进程的 pending，也不能写新进程的 `exitError`，更不能把新进程杀掉。
   */
  private procGen = 0;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** 最近一条 assistant/message 的文本；多 step 时后者覆盖前者 */
  private assistantText = '';
  /** 本轮开始的时刻（wall clock），算首个 token 耗时用 */
  private turnStartedAt = 0;
  /** 本轮首个 token 的耗时；`null` = 还没收到 */
  private firstTokenMs: number | null = null;
  /**
   * 本轮各 step 的用量累加。
   *
   * `assistant/message` 自带 `usage`（协议原话：模型输出与它的记账一起走，
   * 没有单独的 usage 记录）。以前这里只取了 message、把同级的 usage 丢了，
   * 结果 SDK 模式永远打 `tokens=?/?` —— 刚配的压缩阈值等于没有仪表。
   */
  private turnUsage: TokenUsage | null = null;
  /** turn 结束（agent 整体 idle）时触发 */
  private onIdle: (() => void) | null = null;
  private sdkReady = false;
  /** 宿主运行时认不认 `session/cancel`（`null` = 还没探过） */
  private cancelSupported: boolean | null = null;
  /** 宿主运行时认不认 `session/fork`（`null` = 还没探过） */
  private rollbackSupported: boolean | null = null;
  /** 撤回切点的账本：入箱 seq − 1，且按票据认领（见 `RollbackLedger`） */
  private readonly rollback = new RollbackLedger();
  /** 最近一次撤回的结果（给「补上下文」决定措辞用，取一次就清） */
  private rollbackOutcome: 'ok' | 'failed' | null = null;
  /** 在途的握手指令（并发 `ask` 必须等同一个，不能各自起进程） */
  private readonly handshaking = new SingleFlight<void>();
  /** 当前在途那一轮的票据（`null` = 还没开始 / 已经结束）；取消时按它丢过期票据 */
  private activeTicket: TurnTicket | null = null;
  /** 主轮相位。`isBusy()` 只看它，不再靠「`onIdle` 有没有被清掉」来猜。 */
  private turnPhase: DshTurnPhase = 'idle';
  /** 轮次串行队列的尾巴（`ask` 排队用，见 `ask` 的注释） */
  private turns: Promise<void> = Promise.resolve();
  /** 当前在途那一轮是不是**被我们主动取消**的（是的话收成空答复，不抛错） */
  private cancelRequested = false;
  /**
   * 当前在途那一轮被**放手**了（见 `detachTurn`）：`ask` 立刻收尾，但 dsh 那一轮
   * 还在跑，答完之后没有等待者 —— 由 `onAnnounce` 播出去。
   */
  private detached = false;
  /**
   * 放手那一轮的答复文本（独立一份：新一轮开起来会清 `assistantText`）
   */
  private detachedText = '';
  /** 放手那一轮的用户原话（回注记忆要成对，见 `onDetachedAnswer`） */
  private detachedUserText = '';
  /** 正在跑的那一轮的用户原话（`detachTurn` 时抄进 `detachedUserText`） */
  private activeUserText = '';
  /**
   * 轮号：`turn/start` / `turn/end` 的 `data.turn`（dsh 自己发的单调递增整数）。
   *
   * **不用 idle 计数认领轮次**：`session.status` 只有 `{sessionId, status}`，没有轮号；
   * 而「发了几条 prompt / 收了几条 idle」只要错一格（排队的 prompt 被 `outcome:canceled`
   * 取消时就不会有 turn、也就没有 idle），后面每一轮的答案都会交给错的人。
   * `turn/start` / `turn/end` 是**逐轮**事件，轮号对得上才结算。
   */
  private currentTurn: number | null = null;
  /** 放手那一轮要认领的轮号（`null` = 放手时还没有 turn/start，下一次 turn/end 就是它） */
  private detachedTurn: number | null = null;
  /**
   * 上一轮残留尾巴的吞噬相位（仅用于主会话串行边界，`idle` 不带轮号只能靠显式相位区分）：
   * - `'none'`：没有上一轮未收尾的尾巴
   * - `'awaiting_old_idle'`：旧轮的 `turn/start` 已过（放手轮已 `turn/end`，或自发轮已 `turn/start`），
   *   只剩旧轮的一条 `status=idle` 待吞；一旦新的 `turn/start` 来了说明旧 `idle` 没发，直接归 `'none'`
   * - `'awaiting_old_turn_start'`：自发轮只到了 `status=running`，它自己的 `turn/start` 还在管道里；
   *   先吃掉那条旧 `turn/start` 转入 `'awaiting_old_idle'`，绝不能被旧 `turn/start` 提前解除 `idle` 保护
   */
  private tailSwallow: 'none' | 'awaiting_old_turn_start' | 'awaiting_old_idle' = 'none';
  /**
   * 后台作业 / 子代理的实时状态。喂的是 dsh 自己发的事件，**不额外发请求** ——
   * 快车道要「报进度」时读它，而不是再问 dsh 一轮（那要 690 ms 外加一条会话历史）。
   */
  private readonly tasks = new TaskBoard(() => this.openSessionId);
  /**
   * 进程是不是在「一轮还没走完」时退出的。
   *
   * `close` 里必须把在途那一轮唤醒（它等的是 `idle`，不是 RPC），否则进程轰了
   * 之后 `ask` 还要干等满 60 s。唤醒之后靠这个字段把真实原因抛出去。
   */
  private exitError: string | null = null;
  /**
   * 后台任务完成后**自发**产生的汇报文本（不属于任何一轮）。
   *
   * dsh 的后台作业结算后会自己开一轮说结果（没有 `session/prompt`），这条回调
   * 就是接住它的唯一入口 —— 不接就是静默丢弃。
   */
  onAnnounce: ((text: string) => void) | null = null;
  /**
   * 放手那一轮的答案回来了 —— **无论用户是不是已经问了新问题**都要回注记忆。
   *
   * 与 `onAnnounce` 分工：`onAnnounce` 是"播出去"（用户已经在问新问题时不该补播，
   * 会打断他），这条是"记下来"。委派轮被打断之后，dsh 的活儿照样跑完了，答案就在
   * 会话里；不记的话用户之后提起这件事，快车道和 omni 都当没发生过。
   */
  onDetachedAnswer:
    | ((userText: string, answer: string, spoken: boolean) => void)
    | null = null;
  /**
   * 流式文本（侧通道）。三个事件：`start` 交出前 N 个 token、`delta` 逐 token 直通、
   * `end` 这条流结束。**没到阈值的整段也走 start+end**，调用方据 `gate.streaming`
   * 之外的信息无法区分，所以这里只保证"能按顺序捡到全部文本"。
   */
  onLive: ((event: LiveEvent) => void) | null = null;

  /**
   * 逐句合成的订阅口：每来一个 token 增量就调一次。
   *
   * 与 {@link onLive} 的区别：那个带着 20 token 门槛（短答整段给），是给日志/播报
   * 判断用的；这个是**原始增量**，供 `SentencePump` 断句送 TTS。
   */
  onLiveSink: ((text: string) => void) | null = null;

  /** 侧通道增量计数（诊断用：首增量何时到、共几段） */
  liveSinkCount = 0;
  /** 侧通道收到/丢弃计数（诊断：区分「没发」和「被 sessionId 挡了」） */
  liveMsgCount = 0;
  liveDropCount = 0;
  /** 侧通道接收端；懒启动 */
  private liveRelay: LiveTextRelay | null = null;
  /**
   * 侧通道端口；拉起 dsh 子进程时以 `VOICE_LIVE_PORT` 塞进**它自己的**环境。
   *
   * 为什么不是 `process.env['VOICE_LIVE_PORT']`：那是整个宿主进程的全局状态，
   * 同一进程里起两个会话（或测试并行跑）会互相覆盖，dsh 之外的东西也读得到。
   * 环境变量的作用域应当只是「这一个子进程」。
   */
  private liveRelayPort: number | null = null;
  private readonly liveThreshold: number;
  private liveGate: LiveGate;
  /**
   * 自发轮次的判定：只在 prompt 期间挂 `onIdle`，所以那种轮次必须单独识别
   * （见 `spontaneous.ts` 的实测记录）。
   */
  private readonly spontaneous = new SpontaneousTurn();
  /**
   * 本进程内已经打开（resume 过或创建过）的会话 id。
   *
   * SDK 对已在当前进程打开的会话再发 `session/resume` 会报
   * "SDK session is already open or opening"。所以同一个 id 只能 resume 一次，
   * 后续轮次直接 prompt —— 会话本来就在这个常驻进程里活着。
   */
  private openSessionId: string | null = null;

  constructor(opts: SessionOptions) {
    this.program = opts.program ?? process.env['DSH_BIN'] ?? 'dsh';
    this.workDir = opts.workDir;
    this.patch = opts.patch;
    // 空串当没给：`VOICE_AGENT_SESSION=` 这种写法不该落成「相对路径 ''」
    const fromEnv = process.env['VOICE_AGENT_SESSION']?.trim();
    this.sessionFile = opts.sessionFile
      ?? (fromEnv ? fromEnv : join(homedir(), '.voice-agent', 'session.json'));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
    this.mode = opts.mode ?? 'headless';
    this.provider = opts.provider ?? 'deepseek-official';
    this.model = opts.model ?? 'deepseek-flash';
    this.liveThreshold = opts.liveTokenThreshold ?? LIVE_TOKEN_THRESHOLD;
    this.liveGate = new LiveGate(this.liveThreshold);
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    // spawn 的 cwd 必须存在，否则 ENOENT，且报错信息指向不明确
    mkdirSync(this.workDir, { recursive: true });
  }

  /** 当前记录的会话 id，没有就是 null。 */
  get currentSessionId(): string | null {
    return this.readSession();
  }

  /** 主动丢弃会话，下次 ask 会开新的。 */
  reset(): void {
    // 换会话了：账本里的 seq 和待撤回的切点都属于旧会话，一起丢掉
    this.rollback.reset();
    try {
      if (existsSync(this.sessionFile)) writeFileSync(this.sessionFile, '{}');
    } catch {
      // 写不进去也不影响下次调用：readSession 失败就当没有
    }
  }

  /**
   * 问一次。沿用已记录的会话；失败则清空记录重开一次。
   *
   * 只有"带着存量 id"才会多试一次；全新会话失败就直接抛，
   * 避免把真实错误（比如缺 API key）当成会话失效反复重试。
   *
   * **串行**：`askSdk` 只用一个 `onIdle` 槽等 turn 结束，两轮重叠时后一轮会把
   * 前一轮的等待者顶掉（前一轮永远不结束，后一轮等不到自己的 idle，一起挂到 60 s）。
   * 编排层本来也是一轮一轮来，但投机/取消失败时慢车道那一轮可能还在跑 —— 这里排个队，
   * 把「重叠」降级成「等一会儿」。
   */
  async ask(text: string, image?: ImageAttachment, turn?: { readonly ticket: TurnTicket }): Promise<AskResult> {
    const ticket = turn?.ticket;
    const run = this.turns.then(
      () => this.askOnce(text, image, ticket),
      () => this.askOnce(text, image, ticket),
    );
    this.turns = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async askOnce(text: string, image?: ImageAttachment, ticket?: TurnTicket): Promise<AskResult> {
    if (this.mode === 'sdk') return await this.askSdk(text, image, ticket);
    if (image) {
      throw new DshError('headless 模式的 stdin 只收纯文本，带图片请用 --dsh-sdk');
    }

    const stored = this.readSession();
    if (stored) {
      try {
        return await this.run(text, stored);
      } catch (e) {
        this.log(`会话 ${stored} 失败，改开新会话：${(e as Error).message}`);
        this.reset();
      }
    }
    return await this.run(text, null);
  }

  /**
   * 取消当前在途的一轮。**宿主侧能力** —— SDK 封装里没暴露，但协议里有：
   * `session/cancel { sessionId } → { accepted }`，语义是「把取消请求交给活着的 Agent」。
   * 没有在途提示词时它去取消自主工作，未知会话 id 是空操作，所以调用前自己确认真有在途。
   *
   * 用处：投机双轨 / 插话之后，慢车道那一轮的结果已经没人要了 —— 取消掉既省一次
   * 调用的钱，也不会在会话历史里留下一条「用户没听过的回答」。
   *
   * 取消之后 dsh 自己会发 idle，但为防它不发，这里兜一个短定时器：超时就替等待者
   * 收尾，免得 `ask` 一路挂到 60 s 超时。
   */
  cancelTurn(ticket?: TurnTicket): void {
    const sessionId = this.openSessionId ?? this.readSession();
    const waiter = this.onIdle;
    // 放手的委派轮没有等待者，但它**还在跑** —— 那里也要能取消（用户显式下令取消）
    if (this.proc === null || sessionId === null || (waiter === null && !this.detached)) {
      return;
    }
    // **有票据就必须对上当前在途轮**。`activeTicket === null`（这一轮已经收尾，
    // 或还没臂上）也直接丢掉 —— 过期票据不能在「没人认领」的窗口里放行。
    // 不带票据的是显式人工取消，仍然放行。
    if (ticket !== undefined && !this.ticketMatches(ticket)) {
      this.log(`  取消    票据过期（#${ticket.no}/${ticket.gen}）→ 丢弃`);
      return;
    }
    // 取消是**故意的**：被取消的那一轮不该以异常收场（上层根本没法处理「用户不要了」
    // 这种事，抛出去只会变成一条未捕获的 rejection，把整个进程带走）
    this.cancelRequested = true;
    if (this.cancelSupported === false) {
      // 补丁没打（比如 dsh 刚升级过）。不假装成功，也不硬 SIGINT 杀进程 —— 只等它自己说完
      this.log('  取消    ✗ 宿主没有 session/cancel，这一轮取消不了');
    } else {
      void this.rpc('session/cancel', { sessionId }).then(
        () => {
          this.cancelSupported = true;
          this.log(`  取消    已请求取消 ${sessionId} 的在途一轮`);
        },
        (e: Error) => { this.log(`  取消    ✗ ${e.message}`); },
      );
    }
    setTimeout(() => {
      if (waiter !== null && this.onIdle === waiter) {
        this.onIdle = null;
        waiter();
      }
    }, CANCEL_GRACE_MS).unref?.();
    // 放手那一轮被取消：它不会再结算了，把等着回注的那份也一起清掉 ——
    // 用户说了"不要了"，答案就不该再回注记忆
    if (this.detached) {
      this.detached = false;
      this.detachedTurn = null;
      this.detachedText = '';
      this.detachedUserText = '';
      if (this.turnPhase === 'detached_running') {
        this.turnPhase = 'idle';
      }
      this.log('  取消    放手的委派轮也一起取消（用户显式说了不要）');
    }
  }

  /**
   * 传入的票据是不是「当前正在臂上的那一轮」。
   *
   * `activeTicket === null` 时一律不是：轮次已经收尾（或还没写上票据），
   * 过期票据不能靠这个空窗放行。
   */
  private ticketMatches(ticket: TurnTicket): boolean {
    const active = this.activeTicket;
    return active !== null && ticket.no === active.no && ticket.gen === active.gen;
  }

  /**
   * dsh 那边有没有在跑的活儿（含**放手的**委派轮）。
   *
   * 用户说「算了 / 别查了」时要据此决定是否真的发取消 —— 没有在跑的东西，那就是
   * 一句普通闲聊，别去打扰 dsh。
   *
   * 只看相位：`prompting_rpc` / `awaiting_idle` / `detached_running` 才算忙。
   * `session/prompt` 抛错时 `finally` 会把相位归回 `idle`，不会永锁。
   */
  isBusy(): boolean {
    return this.proc !== null && this.turnPhase !== 'idle';
  }

  /**
   * 硬中断：`SIGINT` 给 dsh 子进程（等同 TUI 里 Ctrl-C）。
   *
   * **会杀掉进程**（实测 exit code=130），下一轮要重启并 resume，实测多花 ~2 s
   * （正常一轮 800–1300 ms）。所以只在「这一轮肯定不要了、且短时间内不会再问」
   * 时才划算 —— 调用方自己判断，默认不用。
   */
  interruptTurn(): void {
    const proc = this.proc;
    if (proc === null) {
      return;
    }
    this.log('  取消    SIGINT（进程会退出，下一轮要重启）');
    try {
      proc.kill('SIGINT');
    } catch {
      // 已经退了
    }
  }

  /**
   * 放手：**不取消** dsh 那一轮，只把「有人在等它」摘掉。
   *
   * 为什么不是取消：`session/cancel` 只作废下游输出，**上游的活儿照跑**（真机实测
   * 05:08:50 取消之后 2 s，`bash「nproc; free -h」` 才刚结束）—— 所以取消省下的是
   * 最后那一步总结，丢掉的却是用户唯一能听到的答案。之后用户还得把问题重问一遍。
   *
   * 放手之后：`ask` 立刻收成空答复（这一轮已经作废了，没人要），dsh 继续跑完；
   * 回来的那条 `assistant/message` 记在 {@link detachedText}，`idle` 时交给
   * `onAnnounce` —— 与「后台任务结算」同一口播报，用户照样能听到答案。
   *
   * 票据按代次校验，规则与 `cancelTurn` 一致：迟到的放手不能摘掉下一轮的等待者。
   * 带了票据而 `activeTicket === null` 时同样丢掉，不能把「已经没人等」当成放行。
   */
  detachTurn(ticket?: TurnTicket): void {
    if (this.proc === null) {
      return;
    }
    if (ticket !== undefined && !this.ticketMatches(ticket)) {
      this.log(`  放手    票据过期（#${ticket.no}/${ticket.gen}）→ 丢弃`);
      return;
    }
    this.detached = true;
    this.detachedTurn = this.currentTurn;
    this.detachedText = this.assistantText.trim();
    this.detachedUserText = this.activeUserText;
    if (this.detachedTurn === null) {
      // 还没收到 turn/start：下一次 turn/end 就是它的（dsh 串行，不会有别人的）
      this.log('  放手    放手的时刻还没开轮 → 认下一次 turn/end');
    }
    // `ask` 的等待者立刻收尾：这一轮已经作废，别让它挂到超时
    const fire = this.onIdle;
    this.onIdle = null;
    fire?.();
  }

  /**
   * 认轮次边界：`turn/start` 记住当前轮号，`turn/end` 到达时看是不是「放手」那一轮。
   *
   * 这与「等 idle」不等价：`turn/end` 是逐轮事件、带轮号，而 `idle` 不带任何标识。
   * 放手的一轮跑完时在这里结算（播报或丢弃），`idle` 则照旧只负责唤醒 prompt 的
   * 等待者 —— 两条互不干扰，也就不会出现「上一轮的答案交给新一轮」。
   */
  private observeTurnBoundary(e: Record<string, unknown>, sessionId: string): void {
    const type = typeof e['type'] === 'string' ? e['type'] : '';
    if (type !== 'turn/start' && type !== 'turn/end') {
      return;
    }
    if (!this.isMainSession(sessionId)) {
      return;
    }
    const data = e['data'] as Record<string, unknown> | undefined;
    const turn = typeof data?.['turn'] === 'number' ? data['turn'] : null;
    if (type === 'turn/start') {
      this.currentTurn = turn;
      if (this.tailSwallow === 'awaiting_old_turn_start') {
        // 这是被顶掉的旧自发轮自己的 turn/start，它的 idle 还在后面，不能现在解除保护
        this.tailSwallow = 'awaiting_old_idle';
      } else if (this.tailSwallow === 'awaiting_old_idle') {
        // 新一轮开起来了：上一轮那条 idle 要么已经来过、要么不会来了
        this.tailSwallow = 'none';
      }
      return;
    }
    // turn/end
    const settles = this.detached
      && (this.detachedTurn === null || this.detachedTurn === turn);
    this.currentTurn = null;
    if (!settles) {
      return;
    }
    this.detached = false;
    this.detachedTurn = null;
    // 新一轮如果已经臂上（`prompting_rpc` / `awaiting_idle`），别把它的相位打回 idle。
    if (this.turnPhase === 'detached_running') {
      this.turnPhase = 'idle';
    }
    // 同一轮的 idle 紧跟着就来，它属于这一轮（不是新一轮的）
    this.tailSwallow = 'awaiting_old_idle';
    const text = (this.detachedText || this.assistantText).trim();
    this.detachedText = '';
    this.assistantText = '';
    if (text === '') {
      this.detachedUserText = '';
      return;
    }
    // 回注记忆**先于**「要不要补播」这个判断：答案是真的，用户听没听到是另一回事
    const userText = this.detachedUserText;
    this.detachedUserText = '';
    // `onIdle === null` 表示没有新一轮在等 → 下面会走播报，用户能听到
    const willSpeak = this.onIdle === null && this.onAnnounce !== null;
    try {
      this.onDetachedAnswer?.(userText, text, willSpeak);
    } catch (error) {
      this.log(`  放手    ✗ 回注失败：${(error as Error).message}`);
    }
    // 用户已经问了新问题时旧答案直接丢掉，别补播一次他不想听的
    if (this.onIdle !== null) {
      this.log('  放手    答案回来时用户已经问了新问题 → 不补播（已回注记忆）');
      return;
    }
    if (this.onAnnounce) {
      const reason = data?.['reason'] as Record<string, unknown> | undefined;
      const kind = typeof reason?.['kind'] === 'string' ? reason['kind'] : '';
      this.log(`  放手    委派轮跑完了${kind === '' ? '' : `（${kind}）`} → 答案转成播报`);
      this.onAnnounce(text);
    }
  }

  /**
   * 启动时探测：宿主运行时认不认 `session/cancel`。
   *
   * 顺手把 SDK 握手拉起来（第一次探测本来就要 initialize），之后首轮会快一点。
   * **探测失败一律当"不支持"**：拿不到答案时保守退回串行，比在投机里赌一把安全。
   *
   * @param timeoutMs 最多等多久；超时按不支持处理
   */
  async probeCancelSupport(timeoutMs = 20_000): Promise<boolean> {
    const probe = (async (): Promise<boolean> => {
      try {
        await this.ensureSdk();
      } catch (error) {
        this.log(`  取消    探测失败：${(error as Error).message}`);
        return false;
      }
      return this.cancelSupported === true;
    })();
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs).unref?.();
    });
    return await Promise.race([probe, timeout]);
  }

  /**
   * 后台作业状态的一句话事实（给快车道照实说）。
   *
   * 返回的永远是完整句子，例如「后台任务：现在没有在跑的；刚结束 bash「sleep 20」（3 秒前）。」
   */
  taskStatus(): string {
    return this.tasks.describe();
  }

  /** 关掉常驻进程（有的话）。headless 模式无副作用。 */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    const myGen = this.procGen;
    this.proc = null;
    this.sdkReady = false;
    this.openSessionId = null;
    this.turnPhase = 'idle';
    try {
      proc.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: {} })}\n`,
      );
    } catch {
      // 已经退了
    }
    // 给 shutdown 一点时间优雅退出，超时就强杀。
    // 代次已经往前走（新的 spawn 起来了）就绝不能再杀：定时器抓住的是这一代。
    setTimeout(() => {
      if (myGen !== this.procGen) return;
      try {
        proc.kill();
      } catch {
        // 已经退了
      }
    }, 2000).unref?.();
  }

  // ---------------------------------------------------------------- sdk 常驻
  /**
   * 一轮对话：`session/prompt` 入队，等 `session.status=idle` 收尾。
   *
   * 注意 SDK 协议里没有「最终回答」这种事件：`session/prompt` 只回一个
   * messageId，内容全靠 `session.event` 推。所以这里取**最后一条**
   * `assistant/message` 的 text 块 —— 多 step 时前面的都是中间过程。
   */
  private async askSdk(text: string, image?: ImageAttachment, ticket?: TurnTicket): Promise<AskResult> {
    await this.ensureSdk();

    const started = Date.now();
    const stored = this.readSession();
    let sessionId = stored ?? `session-${randomUUID()}`;
    let resumed = stored !== null;
    if (!resumed) this.saveSession(sessionId);

    // 已持久化的会话必须先 resume。SDK 的 session/prompt 只对**未知** id
    // 懒创建；对已存在的 id 直接 prompt 会报 "session ... already exists"（实测）。
    // 但 resume 只在本进程内做一次：会话已经活着时再 resume 会报
    // "SDK session is already open or opening"。
    if (resumed && this.openSessionId !== sessionId) {
      try {
        await this.rpc('session/resume', { sessionId });
        this.openSessionId = sessionId;
      } catch (e) {
        this.log(`恢复 ${sessionId} 失败，改开新会话：${(e as Error).message}`);
        sessionId = `session-${randomUUID()}`;
        resumed = false;
        this.saveSession(sessionId);
        this.openSessionId = sessionId;
      }
    } else if (!resumed) {
      this.openSessionId = sessionId;
    }

    // 上一轮如果被快车道抢了、而 dsh 已经答完：这里先把那一轮从历史里切掉
    // （`session/fork` 换指针，上层不感知）。失败不影响这一轮。
    sessionId = await this.applyRollback(sessionId);

    this.assistantText = '';
    this.turnUsage = null;
    this.turnStartedAt = started;
    this.firstTokenMs = null;
    this.exitError = null;
    // 自发轮还没收尾时，它的 idle 不带轮号。先按是否已收到旧 turn/start 切入吞尾相位，
    // 免得旧自发轮的 turn/start 或 idle 提前把本轮等待者叫醒。
    // 放在臂 `onIdle` 之前、且中间没有 await：idle 不可能插进这个窗口。
    if (this.spontaneous.isActive) {
      this.tailSwallow = this.currentTurn === null
        ? 'awaiting_old_turn_start'
        : 'awaiting_old_idle';
    }
    // 接下来这一轮的 idle 归 prompt 等待者，不算自发轮次
    this.spontaneous.reset();

    // 从写票据 / 等待者 / 相位之前就进 try：`session/prompt` 抛错也要走 finally，
    // 否则 `onIdle` 留下，`isBusy()` 永远为真。
    let timer: NodeJS.Timeout | undefined;
    try {
      this.turnPhase = 'prompting_rpc';
      this.activeTicket = ticket ?? null;
      this.activeUserText = text;
      this.cancelRequested = false;
      const idle = new Promise<void>((resolve) => { this.onIdle = resolve; });

      await this.rpc('session/prompt', {
        sessionId,
        contentBlocks: image
          ? [
              { type: 'text', text },
              { type: 'image', mimeType: image.mimeType, data: image.data },
            ]
          : [{ type: 'text', text }],
      });

      this.turnPhase = 'awaiting_idle';
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DshError(`等待 turn 结束超时（${this.timeoutMs} ms）`)),
          this.timeoutMs,
        );
      });
      await Promise.race([idle, timeout]);
    } finally {
      clearTimeout(timer);
      this.onIdle = null;
      this.activeTicket = null;
      this.turnPhase = this.detached ? 'detached_running' : 'idle';
    }

    const answer = this.assistantText.trim();
    const cancelled = this.cancelRequested;
    const detached = this.detached;
    this.cancelRequested = false;
    if (this.exitError !== null) {
      const reason = this.exitError;
      this.exitError = null;
      throw new DshError(reason);
    }
    // 被我们主动取消的那一轮：正常收尾成空答复，**不能抛** —— 上层没人在等一个
    // 「用户不要了」的异常，抛出去就是未捕获的 rejection（实测把 bench harness 打死）。
    // 放手的那一轮同理：它还在跑，只是这一轮不再等它（答案之后从播报口出来）。
    if (!answer && !cancelled && !detached) throw new DshError('sdk 没有返回任何文本');

    return {
      text: answer,
      sessionId,
      usage: this.turnUsage,
      durationMs: Date.now() - started,
      resumed,
      ...(this.firstTokenMs === null ? {} : { firstTokenMs: this.firstTokenMs }),
      ...(detached ? { detached: true } : {}),
    };
  }

  /**
   * 撤回上一轮：慢车道那一轮**已经答完**（取消来不及）、但用户听到的是快车道的答案。
   *
   * dsh 的会话日志是 append-only，没有「回退事件」（全量事件词表里没有，见
   * `dsh-session/known-event-types.js`），唯一能让历史变短的公开原语是
   * `session/fork`：从某个 seq 切一段前缀，长出一个新会话。这里**换指针**，
   * 上层和用户都不感知 —— 效果就是「单会话内原子撤回」。
   *
   * 切点用本轮 `turn/start` 之前那条入箱事件的 seq − 1。不能取 `turn/start − 1`：
   * 那一格正是入箱事件本身，复制过去之后新会话会把它当待办**重放一遍**。
   *
   * 只记账不动手：真正的 fork 在下一轮 `askSdk` 发 prompt 之前做（不占热路径，
   * 也避免和正在跑的轮次交叉）。连续多轮取最早切点，一次 fork 全退掉。
   */
  rollbackTurn(ticket?: TurnTicket): void {
    if (this.mode !== 'sdk') {
      return;
    }
    if (!this.rollback.claim(ticket)) {
      return;
    }
    this.log(`  回溯    记下切点 seq=${this.rollback.peek()}（开轮前撤回）`);
    // 现在没人在跑的话立刻做：fork 只要几十毫秒，做完「补上下文」那边才知道
    // 该怎么措辞（成功 = 那轮没发生过 / 失败 = 用户没听到你的回答）。
    void this.tryRollbackNow();
  }

  /** 空闲时立刻撤回；有轮次在飞就留给下一轮 `askSdk`（不交叉）。 */
  private async tryRollbackNow(): Promise<void> {
    if (!this.sdkReady || this.activeTicket !== null || this.openSessionId === null) {
      return;
    }
    if (this.rollback.peek() === null) {
      return;
    }
    await this.applyRollback(this.openSessionId);
  }

  /**
   * 上次撤回的结果：`ok` 成功 / `failed` 没做成 / `none` 没撤过。**取一次就清**，
   * 免得一条旧结果影响很久以后那轮的措辞。
   */
  takeRollbackOutcome(): 'ok' | 'failed' | 'none' {
    const outcome = this.rollbackOutcome;
    this.rollbackOutcome = null;
    return outcome ?? 'none';
  }

  /**
   * 把待撤回的那一轮切掉，返回**接下来该用的** session id。
   *
   * 失败不抛：撤回是"锦上添花"，失败就照旧续在原会话上（历史里多一条幽灵轮，
   * 但用户听到的东西不受影响）。
   */
  private async applyRollback(sessionId: string): Promise<string> {
    const cut = this.rollback.take();
    if (cut === null) {
      return sessionId;
    }
    if (this.rollbackSupported === false) {
      this.rollbackOutcome = 'failed';
      this.log('  回溯    ✗ 宿主运行时没有 session/fork —— 跑一次 scripts/patch-sdk-fork.mjs');
      return sessionId;
    }
    try {
      const startedAt = Date.now();
      const result = await this.rpc('session/fork', { sessionId, atSeq: cut }, FORK_TIMEOUT_MS) as { sessionId?: unknown };
      const child = typeof result?.sessionId === 'string' ? result.sessionId : '';
      if (child === '') {
        throw new DshError('session/fork 没有返回新会话 id');
      }
      this.rollbackSupported = true;
      this.rollbackOutcome = 'ok';
      this.openSessionId = child;
      this.saveSession(child);
      // 账本里的 seq 属于旧会话，留着下次会拿无效切点去 fork 新会话
      this.rollback.reset();
      this.retireSession(sessionId);
      this.log(`  回溯    已撤回上一轮（切点 seq=${cut}，${Date.now() - startedAt} ms）→ ${child}`);
      return child;
    } catch (error) {
      this.rollbackOutcome = 'failed';
      this.log(`  回溯    ✗ ${(error as Error).message}`);
      return sessionId;
    }
  }

  /** dsh 的会话根（`~/.dsh/sessions`），透明化后的原会话就躺在它下面 */
  private get sessionsRoot(): string {
    return join(homedir(), '.dsh', 'sessions');
  }

  /** 「被透明化掉的会话」清单，和工作目录/会话指针放在一起 */
  private get supersededFile(): string {
    return join(dirname(this.sessionFile), 'superseded.jsonl');
  }

  /**
   * 把被替换掉的会话登记进清单，顺手做一次过期清理。
   *
   * 为什么要归档而不是立刻删：fork 之后旧会话**还在磁盘上**（我们只是不再引用它），
   * 万一切点或 fork 出了问题，它是唯一能回看的现场。留 7 天，然后连目录一起删。
   *
   * 不做定时器：清理挂在「启动时」和「每次 fork 之后」这两个本来就会发生的事件上，
   * 少一个进程、少一份状态。代价是常年不重启又从不 fork 的机器不会清 —— 但那种机器
   * 也不会产生新的待清理项。
   */
  private retireSession(oldId: string): void {
    try {
      const dir = this.findSessionDir(oldId);
      if (dir === null) {
        return;
      }
      mkdirSync(dirname(this.supersededFile), { recursive: true });
      appendFileSync(
        this.supersededFile,
        `${JSON.stringify({ id: oldId, at: Date.now(), dir } satisfies SupersededEntry)}\n`,
      );
      this.collectSuperseded();
    } catch (error) {
      // 清理是后台卫生，坏了不该影响对话
      this.log(`  回溯    清理登记失败：${(error as Error).message}`);
    }
  }

  /** 在 `<sessionsRoot>/<workspace>/<id>` 里找那一层目录；找不到就算了 */
  private findSessionDir(id: string): string | null {
    const root = this.sessionsRoot;
    let spaces: string[];
    try {
      spaces = readdirSync(root);
    } catch {
      return null;
    }
    for (const space of spaces) {
      const dir = join(root, space, id);
      if (existsSync(dir)) {
        return dir;
      }
    }
    return null;
  }

  /** 删掉超过 7 天的透明化会话（只在启动与 fork 之后跑） */
  private collectSuperseded(): void {
    let raw: string;
    try {
      raw = readFileSync(this.supersededFile, 'utf8');
    } catch {
      return;
    }
    const entries = raw.split('\n').filter((line) => line.trim() !== '').map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return null; }
    });
    const { drop, keep, bad } = splitSuperseded(entries, Date.now(), this.sessionsRoot);
    for (const entry of drop) {
      if (entry.id === this.openSessionId) {
        continue; // 双保险：正在用的绝不删
      }
      try {
        rmSync(entry.dir, { recursive: true, force: true });
        this.log(`  回溯    清理旧会话 ${entry.id}（透明化于 ${new Date(entry.at).toISOString()}）`);
      } catch (error) {
        keep.push(entry);
        this.log(`  回溯    ✗ 清理 ${entry.id} 失败：${(error as Error).message}`);
      }
    }
    try {
      writeFileSync(
        this.supersededFile,
        keep.map((e) => `${JSON.stringify(e)}\n`).join(''),
      );
    } catch {
      // 写不进去就下次再试
    }
    if (bad > 0) {
      this.log(`  回溯    清单里有 ${bad} 条坏记录，已丢弃`);
    }
  }

  /** 懒启动常驻进程并握手。崩溃后下次调用会自动重启。 */
  private async ensureSdk(): Promise<void> {
    if (this.proc && this.sdkReady) return;
    // 握手是异步的（spawn + initialize 约 2 s）。这期间又有 `ask` 进来时必须**等它**，
    // 不能把刚起的进程 stop 掉 —— 投机会让这个窗口真实存在：快车道那一轮先起了 dsh，
    // 用户第二句话在 initialize 还没回来时就到，原来会把进程连同在途握手一起杀掉
    // （现象：`sdk 进程退出（code=0）`，那一轮直接失败）。
    await this.handshaking.run(() => this.handshake());
  }

  private async handshake(): Promise<void> {
    // 走到这里说明没有可用的 SDK 进程；残留的（崩过一半的）先收掉
    if (this.proc) this.stop();
    // 流式侧通道要在 spawn **之前**就绪：端口靠 `VOICE_LIVE_PORT` 传给子进程，
    // dsh 里的 `voice-live` 插件启动时读它，读不到就整个不启用。
    await this.ensureLiveRelay();

    // 每次 spawn 加一代。close / error 抓住的是这一代，不是「当前这个字段」。
    this.procGen += 1;
    const myGen = this.procGen;
    const proc = this.spawnProgram([
      '--profile', 'sdk',
      ...(this.patch ? ['--patch', this.patch] : []),
    ]);
    this.proc = proc;

    proc.stdout?.on('data', (d: Buffer) => { this.handleData(d); });
    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      // SDK profile 把诊断写 stderr，stdout 专用于协议帧
      if (s) this.log(`[sdk] ${s.slice(0, 200)}`);
    });
    proc.on('error', (e: Error) => {
      if (myGen !== this.procGen) return;
      this.log(`[sdk] 启动失败：${e.message}`);
      this.sdkReady = false;
      if (this.proc === proc) this.proc = null;
    });
    proc.on('close', (code: number | null) => {
      if (myGen !== this.procGen) return;
      this.sdkReady = false;
      // 进程没了，里面的会话也就不在了；下次必须重新 resume
      this.openSessionId = null;
      // 放手状态一起归零：进程都没了，那一轮的 turn/end 再也不会来
      this.detached = false;
      this.detachedText = '';
      this.detachedTurn = null;
      this.currentTurn = null;
      this.tailSwallow = 'none';
      this.turnPhase = 'idle';
      this.activeTicket = null;
      if (this.proc === proc) this.proc = null;
      // 没收到 shutdown 就退出，说明崩了；挂起的请求全部失败
      for (const [, p] of this.pending) p.reject(new DshError(`sdk 进程退出（code=${code}）`));
      this.pending.clear();
      // **在途那一轮也要收敛**：`close` 只 reject 了 RPC，而一轮真正等的是
      // `session.status=idle`。不唤醒它，进程轰了之后 `ask` 还会干等满 60 s
      // （实测 SIGINT 杀掉后挂了 62302 ms）。
      this.exitError = `sdk 进程退出（code=${code}）`;
      const waiter = this.onIdle;
      if (waiter !== null) {
        this.onIdle = null;
        waiter();
      }
      this.log(`[sdk] 进程退出 code=${code}`);
    });

    // 首次握手要加载 profile 与工具树，比普通请求慢，单独放宽
    await this.rpc('initialize', {
      cwd: this.workDir,
      provider: this.provider,
      model: this.model,
    }, 120_000);
    this.sdkReady = true;
    this.log(`[sdk] 已就绪 provider=${this.provider} model=${this.model}`);
    this.cancelSupported = await this.probeCancel();
    this.log(this.cancelSupported
      ? '  取消    session/cancel 可用（打断只作废下游输出，不动上游调用）'
      : '  取消    ✗ 宿主运行时没有 session/cancel —— 跑一次 scripts/patch-sdk-cancel.mjs');
    this.rollbackSupported = await this.probeFork();
    this.log(this.rollbackSupported
      ? '  回溯    session/fork 可用（快车道赢了而 dsh 已答完时，把那一轮切掉）'
      : '  回溯    ✗ 宿主运行时没有 session/fork —— 跑一次 scripts/patch-sdk-fork.mjs');
    // 顺手清一次过期（透明化超过 7 天的旧会话）。不做定时器：清理挂在启动这一事件上。
    this.collectSuperseded();
  }

  /**
   * 探一下宿主运行时认不认 `session/fork`。
   *
   * 认的话传一个不存在的 id 会回「会话找不到」，不认才回 `unknown ... runtime method`。
   * 补丁打在全局 npm 包上，dsh 升级会被覆盖，所以每次握手探一次。
   */
  private async probeFork(): Promise<boolean> {
    try {
      await this.rpc('session/fork', { sessionId: '__probe__' }, 5_000);
      return true;
    } catch (error) {
      return !(error as Error).message.includes('unknown');
    }
  }

  /**
   * 探一下宿主运行时认不认 `session/cancel`。
   *
   * 认的话传一个不存在的 id 会回 `{accepted:false}`（我们的补丁特意不建会话）；
   * 不认则回 `-32603 unknown ... runtime method`。补丁是打在全局 npm 包上的，
   * 升级 dsh 会被覆盖，所以每次握手都探一次并打一行日志。
   */
  private async probeCancel(): Promise<boolean> {
    try {
      await this.rpc('session/cancel', { sessionId: '__probe__' }, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 起侧通道（幂等）。端口通过 `VOICE_LIVE_PORT` 传给 dsh 子进程 —— 这就是
   * `mcp/voice-live` 插件的开关：读不到就不启用。
   *
   * 端口存在**实例字段**里、spawn 时局部拼进 env：不写 `process.env`，否则同一
   * 进程里的第二个会话 / 并行测试会互相污染（见字段上的注释）。
   */
  private async ensureLiveRelay(): Promise<void> {
    if (this.liveRelay !== null) {
      return;
    }
    const relay = new LiveTextRelay(this.log);
    const port = await relay.ready();
    this.log('  流式    侧通道端口 ' + port);
    if (port <= 0) {
      this.log('  流式    侧通道没起来，退回整段交付');
      return;
    }
    relay.onMessage((msg) => { this.onLiveMessage(msg); });
    this.liveRelay = relay;
    this.liveRelayPort = port;
  }

  /**
   * 侧通道收到一行：只有**当前会话**的 token 才进语音链路。
   *
   * 按 `sessionId` 过滤是必须的：dsh 进程里可能同时跑着旁路调用（压缩、会话标题），
   * 那些没有 sessionId 已经被插件挡掉了；但历史会话的迟到 token 也可能漂过来。
   */
  private onLiveMessage(msg: LiveMessage): void {
    this.liveMsgCount += 1;
    if (this.liveMsgCount <= 3) {
      this.log(
        `  流式    消息#${this.liveMsgCount} t=${msg.t} `
        + `s=${msg.s ?? '-'} 当前=${this.currentSessionId ?? '-'} `
        + `text=${typeof msg.text === 'string' ? msg.text.length : '无'}`,
      );
    }
    const current = this.currentSessionId;
    if (current === null || msg.s !== current) {
      this.liveDropCount += 1;
      return;
    }
    if (msg.t === 'end') {
      const events = this.liveGate.finish();
      this.liveGate = new LiveGate(this.liveThreshold);
      for (const ev of events) {
        this.onLive?.(ev);
      }
      return;
    }
    if (typeof msg.text !== 'string') {
      return;
    }
    if (this.onLiveSink !== null) {
      this.liveSinkCount += 1;
      if (this.liveSinkCount === 1) {
        this.log(`  流式    首增量 ${msg.text.length} 字`);
      }
    }
    this.onLiveSink?.(msg.text);
    // 首个 token 的时刻：TTS 要等整段生成完才开腔，所以"模型多久开口"和
    // "整段生成多久"必须分开量，否则优化时不知道该动哪一头。
    if (this.firstTokenMs === null && this.turnStartedAt > 0) {
      this.firstTokenMs = Date.now() - this.turnStartedAt;
    }
    for (const ev of this.liveGate.push(msg.text)) {
      this.onLive?.(ev);
    }
  }

  private async rpc(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin?.writable) {
        reject(new DshError(`sdk 未就绪，无法调用 ${method}`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DshError(`${method} 超时（${timeoutMs} ms）`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 非协议帧（不该出现，stdout 专用于 JSON-RPC）
    }

    const id = msg['id'];
    const method = msg['method'];
    const params = msg['params'];

    // 响应：只有 id，没有 method
    if (typeof id === 'number' && method === undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const err = msg['error'];
      if (err) p.reject(new DshError(`JSON-RPC 错误：${JSON.stringify(err).slice(0, 300)}`));
      else p.resolve(msg['result']);
      return;
    }

    if (typeof method !== 'string' || !params || typeof params !== 'object') return;
    const p = params as Record<string, unknown>;

    if (method === 'session.event') {
      const ev = p['event'];
      if (!ev || typeof ev !== 'object') return;
      const e = ev as Record<string, unknown>;
      const eventSessionId = typeof p['sessionId'] === 'string' ? p['sessionId'] : '';
      // 后台作业/子代理的状态全在事件里，先喂给任务板（不认识的类型它自己忽略）。
      // 子会话的事件只允许到这里：下面的主轮文本 / 轮界一律不看。
      this.tasks.observe(
        eventSessionId,
        typeof e['type'] === 'string' ? e['type'] : '',
        e['data'] as Record<string, unknown> | undefined,
      );
      // 空 sessionId、或不是当前打开的主会话：不能写 assistantText / 用量，
      // 也不能推动主轮的 turn 边界。
      if (!this.isMainSession(eventSessionId)) {
        return;
      }
      // 撤回用的刻度：`turn/start` 之前那一条 `agent/inbox/spliced`（inserted 非空）
      // 就是把这句话塞进收件箱的地方。切在它之后，fork 出来的新会话会把它当待办
      // **重放一遍** —— 探针实测：切点取 turn/start−1 时幽灵句出现了 2 次。
      if (typeof e['seq'] === 'number') {
        const data = e['data'] as Record<string, unknown> | undefined;
        const inserted = data?.['inserted'];
        this.rollback.observe(
          typeof e['type'] === 'string' ? e['type'] : '',
          e['seq'],
          Array.isArray(inserted) ? inserted.length : 0,
          this.activeTicket,
        );
      }
      if (e['type'] !== 'assistant/message') {
        this.observeTurnBoundary(e, eventSessionId);
        return;
      }

      const data = e['data'] as Record<string, unknown> | undefined;
      const message = data?.['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (!Array.isArray(content)) return;

      const parts: string[] = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const block = c as Record<string, unknown>;
        if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
      }
      if (parts.length > 0) {
        const text = parts.join('');
        if (this.detached) {
          this.assistantText = text;
          // 被放手那一轮的答复可能在这之后才到，而新一轮的开头会清 `assistantText`
          // —— 单独留一份，否则「放手」的答案会被下一轮冲掉
          this.detachedText = text;
        } else if (this.tailSwallow !== 'none') {
          // 被顶掉的旧自发轮（或刚结算放手轮）残余消息：绝不污染新一轮的 assistantText 与用量
          return;
        } else {
          this.assistantText = text;
        }
        // 没挂流式桥时（bench 就是这样）拿不到 token 级时刻，退一步记「首条 assistant
        // 消息到达」。它晚于真正的首 token，但仍是"模型开始产出"的可比口径。
        if (this.firstTokenMs === null && this.turnStartedAt > 0) {
          this.firstTokenMs = Date.now() - this.turnStartedAt;
        }
      }

      // usage 与 message 同级（`data.usage`），多 step 时逐 step 累加：
      // 输入/输出累加是成本口径，最后一步的输入才是上下文规模。
      const rawUsage = data?.['usage'];
      if (rawUsage && typeof rawUsage === 'object') {
        this.turnUsage = foldStepUsage(this.turnUsage, rawUsage as TokenUsage);
      }
      return;
    }

    if (method === 'session.status') {
      // 子会话的 idle/running 不能唤醒主轮，也不能被当成自发轮。
      if (!this.isMainSession(p['sessionId'])) {
        return;
      }
      const status = typeof p['status'] === 'string' ? p['status'] : '';
      // 这条 idle 属于刚结算的「放手」轮或被顶掉的旧自发轮 —— 吃掉它，别去唤醒新一轮的等待者
      if (status === 'idle' && this.tailSwallow !== 'none') {
        this.tailSwallow = 'none';
        return;
      }
      const waiting = this.onIdle !== null;
      const verdict = this.spontaneous.onStatus(status, waiting);
      if (verdict === 'begin') {
        // 自发轮次开始：清掉上一轮的残留文本，否则会把旧回复当成本次结果播出去
        this.assistantText = '';
        this.log('[sdk] 后台任务结算 → agent 自发开了一轮（不是我们催的）');
        return;
      }
      if (verdict === 'settle') {
        const text = this.assistantText.trim();
        this.assistantText = '';
        if (text && this.onAnnounce) {
          this.onAnnounce(text);
        }
        return;
      }
      if (status === 'idle' && this.onIdle) {
        const fire = this.onIdle;
        this.onIdle = null;
        fire();
      }
    }
  }

  /**
   * 这条事件是不是当前打开的主会话。
   *
   * 空 id、还没打开、对不上 `openSessionId`，都不是。子会话只能进任务板。
   */
  private isMainSession(sessionId: unknown): boolean {
    return typeof sessionId === 'string'
      && sessionId !== ''
      && sessionId === this.openSessionId;
  }

  // ---------------------------------------------------------------- 内部
  private readSession(): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.sessionFile, 'utf8')) as { id?: unknown };
      return typeof raw.id === 'string' && raw.id ? raw.id : null;
    } catch {
      return null;
    }
  }

  private saveSession(id: string): void {
    try {
      writeFileSync(this.sessionFile, JSON.stringify({ id, at: new Date().toISOString() }));
    } catch (e) {
      // 存不下来只是下次开新会话，不该让本轮失败
      this.log(`会话 id 保存失败：${(e as Error).message}`);
    }
  }

  private async run(text: string, sessionId: string | null): Promise<AskResult> {
    const args = [
      'headless',
      '--json',
      ...(sessionId ? ['--session-id', sessionId] : []),
      '-', // 任务从 stdin 读，避免命令行长度与转义问题
    ];
    const started = Date.now();
    const r = await this.exec(args, text);
    const { sessionId: sid, final, streamed, usage } = parseEvents(r.stdout);

    if (r.timedOut) {
      throw new DshError(`dsh 超时（${this.timeoutMs} ms）`);
    }
    if (r.code !== 0) {
      const tail = r.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      throw new DshError(`dsh 退出码 ${r.code}${tail ? `：${tail}` : ''}`);
    }

    const answer = (final ?? streamed).trim();
    if (!answer) {
      throw new DshError('dsh 没有返回任何文本');
    }
    if (sid) this.saveSession(sid);

    return {
      text: answer,
      sessionId: sid,
      usage,
      durationMs: Date.now() - started,
      resumed: sessionId !== null,
    };
  }

  /**
   * `spawn` 一个可能是 npm shim 的 program。
   *
   * Windows 上 `.cmd` / `.bat` 不是可执行映像，直接 spawn 会 `EINVAL`；
   * 用 `cmd.exe /c <shim> ...` 启动，比 `shell: true` 更可控
   * （后者会把参数直接拼进命令行，Node 会报 DEP0190）。
   */
  private spawnProgram(args: string[]) {
    const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.program);
    const argv = isShim ? ['/c', this.program, ...args] : args;
    const command = isShim ? (process.env['COMSPEC'] ?? 'cmd.exe') : this.program;
    // 侧通道端口只传给**这个子进程**：不写 `process.env`（那会污染同一进程里的
    // 其他会话与测试）。端口没起来就原样继承，插件读不到自然不启用。
    const env = this.liveRelayPort === null
      ? process.env
      : { ...process.env, VOICE_LIVE_PORT: String(this.liveRelayPort) };
    return spawn(command, argv, {
      cwd: this.workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private exec(args: string[], input: string): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve, reject) => {
      let child;
      try {
        child = this.spawnProgram(args);
      } catch (e) {
        reject(new DshError(`无法启动 ${this.program}：${(e as Error).message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经退了
        }
      }, this.timeoutMs);

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DshError(`dsh 启动失败：${e.message}`));
      });
      child.on('close', (code: number | null) => finish(code ?? -1));

      child.stdin.on('error', () => {
        // dsh 提前退出时写 stdin 会 EPIPE，忽略
      });
      child.stdin.end(input, 'utf8');
    });
  }
}

