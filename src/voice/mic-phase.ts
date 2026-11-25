/**
 * 一条连接上的开麦相位。
 *
 * 以前是散落的 `micPending` 布尔：`listen.start` 还没发出去就先置位，
 * 发送失败就永远停在「正在开」，`onClose` 也不叫醒等麦的人。
 * 现在只许经 {@link MicController} 迁移。宽限定时走注入的 {@link Clock}，
 * 这样 `VirtualClock` 能把 {@link CAPTURE_GRACE_MS} 一次推进，
 * `SystemClock.after` 返回的取消函数也能在收尾时清掉句柄。
 */
import type { Cancel, Clock } from '../app/clock.ts';
import type { DeviceCall } from '../devices/primitives.ts';
import { DEFAULT_PET_PARAMS } from '../pet/brain/registry.ts';
import type { VoiceSessionOptions } from './session-options.ts';

/**
 * 连接就绪时那次 `listen.start` 的时长。
 *
 * 它只是**把设备从待机叫回来**（`EXPERIMENTS §42`：0.62 s 内开始推流），
 * 之后由设备自己的会话管理接管。60 s 足够覆盖「连上了、想一下、再开口」，
 * 又不会在用户摘下眼镜后长时间占着麦克风。
 */
export const INITIAL_LISTEN_MS = 60_000;

/**
 * 连接就绪后等多久看「设备有没有在推流」。
 *
 * `EXPERIMENTS §42` 实测：手机发 `WakeUpEvent` 后 0.62 s 内就来流。所以 1.5 s
 * 足够判断"设备本来就在采集"还是"需要拉一把"。
 *
 * 太短会在设备慢启动时误判成需要唤醒（多一次无谓的 requestWakeUp），
 * 太长则首次连接要多等这么久才开麦。
 */
export const CAPTURE_GRACE_MS = 1_500;

/**
 * 连接就绪时该不该主动唤醒设备（发 `listen.start`）。
 *
 * 三条判据，从「最本质」到「最保守」：
 *
 * 1. **设备正在推流** → 不用唤醒（重连场景多半是这样）
 * 2. **明确未佩戴**（`wearing === false`）→ 不唤醒。设备不戴就不可能开麦，
 *    发出去只是白占 {@link INITIAL_LISTEN_MS} 的麦克风。真机 2026-11-22 19:19:43：
 *    未佩戴 + `listen.start{maxMs:60000}`，整段零音频帧、零 `OpenDevice`、
 *    模型一句话没说 —— 用户看到的就是「莫名其妙被拉起，却没人说话」。
 * 3. `wearing === null`（设备不报 / 还没报）→ **放行**。
 *    这里与 ADR-0001 的 `worn` 闸门方向**相反**：那边保守是「不主动开口」，
 *    这边保守必须是「开」—— 漏开的代价（用户长按没反应）比多开一次大。
 *
 * @param hasAudio 宽限期内是否收到过上行音频
 * @param wearing 设备上报的佩戴状态；`null` = 不知道
 */
export function shouldWakeOnReady(input: {
  readonly hasAudio: boolean;
  readonly wearing: boolean | null;
  readonly closed: boolean;
  readonly micPending: boolean;
}): boolean {
  if (input.closed || input.micPending || input.hasAudio) {
    return false;
  }
  return input.wearing !== false;
}

/**
 * - `idle` 还没开始等设备推流
 * - `watching` 宽限期内看设备是不是已经在采集
 * - `opening` `listen.start` **已经发出去**，在等首帧上行
 * - `open` 看到了有效上行音频
 * - `closed` 吸收态：连接收尾，不再出来
 */
export type MicPhase = 'idle' | 'watching' | 'opening' | 'open' | 'closed';

function canEnterMic(from: MicPhase, to: MicPhase): boolean {
  if (from === to) {
    return true;
  }
  if (to === 'closed') {
    return true;
  }
  switch (from) {
    case 'idle':
      return to === 'watching' || to === 'opening';
    case 'watching':
      return to === 'opening' || to === 'open';
    case 'opening':
      return to === 'open' || to === 'idle';
    case 'open':
      return to === 'opening';
    case 'closed':
      return false;
    default:
      return false;
  }
}

/**
 * 播报开麦后还要听多久。
 *
 * `params.listenMs` 是宠物参数上的显式值，优先用它。没有的话用这一层的
 * `listenMs`——启动程序把 `PET_LISTEN_MS` 放在这里，不放进 `params`。
 * 两边都没有才落到默认 8 s。只读默认值会让环境变量对播报开麦完全失效。
 */
