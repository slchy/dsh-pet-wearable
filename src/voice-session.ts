/**
 * 一条连接的**编排**：把几个各管一段的模块接起来，本身不含任何判定逻辑。
 *
 * ```text
 * TCP ──transport──┬─ Audio ──▶ UplinkPipeline（ffmpeg + 能量门）──▶ SttSession
 *                  ├─ Image ──▶ PhotoInbox ──┬─ 有人在等：交图
 *                  │                         └─ 没人等：SessionCore 起一轮识图
 *                  └─ Wake  ──▶ 诊断日志
 *
 * 工具控制口 ──▶ PhotoInbox.request() / SessionCore.endRequested
 * 一轮定稿 ──▶ SessionCore ──effects──▶ TurnRunner ──▶ connection.sendAudio/sendControl
 * ```
 *
 * 每一格都能单独测：判定在 `session-core.ts`（纯决策），解码与判停在
 * `uplink-pipeline.ts`，协议在 `transport.ts`，这里只剩接线。
 */
import type { TurnTicket } from './dialog-fsm.ts';
import { SessionArchive } from './archive.ts';
import { pcm16PeakDbfs } from './pcm.ts';
import { voicingVerdict } from './barge-voicing.ts';
import type { AnnounceStore } from './announce-store.ts';
import { EVENTS } from './events.ts';

import {
  captureMode,
  describeCapabilities,
  encodeV2Call,
  parseV2CaptureImage,
  parseV2Event,
  resolveDeviceLink,
  supportsCall,
  V2_WELCOME,
  type CaptureIntent,
  type DeviceCall,
  type DeviceCapabilities,
  type DeviceEvent,
  type DeviceLink,
  type V1Session,
} from './devices/index.ts';
import { AppSession } from './app/session.ts';
import { DialogRuntime, type AnnounceItem } from './app/dialog.ts';
import { SystemClock, type Clock } from './app/clock.ts';
import type { FastVoiceEngine } from './engine-contract.ts';
import type { VoicePipelineMode } from './pipeline-mode.ts';
import { DEFAULT_PET_PARAMS, type PetParams } from './pet/brain/registry.ts';
import { summarizePetEvent } from './pet/brain/session.ts';
import type { PetReply } from './pet/brain/types.ts';
import { petPrompt } from './pet/proactive.ts';
import { UpstreamFrameType } from './frame.ts';
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  PhotoInbox,
  type CaptureRequest,
  type PhotoOutcome,
} from './photo-inbox.ts';
import type {
  AgentAudioAnswer,
  AgentProvider,
  BackgroundTaskReport,
  SttProvider,
  SttSession,
  TtsProvider,
} from './providers.ts';
import type { SessionCore } from './session-core.ts';
import type { ImageAttachment } from './session.ts';
import { TurnJudge } from './turn-judge.ts';
import type { RealtimeSocketFactory } from './qwen-realtime-asr.ts';
import { OmniShadow } from './omni-shadow.ts';
import { startToolControl, type ToolControl, type ToolControlHandlers } from './tool-control.ts';
import { runTransport, type Connection, type HelloInfo } from './transport.ts';
import { TurnRunner } from './turn-runner.ts';
import { UplinkPipeline } from './uplink-pipeline.ts';
import { UtteranceAssembler } from './utterance-assembler.ts';
import type { SemanticEndpoint } from './semantic-endpoint.ts';

/** 上行采样率：mSBC 解码后固定 16 kHz */
export const UPSTREAM_SAMPLE_RATE = 16_000;

/**
 * 判停器的最小接口（`TurnJudge` 满足它）。
 *
 * 抽成接口只为一件事：**共享与独占的判定要能单测**，不必起 python 侧车。
 */
export interface EndpointDetector {
  predict(pcm: Buffer): Promise<number>;
  stop(): void;
}

/**
 * 决定这条连接用哪个判停器、以及要不要在断开时销毁它。
 *
 * 共享的那份由进程持有（`main.ts` 创建并预热），**连接断开时不能 stop**：
 * 侧车冷启动要重新加载 8.7 MB ONNX（实测 ~300 ms），真机每次重连第一句都要付。
 * 自己创建的那份（单连接命令行 / 测试）必须 stop，否则进程退不掉。
 */
export function resolveEndpointDetector(
  options: { readonly turnJudge?: object; readonly turnJudgeClient?: EndpointDetector },
  create: () => EndpointDetector,
  log: (line: string) => void,
): { readonly client: EndpointDetector | null; readonly owned: boolean } {
  if (options.turnJudgeClient !== undefined) {
    if (options.turnJudge === undefined) {
      log('  判停    ⚠ 给了共享判停器但没有参数表（quietMs 等），会按 0 处理');
    }
    return { client: options.turnJudgeClient, owned: false };
  }
  if (options.turnJudge === undefined) {
    return { client: null, owned: false };
  }
  return { client: create(), owned: true };
}

/**
 * 没有判停器（TurnJudge 关掉）时的固定合并窗口。
 *
 * 旧行为：收到一句 ASR 就再等 600 ms 看有没有下文，没有就定稿。
 */
const ASSEMBLER_FALLBACK_WINDOW_MS = 600;

/**
 * 判停请求提前多久发起（与静候窗 `TURN_JUDGE_QUIET_MS` 重叠）。
 *
 * `asrToTurn` 实测中位 224 ms = 静候窗 150 + 判停器往返约 70 + 派发几毫秒。
 * 提前 65 ms 把请求发出去，那趟往返就藏进静默窗里，中位降到约 150 ms；
 * 而判停器看到的句尾静音只从约 550 ms 缩到约 465 ms —— 静音是它判断
 * 「说完了」的主要证据，砍太多会把「没说完」的比例抬上去，长尾反而更烂。
 *
 * 判停器慢过 85 ms 时只会退化成旧行为，不会更慢：`evaluate` 到点是**等**
 * 那份已经出发的请求，不会重发。
 */
const ASSEMBLER_PREDICT_LEAD_MS = 65;

/**
 * 连接就绪时那次 `listen.start` 的时长。
 *
 * 它只是**把设备从待机叫回来**（`EXPERIMENTS §42`：0.62 s 内开始推流），
 * 之后由设备自己的会话管理接管。60 s 足够覆盖「连上了、想一下、再开口」，
 * 又不会在用户摘下眼镜后长时间占着麦克风。
 */
const INITIAL_LISTEN_MS = 60_000;

/**
 * 连接就绪后等多久看「设备有没有在推流」。
 *
 * `EXPERIMENTS §42` 实测：手机发 `WakeUpEvent` 后 0.62 s 内就来流。所以 1.5 s
 * 足够判断"设备本来就在采集"还是"需要拉一把"。
 *
 * 太短会在设备慢启动时误判成需要唤醒（多一次无谓的 requestWakeUp），
 * 太长则首次连接要多等这么久才开麦。
 */
const CAPTURE_GRACE_MS = 1_500;

/**
 * 连接就绪时该不该主动唤醒设备（发 `listen.start`）。
 *
 * 三条判据，从「最本质」到「最保守」：
 *
 * 1. **设备正在推流** → 不用唤醒（重连场景多半是这样）
 * 2. **明确未佩戴**（`wearing === false`）→ 不唤醒。设备不戴就不可能开麦，
 *    发出去只是白占 {@link INITIAL_LISTEN_MS} 的麦克风。真机 2026-11-22 19:19:43：
 *    未佩戴 + `listen.start{maxMs:60000}`，整段零音频帧、零 `OpenDevice`、
 *    模型一句话没说 —— 用户看到的就是「莫名其妙被拉起，却没人说话」。
 * 3. `wearing === null`（设备不报 / 还没报）→ **放行**。
 *    这里与 ADR-0001 的 `worn` 闸门方向**相反**：那边保守是「不主动开口」，
 *    这边保守必须是「开」—— 漏开的代价（用户长按没反应）比多开一次大。
 *
 * @param hasAudio 宽限期内是否收到过上行音频
 * @param wearing 设备上报的佩戴状态；`null` = 不知道
 */
export function shouldWakeOnReady(input: {
  readonly hasAudio: boolean;
  readonly wearing: boolean | null;
  readonly closed: boolean;
  readonly micPending: boolean;
}): boolean {
  if (input.closed || input.micPending || input.hasAudio) {
    return false;
  }
  return input.wearing !== false;
}

/**
 * 一条连接上的开麦相位。
 *
 * 以前是散落的 `micPending` 布尔：`listen.start` 还没发出去就先置位，
 * 发送失败就永远停在「正在开」，`onClose` 也不叫醒等麦的人。
 * 现在只许经 {@link VoiceConnection} 的 `enterMic` 迁移。
 *
 * - `idle` 还没开始等设备推流
 * - `watching` 宽限期内看设备是不是已经在采集
 * - `opening` `listen.start` **已经发出去**，在等首帧上行
 * - `open` 看到了有效上行音频
 * - `closed` 吸收态：连接收尾，不再出来
 */
export type MicPhase = 'idle' | 'watching' | 'opening' | 'open' | 'closed';

function canEnterMic(from: MicPhase, to: MicPhase): boolean {
  if (from === to) {
    return true;
  }
  if (to === 'closed') {
    return true;
  }
  switch (from) {
    case 'idle':
      return to === 'watching' || to === 'opening';
    case 'watching':
      return to === 'opening' || to === 'open';
    case 'opening':
      return to === 'open' || to === 'idle';
    case 'open':
      return to === 'opening';
    case 'closed':
      return false;
    default:
      return false;
  }
}

/**
 * 能量门上的静音提前量 → 装配器选项。
 *
 * `0` 是「关掉这一路」，必须原样传下去。缺字段（`undefined`）才表示没配置，
 * 由 `SilenceTriggers` 用默认 200 / 100。以前 `<= 0` 把 `0` 删掉，
 * 关闭开关静默失效，变回默认值。
 */
export function assemblerSilenceFromGate(gate: {
  readonly pauseDetectMs?: number;
  readonly speculateMs?: number;
}): { readonly silencePauseMs?: number; readonly speculateMs?: number } {
  return {
    ...(gate.pauseDetectMs !== undefined ? { silencePauseMs: gate.pauseDetectMs } : {}),
    ...(gate.speculateMs !== undefined ? { speculateMs: gate.speculateMs } : {}),
  };
}

/**
 * 电量帧合并。
 *
 * 只在字段**真有值**时更新。`undefined` 是没带这个字段；线上 `parseV2Event`
 * 还会把缺字段收成 `null`。两种空都不能盖掉上一次已经记下的电量 / 充电。
 */
export function mergePowerReading(
  current: { readonly percent: number | null; readonly charging: boolean | null },
  event: { readonly percent?: number | null; readonly charging?: boolean | null },
): { readonly percent: number | null; readonly charging: boolean | null } {
  return {
    percent: event.percent !== undefined && event.percent !== null ? event.percent : current.percent,
    charging: event.charging !== undefined && event.charging !== null ? event.charging : current.charging,
  };
}

/**
 * 送给判停器的「最近音频」上限（秒）。
 *
 * 判停器要听到整句话的尾巴才能判「说完了」，8 s 足够覆盖常见的一句话，
 * 又不至于把整段对话都留在内存里。
 */
const ASSEMBLER_RECENT_SECONDS = 8;

/**
 * 送给判停器的快照，尾部最多留多少毫秒静音。
 *
 * 官方约定是「音频顶到输入向量的末尾、零补在开头」。尾巴留静音等于把语音从窗口
 * 末尾推开，p 会被拉低（同一句留 0 ms 时 0.95、留 800 ms 时 0.04）。留多少在
 * **噪声里**：两场真机 21 轮的离线扫描 0–20 ms 略好于 100 ms（18/21 vs 15/21），
 * 但真机回放复现不出来 —— 所以取小值只是方向正确，不是可测量的收益。
 */
const ASSEMBLER_TRAILING_TRIM_MS = 20;

