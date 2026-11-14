/**
 * 把异步的 `BatteryPort` 变成 `PetSnapshot` 里的同步电量。
 *
 * 宠物核心是纯同步的，不能在每个 tick 里 `await`；所以「谁轮询、缓存多久」
 * 必须定在这里，而不是留给每个调用方各自发挥：
 *
 * - 默认 **60 s** 轮询一次（电量是慢变量，没必要更勤）
 * - 成功读到 `null`（设备确实读不到）→ 缓存置 `null`，未知就是未知
 * - 读取抛错（传输抖动）→ **保留上一次的值**，不把一次失败当成「未知」
 * - `dispose()` 之后不再改缓存
 */
import type { BatteryPort } from './ports.ts';

export interface BatteryCacheOptions {
  /** 轮询周期（ms）。默认 60 s */
  readonly pollMs?: number;
  readonly log?: (line: string) => void;
}

const DEFAULT_POLL_MS = 60_000;

export class BatteryCache {
  private readonly port: BatteryPort;
  private readonly pollMs: number;
  private readonly log?: (line: string) => void;
  private value: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private disposed = false;

  constructor(port: BatteryPort, options: BatteryCacheOptions = {}) {
    this.port = port;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.log = options.log;
  }

  /** 最近一次成功读到的值；从未读到过时是 `null`。 */
  current(): number | null {
    return this.value;
  }

  /** 立刻读一次；失败时保留旧值。 */
  async refresh(): Promise<number | null> {
    if (this.inFlight) {
      return this.value;
    }
    this.inFlight = true;
    try {
      const level = await this.port.level();
      if (!this.disposed) {
        this.value = level;
      }
      return this.value;
    } catch (error) {
      this.log?.(`  [battery] 读取失败：${(error as Error).message}`);
      return this.value;
    } finally {
      this.inFlight = false;
    }
  }

  /** 开始轮询：立刻读一次，之后每 `pollMs` 一次。重复调用无副作用。 */
  start(): void {
    if (this.disposed || this.timer !== null) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.pollMs);
    // 插件是常驻进程的一部分，电量轮询不该拖住退出
    this.timer.unref?.();
  }

  /** 停止轮询；`current()` 仍返回最后缓存值。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
