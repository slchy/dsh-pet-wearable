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
 * 它们原先各有两份：生产在 `voice-session.ts`，模拟在 `harness.ts`。两份一定会漂移，
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
import type { DialogState } from '../dialog-fsm.ts';
import type { DeviceCapabilities } from '../devices/primitives.ts';
import { FloorArbiter } from '../pet/brain/floor.ts';
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
  /**
   * 要不要建宠物子系统（默认 true）。
   *
   * 关掉时**仍然会有 `FloorArbiter`** —— 话筒归属是应用层的事，不是宠物的附属品：
   * `user` / `reply` / `announce` 三个占用者必须在同一张表里仲裁，否则
   * 「用户说话时旁白还在念」这类问题又得靠特判。
   */
  readonly pet?: boolean;
  /** 心跳间隔；默认 30 s */
  readonly tickMs?: number;
  readonly onEvent?: (name: string, fields: Record<string, unknown>) => void;
  readonly dismissAnnounce?: () => void;
  readonly log?: (line: string) => void;
  /** 对话层；给了就由本类持有与释放（生产传 `DialogRuntime`，模拟器同上） */
  readonly dialog?: DialogRuntime;
}

export class AppSession {
  /**
   * 宠物子系统。外部只读，不要直接喂输入 —— 那会绕开心跳与话筒。
   * `null` = 这套配置不要宠物（`pet: false`），但话筒照常仲裁。
   */
  readonly pet: PetSession | null;

  /**
   * **话筒的唯一真相**（ADR-0001 §6）。应用层持有，宠物通过 `pet.floor` 读同一个实例。
   *
   * 谁占着 → `floor.owner`；要是空着 → `null`。宠物环里的 `floorOwner` 只是这份真相的投影：
   * 对话、播报、宠物每申请或释放一次，都要把 `{ busy, owner }` 同步过去。
   */
  readonly floor: FloorArbiter;

  private readonly clock: Clock;
  private readonly stopHeartbeat: () => void;
  /** 对话层实体；没有就是"只有宠物环"（不开主动开口时） */
  private readonly dialog: DialogRuntime | null;
  /**
   * 对话相位的唯一副本，**只**由 {@link onDialogState} 写入。
   *
   * 播报能不能占 `announce`、思考期能不能把话筒放空，都看这一份。
   * 另存一个布尔会和状态机各说各的，finally 一释放就把思考期的话筒放成 `null`。
   */
  private dialogPhase: DialogState = 'listening';
  private closed = false;

