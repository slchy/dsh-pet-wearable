/**
 * 内核解释器：把 {@link Effect} 翻译成真实世界的动作，并持有**唯一一份**内核状态。
 *
 * 内核（`kernel.ts`）只声明意图，这里负责执行。分开的好处是**协议脏活不出内核**：
 * DashScope 那种「discard 时还没拿到 assistantItemId，必须等 response.done 再发
 * item.delete」的实现细节，全在这一层之下的适配器里，`step()` 一行都不用知道。
 *
 * ## 两种用法（别混着用）
 *
 * | 用法 | 谁会调 | 干什么 |
 * |:--|:--|:--|
 * | `dispatch(event)` | `DialogFsm` 门面、**纯回放 / 离线对账 / 单测里的事件推演** | 只推状态 + 广播给订阅者，**不执行**任何副作用 |
 * | `dispatchAndApply(event, ports?)` | **生产执行**：`DialogRuntime` 装配层用 `attachPorts` 绑好端口后调用 | 推进 + `applyEffects()` |
 * | `attachPorts(ports)` | 装配层 | 绑一次，此后 `dispatchAndApply` 用它 |
 *
 * 一句话：`dispatch` 是给"只想看内核怎么走"的场景（回放、单测、形式化验证），
 * `dispatchAndApply` 才是会真的停音频 / 作废轮次 / 回注记忆的那条路。
 *
 * 为什么不干脆让 `dispatch` 自动执行：同一批意图**只许执行一次**。门面里每个方法都
 * 走 `dispatch`，如果它暗中执行副作用，装配层再调一次 `dispatchAndApply` 就是双份
 * （`audio.stop` 发两遍只是噪音，`settleTurn` 发两遍就是重复回注）。
 *
 * 这一层是唯一允许出现 `await` / 定时器的地方 —— 但它本身不带 I/O：
 * 状态在 `KernelState` 里，端口由装配层注入。
 */
import {
  initialKernelState,
  step,
  type Effect,
  type KernelEvent,
  type KernelState,
  type SettlementInject,
} from './kernel.ts';
import type { Lane } from './turn-router.ts';

/**
 * 一条结算意图的**完整**快照（`settleTurn` 端口收到的就是它）。
 *
 * 这几个字段在 `kernel.ts` 的 `settle()` 里**一次算出**，执行层不许自己再判一遍
 * —— 以前 `turn-runner` 绕开 `reflect` 按 `audioBytes === 0` 自己判口气，两边会漂。
 * `lane` / `endedAtMs` 是记账要用的身份与时刻，跟着结算一起流到端口。
 */
export interface KernelSettlement {
  readonly ticket: { readonly no: number; readonly gen: number };
  /** 用户少听了一段（内容面） */
  readonly truncated: boolean;
  /** 用户**听全了** —— 外部记忆该知道这一轮 */
  readonly reflect: boolean;
  /** 回注口气：`spoken` / `unspoken` / `none` */
  readonly inject: SettlementInject;
  readonly heardMs: number;
  readonly totalAudioMs: number;
  /** 这一轮由谁答的；`null` = 没人报过 `turnAnswered` */
  readonly lane: Lane | null;
  /** 结算时刻（宿主时钟） */
  readonly endedAtMs: number;
}

/** 解释器要动的那些东西。全部由装配层注入，内核与解释器都不自己 new */
export interface KernelPorts {
  /** 让设备停止播放（`{"op":"audio.stop"}`） */
  readonly stopDeviceAudio: () => void;
  /** 作废一轮：清投机、摘掉在等的答复。`reason` 区分插话与连接结束 */
  readonly invalidateTurn: (
    ticket: { readonly no: number; readonly gen: number },
    reason?: 'bargeIn' | 'closed',
  ) => void;
  /** 放弃引擎在途投机 */
  readonly abortEngine: (reason: 'delegated' | 'superseded' | 'barge_in') => void;
  /**
   * 一轮结算（见 {@link KernelSettlement}）。
   *
   * 整份快照**同源**（都在 `kernel.ts` 的 `settle()` 里一次算出），执行层不许
   * 自己再判一遍。
   */
  readonly settleTurn: (turn: KernelSettlement) => void;
  readonly log?: (line: string) => void;
}

/** 状态转移的观察者（只读，不参与决策） */
export type KernelListener = (
  prev: KernelState,
  next: KernelState,
  event: KernelEvent,
  effects: readonly Effect[],
) => void;

