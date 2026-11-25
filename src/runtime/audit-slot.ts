/**
 * 进程内审计槽。写入方（快车道、TTS）是共用的，档案接收方按连接换；
 * 摘掉时带令牌，避免旧连接收尾把新连接的出口一起摘掉。
 */

/** 审计出口的形状：`agent.*` / `tts.*` 事件往哪儿写。 */
export type AuditSink = (name: string, data: Record<string, unknown>) => void;

/**
 * 审计出口的**槽位**：进程里所有共用件（`FrontedAgent`、TTS provider）都往这里写，
 * 而真正的接收方（档案）是**每连接一份**。
 */
export interface AuditSlot {
  /** 当前挂着的那个（`null` = 没人接）。排障/单测用，不参与装配。 */
  peek(): AuditSink | null;
  /**
   * 挂上 / 摘掉。
   *
   * 传 `expected` 时是**所有权守卫**：只有「槽里现在挂的正是我当初挂的那个」才摘，
   * 否则什么也不做 —— 旧连接断开时不能把后来那条连接的档案摘掉。
   * 不传 `expected`（`undefined` / `null`）保持老语义：直接覆盖。
   */
  set(sink: AuditSink | null, expected?: AuditSink | null): void;
  /** 转发一条事件；没有持有者、或持有者抛错，都只当没发生。 */
  emit(name: string, data: Record<string, unknown>): void;
  /** 挂上并返回**只摘自己那一份**的卸载函数。 */
  register(sink: AuditSink): () => void;
}

/**
 * 造一个审计槽位。
 *
 * 为什么要有所有权守卫：`FrontedAgent` 和 TTS provider 是**进程级共用**的，它们的
 * 回调只能写「当前这条连接」的档案。多设备并发（或快速重连）时，旧连接的生命周期
 * 收拾得比新连接晚，它那句 `setAudit(null)` 会把新连接的档案出口一起摘掉 ——
 * 之后所有 `agent.*` / `tts.*` 事件静默丢失，日志里一个字都没有。
 *
 * 现在 `voice-session` 传不传令牌由它自己决定：不传（1 参调用）就仍是
 * 「最后挂上的赢、`null` 直接清」；传了（2 参）就走所有权守卫。装配层两参都转发，
 * 所以那一侧改签名时这里不用再动。
 */
export function createAuditSlot(): AuditSlot {
  let current: AuditSink | null = null;

  const set = (sink: AuditSink | null, expected?: AuditSink | null): void => {
    if (sink === null && expected != null) {
      // 只摘自己挂上去的那一个：别人后来居上时保持原样
      if (current === expected) {
        current = null;
      }
      return;
    }
    current = sink;
  };

  return {
    peek: () => current,
    set,
    emit: (name, data) => {
      const sink = current;
      if (sink === null) {
        return;
      }
      // 审计抛错不能把一轮通话带下水（档案可能刚好在关）
      try {
        sink(name, data);
      } catch {
        // 忽略
      }
    },
    register: (sink) => {
      set(sink);
      return () => { set(null, sink); };
    },
  };
}
