/**
 * 确定性控制内核：**纯 Mealy 机**，也是**唯一**的相位真相源。
 *
 * ```
 * step(state, event) → [state', effects[]]
 * ```
 *
 * 实现上 `step()` 只做三件事：**因果屏障**、**吸收态守门**、**按区域路由**；
 * 真正的转移分别落在 `stepInput` / `stepPlayback` / `stepDialog` 三个窄函数里，
 * 每个只读自己那一区的字段。
 *
 * 这个文件里没有 `await`、没有 `setTimeout`、没有 socket、没有 Promise、没有 `Date.now`。
 * 所有输入都是显式事件，所有输出都是**声明式意图**（`Effect`）—— 谁去执行、怎么执行，
 * 由 `kernel-runtime.ts` 的 `KernelRuntime` 决定。于是同一份 `(state, event[])` 序列在
 * 任何机器上 `reduce` 出完全一致的结果，回放不需要开 WS、不需要等真实时间。
 *
 * ## 为什么要做成纯函数
 *
 * [turn-runner.ts] 是一条 `async` 泵：它 `await` 回执、`await` dsh、`await`
 * TTS，同时在 `await` 之间改状态机。真机上已经踩过它的典型死法 ——
 * 「`await` 回执时插话进来把状态改了，老协程醒来又把新状态覆盖掉」。（这句写于
 * 抽出内核之前：那时它 835 行 / 20 个 `await`；现在 1147 行 / 27 个，但**判定已经
 * 搬到这里**，它只喂事实、只执行意图。）
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
 * | `dialog` | 话筒主权（listening/awaiting_shot/thinking/speaking/ending/closed） | 逻辑因果（票据 `no`/`gen`） |
 * | `playback` | 声音播到哪了 | **媒体时间**（字节/采样率） |
 * | `ledger` | 谁答过、答的什么、该不该回注 | — |
 *
 * 三条交互律：
 *
 * 1. **事件自带出生证**：跨异步边界的请求出发时盖上 `commitSeq`/票据，结果回来原样带回。
 * 2. **控制权与物理结算分离**：`stale`（票据被顶掉，瞬时）归 `dialog`；
 *    `truncated`（少听了，后验）归 `playback`。两者分属不同区域就不会再打架。
 * 3. **跨区只读快照**：判打断只比 `commitSeq > dialog.ticket.baseCommitSeq`，
 *    不回头去问 ASR「你是不是还在解」。
 *
 * ## 唯一相位真相源（Option A）
 *
 * 以前相位在 `dialog-fsm.ts` 的 `DialogFsm` 里另算一份，内核只做记账；两边各有一套
 * `turn` / `gen` / `endAfterSpeech`，改一处就漂。现在 `dialog` 区域**就是**那台状态机：
 *
 * - `beginTurn` / `beginAwaitShot` / `abortAwaitShot` / `receiptStarted` / `receiptEnded` /
 *   `audioStarted` / `audioDone` / `requestEnd` / `bargeIn` / `close`（`closed`）全部走这里；
 * - `DialogFsm` 退化成一层薄门面（`runtime.dispatch(...)` + 读 `runtime.state.dialog`），
 *   它自己的 `onState` / `onInvalidate` 由 `KernelRuntime` 的转移通知驱动 —— 单点订阅，
 *   不再有第二份状态；
 * - 老的记账事件（`turnStarted` / `fsmPhase` / `audioSent` / `devicePlayed` /
 *   `turnEnded` / `ticketInvalidated` / `turnAnswered` / `closed`）**全部保留**：
 *   它们是事实输入，不是第二套判定。
 *
 * `closed` 是**吸收态**：`phase === 'closed'` 之后，任何事件都不许把相位拉回非 closed。
 *
 * ## 回注语义只有一份（`SettlementInject`）
 *
 * 一轮结算时要回答「外部记忆（omni/dsh 上下文）该不该知道这一轮、以什么口气知道」。
 * 以前有两个算法：内核算 `reflect`，而 `turn-runner` 又按 `audioBytes === 0` 自己判
 * `unspoken`；两处口径一漂，该注的答案就被吞（真机 `20261123-053719` 第 2 轮丢了
 * 《其主之声》）。现在 `settleTurn` 同时给出 `inject` 三态：
 *
 * | 条件 | `inject` | `reflect` | 含义 |
 * |:--|:--|:--|:--|
 * | `truncated`（用户少听了一段） | `none` | `false` | 不注 |
 * | 听全了（`totalAudioMs > 0` 且没少听） | `spoken` | `true` | 按「用户听到了」注 |
 * | 有结论但一个字都没播出去 | `unspoken` | `false` | 仍要告知上下文，但不是「他听到了」 |
 */