/** 按顺序执行一批意图。抛错不外抛：一个意图失败不该让整轮静音 */
export function applyEffects(effects: readonly Effect[], ports: KernelPorts): void {
  for (const effect of effects) {
    try {
      switch (effect.type) {
        case 'stopDeviceAudio':
          ports.stopDeviceAudio();
          break;
        case 'invalidateTurn':
          ports.invalidateTurn(effect.ticket, effect.reason);
          break;
        case 'abortEngine':
          ports.abortEngine(effect.reason);
          break;
        case 'settleTurn':
          ports.settleTurn({
            ticket: effect.ticket,
            truncated: effect.outcome.truncated,
            reflect: effect.reflect,
            inject: effect.inject,
            heardMs: effect.outcome.heardMs,
            totalAudioMs: effect.outcome.totalAudioMs,
            lane: effect.lane,
            endedAtMs: effect.endedAtMs,
          });
          break;
      }
    } catch (error) {
      ports.log?.(`  内核    ✗ 意图 ${effect.type} 执行失败：${(error as Error).message}`);
    }
  }
}

/**
 * 内核运行时：**唯一一份** `KernelState` + 转移广播。
 *
 * 一个会话只该有一个实例：`SessionCore.runtime` 把它透出来，`DialogFsm` 是它的门面，
 * Wave 3 的 `TurnRunner` / `VoiceConnection` 共用同一个 —— 这样「相位」和「账本」
 * 不会各算一份。
 */
export class KernelRuntime {
  private _state: KernelState;
  private _ports: KernelPorts | null;
  /** 订阅者用快照遍历：回调里退订/再订阅不会漏发或跳发 */
  private readonly listeners: KernelListener[] = [];

  constructor(state: KernelState = initialKernelState(), ports: KernelPorts | null = null) {
    this._state = state;
    this._ports = ports;
  }

  /** 当前状态的只读快照（**不要**改它：内核产出的都是不可变对象） */
  get state(): KernelState {
    return this._state;
  }

  /** 当前绑定的端口（`null` = 没人执行副作用，纯推演） */
  get ports(): KernelPorts | null {
    return this._ports;
  }

  /** 绑/解绑端口。解绑传 `null`。 */
  attachPorts(ports: KernelPorts | null): void {
    this._ports = ports;
  }

  /**
   * 推进一条事件，**只改状态、不执行副作用**。
   *
   * 纯回放 / 离线对账 / 单测里的事件推演走这里 —— 即使 `attachPorts` 绑了端口，
   * 它也不会碰。生产执行见 {@link dispatchAndApply}。
   *
   * @returns 内核声明的意图（调用方决定要不要 `applyEffects`）
   */
  dispatch(event: KernelEvent): readonly Effect[] {
    const prev = this._state;
    const [next, effects] = step(prev, event);
    this._state = next;
    // 观察者出错不许影响内核推进：它只读，坏了是它自己的事
    for (const listener of [...this.listeners]) {
      try {
        listener(prev, next, event, effects);
      } catch {
        // 静默：日志由订阅者自己负责，内核不反向依赖它
      }
    }
    return effects;
  }

  /**
   * 推进一条事件并**执行**它声明的意图（生产路径）。
   *
   * 装配层（`DialogRuntime`）先 `attachPorts(...)` 绑好端口，之后每一条事件都走这里：
   * 停音频、作废轮次、结算回注都真的落到外部世界。
   *
   * @param ports 不传就用 {@link attachPorts} 绑定的那一份；显式传 `null` 表示这次不执行
   */
  dispatchAndApply(
    event: KernelEvent,
    ports: KernelPorts | null = this._ports,
  ): readonly Effect[] {
    const effects = this.dispatch(event);
    if (ports !== null) {
      applyEffects(effects, ports);
    }
    return effects;
  }

  /**
   * 订阅**真实**状态转移（每次 `dispatch` 都会通知，哪怕状态没变）。
   *
   * 外层（`DialogFsm.onState` / `onInvalidate`、`DialogRuntime` 的状态观测、日志）
   * 都从这里单点拿，**不许**再去轮询自己的副本 —— 那就是双份状态的起点。
   *
   * @returns 退订函数
   */
  subscribe(listener: KernelListener): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) {
        this.listeners.splice(at, 1);
      }
    };
  }
}