export function announceListenMs(
  proactive: VoiceSessionOptions['proactive'],
): number {
  return proactive?.params?.listenMs
    ?? proactive?.listenMs
    ?? DEFAULT_PET_PARAMS.listenMs;
}

/**
 * 开麦相位机向外要的端口。
 *
 * `sendCall` 是设备层那一份：字节真发出去之后由它调 {@link MicController.noteListenSent}。
 * 这里不再抄一份电量 / 佩戴，`wearing()` 读设备状态的当前值。
 */
export interface MicPorts {
  readonly clock: Clock;
  wearing(): boolean | null;
  connClosed(): boolean;
  sendCall(call: DeviceCall): boolean;
  /** 相位进入 `open` 之后：记档、通知应用层。等麦的人已经先被叫醒。 */
  onOpened(): void;
}

/**
 * 开麦相位的唯一写入点。
 *
 * `beginClose()` 只挡住后续 `listen.start`（告别那 250 ms、被新连接顶掉）。
 * `absorb()` 才进入 `closed` 并叫醒还在等首帧的人。
 */
export class MicController {
  private readonly ports: MicPorts;
  private micPhase: MicPhase = 'idle';
  /**
   * 相位代次。每次真正迁出一格就 +1。
   *
   * 宽限定时器和等麦超时都抓住自己登记时的代次：恢复时对不上，
   * 或已经停在 `closed`，这次回调作废。
   */
  private micEpoch = 0;
  /** `end_session` 已发出、socket 还没关。这段时间拒绝 `listen.start`。 */
  private linkClosing = false;
  /** 等首帧上行的人。参数是「麦开了没有」。 */
  private micWaiters: Array<(opened: boolean) => void> = [];
  /**
   * 连接就绪后观察「设备到底在不在采集」的定时器。
   *
   * 到期时还没收到任何上行音频，才发 `listen.start` 把它拉起来。收到帧就取消
   * （说明设备已经在推流，不需要唤醒 —— 重连场景多半是这样）。
   */
  private captureCancel: Cancel | null = null;

  constructor(ports: MicPorts) {
    this.ports = ports;
  }

  get phase(): MicPhase {
    return this.micPhase;
  }

  /** `closing` / `closed`：半关、对端已关、或开麦相位已经吸收。 */
  listenStartBlocked(): boolean {
    return this.linkClosing || this.micPhase === 'closed' || this.ports.connClosed();
  }

  /**
   * `listen.start` / `listen.stop` 只有在字节真的交出去之后才改相位。
   *
   * 开麦成功 → `opening`（等首帧）。关麦成功且还在等首帧 → 回到 `idle`，
   * 并把等待者按「这次开麦结束」放开，避免再耗满超时。
   */
  noteListenSent(call: DeviceCall): void {
    if (call.op === 'listen.start') {
      this.enterMic('opening');
      return;
    }
    if (call.op !== 'listen.stop' || this.micPhase === 'closed') {
      return;
    }
    if (this.micPhase === 'opening') {
      this.enterMic('idle');
    }
    this.resolveMicWaiters(true);
  }

  /**
   * 开始等设备的第一帧上行音频。
   *
   * 为什么不是"连接就绪就开麦"：那样每次网络抖动重连都会唤醒眼镜（亮灯、耗电、
   * 可能还有提示音），而那一刻根本没人在说话。
   *
   * 为什么不干脆"重连就跳过"：设备侧的 Aivs 会话可能已经自毁（真机 `会话状态 3`
   * 后采集停止），那种情况下不唤醒就是「未响应」。
   *
   * 判据只能是设备有没有在推流 —— 等 {@link CAPTURE_GRACE_MS} 看有没有帧；
   * 到期要不要开麦交给 {@link shouldWakeOnReady}（它还看佩戴）。
   */
  armCaptureWatch(resumed: boolean): void {
    if (this.listenStartBlocked() || !this.enterMic('watching')) {
      return;
    }
    const epoch = this.micEpoch;
    const why = resumed ? '自动重连' : '连接就绪';
    this.captureCancel = this.ports.clock.after(CAPTURE_GRACE_MS, () => {
      this.captureCancel = null;
      // 代次或相位变了（已开、已关、已经在开）就别再补一发 listen.start
      if (this.micEpoch !== epoch || this.micPhase !== 'watching' || this.listenStartBlocked()) {
        return;
      }
      if (!shouldWakeOnReady({
        hasAudio: false, // 收到帧时 watch 已被 noteUplinkAudio 取消，走到这里就是没帧
        wearing: this.ports.wearing(),
        closed: this.ports.connClosed() || this.linkClosing,
        // 能走到这里相位仍是 watching；opening 已在上面返回
        micPending: false,
      })) {
        if (this.ports.wearing() === false) {
          console.log(`  开麦    ${why}且 ${CAPTURE_GRACE_MS} ms 无上行音频，但设备未佩戴 → 不唤醒`);
        }
        return;
      }
      console.log(`  开麦    ${why}但 ${CAPTURE_GRACE_MS} ms 内没有上行音频 → 请设备推流（§42）`);
      this.sendListenStart();
    });
  }

