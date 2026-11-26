/**
 * 将 `.env` + 插件配置解析成：
 * 1. 前端安全快照 {@link HostVoiceConfigSnapshot}（密钥全部脱敏）
 * 2. 前端保存请求 → `.env` 增量更新映射 {@link buildEnvUpdatesFromConfigRequest}
 * 3. 启动期隔离环境与实际生效 STT / TTS / Live 选型 {@link applyVoiceProfile}
 *
 * 绝不直接修改传入的 `baseEnv` 或全局 `process.env`。
 */
import {
  isDshBackedAgent,
  shouldUsePureLiveAudio,
  type VoiceWebConfig,
} from './driver-policy.ts';
import {
  DEFAULT_CASCADE_STT_MODEL,
  DEFAULT_CASCADE_TTS_MODEL,
  DEFAULT_CASCADE_TTS_VOICE,
  DEFAULT_LIVE_ASR_MODEL,
  DEFAULT_LIVE_MODEL,
  deriveOpenAiHttpBaseUrl,
  deriveOpenAiRealtimeWsUrl,
  isWsEndpointUrl,
  maskApiKey,
  type HostVoiceConfigSnapshot,
  type VoiceConfigUpdateRequest,
  type VoiceMode,
} from './voice-overrides.ts';
import {
  realtimeLiveDefaults,
  resolveRealtimeDialect,
  type RealtimeDialect,
} from './voice/realtime-dialect.ts';
import { resolveLiveApiKey } from './voice/voice-config.ts';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface ResolvedVoiceSelection {
  readonly mode: VoiceMode;
  readonly env: Record<string, string | undefined>;
  readonly ttsEnv: Record<string, string | undefined>;
  readonly usePureLiveAudio: boolean;
  readonly effectiveStt: string;
  readonly effectiveTts: string;
  readonly liveDialect: RealtimeDialect;
  readonly liveModel: string;
  readonly summary: string;
}

/** 判别当前生效的三档模式：`default`（优化方案）/ `live` / `cascade`。 */
export function resolveVoiceModeFromEnv(env: EnvRecord): VoiceMode {
  const explicitMode = (env['VOICE_MODE'] ?? '').trim().toLowerCase();
  if (explicitMode === 'default' || explicitMode === 'live' || explicitMode === 'cascade') {
    return explicitMode;
  }
  const explicitPipeline = (env['VOICE_PIPELINE'] ?? '').trim().toLowerCase();
  if (explicitPipeline === 'cascade') return 'cascade';

  const hasCustomLive = (env['LIVE_BASE_URL'] ?? env['LIVE_URL'] ?? '').trim() !== ''
    || (env['LIVE_API_KEY'] ?? '').trim() !== ''
    || ((env['LIVE_DIALECT'] ?? env['OMNI_DIALECT'] ?? '').trim().toLowerCase().startsWith('openai'));
  if (hasCustomLive) return 'live';

  const hasDashKey = (env['DASHSCOPE_API_KEY'] ?? '').trim() !== '';
  const hasOpenAiKey = (env['OPENAI_API_KEY'] ?? env['OPENAI_ASR_API_KEY'] ?? env['OPENAI_TTS_API_KEY'] ?? '').trim() !== '';
  if (!hasDashKey && hasOpenAiKey) {
    return explicitPipeline === 'live' ? 'live' : 'cascade';
  }
  return 'default';
}

