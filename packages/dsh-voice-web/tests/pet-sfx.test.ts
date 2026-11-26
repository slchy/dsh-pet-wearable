/**
 * 交互音效：DSP 参数、峰值 / 时长 / 防爆音、彩蛋分层、深夜呼吸与 WebAudio 调度。
 *
 * 渲染全程注入常量 rng，断言不依赖机器抖动；`createPetSfx` 用最小 AudioContext mock。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SFX_BASE_CUTOFF_HZ,
  SFX_BREATHING_CUTOFF_HZ,
  SFX_CUES,
  SFX_NOTE_HZ,
  renderCueLayers,
  pcmFloatToInt16,
  resolveSfxRenderParams,
  synthesizeCuePcm,
  type SfxCue,
  type SfxSynthOptions,
} from '../src/browser/pet-sfx-dsp.ts';
import {
  createPetSfx,
  type SfxAudioBufferLike,
  type SfxAudioBufferSourceLike,
  type SfxAudioContextLike,
  type SfxAudioNodeLike,
  type SfxAudioParamLike,
  type SfxGainLike,
} from '../src/browser/pet-sfx.ts';

const SR = 48_000;

const DURATIONS_MS: Record<SfxCue, number> = {
  'mic-open': 95,
  'mic-close': 75,
  'barge-in': 40,
  delegate: 110,
  proactive: 145,
  sleepy: 120,
};

function fixed(value: number): () => number {
  return () => value;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** 前三次微变固定 0.5（音乐层逐位一致），只让空气微触的种子不同。 */
function airSeedOnly(value: number): () => number {
  let calls = 0;
  return () => {
    calls += 1;
    return calls <= 3 ? 0.5 : value;
  };
}

function dbOf(linear: number): number {
  return 20 * Math.log10(linear);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function meanOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] ?? 0;
  return sum / Math.max(1, samples.length);
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let diff = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (delta > diff) diff = delta;
  }
  return diff;
}

/** 用向上过零点间隔估这一窗的平均频率。 */
function crossingFrequency(
  samples: Float32Array,
  sampleRate: number,
  fromMs: number,
  toMs: number,
): number {
  const from = Math.max(0, Math.floor((fromMs / 1000) * sampleRate));
  const to = Math.min(samples.length, Math.floor((toMs / 1000) * sampleRate));
  let count = 0;
  let first = -1;
  let last = -1;
  let prev = samples[from] ?? 0;
  for (let i = from + 1; i < to; i += 1) {
    const current = samples[i] ?? 0;
    if (prev <= 0 && current > 0) {
      if (first < 0) first = i;
      last = i;
      count += 1;
    }
    prev = current;
  }
  if (count < 2 || first < 0 || last <= first) return 0;
  return (sampleRate * (count - 1)) / (last - first);
}

const STEADY: SfxSynthOptions = { sampleRate: SR, rng: fixed(0.5) };

test('6 个 cue 的时长、样点数、有限性与首尾防爆音', () => {
  for (const cue of SFX_CUES) {
    const audio = synthesizeCuePcm(cue, STEADY);
    assert.equal(audio.sampleRate, SR, cue);
    assert.equal(
      audio.samples.length,
      Math.round((DURATIONS_MS[cue] * SR) / 1000),
      cue,
    );
    assert.ok(Math.abs(audio.durationMs - DURATIONS_MS[cue]) < 0.05, cue);

    let peak = 0;
    for (let i = 0; i < audio.samples.length; i += 1) {
      const value = audio.samples[i] ?? Number.NaN;
      assert.ok(Number.isFinite(value), `${cue} sample ${i} 不是有限值`);
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
    }
    assert.ok(peak <= 0.9, `${cue} 峰值 ${peak} 接近削波`);
    assert.ok(peak > 0.005, `${cue} 几乎没有声音`);
    assert.ok(Math.abs(audio.peakLinear - peak) < 1e-6, `${cue} peakLinear 不自洽`);
    assert.ok(Math.abs(audio.samples[0] ?? 0) < 2e-3, `${cue} 首样点没归零`);
    assert.ok(
      Math.abs(audio.samples[audio.samples.length - 1] ?? 0) < 2e-3,
      `${cue} 尾样点没归零`,
    );
    assert.ok(Math.abs(meanOf(audio.samples)) < 1e-3, `${cue} 有直流偏置`);
  }
});