export interface VoiceSessionOptions {
  /** 监听端口 */
  readonly port: number;
  /**
   * v1 手机的型号提示（见 `src/devices/`）。
   *
   * v1 手机不在 `Hello` 里自报能力，这个入参给它补默认能力；空串 / 未知型号 = v1 基线。
   * 判定核只读能力，不认型号字符串。
   */
  readonly device?: string;
  /**
   * 监听地址。缺省 `127.0.0.1` —— 本地开发默认不暴露；
   * 上公网时由部署方显式给 `0.0.0.0`（或具体网卡地址）。
   */
  readonly host?: string;
  readonly ffmpegPath: string;
  /** Agent（LLM）。注入而不是 import 具体实现 —— 换模型不用动编排层。 */
  readonly agent: AgentProvider;
  /** STT。每次连接由 provider 开一个新会话；换厂商同理。 */
  readonly stt: SttProvider;
  /** TTS。采样率由 provider 自己声明，这里不再单独配。 */
  readonly tts: TtsProvider;
  /** TurnJudge 判停器；缺任一项则不启用，退回固定合并窗口 */
  readonly turnJudge?: {
    readonly pythonPath: string;
    readonly scriptPath: string;
    readonly quietMs: number;
    readonly extendMs: number;
    readonly maxExtensions: number;
    /** 「判停说没说完」单独的上限，见 `UtteranceAssemblerOptions.maxUnsureExtensions` */
    readonly maxUnsureExtensions?: number;
    /** 文本含汉字时用的阈值，见 `UtteranceAssemblerOptions.thresholdCjk` */
    readonly thresholdCjk?: number;
    /** 快照尾部最多留多少静音（ms），见 `UtteranceAssemblerOptions.trailingTrimMs` */
    readonly trailingTrimMs?: number;
    readonly threshold: number;
    /** QoS：`②` 的总等待预算（ms），见 `UtteranceAssemblerOptions.waitBudgetMs` */
    readonly waitBudgetMs?: number;
    /** QoS：序列形态的豁免预算（ms），见 `UtteranceAssemblerOptions.waitBudgetSequenceMs` */
    readonly waitBudgetSequenceMs?: number;
    /** **统一上限**：开轮静音不得超过这个值，见 `UtteranceAssemblerOptions.maxOpenSilenceMs` */
    readonly maxOpenSilenceMs?: number;
  };
  /**
   * 进程级共享的判停器客户端。
   *
   * 给了就用它，并且**不随连接销毁** —— 侧车是 python + 8.7 MB ONNX，冷启动实测
   * ~300 ms，而真机每次重连（网络抖动 / 服务重启 / 重开 App）第一句都要付这一刀。
   * 常驻之后只有进程启动付一次。
   *
   * 与 {@link turnJudge} 一起给（后者提供静默窗等参数）；只给这个不给参数表是
   * 配置错误，会退化成 `quietMs: 0`。
   */
  readonly turnJudgeClient?: EndpointDetector;
  /**
   * 语义判停（END 标签）：只在「即将开轮」那一刻问「用户这句话说完了没有」。
   *
   * 声学判停（`turnJudge`）看音频、判不了语义；不给就是老行为。
   * 实现见 `semantic-endpoint.ts`，只回 `END`/`MORE`。
   */
  readonly semantic?: SemanticEndpoint;
  /** 等语义判停回话的上限（ms）。等不到按「说完了」走。默认 300 */
  readonly semanticBudgetMs?: number;
  /**
   * omni 影子旁路：只观测，**不发声**。
   *
   * 给 `apiKey` 就开，不给就完全不建连。它量的是「把封段→首块交给 omni
   * 一体模型能快多少」，用来判要不要让它接管快车道 —— 判据见 `EVENTS.omniShadow`。
   *
   * **硬前提：STT 必须是 `qwen-realtime`。** 只有「端点由我们控」的 provider 才有
   * `onCommit`（NLS 的 `commitMs` 是 0），而封段正是影子的起跑线；没有它，
   * 影子一条数据都出不来（会静默地什么都不发生，所以 `main.ts` 启动时就拦）。
   */
  readonly omniShadow?: {
    readonly apiKey: string;
    readonly model?: string;
    /** 认领模式：`off`（只量）/ `full`（真答）。缺省 `off` */
    readonly serve?: 'off' | 'full';
    /** 测试注入 realtime 套接字；生产不传，行为与以前一致 */
    readonly socketFactory?: RealtimeSocketFactory;
    /**
     * 长期记忆摘要。字符串原样用；函数在**这条连接**构造影子时调用一次，
     * 取当时的 MEMORY.md。空白不传。
     */
    readonly memoryContext?: string | (() => string);
    /** 当前日期。原样交给影子，由它在 `session.update` 时调用一次。 */
    readonly clockContext?: () => string;
    /** ASR 热词。空白不传。 */
    readonly asrCorpusText?: string;
    /** ASR 语言。空白不传。 */
    readonly asrLanguage?: string;
  };
  /** 显式管道模式（'live' | 'cascade'）。未设时兼容旧推断。 */
  readonly pipelineMode?: VoicePipelineMode;
  /**
   * 生产热路径语音引擎（`LiveOrchestrator.toEngine()` 或 `CascadeAgent.toEngine(...)`）。
   * 传入后 `TurnRunner` 走统一单泵；缺省时由 `TurnRunner` 自动用 `AgentEngineAdapter` 兼容包装。
   */
  readonly engine?: FastVoiceEngine;
  /**
   * Pure Live 模式下把后台汇报交给 Omni 同嗓子播报（委托给 `TurnRunner.speakAudioAnswer`）。
   */
  readonly speakAnnounce?: (
    item: AnnounceItem,
    playAudio: (answer: AgentAudioAnswer) => Promise<{
      readonly spokenBytes: number;
      readonly interrupted: boolean;
      readonly transcript: string;
    }>,
  ) => Promise<'spoken' | 'defer' | 'fallback'>;
  /** 插话/双击时同步掐断正在播的 Omni 后台汇报 */
  readonly cancelAnnounce?: () => void;
  /** 当某条后台汇报退回 TTS 播完后通知上层（用于静默回注 Omni 上下文） */
  readonly onFallbackAnnounceSpoken?: (item: AnnounceItem, interrupted: boolean) => void;
  /** 上行增益（喂给 STT 前放大；眼镜 mic 电平偏低） */
  readonly micGain?: number;
  /** 电平表周期（毫秒）；> 0 时每这么久打一行上行峰值，调增益用 */
  readonly levelLogMs?: number;
  /** 能量门 */
  readonly gate: {
    readonly thresholdDbfs: number;
    readonly holdMs: number;
    readonly prerollMs: number;
    /**
     * 静音持续多久算「这段话说完了」——**只用来提前跑判停**，不关门、不断路。
     *
     * 默认 200 ms：和 ASR 的 `max_sentence_silence` 对齐，这样它开始数静音的时候
     * 我们也在数，`SentenceEnd` 到时判停概率已经算好了。设 0 关闭预判停。
     */
    readonly pauseDetectMs?: number;
    /**
     * 静音持续多久就**先投机一次**（默认 100 ms，比 {@link pauseDetectMs} 早）。
     *
     * 投机只是拿中间结果先猜，问早了作废、问晚了白等，所以不必等判停那 200 ms。
     * 提前这 100 ms 本身不省端到端，它的用途是把「首字 → 认领」的窗口撑到能盖住
     * TTS 首块（330–375 ms），见 `UtteranceAssemblerOptions.speculateMs`。设 0 关闭。
     */
    readonly speculateMs?: number;
    /**
     * 静音多久就让 ASR **封段**（端点由我们控的 provider 才需要，见 `SttSession.commit`）。
     *
     * 服务端 VAD 的静音窗 200 ms 是硬下限（NLS 与 DashScope 一样），关掉它之后
     * 这个值就是新的窗。切早了会把字切成两半，所以别一次压到底；`0` = 不封段
     * （服务端自己判句的 provider 必须留 0）。
     */
    readonly commitMs?: number;
    /**
     * 静音多久才让 **ASR** 封段解码（默认 = {@link commitMs}，即不拆）。
     *
     * `commitMs` 同时点着两个动作：omni 车道起跑（`OmniShadow.seal`）和 ASR 封段。
     * 前者越早越好（20 ms），后者切早了会把一句话切成两半 —— 真机
     * `20261123-053719` 两轮都断在书名中间，第二个碎片被解成了德语。
     * 判停本来要等 200–300 ms 静音，所以 ASR 晚到 150 ms **不花延迟**。
     */
    readonly sttCommitMs?: number;
    /**
     * 开轮的静音门槛（ms）：定稿到达时「截至此刻」的连续静音不够就再等。
     *
     * 只对「端点由我们控」的 provider 有意义 —— 提交得早，定稿会在用户可能
     * 还在说的时候到；`0` = 关闭（NLS 吐句子时静音早已够，用不上）。
     */
    readonly openQuietMs?: number;
    /** 判停概率高时的短门槛（见 {@link openQuietMs}） */
    readonly openQuietShortMs?: number;
  };
  /** 播完后额外等待的余量 */
  readonly playbackTailMs: number;
  /**
   * 长思考回执：`afterMs` 内还没开始出声就先用旁白说一句（见 `turn-runner.ts`）。
   *
   * 真机上 dsh 跑工具常常 5–8 s，这期间一片安静，用户会以为它没听见。
   */
  /** 下行语音增益（默认 1）；MiMo 输出偏小，实机用 2–3 更合适 */
  readonly ttsGain?: number;
  /** 落盘目录，空串表示不落盘 */
  readonly archiveDir: string;
  /** 单段档案上限（MB），到顶另起一段 */
  readonly archiveMaxMb: number;
  /** 保留多少个会话档案目录 */
  readonly archiveKeep: number;
  /**
   * 审计出口的注册器（`agent.*` 与 `tts.task` 共用同一条出口）。
   *
   * `FrontedAgent` 和 TTS provider 都是**进程级共用**的，而档案是**每条连接一份** ——
   * 所以连接建立时把这些事件接到自己的档案上，断开时摘掉。同时只有一个设备在用时
   * 归属是精确的。
   *
   * **断开时必须带 `expected`（自己当初挂上去的那个 sink）**：弱网重连时旧连接的
   * 收尾常常晚于新连接的挂载，无令牌的 `null` 会把新连接的档案出口一起摘掉 ——
   * 之后所有 `agent.*` / `tts.*` 事件静默丢失，日志里一个字都没有
   * （生产实现见 `main.ts` 的 `createAuditSlot`）。
   */
  readonly setAudit?: (
    sink: ((name: string, data: Record<string, unknown>) => void) | null,
    expected?: ((name: string, data: Record<string, unknown>) => void) | null,
  ) => void;
  /** 照片落盘目录；空串表示不落盘（默认） */
  readonly photoDir: string;
  /** 控制口端口与超时 */
  readonly controlPort: number;
  /** 不用人动手的拍照（`needsUser=false`）的兜底总时长 */
  readonly photoTimeoutMs: number;
  /**
   * 要人在设备上动手的拍照（`needsUser=true`）的兜底总时长（默认 40 s）。
   *
   * 分段计时（等设备就绪 / 等人按快门）是设备侧的事，设备会先超时并上报原因；
   * 这里只是「设备也没消息」的兜底 —— 见 `photo-inbox.ts`。
   */
  readonly confirmTimeoutMs?: number;
  /** 默认的识图提问 */
  readonly imageQuestion: string;
  /** 离线时的后台汇报队列（null / 不给 = 不持久化） */
  readonly announceStore?: AnnounceStore | null;

  /**
   * 宠物环：主动开口（打招呼 / 搭话 /「看你所看」）。**不给就不主动开口**。
   *
   * 深夜判定用进程本地时区 —— VPS 上记得设 `TZ`（如 `Asia/Shanghai`）。
   */
  readonly proactive?: {
    /** 宠物层参数（见 `pet/brain/registry.ts` 的 `PetParams`），全部可覆盖 */
    readonly params?: Partial<PetParams>;
    /** 主动开口后开麦听回应多久（设备支持 `listen.start` 才生效） */
    readonly listenMs?: number;
    /** 多久判一次时机（默认 30 s） */
    readonly tickMs?: number;
  } | null;

