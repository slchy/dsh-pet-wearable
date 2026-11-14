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
import { SystemClock } from './app/clock.ts';
import { SessionArchive } from './archive.ts';
import type { AnnounceStore } from './announce-store.ts';
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
import { BatteryCache } from './pet/battery-cache.ts';
import { DeviceEventHost } from './pet/device-host.ts';
import { PetTiming, type PetMove, type PetTimingOptions } from './pet/pet-timing.ts';
import {
  DEFAULT_PROACTIVE,
  planProactive,
  proactivePrompt,
  type ProactivePlan,
} from './pet/proactive.ts';
import { UpstreamFrameType } from './frame.ts';
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  PhotoInbox,
  type CaptureRequest,
  type PhotoOutcome,
} from './photo-inbox.ts';
import type { AgentProvider, SttProvider, SttSession, TtsProvider } from './providers.ts';
import { SessionCore, type CoreEffect } from './session-core.ts';
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
 * 没有判停器（SmartTurn 关掉）时的固定合并窗口。
 *
 * 旧行为：收到一句 ASR 就再等 600 ms 看有没有下文，没有就定稿。
 */
const ASSEMBLER_FALLBACK_WINDOW_MS = 600;

/**
 * 送给判停器的「最近音频」上限（秒）。
 *
 * 判停器要听到整句话的尾巴才能判「说完了」，8 s 足够覆盖常见的一句话，
 * 又不至于把整段对话都留在内存里。
 */
const ASSEMBLER_RECENT_SECONDS = 8;

