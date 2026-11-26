/**
 * `AgentProvider` 全部可选成员的**编译期清单**。
 *
 * `satisfies Record<OptionalAgentKey, true>` 把「清单漏了一个新能力」变成
 * `tsc --noEmit` 错误：以后只要给 `AgentProvider` 加可选方法，这里不补就编译不过。
 * 运行期测试再遍历 `Object.keys(...)`，验 `trackActivity` 一个都不漏地透传。
 *
 * 之前是手写字符串数组，漏 `rollbackTurn` / `takeRollbackOutcome` 时编译期毫无反应，
 * 线上表现是「功能就是不生效」，从日志里看不出来。
 */
import type { AgentProvider } from '../../src/providers.ts';

export type OptionalAgentKey = Exclude<keyof AgentProvider, 'name' | 'reply' | 'sessionId'>;

export const OPTIONAL_AGENT_KEYS = {
  setAnnouncer: true,
  setDetachedAnswerSink: true,
  attachLiveSink: true,
  cancelTurn: true,
  setDelegateHook: true,
  interruptTurn: true,
  detachTurn: true,
  dshBusy: true,
  taskStatus: true,
  setTaskReporter: true,
  cancelBackgroundTasks: true,
  prefetch: true,
  speculatePartial: true,
  attachAudioLane: true,
  willServeAudio: true,
  noteServedTurn: true,
  rollbackTurn: true,
  takeRollbackOutcome: true,
  injectAnsweredTurn: true,
  dropPrefetch: true,
  reconcileTurnOutcome: true,
  lastLedgerLane: true,
} as const satisfies Record<OptionalAgentKey, true>;