import { isPreTurnSegment, isStaleTicket } from './causal.ts';
import { outcomeOf, type SettlementInject, type TurnOutcome } from './engine-contract.ts';
import type { Lane } from './turn-router.ts';
import type { TurnReport } from './turn-report.ts';

/**
 * 对话相位。
 *
 * **定义在这里**：`dialog` 区域是相位的唯一真相源，把类型留在 `dialog-fsm.ts` 会让
 * 内核反向依赖那层门面（`kernel.ts → dialog-fsm.ts → kernel-runtime.ts → kernel.ts`
 * 形成模块环，ESM 下能跑，但谁先求值谁踩 TDZ）。`dialog-fsm.ts` 原样转出，
 * 所以既有 `from './dialog-fsm.ts'` 的导入一个字都不用改。
 */
export type DialogState = 'listening' | 'awaiting_shot' | 'thinking' | 'speaking' | 'ending' | 'closed';

/**
 * 一轮的票据。
 *
 * - `no`：轮次号，判断「这还是不是当前这一轮」
 * - `gen`：代次，判断「这一轮是否已被插话作废」
 * - `baseCommitSeq` / `startedAtMs`：开轮瞬间锁存的因果水位线（见 `engine-contract.ts`
 *   契约③）。由确定性内核在 `beginTurn` 时经宿主上下文锁存，此后不变。
 */
export interface TurnTicket {
  readonly no: number;
  readonly gen: number;
  /**
   * 开轮瞬间**已发出**的最大 ASR commit 序号（见 `engine-contract.ts` 契约③）。
   *
   * 判「这条转写是开轮前录的还是开轮后的」用它 —— 比时钟干净，也不会因为
   * 某一处换了时钟就静默失效（这个坑今天踩过）。
   *
   * 可选：只有装配层注入了 `DialogFsmContext` 才有（单测/离线场景没有 ASR）。
   */
  readonly baseCommitSeq?: number;
  /** 开轮时刻（宿主时钟），同上 */
  readonly startedAtMs?: number;
}

/** 声学 + ASR 区域：只记"这一句说到哪了"的离散事实 */
export interface InputRegion {
  /** 当前能量门周期号（`AudioFrame.gateSeq`）。只作参考，不参与因果裁决 */
  readonly gateSeq: number;
  /** 已经发出的第几发 ASR commit */
  readonly commitSeq: number;
  /** 有在途 commit 还没收到 `.completed` */
  readonly awaitingDecode: boolean;
}

/**
 * 话筒主权区域：**唯一的相位真相源**。
 *
 * 每个字段都是 `DialogFsm` 原先自己维护的那一份；现在只有这里算，门面只读。
 */
