/**
 * 上行管道：mSBC → PCM（ffmpeg）→ 能量门 → 交给 STT 的「有声段」。
 *
 * 抽出来的理由：这段逻辑原本埋在 `voice-session.ts` 的 `bindUpstream()` 里，
 * 和 socket 回调混在一起，改一次判停就要动编排代码。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { EnergyGate, type PrerollFrame } from './energy-gate.ts';
import type { AudioFrame } from './engine-contract.ts';
import { pcm16Gain, pcm16PeakDbfs } from './pcm.ts';
import { WINDOW, type SpeechVadStream } from './vad.ts';

/** 神经 VAD 一帧：512 个 int16 = 1024 字节 = 16 kHz 下 32 ms。 */
const VAD_FRAME_BYTES = WINDOW * 2;
const VAD_FRAME_MS = 32;

export interface UplinkGateConfig {
  readonly thresholdDbfs: number;
  readonly holdMs: number;
  readonly prerollMs: number;
}

export interface UplinkPipelineOptions {
  readonly ffmpegPath: string;
  /**
   * 上行编码。`msbc` 走 ffmpeg 解码；`pcm16` 表示对端已经是 PCM16 16 kHz
   * 单声道，直接进增益/能量门（雷鸟的 `AudioRecord` 就是这种）。
   *
   * 缺省 `msbc` —— v1 协议的历史行为。
   */
  readonly codec?: 'msbc' | 'pcm16';
  /** 解码后的采样率（mSBC 固定 16 kHz） */
  readonly sampleRate: number;
  /**
   * 能量门配置。
   *
   * `thresholdDbfs` 是**放大后**（也就是实际喂给 ASR）的电平门限 —— 所以调大
   * [gain] 会同时让门更容易被推开。这是有意的：眼镜 mic 电平本来就低，小声说话
   * 时原始峰值只有 −65 dBFS 左右，若门限按放大前的电平算，增益再大也唤不醒 VAD。
   */
  readonly gate: UplinkGateConfig;
  /**
   * 上行增益（线性倍数，默认 1）。眼镜 mic 采进来的电平偏低，实测 ASR 识别率
   * 明显受它影响；放大后再喂 STT。
   *
   * ⚠️ 它同时决定门的灵敏度（见 [gate]）：增益越大，同样大的小声越容易被判为有声，
   * 噪声底也跟着抬高。`VOICE_PEAK_DBFS` 要按**放大后**的电平去设。
   */
  readonly gain?: number;
  readonly log: (line: string) => void;
  readonly onError: (line: string) => void;
  /**
   * 可注入时钟，默认 `Date.now`。
   *
   * **必须和宿主（`voice-session` 的 `SystemClock`）是同一把尺**：`AudioFrame.tsMs`
   * 与能量门的保持窗口都从这里取。不传时门用 `Date.now()`、宿主用单调毫秒，
   * 两边比出来的「静音多久」是个天文数字（真机踩过一次：帧时戳和判停的时间戳
   * 差 1.7e12，插话判据整场静默失效且没有一行日志）。
   */
  readonly now?: () => number;
  /**
   * 电平表周期（毫秒）。> 0 时每这么久打一行「上行电平 峰值 -XX dBFS」。
   *
   * 调增益时唯一可靠的依据：只看"开门那一瞬"的峰值会误判 —— 门一开就记录，
   * 记到的往往是**起音**（最轻的那一下），而不是这段话真正的响度。实测就是这么
   * 看错了一次：以为 mic 只有 −57 dBFS，其实那只是跨过门限的第一块。
   *
   * 默认关（0）：正常运行时每 2 s 一行太吵。调音时开 `MIAI_LEVEL_LOG=2000`。
   */
  readonly levelLogMs?: number;
  /**
   * 连续多少块过门限才把 `AudioFrame.voiced` 打成 true。
   *
   * 缺省 1，能量门的历史行为。生产连接传 2，与静音触发器的两帧去抖对齐：
   * 单帧尖峰不再把 `silenceMs` 打回 0。
   */
  readonly voiceDebounceFrames?: number;
  /**
   * 本连接的神经 VAD 流。`null` / 缺省时能量门保持完全同步，和旧路径逐块一致。
   * 有流时放大后的 PCM 先切成 32 ms 再串行推理，禁止并发调用同一个流。
   */
  readonly vadStream?: SpeechVadStream | null;
  /** 设备正在播报。能量门据此抬高起音门槛，挡住扬声器回波。 */
  readonly isSpeaking?: () => boolean;
  readonly vadStartThreshold?: number;
  readonly vadReleaseThreshold?: number;
  readonly vadSpeakingStartThreshold?: number;
  readonly speakingDebounceFrames?: number;
  /** 每块解码后的 PCM：判停器、落盘都要它 */
  readonly onPcm: (pcm: Buffer) => void;
  /**
   * 每块解码后、**放大前**的 PCM。档案用它 —— 存档必须是原始电平，
   * 否则事后没法重算"换个增益会不会识别出来"。
   */
  readonly onRawPcm?: (pcm: Buffer) => void;
  /**
   * 有声开始：先把 preroll 喂进 STT，再继续喂后续。
   *
   * `prerollFrames` 是同一批预卷，`voiced` 已由能量门标好。给了就用它，
   * 不要再对 `preroll` 重算峰值。缺省（老调用方）可以不传。
   */
  readonly onSpeechOpen: (
    peakDbfs: number,
    preroll: readonly Buffer[],
    prerollMs: number,
    prerollFrames?: readonly PrerollFrame[],
  ) => void;
  /**
   * 门开着时的每一块音频 —— **声学前端的唯一出口**（见 `engine-contract.ts` 契约①）。
   *
   * 为什么给一整个 `AudioFrame` 而不是 `(pcm, voiced)`：下游各自需要的量不一样
   * （ASR 要 `voiced` 决定暂存、omni 旁路要它决定 mute、封段/投机/判停要
   * `silenceMs`），而「各取一个」的后果是各算一遍 —— 真机上就是四个阈值
   * （20/100/150/200 ms）对不上同一段音频。
   */
  readonly onFrame: (frame: AudioFrame) => void;
  /** 持续静音：请 STT 出定稿并挂断这一路。`gapMs` = 距最后一个有声块多久 */
  readonly onSpeechClose: (gapMs?: number) => void;
}

