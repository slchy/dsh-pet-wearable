/**
 * Whisper 风格 log-mel 特征（Smart Turn v3.2 的输入），纯零依赖 TypeScript。
 *
 * 1:1 移植自 `bench/eot/whisper_features.py`（旧 Python 运行时使用的同一份特征实现）：
 *
 * - 模型固定吃 8 秒（80×800 的 log-mel，16 kHz 单声道 PCM16）；
 * - 不足 8 秒在**开头**补零（`np.pad(audio, (padding, 0))`），真实音频对齐到窗口末尾；
 * - 归一化在 float32 精度下做（`(x - mean) / sqrt(var + 1e-7)`）；
 * - 频谱是 float64：双侧 reflect padding 200 点、周期 Hann 窗、400 点 rFFT、取前 800 帧。
 *
 * 400 = 2^4 × 5^2，不是 2 的幂。这里用 **radix-2 + radix-5 混合基 Cooley-Tukey**
 * 实现，输出顺序与 `np.fft.rfft` 一致；`fft400()` 导出给单测对照朴素 DFT。
 *
 * ---
 * Copyright (c) 2024-2026, Daily
 *
 * SPDX-License-Identifier: BSD 2-Clause License
 *
 * Portions derived from Hugging Face Transformers
 * (src/transformers/models/whisper/feature_extraction_whisper.py and
 * src/transformers/audio_utils.py):
 *
 *   Copyright 2022 The HuggingFace Inc. team.
 *   Copyright 2023 The HuggingFace Inc. team and the librosa & torchaudio authors.
 *
 *   Licensed under the Apache License, Version 2.0
 *   (https://www.apache.org/licenses/LICENSE-2.0). Modified by Daily.
 */

/** 上行采样率（Hz）。 */
export const WHISPER_SAMPLE_RATE = 16_000;
/** 模型窗口固定 8 秒，按 16 kHz 折成 128,000 个采样点。 */
export const WHISPER_MAX_SAMPLES = 128_000;
/** STFT 帧长。 */
export const WHISPER_N_FFT = 400;
/** STFT 帧移。 */
export const WHISPER_HOP_LENGTH = 160;
/** mel 滤波器个数。 */
export const WHISPER_N_MELS = 80;
/** 交给 ONNX 的帧数（`[1, 80, 800]`）。 */
export const WHISPER_N_FRAMES = 800;

const N_FFT_HALF = WHISPER_N_FFT / 2; // 200
const N_BINS = N_FFT_HALF + 1; // 201
const MEL_FLOOR = 1e-10;
const NORM_VARIANCE_EPS = 1e-7;

// ------------------------------------------------------------------ PCM → 窗口

/**
 * PCM16（小端、16 kHz 单声道）→ 模型窗口（128,000 点 float32）。
 *
 * 超过 8 秒取**末尾** 8 秒；不足 8 秒在**开头**补零 —— 与上游
 * `truncate_audio_to_last_n_seconds()` 的 `np.pad(audio, (padding, 0))` 一致，
 * 让真实语音永远顶到窗口末尾。
 */
export function pcm16ToLast8Seconds(pcm: Buffer): Float32Array {
  const samples = pcm.length >> 1;
  const take = Math.min(samples, WHISPER_MAX_SAMPLES);
  const startSample = samples - take;
  const writeAt = WHISPER_MAX_SAMPLES - take;
  const out = new Float32Array(WHISPER_MAX_SAMPLES);
  for (let i = 0; i < take; i += 1) {
    out[writeAt + i] = Math.fround(pcm.readInt16LE((startSample + i) * 2) / 32768.0);
  }
  return out;
}

// ------------------------------------------------------------------ 400 点混合基 FFT

/** 400 的 radix-2 / radix-5 分解：(p, m) 对，按 DIT 递归顺序排列。 */
const FFT_FACTORS: readonly number[] = [2, 200, 2, 100, 2, 50, 2, 25, 5, 5, 5, 1];

const TWIDDLE_RE = new Float64Array(WHISPER_N_FFT);
const TWIDDLE_IM = new Float64Array(WHISPER_N_FFT);
for (let k = 0; k < WHISPER_N_FFT; k += 1) {
  const angle = (2 * Math.PI * k) / WHISPER_N_FFT;
  TWIDDLE_RE[k] = Math.cos(angle);
  TWIDDLE_IM[k] = -Math.sin(angle);
}

/** radix-5 的固定旋转因子：W5 = exp(-2πi/5)。 */
const C1 = Math.cos((2 * Math.PI) / 5);
const S1 = Math.sin((2 * Math.PI) / 5);
const C2 = Math.cos((4 * Math.PI) / 5);
const S2 = Math.sin((4 * Math.PI) / 5);

