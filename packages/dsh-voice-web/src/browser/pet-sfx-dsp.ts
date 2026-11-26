/**
 * Gemini-chan 交互音效 DSP：星尘晶体 × 双子轻应（Starlight Pluck + Twin Spark）。
 *
 * 纯函数、零 DOM / 零 WebAudio / 零 Node：`node:test`、浏览器和未来的穿戴设备共用一份。
 * 全部音高锁在 E 大调五声音阶里，三层管线：
 *
 * 1. 晶体主音：正弦载波 + 正弦调制器的 2-Op FM，调制指数在前 ~18 ms 指数收敛到 0；
 * 2. 双子星芒：一对高八度、±6 cents 偏频、比主音低 15 dB 的泛音；
 *    `retroSpark` 只给这一层套 24 ms 采样保持包络，主音一点不碰；
 * 3. 耳畔微触：3 kHz / Q=4 带通白噪，峰值固定在 -24 dBFS。
 *
 * 出口是 RBJ 二阶低通 + 一次触发内的微漂移（音高 / 亮度 / FM 指数）。
 * 深夜或低电量时低通收到 2.2 kHz、起音放缓 5 ms、整体再降 2.5 dB。
 * 音乐层峰值归一到每个 cue 的目标值；空气微触在这之后按 -24 dBFS 叠加。
 * 样点一律有限、无直流、首尾归零，峰值留出足够余量。
 */

export const SFX_CUES = [
  'mic-open',
  'mic-close',
  'barge-in',
  'delegate',
  'proactive',
  'sleepy',
] as const;

export type SfxCue = (typeof SFX_CUES)[number];

export interface SfxEnvironment {
  readonly isNight?: boolean;
  readonly lowPower?: boolean;
}

export interface SfxSynthOptions {
  readonly sampleRate?: number;
  readonly retroSpark?: boolean;
  readonly env?: SfxEnvironment;
  /** 注入后单测完全确定；缺省用 `Math.random` 做活体微变 */
  readonly rng?: () => number;
  readonly masterGainDb?: number;
}

export interface SfxRenderedAudio {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly durationMs: number;
  readonly peakLinear: number;
  readonly cutoffHz: number;
  readonly attackOffsetMs: number;
}

/** 解析后的单音计划：`resolveSfxRenderParams` 的输出，单测直接断言。 */
export interface SfxNotePlan {
  readonly freq: number;
  readonly startMs: number;
  readonly gateMs: number;
  readonly attackMs: number;
  readonly decayMs: number;
  readonly glideCents: number;
  /** 滑音走完用多久；缺省走完整段 gate */
  readonly glideMs: number;
}

export interface SfxRenderParams {
  readonly cue: SfxCue;
  readonly sampleRate: number;
  readonly durationMs: number;
  readonly notes: readonly SfxNotePlan[];
  readonly ratio: number;
  readonly fmIndex: number;
  readonly cutoffHz: number;
  readonly peakDb: number;
  readonly gainDb: number;
  readonly attackOffsetMs: number;
  readonly sparkEnabled: boolean;
  readonly retroSpark: boolean;
  readonly sparkHoldMs: number;
  readonly airMs: number;
  readonly driftCents: number;
  readonly cutoffJitter: number;
  readonly fmJitter: number;
}

export interface SfxLayerSplit {
  readonly main: Float32Array;
  readonly spark: Float32Array;
}

/** E 大调五声音阶（第 5 八度），Hz。 */
export const SFX_NOTE_HZ = {
  csharp5: 554.365,
  e5: 659.255,
  fsharp5: 739.989,
  gsharp5: 830.609,
  b5: 987.767,
} as const;

export const SFX_DEFAULT_SAMPLE_RATE = 48_000;
export const SFX_SPARK_HOLD_MS = 24;
export const SFX_SPARK_DETUNE_CENTS = 6;
export const SFX_SPARK_LEVEL_DB = -15;
export const SFX_AIR_CENTER_HZ = 3_000;
export const SFX_AIR_Q = 4;
export const SFX_AIR_PEAK_DB = -24;
export const SFX_BASE_CUTOFF_HZ = 4_200;
export const SFX_BREATHING_CUTOFF_HZ = 2_200;
export const SFX_BREATHING_GAIN_DB = -2.5;
export const SFX_BREATHING_ATTACK_MS = 5;
export const SFX_LIFE_DRIFT_CENTS = 8;
/** 空气微触种子的异或盐：只取一个 rng 值也能展开成一段白噪。 */
const SFX_AIR_SEED_SALT = 0x9e37_79b9;

