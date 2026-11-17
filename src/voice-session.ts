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
import type { AnnounceStore } from './announce-store.ts';
import { EVENTS } from './events.ts';
import { performance } from 'node:perf_hooks';

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
import { DialogRuntime } from './app/dialog.ts';
import { SystemClock, type Clock } from './app/clock.ts';
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
import type { AgentProvider, SttProvider, SttSession, TtsProvider } from './providers.ts';
import type { SessionCore } from './session-core.ts';
import type { ImageAttachment } from './session.ts';
import { SmartTurn } from './smart-turn.ts';
import { startToolControl, type ToolControl } from './tool-control.ts';
import { runTransport, type Connection, type HelloInfo } from './transport.ts';
import { TurnRunner } from './turn-runner.ts';
import { UplinkPipeline } from './uplink-pipeline.ts';
import { UtteranceAssembler } from './utterance-assembler.ts';

/** 上行采样率：mSBC 解码后固定 16 kHz */
export const UPSTREAM_SAMPLE_RATE = 16_000;

/**
 * 判停器的最小接口（`SmartTurn` 满足它）。
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
  options: { readonly smartTurn?: object; readonly smartTurnClient?: EndpointDetector },
  create: () => EndpointDetector,
  log: (line: string) => void,
): { readonly client: EndpointDetector | null; readonly owned: boolean } {
  if (options.smartTurnClient !== undefined) {
    if (options.smartTurn === undefined) {
      log('  判停    ⚠ 给了共享判停器但没有参数表（quietMs 等），会按 0 处理');
    }
    return { client: options.smartTurnClient, owned: false };
  }
  if (options.smartTurn === undefined) {
    return { client: null, owned: false };
  }
  return { client: create(), owned: true };
}

/**
 * 没有判停器（SmartTurn 关掉）时的固定合并窗口。
 *
 * 旧行为：收到一句 ASR 就再等 600 ms 看有没有下文，没有就定稿。
 */
const ASSEMBLER_FALLBACK_WINDOW_MS = 600;

/**
 * 判停请求提前多久发起（与静候窗 `SMART_TURN_QUIET_MS` 重叠）。
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
 * 送给判停器的「最近音频」上限（秒）。
 *
 * 判停器要听到整句话的尾巴才能判「说完了」，8 s 足够覆盖常见的一句话，
 * 又不至于把整段对话都留在内存里。
 */
const ASSEMBLER_RECENT_SECONDS = 8;

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
  /** Smart Turn 判停器；缺任一项则不启用，退回固定合并窗口 */
  readonly smartTurn?: {
    readonly pythonPath: string;
    readonly scriptPath: string;
    readonly quietMs: number;
    readonly extendMs: number;
    readonly maxExtensions: number;
    /** 「判停说没说完」单独的上限，见 `UtteranceAssemblerOptions.maxUnsureExtensions` */
    readonly maxUnsureExtensions?: number;
    readonly threshold: number;
    /** 结尾「像没说完」时再多等一拍，见 `UtteranceAssemblerOptions.unfinishedWaitMs` */
    readonly unfinishedWaitMs?: number;
    /**
     * 判停器说「说完了」后，若这么久内还收到过中间结果就再等一拍，
     * 见 `UtteranceAssemblerOptions.partialGraceMs`。
     */
    readonly partialGraceMs?: number;
  };
  /**
   * 进程级共享的判停器客户端。
   *
   * 给了就用它，并且**不随连接销毁** —— 侧车是 python + 8.7 MB ONNX，冷启动实测
   * ~300 ms，而真机每次重连（网络抖动 / 服务重启 / 重开 App）第一句都要付这一刀。
   * 常驻之后只有进程启动付一次。
   *
   * 与 {@link smartTurn} 一起给（后者提供静默窗等参数）；只给这个不给参数表是
   * 配置错误，会退化成 `quietMs: 0`。
   */
  readonly smartTurnClient?: EndpointDetector;
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
}

/**
 * 启动监听，按连接串行处理。返回进程退出码。
 *
 * 监听、鉴权、心跳、TLS 全在 `transport.ts`；这里只决定「一条连接里谁来干活」。
 */
