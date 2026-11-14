/**
 * `AppSession`：应用层的根。
 *
 * 对应 ADR-0002 §3.1。它拥有**输入面与心跳**，`PetSession` 只是其中一个子系统：
 *
 * ```
 * 适配层 / 模拟器 ──(userPartial / userFinal / deviceEvent / image / close)──► AppSession
 *                                                                              │
 *                        clock.every(tickMs) ──► PetSession.tick()  ◄──────────┤
 *                        事件后补 tick ─────────► PetSession.tick()  ◄──────────┤
 *                        话筒占用 ──────────────► FloorArbiter       ◄──────────┘
 * ```
 *
 * <h2>为什么心跳和补 tick 必须在这里</h2>
 *
 * 它们原先各有两份：生产在 `aliyun-session.ts`，模拟在 `harness.ts`。两份一定会漂移，
 * 于是模拟测的是自己的抄本（ADR-0002 P2）。现在只有这一份，适配层和模拟器都不许调
 * `tick()` / `acquireFloor()`。
 *
 * <h2>对话层也归这里管</h2>
 *
 * `SessionCore` / `PhotoInbox` / 播报队列实体在 {@link DialogRuntime}（`app/dialog.ts`），
 * 生产与模拟器共用那一份。本类拿着同一个实例，负责两件只有应用层才知道的事：
 * 一轮跑起来时话筒归对话层（{@link turnStart} / {@link turnEnd}），以及卸载时
 * 把它一起收掉。**不要再在适配层另建一个状态机** —— 两套接线必然漂移。
 */
import type { Clock } from './clock.ts';
import type { DialogRuntime } from './dialog.ts';
import type { DeviceCapabilities } from '../devices/primitives.ts';
import { PetSession } from '../pet/brain/session.ts';
import type { PetParams } from '../pet/brain/registry.ts';
import type {
  AgentPort,
  DevicePort,
  FloorOwner,
  PetImage,
  PetInput,
  Voice,
} from '../pet/brain/types.ts';

/** 设备事件里应用层关心的部分。 */
export type AppDeviceEvent =
  | { readonly kind: 'presence'; readonly wearing: boolean | null }
  | { readonly kind: 'power'; readonly percent: number | null }
  | { readonly kind: 'summon'; readonly opensSession?: boolean };

export interface AppSessionOptions {
  readonly clock: Clock;
  readonly caps: DeviceCapabilities;
  readonly voice: Voice;
  readonly device: DevicePort;
  readonly agent: AgentPort;
  readonly params?: Partial<PetParams>;
  /** 心跳间隔；默认 30 s */
  readonly tickMs?: number;
  readonly onEvent?: (name: string, fields: Record<string, unknown>) => void;
  readonly dismissAnnounce?: () => void;
  readonly log?: (line: string) => void;
  /** 对话层；给了就由本类持有与释放（生产传 `DialogRuntime`，模拟器同上） */
  readonly dialog?: DialogRuntime;
}

export class AppSession {
  /** 宠物子系统。外部只读，不要直接喂输入 —— 那会绕开心跳与话筒。 */
  readonly pet: PetSession;

  private readonly clock: Clock;
  private readonly stopHeartbeat: () => void;
  /** 对话层实体；没有就是"只有宠物环"（不开主动开口时） */
  private readonly dialog: DialogRuntime | null;
  private closed = false;
  /** 现在谁占着话筒（对话层的视角；宠物自己占的不记在这里） */
  private speaker: FloorOwner | null = null;