/**
 * DIT 递归：把 `inRe/inIm` 按 `fstride` 抽头写进 `outRe/outIm` 的 `[outOff, outOff+p*m)`，
 * 再就地做 p 点蝶形。`inIm` 为 null 时视为全零虚部（纯实数输入）。
 */
function fftWork(
  outRe: Float64Array,
  outIm: Float64Array,
  outOff: number,
  inRe: Float64Array,
  inIm: Float64Array | null,
  inOff: number,
  fstride: number,
  factorIndex: number,
): void {
  const p = FFT_FACTORS[factorIndex]!;
  const m = FFT_FACTORS[factorIndex + 1]!;
  const end = outOff + p * m;

  if (m === 1) {
    let out = outOff;
    let inp = inOff;
    do {
      outRe[out] = inRe[inp]!;
      outIm[out] = inIm === null ? 0 : inIm[inp]!;
      out += 1;
      inp += fstride;
    } while (out !== end);
  } else {
    let out = outOff;
    let inp = inOff;
    do {
      fftWork(outRe, outIm, out, inRe, inIm, inp, fstride * p, factorIndex + 2);
      out += m;
      inp += fstride;
    } while (out !== end);
  }

  if (p === 2) {
    for (let u = 0; u < m; u += 1) {
      const tw = u * fstride;
      const wr = TWIDDLE_RE[tw]!;
      const wi = TWIDDLE_IM[tw]!;
      const i0 = outOff + u;
      const i1 = i0 + m;
      const ar = outRe[i0]!;
      const ai = outIm[i0]!;
      const br0 = outRe[i1]!;
      const bi0 = outIm[i1]!;
      const br = br0 * wr - bi0 * wi;
      const bi = br0 * wi + bi0 * wr;
      outRe[i0] = ar + br;
      outIm[i0] = ai + bi;
      outRe[i1] = ar - br;
      outIm[i1] = ai - bi;
    }
    return;
  }

  // p === 5
  for (let u = 0; u < m; u += 1) {
    const i0 = outOff + u;
    const i1 = i0 + m;
    const i2 = i1 + m;
    const i3 = i2 + m;
    const i4 = i3 + m;

    const a0r = outRe[i0]!;
    const a0i = outIm[i0]!;

    const t1 = u * fstride;
    const t2 = 2 * t1;
    const t3 = 3 * t1;
    const t4 = 4 * t1;

    let ar = outRe[i1]!;
    let ai = outIm[i1]!;
    let wr = TWIDDLE_RE[t1]!;
    let wi = TWIDDLE_IM[t1]!;
    const a1r = ar * wr - ai * wi;
    const a1i = ar * wi + ai * wr;

    ar = outRe[i2]!;
    ai = outIm[i2]!;
    wr = TWIDDLE_RE[t2]!;
    wi = TWIDDLE_IM[t2]!;
    const a2r = ar * wr - ai * wi;
    const a2i = ar * wi + ai * wr;

    ar = outRe[i3]!;
    ai = outIm[i3]!;
    wr = TWIDDLE_RE[t3]!;
    wi = TWIDDLE_IM[t3]!;
    const a3r = ar * wr - ai * wi;
    const a3i = ar * wi + ai * wr;

    ar = outRe[i4]!;
    ai = outIm[i4]!;
    wr = TWIDDLE_RE[t4]!;
    wi = TWIDDLE_IM[t4]!;
    const a4r = ar * wr - ai * wi;
    const a4i = ar * wi + ai * wr;

    const b0r = a1r + a4r;
    const b0i = a1i + a4i;
    const b1r = a2r + a3r;
    const b1i = a2i + a3i;
    const b2r = a1r - a4r;
    const b2i = a1i - a4i;
    const b3r = a2r - a3r;
    const b3i = a2i - a3i;

    // X0
    outRe[i0] = a0r + b0r + b1r;
    outIm[i0] = a0i + b0i + b1i;

    // X1 / X4：± i·(s1·b2 + s2·b3)
    const x1r = S1 * b2r + S2 * b3r;
    const x1i = S1 * b2i + S2 * b3i;
    const base1r = a0r + C1 * b0r + C2 * b1r;
    const base1i = a0i + C1 * b0i + C2 * b1i;
    outRe[i1] = base1r + x1i;
    outIm[i1] = base1i - x1r;
    outRe[i4] = base1r - x1i;
    outIm[i4] = base1i + x1r;

    // X2 / X3：± i·(s1·b3 − s2·b2)
    const x2r = S1 * b3r - S2 * b2r;
    const x2i = S1 * b3i - S2 * b2i;
    const base2r = a0r + C2 * b0r + C1 * b1r;
    const base2i = a0i + C2 * b0i + C1 * b1i;
    outRe[i2] = base2r - x2i;
    outIm[i2] = base2i + x2r;
    outRe[i3] = base2r + x2i;
    outIm[i3] = base2i - x2r;
  }
}

