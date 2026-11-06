/**
 * PCM16 单声道小端的纯函数与定长缓冲。
 *
 * 本模块**不做任何 I/O**，不依赖其它业务模块，可单独测试。
 */

/** 16 kHz × 16 bit × 单声道 = 32 字节/毫秒 */
export const PCM16_BYTES_PER_MS_AT_16K = 32;

/** 全零 PCM 的峰值电平（dBFS）。用 -120 而不是 -Infinity，避免日志里出现 Infinity。 */
export const PCM16_SILENCE_DBFS = -120;

/**
 * 峰值电平（dBFS）。
 *
 * 用**峰值**而不是 RMS：判的是「这段到底有没有人声」，瞬态比能量更敏感，
 * 而回声/底噪在峰值上看得更清楚（实测播放期回波底噪 −80 dBFS）。
 */
export function pcm16PeakDbfs(pcm: Buffer): number {
  let peak = 0;
  const samples = pcm.length >> 1;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i << 1);
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  return peak === 0 ? PCM16_SILENCE_DBFS : 20 * Math.log10(peak / 32768);
}

/** 字节数 → 毫秒 */
export function pcm16DurationMs(bytes: number, sampleRate: number): number {
  return (bytes / (sampleRate * 2)) * 1000;
}

/**
 * 按**字节**定长的滑动预卷缓冲。
 *
 * 为什么不能按块数：ffmpeg 每次 `data` 事件的块大小不固定 —— 实测同一次会话里
 * 既出现「8 块 = 105 ms」也出现「3 块 = 225 ms」。按块数留 8 块在最坏情况下
 * 只能盖 105 ms，连一个中文音节都不够，于是开头被削
 * （「你在运行什么」被识别成「李运行在什么」）。
 */
export class PcmPreroll {
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    while (this.bufferedBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bufferedBytes -= dropped?.length ?? 0;
    }
  }

  /** 取出全部内容并清空。 */
  drain(): Buffer[] {
    this.bufferedBytes = 0;
    return this.chunks.splice(0, this.chunks.length);
  }

  get byteLength(): number {
    return this.bufferedBytes;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  durationMs(sampleRate: number): number {
    return pcm16DurationMs(this.bufferedBytes, sampleRate);
  }
}
