/**
 * 前缀保活。
 *
 * <h2>为什么需要</h2>
 *
 * DeepSeek 的上下文缓存是按**前缀哈希**命中的。真机实测（同一条 272 轮会话的
 * `usage.cacheReadTokens`）：
 *
 * ```text
 * 空闲   8 分钟 → cacheRead  8 064   热
 * 空闲  78 分钟 → cacheRead 11 520   热
 * 空闲 282 分钟 → cacheRead 13 056   热（4.7 小时还行）
 * 空闲  23 小时 → cacheRead  2 816   凉（56 987 token 全算）
 * ```
 *
 * 凉了的代价只有一处：**当天第一次开口**要多等 1–3 秒重算整段前缀。
 * 所以这里做的事很单薄 —— 空闲超过阈值就发一条极短的请求，把前缀重新焐热。
 *
 * <h2>边界</h2>
 *
 * - **只在没人说话时发**：有活儿在飞就跳过这一拍，绝不插队到用户那一轮里。
 * - **失败不重试**：保活失败无非是缓存继续凉，下个周期再试，不值得为它加告警。
 * - **发什么由调用方定**：这里只管「什么时候」，不碰 agent 的接口细节。
 */

import type { AgentProvider } from './providers.ts';

/** 保活用的输入。刻意写得不像用户的话，模型不会把它当成一句招呼去回应。 */
export const KEEPALIVE_PROMPT = '（保活信号，不需要回应）';

export interface KeepaliveClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 真实时钟。测试里换成手动推进的假时钟，别在测试里等真时间。 */
export const systemClock: KeepaliveClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** 「最后一次交互」与「有没有人在飞」。由 `trackActivity` 维护。 */
export interface ActivityState {
  /** 最后一次 reply 结束（或开始）的时刻。 */
  last: number;
  /** 在飞的 reply 数。 */
  inflight: number;
}

export function newActivityState(now: number): ActivityState {
  return { last: now, inflight: 0 };
}

/**
 * 给 agent 包一层，记下活动痕迹。
 *
 * 包在 `reply` 外面而不是塞进 `VoiceAgent`：保活是个**旁路**，不该为了让别人看见
 * 自己而去改动主链路的类。顺带一提，`setAnnouncer` 也必须原样透传 —— 漏了它
 * 后台任务的汇报就再也播不出来，而且不报错。
 */
export function trackActivity(
  agent: AgentProvider,
  state: ActivityState,
  now: () => number = Date.now,
): AgentProvider {
  return {
    name: agent.name,
    get sessionId() { return agent.sessionId ?? null; },
    async reply(userText, image, note) {
      state.inflight += 1;
      try {
        return await agent.reply(userText, image, note);
      } finally {
        state.inflight -= 1;
        state.last = now();
      }
    },
    ...(agent.setAnnouncer === undefined ? {} : { setAnnouncer: agent.setAnnouncer.bind(agent) }),
  };
}

export interface KeepaliveOptions {
  readonly clock: KeepaliveClock;
  /** 空闲多久之后保活一次。`<= 0` 表示关闭（返回一个空的停止函数）。 */
  readonly intervalMs: number;
  /** 检查粒度，默认 60 s。 */
  readonly tickMs?: number;
  /** 距上一次交互过了多少毫秒。 */
  readonly idleFor: () => number;
  /** 有活儿在飞就跳过这一拍。 */
  readonly isBusy: () => boolean;
  readonly ping: () => Promise<void>;
  readonly log?: (line: string) => void;
}

/**
 * 起一个保活循环，返回停止函数。
 *
 * 判定是「空闲够久 **且** 上一拍已经过去够久」：后者防止 ping 抛错后立刻重试
 * 把日志刷满 —— 失败时不更新 `last`，只看前者会一拍接一拍地打。
 */
export function startKeepalive(options: KeepaliveOptions): () => void {
  if (!(options.intervalMs > 0)) return () => {};

  const tick = options.tickMs ?? 60_000;
  let stopped = false;
  let handle: unknown = null;
  let lastPingAt = 0;

  const schedule = (): void => {
    if (stopped) return;
    handle = options.clock.setTimeout(fire, tick);
  };

  const fire = (): void => {
    if (stopped) return;
    handle = null;
    const now = options.clock.now();
    const idle = options.idleFor();
    if (options.isBusy() || idle < options.intervalMs || now - lastPingAt < options.intervalMs) {
      schedule();
      return;
    }
    lastPingAt = now;
    options.log?.(`[keepalive] 空闲 ${Math.round(idle / 60_000)} 分钟，发一次保活`);
    void options.ping()
      .catch((e: Error) => { options.log?.(`[keepalive] 失败：${e.message}`); })
      .finally(schedule);
  };

  schedule();
  return () => {
    stopped = true;
    if (handle !== null) options.clock.clearTimeout(handle);
    handle = null;
  };
}