/** 把 400 点 FFT 写进调用方给的缓冲区（不分配）。`outRe/outIm` 长度必须 >= 400。 */
function fft400Into(
  inRe: Float64Array,
  inIm: Float64Array | null,
  outRe: Float64Array,
  outIm: Float64Array,
): void {
  fftWork(outRe, outIm, 0, inRe, inIm, 0, 1, 0);
}

/**
 * 400 点复数 FFT（无输入时虚部按 0 处理）。
 *
 * 导出只给单测对照朴素 DFT；生产走内部的 `fft400Into`（复用缓冲区，无逐帧分配）。
 */
export function fft400(
  real: Float64Array,
  imag?: Float64Array,
): { readonly re: Float64Array; readonly im: Float64Array } {
  const inRe = real.length === WHISPER_N_FFT ? real : real.subarray(0, WHISPER_N_FFT);
  const inIm = imag === undefined
    ? null
    : imag.length === WHISPER_N_FFT ? imag : imag.subarray(0, WHISPER_N_FFT);
  const re = new Float64Array(WHISPER_N_FFT);
  const im = new Float64Array(WHISPER_N_FFT);
  fft400Into(inRe, inIm, re, im);
  return { re, im };
}

// ------------------------------------------------------------------ Hann 窗 / mel 滤波器组

/** 周期 Hann 窗（长度 400）：等价 `np.hanning(401)[:-1]`。 */
const HANN_WINDOW = new Float64Array(WHISPER_N_FFT);
for (let n = 0; n < WHISPER_N_FFT; n += 1) {
  HANN_WINDOW[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / WHISPER_N_FFT));
}

/** Slaney 刻度：Hz → mel（`transformers` 的 `hertz_to_mel`）。 */
function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = 27.0 / Math.log(6.4);
  if (freq >= minLogHertz) return minLogMel + Math.log(freq / minLogHertz) * logstep;
  return (3.0 * freq) / 200.0;
}

/** Slaney 刻度：mel → Hz。 */
function melToHertzSlaney(mel: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = Math.log(6.4) / 27.0;
  if (mel >= minLogMel) return minLogHertz * Math.exp(logstep * (mel - minLogMel));
  return (200.0 * mel) / 3.0;
}

/** 与 `np.linspace` 相同的步进方式：`start + i * (stop - start) / (n - 1)`。 */
function linspace(start: number, stop: number, num: number): Float64Array {
  const out = new Float64Array(num);
  if (num === 0) return out;
  if (num === 1) {
    out[0] = start;
    return out;
  }
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i += 1) out[i] = start + i * step;
  return out;
}

interface MelBand {
  /** 第一个非零频点（含）。 */
  readonly start: number;
  /** 从 `start` 起的权重（含中间为 0 的频点，保证连续）。 */
  readonly weights: Float64Array;
}

/**
 * Slaney 归一化三角 mel 滤波器组（80 × 201），稀疏存储每个 mel 带的非零区间。
 *
 * 与 `whisper_features.py` 的 `_build_mel_filterbank` 逐项一致：
 * `enorm = 2 / (filter_freqs[m+2] - filter_freqs[m])`，只保留 `weight > 0` 的频点。
 */
function buildMelFilterbank(): readonly MelBand[] {
  const samplingRate = WHISPER_SAMPLE_RATE;
  const melMin = hertzToMelSlaney(0);
  const melMax = hertzToMelSlaney(samplingRate / 2);
  const melFreqs = linspace(melMin, melMax, WHISPER_N_MELS + 2);
  const filterFreqs = new Float64Array(melFreqs.length);
  for (let i = 0; i < melFreqs.length; i += 1) {
    filterFreqs[i] = melToHertzSlaney(melFreqs[i]!);
  }
  const fftFreqs = linspace(0, samplingRate / 2, N_BINS);
  const filterDiff = new Float64Array(filterFreqs.length - 1);
  for (let i = 0; i < filterDiff.length; i += 1) {
    filterDiff[i] = filterFreqs[i + 1]! - filterFreqs[i]!;
  }

  const bands: MelBand[] = [];
  for (let m = 0; m < WHISPER_N_MELS; m += 1) {
    const enorm = 2.0 / (filterFreqs[m + 2]! - filterFreqs[m]!);
    let first = -1;
    let last = -1;
    const weights = new Float64Array(N_BINS);
    for (let k = 0; k < N_BINS; k += 1) {
      const down = (fftFreqs[k]! - filterFreqs[m]!) / filterDiff[m]!;
      const up = (filterFreqs[m + 2]! - fftFreqs[k]!) / filterDiff[m + 1]!;
      const weight = Math.max(0, Math.min(down, up)) * enorm;
      if (weight > 0) {
        if (first < 0) first = k;
        last = k;
      }
      weights[k] = weight;
    }
    if (first < 0) {
      bands.push({ start: 0, weights: new Float64Array(0) });
    } else {
      bands.push({ start: first, weights: weights.subarray(first, last + 1) });
    }
  }
  return bands;
}