test('delegate 峰值严格压在 -22 dBFS 以内', () => {
  const audio = synthesizeCuePcm('delegate', STEADY);
  const peakDb = dbOf(audio.peakLinear);
  assert.ok(peakDb <= -22 + 0.05, `delegate 峰值 ${peakDb} dBFS 超过 -22`);
  assert.ok(peakDb >= -26, `delegate 峰值 ${peakDb} dBFS 过于安静`);
});

test('mic-close 比 mic-open 低约 2 dB，RMS 也更小', () => {
  const open = synthesizeCuePcm('mic-open', STEADY);
  const close = synthesizeCuePcm('mic-close', STEADY);
  const delta = dbOf(open.peakLinear) - dbOf(close.peakLinear);
  // mic-open 额外带 -24 dBFS 的空气微触，峰顶最多再抬 1 dB 上下。
  assert.ok(delta > 1.5 && delta < 4.5, `mic-close 与 mic-open 峰值差 ${delta} dB`);
  assert.equal(
    resolveSfxRenderParams('mic-open', STEADY).peakDb
      - resolveSfxRenderParams('mic-close', STEADY).peakDb,
    2,
  );
  assert.ok(rms(close.samples) < rms(open.samples));
});

test('barge-in 是 40 ms、FM=0 的纯正弦下滑，没有星芒', () => {
  const params = resolveSfxRenderParams('barge-in', STEADY);
  assert.equal(params.fmIndex, 0);
  assert.equal(params.sparkEnabled, false);
  assert.equal(params.durationMs, 40);

  const audio = synthesizeCuePcm('barge-in', STEADY);
  assert.equal(audio.samples.length, Math.round((40 * SR) / 1000));
  const early = crossingFrequency(audio.samples, SR, 5, 15);
  const late = crossingFrequency(audio.samples, SR, 25, 35);
  assert.ok(early > 0 && late > 0);
  assert.ok(early > late * 1.03, `下滑不明显：前段 ${early} Hz，后段 ${late} Hz`);

  const layers = renderCueLayers('barge-in', STEADY);
  for (let i = 0; i < layers.spark.length; i += 1) {
    assert.equal(layers.spark[i], 0);
  }
});

test('sleepy 低通 1.8 kHz 且星芒层完全关闭', () => {
  const params = resolveSfxRenderParams('sleepy', {
    sampleRate: SR,
    retroSpark: true,
    rng: fixed(0.5),
  });
  assert.equal(params.cutoffHz, 1_800);
  assert.equal(params.sparkEnabled, false);
  assert.equal(params.retroSpark, false);

  const audio = synthesizeCuePcm('sleepy', { ...STEADY, retroSpark: true });
  assert.equal(audio.cutoffHz, 1_800);
  const layers = renderCueLayers('sleepy', { ...STEADY, retroSpark: true });
  for (let i = 0; i < layers.spark.length; i += 1) {
    assert.equal(layers.spark[i], 0);
  }
});

test('retroSpark 只给 Layer 2 上 24 ms 阶梯包络，Layer 1 逐位不变', () => {
  const on = resolveSfxRenderParams('mic-open', {
    sampleRate: SR,
    retroSpark: true,
    rng: fixed(0.5),
  });
  assert.equal(on.retroSpark, true);
  assert.equal(on.sparkHoldMs, 24);

  const smooth = renderCueLayers('mic-open', { ...STEADY, retroSpark: false });
  const retro = renderCueLayers('mic-open', { ...STEADY, retroSpark: true });
  assert.equal(maxDiff(smooth.main, retro.main), 0, 'Layer 1 被彩蛋改动了');
  assert.ok(maxDiff(smooth.spark, retro.spark) > 1e-4, 'Layer 2 听不出阶梯包络');

  const renderedSmooth = synthesizeCuePcm('mic-open', { ...STEADY, retroSpark: false });
  const renderedRetro = synthesizeCuePcm('mic-open', { ...STEADY, retroSpark: true });
  assert.ok(maxDiff(renderedSmooth.samples, renderedRetro.samples) > 1e-5);
});