  constructor(options: AppSessionOptions) {
    this.clock = options.clock;
    this.dialog = options.dialog ?? null;
    this.pet = new PetSession({
      caps: options.caps,
      clock: options.clock,
      voice: options.voice,
      device: options.device,
      agent: options.agent,
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.dismissAnnounce === undefined ? {} : { dismissAnnounce: options.dismissAnnounce }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    // 心跳只有这一份：适配层与模拟器都不再各自 setInterval
    this.stopHeartbeat = options.clock.every(options.tickMs ?? 30_000, () => {
      this.syncFloor();
      this.pet.tick();
    });
  }

  // ---------------------------------------------------------------- 输入面

  /**
   * 用户开口（中间结果）。
   *
   * **先喂宠物再占话筒**：宠物在朗读时听到用户开口应当判 `engaged`（用户接了话），
   * 而不是 `aborted`（被别人抢了话筒）。反过来就会把每次插话都记成被抢。
   */
  userPartial(): void {
    if (this.closed) {
      return;
    }
    this.pet.userPartial();
    this.claim('user');
  }

  /** 一句话定稿。话筒转给"应答"。 */
  userFinal(text: string): void {
    if (this.closed) {
      return;
    }
    this.pet.userFinal(text);
    this.claim('reply');
  }

  /** 设备事件。**事件之后立刻补一次心跳**，这样"刚戴回"才成立（ADR-0001 §5.2）。 */
  deviceEvent(event: AppDeviceEvent): void {
    if (this.closed) {
      return;
    }
    switch (event.kind) {
      case 'presence':
        this.pet.presence(event.wearing);
        break;
      case 'power':
        this.pet.power(event.percent);
        break;
      case 'summon':
        this.pet.summon(event.opensSession === true);
        break;
    }
    this.pet.tick();
  }

  /** 一张图到了（主动拍照的结果；`null` = 没拍到）。 */
  image(id: string, image: PetImage | null): void {
    if (this.closed) {
      return;
    }
    this.pet.image(id, image);
  }

  /**
   * 麦开了：`listen.start` 之后收到的**首帧上行音频**。
   *
   * 适配层在收到第一帧 `Audio` 时调它，不用手机回执 —— `Queued` / SAR ACK
   * 只证明命令进了队列，不证明设备在采集（ADR-0001 §5.4）。
   */
  micOpened(): void {
    if (this.closed) {
      return;
    }
    this.pet.micOpened();
  }

  /** 一轮对话开始 / 结束。对话层在跑的时候宠物不抢话筒。 */
  turnStart(): void {
    this.claim('reply');
  }

  turnEnd(): void {
    if (this.speaker === 'reply') {
      this.release('reply');
    }
  }

  /** 后台汇报排队状态。`spoken` = 刚刚播完一条（算"出过声"，推迟下次搭话）。 */
  announce(pending: boolean, spoken = false): void {
    if (this.closed) {
      return;
    }
    this.pet.announce(pending, spoken);
    if (pending) {
      this.claim('announce');
    } else if (this.speaker === 'announce') {
      this.release('announce');
    }
  }

  /** 快反射之类的短音占用。 */
  reflexStart(): void {
    this.claim('reflex');
  }

  reflexEnd(): void {
    if (this.speaker === 'reflex') {
      this.release('reflex');
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopHeartbeat();
    this.pet.close();
  }

  dispose(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.pet.dispose();
    this.dialog?.dispose();
  }

  /** 排队空且没有在途动作。 */
  isQuiet(): boolean {
    return this.pet.isIdle();
  }

  /**
   * 不会再排进新输入（**不等**在途动作）。
   *
   * 虚拟时钟的 `drain` 用这个：正在朗读的那一段本来就该等着它的计时器，
   * 拿 `isQuiet()` 当条件会死锁。
   */
  hasPendingInput(): boolean {
    return this.pet.hasPendingInput();
  }

  /** 状态快照（测试与档案用）。 */
  snapshot(): ReturnType<PetSession['snapshot']> {
    return this.pet.snapshot();
  }

  // ---------------------------------------------------------------- 话筒

  private claim(owner: FloorOwner): void {
    if (this.pet.acquireFloor(owner)) {
      this.speaker = owner;
    }
  }

  private release(owner: FloorOwner): void {
    this.pet.releaseFloor(owner);
    if (this.speaker === owner) {
      this.speaker = null;
    }
  }

  /**
   * 按对话层的状态校正话筒。
   *
   * 只处理**对话层自己**占的那些（`reply` / `announce`）；宠物占着的 `pet` 不碰 ——
   * 抢自己的话筒没有意义，还会把正在朗读的那一段切掉。
   */
  private syncFloor(): void {
    if (this.speaker === 'reply' && !this.turnBusy()) {
      this.release('reply');
    }
  }

  /** 对话层是不是在跑一轮。由 `turnStart` / `turnEnd` 维护。 */
  private turnBusy(): boolean {
    return this.speaker === 'reply';
  }
}
