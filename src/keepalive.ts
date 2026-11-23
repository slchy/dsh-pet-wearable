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
 * 自己而去改动主链路的类。
 *
 * **`AgentProvider` 上的每个可选能力都必须原样透传**，漏一个就是静默降级、不报错：
 * - `setAnnouncer` 漏了 —— 后台任务的汇报再也播不出来
 * - `attachLiveSink` 漏了 —— 流式增量到了 `session` 却没人接，边生成边合成拿到
 *   空文本，每轮都退回整段合成（实测踩过：日志里 `首增量` 一次都不出现）
 *
 * 给 `AgentProvider` 加新的可选方法时，这里要跟着加一行。
 */
export function trackActivity(
  agent: AgentProvider,
  state: ActivityState,
  now: () => number = Date.now,
): AgentProvider {
  return {
    name: agent.name,
    get sessionId() { return agent.sessionId ?? null; },
    async reply(userText, image, note, turn) {
      state.inflight += 1;
      try {
        return await agent.reply(userText, image, note, turn);
      } finally {
        state.inflight -= 1;
        state.last = now();
      }
    },
    ...(agent.setAnnouncer === undefined ? {} : { setAnnouncer: agent.setAnnouncer.bind(agent) }),
    // 放手那一轮的答案回注记忆：漏转发 = 被打断的委派轮答案彻底消失（静默降级）
    ...(agent.setDetachedAnswerSink === undefined
      ? {}
      : { setDetachedAnswerSink: agent.setDetachedAnswerSink.bind(agent) }),
    ...(agent.attachLiveSink === undefined ? {} : { attachLiveSink: agent.attachLiveSink.bind(agent) }),
    // 每个可选能力都必须显式透传 —— 漏一个就是静默降级（`keepalive.ts` 顶部踩过）
    ...(agent.cancelTurn === undefined ? {} : { cancelTurn: agent.cancelTurn.bind(agent) }),
    // 放手 / 有没有活儿：漏这两条 = 委派轮被打断时既不取消也不放手，
    // dsh 跑完之后答案直接消失（`FrontedAgent` 里的 `inner.detachTurn?.()` 静默空转）
    ...(agent.detachTurn === undefined ? {} : { detachTurn: agent.detachTurn.bind(agent) }),
    ...(agent.dshBusy === undefined ? {} : { dshBusy: agent.dshBusy.bind(agent) }),
    // 「交给慢车道了」的回执钩子：漏转发 = 委派轮永远没有回执（静默降级）
    ...(agent.setDelegateHook === undefined
      ? {}
      : { setDelegateHook: agent.setDelegateHook.bind(agent) }),
    ...(agent.interruptTurn === undefined ? {} : { interruptTurn: agent.interruptTurn.bind(agent) }),
    ...(agent.taskStatus === undefined ? {} : { taskStatus: agent.taskStatus.bind(agent) }),
    // 判停前起跑：漏转发 = 每次多等判停那一拍，日志里连一行都不出（静默降级）
    ...(agent.prefetch === undefined ? {} : { prefetch: agent.prefetch.bind(agent) }),
    // 中间结果投机：同样漏一条就静默降级（少抢 500–1200 ms）
    ...(agent.speculatePartial === undefined
      ? {}
      : { speculatePartial: agent.speculatePartial.bind(agent) }),
    // omni 音频直出车道：漏这三条 = **omni 一次都不会接管**，而且不报错 ——
    // 档案里只有 `path=fast`，看起来像"它就是不快"，排查从现象根本看不出来。
    // （2026-11-23 线上实测：一晚上 4 轮全部静默走了文本快车道，正是这处漏了。）
    ...(agent.attachAudioLane === undefined
      ? {}
      : { attachAudioLane: agent.attachAudioLane.bind(agent) }),
    ...(agent.willServeAudio === undefined
      ? {}
      : { willServeAudio: agent.willServeAudio.bind(agent) }),
    ...(agent.noteServedTurn === undefined
      ? {}
      : { noteServedTurn: agent.noteServedTurn.bind(agent) }),
    // 委派轮回注：漏转发 = omni 永远不知道 dsh 答了什么，下一轮顺着追问就答非所问。
    // 这条同样是**静默**降级（没有它 omni 照样能答，只是答错）。
    ...(agent.injectAnsweredTurn === undefined
      ? {}
      : { injectAnsweredTurn: agent.injectAnsweredTurn.bind(agent) }),
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
