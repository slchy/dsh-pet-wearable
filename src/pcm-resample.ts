/**
 * 纯 TS 单声道 PCM16 (s16le) 线性重采样（零原生依赖）。
 *
 * 主要用于把宿主统一的 16 kHz 上行音频转换为 OpenAI Realtime 要求的 24 kHz 上行，
 * 避免为了方言差异改动 VAD / TurnJudge / UplinkPipeline 的 16 kHz 基准时钟。
 */

/**
 * 单声道 s16le PCM 重采样。`fromRate === toRate` 或输入为空时零拷贝原样返回。
 */
export function resamplePcm16Mono(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new RangeError(`无效的采样率：fromRate=${fromRate}, toRate=${toRate}`);
  }
  if (pcm.length < 2) {
    return pcm.length === 0 ? pcm : Buffer.alloc(0);
  }
  if (fromRate === toRate) {
    return pcm;
  }
  const inSamples = pcm.length >> 1;
  if (inSamples <= 1) {
    const outCount = Math.max(1, Math.round((inSamples * toRate) / fromRate));
    const sample = pcm.readInt16LE(0);
    const out = Buffer.allocUnsafe(outCount * 2);
    for (let i = 0; i < outCount; i += 1) {
      out.writeInt16LE(sample, i * 2);
    }
    return out;
  }

  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const ratio = fromRate / toRate;
  const lastIndex = inSamples - 1;

  for (let i = 0; i < outSamples; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = pcm.readInt16LE(Math.min(idx, lastIndex) * 2);
    const s1 = pcm.readInt16LE(Math.min(idx + 1, lastIndex) * 2);
    const interp = Math.round(s0 + (s1 - s0) * frac);
    const clamped = interp > 32_767 ? 32_767 : interp < -32_768 ? -32_768 : interp;
    out.writeInt16LE(clamped, i * 2);
  }
  return out;
}
