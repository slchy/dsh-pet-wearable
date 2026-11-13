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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TurnTicket } from './dialog-fsm.ts';
import { UpstreamFrameType } from './frame.ts';
import { pcm16DurationMs } from './pcm.ts';
import { PhotoInbox } from './photo-inbox.ts';
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

export interface AliyunSessionOptions {
  /** 监听端口 */
  readonly port: number;
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
  readonly dumpDir: string;
  /** 照片落盘目录；空串表示不落盘（默认） */
  readonly photoDir: string;
  /** 控制口端口与超时 */
  readonly controlPort: number;
  readonly photoTimeoutMs: number;
  /** 默认的识图提问 */
  readonly imageQuestion: string;

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
    onConnection: (conn) => { new AliyunConnection(conn, options).start(); },
  });
}

/** 一条连接的完整状态：只负责把各模块接起来。 */
class AliyunConnection {
  private readonly conn: Connection;
  private readonly options: AliyunSessionOptions;

  private readonly core: SessionCore;
  private readonly uplink: UplinkPipeline;
  private readonly photos: PhotoInbox;
  private readonly smartTurn: SmartTurn | null;
  private readonly assembler: UtteranceAssembler;
  private readonly runner: TurnRunner;
  private readonly stt: SttSession;

  private control: ToolControl | null = null;
  private serialChain: Promise<void> = Promise.resolve();

  private downlinkChunks: Buffer[] = [];
  private uplinkDuringPlayback: Buffer[] = [];
  private dumpedTurn = 0;

  constructor(conn: Connection, options: AliyunSessionOptions) {
    this.conn = conn;
    this.options = options;

    const log = (line: string): void => { console.log(line); };
    this.core = new SessionCore({ imageQuestion: options.imageQuestion, log });

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
      fallbackWindowMs: 600,
      threshold: smartTurnOptions?.threshold ?? 1,
      recentMaxBytes: UPSTREAM_SAMPLE_RATE * 2 * 8,
      predict: this.smartTurn
        ? (pcm: Buffer) => this.smartTurn!.predict(pcm)
        : undefined,
      onUtterance: (text) => {
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
      dir: options.photoDir,
      timeoutMs: options.photoTimeoutMs,
      log,
      sendTakePhoto: (kind) => {
        this.conn.sendControl(kind === 'hq' ? 'take_photo_hq' : 'take_photo');
      },
    });

    this.uplink = new UplinkPipeline({
      ffmpegPath: options.ffmpegPath,
      sampleRate: UPSTREAM_SAMPLE_RATE,
      gate: options.gate,
      gain: options.micGain,
      log,
      onError: (line) => { console.error(`[ffmpeg] ${line}`); },
      onPcm: (pcm) => {
        if (this.core.phase === 'speaking' && options.dumpDir) {
          this.uplinkDuringPlayback.push(Buffer.from(pcm));
        }
        // 判停器要看音频本身，不只是文本
        this.assembler.addAudio(pcm);
      },
      onSpeechOpen: (_peakDbfs, preroll) => {
        for (const part of preroll) {
          this.stt.feed(part);
        }
      },
      onSpeech: (pcm) => { this.stt.feed(pcm); },
      onSpeechClose: () => { this.stt.hangup(); },
    });

