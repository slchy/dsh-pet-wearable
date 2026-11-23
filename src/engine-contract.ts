/**
 * 四层架构的**类型契约**：声学前端 → 控制内核 → 快车道引擎 → 慢车道与出话层。
 *
 * 这个文件里只有类型和纯函数，没有 IO、没有状态机、没有计时器。
 * 之所以单独成文：真机两场（`20261123-051448` / `-053719`）的事故全是
 * 「跨层缺少最小因果字段」——不是逻辑写错，是**信息在层间没有名字**，
 * 于是每一层各自猜一遍（猜静音、猜「用户听到了吗」、猜这一轮谁答的）。
 *
 * 五条硬契约（逐条都对应一次真机翻车）：
 *
 * 1. {@link AudioFrame}——声学前端只吐中性帧。`voiced` 与 `silenceMs` 升格成
 *    一等公民：`voiced` 曾经只传到一半（provider 包装把它吞了，静音过滤整场失效），
 *    `silenceMs` 曾经由三个模块各算一遍（20 / 100 / 150 / 200 ms 四个阈值）。
 * 2. {@link AsrSyncState}——ASR 与组装器共享的因果状态。「手上还有没有没解完的一段」
 *    曾经无处可查，于是判停拿半句话开了轮，后半句解回来成了「插话」，把自己掐死。
 * 3. {@link TurnInput} 的 `baseCommitSeq`——开轮瞬间已发出的最大 commit 序号。
 *    **旧段不可能变成插话**：那段音频是在我们出声之前录的。
 * 4. {@link TurnOutcome}——控制面与内容面拆权。`stale` 管 FSM 防越权，
 *    `truncated` 管记账与外部记忆回注；它们曾经是同一个 `interrupted`。
 * 5. {@link FastVoiceEngine}——Live 与级联只在这一个接口后面不同。
 *
 * **为什么 `baseCommitSeq` 不放进 `TurnTicket`**：票据由 `DialogFsm` 铸造，
 * 而 FSM 属于确定性内核、**不认识 ASR**（它只认状态与代次）。把 commit 序号塞进
 * 票据等于让状态机依赖转写层，下一次就会为了填这个字段在 FSM 里反向查 ASR。
 * 它属于「开轮时交给引擎的输入」，所以放在 {@link TurnInput} 上。
 */

/**
 * 声学前端的唯一输出。
 *
 * 消费方（ASR 暂存、omni 旁路、判停器、组装器）**都只读这一份**，
 * 谁都不许自己按能量重算 `voiced`、不许自己累计 `silenceMs`——
 * 两处门限一漂移，表现就是「有时候丢字、有时候灌静音」，而且从数据上分不出来。
 */
export interface AudioFrame {
  /** PCM16 s16le 单声道 16 kHz（已解码、已增益） */
  readonly pcm: Buffer;
  /** 门控后的人声态。贯穿 ASR 的暂存/挂断与 omni 旁路的 mute。 */
  readonly voiced: boolean;
  /** 距最近一帧 `voiced === true` 的累计静音（ms）。只有它决定「封段/判停到点」 */
  readonly silenceMs: number;
  /** 能量门的开关周期号：每次 `speech.open` +1，闭门期间不变 */
  readonly gateSeq: number;
  /** 采集时刻（**与宿主同一个时钟**，见 `SignalClock`） */
  readonly tsMs: number;
}

/**
 * ASR 与组装器共享的因果状态。
 *
 * 三个字段回答三个不同的问题，别再合成一个布尔：
 * - `commitSeq`：已经发出几发 commit（单调）。
 * - `awaitingDecode`：手上那段解完没有。**判停开轮前要看它**——否则拿半句话开轮。
 * - `hasVoicedSinceCommit`：这发 commit 之后有没有人真的说过话。
 *   `gate.close` 的 `hangup()` 靠它决定要不要补一发（纯静音补发=幻觉定稿）。
 */
export interface AsrSyncState {
  readonly commitSeq: number;
  readonly awaitingDecode: boolean;
  readonly hasVoicedSinceCommit: boolean;
}

/**
 * 开轮时交给引擎的输入。
 *
 * `baseCommitSeq` 是这套契约里**唯一**能彻底堵住「自己后半句杀自己」的字段：
 * 转写回来时比较「它的 commit 序号 ≤ baseCommitSeq」，就该判定为旧段，
 * 既不算插话、也不开轮。不用比时钟、不用比音量——那两个都只是代理量。
 */
export interface TurnInput {
  readonly text: string;
  /** 这一轮是第几轮（与 `turn.end` 的 `n` 同源） */
  readonly no: number;
  /** 开轮瞬间**已发出**的最大 ASR commit 序号 */
  readonly baseCommitSeq: number;
  /** 开轮时刻（宿主时钟） */
  readonly startedAtMs: number;
  /** 这一轮要不要带照片 */
  readonly hasImage: boolean;
}

/**
 * 一轮的**结果**，控制面与内容面分开。
 *
 * `stale`（票据被作废）与 `truncated`（用户少听了）是两件事：
 * - `stale` 决定老轮**还能不能动 FSM**。它绝不能改判成「没打断」——
 *   真机第 3 轮 19.44 s 音频正好播完、用户 26 ms 后才开口，
 *   按 `heard == audio` 判「没打断」的话老轮会越权去收尾。
 * - `truncated` 决定**记账**与**外部记忆回注**。用户听全了就该注。
 */
