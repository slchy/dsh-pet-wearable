/**
 * OpenAI-compatible 文本转语音（`POST /v1/audio/speech`，`response_format: 'pcm'`）。
 *
 * 兼容 OpenAI 官方（`gpt-4o-mini-tts` / `tts-1`）以及所有实现 `/v1/audio/speech` 的
 * 第三方或自托管服务（如 vLLM / Kokoro / Fish / 网关）。
 * OpenAI 协议约定 PCM 输出固定为 24 kHz 单声道 s16le；若第三方网关采用其它采样率，
 * 可显式传入 `sampleRate`。
 */
import type { TtsProvider } from './providers.ts';

export const DEFAULT_OPENAI_TTS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_OPENAI_TTS_VOICE = 'alloy';
export const DEFAULT_OPENAI_TTS_SAMPLE_RATE = 24_000;

export interface OpenAiTtsOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly voice?: string;
  /** 可选风格指令（如 `gpt-4o-mini-tts` 支持 `instructions`）；未设时不发送该字段。 */
  readonly instructions?: string;
  /** 可选按情绪映射的风格指令表；命中时覆盖或追加到 `instructions`。 */
  readonly emotionInstructions?: Readonly<Record<string, string>>;
  /** 语速（0.25–4.0），缺省不传。 */
  readonly speed?: number;
  /** PCM16 单声道输出采样率，默认 24000。 */
  readonly sampleRate?: number;
  /** 请求超时（毫秒），默认 15000。 */
  readonly timeoutMs?: number;
  /** 测试注入 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

export class OpenAiTtsError extends Error {}

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? DEFAULT_OPENAI_TTS_BASE_URL).trim();
  const base = trimmed === '' ? DEFAULT_OPENAI_TTS_BASE_URL : trimmed;
  return base.replace(/\/+$/u, '');
}

function resolveInstructions(
  opts: OpenAiTtsOptions,
  emotion: string | undefined,
): string | undefined {
  const base = opts.instructions?.trim() ?? '';
  const perEmotion = emotion !== undefined ? (opts.emotionInstructions?.[emotion]?.trim() ?? '') : '';
  if (base !== '' && perEmotion !== '') return `${base} ${perEmotion}`;
  if (perEmotion !== '') return perEmotion;
  if (base !== '') return base;
  return undefined;
}

/**
 * 把 OpenAI-compatible `/audio/speech` 包成 {@link TtsProvider}。
 *
 * 保持 PCM16 帧偶数字节对齐：网络分片若切在奇数字节上，把尾字节暂存到下一片拼接，
 * 避免下游播放器半采样错位爆音。
 */
export function openAiTts(opts: OpenAiTtsOptions): TtsProvider {
  const apiKey = opts.apiKey.trim();
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const model = (opts.model?.trim() ?? '') || DEFAULT_OPENAI_TTS_MODEL;
  const voice = (opts.voice?.trim() ?? '') || DEFAULT_OPENAI_TTS_VOICE;
  const sampleRate = opts.sampleRate ?? DEFAULT_OPENAI_TTS_SAMPLE_RATE;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`OpenAI TTS sampleRate 必须为正有限数（得到 ${sampleRate}）`);
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const inFlight = new Set<AbortController>();

  return {
    name: `openai-tts:${model}`,
    sampleRate,

    async *synthesize(text: string, emotion?: string): AsyncIterable<Buffer> {
      const input = text.trim();
      if (input === '') return;

      const controller = new AbortController();
      inFlight.add(controller);
      const timer = timeoutMs > 0
        ? setTimeout(() => { controller.abort(new OpenAiTtsError(`OpenAI TTS 超时 ${timeoutMs} ms`)); }, timeoutMs)
        : null;

      try {
        const instructions = resolveInstructions(opts, emotion);
        const body: Record<string, unknown> = {
          model,
          voice,
          input,
          response_format: 'pcm',
          ...(instructions === undefined ? {} : { instructions }),
          ...(opts.speed === undefined ? {} : { speed: opts.speed }),
        };
        const response = await doFetch(`${baseUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let detail = '';
          try {
            detail = (await response.text()).slice(0, 200);
          } catch {
            // 读错误体失败不盖住状态码
          }
          throw new OpenAiTtsError(
            `OpenAI TTS HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
          );
        }

        if (response.body === null) {
          const buf = Buffer.from(await response.arrayBuffer());
          const evenLen = buf.length & ~1;
          if (evenLen > 0) yield buf.subarray(0, evenLen);
          return;
        }

        const reader = response.body.getReader();
        let carry: Buffer<ArrayBufferLike> | null = null;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined || value.byteLength === 0) continue;
            let chunk: Buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            if (carry !== null) {
              chunk = Buffer.concat([carry, chunk]);
              carry = null;
            }
            if ((chunk.length & 1) === 1) {
              carry = chunk.subarray(chunk.length - 1);
              chunk = chunk.subarray(0, chunk.length - 1);
            }
            if (chunk.length > 0) {
              yield chunk;
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // 读端已释放
          }
        }
      } finally {
        if (timer !== null) clearTimeout(timer);
        inFlight.delete(controller);
      }
    },

    close(): void {
      for (const controller of inFlight) {
        controller.abort();
      }
      inFlight.clear();
    },
  };
}