export async function runVoiceServer(options: VoiceSessionOptions): Promise<number> {
  return await runTransport({
    port: options.port,
    host: options.host,
    tls: options.tls,
    authenticate: options.authenticate,
    idleTimeoutMs: options.idleTimeoutMs,
    singleConnection: options.serve !== true,
    log: (line) => { console.log(line); },
    onConnection: (conn) => { handshake(conn, options); },
  });
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
function handshake(conn: Connection, options: VoiceSessionOptions): void {
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
    new VoiceConnection(conn, options, link).start(first, hello?.resumed === true);
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

/** 一条连接的完整状态：只负责把各模块接起来。 */
class VoiceConnection {
  private readonly conn: Connection;
  private readonly options: VoiceSessionOptions;
  private readonly link: DeviceLink;
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
  /** 上行编码由能力集决定；档案与解码都要它 */
  private readonly uplinkCodec: 'msbc' | 'pcm16';

  private readonly dialog: DialogRuntime;
  private readonly uplink: UplinkPipeline;
  private readonly smartTurn: EndpointDetector | null;
  /** 判停器是不是这条连接自己的（自己建的在断开时必须销毁，共享的不许） */
  private readonly ownsSmartTurn: boolean;
  private readonly assembler: UtteranceAssembler;
  private readonly stt: SttSession;

  private control: ToolControl | null = null;

  /** 原始档案（`MIAI_ARCHIVE_DIR` 为空时是 null） */
  private readonly archive: SessionArchive | null;

  constructor(conn: Connection, options: VoiceSessionOptions, link: DeviceLink) {
    this.conn = conn;
    this.options = options;

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
      caps: this.caps,
      agent: options.agent,
      tts: options.tts,
      downlink: conn,
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
          this.conn.sendControl('end_session');
          setTimeout(() => { this.conn.end(); }, 250).unref?.();
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

    const smartTurnOptions = options.smartTurn;
    const detector = resolveEndpointDetector(
      options,
      () => new SmartTurn({
        python: smartTurnOptions!.pythonPath,
        script: smartTurnOptions!.scriptPath,
        log: (line) => { console.log(`  ${line}`); },
      }),
      (line) => { console.log(line); },
    );
    this.smartTurn = detector.client;
    this.ownsSmartTurn = detector.owned;

    this.assembler = new UtteranceAssembler({
      quietMs: smartTurnOptions?.quietMs ?? 0,
      extendMs: smartTurnOptions?.extendMs ?? 0,
      maxExtensions: smartTurnOptions?.maxExtensions ?? 0,
      ...(smartTurnOptions?.maxUnsureExtensions === undefined
        ? {}
        : { maxUnsureExtensions: smartTurnOptions.maxUnsureExtensions }),
      fallbackWindowMs: ASSEMBLER_FALLBACK_WINDOW_MS,
      threshold: smartTurnOptions?.threshold ?? 1,
      ...(smartTurnOptions?.unfinishedWaitMs === undefined
        ? {}
        : { unfinishedWaitMs: smartTurnOptions.unfinishedWaitMs }),
      ...(smartTurnOptions?.partialGraceMs === undefined
        ? {}
        : { partialGraceMs: smartTurnOptions.partialGraceMs }),
      recentMaxBytes: UPSTREAM_SAMPLE_RATE * 2 * ASSEMBLER_RECENT_SECONDS,
      // 判停的每次决定都落档：`② 定稿→开轮` 在档案里一直是黑盒，1 ms 和 2400 ms
      // 都可以是这个数，不看 p 分不清「判停不敢收」和「排队」。
      onJudge: (fact) => { this.archive?.event(EVENTS.judge, { ...fact }); },
      predict: this.smartTurn
        ? (pcm: Buffer) => this.smartTurn!.predict(pcm)
        : undefined,
      // 只在有判停器时才有意义（没有判停器就走固定窗口，没有往返可叠）
      ...(this.smartTurn ? { predictAtMs: ASSEMBLER_PREDICT_LEAD_MS } : {}),
      // 静音一到就把判停跑掉，和 ASR 那 200 ms 静音窗并行 —— 出句时概率已经算好。
      // 门槛用能量门那个（同一路放大后的波形、同一套设备标定）。
      silenceDb: options.gate.thresholdDbfs,
      ...(options.gate.pauseDetectMs === undefined || options.gate.pauseDetectMs <= 0
        ? {}
        : { silencePauseMs: options.gate.pauseDetectMs }),
      // 投机比判停更早（默认 100 ms）：猜错了作废就是，问晚了白等
      ...(options.gate.speculateMs === undefined || options.gate.speculateMs <= 0
        ? {}
        : { speculateMs: options.gate.speculateMs }),
      onUtterance: (text) => {
        this.app?.userFinal(text);
        console.log('\n--- 本轮 ---');
        console.log(`  文本    ${JSON.stringify(text)}`);
        this.dialog.dispatch({ type: 'utterance', text });
      },
      // 句子定稿那一刻就让快车道起跑，把判停那一拍从关键路径上挪走。
      // 判停若并了下一段，组装器会拿更长的文本再调一次；认领时按文本比对。
      onSentence: (text) => {
        this.options.agent.prefetch?.(text);
      },
      // 中间结果投机：比定稿再往前提 p50 731 ms（真机 47 轮）。文本是猜的，
      // 定稿确认是前缀才认领 —— 认不了就作废，退回上面那条路，等于没做。
      onPartial: (text) => {
        this.options.agent.speculatePartial?.(text);
      },
      log,
    });

    this.stt = options.stt.open({
      onPartial: (text) => { this.onPartial(text); },
      onSentence: (text, index) => { this.onSentence(text, index); },
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
      log,
      onError: (line) => { console.error(`[ffmpeg] ${line}`); },
      onRawPcm: (raw) => { this.archive?.pcmRaw(raw); },
      onPcm: (pcm) => {
        // 判停器要看音频本身，不只是文本
        this.assembler.addAudio(pcm);
      },
      onSpeechOpen: (peakDbfs, preroll, prerollMs) => {
        this.archive?.event(EVENTS.gateOpen, { peakDbfs: Number(peakDbfs.toFixed(1)), prerollMs });
        for (const part of preroll) {
          this.stt.feed(part);
        }
      },
      onSpeech: (pcm) => { this.stt.feed(pcm); },
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

    // 后台任务完成后的播报落在这条连接上
    this.options.agent.setAnnouncer?.((speech, emotion) => { this.onAnnounce(speech, emotion); });

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
    this.control = startToolControl({
      port: this.options.controlPort,
      photoTimeoutMs: this.options.photoTimeoutMs,
      // HTTP 超时比收件箱的兜底再宽 5 s：让设备上报的失败原因先回来
      hqTimeoutMs: detail === null ? undefined : this.photos.timeoutFor(detail.needsUser) + 5_000,
      handlers: {
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
      },
    });
  }

  // ------------------------------------------------------------------ 接线

  private onFrame(type: number, payload: Buffer): void {
    switch (type) {
      case UpstreamFrameType.Audio:
        // 有上行音频 = 设备确实在采集，不需要（再）唤醒它
        if (this.captureWatch !== null) {
          clearTimeout(this.captureWatch);
          this.captureWatch = null;
          console.log('  开麦    设备已在推流 → 不主动唤醒');
        }
        // 首帧上行 = 麦真的开了（不用手机回执：ACK 只证明命令进了队列）
        this.onMicOpened();
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
  private onDeviceEvent(event: DeviceEvent): void {    switch (event.kind) {
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
      case 'power':
        this.powerPercent = event.percent;
        this.charging = event.charging;
        this.app?.deviceEvent(event);
        return;
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
    // 开麦之后要等首帧上行才算"麦真的开了"（ADR-0001 §5.4）
    if (call.op === 'listen.start') {
      this.micPending = true;
    } else if (call.op === 'listen.stop') {
      this.micPending = false;
      this.resolveMicWaiters();
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
      return true;
    }
    const text = this.v1.encode(call);
    if (text === null) {
      this.archive?.event(EVENTS.ctlSkip, { op: call.op, why: 'v1-cannot-express' });
      console.log(`  控制    ✗ v1 无法表达 ${call.op}，已跳过`);
      return false;
    }
    this.sendControl(text);
    return true;
  }

  /** 下发控制串并记进档案：每次下发都能在时间线上对到当时的音频位置 */
  private sendControl(text: string): void {
    this.archive?.event(EVENTS.ctlSend, { text });
    this.conn.sendControl(text);
  }

  // ------------------------------------------------------------------ 开麦

  /** 已经发过 `listen.start`，还没收到首帧上行音频 */
  private micPending = false;
  /** 等首帧上行的人（播报用；宠物走 `AppSession.micOpened()`） */
  private micWaiters: Array<() => void> = [];

  /**
   * 连接就绪后观察「设备到底在不在采集」的定时器。
   *
   * 到期时还没收到任何上行音频，才发 `listen.start` 把它拉起来。收到帧就取消
   * （说明设备已经在推流，不需要唤醒 —— 重连场景多半是这样）。
   */
  private captureWatch: NodeJS.Timeout | null = null;

  /**
   * 开始等设备的第一帧上行音频。
   *
   * 为什么不是"连接就绪就开麦"：那样每次网络抖动重连都会唤醒眼镜（亮灯、耗电、
   * 可能还有提示音），而那一刻根本没人在说话。
   *
   * 为什么不干脆"重连就跳过"：设备侧的 Aivs 会话可能已经自毁（真机 `会话状态 3`
   * 后采集停止），那种情况下不唤醒就是「未响应」。
   *
   * 判据只能是设备有没有在推流 —— 等 {@link CAPTURE_GRACE_MS} 看有没有帧。
   */
  private armCaptureWatch(resumed: boolean): void {
    const why = resumed ? '自动重连' : '连接就绪';
    this.captureWatch = setTimeout(() => {
      this.captureWatch = null;
      if (this.conn.isClosed || this.micPending) {
        return;
      }
      console.log(`  开麦    ${why}但 ${CAPTURE_GRACE_MS} ms 内没有上行音频 → 请设备推流（§42）`);
      this.sendListenStart();
    }, CAPTURE_GRACE_MS);
    this.captureWatch.unref?.();
  }

  /** 发一次 `listen.start` 并进入等首帧的状态。 */
  private sendListenStart(): void {
    this.micPending = true;
    this.sendCall({ op: 'listen.start', maxMs: INITIAL_LISTEN_MS });
  }

  private resolveMicWaiters(): void {
    const waiters = this.micWaiters;
    this.micWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * 麦开的证据到了。
   *
   * 只在 `micPending` 时算一次：`listen.stop` 之后再来的音频属于对话层，
   * 不该再被当成"宠物这一轮开麦成功"。
   */
  private onMicOpened(): void {
    if (!this.micPending) {
      return;
    }
    this.micPending = false;
    this.archive?.event(EVENTS.micOpened);
    this.resolveMicWaiters();
    this.app?.micOpened();
  }

  /**
   * 等麦开，最多 `timeoutMs`。
   *
   * 播报用（ADR-0001 §6）：设备支持 `listen.start` 时，播报也先开麦再开口，
   * 这样播报一开口就能被插话；超时照播。
   */
  private awaitMicOpen(timeoutMs: number): Promise<boolean> {
    if (!this.micPending) {
      return Promise.resolve(false);
    }
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
      const cancel = this.clock.after(timeoutMs, () => { finish(false); });
      this.micWaiters.push(() => { finish(true); });
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
  private onClose(): void {
    // 有在途开口就记 aborted，然后丢掉执行器手里的计时器
    this.app?.close();
    this.app?.dispose();
    console.log(`\n连接结束，${this.core.turn} 轮`);
    // 连接没了，后台任务的播报就没有出口了（结果仍会在 dsh 会话里，下次连上可追问）
    this.options.agent.setAnnouncer?.(null);
    this.dialog.dispatch({ type: 'closed' });
    // 收件箱里还有等待者的话，定时器会拖住进程（不必再下发 hq_cancel：连接都断了）
    this.dialog.dispose();
    this.assembler.dispose();
    // 只有自己建的那份才销毁：共享侧车由进程持有，断开就 stop 等于每次重连都
    // 重新加载 ONNX（实测 ~300 ms，第一句白吃）
    if (this.ownsSmartTurn) {
      this.smartTurn?.stop();
    }
    this.control?.close();
    this.archive?.close();
    this.stt.close();
    this.uplink.end();
  }

  // ------------------------------------------------------------------ 事件

  private onPartial(text: string): void {
    console.log(`  … ${text}`);
    this.archive?.event(EVENTS.asrPartial, { text });
    // 判停的**文本判据**：中间结果在出 = 用户还在说。只传信号不拼文本，
    // 中间结果会反复改写，拼起来是乱的。
    this.assembler.notePartial(text);
    // 用户已经开口了，「嗯，我看看」这种回执就没必要了
    // 宠物要在**用户刚开口**就收手，不能等到这句话定稿
    this.app?.userPartial();
    const effects = this.dialog.dispatch({ type: 'partial', text });
    if (effects.some((effect) => effect.type === 'call' && effect.call.op === 'audio.stop')) {
      console.log('  打断    听到识别结果 → 停止播放，已排队的轮次作废');
    }
  }

  private onSentence(text: string, index: number): void {
    console.log(`  句 ${index}  ${JSON.stringify(text)}`);
    this.archive?.event(EVENTS.asrSentence, { text, index });
    const effects = this.dialog.dispatch({ type: 'sentence', text });
    // 打断有两处入口（中间结果 / 定稿），日志必须都打 —— 否则统计打断率会漏掉
    // 「短促插话只出定稿」那一半，真机上就是 4 次里少记 1 次。
    if (effects.some((effect) => effect.type === 'call' && effect.call.op === 'audio.stop')) {
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

  // ------------------------------------------------------------------ 档案
  // ------------------------------------------------------------------ 档案

  /**
   * 档案已经在 `close()` 里收尾（`archive.close()`），这里不再单独落盘 ——
   * 旧的按轮次 `down_<turn>.pcm` 落盘已删掉：它只覆盖播放期，恰好漏掉
   * 「用户说话但没成句」这种最需要事后查的场景，而且同名文件会被下一条连接覆盖。
   */
}
