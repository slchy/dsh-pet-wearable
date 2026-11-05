/**
 * MiMo ASR / TTS 客户端（TS 版，与 scripts/mimo_client.py 等价）。
 *
 * 实测事实见 docs/MIMO-API-PROBED.md：
 * - 端点 POST /v1/chat/completions，header `api-key`
 * - ASR：音频整段 base64 内联，输出 SSE 文本 delta
 * - TTS：输出 SSE base64 PCM16，**采样率 24 kHz**
 */

const API_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
const ASR_MODEL = 'mimo-v2.5-asr';
const TTS_MODEL = 'mimo-v2.5-tts';

/** 上行 mSBC 解码后的采样率 */
export const ASR_SAMPLE_RATE = 16_000;
/** MiMo TTS 输出采样率（实测确认） */
export const TTS_SAMPLE_RATE = 24_000;

export class MimoError extends Error {}

function apiKey(): string {
  const k = process.env.MIMO_API_KEY?.trim();
  if (!k) {
    throw new MimoError('未设置 MIMO_API_KEY');
  }
  return k;
}

/** 给裸 PCM16 加 44 字节 WAV 头。 */
export function pcmToWav(pcm: Buffer, rate = ASR_SAMPLE_RATE, channels = 1): Buffer {
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                 // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type SseObject = Record<string, unknown>;

async function* sse(body: unknown): AsyncGenerator<SseObject> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey(),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MimoError(`HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }
  if (!res.body) {
    throw new MimoError('响应没有 body');
  }

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (!data) continue;
      try {
        yield JSON.parse(data) as SseObject;
      } catch {
        // 跳过畸形的 SSE 行，不中断整条流
      }
    }
  }
}

function deltaText(obj: SseObject): string {
  const choices = obj.choices as Array<{ delta?: { content?: unknown } }> | undefined;
  const c = choices?.[0]?.delta?.content;
  return typeof c === 'string' ? c : '';
}

function deltaAudio(obj: SseObject): string {
  const choices = obj.choices as
    | Array<{ delta?: { audio?: { data?: unknown } } }>
    | undefined;
  const d = choices?.[0]?.delta?.audio?.data;
  return typeof d === 'string' ? d : '';
}

/** 整段 WAV → 文本。 */
export async function asr(wav: Buffer, language = 'auto'): Promise<{ text: string; chunks: number }> {
  const b64 = wav.toString('base64');
  const pieces: string[] = [];
  let chunks = 0;

  for await (const obj of sse({
    model: ASR_MODEL,
    messages: [{
      role: 'user',
      content: [{
        type: 'input_audio',
        input_audio: { data: `data:audio/wav;base64,${b64}` },
      }],
    }],
    asr_options: { language },
    stream: true,
  })) {
    const t = deltaText(obj);
    if (t) {
      pieces.push(t);
      chunks += 1;
    }
  }

  return { text: pieces.join(''), chunks };
}

/** 文本 → PCM16 单声道 24 kHz。 */
export async function tts(
  text: string,
  voice = 'Chloe',
  style = 'Calm, natural, conversational.',
): Promise<{ pcm: Buffer; chunks: number }> {
  const parts: Buffer[] = [];
  let chunks = 0;

  for await (const obj of sse({
    model: TTS_MODEL,
    messages: [
      { role: 'user', content: style },
      { role: 'assistant', content: text },
    ],
    audio: { format: 'pcm16', voice },
    stream: true,
  })) {
    const d = deltaAudio(obj);
    if (!d) continue;
    parts.push(Buffer.from(d, 'base64'));
    chunks += 1;
  }

  return { pcm: Buffer.concat(parts), chunks };
}
