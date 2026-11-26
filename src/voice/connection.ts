/**
 * 一条连接的编排：把几个各管一段的模块接起来，本身不含任何判定逻辑。
 *
 * 构造顺序是固定的（闭包延后读还没赋值的 `stt` / `assembler`）：
 * 1. `DialogRuntime`
 * 2. `bindUiEvent` + `createAppSession`
 * 3. `SessionArchive.open` + `setAudit(this.auditSink)`
 * 4. `OmniShadow`
 * 5. `resolveEndpointDetector` + `wireAssembler`
 * 6. `stt.open` + `tts.warm`
 * 7. `UplinkPipeline`
 */
import { DialogRuntime, type AnnounceItem } from '../app/dialog.ts';
import { SystemClock, type Clock } from '../app/clock.ts';
import { AppSession } from '../app/session.ts';
import { SessionArchive } from '../archive.ts';
import {
  captureMode,
  describeCapabilities,
  parseV2CaptureImage,
  type DeviceCall,
  type DeviceCapabilities,
  type DeviceLink,
  type V1Session,
} from '../devices/index.ts';
import type { DialogState } from '../dialog-fsm.ts';
import { EVENTS } from '../events.ts';
import { UpstreamFrameType } from '../frame.ts';
import { OmniShadow, type OmniShadowOptions } from '../omni-shadow.ts';
import { DEFAULT_PET_PARAMS } from '../pet/brain/registry.ts';
import { summarizePetEvent } from '../pet/brain/session.ts';
import type { PetReply } from '../pet/brain/types.ts';
import { petPrompt } from '../pet/proactive.ts';
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  type PhotoInbox,
} from '../photo-inbox.ts';
import type {
  BackgroundTaskReport,
  RealtimeUplinkLane,
  SttSession,
} from '../providers.ts';
import type { ImageAttachment } from '../session.ts';
import type { SessionCore } from '../session-core.ts';
import type { ToolControlHandlers } from '../tool-control.ts';
import type { Connection } from '../transport.ts';
import { resolveTurnJudgeModelPath } from '../runtime/turn-judge-bootstrap.ts';
import { TurnJudge } from '../turn-judge.ts';
import type { TurnRunner } from '../turn-runner.ts';
import { safeEmitUi, type PetUiPhase } from '../ui-events.ts';
import { UplinkPipeline } from '../uplink-pipeline.ts';
import type { UtteranceAssembler } from '../utterance-assembler.ts';
import { AsrFront } from './asr-front.ts';
import { DeviceReading } from './device-io.ts';
import { resolveEndpointDetector, wireAssembler, type EndpointDetector } from './endpoint-wire.ts';
import { omniStaticContext } from './handshake.ts';
import { announceListenMs, MicController } from './mic-phase.ts';
import {
  UPSTREAM_SAMPLE_RATE,
  type VoiceService,
  type VoiceSessionOptions,
} from './session-options.ts';

/**
 * 从尾部留下不超过 `budgetBytes` 的帧，至少留 1 帧。
 * ASR / Omni 的预卷用它；TurnJudge 仍拿开门时的完整预卷。
 */
function tailByBytes<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  budgetBytes: number,
): readonly T[] {
  if (items.length <= 1) return items;
  let bytes = 0;
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item === undefined) continue;
    const size = sizeOf(item);
    if (start < items.length && bytes + size > budgetBytes) break;
    bytes += size;
    start = i;
  }
  return items.slice(start);
}

