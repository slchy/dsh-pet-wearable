/**
 * 确定性控制内核：**纯 Mealy 机**。
 *
 * ```
 * step(state, event) → [state', effects[]]
 * ```
 *
 * 这个文件里没有 `await`、没有 `setTimeout`、没有 socket、没有 Promise。所有输入都是
 * 显式事件，所有输出都是**声明式意图**（`Effect`）—— 谁去执行、怎么执行，由
 * `kernel-runtime.ts` 的解释器决定。于是同一份 `(state, event[])` 序列在任何机器上
 * `reduce` 出完全一致的结果，回放不需要开 WS、不需要等真实时间。
 *
 * ## 为什么要做成纯函数
 *
 * [turn-runner.ts] 是一条 800 行的 `async` 泵：它 `await` 回执、`await` dsh、`await`
 * TTS，同时在 `await` 之间改状态机。真机上已经踩过它的典型死法 ——
 * 「`await` 回执时插话进来把状态改了，老协程醒来又把新状态覆盖掉」。
 * 把**判定**收进纯函数之后，这类重入在结构上就不存在了：`step` 是原子的同步函数，
 * 抢占只可能发生在两次 `step` 之间，而那时状态已经是完整的一份。
 *
 * ## 四个正交区域
 *
 * 全双工语音里「用户在不在说话」「ASR 解没解完」「设备在不在播」「谁答过什么」是
 * **同时发生、独立演进**的四件事。硬塞进一个枚举，状态数指数爆炸；所以按 Harel 的
 * 正交区域拆开，跨区只通过**带因果戳的事件**通信、只读对方的快照：
 *
 * | 区域 | 回答什么 | 尺子 |
 * |:--|:--|:--|
 * | `input` | 这一句说完了没、解码在不在途 | 逻辑因果（`commitSeq`） |
 * | `dialog` | 话筒主权在谁手上（listening/thinking/speaking） | 逻辑因果（票据 `no`/`gen`） |
 * | `playback` | 声音播到哪了 | **媒体时间**（字节/采样率） |
 * | `ledger` | 谁答过、答的什么 | — |
 *
 * 三条交互律：
 *
 * 1. **事件自带出生证**：跨异步边界的请求出发时盖上 `commitSeq`/票据，结果回来原样带回。
 * 2. **控制权与物理结算分离**：`stale`（票据被顶掉，瞬时）归 `dialog`；
 *    `truncated`（少听了，后验）归 `playback`。两者分属不同区域就不会再打架。
 * 3. **跨区只读快照**：判打断只比 `event.commitSeq > dialog.ticket.baseCommitSeq`，
 *    不回头去问 ASR「你是不是还在解」。
 *
 * ## 运行时边界（现状，别搞混）
 *
 * | 判定 | 现在归谁 |
 * |:--|:--|
 * | 能不能打断（旧段 vs 新话） | `causal.ts` 的纯函数 —— `voice-session` 与内核**调同一个** |
 * | 这一轮听到多少、少听没少听、要不要回注 | **本文件**（`turn-runner` 只喂事实、只执行结算意图） |
 * | 话筒主权相位（listening/thinking/speaking） | `DialogFsm`（它本身就是同步纯状态机） |
 *
 * 也就是说：泵（`turn-runner`）仍然 `await` TTS/模型，但**它不再自己算账**。
 * 把 `DialogFsm` 的相位也搬进这里（让 `dialog` 区域成为唯一相位真相源）是下一步，
 * 动的是 460 行 FSM 与全部调用点，得单独一次改动。
 */
import { isPreTurnSegment, isStaleTicket } from './causal.ts';
import { outcomeOf, type TurnOutcome } from './engine-contract.ts';
import type { TurnTicket } from './dialog-fsm.ts';
import type { Lane } from './turn-router.ts';

/** 声学 + ASR 区域：只记"这一句说到哪了"的离散事实 */
export interface InputRegion {
  /** 当前能量门周期号（`AudioFrame.gateSeq`）。只作参考，不参与因果裁决 */
  readonly gateSeq: number;
  /** 已经发出的第几发 ASR commit */
  readonly commitSeq: number;
  /** 有在途 commit 还没收到 `.completed` */
  readonly awaitingDecode: boolean;
}

/** 话筒主权区域 */
export interface DialogRegion {
  readonly phase: 'listening' | 'awaiting_shot' | 'thinking' | 'speaking' | 'ending' | 'closed';
  /** 当前有效票据；`null` = 还没有过一轮 */
  readonly ticket: TurnTicket | null;
}

