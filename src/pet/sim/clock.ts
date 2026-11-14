/**
 * 虚拟时钟：最小堆 + `(at, seq)` 排序 + 宏任务排空。
 *
 * 对应 ADR-0002 §3.2。纪律：
 * - 并列规则**只有一条**：同一时刻按登记顺序触发（`seq` 递增）。
 * - `runUntil` 每轮先 `drain()` 再取最早的计时器，所以"回调里又登记了更早的计时器"
 *   也会被正确插队。
 * - `drain()` 用宏任务边界，不设固定次数上限（ADR-0002 P4 的修法）。
 * - `localHour` 由「起始墙钟 + 已走过的虚拟时间」推出，**不单独拨**：
 *   跨过 23 点自然进入深夜，场景不用手改。
 */
import type { Cancel, Clock } from '../../app/clock.ts';

interface Timer {
  at: number;
  seq: number;
  readonly fn: () => void;
  cancelled: boolean;
  /** `every` 的周期；`null` = 一次性 */
  readonly period: number | null;
}

export class VirtualClock implements Clock {
  private t: number;
  private seq = 0;
  private readonly startMinute: number;
  private readonly timers: Timer[] = [];
  /** 登记计数：判"这一轮有没有新登记" */
  private registered = 0;

  /**
   * @param startAt 起始单调时刻（通常 0）
   * @param startMinute 起始墙钟（一天里的第几分钟，0–1439）
   */
  constructor(startAt = 0, startMinute = 12 * 60) {
    this.t = startAt;
    this.startMinute = startMinute;
  }

  now(): number {
    return this.t;
  }

  /**
   * 本地小时 = 起始墙钟 + 已走过的虚拟时间。
   *
   * 按**分钟**累加而不是按小时取整：22:40 起跑 20 分钟后就是 23:00，
   * 不这样的话"跨进深夜"要等整整一小时。
   */
  localHour(): number {
    const minutes = this.startMinute + Math.floor(this.t / 60_000);
    return ((Math.floor(minutes / 60) % 24) + 24) % 24;
  }

  after(ms: number, fn: () => void): Cancel {
    return this.schedule(ms, fn, null);
  }

  every(ms: number, fn: () => void): Cancel {
    return this.schedule(ms, fn, ms);
  }

  private schedule(ms: number, fn: () => void, period: number | null): Cancel {
    this.seq += 1;
    this.registered += 1;
    const timer: Timer = { at: this.t + ms, seq: this.seq, fn, cancelled: false, period };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  }

  /** 还挂着的计时器数（调试 / 泄漏检查用）。 */
  get pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }

  /** 下一个不晚于 `until` 的计时器时刻；没有就 `null`。 */
  nextDue(until: number): number | null {
    let best: number | null = null;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.at > until) {
        continue;
      }
      if (best === null || timer.at < best) {
        best = timer.at;
      }
    }
    return best;
  }

  /**
   * 触发一个已到点的计时器（按 `(at, seq)` 取最小）。
   *
   * @returns 是否触发了一个
   */
  private fireOne(until: number): boolean {
    let best: Timer | null = null;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.at > until) {
        continue;
      }
      if (best === null || timer.at < best.at || (timer.at === best.at && timer.seq < best.seq)) {
        best = timer;
      }
    }
    if (best === null) {
      return false;
    }
    this.t = Math.max(this.t, best.at);
    if (best.period === null) {
      best.cancelled = true;
    } else {
      // `every` 原地续期：保持同对象，这样先前返回的 cancel 仍然有效
      this.seq += 1;
      best.at += best.period;
      best.seq = this.seq;
    }
    best.fn();
    return true;
  }

  /**
   * 排空：等微任务跑完，直到连续两轮「没有新计时器登记且没有别的工作」。
   *
   * 用宏任务边界（`setImmediate`）而不是固定次数的微任务轮转 —— ADR-0002 P4
   * 就是固定次数导致异步链更长时静默放行。
   *
   * @param isQuiet 额外的工作判据（例如会话队列是否空）
   */
  async drain(isQuiet: () => boolean = () => true): Promise<void> {
    let calm = 0;
    for (let guard = 0; guard < 100_000; guard += 1) {
      const registered = this.registered;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      calm = this.registered === registered && isQuiet() ? calm + 1 : 0;
      if (calm >= 2) {
        return;
      }
    }
    throw new Error('pet: drain 未能收敛（一直有新计时器登记）');
  }

  /**
   * 推进到 `target`：每轮先排空、再触发最早的计时器；到点后再排空一次。
   */
  async runUntil(target: number, isQuiet?: () => boolean): Promise<void> {
    if (target < this.t) {
      throw new Error(`pet: 虚拟时钟不能后退（${target} < ${this.t}）`);
    }
    await this.drain(isQuiet);
    for (;;) {
      if (!this.fireOne(target)) {
        break;
      }
      await this.drain(isQuiet);
    }
    this.t = target;
    await this.drain(isQuiet);
  }
}
