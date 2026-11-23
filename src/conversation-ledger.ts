/**
 * 对话账本：**这一场里发生了什么**的唯一真值。
 *
 * 为什么要它：真机事故里有一半是「同一件事有好几份副本」——
 * `FrontedAgent.history`（快车道 prompt 窗口）、`omni-shadow` 的服务端历史、
 * dsh 的 session，再加档案。每份都可能漏一笔，补漏又长出新补丁
 * （`noteServedTurn` / `injectAnswer` / 旁注三套）。
 *
 * 这个账本不试图取代那几条连接的历史（它们在服务端、拿不回来），它只回答
 * 内核真正需要回答的几个问题：
 *
 * - **上一轮的答案是谁给的**（路由的「话题粘性」靠它）
 * - **dsh 上一条是不是在问用户话**（短回话要回给 dsh，不能被快车道抢答）
 * - **那一轮用户到底听到了多少**（`truncated` → 要不要回注给别的车道）
 *
 * 只记**已经结束的轮次**。中途被打断在 `truncated` 里体现，不靠"删记录"表达。
 */

/** 谁给的这一轮回答。`pet` = 宠物主动开口（不代表用户问过话） */
export type LedgerLane = 'live' | 'cascade' | 'dsh' | 'pet';

export interface LedgerTurn {
  /** 用户问的（`pet` 轮为空串） */
  readonly userText: string;
  /** 实际念给用户听的（不是模型的完整答案 —— 被打断时只有前半截） */
  readonly assistantText: string;
  readonly lane: LedgerLane;
  /** 用户少听了一段（内容面）。**不是**「票据被作废」，那个是控制面 */
  readonly truncated: boolean;
  readonly endedAtMs: number;
}

/** 记多少轮。只给路由/回注用，不是归档 —— 档案在 `SessionArchive` 里 */
const DEFAULT_KEEP = 12;

export class ConversationLedger {
  private readonly turns: LedgerTurn[] = [];
  private readonly keep: number;

  constructor(keep: number = DEFAULT_KEEP) {
    this.keep = Math.max(1, keep);
  }

  /** 一轮结束。`assistantText` 为空（一个字都没念）也照记 —— 那是「问过但没答」 */
  record(turn: LedgerTurn): void {
    const clean = turn.assistantText.trim();
    this.turns.push({
      ...turn,
      userText: turn.userText.trim(),
      assistantText: clean,
    });
    while (this.turns.length > this.keep) {
      this.turns.shift();
    }
  }

  /**
   * 最近一轮**有回答**的车道。
   *
   * 跳过「一个字都没念」的轮次：那一轮不算答过，拿它当"上一轮"会让刚发生的事
   * 凭空消失（回放里就踩过：从后往前取第一个拿到的是用户那句，`stick-to-dsh` 失效）。
   */
  lastAnsweredLane(): LedgerLane | null {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i];
      if (turn !== undefined && turn.assistantText !== '') {
        return turn.lane;
      }
    }
    return null;
  }

  /** 最近一轮有回答的完整记录（`dsh` 的「在等回话」要它的文本） */
  lastAnswered(): LedgerTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i];
      if (turn !== undefined && turn.assistantText !== '') {
        return turn;
      }
    }
    return null;
  }

  /** 最近的 `n` 轮（给熔断后的素级联喂上下文，见 `FallbackVoiceEngine`） */
  recent(n: number): readonly LedgerTurn[] {
    return this.turns.slice(Math.max(0, this.turns.length - Math.max(0, n)));
  }

  get size(): number {
    return this.turns.length;
  }
}