/** 物理播音区域：唯一的尺子是媒体时间 */
export interface PlaybackRegion {
  /** 这些媒体数据属于哪一轮。`null` = 还没有人出声 */
  readonly ticket: TurnTicket | null;
  /** 首块音频下发的墙钟时刻；`null` = 这一轮还没出声 */
  readonly firstAudioAtMs: number | null;
  /** 已经**下发到设备**的媒体时长（ms）。字节/采样率，不是墙钟 */
  readonly sentMediaMs: number;
  /** 设备回执「播完了」的墙钟时刻；`null` = 没回执 / 不支持 */
  readonly playedAtMs: number | null;
}

/** 对话账本区域：唯一真相源 */
export interface LedgerRegion {
  readonly lastLane: Lane | null;
  readonly lastAnsweredAtMs: number | null;
  /** 最近一轮的结算（少听没少听在这里落定，回注记忆看它） */
  readonly lastOutcome: TurnOutcome | null;
  /**
   * 最近一次结算对应的轮次。
   *
   * 打断**当场**就结算了那一轮（用户听到多少是后验事实，清了播放区就没了），
   * 所以那条协程跑到尾巴再发 `turnEnded` 时不能拿空播放区重算一遍 ——
   * 那会把"少听了一半"重算成"听了 0 秒、也没少听"，于是该吞的答案被回注。
   */
  readonly lastSettled: {
    readonly ticket: TurnTicket;
    readonly outcome: TurnOutcome;
    readonly reflect: boolean;
  } | null;
}

/** 内核状态：四个正交区域的快照。**不含 socket / promise / timer** */
export interface KernelState {
  readonly input: InputRegion;
  readonly dialog: DialogRegion;
  readonly playback: PlaybackRegion;
  readonly ledger: LedgerRegion;
}

/**
 * 外部事实事件。**时间流逝也是事件** —— 内核里绝不出现 `await sleep()`；
 * 超时由外部发一条带出生纪元的 `TimerFired` 进来。
 */
export type KernelEvent =
  | { readonly type: 'gate'; readonly gateSeq: number }
  | { readonly type: 'asrCommit'; readonly commitSeq: number }
  | { readonly type: 'decodeSettled'; readonly commitSeq: number }
  /** 用户说了话（中间结果或定稿）。**带出生证**，否则内核无从判因果 */
  | {
    readonly type: 'userSpeech';
    readonly commitSeq: number;
    readonly final: boolean;
    /** 到达时刻（墙钟）。只用来给被打断的那一轮结算，**不参与因果裁决** */
    readonly atMs: number;
  }
  | { readonly type: 'turnStarted'; readonly ticket: TurnTicket; readonly atMs: number }
  | { readonly type: 'fsmPhase'; readonly phase: DialogRegion['phase'] }
  | { readonly type: 'audioSent'; readonly mediaMs: number; readonly atMs: number }
  | { readonly type: 'devicePlayed'; readonly atMs: number }
  | { readonly type: 'turnEnded'; readonly ticket: TurnTicket; readonly atMs: number }
  /**
   * 这一轮**已经作废**（插话 / 断连 / 被新轮顶掉）。
   *
   * 由发现这件事的人发（目前是 `TurnRunner`：它拿票据跟 FSM 比）。内核自己不猜 ——
   * 它只认事实事件，这也是"事件按发生顺序瞬时到达"这个假设被真正打破的地方。
   */
  | { readonly type: 'ticketInvalidated'; readonly ticket: TurnTicket }
  /** 一轮由谁答的（快/慢/omni），记账用 */
  | { readonly type: 'turnAnswered'; readonly lane: Lane }
  | { readonly type: 'closed' };

/**
 * 声明式意图。内核**不执行**任何 I/O，只声明"外部世界接下来该干什么"。
 *
 * 高階意图（`DiscardSpeculation` / `AbortTurn`），不是协议帧 ——
 * DashScope 那种「discard 时还没拿到 assistantItemId，必须等 response.done 再发
 * item.delete」的脏活全部由协议适配器自己的局部状态机消化，内核看不见。
 */
export type Effect =
  /** 让设备停止播放（清掉它缓冲里还没播的那截） */
  | { readonly type: 'stopDeviceAudio' }
  /** 作废这一轮：老轮从此无权修改任何区域 */
  | { readonly type: 'invalidateTurn'; readonly ticket: TurnTicket }
  /** 放弃引擎的在途投机（委派给 dsh、被插话、被新轮顶掉） */
  | { readonly type: 'abortEngine'; readonly reason: 'delegated' | 'superseded' | 'barge_in' }
  /** 这一轮结算：账本落定（少听没少听在 `outcome.truncated` 里） */
  | {
    readonly type: 'settleTurn';
    readonly ticket: TurnTicket;
    readonly outcome: TurnOutcome;
    /** 用户听全了 → 外部记忆（omni/dsh 上下文）该知道这一轮 */
    readonly reflect: boolean;
  };

