/**
 * `DialogRuntime`：对话层的一条完整回路，**生产和模拟器共用这一个实现**。
 *
 * ```text
 * 定稿一句话 ──► SessionCore ──effects──► 串行队列 ──► TurnRunner ──► 下行
 *                  ▲                        │
 *    拍到的图 / 设备事件 ────────────────────┘
 * ```
 *
 * <h2>为什么要有这个类</h2>
 *
 * ADR-0002 §3.1 要求被模拟的是应用层本身，而不是它的抄本。这些接线 ——
 * 状态机、拍照收件箱、一轮的串行队列、后台播报的排队 —— 原先各自写在
 * `voice-session.ts` 和 `pet/sim/dialog.ts` 两处，两份一定会漂移。现在只有这一份。
 *
 * 所有**判定**仍在 `session-core.ts`（纯函数），所有**环境**都从这里注入：
 * 下发设备操作、攒句子、结束连接、播报时怎么开麦。
 *
 * <h2>不在这里的东西</h2>
 *
 * ASR、上行音频、TLS、协议帧都留在适配层。本类只吃"一句话定稿了"这种已经抽象过的
 * 事件，所以虚拟时间里跑它不需要设备、不需要网络、不需要 ffmpeg。
 */
import { closeAnnounceMic, speakAnnouncement } from './announce.ts';
import { isBackchannelOnly } from '../backchannel.ts';
import type { Cancel, Clock } from './clock.ts';
import type { DeviceCall, DeviceCapabilities } from '../devices/primitives.ts';
import type { DialogFsmContext, TurnTicket, DialogState } from '../dialog-fsm.ts';
import { initialKernelState } from '../kernel.ts';
import { KernelRuntime } from '../kernel-runtime.ts';
import { PhotoInbox, type CaptureRequest } from '../photo-inbox.ts';
import {
  announceInterruptionNote, interruptionNote, remainingSpeech, TTS_CHARS_PER_SEC,
} from '../interrupted-tail.ts';
import type { FastVoiceEngine } from '../engine-contract.ts';
import { EVENTS } from '../events.ts';
import type { AgentProvider, DelegateReason, TtsProvider } from '../providers.ts';
import { SessionCore, type CoreEffect, type CoreEvent } from '../session-core.ts';
import type { ImageAttachment } from '../session.ts';
import type { DownlinkSink } from '../transport.ts';
import { TurnRunner, type TurnResult } from '../turn-runner.ts';

/** 被打断的那半句最多留这么久：再久就是另一段对话了。 */
const TAIL_TTL_MS = 120_000;

/**
 * 用户最后一次开口之后，要安静这么久才敢播报。
 *
 * 状态机只在**一句话定稿之后**才 `listening → thinking`，所以「用户正说到一半」
 * 和「用户不说话」在 `core.phase` 里是同一个 `listening`。光看 phase 就会在用户
 * 换气的地方插进来 —— 实测最难受的不是慢两秒，是「它抢在我说完之前开口」。
 */
const ANNOUNCE_QUIET_MS = 800;

/**
 * 交给慢车道时给用户的一句回执。
 *
 * 真机实测（2026-11-16，v2 设备）：交给 dsh 的轮次从停嘴到出声 1.8–2.9 s，中间
 * 一片安静；而快车道命中的是 1.0–2.0 s。这段空白用一句话填上，比让用户以为没听见好。
 *
 * 只有**四个字**（一句 4.8 字/秒 ≈ 0.83 s）：太长了答案就得等它，反而更慢。
 */
const RECEIPTS: Record<DelegateReason, readonly string[]> = {
  task: ['我看看。', '嗯，我查查。', '哦，稍等。'],
  // 用户刚回答了 dsh 的问话，回执只是填空 —— 「我看看」在这里听着像没听懂
  answer: ['嗯。', '嗯嗯。'],
  memory: ['我记着。', '嗯，记住了。'],
  overcap: ['我看看。', '嗯，稍等。'],
  delegate: ['我看看。', '嗯，等一下。', '哦，好。'],
  // 「嗯，我想想」实测 1288 ms，答案 700 ms 就到了 —— 永远只播半句，所以换短的
  timeout: ['嗯…', '稍等。'],
  empty: ['嗯…', '让我想想。'],
  error: ['我看看。', '嗯，稍等。'],
};

/**
 * 挑一条回执。
 *
 * 为什么要**多条**：真机 19 次回执里 18 次都是「我看看。」—— 委派轮占四成，
 * 用户听出来就是「这东西张口就是我看看」，还以为是快模型在说（其实快车道轮
 * 一次回执都不播，见 `delegation-receipt.test.ts`）。
 *
 * 每条都会被 `TurnRunner.speakReceipt` 的缓存按文案 key 记住（第一次合成、之后
 * 0 ms 首块），所以多几条只是首次多合成几次，播放时没有代价。
 */
function pickReceipt(reason: DelegateReason): string {
  const options = RECEIPTS[reason];
  return options[Math.floor(Math.random() * options.length)] ?? options[0]!;
}

/** 播报时怎么开麦。设备没有 `listen.start` 就不给这个。 */
export interface AnnounceMic {
  readonly listenStart: boolean;
  /** 开麦到首帧上行音频的截止 */
  readonly micOpenTimeoutMs: number;
  /** 说完之后再听多久 */
  readonly listenMs: number;
  readonly call: (call: DeviceCall) => void;
  /** 等首帧上行，最多 `timeoutMs`；`true` = 麦开了 */
  readonly awaitMicOpen: (timeoutMs: number) => Promise<boolean>;
}