interface CueNoteSpec {
  readonly freq: number;
  readonly startMs: number;
  readonly gateMs: number;
  readonly glideCents?: number;
  readonly glideMs?: number;
  readonly attackMs?: number;
  readonly decayMs?: number;
}

interface CueSpec {
  readonly durationMs: number;
  /** 音乐层（不含空气微触）的峰值目标 */
  readonly peakDb: number;
  readonly cutoffHz: number;
  readonly ratio: number;
  readonly fmIndex: number;
  readonly attackMs: number;
  /** 指数衰减到 1/e 的时间 */
  readonly decayMs: number;
  readonly spark: boolean;
  /** 0 = 不带空气微触 */
  readonly airMs: number;
  readonly notes: readonly CueNoteSpec[];
}

const CUE_SPECS: Record<SfxCue, CueSpec> = {
  'mic-open': {
    durationMs: 95,
    peakDb: -12,
    cutoffHz: 4_200,
    ratio: 2.756,
    fmIndex: 1.8,
    attackMs: 2,
    decayMs: 15,
    spark: true,
    airMs: 8,
    notes: [
      { freq: SFX_NOTE_HZ.e5, startMs: 0, gateMs: 28 },
      // 后音带 30 cents 的极短上滑，滑完就稳住。
      { freq: SFX_NOTE_HZ.b5, startMs: 35, gateMs: 60, glideCents: 30, glideMs: 12 },
    ],
  },
  'mic-close': {
    durationMs: 75,
    // 比 mic-open 低 2 dB
    peakDb: -14,
    cutoffHz: 4_200,
    ratio: 2.756,
    fmIndex: 0.9,
    attackMs: 2.5,
    decayMs: 13,
    spark: true,
    airMs: 0,
    notes: [
      { freq: SFX_NOTE_HZ.b5, startMs: 0, gateMs: 24 },
      { freq: SFX_NOTE_HZ.fsharp5, startMs: 28, gateMs: 47, glideCents: -12 },
    ],
  },
  'barge-in': {
    durationMs: 40,
    peakDb: -10,
    cutoffHz: 4_200,
    ratio: 1,
    fmIndex: 0,
    attackMs: 1.5,
    decayMs: 10,
    spark: false,
    airMs: 0,
    notes: [{ freq: SFX_NOTE_HZ.e5, startMs: 0, gateMs: 40, glideCents: -300 }],
  },
  delegate: {
    durationMs: 110,
    peakDb: -22,
    cutoffHz: 2_600,
    ratio: 2,
    fmIndex: 0.6,
    attackMs: 4,
    decayMs: 16,
    spark: false,
    airMs: 0,
    notes: [
      { freq: SFX_NOTE_HZ.gsharp5, startMs: 0, gateMs: 28 },
      { freq: SFX_NOTE_HZ.b5, startMs: 40, gateMs: 66, glideCents: -8 },
    ],
  },
  proactive: {
    durationMs: 145,
    peakDb: -14,
    cutoffHz: 4_200,
    ratio: 2,
    fmIndex: 1.2,
    attackMs: 10,
    decayMs: 22,
    spark: true,
    airMs: 0,
    notes: [
      { freq: SFX_NOTE_HZ.e5, startMs: 0, gateMs: 38 },
      { freq: SFX_NOTE_HZ.gsharp5, startMs: 45, gateMs: 42 },
      { freq: SFX_NOTE_HZ.b5, startMs: 90, gateMs: 55, glideCents: 10 },
    ],
  },
  sleepy: {
    durationMs: 120,
    peakDb: -16,
    cutoffHz: 1_800,
    ratio: 2,
    fmIndex: 0.5,
    attackMs: 6,
    decayMs: 55,
    spark: false,
    airMs: 0,
    notes: [{ freq: SFX_NOTE_HZ.fsharp5, startMs: 0, gateMs: 120, glideCents: -200 }],
  },
};

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function rand01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return clamp(value, 0, 1);
}

