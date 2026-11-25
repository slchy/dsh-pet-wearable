/**
 * Silero v5 共享会话、能量门回波护栏、32 ms 上行重切、最短人声门槛、启动降级。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { EnergyGate } from '../src/energy-gate.ts';
import type { AudioFrame } from '../src/engine-contract.ts';
import { pcm16PeakDbfs } from '../src/pcm.ts';
import { loadSharedVad, resolveVadModelPath } from '../src/runtime/vad-bootstrap.ts';
import { SilenceTriggers, type SilenceTriggerHost } from '../src/silence-triggers.ts';
import { UplinkPipeline } from '../src/uplink-pipeline.ts';
import { SAMPLE_RATE, WINDOW, SileroVadModel, type SpeechVadStream } from '../src/vad.ts';

const FRAME_BYTES = WINDOW * 2;

function pcmOf(sample: number, bytes: number): Buffer {
  const pcm = Buffer.alloc(bytes);
  const clamped = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  for (let i = 0; i < bytes; i += 2) pcm.writeInt16LE(clamped, i);
  return pcm;
}

function pcmDb(dbfs: number, bytes = 640): Buffer {
  return pcmOf(32_767 * (10 ** (dbfs / 20)), bytes);
}

function gateAt(now: () => number = () => 0): EnergyGate {
  return new EnergyGate({
    thresholdDbfs: -40,
    holdMs: 2_000,
    prerollBytes: 8_000,
    sampleRate: SAMPLE_RATE,
    now,
  });
}

/** 120 Hz 声门脉冲过三个共振峰，给神经 VAD 一段像元音的激励。 */
function vowelFrames(count: number): Float32Array[] {
  const total = count * WINDOW;
  const wave = new Float32Array(total);
  const f0 = 120;
  const formants = [
    { f: 730, bw: 90, gain: 1 },
    { f: 1090, bw: 110, gain: 0.55 },
    { f: 2440, bw: 170, gain: 0.25 },
  ].map((item) => {
    const radius = Math.exp((-Math.PI * item.bw) / SAMPLE_RATE);
    return {
      a1: -2 * radius * Math.cos((2 * Math.PI * item.f) / SAMPLE_RATE),
      a2: radius * radius,
      gain: item.gain * (1 - radius),
      z1: 0,
      z2: 0,
    };
  });
  let phase = 0;
  const step = f0 / SAMPLE_RATE;
  for (let n = 0; n < total; n += 1) {
    phase += step;
    if (phase >= 1) phase -= 1;
    const open = phase < 0.45 ? Math.sin((Math.PI * phase) / 0.45) : 0;
    const impulse = phase < step ? 1 : 0;
    const excitation = impulse * 0.9 + open * 0.2;
    let mixed = 0;
    for (const filter of formants) {
      const next = excitation * filter.gain - filter.a1 * filter.z1 - filter.a2 * filter.z2;
      filter.z2 = filter.z1;
      filter.z1 = next;
      mixed += next;
    }
    wave[n] = Math.max(-1, Math.min(1, Math.tanh(mixed * 1.4)));
  }
  const frames: Float32Array[] = [];
  for (let i = 0; i < count; i += 1) {
    frames.push(wave.subarray(i * WINDOW, (i + 1) * WINDOW));
  }
  return frames;
}

function pipelineOf(options: {
  readonly vadStream?: SpeechVadStream | null;
  readonly now?: () => number;
  readonly isSpeaking?: () => boolean;
  readonly onFrame?: (frame: AudioFrame) => void;
  readonly onPcm?: (pcm: Buffer) => void;
  readonly onRawPcm?: (pcm: Buffer) => void;
}): UplinkPipeline {
  return new UplinkPipeline({
    ffmpegPath: 'ffmpeg',
    codec: 'pcm16',
    sampleRate: SAMPLE_RATE,
    gate: { thresholdDbfs: -40, holdMs: 2_000, prerollMs: 0 },
    log: () => {},
    onError: () => {},
    onSpeechOpen: () => {},
    onSpeechClose: () => {},
    onFrame: options.onFrame ?? (() => {}),
    onPcm: options.onPcm ?? (() => {}),
    ...(options.onRawPcm === undefined ? {} : { onRawPcm: options.onRawPcm }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.vadStream === undefined ? {} : { vadStream: options.vadStream }),
    ...(options.isSpeaking === undefined ? {} : { isSpeaking: options.isSpeaking }),
  });
}

