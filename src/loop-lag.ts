/**
 * 事件循环延迟（process 级，常开）。
 *
 * <h2>为什么要有它</h2>
 *
 * TTS 那一段偶发多出 ~250 ms，而「合成本身」（`首包`）和「服务端接单」（`建立`）
 * 都量过是平的（`COSYVOICE_TRACE`、`docs/OPS-RECORD.md` §12.8.1）。剩下唯一能解释
 * 「两件不相干的事同时被推后同样的量」的，就是**这一进程被卡了一下** ——
 * 但这条从来没有仪表，于是只能猜。
 *
 * <h2>为什么不用 `perf_hooks.monitorEventLoopDelay`</h2>
 *
 * 实测**抓不到同步阻塞**：在 Linux/Node 22 上卡住 120 ms，它报 `max = 10 ms`
 * （就是 resolution 本身）；Windows 上报 16 ms（定时器粒度）。我们要看的恰恰是
 * 「一次卡 250 ms」，所以改成自己排一个 `setInterval` 量**漂移**：
 * 每次该 25 ms 到，实际晚了多少就是那一段卡了多久。同一段代码在服务器上量到 118 ms。
 *
 * 采样很便宜（一个 unref 的定时器），所以**常开**，每轮结束把这一轮的最大值和 p99
 * 记进 `turn.end`。看到 TTS 尖峰时对一眼：
 *
 * - `loop_max_ms` 也大 → 是我们自己卡的（谁卡的再查），与厂商无关
 * - `loop_max_ms` 正常 → 才轮到怀疑网络/服务端
 *
 * 口径：**延迟**，不是间隔。`max=250` 表示「有一次定时器晚了 250 ms 才被处理」，
 * 这段时间里 Promise 回调、socket 数据、TTS 首块全都在排队。
 */

/** 采样间隔。25 ms 够看出 100 ms 以上的停顿，又不会自己产生太多噪声 */
const RESOLUTION_MS = 25;

/** 两次取快照之间最多留这么多样本（25 ms 一个 → 约 1 分钟），防止长时间没人取时涨爆 */
const MAX_SAMPLES = 2400;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let samples: number[] = [];

/** 懒启动：第一次取快照时才开始采样，模块被 import 但还没有轮次时不空转 */
function ensure(): void {
  if (timer !== null) return;
  lastTick = Date.now();
  samples = [];
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - RESOLUTION_MS;
    lastTick = now;
    if (lag <= 0) return;
    samples.push(lag);
    if (samples.length > MAX_SAMPLES) samples.shift();
  }, RESOLUTION_MS);
  // 不保活进程：这个定时器只是观测，不该妨碍退出
  timer.unref();
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return -1;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo));
}

/**
 * 取「自上次调用以来」的延迟统计，并**清零**。
 *
 * 清零是必须的：一轮结束后不重置，下一轮会继承前面所有的尖峰，
 * 「这一轮卡了没有」就永远回答不了。
 *
 * 一次样本都没有（例如刚启动、这一轮短于 25 ms）时给 `-1` —— 缺仪表就记 -1，
 * **不拿 0 冒充「没卡过」**。
 */
export function loopLagSnapshot(): {
  readonly loop_max_ms: number;
  readonly loop_p99_ms: number;
} {
  ensure();
  const sorted = [...samples].sort((a, b) => a - b);
  const max = sorted.length === 0 ? -1 : sorted[sorted.length - 1]!;
  const p99 = percentile(sorted, 0.99);
  samples = [];
  lastTick = Date.now();
  return { loop_max_ms: max, loop_p99_ms: sorted.length === 0 ? -1 : p99 };
}