/** 构造发往前端的配置快照（所有 API Key 均为脱敏展示，绝不回传明文）。 */
export function buildVoiceConfigSnapshot(input: {
  readonly env: EnvRecord;
  readonly activePipeline: string;
  readonly activeSummary: string;
  readonly envFileHint: string;
  readonly reloading: boolean;
}): HostVoiceConfigSnapshot {
  const { env } = input;
  const mode = resolveVoiceModeFromEnv(env);
  const dashKey = (env['DASHSCOPE_API_KEY'] ?? '').trim();
  const liveKey = (env['LIVE_API_KEY'] ?? env['OMNI_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();
  const liveBaseUrl = (env['LIVE_BASE_URL'] ?? env['LIVE_URL'] ?? env['OMNI_URL'] ?? '').trim();
  const liveModel = (env['LIVE_MODEL'] ?? env['OMNI_SHADOW_MODEL'] ?? '').trim();
  const liveAsrModel = (env['LIVE_ASR_MODEL'] ?? '').trim();

  const sttBaseUrl = (env['OPENAI_ASR_BASE_URL'] ?? env['OPENAI_ASR_URL'] ?? env['OPENAI_BASE_URL'] ?? '').trim();
  const sttKey = (env['OPENAI_ASR_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();
  const sttModel = (env['OPENAI_ASR_MODEL'] ?? '').trim();

  const ttsReuseStt = env['OPENAI_TTS_REUSE_STT'] === '1';
  const ttsBaseUrl = (env['OPENAI_TTS_BASE_URL'] ?? env['OPENAI_BASE_URL'] ?? '').trim();
  const ttsKey = (env['OPENAI_TTS_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();
  const ttsModel = (env['OPENAI_TTS_MODEL'] ?? '').trim();
  const ttsVoice = (env['OPENAI_TTS_VOICE'] ?? '').trim();

  return {
    mode,
    defaultMode: {
      apiKeyMasked: maskApiKey(dashKey),
      hasApiKey: dashKey !== '',
    },
    live: {
      baseUrl: liveBaseUrl,
      apiKeyMasked: maskApiKey(liveKey),
      hasApiKey: liveKey !== '',
      model: liveModel,
      asrModel: liveAsrModel,
    },
    cascade: {
      sttBaseUrl,
      sttApiKeyMasked: maskApiKey(sttKey),
      hasSttApiKey: sttKey !== '',
      sttModel,
      ttsReuseStt,
      ttsBaseUrl,
      ttsApiKeyMasked: maskApiKey(ttsKey),
      hasTtsApiKey: ttsKey !== '',
      ttsModel,
      ttsVoice,
    },
    active: {
      mode,
      pipeline: input.activePipeline,
      detail: input.activeSummary,
    },
    envFileHint: input.envFileHint,
    reloading: input.reloading,
  };
}

/** 把前端提交的配置更新转成 `~/.dsh/.env` 键值变更表（`null` 表示删除该键，`undefined` 表示不动）。 */
export function buildEnvUpdatesFromConfigRequest(
  req: VoiceConfigUpdateRequest,
): Record<string, string | null> {
  const updates: Record<string, string | null> = {
    VOICE_MODE: req.mode,
    VOICE_PIPELINE: req.mode === 'cascade' ? 'cascade' : 'live',
  };

  if (req.defaultMode !== undefined) {
    if (req.defaultMode.clearApiKey === true) {
      updates['DASHSCOPE_API_KEY'] = null;
    } else if (req.defaultMode.apiKey !== undefined) {
      updates['DASHSCOPE_API_KEY'] = req.defaultMode.apiKey;
    }
  }

  if (req.live !== undefined) {
    if (req.live.baseUrl !== undefined) {
      updates['LIVE_BASE_URL'] = req.live.baseUrl === '' ? null : req.live.baseUrl;
      if (req.live.baseUrl === '') {
        updates['LIVE_URL'] = null;
        updates['LIVE_DIALECT'] = 'openai-ga';
      } else {
        const wsUrl = deriveOpenAiRealtimeWsUrl(req.live.baseUrl);
        updates['LIVE_URL'] = wsUrl;
        updates['LIVE_DIALECT'] = wsUrl.toLowerCase().includes('dashscope') ? 'dashscope' : 'openai-ga';
      }
    }
    if (req.live.clearApiKey === true) {
      updates['LIVE_API_KEY'] = null;
    } else if (req.live.apiKey !== undefined) {
      updates['LIVE_API_KEY'] = req.live.apiKey;
    }
    if (req.live.model !== undefined) {
      updates['LIVE_MODEL'] = req.live.model === '' ? null : req.live.model;
    }
    if (req.live.asrModel !== undefined) {
      updates['LIVE_ASR_MODEL'] = req.live.asrModel === '' ? null : req.live.asrModel;
    }
  }

  if (req.cascade !== undefined) {
    if (req.cascade.sttBaseUrl !== undefined) {
      const url = req.cascade.sttBaseUrl;
      if (url === '') {
        updates['OPENAI_ASR_BASE_URL'] = null;
        updates['OPENAI_ASR_URL'] = null;
      } else if (isWsEndpointUrl(url)) {
        updates['OPENAI_ASR_BASE_URL'] = url;
        updates['OPENAI_ASR_URL'] = deriveOpenAiRealtimeWsUrl(url);
      } else {
        updates['OPENAI_ASR_BASE_URL'] = url;
        updates['OPENAI_ASR_URL'] = null;
      }
    }
    if (req.cascade.clearSttApiKey === true) {
      updates['OPENAI_ASR_API_KEY'] = null;
    } else if (req.cascade.sttApiKey !== undefined) {
      updates['OPENAI_ASR_API_KEY'] = req.cascade.sttApiKey;
    }
    if (req.cascade.sttModel !== undefined) {
      updates['OPENAI_ASR_MODEL'] = req.cascade.sttModel === '' ? null : req.cascade.sttModel;
    }
    if (req.cascade.ttsReuseStt !== undefined) {
      updates['OPENAI_TTS_REUSE_STT'] = req.cascade.ttsReuseStt ? '1' : '0';
    }
    if (req.cascade.ttsBaseUrl !== undefined) {
      updates['OPENAI_TTS_BASE_URL'] = req.cascade.ttsBaseUrl === '' ? null : req.cascade.ttsBaseUrl;
    }
    if (req.cascade.clearTtsApiKey === true) {
      updates['OPENAI_TTS_API_KEY'] = null;
    } else if (req.cascade.ttsApiKey !== undefined) {
      updates['OPENAI_TTS_API_KEY'] = req.cascade.ttsApiKey;
    }
    if (req.cascade.ttsModel !== undefined) {
      updates['OPENAI_TTS_MODEL'] = req.cascade.ttsModel === '' ? null : req.cascade.ttsModel;
    }
    if (req.cascade.ttsVoice !== undefined) {
      updates['OPENAI_TTS_VOICE'] = req.cascade.ttsVoice === '' ? null : req.cascade.ttsVoice;
    }
  }

  return updates;
}

/** 恢复默认优化方案时的 `.env` 变更（保留已填的 DASHSCOPE_API_KEY 与自定义存档）。 */
export function buildResetToDefaultEnvUpdates(): Record<string, string | null> {
  return {
    VOICE_MODE: 'default',
    VOICE_PIPELINE: 'live',
  };
}

/**
 * 按当前模式生成隔离的运行时 `env` 与 STT/TTS/Live 选型。
 *
 * - `default`：纯净的 DashScope Pure Live 调优方案（只依赖 `DASHSCOPE_API_KEY`）
 * - `live`：任意 OpenAI Realtime 兼容端点（HTTP Base URL 自动派生 `wss://.../realtime`）
 * - `cascade`：独立 STT（HTTP 走 `/audio/transcriptions`，`wss://` 走 Realtime WS）+ OpenAI 兼容 TTS
 */
export function applyVoiceProfile(
  baseEnv: EnvRecord,
  config: Pick<VoiceWebConfig, 'agent' | 'stt' | 'tts'>,
): ResolvedVoiceSelection {
  const env: Record<string, string | undefined> = { ...baseEnv };
  const mode = resolveVoiceModeFromEnv(baseEnv);
  const dshBacked = isDshBackedAgent(config.agent);
  const turnDetection = env['ASR_TURN_DETECTION'] ?? env['QWEN_ASR_TURN_DETECTION'];

  if (mode === 'default') {
    // 纯净默认优化方案：屏蔽自定义 OpenAI/Live 覆盖，仅依赖 DASHSCOPE_API_KEY
    for (const key of [
      'LIVE_BASE_URL',
      'LIVE_URL',
      'LIVE_API_KEY',
      'LIVE_MODEL',
      'LIVE_ASR_MODEL',
      'LIVE_DIALECT',
      'OMNI_URL',
      'OMNI_API_KEY',
      'OMNI_SHADOW_MODEL',
      'OMNI_DIALECT',
      'QWEN_ASR_URL',
    ]) {
      delete env[key];
    }
    env['VOICE_PIPELINE'] = 'live';
    env['LIVE_DIALECT'] = 'dashscope';

    const hasDashKey = resolveLiveApiKey(env) !== '';
    const usePureLiveAudio = shouldUsePureLiveAudio({
      dshBacked,
      wantsLive: true,
      hasOmniKey: hasDashKey,
      turnDetection,
    });
    const effectiveStt = dshBacked ? 'qwen-realtime' : config.stt;
    const effectiveTts = usePureLiveAudio ? 'silent' : (dshBacked ? 'cosyvoice' : config.tts);
    const liveModel = realtimeLiveDefaults('dashscope').model;
    return {
      mode,
      env,
      ttsEnv: env,
      usePureLiveAudio,
      effectiveStt,
      effectiveTts,
      liveDialect: 'dashscope',
      liveModel,
      summary: `默认优化 · ${liveModel}`,
    };
  }

  if (mode === 'live') {
    const rawBase = (baseEnv['LIVE_BASE_URL'] ?? baseEnv['LIVE_URL'] ?? baseEnv['OMNI_URL'] ?? '').trim();
    const apiKey = (baseEnv['LIVE_API_KEY'] ?? baseEnv['OMNI_API_KEY'] ?? baseEnv['OPENAI_API_KEY'] ?? '').trim();
    const wsUrl = rawBase === '' ? '' : deriveOpenAiRealtimeWsUrl(rawBase);
    const isDash = (wsUrl || rawBase).toLowerCase().includes('dashscope');
    const liveDialect: RealtimeDialect = isDash
      ? 'dashscope'
      : resolveRealtimeDialect(baseEnv['LIVE_DIALECT'] ?? 'openai-ga', wsUrl || undefined);
    const liveModel = (baseEnv['LIVE_MODEL'] ?? baseEnv['OMNI_SHADOW_MODEL'] ?? '').trim()
      || (isDash ? realtimeLiveDefaults('dashscope').model : DEFAULT_LIVE_MODEL);
    const liveAsrModel = (baseEnv['LIVE_ASR_MODEL'] ?? '').trim()
      || (isDash ? realtimeLiveDefaults('dashscope').asrModel : DEFAULT_LIVE_ASR_MODEL);

    env['VOICE_PIPELINE'] = 'live';
    env['LIVE_DIALECT'] = liveDialect;
    if (wsUrl !== '') {
      env['LIVE_URL'] = wsUrl;
    } else {
      delete env['LIVE_URL'];
      delete env['OMNI_URL'];
    }
    env['LIVE_API_KEY'] = apiKey;
    env['LIVE_MODEL'] = liveModel;
    env['LIVE_ASR_MODEL'] = liveAsrModel;

    const usePureLiveAudio = shouldUsePureLiveAudio({
      dshBacked,
      wantsLive: true,
      hasOmniKey: apiKey !== '',
      turnDetection,
    });

    let effectiveStt: string;
    if (isDash) {
      effectiveStt = 'qwen-realtime';
      env['DASHSCOPE_API_KEY'] = apiKey;
      if (wsUrl !== '') env['QWEN_ASR_URL'] = wsUrl;
      env['QWEN_ASR_MODEL'] = liveAsrModel;
    } else {
      effectiveStt = 'openai-realtime';
      env['OPENAI_ASR_API_KEY'] = apiKey;
      env['OPENAI_ASR_DIALECT'] = liveDialect;
      if (wsUrl !== '') {
        env['OPENAI_ASR_URL'] = wsUrl;
      } else {
        delete env['OPENAI_ASR_URL'];
      }
      env['OPENAI_ASR_MODEL'] = liveAsrModel;
    }

    const effectiveTts = usePureLiveAudio ? 'silent' : config.tts;
    return {
      mode,
      env,
      ttsEnv: env,
      usePureLiveAudio,
      effectiveStt,
      effectiveTts,
      liveDialect,
      liveModel,
      summary: `Live · ${liveModel}`,
    };
  }

  // mode === 'cascade'
  env['VOICE_PIPELINE'] = 'cascade';
  const explicitVoiceMode = (baseEnv['VOICE_MODE'] ?? '').trim().toLowerCase() === 'cascade';
  const sttRawUrl = (baseEnv['OPENAI_ASR_BASE_URL'] ?? baseEnv['OPENAI_ASR_URL'] ?? baseEnv['OPENAI_BASE_URL'] ?? '').trim();
  const sttKey = (baseEnv['OPENAI_ASR_API_KEY'] ?? baseEnv['OPENAI_API_KEY'] ?? '').trim();
  const sttModel = (baseEnv['OPENAI_ASR_MODEL'] ?? '').trim();
  const ttsReuseStt = baseEnv['OPENAI_TTS_REUSE_STT'] === '1';
  const ttsRawUrl = ttsReuseStt
    ? sttRawUrl
    : (baseEnv['OPENAI_TTS_BASE_URL'] ?? baseEnv['OPENAI_BASE_URL'] ?? '').trim();
  const ttsKey = ttsReuseStt
    ? sttKey
    : (baseEnv['OPENAI_TTS_API_KEY'] ?? baseEnv['OPENAI_API_KEY'] ?? '').trim();
  const ttsModel = (baseEnv['OPENAI_TTS_MODEL'] ?? '').trim();
  const ttsVoice = (baseEnv['OPENAI_TTS_VOICE'] ?? '').trim();

  // 兼容旧配置：未设 VOICE_MODE 且完全没有 OpenAI 级联配置时，保留插件静态 stt/tts
  const hasAnyOpenAiCascade = explicitVoiceMode
    || sttRawUrl !== ''
    || sttKey !== ''
    || ttsRawUrl !== ''
    || ttsKey !== '';

  if (!hasAnyOpenAiCascade) {
    return {
      mode,
      env,
      ttsEnv: env,
      usePureLiveAudio: false,
      effectiveStt: config.stt,
      effectiveTts: config.tts,
      liveDialect: 'dashscope',
      liveModel: realtimeLiveDefaults('dashscope').model,
      summary: `级联 · ${config.stt} + ${config.tts}`,
    };
  }

  let effectiveStt: string;
  if (sttRawUrl !== '' && isWsEndpointUrl(sttRawUrl)) {
    const wsUrl = deriveOpenAiRealtimeWsUrl(sttRawUrl);
    if (wsUrl.toLowerCase().includes('dashscope')) {
      effectiveStt = 'qwen-realtime';
      env['DASHSCOPE_API_KEY'] = sttKey;
      env['QWEN_ASR_URL'] = wsUrl;
      if (sttModel !== '') env['QWEN_ASR_MODEL'] = sttModel;
    } else {
      effectiveStt = 'openai-realtime';
      env['OPENAI_ASR_API_KEY'] = sttKey;
      env['OPENAI_ASR_URL'] = wsUrl;
      env['OPENAI_ASR_DIALECT'] = 'openai-ga';
      env['OPENAI_ASR_MODEL'] = sttModel || DEFAULT_CASCADE_STT_MODEL;
    }
  } else {
    effectiveStt = 'openai';
    env['OPENAI_ASR_API_KEY'] = sttKey;
    if (sttRawUrl !== '') {
      env['OPENAI_ASR_BASE_URL'] = deriveOpenAiHttpBaseUrl(sttRawUrl);
    } else {
      delete env['OPENAI_ASR_BASE_URL'];
    }
    env['OPENAI_ASR_MODEL'] = sttModel || DEFAULT_CASCADE_STT_MODEL;
  }

  const effectiveTts = 'openai';
  env['OPENAI_TTS_API_KEY'] = ttsKey;
  if (ttsRawUrl !== '') {
    env['OPENAI_TTS_BASE_URL'] = deriveOpenAiHttpBaseUrl(ttsRawUrl);
  } else {
    delete env['OPENAI_TTS_BASE_URL'];
  }
  env['OPENAI_TTS_MODEL'] = ttsModel || DEFAULT_CASCADE_TTS_MODEL;
  env['OPENAI_TTS_VOICE'] = ttsVoice || DEFAULT_CASCADE_TTS_VOICE;

  const shownStt = sttModel || DEFAULT_CASCADE_STT_MODEL;
  const shownTts = ttsModel || DEFAULT_CASCADE_TTS_MODEL;
  return {
    mode,
    env,
    ttsEnv: env,
    usePureLiveAudio: false,
    effectiveStt,
    effectiveTts,
    liveDialect: 'openai-ga',
    liveModel: DEFAULT_LIVE_MODEL,
    summary: `级联 · ${shownStt} + ${shownTts}`,
  };
}