/** 对话层要往外做的事。生产接到连接上，模拟器接到计数器和数组上。 */
export interface DialogEnv {
  /** 下发一次设备操作；`false` = 设备或协议表达不了 */
  readonly call: (call: DeviceCall) => boolean;
  /** 攒一句进这一轮（ASR 的分句） */
  readonly assemble: (text: string) => void;
  /** 这一轮该结束了 */
  readonly end: () => void;
  /** 拍照请求作罢之后的清账（v1 的 id 映射表） */
  readonly forget?: (id: string) => void;
  /** 播报时怎么开麦；不给就是不支持开麦 */
  readonly announceMic?: AnnounceMic;
  /** 播报排队状态（`pending` = 还有话等着说，`spoken` = 刚播完一条） */
  readonly onAnnounce?: (pending: boolean, spoken: boolean) => void;
  /** 有没有一轮在跑（对话层占着话筒） */
  readonly onTurnStart?: (text: string, hasImage: boolean) => void;
  readonly onTurnEnd?: () => void;
  /**
   * 对话状态机每次转移后回调（实现见 `dispatch`）。
   *
   * 话筒归属就用它驱动（`AppSession.onDialogState`）：**由状态定，不由布尔量特判**。
   */
  readonly onDialogState?: (state: DialogState, previous: DialogState) => void;
  /**
   * 这一轮要附带给模型的**设备现状**（电量、佩戴…）。
   *
   * 模型看不见上行事件，不给它这行就会瞎答：真机问「眼镜还剩多少电」，
   * agent 回「读不到，我手上没有拿电量的接口」——可设备每 30 s 就在报
   * `{"kind":"power","percent":77}`，只是那数据只喂给了宠物环。
   */
  readonly deviceNote?: () => string | undefined;
  /** 每个效果执行前过一眼（档案、断言用） */
  readonly onEffect?: (effect: CoreEffect) => void;
}

/**
 * 把「设备现状」和「续话尾巴」拼成这一轮的系统注记。
 *
 * 两段都是**可选**的，而且都只在当下有效（电量会变、尾巴只活一轮），
 * 所以拼在用户消息前面而不是塞进系统提示词 —— 后者会被前缀缓存锁住。
 *
 * 导出是为了能单测：这里的顺序错了模型就会把「接着刚才」理解成「设备状态」。
 */
export function composeTurnNote(deviceNote?: string, tailNote?: string): string | undefined {
  const parts = [deviceNote, tailNote].filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? undefined : parts.join('；');
}

/** 一条后台播报。字符串入队仍合法，字段形态留给 Pure Live 同嗓子汇报。 */
export interface AnnounceItem {
  readonly speech: string;
  readonly emotion?: string;
  /** 后台任务标识（Pure Live 模式用于防重复回注与上下文关联） */
  readonly taskId?: string;
  /** 触发任务的用户原问（供前台汇报对齐指代） */
  readonly query?: string;
  /** 为真时必须走逐字朗读路径（如精确数字/端口/长报告），不交给对话态 Omni 自由转述 */
  readonly verbatim?: boolean;
  /** 后台任务需要用户确认的问题 */
  readonly needsConfirm?: string;
}

export interface DialogOptions {
  /** 时钟端口：超时与等待全走它 */
  readonly clock: Clock;
  readonly caps: DeviceCapabilities;
  /**
   * 票据上的 `baseCommitSeq` / `startedAtMs` 从哪来（见 dialog-fsm.ts 的
   * DialogFsmContext）。由 VoiceSession 注入 —— 只有它认识 ASR。
   */
  readonly ticketContext?: DialogFsmContext;
  /**
   * 这条会话还是不是**当前活跃的那条连接**（缺省恒 `true`）。
   *
   * 唯一用途是 `dispose()` 时决定要不要摘 agent 上的回执钩子：`setDelegateHook`
   * 是**进程级共用**的一个槽，而旧连接（被新连接顶掉的那条）的收尾常常晚于
   * 新连接的挂载 —— 不判所有权就摘，等于把新连接的回执掐掉（表现是「重连之后
   * 它再也不说『我看看』」）。
   */
  readonly isActiveOwner?: () => boolean;
  readonly agent: AgentProvider;
  readonly tts: TtsProvider;
  readonly downlink: DownlinkSink;
  /** 识图那一轮问 agent 的话 */
  readonly imageQuestion: string;
  /** 拍照落盘目录；空串不落盘 */
  readonly photoDir: string;
  readonly photoTimeoutMs: number;
  readonly confirmTimeoutMs: number;
  /** 预估播放时长之外再等的余量 */
  readonly playbackTailMs: number;
  readonly ttsGain?: number;
  /** 每块下行音频（AEC 分析落盘用） */
  readonly onDownlinkChunk?: (chunk: Buffer) => void;
  /** 时间线事件（进会话档案） */
  readonly onEvent?: (name: string, fields?: Record<string, unknown>) => void;
  /**
   * 挂/摘「流式增量」的钩子（逐句合成用）。
   * 宿主把它接到 dsh 的流式侧通道；不接就退回整段合成。
   */
  readonly onLiveAvailable?: (sink: ((text: string) => void) | null) => void;
  /**
   * 长思考回执：一句话在 `afterMs` 内还没开始出声，就先用旁白说 `text`。
   * 不给就不回执。
   */
  readonly env: DialogEnv;
  readonly log: (line: string) => void;
  /** 可选：热路径语音引擎（Pure Live / Pure Cascade 由装配层显式注入；缺省时由 TurnRunner 包装 agent+tts） */
  readonly engine?: FastVoiceEngine;
  /**
   * 可选：自定义后台播报播放口（Pure Live 模式下用 Omni `speakFromText()` 同嗓子汇报）。
   *
   * - `'spoken'`：已通过实时前台播出并入历史
   * - `'defer'`：实时前台此刻正忙 / 有用户缓冲，排回队首顺延重试
   * - `'fallback'`：要求逐字朗读或前台不可用，退回 `runner.speakCanned()`
   */
  readonly speakAnnounce?: (item: AnnounceItem) => Promise<'spoken' | 'defer' | 'fallback'>;
  /**
   * 可选：出队前判断这条播报是否已经不需要再说。
   *
   * Pure Live 把它接到 `LiveOrchestrator.shouldSkipBackgroundReport()`：前台 Omni
   * 可能已经读过单槽里的完整结论，队列里那一条再来一遍就是双讲。命中时
   * **不开麦、不调 speakAnnounce、不记出过声**，连队列通知都不该发。
   */
  readonly shouldSkipAnnounce?: (item: AnnounceItem) => boolean;
  /** 可选：插话或双击清空播报时，同步掐断正在播的自定义后台汇报（例如 Omni `cancelBackgroundSpeech()`） */
  readonly cancelAnnounce?: () => void;
  /** 可选：当某条播报走回落 TTS（`verbatim` 或 `'fallback'`）播完/被打断后通知上层（用于静默回注 Omni 历史） */
  readonly onFallbackAnnounceSpoken?: (item: AnnounceItem, interrupted: boolean) => void;
  /**
   * 是否允许播报 / 委派回执退回外部 TTS（`runner.speakCanned` / `speakReceipt`）。
   * 默认 `true`（Cascade）；Pure Live 必须传 `false`：live 路径绝不调用外部 TTS。
   */
  readonly allowTtsFallback?: boolean;
}

