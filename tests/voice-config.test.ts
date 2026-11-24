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
  DEFAULT_IMAGE_QUESTION,
  DEFAULT_PLAYBACK_TAIL,
  resolveOmniApiKey,
  type VoiceRuntimeConfig,
  type VoiceRuntimeInput,
} from '../src/voice-config.ts';

const base = {
  env: {} as Record<string, string | undefined>,
  sttSpec: 'qwen-realtime',
  turnJudgeEnabled: true,
  turnJudgePython: 'python',
  turnJudgeScript: 'judge.py',
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
  assert.equal(cli.gate.pauseDetectMs, 200);
  assert.equal(cli.gate.speculateMs, 100);
  assert.equal(cli.gate.commitMs, 20);
  assert.equal(cli.gate.sttCommitMs, 150);
  assert.equal(cli.gate.openQuietMs, 300);
  assert.equal(cli.gate.openQuietShortMs, 200);
  assert.equal(cli.semanticBudgetMs, 400);
  assert.equal(cli.semanticTimeoutMs, 400);
  assert.equal(cli.confirmTimeoutMs, DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.equal(cli.photoTimeoutMs, 60_000);
  assert.equal(cli.idleTimeoutMs, 45_000);
  assert.equal(cli.archiveMaxMb, 80);
  assert.equal(cli.archiveKeep, 20);
  assert.equal(cli.playbackTailMs, DEFAULT_PLAYBACK_TAIL);
  assert.equal(cli.playbackTailMs, 600);
  assert.equal(cli.imageQuestion, DEFAULT_IMAGE_QUESTION);
  assert.equal(cli.controlPort, 0);
  assert.equal(cli.turnJudge?.quietMs, 0);
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

  const other = buildVoiceRuntimeConfig({ ...base, sttSpec: 'aliyun' });
  assert.equal(other.manualEndpoint, false);
  assert.equal(other.gate.commitMs, 0);
  assert.equal(other.gate.sttCommitMs, 0);
  assert.equal(other.gate.openQuietMs, undefined);
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

test('确认超时认新名字，只留旧的两段时相加', () => {
  const legacy = buildVoiceRuntimeConfig({
    ...base,
    env: { MIAI_HQ_ARM_TIMEOUT_MS: '1000', MIAI_HQ_SHUTTER_TIMEOUT_MS: '2000' },
  });
  assert.equal(legacy.confirmTimeoutMs, 3_000);
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

test('三个入口都调用同一份配置，不再各抄一套默认值', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const driver = readFileSync(new URL('../packages/dsh-voice-web/src/driver.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../bench/eval/server.ts', import.meta.url), 'utf8');

  assert.match(main, /buildVoiceRuntimeConfig\(/u);
  assert.match(main, /resolveOmniApiKey\(process\.env\)/u);
  assert.match(main, /DEFAULT_IMAGE_QUESTION/u);
  assert.match(main, /DEFAULT_PET_PARAMS\.listenMs/u);
  assert.equal(/DEFAULT_PROACTIVE/u.test(main), false);
  assert.equal(main.includes('这张图里有什么'), false);
  assert.equal(/env\['OMNI_API_KEY'\] \?\? env\['DASHSCOPE_API_KEY'\]/u.test(main), false);

  assert.match(driver, /buildVoiceRuntimeConfig\(/u);
  assert.match(driver, /micGain:\s*1/u);
  assert.match(driver, /controlPort:\s*0/u);
  assert.match(driver, /isLoopbackHost\(config\.host\)/u);
  assert.match(driver, /installHttpAgent\(/u);
  assert.match(driver, /expiryWarning\(cert\)/u);
  assert.match(driver, /loadStaticAsrCorpus\(memoryFile\.hotwordHints\(\)/u);
  assert.match(driver, /resolveAsrLanguage\(process\.env\)/u);
  assert.match(driver, /memorySummary:\s*\(\)\s*=>\s*memoryFile\.summary\(\)/u);
  assert.match(driver, /\.then\(\(code\) => \{[\s\S]*reject\(/u);
  assert.equal(/config\.host !== '127\.0\.0\.1'/u.test(driver), false);
  assert.equal(/SEMANTIC_END_TAG_BUDGET_MS',\s*300/u.test(driver), false);
  assert.equal(/30_000/u.test(driver), false);

  assert.match(server, /buildVoiceRuntimeConfig\(/u);
  assert.match(server, /idleTimeoutMs:\s*120_000/u);
  assert.match(server, /archiveMaxMb:\s*200/u);
  assert.match(server, /archiveKeep:\s*100/u);
  assert.match(server, /photoTimeoutMs:\s*20_000/u);
  assert.equal(/-46/u.test(server), false);
  assert.equal(/MIC_GAIN',\s*2/u.test(server), false);
});
