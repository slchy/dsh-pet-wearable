/**
 * 时钟端口与生产实现。
 *
 * 对应 ADR-0002 §3.2。这是应用层**唯一**允许读时间的地方：
 * `src/app/` 与 `src/pet/brain/` 里出现 `Date.now` / `performance.now` /
 * `new Date` / `setTimeout` / `setInterval` 都算破例（有测试盯着）。
 */

/** 取消一个已登记的回调；重复调用无副作用。 */
export type Cancel = () => void;

/**
 * 时钟。
 *
 * `now()` 必须是**单调**源：系统改时间不能让"闲置了多久"跳变。
 * `localHour()` 才是墙钟，只给"深夜不打扰"用。
 */
export interface Clock {
  /** 单调毫秒 */
  now(): number;
  /** 本地墙钟小时 0–23 */
  localHour(): number;
  /** 到点回调一次 */
  after(ms: number, fn: () => void): Cancel;
  /** 每 `ms` 回调一次，直到取消 */
  every(ms: number, fn: () => void): Cancel;
}

/**
 * 生产时钟。
 *
 * 定时器一律 `unref`：没别的事时进程照常退出，不被心跳拖着。
 */
export class SystemClock implements Clock {
  private readonly startedAt: number;
  private readonly startHour: number;
  private readonly monotonic: () => number;

  /**
   * @param monotonic 单调源（`performance.now()` 一类），测试可替换
   * @param wallHour 启动时的本地小时，测试可替换
   */
  constructor(
    monotonic: () => number = () => performance.now(),
    wallHour: () => number = () => new Date().getHours(),
  ) {
    this.monotonic = monotonic;
    this.startedAt = monotonic();
    this.startHour = wallHour();
  }

  now(): number {
    return this.monotonic() - this.startedAt;
  }

  /**
   * 本地小时 = 启动时的墙钟小时 + 已经走过的单调时长。
   *
   * 跨过 23 点会**自然**进入深夜，不用另设偏移；系统时钟被改也不会让判定跳变。
   */
  localHour(): number {
    const hours = this.startHour + Math.floor(this.now() / 3_600_000);
    return ((hours % 24) + 24) % 24;
  }

  after(ms: number, fn: () => void): Cancel {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => { clearTimeout(timer); };
  }

  every(ms: number, fn: () => void): Cancel {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return () => { clearInterval(timer); };
  }
}
