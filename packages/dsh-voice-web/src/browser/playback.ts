/**
 * 浏览器侧播放：下行 PCM16（24 kHz）→ 排队播出去，能被打断。
 *
 * 每个下行块单独做成一个 `AudioBuffer`，靠 `nextStartAt` 首尾相接排进同一条时间线。
 * 不自己维护 Web Audio 的抖动缓冲：服务端实测是 4–6 倍速突发下发（一轮 10.5 s
 * 的音频可能 2.9 s 就灌完），按到达顺序排队正好接住，不需要额外缓冲层。
 *
 * 采样率交给 Web Audio 自己重采样：`createBuffer` 允许指定与 context 不同的
 * 采样率，播放时由音频线程处理。这样采集那边可以固定用一个 48 kHz 的 context
 * —— 回声消除要靠「同一个 context 里正在播放的信号」当参考。
 *
 * 输出电平走一条 `AnalyserNode`：每个块先接到分析节点，节点再进 destination
 * （分析节点不改信号，回声消除仍看得到同一条输出）。`getLevel()` 只往一块
 * 复用的时域缓冲里填数，60 fps 上不再分配。
 */

export interface PlaybackOptions {
  readonly context: AudioContext;
  /** 下行采样率，与 `frame.ts` 里写的 24 kHz 对齐 */
  readonly sampleRate?: number;
  /**
   * 第一块之前先等多久再开播（秒）。
   *
   * 太小会因为主线程抖动把一块挤到过去、造成爆音；太大就是白加的延迟。
   */
  readonly startDelaySec?: number;
  /**
   * 出声状态变化：有声音在排 → `true`，排空 → `false`。
   *
   * 页面靠它显示"它在说话"；将来做播放期抬门限也要挂在这里。
   */
  readonly onActivity?: (busy: boolean) => void;
}

export interface PlaybackHandle {
  /** 收到一个下行 Audio 帧就调用一次 */
  push(pcm: Uint8Array): void;
  /** 打断：立刻静音并丢掉所有排队的块 */
  stop(): void;
  /** 还有没有声音在播或在排队 */
  readonly busy: boolean;
  /**
   * 输出电平：时域 RMS 乘一点增益后夹到 `[0, 1]`。
   * 已关闭、没在说、或分析节点没建起来时为 `0`。
   */
  getLevel(): number;
  /** 拆掉已排的音频（收尾用，与 `stop` 的区别是不再接受新块） */
  close(): void;
}

/** 建得起来的输出电平表。浮点缓冲和字节缓冲二选一，另一边留空。 */
interface OutputMeter {
  readonly analyser: AnalyserNode;
  readonly floatSamples: Float32Array<ArrayBuffer> | null;
  readonly byteSamples: Uint8Array<ArrayBuffer> | null;
}

/**
 * 最小的 `AudioContext` mock 可能没有 `createAnalyser`。失败就退回直连
 * destination，电平恒为 0，播放本身不受影响。
 */
function createOutputMeter(context: AudioContext): OutputMeter | null {
  let analyser: AnalyserNode | null = null;
  try {
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    analyser.connect(context.destination);
    // 缓冲长度跟 fftSize 走，整段生命周期只分配这一次。
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      return {
        analyser,
        floatSamples: new Float32Array(analyser.fftSize),
        byteSamples: null,
      };
    }
    return {
      analyser,
      floatSamples: null,
      byteSamples: new Uint8Array(analyser.fftSize),
    };
  } catch {
    if (analyser !== null) {
      try {
        analyser.disconnect();
      } catch {
        // 节点没连上，或 mock 没有 disconnect
      }
    }
    return null;
  }
}