export interface DialogRegion {
  /** 当前相位。`closed` 是吸收态 */
  readonly phase: DialogState;
  /** 当前轮次号（从 1 开始；`0` = 还没开过轮） */
  readonly turn: number;
  /** 代次：每次插话 +1，用来作废排队中的轮次 */
  readonly gen: number;
  /** 模型已经要求结束：等这段音频播完再走 `ending` */
  readonly endAfterSpeech: boolean;
  /** 当前这段 `speaking` 只是回执在响（真回答的音频还没开始） */
  readonly receiptOnly: boolean;
  /** 最近一次**相位转移**的原因（档案里的 `dialog.state.why`） */
  readonly lastWhy: string;
  /**
   * 当前有效票据；`null` = 还没有过一轮 / 被插话作废 / 已关闭。
   *
   * 票据上带**开轮瞬间锁存的因果水位线**（`baseCommitSeq` / `startedAtMs`）：
   * 这一轮的值此后不再变，所以迟到的转写拿它比，不会因为下一轮开始而被"刷新成新口径"。
   */
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

/**
 * 结算的**回注口气**：一句话说清「外部记忆该不该知道这一轮」。
 *
 * - `spoken`：用户听全了 → 内容与口气都成立，注；
 * - `unspoken`：这一轮有结论（比如 dsh 答了），但一个字都没播出去 → 内容仍要注，
 *   否则下一轮它会把同一件事再编一遍（真机 `20261123-053719` 第 2 轮）；
 * - `none`：用户少听了一段 → 不注。
 *
 * 定义搬去 `engine-contract.ts`（`turn-report.ts` 也要用它，放在这里会与
 * `turn-report.ts` 形成模块环）；这里**原样转出**，既有导入零破坏。
 */
export type { SettlementInject } from './engine-contract.ts';

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
    readonly inject: SettlementInject;
    /** 这一轮由谁答的（`null` = 没人报过 `turnAnswered`）。结算时一并锁存 */
    readonly lane: Lane | null;
    /** 结算时刻（宿主时钟）。与 `outcome` 同源，重述时不许换一个时刻 */
    readonly endedAtMs: number;
  } | null;
  /**
   * 最近一轮的**结构化结算快照**（`turn-report.ts`）。
   *
   * 只由 `turnReport` 事件写入，**不参与任何判定** —— 它不改相位、不产意图，
   * 连接进了吸收态 `closed` 之后仍然可以落账（失败轮的收尾就在那之后）。
   */
  readonly lastReport: TurnReport | null;
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
 *
 * 上半段是老的事实事件（记账/媒体/因果），**全部保留**；下半段是对话相位事件
 * （以前散在 `DialogFsm` 里，现在只有这一份）。
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
  /**
   * 一轮的**结算快照**（`turn-report.ts`）。
   *
   * 不是判定输入：只写 `ledger.lastReport`，不碰 `dialog.phase`、不产任何 `Effect`。
   * **故意不进 {@link PHASE_EVENTS}** —— 连接已进吸收态 `closed` 时，本轮收尾
   * 仍要能落账（失败轮的 `turnEnded` 与它都在那之后）。
   */
  | { readonly type: 'turnReport'; readonly report: TurnReport }
  | { readonly type: 'closed' }
  // ------------------------------------------------------------ 对话相位（唯一真相源）
  /**
   * 开一轮：`listening | awaiting_shot → thinking`；`thinking` 重入也是合法的
   * （"出声前吸收窗口"：用户在一半的句中停顿里又说了一句，旧票作废）。
   *
   * `baseCommitSeq` / `startedAtMs` 由宿主上下文在**开轮瞬间**给出，内核把它锁进
   * 新票据。从 `thinking` 重入时**沿用**上一张票的水位线 —— 那是同一轮内部的事，
   * 重记会把「开轮前录的那段」判据自己刷新掉。
   */
  | {
    readonly type: 'beginTurn';
    readonly atMs: number;
    readonly baseCommitSeq?: number;
    readonly startedAtMs?: number;
  }
  | { readonly type: 'beginAwaitShot' }
  | { readonly type: 'abortAwaitShot'; readonly why: string }
  /**
   * 回执开始出声。`ticket` 可选：带了就必须仍是当前轮
   * （`dialog.ticket !== null` 且 `{no, gen}` 都对得上），过期票是空操作。
   * 不带时保持旧的无参口径。
   */
  | { readonly type: 'receiptStarted'; readonly ticket?: TurnTicket }
  /** 回执这段 `speaking` 结束。票据规则与 {@link receiptStarted} 相同；过期票必为空操作 */
  | { readonly type: 'receiptEnded'; readonly ticket?: TurnTicket }
  | { readonly type: 'audioStarted'; readonly ticket: TurnTicket }
  | { readonly type: 'audioDone'; readonly ticket: TurnTicket }
  | { readonly type: 'requestEnd' }
  /**
   * 用户插话。`commitSeq` 是**产出这段转写的那一发 commit**（可选）：带上就先过
   * 因果屏障 —— 开轮前录的那段迟到转写不算插话。
   */
  | {
    readonly type: 'bargeIn';
    readonly why: string;
    readonly atMs: number;
    readonly commitSeq?: number;
  };

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
  | {
    readonly type: 'invalidateTurn';
    readonly ticket: TurnTicket;
    /** 为什么作废：插话 / 连接结束（执行层据此区分取消上游的口气） */
    readonly reason: 'bargeIn' | 'closed';
  }
  /** 放弃引擎的在途投机（委派给 dsh、被插话、被新轮顶掉） */
  | { readonly type: 'abortEngine'; readonly reason: 'delegated' | 'superseded' | 'barge_in' }
  /** 这一轮结算：账本落定（少听没少听在 `outcome.truncated` 里） */
  | {
    readonly type: 'settleTurn';
    readonly ticket: TurnTicket;
    readonly outcome: TurnOutcome;
    /** 用户听全了 → 外部记忆（omni/dsh 上下文）该知道这一轮 */
    readonly reflect: boolean;
    /** 回注口气：`spoken` / `unspoken` / `none`（见 {@link SettlementInject}） */
    readonly inject: SettlementInject;
    /** 这一轮由谁答的；整条结算链（含幂等重述）都带同一个值 */
    readonly lane: Lane | null;
    /** 结算时刻（宿主时钟）；重述时照抄，不拿新时刻重算 */
    readonly endedAtMs: number;
  };