  /**
   * TLS。**不给就是明文** —— 本地开发不必先造证书；上公网时由部署方注入。
   *
   * 证书的路径与内容属于**部署细节，不进源码**：内容以 `Buffer` 传，路径只走
   * `MIAI_TLS_KEY` / `MIAI_TLS_CERT`（独立进程）或 `tls.keyPath` / `tls.certPath`
   * （插件）。这样换证书不需要改代码，也不会有人把私钥误提交上来。
   *
   * 到期不会静默：`main.ts` 的 `loadTls()` 会读 `notAfter`，剩 30 天起在启动日志里
   * 提醒，过期后明确说明「每次握手都会失败」（见 `tls-cert.ts`）。
   */
  readonly tls?: {
    readonly key: Buffer;
    readonly cert: Buffer;
  };

  /**
   * 首帧鉴权。**不给就不要求 `Hello`**，任何客户端能直接发 Audio。
   *
   * 给了就必须先收到合法 `Hello` 才放行后续帧；返回 false 会回一条
   * `Control: auth_failed` 再断开。
   */
  readonly authenticate?: (hello: HelloInfo) => boolean;

  /** 心跳/空闲上限：这么久没收到任何字节就主动断开（默认 45 s）。 */
  readonly idleTimeoutMs?: number;

  /**
   * 常驻模式：一条连接结束后**继续等**下一条（默认 false = 单连接就退出）。
   *
   * 调试时客户端会反复重连（改端口、换证书、拉断重试），每次都要手动重启服务
   * 很烦；`--serve` 就是给它准备的。
   */
  readonly serve?: boolean;

  /**
   * 监听成功：真实端口 + 外部停机入口。
   *
   * 给「进程内起栈」的宿主（dsh 插件）用：`port: 0` 时只有这里能拿到端口；
   * {@link serve} 多设备模式下也只有这里能停机（靠连接结束收不了尾）。
   * 语义见 `transport.ts` 的同名选项。
   */
  readonly onListening?: (info: { readonly port: number; readonly stop: () => void }) => void;
}

/**
 * 进程内只该有一份的共用件。
 *
 * 两个都是**服务级**的，不是「每条连接一个」：
 * - {@link VoiceService.control}：控制口端口固定，一条连接建一个会在重连时
 *   `EADDRINUSE`，而且还在监听的旧 server 会把 MCP 的 `/say`、`take_photo`
 *   路由给**上一条已经关闭的连接**（见 `tool-control.ts` 顶部）；
 * - {@link VoiceService.activeSlot}：同一时间只服务一台设备。新连接接管时通过它
 *   找到旧连接并主动断开，旧连接迟到的收尾也靠它判断「我是不是还该动共享槽」。
 */
export interface VoiceService {
  /** 服务级控制口（`runVoiceServer` 建，监听收尾才关） */
  readonly control: ToolControl;
  /** 唯一活跃连接槽；`null` = 此刻没有设备 */
  readonly activeSlot: { current: VoiceConnection | null };
}

/**
 * 启动监听，按连接串行处理。返回进程退出码。
 *
 * 监听、鉴权、心跳、TLS 全在 `transport.ts`；这里只决定「一条连接里谁来干活」。
 */
export async function runVoiceServer(options: VoiceSessionOptions): Promise<number> {
  // 控制口**在这里建一次**，不是每条连接建一个：端口固定，连接级开关就是
  // EADDRINUSE 的来源（`tool-control.ts` 顶部记了现场表现）。
  // 连接上来时 `setHandlers` 热切换，断开时带令牌摘掉。
  const control = startToolControl({
    port: options.controlPort,
    photoTimeoutMs: options.photoTimeoutMs,
    handlers: null,
  });
  const service: VoiceService = { control, activeSlot: { current: null } };
  try {
    return await runTransport({
      port: options.port,
      host: options.host,
      tls: options.tls,
      authenticate: options.authenticate,
      idleTimeoutMs: options.idleTimeoutMs,
      singleConnection: options.serve !== true,
      log: (line) => { console.log(line); },
      ...(options.onListening === undefined ? {} : { onListening: options.onListening }),
      onConnection: (conn) => { handshake(conn, options, service); },
    });
  } finally {
    // `close()` 会 `closeAllConnections()`：不关的话，keep-alive 的工具进程会一直
    // 占着端口，下一个进程绑定同一个端口就 EADDRINUSE。
    control.close();
  }
}

/**
 * 没配鉴权时等 `Hello` 的上限。v1 手机不鉴权就不发 `Hello`，
 * 这么久没动静（或先来了别的帧）就按 v1 走。
 */
const HANDSHAKE_WAIT_MS = 1_000;

/**
 * 先定这条连接说哪个版本，再建业务对象 —— 能力决定了上行解码、判定核和收件箱，
 * 必须在它们构造之前就知道。
 *
 * - 配了鉴权：连接层保证 `Hello` 先到，等它
 * - 没配鉴权：`Hello` 先到就用它；先到的是别的帧或等满 {@link HANDSHAKE_WAIT_MS} → v1，
 *   那一帧原样转交，不丢
 */
function handshake(conn: Connection, options: VoiceSessionOptions, service: VoiceService): void {
  let decided = false;
  let timer: NodeJS.Timeout | null = null;

  const decide = (hello: HelloInfo | null, first?: { type: number; payload: Buffer }): void => {
    if (decided) {
      return;
    }
    decided = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    const link = resolveDeviceLink(hello, options.device);
    if (link.proto === 2) {
      conn.sendWelcome(V2_WELCOME);
    } else if (hello?.proto !== undefined && hello.proto >= 2) {
      console.log('  握手    设备要 v2 但能力不合法 → 不回 Welcome，按 v1 走');
    }
    const next = new VoiceConnection(conn, options, link, service);
    // **单活**：同一时间只服务一台设备。新连接握手完成就顶掉旧的 ——
    // 手机重启 / 换机之后旧连接往往还挂着（对端已死，这边还没察觉），
    // 两条连接同时跑会让 ASR/TTS/播报互相抢，人也分不清声音来自哪一台。
    const previous = service.activeSlot.current;
    if (previous !== null) {
      console.log(`  连接    新连接接管（${conn.remote}）→ 主动断开旧连接`);
      previous.evict();
    }
    service.activeSlot.current = next;
    next.start(first, hello?.resumed === true);
  };

  conn.bind({
    onHello: (hello) => { decide(hello); },
    onFrame: (type, payload) => { decide(null, { type, payload }); },
    onClose: () => {
      decided = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  });
  if (options.authenticate === undefined) {
    timer = setTimeout(() => { decide(null); }, HANDSHAKE_WAIT_MS);
  }
}

/**
 * 把宿主给的静态上下文收成 `OmniShadow` 认的形状。
 *
 * 记忆可以是函数：每条连接构造影子时调用一次，取当时的 MEMORY.md 摘要。
 * 日期函数不在这里调用，影子自己在 `session.update` 里调用一次。
 * 空白字段不传，避免空块写进提示词或 ASR 配置。
 */
function omniStaticContext(
  shadow: NonNullable<VoiceSessionOptions['omniShadow']>,
): {
  readonly memoryContext?: string;
  readonly clockContext?: () => string;
  readonly asrCorpusText?: string;
  readonly asrLanguage?: string;
} {
  const rawMemory = shadow.memoryContext === undefined
    ? undefined
    : (typeof shadow.memoryContext === 'function' ? shadow.memoryContext() : shadow.memoryContext);
  const memory = textIfPresent(rawMemory);
  const corpus = textIfPresent(shadow.asrCorpusText);
  const language = textIfPresent(shadow.asrLanguage);
  return {
    ...(memory === undefined ? {} : { memoryContext: memory }),
    ...(shadow.clockContext === undefined ? {} : { clockContext: shadow.clockContext }),
    ...(corpus === undefined ? {} : { asrCorpusText: corpus }),
    ...(language === undefined ? {} : { asrLanguage: language }),
  };
}

/** 空白不当事实。有内容则原样返回，不改写。 */
function textIfPresent(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') {
    return undefined;
  }
  return text;
}

/**
 * 一条连接的完整状态：只负责把各模块接起来。
 *
 * 导出只为一件事：**接线的所有权语义要能单测**（`tests/voice-session-reconnect.test.ts`
 * 直接驱动两条 `VoiceConnection`，不必起真 socket）。生产路径只有 `handshake` 会构造它。
 */
export class VoiceConnection {
  private readonly conn: Connection;
  private readonly options: VoiceSessionOptions;
  private readonly link: DeviceLink;
  private readonly service: VoiceService;
  private readonly caps: DeviceCapabilities;
  /**
   * 设备最近一次上报的电量 / 充电 / 佩戴。
   *
   * 以前这些只喂给宠物环，agent 那条路上完全没有 —— 真机问「眼镜还剩多少电」，
   * agent 回「读不到，我手上没有拿电量的接口」，而设备每 30 s 就在报。
   */
  private powerPercent: number | null = null;
  private charging: boolean | null = null;
  private wearing: boolean | null = null;
  /** v1 线协议垫片：原语 ↔ 控制串 / 状态帧，图像帧归属；v2 连接为 `null` */
  private readonly v1: V1Session | null;

  /** 应用层（宠物环 + 心跳）；没开主动开口时为 null */
  private readonly app: AppSession | null;
  /** 等首帧上行的兜底时长；宠物与播报共用 */
  private readonly micOpenTimeoutMs: number;
  /**
   * 本连接唯一的时钟。
   *
   * 一轮对话的等待、拍照的兜底超时、宠物心跳全走它 —— 生产是 `SystemClock`，
   * 模拟器换成 `VirtualClock`。**不要在这里再直接 `Date.now()`**。
   */
  private readonly clock: Clock = new SystemClock();
  /** 最近一次 ASR 定稿的时刻（插话闸用，见 `barge-voicing.ts`） */
  private lastSentenceAtMs = Number.NEGATIVE_INFINITY;
  /**
   * 装配器与插话闸**共用**的时刻源。
   *
   * 写成同一个函数引用，就是为了让「两边各取一个时钟」这件事再也做不出来 ——
   * 真机踩过：装配器 `Date.now()`、闸 `SystemClock.now()`，闸恒放行且无日志。
   */
  private readonly assemblerNow = (): number => this.clock.now();
  /** 时钟接错只报一次，免得每句话刷一行 */
  private clockMismatchLogged = false;
  /** 上行编码由能力集决定；档案与解码都要它 */
  private readonly uplinkCodec: 'msbc' | 'pcm16';

  private readonly dialog: DialogRuntime;
  private readonly uplink: UplinkPipeline;
  private readonly turnJudge: EndpointDetector | null;
  /** 判停器是不是这条连接自己的（自己建的在断开时必须销毁，共享的不许） */
  private readonly ownsTurnJudge: boolean;
  private readonly assembler: UtteranceAssembler;
  private readonly stt: SttSession;
  /**
   * omni 影子旁路（`OMNI_SHADOW=1` 才有，默认 null = 零成本）。
   *
   * 跟着**这条连接**活：服务空跑时 DashScope realtime 会空闲断链，进程启动就建连
   * 等于白建一条注定 `broken` 的连接。
   */
  private readonly omni: OmniShadow | null;
  /**
   * 车道封段序号（omni 的 `seal`）。
   *
   * 和 ASR 的 `commitSeq` **不是同一个号**：车道 20 ms 就起跑，ASR 150 ms 才切段
   * （见 `sttCommitMs`）。两份档案事件用 `asr.commit.lane_seq` 配对。
   *
   * ASR 那个号**不在这里**：`commit` 何时真发出去只有 ASR 自己知道
   * （空缓冲跳过、解码窗口延后都不占号），宿主自己数就会指错段
   * （见 `qwen-realtime-asr.ts` 的 `_commitSeq` 与 `causal.ts`）。
   */
  private sealSeq = 0;

