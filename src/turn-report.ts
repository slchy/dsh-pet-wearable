/**
 * 一轮的**结构化结算快照**（{@link TurnReport}）：只有类型与纯函数，零 I/O、零时钟。
 *
 * <h2>为什么要单独一份</h2>
 *
 * `turn.end` 是给延迟报告用的**扁平仪表**（`dsh_ms` / `tts_first_ms` / `audio_s` …），
 * 字段一多就没人敢动 —— 而「这一轮到底走没走委派」「为什么被作废」「少听没少听」
 * 这些**判定结果**一直只散在 console 日志里。本模块把一轮的结算事实收成一份
 * 结构化快照：`kernel.ts` 的账本存它（`ledger.lastReport`），档案里落成
 * `turn.report`（{@link turnReportToArchiveFields}）。
 *
 * 旧的 `turn.end` **一个字段都不动** —— 黄金测试与历史基线都盯着它。
 *
 * <h2>时钟口径（三种基准，别混）</h2>
 *
 * - **绝对时刻**（`startedAtMs` / `firstAudioAtMs` / `playedAtMs` / `endedAtMs`）
 *   是宿主 `clock.now()` 的**单调毫秒**（生产是进程启动后的单调时钟）。
 * - 档案里的 `t` 是 `Date.now() - archive.startedAt` 的**墙钟**相对值。
 *   两者**不是同一基准**：跨基准相减只会得到几十年的垃圾，严禁。
 * - 跨事件对齐靠**逻辑因果键**（`ticket.no` / `ticket.gen` / `baseCommitSeq`），
 *   不靠时刻 —— 见 `src/causal.ts` 的「判据放哪儿：三种时间 + 一个家」。
 *
 * 两个容易搞错的时刻，口径写死在这里：
 *
 * - `firstAudioAtMs` = **服务端首块下行音频下发时刻**（`audioSent` 的第一块），
 *   不是设备真播回执；
 * - `playedAtMs` = `device.played` 的**整段播完回执**时刻；设备不支持或没回执时为
 *   `null`。
 *
 * **所有缺失值一律 `null`，绝不拿 `0` / `-1` 冒充** —— 否则「没量到」会被读成
 * 「很快」或「负延迟」，历史基线被静默伪造。
 */
import type { SettlementInject } from './engine-contract.ts';
import type { DelegateReason } from './providers.ts';
import type { Lane } from './turn-router.ts';

/** 这一轮的结局。优先级见 {@link resolveTurnStatus} */
export type TurnStatus = 'completed' | 'interrupted' | 'closed' | 'failed';

/**
 * 被打断的原因：
 * - `bargeIn`：用户插话（内核 `invalidateTurn` 的 `bargeIn`）
 * - `closed`：连接结束（吸收态 `closed`）
 * - `superseded`：被新轮顶掉（`thinking → thinking` 的吸收窗口）
 */
export type TurnInterruptReason = 'bargeIn' | 'closed' | 'superseded';

/** 这一轮由哪条路径答的（引擎 `meta.path` 的三个取值） */
export type TurnPath = 'fast' | 'dsh' | 'omni';

/**
 * 一轮的结算快照。**全 `readonly`**：它是账本里的历史事实，写出之后不许再改。
 *
 * 字段分四组：身份与因果 / 判定结果 / 媒体量 / 时刻与耗时。
 */