test('isNight / lowPower 把低通压到 2.2 kHz 并把起音放缓 5 ms', () => {
  const day = resolveSfxRenderParams('mic-open', STEADY);
  assert.equal(day.cutoffHz, SFX_BASE_CUTOFF_HZ);
  assert.equal(day.attackOffsetMs, 0);
  assert.equal(day.gainDb, 0);

  for (const env of [{ isNight: true }, { lowPower: true }]) {
    const quiet = resolveSfxRenderParams('mic-open', { ...STEADY, env });
    assert.equal(quiet.cutoffHz, SFX_BREATHING_CUTOFF_HZ);
    assert.equal(quiet.attackOffsetMs, 5);
    assert.ok(quiet.gainDb <= -2 && quiet.gainDb >= -3, `呼吸电平 ${quiet.gainDb} dB`);

    const audio = synthesizeCuePcm('mic-open', { ...STEADY, env });
    assert.equal(audio.cutoffHz, SFX_BREATHING_CUTOFF_HZ);
    assert.equal(audio.attackOffsetMs, 5);
    assert.ok(dbOf(audio.peakLinear) < dbOf(synthesizeCuePcm('mic-open', STEADY).peakLinear));
  }

  // 更低的自身截止频率仍然优先：delegate 取 2.2k，sleepy 保持 1.8k。
  assert.equal(
    resolveSfxRenderParams('delegate', { ...STEADY, env: { isNight: true } }).cutoffHz,
    SFX_BREATHING_CUTOFF_HZ,
  );
  assert.equal(
    resolveSfxRenderParams('sleepy', { ...STEADY, env: { isNight: true } }).cutoffHz,
    1_800,
  );
});

test('注入 rng 后活体微变可复现，漂移在 ±10 cents 内', () => {
  const a = resolveSfxRenderParams('mic-open', { sampleRate: SR, rng: seeded(7) });
  const b = resolveSfxRenderParams('mic-open', { sampleRate: SR, rng: seeded(9) });
  const replayed = resolveSfxRenderParams('mic-open', { sampleRate: SR, rng: seeded(7) });
  assert.equal(a.driftCents, replayed.driftCents);
  assert.ok(Math.abs(a.driftCents) <= 10);
  assert.notEqual(a.driftCents, b.driftCents);
  assert.ok(Math.abs((a.cutoffJitter - 1) * 100) <= 3.001);
  assert.ok(Math.abs((a.fmJitter - 1) * 100) <= 8.001);

  const low = resolveSfxRenderParams('mic-open', { sampleRate: SR, rng: fixed(0) });
  const high = resolveSfxRenderParams('mic-open', { sampleRate: SR, rng: fixed(1) });
  assert.ok(low.driftCents < -7);
  assert.ok(high.driftCents > 7);

  const audioA = synthesizeCuePcm('mic-open', { sampleRate: SR, rng: seeded(11) });
  const audioB = synthesizeCuePcm('mic-open', { sampleRate: SR, rng: seeded(11) });
  assert.equal(maxDiff(audioA.samples, audioB.samples), 0);
});

test('pcmFloatToInt16 饱和、NaN 归零、正负满幅不越界', () => {
  const out = pcmFloatToInt16(new Float32Array([
    0,
    1,
    -1,
    0.5,
    -0.5,
    2,
    -2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]));
  assert.deepEqual(Array.from(out), [
    0,
    32_767,
    -32_768,
    16_384,
    -16_384,
    32_767,
    -32_768,
    0,
    32_767,
    -32_768,
  ]);
});

