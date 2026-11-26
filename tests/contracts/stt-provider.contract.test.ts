/**
 * STT provider 的跨实现契约。
 *
 * 真机踩过的边界都收在这里：`close()` 之后再送音频不许再吐转写（否则一轮
 * 已结束的会话还在往组装器里塞句子）、`close()` 必须幂等、支持因果序号的
 * provider 必须单调递增且 `discard()` 后迟到定稿不回调。
 *
 * 全部零真实网络：qwen 用假 socket；aliyun 注入 tokenProvider 且不真正建连。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aliyunStt } from '../../src/aliyun-asr.ts';
import {
  cannedStt,
  noopStt,
  type SttProvider,
  type SttSession,
} from '../../src/providers.ts';
import {
  openaiRealtimeStt,
  qwenRealtimeStt,
  type RealtimeSocket,
} from '../../src/qwen-realtime-asr.ts';

interface Sent {
  readonly type: string;
}

/** qwen 只用到 readyState/send/close/on —— 与生产 `RealtimeSocket` 同形。 */
class FakeSocket {
  readyState = 0;
  readonly sent: Sent[] = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
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

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      (cb as (...values: unknown[]) => void)(...args);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(obj: unknown): void {
    this.emit('message', JSON.stringify(obj));
  }

  types(): string[] {
    return this.sent.map((item) => item.type);
  }
}

const asSocket = (socket: FakeSocket): RealtimeSocket => socket as unknown as RealtimeSocket;

interface Recorder {
  readonly sentences: string[];
  readonly partials: string[];
  readonly errors: string[];
  readonly handlers: {
    onSentence(text: string, index: number, commitSeq?: number): void;
    onPartial(text: string, commitSeq?: number): void;
    onError(error: Error): void;
  };
}

function recorder(): Recorder {
  const sentences: string[] = [];
  const partials: string[] = [];
  const errors: string[] = [];
  return {
    sentences,
    partials,
    errors,
    handlers: {
      onSentence: (text) => { sentences.push(text); },
      onPartial: (text) => { partials.push(text); },
      onError: (error) => { errors.push(error.message); },
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function qwenCase(): { provider: SttProvider; socket: FakeSocket } {
  const socket = new FakeSocket();
  const provider = qwenRealtimeStt({
    apiKey: 'k',
    socketFactory: () => asSocket(socket),
  });
  return { provider, socket };
}

function openaiCase(dialect: 'openai-ga' | 'openai-beta' = 'openai-ga'): {
  provider: SttProvider;
  socket: FakeSocket;
} {
  const socket = new FakeSocket();
  const provider = openaiRealtimeStt({
    apiKey: 'sk-test',
    dialect,
    socketFactory: () => asSocket(socket),
  });
  return { provider, socket };
}

function aliyunCase(): SttProvider {
  return aliyunStt({
    akId: '',
    akSecret: '',
    appkey: 'appkey',
    region: 'cn-shanghai',
    maxSentenceSilenceMs: 200,
    tokenProvider: async () => ({ id: 'token', expireAtSec: Math.floor(Date.now() / 1000) + 3600 }),
  });
}

const FACTORIES: ReadonlyArray<{ name: string; make: () => SttProvider }> = [
  { name: 'noopStt', make: () => noopStt() },
  { name: 'cannedStt', make: () => cannedStt('你好。', 640) },
  { name: 'qwenRealtimeStt', make: () => qwenCase().provider },
  { name: 'openaiRealtimeStt(ga)', make: () => openaiCase('openai-ga').provider },
  { name: 'openaiRealtimeStt(beta)', make: () => openaiCase('openai-beta').provider },
  { name: 'aliyunStt', make: aliyunCase },
];

for (const entry of FACTORIES) {
  test(`${entry.name}：name 非空，close 幂等，close 后不再产生回调`, async () => {
    const provider = entry.make();
    assert.equal(typeof provider.name, 'string');
    assert.ok(provider.name.trim() !== '', 'name 不能为空');

    const rec = recorder();
    const session: SttSession = provider.open(rec.handlers);
    session.close();
    session.close();
    session.close();

    assert.doesNotThrow(() => { session.feed(Buffer.alloc(2048), true); });
    assert.doesNotThrow(() => { session.hangup(); });
    await tick();
    assert.deepEqual(rec.sentences, [], 'close 之后不许再吐定稿');
    assert.deepEqual(rec.partials, [], 'close 之后不许再吐中间结果');
    assert.deepEqual(rec.errors, [], 'close 之后也不许报错');
  });
}

test('qwenRealtimeStt：commitSeq 单调不减，discard 后迟到定稿被丢弃', async () => {
  const { provider, socket } = qwenCase();
  const rec = recorder();
  const session = provider.open(rec.handlers);
  assert.equal(typeof session.commitSeq, 'function');
  assert.equal(typeof session.discard, 'function');
  assert.equal(session.commitSeq?.(), 0);

  session.feed(Buffer.alloc(640), true);
  socket.open();
  await tick();
  socket.message({ type: 'session.updated' });
  assert.equal(session.commitSeq?.(), 0, '就绪本身不占号');

  session.commit?.();
  assert.equal(session.commitSeq?.(), 1);

  // 这一发的结果不要了：迟到的 .completed 必须被吞掉
  session.discard?.();
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '这段该丢。',
  });
  assert.deepEqual(rec.sentences, [], 'discard 之后不许回调 onSentence');
  assert.equal(session.commitSeq?.(), 1, 'discard 不该改序号');

  session.feed(Buffer.alloc(640), true);
  session.commit?.();
  assert.equal(session.commitSeq?.(), 2, '下一发必须继续递增');
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '这段留下。',
  });
  assert.deepEqual(rec.sentences, ['这段留下。']);
  assert.equal(session.commitSeq?.(), 2);

  session.close();
  session.close();
});

test('qwenRealtimeStt：close 后再 feed/hangup 不建连、不回调', async () => {
  const socket = new FakeSocket();
  let made = 0;
  const provider = qwenRealtimeStt({
    apiKey: 'k',
    socketFactory: () => { made += 1; return asSocket(socket); },
  });
  const rec = recorder();
  const session = provider.open(rec.handlers);
  session.close();
  session.feed(Buffer.alloc(640), true);
  session.hangup();
  await tick();

  assert.equal(made, 0, 'close 是吸收态：之后 feed 不许再建连');
  assert.deepEqual(rec.sentences, []);
  assert.deepEqual(rec.errors, []);
});

test('aliyunStt：open 只预取 token，不建 WebSocket；close 幂等', async () => {
  let tokens = 0;
  const provider = aliyunStt({
    akId: '',
    akSecret: '',
    appkey: 'appkey',
    region: 'cn-shanghai',
    tokenProvider: async () => {
      tokens += 1;
      return { id: 'token', expireAtSec: Math.floor(Date.now() / 1000) + 3600 };
    },
  });
  const rec = recorder();
  const session = provider.open(rec.handlers);
  await tick();
  assert.equal(tokens, 1, 'open 只该取一次 token（用户还没开口）');
  session.close();
  session.close();
  assert.doesNotThrow(() => { session.feed(Buffer.alloc(640), true); });
  assert.doesNotThrow(() => { session.hangup(); });
  await tick();
  assert.deepEqual(rec.sentences, []);
});
