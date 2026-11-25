import type { Emotion } from './emotion.ts';

/** 浏览器浮层上的四态。对话机里的 `closed` / `ending` 收成 `idle`。 */
export type PetUiPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * 浮层消费的事件。字段都是 JSON 可序列化的纯数据，不含函数或 Buffer。
 */
export type PetUiEvent =
  | { readonly type: 'phase'; readonly phase: PetUiPhase }
  | { readonly type: 'asr'; readonly text: string; readonly final: boolean }
  | { readonly type: 'asr.replace'; readonly text: string; readonly previous?: string }
  | { readonly type: 'reply.delta'; readonly delta: string; readonly path?: 'omni' | 'fast' | 'dsh' }
  | {
      readonly type: 'reply.final';
      readonly text: string;
      readonly emotion: Emotion;
      readonly path?: 'omni' | 'fast' | 'dsh';
    }
  | { readonly type: 'delegated'; readonly query: string; readonly reason?: string }
  | { readonly type: 'announce'; readonly text: string; readonly emotion: Emotion };

/**
 * 把一条 UI 事件交给可选监听器。
 *
 * 没挂监听器时什么都不做。监听器抛错被吞掉 —— 浮层的 bug 不能打断语音轮次。
 */
export function safeEmitUi(
  cb: ((ev: PetUiEvent) => void) | undefined,
  ev: PetUiEvent,
): void {
  try {
    cb?.(ev);
  } catch {
    // 监听器的异常留在浮层里
  }
}
