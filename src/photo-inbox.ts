/**
 * 拍照收件箱：把「请设备拍一张」变成一次可等待、可超时、可取消的 `capture` 调用。
 *
 * 只认原语（`DeviceCall` / `DeviceEvent` / 带 id 的图像帧）。图属于哪个请求
 * 由线协议层决定（v1 靠 `hq_image` 公告，新协议直接带 id），这里只按 id 认领。
 *
 * <h2>流程</h2>
 *
 * ```text
 * needsUser=false ──发 capture──▶ 等图（timeoutMs）
 * needsUser=true  ──发 capture──▶ 等图（confirmTimeoutMs）
 *   capture.waiting ────────────▶ 照念设备给的提示（只念一次）
 *   capture.failed ─────────────▶ 立刻收尾，不让调用方干等到超时
 * ```
 *
 * 分段计时（等设备就绪 / 等人按快门）是设备侧的事：设备自己会先超时并上报原因，
 * 插件这里只有一个兜底总时长。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CaptureFailure, CaptureIntent, DeviceCall, DeviceEvent } from './devices/primitives.ts';
import type { Clock } from './app/clock.ts';

export type PhotoOutcome =
  | { readonly ok: true; readonly jpeg: Buffer }
  | { readonly ok: false; readonly failure: CaptureFailure };

export interface CaptureRequest {
  /** 关联 id；取消、事件、图像帧都按它匹配 */
  readonly id: string;
  readonly intent: CaptureIntent;
  /** 这一档要不要用户在设备上动手 —— 决定兜底时长与要不要下发取消 */
  readonly needsUser: boolean;
}

/** 不用人动手时的兜底总时长（低清直出 1–3 s 就有） */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
/**
 * 要人动手时的兜底总时长。
 *
 * 小米实测：建组 + 入组 + 连相册 5.4 s，等按快门手机自己 20 s 放弃并上报；
 * 正常情况下永远是设备的原因先到，这里只是「设备也没消息」的兜底。
 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 40_000;

export interface PhotoInboxOptions {
  /** 时钟端口：超时走它（模拟器要用虚拟时间） */
  readonly clock: Clock;
  /** 落盘目录；空串不落盘（默认） */
  readonly dir: string;
  /** 不用人动手时的兜底总时长 */
  readonly timeoutMs: number;
  /** 要人动手时的兜底总时长 */
  readonly confirmTimeoutMs: number;
  readonly log: (line: string) => void;
  /** 下发一次操作。返回 false 表示设备 / 协议表达不了 */
  readonly send: (call: DeviceCall) => boolean;
}

interface Waiter {
  readonly request: CaptureRequest;
  resolve: (outcome: PhotoOutcome) => void;
  /** 取消兜底计时 */
  cancelTimer: () => void;
  /** 设备的提示已经念过 */
  prompted: boolean;
}

export class PhotoInbox {
  private readonly options: PhotoInboxOptions;
  private waiter: Waiter | null = null;
  /** 吸收态：`dispose()` 之后不再接新请求，也不再武装定时器 */
  private disposed = false;

  constructor(options: PhotoInboxOptions) {
    this.options = options;
  }

  get isWaiting(): boolean {
    return this.waiter !== null;
  }

  /** 正在等哪个请求；没人等返回 null */
  get waitingId(): string | null {
    return this.waiter?.request.id ?? null;
  }

  /** 这类请求的兜底总时长（给工具口的 HTTP 超时对齐用） */
  timeoutFor(needsUser: boolean): number {
    return needsUser ? this.options.confirmTimeoutMs : this.options.timeoutMs;
  }

