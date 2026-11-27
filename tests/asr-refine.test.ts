/**
 * 整句高精度转写（`runtime/asr-refine.ts`）与整句 PCM 透传的回归。
 *
 * 这里的失败模式都是**静默**的：
 * - 默认语言又锁回 `zh`：中英混读的罗马音被拉成中文同音字；
 * - 请求体拼错 / `system` 位置错：模型收不到热词，转写看起来"正常"但没变好；
 * - 网络超时没兜住：精转把委派整轮拖死（本该无感回退到流式文本）；
 * - `utterancePcm` 在某一层漏传：高精度精转永远拿不到未切碎的整句。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DialogRuntime } from '../src/app/dialog.ts';
import { SystemClock } from '../src/app/clock.ts';
import { V1_BASELINE } from '../src/devices/wire-v1.ts';
import type { FastVoiceEngine, TurnInput } from '../src/engine-contract.ts';
import { silentTts, type AgentProvider } from '../src/providers.ts';
import { loadRefineHotwords, resolveAsrLanguage } from '../src/runtime/asr-context.ts';
import { createAsrRefiner, resolveAsrRefiner } from '../src/runtime/asr-refine.ts';

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

// ---------------------------------------------------------------- 语言 / 热词

test('resolveAsrLanguage：缺省 auto（不写 language），显式值原样返回', () => {
  assert.equal(resolveAsrLanguage({}), undefined);
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: undefined }), undefined);
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: 'zh' }), 'zh');
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: 'en' }), 'en');
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: ' yue ' }), 'yue');
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: 'auto' }), undefined);
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: 'off' }), undefined);
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: '' }), undefined);
  assert.equal(resolveAsrLanguage({ QWEN_ASR_LANGUAGE: '   ' }), undefined);
});

test('loadRefineHotwords：VOICE_REFINE_ASR_CORPUS=0 关掉，默认并入记忆热词', () => {
  assert.equal(loadRefineHotwords('花生过敏', { VOICE_REFINE_ASR_CORPUS: '0' }), '');
  const corpus = loadRefineHotwords('花生过敏', {});
  assert.ok(corpus.includes('花生过敏'), `记忆热词没并进去：${corpus.slice(0, 80)}`);
  assert.ok(corpus.length <= 600, `corpus 上限是 600 字，实际 ${corpus.length}`);
});

// ---------------------------------------------------------------- DashScope

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function requireForm(body: unknown): FormData {
  assert.ok(body instanceof FormData, 'body 必须是 multipart FormData');
  return body as FormData;
}

function requireBlob(value: unknown): Blob {
  assert.ok(value instanceof Blob, 'file 字段必须是 Blob');
  return value as Blob;
}

test('createAsrRefiner（dashscope）：URL / Bearer / messages / asr_options 全部按契约', async () => {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '  你好，Bangumi。 ' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const refiner = createAsrRefiner({
    provider: 'dashscope',
    apiKey: 'sk-dashscope',
    staticContext: '热词：Bangumi Live',
    fetchImpl,
    log: () => {},
  });

  const pcm = Buffer.alloc(16_000 * 2, 1); // 1 s
  const text = await refiner({
    pcm,
    streamingText: '你好 班戈米',
    context: '最近在聊新番',
  });
  assert.equal(text, '你好，Bangumi。', '返回文本要 trim');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, DASHSCOPE_URL);
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer sk-dashscope');

  const body = JSON.parse(String(call.init.body)) as {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    asr_options: Record<string, unknown>;
  };
  assert.equal(body.model, 'qwen3-asr-flash');
  assert.equal(body.messages[0]?.role, 'system');
  assert.deepEqual(body.messages[0]?.content, [{ type: 'text', text: '热词：Bangumi Live\n最近在聊新番' }]);
  assert.equal(body.messages[1]?.role, 'user');

  const content = body.messages[1]?.content as Array<{
    type: string;
    input_audio: { data: string };
  }>;
  const inputAudio = content[0]?.input_audio;
  assert.ok(inputAudio !== undefined);
  assert.match(inputAudio.data, /^data:audio\/wav;base64,/u);
  const wav = Buffer.from(inputAudio.data.split(',')[1] ?? '', 'base64');
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.deepEqual(body.asr_options, { enable_itn: true }, '没传 language 时不许出现 asr_options.language');
});

test('createAsrRefiner（dashscope）：显式 language 写进 asr_options', async () => {
  let body: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const refiner = createAsrRefiner({
    provider: 'dashscope',
    apiKey: 'sk',
    language: 'en',
    fetchImpl,
    log: () => {},
  });
  await refiner({ pcm: Buffer.alloc(1000 * 32, 0), streamingText: '' });
  assert.deepEqual(body?.['asr_options'], { enable_itn: true, language: 'en' });
});

// ---------------------------------------------------------------- OpenAI

test('createAsrRefiner（openai）：multipart 含 file / model / prompt，未传 language 不含该字段', async () => {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ text: ' 精转结果 ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const refiner = createAsrRefiner({
    provider: 'openai',
    apiKey: 'sk-openai',
    staticContext: '热词：眼镜',
    fetchImpl,
    log: () => {},
  });

  const text = await refiner({
    pcm: Buffer.alloc(16_000 * 2, 1),
    streamingText: 'jing zhuan',
    context: '最近在聊眼镜',
  });
  assert.equal(text, '精转结果');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, OPENAI_URL);
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer sk-openai');

  const form = requireForm(call.init.body);
  const file = requireBlob(form.get('file'));
  assert.equal(file.type, 'audio/wav');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(form.get('model'), 'gpt-4o-transcribe');
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.get('prompt'), '热词：眼镜\n最近在聊眼镜');
  assert.equal(form.get('language'), null, '没传 language 时不许出现该字段');
});

// ---------------------------------------------------------------- 容错与边界

test('createAsrRefiner：PCM 过短不调 fetch，直接返回 null', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  const refiner = createAsrRefiner({
    provider: 'dashscope',
    apiKey: 'sk',
    fetchImpl,
    log: () => {},
  });
  const text = await refiner({ pcm: Buffer.alloc(100 * 32, 0), streamingText: '嗯' }); // 100 ms
  assert.equal(text, null);
  assert.equal(calls, 0);
});

test('createAsrRefiner：HTTP 500 / 网络异常 / 超时都安全返回 null', async () => {
  const logs: string[] = [];

  const http500 = createAsrRefiner({
    provider: 'dashscope',
    apiKey: 'sk',
    fetchImpl: async () => new Response('boom', { status: 500 }),
    log: (line) => { logs.push(line); },
  });
  assert.equal(await http500({ pcm: Buffer.alloc(1000 * 32, 0), streamingText: '' }), null);

  const networkDown = createAsrRefiner({
    provider: 'dashscope',
    apiKey: 'sk',
    fetchImpl: async () => { throw new Error('网断了'); },
    log: (line) => { logs.push(line); },
  });
  assert.equal(await networkDown({ pcm: Buffer.alloc(1000 * 32, 0), streamingText: '' }), null);

  const neverEnds: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      reject(new Error('缺少 signal'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
  const timeout = createAsrRefiner({
    provider: 'dashscope',
    apiKey: 'sk',
    timeoutMs: 20,
    fetchImpl: neverEnds,
    log: (line) => { logs.push(line); },
  });
  assert.equal(await timeout({ pcm: Buffer.alloc(1000 * 32, 0), streamingText: '' }), null);

  assert.ok(logs.some((line) => line.includes('HTTP 500')), `缺少 500 日志：${logs.join(' | ')}`);
  assert.ok(logs.some((line) => line.includes('网断了')), `缺少网络异常日志：${logs.join(' | ')}`);
  assert.ok(logs.some((line) => line.includes('超时 20 ms')), `缺少超时日志：${logs.join(' | ')}`);
});

// ---------------------------------------------------------------- 后端选择

test('resolveAsrRefiner：显式关闭 / 单测进程 / 有 DashScope key 的三种结论', () => {
  assert.equal(
    resolveAsrRefiner({ VOICE_REFINE_ASR: '0', DASHSCOPE_API_KEY: 'sk' }),
    null,
  );
  assert.equal(
    resolveAsrRefiner({ VOICE_REFINE_ASR: 'off', DASHSCOPE_API_KEY: 'sk' }),
    null,
  );

  // 只有 DashScope key、显式开启 → DashScope 精转器
  const dash = resolveAsrRefiner({ VOICE_REFINE_ASR: '1', DASHSCOPE_API_KEY: 'sk' });
  assert.equal(typeof dash, 'function');

  // 单测进程里默认不发外网请求
  assert.equal(
    resolveAsrRefiner({ NODE_TEST_CONTEXT: 'child-v8', DASHSCOPE_API_KEY: 'sk' }),
    null,
  );
  assert.equal(
    typeof resolveAsrRefiner({
      NODE_TEST_CONTEXT: 'child-v8',
      VOICE_REFINE_ASR: '1',
      DASHSCOPE_API_KEY: 'sk',
    }),
    'function',
  );
});

test('resolveAsrRefiner：显式 openai provider 走 /audio/transcriptions', async () => {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ text: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const refiner = resolveAsrRefiner(
    {
      VOICE_REFINE_ASR_PROVIDER: 'openai',
      OPENAI_ASR_API_KEY: 'sk-openai',
    },
    { fetchImpl, log: () => {} },
  );
  assert.equal(typeof refiner, 'function');
  assert.equal(await refiner!({ pcm: Buffer.alloc(1000 * 32, 0), streamingText: '' }), 'ok');
  assert.equal(calls[0]?.url, OPENAI_URL);
});

// ---------------------------------------------------------------- 整句 PCM 透传

test('utterancePcm：SessionCore → DialogRuntime → TurnRunner → 引擎输入一路透传', async () => {
  const pcm = Buffer.alloc(3200, 7); // 100 ms，只为比对引用/内容
  const turns: TurnInput[] = [];
  let markEnded: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => { markEnded = resolve; });

  const engine: FastVoiceEngine = {
    mode: 'cascade',
    isHealthy: () => true,
    respond: async function* (turn) {
      turns.push(turn);
      yield { type: 'done', fullText: '收到' };
    },
    abortSpeculation: () => {},
  };
  const agent: AgentProvider = {
    name: 'dsh',
    reply: async () => ({ text: '', speech: '' }),
  };

  const dialog = new DialogRuntime({
    clock: new SystemClock(),
    caps: V1_BASELINE,
    agent,
    tts: silentTts(16_000),
    downlink: { sendAudio: () => {}, sendControl: () => {} },
    imageQuestion: '这是什么？',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
      onTurnEnd: () => { markEnded?.(); },
    },
    log: () => {},
    engine,
  });

  try {
    const effects = dialog.dispatch({ type: 'utterance', text: '查一下 Bangumi', utterancePcm: pcm });
    assert.equal(effects.length, 1);
    const effect = effects[0]!;
    assert.equal(effect.type, 'turn');
    if (effect.type === 'turn') {
      assert.equal(effect.utterancePcm, pcm, 'SessionCore 的 turn 效果丢了 utterancePcm');
    }

    await ended;
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.utterancePcm, pcm, '引擎输入 `TurnInput.utterancePcm` 丢了整句 PCM');
  } finally {
    dialog.dispose();
  }
});