export class DialogRuntime {
  readonly core: SessionCore;
  readonly photos: PhotoInbox;
  readonly runner: TurnRunner;

  private readonly options: DialogOptions;
  /** 上一次通知过的状态机状态（只在真的变了时回调 `onDialogState`） */
  private lastDialogState: DialogState;
  /**
   * 挂在 agent 上的回执钩子。
   *
   * 存成字段而不是匿名闭包：`dispose()` 要按**值**判断「现在挂的是不是我那份」，
   * 现造一个新闭包摘不掉别人的（`setDelegateHook` 没有令牌参数）。
   */
  private readonly delegateHook = (reason: DelegateReason): void => {
    if (this.disposed || this.options.allowTtsFallback === false) {
      return;
    }
    this.runner.speakReceipt(pickReceipt(reason));
  };
  /** `fsm.onState` 的退订函数（`dispose()` 时摘掉，别让死连接继续收通知） */
  private readonly unsubscribeState: () => void;
  /** 一轮、一次拍照都排在这条链上，不并发 */
  private serialChain: Promise<void> = Promise.resolve();
  /** 串行队列里还没跑完的任务数 */
  private queued = 0;

  private readonly announceQueue: AnnounceItem[] = [];
  /**
   * 播报协程的唯一相位。队列是货，这个枚举是「现在在干什么」。
   *
   * - `empty` 没货
   * - `queued` 有货，在等正题结束或用户安静
   * - `opening_mic` 开麦窗口
   * - `speaking` 正在念
   * - `deferred` 让过路（前台忙，或开麦时用户说了一句），等空窗重试
   */
  private announcePhase: 'empty' | 'queued' | 'opening_mic' | 'speaking' | 'deferred' = 'empty';
  private disposed = false;
  /** 用户最后一次开口（中间结果也算）的时刻，用来判断「他是不是还在说」。 */
  private lastUserSpeechAt = Number.NEGATIVE_INFINITY;
  /**
   * 用户最后一整句（`sentence` / `utterance`）的时刻。
   *
   * 和 {@link lastUserSpeechAt} 分开：那个连 partial 也算，用来掐断正在念的旁白；
   * 这个只认整句 —— 播报在开麦窗口里要不要让路，看的是「他真的说了一句」，
   * 一个语气词的 partial 不该把一条汇报又推后 800 ms。
   */
  private lastUserSentenceAt = Number.NEGATIVE_INFINITY;
  /** 因为用户还在说话而推迟的那次播报检查。同一时刻只排一个。 */
  private announceRetry: Cancel | null = null;
  /**
   * 上一轮被打断、**没念出口**的那一段（一次性）。
   *
   * 只活到下一轮：用户接着问「你刚才想说什么」时，模型得知道自己断在哪。
   * 顺序反过来（用户没再问）就丢掉 —— 隔了几句话还翻旧账更烦人。
   */
  private tail: { readonly text: string; readonly at: number } | null = null;
  /**
   * 被打断的**后台汇报**剩下的那半句。
   *
   * 和 {@link tail} 分开存：一条是「自回答被打断」，一条是「我派出去的活只念了
   * 一半」，给模型的措辞完全不同（后者要它自己判断该不该补）。两条可能同时存在。
   */
  private announceTail: { readonly text: string; readonly at: number } | null = null;