export interface TurnReport {
  /** 票据：轮次号 + 代次（唯一的跨异步因果坐标） */
  readonly ticket: { readonly no: number; readonly gen: number };
  /** 开轮瞬间已发出的最大 ASR commit 序号；装配层没注入上下文时为 `null` */
  readonly baseCommitSeq: number | null;
  readonly status: TurnStatus;
  readonly path: TurnPath | null;
  /** 内核账本里的车道名（`omni` 折成 `live`，见 `TurnRunner.noteLane`） */
  readonly lane: Lane | null;
  readonly delegated: boolean;
  readonly delegateReason: DelegateReason | null;
  /** 引擎已在后台派单、本轮播完垫话即收尾（`meta.nonBlocking`） */
  readonly nonBlockingDelegate: boolean;
  readonly interrupted: boolean;
  readonly interruptReason: TurnInterruptReason | null;
  /** 作废那一刻相位转移的原因（`dialog.state.why`），排障用 */
  readonly interruptWhy: string | null;
  /** 失败轮的异常消息；正常收尾为 `null` */
  readonly error: string | null;
  /** 票据被顶掉 / 被作废（内核 `outcome.stale`，控制面） */
  readonly stale: boolean;
  /** 用户少听了一段（内核 `outcome.truncated`，内容面） */
  readonly truncated: boolean;
  /** 用户听全了 → 外部记忆该知道这一轮（内核结算给出） */
  readonly reflect: boolean;
  /** 回注口气（内核结算给出，`turn-runner` 不再自己判） */
  readonly inject: SettlementInject;
  /** 用户实际听到的时长（媒体时间，ms） */
  readonly heardMs: number;
  /** 这一轮下发的媒体总时长（ms） */
  readonly totalAudioMs: number;
  /** 下发的 PCM 字节数 */
  readonly audioBytes: number;
  /** 实际播出的字数（与 `turn.end.said_chars` 同源：一个字节都没发时为 0） */
  readonly saidChars: number;
  /** 开轮时刻（宿主单调时钟 ms）；与档案 `t` 不是同一基准 */
  readonly startedAtMs: number;
  /** 首块下行音频下发时刻（不是设备回执）；没出声为 `null` */
  readonly firstAudioAtMs: number | null;
  /** 设备 `played` 整段播完回执时刻；不支持 / 没回执为 `null` */
  readonly playedAtMs: number | null;
  /** 本轮结算时刻（宿主单调时钟 ms） */
  readonly endedAtMs: number;
  /** agent 自报耗时（ms）；失败发生在拿到任何事件之前为 `null` */
  readonly agentMs: number | null;
  /**
   * 模型首 token 延迟（ms）。只对**文本 LLM 路径**（`fast` / `dsh`，含 Live
   * `fallbackDsh`）有意义；Omni 直出为 `null` —— 它没有「首 token」这个相位。
   */
  readonly llmFirstMs: number | null;
  /** 首个非空文本增量相对开轮的时刻（ms）；Omni 与级联都可采，无文本为 `null` */
  readonly firstTextMs: number | null;
  /** 首段送合成 → 首块音频下发（ms，**引擎同源时钟**算好）。Omni 直出 / 无首块为 `null` */
  readonly ttsFirstMs: number | null;
  /** `firstAudioAtMs - startedAtMs`（ms）；没出声为 `null` */
  readonly turnToAudioMs: number | null;
  /** dsh 会话 id（与 `turn.end.dsh_session` 同源）；没有为 `null` */
  readonly dshSession: string | null;
}

/** {@link buildTurnReport} 的输入：除 `inject` 外都可缺省，缺省即 `null` */
export interface BuildTurnReportInput {
  readonly ticket: { readonly no: number; readonly gen: number };
  readonly baseCommitSeq?: number | null;
  readonly status: TurnStatus;
  readonly path?: TurnPath | null;
  readonly lane?: Lane | null;
  readonly delegated?: boolean;
  readonly delegateReason?: DelegateReason | null;
  readonly nonBlockingDelegate?: boolean;
  readonly interrupted?: boolean;
  readonly interruptReason?: TurnInterruptReason | null;
  readonly interruptWhy?: string | null;
  readonly error?: string | null;
  readonly stale?: boolean;
  readonly truncated?: boolean;
  readonly reflect?: boolean;
  readonly inject: SettlementInject;
  readonly heardMs?: number | null;
  readonly totalAudioMs?: number | null;
  readonly audioBytes?: number | null;
  readonly saidChars?: number | null;
  readonly startedAtMs: number;
  readonly firstAudioAtMs?: number | null;
  readonly playedAtMs?: number | null;
  readonly endedAtMs: number;
  readonly agentMs?: number | null;
  readonly llmFirstMs?: number | null;
  readonly firstTextMs?: number | null;
  readonly ttsFirstMs?: number | null;
  readonly dshSession?: string | null;
}

/**
 * 结局的唯一优先级：**失败 > 关闭 > 打断 > 完成**。
 *
 * 顺序不是随手排的：一轮在 `catch` 里收尾时也可能已经被插话（`closed` 还叠在上面），
 * 这时最该说的事实是「它失败了」；连接已经进了吸收态则比「被打断」更根本。
 * 反过来的话，报告会把失败轮统统记成 completed。
 */
export function resolveTurnStatus(input: {
  readonly failed: boolean;
  readonly closed: boolean;
  readonly interrupted: boolean;
}): TurnStatus {
  if (input.failed) {
    return 'failed';
  }
  if (input.closed) {
    return 'closed';
  }
  if (input.interrupted) {
    return 'interrupted';
  }
  return 'completed';
}

