/**
 * 把「推文本」变成「异步迭代器」，供 `tts.synthesizeStream` 消费。
 *
 * <h2>为什么这个小东西必须写对</h2>
 *
 * 生产者是 WebSocket 回调（同步、随时可能触发），消费者是 TTS 的 for-await。
 * 两边交错，错过一次唤醒就会整段卡死：表现是 TTS 收到空文本、服务端回
 * Please ensure input text is valid.，看起来像"文本非法"，其实是队列没交付。
 *
 * 两个必须成立的时序（都有单测）：
 *
 * 1. 先 push 后迭代  —— 已经攒下的必须立刻吐出来
 * 2. 先迭代后 push  —— 迭代器挂起时 push 必须把它叫醒
 *
 * 以及一条容易写错的：close() 之后，剩余元素仍要吐完再结束。
 */
export class TokenQueue implements AsyncIterable<string> {
  private readonly pending: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (text === '') return;
    this.pending.push(text);
    // 取走再调用：resolver 只该被用一次，留着重入会重复 resolve
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  close(): void {
    this.closed = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** 已推送但还没被取走的段数（诊断用） */
  get size(): number {
    return this.pending.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      // 醒来后不做假设，回到循环顶部重新检查 pending：假醒也不能漏元素
    }
  }
}