test('mic-open 前 8 ms 带非零 3 kHz 空气微触，8 ms 后逐位回到音乐层', () => {
  const steady = synthesizeCuePcm('mic-open', STEADY);
  // 同一个种子下音乐层逐位一致，只有空气微触不同；去掉 airClick 时残差会是 0。
  const other = synthesizeCuePcm('mic-open', { sampleRate: SR, rng: airSeedOnly(0.25) });
  const airSamples = Math.round((8 / 1000) * SR);
  const residual = new Float32Array(airSamples);
  let peak = 0;
  for (let i = 0; i < airSamples; i += 1) {
    const value = (steady.samples[i] ?? 0) - (other.samples[i] ?? 0);
    residual[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  assert.ok(peak > 0.01, `空气微触峰值差 ${peak} 太小`);
  assert.equal(
    maxDiff(steady.samples.subarray(airSamples), other.samples.subarray(airSamples)),
    0,
    '8 ms 之后不应再有空气微触',
  );
  // 3 kHz / Q=4 的窄带噪声：向上过零率落在 3 kHz 附近。
  const freq = crossingFrequency(residual, SR, 1, 7);
  assert.ok(freq > 2_000 && freq < 4_500, `空气微触中心 ${freq} Hz 偏离 3 kHz`);
  // 空气微触自身有 1.2 ms 淡入淡出，mic-open 首尾仍不爆音。
  assert.ok(Math.abs(steady.samples[0] ?? 0) < 2e-3, '首样点没归零');
  assert.ok(Math.abs(steady.samples[steady.samples.length - 1] ?? 0) < 2e-3, '尾样点没归零');
});

test('五声音阶常量与星芒偏频符合规格', () => {
  assert.equal(SFX_NOTE_HZ.csharp5, 554.365);
  assert.equal(SFX_NOTE_HZ.e5, 659.255);
  assert.equal(SFX_NOTE_HZ.fsharp5, 739.989);
  assert.equal(SFX_NOTE_HZ.gsharp5, 830.609);
  assert.equal(SFX_NOTE_HZ.b5, 987.767);
  const params = resolveSfxRenderParams('mic-open', STEADY);
  assert.equal(params.ratio, 2.756);
  assert.equal(params.fmIndex, 1.8);
});

// ---------------------------------------------------------------------------
// WebAudio 运行时：最小结构 mock
// ---------------------------------------------------------------------------

class FakeParam implements SfxAudioParamLike {
  value = 1;
  readonly events: Array<{ readonly kind: string; readonly value: number; readonly time: number }> = [];

  setValueAtTime(value: number, startTime: number): unknown {
    this.events.push({ kind: 'set', value, time: startTime });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): unknown {
    this.events.push({ kind: 'ramp', value, time: endTime });
    this.value = value;
    return this;
  }

  cancelScheduledValues(startTime: number): unknown {
    this.events.push({ kind: 'cancel', value: 0, time: startTime });
    return this;
  }
}

class FakeNode implements SfxAudioNodeLike {
  readonly connections: object[] = [];

  connect(destination: object): unknown {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    // mock 不跟踪断开
  }
}

class FakeSource extends FakeNode implements SfxAudioBufferSourceLike {
  buffer: SfxAudioBufferLike | null = null;
  onended: unknown = null;
  startAt: number | null = null;
  stopAt: number | null = null;

  start(when?: number): void {
    this.startAt = when ?? 0;
  }

  stop(when?: number): void {
    this.stopAt = when ?? 0;
  }
}

class FakeGain extends FakeNode implements SfxGainLike {
  readonly gain = new FakeParam();
}

class FakeBuffer implements SfxAudioBufferLike {
  private readonly data: Float32Array;
  private readonly rate: number;

  constructor(length: number, rate: number) {
    this.data = new Float32Array(length);
    this.rate = rate;
  }

  get duration(): number {
    return this.data.length / this.rate;
  }

  getChannelData(_channel: number): Float32Array {
    return this.data;
  }
}

class FakeContext implements SfxAudioContextLike {
  currentTime = 0;
  sampleRate = SR;
  state = 'running';
  readonly destination: SfxAudioNodeLike = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly buffers: FakeBuffer[] = [];
  resumeCalls = 0;
  closeCalls = 0;

  createBuffer(_channels: number, length: number, rate: number): SfxAudioBufferLike {
    const buffer = new FakeBuffer(length, rate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): SfxAudioBufferSourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createGain(): SfxGainLike {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }
}

/** 往 globalThis 临时挂一个构造器，验证空闲兜底路径。 */
function withFakeAudioContext(run: (created: FakeContext[]) => void): void {
  const scope = globalThis as unknown as { AudioContext?: new () => FakeContext };
  const previous = scope.AudioContext;
  const created: FakeContext[] = [];
  scope.AudioContext = class extends FakeContext {
    constructor() {
      super();
      created.push(this);
    }
  };
  try {
    run(created);
  } finally {
    if (previous === undefined) delete scope.AudioContext;
    else scope.AudioContext = previous;
  }
}

test('createPetSfx 通话中优先复用共享 context，不另建新图', () => {
  withFakeAudioContext((created) => {
    const shared = new FakeContext();
    const sfx = createPetSfx({
      getSharedContext: () => shared,
      isEnabled: () => true,
      isRetroSpark: () => false,
    });
    sfx.play('mic-open');
    assert.equal(shared.sources.length, 1);
    assert.equal(created.length, 0);
    assert.equal(shared.buffers.length, 1);
    sfx.dispose();
  });
});

test('createPetSfx 空闲时回退独立 context，且惰性复用', () => {
  withFakeAudioContext((created) => {
    const sfx = createPetSfx({
      getSharedContext: () => null,
      isEnabled: () => true,
      isRetroSpark: () => false,
    });
    sfx.prime();
    assert.equal(created.length, 1);
    sfx.play('delegate');
    sfx.play('proactive');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.sources.length, 2);
    sfx.dispose();
    assert.equal(created[0]?.state, 'closed');
  });
});

test('fadeOut 对 delegate 调度 20 ms 顺滑淡出并停源', () => {
  withFakeAudioContext(() => {
    const shared = new FakeContext();
    const sfx = createPetSfx({
      getSharedContext: () => shared,
      isEnabled: () => true,
      isRetroSpark: () => false,
    });
    sfx.play('delegate');
    const gain = shared.gains[0];
    const source = shared.sources[0];
    if (gain === undefined || source === undefined) {
      throw new Error('delegate 没有创建 gain / source');
    }

    sfx.fadeOut('delegate', 20);
    const ramp = gain.gain.events.find((event) => event.kind === 'ramp');
    assert.ok(ramp !== undefined);
    assert.equal(ramp.value, 0);
    assert.ok(Math.abs(ramp.time - 0.02) < 1e-9);
    assert.ok(source.stopAt !== null && source.stopAt >= 0.02);
    sfx.dispose();
  });
});

test('soundEnabled=false 完全静音且不创建任何节点', () => {
  withFakeAudioContext((created) => {
    const shared = new FakeContext();
    const sfx = createPetSfx({
      getSharedContext: () => shared,
      isEnabled: () => false,
      isRetroSpark: () => false,
    });
    sfx.play('mic-open');
    sfx.play('delegate');
    assert.equal(shared.sources.length, 0);
    assert.equal(shared.buffers.length, 0);
    assert.equal(created.length, 0);

    sfx.play('mic-open', { force: true });
    assert.equal(shared.sources.length, 1);
    sfx.dispose();
  });
});

test('同一 cue 50 ms 冷却，barge-in 与 mic-open 不参与', () => {
  withFakeAudioContext(() => {
    const shared = new FakeContext();
    const sfx = createPetSfx({
      getSharedContext: () => shared,
      isEnabled: () => true,
      isRetroSpark: () => false,
    });
    sfx.play('delegate');
    sfx.play('delegate');
    assert.equal(shared.sources.length, 1);

    sfx.play('mic-open');
    sfx.play('mic-open');
    assert.equal(shared.sources.length, 3);

    sfx.play('barge-in');
    sfx.play('barge-in');
    assert.equal(shared.sources.length, 5);
    sfx.dispose();
  });
});

test('play 的 env 透传到渲染：深夜 sleepy 峰值再降 2.5 dB', () => {
  withFakeAudioContext(() => {
    const shared = new FakeContext();
    const sfx = createPetSfx({
      getSharedContext: () => shared,
      isEnabled: () => true,
      isRetroSpark: () => false,
    });
    sfx.play('sleepy', { env: { isNight: true, lowPower: false } });
    assert.equal(shared.buffers.length, 1);
    const buffer = shared.buffers[0];
    if (buffer === undefined) throw new Error('sleepy 没有创建 buffer');
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const magnitude = Math.abs(data[i] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
    // sleepy 目标峰值 -16 dBFS，深夜整体再 -2.5 dB。
    const peakDb = dbOf(peak);
    assert.ok(peakDb <= -18 && peakDb >= -19.5, `深夜 sleepy 峰值 ${peakDb} dBFS`);
    sfx.dispose();
  });
});
