/**
 * 桌宠前端与宿主共享的语音引擎配置契约（纯函数、零 Node/DOM 依赖）。
 *
 * 三档模式：
 * - `default`：当前深度调优的推荐优化方案（DashScope Pure Live 低延迟链路），只需填一个 `DASHSCOPE_API_KEY`
 * - `live`：自定义 OpenAI Realtime 兼容端点（填 Base URL + API Key，拉取可用模型列表选择）
 * - `cascade`：自定义级联端点（独立 STT + TTS 的 Base URL + API Key，支持一键复用 STT 端点与 Key）
 *
 * 任何发往浏览器的状态快照都只携带脱敏后的 API Key 预览，绝不回传明文密钥。
 */

export const VOICE_MODES = ['default', 'live', 'cascade'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export const MODEL_FETCH_SLOTS = ['live', 'stt', 'tts'] as const;
export type ModelFetchSlot = (typeof MODEL_FETCH_SLOTS)[number];

export const VOICE_MODE_LABELS: Readonly<Record<VoiceMode, string>> = {
  default: '默认',
  live: 'Live',
  cascade: '级联',
};

/** 明确告知用户：默认模式即当前调优推荐方案，只需填写 DASHSCOPE_API_KEY。 */
export const OPTIMIZED_DEFAULT_TIP =
  '默认模式为当前深度调优的推荐优化方案（Pure Live 低延迟链路），只需填写 DASHSCOPE_API_KEY 即可开箱即用。';

export const CUSTOM_MODE_TIP =
  '自定义 OpenAI 兼容端点模式（配置写入 ~/.dsh/.env，随时可切回「默认」恢复调优优化方案）。';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_LIVE_MODEL = 'gpt-realtime';
export const DEFAULT_LIVE_ASR_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_CASCADE_STT_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_CASCADE_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_CASCADE_TTS_VOICE = 'alloy';

export interface VoiceDefaultModeView {
  readonly apiKeyMasked: string | null;
  readonly hasApiKey: boolean;
}

export interface VoiceLiveModeView {
  readonly baseUrl: string;
  readonly apiKeyMasked: string | null;
  readonly hasApiKey: boolean;
  readonly model: string;
  readonly asrModel: string;
}

export interface VoiceCascadeModeView {
  readonly sttBaseUrl: string;
  readonly sttApiKeyMasked: string | null;
  readonly hasSttApiKey: boolean;
  readonly sttModel: string;
  readonly ttsReuseStt: boolean;
  readonly ttsBaseUrl: string;
  readonly ttsApiKeyMasked: string | null;
  readonly hasTtsApiKey: boolean;
  readonly ttsModel: string;
  readonly ttsVoice: string;
}

export interface VoiceActiveSummary {
  readonly mode: VoiceMode;
  readonly pipeline: string;
  readonly detail: string;
}

/** 宿主通过 `GET /dsh-voice/state` 返回的配置快照（密钥全部脱敏）。 */
export interface HostVoiceConfigSnapshot {
  readonly mode: VoiceMode;
  readonly defaultMode: VoiceDefaultModeView;
  readonly live: VoiceLiveModeView;
  readonly cascade: VoiceCascadeModeView;
  readonly active: VoiceActiveSummary;
  readonly envFileHint: string;
  readonly reloading: boolean;
}

/** 前端 `POST /dsh-voice/config` 提交的配置更新请求。 */
export interface VoiceConfigUpdateRequest {
  readonly mode: VoiceMode;
  readonly defaultMode?: {
    readonly apiKey?: string;
    readonly clearApiKey?: boolean;
  };
  readonly live?: {
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly clearApiKey?: boolean;
    readonly model?: string;
    readonly asrModel?: string;
  };
  readonly cascade?: {
    readonly sttBaseUrl?: string;
    readonly sttApiKey?: string;
    readonly clearSttApiKey?: boolean;
    readonly sttModel?: string;
    readonly ttsReuseStt?: boolean;
    readonly ttsBaseUrl?: string;
    readonly ttsApiKey?: string;
    readonly clearTtsApiKey?: boolean;
    readonly ttsModel?: string;
    readonly ttsVoice?: string;
  };
}

export type SanitizeConfigUpdateResult =
  | { readonly ok: true; readonly reset: true }
  | { readonly ok: true; readonly reset: false; readonly value: VoiceConfigUpdateRequest }
  | { readonly ok: false; readonly error: string };

/** 前端 `POST /dsh-voice/models` 拉取可用模型表的请求。 */
export interface FetchModelsRequest {
  readonly slot: ModelFetchSlot;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly reuseStt?: boolean;
  readonly sttBaseUrl?: string;
  readonly sttApiKey?: string;
}

export interface AvailableModelItem {
  readonly id: string;
  readonly ownedBy?: string;
}

export type SanitizeFetchModelsResult =
  | { readonly ok: true; readonly value: FetchModelsRequest }
  | { readonly ok: false; readonly error: string };

const MAX_URL_LENGTH = 512;
const MAX_KEY_LENGTH = 512;
const MAX_NAME_LENGTH = 128;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 脱敏展示 API Key（绝不在前端回显完整明文）。
 *
 * 例：`sk-proj-1234567890abcd` → `sk-pro****abcd`；空串返回 `null`。
 */
export function maskApiKey(raw: string | undefined | null): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return null;
  if (trimmed.length <= 4) return '****';
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
  }
  const prefixLen = trimmed.startsWith('sk-') ? Math.min(6, trimmed.length - 6) : Math.min(4, trimmed.length - 6);
  return `${trimmed.slice(0, prefixLen)}****${trimmed.slice(-4)}`;
}