  /**
   * 等一张图。
   *
   * 已经有请求在等时立刻返回 `busy`（不排队，避免两次请求抢一张图）。
   */
  request(request: CaptureRequest): Promise<PhotoOutcome> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, failure: { code: 'cancelled' } });
    }
    if (this.waiter !== null) {
      this.options.log('  拍照    ⚠ 已有请求在等图，本次拒绝（busy）');
      return Promise.resolve({ ok: false, failure: { code: 'busy' } });
    }

    const deadlineMs = this.timeoutFor(request.needsUser);
    return new Promise<PhotoOutcome>((resolve) => {
      const cancelTimer = this.options.clock.after(deadlineMs, () => { this.expire(); });
      this.waiter = { request, resolve, cancelTimer, prompted: false };

      const sent = this.options.send({
        op: 'capture',
        id: request.id,
        intent: request.intent,
        deadlineMs,
      });
      if (!sent) {
        this.settle({ ok: false, failure: { code: 'unsupported' } });
        return;
      }
      this.options.log(
        `  拍照    已下发 ${request.intent}`
        + (request.needsUser ? '（需要用户在设备上动手）' : '（直接拍，等图）'),
      );
    });
  }

  /**
   * 设备的拍照事件。
   *
   * @returns 需要念给用户的一句提示（只在第一次 `capture.waiting` 时给）；否则 `null`
   */
  onEvent(event: DeviceEvent): string | null {
    const waiter = this.waiter;
    if (waiter === null) {
      return null;
    }
    if (event.kind === 'capture.waiting' && event.id === waiter.request.id) {
      this.options.log('  拍照    设备在等用户动手');
      if (waiter.prompted || event.say === undefined) {
        return null;
      }
      waiter.prompted = true;
      return event.say;
    }
    if (event.kind === 'capture.failed' && event.id === waiter.request.id) {
      this.options.log(`  拍照    ✗ 设备上报失败：${event.code}${event.say === undefined ? '' : `（${event.say}）`}`);
      this.settle({
        ok: false,
        failure: { code: event.code, ...(event.say === undefined ? {} : { say: event.say }) },
      });
    }
    return null;
  }

  /** 取消（用户改主意 / 会话收尾）：要人动手的流程才下发 `capture.cancel`。 */
  cancel(why: string): void {
    const waiter = this.waiter;
    if (waiter === null) {
      return;
    }
    this.options.log(`  拍照    取消（${why}）`);
    if (waiter.request.needsUser) {
      this.options.send({ op: 'capture.cancel', id: waiter.request.id });
    }
    this.settle({ ok: false, failure: { code: 'cancelled' } });
  }

  /**
   * 收到一张图。
   *
   * @param id - 线协议层给出的归属；`null` = 不属于任何请求
   * @returns true 表示已消化（交付或有意丢弃）；false 表示是用户自己拍的，
   *          调用方可以当成「看一眼」起一轮
   */
  deliver(id: string | null, jpeg: Buffer): boolean {
    const waiter = this.waiter;
    if (waiter !== null && id === waiter.request.id) {
      this.persist(waiter.request.intent, jpeg);
      this.settle({ ok: true, jpeg });
      return true;
    }
    if (id !== null) {
      this.options.log(`  拍照    （丢弃迟到的图 ${jpeg.length} B，请求 ${id} 已经结束）`);
      return true;
    }
    if (waiter !== null) {
      // 等图期间收到不属于请求的图（小米按快门时相机顺手回的低清图）：不交付，也不另起一轮
      this.options.log(`  拍照    （等图时收到非预期图 ${jpeg.length} B，丢弃）`);
      return true;
    }
    this.persist('unsolicited', jpeg);
    return false;
  }

  /** 连接结束时清干净：否则定时器会拖住进程。置位之后 `request` 不再武装定时器。 */
  dispose(): void {
    this.disposed = true;
    this.settle({ ok: false, failure: { code: 'cancelled' } });
  }

  private expire(): void {
    if (this.waiter === null) {
      return;
    }
    this.options.log('  拍照    ✗ 设备一直没给结果（本地兜底超时）');
    this.settle({ ok: false, failure: { code: 'timeout' } });
  }

  private settle(outcome: PhotoOutcome): boolean {
    const waiter = this.waiter;
    if (waiter === null) {
      return false;
    }
    this.waiter = null;
    waiter.cancelTimer();
    waiter.resolve(outcome);
    return true;
  }

  private persist(tag: string, jpeg: Buffer): void {
    const { dir, log } = this.options;
    if (!dir) {
      return;
    }
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `photo_${tag}_${this.options.clock.now()}.jpg`);
      writeFileSync(file, jpeg);
      log(`  图片    ${jpeg.length} B  ${file}`);
    } catch (error) {
      log(`  ✗ 图片落盘失败: ${(error as Error).message}`);
    }
  }
}