/** 浮点时域样本已经在 [-1, 1]。 */
function floatRms(samples: Float32Array<ArrayBuffer>): number {
  const count = samples.length;
  if (count === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

/**
 * `getByteTimeDomainData` 以 128 为静音。不先折回 [-1, 1] 的话，
 * 静音的 RMS 会被增益放大成满幅。
 */
function byteRms(samples: Uint8Array<ArrayBuffer>): number {
  const count = samples.length;
  if (count === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = ((samples[i] ?? 128) - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

function scaledLevel(rms: number): number {
  const level = Math.min(1, rms * 4.5);
  return level > 0 ? level : 0;
}

class Playback implements PlaybackHandle {
  private readonly options: PlaybackOptions;
  private readonly sampleRate: number;
  private readonly startDelaySec: number;
  private readonly running = new Set<AudioBufferSourceNode>();
  private nextStartAt = 0;
  private closed = false;
  /** 已经向页面报过「在说」。`stop()` 与 `onended` 都只在它为真时回报一次空闲。 */
  private speaking = false;
  private analyser: AnalyserNode | null;
  private floatSamples: Float32Array<ArrayBuffer> | null;
  private byteSamples: Uint8Array<ArrayBuffer> | null;

  constructor(options: PlaybackOptions) {
    this.options = options;
    this.sampleRate = options.sampleRate ?? 24_000;
    this.startDelaySec = options.startDelaySec ?? 0.04;
    const meter = createOutputMeter(options.context);
    this.analyser = meter?.analyser ?? null;
    this.floatSamples = meter?.floatSamples ?? null;
    this.byteSamples = meter?.byteSamples ?? null;
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  push(pcm: Uint8Array): void {
    if (this.closed || pcm.length < 2) {
      return;
    }
    const { context } = this.options;
    const samples = pcm.length >> 1;
    const buffer = context.createBuffer(1, samples, this.sampleRate);
    const out = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i += 1) {
      out[i] = view.getInt16(i * 2, true) / 32768;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    // 有分析节点就只接到它上面（它已经连着 destination）。否则直连，电平保持 0。
    source.connect(this.analyser ?? context.destination);

    // 服务端下行的块首尾相接，这里只保证不重叠、不留空
    const startAt = Math.max(context.currentTime + this.startDelaySec, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;

    this.running.add(source);
    if (!this.speaking) {
      this.speaking = true;
      this.options.onActivity?.(true);
    }
    source.onended = () => {
      this.running.delete(source);
      if (this.running.size === 0 && this.speaking) {
        this.speaking = false;
        this.options.onActivity?.(false);
      }
    };
  }

  stop(): void {
    // 先放下旗标再 `source.stop()`：有的实现会同步进 `onended`，
    // 那时再报一次 false，页面就会看到两次「说完了」。
    const notify = this.speaking;
    this.speaking = false;
    for (const source of this.running) {
      try {
        source.stop();
      } catch {
        // 还没 start 或已经停过
      }
    }
    this.running.clear();
    this.nextStartAt = 0;
    if (notify) {
      this.options.onActivity?.(false);
    }
  }

  /**
   * 归一化输出 RMS。没在播、已关闭、或没有分析节点时直接 0，
   * 避免去读一条已经拆掉的图。
   */
  getLevel(): number {
    const analyser = this.analyser;
    if (this.closed || !this.speaking || analyser === null) {
      return 0;
    }
    const floats = this.floatSamples;
    const bytes = this.byteSamples;
    try {
      if (floats !== null) {
        analyser.getFloatTimeDomainData(floats);
        return scaledLevel(floatRms(floats));
      }
      if (bytes === null) {
        return 0;
      }
      analyser.getByteTimeDomainData(bytes);
      return scaledLevel(byteRms(bytes));
    } catch {
      return 0;
    }
  }

  close(): void {
    this.closed = true;
    this.stop();
    const analyser = this.analyser;
    this.analyser = null;
    this.floatSamples = null;
    this.byteSamples = null;
    if (analyser === null) {
      return;
    }
    try {
      analyser.disconnect();
    } catch {
      // 已经断开，或 mock 没有 disconnect
    }
  }
}

export function createPlayback(options: PlaybackOptions): PlaybackHandle {
  return new Playback(options);
}
