/**
 * 裸 TTS 的默认风格和 key 来源。不打真网：fetch 换成记录请求的桩。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_STYLE, EMOTION_STYLES, MimoError, mimoTts, tts, ttsStream } from '../src/mimo.ts';

interface Shot {
  readonly apiKey: string;
  readonly style: string;
}

function installFetch(shots: Shot[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ content?: string }>;
    };
    shots.push({
      apiKey: headers?.['api-key'] ?? '',
      style: body.messages?.[0]?.content ?? '',
    });
    return new Response('', { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function drain(gen: AsyncIterable<Buffer>): Promise<void> {
  for await (const _chunk of gen) {
    // 测的是发出去的请求，不是音频字节
  }
}

function withKey(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env['MIMO_API_KEY'];
  if (value === undefined) {
    delete process.env['MIMO_API_KEY'];
  } else {
    process.env['MIMO_API_KEY'] = value;
  }
  return run().finally(() => {
    if (previous === undefined) {
      delete process.env['MIMO_API_KEY'];
    } else {
      process.env['MIMO_API_KEY'] = previous;
    }
  });
}

test('裸 tts / ttsStream 默认风格是 BASE_STYLE', async () => {
  await withKey('env-key', async () => {
    const shots: Shot[] = [];
    const restore = installFetch(shots);
    try {
      await drain(ttsStream('你好'));
      await tts('你好');
      assert.equal(shots[0]?.style, BASE_STYLE);
      assert.equal(shots[1]?.style, BASE_STYLE);
      assert.equal(shots[0]?.apiKey, 'env-key');
      assert.equal(shots[0]?.style.includes('Calm, natural, conversational.'), false);
    } finally {
      restore();
    }
  });
});

test('mimoTts 的 apiKey 优先于 MIMO_API_KEY，空白则回落到环境变量', async () => {
  await withKey('env-key', async () => {
    const shots: Shot[] = [];
    const restore = installFetch(shots);
    try {
      await drain(mimoTts({ apiKey: '  option-key  ' }).synthesize('你好', 'happy'));
      await drain(mimoTts({ apiKey: '   ' }).synthesize('你好'));
      await drain(mimoTts({}).synthesize('你好'));
      assert.equal(shots[0]?.apiKey, 'option-key');
      assert.equal(shots[0]?.style, `${BASE_STYLE}${EMOTION_STYLES.happy}`);
      assert.equal(shots[1]?.apiKey, 'env-key');
      assert.equal(shots[2]?.apiKey, 'env-key');
    } finally {
      restore();
    }
  });
});

test('没有 key 时合成抛 MimoError，不发请求', async () => {
  await withKey(undefined, async () => {
    const shots: Shot[] = [];
    const restore = installFetch(shots);
    try {
      await assert.rejects(() => drain(mimoTts({}).synthesize('你好')), MimoError);
      await assert.rejects(() => drain(ttsStream('你好')), MimoError);
      assert.equal(shots.length, 0);
    } finally {
      restore();
    }
  });
});
