/**
 * 阿里云实时识别会话：一条 TCP 连接的完整生命周期。
 *
 * <h2>职责</h2>
 *
 * 只做**编排**：把解帧、能量门、句子合并、一轮执行、控制口、落盘串起来。
 * 每部分的行为都在各自的模块里，本文件不重复实现任何判定逻辑。
 *
 * ```text
 * TCP ──FrameDecoder──┬─ Audio ──▶ ffmpeg ──▶ EnergyGate ──▶ AliyunAsr
 *                     ├─ Image ──▶ 拍照等待 / 识图轮次            │
 *                     └─ Wake  ──▶ 诊断日志                      │
 *                                                                ▼
 * 工具控制口 ◀── take_photo / end_session             UtteranceAssembler
 *      │                                                         │
 *      └──────────── FrameWriter ◀── TurnRunner ◀── 一轮定稿 ◀───┘
 * ```
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { AliyunAsr } from './aliyun-asr.ts';
import { DialogFsm, type TurnTicket } from './dialog-fsm.ts';
import { EnergyGate } from './energy-gate.ts';
import {
  DownstreamFrameType,
  FrameDecoder,
  FrameWriter,
  UpstreamFrameType,
} from './frame.ts';
import { pcm16DurationMs } from './pcm.ts';
import { SmartTurn } from './smart-turn.ts';
import { startToolControl, type ToolControl } from './tool-control.ts';
import { TurnRunner } from './turn-runner.ts';
import { UtteranceAssembler } from './utterance-assembler.ts';
import { isWakeWordOnly } from './wake-word.ts';
import type { VoiceAgent } from './agent.ts';
import type { ImageAttachment } from './session.ts';

/** 上行采样率：mSBC 解码后固定 16 kHz */
export const UPSTREAM_SAMPLE_RATE = 16_000;

export interface AliyunSessionOptions {
  /** 监听端口 */
  readonly port: number;
  readonly ffmpegPath: string;
  readonly agent: VoiceAgent;
  readonly asr: {
    readonly akId: string;
    readonly akSecret: string;
    readonly appkey: string;
    readonly region: string;
    readonly maxSentenceSilenceMs?: number;
  };
  /** Smart Turn 判停器；缺任一项则不启用，退回固定合并窗口 */
  readonly smartTurn?: {
    readonly pythonPath: string;
    readonly scriptPath: string;
    readonly quietMs: number;
    readonly extendMs: number;
    readonly maxExtensions: number;
    readonly threshold: number;
  };
  /** 能量门 */
  readonly gate: {
    readonly thresholdDbfs: number;
    readonly holdMs: number;
    readonly prerollMs: number;
  };
  /** TTS 输出采样率（与上行不同，不得混用） */
  readonly ttsSampleRate: number;
  /** 文本 → 音频块流。注入而不是在内部 import，便于替换与测试。 */
  readonly synthesize: (text: string) => AsyncIterable<Buffer>;
  /** 播完后额外等待的余量 */
  readonly playbackTailMs: number;
  /** 落盘目录，空串表示不落盘 */
  readonly dumpDir: string;
  /** 照片落盘目录 */
  readonly photoDir: string;
  /** 控制口端口与超时 */
  readonly controlPort: number;
  readonly photoTimeoutMs: number;
  /** 默认的识图提问 */
  readonly imageQuestion: string;
}

interface PhotoWaiter {
  resolve: (jpeg: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * 启动监听，按连接串行处理。返回进程退出码。
 *
 * 与历史实现的差别只在**组织方式**：一条连接一个会话对象，会话内的
 * 各个部件各自持有自己的状态，不再共用一个巨型闭包。
 */
export async function runAliyunServer(options: AliyunSessionOptions): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server: Server = createServer((socket) => {
      new AliyunConnection(socket, options, () => {
        server.close();
        resolve(0);
      }).start();
    });

    server.listen(options.port, '127.0.0.1', () => {
      console.log(`监听 127.0.0.1:${options.port}（阿里云流式识别）`);
      console.log(`手机侧先执行： adb reverse tcp:${options.port} tcp:${options.port}\n`);
    });
  });
}

/** 一条连接的完整状态。 */
class AliyunConnection {
  private readonly socket: Socket;
  private readonly options: AliyunSessionOptions;
  private readonly onFinished: () => void;

