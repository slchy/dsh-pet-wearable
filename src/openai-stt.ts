/**
 * OpenAI-compatible HTTP 语音转写（`POST /v1/audio/transcriptions`）。
 *
 * 兼容 OpenAI 官方（`gpt-4o-mini-transcribe` / `whisper-1`）以及所有实现
 * `/v1/audio/transcriptions` 的第三方中转站或自托管服务（Groq / SiliconFlow /
 * OneAPI / 本地 Whisper / SenseVoice 网关）。
 *
 * 与 `QwenRealtimeAsr` 对齐同一套手动端点契约：
 * - 上行按 16 kHz PCM16 单声道喂入；开麦静音期只保留一小段预卷，开口后连续缓冲
 * - 宿主静音到点调 `commit()` 时封装成 WAV 发起 multipart POST，产出带 `commitSeq` 的定稿
 * - 支持 `discard()`、`decoding()`、`whenDecoded()` 与按 `commitSeq` 保序回调
 */
import type { SttProvider, SttSession } from './providers.ts';

export const DEFAULT_OPENAI_STT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';

const INPUT_SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = INPUT_SAMPLE_RATE * 2;
/** 未检测到人声前保留的预卷上限（250 ms），避免削掉句首起音。 */
const PREROLL_RING_BYTES = Math.floor(BYTES_PER_SECOND * 0.25);
/** 单段缓冲上限（60 s），防止异常长静音或漏封段无限吃内存。 */
const MAX_SEGMENT_BYTES = BYTES_PER_SECOND * 60;

export interface OpenAiHttpSttOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly language?: string;
  /** 可选提示词（如热词或上下文偏置），映射到 `prompt` 表单字段。 */
  readonly prompt?: string;
  /** 单次转写请求超时（毫秒），默认 15000。 */
  readonly timeoutMs?: number;
  /** 测试注入 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

export class OpenAiHttpSttError extends Error {}

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? DEFAULT_OPENAI_STT_BASE_URL).trim();
  const base = trimmed === '' ? DEFAULT_OPENAI_STT_BASE_URL : trimmed;
  return base.replace(/\/+$/u, '');
}

/** 把 16-bit signed LE 单声道 PCM 封装成标准 44 字节头 WAV。 */
export function encodePcm16MonoWav(pcm: Buffer, sampleRate = INPUT_SAMPLE_RATE): Buffer {
  const dataBytes = pcm.length & ~1;
  const out = Buffer.allocUnsafe(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16); // PCM fmt chunk size
  out.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  out.writeUInt16LE(1, 22); // NumChannels = 1
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  out.writeUInt16LE(2, 32); // BlockAlign
  out.writeUInt16LE(16, 34); // BitsPerSample
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  if (dataBytes > 0) {
    pcm.copy(out, 44, 0, dataBytes);
  }
  return out;
}

function parseTranscriptText(rawBody: string, contentType: string): string {
  const trimmed = rawBody.trim();
  if (trimmed === '') return '';
  if (contentType.includes('application/json') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const text = (parsed as { text?: unknown }).text;
        if (typeof text === 'string') return text.trim();
      }
    } catch {
      // 某些兼容网关可能回纯文本，回退原文
    }
  }
  return trimmed;
}