    this.runner = new TurnRunner({
      agent: options.agent,
      tts: options.tts,
      downlink: conn,
      fsm: this.core.fsm,
      playbackTailMs: options.playbackTailMs,
      ttsGain: options.ttsGain,
      onDownlinkChunk: (chunk) => {
        if (options.dumpDir) {
          this.downlinkChunks.push(Buffer.from(chunk));
        }
      },
      onTurnFinished: () => {
        this.flushDump();
        this.execute(this.core.dispatch({ type: 'turnFinished' }));
      },
      log,
    });
  }

  start(): void {
    console.log(`已连接 ${this.conn.remote}\n`);

    // 业务只认「帧」和「关闭」：Hello、Ping/Pong、空闲看门狗、TLS 都在连接层
    this.conn.bind({
      onFrame: (type, payload) => { this.onFrame(type, payload); },
      onClose: () => { this.onClose(); },
    });

    this.control = startToolControl({
      port: this.options.controlPort,
      photoTimeoutMs: this.options.photoTimeoutMs,
      handlers: {
        takePhoto: () => this.photos.request('spp'),
        takePhotoHq: () => this.photos.request('hq'),
        endSession: () => { this.execute(this.core.dispatch({ type: 'endRequested' })); },
        say: (text) => {
          // 调试口：和「用户说完一句」走同一条路，方便没有麦克风时联调
          this.execute(this.core.dispatch({ type: 'utterance', text }));
        },
        log: (line) => { console.log(line); },
      },
    });
  }

  // ------------------------------------------------------------------ 接线

  private onFrame(type: number, payload: Buffer): void {
    switch (type) {
      case UpstreamFrameType.Audio:
        this.uplink.push(payload);
        return;
      case UpstreamFrameType.Image:
        // 有拍照请求在等就交付；否则当成「看一眼」，起一轮识图
        if (!this.photos.deliver(payload)) {
          this.execute(this.core.dispatch({ type: 'image', jpeg: payload }));
        }
        return;
      case UpstreamFrameType.Wake:
        this.onWake(payload);
        return;
      default:
        console.error(`  ✗ 未知帧类型 ${type}（${payload.length} B），已丢弃`);
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
        case 'stop':
          this.conn.sendControl('stop');
          break;
        case 'stop_capture':
          this.conn.sendControl('stop_capture');
          break;
        case 'end':
          this.conn.end();
          break;
        case 'drop':
          break;
      }
    }
  }

  private onClose(): void {
    console.log(`\n连接结束，${this.core.turn} 轮`);
    this.execute(this.core.dispatch({ type: 'closed' }));
    this.assembler.dispose();
    this.smartTurn?.stop();
    this.control?.close();
    this.flushDump();
    this.stt.close();
    this.uplink.end();
  }

  // ------------------------------------------------------------------ 事件

  private onPartial(text: string): void {
    console.log(`  … ${text}`);
    const effects = this.core.dispatch({ type: 'partial', text });
    if (effects.some((effect) => effect.type === 'stop')) {
      console.log('  打断    听到识别结果 → 停止播放，已排队的轮次作废');
    }
    this.execute(effects);
  }

  private onSentence(text: string, index: number): void {
    console.log(`  句 ${index}  ${JSON.stringify(text)}`);
    this.execute(this.core.dispatch({ type: 'sentence', text }));
  }

  private onAsrError(error: Error): void {
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
    console.log(
      `  唤醒    transactionId=${transactionId}  requestId=${requestId.slice(0, 8)}…`,
    );
  }

  // ------------------------------------------------------------------ 一轮

  private enqueueTurn(text: string, image: ImageAttachment | undefined, ticket: TurnTicket): void {
    this.serialChain = this.serialChain.then(() => {
      if (this.core.fsm.isStale(ticket)) {
        console.log('  （丢弃：用户已插话，这一轮过时了）');
        return;
      }
      this.downlinkChunks = [];
      this.uplinkDuringPlayback = [];
      return this.runner.run(text, image).then(() => undefined);
    }).catch((error: Error) => {
      console.error(`  ✗ 队列任务失败（不影响后续）: ${error.message}`);
    });
  }

  // ------------------------------------------------------------------ 落盘

  /**
   * 落盘。正常在一轮结束后调（那时才是完整播放期），
   * 但手机 listen 窗口到点会主动断开，进程随即退出 ——
   * 所以 `close` 时也要再兜一次，否则整轮白跑。
   */
  private flushDump(): void {
    const { dumpDir } = this.options;
    const turn = this.core.turn;
    if (!dumpDir || turn === 0 || this.dumpedTurn === turn) {
      return;
    }
    this.dumpedTurn = turn;
    try {
      mkdirSync(dumpDir, { recursive: true });
      const downlink = Buffer.concat(this.downlinkChunks);
      const uplink = Buffer.concat(this.uplinkDuringPlayback);
      writeFileSync(join(dumpDir, `down_${turn}.pcm`), downlink);
      writeFileSync(join(dumpDir, `up_${turn}.pcm`), uplink);
      console.log(
        `  落盘    down_${turn}.pcm ${downlink.length}B  up_${turn}.pcm ${uplink.length}B`
        + `  (上行播放期 ${(pcm16DurationMs(uplink.length, UPSTREAM_SAMPLE_RATE) / 1000).toFixed(2)} s)`,
      );
    } catch (error) {
      console.error(`  ✗ 落盘失败: ${(error as Error).message}`);
    }
  }
}
