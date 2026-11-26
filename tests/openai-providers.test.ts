/**
 * 厂商松绑回归测试：
 * - PCM16 16 kHz ↔ 24 kHz 重采样（零拷贝 / 线性插值 / 边界）
 * - OpenAI-compatible TTS（`/v1/audio/speech` 流式 PCM、奇数字节对齐、情绪指令、中止）
 * - OpenAI Realtime ASR（`openai-ga` / `openai-beta` 握手、16k→24k 上行、`.delta` 累积、能力位）
 * - OpenAI Realtime Live（`OmniShadow` & `omniTts` 三方言协议、GA 事件名、16k 记账 + 24k 发包）
 * - `VoiceConnection` 的 `RealtimeUplinkLane` 端口注入（不依赖具体 `OmniShadow` 类）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveDeviceLink, type DeviceCapabilities } from '../src/devices/index.ts';
import { UpstreamFrameType } from '../src/frame.ts';
import { newActivityState } from '../src/keepalive.ts';
import { OmniShadow } from '../src/omni-shadow.ts';
import { omniTts, type RealtimeLike } from '../src/omni-tts.ts';
import { openAiTts, OpenAiTtsError } from '../src/openai-tts.ts';
import { resamplePcm16Mono } from '../src/pcm-resample.ts';
import {
  cannedStt,
  echoAgent,
  silentTts,
  type AgentAudioAnswer,
  type AgentProvider,
  type FastLaneAudioLane,
  type RealtimeUplinkLane,
} from '../src/providers.ts';
import {
  openaiRealtimeStt,
  qwenRealtimeStt,
  type RealtimeSocket,
} from '../src/qwen-realtime-asr.ts';
import {
  buildRealtimeResponseCreate,
  buildRealtimeWsUrl,
  resolveRealtimeDialect,
} from '../src/realtime-dialect.ts';
import {
  assemblePipelinePlan,
  assembleStreamingAgent,
} from '../src/runtime/pipeline-assembly.ts';
import { buildStt, buildTts } from '../src/runtime/providers-factory.ts';
import { startToolControl } from '../src/tool-control.ts';
import type { Connection, ConnectionHandlers } from '../src/transport.ts';
import { resolveLiveApiKey, resolveOmniApiKey } from '../src/voice-config.ts';
import {
  VoiceConnection,
  type VoiceService,
  type VoiceSessionOptions,
} from '../src/voice-session.ts';

interface WireMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

class FakeRealtimeSocket {
  readyState = 0;
  readonly sent: WireMessage[] = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WireMessage);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      (cb as (...values: unknown[]) => void)(...args);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function makeConstantPcm16(samples: number, value: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------- PCM 重采样

test('resamplePcm16Mono：同采样率零拷贝，16k→24k 与 24k→16k 长度与数值正确', () => {
  const same = makeConstantPcm16(320, 1234);
  assert.equal(resamplePcm16Mono(same, 16_000, 16_000), same, '同采样率必须零拷贝返回原 Buffer');

  assert.equal(resamplePcm16Mono(Buffer.alloc(0), 16_000, 24_000).length, 0);
  assert.equal(resamplePcm16Mono(Buffer.from([0x7f]), 16_000, 24_000).length, 0);

  // 20 ms @ 16 kHz = 320 采样 (640 B) → 20 ms @ 24 kHz = 480 采样 (960 B)
  const up = resamplePcm16Mono(same, 16_000, 24_000);
  assert.equal(up.length, 960);
  for (let i = 0; i < 480; i += 1) {
    assert.equal(up.readInt16LE(i * 2), 1234);
  }

  // 线性斜坡插值校验：0, 300, 600, 900 → 1.5x 输出首几个点应单调且落在线性段内
  const ramp = Buffer.alloc(8);
  ramp.writeInt16LE(0, 0);
  ramp.writeInt16LE(300, 2);
  ramp.writeInt16LE(600, 4);
  ramp.writeInt16LE(900, 6);
  const upRamp = resamplePcm16Mono(ramp, 16_000, 24_000);
  assert.equal(upRamp.length, 12);
  assert.equal(upRamp.readInt16LE(0), 0);
  assert.equal(upRamp.readInt16LE(2), 200);
  assert.equal(upRamp.readInt16LE(4), 400);
  assert.equal(upRamp.readInt16LE(6), 600);

  // 24k → 16k 下采样长度：960 B → 640 B
  const down = resamplePcm16Mono(up, 24_000, 16_000);
  assert.equal(down.length, 640);
  assert.equal(down.readInt16LE(0), 1234);

  assert.throws(() => resamplePcm16Mono(same, 0, 24_000), RangeError);
  assert.throws(() => resamplePcm16Mono(same, 16_000, -1), RangeError);
});

// ---------------------------------------------------------------- RealtimeDialect 辅助

test('RealtimeDialect：方言解析、URL 拼接、response.create 与 key 优先级', () => {
  assert.equal(resolveRealtimeDialect(undefined, undefined), 'dashscope');
  assert.equal(resolveRealtimeDialect('qwen'), 'dashscope');
  assert.equal(resolveRealtimeDialect('openai-beta'), 'openai-beta');
  assert.equal(resolveRealtimeDialect('beta'), 'openai-beta');
  assert.equal(resolveRealtimeDialect('openai-ga'), 'openai-ga');
  assert.equal(resolveRealtimeDialect('openai'), 'openai-ga');
  assert.equal(resolveRealtimeDialect(undefined, 'wss://api.openai.com/v1/realtime'), 'openai-ga');
  assert.equal(resolveRealtimeDialect(undefined, 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'), 'dashscope');
  assert.throws(() => resolveRealtimeDialect('unknown-vendor'), /不支持的 Realtime 协议方言/);

  assert.equal(
    buildRealtimeWsUrl('wss://api.openai.com/v1/realtime', { model: 'gpt-realtime' }),
    'wss://api.openai.com/v1/realtime?model=gpt-realtime',
  );
  assert.equal(
    buildRealtimeWsUrl('wss://proxy.example/rt?api-version=2025-04-01&model=keep', { model: 'ignored', intent: 'transcription' }),
    'wss://proxy.example/rt?api-version=2025-04-01&model=keep&intent=transcription',
  );

  assert.deepEqual(buildRealtimeResponseCreate('dashscope', true), {
    type: 'response.create',
    response: { modalities: ['audio', 'text'] },
  });
  assert.deepEqual(buildRealtimeResponseCreate('openai-beta', true), {
    type: 'response.create',
    response: { modalities: ['audio', 'text'] },
  });
  assert.deepEqual(buildRealtimeResponseCreate('openai-ga', true), {
    type: 'response.create',
    response: { output_modalities: ['audio'] },
  });
  assert.deepEqual(buildRealtimeResponseCreate('openai-ga', false), {
    type: 'response.create',
  });

  // key 解析优先级与方言隔离
  assert.equal(resolveLiveApiKey({ LIVE_API_KEY: '  live  ', OMNI_API_KEY: 'omni' }), 'live');
  assert.equal(resolveOmniApiKey({ LIVE_API_KEY: 'live' }), 'live');
  assert.equal(
    resolveLiveApiKey({ LIVE_DIALECT: 'openai-ga', OPENAI_API_KEY: 'sk-o', DASHSCOPE_API_KEY: 'sk-d' }),
    'sk-o',
  );
  assert.equal(
    resolveLiveApiKey({ OPENAI_API_KEY: 'sk-o', DASHSCOPE_API_KEY: 'sk-d' }),
    'sk-d',
  );
  assert.equal(
    resolveLiveApiKey({ OPENAI_API_KEY: 'sk-o' }),
    '',
  );
});

// ---------------------------------------------------------------- OpenAI-compatible TTS

test('openAiTts：请求格式、情绪指令合并、奇数字节对齐流式输出与错误处理', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

  const tts = openAiTts({
    apiKey: 'sk-tts-test',
    baseUrl: 'https://tts.example/v1/',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    instructions: '语速自然。',
    emotionInstructions: { happy: '语气轻快开心。' },
    speed: 1.1,
    fetchImpl: async (input, init) => {
      seen.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      // 故意切成 3 字节 + 3 字节，验证 PCM16 帧偶数字节对齐
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    },
  });

  assert.equal(tts.name, 'openai-tts:gpt-4o-mini-tts');
  assert.equal(tts.sampleRate, 24_000);

  const chunks: Buffer[] = [];
  for await (const chunk of tts.synthesize('你好世界', 'happy')) {
    assert.equal(chunk.length % 2, 0, '每块 PCM16 必须偶数字节对齐');
    chunks.push(chunk);
  }
  assert.deepEqual([...Buffer.concat(chunks)], [1, 2, 3, 4, 5, 6]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://tts.example/v1/audio/speech');
  assert.equal(seen[0]?.headers['Authorization'], 'Bearer sk-tts-test');
  assert.deepEqual(seen[0]?.body, {
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    input: '你好世界',
    response_format: 'pcm',
    instructions: '语速自然。 语气轻快开心。',
    speed: 1.1,
  });

  // HTTP 失败抛 OpenAiTtsError
  const failing = openAiTts({
    apiKey: 'sk-bad',
    fetchImpl: async () => new Response('invalid api key', { status: 401 }),
  });
  await assert.rejects(async () => {
    for await (const _chunk of failing.synthesize('你好')) {
      // 不应到达
    }
  }, (error: unknown) => error instanceof OpenAiTtsError && /401/.test(error.message));

  // close() 中止在途请求
  let aborted = false;
  const slow = openAiTts({
    apiKey: 'sk-slow',
    fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }),
  });
  const pending = (async () => {
    for await (const _chunk of slow.synthesize('等等')) {
      // 不应到达
    }
  })();
  await tick();
  slow.close?.();
  await assert.rejects(pending);
  assert.equal(aborted, true);
});

// ---------------------------------------------------------------- OpenAI Realtime ASR

test('openaiRealtimeStt(openai-ga)：intent=transcription、无 Beta 头、16k→24k 上行与 .delta 累积', async () => {
  const socket = new FakeRealtimeSocket();
  let capturedUrl = '';
  let capturedHeaders: Readonly<Record<string, string>> | undefined;

  const provider = openaiRealtimeStt({
    apiKey: 'sk-asr-ga',
    dialect: 'openai-ga',
    model: 'gpt-4o-transcribe',
    language: 'zh',
    corpusText: '深言科技 桌宠',
    socketFactory: (url, _apiKey, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return socket as unknown as RealtimeSocket;
    },
  });

  assert.equal(provider.name, 'openai-realtime:gpt-4o-transcribe');
  assert.equal(provider.supportsManualEndpoint, true);

  const partials: Array<{ text: string; seq?: number }> = [];
  const sentences: Array<{ text: string; seq?: number }> = [];
  const session = provider.open({
    onPartial: (text, commitSeq) => { partials.push({ text, seq: commitSeq }); },
    onSentence: (text, _index, commitSeq) => { sentences.push({ text, seq: commitSeq }); },
  });

  // 16 kHz / 20 ms = 640 B
  session.feed(makeConstantPcm16(320, 500), true);
  socket.open();
  await tick();

  assert.equal(capturedUrl, 'wss://api.openai.com/v1/realtime?intent=transcription');
  assert.equal(capturedHeaders?.['Authorization'], 'Bearer sk-asr-ga');
  assert.equal(capturedHeaders?.['OpenAI-Beta'], undefined);

  assert.deepEqual(socket.sent[0], {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: {
            model: 'gpt-4o-transcribe',
            language: 'zh',
            prompt: '深言科技 桌宠',
          },
          turn_detection: null,
        },
      },
    },
  });

  socket.message({ type: 'session.updated' });
  const appendMsg = socket.sent.find((m) => m.type === 'input_audio_buffer.append');
  assert.ok(appendMsg !== undefined);
  const wirePcm = Buffer.from(String(appendMsg['audio']), 'base64');
  assert.equal(wirePcm.length, 960, '16 kHz 640 B 应重采样为 24 kHz 960 B');
  assert.equal(wirePcm.readInt16LE(0), 500);

  session.commit?.();
  assert.equal(session.commitSeq?.(), 1);

  socket.message({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好' });
  socket.message({ type: 'conversation.item.input_audio_transcription.delta', delta: '世界' });
  assert.deepEqual(partials, [
    { text: '你好', seq: 1 },
    { text: '你好世界', seq: 1 },
  ]);

  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '你好世界。',
  });
  assert.deepEqual(sentences, [{ text: '你好世界。', seq: 1 }]);

  // 下一句 delta 不应残留上一句的 partialBuffer
  session.feed(makeConstantPcm16(320, 300), true);
  session.commit?.();
  socket.message({ type: 'conversation.item.input_audio_transcription.delta', delta: '第二句' });
  assert.equal(partials[2]?.text, '第二句');
  assert.equal(partials[2]?.seq, 2);

  session.close();
});

test('openaiRealtimeStt(openai-beta)：带 OpenAI-Beta 头、transcription_session.update 与 vad 能力位', async () => {
  const socket = new FakeRealtimeSocket();
  let capturedHeaders: Readonly<Record<string, string>> | undefined;

  const manualProvider = openaiRealtimeStt({
    apiKey: 'sk-asr-beta',
    dialect: 'openai-beta',
    corpusText: '莱姆 其主之声',
    socketFactory: (_url, _apiKey, headers) => {
      capturedHeaders = headers;
      return socket as unknown as RealtimeSocket;
    },
  });
  assert.equal(manualProvider.supportsManualEndpoint, true);

  const vadProvider = openaiRealtimeStt({
    apiKey: 'sk-asr-beta',
    dialect: 'openai-beta',
    turnDetection: 'vad',
  });
  assert.equal(vadProvider.supportsManualEndpoint, false);
  assert.equal(qwenRealtimeStt({ apiKey: 'k', turnDetection: 'manual' }).supportsManualEndpoint, true);
  assert.equal(qwenRealtimeStt({ apiKey: 'k', turnDetection: 'vad' }).supportsManualEndpoint, false);

  const session = manualProvider.open({ onSentence: () => {} });
  session.feed(makeConstantPcm16(320, 400), true);
  socket.open();
  await tick();

  assert.equal(capturedHeaders?.['OpenAI-Beta'], 'realtime=v1');
  assert.deepEqual(socket.sent[0], {
    type: 'transcription_session.update',
    session: {
      input_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'gpt-4o-mini-transcribe',
        prompt: '莱姆 其主之声',
      },
      turn_detection: null,
    },
  });

  // OpenAI Beta 回执事件名为 transcription_session.updated
  socket.message({ type: 'transcription_session.updated' });
  const appendMsg = socket.sent.find((m) => m.type === 'input_audio_buffer.append');
  assert.ok(appendMsg !== undefined, '收到 transcription_session.updated 后应冲刷 backlog');
  assert.equal(Buffer.from(String(appendMsg['audio']), 'base64').length, 960);

  session.close();
});

// ---------------------------------------------------------------- OmniShadow OpenAI Realtime 方言

test('OmniShadow(openai-beta)：OpenAI-Beta 头、pcm16 会话、24k 上行重采样且 16k 时长记账不变', async () => {
  const socket = new FakeRealtimeSocket();
  const events: Array<Record<string, unknown>> = [];
  let capturedUrl = '';
  let capturedHeaders: Readonly<Record<string, string>> | undefined;
  let clock = 1000;

  const shadow = new OmniShadow({
    apiKey: 'sk-live-beta',
    dialect: 'openai-beta',
    voice: 'verse',
    asrLanguage: 'zh',
    asrCorpusText: '桌宠 语音',
    serve: 'full',
    now: () => clock,
    emit: (data) => { events.push(data); },
    socketFactory: (url, _apiKey, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return socket as unknown as RealtimeSocket;
    },
  });

  shadow.start();
  socket.open();
  assert.equal(capturedUrl, 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview');
  assert.equal(capturedHeaders?.['Authorization'], 'Bearer sk-live-beta');
  assert.equal(capturedHeaders?.['OpenAI-Beta'], 'realtime=v1');

  const update = socket.sent[0] as { type: string; session: Record<string, unknown> };
  assert.equal(update.type, 'session.update');
  assert.equal(update.session['voice'], 'verse');
  assert.equal(update.session['input_audio_format'], 'pcm16');
  assert.equal(update.session['output_audio_format'], 'pcm16');
  assert.deepEqual(update.session['input_audio_transcription'], {
    model: 'gpt-4o-mini-transcribe',
    language: 'zh',
    prompt: '桌宠 语音',
  });
  assert.ok(Array.isArray(update.session['tools']), 'serve=full 应挂载 delegate 工具');

  socket.message({ type: 'session.updated' });
  // 推 100 ms @ 16 kHz = 3200 B → 线上应发 4800 B @ 24 kHz，但 seal_s 仍按 16 kHz = 0.1 s 记账
  shadow.restart([]);
  shadow.feed(makeConstantPcm16(1600, 777), true);
  const appendMsg = socket.sent.find((m) => m.type === 'input_audio_buffer.append');
  assert.ok(appendMsg !== undefined);
  assert.equal(Buffer.from(String(appendMsg['audio']), 'base64').length, 4800);

  shadow.seal(1, 20);
  const answer = shadow.claim();
  assert.ok(answer !== null);
  clock += 120;
  socket.message({ type: 'response.created' });
  socket.message({ type: 'response.audio_transcript.delta', delta: '好的' });
  socket.message({ type: 'response.audio.delta', delta: Buffer.from([10, 20, 30, 40]).toString('base64') });
  socket.message({ type: 'response.done', response: { status: 'completed', output: [] } });

  const out: Buffer[] = [];
  for await (const chunk of answer.chunks) out.push(chunk);
  assert.deepEqual([...Buffer.concat(out)], [10, 20, 30, 40]);
  assert.equal(answer.transcript(), '好的');
  assert.equal(events[0]?.['seal_s'], 0.1);

  shadow.stop();
});

test('OmniShadow(openai-ga)：GA session.update、output_audio/output_audio_transcript/item.added 与 output_modalities', async () => {
  const socket = new FakeRealtimeSocket();
  let capturedUrl = '';
  let capturedHeaders: Readonly<Record<string, string>> | undefined;

  const shadow = new OmniShadow({
    apiKey: 'sk-live-ga',
    dialect: 'openai-ga',
    voice: 'marin',
    asrCorpusText: '深言',
    serve: 'full',
    emit: () => {},
    socketFactory: (url, _apiKey, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return socket as unknown as RealtimeSocket;
    },
  });

  shadow.start();
  socket.open();
  assert.equal(capturedUrl, 'wss://api.openai.com/v1/realtime?model=gpt-realtime');
  assert.equal(capturedHeaders?.['OpenAI-Beta'], undefined);

  const update = socket.sent[0] as { type: string; session: Record<string, unknown> };
  assert.equal(update.type, 'session.update');
  assert.equal(update.session['type'], 'realtime');
  assert.deepEqual(update.session['output_modalities'], ['audio']);
  assert.deepEqual(update.session['audio'], {
    input: {
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: {
        model: 'gpt-4o-mini-transcribe',
        prompt: '深言',
      },
      turn_detection: null,
    },
    output: {
      format: { type: 'audio/pcm', rate: 24_000 },
      voice: 'marin',
    },
  });

  socket.message({ type: 'session.updated' });

  // speakFromText 在 GA 下应发 output_modalities: ['audio']，并认 conversation.item.added 与 response.output_audio.delta
  const bg = shadow.speakFromText('任务完成了');
  assert.ok(bg !== null);
  const createMsg = socket.sent.find((m) => m.type === 'response.create');
  assert.deepEqual(createMsg, {
    type: 'response.create',
    response: { output_modalities: ['audio'] },
  });

  socket.message({ type: 'conversation.item.added', item: { id: 'u-ga-1', role: 'user' } });
  socket.message({ type: 'response.created' });
  socket.message({ type: 'response.output_audio_transcript.delta', delta: '已完成' });
  socket.message({ type: 'response.output_audio.delta', delta: Buffer.from([7, 8, 9, 10]).toString('base64') });
  socket.message({
    type: 'response.done',
    response: { status: 'completed', output: [{ id: 'a-ga-1', role: 'assistant' }] },
  });

  const chunks: Buffer[] = [];
  for await (const chunk of bg.chunks) chunks.push(chunk);
  assert.deepEqual([...Buffer.concat(chunks)], [7, 8, 9, 10]);
  assert.equal(bg.transcript(), '已完成');
  // 临时 prompt 的 user item 应在 response.done 时被删除
  assert.ok(
    socket.sent.some((m) => m.type === 'conversation.item.delete' && m['item_id'] === 'u-ga-1'),
    'GA 的 conversation.item.added 应正确记录 userItemId 并在 done 时删掉临时提示',
  );

  shadow.stop();
});

test('omniTts(openai-ga)：GA session.update、response.output_audio.delta 与 item.added 清理', async () => {
  const socket = new FakeRealtimeSocket();
  const tts = omniTts({
    apiKey: 'sk-ga-reader',
    dialect: 'openai-ga',
    voice: 'alloy',
    socketFactory: () => {
      queueMicrotask(() => { socket.open(); });
      return socket as unknown as RealtimeLike;
    },
  });

  const origSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    origSend(data);
    const ev = JSON.parse(data) as WireMessage;
    if (ev.type === 'session.update') {
      socket.message({ type: 'session.updated' });
    } else if (ev.type === 'response.create') {
      socket.message({ type: 'conversation.item.added', item: { id: 'u-1', role: 'user' } });
      socket.message({ type: 'response.created' });
      socket.message({ type: 'response.output_audio.delta', delta: Buffer.from([5, 6]).toString('base64') });
      socket.message({
        type: 'response.done',
        response: { status: 'completed', output: [{ id: 'a-1', role: 'assistant' }] },
      });
    }
  };

  const out: Buffer[] = [];
  for await (const chunk of tts.synthesize('请朗读这一句')) {
    out.push(chunk);
  }
  assert.deepEqual([...Buffer.concat(out)], [5, 6]);
  const update = socket.sent[0] as unknown as { session: Record<string, unknown> };
  assert.equal(update.session['type'], 'realtime');
  tts.close?.();
});

// ---------------------------------------------------------------- 工厂与管道装配

test('buildStt(openai-realtime) / buildTts(openai) / assembleStreamingAgent(LIVE_DIALECT=openai-ga)', async () => {
  const saved = {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    OPENAI_ASR_API_KEY: process.env['OPENAI_ASR_API_KEY'],
    OPENAI_TTS_API_KEY: process.env['OPENAI_TTS_API_KEY'],
    OPENAI_TTS_MODEL: process.env['OPENAI_TTS_MODEL'],
  };
  try {
    delete process.env['OPENAI_ASR_API_KEY'];
    delete process.env['OPENAI_TTS_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-factory-test';
    process.env['OPENAI_TTS_MODEL'] = 'tts-1';

    const stt = await buildStt('openai-realtime', {
      akId: '',
      akSecret: '',
      appkey: '',
      region: 'cn-shanghai',
      maxSentenceSilenceMs: 200,
    });
    assert.equal(stt.name, 'openai-realtime:gpt-4o-mini-transcribe');
    assert.equal(stt.supportsManualEndpoint, true);

    const tts = await buildTts('openai');
    assert.equal(tts.name, 'openai-tts:tts-1');
    assert.equal(tts.sampleRate, 24_000);
    tts.close?.();

    const env = {
      VOICE_PIPELINE: 'live',
      LIVE_DIALECT: 'openai-ga',
      LIVE_MODEL: 'gpt-realtime',
      LIVE_VOICE: 'marin',
      OPENAI_API_KEY: 'sk-openai-live',
    };
    const plan = assemblePipelinePlan(env, {
      sttName: 'openai-realtime',
      sttSupportsManualEndpoint: stt.supportsManualEndpoint,
      strict: true,
    });
    assert.equal(plan.mode, 'live');
    const assembled = assembleStreamingAgent({
      plan,
      env,
      dshAgent: echoAgent(),
      tts: silentTts(24_000),
      activity: newActivityState(Date.now()),
      memory: () => '',
      taskStatus: () => '',
      audit: () => {},
      speculate: false,
      log: () => {},
    });
    assert.equal(assembled.omniShadow?.dialect, 'openai-ga');
    assert.equal(assembled.omniShadow?.model, 'gpt-realtime');
    assert.equal(assembled.omniShadow?.voice, 'marin');
    assert.equal(assembled.omniShadow?.apiKey, 'sk-openai-live');
    assembled.dispose();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------- VoiceConnection 端口解耦

test('VoiceConnection：通过 realtimeLane 端口接入自定义 RealtimeUplinkLane，无需 OmniShadow 实例', async () => {
  const calls: string[] = [];
  let attachedLane: FastLaneAudioLane | null = null;

  const customLane: RealtimeUplinkLane = {
    currentState: 'ready',
    start: () => { calls.push('start'); },
    stop: () => { calls.push('stop'); },
    restart: () => { calls.push('restart'); },
    feed: () => { calls.push('feed'); },
    seal: (seq) => { calls.push(`seal:${seq}`); },
    willServe: () => true,
    claim: (): AgentAudioAnswer | null => null,
    discard: () => { calls.push('discard'); },
  };

  const agent: AgentProvider = {
    name: 'lane-spy',
    attachAudioLane: (lane) => {
      attachedLane = lane;
      calls.push(lane === null ? 'detach' : 'attach');
    },
    reply: async (text) => ({ text, speech: text }),
  };

  const bound: { current: ConnectionHandlers | null } = { current: null };
  let closed = false;
  const conn = {
    remote: '127.0.0.1:9999',
    get isClosed() { return closed; },
    bind(h: ConnectionHandlers) { bound.current = h; },
    sendAudio() {},
    sendControl() {},
    sendWelcome() {},
    sendCall() {},
    end() { closed = true; },
  } as unknown as Connection;

  const control = startToolControl({ port: 0, photoTimeoutMs: 1_000, handlers: null });
  try {
    const service: VoiceService = { control, activeSlot: { current: null } };
    const caps: DeviceCapabilities = {
      audioIn: 'pcm16',
      capture: {},
      presence: false,
      power: false,
      summon: false,
      listenStart: false,
      played: false,
      ignorePhrases: [],
    };
    const link = resolveDeviceLink({ proto: 2, capabilities: caps });
    const options: VoiceSessionOptions = {
      port: 0,
      host: '127.0.0.1',
      ffmpegPath: 'ffmpeg',
      agent,
      stt: cannedStt(),
      tts: silentTts(24_000),
      pipelineMode: 'live',
      realtimeLane: {
        serve: 'full',
        create: () => customLane,
      },
      gate: { thresholdDbfs: -40, holdMs: 200, prerollMs: 100 },
      playbackTailMs: 0,
      archiveDir: '',
      archiveMaxMb: 1,
      archiveKeep: 1,
      photoDir: '',
      controlPort: 0,
      photoTimeoutMs: 5_000,
      imageQuestion: '这张图里有什么？',
    };

    const vc = new VoiceConnection(conn, options, link, service);
    service.activeSlot.current = vc;
    vc.start();

    assert.equal(attachedLane, customLane, 'VoiceConnection 应把自定义 RealtimeUplinkLane 挂到 agent');
    assert.deepEqual(calls.slice(0, 2), ['start', 'attach']);

    // 连续推多帧响亮 PCM16 跨过两帧去抖，触发能量门打开 → restart + feed
    const loud = Buffer.alloc(640);
    for (let i = 0; i < 320; i += 1) {
      loud.writeInt16LE(i % 2 === 0 ? 12_000 : -12_000, i * 2);
    }
    for (let f = 0; f < 4; f += 1) {
      bound.current?.onFrame(UpstreamFrameType.Audio, loud);
    }
    assert.ok(calls.includes('restart'), '开门后应转发 restart 到自定义端口');
    assert.ok(calls.includes('feed'), '上行音频应转发 feed 到自定义端口');

    closed = true;
    bound.current?.onClose('socket closed');
    assert.equal(attachedLane, null, '断开时应摘掉自定义端口');
    assert.ok(calls.includes('stop'), '断开时应调用 stop()');
  } finally {
    control.close();
  }
});