  constructor(options: DialogOptions) {
    this.options = options;

    // **一个会话只有一份 `KernelState`**：这里种好它（含「上一轮谁答的」），
    // `SessionCore` / `DialogFsm` / `TurnRunner` 拿到的是同一个实例。
    // `lastLedgerLane` 是重连时唯一的记性：内核是新建的，不播种就不知道上一轮是 dsh，
    // 用户顺着它的追问回一句会被当成闲聊抢答。
    const kernelRuntime = new KernelRuntime(
      initialKernelState(0, options.agent.lastLedgerLane?.() ?? null),
    );
    this.core = new SessionCore({
      imageQuestion: options.imageQuestion,
      log: options.log,
      capabilities: options.caps,
      runtime: kernelRuntime,
      ticketContext: {
        ...(options.ticketContext ?? {}),
        // `now` 必须有：`bargeIn` 的结算时刻（`endedAtMs` / `heardMs`）从它来。
        // 缺了就是 `atMs = 0`，插话当场结算会算出「一秒都没听到」，与真机行为不同。
        // 模拟器（`DialogSim`）不注入 `ticketContext`，也要走这一条虚拟时钟。
        now: options.ticketContext?.now ?? (() => options.clock.now()),
      },
    });
    this.lastDialogState = this.core.fsm.state;

    this.photos = new PhotoInbox({
      clock: options.clock,
      dir: options.photoDir,
      timeoutMs: options.photoTimeoutMs,
      confirmTimeoutMs: options.confirmTimeoutMs,
      log: options.log,
      send: (call) => options.env.call(call),
    });

    this.runner = new TurnRunner({
      clock: options.clock,
      agent: options.agent,
      tts: options.tts,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      downlink: options.downlink,
      fsm: this.core.fsm,
      playbackTailMs: options.playbackTailMs,
      // 设备能报 `played` 就以设备为准（估算是**下限**，回执只能延后）
      deviceReportsPlayed: options.caps.played,
      onState: () => { this.notifyState(); },
      sendCall: (call) => { options.env.call(call); },
      ...(options.ttsGain === undefined ? {} : { ttsGain: options.ttsGain }),
      ...(options.onDownlinkChunk === undefined ? {} : { onDownlinkChunk: options.onDownlinkChunk }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.onLiveAvailable === undefined ? {} : { onLiveAvailable: options.onLiveAvailable }),
      onTurnFinished: () => {
        this.execute(this.core.dispatch({ type: 'turnFinished' }));
        this.notifyState();
        // 本轮结束，后台任务的播报可以接着放
        void this.flushAnnounce();
      },
      log: options.log,
    });

    // **生产端口**：内核声明的意图从这里落到真实世界 —— 停设备音频、作废在途轮次、
    // 放弃引擎投机、把这一轮的结算交回 `TurnRunner` 并写进账本。
    //
    // 绑一次，此后每一条事件都走 `dispatchAndApply`，意图**只执行一次**：
    // 门面（`DialogFsm`）不再另发一份 `audio.stop`，`TurnRunner` 也不再订阅
    // `onInvalidate` 自己取消一遍。
    //
    // **`dispose()` 不许 `attachPorts(null)`**：`VoiceConnection.onClose` 里
    // `app.dispose()`（含本类 `dispose()`）跑在 `dialog.dispatch({type:'closed'})`
    // **之前**，而 `closed` 必须还能通过 `invalidateTurn` 取消在途的上游请求。
    this.core.runtime.attachPorts({
      stopDeviceAudio: () => {
        options.env.call({ op: 'audio.stop' });
      },
      invalidateTurn: (ticket, reason) => {
        this.runner.invalidateTurn(ticket, reason ?? 'bargeIn');
      },
      abortEngine: (reason) => {
        // 引擎在场时只走 `abortSpeculation`：cascade 内部已经 `dropPrefetch`，
        // live 内部已经 `abortLane`。再打到 agent 上就是同一次中止执行两遍。
        // 引擎缺席（模拟器 / 旧测试）才落到裸 agent，理由字符串与既有装配一致。
        if (options.engine !== undefined) {
          options.engine.abortSpeculation(reason);
          return;
        }
        options.agent.dropPrefetch?.(`内核中止(${reason})`);
      },
      settleTurn: (turn) => {
        // `TurnRunner` 拿它结算这一轮；账本（`ConversationLedger`）按同一张票据
        // 补上「用户到底听全没有」—— 两份账必须同源，否则路由按哪份都错。
        this.runner.acceptSettlement(turn);
        options.agent.reconcileTurnOutcome?.({
          ticket: turn.ticket,
          truncated: turn.truncated,
          endedAtMs: turn.endedAtMs,
        });
      },
      log: options.log,
    });

    // 委派轮的回执：快车道判出「这轮答不了」时补一句，填掉 1.8–2.9 s 的安静。
    // 挂在 `DialogRuntime` 而不是 `voice-session`：轮次在这里，判断「这一轮还要不要说话」
    // 只有它做得了（票据在 `TurnRunner` 里）。
    options.agent.setDelegateHook?.(this.delegateHook);

    // 状态机的**每一次**转移都要走一遍通知（`notifyState` 自己去重）。
    //
    // 只在 `dispatch()` 结尾调一次是不够的：一个事件里可能**同步连续**跳好几格
    // （`awaiting_shot` 里改主意会先 `abortAwaitShot` 回 `listening`、再为同一句话
    // 重新 `beginAwaitShot`），末尾读到的状态和起点相同，去重之后就一条都不通知 ——
    // `AppSession` 的话筒归属和档案里的 `dialog.state` 都会漏掉中间那一格。
    this.unsubscribeState = this.core.fsm.onState(() => { this.notifyState(); });
  }