function normalizeSampleRate(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SFX_DEFAULT_SAMPLE_RATE;
  return Math.round(clamp(value, 8_000, 192_000));
}

function sampleCount(durationMs: number, sampleRate: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * sampleRate));
}

/** 解析一次触发的全部参数；rng 在这里一次性消费，后续渲染不再随机。 */
export function resolveSfxRenderParams(
  cue: SfxCue,
  options: SfxSynthOptions = {},
): SfxRenderParams {
  const sampleRate = normalizeSampleRate(options.sampleRate);
  const spec = CUE_SPECS[cue];
  const env = options.env;
  const breathing = env?.isNight === true || env?.lowPower === true;
  const cutoffHz = Math.min(
    spec.cutoffHz,
    SFX_BASE_CUTOFF_HZ,
    breathing ? SFX_BREATHING_CUTOFF_HZ : SFX_BASE_CUTOFF_HZ,
  );
  const attackOffsetMs = breathing ? SFX_BREATHING_ATTACK_MS : 0;
  const masterGainDb = options.masterGainDb !== undefined && Number.isFinite(options.masterGainDb)
    ? clamp(options.masterGainDb, -40, 12)
    : 0;
  const gainDb = masterGainDb + (breathing ? SFX_BREATHING_GAIN_DB : 0);

  const random = options.rng ?? Math.random;
  const driftCents = (rand01(random()) * 2 - 1) * SFX_LIFE_DRIFT_CENTS;
  const cutoffJitter = 1 + (rand01(random()) * 2 - 1) * 0.03;
  const fmJitter = 1 + (rand01(random()) * 2 - 1) * 0.08;

  const sparkEnabled = spec.spark;
  const retroSpark = options.retroSpark === true && sparkEnabled;

  return {
    cue,
    sampleRate,
    durationMs: spec.durationMs,
    notes: spec.notes.map((note) => ({
      freq: note.freq,
      startMs: note.startMs,
      gateMs: note.gateMs,
      attackMs: (note.attackMs ?? spec.attackMs) + attackOffsetMs,
      decayMs: note.decayMs ?? spec.decayMs,
      glideCents: note.glideCents ?? 0,
      glideMs: note.glideMs ?? note.gateMs,
    })),
    ratio: spec.ratio,
    fmIndex: spec.fmIndex,
    cutoffHz,
    peakDb: spec.peakDb,
    gainDb,
    attackOffsetMs,
    sparkEnabled,
    retroSpark,
    sparkHoldMs: SFX_SPARK_HOLD_MS,
    airMs: spec.airMs,
    driftCents,
    cutoffJitter,
    fmJitter,
  };
}

function envelopeAt(tSec: number, attackSec: number, decaySec: number): number {
  const attack = tSec < attackSec
    ? 0.5 - 0.5 * Math.cos((Math.PI * tSec) / attackSec)
    : 1;
  const decay = tSec <= attackSec ? 1 : Math.exp(-(tSec - attackSec) / decaySec);
  return attack * decay;
}

function gateFade(tSec: number, gateSec: number, fadeSec: number): number {
  const remain = gateSec - tSec;
  if (remain >= fadeSec) return 1;
  if (remain <= 0) return 0;
  return 0.5 - 0.5 * Math.cos((Math.PI * remain) / fadeSec);
}

/**
 * 只渲染三层里的主音与星芒，不做归一化和滤波。
 *
 * 单测用它证明 `retroSpark` 只改 Layer 2：同一颗 rng 下主音数组逐位相同。
 */
export function renderCueLayers(cue: SfxCue, options: SfxSynthOptions = {}): SfxLayerSplit {
  const params = resolveSfxRenderParams(cue, options);
  return renderLayers(params);
}