/** 把 OpenAI-compatible HTTP `/audio/transcriptions` 包成 {@link SttProvider}。 */
export function openAiHttpStt(
  opts: OpenAiHttpSttOptions,
  log?: (line: string) => void,
): SttProvider {
  const apiKey = opts.apiKey.trim();
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const model = (opts.model?.trim() ?? '') || DEFAULT_OPENAI_STT_MODEL;
  const language = opts.language?.trim() ?? '';
  const prompt = opts.prompt?.trim() ?? '';
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const emitLog = log ?? (() => {});

  return {
    name: `openai-stt:${model}`,
    supportsManualEndpoint: true,

    open(handlers): SttSession {
      let closed = false;
      let hasVoiced = false;
      let segmentChunks: Buffer[] = [];
      let segmentBytes = 0;
      let prerollChunks: Buffer[] = [];
      let prerollBytes = 0;

      let _commitSeq = 0;
      let sentenceSeq = 0;
      let discardBeforeSeq = 0;
      let inFlight = 0;
      let decodeWaiters: Array<() => void> = [];
      const controllers = new Set<AbortController>();
      let deliveryChain: Promise<void> = Promise.resolve();

      const resetBuffers = (): void => {
        hasVoiced = false;
        segmentChunks = [];
        segmentBytes = 0;
        prerollChunks = [];
        prerollBytes = 0;
      };

      const flushDecodeWaiters = (): void => {
        if (inFlight > 0 || decodeWaiters.length === 0) return;
        const waiters = decodeWaiters;
        decodeWaiters = [];
        queueMicrotask(() => {
          for (const resolve of waiters) resolve();
        });
      };

      const appendSegment = (chunk: Buffer): void => {
        segmentChunks.push(chunk);
        segmentBytes += chunk.length;
        while (segmentBytes > MAX_SEGMENT_BYTES && segmentChunks.length > 1) {
          const dropped = segmentChunks.shift();
          if (dropped !== undefined) segmentBytes -= dropped.length;
        }
      };

      const appendPreroll = (chunk: Buffer): void => {
        prerollChunks.push(chunk);
        prerollBytes += chunk.length;
        while (prerollBytes > PREROLL_RING_BYTES && prerollChunks.length > 1) {
          const dropped = prerollChunks.shift();
          if (dropped !== undefined) prerollBytes -= dropped.length;
        }
      };

      const transcribeSegment = async (
        pcm: Buffer,
        myCommitSeq: number,
        controller: AbortController,
      ): Promise<string> => {
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            controller.abort(new OpenAiHttpSttError(`OpenAI STT 超时 ${timeoutMs} ms`));
          }, timeoutMs)
          : null;
        try {
          const wav = encodePcm16MonoWav(pcm, INPUT_SAMPLE_RATE);
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
          form.append('model', model);
          form.append('response_format', 'json');
          if (language !== '') form.append('language', language);
          if (prompt !== '') form.append('prompt', prompt);

          const response = await doFetch(`${baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: form,
            signal: controller.signal,
          });

          if (!response.ok) {
            let detail = '';
            try {
              detail = (await response.text()).slice(0, 200);
            } catch {
              // 忽略读取错误体失败
            }
            throw new OpenAiHttpSttError(
              `OpenAI STT HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
            );
          }

          const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
          const rawBody = await response.text();
          return parseTranscriptText(rawBody, contentType);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      };

      const commit = (): void => {
        if (closed || !hasVoiced || segmentBytes === 0) {
          resetBuffers();
          return;
        }
        const pcm = Buffer.concat(segmentChunks, segmentBytes);
        resetBuffers();

        const myCommitSeq = ++_commitSeq;
        inFlight += 1;
        const controller = new AbortController();
        controllers.add(controller);

        const requestPromise = transcribeSegment(pcm, myCommitSeq, controller)
          .then((text) => ({ ok: true as const, text }))
          .catch((error: unknown) => ({ ok: false as const, error }));

        // 保序交付：即使先发的长句晚于后发的短句返回，也按 commitSeq 顺序回调
        deliveryChain = deliveryChain.then(async () => {
          try {
            const result = await requestPromise;
            if (closed || myCommitSeq <= discardBeforeSeq) return;
            if (result.ok) {
              if (result.text !== '') {
                sentenceSeq += 1;
                handlers.onSentence(result.text, sentenceSeq, myCommitSeq);
              }
            } else {
              const rawErr = result.error instanceof Error
                ? result.error
                : controller.signal.reason instanceof Error
                  ? controller.signal.reason
                  : new OpenAiHttpSttError(String(result.error));
              emitLog(`OpenAI HTTP STT 失败: ${rawErr.message}`);
              handlers.onError?.(rawErr);
            }
          } finally {
            controllers.delete(controller);
            inFlight = Math.max(0, inFlight - 1);
            flushDecodeWaiters();
          }
        });
      };

      return {
        feed(pcm: Buffer, voiced?: boolean): void {
          if (closed || pcm.length === 0) return;
          const copy = Buffer.from(pcm);
          if (!hasVoiced) {
            if (voiced === false) {
              appendPreroll(copy);
              return;
            }
            hasVoiced = true;
            for (const pre of prerollChunks) appendSegment(pre);
            prerollChunks = [];
            prerollBytes = 0;
          }
          appendSegment(copy);
        },

        commit,

        hangup(): void {
          commit();
        },

        discard(): void {
          resetBuffers();
          discardBeforeSeq = _commitSeq;
          for (const controller of controllers) {
            controller.abort();
          }
        },

        close(): void {
          if (closed) return;
          closed = true;
          resetBuffers();
          discardBeforeSeq = _commitSeq;
          for (const controller of controllers) {
            controller.abort();
          }
          controllers.clear();
          inFlight = 0;
          flushDecodeWaiters();
        },

        commitSeq(): number {
          return _commitSeq;
        },

        decoding(): boolean {
          return inFlight > 0;
        },

        whenDecoded(): Promise<void> | null {
          if (inFlight <= 0) return null;
          return new Promise<void>((resolve) => {
            decodeWaiters.push(resolve);
          });
        },
      };
    },
  };
}
