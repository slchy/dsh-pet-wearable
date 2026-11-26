import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyDotEnvUpdates,
  parseDotEnvText,
  readDotEnvFile,
  upsertDotEnvFile,
} from '../src/env-store.ts';
import { fetchAvailableModels } from '../src/model-catalog.ts';
import {
  applyVoiceProfile,
  buildEnvUpdatesFromConfigRequest,
  buildResetToDefaultEnvUpdates,
  buildVoiceConfigSnapshot,
} from '../src/voice-config-apply.ts';
import {
  OPTIMIZED_DEFAULT_TIP,
  deriveOpenAiHttpBaseUrl,
  deriveOpenAiRealtimeWsUrl,
  maskApiKey,
  sanitizeFetchModelsRequest,
  sanitizeVoiceConfigUpdate,
} from '../src/voice-overrides.ts';

test('maskApiKey 严格脱敏，永不回显完整明文密钥', () => {
  assert.equal(maskApiKey(''), null);
  assert.equal(maskApiKey('   '), null);
  assert.equal(maskApiKey(undefined), null);
  assert.equal(maskApiKey('abcd'), '****');
  assert.equal(maskApiKey('sk-123456'), 'sk****56');

  const secret = 'sk-proj-secret-middle-token-9876';
  const masked = maskApiKey(secret);
  assert.equal(masked, 'sk-pro****9876');
  assert.equal(masked?.includes('secret-middle-token'), false);
});

