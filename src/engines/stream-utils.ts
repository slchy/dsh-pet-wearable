/**
 * 流式引擎的公共件：事件队列、中止门、念出去的全文。
 *
 * Live / Cascade / 适配器 / 纯级联泵 / Live 编排以前各抄一份。队列顺序、
 * `abort` 监听有没有摘掉、多步增量按哪一段对账，抄歪一处就不会报错，
 * 只会在插话或流式回落时静默分叉。这里只留一份。
 */
import { cleanForSpeech, parseEmotion } from '../emotion.ts';

/**
 * 把多个生产者的输出并成一条异步流。
 *
 * 与 `TokenQueue` 同一个形状（先 push 后迭代、先迭代后 push 都要成立）。
 * 文本和音频必须走**同一条**队列，消费端看到的就是到达顺序。
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly pending: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: T): void {
    if (this.closed) {
      return;
    }
    this.pending.push(event);
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

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
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
    }
  }
}

/**
 * `AbortSignal` 的一次性等待器。
 *
 * `done` 在信号中止时兑现；已经中止则立刻兑现，并且**不挂监听**。
 * 调用方必须在 `finally` 里 `cancel()`：不摘的话，这一轮结束之后回调还挂在
 * signal 上，下一轮 abort 会打进已经结束的等待。
 */
export interface AbortGate {
  readonly done: Promise<void>;
  cancel(): void;
}

export function createAbortGate(signal: AbortSignal): AbortGate {
  if (signal.aborted) {
    return {
      done: Promise.resolve(),
      cancel() {},
    };
  }
  let onAbort: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    onAbort = () => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    done,
    cancel() {
      if (onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    },
  };
}

/**
 * 流式那条路实际念出去的全文。
 *
 * 增量按到达顺序拼起来，再剥开头的情绪标签、按 TTS 口径清洗。
 * 多步时 `reply.speech` 只是最后一步，打断续话必须按全部增量切。
 */
export function spokenFromStream(raw: string): string {
  return cleanForSpeech(parseEmotion(raw).rest);
}
