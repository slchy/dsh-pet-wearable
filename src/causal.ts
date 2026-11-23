/**
 * 逻辑因果时间：**谁发生在谁之前**，与「谁先到达」无关。
 *
 * 全双工语音链路上有四条延迟完全不同的异步管道（声学流、ASR 解码、Omni 生成、TTS 播放），
 * 物理到达顺序 ≠ 逻辑因果顺序。真机上踩过的每一个"灵异"事故，根子都是拿**到达时刻**
 * 当成了因果顺序：
 *
 * - `20261123-053719` 第 2 轮：`seq=3` 在 11473 ms 就封了段，11583 ms 系统进 `speaking`，
 *   11655 ms 那条转写才迟到 —— 按到达时间它像"用户插话"，于是老轮把自己前半句杀了。
 * - 同一份档案第 5/7 轮：静音尾被解成 `Thank you.` / `嗯。`，按到达时间看是"用户说了话"，
 *   于是凭空多出幽灵轮。
 *
 * 所以判据只认**序号**（`commitSeq`），一秒都不看表。这个文件就是它们唯一的家：
 * 以前 `commitSeq <= baseCommitSeq` 这条比较散在五个文件八处，改一处漏一处都是静默失效
 * （`baseCommitSeq` 没有时判成"不是旧段"，表现就是自己打断自己）。
 *
 * ## 不放进这里的因果量
 *
 * - `gateSeq`（能量门开关周期）：它决定**攒哪些帧**，不决定**这段定稿归谁**。
 *   一个 gate 周期里可能发出零发 commit（静音被丢），拿它判因果会误伤。
 *   `AudioFrame` 里留着它是为了"这段音频属于第几次开口"这类声学判断。
 * - 轮次票据的 `{no, gen}`：那是**轮次**的因果（谁被谁顶掉），见 {@link isStaleTicket}。
 */

/** 一段 ASR 产物的出生证：产出它的那一发 commit 的序号 */
export interface CausalStamp {
  /** 已经发出的第几发 ASR commit（单调递增，从 1 开始） */
  readonly commitSeq: number;
}

/** 开轮那一刻的因果水位线 */
export interface CausalWatermark {
  /**
   * 开轮瞬间已经发出的最大 `commitSeq`。
   *
   * `undefined` = 这张票据没有因果坐标（单测、离线场景、装配层没注入）——
   * 这时**一律判"不是旧段"**：宁可让一次插话通过，也不能凭空吞掉一轮回答。
   */
  readonly baseCommitSeq?: number | undefined;
}

/**
 * 这段转写是不是**开轮之前就已经在飞的旧音频**。
 *
 * 判据：产出它的那发 commit 早于（或等于）开轮时锁存的水位线。commit 之后音频就被切走
 * 了，所以这条等价于"这段音频全部录在开轮之前"——那种时候的转写绝不可能是用户在插话，
 * 只能是判停抢跑之后补回来的后半句（真机上它就是"自己后半句杀自己"）。
 */
export function isPreTurnSegment(
  cause: CausalStamp,
  mark: CausalWatermark,
): boolean {
  const base = mark.baseCommitSeq;
  if (base === undefined) {
    return false;
  }
  return cause.commitSeq <= base;
}

/**
 * 这段转写能不能构成**插话**（打断正在播的回答）。
 *
 * 与 {@link isPreTurnSegment} 互补，但单独命名：调用点读起来是"能不能打断"，
 * 而不是"是不是旧段"的否定 —— 后者在 `thinking` 之类的状态上会让人想歪。
 */
export function mayBargeIn(cause: CausalStamp, mark: CausalWatermark): boolean {
  return !isPreTurnSegment(cause, mark);
}

/** 轮次票据的因果坐标：`no` 是第几轮，`gen` 是被插话顶掉过几次 */
export interface TicketCoordinate {
  readonly no: number;
  readonly gen: number;
}

/**
 * 这张票据是不是**已经被顶掉**了。
 *
 * 轮次与代次都要比：`gen` 只在插话时 +1，连续两句闲聊的 `gen` 相同，
 * 只比 `gen` 会把"上一轮"当成"这一轮"（实测打死过 harness）。
 */
export function isStaleTicket(
  current: TicketCoordinate | null | undefined,
  ticket: TicketCoordinate | null | undefined,
): boolean {
  if (current === null || current === undefined) {
    return true;
  }
  if (ticket === null || ticket === undefined) {
    return false;
  }
  return ticket.no !== current.no || ticket.gen !== current.gen;
}
