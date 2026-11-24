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
  /** 拆掉已排的音频（收尾用，与 `stop` 的区别是不再接受新块） */
  close(): void;
}

class Playback implements PlaybackHandle {
  private readonly sampleRate: number;
  private readonly startDelaySec: number;
  private readonly running = new Set<AudioBufferSourceNode>();
  private nextStartAt = 0;
  private closed = false;
  /** 已经向页面报过「在说」。`stop()` 与 `onended` 都只在它为真时回报一次空闲。 */
  private speaking = false;

  constructor(private readonly options: PlaybackOptions) {
    this.sampleRate = options.sampleRate ?? 24_000;
    this.startDelaySec = options.startDelaySec ?? 0.04;
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
    source.connect(context.destination);

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

  close(): void {
    this.closed = true;
    this.stop();
  }
}

export function createPlayback(options: PlaybackOptions): PlaybackHandle {
  return new Playback(options);
}