export class UplinkPipeline {
  private readonly options: UplinkPipelineOptions;
  private readonly gate: EnergyGate;
  private readonly ffmpeg: ChildProcessWithoutNullStreams | null;
  /** 统一时钟：能量门、电平表、`AudioFrame.tsMs` 共用（见 `UplinkPipelineOptions.now`） */
  private readonly now: () => number;
  private received = false;
  /** 关管道之后为真。吸收态：`push` / `onPcm` 直接丢弃，断连后的 ffmpeg 尾包不许再进门。 */
  private closed = false;

  /** 电平表：窗口内峰值与窗口起点 */
  private meterPeak = -Infinity;
  private meterAt = 0;
  /** 能量门周期号：每次开门 +1（`AudioFrame.gateSeq`）。闭门期间不变 */
  private gateSeq = 0;
  /** 凑不满 32 ms 的放大后 PCM。`end()` 丢掉，不拿半帧去推理。 */
  private vadCarry: Buffer = Buffer.alloc(0);
  private readonly vadQueue: Array<{
    readonly frame: Buffer;
    readonly tsMs: number;
    readonly floatFrame: Float32Array;
  }> = [];
  /** 上一帧神经 VAD 的时间戳，保证一次来包切出的多帧单调不减。 */
  private lastVadTsMs = 0;
  private vadPumping = false;
  private readonly vadWaiters: Array<() => void> = [];

  /**
   * 每 `levelLogMs` 打一行窗口峰值。
   *
   * 峰值取的是**放大后**的电平（和喂给 ASR 的一致），这样读数和门限是同一个坐标系。
   */
  private meter(pcm: Buffer, now: number): void {
    const period = this.options.levelLogMs ?? 0;
    if (period <= 0) {
      return;
    }
    if (this.meterAt === 0) {
      this.meterAt = now;
      this.meterPeak = -Infinity;
    }
    const peak = pcm16PeakDbfs(pcm);
    if (peak > this.meterPeak) {
      this.meterPeak = peak;
    }
    if (now - this.meterAt < period) {
      return;
    }
    const frames = Number.isFinite(this.meterPeak) ? this.meterPeak.toFixed(1) : '—';
    this.options.log(`  电平    峰值 ${frames} dBFS（${((now - this.meterAt) / 1000).toFixed(1)} s）`);
    this.meterAt = now;
    this.meterPeak = -Infinity;
  }

