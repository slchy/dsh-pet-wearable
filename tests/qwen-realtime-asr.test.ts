/**
 * DashScope realtime ASR：**端点由我们控**。
 *
 * 这里只验「客户端这一侧的行为」：封段闸（脏标记）、丢弃、事件映射、重连。
 * 真实识别质量与延迟在 `bench/latency/probe-realtime-asr-turn.mjs` 里量。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QwenRealtimeAsr, type RealtimeSocket } from '../src/qwen-realtime-asr.ts';

interface Sent {
  type: string;
  session?: { turn_detection?: unknown };
  audio?: string;
}

class FakeSocket {
  readyState = 0;
  readonly sent: Sent[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...args: unknown[]) => void);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(obj: unknown): void {
    this.emit('message', JSON.stringify(obj));
  }

  types(): string[] {
    return this.sent.map((s) => s.type);
  }
}

const asSocket = (s: FakeSocket): RealtimeSocket => s as unknown as RealtimeSocket;

function make(options: { onSentence?: (t: string, i: number) => void } = {}) {
  const socket = new FakeSocket();
  const sentences: Array<{ text: string; index: number }> = [];
  const partials: string[] = [];
  const errors: string[] = [];
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: (text, index) => {
      sentences.push({ text, index });
      options.onSentence?.(text, index);
    },
    onPartial: (t) => { partials.push(t); },
    onError: (e) => { errors.push(e.message); },
    socketFactory: () => asSocket(socket),
  });
  return { asr, socket, sentences, partials, errors };
}

/** 连上并等到就绪（服务端回 `session.updated`）。 */
async function ready(): Promise<ReturnType<typeof make>> {
  const h = make();
  const connecting = h.asr.connect();
  h.socket.open();
  await connecting;
  h.socket.message({ type: 'session.updated', session: {} });
  return h;
}

test('建会话时关掉服务端 VAD —— 端点归我们', async () => {
  const { socket } = await ready();
  const update = socket.sent.find((s) => s.type === 'session.update');
  assert.ok(update, '要先发 session.update');
  assert.equal(update.session?.turn_detection, null, 'turn_detection 必须是 null，不是窗值');
});

test('没有新音频就 commit = 什么都不发（空缓冲会被服务端拒）', async () => {
  const { asr, socket } = await ready();
  asr.commit();
  assert.deepEqual(socket.types().filter((t) => t.includes('commit')), [], '不该发 commit');
});

test('喂过音频才 commit，同一段只发一次', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640));
  assert.deepEqual(socket.types(), ['session.update', 'input_audio_buffer.append']);

  asr.commit();
  assert.deepEqual(socket.types(), [
    'session.update',
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
  ]);

  asr.commit();
  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
    1,
    '第二段没新音频，不能重复封段',
  );

  // 解码结束之后又来的音频才算**下一段**
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2);
});

test('解码还没回来时喂的音频不算新一段 —— 那一发空 commit 会被服务端拒', async () => {
  // 真机 5 场 5 次 `maybe no invalid audio stream` 全是这个形状：两次封段隔
  // 181–292 ms，中间推了 225–300 ms 音频，但那段音频服务端算进**上一条**缓冲
  // （反证：那 5 次的定稿文本全部完整）。客户端却把它记成新音频 → 提交空缓冲。
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 1);

  // 解码窗口内继续推音频、再封一次段
  asr.feed(Buffer.alloc(640));
  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
    1,
    '这些音频归正在解的那一条，不该再发 commit',
  );

  // 解码结束 → 之后再来音频才允许封段
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2);
});

test('服务端报错之后要重新武装，否则再也 commit 不出去', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640));
  asr.commit();
  socket.message({ type: 'error', error: { message: 'maybe no invalid audio stream' } });
  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2);
});

test('就绪之前到的 commit 会在就绪后补发', async () => {
  const { asr, socket } = make();
  const connecting = asr.connect();
  socket.open();
  await connecting;

  asr.feed(Buffer.alloc(640)); // 还没 session.updated → 进 backlog
  asr.commit(); // 记一笔，等就绪补发
  assert.deepEqual(socket.types(), ['session.update'], '未就绪时一个字都不该发');

  socket.message({ type: 'session.updated', session: {} });
  assert.deepEqual(socket.types(), [
    'session.update',
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
  ]);
});

