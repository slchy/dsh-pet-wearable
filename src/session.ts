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
 *
 * 轮次、传输、headless、侧通道、撤回清单拆在 `src/session/`。本文件是固定
 * 顺序的管道，并重新导出原来的全部公开符号。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { TurnTicket } from './dialog-fsm.ts';
import { LIVE_TOKEN_THRESHOLD, type LiveEvent, type LiveMessage } from './live-text.ts';
import { TaskBoard } from './task-board.ts';
import { HeadlessRunner } from './session/headless.ts';
import { LiveSideband } from './session/live-sideband.ts';
import { RollbackLedger } from './session/rollback-ledger.ts';
import { SdkProcess } from './session/sdk-process.ts';
import { SupersededStore } from './session/superseded.ts';
import { isMainSession, TurnRouter } from './session/turn-router.ts';
import {
  classifySessionFrame,
  DshError,
  type AskResult,
  type DshTurnPhase,
  type ImageAttachment,
  type JsonRpcNotice,
  type SessionFrame,
  type SessionOptions,
  type TurnEffect,
} from './session/types.ts';
import type { TokenUsage } from './session/usage.ts';

export type { AskResult, DshTurnPhase, ImageAttachment, SessionOptions } from './session/types.ts';
export { DshError } from './session/types.ts';
export type { TokenUsage } from './session/usage.ts';
export { foldStepUsage } from './session/usage.ts';
export { parseEvents } from './session/parse-events.ts';
export { RollbackLedger } from './session/rollback-ledger.ts';
export type { SupersededEntry } from './session/superseded.ts';
export { splitSuperseded, SUPERSEDED_TTL_MS } from './session/superseded.ts';

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

export class DshSession {
  private readonly program: string;
  private readonly workDir: string;
  private readonly sessionFile: string;
  private readonly timeoutMs: number;
  private readonly patch: string | undefined;
  private readonly log: (line: string) => void;
  private readonly mode: 'headless' | 'sdk';
  private readonly provider: string;
  private readonly model: string;

  private readonly router = new TurnRouter();
  private readonly rollback = new RollbackLedger();
  private readonly tasks = new TaskBoard(() => this.openSessionId);
  private readonly live: LiveSideband;
  private readonly headless: HeadlessRunner;
  private readonly superseded: SupersededStore;
  private readonly sdk: SdkProcess;

  private openSessionId: string | null = null;
  private rollbackSupported: boolean | null = null;
  private rollbackOutcome: 'ok' | 'failed' | null = null;
  /** 轮次串行队列的尾巴（`ask` 排队用） */
  private turnQueue: Promise<void> = Promise.resolve();

  /**
   * 既有测试用类型转换读这些槽（`tests/detached-answer.test.ts`）。
   * 状态只住在 {@link TurnRouter}，这里不另存一份。
   */
  private get detachedLease() { return this.router.view().detachedLease; }
  private get tailSwallow() { return this.router.view().tailSwallow; }
  private get assistantText() { return this.router.view().assistantText; }
  private get activeUserText() { return this.router.view().activeUserText; }
  private get turnPhase(): DshTurnPhase { return this.router.view().turnPhase; }
  private get spontaneous() { return this.router.view().spontaneous; }
  /** `tests/detached-answer.test.ts` 的 dispose 读这个名字来关掉侧通道。 */
  private get liveRelay(): { close(): void } | null {
    return this.live.openedRelay();
  }

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
   * 会打断他），这条是"记下来"。
   */
  onDetachedAnswer:
    | ((userText: string, answer: string, spoken: boolean) => void)
    | null = null;
  /**
   * 流式文本（侧通道）。三个事件：`start` 交出前 N 个 token、`delta` 逐 token 直通、
   * `end` 这条流结束。
   */
  onLive: ((event: LiveEvent) => void) | null = null;
  /**
   * 逐句合成的订阅口：每来一个 token 增量就调一次。
   *
   * 与 {@link onLive} 的区别：那个带着 20 token 门槛（短答整段给）；这个是**原始增量**。
   */
  onLiveSink: ((text: string) => void) | null = null;

