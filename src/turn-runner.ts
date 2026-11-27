/**
 * 执行一轮完整对话：agent → TTS → 下发 → 等播放结束。
 *
 * <h2>职责边界</h2>
 *
 * 只管「一轮怎么跑完」，不关心：
 * - 音频从哪来（见 {@link EnergyGate}）
 * - 文本怎么攒出来（见 {@link UtteranceAssembler}）
 * - 现在能不能开新一轮（见 {@link DialogFsm}）
 *
 * 依赖全部注入，自身不 import 任何具体供应商实现
 * （`synthesize` 是函数，不是 TTS 客户端）。
 * 判定不在这个文件里：相位、播放游标、结算全由共享内核（`fsm.runtime`）裁决。
 *
 * <h2>副作用也只有一条路：内核意图 → 装配层的端口</h2>
 *
 * 事实（`audioSent` / `devicePlayed` / `turnEnded` …）一律走
 * `KernelRuntime.dispatchAndApply`，声明的意图由装配层绑好的端口执行 ——
 * 停音频、作废轮次、结算回注都只执行**一次**。本类自己只实现端口那一侧：
 * {@link TurnRunner.invalidateTurn}（作废在途轮次）与
 * {@link TurnRunner.acceptSettlement}（收下这一轮的结算）。
 *
 * 没挂端口的裸跑（单测 / 离线推演）仍要能跑完一轮：那种情况下 `turnEnded` 的
 * 结算意图由本类用一个一次性本地端口解释，**不另算一套口径**。
 *
 * <h2>出话只有一条泵</h2>
 *
 * `run()` 只消费 {@link FastVoiceEngine.respond}。`omni` / `stream` / `pump`
 * 以及 omni 转交 dsh 的垫话、流式失败退回整段，都在 `src/engines/`
 * （生产的 `live` / `cascade` 管道直接注入引擎；只给了 `{ agent, tts }` 的
 * 旧装配则包一层 {@link AgentEngineAdapter}）。逐轮延迟埋点
 * （`tts.first` / `turn.end` 的 `dsh_ms` / `audio_s`）仍在本类：引擎只报事实，
 * 记账与结算不进引擎。
 */
import { DialogFsm } from './dialog-fsm.ts';
import type { Clock } from './app/clock.ts';
import { EVENTS } from './events.ts';
import type { Effect, KernelEvent } from './kernel.ts';
import { applyEffects, type KernelSettlement } from './kernel-runtime.ts';
import { loopLagSnapshot } from './loop-lag.ts';
import { diffNetCounters, netFields, readNetCounters } from './net-counters.ts';
import { sampleSockets } from './socket-stats.ts';
import type { DownlinkSink } from './transport.ts';
import type { TurnTicket } from './dialog-fsm.ts';
import type { DeviceCall } from './devices/primitives.ts';
import { pcm16DurationMs, pcm16Gain } from './pcm.ts';
import { remainingSpeech } from './interrupted-tail.ts';
import type { FastVoiceEngine, TurnInput } from './engine-contract.ts';
import { AgentEngineAdapter } from './engines/index.ts';
import { asEmotion, cleanForSpeech, DEFAULT_EMOTION, parseEmotion } from './emotion.ts';
import type { AgentAudioAnswer, AgentProvider, DelegateReason, TtsProvider } from './providers.ts';
import type { ImageAttachment } from './session.ts';
import {
  buildTurnReport,
  resolveTurnStatus,
  turnReportToArchiveFields,
  type TurnInterruptReason,
  type TurnPath,
} from './turn-report.ts';
import { safeEmitUi, type PetUiEvent } from './ui-events.ts';

/**
 * 等播放结束时的轮询间隔。
 *
 * 播放进度只能靠时间估（PCM 时长 + 余量），所以要隔一会儿看一眼「是不是被打断了」。
 * 100 ms 是「用户感觉不到延迟」和「不空转 CPU」的折中。
 */
const PLAYBACK_POLL_MS = 100;

/**
 * 有 `played` 能力的设备，估算时长之后最多再等这么久。
 *
 * 真机的 `played` 只当**下限**用（见 `run()` 里的注释），所以需要一个「事件永远不来」
 * 的上限；3 s 足够覆盖设备缓冲，也不会把一轮挂太久。
 */
const PLAYED_GRACE_MS = 3_000;

/**
 * 会话层的图片附件（base64）收成引擎契约的字节快照。
 *
 * 适配器再编回 base64 交给 `agent.reply`。在这里转一次，`run()` 就不用知道
 * 供应商要的是哪一种形状。
 */
function turnImage(image: ImageAttachment): { readonly bytes: Buffer; readonly mime: string } {
  return {
    bytes: Buffer.from(image.data, 'base64'),
    mime: image.mimeType,
  };
}

export interface TurnRunnerOptions {
  /** 时钟端口：一轮里的所有等待与计时都走它（模拟器要用虚拟时间） */
  readonly clock: Clock;
  readonly agent: AgentProvider;
  /** TTS provider：采样率与合成都在里面，宿主不再各配一份 */
  readonly tts: TtsProvider;
  /**
   * 快车道引擎。给了就直接用（生产的 `live` / `cascade` 管道）。
   *
   * 没给（模拟器 / 旧测试只传 `{ agent, tts }`）时，本类用
   * {@link AgentEngineAdapter} 把同一对 agent + TTS 收成同一条 `respond()`，
   * 因此 `run()` 里只有一条泵。
   */
  readonly engine?: FastVoiceEngine;
  readonly downlink: DownlinkSink;
  readonly fsm: DialogFsm;
  /** 预估播放时长之外再多等的余量 */
  readonly playbackTailMs: number;
  /**
   * 设备会上报 `played`（`caps.played`）。
   *
   * 为真时**等设备说播完**再离开 `speaking`，但估算时长是**下限**、设备回执只能延后。
   * 实测某个 v2 设备在「最后一个字节收到」就报 `played`（4.58 s 的音频 1 s 就回执了），
   * 按它收尾会让尾音还在放就已经回到 `listening` —— 那段播放里的插话就不再算插话。
   * 为假时保持老行为：按下发字节数估时长。降级方向必须是「宁可多等一会儿」。
   */
  readonly deviceReportsPlayed?: boolean;
  /** 有 `played` 的设备在估算时长之后最多再等多久（默认 {@link PLAYED_GRACE_MS}） */
  readonly playedGraceMs?: number;
  /**
   * 下行语音增益（线性倍数，默认 1）。MiMo 输出偏小，实机听感要开到接近满格，
   * 所以默认放大一档；压峰用软限幅（见 `pcm.ts` 的 `pcm16Gain`）。
   */
  readonly ttsGain?: number;
  /** 每块下行音频（AEC 分析落盘用） */
  readonly onDownlinkChunk?: (chunk: Buffer) => void;
  /**
   * 时间线事件（进会话档案）。
   *
   * `tts.first` 与 `turn.end` 是延迟复算必需的仪表：缺了它们，「用户说完 → 听到第一个字」
   * 只散在 console 里，改动之后没法比快慢（见 `latency-report.ts`）。
   */
  readonly onEvent?: (name: string, fields?: Record<string, unknown>) => void;
  /**
   * 浏览器浮层遥测。缺省时不发任何事件，CLI / 真机的协议与时序不变。
   *
   * 监听器抛错会被吞掉，不能打断这一轮。`DialogRuntime` 造 runner 时不认识
   * 这个钩子，连接层在实例建好后用 {@link TurnRunner.bindUiEvent} 挂上。
   */
  readonly onUiEvent?: (ev: PetUiEvent) => void;
  /** 一轮结束（落盘用），无论成功失败都会调用 */
  readonly onTurnFinished: () => void;
  /**
   * 状态机在本方法里发生转移之后叫一次（`beginTurn` / `audioStarted` / `audioDone`）。
   *
   * 三次转移都发生在 `TurnRunner.run` 内部，`DialogRuntime.dispatch` 看不到它们。
   * 没有这个钩子，`onDialogState` 只知道 `listening` 一个状态，话筒永远不会被释放。
   */
  readonly onState?: () => void;
  /**
   * 给设备发一条控制指令（目前只用来 `audio.stop`）。
   *
   * 回执被正式回答顶掉时必须先清掉设备播放队列，否则「我看看」和答案会叠在一起。
   */
  readonly sendCall?: (call: DeviceCall) => void;
  /**
   * 挂/摘「流式增量」的钩子。
   *
   * 传进来一个回调就表示这一轮开始收 token（`null` 表示这一轮结束、摘掉）。
   * 有它才能「首句一生成就开腔」，没有就退回整段合成。
   */
  readonly onLiveAvailable?: (sink: ((text: string) => void) | null) => void;
  readonly log: (line: string) => void;
}

