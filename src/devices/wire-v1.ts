/**
 * v1 线协议的**垫片**：旧手机只会 `Control` 控制串 / `Status` 状态事件，
 * 不发能力、不带请求 id。这里把它翻译成原语，业务只认原语。
 *
 * v1 只有小米手机端在说。等手机端改说新协议（`Hello` 自报能力 + 带 id 的帧），
 * 这个文件和 `xiaomi.ts` 一起删掉。
 *
 * v1 的硬限制，翻译时不假装没有：
 * - **没有请求 id**：一条连接同时只有一个拍照在途，图和状态都归它
 * - **高清图靠公告关联**：`hq_image` 之后的那一帧图才是原图；等快门期间相机
 *   顺手回的低清图不属于任何请求（实测把 17 KB 的糊图当原图交付过）
 * - **取消没有回执**：取消之后迟到的那一帧图要吃掉，不能当成「看一眼」
 * - **没有开麦动词**：`listen.start` 表达不了
 *
 * 因为拿不到 id，归属只能靠「上一趟请求的图一定先于下一趟到达」这条顺序假设：
 * 公告过的、取消掉的图都排在在途请求之前认领（见 {@link V1Session.image}）。
 * 一句话：**宁可让新请求超时，也不把旧图当新图交出去。**
 */
import type {
  CaptureErrorCode,
  CaptureIntent,
  DeviceCall,
  DeviceCapabilities,
  DeviceEvent,
} from './primitives.ts';

/** 任何 v1 手机都保证的能力：mSBC 上行、低清直出，别的都没有。 */
export const V1_BASELINE: DeviceCapabilities = {
  audioIn: 'msbc',
  capture: { glance: { needsUser: false } },
  presence: false,
  power: false,
  summon: false,
  listenStart: false,
  played: false,
  ignorePhrases: [],
};

/** v1 手机说不出来的那几句话，由垫片代说。 */
export interface V1Phrases {
  /** 要等用户动手时念的一句 */
  readonly waitingSay?: string;
  /** v1 失败原因 → 一句给用户的原因 */
  readonly failureSay?: (reason: string) => string | undefined;
}

/** v1 失败原因 → 失败码。原因本身由 {@link V1Phrases.failureSay} 翻成人话。 */
export function v1FailureCode(reason: string): CaptureErrorCode {
  switch (reason) {
    case 'cancelled':
      return 'cancelled';
    case 'busy':
      return 'busy';
    case 'no_shutter':
    case 'no_arm':
    case 'timeout':
      return 'timeout';
    default:
      return 'failed';
  }
}

/** 一条状态帧的翻译结果：`known=false` 表示 v1 里也没有这个事件。 */
export interface V1StatusResult {
  readonly known: boolean;
  readonly event: DeviceEvent | null;
}

/** 一条连接上的 v1 翻译状态（在途请求、高清公告、取消后的迟到图）。 */
export class V1Session {
  private readonly phrases: V1Phrases;
  /** 正在等的拍照 */
  private inflight: { readonly id: string; readonly intent: CaptureIntent } | null = null;
  /** 收到过 `hq_image`：下一帧图属于这个 id */
  private announcedId: string | null = null;
  /** 取消过一次高清：下一帧迟到的图归这个已作废的 id（让收件箱吃掉） */
  private cancelledId: string | null = null;

  constructor(phrases: V1Phrases = {}) {
    this.phrases = phrases;
  }

  /**
   * 原语操作 → 控制串，并记下关联状态。
   *
   * @returns v1 表达不了时返回 `null`（调用方应跳过，而不是硬凑）
   */
  encode(call: DeviceCall): string | null {
    switch (call.op) {
      case 'audio.stop':
        return 'stop';
      case 'listen.stop':
        return 'stop_capture';
      case 'session.end':
        return 'end_session';
      case 'listen.start':
        return null;
      case 'capture':
        this.inflight = { id: call.id, intent: call.intent };
        // 上一次的公告与取消残留**不清**：那两帧可能还在链路上，清掉就会把旧图
        // 认给这个新请求。顺序假设见类注释。
        return call.intent === 'detail' ? 'take_photo_hq' : 'take_photo';
      case 'capture.cancel':
        // id 对不上就是作废的取消：不能下发 —— 否则设备侧取消的是**新**请求
        if (this.inflight?.id !== call.id) {
          return null;
        }
        if (this.inflight.intent === 'detail') {
          this.cancelledId = call.id;
        }
        this.inflight = null;
        return 'hq_cancel';
    }
  }

  /**
   * 请求已经有了结局（成功 / 超时 / 失败），它不再等在途。
   *
   * **只清 `inflight`**：公告过或取消掉的图可能还在链路上，那一帧仍旧要归旧 id
   * （让收件箱吃掉），清掉残留就会把它认给下一个请求。
   */
  forget(id: string): void {
    if (this.inflight?.id === id) {
      this.inflight = null;
    }
  }

  /** `Status` 帧（JSON）→ 原语事件。 */
  status(json: Record<string, unknown>): V1StatusResult {
    const name = json['ev'];
    const id = this.inflight?.id ?? this.cancelledId;
    switch (name) {
      case 'hq_armed': {
        // fresh=true：相机里已经有新图，不用等人
        const fresh = json['fresh'] === true || json['fresh'] === 'true';
        if (fresh || id === null) {
          return { known: true, event: null };
        }
        return {
          known: true,
          event: {
            kind: 'capture.waiting',
            id,
            ...(this.phrases.waitingSay === undefined ? {} : { say: this.phrases.waitingSay }),
          },
        };
      }
      case 'hq_image':
        this.announcedId = id;
        return { known: true, event: null };
      case 'hq_failed': {
        if (id === null) {
          return { known: true, event: null };
        }
        // 设备给了结局：这一趟不会再有迟到的图，取消残留到此为止
        if (this.cancelledId === id) {
          this.cancelledId = null;
        }
        const reason = typeof json['reason'] === 'string' ? json['reason'] : 'timeout';
        const say = this.phrases.failureSay?.(reason);
        return {
          known: true,
          event: {
            kind: 'capture.failed',
            id,
            code: v1FailureCode(reason),
            ...(say === undefined ? {} : { say }),
          },
        };
      }
      default:
        return { known: false, event: null };
    }
  }

  /**
   * 一帧图属于哪个请求。
   *
   * 认领顺序固定：**公告的高清 → 取消后的迟到图 → 在途 glance 的第一帧**。
   * v1 按序处理命令，旧请求的回图一定先于新请求到达，所以先认领旧请求的。
   *
   * @returns 请求 id；`null` = 不属于任何请求（用户自己拍的，或等快门时的低清回图）
   */
  image(): string | null {
    if (this.announcedId !== null) {
      const id = this.announcedId;
      this.announcedId = null;
      return id;
    }
    if (this.cancelledId !== null) {
      const id = this.cancelledId;
      this.cancelledId = null;
      return id;
    }
    const inflight = this.inflight;
    if (inflight !== null && inflight.intent === 'glance') {
      // 低清直出没有公告，到的第一帧就是它。
      // **一趟 glance 只回一帧**：认领即结束 —— 留着它，这次请求结束（成功、超时
      // 或取消）之后用户自己拍的图都会被当成它的迟到图吃掉，再也起不了识图轮。
      this.inflight = null;
      return inflight.id;
    }
    return null;
  }
}
