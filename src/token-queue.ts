/**
 * 把「推文本」变成「异步迭代器」，供 `tts.synthesizeStream` 消费。
 *
 * 流式合成需要的是一个 `AsyncIterable<string>`，而 token 是从回调里推过来的 ——
 * 中间需要这么个泵。空串直接丢（流里会有），`close()` 之后迭代器正常结束。
 */
export class TokenQueue implements AsyncIterable<string> {
  private readonly pending: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (text === '') return;
    this.pending.push(text);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}