const MEL_BANDS = buildMelFilterbank();

// ------------------------------------------------------------------ log-mel 主流程

/**
 * Whisper 风格 log-mel（80×800，行主序，`out[m * 800 + t]`）。
 *
 * 与 `compute_whisper_log_mel_features()` 一致：入参不足 128,000 点在末尾补零、
 * 超长截前 128,000 点；`doNormalize !== false` 时先做零均值单位方差归一化。
 */
export function computeWhisperLogMelFeatures(
  audio: Float32Array,
  options?: { readonly doNormalize?: boolean },
): Float32Array {
  const doNormalize = options?.doNormalize !== false;

  // 1. 定长 8 秒（不足在末尾补零、超长截前）
  const x = new Float32Array(WHISPER_MAX_SAMPLES);
  if (audio.length >= WHISPER_MAX_SAMPLES) {
    x.set(audio.subarray(0, WHISPER_MAX_SAMPLES));
  } else {
    x.set(audio);
  }

  // 2. float32 归一化（对齐 numpy 对 float32 buffer 的原地运算）
  if (doNormalize) {
    let sum = 0;
    for (let i = 0; i < WHISPER_MAX_SAMPLES; i += 1) sum += x[i]!;
    const mean = Math.fround(sum / WHISPER_MAX_SAMPLES);
    let squareSum = 0;
    for (let i = 0; i < WHISPER_MAX_SAMPLES; i += 1) {
      const d = Math.fround(x[i]! - mean);
      squareSum += d * d;
    }
    const variance = Math.fround(squareSum / WHISPER_MAX_SAMPLES);
    const denom = Math.fround(Math.sqrt(Math.fround(variance + NORM_VARIANCE_EPS)));
    for (let i = 0; i < WHISPER_MAX_SAMPLES; i += 1) {
      x[i] = Math.fround(Math.fround(x[i]! - mean) / denom);
    }
  }

  // 3. 双侧 reflect padding（float64，精确复现 np.pad(mode="reflect")）
  const pad = N_FFT_HALF;
  const padded = new Float64Array(WHISPER_MAX_SAMPLES + 2 * pad);
  for (let i = 0; i < WHISPER_MAX_SAMPLES; i += 1) padded[pad + i] = x[i]!;
  for (let k = 0; k < pad; k += 1) {
    padded[pad - 1 - k] = x[k + 1]!;
    padded[pad + WHISPER_MAX_SAMPLES + k] = x[WHISPER_MAX_SAMPLES - 2 - k]!;
  }

  // 4. 逐帧（只算前 800 帧，等价于算出 801 帧后丢掉最后一列）
  const frameRe = new Float64Array(WHISPER_N_FFT);
  const frameIm = new Float64Array(WHISPER_N_FFT);
  const specRe = new Float64Array(WHISPER_N_FFT);
  const specIm = new Float64Array(WHISPER_N_FFT);
  const power = new Float64Array(N_BINS);
  const logSpec = new Float64Array(WHISPER_N_MELS * WHISPER_N_FRAMES);

  for (let t = 0; t < WHISPER_N_FRAMES; t += 1) {
    const offset = t * WHISPER_HOP_LENGTH;
    for (let n = 0; n < WHISPER_N_FFT; n += 1) {
      frameRe[n] = padded[offset + n]! * HANN_WINDOW[n]!;
      frameIm[n] = 0;
    }
    fft400Into(frameRe, frameIm, specRe, specIm);

    for (let k = 0; k < N_BINS; k += 1) {
      const re = specRe[k]!;
      const im = specIm[k]!;
      power[k] = re * re + im * im;
    }

    for (let m = 0; m < WHISPER_N_MELS; m += 1) {
      const band = MEL_BANDS[m]!;
      let acc = 0;
      for (let i = 0; i < band.weights.length; i += 1) {
        acc += band.weights[i]! * power[band.start + i]!;
      }
      logSpec[m * WHISPER_N_FRAMES + t] = Math.log10(Math.max(MEL_FLOOR, acc));
    }
  }

  // 5. 全局上限 −8 dB、偏移 +4、除以 4，最后降到 float32
  let maxLog = -Infinity;
  for (let i = 0; i < logSpec.length; i += 1) {
    const value = logSpec[i]!;
    if (value > maxLog) maxLog = value;
  }
  const floor = maxLog - 8.0;
  const out = new Float32Array(logSpec.length);
  for (let i = 0; i < logSpec.length; i += 1) {
    const value = Math.max(logSpec[i]!, floor);
    out[i] = Math.fround((value + 4.0) / 4.0);
  }
  return out;
}