function renderLayers(params: SfxRenderParams): SfxLayerSplit {
  const sr = params.sampleRate;
  const total = sampleCount(params.durationMs, sr);
  const main = new Float32Array(total);
  const spark = new Float32Array(total);
  const sparkAmp = dbToLinear(SFX_SPARK_LEVEL_DB);
  const holdSec = params.sparkHoldMs / 1000;
  const detuneLow = Math.pow(2, -SFX_SPARK_DETUNE_CENTS / 1200);
  const detuneHigh = Math.pow(2, SFX_SPARK_DETUNE_CENTS / 1200);
  const indexTauSec = 0.004;

  for (const note of params.notes) {
    const startIdx = Math.round((note.startMs / 1000) * sr);
    if (startIdx < 0 || startIdx >= total) continue;
    const gateSamples = Math.min(Math.round((note.gateMs / 1000) * sr), total - startIdx);
    if (gateSamples <= 0) continue;

    const gateSec = note.gateMs / 1000;
    const attackSec = Math.max(note.attackMs, 1) / 1000;
    const decaySec = Math.max(note.decayMs, 1) / 1000;
    const fadeSec = Math.min(0.004, gateSec * 0.25);
    const glideCents = note.glideCents;
    const glideSec = Math.max(Math.min(note.glideMs / 1000, gateSec), 1 / sr);
    let carrierPhase = 0;
    let modPhase = 0;
    let twinPhaseLow = 0;
    let twinPhaseHigh = 0;
    let sparkStep = -1;
    let sparkHeld = 0;

    for (let i = 0; i < gateSamples; i += 1) {
      const t = i / sr;
      const glide = glideCents === 0 ? 0 : glideCents * Math.min(1, t / glideSec);
      const freq = note.freq * Math.pow(2, (glide + params.driftCents) / 1200);
      const attack = t < attackSec
        ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attackSec)
        : 1;
      const decay = t <= attackSec ? 1 : Math.exp(-(t - attackSec) / decaySec);
      const gate = gateFade(t, gateSec, fadeSec);
      const env = attack * decay * gate;
      const modIndex = params.fmIndex === 0
        ? 0
        : params.fmIndex * params.fmJitter * Math.exp(-t / indexTauSec);

      carrierPhase += (2 * Math.PI * freq) / sr;
      modPhase += (2 * Math.PI * freq * params.ratio) / sr;
      const body = Math.sin(carrierPhase + modIndex * Math.sin(modPhase)) * env;
      main[startIdx + i] = (main[startIdx + i] ?? 0) + body;

      if (!params.sparkEnabled) continue;
      let sparkEnv = env;
      if (params.retroSpark) {
        const stepIndex = Math.floor(t / holdSec);
        if (stepIndex !== sparkStep) {
          sparkStep = stepIndex;
          // 采样保持取这一阶的末端：起音仍由 attack 连续拉起，不会在 t=0 爆点。
          sparkHeld = envelopeAt(
            Math.min((stepIndex + 1) * holdSec, gateSec),
            attackSec,
            decaySec,
          );
        }
        sparkEnv = sparkHeld * attack * gate;
      }
      twinPhaseLow += (2 * Math.PI * freq * 2 * detuneLow) / sr;
      twinPhaseHigh += (2 * Math.PI * freq * 2 * detuneHigh) / sr;
      spark[startIdx + i] = (spark[startIdx + i] ?? 0)
        + (Math.sin(twinPhaseLow) + Math.sin(twinPhaseHigh)) * sparkAmp * sparkEnv;
    }
  }

  return { main, spark };
}

interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** RBJ 二阶低通（Butterworth Q = 1/√2）。 */
function lowpassCoefficients(cutoffHz: number, sampleRate: number): BiquadCoefficients {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ 二阶带通（恒定 0 dB 峰值增益）。 */
function bandpassCoefficients(
  centerHz: number,
  sampleRate: number,
  q: number,
): BiquadCoefficients {
  const w0 = (2 * Math.PI * centerHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function biquadInPlace(samples: Float32Array, c: BiquadCoefficients): void {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0;
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    samples[i] = y;
  }
}

/** 一阶高通（18 Hz）压掉包络不对称留下的直流。 */
function dcBlock(samples: Float32Array, sampleRate: number): void {
  const r = 1 - (2 * Math.PI * 18) / sampleRate;
  let prevInput = 0;
  let prevOutput = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0;
    const y = x - prevInput + r * prevOutput;
    prevInput = x;
    prevOutput = y;
    samples[i] = y;
  }
}

/**
 * 在混音开头 8 ms 叠一层 3 kHz / Q=4 的带通白噪。
 *
 * 只向 rng 要一个种子，再用本地 xorshift32 展开：常量 rng（如 `fixed(0.5)`）
 * 下逐样点取随机数会整段归零，空气微触就完全消失了。
 */
function addAirClick(
  mix: Float32Array,
  params: SfxRenderParams,
  random: () => number,
): void {
  const sr = params.sampleRate;
  const length = Math.min(Math.round((params.airMs / 1000) * sr), mix.length);
  if (length <= 0) return;

  let state = (Math.floor(rand01(random()) * 0x1_0000_0000) ^ SFX_AIR_SEED_SALT) >>> 0;
  if (state === 0) state = SFX_AIR_SEED_SALT;

  const noise = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    noise[i] = (state / 0x1_0000_0000) * 2 - 1;
  }
  biquadInPlace(noise, bandpassCoefficients(SFX_AIR_CENTER_HZ, sr, SFX_AIR_Q));

  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const value = Math.abs(noise[i] ?? 0);
    if (value > peak) peak = value;
  }
  if (peak <= 1e-9) return;

  const scale = dbToLinear(SFX_AIR_PEAK_DB) / peak;
  const fadeSamples = Math.max(1, Math.round(0.0012 * sr));
  for (let i = 0; i < length; i += 1) {
    let fade = 1;
    if (i < fadeSamples) fade = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
    const remain = length - 1 - i;
    if (remain < fadeSamples) {
      fade *= 0.5 - 0.5 * Math.cos((Math.PI * remain) / fadeSamples);
    }
    mix[i] = (mix[i] ?? 0) + (noise[i] ?? 0) * scale * fade;
  }
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

export function synthesizeCuePcm(
  cue: SfxCue,
  options: SfxSynthOptions = {},
): SfxRenderedAudio {
  const params = resolveSfxRenderParams(cue, options);
  const random = options.rng ?? Math.random;
  const layers = renderLayers(params);
  const total = layers.main.length;
  const mix = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    mix[i] = (layers.main[i] ?? 0) + (layers.spark[i] ?? 0);
  }

  dcBlock(mix, params.sampleRate);
  const cutoffHz = Math.min(
    params.cutoffHz * params.cutoffJitter,
    params.sampleRate * 0.45,
  );
  biquadInPlace(mix, lowpassCoefficients(cutoffHz, params.sampleRate));

  // 音乐层峰值精确压到 cue 的目标值；空气微触在这之后按绝对 -24 dBFS 叠加，
  // 不会因为归一化被一起缩放。
  let peak = peakOf(mix);
  const targetPeak = dbToLinear(params.peakDb);
  if (peak > 1e-9) {
    const scale = targetPeak / peak;
    for (let i = 0; i < total; i += 1) mix[i] = (mix[i] ?? 0) * scale;
  }

  if (params.airMs > 0) addAirClick(mix, params, random);

  const gain = dbToLinear(params.gainDb);
  if (gain !== 1) {
    for (let i = 0; i < total; i += 1) mix[i] = (mix[i] ?? 0) * gain;
  }

  // 最后一道闸：非有限值归零，峰值不超过 -1 dBFS。
  const ceiling = dbToLinear(-1);
  let sanitizedPeak = 0;
  for (let i = 0; i < total; i += 1) {
    const value = mix[i] ?? 0;
    const safe = Number.isFinite(value) ? value : 0;
    if (safe !== value) mix[i] = 0;
    const magnitude = Math.abs(safe);
    if (magnitude > sanitizedPeak) sanitizedPeak = magnitude;
  }
  if (sanitizedPeak > ceiling) {
    const scale = ceiling / sanitizedPeak;
    for (let i = 0; i < total; i += 1) mix[i] = (mix[i] ?? 0) * scale;
    sanitizedPeak = ceiling;
  }

  return {
    samples: mix,
    sampleRate: params.sampleRate,
    durationMs: (total / params.sampleRate) * 1000,
    peakLinear: sanitizedPeak,
    cutoffHz: params.cutoffHz,
    attackOffsetMs: params.attackOffsetMs,
  };
}

/** 交给未来穿戴设备的 PCM16；NaN 归零，超出 [-1, 1] 的值（含 ±Infinity）饱和。 */
export function pcmFloatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    const safe = Number.isNaN(value) ? 0 : clamp(value, -1, 1);
    out[i] = Math.round(safe < 0 ? safe * 0x8000 : safe * 0x7fff);
  }
  return out;
}
