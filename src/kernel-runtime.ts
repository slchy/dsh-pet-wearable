/**
 * 内核解释器：把 {@link Effect} 翻译成真实世界的动作。
 *
 * 内核（`kernel.ts`）只声明意图，这里负责执行。分开的好处是**协议脏活不出内核**：
 * DashScope 那种「discard 时还没拿到 assistantItemId，必须等 response.done 再发
 * item.delete」的实现细节，全在这一层之下的适配器里，`step()` 一行都不用知道。
 *
 * 这一层也是唯一允许出现 `await` / 定时器的地方 —— 但它本身不带状态：
 * 状态在 `KernelState` 里，它只是"执行器"。
 */
import type { Effect } from './kernel.ts';

/** 解释器要动的那些东西。全部由装配层注入，内核与解释器都不自己 new */
export interface KernelPorts {
  /** 让设备停止播放（`{"op":"audio.stop"}`） */
  readonly stopDeviceAudio: () => void;
  /** 作废一轮：清投机、摘掉在等的答复 */
  readonly invalidateTurn: (ticket: { readonly no: number; readonly gen: number }) => void;
  /** 放弃引擎在途投机 */
  readonly abortEngine: (reason: 'delegated' | 'superseded' | 'barge_in') => void;
  /**
   * 一轮结算。`reflect` 为真表示用户**听全了** —— 外部记忆（omni/dsh 的上下文）
   * 该知道这一轮；为假时只记账，不回注。
   */
  readonly settleTurn: (turn: {
    readonly ticket: { readonly no: number; readonly gen: number };
    readonly truncated: boolean;
    readonly reflect: boolean;
  }) => void;
  readonly log?: (line: string) => void;
}

/** 按顺序执行一批意图。抛错不外抛：一个意图失败不该让整轮静音 */
export function applyEffects(effects: readonly Effect[], ports: KernelPorts): void {
  for (const effect of effects) {
    try {
      switch (effect.type) {
        case 'stopDeviceAudio':
          ports.stopDeviceAudio();
          break;
        case 'invalidateTurn':
          ports.invalidateTurn(effect.ticket);
          break;
        case 'abortEngine':
          ports.abortEngine(effect.reason);
          break;
        case 'settleTurn':
          ports.settleTurn({
            ticket: effect.ticket,
            truncated: effect.outcome.truncated,
            reflect: effect.reflect,
          });
          break;
      }
    } catch (error) {
      ports.log?.(`  内核    ✗ 意图 ${effect.type} 执行失败：${(error as Error).message}`);
    }
  }
}