test('SileroVadModel 共享会话，双流隔离，静音低、元音高', { timeout: 60_000 }, async () => {
  const modelPath = resolveVadModelPath({});
  assert.ok(modelPath, '仓库里应能定位 models/silero_vad.onnx');
  assert.equal(existsSync(modelPath), true);
  const model = await SileroVadModel.load(modelPath);
  try {
    assert.match(model.modelPath, /silero_vad\.onnx$/u);
    const speech = model.createStream();
    const quiet = model.createStream();
    const vowels = vowelFrames(24);
    const silence = new Float32Array(WINDOW);
    let speechMax = 0;
    let silenceMax = 0;
    for (let i = 0; i < vowels.length; i += 1) {
      const vowel = vowels[i];
      assert.ok(vowel);
      silenceMax = Math.max(silenceMax, await quiet.process(silence));
      speechMax = Math.max(speechMax, await speech.process(vowel));
    }
    assert.ok(silenceMax < 0.15, `静音流最高概率 ${silenceMax}，应 < 0.15`);
    assert.ok(speechMax > 0.5, `人声流最高概率 ${speechMax}，应 > 0.5`);

    speech.reset();
    let afterReset = 0;
    for (let i = 0; i < 3; i += 1) {
      afterReset = Math.max(afterReset, await speech.process(silence));
    }
    assert.ok(afterReset < 0.15, `reset 后静音概率 ${afterReset}，应 < 0.15`);
    const quietAfter = await quiet.process(silence);
    assert.ok(quietAfter < 0.15, `另一条流不应被 reset 带走，概率 ${quietAfter}`);
  } finally {
    await model.dispose();
    await model.dispose();
  }
  assert.throws(() => model.createStream(), /SileroVadModel 已释放/);
});

test('EnergyGate 神经滞回、播报期护栏、能量模式 +6 dB', () => {
  const loud = pcmOf(8_000, 640);
  assert.ok(pcm16PeakDbfs(loud) > -62);
  const mid = pcmDb(-37);
  const midPeak = pcm16PeakDbfs(mid);
  assert.ok(midPeak > -40 && midPeak <= -34, `中等电平 ${midPeak} 应落在 (-40, -34]`);
  const above = pcmDb(-20);
  assert.ok(pcm16PeakDbfs(above) > -34);
  const digitalSilence = Buffer.alloc(640);

  const hysteresis = gateAt();
  const tooLow = hysteresis.process(loud, 0, 0.44);
  assert.equal(tooLow.voiced, false);
  assert.equal(tooLow.forward, false);
  const opened = hysteresis.process(loud, 20, 0.45);
  assert.equal(opened.voiced, true);
  assert.ok(opened.opened);
  const held = hysteresis.process(loud, 40, 0.3);
  assert.equal(held.voiced, true);
  assert.equal(held.forward, true);
  const released = hysteresis.process(loud, 60, 0.29);
  assert.equal(released.voiced, false);
  assert.equal(released.forward, true, '跌破 0.30 只结束本段人声，保持窗内门还开着');

  const floor = gateAt();
  const silentHot = floor.process(digitalSilence, 0, 0.99);
  assert.equal(silentHot.forward, false, '数字静音即使概率很高也不开门');

  const echo = gateAt();
  for (let i = 0; i < 3; i += 1) {
    const early = echo.process(loud, i * 32, 0.7, { speaking: true });
    assert.equal(early.voiced, false, `播报期第 ${i + 1} 帧还没攒够 4 帧`);
    assert.equal(early.forward, false);
  }
  const fourth = echo.process(loud, 96, 0.7, { speaking: true });
  assert.equal(fourth.voiced, true);
  const still = echo.process(loud, 128, 0.3, { speaking: true });
  assert.equal(still.voiced, true, '已经确认的人声用 0.30 维持，不再要求 0.65');

  const blocked = gateAt();
  for (let i = 0; i < 4; i += 1) {
    const soft = blocked.process(loud, i * 32, 0.5, { speaking: true });
    assert.equal(soft.voiced, false, '播报期 0.50 低于 0.65，四帧也不开门');
  }

  const plain = gateAt();
  assert.equal(plain.process(mid, 0).voiced, true, '不在播报期，中等电平按原门限开门');

  const speakingEnergy = gateAt();
  const guarded = speakingEnergy.process(mid, 0, undefined, { speaking: true });
  assert.equal(guarded.voiced, false);
  assert.equal(guarded.forward, false);
  for (let i = 0; i < 3; i += 1) {
    const early = speakingEnergy.process(above, 20 + i * 20, undefined, { speaking: true });
    assert.equal(early.voiced, false, `能量护栏第 ${i + 1} 帧还没攒够 4 帧`);
  }
  const barge = speakingEnergy.process(above, 80, undefined, { speaking: true });
  assert.equal(barge.voiced, true, '比抬高后的门限更响，连续 4 帧后播报期也能开口');
  const continued = speakingEnergy.process(mid, 100, undefined, { speaking: true });
  assert.equal(continued.voiced, true, '本段已经确认后，能量门限回到原来的 -40');
  const dropped = speakingEnergy.process(digitalSilence, 120, undefined, { speaking: true });
  assert.equal(dropped.voiced, false);
  assert.equal(dropped.forward, true);
  const rearmed = speakingEnergy.process(mid, 140, undefined, { speaking: true });
  assert.equal(rearmed.voiced, false, '静音打断后播报护栏重新武装');
  const closed = speakingEnergy.process(digitalSilence, 140 + 2_000 + 1, undefined, { speaking: true });
  assert.equal(closed.closed, true);
  const afterClose = speakingEnergy.process(loud, 3_000, 0.5, { speaking: true });
  assert.equal(afterClose.forward, false, '关门后 inSpeech 已清，播报期 0.50 不能重开');
});