test('Base URL 推导：任意 HTTP/WSS 端点互转，零厂商下拉依赖', () => {
  assert.equal(
    deriveOpenAiHttpBaseUrl('https://gateway.example.com/v1/'),
    'https://gateway.example.com/v1',
  );
  assert.equal(
    deriveOpenAiHttpBaseUrl('wss://gateway.example.com/v1/realtime?model=gpt-realtime'),
    'https://gateway.example.com/v1',
  );
  assert.equal(
    deriveOpenAiHttpBaseUrl('https://gateway.example.com/v1/audio/speech'),
    'https://gateway.example.com/v1',
  );
  assert.equal(
    deriveOpenAiHttpBaseUrl('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
  );

  assert.equal(
    deriveOpenAiRealtimeWsUrl('https://gateway.example.com/v1'),
    'wss://gateway.example.com/v1/realtime',
  );
  assert.equal(
    deriveOpenAiRealtimeWsUrl('http://127.0.0.1:8080/v1/'),
    'ws://127.0.0.1:8080/v1/realtime',
  );
  assert.equal(
    deriveOpenAiRealtimeWsUrl('wss://custom.example.com/v1/realtime'),
    'wss://custom.example.com/v1/realtime',
  );
  assert.equal(
    deriveOpenAiRealtimeWsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  );
});

test('sanitizeVoiceConfigUpdate 与 sanitizeFetchModelsRequest 拦截非法 URL 和 .env 换行注入', () => {
  assert.deepEqual(sanitizeVoiceConfigUpdate({ reset: true }), { ok: true, reset: true });
  assert.equal(sanitizeVoiceConfigUpdate({ mode: 'unknown' }).ok, false);
  assert.equal(
    sanitizeVoiceConfigUpdate({ mode: 'default', defaultMode: { apiKey: 'sk-ok\nEVIL=1' } }).ok,
    false,
  );
  assert.equal(
    sanitizeVoiceConfigUpdate({ mode: 'live', live: { baseUrl: 'file:///etc/passwd' } }).ok,
    false,
  );
  assert.equal(
    sanitizeVoiceConfigUpdate({ mode: 'cascade', cascade: { sttModel: 'bad\rmodel' } }).ok,
    false,
  );

  const good = sanitizeVoiceConfigUpdate({
    mode: 'live',
    live: {
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-live-secret-1234',
      model: 'gpt-realtime',
      asrModel: 'gpt-4o-mini-transcribe',
    },
  });
  assert.equal(good.ok, true);
  if (good.ok && !good.reset) {
    assert.equal(good.value.mode, 'live');
    assert.equal(good.value.live?.baseUrl, 'https://relay.example.com/v1');
    assert.equal(good.value.live?.apiKey, 'sk-live-secret-1234');
  }

  assert.equal(sanitizeFetchModelsRequest({ slot: 'bad' }).ok, false);
  assert.equal(sanitizeFetchModelsRequest({ slot: 'stt', baseUrl: 'ftp://example.com' }).ok, false);
  const okReq = sanitizeFetchModelsRequest({
    slot: 'tts',
    reuseStt: true,
    sttBaseUrl: 'https://relay.example.com/v1',
  });
  assert.equal(okReq.ok, true);
});

test('env-store：保留注释与无关键，原子 upsert / 删除键，拦截控制字符注入', () => {
  const initial = [
    '# 用户注释',
    'UNRELATED_VAR=keep-me',
    'DASHSCOPE_API_KEY=sk-old-1111',
    'VOICE_MODE=cascade',
    '',
  ].join('\n');

  const updated = applyDotEnvUpdates(initial, {
    DASHSCOPE_API_KEY: 'sk-new-9999',
    VOICE_MODE: 'default',
    LIVE_API_KEY: 'sk-live with space',
    REMOVED_NONE: null,
  });
  assert.match(updated, /^# 用户注释/u);
  assert.match(updated, /UNRELATED_VAR=keep-me/u);
  assert.match(updated, /DASHSCOPE_API_KEY=sk-new-9999/u);
  assert.match(updated, /VOICE_MODE=default/u);
  assert.match(updated, /LIVE_API_KEY="sk-live with space"/u);

  const parsed = parseDotEnvText(updated);
  assert.equal(parsed['UNRELATED_VAR'], 'keep-me');
  assert.equal(parsed['DASHSCOPE_API_KEY'], 'sk-new-9999');
  assert.equal(parsed['LIVE_API_KEY'], 'sk-live with space');

  const deleted = applyDotEnvUpdates(updated, { LIVE_API_KEY: null });
  assert.equal(deleted.includes('LIVE_API_KEY'), false);
  assert.throws(() => applyDotEnvUpdates('', { DASHSCOPE_API_KEY: 'bad\nINJECT=1' }));

  const dir = mkdtempSync(join(tmpdir(), 'dsh-env-store-'));
  try {
    const file = join(dir, '.env');
    upsertDotEnvFile(file, { VOICE_MODE: 'default', DASHSCOPE_API_KEY: 'sk-disk-1234' });
    assert.equal(readDotEnvFile(file)['DASHSCOPE_API_KEY'], 'sk-disk-1234');
    assert.match(readFileSync(file, 'utf8'), /DASHSCOPE_API_KEY=sk-disk-1234/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchAvailableModels：拉取 /models、按槽位排序、复用 STT 凭据且错误不回显密钥', async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization') });
    return new Response(JSON.stringify({
      data: [
        { id: 'text-embedding-3-small', owned_by: 'openai' },
        { id: 'gpt-4o-mini-tts', owned_by: 'openai' },
        { id: 'gpt-realtime', owned_by: 'openai' },
        { id: 'whisper-1', owned_by: 'openai' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // Live 槽位：从 wss:// 自动推导 https://.../models，且使用已存 .env key，realtime 模型排第一
  const liveOut = await fetchAvailableModels(
    { slot: 'live', baseUrl: 'wss://gw.example.com/v1/realtime' },
    { LIVE_API_KEY: 'sk-saved-live-key' },
    fakeFetch,
  );
  assert.equal(liveOut.ok, true);
  if (liveOut.ok) {
    assert.equal(liveOut.endpoint, 'https://gw.example.com/v1/models');
    assert.equal(liveOut.models[0]?.id, 'gpt-realtime');
  }
  assert.equal(calls[0]?.auth, 'Bearer sk-saved-live-key');

  // TTS 复用 STT 端点与 Key：tts 模型排第一
  const ttsOut = await fetchAvailableModels(
    { slot: 'tts', reuseStt: true },
    { OPENAI_ASR_BASE_URL: 'https://stt.example.com/v1', OPENAI_ASR_API_KEY: 'sk-stt-shared' },
    fakeFetch,
  );
  assert.equal(ttsOut.ok, true);
  if (ttsOut.ok) {
    assert.equal(ttsOut.endpoint, 'https://stt.example.com/v1/models');
    assert.equal(ttsOut.models[0]?.id, 'gpt-4o-mini-tts');
  }
  assert.equal(calls[1]?.auth, 'Bearer sk-stt-shared');

  // 上游报错体含密钥时必须脱敏，绝不回显给浏览器
  const secretKey = 'sk-super-secret-leak-check-9999';
  const errOut = await fetchAvailableModels(
    { slot: 'stt', baseUrl: 'https://err.example.com/v1', apiKey: secretKey },
    {},
    async () => new Response(`invalid key: ${secretKey}`, { status: 401 }),
  );
  assert.equal(errOut.ok, false);
  if (!errOut.ok) {
    assert.equal(errOut.status, 502);
    assert.equal(errOut.error.includes(secretKey), false);
    assert.match(errOut.error, /HTTP 401/);
  }
});

test('三档模式解析与脱敏快照：默认只靠 DASHSCOPE_API_KEY，Live/级联按 URL 自动选协议', () => {
  assert.match(OPTIMIZED_DEFAULT_TIP, /优化|推荐/u);
  assert.match(OPTIMIZED_DEFAULT_TIP, /DASHSCOPE_API_KEY/u);

  const cfg = { agent: 'dsh', stt: 'aliyun', tts: 'cosyvoice' };

  // 1. 默认模式：只填一个 DASHSCOPE_API_KEY 即启用 Pure Live 优化方案，并屏蔽残留自定义 Live/OpenAI 键
  const defRes = applyVoiceProfile(
    {
      VOICE_MODE: 'default',
      DASHSCOPE_API_KEY: 'sk-dash-only-1234',
      LIVE_URL: 'wss://stale.example.com/v1/realtime',
      LIVE_API_KEY: 'sk-stale-live',
    },
    cfg,
  );
  assert.equal(defRes.mode, 'default');
  assert.equal(defRes.env['VOICE_PIPELINE'], 'live');
  assert.equal(defRes.liveDialect, 'dashscope');
  assert.equal(defRes.effectiveStt, 'qwen-realtime');
  assert.equal(defRes.effectiveTts, 'silent');
  assert.equal(defRes.env['LIVE_URL'], undefined);

  // 2. 自定义 Live 模式：填 HTTP Base URL + API Key + Model，自动派生 wss://.../realtime 和 openai-realtime 伴随 STT
  const liveUpdates = buildEnvUpdatesFromConfigRequest({
    mode: 'live',
    live: {
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-live-secret-5678',
      model: 'gpt-realtime-mini',
      asrModel: 'gpt-4o-mini-transcribe',
    },
  });
  assert.equal(liveUpdates['LIVE_URL'], 'wss://relay.example.com/v1/realtime');
  const liveRes = applyVoiceProfile(liveUpdates as Record<string, string | undefined>, cfg);
  assert.equal(liveRes.mode, 'live');
  assert.equal(liveRes.liveDialect, 'openai-ga');
  assert.equal(liveRes.liveModel, 'gpt-realtime-mini');
  assert.equal(liveRes.effectiveStt, 'openai-realtime');
  assert.equal(liveRes.env['OPENAI_ASR_URL'], 'wss://relay.example.com/v1/realtime');
  assert.equal(liveRes.effectiveTts, 'silent');

  // 3. 级联模式：HTTP STT 走 /audio/transcriptions（openai），TTS 复用 STT 凭据
  const cascadeHttpEnv = buildEnvUpdatesFromConfigRequest({
    mode: 'cascade',
    cascade: {
      sttBaseUrl: 'https://api.groq.com/openai/v1',
      sttApiKey: 'gsk-secret-stt-1111',
      sttModel: 'whisper-large-v3',
      ttsReuseStt: true,
      ttsModel: 'playai-tts',
      ttsVoice: 'nova',
    },
  });
  const cascadeHttp = applyVoiceProfile(cascadeHttpEnv as Record<string, string | undefined>, cfg);
  assert.equal(cascadeHttp.mode, 'cascade');
  assert.equal(cascadeHttp.effectiveStt, 'openai');
  assert.equal(cascadeHttp.env['OPENAI_ASR_BASE_URL'], 'https://api.groq.com/openai/v1');
  assert.equal(cascadeHttp.effectiveTts, 'openai');
  assert.equal(cascadeHttp.env['OPENAI_TTS_BASE_URL'], 'https://api.groq.com/openai/v1');
  assert.equal(cascadeHttp.env['OPENAI_TTS_API_KEY'], 'gsk-secret-stt-1111');
  assert.equal(cascadeHttp.env['OPENAI_TTS_VOICE'], 'nova');

  // 4. 级联模式：STT 填 wss:// 自动切到 openai-realtime，TTS 独立端点
  const cascadeWsEnv = buildEnvUpdatesFromConfigRequest({
    mode: 'cascade',
    cascade: {
      sttBaseUrl: 'wss://rt.example.com/v1/realtime',
      sttApiKey: 'sk-rt-stt-2222',
      sttModel: 'gpt-4o-transcribe',
      ttsReuseStt: false,
      ttsBaseUrl: 'https://tts.example.com/v1',
      ttsApiKey: 'sk-tts-only-3333',
      ttsModel: 'gpt-4o-mini-tts',
    },
  });
  const cascadeWs = applyVoiceProfile(cascadeWsEnv as Record<string, string | undefined>, cfg);
  assert.equal(cascadeWs.effectiveStt, 'openai-realtime');
  assert.equal(cascadeWs.env['OPENAI_ASR_URL'], 'wss://rt.example.com/v1/realtime');
  assert.equal(cascadeWs.effectiveTts, 'openai');
  assert.equal(cascadeWs.env['OPENAI_TTS_BASE_URL'], 'https://tts.example.com/v1');
  assert.equal(cascadeWs.env['OPENAI_TTS_API_KEY'], 'sk-tts-only-3333');

  // 5. 状态快照只暴露脱敏密钥，绝不泄露明文；重置只切回 default 不删 DASHSCOPE_API_KEY
  const snap = buildVoiceConfigSnapshot({
    env: {
      VOICE_MODE: 'default',
      DASHSCOPE_API_KEY: 'sk-dash-full-secret-abcd',
      LIVE_API_KEY: 'sk-live-full-secret-efgh',
    },
    activePipeline: 'live',
    activeSummary: '默认优化 · qwen3.8-omni-flash-realtime',
    envFileHint: '~/.dsh/.env',
    reloading: false,
  });
  const snapJson = JSON.stringify(snap);
  assert.equal(snapJson.includes('full-secret'), false);
  assert.equal(snap.defaultMode.hasApiKey, true);
  assert.equal(snap.defaultMode.apiKeyMasked, 'sk-das****abcd');
  assert.equal(snap.live.apiKeyMasked, 'sk-liv****efgh');

  assert.deepEqual(buildResetToDefaultEnvUpdates(), {
    VOICE_MODE: 'default',
    VOICE_PIPELINE: 'live',
  });
});