/** 判断端点 URL 是否为 WebSocket 协议（`ws://` 或 `wss://`）。 */
export function isWsEndpointUrl(raw: string): boolean {
  return /^wss?:\/\//iu.test(raw.trim());
}

/** 校验用户填写的 Base URL（允许留空走默认；非空时只接受合法 `http/https/ws/wss` URL）。 */
export function validateEndpointUrl(raw: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: '' };
  if (trimmed.length > MAX_URL_LENGTH || CONTROL_CHAR_RE.test(trimmed) || /\s/u.test(trimmed)) {
    return { ok: false, error: 'Base URL 格式不合法（包含空白或控制字符，或长度超限）' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `Base URL 无法解析：${trimmed}` };
  }
  if (
    parsed.protocol !== 'http:'
    && parsed.protocol !== 'https:'
    && parsed.protocol !== 'ws:'
    && parsed.protocol !== 'wss:'
  ) {
    return { ok: false, error: `Base URL 仅支持 http/https/ws/wss 协议（收到 ${parsed.protocol}）` };
  }
  if (parsed.hostname === '') {
    return { ok: false, error: 'Base URL 缺少主机名' };
  }
  return { ok: true, value: trimmed };
}

/**
 * 从任意用户填写的 Base URL（HTTP 或 WS）推导出 OpenAI 兼容 HTTP 基础地址，
 * 供 `GET /models`、`POST /audio/transcriptions`、`POST /audio/speech` 使用。
 */
export function deriveOpenAiHttpBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return DEFAULT_OPENAI_BASE_URL;
  const parsed = new URL(trimmed);
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  parsed.search = '';
  parsed.hash = '';

  const lowerHost = parsed.hostname.toLowerCase();
  let path = parsed.pathname.replace(/\/+$/u, '');
  if (lowerHost.includes('dashscope') && path === '/api-ws/v1/realtime') {
    path = '/compatible-mode/v1';
  } else {
    path = path
      .replace(/\/audio\/transcriptions$/iu, '')
      .replace(/\/audio\/speech$/iu, '')
      .replace(/\/models$/iu, '')
      .replace(/\/realtime$/iu, '')
      .replace(/\/+$/u, '');
  }
  parsed.pathname = path;
  return parsed.toString().replace(/\/+$/u, '');
}

/**
 * 从任意用户填写的 Base URL（HTTP 或 WS）推导出 Realtime WebSocket 地址。
 * 例如：`https://api.openai.com/v1` → `wss://api.openai.com/v1/realtime`。
 */
export function deriveOpenAiRealtimeWsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return 'wss://api.openai.com/v1/realtime';
  const parsed = new URL(trimmed);
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  parsed.hash = '';

  const lowerHost = parsed.hostname.toLowerCase();
  let path = parsed.pathname.replace(/\/+$/u, '');
  if (lowerHost.includes('dashscope') && (path === '' || path === '/compatible-mode/v1')) {
    path = '/api-ws/v1/realtime';
  } else {
    path = path
      .replace(/\/audio\/transcriptions$/iu, '')
      .replace(/\/audio\/speech$/iu, '')
      .replace(/\/models$/iu, '')
      .replace(/\/+$/u, '');
    if (!/\/realtime$/iu.test(path)) {
      path = `${path}/realtime`;
    }
  }
  parsed.pathname = path;
  return parsed.toString();
}

function sanitizeOptionalName(
  raw: unknown,
  label: string,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} 必须是字符串` };
  const trimmed = raw.trim();
  if (trimmed.length > MAX_NAME_LENGTH || CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: `${label} 长度超限或包含非法控制字符` };
  }
  return { ok: true, value: trimmed };
}

function sanitizeOptionalKey(
  raw: unknown,
  label: string,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} 必须是字符串` };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  if (trimmed.length > MAX_KEY_LENGTH || CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: `${label} 长度超限或包含非法换行/控制字符` };
  }
  return { ok: true, value: trimmed };
}

