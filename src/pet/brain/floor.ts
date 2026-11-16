/**
 * 话筒仲裁。**宠物只申请，不仲裁** —— 仲裁在应用层（ADR-0001 §6）。
 *
 * 宠物通过 `world.floorBusy` 与 `floorTaken` 打断得知结果；它不查这张表。
 *
 * | 占用者 | 可被谁抢 |
 * |---|---|
 * | `user` | 无 |
 * | `reply` | `user` |
 * | `announce` | `user`、敲击（由应用层转成 `reflex`/`dismiss`） |
 * | `pet` | `user`、敲击；**`announce` 不抢**（等它播完） |
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
      return current !== 'pet' && current !== 'announce';
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
   * 和 {@link acquire} 的区别：**不走抢占表**。ADR-0001 §6 的「`user` 定稿后转给
   * `reply`」就是移交 —— 而 `reply` 去**抢** `user` 是不允许的（`user` 不可抢占），
   * 所以 `userFinal()` 里直接 `claim('reply')` 永远失败，话筒会卡在 `user` 上。
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
