/**
 * OpenAI 兼容端点可用模型表（`GET {baseUrl}/models`）拉取器。
 *
 * 由宿主服务端代发，避免浏览器 CORS 问题并避免前端持有/回显已保存的明文密钥。
 */
import {
  DEFAULT_OPENAI_BASE_URL,
  deriveOpenAiHttpBaseUrl,
  rankModelsForSlot,
  type AvailableModelItem,
  type FetchModelsRequest,
} from './voice-overrides.ts';

export type EnvLookup = Readonly<Record<string, string | undefined>>;

export type FetchModelsOutcome =
  | {
    readonly ok: true;
    readonly endpoint: string;
    readonly models: readonly AvailableModelItem[];
  }
  | {
    readonly ok: false;
    readonly status: number;
    readonly error: string;
  };

const FETCH_TIMEOUT_MS = 10_000;
const MAX_MODELS = 300;

function resolveSlotCredentials(
  req: FetchModelsRequest,
  env: EnvLookup,
): { readonly rawBaseUrl: string; readonly apiKey: string } {
  const sttSavedUrl = (env['OPENAI_ASR_BASE_URL'] ?? env['OPENAI_ASR_URL'] ?? env['OPENAI_BASE_URL'] ?? '').trim();
  const sttSavedKey = (env['OPENAI_ASR_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();

  if (req.slot === 'live') {
    const savedUrl = (env['LIVE_BASE_URL'] ?? env['LIVE_URL'] ?? env['OMNI_URL'] ?? env['OPENAI_BASE_URL'] ?? '').trim();
    const savedKey = (env['LIVE_API_KEY'] ?? env['OMNI_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();
    return {
      rawBaseUrl: (req.baseUrl ?? '').trim() || savedUrl || DEFAULT_OPENAI_BASE_URL,
      apiKey: (req.apiKey ?? '').trim() || savedKey,
    };
  }

  if (req.slot === 'stt') {
    return {
      rawBaseUrl: (req.baseUrl ?? '').trim() || sttSavedUrl || DEFAULT_OPENAI_BASE_URL,
      apiKey: (req.apiKey ?? '').trim() || sttSavedKey,
    };
  }

  // slot === 'tts'
  const reuseStt = req.reuseStt ?? (env['OPENAI_TTS_REUSE_STT'] === '1');
  if (reuseStt) {
    return {
      rawBaseUrl: (req.sttBaseUrl ?? '').trim() || sttSavedUrl || DEFAULT_OPENAI_BASE_URL,
      apiKey: (req.sttApiKey ?? '').trim() || sttSavedKey,
    };
  }
  const ttsSavedUrl = (env['OPENAI_TTS_BASE_URL'] ?? env['OPENAI_BASE_URL'] ?? '').trim();
  const ttsSavedKey = (env['OPENAI_TTS_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();
  return {
    rawBaseUrl: (req.baseUrl ?? '').trim() || ttsSavedUrl || DEFAULT_OPENAI_BASE_URL,
    apiKey: (req.apiKey ?? '').trim() || ttsSavedKey,
  };
}

function parseModelsPayload(payload: unknown): AvailableModelItem[] {
  let list: unknown[] = [];
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload !== null && typeof payload === 'object') {
    const bag = payload as { data?: unknown; models?: unknown };
    if (Array.isArray(bag.data)) list = bag.data;
    else if (Array.isArray(bag.models)) list = bag.models;
  }

  const seen = new Set<string>();
  const items: AvailableModelItem[] = [];
  for (const entry of list) {
    if (items.length >= MAX_MODELS) break;
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id !== '' && !seen.has(id)) {
        seen.add(id);
        items.push({ id });
      }
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as { id?: unknown; name?: unknown; owned_by?: unknown };
    const rawId = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : '';
    const id = rawId.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof rec.owned_by === 'string' && rec.owned_by.trim() !== ''
      ? rec.owned_by.trim()
      : undefined;
    items.push(ownedBy === undefined ? { id } : { id, ownedBy });
  }
  return items;
}

function redactSecret(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('****');
}

/** 代理拉取 OpenAI 兼容 `/models` 可用模型表。 */
export async function fetchAvailableModels(
  req: FetchModelsRequest,
  env: EnvLookup,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchModelsOutcome> {
  const { rawBaseUrl, apiKey } = resolveSlotCredentials(req, env);
  if (apiKey === '') {
    return {
      ok: false,
      status: 400,
      error: '请先填写 API Key（或先保存配置）后再拉取可用模型表',
    };
  }

  let endpoint: string;
  try {
    const httpBase = deriveOpenAiHttpBaseUrl(rawBaseUrl);
    const parsed = new URL(`${httpBase}/models`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, status: 400, error: `不支持的协议：${parsed.protocol}` };
    }
    endpoint = parsed.toString();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 400, error: `Base URL 无效：${msg}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = redactSecret((await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 160), apiKey);
      } catch {
        // 忽略错误体读取失败
      }
      return {
        ok: false,
        status: 502,
        error: `拉取模型失败（HTTP ${response.status}${detail === '' ? '' : `：${detail}`}）`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, status: 502, error: '上游 /models 返回了非 JSON 响应' };
    }
    const items = rankModelsForSlot(parseModelsPayload(payload), req.slot);
    if (items.length === 0) {
      return { ok: false, status: 502, error: '上游 /models 返回空模型列表（也可直接手动输入模型名）' };
    }
    return { ok: true, endpoint, models: items };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const safeMsg = redactSecret(rawMsg, apiKey);
    return {
      ok: false,
      status: 502,
      error: controller.signal.aborted
        ? `拉取模型超时（${FETCH_TIMEOUT_MS / 1000}s），请检查 Base URL 连通性`
        : `拉取模型请求失败：${safeMsg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
