import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodePcm16MonoWav,
  openAiHttpStt,
} from '../src/openai-stt.ts';
import { buildStt } from '../src/runtime/providers-factory.ts';
import { isManualEndpointStt } from '../src/voice-config.ts';

test('encodePcm16MonoWav 产出合法 16kHz 单声道 PCM16 RIFF WAV 头', () => {
  const pcm = Buffer.alloc(640, 0x12);
  const wav = encodePcm16MonoWav(pcm, 16_000);
  assert.equal(wav.length, 44 + 640);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + 640);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), 640);
});

test('openAiHttpStt：静音不发请求，有声 commit 发 multipart WAV 并回传 commitSeq', async () => {
  const calls: Array<{ url: string; auth: string | null; model: string | null; language: string | null; prompt: string | null; wavSize: number }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = new Headers(init?.headers);
    const form = init?.body as FormData;
    const file = form.get('file') as Blob;
    calls.push({
      url,
      auth: headers.get('authorization'),
      model: form.get('model') as string | null,
      language: form.get('language') as string | null,
      prompt: form.get('prompt') as string | null,
      wavSize: file.size,
    });
    return new Response(JSON.stringify({ text: '你好世界' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = openAiHttpStt({
    apiKey: 'sk-test-http-stt',
    baseUrl: 'https://gateway.example.com/v1/',
    model: 'whisper-large-v3',
    language: 'zh',
    prompt: '专有名词',
    fetchImpl,
  });
  assert.equal(provider.name, 'openai-stt:whisper-large-v3');
  assert.equal(provider.supportsManualEndpoint, true);

  const sentences: Array<{ text: string; seq: number; commitSeq: number | undefined }> = [];
  const session = provider.open({
    onSentence: (text, seq, commitSeq) => {
      sentences.push({ text, seq, commitSeq });
    },
  });

  // 纯静音帧 commit 不发 HTTP，不占 commitSeq
  session.feed(Buffer.alloc(320), false);
  session.commit?.();
  assert.equal(session.commitSeq?.(), 0);
  assert.equal(calls.length, 0);

  // 预卷静音 + 有声帧 → commit 打包在一起上传
  session.feed(Buffer.alloc(320, 1), false);
  session.feed(Buffer.alloc(640, 2), true);
  session.commit?.();
  assert.equal(session.commitSeq?.(), 1);
  assert.equal(session.decoding?.(), true);
  await session.whenDecoded?.();
  assert.equal(session.decoding?.(), false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://gateway.example.com/v1/audio/transcriptions');
  assert.equal(calls[0]?.auth, 'Bearer sk-test-http-stt');
  assert.equal(calls[0]?.model, 'whisper-large-v3');
  assert.equal(calls[0]?.language, 'zh');
  assert.equal(calls[0]?.prompt, '专有名词');
  assert.equal(calls[0]?.wavSize, 44 + 320 + 640);
  assert.deepEqual(sentences, [{ text: '你好世界', seq: 1, commitSeq: 1 }]);
  session.close();
});

test('openAiHttpStt：discard 丢弃在途结果且不触发错误，HTTP 报错走 onError', async () => {
  let reqIndex = 0;
  let releaseFirst!: () => void;
  const fetchImpl: typeof fetch = async () => {
    reqIndex += 1;
    if (reqIndex === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return new Response(JSON.stringify({ text: '应当被作废' }), { status: 200 });
    }
    return new Response('unauthorized', { status: 401 });
  };

  const sentences: string[] = [];
  const errors: string[] = [];
  const session = openAiHttpStt({ apiKey: 'sk-err', fetchImpl }).open({
    onSentence: (text) => { sentences.push(text); },
    onError: (err) => { errors.push(err.message); },
  });

  session.feed(Buffer.alloc(640, 3), true);
  session.commit?.();
  session.discard?.();
  releaseFirst();
  await session.whenDecoded?.();
  assert.deepEqual(sentences, []);
  assert.deepEqual(errors, []);

  session.feed(Buffer.alloc(640, 4), true);
  session.commit?.();
  await session.whenDecoded?.();
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /HTTP 401/);
  session.close();
});

test('buildStt("openai") 与 isManualEndpointStt 正常接入注入 env', async () => {
  assert.equal(isManualEndpointStt('openai'), true);
  assert.equal(isManualEndpointStt('openai-http'), true);
  const stt = await buildStt(
    'openai',
    { akId: '', akSecret: '', appkey: '', region: 'cn-shanghai', maxSentenceSilenceMs: 200 },
    {
      OPENAI_ASR_API_KEY: 'sk-injected',
      OPENAI_ASR_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_ASR_MODEL: 'whisper-1',
    },
  );
  assert.equal(stt.name, 'openai-stt:whisper-1');
  assert.equal(stt.supportsManualEndpoint, true);

  await assert.rejects(
    () => buildStt(
      'openai',
      { akId: '', akSecret: '', appkey: '', region: 'cn-shanghai', maxSentenceSilenceMs: 200 },
      {},
    ),
    /OPENAI_ASR_API_KEY/,
  );
});
