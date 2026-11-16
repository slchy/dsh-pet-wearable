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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { SpontaneousTurn } from './spontaneous.ts';
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
  /**
   * 后台任务完成后**自发**产生的汇报文本（不属于任何一轮）。
   *
   * dsh 的后台作业结算后会自己开一轮说结果（没有 `session/prompt`），这条回调
   * 就是接住它的唯一入口 —— 不接就是静默丢弃。
   */
  onAnnounce: ((text: string) => void) | null = null;
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
   */
  async ask(text: string, image?: ImageAttachment): Promise<AskResult> {
    if (this.mode === 'sdk') return await this.askSdk(text, image);
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

  /** 关掉常驻进程（有的话）。headless 模式无副作用。 */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.sdkReady = false;
    this.openSessionId = null;
    try {
      proc.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: {} })}\n`,
      );
    } catch {
      // 已经退了
    }
    // 给 shutdown 一点时间优雅退出，超时就强杀
    setTimeout(() => {
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
  private async askSdk(text: string, image?: ImageAttachment): Promise<AskResult> {
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

    this.assistantText = '';
    this.turnUsage = null;
    this.turnStartedAt = started;
    this.firstTokenMs = null;
    // 接下来这一轮的 idle 归 prompt 等待者，不算自发轮次
    this.spontaneous.reset();
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

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DshError(`等待 turn 结束超时（${this.timeoutMs} ms）`)),
        this.timeoutMs,
      );
    });
    try {
      await Promise.race([idle, timeout]);
    } finally {
      clearTimeout(timer);
      this.onIdle = null;
    }

    const answer = this.assistantText.trim();
    if (!answer) throw new DshError('sdk 没有返回任何文本');

    return {
      text: answer,
      sessionId,
      usage: this.turnUsage,
      durationMs: Date.now() - started,
      resumed,
      ...(this.firstTokenMs === null ? {} : { firstTokenMs: this.firstTokenMs }),
    };
  }

  /** 懒启动常驻进程并握手。崩溃后下次调用会自动重启。 */
  private async ensureSdk(): Promise<void> {
    if (this.proc && this.sdkReady) return;
    if (this.proc) this.stop();

    // 流式侧通道要在 spawn **之前**就绪：端口靠 `VOICE_LIVE_PORT` 传给子进程，
    // dsh 里的 `voice-live` 插件启动时读它，读不到就整个不启用。
    await this.ensureLiveRelay();

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
      this.log(`[sdk] 启动失败：${e.message}`);
      this.sdkReady = false;
      if (this.proc === proc) this.proc = null;
    });
    proc.on('close', (code: number | null) => {
      this.sdkReady = false;
      // 进程没了，里面的会话也就不在了；下次必须重新 resume
      this.openSessionId = null;
      if (this.proc === proc) this.proc = null;
      // 没收到 shutdown 就退出，说明崩了；挂起的请求全部失败
      for (const [, p] of this.pending) p.reject(new DshError(`sdk 进程退出（code=${code}）`));
      this.pending.clear();
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
  }

  /**
   * 起侧通道（幂等）。端口通过 `VOICE_LIVE_PORT` 传给 dsh 子进程 —— 这一行就是
   * `mcp/voice-live` 插件的开关：读不到就不启用。
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
    process.env['VOICE_LIVE_PORT'] = String(port);
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
      if (e['type'] !== 'assistant/message') return;

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
        this.assistantText = parts.join('');
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
      const status = typeof p['status'] === 'string' ? p['status'] : '';
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
    return spawn(command, argv, {
      cwd: this.workDir,
      env: process.env,
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