export interface TurnOutcome {
  /** `fsm.isStale(ticket)`：控制面 */
  readonly stale: boolean;
  /** 内容面：用户真的少听了 */
  readonly truncated: boolean;
  readonly heardMs: number;
  readonly totalAudioMs: number;
}

/**
 * 判「少听了」的容差（ms）。
 *
 * 不是 0：`heard_s` 是拿「首块下发时刻」往外推的，设备侧还有缓冲与回执抖动。
 * 实测（8 份档案 93 轮）用 300 能把「插话落在最后一个字之后」的那些轮次
 * 判成**听全了**（它们确实听全了），再小就会把它们算成少听，于是
 * 该回注的答案被吞掉——`20261123-053719` 第 2 轮就是这么丢的《其主之声》。
 */
export const TRUNCATED_EPSILON_MS = 300;

/**
 * 由「票据作废 + 首块时刻 + 音频总长」算出 {@link TurnOutcome}。
 *
 * 纯函数：同一份输入永远同一个结果，回放可以对账。
 *
 * ## 尺子：这里必须用**媒体时间**，不是墙钟
 *
 * 三把尺子各有各的活（见 `docs/QOS.md` 的"三种时间"）：
 *
 * | 尺子 | 回答什么 | 用在哪 |
 * |:--|:--|:--|
 * | 逻辑因果（`commitSeq`/`ticket`） | 谁发生在谁之前 | 能不能打断、这份回答该谁认领 |
 * | **媒体时间**（采样点数/字节数） | 声音在声学轴上落到哪 | `heardMs`、`truncated`、续话 |
 * | 墙钟（`clock.now`） | 等了多久 | 超时、轮询 |
 *
 * `heardMs` 曾经是「首块下发之后过了多久」（纯墙钟）。dsh 那种**边生成边念**的轮次上
 * 它会高估：音频 14 s、TTS 吐了 8 s 才吐完，用户 5 s 时插话 —— 墙钟说听了 5 s，
 * 可真正送到设备的媒体时长只有 2 s。高估 → 判成"听全了" → 该回注的答案被吞。
 *
 * 所以取两者的小值：声音播不了比实时更快（`elapsed` 是物理上限），也播不了还没送到的
 * 东西（`sentMediaMs`）。没给 `sentMediaMs` 时退化成旧口径，回放对账不会漂。
 */
export function outcomeOf(input: {
  readonly stale: boolean;
  /** 首块音频下发的时刻；`< 0` = 一个字都没发出去 */
  readonly firstAudioAtMs: number;
  /** 算 `heardMs` 用的「现在」 */
  readonly nowMs: number;
  readonly totalAudioMs: number;
  /**
   * 已经**下发到设备**的媒体时长（ms）：字节数 / 采样率。
   *
   * 不是墙钟——生成慢的轮次里它比 `nowMs - firstAudioAtMs` 小得多。
   */
  readonly sentMediaMs?: number;
}): TurnOutcome {
  const total = Math.max(0, input.totalAudioMs);
  const elapsed = input.firstAudioAtMs < 0
    ? 0
    : Math.max(0, input.nowMs - input.firstAudioAtMs);
  const heard = input.firstAudioAtMs < 0
    ? 0
    : Math.min(total, elapsed, input.sentMediaMs ?? Number.POSITIVE_INFINITY);
  return {
    stale: input.stale,
    truncated: total > 0 && heard + TRUNCATED_EPSILON_MS < total,
    heardMs: heard,
    totalAudioMs: total,
  };
}

/** 引擎吐给内核的事件流（两种引擎**完全同构**） */
export type EngineEvent =
  /** 引擎自己的正文音频。**回执不在这里**——回执是内核自己用 TTS 说的 */
  | { readonly type: 'audio'; readonly pcm: Buffer }
  /** 文本增量（记账 / 逐字对齐用） */
  | { readonly type: 'text'; readonly delta: string }
  /** 引擎自己决定转交 dsh（omni 的 `tool_call`） */
  | { readonly type: 'delegate'; readonly reason: string; readonly rewrittenQuery: string | null }
  | { readonly type: 'done'; readonly fullText: string };

/**
 * 快车道语音引擎。
 *
 * 两条实现：Live（omni 直出音频）与 Cascade（LLM → TTS）。
 * **内核不许知道自己是哪一种**——`分支=omni` / `分支=stream` 那两段代码
 * 就是这条被违反之后的产物。
 *
 * 铁律：`respond()` 是**唯一**会被内核 `await` 的方法。
 * 其余全部同步 `void`——订阅、放弃投机、回注都是「告诉引擎发生了什么」，
 * 引擎内部可以慢，内核绝不等。这条不靠注释守，靠签名守。
 */
export interface FastVoiceEngine {
  readonly mode: 'live' | 'cascade';

  /** 只报事实（连接活着、上下文还在），**不做路由决定**——那是内核的事 */
  isHealthy(): boolean;

  /** 内核广播的一帧上行音频（Live 侧据此自己决定 20 ms 就 seal） */
  onAudioFrame?(frame: AudioFrame): void;
  /** 中间结果：引擎可以据此提前起跑，但内核开轮/打断**不看**引擎订阅了没有 */
  onAsrPartial?(text: string, commitSeq: number): void;
  /** 定稿：同上 */
  onAsrFinal?(text: string, commitSeq: number): void;

  /** 唯一出话入口 */
  respond(turn: TurnInput, signal: AbortSignal): AsyncIterable<EngineEvent>;

  /** 放弃在途投机（交给 dsh / 被新轮顶掉 / 被插话） */
  abortSpeculation(reason: 'delegated' | 'superseded' | 'barge_in'): void;
}