  /**
   * 最近一帧的**前端**静音时长（`AudioFrame.silenceMs`，能量门算的）。
   *
   * 落进 `asr.commit.front_silence_ms`：组装器那条「静音 20 ms（实际 92 ms）」
   * 里的 92 是**它自己的 tick 延迟**（下一块音频什么时候到），而真机那句话问的
   * 「到底静了多久」要的是这个数。两个数并排落档，①a 才拆得开。
   */
  private lastFrameSilenceMs = 0;

  /**
   * 这条连接挂到服务级控制口上的 handlers（`setHandlers(null, this)` 的令牌）。
   *
   * 断开时**必须原样带回去**：新连接可能已经接管了控制口，无令牌的 `null` 会把
   * 它一起清掉（MCP 拍照从此 503）。
   */
  private toolHandlers: ToolControlHandlers | null = null;

  /**
   * 本连接挂到审计槽上的出口。
   *
   * 存成字段同样是为了当令牌用（见 {@link VoiceSessionOptions.setAudit}）：
   * 每次现造一个闭包，摘的时候就认不出「槽里那个是不是我挂的」。
   */
  private readonly auditSink = (name: string, data: Record<string, unknown>): void => {
    this.archive?.event(name, data);
  };

  /** 原始档案（`MIAI_ARCHIVE_DIR` 为空时是 null） */
  private readonly archive: SessionArchive | null;

  constructor(
    conn: Connection,
    options: VoiceSessionOptions,
    link: DeviceLink,
    service: VoiceService,
  ) {
    this.conn = conn;
    this.options = options;
    this.service = service;

    const log = (line: string): void => { console.log(line); };
    // 版本与能力在握手时定好；往下全是能力
    this.link = link;
    this.caps = link.capabilities;
    this.v1 = link.v1;
    this.uplinkCodec = this.caps.audioIn;

    const proactive = options.proactive;
    this.micOpenTimeoutMs = proactive?.params?.micOpenTimeoutMs ?? DEFAULT_PET_PARAMS.micOpenTimeoutMs;
    // 对话层（状态机 + 拍照 + 一轮的串行队列 + 播报排队）只有一份实现，
    // 在 `app/dialog.ts`；这里只把环境接上（ADR-0002 §3.1）
    this.dialog = new DialogRuntime({
      clock: this.clock,
      // 票据上的两个因果字段：谁认识 ASR 谁注入（FSM 自己不认识转写层）
      ticketContext: {
        baseCommitSeq: () => this.stt.commitSeq?.() ?? 0,
        now: this.assemblerNow,
      },
      caps: this.caps,
      agent: options.agent,
      tts: options.tts,
      downlink: conn,
      // 旧连接被顶掉之后，`dispose()` 不许摘新连接的回执钩子（见 DialogOptions）
      isActiveOwner: () => this.isActiveOwner(),
      imageQuestion: options.imageQuestion,
      photoDir: options.photoDir,
      photoTimeoutMs: options.photoTimeoutMs,
      confirmTimeoutMs: options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
      playbackTailMs: options.playbackTailMs,
      ...(options.ttsGain === undefined ? {} : { ttsGain: options.ttsGain }),
      onDownlinkChunk: (chunk) => { this.archive?.downlink(chunk); },
      onEvent: (name, fields) => { this.archive?.event(name, fields); },
      onLiveAvailable: (sink) => {
        // 逐句合成：把这一轮期间的 token 增量接到 TTS 上（见 sentence-pump.ts）
        options.agent.attachLiveSink?.(sink);
      },
      env: {
        call: (call) => this.sendCall(call),
        assemble: (text) => { this.assembler.addSentence(text); },
        deviceNote: () => this.deviceNote(),
        // 收尾前先明说「这次会话结束了」。
        //
        // 只 `end()` 掉 socket 的话，App 那边只看到「对端关闭」，和网络掉线一模一样
        // —— supervisor 会在 1 秒后自己连回来，用户看到的就是「说完再见它又活了」。
        //
        // 延迟关闭是给控制串留出发出去 + App 读线程处理的时间（它收到就置位，不再重连）。
        end: () => {
          // 从这一刻起就是「正在关」：宽限期内的 listen.start 必须拒绝，
          // 不能在告别的 250 ms 里再把麦打开。
          this.linkClosing = true;
          this.conn.sendControl('end_session');
          this.clearEndSessionTimer();
          const timer = setTimeout(() => {
            if (this.endSessionTimer !== timer) {
              return;
            }
            this.endSessionTimer = null;
            if (this.micPhase === 'closed' || this.conn.isClosed) {
              return;
            }
            this.conn.end();
          }, 250);
          timer.unref?.();
          this.endSessionTimer = timer;
        },
        forget: (id) => { this.v1?.forget(id); },
        ...(this.caps.listenStart
          ? {
            announceMic: {
              listenStart: true,
              micOpenTimeoutMs: this.micOpenTimeoutMs,
              listenMs: DEFAULT_PET_PARAMS.listenMs,
              call: (call: DeviceCall) => { this.sendCall(call); },
              awaitMicOpen: (timeoutMs: number) => this.awaitMicOpen(timeoutMs),
            },
          }
          : {}),
        onAnnounce: (pending, spoken) => { this.app?.announce(pending, spoken); },
        onTurnStart: (text, hasImage) => {
          this.archive?.event(EVENTS.turnStart, { text_len: text.length, image: hasImage });
        },
        // 话筒占用/释放由状态机转移驱动（见 `AppSession.onDialogState`）
        onDialogState: (state) => { this.app?.onDialogState(state); },
      },
      log,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.speakAnnounce === undefined
        ? {}
        : {
            speakAnnounce: (item: AnnounceItem) => options.speakAnnounce!(
              item,
              (answer) => this.runner.speakAudioAnswer(answer),
            ),
            cancelAnnounce: options.cancelAnnounce,
            onFallbackAnnounceSpoken: options.onFallbackAnnounceSpoken,
          }),
    });
    // 应用层**总是**要建：话筒（user / reply / announce）必须在同一张表里仲裁，
    // 没有宠物也要（ADR-0001 §6）。宠物只是这套应用层里的一个子系统。
    this.app = this.createAppSession(proactive, this.dialog);

    // 档案先开：后面每一段音频/每个事件都要往里写
    this.archive = SessionArchive.open(
      {
        rootDir: options.archiveDir,
        tag: conn.remote,
        maxBytesPerSegment: options.archiveMaxMb * 1024 * 1024,
        keepSessions: options.archiveKeep,
        log,
      },
      {
        remote: conn.remote,
        micGain: options.micGain ?? 1,
        ttsGain: options.ttsGain ?? 1,
        gateDbfs: options.gate.thresholdDbfs,
        gateHoldMs: options.gate.holdMs,
        gatePrerollMs: options.gate.prerollMs,
        uplinkRate: UPSTREAM_SAMPLE_RATE,
        uplinkCodec: this.uplinkCodec,
        downlinkRate: options.tts.sampleRate,
        stt: options.stt.name,
        tts: options.tts.name,
        agent: options.agent.name,
        levelLogMs: options.levelLogMs ?? 0,
      },
    );
    // 快车道的输入/输出、TTS 的两段耗时都接进**这一条**连接的档案（见 `setAudit`）
    options.setAudit?.(this.auditSink);

    this.omni = options.omniShadow === undefined ? null : new OmniShadow({
      apiKey: options.omniShadow.apiKey,
      ...(options.omniShadow.model === undefined ? {} : { model: options.omniShadow.model }),
      ...(options.omniShadow.socketFactory === undefined
        ? {}
        : { socketFactory: options.omniShadow.socketFactory }),
      serve: options.omniShadow.serve ?? 'off',
      ...omniStaticContext(options.omniShadow),
      // 每一份 seal 一条，`seq` 与 `asr.commit` 同源
      emit: (data) => { this.archive?.event(EVENTS.omniShadow, data); },
      log: (line) => { console.log(line); },
    });

    const turnJudgeOptions = options.turnJudge;
    const detector = resolveEndpointDetector(
      options,
      () => new TurnJudge({
        python: turnJudgeOptions!.pythonPath,
        script: turnJudgeOptions!.scriptPath,
        log: (line) => { console.log(`  ${line}`); },
      }),
      (line) => { console.log(line); },
    );
    this.turnJudge = detector.client;
    this.ownsTurnJudge = detector.owned;