const EMPTY_PLAYBACK: PlaybackRegion = {
  ticket: null,
  firstAudioAtMs: null,
  sentMediaMs: 0,
  playedAtMs: null,
};

/** 会动 `dialog.phase` 的事件：`closed` 之后一律吸收（`turnEnded` 只结算，不动相位） */
const PHASE_EVENTS: ReadonlySet<KernelEvent['type']> = new Set<KernelEvent['type']>([
  'beginTurn',
  'beginAwaitShot',
  'abortAwaitShot',
  'receiptStarted',
  'receiptEnded',
  'audioStarted',
  'audioDone',
  'requestEnd',
  'bargeIn',
  'userSpeech',
  'turnStarted',
  'fsmPhase',
]);

/**
 * 按**正交区域**给事件分家：`step()` 只做守门与路由，每个区域的转移各有一个
 * 窄函数。分组就是「谁在演进」——声学输入 / 物理播放 / 对话相位。
 *
 * 用 `Extract` / `Exclude` 从 `KernelEvent` 派生而不是手抄：新增一条事件时，
 * 三个区域的 switch 会在**编译期**报「少了一个 case」（函数签名不许返回
 * `undefined`），而不是悄悄落进某个 `default` 分支。
 */
type InputKernelEvent = Extract<
  KernelEvent,
  { type: 'gate' | 'asrCommit' | 'decodeSettled' | 'userSpeech' }
>;
type PlaybackKernelEvent = Extract<
  KernelEvent,
  { type: 'audioSent' | 'devicePlayed' | 'turnAnswered' | 'turnEnded' | 'turnReport' }
>;
type DialogKernelEvent = Exclude<KernelEvent, InputKernelEvent | PlaybackKernelEvent>;

export function initialKernelState(gateSeq = 0, initialLane: Lane | null = null): KernelState {
  return {
    input: { gateSeq, commitSeq: 0, awaitingDecode: false },
    dialog: {
      phase: 'listening',
      turn: 0,
      gen: 0,
      endAfterSpeech: false,
      receiptOnly: false,
      lastWhy: '',
      ticket: null,
    },
    playback: EMPTY_PLAYBACK,
    ledger: {
      lastLane: initialLane,
      lastAnsweredAtMs: null,
      lastOutcome: null,
      lastSettled: null,
      lastReport: null,
    },
  };
}

/**
 * 这发 `commitSeq` 是不是「开轮之前录进 ASR 的旧段」。
 *
 * 全仓唯一入口：内核的 `isCausallyStale` 与 `SessionCore` 的旧段拦截共用这一个函数，
 * 不再在 `voice-session.ts` 另写一份 `fromPreTurnSegment`。
 * 只在有活跃轮次（`thinking` / `speaking`）时生效。
 */
export function isPreTurnCommit(state: KernelState, commitSeq: number | undefined): boolean {
  if (commitSeq === undefined) {
    return false;
  }
  const { phase, ticket } = state.dialog;
  if (phase !== 'speaking' && phase !== 'thinking') {
    return false;
  }
  return isPreTurnSegment({ commitSeq }, { baseCommitSeq: ticket?.baseCommitSeq });
}

/**
 * 因果屏障：**所有状态转移前的统一守门人**。
 *
 * 旧段（开轮之前就已经在飞的转写）只能归档：它既不能打断，也不能开新轮。
 * 判据在 `causal.ts`，这里只是把"要不要放行"收成一处。
 *
 * 两类事件带出生证：`userSpeech`（ASR 出来的话）与 `bargeIn`（宿主转发的插话）。
 * 两者**共用同一个谓词** `isPreTurnCommit` —— 后者是可选的，宿主不知道 commit
 * 序号时不传，那就跳过这道闸（宁可放过一次插话，也不凭空吞掉一轮回答）。
 *
 * 没有活跃轮次的相位（`listening` / `awaiting_shot` / `ending` / `closed`）上，
 * `userSpeech` 本来也产生不了转移（`bargeInTransition` 只从 `speaking` 出发），
 * 所以这里返回 `false` 与旧行为完全等价。
 */