test('UplinkPipeline 把 20 ms 重切成 32 ms，推理严格串行，时间戳单调', async () => {
  let clock = 5_000;
  let inflight = 0;
  let maxInflight = 0;
  const lengths: number[] = [];
  const raw: number[] = [];
  const amplified: number[] = [];
  const frames: AudioFrame[] = [];
  const stream: SpeechVadStream = {
    async process(frame: Float32Array): Promise<number> {
      lengths.push(frame.length);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => { setTimeout(resolve, 2); });
      inflight -= 1;
      return 0.9;
    },
    reset(): void {},
  };
  const pipeline = pipelineOf({
    vadStream: stream,
    now: () => clock,
    onRawPcm: (pcm) => { raw.push(pcm.length); },
    onPcm: (pcm) => { amplified.push(pcm.length); },
    onFrame: (frame) => { frames.push(frame); },
  });
  const first = pcmOf(8_000, 640);
  pipeline.push(first);
  assert.deepEqual(raw, [640], '原始块在推理前同步交出去');
  assert.deepEqual(amplified, [640]);
  assert.equal(frames.length, 0, '20 ms 还凑不满一帧');
  pipeline.push(pcmOf(8_000, 640));
  pipeline.push(pcmOf(8_000, 768));
  clock = 5_100;
  pipeline.push(pcmOf(8_000, 2_048));
  await pipeline.flushVad();
  pipeline.end();

  assert.deepEqual(lengths, [WINDOW, WINDOW, WINDOW, WINDOW]);
  assert.equal(maxInflight, 1, '同一个流的 process 不能重叠');
  assert.deepEqual(frames.map((frame) => frame.pcm.length), [
    FRAME_BYTES, FRAME_BYTES, FRAME_BYTES, FRAME_BYTES,
  ]);
  // 前两帧各来自一次只切出 1 帧的包，时间戳就是包到达时刻；
  // 最后一包一次切出 2 帧，从包尾按 32 ms 倒推。
  assert.deepEqual(frames.map((frame) => frame.tsMs), [5_000, 5_000, 5_068, 5_100]);
  for (let i = 1; i < frames.length; i += 1) {
    const prev = frames[i - 1];
    const current = frames[i];
    assert.ok(prev && current && current.tsMs >= prev.tsMs);
  }
});

test('一次来包切出两帧时，时间戳从包尾倒推且单调不减', async () => {
  let clock = 5_000;
  const frames: AudioFrame[] = [];
  const pipeline = pipelineOf({
    vadStream: {
      async process(): Promise<number> { return 0.9; },
      reset(): void {},
    },
    now: () => clock,
    onFrame: (frame) => { frames.push(frame); },
  });
  pipeline.push(pcmOf(8_000, 2_048));
  clock = 5_100;
  pipeline.push(pcmOf(8_000, 2_048));
  await pipeline.flushVad();
  pipeline.end();
  assert.deepEqual(frames.map((frame) => frame.tsMs), [4_968, 5_000, 5_068, 5_100]);
});

test('UplinkPipeline.end() 丢掉还没推理的帧', async () => {
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let resets = 0;
  const frames: AudioFrame[] = [];
  const stream: SpeechVadStream = {
    async process(): Promise<number> {
      calls += 1;
      await blocked;
      return 0.95;
    },
    reset(): void { resets += 1; },
  };
  const pipeline = pipelineOf({
    vadStream: stream,
    now: () => 8_000,
    onFrame: (frame) => { frames.push(frame); },
  });
  pipeline.push(pcmOf(8_000, FRAME_BYTES * 4));
  assert.equal(calls, 1, '第一帧已经进推理，后面三帧还在队列里');
  const flushed = pipeline.flushVad();
  pipeline.end();
  assert.equal(resets, 1);
  release();
  await flushed;
  assert.equal(calls, 1);
  assert.equal(frames.length, 0);
});