  private readonly frames: FrameWriter;
  private readonly decoder: FrameDecoder;
  private readonly fsm: DialogFsm;
  private readonly gate: EnergyGate;
  private readonly smartTurn: SmartTurn | null;
  private readonly assembler: UtteranceAssembler;
  private readonly runner: TurnRunner;
  private readonly asr: AliyunAsr;
  private readonly ffmpeg: ChildProcessWithoutNullStreams;

  private control: ToolControl | null = null;
  private photoWaiter: PhotoWaiter | null = null;
  private serialChain: Promise<void> = Promise.resolve();

  private downlinkChunks: Buffer[] = [];
  private uplinkDuringPlayback: Buffer[] = [];
  private dumpedTurn = 0;

  constructor(socket: Socket, options: AliyunSessionOptions, onFinished: () => void) {
    this.socket = socket;
    this.options = options;
    this.onFinished = onFinished;

    this.frames = new FrameWriter(socket);
    this.decoder = new FrameDecoder((message) => {
      console.error(`  ✗ ${message}`);
    });
    this.fsm = new DialogFsm((line) => { console.log(line); });

    const prerollBytes = Math.round((options.gate.prerollMs / 1000)
      * UPSTREAM_SAMPLE_RATE * 2);
    this.gate = new EnergyGate({
      thresholdDbfs: options.gate.thresholdDbfs,
      holdMs: options.gate.holdMs,
      prerollBytes,
      sampleRate: UPSTREAM_SAMPLE_RATE,
    });

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
        this.enqueueTurn(text);
      },
      log: (line) => { console.log(line); },
    });

    this.asr = new AliyunAsr({
      akId: options.asr.akId,
      akSecret: options.asr.akSecret,
      appkey: options.asr.appkey,
      region: options.asr.region,
      maxSentenceSilenceMs: options.asr.maxSentenceSilenceMs,
      log: (line) => { console.log(`  ${line}`); },
      onPartial: (text) => { this.onPartial(text); },
      onSentence: (text, index) => { this.onSentence(text, index); },
      onError: (error) => { this.onAsrError(error); },
    });

    this.ffmpeg = spawn(options.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'sbc', '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(UPSTREAM_SAMPLE_RATE), '-ac', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;

    this.runner = new TurnRunner({
      agent: options.agent,
      synthesize: options.synthesize,
      frames: this.frames,
      fsm: this.fsm,
      ttsSampleRate: options.ttsSampleRate,
      playbackTailMs: options.playbackTailMs,
      onDownlinkChunk: (chunk) => {
        if (this.options.dumpDir) {
          this.downlinkChunks.push(Buffer.from(chunk));
        }
      },
      onTurnFinished: () => {
        this.flushDump();
        if (this.fsm.state === 'ending') {
          console.log('\n--- 会话结束（模型判定）---');
          if (!this.socket.destroyed) {
            this.socket.end();
          }
        }
      },
      log: (line) => { console.log(line); },
    });
  }

  start(): void {
    console.log(`已连接 ${this.socket.remoteAddress}:${this.socket.remotePort}\n`);

    this.bindControl();
    this.bindUpstream();
    this.bindDecoderEvents();
    this.bindClose();
  }

  // ------------------------------------------------------------------ 接线

  private bindControl(): void {
    this.control = startToolControl({
      port: this.options.controlPort,
      photoTimeoutMs: this.options.photoTimeoutMs,
      handlers: {
        takePhoto: () => this.requestPhoto(),
        endSession: () => { this.fsm.requestEnd(); },
        log: (line) => { console.log(line); },
      },
    });
  }

  private bindUpstream(): void {
    this.ffmpeg.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[ffmpeg] ${text}`);
      }
    });

    this.ffmpeg.stdout.on('data', (chunk: Buffer) => {
      if (this.fsm.state === 'speaking' && this.options.dumpDir) {
        this.uplinkDuringPlayback.push(Buffer.from(chunk));
      }

      // 判停器要看音频本身，不只是文本
      this.assembler.addAudio(chunk);

      const decision = this.gate.process(chunk);
      if (decision.opened) {
        console.log(
          `  上行    有声 ${decision.opened.peakDbfs.toFixed(1)} dBFS → 开始推送`
          + `（补 ${decision.opened.preroll.length} 块 / ${decision.opened.prerollMs} ms）`,
        );
        for (const part of decision.opened.preroll) {
          this.asr.feed(part);
        }
      }
      if (decision.forward) {
        this.asr.feed(chunk);
      }
      if (decision.closed) {
        console.log('  上行    持续静音 → 停推并挂断（避免 IDLE_TIMEOUT）');
        this.asr.hangup();
      }
    });
  }

  private bindDecoderEvents(): void {
    this.socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        this.dispatch(frame.type, frame.payload);
      }
    });

    this.socket.on('error', (error: Error) => {
      console.error(`socket 错误: ${error.message}`);
    });
  }

  private dispatch(type: number, payload: Buffer): void {
    switch (type) {
      case UpstreamFrameType.Audio:
        if (!this.ffmpeg.stdin.destroyed) {
          this.ffmpeg.stdin.write(payload);
        }
        return;
      case UpstreamFrameType.Image:
        this.onImage(payload);
        return;
      case UpstreamFrameType.Wake:
        this.onWake(payload);
        return;
      default:
        console.error(`  ✗ 未知帧类型 ${type}（${payload.length} B），已丢弃`);
    }
  }

  private bindClose(): void {
    this.socket.on('close', () => {
      console.log(`\n连接结束，${this.fsm.turn} 轮`);
      this.fsm.close();
      this.assembler.dispose();
      this.smartTurn?.stop();
      this.control?.close();
      this.flushDump();
      this.asr.close();
      if (!this.ffmpeg.stdin.destroyed) {
        this.ffmpeg.stdin.end();
      }
      setTimeout(() => {
        try {
          this.ffmpeg.kill();
        } catch {
          // 已退出
        }
      }, 1000).unref?.();
      this.onFinished();
    });
  }

  // ------------------------------------------------------------------ 事件

  private onPartial(text: string): void {
    console.log(`  … ${text}`);
    // 插话判据用「服务端真的解出了字」，不用能量峰值 ——
    // 噪声能骗过峰值，骗不过识别器。能不能打断由状态机定（只有 speaking 算）。
    const bare = text.replace(/[\s。.,，!！?？、~～]/g, '');
    if (bare.length < 2) {
      return;
    }
    if (!this.fsm.bargeIn(text)) {
      return;
    }
    console.log(`  打断    听到「${text}」→ 停止播放，已排队的轮次作废`);
    this.frames.writeText(DownstreamFrameType.Control, 'stop');
  }

  private onSentence(text: string, index: number): void {
    console.log(`  句 ${index}  ${JSON.stringify(text)}`);
    if (isWakeWordOnly(text)) {
      console.log('  → 唤醒词，丢弃（不算一轮）');
      return;
    }
    this.assembler.addSentence(text);
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

  private onImage(jpeg: Buffer): void {
    this.persistPhoto(jpeg);
    const waiter = this.photoWaiter;
    if (waiter) {
      this.photoWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(jpeg);
      return;
    }
    // 没人等就直接当成「看一眼」的轮次
    this.enqueueTurn(this.options.imageQuestion, {
      mimeType: 'image/jpeg',
      data: jpeg.toString('base64'),
    });
  }

  // ------------------------------------------------------------------ 一轮

  private enqueueTurn(text: string, image?: ImageAttachment): void {
    const ticket: TurnTicket = this.fsm.ticket();
    this.serialChain = this.serialChain.then(() => {
      if (this.fsm.isStale(ticket)) {
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

  // ------------------------------------------------------------------ 拍照

  private requestPhoto(): Promise<Buffer | null> {
    if (this.photoWaiter) {
      return Promise.resolve(null);
    }
    return new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.photoWaiter?.timer === timer) {
          this.photoWaiter = null;
        }
        resolve(null);
      }, this.options.photoTimeoutMs);

      this.photoWaiter = { resolve, timer };
      this.frames.writeText(DownstreamFrameType.Control, 'take_photo');
      console.log('  拍照    已下发指令，等设备回图…');
    });
  }

  private persistPhoto(jpeg: Buffer): void {
    try {
      mkdirSync(this.options.photoDir, { recursive: true });
      const file = join(this.options.photoDir, `photo_${Date.now()}.jpg`);
      writeFileSync(file, jpeg);
      console.log(`  图片    ${jpeg.length} B  ${file}`);
    } catch (error) {
      console.error(`  ✗ 图片落盘失败: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ 落盘

  /**
   * 落盘。正常在一轮结束后调（那时才是完整播放期），
   * 但手机 listen 窗口到点会主动断开，进程随即退出 ——
   * 所以 `close` 时也要再兜一次，否则整轮白跑。
   */
  private flushDump(): void {
    const { dumpDir } = this.options;
    const turn = this.fsm.turn;
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