  constructor(options: AppSessionOptions) {
    this.clock = options.clock;
    this.dialog = options.dialog ?? null;
    this.floor = new FloorArbiter();
    this.pet = options.pet === false
      ? null
      : new PetSession({
        caps: options.caps,
        clock: options.clock,
        voice: options.voice,
        device: options.device,
        agent: options.agent,
        floor: this.floor,
        ...(options.params === undefined ? {} : { params: options.params }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        ...(options.dismissAnnounce === undefined ? {} : { dismissAnnounce: options.dismissAnnounce }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
    // 心跳只有这一份：适配层与模拟器都不再各自 setInterval
    this.stopHeartbeat = options.clock.every(options.tickMs ?? 30_000, () => {
      this.pet?.tick();
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
    this.pet?.userPartial();
    this.claim('user');
  }

  /** 一句话定稿。话筒**移交**给"应答"（`reply` 抢不动 `user`，只能由 `user` 交出来）。 */
  userFinal(text: string): void {
    if (this.closed) {
      return;
    }
    this.pet?.userFinal(text);
    this.handToReply();
  }

  /** 设备事件。**事件之后立刻补一次心跳**，这样"刚戴回"才成立（ADR-0001 §5.2）。 */
  deviceEvent(event: AppDeviceEvent): void {
    if (this.closed || this.pet === null) {
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
    this.pet?.image(id, image);
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
    this.pet?.micOpened();
  }

  /**
   * 对话状态机转移后回调（`DialogRuntime` 每次 `dispatch` 之后调一次）。
   *
   * **话筒的占用/释放由这里驱动**，不再靠心跳里按布尔量校正：
   *
   * | FSM 状态 | 话筒 |
   * |---|---|
   * | `thinking` / `speaking` | 必为 `reply`。当前是 `user` 或 `announce` 时移交，不许申请失败后留在原地 |
   * | `listening` / `ending` / `closed` | 释放 `reply` |
   * | `awaiting_shot` | 空着就空着；`user` / `announce` 移交成 `reply`，免得播报占着等快门 |
   */
  onDialogState(state: DialogState): void {
    if (this.closed) {
      return;
    }
    this.dialogPhase = state;
    switch (state) {
      case 'thinking':
      case 'speaking':
        // 直接 prompt 进来的轮次没有 user 阶段，`handToReply` 会自己去申请
        this.handToReply();
        return;
      case 'listening':
      case 'ending':
      case 'closed':
        this.release('reply');
        return;
      case 'awaiting_shot':
        this.handForegroundMic();
        return;
    }
  }

  /**
   * 一轮对话开始 / 结束。
   *
   * 生产由 {@link onDialogState} 驱动；这两个方法留给**模拟器**（`pet/sim/dialog.ts`
   * 自己那套驱动）和直接调用方。重复调用无害：`acquire` 同一个人是幂等，
   * 移交时 `from` 已经不对就返回 `false`。
   */
  turnStart(): void {
    this.handToReply();
  }

  turnEnd(): void {
    this.release('reply');
  }

  /**
   * 后台汇报排队状态。`spoken` = 刚刚播完一条（算"出过声"，推迟下次搭话）。
   *
   * `pending` 只说明队列里还有没有货，不是「现在去抢话筒」：
   *
   * - 只有前台真的空闲（`listening`）才申请 `announce`
   * - `thinking` / `speaking` 期间话筒必须是 `reply`，不许放成 `null`，也不许被播报抢回去
   * - 宠物只在真正占上、或合法排队等待时才收到 `announcePending`
   */
  announce(pending: boolean, spoken = false): void {
    if (this.closed) {
      return;
    }
    if (!pending) {
      this.releaseAnnounceKeepingReply();
      this.pet?.announce(false, spoken);
      return;
    }
    if (this.dialogPhase === 'listening') {
      const held = this.claim('announce');
      // 没占上但话筒在别人手里：播报在排队，不是被丢掉
      if (held || this.currentOwner() !== null) {
        this.pet?.announce(true, spoken);
      }
      return;
    }
    this.keepReplyWhileForegroundBusy();
    // 前台正忙，队列还在：合法等待。告诉宠物让位，但不去 `claim('announce')`
    this.pet?.announce(true, spoken);
  }

  /** 快反射之类的短音占用。 */
  reflexStart(): void {
    this.claim('reflex');
  }

  reflexEnd(): void {
    this.release('reflex');
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopHeartbeat();
    // 宠物在的时候由它同步收口：清同一个仲裁器、把 `closed` 记进大脑、当场 `listen.stop`。
    // 这里再 `clear` 一次，覆盖没装宠物的配置。
    this.pet?.close();
    this.floor.clear();
  }

  dispose(): void {
    this.closed = true;
    this.stopHeartbeat();
    // 吸收态在 `PetSession.dispose` 里同步置上。麦若还开着，那里会先停再拆，
    // 不把 `listen.stop` 留到微任务。
    this.pet?.dispose();
    this.dialog?.dispose();
    this.floor.clear();
  }

  /** 排队空且没有在途动作。没有宠物时恒为"安静"。 */
  isQuiet(): boolean {
    return this.pet === null || this.pet.isIdle();
  }

  /**
   * 不会再排进新输入（**不等**在途动作）。
   *
   * 虚拟时钟的 `drain` 用这个：正在朗读的那一段本来就该等着它的计时器，
   * 拿 `isQuiet()` 当条件会死锁。
   */
  hasPendingInput(): boolean {
    return this.pet !== null && this.pet.hasPendingInput();
  }

  /** 状态快照（测试与档案用）。没有宠物时返回 `null`。 */
  snapshot(): ReturnType<PetSession['snapshot']> | null {
    return this.pet?.snapshot() ?? null;
  }

  // ---------------------------------------------------------------- 话筒

  /**
   * 申请（会走抢占表）。宠物在的时候经它转一手，好让它看到 `floorBusy` 变化。
   *
   * @returns 拿到话筒没有。失败必须交还给调用方 —— 吞掉的话，思考期申请
   * `reply` 失败后播报一释放，话筒就是 `null`，宠物会叠着抢话。
   */
  private claim(owner: FloorOwner): boolean {
    if (this.pet === null) {
      return this.floor.acquire(owner);
    }
    return this.pet.acquireFloor(owner);
  }

  private release(owner: FloorOwner): void {
    if (this.pet === null) {
      this.floor.release(owner);
      return;
    }
    this.pet.releaseFloor(owner);
  }

  /** `from` 主动交给 `to`，不走抢占表，中间不经过 `null`。 */
  private transfer(from: FloorOwner, to: FloorOwner): boolean {
    if (this.pet === null) {
      return this.floor.handoff(from, to);
    }
    return this.pet.handoffFloor(from, to);
  }

  /**
   * 前台应答占住话筒。
   *
   * 当前是 `user` 或 `announce` 时**无条件移交**（`user` 不可抢；`announce` 若先
   * 释放再申请，会闪一帧 `null`）。其它占用者才走抢占表。
   */
  private handToReply(): boolean {
    const owner = this.currentOwner();
    if (owner === 'reply') {
      return true;
    }
    if (owner === 'user' || owner === 'announce') {
      if (this.transfer(owner, 'reply')) {
        return true;
      }
    }
    return this.claim('reply');
  }

  /** `awaiting_shot`：只把 `user` / `announce` 交出去，空话筒保持空。 */
  private handForegroundMic(): boolean {
    const owner = this.currentOwner();
    if (owner === 'user' || owner === 'announce') {
      return this.transfer(owner, 'reply');
    }
    return owner === 'reply';
  }

  /**
   * 播报说完了。思考 / 播音 / 等快门时，若手里还是 `announce`，移交给 `reply`，
   * 不许 `release` 成 `null`。本来就空着的 `thinking` / `speaking` 也要补上 `reply`。
   */
  private releaseAnnounceKeepingReply(): void {
    const cover = this.dialogPhase === 'thinking'
      || this.dialogPhase === 'speaking'
      || this.dialogPhase === 'awaiting_shot';
    if (this.currentOwner() === 'announce' && cover) {
      this.transfer('announce', 'reply');
      return;
    }
    this.release('announce');
    if (
      (this.dialogPhase === 'thinking' || this.dialogPhase === 'speaking')
      && this.currentOwner() === null
    ) {
      this.claim('reply');
    }
  }

  /**
   * 队列还有货，但前台已经不是 `listening`：不要去抢 `announce`。
   * `thinking` / `speaking` 若空着或仍被播报占着，补成 `reply`。
   */
  private keepReplyWhileForegroundBusy(): void {
    const owner = this.currentOwner();
    if (this.dialogPhase === 'thinking' || this.dialogPhase === 'speaking') {
      if (owner === 'announce') {
        this.transfer('announce', 'reply');
        return;
      }
      if (owner === null) {
        this.claim('reply');
      }
      return;
    }
    if (this.dialogPhase === 'awaiting_shot' && owner === 'announce') {
      this.transfer('announce', 'reply');
    }
  }

  private currentOwner(): FloorOwner | null {
    return this.pet === null ? this.floor.owner : this.pet.floor.owner;
  }
}