/** 非负有限数；否则 `null`（**不拿 0 冒充缺失**） */
function durationOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/** 绝对时刻：有限性保护。宿主时钟理论上不会给出 NaN，给了就是装配坏了 */
function absoluteMs(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 非空字符串；空串当缺失 */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * 组一份 {@link TurnReport}。所有时长做**有限性 + 非负**保护：
 * 负数 / `NaN` / `Infinity` 一律收成 `null`。
 *
 * `turnToAudioMs` 由 `firstAudioAtMs - startedAtMs` 现算：跨时钟（或时钟抖动）
 * 得到负值时同样记 `null`，绝不伪造 0。
 */
export function buildTurnReport(input: BuildTurnReportInput): TurnReport {
  const startedAtMs = absoluteMs(input.startedAtMs);
  const firstAudioAtMs = durationOrNull(input.firstAudioAtMs);
  const playedAtMs = durationOrNull(input.playedAtMs);
  const turnToAudio = firstAudioAtMs === null ? null : firstAudioAtMs - startedAtMs;
  return {
    ticket: { no: input.ticket.no, gen: input.ticket.gen },
    baseCommitSeq: durationOrNull(input.baseCommitSeq),
    status: input.status,
    path: input.path ?? null,
    lane: input.lane ?? null,
    delegated: input.delegated === true,
    delegateReason: input.delegateReason ?? null,
    nonBlockingDelegate: input.nonBlockingDelegate === true,
    interrupted: input.interrupted === true,
    interruptReason: input.interruptReason ?? null,
    interruptWhy: textOrNull(input.interruptWhy),
    error: textOrNull(input.error),
    stale: input.stale === true,
    truncated: input.truncated === true,
    reflect: input.reflect === true,
    inject: input.inject,
    heardMs: durationOrNull(input.heardMs) ?? 0,
    totalAudioMs: durationOrNull(input.totalAudioMs) ?? 0,
    audioBytes: durationOrNull(input.audioBytes) ?? 0,
    saidChars: durationOrNull(input.saidChars) ?? 0,
    startedAtMs,
    firstAudioAtMs,
    playedAtMs,
    endedAtMs: absoluteMs(input.endedAtMs),
    agentMs: durationOrNull(input.agentMs),
    llmFirstMs: durationOrNull(input.llmFirstMs),
    firstTextMs: durationOrNull(input.firstTextMs),
    ttsFirstMs: durationOrNull(input.ttsFirstMs),
    turnToAudioMs: turnToAudio === null || turnToAudio < 0 ? null : turnToAudio,
    dshSession: textOrNull(input.dshSession),
  };
}

/**
 * 展开成档案用的扁平 snake_case JSON（写进 `turn.report`）。
 *
 * 显式保留 `null` 而不是省略键：省略之后读档案的人分不出「这个字段这一版还没有」
 * 和「这一轮确实没量到」。也绝不写 `-1` 冒充缺失。
 *
 * `played_ms` 是**派生量**（`playedAtMs - firstAudioAtMs`）：设备回执那条事件本身
 * 只带绝对时刻，而报告想看的是「首块 → 播完」这段播放时长。
 */
export function turnReportToArchiveFields(report: TurnReport): Record<string, unknown> {
  const playedMs = report.playedAtMs !== null && report.firstAudioAtMs !== null
    ? Math.max(0, Math.round(report.playedAtMs - report.firstAudioAtMs))
    : null;
  return {
    turn: report.ticket.no,
    gen: report.ticket.gen,
    base_commit_seq: report.baseCommitSeq,
    status: report.status,
    path: report.path,
    lane: report.lane,
    delegated: report.delegated,
    delegate_reason: report.delegateReason,
    non_blocking_delegate: report.nonBlockingDelegate,
    interrupted: report.interrupted,
    interrupt_reason: report.interruptReason,
    interrupt_why: report.interruptWhy,
    error: report.error,
    stale: report.stale,
    truncated: report.truncated,
    reflect: report.reflect,
    inject: report.inject,
    heard_ms: report.heardMs,
    total_audio_ms: report.totalAudioMs,
    audio_bytes: report.audioBytes,
    said_chars: report.saidChars,
    agent_ms: report.agentMs,
    llm_first_ms: report.llmFirstMs,
    first_text_ms: report.firstTextMs,
    tts_first_ms: report.ttsFirstMs,
    turn_to_audio_ms: report.turnToAudioMs,
    played_ms: playedMs,
    dsh_session: report.dshSession,
  };
}