export function isCausallyStale(state: KernelState, event: KernelEvent): boolean {
  if (event.type === 'userSpeech' || event.type === 'bargeIn') {
    return isPreTurnCommit(state, event.commitSeq);
  }
  return false;
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
 *
 * 回注口径**只在这里算一次**（`inject`），执行层照单执行，别再自己按字节数判：
 * 以前 `turn-runner` 绕开 `reflect` 自己判 `audioBytes === 0`，两边迟早漂。
 */
function settle(
  playback: PlaybackRegion,
  ticket: TurnTicket,
  atMs: number,
  stale: boolean,
  lane: Lane | null,
): Extract<Effect, { type: 'settleTurn' }> {
  const outcome = outcomeAt(playback, ticket, atMs, stale);
  // 「用户听到了」：这一轮确实有声音下发，而且他听全了。
  // 注意 `totalAudioMs === 0` 时 `truncated` 必为 false（见 `outcomeOf`）——
  // 那不是"少听"，是"没播"，所以要区分成 `unspoken` 而不是 `spoken`。
  const reflect = outcome.totalAudioMs > 0 && !outcome.truncated;
  const inject: SettlementInject = outcome.truncated ? 'none' : reflect ? 'spoken' : 'unspoken';
  return { type: 'settleTurn', ticket, outcome, reflect, inject, lane, endedAtMs: atMs };
}

/** 把一次结算写进账本（`lastOutcome` + `lastSettled` 必须同源） */
function recordSettle(
  ledger: LedgerRegion,
  effect: Extract<Effect, { type: 'settleTurn' }>,
): LedgerRegion {
  return {
    ...ledger,
    lastOutcome: effect.outcome,
    lastSettled: {
      ticket: effect.ticket,
      outcome: effect.outcome,
      reflect: effect.reflect,
      inject: effect.inject,
      lane: effect.lane,
      endedAtMs: effect.endedAtMs,
    },
  };
}

/** 铸一张票。可选字段**不写空键**：`'baseCommitSeq' in t` 是装配层判断有没有注入的方式 */
function mintTicket(
  no: number,
  gen: number,
  base: { readonly baseCommitSeq?: number; readonly startedAtMs?: number },
): TurnTicket {
  return {
    no,
    gen,
    ...(base.baseCommitSeq === undefined ? {} : { baseCommitSeq: base.baseCommitSeq }),
    ...(base.startedAtMs === undefined ? {} : { startedAtMs: base.startedAtMs }),
  };
}

/** 这张票是不是"就是当前这一轮"（轮次与代次都要比，见 `causal.isStaleTicket`） */
function ticketMatches(dialog: DialogRegion, ticket: TurnTicket): boolean {
  return ticket.no === dialog.turn && ticket.gen === dialog.gen;
}

/**
 * 回执事件带了票据时，必须仍是当前这一轮。
 *
 * 判据就是 `dialog.ticket !== null && !isStaleTicket(dialog.ticket, ticket)`：
 * 票被插话清掉、被新轮顶掉，都不许再改相位。不带票据则保持旧的无参口径。
 */
function acceptsReceiptTicket(dialog: DialogRegion, ticket: TurnTicket | undefined): boolean {
  if (ticket === undefined) {
    return true;
  }
  return dialog.ticket !== null && !isStaleTicket(dialog.ticket, ticket);
}

/**
 * 开一轮的共同部分：结算被顶掉的上一轮（如果它还在播放区里），再开新的一轮。
 *
 * 真机 `20261123-002440` 第 3 轮：19.44 s 音频正好播完、用户 26 ms 后开口，
 * 老轮 stale 但没少听 —— 该回注记忆。播放区若不按轮次归档，这条事实就丢了。
 */
function startTurn(
  state: KernelState,
  ticket: TurnTicket,
  atMs: number,
  why: string,
): [KernelState, Effect[]] {
  const effects: Effect[] = [];
  let ledger = state.ledger;
  const prev = state.playback;
  if (prev.ticket !== null && isStaleTicket(ticket, prev.ticket)) {
    const effect = settle(prev, prev.ticket, atMs, true, ledger.lastLane);
    effects.push(effect);
    ledger = recordSettle(ledger, effect);
  }
  return [
    {
      ...state,
      dialog: {
        ...state.dialog,
        phase: 'thinking',
        turn: ticket.no,
        gen: ticket.gen,
        endAfterSpeech: false,
        // 上一轮的回执标志不能带进新轮，否则新轮的 audioDone 会把它当成回执直接返回。
        receiptOnly: false,
        ticket,
        lastWhy: why,
      },
      playback: { ticket, firstAudioAtMs: null, sentMediaMs: 0, playedAtMs: null },
      ledger,
    },
    effects,
  ];
}

/**
 * 插话的共同部分（`bargeIn` 事件与 `userSpeech` 在 speaking 期共用）。
 *
 * 只从 `speaking` 出发：`thinking` 期间用户说话不算插话 —— 否则 TTS 首块到达前
 * 那 ~1 s 里的一句正常话会打断掉还没出声的回复（实测：回放 0 字节被中断）。
 */
function bargeInTransition(
  state: KernelState,
  atMs: number,
  why: string,
): [KernelState, Effect[]] {
  const dialog = state.dialog;
  if (dialog.phase !== 'speaking') {
    return [state, []];
  }
  const effects: Effect[] = [{ type: 'stopDeviceAudio' }];
  if (dialog.ticket !== null) {
    effects.push({ type: 'invalidateTurn', ticket: dialog.ticket, reason: 'bargeIn' });
  }
  effects.push({ type: 'abortEngine', reason: 'barge_in' });
  let ledger = state.ledger;
  // 被打断的这一刻就是这一轮该结算的时刻：**先结算再清区**，
  // 否则"用户听到多少"这条后验事实会随着播放区清零一起消失。
  if (state.playback.ticket !== null) {
    const effect = settle(state.playback, state.playback.ticket, atMs, true, ledger.lastLane);
    effects.push(effect);
    ledger = recordSettle(ledger, effect);
  }
  const gen = dialog.gen + 1;
  return [
    {
      ...state,
      dialog: {
        ...dialog,
        phase: 'listening',
        gen,
        endAfterSpeech: false,
        receiptOnly: false,
        ticket: null,
        lastWhy: `插话「${why}」→ 代次 ${gen}`,
      },
      playback: EMPTY_PLAYBACK,
      ledger,
    },
    effects,
  ];
}

/**
 * 进入吸收态 `closed`：先声明"这一轮作废"（泵据此取消上游），再清票。
 *
 * `closed` 事件与 `fsmPhase:'closed'`（老档案回放）走同一条路 —— 否则相位到了
 * `closed` 却留着票据，迟到的 `turnEnded` 还能拿它结算。
 */
function closeTransition(state: KernelState): [KernelState, Effect[]] {
  if (state.dialog.phase === 'closed') {
    return [state, []];
  }
  const effects: Effect[] = state.dialog.ticket === null
    ? []
    : [{ type: 'invalidateTurn', ticket: state.dialog.ticket, reason: 'closed' }];
  return [
    {
      ...state,
      dialog: { ...state.dialog, phase: 'closed', ticket: null, lastWhy: '连接结束' },
    },
    effects,
  ];
}

/**
 * 纯转移。同一份 `(state, event)` 永远同一个结果 —— 可以在任何机器上离线 reduce。
 */
export function step(state: KernelState, event: KernelEvent): [KernelState, Effect[]] {
  // 1. 因果屏障：旧段一律只归档
  if (isCausallyStale(state, event)) {
    return [state, []];
  }
  // 2. 吸收态：连接已经断了，任何迟到的回调都不得把相位拉回去。
  //    反例（由 tests/fsm-verify.ts 的 P2 抓到）：close 之后本轮 finally 里的
  //    audioDone 会把 closed 拉回 listening。
  if (state.dialog.phase === 'closed' && PHASE_EVENTS.has(event.type)) {
    return [state, []];
  }
  // 3. 按区域路由。三个区域各自一个窄 switch，`default` 只是"剩下那些"——
  //    新事件类型落不进任何一个区域时，`stepDialog` 的签名会编译不过。
  switch (event.type) {
    case 'gate':
    case 'asrCommit':
    case 'decodeSettled':
    case 'userSpeech':
      return stepInput(state, event);
    case 'audioSent':
    case 'devicePlayed':
    case 'turnAnswered':
    case 'turnEnded':
    case 'turnReport':
      return stepPlayback(state, event);
    default:
      return stepDialog(state, event);
  }
}

/** `input` 区域：声学 + ASR。尺子是逻辑因果（`commitSeq`），不认识票据 */
function stepInput(state: KernelState, event: InputKernelEvent): [KernelState, Effect[]] {
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

    case 'userSpeech':
      // 能不能打断：只有 `speaking`，且这段**不是**开轮前的旧音频（上面已挡）。
      // 因果坐标比的是开轮水位线，不是到达时刻 —— 这就是"自己后半句杀自己"的解药。
      return bargeInTransition(state, event.atMs, event.final ? '定稿' : '中间结果');
  }
}

