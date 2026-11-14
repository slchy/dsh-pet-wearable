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

export class PetSession {
  readonly floor = new FloorArbiter();

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
    this.brain = new PetBrain(options.params);
    this.state = this.brain.initial(options.caps, this.stamp());
    this.executor = new PetExecutor({
      clock: options.clock,
      voice: options.voice,
      device: options.device,
      agent: options.agent,
      floor: this.floor,
      report: (input) => {
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

  /** 连接关闭：有 engagement 就记 `aborted`。 */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.enqueue({ kind: 'closed', ...this.stamp() });
  }

  // ---------------------------------------------------------------- 话筒

  /**
   * 申请话筒。**只有应用层能调** —— 宠物自己通过执行器申请 `pet`。
   *
   * @returns 是否拿到；拿不到调用方自行降级
   */
  acquireFloor(owner: FloorOwner): boolean {
    const before = this.floor.owner;
    const ok = this.floor.acquire(owner);
    if (ok && this.floor.owner !== before) {
      this.enqueue({ kind: 'floor', busy: true, owner: this.floor.owner, ...this.stamp() });
    }
    return ok;
  }

  releaseFloor(owner: FloorOwner): void {
    const before = this.floor.owner;
    if (!this.floor.release(owner)) {
      return;
    }
    if (this.floor.owner !== before) {
      this.enqueue({ kind: 'floor', busy: this.floor.busy, owner: this.floor.owner, ...this.stamp() });
    }
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

  /** 收尾：丢掉在途动作。**不**产生结局（关闭时会由 `close()` 产生）。 */
  dispose(): void {
    this.executor.dispose();
    this.floor.clear();
  }

  // ---------------------------------------------------------------- 内部

  private stamp(): { now: number; localHour: number } {
    return { now: this.options.clock.now(), localHour: this.options.clock.localHour() };
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
        this.options.onEvent?.('pet.in', input as unknown as Record<string, unknown>);
        const result = this.brain.step(this.state, input);
        this.state = result.state;
        for (const intent of result.intents) {
          this.options.onEvent?.('pet.out', intent as unknown as Record<string, unknown>);
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
    this.options.onEvent?.('pet.outcome', { ...record, dismiss });
    this.options.log?.(`主动开口结束（${record.reason}/${record.outcome}，${record.phase}）`);
  }
}