  constructor(options: UplinkPipelineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;

    // 门限作用在**放大后**的波形上：增益越大，小声越容易被判为有声。
    // 早先这里按 +20log10(gain) 同步抬高门限（"保持选择性不变"），结果是
    // 增益加得再多，小声说话依然推不开门 —— 用户的原话是「小声说话无法触发 VAD」。
    this.gate = new EnergyGate({
      thresholdDbfs: options.gate.thresholdDbfs,
      holdMs: options.gate.holdMs,
      prerollBytes: Math.round((options.gate.prerollMs / 1000) * options.sampleRate * 2),
      sampleRate: options.sampleRate,
      // **必须透传**：门自己默认 `Date.now()`，跟宿主的 `SystemClock` 差 1.7e12。
      // 漏传的症状是「第一块静音就把门关了」（gap 看似无穷大），或反过来永不关门。
      now: this.now,
      ...(options.voiceDebounceFrames === undefined
        ? {}
        : { voiceDebounceFrames: options.voiceDebounceFrames }),
      ...(options.vadStartThreshold === undefined
        ? {}
        : { vadStartThreshold: options.vadStartThreshold }),
      ...(options.vadReleaseThreshold === undefined
        ? {}
        : { vadReleaseThreshold: options.vadReleaseThreshold }),
      ...(options.vadSpeakingStartThreshold === undefined
        ? {}
        : { vadSpeakingStartThreshold: options.vadSpeakingStartThreshold }),
      ...(options.speakingDebounceFrames === undefined
        ? {}
        : { speakingDebounceFrames: options.speakingDebounceFrames }),
    });

    this.ffmpeg = options.codec === 'pcm16'
      ? null
      : spawn(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'sbc', '-i', 'pipe:0',
        '-f', 's16le', '-ar', String(options.sampleRate), '-ac', '1', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;

    if (this.ffmpeg !== null) {
      this.ffmpeg.stderr.on('data', (data: Buffer) => {
        if (this.closed) {
          return; // 收尾阶段的抱怨不值得看（见 end()）
        }
        const text = data.toString().trim();
        if (text) {
          options.onError(text);
        }
      });

      this.ffmpeg.stdout.on('data', (pcm: Buffer) => { this.onPcm(pcm); });
    }
  }

  /** 送一段上行音频。`msbc` 是压缩帧，`pcm16` 是已经解码好的字节。 */
  push(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    if (this.options.codec === 'pcm16') {
      this.received = true;
      this.onPcm(chunk);
      return;
    }
    if (this.ffmpeg !== null && !this.ffmpeg.stdin.destroyed) {
      this.received = true;
      this.ffmpeg.stdin.write(chunk);
    }
  }

  /** 关管道。ffmpeg 偶尔不肯立刻退，兜底一秒后 kill。 */
  end(): void {
    this.closed = true;
    this.vadQueue.length = 0;
    this.vadCarry = Buffer.alloc(0);
    this.options.vadStream?.reset();
    if (!this.vadPumping) this.resolveVadWaiters();
    const ffmpeg = this.ffmpeg;
    if (ffmpeg === null) {
      return;
    }
    if (!this.received) {
      // 这段连接没收到任何音频：优雅关闭反而会让 ffmpeg 报
      // 「Output file does not contain any stream」，直接杀掉更干净
      try {
        ffmpeg.kill();
      } catch {
        // 已退出
      }
      return;
    }
    if (!ffmpeg.stdin.destroyed) {
      ffmpeg.stdin.end();
    }
    setTimeout(() => {
      try {
        ffmpeg.kill();
      } catch {
        // 已退出
      }
    }, 1000).unref?.();
  }

  /**
   * 等当前神经 VAD 队列排空。没有流、或队列已空时立刻完成。
   * `end()` 会丢掉还没开始推理的帧，这一份会在飞行中的那一帧丢弃结果后完成。
   */
  flushVad(): Promise<void> {
    if (!this.vadPumping && this.vadQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.vadWaiters.push(resolve);
      this.kickVad();
    });
  }

  private onPcm(raw: Buffer): void {
    if (this.closed) {
      return;
    }
    const { onPcm, onRawPcm } = this.options;

    onRawPcm?.(raw);

    const pcm = pcm16Gain(raw, this.options.gain ?? 1);
    onPcm(pcm);

    // 能量门的保持窗口和 `AudioFrame.tsMs` 共用这一下。同一帧再读一次时钟，
    // 两边的「静音多久」就会差一截。有神经 VAD 时，这一下是整包的到达时刻，
    // 切出来的 32 ms 帧再按包尾倒推。
    const tsMs = this.now();
    this.meter(pcm, tsMs);
    if (this.options.vadStream == null) {
      this.feedGateFrame(pcm, tsMs);
      return;
    }
    this.enqueueVadFrames(pcm, tsMs);
  }

