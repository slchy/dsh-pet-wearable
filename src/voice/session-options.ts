/**
 * 一条语音连接的配置，以及进程里只该有一份的共用件。
 *
 * 浏览器宿主、CLI、评测服务都从这里拿同一份选项形状。
 */
import type { AnnounceItem } from '../app/dialog.ts';
import type { AnnounceStore } from '../announce-store.ts';
import type { FastVoiceEngine } from '../engine-contract.ts';
import type { OmniShadowOptions } from '../omni-shadow.ts';
import type { VoicePipelineMode } from '../pipeline-mode.ts';
import type { PetParams } from '../pet/brain/registry.ts';
import type {
  AgentAudioAnswer,
  AgentProvider,
  RealtimeUplinkLane,
  SttProvider,
  TtsProvider,
} from '../providers.ts';
import type { RealtimeSocketFactory } from '../qwen-realtime-asr.ts';
import type { RealtimeDialect } from '../realtime-dialect.ts';
import type { SemanticEndpoint } from '../semantic-endpoint.ts';
import type { ToolControl } from '../tool-control.ts';
import type { HelloInfo } from '../transport.ts';
import type { PetUiEvent } from '../ui-events.ts';
import type { SharedSpeechVad } from '../vad.ts';
import type { EndpointDetector } from './endpoint-wire.ts';
import type { VoiceConnection } from './connection.ts';

/** 上行采样率：mSBC 解码后固定 16 kHz */
export const UPSTREAM_SAMPLE_RATE = 16_000;

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
  /** TurnJudge 声学判停参数；不给则不启用，退回固定合并窗口 */
  readonly turnJudge?: {
    /** 声学判停（Smart Turn v3.2）模型路径；缺省时连接层按环境变量再找一次 */
    readonly modelPath?: string;
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
   * 给了就用它，并且**不随连接销毁** —— 声学判停模型是 8.7 MB ONNX，冷启动实测
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
    readonly url?: string;
    /** 协议方言（`dashscope` | `openai-beta` | `openai-ga`）；缺省按 URL 推断，默认 `dashscope` */
    readonly dialect?: RealtimeDialect;
    /** 输出音色；空白不传 */
    readonly voice?: string;
    /** 输入音频转写模型名；缺省按方言默认 */
    readonly asrModel?: string;
    /** 附加握手请求头 */
    readonly extraHeaders?: Readonly<Record<string, string>>;
    /** 认领模式：`off`（只量）/ `full`（真答）。缺省 `off` */
    readonly serve?: 'off' | 'full';
    /** 测试注入 realtime 套接字；生产不传，行为与以前一致 */
    readonly socketFactory?: RealtimeSocketFactory;
    /** 可选覆盖车道工厂（缺省为 `new OmniShadow(opts)`），方便替换任意兼容 `RealtimeUplinkLane` 的实现 */
    readonly createLane?: (opts: OmniShadowOptions) => RealtimeUplinkLane;
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
  /**
   * 厂商中立的实时语音车道端口工厂（优先级高于 `omniShadow`）。
   * 任何实现 {@link RealtimeUplinkLane} 的协议适配器均可借此接入连接层，无需改动 `VoiceConnection`。
   */
  readonly realtimeLane?: {
    readonly serve?: 'off' | 'full';
    readonly create: (hooks: {
      readonly emit: (data: Record<string, unknown>) => void;
      readonly log: (line: string) => void;
    }) => RealtimeUplinkLane;
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
  /**
   * 出队前检查这条后台汇报是否已经不用再说（前台代播 / 已播报 / 已取消）。
   * Pure Live 接 `LiveOrchestrator.shouldSkipBackgroundReport()`，避免双讲。
   */
  readonly shouldSkipAnnounce?: (item: AnnounceItem) => boolean;
  /** 插话/双击时同步掐断正在播的 Omni 后台汇报 */
  readonly cancelAnnounce?: () => void;
  /** 当某条后台汇报退回 TTS 播完后通知上层（用于静默回注 Omni 上下文） */
  readonly onFallbackAnnounceSpoken?: (item: AnnounceItem, interrupted: boolean) => void;
  /** 上行增益（喂给 STT 前放大；眼镜 mic 电平偏低） */
  readonly micGain?: number;
  /** 电平表周期（毫秒）；> 0 时每这么久打一行上行峰值，调增益用 */
  readonly levelLogMs?: number;
  /**
   * 进程级共享的神经 VAD。缺省或 `null` 时这条连接用能量门。
   * 每条连接自己 `createStream()`，不共用 LSTM 状态。
   */
  readonly vad?: SharedSpeechVad | null;
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
    /**
     * 开轮静音的统一上限（ms）。没有声学判停器时，手动端点仍把这一份交给组装器，
     * 见 `UtteranceAssemblerOptions.maxOpenSilenceMs`。`0` 表示不设上限。
     */
    readonly maxOpenSilenceMs?: number;
    /**
     * 本段有效有声不足这么久，不封段、不投机、不预跑。
     * 缺省不传给装配器，装配器按 0 处理（短合成仍能封段）。
     */
    readonly minSpeechMs?: number;
    /**
     * 喂给 ASR 与 Omni 的预卷尾窗。小于 `prerollMs` 时从尾部裁；
     * 缺省或大于等于 `prerollMs` 时不裁。TurnJudge 仍吃完整预卷。
     */
    readonly asrPrerollMs?: number;
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

  /**
   * 浏览器浮层遥测。缺省时不发事件，CLI / 真机的协议与行为不变。
   *
   * 同一份配置给 `runVoiceServer` 和每条 `VoiceConnection`。监听器抛错会被吞掉。
   */
  readonly onUiEvent?: (ev: PetUiEvent) => void;
}

/**
 * `runVoiceServer` 的入参。与 {@link VoiceSessionOptions} 是同一类型
 * （浏览器宿主沿用这个名字）。
 */
export type VoiceServerOptions = VoiceSessionOptions;

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
