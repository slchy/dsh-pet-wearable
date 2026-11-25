/**
 * 「撤回切点」的账本：快车道赢了、而慢车道那一轮已经答完时，下一轮 prompt
 * 之前用 `session/fork` 把那一轮从历史里切掉。
 */
import type { TurnTicket } from '../dialog-fsm.ts';

/**
 * 切点必须落在**入箱之前**：`turn/start` 前面那条 `agent/inbox/spliced`（inserted
 * 非空）就是把这句话塞进收件箱，切在它之后，fork 出来的新会话会把它当待办
 * **重放一遍**（探针实测：切点取 `turn/start − 1` 时幽灵句在新会话里出现 2 次，
 * 取入箱 seq − 1 才干净）。
 *
 * 票据是必须的：那一轮的 promise 可能到下下轮才 resolve，这时账本里已经换成新的
 * 那一轮了 —— 拿错切点去撤会把**下一轮**切掉。
 */
export class RollbackLedger {
  private lastInsert: number | null = null;
  private cut: number | null = null;
  private owner: TurnTicket | null = null;
  private pending: number | null = null;

  /** 吃一条**本会话**的事件（`inserted` = 该事件往收件箱塞了几条，非入箱事件传 0） */
  observe(type: string, seq: number, inserted: number, active: TurnTicket | null): void {
    if (type === 'agent/inbox/spliced') {
      if (inserted > 0) this.lastInsert = seq;
      return;
    }
    if (type === 'turn/start') {
      this.cut = this.lastInsert === null ? null : this.lastInsert - 1;
      this.owner = active;
      this.lastInsert = null;
    }
  }

  /** 认领「这一轮不要了」；票据对不上（迟到的作废）或没有切点时返回 false */
  claim(ticket?: TurnTicket): boolean {
    if (this.cut === null || this.cut < 0) return false;
    // 没有属主票据 = 这一轮不是我们催的（自发轮/后台结算）→ 一律不认，宁可撤不了
    // 也不能拿错切点把**别人**那一轮切掉。
    const mine = this.owner;
    if (mine === null) return false;
    if (ticket !== undefined && (ticket.no !== mine.no || ticket.gen !== mine.gen)) return false;
    this.pending = this.pending === null ? this.cut : Math.min(this.pending, this.cut);
    return true;
  }

  /** 取走待撤回的切点（取一次就清空；连续多轮只会剩下最早那个） */
  take(): number | null {
    const cut = this.pending;
    this.pending = null;
    return cut;
  }

  /**
   * 全清。两种时候必须调：
   * - **fork 成功之后**：账本里的 seq 属于旧会话，留着下次会拿无效切点去 fork 新会话；
   * - **换会话 / reset**：同上。
   */
  reset(): void {
    this.lastInsert = null;
    this.cut = null;
    this.owner = null;
    this.pending = null;
  }

  /** 只读：待撤回的切点（日志用） */
  peek(): number | null {
    return this.pending;
  }
}
