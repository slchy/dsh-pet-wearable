/**
 * 判停器的滚动音频窗口。
 *
 * 只负责「最近一段 PCM」的拼接、按字节封顶、裁掉尾部静音。没有定时器，
 * 也不认识 `seq`：哪一次快照还能不能用来定稿，由 {@link UtteranceAssembler}
 * 拿着 `lastSnapshotBytes` 自己比。
 *
 * 裁尾门限必须比开门门槛低一截。开门门槛（`silenceDb`，默认 −40 dBFS）问的是
 * 「有没有人说话」，而这台设备的语音峰值本身就在 −32…−40；拿它当静音会把
 * 最后几个音节裁掉，同一句的 p 能从 0.89 掉到 0.28。
 */
import { pcm16DurationMs, pcm16TrimTrailingSilence } from '../pcm.ts';

export interface AudioSnapshotOptions {
  /** 滚动窗口上限（字节）。超了丢掉最老的块，但至少留一块。 */
  readonly recentMaxBytes: number;
  /**
   * 时长换算用的采样率。生产上行是 16 kHz。
   *
   * `pcm16TrimTrailingSilence` 自身按 16 kHz 步进；这里的采样率只服务
   * {@link AudioSnapshotBuffer.durationMs}，两条路都传 16 kHz。
   */
  readonly sampleRate: number;
  /** 开门门槛（dBFS）。不设 = 快照原样返回，不裁尾。 */
  readonly silenceDb?: number;
  /** 裁尾门限比开门门槛再低多少 dB。缺省 20。 */
  readonly silenceFloorOffsetDb?: number;
  /** 最后一个有声窗口之后再留多少毫秒。缺省 0。 */
  readonly trailingTrimMs?: number;
}

export class AudioSnapshotBuffer {
  private readonly recentMaxBytes: number;
  private readonly sampleRate: number;
  private readonly silenceDb: number | undefined;
  private readonly silenceFloorOffsetDb: number;
  private readonly trailingTrimMs: number;
  private readonly recentChunks: Buffer[] = [];
  private recentBytes = 0;

  constructor(options: AudioSnapshotOptions) {
    this.recentMaxBytes = options.recentMaxBytes;
    this.sampleRate = options.sampleRate;
    this.silenceDb = options.silenceDb;
    this.silenceFloorOffsetDb = options.silenceFloorOffsetDb ?? 20;
    this.trailingTrimMs = options.trailingTrimMs ?? 0;
  }

  /** 追加一块上行 PCM。拷贝一份，调用方随后复用原来的 Buffer 也不影响窗口。 */
  push(chunk: Buffer): void {
    this.recentChunks.push(Buffer.from(chunk));
    this.recentBytes += chunk.length;
    this.trim();
  }

  /**
   * 新一轮开口：把窗口重置成这一句的预卷。
   *
   * 判停看的是「这一句」，不是连着上一轮回答的 8 秒滚动。短句若带着上一轮，
   * p 会从 0.95 掉到 0.26，等于什么都没判。
   */
  reset(chunks: readonly Buffer[] = []): void {
    this.recentChunks.length = 0;
    for (const chunk of chunks) {
      this.recentChunks.push(Buffer.from(chunk));
    }
    this.recentBytes = this.recentChunks.reduce((total, chunk) => total + chunk.length, 0);
    this.trim();
  }

  /**
   * 送给判停器的快照：拼接，再裁掉尾巴上多余的静音。
   *
   * 预跑和定稿现算都必须走这里，否则同一句话会因为入口不同拿到两个 p。
   * 尾巴留静音会把语音从窗口末尾推开：同一句留 0 ms 时 p≈0.95，留 800 ms 时 ≈0.04。
   */
  snapshot(): Buffer {
    const pcm = Buffer.concat(this.recentChunks);
    const floor = this.silenceDb === undefined
      ? undefined
      : this.silenceDb - this.silenceFloorOffsetDb;
    return pcm16TrimTrailingSilence(pcm, floor, this.trailingTrimMs);
  }

  clear(): void {
    this.recentChunks.length = 0;
    this.recentBytes = 0;
  }

  /** 窗口里还留着多少字节（裁尾之前）。 */
  get byteLength(): number {
    return this.recentBytes;
  }

  get durationMs(): number {
    return pcm16DurationMs(this.recentBytes, this.sampleRate);
  }

  private trim(): void {
    while (this.recentBytes > this.recentMaxBytes && this.recentChunks.length > 1) {
      const dropped = this.recentChunks.shift();
      this.recentBytes -= dropped?.length ?? 0;
    }
  }
}
