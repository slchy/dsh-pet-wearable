/**
 * `PetSession`：应用层的宠物环路。**只依赖四个端口**。
 *
 * 对应 ADR-0001 §3。
 *
 * ```
 * 输入 ──► 队列（单线程，按到达顺序） ──► PetBrain.step ──► 意图 ──► PetExecutor
 *                  ▲                                                  │
 *                  └──────────────── 阶段结果 / 话筒变化 ◄──────────────┘
 * ```
 *
 * <h2>为什么要有队列</h2>
 *
 * 状态机是纯的，但执行器是异步的。把每条输入排进同一个队列再逐条 `step`，
 * 就得到"执行器从不直接改状态"的保证 —— 它只能把结果作为新输入排进来。
 * 这样重放一份 `pet.in` 必然得到同一串 `pet.out`。
 */
import type { DeviceCapabilities } from '../../devices/primitives.ts';
import { EVENTS } from '../../events.ts';
import { PetBrain } from './brain.ts';
import { PetExecutor } from './executor.ts';
import { FloorArbiter } from './floor.ts';
import type { PetParams } from './registry.ts';
import type {
  AgentPort,
  Clock,
  DevicePort,
  FloorOwner,
  PetImage,
  PetInput,
  PetIntent,
  PetOutcomeRecord,
  PetState,
  Voice,
} from './types.ts';

export interface PetSessionOptions {
  readonly caps: DeviceCapabilities;
  readonly clock: Clock;
  readonly voice: Voice;
  readonly device: DevicePort;
  readonly agent: AgentPort;
  readonly params?: Partial<PetParams>;
  /** 共用的话筒仲裁器（应用层造的那一个）；不给就自己造，单测用 */
  readonly floor?: FloorArbiter;
  /** 档案钩子：每条输入 / 每条意图 / 每条结局 */
  readonly onEvent?: (name: string, fields: Record<string, unknown>) => void;
  /** 敲击要关掉正在播的后台汇报 */
  readonly dismissAnnounce?: () => void;
  readonly log?: (line: string) => void;
}

/**
 * 把一条宠物事件压成**可落盘**的形状。
 *
 * 输入/意图里可能带 JPEG（base64，几 MB）。档案是逐条 JSON 写的，
 * 直接塞进去会让 `events.jsonl` 爆炸，所以图片一律只留字节数。
 */
export function summarizePetEvent(name: string, fields: Record<string, unknown>): Record<string, unknown> {
  void name;
  const out: Record<string, unknown> = { ...fields };
  const image = out['image'];
  if (image !== null && typeof image === 'object') {
    const data = (image as { data?: unknown }).data;
    out['image'] = { bytes: typeof data === 'string' ? data.length : 0 };
  }
  return out;
}

/** 长文本进日志要截断，不然一行能刷满屏。 */
function clip(text: string, max = 24): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 一行说得清「谁戳了它」。
 *
 * 心跳每 30 s 一条，所以这行必须短。它存在的意义：**「它为什么不出声」要能当场读出来**，
 * 而不是去翻 `events.jsonl` 才知道宠物到底收没收到佩戴/电量/话筒变化。
 */
export function describePetInput(input: PetInput): string {
  switch (input.kind) {
    case 'tick':
      return '心跳';
    case 'userPartial':
      return '用户开口（中间结果）';
    case 'userFinal':
      return `用户说完「${clip(input.text)}」`;
    case 'presence':
      return `佩戴=${input.wearing === null ? '未知' : input.wearing ? '戴上' : '摘下'}`;
    case 'power':
      return `电量=${input.percent === null ? '未知' : `${input.percent}%`}`;
    case 'summon':
      return input.opensSession ? '招呼（同时开语音会话）' : '招呼';
    case 'floor':
      return `话筒=${input.busy ? `被占(${input.owner ?? '?'})` : '空闲'}`;
    case 'announce':
      return `待播报=${input.pending ? '有' : '无'}${input.spoken ? '，刚播完' : ''}`;
    case 'image':
      return input.image === null
        ? '看图结果：没拍到'
        : `看图结果：${Math.round(input.image.data.length * 0.75)} B`;
    case 'phaseResult':
      return `阶段结果 ${input.phase}#${input.step}=${input.result}`;
    case 'micOpened':
      return '首帧上行到了（麦真的在采集）';
    case 'closed':
      return '连接关闭';
  }
}

/** 一行说得清「它决定了什么」。 */
export function describePetIntent(intent: PetIntent): string {
  switch (intent.kind) {
    case 'phase.enter':
      return `进入 ${intent.phase}（计划 ${intent.plan.join('→')}，截止 ${
        intent.deadlineMs === null ? '无' : `${intent.deadlineMs} ms`
      }，${intent.holdsFloor ? '占话筒' : '不占话筒'})`;
    case 'end':
      return `收尾：${intent.record.reason} / ${intent.record.outcome}`;
    case 'reflex':
      return `快反射 ${intent.cue}`;
    case 'announce.dismiss':
      return '撤掉待播报';
  }
}

