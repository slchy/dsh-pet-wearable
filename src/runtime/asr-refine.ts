/**
 * 整句高精度转写（非流式）—— 流式 ASR 的旁路校对。
 *
 * 流式 ASR 为了低延迟把一句话切成好几段解码，专名、中英混读和罗马音容易丢字
 * 或被拉成同音字。这里把内存里**未切碎**的 16 kHz PCM16 整段封成 WAV，在
 * 要委派 `dsh` 的整句上再走一次高精度接口。
 *
 * 只做加法：网络错误 / 非 2xx / 超时 / 空串一律返回 `null`，调用方继续用流式
 * 结果，**绝不阻断委派**。
 *
 * 两条后端都是零新增依赖：
 * - DashScope `qwen3-asr-flash`（OpenAI 兼容 `/chat/completions`，复用
 *   `DASHSCOPE_API_KEY`，不需要额外配置）
 * - OpenAI 兼容 `/audio/transcriptions`（`gpt-4o-transcribe`）
 */
import { encodePcm16MonoWav } from '../openai-stt.ts';

const SAMPLE_RATE = 16_000;
/** 16 kHz × 2 B / 1000 ms（字节/毫秒换算因子）。 */
const PCM16_BYTES_PER_MILLISECOND = 32;
const REFINE_TIMEOUT_MS = 3_500;
const REFINE_MIN_DURATION_MS = 200;
/** 热词 + 最近对话主题截到这么长：再长只会抬高首字延迟。 */
const MAX_CONTEXT_CHARS = 800;

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DASHSCOPE_MODEL = 'qwen3-asr-flash';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_MODEL = 'gpt-4o-transcribe';

export interface AsrRefineRequest {
  /** 16 kHz mono PCM16（**未切碎**的整句） */
  readonly pcm: Buffer;
  /** 流式 ASR 的原始结果，仅供日志对比 */
  readonly streamingText: string;
  /** 可选：热词 + 最近对话主题（DashScope 的 `system` / OpenAI 的 `prompt`） */
  readonly context?: string;
  /** 可选，缺省不传 = auto */
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export type AsrRefiner = (req: AsrRefineRequest) => Promise<string | null>;

export interface AsrRefinerOptions {
  readonly provider: 'dashscope' | 'openai';
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly language?: string;
  /** 静态热词 / 记忆提示词 */
  readonly staticContext?: string;
  /** 单次请求超时（默认 3.5 s，慢网不卡死后台委派） */
  readonly timeoutMs?: number;
  /** 短于这么久（默认 200 ms）的碎片跳过精转，返回 `null` */
  readonly minDurationMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

function trimTrailingSlash(raw: string): string {
  return raw.replace(/\/+$/u, '');
}

/** 静态热词与本轮动态上下文合并、去空、截断。 */
function mergeContext(staticContext: string | undefined, context: string | undefined): string {
  const parts = [staticContext ?? '', context ?? '']
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const joined = parts.join('\n');
  return joined.length <= MAX_CONTEXT_CHARS ? joined : joined.slice(0, MAX_CONTEXT_CHARS).trimEnd();
}

async function ensureOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    // 读错误体失败就只报状态码
  }
  throw new Error(`${label} HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
}

/** `choices[0].message.content`：字符串直接用；数组只拼 `type === 'text'` 的块。 */
function dashscopeText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (message === null || message === undefined || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const parsed = block as { type?: unknown; text?: unknown };
    if (parsed.type === 'text' && typeof parsed.text === 'string') text += parsed.text;
  }
  return text.trim();
}

/** OpenAI 兼容回包：JSON `{ text }` 或纯文本。 */
function openAiText(rawBody: string, contentType: string): string {
  const trimmed = rawBody.trim();
  if (trimmed === '') return '';
  if (contentType.includes('application/json') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const text = (parsed as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
    } catch {
      // 兼容网关可能回纯文本，回退原文
    }
  }
  return trimmed;
}

interface Transport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly doFetch: typeof fetch;
  readonly signal: AbortSignal;
}

async function transcribeDashscope(
  transport: Transport,
  wav: Buffer,
  context: string,
  language: string,
): Promise<string> {
  const messages: Record<string, unknown>[] = [];
  if (context !== '') {
    // DashScope `qwen3-asr-flash` 的 OpenAI 兼容接口要求 system.content 为文本块数组，
    // 传纯字符串会被服务端以 HTTP 400 InvalidParameter 拒绝。
    messages.push({ role: 'system', content: [{ type: 'text', text: context }] });
  }
  messages.push({
    role: 'user',
    content: [{
      type: 'input_audio',
      input_audio: {
        data: `data:audio/wav;base64,${wav.toString('base64')}`,
      },
    }],
  });
  const asrOptions: Record<string, unknown> = { enable_itn: true };
  if (language !== '') asrOptions['language'] = language;

  const response = await transport.doFetch(`${transport.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: transport.model,
      messages,
      asr_options: asrOptions,
    }),
    signal: transport.signal,
  });
  await ensureOk(response, 'DashScope');
  return dashscopeText(await response.json());
}

