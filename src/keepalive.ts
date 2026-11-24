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

import type {
  AgentImage,
  AgentProvider,
  AgentReplyView,
  TurnContext,
} from './providers.ts';

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
 * 自己而去改动主链路的类。
 *
 * **`AgentProvider` 上的每个可选能力都必须原样透传**，漏一个就是静默降级、不报错：
 * - `setAnnouncer` 漏了 —— 后台任务的汇报再也播不出来
 * - `attachLiveSink` 漏了 —— 流式增量到了 `session` 却没人接，边生成边合成拿到
 *   空文本，每轮都退回整段合成（实测踩过：日志里 `首增量` 一次都不出现）
 * - `attachAudioLane` / `willServeAudio` / `noteServedTurn` 漏了 —— omni 一晚上
 *   4 轮全部静默退回文本快车道，从现象上看不出来
 *
 * 所以这里**不再逐个列举**：以前那份手工转发表每加一个可选方法就得跟着加一行，
 * 忘了就是静默降级（同一类事故已经踩过至少三次）。改成 `Proxy` 之后，任何属性
 * （包括以后新加的、甚至运行时才挂上去的）都自动转发，只有 `reply` 被包一层记账。
 *
 * 两条实现细节别改：
 * - `Reflect.get(target, prop, target)` 的第三个参数必须是 **`target`**而不是
 *   `receiver`：实现方用 `#私有字段` 的 getter 会在 receiver 上找私有槽，传 Proxy
 *   会直接抛 "Receiver must be an instance of class"。
 * - 方法要 `.bind(target)`：宿主是拿下来再调的（`const fn = agent.prefetch` 这类
 *   写法也有），不绑就会丢 `this`，私有字段同样会炸。
 */
export function trackActivity(
  agent: AgentProvider,
  state: ActivityState,
  now: () => number = Date.now,
): AgentProvider {
  const trackedReply = async (
    userText: string,
    image?: AgentImage,
    note?: string,
    turn?: TurnContext,
  ): Promise<AgentReplyView> => {
    state.inflight += 1;
    try {
      return await agent.reply(userText, image, note, turn);
    } finally {
      state.inflight -= 1;
      state.last = now();
    }
  };

  /**
   * 方法值 → 绑到原对象上的版本。
   *
   * 按**函数对象**缓存（不是按属性名）：同一个方法重复取到的是同一个包装，
   * `proxy.prefetch === proxy.prefetch` 成立；而运行时把某个能力换成另一个函数时，
   * 键变了自然就重新绑，不会拿到旧的。
   */
  const bound = new WeakMap<Function, Function>();
  const boundTo = (target: AgentProvider, value: unknown): unknown => {
    if (typeof value !== 'function') return value;
    const cached = bound.get(value);
    if (cached !== undefined) return cached;
    const wrapper: Function = value.bind(target);
    bound.set(value, wrapper);
    return wrapper;
  };

  return new Proxy(agent, {
    get(target, prop) {
      if (prop === 'reply') return trackedReply;
      // 老包装把「没有 sessionId」归成 null（调用方按 null 判「不用 dsh」），保持原样
      if (prop === 'sessionId') return target.sessionId ?? null;
      // `constructor` 不绑：`main.ts` 的装配自检靠它打印真实类名，
      // 绑过之后会变成 "bound FrontedAgent"；它也不是「能力」，不需要 this
      if (prop === 'constructor') return Reflect.get(target, prop, target);
      return boundTo(target, Reflect.get(target, prop, target));
    },
  });
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