export class PetSession {
  /**
   * 话筒仲裁器。默认自己造一个，但**可以被注入** —— 应用层要拿同一个实例来仲裁
   * `user` / `reply` / `announce`（ADR-0001 §6：仲裁在应用层，宠物只申请）。
   */
  readonly floor: FloorArbiter;

  private readonly options: PetSessionOptions;
  private readonly brain: PetBrain;
  private readonly executor: PetExecutor;
  private readonly queue: PetInput[] = [];
  private state: PetState;
  private pumping = false;
  private inFlight = 0;
  private idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(options: PetSessionOptions) {
    this.options = options;
    this.floor = options.floor ?? new FloorArbiter();
    this.brain = new PetBrain(options.params);
    this.state = this.brain.initial(options.caps, this.stamp());
    this.executor = new PetExecutor({
      clock: options.clock,
      voice: options.voice,
      device: options.device,
      agent: options.agent,
      floor: this.floor,
      isLive: (engagementId) => this.state.engagement?.id === engagementId,
      report: (input) => {
        if (input.kind === 'floor') {
          // 抢麦失败时归属往往没变，但大脑必须再看一次，否则 floorTaken 没有输入。
          const force = input.busy && input.owner !== 'pet';
          this.publishFloor(force);
          return;
        }
        this.enqueue({ ...input, ...this.stamp() } as PetInput);
      },
      onOutcome: (record, dismiss) => {
        this.emitOutcome(record, dismiss);
      },
      ...(options.dismissAnnounce === undefined ? {} : { dismissAnnounce: options.dismissAnnounce }),
      onEvent: (name, fields) => {
        this.options.onEvent?.(name, fields);
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }

  // ---------------------------------------------------------------- 输入

  // 每条输入都从这里进去；调用方不需要知道时钟从哪来

  tick(): void {
    this.enqueue({ kind: 'tick', ...this.stamp() });
  }

  userPartial(): void {
    this.enqueue({ kind: 'userPartial', ...this.stamp() });
  }

  userFinal(text: string): void {
    this.enqueue({ kind: 'userFinal', text, ...this.stamp() });
  }

  presence(wearing: boolean | null): void {
    this.enqueue({ kind: 'presence', wearing, ...this.stamp() });
  }

  power(percent: number | null): void {
    this.enqueue({ kind: 'power', percent, ...this.stamp() });
  }

  summon(opensSession = false): void {
    this.enqueue({ kind: 'summon', opensSession, ...this.stamp() });
  }

  /** 后台汇报队列状态。`spoken` = 刚刚真的播过一条（会推迟下一次搭话）。 */
  announce(pending: boolean, spoken = false): void {
    this.enqueue({ kind: 'announce', pending, spoken, ...this.stamp() });
  }

  /** 主动拍照的结果；`image === null` 表示没拍到。 */
  image(id: string, image: PetImage | null): void {
    this.enqueue({ kind: 'image', id, image, ...this.stamp() });
  }

  /**
   * 麦开了：`listen.start` 之后收到的首帧上行音频。
   *
   * 只有适配层能产出 —— 它是"设备真的在采集"的唯一证据（ADR-0001 §5.4）。
   */
  micOpened(): void {
    this.enqueue({ kind: 'micOpened', ...this.stamp() });
  }

  /**
   * 连接关闭：有 engagement 就记 `aborted`。
   *
   * 顺序是同步的：先封执行器，再清话筒，再把 `closed` 送进大脑，
   * 然后立刻对活跃麦发 `listen.stop`。关麦不能等 `end` 的微任务 ——
   * 紧接着的 `dispose()` 会先清掉 `micOpenFor`。
   */
  close(): void {
    if (this.closed) {
      return;
    }
    const hadEngagement = this.state.engagement !== null;
    this.executor.seal();
    this.floor.clear();
    this.closed = true;
    this.enqueue({ kind: 'closed', ...this.stamp() });
    if (hadEngagement) {
      this.executor.stopOpenMic();
    }
  }

  // ---------------------------------------------------------------- 话筒

  /**
   * 申请话筒。**只有应用层能调** —— 宠物自己通过执行器申请 `pet`。
   *
   * @returns 是否拿到；拿不到调用方自行降级
   */
  acquireFloor(owner: FloorOwner): boolean {
    const ok = this.floor.acquire(owner);
    this.publishFloor(false);
    return ok;
  }

  /**
   * 移交话筒（`user → reply`）。和 {@link acquireFloor} 一样会把 `floor` 事件喂给
   * 宠物环 —— 否则宠物看到的 `floorBusy` 会停在旧值上。
   */
  handoffFloor(from: FloorOwner, to: FloorOwner): boolean {
    if (!this.floor.handoff(from, to)) {
      return false;
    }
    this.publishFloor(false);
    return true;
  }

  releaseFloor(owner: FloorOwner): void {
    if (!this.floor.release(owner)) {
      return;
    }
    this.publishFloor(false);
  }

  // ---------------------------------------------------------------- 观测

  /** 当前状态机状态（只读快照）。测试与档案用。 */
  snapshot(): PetState {
    return this.state;
  }

  /** 队列空。虚拟时钟用它判"这一轮不会再排进新输入"，**不等在途动作**。 */
  hasPendingInput(): boolean {
    return this.queue.length > 0;
  }

  /** 队列空且没有在途执行器。 */
  isIdle(): boolean {
    return this.queue.length === 0 && this.inFlight === 0;
  }

  /** 队列空且没有在途执行器时 resolve。 */
  whenIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * 收尾：丢掉在途动作。**不**产生结局（关闭时会由 `close()` 产生）。
   *
   * `closed` 在这里同步置上，作为吸收态。还开着的麦先停掉，话筒投影先对齐，
   * 然后再拆执行器 —— 拆的过程里再报上来的结果会被吸收态丢掉。
   */
  dispose(): void {
    if (!this.closed && this.state.engagement !== null) {
      this.executor.stopOpenMic();
    }
    if (!this.closed) {
      this.floor.clear();
      this.publishFloor(false);
    }
    this.closed = true;
    this.executor.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private stamp(): { now: number; localHour: number } {
    return { now: this.options.clock.now(), localHour: this.options.clock.localHour() };
  }

  /**
   * 把仲裁器的当前归属写进大脑。
   *
   * 仲裁器是话筒的唯一真相，`PetWorld.floorOwner` 只是投影。归属没变且不是
   * 「抢麦失败」时不入队，避免把同一次占用再报成 `floorTaken`。
   *
   * @param force 抢麦失败：即使投影已经一致，也要再送一次让状态机决断
   */
  private publishFloor(force: boolean): void {
    if (this.closed) {
      return;
    }
    const busy = this.floor.busy;
    const owner = this.floor.owner;
    const same = this.state.world.floorBusy === busy && this.state.world.floorOwner === owner;
    if (same && !force) {
      return;
    }
    this.enqueue({ kind: 'floor', busy, owner, ...this.stamp() });
  }

  /** 当前处在哪个阶段，或「闲置」。日志里带上它，才知道这句话是在什么状态下判的。 */
  private phaseNote(): string {
    const engagement = this.state.engagement;
    if (engagement === null) {
      return '  [闲置]';
    }
    const phase = engagement.plan[engagement.at] ?? '?';
    return `  [${phase} #${engagement.step}]`;
  }

  private enqueue(input: PetInput): void {
    // 连接关了就不再接受任何新输入；否则心跳还会把宠物叫起来说话
    if (this.closed && input.kind !== 'closed') {
      return;
    }
    this.queue.push(input);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const input = this.queue.shift();
        if (input === undefined) {
          break;
        }
        this.options.onEvent?.(EVENTS.petIn, input as unknown as Record<string, unknown>);
        this.options.log?.(`宠物 ← ${describePetInput(input)}${this.phaseNote()}`);
        const result = this.brain.step(this.state, input);
        this.state = result.state;
        if (result.intents.length === 0 && input.kind === 'tick') {
          // 心跳是唯一"什么都不做"也会发生的输入：它不出声时必须留下一行，
          // 否则分不清"没在跑"和"判断了但决定不说"
          this.options.log?.(`宠物 ·  心跳后仍不出声${this.phaseNote()}`);
        }
        for (const intent of result.intents) {
          this.options.onEvent?.(EVENTS.petOut, intent as unknown as Record<string, unknown>);
          this.options.log?.(`宠物 → ${describePetIntent(intent)}`);
          this.inFlight += 1;
          // 推到微任务里执行：执行器绝不能重入 pump，否则它会在同一条输入里
          // 把下一阶段的副作用全跑完（打断就只能等它们做完才生效）
          void Promise.resolve()
            .then(() => this.executor.run(intent))
            .catch((error: unknown) => {
              this.options.log?.(`宠物执行器出错：${String(error)}`);
            })
            .finally(() => {
              this.inFlight -= 1;
              this.settleIdle();
            });
        }
      }
    } finally {
      this.pumping = false;
    }
    this.settleIdle();
  }

  private settleIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private emitOutcome(record: PetOutcomeRecord, dismiss: boolean): void {
    this.options.onEvent?.(EVENTS.petOutcome, { ...record, dismiss });
    this.options.log?.(`主动开口结束（${record.reason}/${record.outcome}，${record.phase}）`);
  }
}