async function transcribeOpenAi(
  transport: Transport,
  wav: Buffer,
  context: string,
  language: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', transport.model);
  form.append('response_format', 'json');
  if (language !== '') form.append('language', language);
  if (context !== '') form.append('prompt', context);

  const response = await transport.doFetch(`${transport.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
    },
    body: form,
    signal: transport.signal,
  });
  await ensureOk(response, 'OpenAI');
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  return openAiText(await response.text(), contentType);
}

/**
 * 造一个整句精转器。返回的函数**永不抛错**：所有失败都收敛成 `null`。
 */
export function createAsrRefiner(opts: AsrRefinerOptions): AsrRefiner {
  const { provider } = opts;
  const apiKey = opts.apiKey.trim();
  const rawBaseUrl = (opts.baseUrl ?? '').trim();
  const baseUrl = trimTrailingSlash(
    rawBaseUrl !== ''
      ? rawBaseUrl
      : provider === 'dashscope' ? DASHSCOPE_BASE_URL : OPENAI_BASE_URL,
  );
  const model = (opts.model?.trim() ?? '')
    || (provider === 'dashscope' ? DASHSCOPE_MODEL : OPENAI_MODEL);
  const language = opts.language?.trim() ?? '';
  const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0
    ? opts.timeoutMs
    : REFINE_TIMEOUT_MS;
  const minDurationMs = opts.minDurationMs ?? REFINE_MIN_DURATION_MS;
  const minBytes = Math.max(0, Math.round(minDurationMs * PCM16_BYTES_PER_MILLISECOND));
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});

  return async (req) => {
    if (req.pcm.byteLength < minBytes) return null;
    if (req.signal?.aborted === true) return null;

    const controller = new AbortController();
    const signal = req.signal;
    const onAbort = (): void => { controller.abort(); };
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    // 不调用 unref()：`finally` 一定会 `clearTimeout(timer)`，不会挂住进程；
    // 若 unref，Node 22 直接执行单测文件且 fetchImpl 为纯 Promise 桩时，
    // 事件循环会因零活跃句柄提前退出而报 Promise pending。
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const wav = encodePcm16MonoWav(req.pcm, SAMPLE_RATE);
      const context = mergeContext(opts.staticContext, req.context);
      const requestLanguage = (req.language ?? language).trim();
      const transport: Transport = { baseUrl, apiKey, model, doFetch, signal: controller.signal };
      const text = provider === 'dashscope'
        ? await transcribeDashscope(transport, wav, context, requestLanguage)
        : await transcribeOpenAi(transport, wav, context, requestLanguage);
      const trimmed = text.trim();
      if (trimmed === '') {
        log(`  ASR精转 ✗ ${provider} 返回空串`);
        return null;
      }
      // 流式与精转的字符数一起记：事后能判断值不值得留这条旁路。
      log(
        `  ASR精转 ✓ ${provider} ${[...trimmed].length} 字`
        + `（流式 ${[...req.streamingText.trim()].length} 字）`,
      );
      return trimmed;
    } catch (error) {
      const reason = timedOut
        ? `超时 ${timeoutMs} ms`
        : error instanceof Error ? error.message : String(error);
      log(`  ASR精转 ✗ ${provider} ${reason.slice(0, 160)}`);
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * 按环境变量选后端（或返回 `null` 表示精转关闭）。
 *
 * 优先级：
 * 1. 显式 `VOICE_REFINE_ASR_PROVIDER=openai|dashscope`
 * 2. `VOICE_REFINE_ASR_URL`（不含 `dashscope`）或 `OPENAI_ASR_API_KEY`
 *    （且没配 `DASHSCOPE_API_KEY`，或主 STT 本身是 OpenAI）
 * 3. 有 `DASHSCOPE_API_KEY`
 * 4. 都没有 → `null`
 */
export function resolveAsrRefiner(
  env: Readonly<Record<string, string | undefined>>,
  extra?: {
    readonly staticContext?: string;
    readonly language?: string;
    readonly log?: (line: string) => void;
    readonly fetchImpl?: typeof fetch;
  },
): AsrRefiner | null {
  const mode = (env['VOICE_REFINE_ASR'] ?? '').trim().toLowerCase();
  if (mode === '0' || mode === 'false' || mode === 'off') return null;

  // 单测进程里默认不发真实外网请求：显式 `VOICE_REFINE_ASR=1` 或注入 fetch 才放行。
  const inTest = (env['NODE_TEST_CONTEXT'] ?? '').trim() !== '';
  if (inTest && mode !== '1' && extra?.fetchImpl === undefined) return null;

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = env[key]?.trim() ?? '';
      if (value !== '') return value;
    }
    return '';
  };

  const dashscopeKey = pick('DASHSCOPE_API_KEY');
  const openAiKey = pick('OPENAI_ASR_API_KEY', 'OPENAI_API_KEY');
  const refineKey = pick('VOICE_REFINE_ASR_API_KEY');
  const refineUrl = pick('VOICE_REFINE_ASR_URL');
  const mainSttIsOpenAi = pick('MIAI_STT').toLowerCase().startsWith('openai');
  const urlLooksOpenAi = refineUrl !== '' && !refineUrl.toLowerCase().includes('dashscope');

  const explicit = pick('VOICE_REFINE_ASR_PROVIDER').toLowerCase();
  const provider: 'openai' | 'dashscope' | null = explicit === 'openai' || explicit === 'dashscope'
    ? explicit
    : urlLooksOpenAi || (openAiKey !== '' && (dashscopeKey === '' || mainSttIsOpenAi))
      ? 'openai'
      : dashscopeKey !== ''
        ? 'dashscope'
        : null;

  const modelOverride = pick('VOICE_REFINE_ASR_MODEL');
  const timeoutRaw = pick('VOICE_REFINE_ASR_TIMEOUT_MS');
  const timeoutParsed = timeoutRaw === '' ? Number.NaN : Number(timeoutRaw);
  const timeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? timeoutParsed : undefined;

  const shared = {
    ...(extra?.staticContext === undefined ? {} : { staticContext: extra.staticContext }),
    ...(extra?.language === undefined ? {} : { language: extra.language }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(extra?.log === undefined ? {} : { log: extra.log }),
    ...(extra?.fetchImpl === undefined ? {} : { fetchImpl: extra.fetchImpl }),
  };

  if (provider === 'openai') {
    const apiKey = refineKey !== '' ? refineKey : openAiKey;
    if (apiKey === '') return null;
    const baseUrl = pick('VOICE_REFINE_ASR_URL', 'OPENAI_ASR_BASE_URL', 'OPENAI_BASE_URL');
    return createAsrRefiner({
      provider: 'openai',
      apiKey,
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(modelOverride === '' ? {} : { model: modelOverride }),
      ...shared,
    });
  }
  if (provider === 'dashscope') {
    const apiKey = refineKey !== '' ? refineKey : dashscopeKey;
    if (apiKey === '') return null;
    return createAsrRefiner({
      provider: 'dashscope',
      apiKey,
      ...(refineUrl === '' ? {} : { baseUrl: refineUrl }),
      ...(modelOverride === '' ? {} : { model: modelOverride }),
      ...shared,
    });
  }
  return null;
}