    this.assembler = new UtteranceAssembler({
      quietMs: turnJudgeOptions?.quietMs ?? 0,
      extendMs: turnJudgeOptions?.extendMs ?? 0,
      maxExtensions: turnJudgeOptions?.maxExtensions ?? 0,
      ...(turnJudgeOptions?.maxUnsureExtensions === undefined
        ? {}
        : { maxUnsureExtensions: turnJudgeOptions.maxUnsureExtensions }),
      fallbackWindowMs: ASSEMBLER_FALLBACK_WINDOW_MS,
      threshold: turnJudgeOptions?.threshold ?? 1,
      ...(turnJudgeOptions?.thresholdCjk === undefined
        ? {}
        : { thresholdCjk: turnJudgeOptions.thresholdCjk }),
      ...(turnJudgeOptions?.waitBudgetMs === undefined
        ? {}
        : { waitBudgetMs: turnJudgeOptions.waitBudgetMs }),
      ...(turnJudgeOptions?.waitBudgetSequenceMs === undefined
        ? {}
        : { waitBudgetSequenceMs: turnJudgeOptions.waitBudgetSequenceMs }),
      ...(turnJudgeOptions?.maxOpenSilenceMs === undefined
        ? {}
        : { maxOpenSilenceMs: turnJudgeOptions.maxOpenSilenceMs }),
      ...(options.semantic === undefined
        ? {}
        : {
          semanticEndpoint: (text: string) => options.semantic!.judge(text),
          ...(options.semanticBudgetMs === undefined
            ? {}
            : { semanticBudgetMs: options.semanticBudgetMs }),
        }),
      recentMaxBytes: UPSTREAM_SAMPLE_RATE * 2 * ASSEMBLER_RECENT_SECONDS,
      // 尾巴上多的静音会把 p 拉低（停嘴处 0.95 → +300 ms 0.35），而 p 正是
      // 「要不要再等一拍」的依据 —— 不裁就是「每多等一拍，判据更差」。
      trailingTrimMs: turnJudgeOptions?.trailingTrimMs ?? ASSEMBLER_TRAILING_TRIM_MS,
      // 判停的每次决定都落档：`② 定稿→开轮` 在档案里一直是黑盒，1 ms 和 2400 ms
      // 都可以是这个数，不看 p 分不清「判停不敢收」和「排队」。
      onJudge: (fact) => { this.archive?.event(EVENTS.judge, { ...fact }); },
      predict: this.turnJudge
        ? (pcm: Buffer) => this.turnJudge!.predict(pcm)
        : undefined,
      // 只在有判停器时才有意义（没有判停器就走固定窗口，没有往返可叠）
      ...(this.turnJudge ? { predictAtMs: ASSEMBLER_PREDICT_LEAD_MS } : {}),
      // 静音一到就把判停跑掉，和 ASR 那 200 ms 静音窗并行 —— 出句时概率已经算好。
      // 门槛用能量门那个（同一路放大后的波形、同一套设备标定）。
      silenceDb: options.gate.thresholdDbfs,
      // **必须与本类的 `clock` 同一把尺**：`lastVoicedAt` 要拿 `lastSentenceAtMs` 去比
      // （见 `barge-voicing.ts`）。默认是 `Date.now()`（≈1.76e12），而 `SystemClock`
      // 是进程启动后的单调毫秒（≈2e4）—— 接错的那一版闸恒放行且毫无日志。
      now: this.assemblerNow,
      // `0` 原样透传（关闭预判停 / 投机）。删掉字段会让 SilenceTriggers 用回 200 / 100。
      ...assemblerSilenceFromGate(options.gate),
      // 端点归我们把控的 ASR（qwen realtime）：静音到点就封段，解码那 ~260 ms
      // 与判停那一拍并行跑。`commitMs` 为 0 就不接（NLS 自己判句，别插嘴）。
      ...(options.gate.commitMs === undefined || options.gate.commitMs <= 0
        ? {}
        : {
          commitAfterMs: options.gate.commitMs,
          onCommit: (silenceMs) => {
            const laneSeq = (this.sealSeq += 1);
            // 车道起跑（omni 的 `seal`）。**ASR 的 commit 在更晚的 `onSttCommit`**，
            // 所以这里不再写 `asr.commit` —— 否则 ①a/①b（停嘴→封段→定稿）
            // 会拿 20 ms 的车道时刻冒充 150 ms 的封段时刻，整份延迟报告偏 130 ms。
            this.omni?.seal(laneSeq, silenceMs);
          },
          // ASR 那一路**晚一点**再切（见 `sttCommitMs`）：车道要的是「这半句结束」，
          // ASR 要的是「这一句结束」，两者的最优值差一个数量级。
          ...(options.gate.sttCommitMs === undefined || options.gate.sttCommitMs <= 0
            ? {}
            : {
              sttCommitAfterMs: options.gate.sttCommitMs,
              onSttCommit: (silenceMs) => {
                // **先真发，再读号**。`commit()` 会跳过（这段没有新音频）、会延后
                // （上一段还在解码），这两种都**不占号**；宿主以前自己 `+1`，
                // 跳过时虚增、`hangup()` 时漏增，转写戴的出生证就指错了段
                // （`causal.ts` 那条水位线全靠这个号）。
                this.stt.commit?.();
                const seq = this.stt.commitSeq?.() ?? 0;
                this.archive?.event(EVENTS.asrCommit, {
                  seq,
                  silence_ms: Math.round(silenceMs),
                  // 前端（能量门）算的真静音时长。与 `silence_ms` 的差就是
                  // 「静音开始到真有音频帧到达」的 tick 延迟 —— ①a 拆开看这两个数
                  front_silence_ms: Math.round(this.lastFrameSilenceMs),
                  want_ms: options.gate.sttCommitMs,
                  // 与 `omni.shadow` 的 join key：同一段语音的车道序号。
                  // 两个号从 2026-11-23 起**不再相等**（车道 20 ms 先跑、ASR 150 ms 后切），
                  // 想配对就看这一个字段，别再假设 `seq` 一样。
                  lane_seq: this.sealSeq,
                });
                // 共享内核的 `input` 区域只认这一个号（`Math.max` 保护：重复不会倒着走）
                this.core.runtime.dispatch({ type: 'asrCommit', commitSeq: seq });
              },
            }),
        }),
      // 开轮门槛：提交早 → 定稿也早，可能人还在说。定稿到达时看「截至此刻的
      // 连续静音」，不够就等 —— 那本来就不该开轮。
      ...(options.gate.openQuietMs === undefined || options.gate.openQuietMs <= 0
        ? {}
        : {
          openQuietMs: options.gate.openQuietMs,
          ...(options.gate.openQuietShortMs === undefined
            ? {}
            : { openQuietShortMs: options.gate.openQuietShortMs }),
        }),
      onUtterance: (text) => {
        this.app?.userFinal(text);
        console.log('\n--- 本轮 ---');
        console.log(`  文本    ${JSON.stringify(text)}`);
        this.dialog.dispatch({ type: 'utterance', text });
      },
      // 句子定稿那一刻就让快车道起跑，把判停那一拍从关键路径上挪走。
      // 判停若并了下一段，组装器会拿更长的文本再调一次；认领时按文本比对。
      onSentence: (text) => {
        // 预热**只跟快车道起跑走**，不跟「这一轮会不会答」走。
        //
        // 因为委派轮一定先出回执（`RECEIPTS`），而回执和正式回答共用同一条 TTS 连接
        // —— 连接上一次只有一个 task，预热会被回执认领掉。测试过「定稿无条件预热」：
        // 委派轮里 `stream:false prewarmed:true`（回执）紧跟着
        // `stream:true prewarmed:false`（正式回答），白开一条 task。
        // 试过把回执预合成进缓存来腾出预热，代价是设备刚连上就要占 TTS 约 2 秒，
        // 与用户第一句话抢连接 —— 为 66 ms 不值得，已回滚（`5500c47`）。
        //
        // ⚠️ `prefetch` 只许调**一次**：以前这里还多一行无条件的 `prefetch(text)`，
        // 每句定稿要发两趟（命中缓存那趟不算，但没命中就是重复请求）。
        if (this.options.agent.prefetch?.(text) === true) this.options.tts.prewarm?.();
      },
      // 中间结果投机：比定稿再往前提 p50 731 ms（真机 47 轮）。文本是猜的，
      // 定稿确认是前缀才认领 —— 认不了就作废，退回上面那条路，等于没做。
      // 返回 false（没投出去）时组装器不会记「这段语音已投机」，下一个静音 tick
      // 还会再问一次 —— 否则「静音 100 ms 时只凑到 2 个字」就等于整轮放弃。
      onPartial: (text) => this.options.agent.speculatePartial?.(text) ?? false,
      // 开轮前先等 ASR 那段解完（见 `UtteranceAssemblerOptions.awaitDecode`）。
      // 闭包里取 `this.stt`：它在本行之后才赋值，构造期不能摸。
      awaitDecode: () => this.stt?.whenDecoded?.() ?? null,
      log,
    });

    this.stt = options.stt.open({
      onPartial: (text, commitSeq) => { this.onPartial(text, commitSeq); },
      onSentence: (text, index, commitSeq) => { this.onSentence(text, index, commitSeq); },
      onError: (error) => { this.onAsrError(error); },
    });
    // 设备刚连上、用户还没开口：把 TTS 那条 WebSocket 先建好（~170 ms 的
    // TCP+TLS+Upgrade）。放在「这一轮开始」就太晚了 —— 那时用户已经在等。
    // ASR 那侧不用在这里调：`stt.open()` 内部已经预取 token。
    options.tts.warm?.();