  // ---------------------------------------------------------------- 输入面

  /**
   * 状态机吃一个事件，并执行它给出的效果。
   *
   * @returns 这一批效果（调用方偶尔要先看一眼，比如"是不是要求停播"）
   */
  dispatch(event: CoreEvent): readonly CoreEffect[] {
    // 先让判定核跑：它才知道这段转写是不是**开轮前录的旧段**（因果屏障）。
    const effects = this.core.dispatch(event);
    // 旧段既不能打断，也不能当「用户刚开口」去掐旁白、去刷新「他还在说话」的时间戳 ——
    // 判停抢跑补回来的那半句会让一条后台汇报莫名其妙停下，或让播报一直让路。
    const droppedPreTurn = effects.some((effect) => effect.type === 'drop' && effect.why === 'pre-turn');

    // 用户只要开口（中间结果 / 定稿 / 成句），任何正在念的「回执」和「播报」都要停。
    // 只在 `onPartial` 上收回执是不够的：短促的插话常常只出定稿（真机 05:17:24）。
    //
    // 这里原来调的是 `cancelAck()`，那个方法在 39cbcd1 里被删掉之后调用没跟过来，
    // 只剩下一个空壳 `if` —— 表现是「用户插话，旁白照念」。别再把这段改成空的：
    // 旁白（后台汇报 / 回执）不占轮次票据，状态机也停在 `listening`，
    // 所以 `bargeIn` 那条路对它不成立，**它是唯一能掐断播报的地方**。
    if (
      !droppedPreTurn
      && (event.type === 'sentence' || event.type === 'partial' || event.type === 'utterance')
    ) {
      this.lastUserSpeechAt = this.options.clock.now();
      if (event.type !== 'partial') {
        this.lastUserSentenceAt = this.options.clock.now();
      }
      // 只是「嗯」一声、或者 ASR 把一个语气词当成中间结果 —— 这不算打断。
      // 误判的代价不对称：打断错的代价是丢掉一整条后台汇报，不打断只是晚几百毫秒安静。
      if (!isBackchannelOnly(event.text)) {
        this.interruptCanned();
      }
    }
    this.execute(effects);
    this.notifyState();
    return effects;
  }

  /** 状态真变了才回调（`dispatch` 每次都调，监听方不必自己去重）。 */
  private notifyState(): void {
    const next = this.core.fsm.state;
    if (next === this.lastDialogState) {
      return;
    }
    const previous = this.lastDialogState;
    this.lastDialogState = next;
    // 落进档案：「状态轮转对不对」只能从这条时间线看出来。`turn.start` / `tts.first`
    // 只说明快慢，说不出「这块音频是不是在 speaking 里发出去的」。
    //
    // `why` 不能省：`thinking → speaking` 既可能是首块音频，也可能是回执出声
    // （`DialogFsm.receiptStarted`），两者对延迟和打断的含义相反。
    this.options.onEvent?.(EVENTS.dialogState, {
      from: previous,
      to: next,
      why: this.core.fsm.lastTransitionReason,
    });
    this.options.env.onDialogState?.(next, previous);
  }

  /**
   * 掐断正在念的旁白，把**没念完的部分**记下来交给下一轮的模型。
   *
   * 不自动补播：系统不知道哥刚才问的是什么，硬补会在人家已经聊到别处时插一句
   * 无关的旧结论。模型手里有上下文，让它判断该不该接着说（见
   * `announceInterruptionNote`）—— 这和「一轮回答被打断」是同一套处理。
   */
  private interruptCanned(): void {
    this.runner.cancelCanned();
    this.options.cancelAnnounce?.();
    const residue = this.runner.takeCannedResidue();
    if (residue === null) {
      return;
    }
    this.announceTail = { text: residue.text, at: this.options.clock.now() };
    this.options.log(`  播报    被打断，剩 ${[...residue.text].length} 字没念完 → 交给下一轮`);
  }

  /**
   * 用户还在说话：稍后再看一次播报队列。
   *
   * 只排一个 —— `flushAnnounce` 会在每次入队、每轮结束时被反复调用，
   * 每次都排一个定时器的话，用户说半分钟就能攒下几十个待触发的回调。
   */
  private scheduleAnnounceRetry(ms: number): void {
    if (this.announceRetry !== null || this.disposed) {
      return;
    }
    this.announceRetry = this.options.clock.after(Math.max(1, ms), () => {
      this.announceRetry = null;
      void this.flushAnnounce();
    });
  }

  /** 轮次队列空，且播报不在开麦/出声。排队与推迟重试不算占着协程。 */
  get idle(): boolean {
    return this.queued === 0 && !this.announceBusy();
  }

  // ---------------------------------------------------------------- 效果

  /** 执行状态机给出的动作。**所有副作用只在这里发生。** */
  private execute(effects: readonly CoreEffect[]): void {
    const { env } = this.options;
    for (const effect of effects) {
      env.onEffect?.(effect);
      switch (effect.type) {
        case 'assemble':
          env.assemble(effect.text);
          break;
        case 'turn':
          void this.enqueueTurn(effect.text, effect.image, effect.ticket);
          break;
        case 'capture':
          this.enqueueCapture(effect.request, effect.ticket);
          break;
        case 'call':
          if (effect.call.op === 'capture.cancel') {
            this.runner.cancelCanned();
            this.options.cancelAnnounce?.();
            this.photos.cancel('用户改主意或收尾');
          } else {
            env.call(effect.call);
          }
          break;
        case 'end':
          env.end();
          break;
        case 'drop':
          break;
      }
    }
  }