test('增量（stash）当中间结果，定稿（transcript）带递增句序', async () => {
  const { socket, sentences, partials } = await ready();

  socket.message({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: '嗯' });
  socket.message({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: '嗯，见面了' });
  assert.deepEqual(partials, ['嗯', '嗯，见面了'], '增量在 stash，不是 text');

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯，见面了。' });
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '  ' });
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '下一句。' });
  assert.deepEqual(sentences, [
    { text: '嗯，见面了。', index: 0 },
    { text: '下一句。', index: 2 },
  ], '空定稿不上报，但句序照走');
});

test('discard 只吃掉下一段定稿（打断时用，clear 这个协议没有）', async () => {
  const { asr, socket, sentences } = await ready();
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '第一段。' });

  asr.discard();
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '被打断那段。' });
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '第三段。' });
  assert.deepEqual(sentences.map((s) => s.text), ['第一段。', '第三段。']);
});

test('连接断了之后再喂音频会重连', async () => {
  const sockets: FakeSocket[] = [];
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: () => {},
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return asSocket(s);
    },
  });

  const first = asr.connect();
  sockets[0]?.open();
  await first;
  sockets[0]?.message({ type: 'session.updated', session: {} });
  assert.equal(sockets.length, 1);

  sockets[0]?.close();
  asr.feed(Buffer.alloc(640));
  await new Promise((r) => { setImmediate(r); });
  assert.equal(sockets.length, 2, '断了要自己重建，不能把音频攒进黑洞');
});

test('hangup 只是封段，不关连接（缓冲丢了就再也拿不回来）', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640));
  asr.hangup();
  assert.equal(socket.readyState, 1, '连接必须留着');
  assert.ok(socket.types().includes('input_audio_buffer.commit'));
});

test('建连期间的音频不会把连接摘掉（连上后照常会话）', async () => {
  // 曾经的 bug：`feed()` 里判 `readyState !== OPEN` 就 drop，第一个音频块正好
  // 在建连期间到达 → `this.ws` 被摘空 → 之后 socket 就算连上也没人发
  // session.update，整条会话永远不就绪（真机上表现为「连接超时」）。
  const socket = new FakeSocket();
  let created = 0;
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: () => {},
    socketFactory: () => {
      created += 1;
      return asSocket(socket);
    },
  });

  asr.feed(Buffer.alloc(640)); // 触发 connect（socket 还在 CONNECTING）
  asr.feed(Buffer.alloc(640)); // 建连期间继续来音频
  assert.equal(socket.readyState, 0);
  assert.equal(created, 1, '建连期间不该另开一条');

  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated', session: {} });

  assert.equal(socket.readyState, 1);
  assert.ok(
    socket.types().includes('session.update'),
    '连上之后必须能发会话配置，否则永远不就绪',
  );
  const appends = socket.types().filter((t) => t === 'input_audio_buffer.append').length;
  assert.equal(appends, 2, '建连期间攒下的两块音频要在就绪后补发');

  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.ok(socket.types().includes('input_audio_buffer.commit'), '就绪后照常封段');
});

test('服务端错误转成 onError，不吞', async () => {
  const { socket, errors } = await ready();
  socket.message({ type: 'error', error: { code: 'invalid_value', message: 'boom' } });
  assert.deepEqual(errors, ['服务端错误: boom']);
});

test('解码窗口内喂的音频先存本地，定稿之后补推（服务端会把它丢掉）', async () => {
  // 实测：commit 在飞时 append 的 500 ms 语音，既不进第一段定稿也不进第二段 —— 凭空消失。
  // 所以这一段必须在客户端攒住，等 `.completed` 之后再推。
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640));
  asr.commit();
  const appendsAfterCommit = socket.types().filter((t) => t === 'input_audio_buffer.append').length;

  asr.feed(Buffer.alloc(640));
  asr.feed(Buffer.alloc(640));
  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.append').length,
    appendsAfterCommit,
    '解码窗口内不该直接 append',
  );

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.append').length,
    appendsAfterCommit + 2,
    '定稿之后要把攒下的两帧补推上去',
  );

  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2,
    '补推之后才算新的一段，这时才允许再封段');
});

test('补推出来的音频也要能封段（dirty 由 flush 置位）', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640));
  asr.commit();
  asr.feed(Buffer.alloc(640)); // 攒着
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2);
});
