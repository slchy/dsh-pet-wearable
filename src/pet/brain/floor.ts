/**
 * 话筒仲裁。**宠物只申请，不仲裁** —— 仲裁在应用层（ADR-0001 §6）。
 *
 * 宠物通过 `world.floorBusy` 与 `floorTaken` 打断得知结果；它不查这张表。
 *
 * | 占用者 | 可被谁抢 |
 * |---|---|
 * | `user` | 无（定稿后由 `handoff` 交给 `reply`） |
 * | `reply` | `user` |
 * | `announce` | `user`、`reply`、敲击（由应用层转成 `reflex`/`dismiss`） |
 * | `pet` | `user`、敲击；**`announce` 不抢、`reply` 也不抢**（等它说完） |
 * | `reflex` | 任何人 |
 */
import type { FloorOwner } from './types.ts';

/** 抢占关系：`incoming` 能否从 `current` 手里拿走话筒。 */
function canPreempt(incoming: FloorOwner, current: FloorOwner): boolean {
  if (current === 'user') {
    return false;
  }
  switch (incoming) {
    case 'user':
      return true;
    case 'reply':
      // `announce` 必须让得开：用户说完进入 thinking/speaking 时，前台应答要接过
      // 被掐断的后台播报。让不出去的话，播报 finally 一 `release` 话筒就空了，
      // 宠物会在模型思考期间叠着抢话。`pet` 仍不抢，等它说完。
      // `user` 在函数开头就不可抢，定稿走 {@link FloorArbiter.handoff}。
      return current !== 'pet';
    case 'announce':
      // 宠物在说话时后台汇报等着 —— 抢话比晚几秒更烦人
      return current === 'reflex';
    case 'pet':
      return current === 'reflex';
    case 'reflex':
      return true;
  }
}

export class FloorArbiter {
  private currentOwner: FloorOwner | null = null;

  /** 当前占用者；`null` = 话筒空着。 */
  get owner(): FloorOwner | null {
    return this.currentOwner;
  }

  /** 有没有人占着。 */
  get busy(): boolean {
    return this.currentOwner !== null;
  }

  /**
   * 申请话筒。
   *
   * @returns 拿到 `true`；被拒 `false`（调用方按 `floorTaken` 处理）
   */
  acquire(who: FloorOwner): boolean {
    const current = this.currentOwner;
    if (current === null || current === who) {
      this.currentOwner = who;
      return true;
    }
    if (!canPreempt(who, current)) {
      return false;
    }
    this.currentOwner = who;
    return true;
  }

  /**
   * 移交：`from` 主动把话筒交给 `to`。
   *
   * 和 {@link acquire} 的区别：**不走抢占表**，而且中间不经过 `null`。两处合法移交：
   *
   * - `user → reply`：`user` 不可抢占，定稿只能由 `user` 交出来。直接 `claim('reply')`
   *   永远失败，话筒会卡在 `user` 上。
   * - `announce → reply`：后台播报被掐断、对话进入 thinking/speaking 时，前台应答
   *   接过话筒。先 `release('announce')` 再申请会让 `owner` 闪成 `null`，宠物
   *   的 `floorFree` 在这一帧里成立，思考期就会叠话。
   *
   * `from` 不是当前持有者时返回 `false`（过期通知），调用方可以忽略。
   *
   * @returns 是否真的移交了
   */
  handoff(from: FloorOwner, to: FloorOwner): boolean {
    if (this.currentOwner !== from) {
      return false;
    }
    this.currentOwner = to;
    return true;
  }

  /** 释放。只有持有者能释放 —— 别人的释放是过期通知，忽略。 */
  release(who: FloorOwner): boolean {
    if (this.currentOwner !== who) {
      return false;
    }
    this.currentOwner = null;
    return true;
  }

  /** 重置（连接关闭）。 */
  clear(): void {
    this.currentOwner = null;
  }
}