  private enqueueTurn(
    text: string,
    image: ImageAttachment | undefined,
    ticket: TurnTicket,
  ): Promise<void> {
    this.queued += 1;
    this.serialChain = this.serialChain.then(async () => {
      if (this.disposed || this.core.fsm.state === 'closed') {
        this.options.log('  （丢弃：连接已关闭，不再开轮）');
        return;
      }
      if (this.core.fsm.isStale(ticket)) {
        this.options.log('  （丢弃：用户已插话，这一轮过时了）');
        return;
      }
      // 图由 `capture` 那一步拿好并挂在 text/image 里，这里不再自己拍
      this.options.env.onTurnStart?.(text, image !== undefined);
      // 续话（上一轮被打断的尾巴）和设备现状一起作为系统注记，模型才答得上
      // 「眼镜还剩多少电」「我刚才说到哪」这类只能靠上下文的问题。
      const note = composeTurnNote(this.options.env.deviceNote?.(), this.takeTailNote());
      try {
        const result = await this.runner.run(text, image, note);
        if (result !== null) {
          // 不只看 `interrupted`：真机 2026-11-23 第 11/13 轮，41–45 字的答案只合成出
          // 1.1–1.4 s 音频（TTS 那边把上一条被放弃的流的残留当成了自己的），
          // `interrupted=false` 却少念了大半段 —— 那一半也得交给下一轮。
          // 判定在 `rememberTail` 里，两者共用同一把尺。
          this.rememberTail(result);
        }
      } finally {
        this.options.env.onTurnEnd?.();
      }
    }).catch((error: Error) => {
      console.error(`  ✗ 队列任务失败（不影响后续）: ${error.message}`);
    }).finally(() => {
      this.queued -= 1;
    });
    return this.serialChain;
  }

  /** 取走「被打断的那两段」并拼成给模型的注记（一次性）。 */
  private takeTailNote(): string | undefined {
    const notes: string[] = [];
    const now = this.options.clock.now();

    const replyTail = this.tail;
    this.tail = null;
    if (replyTail !== null && now - replyTail.at <= TAIL_TTL_MS) {
      this.options.log(`  续话    上一轮被打断，剩 ${[...replyTail.text].length} 字没说完 → 交给这一轮`);
      notes.push(interruptionNote(replyTail.text));
    }

    const announceTail = this.announceTail;
    this.announceTail = null;
    if (announceTail !== null && now - announceTail.at <= TAIL_TTL_MS) {
      this.options.log(`  续话    后台汇报只念了一半，剩 ${[...announceTail.text].length} 字 → 交给这一轮判断`);
      notes.push(announceInterruptionNote(announceTail.text));
    }

    return notes.length === 0 ? undefined : notes.join('\n');
  }

  /**
   * 记下这一轮**没念出口**的部分。
   *
   * 两种来路都要记：被插话打断（`interrupted`），以及音频根本没覆盖全文
   * （TTS 只吐了一部分，`interrupted=false`）。第二种用「这段字该有多长」兜：
   * 真机那两轮是 41–45 字只出 1.1–1.4 s（应 ~8.5–9.4 s，占比 0.13–0.15），
   * 正常轮是 100 字 19.44 s（占比 0.93）—— 取 0.6 两边都够不着。
   */
  private rememberTail(result: TurnResult): void {
    const chars = [...result.speech].length;
    const expectedSeconds = chars / TTS_CHARS_PER_SEC;
    const shortAudio = result.audioSeconds > 0 && result.audioSeconds < expectedSeconds * 0.6;
    if (!result.interrupted && !shortAudio) {
      this.tail = null;
      return;
    }
    const rest = remainingSpeech(result.speech, result.playedSeconds);
    if (rest === '') {
      this.tail = null;
      return;
    }
    this.tail = { text: rest, at: this.options.clock.now() };
    this.options.log(`  续话    被打断，剩 ${[...rest].length} 字没说完`);
  }

  /**
   * 执行一次 `capture`，拿到结果再交给状态机。
   *
   * 走串行队列：等图的这几十秒里不能开别的一轮（用户改主意时会先下发
   * `capture.cancel` 让这里立刻返回，所以不会把后面的句子卡住）。
   */
  private enqueueCapture(request: CaptureRequest, ticket: TurnTicket): void {
    this.queued += 1;
    this.serialChain = this.serialChain.then(async () => {
      if (this.disposed || this.core.fsm.state === 'closed') {
        this.options.log('  （丢弃：连接已关闭，不再拍照）');
        return;
      }
      if (this.core.fsm.isStale(ticket)) {
        this.options.log('  （丢弃：拍照请求已过时）');
        return;
      }
      const outcome = await this.photos.request(request);
      this.options.env.forget?.(request.id);
      this.execute(this.core.dispatch(
        outcome.ok
          ? { type: 'shotResult', ok: true, jpeg: outcome.jpeg }
          : { type: 'shotResult', ok: false, failure: outcome.failure },
      ));
    }).catch((error: Error) => {
      console.error(`  ✗ 拍照任务失败（不影响后续）: ${error.message}`);
    }).finally(() => {
      this.queued -= 1;
    });
  }

  // ---------------------------------------------------------------- 播报

