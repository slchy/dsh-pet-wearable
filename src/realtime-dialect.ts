/**
 * Realtime WebSocket 协议方言的纯定义与辅助函数（零依赖、零 IO）。
 *
 * 三套方言共享同一套状态机（ASR / Live 车道 / Omni 朗读机），只在协议边界适配：
 * - `dashscope`（默认）：阿里云 DashScope Realtime（16 kHz 上行、24 kHz 下行、`corpus.text`、`modalities`）
 * - `openai-beta`：OpenAI Realtime Beta（24 kHz 上行/下行、`OpenAI-Beta: realtime=v1`、`pcm16`、`prompt`）
 * - `openai-ga`：OpenAI Realtime GA（24 kHz 上行/下行、`type: 'realtime'|'transcription'`、`audio/pcm`、`output_modalities`）
 */

export type RealtimeDialect = 'dashscope' | 'openai-beta' | 'openai-ga';

export interface RealtimeLiveDefaults {
  readonly url: string;
  readonly model: string;
  readonly asrModel: string;
  readonly inputRate: number;
  readonly outputRate: number;
  readonly extraHeaders: Readonly<Record<string, string>>;
}

export interface RealtimeAsrDefaults {
  readonly url: string;
  readonly model: string;
  readonly inputRate: number;
  readonly extraHeaders: Readonly<Record<string, string>>;
}

const LIVE_DEFAULTS: Readonly<Record<RealtimeDialect, RealtimeLiveDefaults>> = {
  dashscope: {
    url: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    asrModel: 'qwen3-asr-flash-realtime',
    inputRate: 16_000,
    outputRate: 24_000,
    extraHeaders: {},
  },
  'openai-beta': {
    url: 'wss://api.openai.com/v1/realtime',
    model: 'gpt-4o-realtime-preview',
    asrModel: 'gpt-4o-mini-transcribe',
    inputRate: 24_000,
    outputRate: 24_000,
    extraHeaders: { 'OpenAI-Beta': 'realtime=v1' },
  },
  'openai-ga': {
    url: 'wss://api.openai.com/v1/realtime',
    model: 'gpt-realtime',
    asrModel: 'gpt-4o-mini-transcribe',
    inputRate: 24_000,
    outputRate: 24_000,
    extraHeaders: {},
  },
};

const ASR_DEFAULTS: Readonly<Record<RealtimeDialect, RealtimeAsrDefaults>> = {
  dashscope: {
    url: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3-asr-flash-realtime',
    inputRate: 16_000,
    extraHeaders: {},
  },
  'openai-beta': {
    url: 'wss://api.openai.com/v1/realtime',
    model: 'gpt-4o-mini-transcribe',
    inputRate: 24_000,
    extraHeaders: { 'OpenAI-Beta': 'realtime=v1' },
  },
  'openai-ga': {
    url: 'wss://api.openai.com/v1/realtime',
    model: 'gpt-4o-mini-transcribe',
    inputRate: 24_000,
    extraHeaders: {},
  },
};

/**
 * 解析 Realtime 协议方言。
 *
 * - 显式值支持 `dashscope` / `qwen`、`openai-beta` / `openai-v1` / `beta`、`openai-ga` / `openai` / `ga`
 * - 非法显式值直接抛错（避免打错字静默回退到错误协议）
 * - 未显式指定时按 URL 自动嗅探（含 `openai.com` → `openai-ga`），默认 `dashscope` 保持零破坏兼容
 */
export function resolveRealtimeDialect(raw?: string, url?: string): RealtimeDialect {
  const clean = raw?.trim().toLowerCase() ?? '';
  if (clean !== '') {
    if (clean === 'dashscope' || clean === 'qwen') return 'dashscope';
    if (clean === 'openai-beta' || clean === 'openai-v1' || clean === 'beta') return 'openai-beta';
    if (clean === 'openai-ga' || clean === 'openai' || clean === 'ga') return 'openai-ga';
    throw new Error(
      `不支持的 Realtime 协议方言 "${raw}"（支持 dashscope | openai-beta | openai-ga）`,
    );
  }
  const cleanUrl = url?.trim().toLowerCase() ?? '';
  if (cleanUrl !== '') {
    if (cleanUrl.includes('dashscope')) return 'dashscope';
    if (cleanUrl.includes('openai.com')) return 'openai-ga';
  }
  return 'dashscope';
}

export function isOpenAiDialect(dialect: RealtimeDialect): boolean {
  return dialect === 'openai-beta' || dialect === 'openai-ga';
}

export function realtimeLiveDefaults(dialect: RealtimeDialect): RealtimeLiveDefaults {
  return LIVE_DEFAULTS[dialect];
}

export function realtimeAsrDefaults(dialect: RealtimeDialect): RealtimeAsrDefaults {
  return ASR_DEFAULTS[dialect];
}

/**
 * 给 WebSocket 基础地址补齐查询参数。
 *
 * 如果 `baseUrl` 已经带了同名参数（例如自定义代理或 Azure 风格 `?deployment=...&api-version=...`），
 * 保留原参数不重复追加，也不拼出双 `?` 的非法 URL。
 */
export function buildRealtimeWsUrl(
  baseUrl: string,
  query: Readonly<Record<string, string>>,
): string {
  const qIndex = baseUrl.indexOf('?');
  const existing = new Set<string>();
  if (qIndex >= 0) {
    const rawQuery = baseUrl.slice(qIndex + 1);
    for (const pair of rawQuery.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = eq >= 0 ? pair.slice(0, eq) : pair;
      if (key !== '') existing.add(key);
    }
  }
  const additions: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === '' || existing.has(key)) continue;
    additions.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (additions.length === 0) return baseUrl;
  const sep = qIndex >= 0 ? (baseUrl.endsWith('?') || baseUrl.endsWith('&') ? '' : '&') : '?';
  return `${baseUrl}${sep}${additions.join('&')}`;
}

/** 组装 WebSocket 握手请求头（Authorization + 方言必需头 + 调用方透传头）。 */
export function buildRealtimeHeaders(
  apiKey: string,
  dialect: RealtimeDialect,
  extraHeaders?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...LIVE_DEFAULTS[dialect].extraHeaders,
    ...extraHeaders,
  };
}

/**
 * 组装 `response.create` 负载。
 *
 * - `withModalities === false`：通用极简 `{ type: 'response.create' }`（跟 `session.update` 保持一致）
 * - `withModalities === true`：
 *   - DashScope / OpenAI Beta：`response: { modalities: ['audio', 'text'] }`
 *   - OpenAI GA：`response: { output_modalities: ['audio'] }`（GA 不接受 `['audio', 'text']` 双值，
 *     单选 `['audio']` 即同时输出音频与音频字幕）
 */
export function buildRealtimeResponseCreate(
  dialect: RealtimeDialect,
  withModalities = false,
): Record<string, unknown> {
  if (!withModalities) {
    return { type: 'response.create' };
  }
  if (dialect === 'openai-ga') {
    return {
      type: 'response.create',
      response: { output_modalities: ['audio'] },
    };
  }
  return {
    type: 'response.create',
    response: { modalities: ['audio', 'text'] },
  };
}