export function initialKernelState(gateSeq = 0): KernelState {
  return {
    input: { gateSeq, commitSeq: 0, awaitingDecode: false },
    dialog: { phase: 'listening', ticket: null },
    playback: { ticket: null, firstAudioAtMs: null, sentMediaMs: 0, playedAtMs: null },
    ledger: { lastLane: null, lastAnsweredAtMs: null, lastOutcome: null, lastSettled: null },
  };
}

/**
 * 因果屏障：**所有状态转移前的统一守门人**。
 *
 * 旧段（开轮之前就已经在飞的转写）只能归档：它既不能打断，也不能开新轮。
 * 判据在 `causal.ts`，这里只是把"要不要放行"收成一处。
 */
export function isCausallyStale(state: KernelState, event: KernelEvent): boolean {
  if (event.type !== 'userSpeech') {
    return false;
  }
  const ticket = state.dialog.ticket;
  return isPreTurnSegment(
    { commitSeq: event.commitSeq },
    { baseCommitSeq: ticket?.baseCommitSeq },
  );
}

/** 一轮的时长（媒体时间）。**这条计算只能有一个地方**，见 `outcomeOf` */
export function outcomeAt(
  playback: PlaybackRegion,
  ticket: TurnTicket,
  atMs: number,
  stale: boolean,
): TurnOutcome {
  return outcomeOf({
    stale,
    firstAudioAtMs: playback.firstAudioAtMs ?? -1,
    nowMs: atMs,
    totalAudioMs: playback.sentMediaMs,
    sentMediaMs: playback.sentMediaMs,
  });
}

/**
 * 一轮被顶掉 / 播完时的结算意图。**控制面与物理面在这里拆权**：
 * `stale` 由票据比对得出（离散、瞬时），`truncated` 由媒体游标得出（连续、后验）。
 * 回注记忆只看 `truncated` —— 用户听全了这一轮才算"他知道这件事"。
 */
function settle(
  playback: PlaybackRegion,
  ticket: TurnTicket,
  atMs: number,
  stale: boolean,
): Extract<Effect, { type: 'settleTurn' }> {
  const outcome = outcomeAt(playback, ticket, atMs, stale);
  return {
    type: 'settleTurn',
    ticket,
    outcome,
    reflect: outcome.totalAudioMs > 0 && !outcome.truncated,
  };
}

/**
 * 纯转移。同一份 `(state, event)` 永远同一个结果 —— 可以在任何机器上离线 reduce。
 */