/** `playback` 区域：唯一的尺子是**媒体时间**，结算在这里宣布 */
function stepPlayback(state: KernelState, event: PlaybackKernelEvent): [KernelState, Effect[]] {
  switch (event.type) {
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

    /**
     * 结算快照只进账本。**不改相位、不产意图**：它不是判定，是留痕。
     * 连接已进 `closed` 时也要能落账，所以 `turnReport` 不在 `PHASE_EVENTS` 里，
     * 上面那道吸收态守门拦不到它。
     */
    case 'turnReport':
      return [{ ...state, ledger: { ...state.ledger, lastReport: event.report } }, []];

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
            inject: settled.inject,
            lane: settled.lane,
            endedAtMs: settled.endedAtMs,
          }],
        ];
      }
      const stale = isStaleTicket(state.dialog.ticket, event.ticket);
      // 播放记录属于哪一轮就结算哪一轮：迟到的 `turnEnded` 不能把新一轮的媒体算进来
      const playback = state.playback.ticket !== null
        && !isStaleTicket(state.playback.ticket, event.ticket)
        ? state.playback
        : { ...state.playback, ticket: event.ticket, sentMediaMs: 0, firstAudioAtMs: null };
      const effect = settle(playback, event.ticket, event.atMs, stale, state.ledger.lastLane);
      // 只结算播放区与账本。相位的出口是 `audioDone`：在这里把 `dialog.phase`
      // 写成 `listening` 会盖掉 `endAfterSpeech` 通往 `ending` 的路，或在回执
      // 期间留下 `listening + receiptOnly`。`ending` / `receiptOnly` 都保持原样。
      return [
        {
          ...state,
          playback: {
            ...state.playback,
            ticket: null,
            firstAudioAtMs: null,
            sentMediaMs: 0,
            // 上一轮的回执时刻不能残留在空播放区里：`turn-end` 之后读它的人
            // 会以为「这一轮播完了」，而实际只是账清空了。
            playedAtMs: null,
          },
          ledger: { ...recordSettle(state.ledger, effect), lastAnsweredAtMs: event.atMs },
        },
        [effect],
      ];
    }
  }
}