  /** 侧通道增量计数（诊断用：首增量何时到、共几段） */
  get liveSinkCount(): number { return this.live.liveSinkCount; }
  set liveSinkCount(value: number) { this.live.liveSinkCount = value; }
  /** 侧通道收到/丢弃计数（诊断：区分「没发」和「被 sessionId 挡了」） */
  get liveMsgCount(): number { return this.live.liveMsgCount; }
  set liveMsgCount(value: number) { this.live.liveMsgCount = value; }
  get liveDropCount(): number { return this.live.liveDropCount; }
  set liveDropCount(value: number) { this.live.liveDropCount = value; }

  constructor(opts: SessionOptions) {
    this.program = opts.program ?? process.env['DSH_BIN'] ?? 'dsh';
    this.workDir = opts.workDir;
    this.patch = opts.patch;
    // 空串当没给：`VOICE_AGENT_SESSION=` 这种写法不该落成「相对路径 ''」
    const fromEnv = process.env['VOICE_AGENT_SESSION']?.trim();
    this.sessionFile = opts.sessionFile
      ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.voice-agent', 'session.json'));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
    this.mode = opts.mode ?? 'headless';
    this.provider = opts.provider ?? 'deepseek-official';
    this.model = opts.model ?? 'deepseek-flash';

    this.live = new LiveSideband({
      log: (line) => { this.log(line); },
      threshold: opts.liveTokenThreshold ?? LIVE_TOKEN_THRESHOLD,
      onMessage: (msg) => { this.acceptLive(msg); },
    });
    this.headless = new HeadlessRunner({
      program: this.program,
      workDir: this.workDir,
      timeoutMs: this.timeoutMs,
    });
    this.superseded = new SupersededStore({
      supersededFile: join(dirname(this.sessionFile), 'superseded.jsonl'),
      sessionsRoot: join(homedir(), '.dsh', 'sessions'),
      log: (line) => { this.log(line); },
    });
    this.sdk = new SdkProcess({
      program: this.program,
      workDir: this.workDir,
      timeoutMs: this.timeoutMs,
      patch: this.patch,
      provider: this.provider,
      model: this.model,
      log: (line) => { this.log(line); },
      host: {
        requestStop: () => { this.stop(); },
        clearTurns: () => { this.router.clearTurnState(); },
        onGenerationClosed: () => {
          this.openSessionId = null;
          this.router.clearTurnState();
          this.router.wakeIdle();
        },
        ensureLive: () => this.live.ensure(),
        livePort: () => this.live.port,
        onForkProbed: (supported) => { this.rollbackSupported = supported; },
        collectSuperseded: () => { this.superseded.collect(this.openSessionId); },
        handleLine: (note) => { this.handleLine(note); },
      },
    });

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
    // 换会话了：账本里的 seq 和待撤回的切点都属于旧会话，一起丢掉。
    // 放手租约也是旧会话的，留着会把下一轮的文本和 idle 认成上一轮。
    this.rollback.reset();
    this.router.clearTurnState();
    try {
      if (existsSync(this.sessionFile)) writeFileSync(this.sessionFile, '{}');
    } catch {
      // 写不进去也不影响下次调用：readSession 失败就当没有
    }
  }