export function step(state: KernelState, event: KernelEvent): [KernelState, Effect[]] {
  // 1. 因果屏障：旧段一律只归档
  if (isCausallyStale(state, event)) {
    return [state, []];
  }

  switch (event.type) {
    case 'gate':
      return [
        { ...state, input: { ...state.input, gateSeq: event.gateSeq } },
        [],
      ];

    case 'asrCommit':
      return [
        {
          ...state,
          input: {
            ...state.input,
            commitSeq: Math.max(state.input.commitSeq, event.commitSeq),
            awaitingDecode: true,
          },
        },
        [],
      ];

    case 'decodeSettled':
      // 迟到的 `.completed` 不能把"又有新 commit 在解"这件事抹掉
      if (event.commitSeq < state.input.commitSeq) {
        return [state, []];
      }
      return [
        { ...state, input: { ...state.input, awaitingDecode: false } },
        [],
      ];

    case 'userSpeech': {
      // 能不能打断：只有 `speaking`，且这段**不是**开轮前的旧音频（上面已挡）。
      // 因果坐标比的是开轮水位线，不是到达时刻 —— 这就是"自己后半句杀自己"的解药。
      if (state.dialog.phase !== 'speaking' || state.dialog.ticket === null) {
        return [state, []];
      }
      const ticket = state.dialog.ticket;
      const effects: Effect[] = [
        { type: 'stopDeviceAudio' },
        { type: 'invalidateTurn', ticket },
        { type: 'abortEngine', reason: 'barge_in' },
      ];
      let ledger = state.ledger;
      // 被打断的这一刻就是这一轮该结算的时刻：**先结算再清区**，
      // 否则"用户听到多少"这条后验事实会随着播放区清零一起消失。
      if (state.playback.ticket !== null) {
        const effect = settle(state.playback, state.playback.ticket, event.atMs, true);
        effects.push(effect);
        ledger = {
          ...ledger,
          lastOutcome: effect.outcome,
          lastSettled: {
            ticket: effect.ticket,
            outcome: effect.outcome,
            reflect: effect.reflect,
          },
        };
      }
      return [
        {
          ...state,
          dialog: { ...state.dialog, phase: 'listening', ticket: null },
          playback: { ticket: null, firstAudioAtMs: null, sentMediaMs: 0, playedAtMs: null },
          ledger,
        },
        effects,
      ];
    }

    case 'turnStarted': {
      const effects: Effect[] = [];
      let ledger = state.ledger;
      // 上一轮还挂着（被新轮顶掉）：用**它自己那份**播放记录结算，再开新的一轮。
      // 真机 `20261123-002440` 第 3 轮就是这样：19.44 s 音频正好播完、用户 26 ms 后开口，
      // 老轮 stale 但没少听 —— 该回注记忆。播放区若不按轮次归档，这条事实就丢了。
      const prev = state.playback;
      if (prev.ticket !== null && isStaleTicket(event.ticket, prev.ticket)) {
        const effect = settle(prev, prev.ticket, event.atMs, true);
        effects.push(effect);
        ledger = {
          ...ledger,
          lastOutcome: effect.outcome,
          lastSettled: {
            ticket: effect.ticket,
            outcome: effect.outcome,
            reflect: effect.reflect,
          },
        };
      }
      return [
        {
          ...state,
          dialog: { phase: 'thinking', ticket: event.ticket },
          playback: { ticket: event.ticket, firstAudioAtMs: null, sentMediaMs: 0, playedAtMs: null },
          ledger,
        },
        effects,
      ];
    }

    case 'fsmPhase':
      return [{ ...state, dialog: { ...state.dialog, phase: event.phase } }, []];

    case 'audioSent': {
      const first = state.playback.firstAudioAtMs;
      return [
        {
          ...state,
          playback: {
            ...state.playback,
            firstAudioAtMs: first ?? event.atMs,
            sentMediaMs: Math.max(state.playback.sentMediaMs, event.mediaMs),
          },
        },
        [],
      ];
    }
    case 'devicePlayed':
      return [{ ...state, playback: { ...state.playback, playedAtMs: event.atMs } }, []];

    case 'turnAnswered':
      return [
        {
          ...state,
          ledger: {
            ...state.ledger,
            lastLane: event.lane,
          },
        },
        [],
      ];

    case 'ticketInvalidated': {
      // 只作废"就是这一轮"的票据；迟到的作废不能摘掉下一轮的（与 `cancelTurn` 同一条规矩）
      const current = state.dialog.ticket;
      if (current === null || isStaleTicket(current, event.ticket)) {
        return [state, []];
      }
      return [{ ...state, dialog: { ...state.dialog, ticket: null } }, []];
    }

    case 'turnEnded': {
      // 已经结算过（打断那一刻就结了）：原样再声明一次，别拿空播放区重算
      const settled = state.ledger.lastSettled;
      if (settled !== null && !isStaleTicket(settled.ticket, event.ticket)) {
        return [
          state,
          [{
            type: 'settleTurn',
            ticket: settled.ticket,
            outcome: settled.outcome,
            reflect: settled.reflect,
          }],
        ];
      }
      const stale = isStaleTicket(state.dialog.ticket, event.ticket);
      // 播放记录属于哪一轮就结算哪一轮：迟到的 `turnEnded` 不能把新一轮的媒体算进来
      const playback = state.playback.ticket !== null
        && !isStaleTicket(state.playback.ticket, event.ticket)
        ? state.playback
        : { ...state.playback, ticket: event.ticket, sentMediaMs: 0, firstAudioAtMs: null };
      const effect = settle(playback, event.ticket, event.atMs, stale);
      return [
        {
          ...state,
          dialog: stale ? state.dialog : { ...state.dialog, phase: 'listening', ticket: null },
          playback: { ...state.playback, ticket: null, firstAudioAtMs: null, sentMediaMs: 0 },
          ledger: {
            ...state.ledger,
            lastAnsweredAtMs: event.atMs,
            lastOutcome: effect.outcome,
            lastSettled: {
              ticket: effect.ticket,
              outcome: effect.outcome,
              reflect: effect.reflect,
            },
          },
        },
        [effect],
      ];
    }

    case 'closed':
      return [{ ...state, dialog: { phase: 'closed', ticket: null } }, []];
  }
}

/** 把一串事件按序 reduce —— 离线回放的唯一入口 */
export function reduceKernel(
  state: KernelState,
  events: readonly KernelEvent[],
): { readonly state: KernelState; readonly effects: readonly Effect[] } {
  let current = state;
  const effects: Effect[] = [];
  for (const event of events) {
    const [next, out] = step(current, event);
    current = next;
    effects.push(...out);
  }
  return { state: current, effects };
}