  /**
   * 后台任务完成 → 播报。
   *
   * 这条**不属于任何一轮**（`speakCanned` 的旁白通道），所以不占轮次票据、不改状态机。
   * 用户正在说话或正在播报时排队，等回到 `listening` 再放出来 —— 抢话比晚两秒更烦人。
   */
  enqueueAnnounce(speechOrItem: string | AnnounceItem, emotion?: string): void {
    const item: AnnounceItem = typeof speechOrItem === 'string'
      ? { speech: speechOrItem, ...(emotion === undefined ? {} : { emotion }) }
      : speechOrItem;
    this.announceQueue.push(item);
    if (this.announcePhase === 'empty' || this.announcePhase === 'deferred') {
      this.announcePhase = 'queued';
    }
    // 有货就要让宠物知道：它在「让位」闸门里等着这条。
    // 这一下只报「队列非空」，抢不抢话筒由会话层按对话相位决定。
    this.options.env.onAnnounce?.(true, false);
    void this.flushAnnounce();
  }

  /** 清空播报队列并停掉正在播的那条（敲击关播报）。 */
  clearAnnounce(): void {
    this.announceQueue.length = 0;
    this.runner.cancelCanned();
    this.options.cancelAnnounce?.();
    // 双击是明确的「别念了」：残句连"要不要补"都不该再问，直接作废
    this.runner.takeCannedResidue();
    this.announceTail = null;
    if (!this.announceBusy()) {
      this.announcePhase = 'empty';
    }
  }

  async flushAnnounce(): Promise<void> {
    if (this.disposed || this.announceBusy()) {
      return;
    }
    if (this.announceQueue.length === 0) {
      this.announcePhase = 'empty';
      return;
    }
    if (this.core.phase !== 'listening') {
      // 等本轮结束（`onTurnFinished` 会再叫一次）。
      // 不再补一次 `onAnnounce(true)`：前台已经 thinking/speaking 时，那会被听成抢话筒。
      if (this.announcePhase !== 'deferred') {
        this.announcePhase = 'queued';
      }
      return;
    }
    // 用户在说话时状态机也是 `listening`（要等一句话定稿才进 `thinking`），
    // 所以还得看他最近有没有出过声 —— 否则会在换气处插进来。
    const quietFor = this.options.clock.now() - this.lastUserSpeechAt;
    if (quietFor < ANNOUNCE_QUIET_MS) {
      if (this.announcePhase !== 'deferred') {
        this.announcePhase = 'queued';
      }
      this.scheduleAnnounceRetry(ANNOUNCE_QUIET_MS - quietFor);
      return;
    }
    // 队首可能已经被前台代播 / 已播报 / 已取消。**在通知宠物、开麦之前**清掉：
    // 否则会先 `onAnnounce(true,false)` 让宠物让位，再开麦、再发现没话说。
    while (
      this.announceQueue.length > 0
      && this.options.shouldSkipAnnounce?.(this.announceQueue[0]!) === true
    ) {
      this.announceQueue.shift();
    }
    if (this.announceQueue.length === 0) {
      this.announcePhase = 'empty';
      return;
    }
    const mic = this.options.env.announceMic;
    this.announcePhase = mic === undefined ? 'speaking' : 'opening_mic';
    // 真的出声过没有 —— `onAnnounce` 的第二个参数是「刚出过声」，跳过的那条不算
    let spokeAny = false;
    /** 这一条被排回队首（车道忙或开麦时用户说了一句），不是被丢掉。 */
    let yielded = false;
    // 播报占的是 `announce`，不是 `reply`：它是后台汇报，不是对话层的一轮。
    // 此刻相位仍是 `listening`，会话层才会据此申请话筒。
    this.options.env.onAnnounce?.(true, false);
    try {
      while (this.announceQueue.length > 0) {
        const item = this.announceQueue.shift();
        if (item === undefined) {
          break;
        }
        // 批内前后条各自独立：前一条开麦/出声期间，这一条可能刚被前台代播。
        if (this.options.shouldSkipAnnounce?.(item) === true) {
          continue;
        }
        // 情绪随这条播报走：闭包捕获，`speakAnnouncement` 的签名不用动。
        // `deferred` 由 `speak` 在 `'defer'` 时置位；两条开麦分支共用后面的结算。
        let deferred = false;
        const allowTts = this.options.allowTtsFallback !== false;
        const speak = async (text: string): Promise<void> => {
          this.announcePhase = 'speaking';
          if (this.options.speakAnnounce !== undefined && (!allowTts || item.verbatim !== true)) {
            const outcome = await this.options.speakAnnounce(item);
            if (outcome === 'spoken') {
              return;
            }
            if (outcome === 'defer') {
              deferred = true;
              return;
            }
            if (!allowTts) {
              this.options.log('  播报    live 路径禁用外部 TTS，仅展示文字不降级朗读');
              this.runner.emitAnnounceText(text, item.emotion);
              this.options.onFallbackAnnounceSpoken?.(item, true);
              return;
            }
            // 'fallback' → 仅非 live 路径落到下面走 runner.speakCanned
          }
          if (!allowTts) {
            this.options.log('  播报    live 路径禁用外部 TTS，跳过外部合成');
            this.runner.emitAnnounceText(text, item.emotion);
            this.options.onFallbackAnnounceSpoken?.(item, true);
            return;
          }
          await this.runner.speakCanned(text, item.emotion);
          const interrupted = this.core.phase !== 'listening'
            || this.options.clock.now() - this.lastUserSpeechAt < ANNOUNCE_QUIET_MS;
          this.options.onFallbackAnnounceSpoken?.(item, interrupted);
        };
        // 开麦这一段是异步的（最长 1.5 s），期间的整句记录用来判断要不要让路
        const mark = this.options.clock.now();
        let spoke = true;
        if (mic === undefined) {
          this.announcePhase = 'speaking';
          await speak(item.speech);
        } else {
          this.announcePhase = 'opening_mic';
          // 设备能开麦就先开：播报一开口就能被插话（ADR-0001 §6）。超时照播。
          const result = await speakAnnouncement(item.speech, {
            listenStart: mic.listenStart,
            micOpenTimeoutMs: mic.micOpenTimeoutMs,
            listenMs: mic.listenMs,
            call: mic.call,
            awaitMicOpen: mic.awaitMicOpen,
            // 开麦窗口里用户说了一整句就不念了。只看 `sentence`/`utterance`：
            // 一个语气词的 partial 不值得把汇报再推后一轮；同时重检未 dispose 且仍在 listening
            shouldSpeak: () => !this.disposed
              && this.core.fsm.state === 'listening'
              && this.lastUserSentenceAt <= mark,
            speak,
          });
          spoke = result.spoke;
        }
        if (deferred) {
          // 排回**队首**：前台正忙，这条只是被推迟。不要记成出过声，
          // `finally` 看到队列非空会自己排 `ANNOUNCE_QUIET_MS` 后再试。
          this.announceQueue.unshift(item);
          yielded = true;
          this.options.log('  播报    前台车道正忙 → 排回队首，等空窗重试');
          break;
        }
        if (mic !== undefined && !spoke) {
          // 排回**队首**：这条只是被推迟，不是被丢掉
          this.announceQueue.unshift(item);
          yielded = true;
          this.options.log('  播报    开麦期间用户说了一句 → 排回队首，等安静');
          break;
        }
        spokeAny = true;
        // 播报期间用户说话了：这条已经被 `cancelCanned` 掐断，剩下的留到下一轮结束
        if (
          this.core.phase !== 'listening'
          || this.options.clock.now() - this.lastUserSpeechAt < ANNOUNCE_QUIET_MS
        ) {
          break;
        }
      }
    } finally {
      if (mic !== undefined) {
        // 整批播完关麦（与 `pet/sim/world.ts` 同一个函数）
        closeAnnounceMic({ listenStart: mic.listenStart, call: mic.call });
      }
      this.finishAnnounce(spokeAny, yielded);
    }
  }