  /** 无神经 VAD 与推理完成后共用：把一块 PCM 送进能量门，再按决策回调。 */
  private feedGateFrame(pcm: Buffer, tsMs: number, speechProb?: number): void {
    const { onSpeechOpen, onFrame, onSpeechClose, log } = this.options;
    const speaking = this.options.isSpeaking?.() === true;
    const decision = this.gate.process(pcm, tsMs, speechProb, { speaking });
    if (decision.opened) {
      log(
        `  上行    有声 ${decision.opened.peakDbfs.toFixed(1)} dBFS → 开始推送`
        + `（补 ${decision.opened.preroll.length} 块 / ${decision.opened.prerollMs} ms）`,
      );
      this.gateSeq += 1;
      onSpeechOpen(
        decision.opened.peakDbfs,
        decision.opened.preroll,
        decision.opened.prerollMs,
        decision.opened.prerollFrames,
      );
    }
    if (decision.forward) {
      // 与能量门同一把尺：下游拿 `tsMs` 和宿主的 `lastSentenceAt` 比「这之后有没有人说话」
      onFrame({
        pcm,
        voiced: decision.voiced,
        silenceMs: decision.silenceMs,
        gateSeq: this.gateSeq,
        tsMs,
      });
    }
    if (decision.closed) {
      // 带上「距上次有声多久」：holdMs 只有 2 s，如果 gap 远大于它，
      // 说明不是"用户没说话"，而是**上行断流**（播放期间采集中断/被设备暂停）。
      log(
        '  上行    持续静音 → 停推并挂断（避免 IDLE_TIMEOUT）'
        + (decision.closedGapMs === undefined ? '' : `，距上次有声 ${Math.round(decision.closedGapMs)} ms`),
      );
      onSpeechClose(decision.closedGapMs);
    }
  }

  /** 把放大后的 PCM 切成 32 ms。一次来包切出多帧时，时间戳从包尾倒推并且单调不减。 */
  private enqueueVadFrames(pcm: Buffer, chunkNow: number): void {
    const pending = this.vadCarry.length === 0 ? pcm : Buffer.concat([this.vadCarry, pcm]);
    const frameCount = Math.floor(pending.length / VAD_FRAME_BYTES);
    for (let i = 0; i < frameCount; i += 1) {
      const start = i * VAD_FRAME_BYTES;
      const frame = Buffer.from(pending.subarray(start, start + VAD_FRAME_BYTES));
      const tsMs = Math.max(this.lastVadTsMs, chunkNow - (frameCount - 1 - i) * VAD_FRAME_MS);
      this.lastVadTsMs = tsMs;
      this.vadQueue.push({ frame, tsMs, floatFrame: pcm16ToUnitFloat(frame) });
    }
    const rest = pending.subarray(frameCount * VAD_FRAME_BYTES);
    this.vadCarry = rest.length === 0 ? Buffer.alloc(0) : Buffer.from(rest);
    if (frameCount > 0) this.kickVad();
  }

  /** 单执行者。同一个 `SpeechVadStream.process` 绝不重叠。 */
  private kickVad(): void {
    if (this.vadPumping || this.closed || this.vadQueue.length === 0 || this.options.vadStream == null) {
      return;
    }
    this.vadPumping = true;
    this.drainVadQueue().finally(() => {
      this.vadPumping = false;
      if (!this.closed && this.vadQueue.length > 0) {
        this.kickVad();
        return;
      }
      this.resolveVadWaiters();
    });
  }

  private async drainVadQueue(): Promise<void> {
    const stream = this.options.vadStream;
    if (stream == null) return;
    while (!this.closed && this.vadQueue.length > 0) {
      const item = this.vadQueue.shift();
      if (item === undefined) break;
      let prob = 0;
      try {
        prob = await stream.process(item.floatFrame);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.options.onError(`VAD ${detail}`);
      }
      if (this.closed) return;
      this.feedGateFrame(item.frame, item.tsMs, prob);
    }
  }

  private resolveVadWaiters(): void {
    const waiters = this.vadWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function pcm16ToUnitFloat(frame: Buffer): Float32Array {
  const out = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i += 1) {
    out[i] = frame.readInt16LE(i * 2) / 32768;
  }
  return out;
}