    this.uplink = new UplinkPipeline({
      ffmpegPath: options.ffmpegPath,
      // 上行编码由能力决定：v1 是 mSBC，自报 pcm16 的设备直接进增益/能量门
      codec: this.uplinkCodec,
      sampleRate: UPSTREAM_SAMPLE_RATE,
      gate: options.gate,
      gain: options.micGain,
      levelLogMs: options.levelLogMs,
      /**
       * **统一时钟**：能量门的保持窗口、`AudioFrame.tsMs`、装配器的静音计时、
       * 插话闸的 `lastVoicedAt` 全从这里取。
       *
       * 不传的话门用 `Date.now()`（≈1.76e12）、宿主用 `SystemClock`（≈2e4），
       * 两边比出来的「静音多久」是个天文数字 —— 真机踩过，插话判据整场静默失效
       * 且一行日志都没有（见 `uplink-pipeline.ts` 的同名选项）。
       */
      now: this.assemblerNow,
      log,
      onError: (line) => { console.error(`[ffmpeg] ${line}`); },
      onRawPcm: (raw) => { this.archive?.pcmRaw(raw); },
      // 判停用的音频**不在这里收**：下面 `onFrame` 里的 `assembler.addFrame(frame)`
      // 是唯一入口。两处都收等于每帧进 `recentChunks` 两次，而且这条老路会按
      // `silenceDb` **自己重算**能量，与能量门的 `voiced` 两套判据（见 `addAudio`）。
      onPcm: () => {},
      onSpeechOpen: (peakDbfs, preroll, prerollMs) => {
        this.archive?.event(EVENTS.gateOpen, { peakDbfs: Number(peakDbfs.toFixed(1)), prerollMs });
        // 新一轮开口：判停窗口只留这一句（官方也是按句裁的）。预卷就是这段的开头，
        // 前面那些静音 / 上一轮的回答都不该进模型。
        this.assembler.resetAudio(preroll);
        // 预卷里**大部分是静音**（它是「触发点之前 800 ms」，不是语音起点）。
        // 按同一套门限逐块标 voiced：静音只进软起音环，不会一开麦就让服务端先在
        // 静音上吐一个「嗯。」（那一下还会把宠物话筒改成 owner=user）。
        //
        // 比较符必须与 `EnergyGate` 严格一致（`peakDbfs > thresholdDbfs`）：
        // `>=` 会把「恰好等于门限」的那一块标成有声，而门自己把它当静音。
        for (const part of preroll) {
          this.stt.feed(part, pcm16PeakDbfs(part) > options.gate.thresholdDbfs);
        }
        // 影子按「这一句」重新起一段。封段后到下一次开口之间的静音**一个字节都不推**
        // （见 `OmniShadow` 的 mute），所以这里只要把预卷补上就行。
        this.omni?.restart(preroll);
      },
      onFrame: (frame) => {
        // 能量门周期号进共享内核（只作参考，不参与因果裁决 —— `causal.ts` 顶部）
        this.core.runtime.dispatch({ type: 'gate', gateSeq: frame.gateSeq });
        // 声学前端的**唯一出口**：`voiced` / `silenceMs` / `tsMs` 都是门算好的，
        // 装配器不再按 `silenceDb` 重算一遍（两处各算一遍正是「有时候丢字、
        // 有时候灌静音」的来源，见 `UtteranceAssembler.addFrame`）。
        this.assembler.addFrame(frame);
        this.lastFrameSilenceMs = frame.silenceMs;
        // `voiced` 必须透传：门比封段晚关约 2 s，不带它 ASR 的「解码期暂存」
        // 就会把尾静音攒下来补推，换来一句幻觉定稿（实测 150 ms 静音 → 「嗯。」）
        this.stt.feed(frame.pcm, frame.voiced);
        // 同一个理由：不带它就会往旁路里灌静音
        this.omni?.feed(frame.pcm, frame.voiced);
      },
      onSpeechClose: (gapMs) => {
        // 带上 gapMs：能量门要 holdMs（默认 2 s）才关门，所以 `t` 本身**不是**
        // 「用户停嘴」的时刻，`t - gapMs` 才是。延迟报告靠这个还原真实起点。
        this.archive?.event(EVENTS.gateClose, gapMs === undefined ? undefined : { gapMs });
        this.stt.hangup();
      },
    });
  }

  /** 状态机（在 `DialogRuntime` 里；本类只读它的阶段与轮次） */
  private get core(): SessionCore {
    return this.dialog.core;
  }

  private get photos(): PhotoInbox {
    return this.dialog.photos;
  }

  private get runner(): TurnRunner {
    return this.dialog.runner;
  }

  /**
   * @param first - 握手期间先到的那一帧（v1 手机不发 `Hello` 时），原样补交
   */
  /**
   * @param first 握手前先到的那一帧（v1 没发 `Hello` 时可能有）
   * @param resumed 这是**自动重连**，不是用户主动开的通道（见 `HelloInfo.resumed`）
   */
  start(first?: { type: number; payload: Buffer }, resumed = false): void {
    console.log(`已连接 ${this.conn.remote}\n`);
    console.log(
      `  设备    ${this.link.label}（v${this.link.proto}）：${describeCapabilities(this.caps)}`,
    );
    this.archive?.event(EVENTS.deviceLink, { proto: this.link.proto, label: this.link.label });

    // 影子握手（实测 ~1.3 s）与设备握手并行，不占关键路径。
    // 挂到 agent 上才会发声：显式 `live`，或没写管道模式且 `serve !== 'off'`
    // （旧的认领推断）。`cascade` 里影子只测量，`start()` 照跑，但不挂车道。
    const omniServesPlayback = this.options.pipelineMode === 'live'
      || (
        this.options.pipelineMode === undefined
        && this.options.omniShadow !== undefined
        && this.options.omniShadow.serve !== 'off'
      );
    this.omni?.start();
    // 车道照连接挂：这一条连接答完/断开时必须摘掉，否则下一条连接会认领到
    // 一条已经死了的 WS（它的 response 永远不会 done）
    if (this.omni !== null && omniServesPlayback) {
      this.options.agent.attachAudioLane?.(this.omni);
    }

    // 后台任务完成后的播报落在这条连接上
    this.options.agent.setAnnouncer?.((speech, emotion) => { this.onAnnounce(speech, emotion); });
    // Pure Live：`BackgroundTaskReport` 进播报空窗。没这个口的 agent 是空操作。
    this.options.agent.setTaskReporter?.((report) => {
      this.onTaskReport(report);
    });

    // 上次离线期间攒下的汇报：连上就补播（旧的先播）
    const backlog = this.options.announceStore?.drain() ?? [];
    if (backlog.length > 0) {
      this.archive?.event(EVENTS.announceReplay, { count: backlog.length });
      console.log(`  补播    离线期间攒了 ${backlog.length} 条后台汇报`);
      for (const item of backlog) {
        this.dialog.enqueueAnnounce(item.text, item.emotion);
      }
    }

    // 业务只认「帧」和「关闭」：Hello、Ping/Pong、空闲看门狗、TLS 都在连接层
    this.conn.bind({
      onFrame: (type, payload) => { this.onFrame(type, payload); },
      onClose: () => { this.onClose(); },
    });
    if (first !== undefined) {
      this.onFrame(first.type, first.payload);
    }
    // 心跳由 AppSession 自己开（clock.every），这里不再 setInterval

    // 连接就绪时**不立刻开麦**，而是先看设备是不是已经在采集。
    //
    // 历史：以前无条件发 `listen.start`（修「未响应」），结果 App 的网络抖动重连
    // 也会把眼镜唤醒；改成看 `Hello.resumed` 跳过重连，又暴露出另一头 ——
    // 重连时设备侧的 Aivs 会话**确实**可能已经自毁（真机 `会话状态 3` + 采集停止），
    // 那时不唤醒就等于未响应。
    //
    // 所以判据改成最本质的那条：**有没有上行音频**。设备在推流就什么都不做；
    // 一段时间内一帧都没有，才说明需要把它拉起来。
    if (this.caps.listenStart && backlog.length === 0) {
      this.armCaptureWatch(resumed);
    }

    const detail = captureMode(this.caps, 'detail');
    const handlers: ToolControlHandlers = {
      capabilities: () => this.caps,
      takePhoto: () => this.requestToolCapture('glance'),
      // 没有 `detail` 意图时不传 `takePhotoHq`：`tool-control` 会回落到 `takePhoto`
      takePhotoHq: detail === null ? undefined : () => this.requestToolCapture('detail'),
      endSession: () => { this.dialog.dispatch({ type: 'endRequested' }); },
      say: (text) => {
        // 调试口：和「用户说完一句」走同一条路，方便没有麦克风时联调
        this.dialog.dispatch({ type: 'utterance', text });
      },
      control: (text) => { this.conn.sendControl(text); },
      log: (line) => { console.log(line); },
    };
    this.toolHandlers = handlers;
    // 控制口是**服务级**的：这里只热切换 handlers，不重新 bind 端口 ——
    // 每条连接建一个的后果是重连时 EADDRINUSE，而且旧 server 会把 MCP 的请求
    // 路由给已经死掉的连接（`tool-control.ts` 顶部的现场记录）。
    this.service.control.setHandlers(handlers, undefined, {
      photoTimeoutMs: this.options.photoTimeoutMs,
      // HTTP 超时比收件箱的兜底再宽 5 s：让设备上报的失败原因先回来
      hqTimeoutMs: detail === null ? undefined : this.photos.timeoutFor(detail.needsUser) + 5_000,
    });
  }

  // ------------------------------------------------------------------ 接线

  private onFrame(type: number, payload: Buffer): void {
    switch (type) {
      case UpstreamFrameType.Audio:
        this.noteUplinkAudio(payload);
        // `uplink.sbc` 只存压缩帧；PCM 上行由 pipeline 的 onRawPcm 写 `uplink.pcm`
        if (this.uplinkCodec === 'msbc') {
          this.archive?.sbc(payload);
        }
        this.uplink.push(payload);
        return;
      case UpstreamFrameType.Image: {
        // v1：图属于哪个请求由垫片判（`hq_image` 公告 / 在途的 glance）；
        // v2：带 id 的图走 CaptureImage，走 Image 的一律是用户自己拍的。
        // 没人认领就是「看一眼」，起一轮识图
        if (!this.photos.deliver(this.v1?.image() ?? null, payload)) {
          this.dialog.dispatch({ type: 'image', jpeg: payload });
        }
        return;
      }
      case UpstreamFrameType.Status:
        if (this.v1 === null) {
          console.log('  ✗ v2 连接收到 v1 状态帧，已忽略（v2 用 Event 帧）');
          return;
        }
        this.onStatus(this.v1, payload);
        return;
      case UpstreamFrameType.Event:
        this.onV2Event(payload);
        return;
      case UpstreamFrameType.CaptureImage: {
        const parsed = this.link.proto === 2 ? parseV2CaptureImage(payload) : null;
        if (parsed === null) {
          console.error(`  ✗ CaptureImage 帧格式不对或不在 v2 连接上（${payload.length} B），已丢弃`);
          return;
        }
        this.photos.deliver(parsed.id, parsed.jpeg);
        return;
      }
      case UpstreamFrameType.Wake:
        this.onWake(payload);
        return;
      default:
        console.error(`  ✗ 未知帧类型 ${type}（${payload.length} B），已丢弃`);
    }
  }

  /**
   * 设备上报的状态事件。
   *
   * v1 的 `hq_armed` / `hq_image` / `hq_failed` 由垫片翻译成原语事件；
   * 收件箱只认 `DeviceEvent`。
   */
  private onStatus(v1: V1Session, payload: Buffer): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    } catch {
      console.error(`  ✗ 状态帧不是合法 JSON：${payload.toString('utf8').slice(0, 120)}`);
      return;
    }
    const name = typeof json['ev'] === 'string' ? json['ev'] : '';
    this.archive?.event(EVENTS.statusRecv, { name, raw: JSON.stringify(json).slice(0, 200) });

    // v1 的状态帧没有请求 id：垫片按它记着的在途请求补上
    const result = v1.status(json);
    if (!result.known) {
      console.log(`  ✗ 未知状态事件 ${JSON.stringify(name)}，已忽略`);
      return;
    }
    if (result.event !== null) {
      this.onDeviceEvent(result.event);
    }
  }

  /** v2 的 `Event` 帧：JSON `DeviceEvent`。 */
  private onV2Event(payload: Buffer): void {
    if (this.link.proto !== 2) {
      console.log('  ✗ v1 连接收到 v2 Event 帧，已忽略');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      console.error(`  ✗ Event 帧不是合法 JSON：${payload.toString('utf8').slice(0, 120)}`);
      return;
    }
    this.archive?.event(EVENTS.eventRecv, { raw: JSON.stringify(raw).slice(0, 200) });
    const event = parseV2Event(raw);
    if (event === null) {
      console.log(`  ✗ 不认识的设备事件 ${JSON.stringify(raw).slice(0, 120)}，已忽略`);
      return;
    }
    this.onDeviceEvent(event);
  }

  /**
   * 给这一轮附上的设备现状。
   *
   * 模型看不到上行事件流，这行是它唯一知道「电量多少、戴没戴」的途径。
   * 没有数据时返回 `undefined`（而不是空串），让调用方干净地略过。
   */
  private deviceNote(): string | undefined {
    const parts: string[] = [];
    if (this.wearing !== null) {
      parts.push(this.wearing ? '用户正戴着' : '用户摘下了');
    }
    if (this.powerPercent !== null) {
      parts.push(`电量 ${this.powerPercent}%${this.charging ? '，充电中' : ''}`);
    }
    return parts.length === 0 ? undefined : `设备现状：${parts.join('；')}`;
  }

  /** 一条原语事件：拍照的归收件箱，佩戴 / 电量 / 招呼归宠物环。 */
  private onDeviceEvent(event: DeviceEvent): void {
    switch (event.kind) {
      case 'capture.waiting':
      case 'capture.failed': {
        const say = this.photos.onEvent(event);
        if (say !== null) {
          // 设备已就绪，现在轮到人动手 —— 照念设备给的提示
          void this.runner.speakCanned(say);
        }
        return;
      }
      case 'presence':
        this.wearing = event.wearing;
        // 「事件后补 tick」在 AppSession 里（ADR-0002 §3.1）
        this.app?.deviceEvent(event);
        return;
      case 'power': {
        const next = mergePowerReading(
          { percent: this.powerPercent, charging: this.charging },
          event,
        );
        this.powerPercent = next.percent;
        this.charging = next.charging;
        // 宠物只认电量。缺 percent 时传留下的值，避免 null 把宠物侧也清掉。
        this.app?.deviceEvent({ kind: 'power', percent: this.powerPercent });
        return;
      }
      case 'summon':
        this.app?.deviceEvent(event);
        return;
      case 'played':
        // 设备说播完了：有 `played` 能力的设备靠它离开 speaking（时长估算是**下限**，
        // 回执只能延后；真机上见过设备在最后一批字节收到时就回执）
        this.runner.devicePlayed();
        this.archive?.event(EVENTS.devicePlayed);
        return;
    }
  }

  /**
   * 把一次 `DeviceCall` 真正下发出去。
   *
   * - 能力先挡：设备没声明的操作不发（`supportsCall`）
   * - v2 连接原样发 JSON（`Call` 帧）
   * - v1 连接经垫片翻成控制串；v1 表达不了的（如 `listen.start`）明确记日志跳过
   */
  private sendCall(call: DeviceCall): boolean {
    // 关麦 / 已关：拒绝再发 listen.start。失败也不能先进入 opening，
    // 否则等首帧的人会一直耗到 micOpenTimeoutMs。
    if (call.op === 'listen.start' && this.listenStartBlocked()) {
      this.archive?.event(EVENTS.ctlSkip, { op: call.op, why: 'closing' });
      console.log('  控制    ✗ 连接正在关闭，拒绝 listen.start');
      return false;
    }
    if (!supportsCall(this.caps, call)) {
      this.archive?.event(EVENTS.ctlSkip, { op: call.op, why: 'unsupported' });
      console.log(`  控制    ✗ 设备未声明 ${call.op}，已跳过`);
      return false;
    }
    if (this.v1 === null) {
      const json = encodeV2Call(call);
      this.archive?.event(EVENTS.callSend, { json });
      this.conn.sendCall(json);
    } else {
      const text = this.v1.encode(call);
      if (text === null) {
        this.archive?.event(EVENTS.ctlSkip, { op: call.op, why: 'v1-cannot-express' });
        console.log(`  控制    ✗ v1 无法表达 ${call.op}，已跳过`);
        return false;
      }
      this.sendControl(text);
    }
    this.noteListenSent(call);
    return true;
  }

  /** `closing` / `closed`：半关、对端已关、或开麦相位已经吸收。 */
  private listenStartBlocked(): boolean {
    return this.linkClosing || this.micPhase === 'closed' || this.conn.isClosed;
  }

  /**
   * `listen.start` / `listen.stop` 只有在字节真的交出去之后才改相位。
   *
   * 开麦成功 → `opening`（等首帧）。关麦成功且还在等首帧 → 回到 `idle`，
   * 并把等待者按「这次开麦结束」放开，避免再耗满超时。
   */
  private noteListenSent(call: DeviceCall): void {
    if (call.op === 'listen.start') {
      this.enterMic('opening');
      return;
    }
    if (call.op !== 'listen.stop' || this.micPhase === 'closed') {
      return;
    }
    if (this.micPhase === 'opening') {
      this.enterMic('idle');
    }
    this.resolveMicWaiters(true);
  }

  /** 下发控制串并记进档案：每次下发都能在时间线上对到当时的音频位置 */
  private sendControl(text: string): void {
    this.archive?.event(EVENTS.ctlSend, { text });
    this.conn.sendControl(text);
  }

  // ------------------------------------------------------------------ 开麦

  /** 开麦相位。唯一写入点是 {@link enterMic}。 */
  private micPhase: MicPhase = 'idle';
  /**
   * 相位代次。每次真正迁出一格就 +1。
   *
   * 宽限定时器和等麦超时都抓住自己登记时的代次：恢复时对不上，
   * 或已经停在 `closed`，这次回调作废。
   */
  private micEpoch = 0;
  /** `end_session` 已发出、socket 还没关。这段时间拒绝 `listen.start`。 */
  private linkClosing = false;
  /** 等首帧上行的人。参数是「麦开了没有」。 */
  private micWaiters: Array<(opened: boolean) => void> = [];

  /**
   * 连接就绪后观察「设备到底在不在采集」的定时器。
   *
   * 到期时还没收到任何上行音频，才发 `listen.start` 把它拉起来。收到帧就取消
   * （说明设备已经在推流，不需要唤醒 —— 重连场景多半是这样）。
   */
  private captureWatch: NodeJS.Timeout | null = null;
  /** `end_session` 之后那 250 ms 的延迟关闭。`onClose` 必须清掉，不能悬空。 */
  private endSessionTimer: NodeJS.Timeout | null = null;

  /** 开麦相位的唯一写入点。非法迁移打日志并保持原状。`closed` 是吸收态。 */
  private enterMic(next: MicPhase): boolean {
    if (this.micPhase === next) {
      return true;
    }
    if (!canEnterMic(this.micPhase, next)) {
      console.error(`  开麦    拒绝 ${this.micPhase} → ${next}`);
      return false;
    }
    this.micPhase = next;
    this.micEpoch += 1;
    return true;
  }

  private clearCaptureWatch(): void {
    if (this.captureWatch !== null) {
      clearTimeout(this.captureWatch);
      this.captureWatch = null;
    }
  }

  private clearEndSessionTimer(): void {
    if (this.endSessionTimer !== null) {
      clearTimeout(this.endSessionTimer);
      this.endSessionTimer = null;
    }
  }

  /**
   * 开始等设备的第一帧上行音频。
   *
   * 为什么不是"连接就绪就开麦"：那样每次网络抖动重连都会唤醒眼镜（亮灯、耗电、
   * 可能还有提示音），而那一刻根本没人在说话。
   *
   * 为什么不干脆"重连就跳过"：设备侧的 Aivs 会话可能已经自毁（真机 `会话状态 3`
   * 后采集停止），那种情况下不唤醒就是「未响应」。
   *
   * 判据只能是设备有没有在推流 —— 等 {@link CAPTURE_GRACE_MS} 看有没有帧；
   * 到期要不要开麦交给 {@link shouldWakeOnReady}（它还看佩戴）。
   */
  private armCaptureWatch(resumed: boolean): void {
    if (this.listenStartBlocked() || !this.enterMic('watching')) {
      return;
    }
    const epoch = this.micEpoch;
    const why = resumed ? '自动重连' : '连接就绪';
    this.captureWatch = setTimeout(() => {
      this.captureWatch = null;
      // 代次或相位变了（已开、已关、已经在开）就别再补一发 listen.start
      if (this.micEpoch !== epoch || this.micPhase !== 'watching' || this.listenStartBlocked()) {
        return;
      }
      if (!shouldWakeOnReady({
        hasAudio: false, // 收到帧时 watch 已被 onFrame 取消，走到这里就是没帧
        wearing: this.wearing,
        closed: this.conn.isClosed || this.linkClosing,
        // 能走到这里相位仍是 watching；opening 已在上面返回
        micPending: false,
      })) {
        if (this.wearing === false) {
          console.log(`  开麦    ${why}且 ${CAPTURE_GRACE_MS} ms 无上行音频，但设备未佩戴 → 不唤醒`);
        }
        return;
      }
      console.log(`  开麦    ${why}但 ${CAPTURE_GRACE_MS} ms 内没有上行音频 → 请设备推流（§42）`);
      this.sendListenStart();
    }, CAPTURE_GRACE_MS);
    this.captureWatch.unref?.();
  }

  /**
   * 发一次 `listen.start`。
   *
   * 只有 {@link sendCall} 返回 true 才进入 `opening`。发送失败留在原相位，
   * 不能卡死在 `opening`。
   */
  private sendListenStart(): void {
    if (this.listenStartBlocked()) {
      return;
    }
    this.sendCall({ op: 'listen.start', maxMs: INITIAL_LISTEN_MS });
  }

  private resolveMicWaiters(opened: boolean): void {
    const waiters = this.micWaiters;
    this.micWaiters = [];
    for (const resolve of waiters) {
      resolve(opened);
    }
  }

  /**
   * 有效上行音频。
   *
   * 只在 `watching` / `opening` 时算一次：已经 `open` 的后续帧属于对话层，
   * `listen.stop` 回到 `idle` 之后再来的音频也不算「这一轮开麦成功」。
   * 空载荷不是证据。
   */
  private noteUplinkAudio(payload: Buffer): void {
    if (payload.length === 0) {
      return;
    }
    if (this.micPhase !== 'watching' && this.micPhase !== 'opening') {
      return;
    }
    const armed = this.captureWatch !== null;
    this.clearCaptureWatch();
    if (armed) {
      console.log('  开麦    设备已在推流 → 不主动唤醒');
    }
    if (!this.enterMic('open')) {
      return;
    }
    this.archive?.event(EVENTS.micOpened);
    this.resolveMicWaiters(true);
    this.app?.micOpened();
  }

  /**
   * 等麦开，最多 `timeoutMs`。
   *
   * 播报用（ADR-0001 §6）：设备支持 `listen.start` 时，播报也先开麦再开口，
   * 这样播报一开口就能被插话；超时照播。连接收尾时立刻以 `false` 醒来，
   * 不再耗满 `micOpenTimeoutMs`。
   */
  private awaitMicOpen(timeoutMs: number): Promise<boolean> {
    if (this.micPhase === 'open') {
      return Promise.resolve(true);
    }
    if (this.micPhase !== 'opening') {
      return Promise.resolve(false);
    }
    const epoch = this.micEpoch;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (opened: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancel();
        resolve(opened);
      };
      const cancel = this.clock.after(timeoutMs, () => {
        // 成功由 noteUplinkAudio 同步叫醒并取消这个定时器。
        // 走到这里只有两种情况，都是「这次没开成」：
        // 代次已经离开当时那次 opening，或者还停在 opening 但等到了超时。
        if (this.micEpoch !== epoch || this.micPhase !== 'opening') {
          finish(false);
          return;
        }
        finish(false);
      });
      this.micWaiters.push((opened) => {
        // 显式叫醒以参数为准。closed 是吸收态，迟到的 true 也不许报开麦成功。
        finish(this.micPhase === 'closed' ? false : opened);
      });
    });
  }

  /** 工具口拍照用的序号，保证 `id` 在一条连接内唯一 */
  private toolSeq = 0;

  /** 工具口的拍照请求：要的意图没有就退到另一档。 */
  private async requestToolCapture(want: CaptureIntent): Promise<PhotoOutcome> {
    const other: CaptureIntent = want === 'glance' ? 'detail' : 'glance';
    const intent = captureMode(this.caps, want) !== null ? want : other;
    const mode = captureMode(this.caps, intent);
    if (mode === null) {
      return { ok: false, failure: { code: 'unsupported' } };
    }
    this.toolSeq += 1;
    const request: CaptureRequest = { id: `tool-${this.toolSeq}`, intent, needsUser: mode.needsUser };
    try {
      return await this.photos.request(request);
    } finally {
      this.v1?.forget(request.id);
    }
  }

  /**
   * 后台任务完成 → 播报。
   *
   * 排队、让位、开麦的顺序都在 `app/dialog.ts`（与模拟器同一份实现），
   * 这里只记档并把话交进去。
   */
  private onAnnounce(speech: string, emotion?: string): void {
    this.archive?.event(EVENTS.announce, { len: speech.length, emotion });
    this.dialog.enqueueAnnounce(speech, emotion);
  }

  /**
   * Pure Live 后台任务完成 → 播报空窗。
   *
   * 有 `verbatim` 时必须逐字念（精确数字 / 端口 / 长报告），否则念 `summary`。
   */
  private onTaskReport(report: BackgroundTaskReport): void {
    this.archive?.event(EVENTS.announce, {
      len: report.summary.length,
      emotion: report.emotion,
      source: report.source,
      verbatim: report.verbatim !== undefined,
    });
    this.dialog.enqueueAnnounce({
      speech: report.verbatim ?? report.summary,
      emotion: report.emotion,
      taskId: report.taskId,
      query: report.query,
      verbatim: report.verbatim !== undefined,
      needsConfirm: report.needsConfirm,
    });
  }

  /**
   * 被新连接顶掉：主动断开自己。
   *
   * 只 `end()` 连接，**不直接跑收尾** —— 收尾要等对端真的关（`onClose`），
   * 那时才能保证「先断开、再清槽」的顺序；这里直接清槽会让新旧两条交叠。
   */
  evict(): void {
    this.linkClosing = true;
    console.log(`  连接    被新连接接管，断开旧连接 ${this.conn.remote}`);
    this.conn.end();
  }

  /**
   * 这条连接还是不是**当前活跃的那一条**。
   *
   * 判据只有一条：服务级活跃槽里是不是自己。旧连接被顶掉之后仍要走完自己的收尾
   * （TTS / ASR / 档案都要关），但**不许动共享槽** —— `attachAudioLane` /
   * `setAnnouncer` / `setTaskReporter` / `setDelegateHook` / `setAudit` /
   * `ToolControl` 此刻都归新连接。
   * 弱网重连时「旧连接晚于新连接断开」是常态，不判所有权就会把新连接的东西摘掉。
   */
  private isActiveOwner(): boolean {
    return this.service.activeSlot.current === this;
  }

  private onClose(): void {
    // 立刻吸收开麦：不等宽限、也不等 micOpenTimeoutMs。等麦的人拿到 false。
    this.linkClosing = true;
    this.enterMic('closed');
    this.clearCaptureWatch();
    this.clearEndSessionTimer();
    this.resolveMicWaiters(false);

    // 这条连接还是不是「当前那条」——**整段收尾**都按这一份快照判断。
    // 活跃槽要等收尾结束才清：`DialogRuntime.dispose()`（在 `app.dispose()` 里）
    // 也要拿 `isActiveOwner()` 决定摘不摘回执钩子，提前清掉它就变成「旧连接」了。
    const owner = this.isActiveOwner();
    // 控制口是服务级的，**不关**：只把 handlers 摘回「没有设备」，而且必须带令牌 ——
    // 新连接可能已经接管了控制口（无令牌的 `null` 会让 MCP 拍照从此 503）。
    if (this.toolHandlers !== null) {
      this.service.control.setHandlers(null, this.toolHandlers);
    }
    // 先摘车道和播报出口：留一条死连接在上面会让下一条认领到永远不会完成的 response。
    // 但**只摘自己的**。旧连接迟到收尾不许摘新连接的。
    if (owner) {
      this.options.agent.attachAudioLane?.(null);
      this.options.agent.setAnnouncer?.(null);
      this.options.agent.setTaskReporter?.(null);
    }
    // 吸收序：先停上行，再拆还在吃音频的人。`closed` 必须在 `app.dispose()`
    // 之后仍能发出（端口不许在 dispose 里摘掉），所以 dispatch 放在这六步之后。
    this.uplink.end();
    this.assembler.dispose();
    this.app?.close();
    this.app?.dispose();
    this.omni?.stop();
    this.stt.close();
    console.log(`\n连接结束，${this.core.turn} 轮`);
    this.dialog.dispatch({ type: 'closed' });
    // 收件箱里还有等待者的话，定时器会拖住进程（不必再下发 hq_cancel：连接都断了）
    // 这里的 `dispose()` 已经是个 no-op（`app.dispose()` 里调过一次），回执钩子那一步
    // 同样走 `isActiveOwner()` 守卫。
    this.dialog.dispose();
    // 只有自己建的那份才销毁：共享侧车由进程持有，断开就 stop 等于每次重连都
    // 重新加载 ONNX（实测 ~300 ms，第一句白吃）
    if (this.ownsTurnJudge) {
      this.turnJudge?.stop();
    }
    // 先摘审计出口再关档案：否则最后一批 `agent.done` 会写进已关闭的档案。
    // 两道保护都要：令牌让**槽**认出「这是我挂的那份」，`owner` 让**旧连接根本不发**
    // 这趟调用 —— 装配方（`main.ts`）若还是 1 参回调、把令牌丢了，无令牌的 `null`
    // 会把新连接的档案出口清掉，而那一条在线上只表现为「审计事件莫名其妙全没了」。
    if (owner) {
      this.options.setAudit?.(null, this.auditSink);
    }
    this.archive?.close();
    // **最后**才清槽；旧连接的迟到收尾走到这里时槽里已经是新连接，不动它。
    if (owner) {
      this.service.activeSlot.current = null;
    }
  }

  // ------------------------------------------------------------------ 事件

  private onPartial(text: string, commitSeq?: number): void {
    console.log(`  … ${text}`);
    this.archive?.event(EVENTS.asrPartial, { text });
    // 插话的**声学**闸：服务端会把同一截缓冲再解一遍，在尾静音上吐 `Thank you`，
    // 它一旦 ≥2 个字就把正在播的回答整条掐掉（真机两次各丢一整条答案）。
    // 判据不是语种、不是音量、也不是「距上次有声多久」，而是
    // **这一段定稿之后还有没有新的声音** —— 见 `barge-voicing.ts`（8 份档案 17 次
    // 插话逐条压过：3/3 幻觉拦下、13/13 真话放行）。
    if (this.dialog.core.fsm.state === 'speaking' && this.gatedByVoicing()) {
      console.log(`  … ${text}（这段已出过定稿、之后没有新声音 → 重复解码，不算插话）`);
      return;
    }
    // **开轮前录的那一段**由内核挡（`SessionCore` → `kernel.ts::isPreTurnCommit`，
    // 全仓唯一的因果屏障）：产出它的 commit 早于开轮时刻，说明这些音频是在我们
    // 出声之前录的 —— 那不可能真是插话，是我们抢在用户说完之前开了口。
    // 真机 `20261123-053719` 第 2 轮：开轮 71 ms 后 `置身吗` 到达，被当成插话，
    // dsh 那份**完全正确**的答案 `audio_s=0.00` 没了。
    const genBefore = this.core.fsm.gen;
    const effects = this.dialog.dispatch({
      type: 'partial',
      text,
      ...(commitSeq === undefined ? {} : { commitSeq }),
    });
    // 被内核丢掉时**什么都不许碰**：不进装配器（否则记成「用户还在说」）、
    // 不收宠物话筒、也不打断旁白 —— 它压根不是这一轮的话。
    if (effects.some((effect) => effect.type === 'drop' && effect.why === 'pre-turn')) {
      console.log(`  … ${text}（开轮前录的那段还在解 → 不算插话）`);
      return;
    }
    // 判停的**文本判据**：中间结果在出 = 用户还在说。只传信号不拼文本，
    // 中间结果会反复改写，拼起来是乱的。
    this.assembler.notePartial(text);
    // 用户已经开口了，「嗯，我看看」这种回执就没必要了
    // 宠物要在**用户刚开口**就收手，不能等到这句话定稿
    this.app?.userPartial();
    // 代次变了 = 内核真的判了插话（`audio.stop` 由 `KernelPorts.stopDeviceAudio` 执行，
    // 这里不再另找那个效果 —— 两处各判一遍迟早漂）。
    if (this.core.fsm.gen !== genBefore) {
      console.log('  打断    听到识别结果 → 停止播放，已排队的轮次作废');
    }
  }

  /**
   * 这段转写是不是「同一截缓冲的重复解码」。
   *
   * 判据见 `barge-voicing.ts`。时钟接错时**报一次** —— 那一版闸会静默失效
   * （`20261123-051448` 第 4 轮被 `Okay` 打断就是这么漏的），不报等于没有仪表。
   */
  private gatedByVoicing(): boolean {
    const verdict = voicingVerdict(this.assembler.lastVoicedAtMs, this.lastSentenceAtMs);
    if (verdict === 'clock-mismatch' && !this.clockMismatchLogged) {
      this.clockMismatchLogged = true;
      console.error(
        '  ✗ 插话闸   两把时钟不同源'
        + `（有声 ${this.assembler.lastVoicedAtMs} / 定稿 ${this.lastSentenceAtMs}）`
        + ' → 闸失效，检查 UtteranceAssembler 的 now',
      );
    }
    return verdict === 'silent';
  }

  private onSentence(text: string, index: number, commitSeq?: number): void {
    console.log(`  句 ${index}  ${JSON.stringify(text)}`);
    this.archive?.event(EVENTS.asrSentence, { text, index });
    // 解码窗口结束（`.completed` 回来了）—— 这是**事实**，与「这段文本用不用」
    // 无关，所以放在所有丢弃判据之前。共享内核据此放掉 `awaitingDecode`；
    // 迟到的 `.completed` 由内核按 `commitSeq` 比较挡掉，不会抹掉更新的那一发。
    if (commitSeq !== undefined) {
      this.core.runtime.dispatch({ type: 'decodeSettled', commitSeq });
    }
    // 上面那句已经出过结论、之后一直没人说话 → 这一条是同一截缓冲的重复解码。
    // 它既不该打断播放，也不该开一轮（真机档案里 `Okay.` / `对。` / `好。` 共 13 条，
    // 底下一条有声帧都没有；回放里它们每个都会开出一轮「答无可答」的轮次，
    // 直接把 omni 车道撞成 `lane.fallback`）。
    // 真人说「对。」必然带新的有声帧，所以这条不会误杀确认。
    if (this.gatedByVoicing()) {
      console.log(`  句 ${index}  ↳ 定稿之后没有新声音 → 重复解码，丢弃`);
      return;
    }
    // **开轮前录的那一段**的判据只在内核里有一份（`kernel.ts::isPreTurnCommit`，
    // 全仓唯一的因果屏障）：它的音频早于这一轮，定稿回来时拿去「插话」就是自己掐自己。
    // 这里连开轮都不开 —— 用户下一句会重新说到它。
    const genBefore = this.core.fsm.gen;
    const effects = this.dialog.dispatch({
      type: 'sentence',
      text,
      ...(commitSeq === undefined ? {} : { commitSeq }),
    });
    if (effects.some((effect) => effect.type === 'drop' && effect.why === 'pre-turn')) {
      console.log(`  句 ${index}  ↳ 开轮前录的那段定稿 → 不当插话，也不开轮`);
      this.archive?.event(EVENTS.asrSentence, { text, index, dropped: 'pre-turn' });
      return;
    }
    // 后面的 partial 拿它当「上一句」：这之后还有没有新的有声帧，决定那些 partial
    // 是真插话还是重复解码（见 `barge-voicing.ts`）
    this.lastSentenceAtMs = this.assemblerNow();
    // 打断有两处入口（中间结果 / 定稿），日志必须都打 —— 否则统计打断率会漏掉
    // 「短促插话只出定稿」那一半，真机上就是 4 次里少记 1 次。
    if (this.core.fsm.gen !== genBefore) {
      console.log('  打断    听到定稿 → 停止播放，已排队的轮次作废');
    }
  }

  private onAsrError(error: Error): void {
    this.archive?.event(EVENTS.asrError, { message: error.message.slice(0, 200) });
    // 空闲挂断是预期行为（网关对「没听到有效语音」的连接 10 s 就踢），
    // 不是故障，不要用 ✗ 污染日志。
    if (error.message.includes('IDLE_TIMEOUT')) {
      console.log('  [asr] 空闲挂断（无有效语音，正常）');
      return;
    }
    console.error(`  ✗ ASR: ${error.message}`);
  }

  private onWake(payload: Buffer): void {
    const [transactionId = '', requestId = ''] = payload.toString('utf8').split('\n');
    this.archive?.event(EVENTS.wake, { transactionId, requestId: requestId.slice(0, 8) });
    console.log(
      `  唤醒    transactionId=${transactionId}  requestId=${requestId.slice(0, 8)}…`,
    );
  }

  // ------------------------------------------------------------------ 宠物环

  /**
   * 把应用层装到本连接上。**这里只有接线，没有判断**。
   *
   * 四个端口各对应一件已经存在的事：
   * - `Clock`：`SystemClock`（心跳也在 `AppSession` 里，这里不再自己开定时器）
   * - `Device`：`capture` 走收件箱（要等图），其余直接下发原语
   * - `Agent`：措辞由 `petPrompt` 拼，模型只负责说
   * - `Voice`：旁白通道（`speakCanned`），`stop` 就是 `cancelCanned`
   */
  private createAppSession(
    proactive: VoiceSessionOptions['proactive'],
    dialog: DialogRuntime,
  ): AppSession {
    return new AppSession({
      clock: this.clock,
      caps: this.caps,
      dialog,
      pet: proactive !== undefined && proactive !== null,
      ...(proactive?.tickMs === undefined ? {} : { tickMs: proactive.tickMs }),
      device: {
        call: (call) => {
          if (call.op === 'capture') {
            void this.photos.request({ id: call.id, intent: call.intent, needsUser: false })
              .then((outcome) => {
                this.app?.image(call.id, outcome.ok
                  ? { mimeType: 'image/jpeg', data: outcome.jpeg.toString('base64') }
                  : null);
              })
              .catch((error: Error) => {
                console.error(`  ✗ 宠物拍照失败: ${error.message}`);
                this.app?.image(call.id, null);
              })
              // 这一趟结束了（成功也算）：v1 垫片里它是"在途 glance"，
              // 不清掉的话之后用户自己拍的图都会被当成它的迟到图吃掉
              .finally(() => { this.v1?.forget(call.id); });
            return;
          }
          if (call.op === 'capture.cancel') {
            this.photos.cancel('宠物不再需要这张图');
            return;
          }
          this.sendCall(call);
        },
      },
      agent: {
        ask: async (context, image): Promise<PetReply> => {
          const attachment: ImageAttachment | undefined = image === null
            ? undefined
            : { mimeType: image.mimeType as ImageAttachment['mimeType'], data: image.data };
          const view = await this.options.agent.reply(petPrompt(context, image !== null), attachment);
          const text = view.speech.trim();
          return text === ''
            ? { text: '' }
            : { text, emotion: view.emotion as PetReply['emotion'] };
        },
      },
      voice: {
        speak: async (text, emotion, signal) => {
          let aborted = false;
          const onAbort = (): void => {
            aborted = true;
            this.runner.cancelCanned();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            await this.runner.speakCanned(text, emotion ?? undefined);
          } catch (error) {
            console.error(`  ✗ 宠物朗读失败: ${(error as Error).message}`);
            return 'cut';
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
          return aborted ? 'cut' : 'done';
        },
        stop: () => { this.runner.cancelCanned(); },
      },
      ...(proactive?.params === undefined && proactive?.listenMs === undefined
        ? {}
        : {
          params: {
            ...proactive?.params,
            ...(proactive?.listenMs === undefined ? {} : { listenMs: proactive.listenMs }),
          },
        }),
      onEvent: (name, fields) => {
        // 输入/意图里可能带 JPEG（base64），落盘前压成字节数
        this.archive?.event(name, summarizePetEvent(name, fields));
      },
      dismissAnnounce: () => {
        // 敲击关播报：清掉队列并停掉正在播的那条
        this.dialog.clearAnnounce();
      },
      // **带上连接标签**：一副眼镜一条宠物，日志里必须能分辨是谁在说话。
      // 不加的话两条连接的心跳会互相穿插成 `[闲置]` / `[compose #1]` 来回跳，
      // 看着像状态机错乱，其实是两个独立实例。
      log: (line) => { console.log(`  [${this.link.label}] ${line}`); },
    });
  }

}
