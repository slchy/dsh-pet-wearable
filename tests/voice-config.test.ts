/**
 * 三端运行时配置只有一份：CLI、Web 插件、评测沙盒都走 `buildVoiceRuntimeConfig`。
 *
 * 锁的是会静默漂掉的那些数：浏览器语义预算 300、确认超时 30 s、
 * 沙盒门限 −46、上行增益 2，以及服务端 VAD 时客户端仍发 `commit()`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DEFAULT_CONFIRM_TIMEOUT_MS } from '../src/photo-inbox.ts';
import {
  buildVoiceRuntimeConfig,
  DEFAULT_BROWSER_STT_COMMIT_MS,
  DEFAULT_ASR_PREROLL_MS,
  DEFAULT_GATE_HOLD_MS,
  DEFAULT_GATE_PREROLL_MS,
  DEFAULT_MIN_SPEECH_MS,
  DEFAULT_GLASSES_STT_COMMIT_MS,
  DEFAULT_IMAGE_QUESTION,
  DEFAULT_PAUSE_DETECT_MS,
  DEFAULT_PLAYBACK_TAIL,
  DEFAULT_PLAYBACK_TAIL_MS,
  DEFAULT_SPECULATE_MS,
  DEFAULT_TRAILING_TRIM_MS,
  DEVICE_TIMING_PROFILES,
  resolveOmniApiKey,
  validateVoiceTiming,
  type VoiceRuntimeConfig,
  type VoiceRuntimeInput,
} from '../src/voice-config.ts';

const base = {
  env: {} as Record<string, string | undefined>,
  sttSpec: 'qwen-realtime',
  turnJudgeEnabled: true,
  turnJudgeModelPath: 'models/smart-turn-v3.2-cpu.onnx',
  semanticEnabled: true,
} satisfies VoiceRuntimeInput;

function shared(cfg: VoiceRuntimeConfig) {
  return {
    peakDbfs: cfg.peakDbfs,
    gate: cfg.gate,
    turnJudge: cfg.turnJudge,
    semanticBudgetMs: cfg.semanticBudgetMs,
    semanticTimeoutMs: cfg.semanticTimeoutMs,
    confirmTimeoutMs: cfg.confirmTimeoutMs,
    playbackTailMs: cfg.playbackTailMs,
    imageQuestion: cfg.imageQuestion,
  };
}

test('三端默认值同源：插件只改增益和控制口，沙盒只改空闲与档案', () => {
  const cli = buildVoiceRuntimeConfig(base);
  const web = buildVoiceRuntimeConfig({
    ...base,
    overrides: { micGain: 1, controlPort: 0 },
  });
  const sandbox = buildVoiceRuntimeConfig({
    ...base,
    overrides: {
      idleTimeoutMs: 120_000,
      archiveMaxMb: 200,
      archiveKeep: 100,
      photoTimeoutMs: 20_000,
    },
  });

  assert.equal(cli.micGain, 4);
  assert.equal(cli.peakDbfs, -30);
  assert.equal(cli.manualEndpoint, true);
  assert.equal(cli.gate.thresholdDbfs, -30);
  assert.equal(cli.gate.holdMs, 2000);
  assert.equal(cli.gate.prerollMs, 800);
  assert.equal(cli.gate.minSpeechMs, DEFAULT_MIN_SPEECH_MS);
  assert.equal(cli.gate.minSpeechMs, 120);
  assert.equal(cli.gate.asrPrerollMs, DEFAULT_ASR_PREROLL_MS);
  assert.equal(cli.gate.asrPrerollMs, 320);
  assert.equal(cli.gate.pauseDetectMs, 200);
  assert.equal(cli.gate.speculateMs, 100);
  assert.equal(cli.gate.commitMs, 20);
  assert.equal(cli.gate.sttCommitMs, 150);
  assert.equal(cli.gate.openQuietMs, 300);
  assert.equal(cli.gate.openQuietShortMs, 200);
  assert.equal(cli.gate.maxOpenSilenceMs, 650);
  assert.equal(cli.semanticBudgetMs, 400);
  assert.equal(cli.semanticTimeoutMs, 400);
  assert.equal(cli.confirmTimeoutMs, DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.equal(cli.photoTimeoutMs, 60_000);
  assert.equal(cli.idleTimeoutMs, 45_000);
  assert.equal(cli.archiveMaxMb, 80);
  assert.equal(cli.archiveKeep, 20);
  assert.equal(cli.playbackTailMs, DEFAULT_PLAYBACK_TAIL);
  assert.equal(cli.playbackTailMs, DEFAULT_PLAYBACK_TAIL_MS);
  assert.equal(cli.playbackTailMs, 600);
  assert.equal(DEFAULT_PLAYBACK_TAIL, DEFAULT_PLAYBACK_TAIL_MS);
  assert.equal(cli.imageQuestion, DEFAULT_IMAGE_QUESTION);
  assert.equal(cli.controlPort, 0);
  assert.equal(cli.turnJudge?.quietMs, 0);
  assert.equal(cli.turnJudge?.modelPath, 'models/smart-turn-v3.2-cpu.onnx');
  assert.equal(cli.turnJudge?.extendMs, 200);
  assert.equal(cli.turnJudge?.maxExtensions, 2);
  assert.equal(cli.turnJudge?.maxUnsureExtensions, 1);
  assert.equal(cli.turnJudge?.trailingTrimMs, 20);
  assert.equal(cli.turnJudge?.threshold, 0.5);
  assert.equal(cli.turnJudge?.thresholdCjk, 0.35);
  assert.equal(cli.turnJudge?.waitBudgetMs, 200);
  assert.equal(cli.turnJudge?.waitBudgetSequenceMs, 1_200);
  assert.equal(cli.turnJudge?.maxOpenSilenceMs, 650);

  assert.deepEqual(shared(web), shared(cli));
  assert.deepEqual(shared(sandbox), shared(cli));
  assert.equal(web.micGain, 1);
  assert.equal(web.controlPort, 0);
  assert.equal(web.photoTimeoutMs, cli.photoTimeoutMs);
  assert.equal(web.confirmTimeoutMs, DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.equal(sandbox.micGain, 4);
  assert.equal(sandbox.peakDbfs, -30);
  assert.equal(sandbox.idleTimeoutMs, 120_000);
  assert.equal(sandbox.archiveMaxMb, 200);
  assert.equal(sandbox.archiveKeep, 100);
  assert.equal(sandbox.photoTimeoutMs, 20_000);
  assert.equal(sandbox.confirmTimeoutMs, cli.confirmTimeoutMs);
});

test('QWEN_ASR_TURN_DETECTION=vad 时客户端不再 commit', () => {
  const vad = buildVoiceRuntimeConfig({
    ...base,
    env: {
      QWEN_ASR_TURN_DETECTION: 'vad',
      VOICE_COMMIT_MS: '40',
      VOICE_STT_COMMIT_MS: '80',
      VOICE_OPEN_QUIET_MS: '500',
    },
  });
  assert.equal(vad.manualEndpoint, false);
  assert.equal(vad.gate.commitMs, 0);
  assert.equal(vad.gate.sttCommitMs, 0);
  assert.equal(vad.gate.openQuietMs, undefined);
  assert.equal(vad.gate.openQuietShortMs, undefined);
  assert.equal(vad.gate.maxOpenSilenceMs, undefined);

  const other = buildVoiceRuntimeConfig({ ...base, sttSpec: 'aliyun' });
  assert.equal(other.manualEndpoint, false);
  assert.equal(other.gate.commitMs, 0);
  assert.equal(other.gate.sttCommitMs, 0);
  assert.equal(other.gate.openQuietMs, undefined);
  assert.equal(other.gate.openQuietShortMs, undefined);
  assert.equal(other.gate.maxOpenSilenceMs, undefined);
});

test('manual 端点仍读传入的 env，不读 process.env', () => {
  const previous = process.env['VOICE_COMMIT_MS'];
  process.env['VOICE_COMMIT_MS'] = '999';
  try {
    const untouched = buildVoiceRuntimeConfig(base);
    assert.equal(untouched.gate.commitMs, 20);
    const tuned = buildVoiceRuntimeConfig({
      ...base,
      env: { VOICE_COMMIT_MS: '40', VOICE_STT_COMMIT_MS: '80' },
    });
    assert.equal(tuned.gate.commitMs, 40);
    assert.equal(tuned.gate.sttCommitMs, 80);
  } finally {
    if (previous === undefined) delete process.env['VOICE_COMMIT_MS'];
    else process.env['VOICE_COMMIT_MS'] = previous;
  }
});

test('OMNI_API_KEY 单独配置时 resolveOmniApiKey 生效', () => {
  assert.equal(resolveOmniApiKey({ OMNI_API_KEY: 'omni-only' }), 'omni-only');
  assert.equal(resolveOmniApiKey({ DASHSCOPE_API_KEY: 'dash' }), 'dash');
  assert.equal(
    resolveOmniApiKey({ OMNI_API_KEY: 'omni', DASHSCOPE_API_KEY: 'dash' }),
    'omni',
  );
  assert.equal(resolveOmniApiKey({ OMNI_API_KEY: '  trimmed  ' }), 'trimmed');
  assert.equal(resolveOmniApiKey({}), '');
});

test('确认超时只认 MIAI_CONFIRM_TIMEOUT_MS，旧两段别名不再相加', () => {
  const legacy = buildVoiceRuntimeConfig({
    ...base,
    env: { MIAI_HQ_ARM_TIMEOUT_MS: '1000', MIAI_HQ_SHUTTER_TIMEOUT_MS: '2000' },
  });
  assert.equal(legacy.confirmTimeoutMs, DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.notEqual(legacy.confirmTimeoutMs, 3_000);
  const explicit = buildVoiceRuntimeConfig({
    ...base,
    env: {
      MIAI_CONFIRM_TIMEOUT_MS: '5000',
      MIAI_HQ_ARM_TIMEOUT_MS: '1000',
      MIAI_HQ_SHUTTER_TIMEOUT_MS: '2000',
    },
  });
  assert.equal(explicit.confirmTimeoutMs, 5_000);
});

test('判停旧名 SMART_TURN_* 仍然认', () => {
  const cfg = buildVoiceRuntimeConfig({
    ...base,
    env: { SMART_TURN_EXTEND_MS: '50' },
  });
  assert.equal(cfg.turnJudge?.extendMs, 50);
});

test('关掉判停就不带参数表', () => {
  const cfg = buildVoiceRuntimeConfig({ ...base, turnJudgeEnabled: false });
  assert.equal(cfg.turnJudge, undefined);
  assert.equal(cfg.semanticBudgetMs, 400);
});

test('设备档案给默认值：缺省与 glasses 相同，browser 用另一套电平', () => {
  assert.deepEqual(DEVICE_TIMING_PROFILES.glasses, {
    micGain: 4,
    peakDbfs: -30,
    sttCommitMs: DEFAULT_GLASSES_STT_COMMIT_MS,
    controlPort: 0,
  });
  assert.deepEqual(DEVICE_TIMING_PROFILES.browser, {
    micGain: 1,
    peakDbfs: -34,
    sttCommitMs: DEFAULT_BROWSER_STT_COMMIT_MS,
    controlPort: 0,
  });

  const glasses = buildVoiceRuntimeConfig({ ...base, profile: 'glasses' });
  const implicit = buildVoiceRuntimeConfig(base);
  assert.equal(glasses.micGain, 4);
  assert.equal(glasses.peakDbfs, -30);
  assert.equal(glasses.gate.thresholdDbfs, -30);
  assert.equal(glasses.gate.sttCommitMs, DEFAULT_GLASSES_STT_COMMIT_MS);
  assert.equal(glasses.gate.sttCommitMs, 150);
  assert.equal(glasses.controlPort, 0);
  assert.equal(implicit.micGain, glasses.micGain);
  assert.equal(implicit.peakDbfs, glasses.peakDbfs);
  assert.equal(implicit.gate.sttCommitMs, glasses.gate.sttCommitMs);
  assert.equal(implicit.controlPort, glasses.controlPort);

  const browser = buildVoiceRuntimeConfig({ ...base, profile: 'browser' });
  assert.equal(browser.micGain, 1);
  assert.equal(browser.peakDbfs, -34);
  assert.equal(browser.gate.thresholdDbfs, -34);
  assert.equal(browser.gate.sttCommitMs, DEFAULT_BROWSER_STT_COMMIT_MS);
  assert.equal(browser.gate.sttCommitMs, 320);
  assert.equal(browser.controlPort, 0);

  const browserVad = buildVoiceRuntimeConfig({
    ...base,
    profile: 'browser',
    env: { QWEN_ASR_TURN_DETECTION: 'vad' },
  });
  assert.equal(browserVad.manualEndpoint, false);
  assert.equal(browserVad.micGain, 1);
  assert.equal(browserVad.peakDbfs, -34);
  assert.equal(browserVad.gate.commitMs, 0);
  assert.equal(browserVad.gate.sttCommitMs, 0);
  assert.equal(browserVad.gate.openQuietMs, undefined);
  assert.equal(browserVad.gate.maxOpenSilenceMs, undefined);
});

test('显式 env 盖过设备档案，overrides 盖过 env', () => {
  const fromEnv = buildVoiceRuntimeConfig({
    ...base,
    profile: 'browser',
    env: {
      MIC_GAIN: '3',
      VOICE_PEAK_DBFS: '-20',
      VOICE_STT_COMMIT_MS: '180',
      PHOTO_CTL_PORT: '9',
    },
  });
  assert.equal(fromEnv.micGain, 3);
  assert.equal(fromEnv.peakDbfs, -20);
  assert.equal(fromEnv.gate.sttCommitMs, 180);
  assert.equal(fromEnv.controlPort, 9);

  const namedGain = buildVoiceRuntimeConfig({
    ...base,
    profile: 'browser',
    env: { MIAI_MIC_GAIN: '6', MIC_GAIN: '3' },
  });
  assert.equal(namedGain.micGain, 6);

  const fromOverrides = buildVoiceRuntimeConfig({
    ...base,
    profile: 'browser',
    env: {
      MIAI_MIC_GAIN: '6',
      VOICE_PEAK_DBFS: '-20',
      VOICE_STT_COMMIT_MS: '180',
      PHOTO_CTL_PORT: '9',
    },
    overrides: {
      micGain: 2,
      peakDbfs: -28,
      sttCommitMs: 160,
      controlPort: 7,
    },
  });
  assert.equal(fromOverrides.micGain, 2);
  assert.equal(fromOverrides.peakDbfs, -28);
  assert.equal(fromOverrides.gate.thresholdDbfs, -28);
  assert.equal(fromOverrides.gate.sttCommitMs, 160);
  assert.equal(fromOverrides.controlPort, 7);
});

test('pipelineMode=live 关掉投机，cascade 与缺省仍用默认窗', () => {
  const live = buildVoiceRuntimeConfig({ ...base, pipelineMode: 'live' });
  assert.equal(live.gate.speculateMs, 0);
  assert.equal(live.gate.pauseDetectMs, DEFAULT_PAUSE_DETECT_MS);

  const cascade = buildVoiceRuntimeConfig({ ...base, pipelineMode: 'cascade' });
  assert.equal(cascade.gate.speculateMs, DEFAULT_SPECULATE_MS);
  assert.equal(cascade.gate.speculateMs, 100);

  const implicit = buildVoiceRuntimeConfig(base);
  assert.equal(implicit.gate.speculateMs, DEFAULT_SPECULATE_MS);
});

test('openQuietShortMs 由 openQuietMs 的 2/3 四舍五入派生，不再读旧旋钮', () => {
  const derived = buildVoiceRuntimeConfig({
    ...base,
    env: { VOICE_OPEN_QUIET_MS: '450', VOICE_OPEN_QUIET_SHORT_MS: '10' },
  });
  assert.equal(derived.gate.openQuietMs, 450);
  assert.equal(derived.gate.openQuietShortMs, 300);
  assert.equal(derived.gate.openQuietShortMs, Math.round((450 * 2) / 3));

  const rounded = buildVoiceRuntimeConfig({
    ...base,
    env: { VOICE_OPEN_QUIET_MS: '301' },
  });
  assert.equal(rounded.gate.openQuietMs, 301);
  assert.equal(rounded.gate.openQuietShortMs, 201);
  assert.equal(rounded.gate.openQuietShortMs, Math.round((301 * 2) / 3));
});

test('关掉判停后，手动端点的 gate 仍带着统一开轮静音上限', () => {
  const manual = buildVoiceRuntimeConfig({ ...base, turnJudgeEnabled: false });
  assert.equal(manual.manualEndpoint, true);
  assert.equal(manual.turnJudge, undefined);
  assert.equal(manual.gate.openQuietMs, 300);
  assert.equal(manual.gate.openQuietShortMs, 200);
  assert.equal(manual.gate.maxOpenSilenceMs, 650);

  const tuned = buildVoiceRuntimeConfig({
    ...base,
    turnJudgeEnabled: false,
    env: { TURN_JUDGE_MAX_OPEN_SILENCE_MS: '800' },
  });
  assert.equal(tuned.turnJudge, undefined);
  assert.equal(tuned.gate.maxOpenSilenceMs, 800);

  const vad = buildVoiceRuntimeConfig({
    ...base,
    turnJudgeEnabled: false,
    env: { QWEN_ASR_TURN_DETECTION: 'vad', TURN_JUDGE_MAX_OPEN_SILENCE_MS: '800' },
  });
  assert.equal(vad.manualEndpoint, false);
  assert.equal(vad.gate.maxOpenSilenceMs, undefined);
  assert.equal(vad.gate.openQuietMs, undefined);
  assert.equal(vad.gate.openQuietShortMs, undefined);
});

test('SEMANTIC_END_TAG_BUDGET_MS 同时决定预算和超时', () => {
  const cfg = buildVoiceRuntimeConfig({
    ...base,
    env: { SEMANTIC_END_TAG_BUDGET_MS: '250', SEMANTIC_END_TAG_TIMEOUT_MS: '999' },
  });
  assert.equal(cfg.semanticBudgetMs, 250);
  assert.equal(cfg.semanticTimeoutMs, 250);
});

test('热路径常量不读已经移出 .env 的旧旋钮', () => {
  const cfg = buildVoiceRuntimeConfig({
    ...base,
    env: {
      VOICE_HOLD_MS: '50',
      VOICE_PREROLL_MS: '10',
      VOICE_PAUSE_DETECT_MS: '10',
      VOICE_SPECULATE_MS: '5',
      TURN_JUDGE_QUIET_MS: '999',
      TURN_JUDGE_TRIM_MS: '99',
      SEMANTIC_END_TAG_TIMEOUT_MS: '5',
    },
  });
  assert.equal(cfg.gate.holdMs, DEFAULT_GATE_HOLD_MS);
  assert.equal(cfg.gate.holdMs, 2_000);
  assert.equal(cfg.gate.prerollMs, DEFAULT_GATE_PREROLL_MS);
  assert.equal(cfg.gate.prerollMs, 800);
  assert.equal(cfg.gate.minSpeechMs, DEFAULT_MIN_SPEECH_MS);
  assert.equal(cfg.gate.asrPrerollMs, DEFAULT_ASR_PREROLL_MS);
  assert.equal(cfg.gate.pauseDetectMs, DEFAULT_PAUSE_DETECT_MS);
  assert.equal(cfg.gate.speculateMs, DEFAULT_SPECULATE_MS);
  assert.equal(cfg.turnJudge?.quietMs, 0);
  assert.equal(cfg.turnJudge?.trailingTrimMs, DEFAULT_TRAILING_TRIM_MS);
  assert.equal(cfg.turnJudge?.trailingTrimMs, 20);
  assert.equal(cfg.semanticBudgetMs, 400);
  assert.equal(cfg.semanticTimeoutMs, 400);
});

function assertTimingRejected(run: () => void, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof RangeError)) {
      assert.fail(`expected RangeError, got ${String(error)}`);
    }
    assert.match(error.message, pattern);
    return true;
  });
}

test('validateVoiceTiming 拒绝越界的 ASR 预卷和最短人声', () => {
  const cfg = buildVoiceRuntimeConfig(base);
  assertTimingRejected(
    () => validateVoiceTiming({
      ...cfg,
      gate: { ...cfg.gate, asrPrerollMs: cfg.gate.prerollMs + 1 },
    }),
    /gate\.asrPrerollMs=801\b[\s\S]*gate\.prerollMs=800\b[\s\S]*DEFAULT_ASR_PREROLL_MS/,
  );
  assertTimingRejected(
    () => validateVoiceTiming({
      ...cfg,
      gate: { ...cfg.gate, asrPrerollMs: -1 },
    }),
    /gate\.asrPrerollMs=-1\b[\s\S]*DEFAULT_ASR_PREROLL_MS/,
  );
  assertTimingRejected(
    () => validateVoiceTiming({
      ...cfg,
      gate: { ...cfg.gate, minSpeechMs: cfg.gate.holdMs },
    }),
    /gate\.minSpeechMs=2000\b[\s\S]*gate\.holdMs=2000\b[\s\S]*DEFAULT_MIN_SPEECH_MS/,
  );
  assertTimingRejected(
    () => validateVoiceTiming({
      ...cfg,
      gate: { ...cfg.gate, minSpeechMs: -1 },
    }),
    /gate\.minSpeechMs=-1\b[\s\S]*DEFAULT_MIN_SPEECH_MS/,
  );
  validateVoiceTiming({
    ...cfg,
    gate: { ...cfg.gate, asrPrerollMs: cfg.gate.prerollMs, minSpeechMs: 0 },
  });
});

test('validateVoiceTiming 拒绝会让端点互相踩踏的组合', () => {
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { VOICE_COMMIT_MS: '240', VOICE_STT_COMMIT_MS: '80' },
    }),
    /gate\.sttCommitMs=80\b[\s\S]*gate\.commitMs=240\b[\s\S]*VOICE_STT_COMMIT_MS/,
  );
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { VOICE_OPEN_QUIET_MS: '400', TURN_JUDGE_MAX_OPEN_SILENCE_MS: '100' },
    }),
    /gate\.maxOpenSilenceMs=100\b[\s\S]*gate\.openQuietMs=400\b[\s\S]*TURN_JUDGE_MAX_OPEN_SILENCE_MS/,
  );
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { VOICE_STT_COMMIT_MS: String(DEFAULT_GATE_HOLD_MS) },
    }),
    /gate\.holdMs=2000\b[\s\S]*gate\.sttCommitMs=2000\b[\s\S]*DEFAULT_GATE_HOLD_MS/,
  );
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { TURN_JUDGE_WAIT_BUDGET_MS: '40', TURN_JUDGE_EXTEND_MS: '200' },
    }),
    /turnJudge\.waitBudgetMs=40\b[\s\S]*turnJudge\.extendMs=200\b[\s\S]*TURN_JUDGE_WAIT_BUDGET_MS/,
  );
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { VOICE_OPEN_QUIET_MS: '0' },
    }),
    /gate\.openQuietMs=0\b[\s\S]*VOICE_OPEN_QUIET_MS/,
  );
});

test('等待预算和开轮静音上限允许显式关掉（0）', () => {
  const cfg = buildVoiceRuntimeConfig({
    ...base,
    env: {
      TURN_JUDGE_WAIT_BUDGET_MS: '0',
      TURN_JUDGE_MAX_OPEN_SILENCE_MS: '0',
    },
  });
  assert.equal(cfg.turnJudge?.waitBudgetMs, 0);
  assert.equal(cfg.turnJudge?.maxOpenSilenceMs, 0);
  assert.equal(cfg.gate.maxOpenSilenceMs, 0);
  assert.equal(cfg.gate.openQuietMs, 300);
  validateVoiceTiming(cfg);
});

test('序列预算顶到能量门时拒绝；0 仍表示不设序列上限', () => {
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { TURN_JUDGE_SEQUENCE_BUDGET_MS: '2000' },
    }),
    /gate\.holdMs=2000\b[\s\S]*turnJudge\.waitBudgetSequenceMs=2000\b[\s\S]*TURN_JUDGE_SEQUENCE_BUDGET_MS/,
  );
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: { TURN_JUDGE_SEQUENCE_BUDGET_MS: '2500' },
    }),
    /gate\.holdMs=2000\b[\s\S]*turnJudge\.waitBudgetSequenceMs=2500\b[\s\S]*TURN_JUDGE_SEQUENCE_BUDGET_MS/,
  );
  assertTimingRejected(
    () => buildVoiceRuntimeConfig({
      ...base,
      env: {
        QWEN_ASR_TURN_DETECTION: 'vad',
        TURN_JUDGE_SEQUENCE_BUDGET_MS: '2000',
      },
    }),
    /gate\.holdMs=2000\b[\s\S]*turnJudge\.waitBudgetSequenceMs=2000\b[\s\S]*TURN_JUDGE_SEQUENCE_BUDGET_MS/,
  );

  const unlimited = buildVoiceRuntimeConfig({
    ...base,
    env: { TURN_JUDGE_SEQUENCE_BUDGET_MS: '0' },
  });
  assert.equal(unlimited.manualEndpoint, true);
  assert.equal(unlimited.turnJudge?.waitBudgetSequenceMs, 0);
  assert.equal(unlimited.gate.holdMs, DEFAULT_GATE_HOLD_MS);
  validateVoiceTiming(unlimited);

  const vadUnlimited = buildVoiceRuntimeConfig({
    ...base,
    env: {
      QWEN_ASR_TURN_DETECTION: 'vad',
      TURN_JUDGE_SEQUENCE_BUDGET_MS: '0',
      TURN_JUDGE_MAX_OPEN_SILENCE_MS: '0',
    },
  });
  assert.equal(vadUnlimited.manualEndpoint, false);
  assert.equal(vadUnlimited.turnJudge?.waitBudgetSequenceMs, 0);
  assert.equal(vadUnlimited.turnJudge?.maxOpenSilenceMs, 0);
  validateVoiceTiming(vadUnlimited);
});

test('src/main.ts 复用 buildVoiceRuntimeConfig 单源配置，不再自带默认值', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  assert.match(main, /buildVoiceRuntimeConfig\(/u);
  assert.match(main, /resolveLiveApiKey\(process\.env\)/u);
  assert.match(main, /DEFAULT_IMAGE_QUESTION/u);
  assert.match(main, /DEFAULT_PET_PARAMS\.listenMs/u);
  assert.equal(/DEFAULT_PROACTIVE/u.test(main), false);
  assert.equal(main.includes('这张图里有什么'), false);
  assert.equal(/env\['OMNI_API_KEY'\] \?\? env\['DASHSCOPE_API_KEY'\]/u.test(main), false);
});

test('openai-realtime 与自定义 supportsManualEndpoint 插件同样启用手动端点', () => {
  const openAi = buildVoiceRuntimeConfig({
    ...base,
    sttSpec: 'openai-realtime',
  });
  assert.equal(openAi.manualEndpoint, true);
  assert.equal(openAi.gate.commitMs, 20);
  assert.equal(openAi.gate.sttCommitMs, 150);

  const openAiVad = buildVoiceRuntimeConfig({
    ...base,
    sttSpec: 'openai-realtime',
    env: { ASR_TURN_DETECTION: 'vad' },
  });
  assert.equal(openAiVad.manualEndpoint, false);
  assert.equal(openAiVad.gate.commitMs, 0);
  assert.equal(openAiVad.gate.sttCommitMs, 0);

  const pluginManual = buildVoiceRuntimeConfig({
    ...base,
    sttSpec: './custom-asr.mjs',
    sttSupportsManualEndpoint: true,
  });
  assert.equal(pluginManual.manualEndpoint, true);
  assert.equal(pluginManual.gate.commitMs, 20);

  const disabledCapability = buildVoiceRuntimeConfig({
    ...base,
    sttSpec: 'qwen-realtime',
    sttSupportsManualEndpoint: false,
  });
  assert.equal(disabledCapability.manualEndpoint, false);
  assert.equal(disabledCapability.gate.commitMs, 0);
});

test('src/main.ts 先 loadSharedTurnJudge 再 buildVoiceRuntimeConfig，且不再读 Python 路径', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const load = main.indexOf('await loadSharedTurnJudge(');
  const build = main.indexOf('buildVoiceRuntimeConfig({');
  assert.ok(load > 0, 'main.ts 没有走进程内声学判停加载器');
  assert.ok(build > load, 'buildVoiceRuntimeConfig 必须在 loadSharedTurnJudge 之后：参数表要带实际模型路径');
  assert.equal(main.includes('TURN_JUDGE_PYTHON'), false);
  assert.equal(main.includes('TURN_JUDGE_SCRIPT'), false);
  assert.equal(/from\s+['"]\.\/turn-judge\.ts['"]/u.test(main), false, 'main.ts 不该再直接 new TurnJudge');
});
