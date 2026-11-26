/**
 * 声学判停（Smart Turn v3.2）的纯 TS 特征与进程内推理。
 *
 * 三层断言，缺一层就会静默坏掉：
 * - **FFT**：400 = 2^4×5^2，混合基实现必须与朴素 DFT 同值，否则 log-mel 全错；
 * - **窗口**：8 秒尾对齐、开头补零，喂反了 p 会落在 0.2–0.5 之间晃；
 * - **数值**：真模型 + 1 s 预热正弦的输出必须与 Python 金标准一致（< 1e-4）。
 *
 * 模型文件不在 git 里（`models/*.onnx`）。缺失时真模型那组 `t.skip`，
 * 其余用例在无模型 CI 上照样跑 —— 纯逻辑部分零原生依赖。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import {
  loadSharedTurnJudge,
  resolveTurnJudgeModelPath,
} from '../src/runtime/turn-judge-bootstrap.ts';
import { TurnJudge } from '../src/turn-judge.ts';
import {
  computeWhisperLogMelFeatures,
  fft400,
  pcm16ToLast8Seconds,
  WHISPER_MAX_SAMPLES,
  WHISPER_N_FRAMES,
  WHISPER_N_MELS,
  WHISPER_SAMPLE_RATE,
} from '../src/whisper-features.ts';

// ---------------------------------------------------------------- FFT

test('fft400 与朴素 DFT 数值一致（误差 < 1e-11）', () => {
  const n = 400;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    real[i] = seed / 2147483648 - 0.5;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    imag[i] = seed / 2147483648 - 0.5;
  }

  const fast = fft400(real, imag);
  let maxError = 0;
  for (let k = 0; k < n; k += 1) {
    let dftRe = 0;
    let dftIm = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      dftRe += real[t]! * c - imag[t]! * s;
      dftIm += real[t]! * s + imag[t]! * c;
    }
    maxError = Math.max(maxError, Math.abs(fast.re[k]! - dftRe), Math.abs(fast.im[k]! - dftIm));
  }
  assert.ok(maxError < 1e-11, `fft400 与朴素 DFT 最大误差 ${maxError}，应 < 1e-11`);
});

test('fft400 纯实数输入：虚部响应共轭对称', () => {
  const real = new Float64Array(400);
  for (let i = 0; i < 400; i += 1) real[i] = Math.sin((2 * Math.PI * 7 * i) / 400);
  const { re, im } = fft400(real);
  assert.ok(Math.abs(im[0]!) < 1e-10, '实数输入的 DC 虚部应为 0');
  for (let k = 1; k < 200; k += 1) {
    assert.ok(Math.abs(im[k]! + im[400 - k]!) < 1e-10, `第 ${k} 对共轭虚部不抵消`);
    assert.ok(Math.abs(re[k]! - re[400 - k]!) < 1e-10, `第 ${k} 对共轭实部不相等`);
  }
});

// ---------------------------------------------------------------- 窗口

test('pcm16ToLast8Seconds：不足 8 秒在开头补零，真实音频顶到窗口末尾', () => {
  const oneSecond = Buffer.alloc(WHISPER_SAMPLE_RATE * 2);
  for (let i = 0; i < WHISPER_SAMPLE_RATE; i += 1) {
    oneSecond.writeInt16LE((i % 1000) + 1, i * 2);
  }
  const out = pcm16ToLast8Seconds(oneSecond);
  assert.equal(out.length, WHISPER_MAX_SAMPLES);
  assert.equal(out[0], 0);
  assert.equal(out[WHISPER_MAX_SAMPLES - WHISPER_SAMPLE_RATE - 1], 0);
  assert.equal(out[WHISPER_MAX_SAMPLES - WHISPER_SAMPLE_RATE], 1 / 32768);
  assert.equal(out[WHISPER_MAX_SAMPLES - 1], 1000 / 32768);
});

test('pcm16ToLast8Seconds：超过 8 秒只留末尾 8 秒', () => {
  const nineSeconds = Buffer.alloc(WHISPER_SAMPLE_RATE * 9 * 2);
  for (let i = 0; i < WHISPER_SAMPLE_RATE * 9; i += 1) {
    nineSeconds.writeInt16LE((i % 20000) + 1, i * 2);
  }
  const out = pcm16ToLast8Seconds(nineSeconds);
  assert.equal(out.length, WHISPER_MAX_SAMPLES);
  // 第 9 秒的采样点被保留，第一秒的没有被保留
  assert.equal(out[0], (WHISPER_SAMPLE_RATE + 1) / 32768);
  const lastValue = ((WHISPER_SAMPLE_RATE * 9 - 1) % 20000) + 1;
  assert.equal(out[WHISPER_MAX_SAMPLES - 1], lastValue / 32768);
});

// ---------------------------------------------------------------- log-mel

test('computeWhisperLogMelFeatures：形状 80×800，数值有限', () => {
  const audio = new Float32Array(WHISPER_SAMPLE_RATE);
  for (let i = 0; i < audio.length; i += 1) {
    audio[i] = Math.sin((2 * Math.PI * 440 * i) / WHISPER_SAMPLE_RATE) * 0.1;
  }
  const features = computeWhisperLogMelFeatures(audio, { doNormalize: true });
  assert.equal(features.length, WHISPER_N_MELS * WHISPER_N_FRAMES);
  assert.equal(features.length, 80 * 800);
  for (let i = 0; i < features.length; i += 1) {
    assert.ok(Number.isFinite(features[i]!), `第 ${i} 个特征不是有限数`);
  }
  // 有能量：不能是整片地板值
  let max = -Infinity;
  for (let i = 0; i < features.length; i += 1) max = Math.max(max, features[i]!);
  assert.ok(max > -1.4, `440 Hz 正弦的 log-mel 最大值 ${max}，不该落在地板`);
});

test('computeWhisperLogMelFeatures：全零输入走方差 eps，输出全是地板值 −1.5', () => {
  const features = computeWhisperLogMelFeatures(new Float32Array(WHISPER_SAMPLE_RATE * 2));
  assert.equal(features.length, 80 * 800);
  for (let i = 0; i < features.length; i += 1) {
    assert.equal(features[i], -1.5, `全零输入第 ${i} 个特征应为 −1.5`);
  }
});

test('computeWhisperLogMelFeatures：doNormalize=false 与 true 结果不同', () => {
  const audio = new Float32Array(WHISPER_SAMPLE_RATE);
  for (let i = 0; i < audio.length; i += 1) {
    audio[i] = Math.sin((2 * Math.PI * 300 * i) / WHISPER_SAMPLE_RATE) * 0.05 + 0.01;
  }
  const normalized = computeWhisperLogMelFeatures(audio, { doNormalize: true });
  const raw = computeWhisperLogMelFeatures(audio, { doNormalize: false });
  let diff = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    diff = Math.max(diff, Math.abs(normalized[i]! - raw[i]!));
  }
  assert.ok(diff > 1e-3, '归一化开关没有生效');
});

// ---------------------------------------------------------------- 模型定位 / 启动加载

test('resolveTurnJudgeModelPath：TURN_JUDGE_MODEL 优先，兼容 SMART_TURN_MODEL', () => {
  assert.equal(resolveTurnJudgeModelPath({ TURN_JUDGE_MODEL: '/tmp/a.onnx' }), '/tmp/a.onnx');
  assert.equal(resolveTurnJudgeModelPath({ SMART_TURN_MODEL: '/tmp/legacy.onnx' }), '/tmp/legacy.onnx');
  assert.equal(
    resolveTurnJudgeModelPath({ TURN_JUDGE_MODEL: '  ', SMART_TURN_MODEL: '/tmp/legacy.onnx' }),
    '/tmp/legacy.onnx',
    '新名为空白时要落到旧名',
  );
  assert.equal(
    resolveTurnJudgeModelPath({ TURN_JUDGE_MODEL: '/tmp/new.onnx', SMART_TURN_MODEL: '/tmp/old.onnx' }),
    '/tmp/new.onnx',
    '两个都有时新名赢',
  );
  const found = resolveTurnJudgeModelPath({});
  if (found !== null) assert.match(found, /smart-turn-v3\.2-cpu\.onnx$/u);
});

test('loadSharedTurnJudge：显式关闭（TURN_JUDGE=0/off/false）返回 null 并说明', async () => {
  for (const mode of ['0', 'off', 'false']) {
    const lines: string[] = [];
    const judge = await loadSharedTurnJudge({ TURN_JUDGE: mode }, (line) => { lines.push(line); });
    assert.equal(judge, null, `TURN_JUDGE=${mode} 不该加载模型`);
    assert.ok(
      lines.some((line) => line.includes('声学判停') && line.includes('已关闭')),
      `TURN_JUDGE=${mode} 的日志没说清楚：${lines.join(' / ')}`,
    );
  }
  const legacy: string[] = [];
  assert.equal(await loadSharedTurnJudge({ SMART_TURN: '0' }, (line) => { legacy.push(line); }), null);
  assert.ok(legacy.some((line) => line.includes('已关闭')), '旧名 SMART_TURN=0 也要认');
});

test('loadSharedTurnJudge：模型路径不存在时退回固定窗口，不阻断启动', async () => {
  const lines: string[] = [];
  const judge = await loadSharedTurnJudge(
    { TURN_JUDGE_MODEL: 'models/no-such-smart-turn.onnx' },
    (line) => { lines.push(line); },
  );
  assert.equal(judge, null);
  assert.ok(lines.some((line) => line.includes('退回固定合并窗口')), lines.join(' / '));
});

// ---------------------------------------------------------------- TurnJudge 故障安全

test('TurnJudge：空 PCM 与缺失模型一律返回 −1，不抛错', async () => {
  const lines: string[] = [];
  const judge = new TurnJudge({
    modelPath: 'models/no-such-smart-turn.onnx',
    log: (line) => { lines.push(line); },
  });
  try {
    assert.equal(await judge.predict(Buffer.alloc(0)), -1);
    assert.equal(await judge.predict(Buffer.alloc(320, 1)), -1);
    assert.ok(lines.some((line) => line.includes('模型不存在')), lines.join(' / '));
  } finally {
    judge.stop();
  }
});

test('TurnJudge：stop() 幂等，之后 predict 返回 −1', async () => {
  const judge = new TurnJudge({ modelPath: 'models/no-such-smart-turn.onnx' });
  judge.stop();
  assert.doesNotThrow(() => { judge.stop(); });
  assert.equal(await judge.predict(Buffer.alloc(320, 1)), -1);
});

// ---------------------------------------------------------------- 真模型金标准

test('Smart Turn v3.2 真模型：预热正弦输出对齐 Python 金标准（< 1e-4）', { timeout: 120_000 }, async (t) => {
  const modelPath = resolveTurnJudgeModelPath({});
  if (modelPath === null || !existsSync(modelPath)) {
    t.skip('models/smart-turn-v3.2-cpu.onnx 不存在');
    return;
  }

  const judge = new TurnJudge({ modelPath });
  try {
    const warmup = Buffer.alloc(WHISPER_SAMPLE_RATE * 2);
    for (let i = 0; i < WHISPER_SAMPLE_RATE; i += 1) {
      warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2);
    }
    const startedAt = Date.now();
    const probability = await judge.predict(warmup);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(probability >= 0, `真模型推理失败（p=${probability}）`);
    assert.ok(
      Math.abs(probability - 0.978554368019104) < 1e-4,
      `预热正弦 p=${probability}，Python 金标准 0.978554368019104，`
      + `误差 ${Math.abs(probability - 0.978554368019104)}（本次 ${elapsedMs} ms）`,
    );
    // 第二次推理是稳态路径（第一次含模型加载 + 预热）
    const second = await judge.predict(warmup);
    assert.ok(Math.abs(second - probability) < 1e-6, '同一输入的两次推理不该漂');
  } finally {
    judge.stop();
  }
});

test('loadSharedTurnJudge：真模型就绪日志包含模型路径与 p', async (t) => {
  const modelPath = resolveTurnJudgeModelPath({});
  if (modelPath === null || !existsSync(modelPath)) {
    t.skip('models/smart-turn-v3.2-cpu.onnx 不存在');
    return;
  }
  const lines: string[] = [];
  const judge = await loadSharedTurnJudge({}, (line) => { lines.push(line); });
  try {
    assert.ok(judge !== null, '仓库里有模型时应当加载成功');
    assert.equal(judge.modelPath, modelPath);
    const ready = lines.find((line) => line.includes('已就绪'));
    assert.ok(ready !== undefined, lines.join(' / '));
    assert.match(ready, /Smart Turn v3\.2 进程内 ONNX/u);
    assert.match(ready, /p=0\.9/u);
  } finally {
    judge?.stop();
  }
});