export interface AliyunSessionOptions {
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
    readonly threshold: number;
  };
  /** 上行增益（喂给 STT 前放大；眼镜 mic 电平偏低） */
  readonly micGain?: number;
  /** 电平表周期（毫秒）；> 0 时每这么久打一行上行峰值，调增益用 */
  readonly levelLogMs?: number;
  /** 能量门 */
  readonly gate: {
    readonly thresholdDbfs: number;
    readonly holdMs: number;
    readonly prerollMs: number;
  };
  /** 播完后额外等待的余量 */
  readonly playbackTailMs: number;
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
    readonly timing?: Partial<PetTimingOptions>;
    /** 主动开口后开麦听回应多久（设备支持 `listen.start` 才生效） */
    readonly listenMs?: number;
    /** 多久判一次时机（默认 30 s） */
    readonly tickMs?: number;
  } | null;

  /**
   * TLS。**不给就是明文** —— 本地开发不必先造证书；上公网时由部署方注入。
   * 证书路径/内容属于部署细节，不进源码（见 `BACKLOG.md` B-004）。
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
export async function runAliyunServer(options: AliyunSessionOptions): Promise<number> {
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
function handshake(conn: Connection, options: AliyunSessionOptions): void {
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
    new AliyunConnection(conn, options, link).start(first);
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
class AliyunConnection {
  private readonly conn: Connection;
  private readonly options: AliyunSessionOptions;
  private readonly link: DeviceLink;
  private readonly caps: DeviceCapabilities;
  /** v1 线协议垫片：原语 ↔ 控制串 / 状态帧，图像帧归属；v2 连接为 `null` */
  private readonly v1: V1Session | null;

  /** 宠物环（没开主动开口时全为 null） */
  private readonly pet: {
    readonly timing: PetTiming;
    readonly host: DeviceEventHost;
    readonly battery: BatteryCache | null;
    readonly listenMs: number;
    readonly tickMs: number;
  } | null;
  private petTimer: NodeJS.Timeout | null = null;
  /** 一次主动开口还没结束（拍照 / 排队 / 播放中） */
  private proactiveBusy = false;
  /** 用户每说完一句 +1：主动开口拍照期间用户开口了，就放弃这次 */
  private utteranceSeq = 0;
  private petSeq = 0;
  /** 上行编码由能力集决定；档案与解码都要它 */
  private readonly uplinkCodec: 'msbc' | 'pcm16';

  /** 本连接唯一的时钟：拍照兜底超时与一轮的等待都走它 */
  private readonly clock = new SystemClock();
  private readonly core: SessionCore;
  private readonly uplink: UplinkPipeline;
  private readonly photos: PhotoInbox;
  private readonly smartTurn: SmartTurn | null;
  private readonly assembler: UtteranceAssembler;
  private readonly runner: TurnRunner;
  private readonly stt: SttSession;

  private control: ToolControl | null = null;
  private serialChain: Promise<void> = Promise.resolve();
  /** 串行队列里还没跑完的任务数（主动开口只在队列空时才判时机） */
  private queued = 0;

  /** 原始档案（`MIAI_ARCHIVE_DIR` 为空时是 null） */
  private readonly archive: SessionArchive | null;

  constructor(conn: Connection, options: AliyunSessionOptions, link: DeviceLink) {
    this.conn = conn;
    this.options = options;

    const log = (line: string): void => { console.log(line); };
    // 版本与能力在握手时定好；往下全是能力
    this.link = link;
    this.caps = link.capabilities;
    this.v1 = link.v1;
    this.uplinkCodec = this.caps.audioIn;

    const proactive = options.proactive;
    if (proactive === undefined || proactive === null) {
      this.pet = null;
    } else {
      const host = new DeviceEventHost(this.caps, () => performance.now());
      this.pet = {
        timing: new PetTiming(proactive.timing),
        host,
        battery: host.battery === undefined ? null : new BatteryCache(host.battery, { log }),
        listenMs: proactive.listenMs ?? DEFAULT_PROACTIVE.listenMs,
        tickMs: proactive.tickMs ?? 30_000,
      };
    }
    this.core = new SessionCore({ imageQuestion: options.imageQuestion, log, capabilities: this.caps });

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
    this.smartTurn = smartTurnOptions
      ? new SmartTurn({
        python: smartTurnOptions.pythonPath,
        script: smartTurnOptions.scriptPath,
        log: (line) => { console.log(`  ${line}`); },
      })
      : null;

    this.assembler = new UtteranceAssembler({
      quietMs: smartTurnOptions?.quietMs ?? 0,
      extendMs: smartTurnOptions?.extendMs ?? 0,
      maxExtensions: smartTurnOptions?.maxExtensions ?? 0,
      fallbackWindowMs: ASSEMBLER_FALLBACK_WINDOW_MS,
      threshold: smartTurnOptions?.threshold ?? 1,
      recentMaxBytes: UPSTREAM_SAMPLE_RATE * 2 * ASSEMBLER_RECENT_SECONDS,
      predict: this.smartTurn
        ? (pcm: Buffer) => this.smartTurn!.predict(pcm)
        : undefined,
      onUtterance: (text) => {
        this.utteranceSeq += 1;
        this.pet?.timing.onUserSpoke(performance.now());
        console.log('\n--- 本轮 ---');
        console.log(`  文本    ${JSON.stringify(text)}`);
        this.execute(this.core.dispatch({ type: 'utterance', text }));
      },
      log,
    });

    this.stt = options.stt.open({
      onPartial: (text) => { this.onPartial(text); },
      onSentence: (text, index) => { this.onSentence(text, index); },
      onError: (error) => { this.onAsrError(error); },
    });

    this.photos = new PhotoInbox({
      clock: this.clock,
      dir: options.photoDir,
      timeoutMs: options.photoTimeoutMs,
      confirmTimeoutMs: options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
      log,
      send: (call) => this.sendCall(call),
    });

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
        this.archive?.event('gate.open', { peakDbfs: Number(peakDbfs.toFixed(1)), prerollMs });
        for (const part of preroll) {
          this.stt.feed(part);
        }
      },
      onSpeech: (pcm) => { this.stt.feed(pcm); },
      onSpeechClose: () => {
        this.archive?.event('gate.close');
        this.stt.hangup();
      },
    });

    this.runner = new TurnRunner({
      clock: this.clock,
      agent: options.agent,
      tts: options.tts,
      downlink: conn,
      fsm: this.core.fsm,
      playbackTailMs: options.playbackTailMs,
      ttsGain: options.ttsGain,
      onDownlinkChunk: (chunk) => { this.archive?.downlink(chunk); },
      onEvent: (name, fields) => { this.archive?.event(name, fields); },
      onTurnFinished: () => {
        this.execute(this.core.dispatch({ type: 'turnFinished' }));
        // 本轮结束，后台任务的播报可以接着放
        void this.flushAnnounce();
      },
      log,
    });
  }

  /**
   * @param first - 握手期间先到的那一帧（v1 手机不发 `Hello` 时），原样补交
   */
  start(first?: { type: number; payload: Buffer }): void {
    console.log(`已连接 ${this.conn.remote}\n`);
    console.log(
      `  设备    ${this.link.label}（v${this.link.proto}）：${describeCapabilities(this.caps)}`,
    );
    this.archive?.event('device.link', { proto: this.link.proto, label: this.link.label });

    // 后台任务完成后的播报落在这条连接上
    this.options.agent.setAnnouncer?.((speech) => { this.onAnnounce(speech); });

    // 上次离线期间攒下的汇报：连上就补播（旧的先播）
    const backlog = this.options.announceStore?.drain() ?? [];
    if (backlog.length > 0) {
      this.archive?.event('announce.replay', { count: backlog.length });
      console.log(`  补播    离线期间攒了 ${backlog.length} 条后台汇报`);
      for (const speech of backlog) {
        this.announceQueue.push(speech);
      }
      void this.flushAnnounce();
    }

    // 业务只认「帧」和「关闭」：Hello、Ping/Pong、空闲看门狗、TLS 都在连接层
    this.conn.bind({
      onFrame: (type, payload) => { this.onFrame(type, payload); },
      onClose: () => { this.onClose(); },
    });
    if (first !== undefined) {
      this.onFrame(first.type, first.payload);
    }
    this.startPet();

    const detail = captureMode(this.caps, 'detail');
    this.control = startToolControl({
      port: this.options.controlPort,
      photoTimeoutMs: this.options.photoTimeoutMs,
      // HTTP 超时比收件箱的兜底再宽 5 s：让设备上报的失败原因先回来
      hqTimeoutMs: detail === null ? undefined : this.photos.timeoutFor(detail.needsUser) + 5_000,
      handlers: {
        takePhoto: () => this.requestToolCapture('glance'),
        // 没有 `detail` 意图时不传 `takePhotoHq`：`tool-control` 会回落到 `takePhoto`
        takePhotoHq: detail === null ? undefined : () => this.requestToolCapture('detail'),
        endSession: () => { this.execute(this.core.dispatch({ type: 'endRequested' })); },
        say: (text) => {
          // 调试口：和「用户说完一句」走同一条路，方便没有麦克风时联调
          this.execute(this.core.dispatch({ type: 'utterance', text }));
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
          this.execute(this.core.dispatch({ type: 'image', jpeg: payload }));
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
    this.archive?.event('status.recv', { name, raw: JSON.stringify(json).slice(0, 200) });

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
    this.archive?.event('event.recv', { raw: JSON.stringify(raw).slice(0, 200) });
    const event = parseV2Event(raw);
    if (event === null) {
      console.log(`  ✗ 不认识的设备事件 ${JSON.stringify(raw).slice(0, 120)}，已忽略`);
      return;
    }
    this.onDeviceEvent(event);
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
      case 'power':
      case 'summon':
        this.pet?.host.feed(event);
        return;
      case 'played':
        // 播放进度目前由 TurnRunner 按时长估算；收到也只记档，留给以后替换估算
        this.archive?.event('device.played');
        return;
    }
  }

  /** 执行 core 给出的动作。**所有副作用只在这里发生。** */
  private execute(effects: readonly CoreEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'assemble':
          this.assembler.addSentence(effect.text);
          break;
        case 'turn':
          this.enqueueTurn(effect.text, effect.image, effect.ticket);
          break;
        case 'capture':
          this.enqueueCapture(effect.request, effect.ticket);
          break;
        case 'call':
          if (effect.call.op === 'capture.cancel') {
            this.runner.cancelCanned();
            this.photos.cancel('用户改主意或收尾');
          } else {
            this.sendCall(effect.call);
          }
          break;
        case 'end':
          this.conn.end();
          break;
        case 'drop':
          break;
      }
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
    if (!supportsCall(this.caps, call)) {
      this.archive?.event('ctl.skip', { op: call.op, why: 'unsupported' });
      console.log(`  控制    ✗ 设备未声明 ${call.op}，已跳过`);
      return false;
    }
    if (this.v1 === null) {
      const json = encodeV2Call(call);
      this.archive?.event('call.send', { json });
      this.conn.sendCall(json);
      return true;
    }
    const text = this.v1.encode(call);
    if (text === null) {
      this.archive?.event('ctl.skip', { op: call.op, why: 'v1-cannot-express' });
      console.log(`  控制    ✗ v1 无法表达 ${call.op}，已跳过`);
      return false;
    }
    this.sendControl(text);
    return true;
  }

  /** 下发控制串并记进档案：每次下发都能在时间线上对到当时的音频位置 */
  private sendControl(text: string): void {
    this.archive?.event('ctl.send', { text });
    this.conn.sendControl(text);
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

  /** 后台任务完成后的播报排队：用户正在说/正在听的时候不插嘴 */
  private readonly announceQueue: string[] = [];
  private announcing = false;

  /**
   * 后台任务完成 → 播报。
   *
   * 这条**不属于任何一轮**（`speakCanned` 的旁白通道），所以不占轮次票据、不改状态机。
   * 用户正在说话或正在播报时排队，等回到 `listening` 再放出来 —— 抢话比晚两秒更烦人。
   */
  private onAnnounce(speech: string): void {
    this.archive?.event('announce', { len: speech.length });
    this.announceQueue.push(speech);
    void this.flushAnnounce();
  }

  private async flushAnnounce(): Promise<void> {
    if (this.announcing || this.announceQueue.length === 0) {
      return;
    }
    if (this.core.phase !== 'listening') {
      // 等本轮结束（`onTurnFinished` 会再叫一次）
      return;
    }
    this.announcing = true;
    try {
      while (this.announceQueue.length > 0) {
        const speech = this.announceQueue.shift();
        if (speech === undefined) {
          break;
        }
        await this.runner.speakCanned(speech);
        if (this.core.phase !== 'listening') {
          // 播报期间用户说话了，剩下的一条留到下一轮结束
          break;
        }
      }
    } finally {
      this.announcing = false;
    }
  }

  private onClose(): void {
    if (this.petTimer !== null) {
      clearInterval(this.petTimer);
      this.petTimer = null;
    }
    this.pet?.battery?.dispose();
    console.log(`\n连接结束，${this.core.turn} 轮`);
    // 连接没了，后台任务的播报就没有出口了（结果仍会在 dsh 会话里，下次连上可追问）
    this.options.agent.setAnnouncer?.(null);
    this.announceQueue.length = 0;
    this.execute(this.core.dispatch({ type: 'closed' }));
    // 收件箱里还有等待者的话，定时器会拖住进程（不必再下发 hq_cancel：连接都断了）
    this.photos.dispose();
    this.assembler.dispose();
    this.smartTurn?.stop();
    this.control?.close();
    this.archive?.close();
    this.stt.close();
    this.uplink.end();
  }

  // ------------------------------------------------------------------ 事件

  private onPartial(text: string): void {
    console.log(`  … ${text}`);
    this.archive?.event('asr.partial', { text });
    const effects = this.core.dispatch({ type: 'partial', text });
    if (effects.some((effect) => effect.type === 'call' && effect.call.op === 'audio.stop')) {
      console.log('  打断    听到识别结果 → 停止播放，已排队的轮次作废');
    }
    this.execute(effects);
  }

  private onSentence(text: string, index: number): void {
    console.log(`  句 ${index}  ${JSON.stringify(text)}`);
    this.archive?.event('asr.sentence', { text, index });
    this.execute(this.core.dispatch({ type: 'sentence', text }));
  }

  private onAsrError(error: Error): void {
    this.archive?.event('asr.error', { message: error.message.slice(0, 200) });
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
    this.archive?.event('wake', { transactionId, requestId: requestId.slice(0, 8) });
    console.log(
      `  唤醒    transactionId=${transactionId}  requestId=${requestId.slice(0, 8)}…`,
    );
  }

  // ------------------------------------------------------------------ 一轮

  private enqueueTurn(
    text: string,
    image: ImageAttachment | undefined,
    ticket: TurnTicket,
  ): Promise<void> {
    this.queued += 1;
    this.serialChain = this.serialChain.then(async () => {
      if (this.core.fsm.isStale(ticket)) {
        console.log('  （丢弃：用户已插话，这一轮过时了）');
        return;
      }
      this.archive?.event('turn.start', { text_len: text.length, image: image !== undefined });
      // 图由 `capture` 那一步拿好并挂在 text/image 里，这里不再自己拍
      return this.runner.run(text, image).then(() => undefined);
    }).catch((error: Error) => {
      console.error(`  ✗ 队列任务失败（不影响后续）: ${error.message}`);
    }).finally(() => {
      this.queued -= 1;
    });
    return this.serialChain;
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
      if (this.core.fsm.isStale(ticket)) {
        console.log('  （丢弃：拍照请求已过时）');
        return;
      }
      const outcome = await this.photos.request(request);
      this.v1?.forget(request.id);
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


  // ------------------------------------------------------------------ 宠物环

  /**
   * 主动开口的接线：时机在 `pet-timing.ts`，做法在 `proactive.ts`，这里只执行。
   *
   * 定时器**不占着进程**：`unref`，没别的事时照常退出。
   */
  private startPet(): void {
    const pet = this.pet;
    if (pet === null) {
      return;
    }
    pet.host.presence?.onChange((wearing) => {
      pet.timing.onPresence(wearing, performance.now());
    });
    pet.host.touch?.onTap((tap) => {
      const move = pet.timing.onTap(performance.now(), tap);
      if (move.kind === 'reflect') {
        // 快反射要预合成的短音（「嗯？」「在呢」），还没有素材，先只记日志
        this.archive?.event('pet.reflect', { cue: move.cue });
        console.log(`  宠物    敲击（${move.cue}），没有短音素材，略过`);
      }
    });
    pet.battery?.start();
    this.petTimer = setInterval(() => { this.tickPet(); }, pet.tickMs);
    this.petTimer.unref?.();
  }

  /** 判一次时机：只在没人说话、没人在播、队列也空的时候才执行。 */
  private tickPet(): void {
    const pet = this.pet;
    if (pet === null || this.proactiveBusy) {
      return;
    }
    if (this.core.phase !== 'listening' || this.queued > 0 || this.announcing) {
      return;
    }
    const move = pet.timing.tick({
      wearing: pet.host.presence?.wearing() ?? null,
      battery: pet.battery?.current() ?? null,
      nowMs: performance.now(),
      localHour: new Date().getHours(),
    });
    const plan = planProactive(move, this.caps, { listenMs: pet.listenMs });
    if (plan === null) {
      return;
    }
    this.proactiveBusy = true;
    void this.runProactive(move, plan).finally(() => {
      this.proactiveBusy = false;
    });
  }

  /**
   * 一次主动开口：先看一眼（设备能不用人动手拍 `glance` 才拍），再开口。
   *
   * 拍照期间用户开口了（`utteranceSeq` 变了）就放弃 —— 主动找你说话不该
   * 抢用户正在说的话。说完之后按计划开麦，设备不支持就不开。
   */
  private async runProactive(move: PetMove, plan: ProactivePlan): Promise<void> {
    const seq = this.utteranceSeq;
    this.archive?.event('pet.proactive', { kind: plan.kind, look: plan.look });
    console.log(`  宠物    主动开口（${plan.kind}）`);

    let image: ImageAttachment | undefined;
    if (plan.look !== null) {
      this.petSeq += 1;
      const outcome = await this.photos.request({
        id: `pet-${this.petSeq}`,
        intent: plan.look,
        needsUser: false,
      });
      if (this.utteranceSeq !== seq || this.core.phase !== 'listening') {
        console.log('  宠物    拍照期间用户开口了，这次主动开口作废');
        return;
      }
      if (outcome.ok) {
        image = { mimeType: 'image/jpeg', data: outcome.jpeg.toString('base64') };
      } else {
        // 没拍到就当没画面：开口时明确告诉模型别假装看见了
        console.log(`  宠物    主动拍照没拍到（${outcome.failure.code}），改成不带画面开口`);
      }
    }

    const text = proactivePrompt(move, image !== undefined);
    if (text === '') {
      return;
    }
    await this.enqueueTurn(text, image, this.core.fsm.ticket());

    if (plan.listenMs !== null && this.utteranceSeq === seq && this.core.phase === 'listening') {
      this.sendCall({ op: 'listen.start', maxMs: plan.listenMs });
    }
  }
  // ------------------------------------------------------------------ 档案

  /**
   * 档案已经在 `close()` 里收尾（`archive.close()`），这里不再单独落盘 ——
   * 旧的按轮次 `down_<turn>.pcm` 落盘已删掉：它只覆盖播放期，恰好漏掉
   * 「用户说话但没成句」这种最需要事后查的场景，而且同名文件会被下一条连接覆盖。
   */
}