/** 一轮的执行结果，供调用方决定是否收尾 */
export interface TurnResult {
  /** 是否被用户插话中断 */
  readonly interrupted: boolean;
  /**
   * **实际送去念的全文**，从这一轮第一个字算起（被打断时用来算"还剩哪段没说完"）。
   *
   * 不一定等于 `reply.speech`：模型多步（先说一句、调工具、再说一句）时，流式这条路
   * 每一步的话都会念，而 `reply.speech` 只是最后一步。拿最后一步去对已播时长，
   * 切出来的"没说完"会是错的段落。
   */
  readonly speech: string;
  /** 下发的字节数 */
  readonly audioBytes: number;
  /** 整段音频时长（秒） */
  readonly audioSeconds: number;
  /**
   * **用户实际听到的**时长（秒）。
   *
   * 不等于 `audioSeconds`：回答是先整段合成再等的，用户插话那会儿音频早就
   * 全发出去了 —— 所以只能按"首块发出去之后过了多久"算。
   */
  readonly playedSeconds: number;
  /** TTS 首块耗时（毫秒），-1 表示没拿到音频 */
  readonly firstChunkLatencyMs: number;
  /** agent 耗时（毫秒） */
  readonly agentLatencyMs: number;
}

/**
 * 打断原因的**强弱**：`bargeIn` / `closed` 都是「这一轮被外部叫停」，
 * `superseded` 只是「被下一轮顶掉」。首次设定的强原因不许被弱原因盖掉 ——
 * 真机上「用户插话 → 协程醒来发现票据也过期了」会把 bargeIn 改写成 superseded。
 */
const INTERRUPT_PRIORITY: Readonly<Record<TurnInterruptReason, number>> = {
  superseded: 1,
  closed: 2,
  bargeIn: 3,
};

/**
 * 一轮的**现场账**：`run()` 里原先散落的十几个局部变量收成一份。
 *
 * 为什么要收：`finish()` 需要在 try 尾巴和 catch 里各调一次，而闭包只能看到
 * 自己捕获的变量 —— 以前这些值是 `run()` 的 `let`，catch 里根本读不到
 * （所以失败轮连 `turnEnded` 都没发）。收进一个对象之后，出口只有一个，
 * 字段读的就是同一份事实。
 */
interface TurnTrace {
  readonly ticket: TurnTicket;
  /** 开轮时刻（宿主单调时钟）。票据带水位线时以票据的为准 */
  readonly startedAtMs: number;
  /** agent 起跑时刻（宿主单调时钟） */
  readonly agentStartedAt: number;
  path: TurnPath | null;
  delegated: boolean;
  delegateReason: DelegateReason | null;
  nonBlockingDelegate: boolean;
  interrupted: boolean;
  interruptReason: TurnInterruptReason | null;
  interruptWhy: string | null;
  /** 模型首 token 延迟（ms，`meta.firstTokenMs`） */
  llmFirstMs: number | null;
  /** 首个非空文本增量的时刻（相对 `startedAtMs`，ms） */
  firstTextMs: number | null;
  /** 首段送合成的**绝对**时刻（宿主时钟）；引擎没报为 `null` */
  firstSynthAtMs: number | null;
  /** 首段送合成 → 首块音频（ms）。优先采用引擎同源时钟算好的值 */
  ttsFirstMs: number | null;
  /** 首块下行音频的绝对时刻（宿主时钟）；没出声为 `null` */
  firstAudioAtMs: number | null;
  /** agent 自报耗时（ms）；一个事件都没拿到就失败时为 `null` */
  agentLatencyMs: number | null;
  audioBytes: number;
  audioRate: number;
  speech: string;
  streamedText: string;
  /** 浮层的 `reply.final` 只发一次 */
  uiFinalSent: boolean;
  /** 结算出口只许走一次（打断 / 关闭 / 失败 / 正常都算一次） */
  finished: boolean;
}

