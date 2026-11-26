/**
 * 插件入口拆成 driver / driver-policy / host-lifecycle / standalone-bridge / boot-voice-stack。
 * 运行时配置仍只走 buildVoiceRuntimeConfig；公开纯函数从 driver.ts 再导出。
 * 这五个文件都不得再 import CLI 入口 ./voice/main.ts。
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
  shouldEnableSemanticEndpoint,
  shouldUsePureLiveAudio,
  type HostPhase,
  type HostVoiceBackendView,
  type StackEvent,
  type StackPhase,
  type StackTransition,
  type VoiceBackendState,
  type VoiceWebConfig,
} from '../src/driver.ts';
import { buildVoiceRuntimeConfig } from '../src/voice/voice-config.ts';

const PLUGIN_FILES = [
  'driver.ts',
  'driver-policy.ts',
  'host-lifecycle.ts',
  'standalone-bridge.ts',
  'boot-voice-stack.ts',
] as const;

type PluginFile = (typeof PLUGIN_FILES)[number];

function readPlugin(name: PluginFile): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
}

const pluginSource = Object.fromEntries(
  PLUGIN_FILES.map((name) => [name, readPlugin(name)]),
) as Record<PluginFile, string>;

const pluginUnion = PLUGIN_FILES.map((name) => pluginSource[name]).join('\n');

test('boot-voice-stack.ts 调用同一份配置，并直连 voice/runtime', () => {
  const boot = pluginSource['boot-voice-stack.ts'];

  assert.match(boot, /buildVoiceRuntimeConfig\(/u);
  assert.match(boot, /loadSharedTurnJudge\(process\.env,\s*report\)/u);
  assert.equal(/TURN_JUDGE_PYTHON|TURN_JUDGE_SCRIPT|new TurnJudge/u.test(boot), false);
  assert.match(boot, /profile:\s*'browser'/u);
  assert.match(boot, /pipelineMode:\s*plan\.mode/u);
  assert.match(boot, /shouldEnableSemanticEndpoint\(/u);
  assert.match(boot, /installHttpAgent\(DEFAULT_KEEPALIVE_MS\)/u);
  assert.match(boot, /loadStaticAsrCorpus\(memoryFile\.hotwordHints\(\)/u);
  assert.match(boot, /resolveAsrLanguage\(process\.env\)/u);
  assert.match(boot, /memorySummary:\s*\(\)\s*=>\s*memoryFile\.summary\(\)/u);
  assert.match(boot, /\.then\(\(code\) => \{[\s\S]*reject\(/u);
  assert.match(boot, /resolveArchiveDir\(process\.env\['MIAI_ARCHIVE_DIR'\], homedir\(\)\)/u);
  assert.match(boot, /formatArchiveBanner\(archiveDir\)/u);
  assert.match(boot, /state\.backend = \{ status: 'stopped' \}/u);
  assert.match(boot, /const effectiveStt = usePureLiveAudio \? 'qwen-realtime' : config\.stt/u);
  assert.match(boot, /const effectiveTts = usePureLiveAudio \? 'silent' : config\.tts/u);
  assert.match(
    boot,
    /import\s*\{[^}]*\bbuildAgent\b[^}]*\bbuildStt\b[^}]*\bbuildTts\b[^}]*\}\s*from\s*'\.\/voice\/runtime\/providers-factory\.ts'/u,
  );
  assert.match(
    boot,
    /import\s*\{[^}]*\bloadAuthenticator\b[^}]*\bloadDotEnv\b[^}]*\}\s*from\s*'\.\/voice\/runtime\/env-bootstrap\.ts'/u,
  );
  assert.match(
    boot,
    /import\s*\{\s*createAuditSlot\s*\}\s*from\s*'\.\/voice\/runtime\/audit-slot\.ts'/u,
  );
  assert.match(
    boot,
    /import\s*\{[^}]*\bassemblePipelinePlan\b[^}]*\bassembleStreamingAgent\b[^}]*\bAssembledStreamingPipeline\b[^}]*\}\s*from\s*'\.\/voice\/runtime\/pipeline-assembly\.ts'/u,
  );
  assert.match(
    boot,
    /import\s*\{[^}]*\bloadStaticAsrCorpus\b[^}]*\bresolveAsrLanguage\b[^}]*\}\s*from\s*'\.\/voice\/runtime\/asr-context\.ts'/u,
  );
});

test('standalone-bridge.ts 检查环回、证书到期，并直连 env-bootstrap', () => {
  const bridge = pluginSource['standalone-bridge.ts'];
  assert.match(bridge, /isLoopbackHost\(config\.host\)/u);
  assert.match(bridge, /expiryWarning\(cert\)/u);
  assert.match(
    bridge,
    /import\s*\{\s*loadAuthenticator\s*\}\s*from\s*'\.\/voice\/runtime\/env-bootstrap\.ts'/u,
  );
});

test('driver-policy.ts 用 ?? 解析档案目录，关闭时打出「档案 关闭」', () => {
  const policy = pluginSource['driver-policy.ts'];
  assert.match(policy, /return configured \?\? join\(homeDir, '\.voice-agent', 'archives'\)/u);
  assert.match(policy, /档案 关闭/u);
});

test('五个插件文件都不回退到旧默认、旧状态字段或 || 档案目录', () => {
  assert.equal(/MIAI_HTTP_KEEPALIVE_MS/u.test(pluginUnion), false);
  assert.equal(/config\.host !== '127\.0\.0\.1'/u.test(pluginUnion), false);
  assert.equal(/SEMANTIC_END_TAG_BUDGET_MS',\s*300/u.test(pluginUnion), false);
  assert.equal(/30_000/u.test(pluginUnion), false);
  assert.equal(/MIAI_ARCHIVE_DIR'\] \|\|/u.test(pluginUnion), false);
  assert.equal(/let hostMounted/u.test(pluginUnion), false);
  assert.equal(/stackStarted/u.test(pluginUnion), false);
  assert.equal(/fallbackRelease/u.test(pluginUnion), false);
  assert.equal(/state\.voicePort/u.test(pluginUnion), false);
  assert.equal(/state\.voiceError/u.test(pluginUnion), false);
  assert.equal(/state\.pipelineMode/u.test(pluginUnion), false);
  assert.equal(/effectiveTts = wantsLive && hasOmniKey/u.test(pluginUnion), false);
});

test('五个插件文件不再 import ./voice/main.ts', () => {
  const voiceMain = /(?:from|import)\s*\(?\s*['"][^'"]*voice\/main(?:\.ts|\.js)?['"]/u;
  for (const name of PLUGIN_FILES) {
    assert.equal(voiceMain.test(pluginSource[name]), false, `${name} 不得 import ./voice/main.ts`);
  }
  assert.equal(/function bootVoiceStack/u.test(pluginSource['driver.ts']), false);
  assert.equal(/function mountHostPlugin/u.test(pluginSource['driver.ts']), false);
  assert.equal(/function bootStandalone/u.test(pluginSource['driver.ts']), false);
  assert.match(pluginSource['driver.ts'], /export default \{ name, Config, apply \}/u);
});

test('语义判停：Pure Live 默认关，Cascade 与直连非 dsh 默认开', () => {
  assert.equal(shouldEnableSemanticEndpoint({
    pipelineMode: 'live',
    envFlag: undefined,
    hasApiKey: true,
  }), false);
  assert.equal(shouldEnableSemanticEndpoint({
    pipelineMode: 'live',
    envFlag: '1',
    hasApiKey: true,
  }), true);
  assert.equal(shouldEnableSemanticEndpoint({
    pipelineMode: 'live',
    envFlag: '1',
    hasApiKey: false,
  }), false);
  assert.equal(shouldEnableSemanticEndpoint({
    pipelineMode: 'cascade',
    envFlag: undefined,
    hasApiKey: true,
  }), true);
  assert.equal(shouldEnableSemanticEndpoint({
    pipelineMode: 'cascade',
    envFlag: '0',
    hasApiKey: true,
  }), false);
  assert.equal(shouldEnableSemanticEndpoint({
    pipelineMode: null,
    envFlag: undefined,
    hasApiKey: true,
  }), true);
});

test('浏览器档案经 buildVoiceRuntimeConfig 给出电平、封段与 Pure Live 投机窗', () => {
  const runtime = buildVoiceRuntimeConfig({
    env: {},
    profile: 'browser',
    pipelineMode: 'live',
    sttSpec: 'qwen-realtime',
    turnJudgeEnabled: false,
    semanticEnabled: false,
  });
  assert.equal(runtime.micGain, 1);
  assert.equal(runtime.peakDbfs, -34);
  assert.equal(runtime.controlPort, 0);
  assert.equal(runtime.gate.sttCommitMs, 320);
  assert.equal(runtime.gate.speculateMs, 0);
  assert.equal(runtime.gate.maxOpenSilenceMs, 650);
});

test('档案目录默认落到 ~/.voice-agent/archives，显式空字符串仍关闭', () => {
  const home = join('Users', 'me');
  assert.equal(resolveArchiveDir(undefined, home), join(home, '.voice-agent', 'archives'));
  assert.equal(resolveArchiveDir('', home), '');
  assert.equal(resolveArchiveDir(join('tmp', 'arc'), home), join('tmp', 'arc'));
  assert.equal(formatArchiveBanner(''), '档案 关闭');
  assert.equal(formatArchiveBanner(join('tmp', 'arc')), `档案 ${join('tmp', 'arc')}`);
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

  const stoppedState: VoiceBackendState = { status: 'stopped' };
  const stopped: HostVoiceBackendView = resolveHostVoiceBackendView(stoppedState);
  assert.equal(stopped.voiceReady, false);
  assert.equal(stopped.voiceError, null);
  assert.equal(stopped.pipelineMode, 'stopped');
  assert.equal(stopped.port, null);
  assert.notEqual(stopped.pipelineMode, 'live');
  assert.equal(getVoicePort(stoppedState), null);

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

test('公开类型仍从 driver.ts 导出', () => {
  const backend: VoiceBackendState = { status: 'starting' };
  const view: HostVoiceBackendView = resolveHostVoiceBackendView(backend);
  const event: StackEvent = { type: 'stop' };
  const transition: StackTransition = reduceStackPhase({ kind: 'waiting' }, event);
  const config: VoiceWebConfig = {
    mode: 'host',
    sessionId: '',
    port: 8767,
    host: '127.0.0.1',
    origins: [],
    servePage: false,
    tls: { keyPath: '', certPath: '' },
    stt: 'aliyun',
    tts: 'cosyvoice',
    agent: 'dsh',
    workDir: '',
    device: '',
  };
  assert.equal(view.pipelineMode, 'starting');
  assert.equal(transition.phase.kind, 'stopped');
  assert.equal(transition.releaseNow, null);
  assert.equal(config.mode, 'host');
});