/** 对话相位收成浮层四态。`ending` / `closed` 都是空闲；等拍照仍算在想。 */
function petPhaseOf(state: DialogState): PetUiPhase {
  switch (state) {
    case 'listening':
      return 'listening';
    case 'thinking':
    case 'awaiting_shot':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    case 'ending':
    case 'closed':
      return 'idle';
    default: {
      const unexpected: never = state;
      return unexpected;
    }
  }
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
  /** v1 线协议垫片：原语 ↔ 控制串 / 状态帧，图像帧归属；v2 连接为 `null` */
  private readonly v1: V1Session | null;

  /** 应用层（宠物环 + 心跳）；没开主动开口时为 null */
  private readonly app: AppSession | null;
  /** 等首帧上行的兜底时长；宠物与播报共用 */
  private readonly micOpenTimeoutMs: number;
  /**
   * 本连接唯一的时钟。
   *
   * 一轮对话的等待、拍照的兜底超时、宠物心跳、开麦宽限全走它 ——
   * 生产是 `SystemClock`，模拟器换成 `VirtualClock`。**不要在这里再直接 `Date.now()`**。
   */
  private readonly clock: Clock = new SystemClock();
  /**
   * 装配器与插话闸**共用**的时刻源。
   *
   * 写成同一个函数引用，就是为了让「两边各取一个时钟」这件事再也做不出来 ——
   * 真机踩过：装配器 `Date.now()`、闸 `SystemClock.now()`，闸恒放行且无日志。
   */
  private readonly assemblerNow = (): number => this.clock.now();
  /** 上一次发给浮层的相位；连续相同的不重复发 */
  private lastPetPhase: PetUiPhase | null = null;
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
   * Realtime 音频直出车道（`OMNI_SHADOW=1` / `VOICE_PIPELINE=live` / `realtimeLane` 才有，默认 null = 零成本）。
   *
   * 跟着**这条连接**活：服务空跑时远端 realtime 会空闲断链，进程启动就建连
   * 等于白建一条注定 `broken` 的连接。通过 `RealtimeUplinkLane` 端口与具体协议解耦。
   */
  private readonly omni: RealtimeUplinkLane | null;
  private readonly mic: MicController;
  private readonly device: DeviceReading;
  private readonly asr: AsrFront;

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
  /** `end_session` 之后那 250 ms 的延迟关闭。`onClose` 必须清掉，不能悬空。 */
  private endSessionTimer: ReturnType<typeof setTimeout> | null = null;

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

    // 麦和设备互相指着对方：宽限回调发 `listen.start`，设备把字节交出去之后才改相位。
    // 两个闭包在构造期都不调用，等 `start` / 对话层之后才走。
    let device!: DeviceReading;
    const mic = new MicController({
      clock: this.clock,
      wearing: () => device.wearing,
      connClosed: () => this.conn.isClosed,
      sendCall: (call) => device.sendCall(call),
      onOpened: () => {
        this.archive?.event(EVENTS.micOpened);
        this.app?.micOpened();
      },
    });
    device = new DeviceReading({
      conn,
      link,
      caps: this.caps,
      v1: this.v1,
      mic,
      pipelineMode: () => this.options.pipelineMode,
      archive: (name, fields) => { this.archive?.event(name, fields); },
      onCapture: (event) => this.photos.onEvent(event),
      appDevice: (event) => { this.app?.deviceEvent(event); },
      enqueueAnnounce: (speech) => { this.dialog.enqueueAnnounce(speech); },
      speakCanned: (speech) => { void this.runner.speakCanned(speech); },
      devicePlayed: () => { this.runner.devicePlayed(); },
      requestPhoto: (request) => this.photos.request(request),
      forget: (id) => { this.v1?.forget(id); },
    });
    this.mic = mic;
    this.device = device;

    // 1. 对话层。`ticketContext` 闭包延后读 `this.stt`：此时还没 open。
    this.dialog = new DialogRuntime({
      clock: this.clock,
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
        call: (call) => this.device.sendCall(call),
        assemble: (text) => { this.assembler.addSentence(text); },
        deviceNote: () => this.device.deviceNote(),
        // 收尾前先明说「这次会话结束了」。
        //
        // 只 `end()` 掉 socket 的话，App 那边只看到「对端关闭」，和网络掉线一模一样
        // —— supervisor 会在 1 秒后自己连回来，用户看到的就是「说完再见它又活了」。
        //
        // 延迟关闭是给控制串留出发出去 + App 读线程处理的时间（它收到就置位，不再重连）。
        end: () => {
          // 从这一刻起就是「正在关」：宽限期内的 listen.start 必须拒绝，
          // 不能在告别的 250 ms 里再把麦打开。
          this.mic.beginClose();
          this.conn.sendControl('end_session');
          this.clearEndSessionTimer();
          const timer = setTimeout(() => {
            if (this.endSessionTimer !== timer) {
              return;
            }
            this.endSessionTimer = null;
            if (this.mic.phase === 'closed' || this.conn.isClosed) {
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
              listenMs: announceListenMs(proactive),
              call: (call: DeviceCall) => { this.device.sendCall(call); },
              awaitMicOpen: (timeoutMs: number) => this.mic.awaitMicOpen(timeoutMs),
            },
          }
          : {}),
        onAnnounce: (pending, spoken) => { this.app?.announce(pending, spoken); },
        onTurnStart: (text, hasImage) => {
          // `base_commit_seq`：开轮瞬间已发出的最大 ASR commit 序号。它和票据上
          // 锁存的水位线同源，档案里据此判「这段转写是开轮前录的还是开轮后的」，
          // 不必再靠到达时刻猜。ASR 不提供序号时（老实现）不写这个键。
          const baseCommitSeq = this.stt.commitSeq?.();
          this.archive?.event(EVENTS.turnStart, {
            text_len: text.length,
            image: hasImage,
            ...(baseCommitSeq === undefined ? {} : { base_commit_seq: baseCommitSeq }),
          });
        },
        // 话筒占用/释放由状态机转移驱动（见 `AppSession.onDialogState`）
        onDialogState: (state) => {
          this.app?.onDialogState(state);
          this.emitPetPhase(petPhaseOf(state));
        },
      },
      log,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.speakAnnounce === undefined
        ? {}
        : {
            speakAnnounce: (item: AnnounceItem) => options.speakAnnounce!(
              item,
              (answer) => this.runner.speakAudioAnswer(answer, item.emotion),
            ),
            cancelAnnounce: options.cancelAnnounce,
            onFallbackAnnounceSpoken: options.onFallbackAnnounceSpoken,
          }),
      ...(options.shouldSkipAnnounce === undefined
        ? {}
        : { shouldSkipAnnounce: options.shouldSkipAnnounce }),
      ...(options.pipelineMode === 'live' ? { allowTtsFallback: false } : {}),
    });
    // 2. 浮层钩子不进 DialogRuntime。runner 建好后再挂；缺省时 emit 都是空操作。
    this.dialog.runner.bindUiEvent(options.onUiEvent);
    this.emitPetPhase(petPhaseOf(this.dialog.core.fsm.state));
    // 应用层**总是**要建：话筒（user / reply / announce）必须在同一张表里仲裁，
    // 没有宠物也要（ADR-0001 §6）。宠物只是这套应用层里的一个子系统。
    this.app = this.createAppSession(proactive, this.dialog);

    // 3. 档案先开：后面每一段音频/每个事件都要往里写
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

    // 4. Realtime 车道跟着这条连接活。支持厂商中立 `realtimeLane` 端口，或沿用 `omniShadow` 配置。
    const laneEmit = (data: Record<string, unknown>): void => {
      this.archive?.event(EVENTS.omniShadow, data);
    };
    const laneLog = (line: string): void => {
      console.log(line);
    };
    if (options.realtimeLane !== undefined) {
      this.omni = options.realtimeLane.create({ emit: laneEmit, log: laneLog });
    } else if (options.omniShadow !== undefined) {
      const shadow = options.omniShadow;
      const shadowOpts: OmniShadowOptions = {
        apiKey: shadow.apiKey,
        ...(shadow.model === undefined ? {} : { model: shadow.model }),
        ...(shadow.url === undefined ? {} : { url: shadow.url }),
        ...(shadow.dialect === undefined ? {} : { dialect: shadow.dialect }),
        ...(shadow.voice === undefined ? {} : { voice: shadow.voice }),
        ...(shadow.asrModel === undefined ? {} : { asrModel: shadow.asrModel }),
        ...(shadow.extraHeaders === undefined ? {} : { extraHeaders: shadow.extraHeaders }),
        ...(shadow.socketFactory === undefined ? {} : { socketFactory: shadow.socketFactory }),
        serve: shadow.serve ?? 'off',
        ...omniStaticContext(shadow),
        // 每一份 seal 一条，`seq` 与 `asr.commit` 同源
        emit: laneEmit,
        log: laneLog,
      };
      this.omni = shadow.createLane !== undefined
        ? shadow.createLane(shadowOpts)
        : new OmniShadow(shadowOpts);
    } else {
      this.omni = null;
    }

    this.asr = new AsrFront({
      now: this.assemblerNow,
      lastVoicedAtMs: () => this.assembler.lastVoicedAtMs,
      isSpeaking: () => this.dialog.core.fsm.state === 'speaking',
      generation: () => this.core.fsm.gen,
      dispatch: (event) => this.dialog.dispatch(event),
      notePartial: (text) => { this.assembler.notePartial(text); },
      userPartial: () => { this.app?.userPartial(); },
      emitAsr: (text, final) => {
        safeEmitUi(this.options.onUiEvent, { type: 'asr', text, final });
      },
      archive: (name, fields) => { this.archive?.event(name, fields); },
      decodeSettled: (commitSeq) => {
        this.core.runtime.dispatch({ type: 'decodeSettled', commitSeq });
      },
    });

    // 5. 判停器归属 + 装配器。`awaitDecode` 同样延后读 `this.stt`。
    const turnJudgeOptions = options.turnJudge;
    const detector = resolveEndpointDetector(
      options,
      () => new TurnJudge({
        modelPath: turnJudgeOptions!.modelPath ?? resolveTurnJudgeModelPath(process.env) ?? '',
        log: (line) => { console.log(`  ${line}`); },
      }),
      (line) => { console.log(line); },
    );
    this.turnJudge = detector.client;
    this.ownsTurnJudge = detector.owned;
    this.assembler = wireAssembler({
      options,
      turnJudge: detector.client,
      now: this.assemblerNow,
      log,
      onJudge: (fact) => { this.archive?.event(EVENTS.judge, { ...fact }); },
      // 语义判停真的等了一趟才落这一条（纯 Live 不开语义端点时零开销）
      onSemanticWait: (fact) => { this.archive?.event(EVENTS.semanticGate, { ...fact }); },
      onCommit: (silenceMs) => {
        const laneSeq = this.asr.nextSealSeq();
        // 车道起跑（omni 的 `seal`）。**ASR 的 commit 在更晚的 `onSttCommit`**，
        // 所以这里不再写 `asr.commit` —— 否则 ①a/①b（停嘴→封段→定稿）
        // 会拿 20 ms 的车道时刻冒充 150 ms 的封段时刻，整份延迟报告偏 130 ms。
        this.omni?.seal(laneSeq, silenceMs);
      },
      onSttCommit: (silenceMs) => {
        // **先真发，再读号**。`commit()` 会跳过（这段没有新音频）、会延后
        // （上一段还在解码），这两种都**不占号**；宿主以前自己 `+1`，
        // 跳过时虚增、`hangup()` 时漏增，转写戴的出生证就指错了段。
        this.stt.commit?.();
        const seq = this.stt.commitSeq?.() ?? 0;
        this.archive?.event(EVENTS.asrCommit, {
          seq,
          silence_ms: Math.round(silenceMs),
          // 与 `silence_ms` 同源：都是触发这一次封段的那一帧的能量门静音。
          front_silence_ms: Math.round(this.asr.lastFrameSilenceMs),
          want_ms: options.gate.sttCommitMs,
          // 与 `omni.shadow` 的 join key：同一段语音的车道序号。
          // 两个号从 2026-11-23 起**不再相等**（车道 20 ms 先跑、ASR 150 ms 后切），
          // 想配对就看这一个字段，别再假设 `seq` 一样。
          lane_seq: this.asr.sealSeq,
        });
        // 共享内核的 `input` 区域只认这一个号（`Math.max` 保护：重复不会倒着走）
        this.core.runtime.dispatch({ type: 'asrCommit', commitSeq: seq });
      },
      onUtterance: (text) => {
        this.app?.userFinal(text);
        console.log('\n--- 本轮 ---');
        console.log(`  文本    ${JSON.stringify(text)}`);
        if (text.trim() !== '') {
          safeEmitUi(this.options.onUiEvent, { type: 'asr', text, final: true });
        }
        this.dialog.dispatch({ type: 'utterance', text });
      },
      awaitDecode: () => this.stt?.whenDecoded?.() ?? null,
    });

    // 6. 识别会话 + TTS 预热。用户还没开口，把 TTS 那条 WebSocket 先建好。
    this.stt = options.stt.open({
      onPartial: (text, commitSeq) => { this.asr.onPartial(text, commitSeq); },
      onSentence: (text, index, commitSeq) => { this.asr.onSentence(text, index, commitSeq); },
      onError: (error) => { this.onAsrError(error); },
    });
    // ASR 那侧不用在这里调：`stt.open()` 内部已经预取 token。
    options.tts.warm?.();

    // 7. 上行。能量门、装配器、插话闸共用 `assemblerNow`。
    const vadStream = options.vad?.createStream() ?? null;
    this.uplink = new UplinkPipeline({
      ffmpegPath: options.ffmpegPath,
      vadStream,
      isSpeaking: () => this.dialog.core.fsm.state === 'speaking',
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
      // 与 SilenceTriggers 的两帧去抖对齐：单帧尖峰不把 silenceMs 打回 0。
      voiceDebounceFrames: 2,
      log,
      onError: (line) => { console.error(`[ffmpeg] ${line}`); },
      onRawPcm: (raw) => { this.archive?.pcmRaw(raw); },
      // 判停用的音频**不在这里收**：下面 `onFrame` 里的 `assembler.addFrame(frame)`
      // 是唯一入口。两处都收等于每帧进 `recentChunks` 两次，而且这条老路会按
      // `silenceDb` **自己重算**能量，与能量门的 `voiced` 两套判据（见 `addAudio`）。
      onPcm: () => {},
      onSpeechOpen: (peakDbfs, preroll, prerollMs, prerollFrames) => {
        this.archive?.event(EVENTS.gateOpen, { peakDbfs: Number(peakDbfs.toFixed(1)), prerollMs });
        // 新一轮开口：判停窗口只留这一句（官方也是按句裁的）。预卷就是这段的开头，
        // 前面那些静音 / 上一轮的回答都不该进模型。
        this.assembler.resetAudio(preroll);
        // TurnJudge 吃完整预卷（默认 800 ms）。ASR 与 Omni 只补尾部一小段，
        // 避免把开门前的长静音灌进识别。
        const asrMs = options.gate.asrPrerollMs;
        let asrFrames = prerollFrames;
        let asrPcm: readonly Buffer[] = preroll;
        if (asrMs !== undefined && asrMs < options.gate.prerollMs) {
          const budget = Math.round((asrMs / 1000) * UPSTREAM_SAMPLE_RATE * 2);
          if (prerollFrames !== undefined) {
            asrFrames = tailByBytes(prerollFrames, (frame) => frame.pcm.length, budget);
          }
          asrPcm = tailByBytes(preroll, (chunk) => chunk.length, budget);
        }
        // 预卷的 voiced 由能量门按同一条门限标好。这里直接喂，不再重算峰值。
        for (const part of asrFrames ?? []) {
          this.stt.feed(part.pcm, part.voiced);
        }
        // 影子按「这一句」重新起一段。封段后到下一次开口之间的静音**一个字节都不推**
        // （见 `OmniShadow` 的 mute），所以这里只要把预卷补上就行。
        this.omni?.restart(asrPcm);
      },
      onFrame: (frame) => {
        // 能量门周期号进共享内核（只作参考，不参与因果裁决 —— `causal.ts` 顶部）
        this.core.runtime.dispatch({ type: 'gate', gateSeq: frame.gateSeq });
        // 先记下这一帧的静音，再交给装配器：封段在 addFrame 里同步发生，
        // 档案的 front_silence_ms 要和回调里的 silence_ms 是同一个数。
        this.asr.noteFrame(frame.silenceMs);
        // 声学前端的**唯一出口**：`voiced` / `silenceMs` / `tsMs` 都是门算好的，
        // 装配器不再按 `silenceDb` 重算一遍。
        this.assembler.addFrame(frame);
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
    const laneServe = this.options.realtimeLane?.serve ?? this.options.omniShadow?.serve;
    const omniServesPlayback = this.options.pipelineMode === 'live'
      || (
        this.options.pipelineMode === undefined
        && this.omni !== null
        && laneServe !== 'off'
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
    // 判据是最本质的那条：**有没有上行音频**。设备在推流就什么都不做；
    // 一段时间内一帧都没有，才说明需要把它拉起来。
    if (this.caps.listenStart && backlog.length === 0) {
      this.mic.armCaptureWatch(resumed);
    }

    const detail = captureMode(this.caps, 'detail');
    const handlers: ToolControlHandlers = {
      capabilities: () => this.caps,
      takePhoto: () => this.device.requestToolCapture('glance'),
      // 没有 `detail` 意图时不传 `takePhotoHq`：`tool-control` 会回落到 `takePhoto`
      takePhotoHq: detail === null ? undefined : () => this.device.requestToolCapture('detail'),
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

  private onFrame(type: number, payload: Buffer): void {
    switch (type) {
      case UpstreamFrameType.Audio:
        // 空载荷不是「设备在采集」的证据，但压缩帧仍要进管道和档案。
        if (payload.length > 0) {
          this.mic.noteUplinkAudio();
        }
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
        this.device.onStatus(payload);
        return;
      case UpstreamFrameType.Event:
        this.device.onV2Event(payload);
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
    const canonical = report.canonicalUser?.trim() ?? '';
    if (canonical !== '') {
      safeEmitUi(this.options.onUiEvent, {
        type: 'asr.replace',
        text: canonical,
        ...(report.previousUserText === undefined ? {} : { previous: report.previousUserText }),
      });
    }
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
    this.mic.beginClose();
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

  private clearEndSessionTimer(): void {
    if (this.endSessionTimer !== null) {
      clearTimeout(this.endSessionTimer);
      this.endSessionTimer = null;
    }
  }

  private onClose(): void {
    // 立刻吸收开麦：不等宽限、也不等 micOpenTimeoutMs。等麦的人拿到 false。
    this.mic.beginClose();
    this.mic.absorb();
    this.clearEndSessionTimer();

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
    // 只有自己建的那份才销毁：共享判停器由进程持有，断开就 stop 等于每次重连都
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
    this.emitPetPhase('idle');
  }

  /**
   * 浮层相位。同一条连接上连续相同的值不发（回执那种 thinking↔speaking 仍会发）。
   */
  private emitPetPhase(phase: PetUiPhase): void {
    if (this.lastPetPhase === phase) {
      return;
    }
    this.lastPetPhase = phase;
    safeEmitUi(this.options.onUiEvent, { type: 'phase', phase });
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
          this.device.sendCall(call);
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
            if (this.options.pipelineMode === 'live') {
              this.options.cancelAnnounce?.();
            }
            this.runner.cancelCanned();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            if (this.options.pipelineMode === 'live') {
              if (this.options.speakAnnounce !== undefined) {
                const outcome = await this.options.speakAnnounce(
                  { speech: text, ...(emotion === null || emotion === undefined ? {} : { emotion }) },
                  (answer) => this.runner.speakAudioAnswer(answer, emotion ?? undefined),
                );
                if (outcome !== 'spoken') {
                  this.runner.emitAnnounceText(text, emotion ?? undefined);
                }
              } else {
                this.runner.emitAnnounceText(text, emotion ?? undefined);
              }
            } else {
              await this.runner.speakCanned(text, emotion ?? undefined);
            }
          } catch (error) {
            console.error(`  ✗ 宠物朗读失败: ${(error as Error).message}`);
            return 'cut';
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
          return aborted ? 'cut' : 'done';
        },
        stop: () => {
          if (this.options.pipelineMode === 'live') {
            this.options.cancelAnnounce?.();
          }
          this.runner.cancelCanned();
        },
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