  /** 开麦或出声进行中。`queued` / `deferred` 只是在等，不占着这条协程。 */
  private announceBusy(): boolean {
    return this.announcePhase === 'opening_mic' || this.announcePhase === 'speaking';
  }

  /**
   * 这一轮播报协程的结算。`pending` 只反映队列里还有没有货。
   *
   * 前台已经是 `thinking` / `speaking` / `awaiting_shot`，或这一条主动让了路时，
   * 剩下的条目记成 `deferred`：那是在等空窗，不是再去占麦。会话层看到相位不是
   * `listening` 不会 `claim('announce')` —— 否则 finally 里一次 `pending: true`
   * 会把刚交给 `reply` 的话筒抢回来，一次 `pending: false` 则会把话筒放成 `null`。
   */
  private finishAnnounce(spokeAny: boolean, yielded: boolean): void {
    const pending = this.announceQueue.length > 0;
    const foreground = this.core.phase === 'thinking'
      || this.core.phase === 'speaking'
      || this.core.phase === 'awaiting_shot';
    if (!pending) {
      this.announcePhase = 'empty';
    } else if (yielded || foreground) {
      this.announcePhase = 'deferred';
    } else {
      this.announcePhase = 'queued';
    }
    // 队列里还有货（播报期间又来了新的，或被让路推迟了）得自己再排一次检查，
    // 否则那一条会一直躺着等下一轮。`onTurnFinished` 也会再叫一次。
    if (pending) {
      this.scheduleAnnounceRetry(ANNOUNCE_QUIET_MS);
    }
    // `spoken: true`：播报出声算「最近出过声」，由 minGap 推迟下一次搭话（ADR-0001 §6）
    this.options.env.onAnnounce?.(pending, spokeAny);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // **不要在这里 `attachPorts(null)`**：`VoiceConnection.onClose` 的顺序是
    // `app.dispose()`（含本方法）→ `dialog.dispatch({type:'closed'})`。摘了端口，
    // `closed` 就发不出 `invalidateTurn`，在途的上游轮次会一直跑到超时才收。
    // 端口属于「这条会话的内核」，随实例一起被丢弃，不需要显式解绑。
    this.unsubscribeState();
    this.announceQueue.length = 0;
    if (!this.announceBusy()) {
      this.announcePhase = 'empty';
    }
    this.announceRetry?.();
    this.announceRetry = null;
    this.runner.cancelCanned({ stopAudio: false });
    this.photos.dispose();
    // 回执钩子是**进程级 agent 上的一个槽**：只有「我还是当前那条连接」时才摘。
    // 旧连接的 `dispose()` 晚于新连接挂载是弱网重连的常态，无条件摘会把新连接
    // 那份回执一起掐掉（`setDelegateHook` 没有令牌参数，只能靠这条守卫）。
    if (this.options.isActiveOwner?.() ?? true) {
      this.options.agent.setDelegateHook?.(null);
    }
  }
}