test('没有 vadStream 时能量门仍同步开门', () => {
  const frames: AudioFrame[] = [];
  const pipeline = pipelineOf({
    now: () => 1_000,
    onFrame: (frame) => { frames.push(frame); },
  });
  pipeline.push(pcmOf(8_000, 640));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.pcm.length, 640);
  assert.equal(frames[0]?.voiced, true);
  pipeline.end();
});

function triggerHost(): SilenceTriggerHost {
  return {
    pendingText: () => '',
    lastUtteranceAt: () => Number.NEGATIVE_INFINITY,
    lastPartialAt: () => 1_500,
    lastPartialText: () => '你好',
    hasPredictor: () => true,
    predictionPending: () => false,
    startUpcomingPrediction: () => { predicts.push(1); },
    onVoiced: () => {},
  };
}

const commits: number[] = [];
const sttCommits: number[] = [];
const partials: string[] = [];
const predicts: number[] = [];

function freshTriggers(): SilenceTriggers {
  commits.length = 0;
  sttCommits.length = 0;
  partials.length = 0;
  predicts.length = 0;
  return new SilenceTriggers({
    commitAfterMs: 20,
    sttCommitAfterMs: 40,
    speculateMs: 100,
    silencePauseMs: 200,
    minSpeechMs: 120,
    onCommit: (ms) => { commits.push(ms); },
    onSttCommit: (ms) => { sttCommits.push(ms); },
    onPartial: (text) => { partials.push(text); return true; },
    log: () => {},
  }, triggerHost());
}

function voicedThenQuiet(triggers: SilenceTriggers, voicedMs: number, atMs: number): void {
  triggers.noteFrame(true, atMs, 0, true, voicedMs);
  triggers.noteFrame(false, atMs + 250, 250, true, 20);
}

test('minSpeechMs=120：64 ms 尖峰不封段，128 ms 双封段，清零后重新计', () => {
  const short = freshTriggers();
  voicedThenQuiet(short, 64, 1_000);
  assert.deepEqual(commits, []);
  assert.deepEqual(sttCommits, []);
  assert.deepEqual(partials, []);
  assert.deepEqual(predicts, []);

  const enough = freshTriggers();
  voicedThenQuiet(enough, 128, 1_000);
  assert.equal(commits.length, 1);
  assert.equal(sttCommits.length, 1);
  assert.equal(partials.length, 1);
  assert.equal(predicts.length, 1);

  const reset = freshTriggers();
  reset.noteFrame(true, 1_000, 0, true, 200);
  reset.resetSegment();
  reset.noteFrame(false, 1_250, 250, true, 20);
  assert.deepEqual(commits, []);
  assert.deepEqual(sttCommits, []);

  const uttered = freshTriggers();
  uttered.noteFrame(true, 1_000, 0, true, 200);
  uttered.onUtterance();
  uttered.noteFrame(false, 1_250, 250, true, 20);
  assert.deepEqual(commits, []);
  assert.deepEqual(sttCommits, []);
  voicedThenQuiet(uttered, 128, 2_000);
  assert.equal(commits.length, 1);
  assert.equal(sttCommits.length, 1);
});

test('loadSharedVad 在显式关闭或找不到模型时退回能量门', async () => {
  const energyLines: string[] = [];
  const energy = await loadSharedVad(
    { VOICE_VAD: 'energy' },
    (line) => { energyLines.push(line); },
  );
  assert.equal(energy, null);
  assert.match(energyLines.join('\n'), /能量门（VOICE_VAD=energy，神经 VAD 已关闭）/u);

  const missingLines: string[] = [];
  const missing = await loadSharedVad(
    { VOICE_VAD_MODEL: 'models/no-such-silero.onnx' },
    (line) => { missingLines.push(line); },
  );
  assert.equal(missing, null);
  assert.match(
    missingLines.join('\n'),
    /退回能量门（未找到 models\/silero_vad\.onnx，可设 VOICE_VAD_MODEL 指定）/u,
  );
  assert.equal(
    resolveVadModelPath({ VOICE_VAD_MODEL: '  custom/path.onnx  ' }),
    'custom/path.onnx',
  );
});