export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly log: (line: string) => void;
  /** 这一轮出话的唯一引擎。构造时定下来，`run()` 不再按供应商分支 */
  private readonly engine: FastVoiceEngine;
  /** 旁白与本轮回答共用一条下行音频，必须串行，否则两段 PCM 会交织在一起 */
  private speechChain: Promise<void> = Promise.resolve();
  /**
   * 正在念的那条旁白。
   *
   * 记 `sentBytes` 和 `firstChunkAt` 是为了**被打断之后还能接着说**：语音没法暂停
   * 再继续，只能按已播时长把剩下的文字重新合成一遍。不记的话，用户「嗯」一声就
   * 把整条信息弄丢了 —— 后台任务的结论、高清照的引导语都属于「只说一次就没了」。
   */
  private canned: {
    text: string;
    emotion?: string;
    sentBytes: number;
    /** 首块音频下发的时刻；`-1` = 还没出过声 */
    firstChunkAt: number;
    cancelled: boolean;
    /** 缺省用 TTS 采样率。实时音频流（`speakAudioAnswer`）可以不同 */
    sampleRate?: number;
    /** 实时音频流的当前转写（`cancelCanned` 同步读一次，避免结束后再次覆盖残句） */
    readText?: () => string;
  } | null = null;
  /** 被打断的旁白还没念完的那一段，等下一轮结束再补播。一次性。 */
  private cannedResidue: { text: string; emotion?: string } | null = null;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.log = options.log;
    this.engine = options.engine ?? new AgentEngineAdapter({
      agent: options.agent,
      tts: options.tts,
      ...(options.onLiveAvailable === undefined
        ? {}
        : { onLiveAvailable: options.onLiveAvailable }),
      speechChain: () => this.speechChain,
      clock: () => this.options.clock.now(),
      log: (line) => { this.log(line); },
    });
  }

  /**
   * 把浮层钩子接到已经建好的 runner 上。
   *
   * 与构造参数 `onUiEvent` 写的是同一个字段。后调用的覆盖先给的。
   * 传 `undefined` 等于摘掉。不改音频和下行协议。
   */
  bindUiEvent(onUiEvent: ((ev: PetUiEvent) => void) | undefined): void {
    (this.options as { onUiEvent?: ((ev: PetUiEvent) => void) | undefined }).onUiEvent = onUiEvent;
  }

  /** 等 ms：走 Clock，虚拟时钟下就是推进虚拟时间。 */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.options.clock.after(ms, resolve);
    });
  }

  /**
   * 设备报告「下行音频播完了」。
   *
   * 只在 `deviceReportsPlayed` 为真时有意义；由适配层收到设备 `played` 事件时调。
   * 用轮询标志而不是 promise：等待循环本来就在轮询，多一条 promise 只会多一处
   * 需要清理的悬挂引用。
   *
   * **只在有在途轮次时才算数**：线协议的 `played` 没有轮次字段，绑定发生在这里 ——
   * 上一轮迟到的回执不能拿来结束这一轮。
   */
  devicePlayed(): void {
    if (this.playingTicket === null) {
      return;
    }
    this.playedSeen = true;
    // 内核也要知道（它记的是"设备回执到的时刻"，与媒体游标拼起来才是完整的播放事实）
    if (this.ownsPlayback(this.playingTicket)) {
      this.feed({ type: 'devicePlayed', atMs: this.options.clock.now() });
    }
  }

  /**
   * 把一条事实喂给**共享内核**（`fsm.runtime`，与 `DialogFsm` 是同一个实例）。
   *
   * 以前这里有一份 `private kernel`：相位由 FSM 算、账本与结算由私货算，两套
   * `turn` / `playback`。插话当场结算过的那一轮它看不见，协程跑到尾巴再拿空播放区
   * 重算一遍，就把「少听了一段」重算成「听全了」（该吞的答案被回注）。
   * 现在只有一个 `KernelState`，`settleTurn` 也只有一份算法。
   *
   * **只允许在 `run()` / `devicePlayed()` 里喂与当前轮相关的事件**：`speakCanned`
   * 那些旁白不属于任何一轮（它们不推进话筒主权，也不进 `turn.end` 的账）。
   *
   * 走 `dispatchAndApply`：装配层（`DialogRuntime`）绑了端口时，事件声明的意图
   * **在这里就执行**（`stopDeviceAudio` / `invalidateTurn` / `abortEngine` /
   * `settleTurn`），且只执行这一次。裸跑（没绑端口）时它只推状态 —— 与
   * `dispatch` 等价，`run()` 的尾巴再拿返回的意图自己解释一遍。
   */
  private feed(event: KernelEvent): readonly Effect[] {
    return this.options.fsm.runtime.dispatchAndApply(event);
  }

  /**
   * 这一轮还占着内核的**播放区**吗。
   *
   * 共享之后只有一个 `playback` 区：被插话（`bargeIn` 当场清区）或已结算之后再喂
   * `audioSent`，媒体游标就记到**下一轮**头上 —— 结算拿它算「少听多少」，会静默算错。
   * 所以喂之前先确认这一轮还是区主；迟到的分片照常下发，只是不记账。
   */
  private ownsPlayback(ticket: TurnTicket): boolean {
    const owner = this.options.fsm.runtime.state.playback.ticket;
    return owner !== null && owner.no === ticket.no && owner.gen === ticket.gen;
  }

  /**
   * 这一轮由谁答的，记进内核账本（`ledger.lastLane`）。
   *
   * 只报事实 —— 路由判定在 `turn-router.ts`。`omni` / `fast` 翻译成**车道**名
   * （`live` / `cascade`）：内核不认识"谁调的"，只认识"哪条车道"。
   */
  private noteLane(replyPath: 'fast' | 'dsh' | 'omni' | undefined): void {
    if (replyPath === undefined) {
      return;
    }
    this.feed({
      type: 'turnAnswered',
      lane: replyPath === 'omni' ? 'live' : replyPath === 'fast' ? 'cascade' : 'dsh',
    });
  }

  /** 本轮是否已经收到设备的 `played` */
  private playedSeen = false;
  /** 正在等的这一轮（`null` = 没有在途轮次；回执要绑在它上面） */
  private playingTicket: TurnTicket | null = null;
  /** 这一轮回执（「我看看。」）。回答一出第一个字节就掐掉 */
  private receipt: { text: string; sentBytes: number; firstChunkAt: number; cancelled: boolean; ephemeral: boolean } | null = null;
  private receiptPlaying = false;
  /**
   * 回执音频缓存：文案是固定的那几句，没有理由每轮都去服务端现合成。
   *
   * 真机实测（2026-11-17，v2 设备）：回执首块 321–342 ms 全是合成时间，而回执
   * 总共只有 0.65 s 音频 —— 首块那 300 ms 等于把「开轮 → 听见声音」白白拖长，
   * 还会在答案来得快时被硬切成半句（第 6 轮 agent 890 ms 就到，回执播到 569 ms
   * 被掐，「我看看」只剩「我看」）。缓存之后首块≈0，整句在答案到达前就能播完。
   */
  private readonly receiptCache = new Map<string, { readonly rate: number; readonly chunks: readonly Buffer[] }>();
  /** 本轮是否已经下发过真正的回答音频（回执只在这是 false 时有意义） */
  private firstAudioSeen = false;
  /**
   * 在途的那一轮（端口 `invalidateTurn` 的对象）。
   *
   * `invalidateTurn` 从内核的 `invalidateTurn` 意图进来（插话 / 连接结束），也可能从
   * 裸跑时的 `fsm.onInvalidate` 进来 —— 两条路都必须按**整张票据**比对：迟到的
   * 取消不能杀掉下一轮（`no` 不同），同一轮也不能被取消两次（`invalidated`）。
   * `turnAbort` 是「这一轮已经没必要再等」的信号：引擎的 `respond()` 看到
   * `AbortSignal` 就停，委派轮不用再空等 dsh 的软取消。
   */
  private activeTurn: {
    readonly ticket: TurnTicket;
    invalidated: boolean;
    /**
     * 作废原因。`finish()` 据此给 `TurnReport` 定性 —— 光看 `isTurnDead` 分不出
     * 「用户插话」「连接结束」「被下一轮顶掉」，三者的排障含义完全不同。
     */
    invalidateReason: 'bargeIn' | 'closed' | null;
    /** 作废那一刻相位转移的原因（档案里的 `dialog.state.why`） */
    invalidateWhy: string | null;
    readonly turnAbort: AbortController;
  } | null = null;
  /**
   * 最近一次由 `KernelPorts.settleTurn` 送来的结算。
   *
   * 不在这里算任何东西 —— 内核给出什么就是什么（`kernel.ts` 的 `settle()` 是唯一
   * 算法）。`run()` 的尾巴按票据取走它，**取不到才是装配坏了**。
   */
  private lastSettlement: KernelSettlement | null = null;

  /**
   * 仅把播报文本推给浮层气泡（不调用 TTS 合成）。
   * Pure Live 下前台车道断开时仍可把后台结论显示在桌宠气泡上，同时严守「不调外部 TTS」。
   */
  emitAnnounceText(text: string, emotion?: string): void {
    if (this.options.fsm.state === 'closed' || text.trim() === '') return;
    safeEmitUi(this.options.onUiEvent, {
      type: 'announce',
      text,
      emotion: asEmotion(emotion),
    });
  }

  /**
   * 播一句**系统旁白**（不是模型的回答）。
   *
   * 高清照要等用户按下快门，这几十秒里没有「一轮」可挂 —— 但总得有人告诉他去按。
   * 所以旁白**不改状态机**，只借同一条 TTS 通道说话；它和本轮回答通过
   * {@link speechChain} 串行，两段音频不会撞在一起。
   */
  speakCanned(text: string, emotion?: string, ephemeral = false): Promise<void> {
    // 新的一条旁白：上一条的残留作废（它已经被这条取代了，再补播就是重复）
    this.cannedResidue = null;
    const current = { text, emotion, sentBytes: 0, firstChunkAt: -1, cancelled: false, ephemeral };
    this.canned = current;
    const run = async (): Promise<void> => {
      try {
        if (!current.cancelled && this.options.fsm.state !== 'closed' && text.trim() !== '') {
          safeEmitUi(this.options.onUiEvent, {
            type: 'announce',
            text,
            emotion: asEmotion(emotion),
          });
        }
        const startedAt = this.options.clock.now();
        let firstChunkAtMs = -1;
        for await (const chunk of this.options.tts.synthesize(text, emotion)) {
          if (current.cancelled || this.options.fsm.state === 'closed') {
            if (current.cancelled) {
              this.log(ephemeral ? '  回执    被正式回答顶掉，停止下发' : '  旁白    被打断，停止下发');
            } else {
              this.log(ephemeral ? '  回执    连接已关闭，停止下发' : '  旁白    连接已关闭，停止下发');
            }
            return;
          }
          if (firstChunkAtMs < 0) {
            firstChunkAtMs = this.options.clock.now() - startedAt;
            current.firstChunkAt = this.options.clock.now();
          }
          current.sentBytes += chunk.length;
          this.options.onDownlinkChunk?.(chunk);
          this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
        }
        const seconds = pcm16DurationMs(current.sentBytes, this.options.tts.sampleRate) / 1000;
        this.log(
          `  ${ephemeral ? '回执' : '旁白'}    ${JSON.stringify(text)} ${current.sentBytes} B / ${seconds.toFixed(2)} s`
          + `（首块 ${firstChunkAtMs < 0 ? '—' : `${Math.round(firstChunkAtMs)}ms`}）`,
        );
        // 每 100 ms 看一眼有没有被取消：用户说完「算了」不该还要等这段音频"播完"
        const until = this.options.clock.now() + seconds * 1000 + this.options.playbackTailMs;
        while (
          this.options.clock.now() < until
          && !current.cancelled
          && this.options.fsm.state !== 'closed'
        ) {
          await this.wait(PLAYBACK_POLL_MS);
        }
      } finally {
        if (this.canned === current) {
          this.canned = null;
        }
      }
    };
    const next = this.speechChain.then(run, run);
    this.speechChain = next.catch(() => undefined);
    return next;
  }

  /**
   * 播放一段外部已生成的实时音频流（Pure Live 模式下 Omni 后台汇报用）。
   *
   * 与 `speakCanned` 共用同一个 `this.canned` 取消令牌、`cannedResidue` 残句记录与
   * `speechChain` 串行链 —— 插话或双击调用 `cancelCanned()` 时，两条播报路径享受
   * 完全一致的即时掐断、`audio.stop` 下发与半句续话记录。
   */
  speakAudioAnswer(answer: AgentAudioAnswer, emotion?: string): Promise<{
    readonly spokenBytes: number;
    readonly interrupted: boolean;
    readonly transcript: string;
  }> {
    // 新的一条播报取代上一条：残留作废，否则补播会把已经盖掉的半句又说一遍
    this.cannedResidue = null;
    const token = {
      text: '',
      ...(emotion === undefined ? {} : { emotion }),
      sentBytes: 0,
      firstChunkAt: -1,
      cancelled: false,
      sampleRate: answer.sampleRate,
      readText: () => answer.transcript(),
    };
    this.canned = token;
    const run = async (): Promise<{
      readonly spokenBytes: number;
      readonly interrupted: boolean;
      readonly transcript: string;
    }> => {
      let spokenBytes = 0;
      let firstAudioAt = -1;
      try {
        for await (const chunk of answer.chunks) {
          if (token.cancelled || this.options.fsm.state === 'closed') {
            break;
          }
          if (firstAudioAt < 0) {
            firstAudioAt = this.options.clock.now();
            token.firstChunkAt = firstAudioAt;
          }
          spokenBytes += chunk.length;
          token.sentBytes = spokenBytes;
          token.text = answer.transcript();
          this.options.onDownlinkChunk?.(chunk);
          this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
        }
        // 流式块收齐且没被打断时立刻推浮层气泡，不等整段播放等待结束；
        // 一个字节都没播（调用方会退回 speakCanned）或已被打断时不再补播报气泡。
        if (!token.cancelled && spokenBytes > 0 && this.options.onUiEvent !== undefined) {
          const spoken = answer.transcript();
          if (spoken.trim() !== '') {
            safeEmitUi(this.options.onUiEvent, {
              type: 'announce',
              text: spoken,
              emotion: asEmotion(emotion),
            });
          }
        }
        if (!token.cancelled && spokenBytes > 0 && firstAudioAt >= 0) {
          const until = firstAudioAt
            + pcm16DurationMs(spokenBytes, answer.sampleRate)
            + this.options.playbackTailMs;
          while (
            this.options.clock.now() < until
            && !token.cancelled
            && this.options.fsm.state !== 'closed'
          ) {
            await this.wait(PLAYBACK_POLL_MS);
          }
        }
        return {
          spokenBytes,
          interrupted: token.cancelled,
          transcript: answer.transcript(),
        };
      } finally {
        if (this.canned === token) {
          this.canned = null;
        }
      }
    };
    const next = this.speechChain.then(run, run);
    this.speechChain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * 「这一轮交给慢车道了」的回执。
   *
   * 与旁白的区别只有三点，都为了**不拖慢真正的回答**：
   * - **不排 `speechChain`**：排进去的话本轮 TTS 要等它播完才开始（`run` 里的流式分支
   *   开头就 `await this.speechChain`），等于用回执换来更晚的答案
   * - 不在残句里留底：它本来就不是「用户没听完的内容」，留底会让下一轮收到
   *   「刚才那条汇报只念了一半」的假注记
   * - 回答一来就掐断，并且先给设备发 `audio.stop` 清掉缓冲，避免两句叠在一起
   *
   * @returns 有没有真的开始说（`false` = 这一轮已经出声/已被作废，没必要回执）
   */
  speakReceipt(text: string): boolean {
    if (this.receiptPlaying || this.canned !== null || this.firstAudioSeen) {
      return false;
    }
    // 出声前锁存票据：`holdReceipt` 在 await 之后回来时拿这张票调 `receiptEnded`，
    // 过期票是空操作，不会把下一轮的回执打回 thinking。
    const receiptTicket = this.options.fsm.ticket();
    // 回执是真出声：状态进 `speaking`，用户这时开口才算插话（见 DialogFsm.receiptStarted）。
    // 进不去说明这一轮已经不在等答案（被插话作废 / 已收尾 / 票据过期）—— 那就别出声了。
    if (!this.options.fsm.receiptStarted(receiptTicket)) {
      return false;
    }
    // 立刻通知：档案要记下这段 `speaking`，话筒归属也别等下一帧才对齐
    this.options.onState?.();
    // 回执是**用户听到的第一句**，但它不属于任何 `turn.end`（不排 `speechChain`、
    // 不留残句）—— 不单独记，审计「他到底听到了什么」就少一段。
    this.options.onEvent?.(EVENTS.receipt, { text, chars: [...text].length });
    const rate = this.options.tts.sampleRate;
    const cached = this.receiptCache.get(text);
    if (cached !== undefined && cached.rate === rate) {
      // 命中：立刻整句下发，不等服务端。首块 0 ms —— 这是缓存的意义所在。
      this.log(`  回执    ${JSON.stringify(text)}（缓存）`);
      this.receiptPlaying = true;
      const current = { text, sentBytes: 0, firstChunkAt: 0, cancelled: false, ephemeral: true };
      this.receipt = current;
      for (const chunk of cached.chunks) {
        current.sentBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }
      void this.holdReceipt(current, receiptTicket);
      return true;
    }
    this.log(`  回执    ${JSON.stringify(text)}`);
    this.receiptPlaying = true;
    const current = { text, sentBytes: 0, firstChunkAt: -1, cancelled: false, ephemeral: true };
    this.receipt = current;
    void (async () => {
      const startedAt = this.options.clock.now();
      let firstChunkAtMs = -1;
      const collected: Buffer[] = [];
      for await (const chunk of this.options.tts.synthesize(text)) {
        if (current.cancelled) {
          this.log('  回执    被正式回答顶掉，停止下发');
          return;
        }
        if (firstChunkAtMs < 0) {
          firstChunkAtMs = this.options.clock.now() - startedAt;
          current.firstChunkAt = this.options.clock.now();
        }
        collected.push(chunk);
        current.sentBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }
      // 合成成功才进缓存：中途被顶掉的那次是残缺的，不能存
      if (!current.cancelled && collected.length > 0) {
        this.receiptCache.set(text, { rate, chunks: collected });
      }
      const seconds = pcm16DurationMs(current.sentBytes, rate) / 1000;
      this.log(
        `  回执    ${JSON.stringify(text)} ${current.sentBytes} B / ${seconds.toFixed(2)} s`
        + `（首块 ${firstChunkAtMs < 0 ? '—' : `${Math.round(firstChunkAtMs)}ms`}）`,
      );
      await this.holdReceipt(current, receiptTicket);
    })();
    return true;
  }

  /**
   * 回执下发完之后，按音频时长占住「还在说」的状态，直到播完或被顶掉。
   *
   * `receiptTicket` 是出声时锁存的那张。await 回来再调 `receiptEnded`，
   * 内核按 `{no, gen}` 丢弃过期票，避免悬空等待把下一轮打回 thinking。
   */
  private async holdReceipt(
    current: { sentBytes: number; cancelled: boolean },
    receiptTicket: TurnTicket,
  ): Promise<void> {
    const seconds = pcm16DurationMs(current.sentBytes, this.options.tts.sampleRate) / 1000;
    const until = this.options.clock.now() + seconds * 1000 + this.options.playbackTailMs;
    while (
      this.options.clock.now() < until
      && !current.cancelled
      && this.options.fsm.state !== 'closed'
    ) {
      await this.wait(PLAYBACK_POLL_MS);
    }
    // 回执已经自然播完（或连接关闭）：摘掉当前引用，否则几秒后正式回答到达时
    // 还会误判「回执还在念」并多发一条无意义的 audio.stop。
    // 只在 `this.receipt === current` 时清，防止悬空的旧回执误清下一轮。
    if (this.receipt === current) {
      this.receipt = null;
    }
    // 回执这一段结束了：状态回到 `thinking`（答案还在路上）。
    // 被顶掉、或本轮已经 audioDone 清掉 receiptOnly 时，再调也是空操作。
    this.options.fsm.receiptEnded(receiptTicket);
    this.options.onState?.();
  }

  /**
   * 掐掉还在念的回执。
   *
   * 单独一个方法：`run()` 开头把 `this.receipt` 置空之后，TS 会把这个字段
   * 在整个方法里收窄成 `null`，`finally` 里再写 `cancelled = true` 就编不过。
   * 回执是在 await 期间由 `speakReceipt` 挂上的，这里按字段的声明类型读。
   */
  private cancelActiveReceipt(): void {
    const receipt = this.receipt;
    if (receipt === null) {
      return;
    }
    receipt.cancelled = true;
    this.receipt = null;
    this.receiptPlaying = false;
  }

  /**
   * 这张票已经不是当前轮。
   *
   * `isStale` 只看代次（插话），`isCurrent` 只看轮次号。`thinking → thinking`
   * 的吸收窗口不推进代次，只把 `no` +1 —— 两个都要看，否则旧轮还会往下发音频。
   */
  private isTurnDead(ticket: TurnTicket): boolean {
    const fsm = this.options.fsm;
    return fsm.isStale(ticket) || !fsm.isCurrent(ticket);
  }

  /**
   * 用户改主意：旁白不必播完，后面排队的那一轮也不必等它。
   *
   * **没念完的部分不丢**：按「用户实际可能听到的时长」切出剩下的文字放进
   * {@link cannedResidue}，由对话层决定补播还是作废（双击掐播就是作废）。
   *
   * 已播时长取两个估计的**较小值**：下发出去的音频长度（合成慢时它更小）
   * 和从首块到现在过了多久（播放快不起来，也就是它更小的情况）。只取前者会
   * 严重高估 —— TTS 一次性把整段吐出来时，字节数等于全长，剩余部分就成了空串。
   */
  cancelCanned(options?: { readonly stopAudio?: boolean }): void {
    const current = this.canned;
    if (current === null || current.cancelled) {
      return;
    }
    current.cancelled = true;
    const sentMs = pcm16DurationMs(
      current.sentBytes,
      current.sampleRate ?? this.options.tts.sampleRate,
    );
    const elapsedMs = current.firstChunkAt < 0
      ? 0
      : this.options.clock.now() - current.firstChunkAt;
    const heardMs = Math.min(sentMs, elapsedMs);
    // **一个字都没发出去**：设备缓冲里还没有这段音频，不发 audio.stop，也不记残句
    // （记残句会让下一轮收到「刚才那条后台汇报你只念了一半」的假注记）。
    if (current.sentBytes === 0) {
      return;
    }
    // 音频常以 4–6 倍速提前灌进设备/浏览器缓冲；光停服务端循环挡不住已经排进播放器的那十几秒，
    // 必须立刻下发 audio.stop 清缓冲（旁白不占状态机，KernelPorts.stopDeviceAudio 不会替它发）。
    if (options?.stopAudio !== false && this.options.fsm.state !== 'closed') {
      this.options.sendCall?.({ op: 'audio.stop' });
    }
    const fullText = current.readText?.() ?? current.text;
    const rest = remainingSpeech(fullText, heardMs / 1000);
    if (rest !== '') {
      this.cannedResidue = {
        text: rest,
        ...(current.emotion === undefined ? {} : { emotion: current.emotion }),
      };
    }
  }

  /** 取走被打断旁白的剩余部分（一次性）。`null` = 没有剩余或已经念完。 */
  takeCannedResidue(): { readonly text: string; readonly emotion?: string } | null {
    const residue = this.cannedResidue;
    this.cannedResidue = null;
    return residue;
  }

  // ---------------------------------------------------------------- 端口侧（内核意图的执行者）

  /**
   * 作废在途的那一轮：`KernelPorts.invalidateTurn`（以及裸跑时的 `onInvalidate`）。
   *
   * **严格按票据比对 + 幂等**：
   * - `no` / `gen` 任一不同 → 直接返回。迟到的取消（上一轮的）不能杀掉这一轮。
   * - 已经作废过 → 直接返回。同一条 `invalidateTurn` 意图不能被解释两遍
   *   （`audio.stop` 多发一遍只是噪音，`cancelTurn` 联动 `detachTurn` 会让 dsh 丢答案）。
   */
  invalidateTurn(
    ticket: { readonly no: number; readonly gen: number },
    reason: 'bargeIn' | 'closed' = 'bargeIn',
  ): void {
    const active = this.activeTurn;
    if (
      active === null
      || active.invalidated
      || active.ticket.no !== ticket.no
      || active.ticket.gen !== ticket.gen
    ) {
      return;
    }
    active.invalidated = true;
    // 作废原因只在**真正作废这一轮**时锁存（上面那三条守卫已经排除了迟到票与重复调用）。
    // `finish()` 拿它给报告定性 —— `isTurnDead` 只会说「过期了」，说不出为什么。
    active.invalidateReason = reason;
    active.invalidateWhy = this.options.fsm.lastTransitionReason || null;
    // 先掐引擎：`respond()` 卡在 dsh 上时，不 abort 就还要等软取消那几秒
    active.turnAbort.abort(reason);
    this.log(`  取消    ${reason === 'bargeIn' ? '插话' : '连接结束'} → 取消在途请求（第 ${ticket.no} 轮）`);
    // 回执也要停：`audio.stop` 只清掉设备已经收到的缓冲，合成循环还在往下发，
    // 不掐掉就会在用户说话时接着播（试过：用户一开口「我看看」又从头上响一遍）。
    if (this.receipt !== null && !this.receipt.cancelled) {
      this.receipt.cancelled = true;
      this.receiptPlaying = false;
      this.log('  回执    插话中止，停止下发');
    }
    try {
      this.options.agent.cancelTurn?.(active.ticket);
    } catch (error) {
      this.log(`  取消    ✗ ${(error as Error).message}`);
    }
  }

  /**
   * 收下内核给的这一轮结算（`KernelPorts.settleTurn`）。
   *
   * 只存不算：`truncated` / `inject` / `heardMs` 的算法唯一归口在 `kernel.ts`，
   * 执行层照单执行（以前这里按 `audioBytes` 自己判口气，两边静默漂移）。
   */
  acceptSettlement(turn: KernelSettlement): void {
    this.lastSettlement = turn;
  }

  /** 按整张票据取走结算；对不上就返回 `null`（迟到的结算不能算到别的轮次头上）。 */
  private takeSettlement(ticket: TurnTicket): KernelSettlement | null {
    const settlement = this.lastSettlement;
    if (
      settlement === null
      || settlement.ticket.no !== ticket.no
      || settlement.ticket.gen !== ticket.gen
    ) {
      return null;
    }
    this.lastSettlement = null;
    return settlement;
  }

  /**
   * 把这一轮的定稿收成浮层事件：情绪必须是合法 key，正文去掉标签和不会念的格式。
   */
  private emitReplyFinal(
    fullText: string,
    spoken: string | undefined,
    path: 'omni' | 'fast' | 'dsh' | undefined,
  ): void {
    const parsedFull = parseEmotion(fullText);
    const source = spoken !== undefined && spoken.trim() !== '' ? spoken : parsedFull.rest;
    const parsedSpoken = parseEmotion(source);
    const emotion = asEmotion(
      parsedFull.emotion !== DEFAULT_EMOTION ? parsedFull.emotion : parsedSpoken.emotion,
    );
    safeEmitUi(this.options.onUiEvent, {
      type: 'reply.final',
      text: cleanForSpeech(parsedSpoken.rest),
      emotion,
      ...(path === undefined ? {} : { path }),
    });
  }

  /**
   * 跑一轮。
   *
   * 返回时 `fsm` 已推进到下一状态；调用方据 `fsm.state` 决定是否挂断。
   */
  async run(
    text: string,
    image?: ImageAttachment,
    note?: string,
    utterancePcm?: Buffer,
  ): Promise<TurnResult | null> {
    const { fsm, agent, downlink } = this.options;
    // 整机 TCP 计数器在本轮开始/结束时各读一次，增量落 `turn.end`：
    // 把「多出来的 270 ms」分成「链路丢包」和「服务端内部慢」靠它（见 `net-counters.ts`）。
    const netBefore = readNetCounters();
    const ticket = fsm.beginTurn();
    if (!ticket) {
      return null;
    }
    // **不再自己发 `turnStarted`**：`DialogFsm.beginTurn()` 已经把同一条 `beginTurn`
    // 派给了共享内核（铸票 + 结算被顶掉的上一轮 + 把播放区绑到这张票上）。再发一次
    // 就是第二套开轮口径，还会把刚初始化的播放区重算一遍。
    // 从这里起，「这一轮听到多少 / 该不该回注」只由内核裁决，我们只喂事实：
    // 发了多少媒体（`audioSent`）、什么时候出声（`audioStarted`）、设备报没报播完。
    // 回执标志按**轮次**清零：挪到这里而不是等待环入口，是因为合成期间
    // （最后一批字节发出之前）到达的回执也得算数 —— 在入口清会把已经到的那次擦掉，
    // 之后设备不再发第二次，就只能等满上限。
    this.playedSeen = false;
    this.playingTicket = ticket;
    this.receiptPlaying = false;
    this.receipt = null;
    this.firstAudioSeen = false;

    // 这一轮的中止信号。`invalidateTurn` 同步 abort：委派轮等 dsh 的软取消要几秒
    // （真机 2026-11-23 第 5 轮 2.5 s），不掐掉的话串行链卡着，下一轮开不了。
    const turnAbort = new AbortController();
    // agent 起跑时刻要在建现场账之前拿：`ticket.startedAtMs` 缺省时它就是开轮时刻。
    const agentStartedAt = this.options.clock.now();
    // 端口侧的作废对象：`invalidateTurn` 只认这一张票，`finally` 里清掉。
    this.activeTurn = {
      ticket,
      invalidated: false,
      invalidateReason: null,
      invalidateWhy: null,
      turnAbort,
    };

    /** 一轮的现场账：`finish()` 在 try 尾巴与 catch 里读的是**同一份** */
    const trace: TurnTrace = {
      ticket,
      startedAtMs: ticket.startedAtMs ?? agentStartedAt,
      agentStartedAt,
      path: null,
      delegated: false,
      delegateReason: null,
      nonBlockingDelegate: false,
      interrupted: false,
      interruptReason: null,
      interruptWhy: null,
      llmFirstMs: null,
      firstTextMs: null,
      firstSynthAtMs: null,
      ttsFirstMs: null,
      firstAudioAtMs: null,
      agentLatencyMs: null,
      audioBytes: 0,
      audioRate: this.options.tts.sampleRate,
      speech: '',
      streamedText: '',
      uiFinalSent: false,
      finished: false,
    };

    /**
     * 标记这一轮被中断。**单调置位**：一旦为真就不再回退 —— 以前在 `run()` 尾巴
     * 写 `interrupted = this.isTurnDead(ticket)`，插话之后票据的判定可能瞬时为假
     * （打断当场结算、`createTurn` 又把票清了），于是「用户明明插了话」的那一轮
     * 被记成正常完成。
     *
     * 原因只许**由弱变强**（`superseded` < `closed` < `bargeIn`）：首次设定的
     * `interruptWhy` 也不被更弱的原因覆盖。
     */
    const markInterrupted = (reason: TurnInterruptReason, why?: string | null): void => {
      trace.interrupted = true;
      if (
        trace.interruptReason === null
        || INTERRUPT_PRIORITY[reason] > INTERRUPT_PRIORITY[trace.interruptReason]
      ) {
        trace.interruptReason = reason;
        trace.interruptWhy = why ?? null;
      } else if (trace.interruptWhy === null && why !== undefined && why !== null && why !== '') {
        trace.interruptWhy = why;
      }
    };

    /**
     * **唯一结算出口**：正常收尾与失败各调一次，`trace.finished` 保证恰好一次。
     *
     * 顺序是定死的：
     * 1. 先读设备回执（`turnEnded` 会清空播放区）；
     * 2. 单调更新中断态（作废原因 / 吸收态 / 被顶掉）；
     * 3. 喂 `ticketInvalidated`（如果这轮已经死了）与 `turnEnded`，取回内核结算；
     * 4. 既有回注 / 账本 / `turn.end`（失败轮只发 `{failed:true, dsh_ms}`）；
     * 5. 组 `TurnReport` → `kernel` 的 `turnReport` → 档案 `turn.report`。
     *
     * **失败轮也走这里**：以前 `catch` 直接 return，本轮从没 `turnEnded` ——
     * `ledger.lastSettled` 停在上一轮、`playback` 还挂着这张票，下一轮开轮时的
     * 「结算被顶掉的上一轮」拿到的是脏数据。
     */
    const finish = (kind: 'normal' | 'failed', error?: unknown): TurnResult | null => {
      if (trace.finished) {
        return null;
      }
      trace.finished = true;
      const nowMs = this.options.clock.now();
      // 设备回执只对**这一轮**有意义：必须在 `turnEnded` 清空播放区之前读。
      const playedAtMs = this.ownsPlayback(ticket)
        ? fsm.runtime.state.playback.playedAtMs
        : null;
      const active = this.activeTurn;
      if (
        active !== null
        && active.ticket.no === ticket.no
        && active.ticket.gen === ticket.gen
        && active.invalidateReason !== null
      ) {
        markInterrupted(active.invalidateReason, active.invalidateWhy);
      } else if (fsm.state === 'closed') {
        markInterrupted('closed', fsm.lastTransitionReason);
      } else if (this.isTurnDead(ticket)) {
        markInterrupted('superseded', fsm.lastTransitionReason);
      }

      // 用户听到多少、这一轮该不该记账 —— **判定交给内核**（`kernel.ts` 的纯函数）。
      // 这里只把「这一轮被顶掉了」这条事实告诉它，取回它声明的结算意图，照单执行。
      // `stale`（控制面，票据比对）与 `truncated`（内容面，媒体游标）都在内核里；
      // 插话当场结算过的那一轮，这里拿到的是同一份结算（`lastSettled` 幂等重述）。
      if (this.isTurnDead(ticket)) {
        this.feed({ type: 'ticketInvalidated', ticket });
      }
      const settleEffects = this.feed({ type: 'turnEnded', ticket, atMs: nowMs });
      // 结算由 `KernelPorts.settleTurn` 送进来（上面那次 `feed` 就执行了它）——
      // 这里只按票据取走，**不再自己从意图里挑一条本地解释**。
      let settlement = this.takeSettlement(ticket);
      if (settlement === null && this.options.fsm.runtime.ports === null) {
        // 裸跑 TurnRunner 单测（未挂 DialogRuntime 端口）时，用一次性本地端口解释
        // 同一批内核意图 —— 没有第二套口径，只是把「谁来执行」换成本地空实现。
        const local: { turn: KernelSettlement | null } = { turn: null };
        applyEffects(settleEffects, {
          stopDeviceAudio: () => {},
          invalidateTurn: () => {},
          abortEngine: () => {},
          settleTurn: (turn) => { local.turn = turn; },
          log: this.log,
        });
        settlement = local.turn;
      }
      // 内核保证 `turnEnded` 必出一条结算（要么现算，要么重述当场那次）。真缺了就是
      // 装配坏了 —— 只留痕，**不拿第二套口径兜底**（那正是这次要删掉的东西）。
      if (settlement === null) {
        this.log('  内核    ✗ 没拿到这一轮的结算意图（内核保证必然有，检查装配）');
        settlement = {
          ticket,
          truncated: false,
          reflect: false,
          inject: 'none',
          heardMs: 0,
          totalAudioMs: 0,
          lane: null,
          endedAtMs: nowMs,
        };
      }
      const inject = settlement.inject;
      const truncated = settlement.truncated;
      const heardSeconds = settlement.heardMs / 1000;
      const audioSeconds = pcm16DurationMs(trace.audioBytes, trace.audioRate) / 1000;

      if (kind === 'normal') {
        // 委派轮：把 dsh 的答案回注给 omni 的上下文，否则它不知道自己那一轮被接走了。
        // 按 `truncated` 而不是 `interrupted`：插话落在最后一个字之后（上面第 3 轮那种）
        // 用户其实听全了，该注；少听了一段才不注。
        //
        // **不再要求 `audioBytes > 0`**：*一个字都没下发*不等于*用户少听了*。委派轮的
        // 答案是这一轮的事实结论，用户下一轮问的就是它 ——
        // 真机 `20261123-053719` 第 2 轮，dsh 答出了《其主之声》，`audio_s=0.00`
        // 被这条守卫拦下，于是 omni 至今不知道书名，第 5 轮把《奇书》当真书名编了 10.4 s。
        // 内容照注，口气（`spoken`/`unspoken`）按实际下发情况标 —— 见 `InjectKind`。
        //
        // 快车道答的轮次不注：它们走 `reply()`，omni 那边由 `noteServedTurn` 覆盖。
        //
        // **口气只认内核的 `settlement.inject`**（`spoken` / `unspoken` / `none`）：
        // 以前这里按 `audioBytes === 0` 自己判 `unspoken`，与内核的 `reflect` 是两套算法，
        // 一处改了尺子另一处静默漂移。`none` 就是「用户少听了一段」，不注。
        if (trace.path === 'dsh' && inject !== 'none' && trace.speech.trim() !== '') {
          if (inject === 'unspoken') {
            this.log('  omni    答案一个字都没念出去，但仍回注（下一轮会接着问）');
          }
          agent.injectAnsweredTurn?.(text, trace.speech, inject);
        }

        // 账本：只有 **omni 自己答完**的轮次才记（它没走 `reply()`，不记就跨车道失忆）。
        // 转交 dsh 的那种不算 —— omni 说的那句只是垫话，dsh 那一轮由 `injectAnsweredTurn`
        // / `onDetachedAnswer` 记，重复记账会让路由以为"上一轮是 live 答的"。
        //
        // `truncated` 用结算出来的那个值，**不能省**：账本里它决定回注与粘性判断，
        // 缺了就永远以为用户听全了（P1-4 的接线点）。
        if (trace.path === 'omni' && !trace.delegated && !trace.nonBlockingDelegate) {
          agent.noteServedTurn?.(text, trace.speech, truncated);
        }
      }

      if (kind === 'failed') {
        // 失败也留一条：否则报告里这一轮的 ④ 会显示"缺仪表"，与"没拿到音频"混在一起
        this.options.onEvent?.(EVENTS.turnEnd, {
          failed: true,
          dsh_ms: trace.agentLatencyMs ?? 0,
          ...netFields(diffNetCounters(netBefore, readNetCounters())),
        });
        this.log(`  ✗ 本轮失败: ${(error as Error).message}`);
      } else {
        this.options.onEvent?.(EVENTS.turnEnd, {
          interrupted: trace.interrupted,
          truncated,
          audio_s: Number(audioSeconds.toFixed(2)),
          heard_s: Number(heardSeconds.toFixed(2)),
          // 这一轮**念出去的**文本，审计模型行为用（尤其「抢话之后它有没有接上」）。
          // `path=dsh` 另有 `session.v4.jsonl.zstd` 里的 `assistant/message` 可对；
          // 快车道（qwen-flash）没有 session log，这是它唯一的口供。记实际播出的
          // 文本（多步时是全部增量，见上方 `trace.speech` 注释），回执不在这条里。
          //
          // **一个字节都没下发就记空**：真机 `20261123-053719` 第 2 轮
          // `audio_s=0.00 / barge_in=1`，`said` 却记了 39 字 —— 档案看着"它答了"，
          // 用户一个字都没听到。`speech` 本身还要留给续话用（它决定「还剩几个字」），
          // 所以清的是这一条记录，不是变量。
          said: trace.audioBytes === 0 ? '' : trace.speech,
          said_chars: trace.audioBytes === 0 ? 0 : [...trace.speech].length,
          dsh_ms: trace.agentLatencyMs ?? 0,
          tts_first_ms: trace.ttsFirstMs ?? -1,
          // 这一轮是谁答的。没有它，档案里分不出快车道和 dsh —— `dsh_ms` 两组重叠，
          // 只能靠 console 的 `快车道` 行反推（而且「模型自己让位」和「本地闸挡住」
          // 在日志里长得一模一样）。
          ...(trace.path === null ? {} : { path: trace.path }),
          ...(trace.delegateReason === null ? {} : { delegate: trace.delegateReason }),
          // 记下 dsh 的会话 id，事后才能把这一段和 dsh 自己的 step/tool 轨迹对齐
          ...(this.options.agent.sessionId ? { dsh_session: this.options.agent.sessionId } : {}),
          // **事件循环被占住的时长**，这一轮里最大的一次。
          // 为什么要它：TTS 偶发多出 ~250 ms，而「合成本身」和「服务端接单」都量过是平的
          // （见 `COSYVOICE_TRACE` 与 `docs/OPS-RECORD.md` §12.8.1）—— 那就只剩
          // 「进程被卡了一下」这一种解释，可这条从来没有仪表。有了 max/p99 就能直接判：
          // 尖峰轮的 `loop_max_ms` 也大 → 是我们自己卡的，跟厂商无关。
          ...loopLagSnapshot(),
          // 本轮整机 TCP 计数器增量。**出向**（`net_retrans` / `net_timeouts` /
          // `net_lost_retrans`）算我们发出去的重传；**入向**（`net_ofo_queue` /
          // `net_dsack`）是「厂商回我们的包丢了」的代理 —— 只看前者会把厂商侧重传
          // 误判成「厂商应用层慢」。读不到时这些字段根本不出现，不是 0。
          ...netFields(diffNetCounters(netBefore, readNetCounters())),
        });

        // **每 socket** 的重传/RTO 在 `turn.end` 之后异步采一次（不 await）：
        // 整机计数分不出是谁在重传，而 `ss` 的子进程开销不能进关键路径。
        // 只采 443（厂商那三条）—— 手机那条靠**排除法**：整机涨而三条都是 0，
        // 剩下的就只能是服务器→手机那条（本轮唯一的另一条大流量）。
        void sampleSockets(443).then((sockets) => {
          if (sockets.length === 0) return;
          this.options.onEvent?.(EVENTS.netSockets, { sockets });
        });
      }

      // 内核结算的 `stale` 是**唯一**口径（`outcome.stale`）；读不到时才退回
      // 「票据死了 / 被打断 / 结算给了别的轮」这条等价判据 —— 不另算一套。
      const settled = fsm.runtime.state.ledger.lastSettled;
      const stale = settled !== null
        && settled.ticket.no === ticket.no
        && settled.ticket.gen === ticket.gen
        ? settled.outcome.stale
        : this.isTurnDead(ticket) || trace.interrupted || settlement.ticket.no !== ticket.no;
      const sessionId = this.options.agent.sessionId;
      const report = buildTurnReport({
        ticket: { no: ticket.no, gen: ticket.gen },
        baseCommitSeq: ticket.baseCommitSeq ?? null,
        status: resolveTurnStatus({
          failed: kind === 'failed',
          closed: fsm.state === 'closed',
          interrupted: trace.interrupted,
        }),
        path: trace.path,
        lane: settlement.lane,
        delegated: trace.delegated,
        delegateReason: trace.delegateReason,
        nonBlockingDelegate: trace.nonBlockingDelegate,
        interrupted: trace.interrupted,
        interruptReason: trace.interruptReason,
        interruptWhy: trace.interruptWhy,
        error: kind === 'failed'
          ? (error instanceof Error ? error.message : String(error))
          : null,
        stale,
        truncated,
        reflect: settlement.reflect,
        inject,
        heardMs: settlement.heardMs,
        totalAudioMs: settlement.totalAudioMs,
        audioBytes: trace.audioBytes,
        saidChars: trace.audioBytes === 0 ? 0 : [...trace.speech].length,
        startedAtMs: trace.startedAtMs,
        firstAudioAtMs: trace.firstAudioAtMs,
        playedAtMs,
        endedAtMs: nowMs,
        agentMs: trace.agentLatencyMs,
        // Omni 直出没有「首 token」这个相位：即使引擎顺手报了也不记。
        llmFirstMs: trace.path === 'omni' ? null : trace.llmFirstMs,
        firstTextMs: trace.firstTextMs,
        ttsFirstMs: trace.ttsFirstMs,
        dshSession: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
      });
      // 快照只进账本：`stepPlayback` 不碰相位、不产意图（连接已 `closed` 也能落账）。
      this.feed({ type: 'turnReport', report });
      this.options.onEvent?.(EVENTS.turnReport, turnReportToArchiveFields(report));

      if (kind === 'failed') {
        return null;
      }
      return {
        interrupted: trace.interrupted,
        speech: trace.speech,
        audioBytes: trace.audioBytes,
        audioSeconds,
        playedSeconds: heardSeconds,
        firstChunkLatencyMs: trace.ttsFirstMs ?? -1,
        agentLatencyMs: trace.agentLatencyMs ?? 0,
      };
    };

    // **上游取消的入口**。生产（`DialogRuntime` 绑了端口）走内核那条：
    // `dispatchAndApply` → `applyEffects` → `KernelPorts.invalidateTurn`
    // → `this.invalidateTurn(ticket, reason)`。这里**不再订阅** `onInvalidate`，
    // 否则同一条意图会被解释两遍（`cancelTurn` 联动 `detachTurn` 会让 dsh 丢答案）。
    //
    // 裸跑（TurnRunner 单测 / 离线推演，没有装配层）没有端口执行意图，
    // 才退回订阅 —— 两条路都只落在 `invalidateTurn` 上，口径同一份。
    const offInvalidate = fsm.runtime.ports === null
      ? fsm.onInvalidate((reason) => { this.invalidateTurn(ticket, reason); })
      : (): void => {};
    // 这三次转移（beginTurn / audioStarted / audioDone）都在本方法里发生，
    // 走不到 `DialogRuntime.dispatch`。不在这里通知，话筒就永远只看到 `listening`
    // 一个状态 —— 结束时 `release('reply')` 不会执行，宠物的 `floorFree` 一直不成立。
    this.options.onState?.();

    try {
      /**
       * 首块是不是已经处理过。
       *
       * **不能拿 `ttsFirstMs === 0` 当哨兵**：omni 直出那条没有合成起点，
       * 于是整段（`tts.first` 事件、`audioStarted`、掐回执）会**每块重跑一次** ——
       * 真机档案里一场 14 轮冒出 338 条 `tts.first`。
       */
      let firstChunkSeen = false;
      const emit = (chunk: Buffer): void => {
        // await 恢复后旧轮可能已被新轮顶掉（no）或插话作废（gen），或连接已关。
        // 这里是下发点：死了的轮次不许再把音频送出去。
        if (this.isTurnDead(ticket) || fsm.state === 'closed') {
          return;
        }
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          trace.firstAudioAtMs = this.options.clock.now();
          // 合成起点已知、且与本条同一把时钟：这一段就是 `tts_first_ms`。
          // 跨时钟（引擎的 `firstSynthAtMs` 来自 `Date.now` 之类）会得到负差值，
          // 那种情况保持 `null`，绝不伪造 0 —— 引擎自己报的 `meta.ttsFirstMs` 才是权威。
          if (
            trace.ttsFirstMs === null
            && trace.firstSynthAtMs !== null
            && trace.firstAudioAtMs >= trace.firstSynthAtMs
          ) {
            trace.ttsFirstMs = trace.firstAudioAtMs - trace.firstSynthAtMs;
          }
          this.firstAudioSeen = true;
          // 回执还在念：先清掉设备缓冲再发这一块，否则两句会叠在一起
          if (this.receipt !== null && !this.receipt.cancelled) {
            this.receipt.cancelled = true;
            this.receipt = null;
            this.log('  回执    被正式回答顶掉');
            this.options.sendCall?.({ op: 'audio.stop' });
            // 回执那段 `speaking` 到此为止；紧接着 `audioStarted` 会重新进入 speaking
            fsm.receiptEnded(ticket);
          }
          fsm.audioStarted(ticket);
          this.options.onState?.();
          this.log(`  TTS首块 ${((trace.ttsFirstMs ?? 0) / 1000).toFixed(2)} s`);
          // 既有事件保持原样：拿不到同源差值时仍是 `ms: 0`（延迟复算用事件时间戳）
          this.options.onEvent?.(EVENTS.ttsFirst, { ms: trace.ttsFirstMs ?? 0 });
        }
        trace.audioBytes += chunk.length;
        // 媒体游标：内核判"用户听到多少"只认它（不是墙钟）——`outcomeOf` 那张三把尺子的表。
        // 只在**这一轮还占着播放区**时喂：被插话当场结算之后迟到的那一块若还记进去，
        // 会写进下一轮的播放区（共享内核只有一个），结算就按错的数据算少听没少听。
        if (this.ownsPlayback(ticket)) {
          this.feed({
            type: 'audioSent',
            mediaMs: pcm16DurationMs(trace.audioBytes, trace.audioRate),
            atMs: this.options.clock.now(),
          });
        }
        this.options.onDownlinkChunk?.(chunk);
        downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      };

      let agentMarked = false;
      const markAgent = (): void => {
        if (agentMarked) {
          return;
        }
        agentMarked = true;
        trace.agentLatencyMs = this.options.clock.now() - trace.agentStartedAt;
      };
      const turnInput: TurnInput = {
        text,
        no: ticket.no,
        baseCommitSeq: ticket.baseCommitSeq ?? 0,
        startedAtMs: trace.startedAtMs,
        hasImage: image !== undefined,
        ...(image === undefined ? {} : { image: turnImage(image) }),
        ...(note === undefined ? {} : { note }),
        ...(utterancePcm === undefined ? {} : { utterancePcm }),
        ticket,
      };
      for await (const ev of this.engine.respond(turnInput, turnAbort.signal)) {
        if (this.isTurnDead(ticket) || fsm.state === 'closed') {
          break;
        }
        switch (ev.type) {
          case 'meta':
            if (ev.path !== undefined) {
              trace.path = ev.path;
              this.noteLane(ev.path);
            }
            if (ev.delegate !== undefined) {
              trace.delegateReason = ev.delegate as DelegateReason;
            }
            if (ev.firstTokenMs !== undefined) {
              trace.llmFirstMs = ev.firstTokenMs;
              this.options.onEvent?.(EVENTS.llmFirst, { ms: ev.firstTokenMs });
            }
            // 引擎用**自己那把时钟**算好的「首段送合成 → 首块音频」：直接采用。
            // 这是跨时钟相减的唯一正解（见 `engine-contract.ts` 的 `meta.ttsFirstMs`）。
            if (ev.ttsFirstMs !== undefined) {
              trace.ttsFirstMs = ev.ttsFirstMs;
            }
            if (ev.firstSynthAtMs !== undefined && trace.firstSynthAtMs === null) {
              trace.firstSynthAtMs = ev.firstSynthAtMs;
              // 音频往往先于这条 meta。首块当时还不知道起点，这里按同一对时刻
              // 把记在 `turn.end` 上的 `tts_first_ms` 补上。`tts.first` 事件本身
              // 已经在首块发出（延迟复算用的是事件时间戳，不是这个字段）。
              if (
                trace.ttsFirstMs === null
                && trace.firstAudioAtMs !== null
                && trace.firstAudioAtMs >= ev.firstSynthAtMs
              ) {
                trace.ttsFirstMs = trace.firstAudioAtMs - ev.firstSynthAtMs;
              }
            }
            if (ev.nonBlocking === true) {
              trace.nonBlockingDelegate = true;
            }
            break;
          case 'audio':
            markAgent();
            if (ev.sampleRate !== undefined) {
              trace.audioRate = ev.sampleRate;
            }
            emit(ev.pcm);
            break;
          case 'text':
            trace.streamedText += ev.delta;
            trace.speech = trace.streamedText;
            if (trace.firstTextMs === null && ev.delta.trim() !== '') {
              trace.firstTextMs = Math.max(0, this.options.clock.now() - trace.startedAtMs);
            }
            // 循环头已经把作废轮挡掉了；这里只把还活着的增量送给浮层。
            if (!this.isTurnDead(ticket)) {
              safeEmitUi(this.options.onUiEvent, {
                type: 'reply.delta',
                delta: ev.delta,
                ...(trace.path === null ? {} : { path: trace.path }),
              });
            }
            break;
          case 'delegate':
            // 这一轮中途把它转交给了 dsh（omni 发了 `tool_call`）。
            // omni 在转交前说的那句只是**垫话**，不是一轮独立的 `live` 完结 ——
            // 记账时不能当成"omni 答过这一轮"，否则账本里会出现一条它没答完的记录。
            trace.delegated = true;
            trace.delegateReason = ev.reason as DelegateReason;
            safeEmitUi(this.options.onUiEvent, {
              type: 'delegated',
              query: ev.rewrittenQuery ?? text,
              ...(ev.reason === '' ? {} : { reason: ev.reason }),
            });
            break;
          case 'done':
            markAgent();
            trace.speech = ev.speech ?? ev.fullText;
            if (!trace.uiFinalSent && !this.isTurnDead(ticket)) {
              const raw = ev.fullText.trim() !== '' ? ev.fullText : trace.speech;
              if (raw.trim() !== '') {
                this.emitReplyFinal(raw, ev.speech, trace.path ?? undefined);
                trace.uiFinalSent = true;
              }
            }
            break;
        }
      }
      if (!agentMarked) {
        markAgent();
      }
      if (!trace.uiFinalSent) {
        // `done` 若把 `speech` 收成空串，流式增量还在 `streamedText` 里。
        const raw = trace.speech.trim() !== '' ? trace.speech : trace.streamedText;
        if (raw.trim() !== '' && !this.isTurnDead(ticket) && fsm.state !== 'closed') {
          this.emitReplyFinal(raw, raw, trace.path ?? undefined);
        }
      }
      this.log(
        `  agent   ${((trace.agentLatencyMs ?? 0) / 1000).toFixed(2)} s  `
        + JSON.stringify(trace.speech.slice(0, 120)),
      );

      // **单调置位**：这里只补上「被顶掉」这一种；插话 / 关闭的原因由
      // `invalidateTurn` 锁存，强弱由 `markInterrupted` 统一裁决。
      if (this.isTurnDead(ticket)) {
        markInterrupted('superseded', fsm.lastTransitionReason);
      }
      const audioSeconds = pcm16DurationMs(trace.audioBytes, trace.audioRate) / 1000;
      this.log(
        `  回放    ${trace.audioBytes} 字节  ${audioSeconds.toFixed(2)} s`
        + (trace.interrupted ? '（被中断）' : ''),
      );

      this.log(
        `TURN n=${ticket.no} text_len=${text.length} dsh_ms=${trace.agentLatencyMs ?? 0}`
        + ` tts_first_ms=${trace.ttsFirstMs ?? -1}`
        + ` audio_s=${audioSeconds.toFixed(2)}`
        + (trace.path === null ? '' : ` path=${trace.path}`)
        + (trace.delegateReason === null ? '' : ` delegate=${trace.delegateReason}`)
        + (trace.interrupted ? ' barge_in=1' : '')
        // 控制台也要一眼看出委派与非阻塞：档案里分得清，日志里以前只有 `delegate=`
        + (trace.delegated ? ' delegated=1' : '')
        + (trace.nonBlockingDelegate ? ' non_blocking=1' : ''),
      );

      // 状态机在整个等待期间保持 speaking；插话会让票据作废从而提前结束等待。
      if (!trace.interrupted) {
        // 基准是**首块下发时刻**，不是「最后一块发完的时刻」：omni 流式吐 6 s 音频
        // 本身就要 ~1 s，设备在这 1 s 里已经在播了。用发完时刻当基准，播完之后还要
        // 白锁整整 1 s 的 `speaking`（真机 2026-11-23 05:14：6.16 s 那轮多锁 1.05 s，
        // 用户已经在说下一句，状态机还卡在 speaking）。
        const playbackStartAt = trace.firstAudioAtMs ?? this.options.clock.now();
        const estimateAt = playbackStartAt + audioSeconds * 1000;
        // 设备回执只能**延后**，不能提前：真机上 `played` 有时在「最后一批字节收到」
        // 就报上来了（4.58 s 音频 1 s 回执），按它走等于把尾音那段插话窗口关掉。
        // 所以估算时长是下限，played 到了也要等到下限之后；上限只用来兜「事件永远不来」。
        const graceMs = this.options.deviceReportsPlayed === true
          ? Math.max(this.options.playbackTailMs, this.options.playedGraceMs ?? PLAYED_GRACE_MS)
          : this.options.playbackTailMs;
        const capAt = estimateAt + graceMs;
        // 断连时 `close()` 不推进代次（它不动 `gen`），只看票据会一直空等到上限。
        // `isTurnDead` 同时核对 no 与 gen：吸收窗口开了新轮也要立刻停。
        while (
          !this.isTurnDead(ticket)
          && fsm.state !== 'closed'
          && this.options.clock.now() < capAt
        ) {
          if (this.playedSeen && this.options.clock.now() >= estimateAt) {
            break;
          }
          await this.wait(PLAYBACK_POLL_MS);
        }
      }

      return finish('normal');
    } catch (error) {
      // 失败也走**同一个**出口：`turnEnded` 必须补发，否则 `ledger.lastSettled`
      // 停在上一轮、`playback` 还挂着这张票（下一轮开轮会拿脏数据结算）。
      return finish('failed', error);
    } finally {
      offInvalidate();
      // 端口侧的作废对象只活这一轮：清掉之后迟到的 `invalidateTurn` 一定是给别人
      // （或者已经没有在途轮次），严格票据比对会把它丢掉。
      this.activeTurn = null;
      this.playingTicket = null;
      // 先取消本轮回执，再 audioDone。悬空的 holdReceipt 若在下一轮开了之后
      // 才醒来，只能拿锁存的旧票去 receiptEnded —— 过期票是空操作。
      this.cancelActiveReceipt();
      fsm.audioDone(ticket);
      this.options.onState?.();
      this.options.onTurnFinished();
    }
  }
}