  /**
   * 有效上行音频。空载荷由调用方滤掉：空帧不是「设备在采集」的证据。
   *
   * 只在 `watching` / `opening` 时算一次：已经 `open` 的后续帧属于对话层，
   * `listen.stop` 回到 `idle` 之后再来的音频也不算「这一轮开麦成功」。
   */
  noteUplinkAudio(): void {
    if (this.micPhase !== 'watching' && this.micPhase !== 'opening') {
      return;
    }
    const armed = this.captureCancel !== null;
    this.clearCaptureWatch();
    if (armed) {
      console.log('  开麦    设备已在推流 → 不主动唤醒');
    }
    if (!this.enterMic('open')) {
      return;
    }
    this.resolveMicWaiters(true);
    this.ports.onOpened();
  }

  /**
   * 等麦开，最多 `timeoutMs`。
   *
   * 播报用（ADR-0001 §6）：设备支持 `listen.start` 时，播报也先开麦再开口，
   * 这样播报一开口就能被插话；超时照播。连接收尾时立刻以 `false` 醒来，
   * 不再耗满 `micOpenTimeoutMs`。
   */
  awaitMicOpen(timeoutMs: number): Promise<boolean> {
    if (this.micPhase === 'open') {
      return Promise.resolve(true);
    }
    if (this.micPhase !== 'opening') {
      return Promise.resolve(false);
    }
    const epoch = this.micEpoch;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (opened: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancel();
        resolve(opened);
      };
      const cancel = this.ports.clock.after(timeoutMs, () => {
        // 成功由 noteUplinkAudio 同步叫醒并取消这个定时器。
        // 走到这里只有两种情况，都是「这次没开成」：
        // 代次已经离开当时那次 opening，或者还停在 opening 但等到了超时。
        if (this.micEpoch !== epoch || this.micPhase !== 'opening') {
          finish(false);
          return;
        }
        finish(false);
      });
      this.micWaiters.push((opened) => {
        // 显式叫醒以参数为准。closed 是吸收态，迟到的 true 也不许报开麦成功。
        finish(this.micPhase === 'closed' ? false : opened);
      });
    });
  }

  /** `evict` / `onClose` / 告别：从这一刻起拒绝 `listen.start`。 */
  beginClose(): void {
    this.linkClosing = true;
  }

  /**
   * `onClose`：进入吸收态，清掉宽限定时器，立刻以 `false` 叫醒等麦的人。
   */
  absorb(): void {
    this.enterMic('closed');
    this.clearCaptureWatch();
    this.resolveMicWaiters(false);
  }

  /** 开麦相位的唯一写入点。非法迁移打日志并保持原状。`closed` 是吸收态。 */
  private enterMic(next: MicPhase): boolean {
    if (this.micPhase === next) {
      return true;
    }
    if (!canEnterMic(this.micPhase, next)) {
      console.error(`  开麦    拒绝 ${this.micPhase} → ${next}`);
      return false;
    }
    this.micPhase = next;
    this.micEpoch += 1;
    return true;
  }

  /**
   * 发一次 `listen.start`。
   *
   * 相位要等 `sendCall` 里的 {@link noteListenSent}：发送失败不能先进入 `opening`。
   */
  private sendListenStart(): void {
    if (this.listenStartBlocked()) {
      return;
    }
    this.ports.sendCall({ op: 'listen.start', maxMs: INITIAL_LISTEN_MS });
  }

  private clearCaptureWatch(): void {
    if (this.captureCancel !== null) {
      this.captureCancel();
      this.captureCancel = null;
    }
  }

  private resolveMicWaiters(opened: boolean): void {
    const waiters = this.micWaiters;
    this.micWaiters = [];
    for (const resolve of waiters) {
      resolve(opened);
    }
  }
}