/** `dialog` 区域：话筒主权。尺子是票据（`no` / `gen`），只读别的区域的快照 */
function stepDialog(state: KernelState, event: DialogKernelEvent): [KernelState, Effect[]] {
  switch (event.type) {
    case 'turnStarted': {
      // 迟到的"开轮"不能把已经推进到下一轮的相位倒回去
      if (event.ticket.no < state.dialog.turn || event.ticket.gen < state.dialog.gen) {
        return [state, []];
      }
      return startTurn(state, event.ticket, event.atMs, `第 ${event.ticket.no} 轮`);
    }

    case 'fsmPhase':
      // 相位镜像：只认事实，不重算别的字段（老档案回放用）。
      // 唯独 `closed` 要走吸收态那条路 —— 它必须清票，否则迟到的结算还能认领这一轮。
      if (event.phase === 'closed') {
        return closeTransition(state);
      }
      return [{ ...state, dialog: { ...state.dialog, phase: event.phase } }, []];

    case 'ticketInvalidated': {
      // 只作废"就是这一轮"的票据；迟到的作废不能摘掉下一轮的（与 `cancelTurn` 同一条规矩）
      const current = state.dialog.ticket;
      if (current === null || isStaleTicket(current, event.ticket)) {
        return [state, []];
      }
      return [{ ...state, dialog: { ...state.dialog, ticket: null } }, []];
    }

    case 'closed':
      return closeTransition(state);

    // ---------------------------------------------------------------- 对话相位
    case 'beginTurn': {
      const dialog = state.dialog;
      // `ending` / `closed` 时拒绝开新一轮（`closed` 已被上面的吸收态挡掉）
      if (dialog.phase === 'ending') {
        return [state, []];
      }
      // 从 listening / awaiting_shot 进来才算**开轮**：锁存新的因果水位线。
      // `thinking` 重入（吸收窗口）是同一轮谱系内部的事，沿用上一张票的水位线 ——
      // 否则「开轮前录的那段」判据会被自己刷新掉。
      const fromOutside = dialog.phase === 'listening' || dialog.phase === 'awaiting_shot';
      const ticket = fromOutside
        ? mintTicket(dialog.turn + 1, dialog.gen, {
          baseCommitSeq: event.baseCommitSeq,
          startedAtMs: event.startedAtMs,
        })
        : mintTicket(dialog.turn + 1, dialog.gen, {
          baseCommitSeq: dialog.ticket?.baseCommitSeq,
          startedAtMs: dialog.ticket?.startedAtMs,
        });
      return startTurn(state, ticket, event.atMs, `第 ${ticket.no} 轮`);
    }

    case 'beginAwaitShot': {
      const dialog = state.dialog;
      if (dialog.phase !== 'listening') {
        return [state, []];
      }
      return [
        { ...state, dialog: { ...dialog, phase: 'awaiting_shot', lastWhy: '等一张高清照' } },
        [],
      ];
    }

    case 'abortAwaitShot': {
      const dialog = state.dialog;
      if (dialog.phase !== 'awaiting_shot') {
        return [state, []];
      }
      return [
        {
          ...state,
          dialog: { ...dialog, phase: 'listening', lastWhy: `放弃拍照（${event.why}）` },
        },
        [],
      ];
    }

    case 'receiptStarted': {
      const dialog = state.dialog;
      // 进不去说明这一轮已经不在等答案（被插话作废 / 已收尾）—— 别出声。
      // 带了票据还得是当前这一轮：过期票不许把新轮推进 speaking。
      if (dialog.phase !== 'thinking' || !acceptsReceiptTicket(dialog, event.ticket)) {
        return [state, []];
      }
      return [
        {
          ...state,
          dialog: {
            ...dialog,
            phase: 'speaking',
            receiptOnly: true,
            lastWhy: '回执出声（可打断）',
          },
        },
        [],
      ];
    }

    case 'receiptEnded': {
      const dialog = state.dialog;
      // 过期票据必为空操作：不能把新轮的回执打回 thinking，也不能清掉它的 receiptOnly。
      if (!acceptsReceiptTicket(dialog, event.ticket) || !dialog.receiptOnly) {
        return [state, []];
      }
      const backToThinking = dialog.phase === 'speaking';
      return [
        {
          ...state,
          dialog: {
            ...dialog,
            receiptOnly: false,
            ...(backToThinking ? { phase: 'thinking', lastWhy: '回执播完，继续等答案' } : {}),
          },
        },
        [],
      ];
    }

    case 'audioStarted': {
      const dialog = state.dialog;
      if (!ticketMatches(dialog, event.ticket)) {
        return [state, []];
      }
      // 真音频接管了这段 `speaking`：回执那一段到此结束
      const phase: DialogState = dialog.phase === 'thinking' ? 'speaking' : dialog.phase;
      if (phase === dialog.phase && !dialog.receiptOnly) {
        return [state, []];
      }
      return [
        {
          ...state,
          dialog: {
            ...dialog,
            phase,
            receiptOnly: false,
            ...(phase === dialog.phase ? {} : { lastWhy: '首块音频已下发' }),
          },
        },
        [],
      ];
    }

    case 'audioDone': {
      const dialog = state.dialog;
      if (!ticketMatches(dialog, event.ticket)) {
        return [state, []];
      }
      // 本轮收尾的唯一相位出口。回执还占着 `speaking` 时也要离开：
      // 清掉 `receiptOnly`，落点仍只由 `endAfterSpeech` 决定。
      // 回执自己播完走 `receiptEnded`（回 `thinking`）；轮次已经结束就不能再停在 speaking，
      // 否则 `endAfterSpeech` 到不了 `ending`。
      const phase: DialogState = dialog.endAfterSpeech ? 'ending' : 'listening';
      if (phase === dialog.phase && !dialog.receiptOnly) {
        return [state, []];
      }
      return [
        {
          ...state,
          dialog: {
            ...dialog,
            phase,
            receiptOnly: false,
            ...(phase === dialog.phase ? {} : { lastWhy: '本轮音频结束' }),
          },
        },
        [],
      ];
    }

    case 'requestEnd': {
      const dialog = state.dialog;
      // 没有音频要等，直接进 `ending`；否则只置标志，等这段播完（告别语不截断）
      const immediate = dialog.phase === 'listening' || dialog.phase === 'awaiting_shot';
      return [
        {
          ...state,
          dialog: {
            ...dialog,
            endAfterSpeech: true,
            ...(immediate ? { phase: 'ending', lastWhy: '模型要求结束（当前无音频）' } : {}),
          },
        },
        [],
      ];
    }

    case 'bargeIn': {
      if (state.dialog.phase !== 'speaking') {
        return [state, []];
      }
      return bargeInTransition(state, event.atMs, event.why);
    }
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