  /**
   * 问一次。沿用已记录的会话；失败则清空记录重开一次。
   *
   * **串行**：`askSdk` 只用一个等待槽等 turn 结束，两轮重叠时后一轮会把前一轮的
   * 等待者顶掉。这里排个队，把「重叠」降级成「等一会儿」。
   */
  async ask(text: string, image?: ImageAttachment, turn?: { readonly ticket: TurnTicket }): Promise<AskResult> {
    const ticket = turn?.ticket;
    const run = this.turnQueue.then(
      () => this.askOnce(text, image, ticket),
      () => this.askOnce(text, image, ticket),
    );
    this.turnQueue = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async askOnce(text: string, image?: ImageAttachment, ticket?: TurnTicket): Promise<AskResult> {
    if (this.mode === 'sdk') return await this.askSdk(text, image, ticket);
    // 带图在重试之前拒绝，避免把「模式不支持」当成会话失效清掉指针。
    if (image !== undefined) return await this.headless.run(text, null, image);

    const stored = this.readSession();
    if (stored !== null) {
      try {
        return await this.finishHeadless(text, stored);
      } catch (error) {
        this.log(`会话 ${stored} 失败，改开新会话：${(error as Error).message}`);
        this.reset();
      }
    }
    return await this.finishHeadless(text, null);
  }

  private async finishHeadless(text: string, sessionId: string | null): Promise<AskResult> {
    const result = await this.headless.run(text, sessionId);
    if (result.sessionId !== null) this.saveSession(result.sessionId);
    return result;
  }

  /**
   * 取消当前在途的一轮。过期票据是空操作；不带票据的显式取消仍然放行。
   * 取消是故意的：被取消的那一轮收成空答复，不抛错。
   */
  cancelTurn(ticket?: TurnTicket): void {
    const sessionId = this.openSessionId ?? this.readSession();
    const decision = this.router.cancelTurn({
      ticket,
      hasProc: this.sdk.hasProc,
      sessionId,
    });
    if (decision.type === 'noop') return;
    if (decision.type === 'stale') {
      this.log(decision.line);
      return;
    }
    if (this.sdk.cancelSupported === false) {
      // 补丁没打（比如 dsh 刚升级过）。不假装成功，也不硬 SIGINT 杀进程 —— 只等它自己说完
      this.log('  取消    ✗ 宿主没有 session/cancel，这一轮取消不了');
    } else {
      const target = decision.sessionId;
      void this.sdk.rpc('session/cancel', { sessionId: target }).then(
        () => {
          this.sdk.noteCancelSupported();
          this.log(`  取消    已请求取消 ${target} 的在途一轮`);
        },
        (error: Error) => { this.log(`  取消    ✗ ${error.message}`); },
      );
    }
    const waiter = decision.graceWaiter;
    setTimeout(() => {
      this.router.releaseGrace(waiter);
    }, CANCEL_GRACE_MS).unref?.();
    if (decision.droppedLease) {
      this.log('  取消    放手的委派轮也一起取消（用户显式说了不要）');
    }
  }

  /**
   * dsh 那边有没有在跑的活儿（含**放手的**委派轮）。
   *
   * 只看相位：`prompting_rpc` / `awaiting_idle` / `detached_running` 才算忙。
   * `session/prompt` 抛错时 `finally` 会把相位归回 `idle`，不会永锁。
   */
  isBusy(): boolean {
    return this.sdk.hasProc && this.router.readPhase() !== 'idle';
  }

  /**
   * 硬中断：`SIGINT` 给 dsh 子进程（等同 TUI 里 Ctrl-C）。
   * 会杀掉进程，下一轮要重启并 resume。调用方自己判断，默认不用。
   */
  interruptTurn(): void {
    this.sdk.interrupt();
  }

  /**
   * 放手：**不取消** dsh 那一轮，只把「有人在等它」摘掉。
   * 票据按代次校验：迟到的放手不能摘掉下一轮的等待者。
   */
  detachTurn(ticket?: TurnTicket): void {
    this.applyTurnEffects(this.router.detachTurn(ticket, this.sdk.hasProc));
  }

  /**
   * 启动时探测：宿主运行时认不认 `session/cancel`。
   * **探测失败一律当"不支持"**。
   */
  async probeCancelSupport(timeoutMs = 20_000): Promise<boolean> {
    const probe = (async (): Promise<boolean> => {
      try {
        await this.sdk.ensure();
      } catch (error) {
        this.log(`  取消    探测失败：${(error as Error).message}`);
        return false;
      }
      return this.sdk.cancelSupported === true;
    })();
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs).unref?.();
    });
    return await Promise.race([probe, timeout]);
  }

  /** 后台作业状态的一句话事实（给快车道照实说）。 */
  taskStatus(): string {
    return this.tasks.describe();
  }

  /** 关掉常驻进程（有的话）。headless 模式无副作用。先清轮次，再按代次停传输。 */
  stop(): void {
    this.router.clearTurnState();
    if (this.sdk.stop()) this.openSessionId = null;
  }

  /**
   * 一轮对话：`session/prompt` 入队，等 `session.status=idle` 收尾。
   * `finally` 只把相位归回 `idle` 或 `detached_running`。
   */
  private async askSdk(text: string, image?: ImageAttachment, ticket?: TurnTicket): Promise<AskResult> {
    await this.sdk.ensure();

    const started = Date.now();
    const stored = this.readSession();
    let sessionId = stored ?? `session-${randomUUID()}`;
    let resumed = stored !== null;
    if (!resumed) this.saveSession(sessionId);

    // 已持久化的会话必须先 resume。但 resume 只在本进程内做一次：
    // 会话已经活着时再 resume 会报 "SDK session is already open or opening"。
    if (resumed && this.openSessionId !== sessionId) {
      try {
        await this.sdk.rpc('session/resume', { sessionId });
        this.openSessionId = sessionId;
      } catch (error) {
        this.log(`恢复 ${sessionId} 失败，改开新会话：${(error as Error).message}`);
        sessionId = `session-${randomUUID()}`;
        resumed = false;
        this.saveSession(sessionId);
        this.openSessionId = sessionId;
      }
    } else if (!resumed) {
      this.openSessionId = sessionId;
    }

    sessionId = await this.applyRollback(sessionId);

    this.router.beginAsk(started);
    this.sdk.clearExitError();
    // 放在臂等待者之前、且中间没有 await：idle 不可能插进这个窗口。
    this.router.prepareIncomingPrompt();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let detachedThisAsk = false;
    try {
      const idle = this.router.armForeground(ticket ?? null, text);
      await this.sdk.rpc('session/prompt', {
        sessionId,
        contentBlocks: image
          ? [
              { type: 'text', text },
              { type: 'image', mimeType: image.mimeType, data: image.data },
            ]
          : [{ type: 'text', text }],
      });
      this.router.markAwaitingIdle();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DshError(`等待 turn 结束超时（${this.timeoutMs} ms）`)),
          this.timeoutMs,
        );
      });
      await Promise.race([idle, timeout]);
    } finally {
      clearTimeout(timer);
      detachedThisAsk = this.router.finishForeground();
    }

    const answer = this.router.readAssistantText().trim();
    const cancelled = this.router.takeCancelled();
    const detached = detachedThisAsk;
    const exitReason = this.sdk.exitError;
    if (exitReason !== null) {
      this.sdk.takeExitError();
      throw new DshError(exitReason);
    }
    // 被主动取消或放手的一轮可以没有文本。除此之外空答复是失败。
    if (answer === '' && !cancelled && !detached) throw new DshError('sdk 没有返回任何文本');

    const firstTokenMs = this.router.readFirstToken();
    return {
      text: answer,
      sessionId,
      usage: this.router.readUsage(),
      durationMs: Date.now() - started,
      resumed,
      ...(firstTokenMs === null ? {} : { firstTokenMs }),
      ...(detached ? { detached: true } : {}),
    };
  }

  /**
   * 记下「上一轮不要了」。真正的 fork 在下一轮发 prompt 之前；
   * 现在没人在跑就立刻做，好让补上下文知道该怎么措辞。
   */
  rollbackTurn(ticket?: TurnTicket): void {
    if (this.mode !== 'sdk') return;
    if (!this.rollback.claim(ticket)) return;
    this.log(`  回溯    记下切点 seq=${this.rollback.peek()}（开轮前撤回）`);
    void this.tryRollbackNow();
  }

  /** 空闲时立刻撤回；有轮次在飞就留给下一轮 `askSdk`（不交叉）。 */
  private async tryRollbackNow(): Promise<void> {
    if (!this.sdk.ready || this.router.readTicket() !== null || this.openSessionId === null) return;
    if (this.rollback.peek() === null) return;
    await this.applyRollback(this.openSessionId);
  }

  /**
   * 上次撤回的结果：`ok` 成功 / `failed` 没做成 / `none` 没撤过。**取一次就清**。
   */
  takeRollbackOutcome(): 'ok' | 'failed' | 'none' {
    const outcome = this.rollbackOutcome;
    this.rollbackOutcome = null;
    return outcome ?? 'none';
  }

  /**
   * 把待撤回的那一轮切掉，返回**接下来该用的** session id。
   * 失败不抛：撤回是锦上添花，失败就照旧续在原会话上。
   */
  private async applyRollback(sessionId: string): Promise<string> {
    const cut = this.rollback.take();
    if (cut === null) return sessionId;
    if (this.rollbackSupported === false) {
      this.rollbackOutcome = 'failed';
      this.log('  回溯    ✗ 宿主运行时没有 session/fork —— 跑一次 scripts/patch-sdk-fork.mjs');
      return sessionId;
    }
    try {
      const startedAt = Date.now();
      const result = await this.sdk.rpc(
        'session/fork',
        { sessionId, atSeq: cut },
        FORK_TIMEOUT_MS,
      ) as { sessionId?: unknown } | null;
      const child = typeof result?.sessionId === 'string' ? result.sessionId : '';
      if (child === '') throw new DshError('session/fork 没有返回新会话 id');
      this.rollbackSupported = true;
      this.rollbackOutcome = 'ok';
      this.openSessionId = child;
      this.saveSession(child);
      // 账本里的 seq 属于旧会话，留着下次会拿无效切点去 fork 新会话
      this.rollback.reset();
      this.superseded.retire(sessionId, this.openSessionId);
      this.log(`  回溯    已撤回上一轮（切点 seq=${cut}，${Date.now() - startedAt} ms）→ ${child}`);
      return child;
    } catch (error) {
      this.rollbackOutcome = 'failed';
      this.log(`  回溯    ✗ ${(error as Error).message}`);
      return sessionId;
    }
  }

  /**
   * 通知管道，固定六步。传输层已经把 JSON-RPC 响应结算掉了，这里只看通知。
   *
   * 1. 分拣 `session.event` / `session.status`
   * 2. 事件喂任务板（子会话的作业也记）
   * 3. `openSessionId` 门：子会话到此为止
   * 4. 主会话刻度记入撤回账本
   * 5. 轮次机：边界、吞尾、自发轮、叫醒等待者
   * 6. 前台文本才记首 token 与用量
   */
  private handleLine(note: JsonRpcNotice): void {
    const frame = classifySessionFrame(note);
    if (frame === null) return;
    this.stepTasks(frame);
    if (!isMainSession(frame.sessionId, this.openSessionId)) return;
    this.stepRollback(frame);
    const assistant = this.stepTurn(frame);
    if (assistant !== null) this.stepUsage(assistant);
  }

  private stepTasks(frame: SessionFrame): void {
    if (frame.kind !== 'event') return;
    this.tasks.observe(frame.sessionId, frame.type, frame.data);
  }

  private stepRollback(frame: SessionFrame): void {
    if (frame.kind !== 'event' || frame.seq === null) return;
    this.rollback.observe(frame.type, frame.seq, frame.inserted, this.router.readTicket());
  }

  /** 非 assistant 在这一步走完。assistant 把 `data` 交给第 6 步；没有 data 时传 undefined。 */
  private stepTurn(frame: SessionFrame): Record<string, unknown> | undefined | null {
    if (frame.kind === 'status') {
      this.applyTurnEffects(this.router.consumeStatus(
        frame.status,
        frame.sessionId,
        this.openSessionId,
      ));
      return null;
    }
    if (frame.type !== 'assistant/message') {
      this.applyTurnEffects(this.router.observeTurnBoundary(
        frame.event,
        frame.sessionId,
        this.openSessionId,
        this.onAnnounce !== null,
      ));
      return null;
    }
    return frame.data;
  }

  private stepUsage(data: Record<string, unknown> | undefined): void {
    const message = data?.['message'];
    const messageObj = message !== null && typeof message === 'object'
      ? message as Record<string, unknown>
      : undefined;
    const content = messageObj?.['content'];
    if (!Array.isArray(content)) return;

    const parts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text']);
    }
    if (parts.length > 0) {
      const text = parts.join('');
      if (!this.router.acceptAssistantText(data, text)) return;
      // 没挂流式桥时退一步记「首条 assistant 消息到达」。
      this.router.noteFirstToken(Date.now());
    }
    const rawUsage = data?.['usage'];
    if (rawUsage !== null && typeof rawUsage === 'object') {
      this.router.recordUsage(rawUsage as TokenUsage);
    }
  }

  private applyTurnEffects(effects: readonly TurnEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'log') {
        this.log(effect.line);
        continue;
      }
      if (effect.type === 'detached-answer') {
        try {
          this.onDetachedAnswer?.(effect.userText, effect.answer, effect.spoken);
        } catch (error) {
          this.log(`  放手    ✗ 回注失败：${(error as Error).message}`);
        }
        continue;
      }
      this.onAnnounce?.(effect.text);
    }
  }

  private acceptLive(msg: LiveMessage): void {
    const outcome = this.live.ingest(msg, this.currentSessionId, this.onLiveSink !== null);
    if (outcome.sinkText !== null) this.onLiveSink?.(outcome.sinkText);
    if (outcome.markFirstToken) this.router.noteFirstToken(Date.now());
    for (const event of outcome.events) this.onLive?.(event);
  }

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
    } catch (error) {
      // 存不下来只是下次开新会话，不该让本轮失败
      this.log(`会话 id 保存失败：${(error as Error).message}`);
    }
  }
}
