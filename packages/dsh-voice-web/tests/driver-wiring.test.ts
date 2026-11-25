/**
 * `driver.ts` 必须调用同一份运行时配置，不能再自抄一套默认值。
 * 宿主相位、语音后端、语音栈释放与 Pure Live 改写也从这里的纯函数取，避免布尔各自漂移。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  formatArchiveBanner,
  getVoicePort,
  isDshBackedAgent,
  nextHostPhase,
  pureLiveVadConflict,
  reduceStackPhase,
  resolveArchiveDir,
  resolveHostVoiceBackendView,
  shouldUsePureLiveAudio,
  type HostPhase,
  type StackPhase,
} from '../src/driver.ts';

test('driver.ts 调用同一份配置，不再自抄默认值', () => {
  const driver = readFileSync(new URL('../src/driver.ts', import.meta.url), 'utf8');

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
});

test('档案目录默认落到 ~/.voice-agent/archives，显式空字符串仍关闭', () => {
  const home = join('Users', 'me');
  assert.equal(resolveArchiveDir(undefined, home), join(home, '.voice-agent', 'archives'));
  assert.equal(resolveArchiveDir('', home), '');
  assert.equal(resolveArchiveDir(join('tmp', 'arc'), home), join('tmp', 'arc'));
  assert.equal(formatArchiveBanner(''), '档案 关闭');
  assert.equal(formatArchiveBanner(join('tmp', 'arc')), `档案 ${join('tmp', 'arc')}`);
});

test('driver 用 ?? 解析档案目录，并在关闭时打出「档案 关闭」', () => {
  const driver = readFileSync(new URL('../src/driver.ts', import.meta.url), 'utf8');
  assert.match(driver, /return configured \?\? join\(homeDir, '\.voice-agent', 'archives'\)/u);
  assert.match(driver, /resolveArchiveDir\(process\.env\['MIAI_ARCHIVE_DIR'\], homedir\(\)\)/u);
  assert.match(driver, /formatArchiveBanner\(archiveDir\)/u);
  assert.match(driver, /档案 关闭/u);
  assert.equal(/MIAI_ARCHIVE_DIR'\] \|\|/u.test(driver), false);
  assert.equal(/let hostMounted/u.test(driver), false);
  assert.equal(/stackStarted/u.test(driver), false);
  assert.equal(/fallbackRelease/u.test(driver), false);
  assert.equal(/state\.voicePort/u.test(driver), false);
  assert.equal(/state\.voiceError/u.test(driver), false);
  assert.equal(/state\.pipelineMode/u.test(driver), false);
  assert.match(driver, /state\.backend = \{ status: 'stopped' \}/u);
  assert.match(driver, /const effectiveStt = usePureLiveAudio \? 'qwen-realtime' : config\.stt/u);
  assert.match(driver, /const effectiveTts = usePureLiveAudio \? 'silent' : config\.tts/u);
  assert.equal(/effectiveTts = wantsLive && hasOmniKey/u.test(driver), false);
});

test('HostPhase 只有 discovering 能进入 host 或 standalone', () => {
  assert.equal(nextHostPhase('discovering', 'host'), 'host');
  assert.equal(nextHostPhase('discovering', 'standalone'), 'standalone');

  let phase: HostPhase = 'standalone';
  phase = nextHostPhase(phase, 'host');
  assert.equal(phase, 'standalone');
  phase = nextHostPhase(phase, 'stopped');
  assert.equal(phase, 'stopped');
  phase = nextHostPhase(phase, 'host');
  assert.equal(phase, 'stopped');

  phase = nextHostPhase('discovering', 'host');
  assert.equal(nextHostPhase(phase, 'standalone'), 'host');
  assert.equal(nextHostPhase('host', 'stopped'), 'stopped');
  assert.equal(nextHostPhase('stopped', 'standalone'), 'stopped');
});

test('VoiceBackend 的面板字段只从当前状态派生，stopped 不残留 live', () => {
  const starting = resolveHostVoiceBackendView({ status: 'starting' });
  assert.equal(starting.voiceReady, false);
  assert.equal(starting.voiceError, '语音后端正在启动…');
  assert.equal(starting.pipelineMode, 'starting');
  assert.equal(starting.port, null);
  assert.equal(getVoicePort({ status: 'starting' }), null);

  const ready = resolveHostVoiceBackendView({ status: 'ready', port: 4321, mode: 'live' });
  assert.equal(ready.voiceReady, true);
  assert.equal(ready.voiceError, null);
  assert.equal(ready.pipelineMode, 'live');
  assert.equal(ready.port, 4321);
  assert.equal(getVoicePort({ status: 'ready', port: 4321, mode: 'live' }), 4321);

  const failed = resolveHostVoiceBackendView({ status: 'failed', reason: '没有密钥' });
  assert.equal(failed.voiceReady, false);
  assert.equal(failed.voiceError, '没有密钥');
  assert.equal(failed.pipelineMode, 'unavailable');
  assert.equal(failed.port, null);
  assert.equal(getVoicePort({ status: 'failed', reason: '没有密钥' }), null);

  const stopped = resolveHostVoiceBackendView({ status: 'stopped' });
  assert.equal(stopped.voiceReady, false);
  assert.equal(stopped.voiceError, null);
  assert.equal(stopped.pipelineMode, 'stopped');
  assert.equal(stopped.port, null);
  assert.notEqual(stopped.pipelineMode, 'live');
  assert.equal(getVoicePort({ status: 'stopped' }), null);

  const cascade = resolveHostVoiceBackendView({ status: 'ready', port: 7, mode: 'cascade' });
  assert.equal(cascade.pipelineMode, 'cascade');
  const direct = resolveHostVoiceBackendView({ status: 'ready', port: 8, mode: 'direct' });
  assert.equal(direct.pipelineMode, 'direct');
  assert.equal(direct.voiceReady, true);
});

test('StackPhase 只启动一次；booting 期间 stop 后，boot 完成立刻释放且不留第二份', async () => {
  let calls = 0;
  const release = async (): Promise<void> => {
    calls += 1;
  };

  let phase: StackPhase = { kind: 'waiting' };
  const booting = reduceStackPhase(phase, { type: 'boot', source: 'timeout' });
  assert.equal(booting.releaseNow, null);
  assert.equal(booting.phase.kind, 'booting');
  if (booting.phase.kind === 'booting') {
    assert.equal(booting.phase.source, 'timeout');
  }
  phase = booting.phase;

  const ignored = reduceStackPhase(phase, { type: 'boot', source: 'controller' });
  assert.equal(ignored.phase, phase);
  assert.equal(ignored.releaseNow, null);

  const stopped = reduceStackPhase(phase, { type: 'stop' });
  assert.equal(stopped.releaseNow, null);
  assert.equal(stopped.phase.kind, 'stopped');
  phase = stopped.phase;

  const done = reduceStackPhase(phase, { type: 'booted', release });
  assert.equal(done.phase.kind, 'stopped');
  assert.equal(done.releaseNow, release);
  if (done.releaseNow !== null) await done.releaseNow();

  const after = reduceStackPhase(done.phase, { type: 'boot', source: 'controller' });
  assert.equal(after.phase.kind, 'stopped');
  assert.equal(after.releaseNow, null);
  const stoppedAgain = reduceStackPhase(done.phase, { type: 'stop' });
  assert.equal(stoppedAgain.releaseNow, null);
  assert.equal(calls, 1);
});

test('StackPhase 进入 up 之后 stop 交出当初那一份 release', async () => {
  const order: string[] = [];
  const first = async (): Promise<void> => {
    order.push('first');
  };
  const second = async (): Promise<void> => {
    order.push('second');
  };
  const up = reduceStackPhase(
    { kind: 'booting', source: 'controller' },
    { type: 'booted', release: first },
  );
  assert.equal(up.releaseNow, null);
  assert.equal(up.phase.kind, 'up');
  if (up.phase.kind !== 'up') {
    assert.fail('expected up');
  }
  assert.equal(up.phase.release, first);

  const extra = reduceStackPhase(up.phase, { type: 'booted', release: second });
  assert.equal(extra.phase, up.phase);
  assert.equal(extra.releaseNow, second);

  const stopped = reduceStackPhase(extra.phase, { type: 'stop' });
  assert.equal(stopped.phase.kind, 'stopped');
  assert.equal(stopped.releaseNow, first);
  if (extra.releaseNow !== null) await extra.releaseNow();
  if (stopped.releaseNow !== null) await stopped.releaseNow();
  assert.deepEqual(order, ['second', 'first']);

  const waitingStop = reduceStackPhase({ kind: 'waiting' }, { type: 'stop' });
  assert.equal(waitingStop.phase.kind, 'stopped');
  assert.equal(waitingStop.releaseNow, null);
});

test('Pure Live 只在 dsh、live、有 key、且不是服务端 VAD 时改写音频', () => {
  const live = {
    dshBacked: true,
    wantsLive: true,
    hasOmniKey: true,
    turnDetection: undefined,
  };
  assert.equal(shouldUsePureLiveAudio(live), true);
  assert.equal(shouldUsePureLiveAudio({ ...live, turnDetection: 'manual' }), true);
  assert.equal(shouldUsePureLiveAudio({ ...live, turnDetection: '  Manual  ' }), true);
  assert.equal(shouldUsePureLiveAudio({ ...live, turnDetection: '' }), true);
  assert.equal(shouldUsePureLiveAudio({ ...live, turnDetection: 'vad' }), false);
  assert.equal(shouldUsePureLiveAudio({ ...live, turnDetection: ' VAD ' }), false);
  assert.equal(shouldUsePureLiveAudio({ ...live, dshBacked: false }), false);
  assert.equal(shouldUsePureLiveAudio({ ...live, wantsLive: false }), false);
  assert.equal(shouldUsePureLiveAudio({ ...live, hasOmniKey: false }), false);

  assert.equal(isDshBackedAgent('dsh'), true);
  assert.equal(isDshBackedAgent('dsh-subprocess'), true);
  assert.equal(isDshBackedAgent('echo'), false);
  assert.equal(isDshBackedAgent('none'), false);
});

test('显式 VOICE_PIPELINE=live 且 QWEN_ASR_TURN_DETECTION=vad 时拒绝，避免改成 silent', () => {
  const message = pureLiveVadConflict({
    dshBacked: true,
    voicePipeline: ' live ',
    turnDetection: 'vad',
  });
  assert.equal(typeof message, 'string');
  assert.match(message ?? '', /VOICE_PIPELINE=live/u);
  assert.match(message ?? '', /QWEN_ASR_TURN_DETECTION=vad/u);
  assert.match(message ?? '', /commitMs=0/u);
  assert.match(message ?? '', /silent/u);

  assert.equal(pureLiveVadConflict({
    dshBacked: true,
    voicePipeline: 'live',
    turnDetection: 'manual',
  }), null);
  assert.equal(pureLiveVadConflict({
    dshBacked: true,
    voicePipeline: 'cascade',
    turnDetection: 'vad',
  }), null);
  assert.equal(pureLiveVadConflict({
    dshBacked: false,
    voicePipeline: 'live',
    turnDetection: 'vad',
  }), null);
  assert.equal(pureLiveVadConflict({
    dshBacked: true,
    voicePipeline: undefined,
    turnDetection: 'vad',
  }), null);
});