function sanitizeOptionalUrl(
  raw: unknown,
  label: string,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} 必须是字符串` };
  const checked = validateEndpointUrl(raw);
  if (!checked.ok) return { ok: false, error: `${label}：${checked.error}` };
  return { ok: true, value: checked.value };
}

function sanitizeOptionalBool(
  raw: unknown,
  label: string,
): { readonly ok: true; readonly value: boolean | undefined } | { readonly ok: false; readonly error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: `${label} 必须是布尔值` };
  return { ok: true, value: raw };
}

/** 校验 `POST /dsh-voice/config` 请求体（严格拦截控制字符与 .env 注入）。 */
export function sanitizeVoiceConfigUpdate(raw: unknown): SanitizeConfigUpdateResult {
  if (!isRecord(raw)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  if (raw['reset'] === true) {
    return { ok: true, reset: true };
  }
  const modeRaw = raw['mode'];
  if (typeof modeRaw !== 'string' || !(VOICE_MODES as readonly string[]).includes(modeRaw)) {
    return { ok: false, error: `不支持的语音模式：${String(modeRaw ?? '')}（可选 default | live | cascade）` };
  }
  const mode = modeRaw as VoiceMode;

  let defaultMode: VoiceConfigUpdateRequest['defaultMode'];
  if (raw['defaultMode'] !== undefined) {
    if (!isRecord(raw['defaultMode'])) return { ok: false, error: 'defaultMode 必须是对象' };
    const apiKey = sanitizeOptionalKey(raw['defaultMode']['apiKey'], 'DASHSCOPE_API_KEY');
    if (!apiKey.ok) return apiKey;
    const clearApiKey = sanitizeOptionalBool(raw['defaultMode']['clearApiKey'], 'clearApiKey');
    if (!clearApiKey.ok) return clearApiKey;
    defaultMode = {
      ...(apiKey.value === undefined ? {} : { apiKey: apiKey.value }),
      ...(clearApiKey.value === undefined ? {} : { clearApiKey: clearApiKey.value }),
    };
  }

  let live: VoiceConfigUpdateRequest['live'];
  if (raw['live'] !== undefined) {
    if (!isRecord(raw['live'])) return { ok: false, error: 'live 必须是对象' };
    const baseUrl = sanitizeOptionalUrl(raw['live']['baseUrl'], 'Live Base URL');
    if (!baseUrl.ok) return baseUrl;
    const apiKey = sanitizeOptionalKey(raw['live']['apiKey'], 'Live API Key');
    if (!apiKey.ok) return apiKey;
    const clearApiKey = sanitizeOptionalBool(raw['live']['clearApiKey'], 'clearApiKey');
    if (!clearApiKey.ok) return clearApiKey;
    const model = sanitizeOptionalName(raw['live']['model'], 'Live 模型');
    if (!model.ok) return model;
    const asrModel = sanitizeOptionalName(raw['live']['asrModel'], 'Live 转写模型');
    if (!asrModel.ok) return asrModel;
    live = {
      ...(baseUrl.value === undefined ? {} : { baseUrl: baseUrl.value }),
      ...(apiKey.value === undefined ? {} : { apiKey: apiKey.value }),
      ...(clearApiKey.value === undefined ? {} : { clearApiKey: clearApiKey.value }),
      ...(model.value === undefined ? {} : { model: model.value }),
      ...(asrModel.value === undefined ? {} : { asrModel: asrModel.value }),
    };
  }

  let cascade: VoiceConfigUpdateRequest['cascade'];
  if (raw['cascade'] !== undefined) {
    if (!isRecord(raw['cascade'])) return { ok: false, error: 'cascade 必须是对象' };
    const sttBaseUrl = sanitizeOptionalUrl(raw['cascade']['sttBaseUrl'], 'STT Base URL');
    if (!sttBaseUrl.ok) return sttBaseUrl;
    const sttApiKey = sanitizeOptionalKey(raw['cascade']['sttApiKey'], 'STT API Key');
    if (!sttApiKey.ok) return sttApiKey;
    const clearSttApiKey = sanitizeOptionalBool(raw['cascade']['clearSttApiKey'], 'clearSttApiKey');
    if (!clearSttApiKey.ok) return clearSttApiKey;
    const sttModel = sanitizeOptionalName(raw['cascade']['sttModel'], 'STT 模型');
    if (!sttModel.ok) return sttModel;
    const ttsReuseStt = sanitizeOptionalBool(raw['cascade']['ttsReuseStt'], 'ttsReuseStt');
    if (!ttsReuseStt.ok) return ttsReuseStt;
    const ttsBaseUrl = sanitizeOptionalUrl(raw['cascade']['ttsBaseUrl'], 'TTS Base URL');
    if (!ttsBaseUrl.ok) return ttsBaseUrl;
    const ttsApiKey = sanitizeOptionalKey(raw['cascade']['ttsApiKey'], 'TTS API Key');
    if (!ttsApiKey.ok) return ttsApiKey;
    const clearTtsApiKey = sanitizeOptionalBool(raw['cascade']['clearTtsApiKey'], 'clearTtsApiKey');
    if (!clearTtsApiKey.ok) return clearTtsApiKey;
    const ttsModel = sanitizeOptionalName(raw['cascade']['ttsModel'], 'TTS 模型');
    if (!ttsModel.ok) return ttsModel;
    const ttsVoice = sanitizeOptionalName(raw['cascade']['ttsVoice'], 'TTS 音色');
    if (!ttsVoice.ok) return ttsVoice;
    cascade = {
      ...(sttBaseUrl.value === undefined ? {} : { sttBaseUrl: sttBaseUrl.value }),
      ...(sttApiKey.value === undefined ? {} : { sttApiKey: sttApiKey.value }),
      ...(clearSttApiKey.value === undefined ? {} : { clearSttApiKey: clearSttApiKey.value }),
      ...(sttModel.value === undefined ? {} : { sttModel: sttModel.value }),
      ...(ttsReuseStt.value === undefined ? {} : { ttsReuseStt: ttsReuseStt.value }),
      ...(ttsBaseUrl.value === undefined ? {} : { ttsBaseUrl: ttsBaseUrl.value }),
      ...(ttsApiKey.value === undefined ? {} : { ttsApiKey: ttsApiKey.value }),
      ...(clearTtsApiKey.value === undefined ? {} : { clearTtsApiKey: clearTtsApiKey.value }),
      ...(ttsModel.value === undefined ? {} : { ttsModel: ttsModel.value }),
      ...(ttsVoice.value === undefined ? {} : { ttsVoice: ttsVoice.value }),
    };
  }

  return {
    ok: true,
    reset: false,
    value: {
      mode,
      ...(defaultMode === undefined ? {} : { defaultMode }),
      ...(live === undefined ? {} : { live }),
      ...(cascade === undefined ? {} : { cascade }),
    },
  };
}

/** 校验 `POST /dsh-voice/models` 请求体。 */
export function sanitizeFetchModelsRequest(raw: unknown): SanitizeFetchModelsResult {
  if (!isRecord(raw)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const slotRaw = raw['slot'];
  if (typeof slotRaw !== 'string' || !(MODEL_FETCH_SLOTS as readonly string[]).includes(slotRaw)) {
    return { ok: false, error: `不支持的模型槽位：${String(slotRaw ?? '')}` };
  }
  const baseUrl = sanitizeOptionalUrl(raw['baseUrl'], 'Base URL');
  if (!baseUrl.ok) return baseUrl;
  const apiKey = sanitizeOptionalKey(raw['apiKey'], 'API Key');
  if (!apiKey.ok) return apiKey;
  const reuseStt = sanitizeOptionalBool(raw['reuseStt'], 'reuseStt');
  if (!reuseStt.ok) return reuseStt;
  const sttBaseUrl = sanitizeOptionalUrl(raw['sttBaseUrl'], 'STT Base URL');
  if (!sttBaseUrl.ok) return sttBaseUrl;
  const sttApiKey = sanitizeOptionalKey(raw['sttApiKey'], 'STT API Key');
  if (!sttApiKey.ok) return sttApiKey;

  return {
    ok: true,
    value: {
      slot: slotRaw as ModelFetchSlot,
      ...(baseUrl.value === undefined ? {} : { baseUrl: baseUrl.value }),
      ...(apiKey.value === undefined ? {} : { apiKey: apiKey.value }),
      ...(reuseStt.value === undefined ? {} : { reuseStt: reuseStt.value }),
      ...(sttBaseUrl.value === undefined ? {} : { sttBaseUrl: sttBaseUrl.value }),
      ...(sttApiKey.value === undefined ? {} : { sttApiKey: sttApiKey.value }),
    },
  };
}

const SLOT_PATTERNS: Readonly<Record<ModelFetchSlot, RegExp>> = {
  live: /realtime|omni|audio/iu,
  stt: /transcribe|whisper|asr|stt|sensevoice|paraformer/iu,
  tts: /tts|speech|cosyvoice|voice|audio/iu,
};

/** 按槽位相关性排序可用模型列表：相关语音模型置顶，其余按字母序排列。 */
export function rankModelsForSlot(
  items: readonly AvailableModelItem[],
  slot: ModelFetchSlot,
): AvailableModelItem[] {
  const pattern = SLOT_PATTERNS[slot];
  return [...items].sort((a, b) => {
    const aMatch = pattern.test(a.id) ? 0 : 1;
    const bMatch = pattern.test(b.id) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.id.localeCompare(b.id);
  });
}
