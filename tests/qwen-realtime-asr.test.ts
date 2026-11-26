/**
 * DashScope realtime ASR：**端点由我们控**。
 *
 * 这里只验「客户端这一侧的行为」：封段闸（脏标记）、丢弃、事件映射、重连。
 * 真实识别质量与延迟在 `bench/latency/probe-realtime-asr-turn.mjs` 里量。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QwenRealtimeAsr,
  isCorpusEcho,
  mergeCorpusText,
  qwenRealtimeStt,
  type RealtimeSocket,
} from '../src/qwen-realtime-asr.ts';

interface Sent {
  type: string;
  session?: {
    modalities?: string[];
    input_audio_format?: string;
    turn_detection?: unknown;
    input_audio_transcription?: {
      model?: string;
      language?: string;
      corpus?: { text?: string };
    };
  };
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

function make(options: {
  onSentence?: (t: string, i: number) => void;
  decodeTimeoutMs?: number;
} = {}) {
  const socket = new FakeSocket();
  const sentences: Array<{ text: string; index: number }> = [];
  /** 每条定稿带出来的因果出生证（`undefined` = provider 不提供） */
  const sentenceStamps: Array<number | undefined> = [];
  const partials: string[] = [];
  const partialStamps: Array<number | undefined> = [];
  const errors: string[] = [];
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: (text, index, commitSeq) => {
      sentences.push({ text, index });
      sentenceStamps.push(commitSeq);
      options.onSentence?.(text, index);
    },
    onPartial: (t, commitSeq) => {
      partials.push(t);
      partialStamps.push(commitSeq);
    },
    onError: (e) => { errors.push(e.message); },
    decodeTimeoutMs: options.decodeTimeoutMs,
    socketFactory: () => asSocket(socket),
  });
  return { asr, socket, sentences, sentenceStamps, partials, partialStamps, errors };
}

/** 连上并等到就绪（服务端回 `session.updated`）。 */
async function ready(
  options: { decodeTimeoutMs?: number } = {},
): Promise<ReturnType<typeof make>> {
  const h = make(options);
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

test('解码窗口里的纯尾静音不许补推（补上去会换一句幻觉的「嗯。」）', async () => {
  // 每轮正常对话都在这个形状里：封段 → 能量门还要 2 s 才关 → 窗口里灌进 ~260 ms 尾静音。
  // 实测 150 ms 纯静音就能让 DashScope 吐一个「嗯。」定稿。
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  const before = socket.types().filter((t) => t === 'input_audio_buffer.append').length;
  for (let i = 0; i < 13; i += 1) asr.feed(Buffer.alloc(640), false); // 260 ms 静音
  asr.commit(); // 延后，等定稿
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好。' });

  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.append').length, before,
    '窗口里全是静音，一个字都不该补推');
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 1,
    '延后的那发也要落空：没有语音可封段');
});

test('窗口里先说了话、再灌尾静音：静音不许跟着补推（真机 320 ms 就换一句幻觉定稿）', async () => {
  // `20261123-051448`：第 4 轮补推 16 帧后吐 `Okay.`、第 6 轮 16 帧后 `Thank you.`、
  // 第 7 轮 14 帧后 `嗯。` —— 那 16 帧里绝大部分是封段之后的尾静音。
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  const before = socket.types().filter((t) => t === 'input_audio_buffer.append').length;

  asr.feed(Buffer.alloc(640, 1), true); // 解码期又开口
  for (let i = 0; i < 16; i += 1) asr.feed(Buffer.alloc(640), false); // 320 ms 尾静音
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '我刚下班回来。' });

  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.append').length - before,
    1,
    '只补推那一帧有声，尾静音一个字节都不许跟着上去',
  );
});

test('封段之后的尾静音不点亮 dirty —— gate.close 的 hangup 不该再 commit', async () => {
  // 真机 `20261123-051448` 第 5 轮：第 4 轮刚被打断，2 s 后 gate.close 挂断时又 commit 了一发，
  // 纯静音封出定稿 `Okay.`，白开一轮（还掉回级联）。
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '我刚下班回来。' });
  const commits = socket.types().filter((t) => t === 'input_audio_buffer.commit').length;
  const appends = socket.types().filter((t) => t === 'input_audio_buffer.append').length;

  for (let i = 0; i < 100; i += 1) asr.feed(Buffer.alloc(640), false); // 能量门 hold 的 2 s 静音
  asr.hangup(); // == gate.close

  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
    commits,
    '没有新的人声就不该封段',
  );
  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.append').length,
    appends,
    '尾静音也不该进缓冲（进去就会改变解码上下文）',
  );
});

test('解码窗口里真说了话：补推之后要补发延后的 commit（否则尾巴会粘到下一句句头）', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 1);

  asr.feed(Buffer.alloc(640), false); // 静音（进 ring）
  asr.feed(Buffer.alloc(640), true); // 又开口 → ring 转正
  asr.feed(Buffer.alloc(640), true);
  asr.commit(); // 撞在解码期 → 延后
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 1,
    '解码期不该发第二发');

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2,
    '补推之后必须补发延后的 commit，否则这段语音会悬到下一句');
});

test('软起音：窗口里先到几帧静音、再开口 → ring 里那几帧要一起转正', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  const before = socket.types().filter((t) => t === 'input_audio_buffer.append').length;
  asr.feed(Buffer.alloc(640), false);
  asr.feed(Buffer.alloc(640), false);
  asr.feed(Buffer.alloc(640), true);
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.append').length, before + 3,
    '2 帧静音 + 1 帧有声都该补推');
});

test('断连时把窗口暂存一起清掉，别漏进下一句', async () => {
  const { asr, socket } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  asr.feed(Buffer.alloc(640), true); // 攒了一份
  socket.close();
  // 重连之后的新会话不该背着上一句的尾巴
  const connecting = asr.connect();
  socket.open();
  await connecting;
  socket.message({ type: 'session.updated', session: {} });
  const before = socket.types().filter((t) => t === 'input_audio_buffer.append').length;
  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.append').length, before + 1,
    '只有新喂的这一帧');
});

// ------------------------------------------------------- commitSeq：因果出生证
//
// 这份账以前由宿主自己维护（`commit()` 一被调就 +1），三处会静默失步：
// 跳过/延后时虚增、`hangup()` 时漏增、`flushHeld()` 之后先于定稿交付改了号。
// 现在号源**只有一处**：真正写进 WebSocket 的那一刻。

test('commitSeq 只在真发出 commit 时 +1 —— 跳过和延后都不占号', async () => {
  const { asr, socket } = await ready();
  assert.equal(asr.commitSeq(), 0, '从 0 起');

  asr.commit(); // 空缓冲 → 闸掉
  assert.equal(
    socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
    0,
  );
  assert.equal(asr.commitSeq(), 0, '跳过的那一发不许虚增');

  asr.feed(Buffer.alloc(640));
  asr.commit();
  assert.equal(asr.commitSeq(), 1);

  asr.feed(Buffer.alloc(640), true); // 解码窗口里又开口 → 攒住
  asr.commit(); // 撞在解码期 → 延后
  assert.equal(asr.commitSeq(), 1, '延后的要等 flushHeld 真发出去才占号');

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯。' });
  assert.equal(asr.commitSeq(), 2, '定稿之后补发的延后 commit 才 +1');
});

test('hangup 真发出 commit 时要占号 —— 定稿带回来的就是这个号', async () => {
  // 以前 `hangup()` 走的是同一条 `commit()`，但号记在宿主那边、只在组装器封段时 +1，
  // 所以 gate.close 封出来的这一段拿不到出生证。
  const { asr, socket, sentences, sentenceStamps } = await ready();
  asr.feed(Buffer.alloc(640), true);
  asr.hangup(); // == gate.close
  assert.equal(asr.commitSeq(), 1, 'hangup 走的也是 commit()，不能漏号');

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好。' });
  assert.deepEqual(sentences, [{ text: '你好。', index: 0 }]);
  assert.deepEqual(sentenceStamps, [1], '这条定稿的出生证就是 hangup 那一发');
});

test('延后的 commit：定稿交付旧段序号，下一发在交付之后才占号', async () => {
  // 关键顺序缺陷：`.completed` 里若先 `flushHeld()`，它会立刻补发延后的下一发、
  // 把 `awaitingDecode` 置回 true、把号改写 —— 那条定稿于是戴着下一段的出生证。
  const socket = new FakeSocket();
  let asr: QwenRealtimeAsr;
  /** 交付定稿那一刻的三个事实：出生证 / 已发出的号 / 已发出的 commit 条数 */
  const atSentence: Array<{ stamp: number | undefined; seq: number; commits: number }> = [];
  asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: (_text, _index, commitSeq) => {
      atSentence.push({
        stamp: commitSeq,
        seq: asr.commitSeq(),
        commits: socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
      });
    },
    socketFactory: () => asSocket(socket),
  });
  const connecting = asr.connect();
  socket.open();
  await connecting;
  socket.message({ type: 'session.updated', session: {} });

  asr.feed(Buffer.alloc(640), true);
  asr.commit(); // 1 号，开始解码
  asr.feed(Buffer.alloc(640), true); // 窗口里真说了话
  asr.commit(); // 只能延后
  assert.equal(asr.commitSeq(), 1);
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 1);

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '第一段。' });
  assert.deepEqual(
    atSentence,
    [{ stamp: 1, seq: 1, commits: 1 }],
    '交付旧段时还是 1 号，延后的下一发还没发出',
  );
  assert.equal(asr.commitSeq(), 2, '下一发在交付之后才占号');
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 2);
});

test('onPartial 的出生证：解码期属于当前那一发，空闲新开口属于下一发', async () => {
  const { asr, socket, partialStamps } = await ready();
  assert.equal(asr.commitSeq(), 0);

  // 还没封过段：用户新开口的增量属于**下一发**（1 号）
  socket.message({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: '嗯' });
  assert.deepEqual(partialStamps, [1]);

  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  socket.message({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: '嗯，见' });
  assert.deepEqual(partialStamps, [1, 1], '解码期间属于正在解的那一发');

  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '嗯，见面了。' });
  socket.message({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: '下' });
  assert.deepEqual(partialStamps, [1, 1, 2], '解码结束后属于下一发 commit');
});

test('qwenRealtimeStt 把 commitSeq 透传给宿主（这是唯一的号源）', async () => {
  // 漏透传不会报错，只会让宿主退回自己数 —— 表现就是旧段判错、自己打断自己。
  const socket = new FakeSocket();
  const stt = qwenRealtimeStt({ apiKey: 'k', socketFactory: () => asSocket(socket) });
  const session = stt.open({ onSentence: () => {} });
  assert.equal(typeof session.commitSeq, 'function', '可选能力必须真的接上');

  session.feed(Buffer.alloc(640), true); // 懒连接：有音频才建
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated', session: {} });

  assert.equal(session.commitSeq?.(), 0);
  session.commit?.();
  assert.equal(session.commitSeq?.(), 1);
  assert.equal(session.commit?.(), undefined, 'commit 仍然不返回值（老调用点不受影响）');
});

// ------------------------------------------------------- 静态 corpus / language
//
// 缺省时一个字段都不能多：旧断言和线上对照都认这份报文。
// 给了热词或语言才带 `input_audio_transcription`，热路径不再多一次往返。

const MANUAL_SESSION_UPDATE = {
  type: 'session.update',
  session: {
    modalities: ['text'],
    input_audio_format: 'pcm',
    turn_detection: null,
  },
};

async function sessionUpdateOf(opts: {
  model?: string;
  corpusText?: string;
  language?: string;
  turnDetection?: 'manual' | 'vad';
  vadSilenceMs?: number;
} = {}): Promise<Sent> {
  const socket = new FakeSocket();
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: () => {},
    socketFactory: () => asSocket(socket),
    ...opts,
  });
  const connecting = asr.connect();
  socket.open();
  await connecting;
  const update = socket.sent.find((s) => s.type === 'session.update');
  assert.ok(update, '要先发 session.update');
  return update;
}

test('不传 corpusText / language 时 session.update 保持原报文', async () => {
  const { socket } = await ready();
  const update = socket.sent.find((s) => s.type === 'session.update');
  assert.deepEqual(update, MANUAL_SESSION_UPDATE);
});

test('corpusText 和 language 只有空白时也不改报文', async () => {
  assert.deepEqual(
    await sessionUpdateOf({ corpusText: ' \n\t', language: '  ' }),
    MANUAL_SESSION_UPDATE,
  );
});

test('传 corpusText + language 时 session.update 精确带上 input_audio_transcription', async () => {
  assert.deepEqual(
    await sessionUpdateOf({
      model: 'custom-asr',
      corpusText: '  莱姆 《其主之声》  ',
      language: '\nzh\n',
    }),
    {
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        turn_detection: null,
        input_audio_transcription: {
          model: 'custom-asr',
          language: 'zh',
          corpus: { text: '莱姆 《其主之声》' },
        },
      },
    },
  );
});

test('只给一边时，另一边的键不出现', async () => {
  assert.deepEqual(
    (await sessionUpdateOf({ language: '  en  ', corpusText: ' \n' })).session?.input_audio_transcription,
    { model: 'qwen3-asr-flash-realtime', language: 'en' },
  );
  assert.deepEqual(
    (await sessionUpdateOf({
      corpusText: '  莱姆\n眼镜  ',
      language: '   ',
    })).session?.input_audio_transcription,
    { model: 'qwen3-asr-flash-realtime', corpus: { text: '莱姆\n眼镜' } },
  );
});

test('热词和语言叠在原来的 session 上，不换掉 turn_detection', async () => {
  assert.deepEqual(
    await sessionUpdateOf({
      turnDetection: 'vad',
      vadSilenceMs: 320,
      corpusText: '眼镜',
      language: 'zh',
    }),
    {
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        turn_detection: { type: 'server_vad', silence_duration_ms: 320 },
        input_audio_transcription: {
          model: 'qwen3-asr-flash-realtime',
          language: 'zh',
          corpus: { text: '眼镜' },
        },
      },
    },
  );
});

test('qwenRealtimeStt 把 corpusText 和 language 透传到 session.update', async () => {
  const socket = new FakeSocket();
  const stt = qwenRealtimeStt({
    apiKey: 'k',
    model: 'custom-asr',
    corpusText: '  眼镜  ',
    language: ' zh ',
    socketFactory: () => asSocket(socket),
  });
  stt.open({ onSentence: () => {} }).feed(Buffer.alloc(320), true);
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  const update = socket.sent.find((s) => s.type === 'session.update');
  assert.deepEqual(update?.session?.input_audio_transcription, {
    model: 'custom-asr',
    language: 'zh',
    corpus: { text: '眼镜' },
  });
});

test('mergeCorpusText 去注释、去空串、按空白切分并去重', () => {
  assert.equal(mergeCorpusText(['', '  ', '# 只有注释\n\n#another']), '');
  // 注释行里的「眼镜不要」不能漏进热词；同一词跨段只留第一次
  assert.equal(
    mergeCorpusText([
      '# 眼镜不要\n眼镜  眼镜',
      '莱姆\r\n眼镜\n  其主之声  ',
      '#tail',
    ]),
    '眼镜 莱姆 其主之声',
  );
  assert.equal(mergeCorpusText(['b a b', 'a c']), 'b a c');
});

test('mergeCorpusText 截断停在 maxChars 边界', () => {
  const full = 'abcd efgh';
  assert.equal(full.length, 9);
  assert.equal(mergeCorpusText([full], 9), full, '刚好等于上限，整串保留');
  assert.equal(mergeCorpusText([full], 100), full, '上限更宽，不截');
  assert.equal(mergeCorpusText([full], 8), 'abcd efg', '超一个字就切到正好上限');
  assert.equal(mergeCorpusText([full], 8).length, 8);
  assert.equal(mergeCorpusText([full], 5), 'abcd', '截断点落在分隔空格上时去掉末尾空格');
  assert.equal(mergeCorpusText([full], 4), 'abcd');
  assert.equal(mergeCorpusText([full], 3), 'abc');
  assert.equal(mergeCorpusText([full], 0), '');
  assert.equal(mergeCorpusText(['ab ab cd'], 4), 'ab c', '先去重再截，不能把重复词算进预算');

  const capped = mergeCorpusText(['词'.repeat(900)]);
  assert.equal(capped, '词'.repeat(800), '缺省上限 800，截满且不多一个字');
  assert.equal(mergeCorpusText(['词'.repeat(800)]), '词'.repeat(800));
  assert.equal(mergeCorpusText(['词'.repeat(799)]).length, 799);
});

test('未就绪的静音补推时仍按静音，不点亮 dirty', async () => {
  const { asr, socket } = make();
  const connecting = asr.connect();
  socket.open();
  await connecting;
  asr.feed(Buffer.alloc(640), false);
  socket.message({ type: 'session.updated', session: {} });
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.append').length, 0);
  asr.commit();
  assert.equal(socket.types().filter((t) => t === 'input_audio_buffer.commit').length, 0);
});

test('拆连清掉 pendingVoice 和 discardLeft，close 唤醒 whenDecoded', async () => {
  const sockets: FakeSocket[] = [];
  const sentences: string[] = [];
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: (text) => { sentences.push(text); },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return asSocket(socket);
    },
  });

  const first = asr.connect();
  sockets[0]?.open();
  await first;
  sockets[0]?.message({ type: 'session.updated', session: {} });
  asr.feed(Buffer.alloc(640), true);
  asr.discard();
  sockets[0]?.close();

  asr.feed(Buffer.alloc(640), false);
  await new Promise((resolve) => { setImmediate(resolve); });
  const next = sockets[1];
  assert.ok(next, '拆连之后还要能重建');
  next.open();
  await new Promise((resolve) => { setImmediate(resolve); });
  next.message({ type: 'session.updated', session: {} });
  asr.commit();
  assert.equal(
    next.types().filter((t) => t === 'input_audio_buffer.commit').length,
    0,
    '上一轮的人声标记不该让纯静音封出一段',
  );

  asr.feed(Buffer.alloc(640), true);
  asr.commit();
  next.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: '下一句。',
  });
  assert.deepEqual(sentences, ['下一句。'], '上一轮的 discard 计数不该吃掉新连接的定稿');

  const held = await ready();
  held.asr.feed(Buffer.alloc(640), true);
  held.asr.commit();
  const pending = held.asr.whenDecoded();
  assert.ok(pending);
  let woke = false;
  const wait = pending.then(() => { woke = true; });
  held.asr.close();
  await wait;
  assert.equal(woke, true);
});

test('close 在建连途中让 open 回调失效', async () => {
  const { asr, socket } = make();
  const connecting = asr.connect();
  asr.close();
  socket.open();
  await connecting;
  assert.equal(socket.types().includes('session.update'), false);
});

test('isCorpusEcho 拦截热词回声幻觉且不误杀正常口语', () => {
  const corpus = '审计 市值 代码 挂断 dsh MiMo Copilot Claude 小米 小爱同学 仓库 分支 提交 推送';
  assert.equal(isCorpusEcho(corpus, corpus), true);
  assert.equal(isCorpusEcho('审计，市值，代码，挂断，dsh', corpus), true);
  assert.equal(isCorpusEcho('审计市值代码挂断dshMiMoCopilot', corpus), true);
  assert.equal(isCorpusEcho('帮我看一下 dsh 日志', corpus), false);
  assert.equal(isCorpusEcho('请帮我提交这个分支的代码', corpus), false);
  assert.equal(isCorpusEcho('今天天气怎么样', corpus), false);
});

test('弱音复读 corpus.text 时，partial 与 completed 均被拦截不回调上层', async () => {
  const corpus = '审计 市值 代码 挂断 dsh MiMo Copilot Claude 小米 小爱同学';
  const socket = new FakeSocket();
  const sentences: string[] = [];
  const partials: string[] = [];
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    corpusText: corpus,
    socketFactory: () => socket,
    onSentence: (t) => { sentences.push(t); },
    onPartial: (t) => { partials.push(t); },
  });
  const connecting = asr.connect();
  socket.open();
  socket.message({ type: 'session.updated' });
  await connecting;

  asr.feed(Buffer.alloc(320), true);
  asr.commit();
  socket.message({ type: 'conversation.item.input_audio_transcription.text', stash: corpus });
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: corpus });
  assert.deepEqual(partials, []);
  assert.deepEqual(sentences, []);

  // 正常话仍照常通过
  asr.feed(Buffer.alloc(320), true);
  asr.commit();
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: '帮我看下 dsh 端口' });
  assert.deepEqual(sentences, ['帮我看下 dsh 端口']);
  asr.close();
});

test('hangup 后 .failed / .error 消耗 discardLeft，下一句定稿不被吞', async () => {
  const run = async (kind: 'failed' | 'error'): Promise<void> => {
    const h = await ready();
    try {
      h.asr.feed(Buffer.alloc(640), true);
      h.asr.hangup();
      h.asr.discard();
      assert.equal(h.asr.decoding(), true);
      if (kind === 'failed') {
        h.socket.message({
          type: 'conversation.item.input_audio_transcription.failed',
          error: { message: 'hangup' },
        });
        assert.deepEqual(h.errors, ['转写失败: hangup']);
      } else {
        h.socket.message({ type: 'error', error: { message: 'hangup' } });
        assert.deepEqual(h.errors, ['服务端错误: hangup']);
      }
      assert.equal(h.asr.decoding(), false, `${kind} 也要结束这次等待`);
      h.asr.feed(Buffer.alloc(640), true);
      h.asr.commit();
      assert.equal(
        h.socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
        2,
        `${kind} 之后新的 commit 必须真的发出去`,
      );
      h.socket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '下一句。',
      });
      assert.deepEqual(
        h.sentences.map((s) => s.text),
        ['下一句。'],
        `${kind} 没吃掉 discardLeft，下一句真定稿被吞了`,
      );
    } finally {
      h.asr.close();
    }
  };
  await run('failed');
  await run('error');
});

/** 用保活超时包住等待：看门狗定时器本身 unref，Node 22 下纯等它会让事件循环提前退出。 */
function waitWithin<T>(work: Promise<T>, ms = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待超时（>${ms} ms）`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test('awaitingDecode 超时看门狗解锁新 commit 并唤醒 whenDecoded', async () => {
  const h = await ready({ decodeTimeoutMs: 30 });
  try {
    h.asr.feed(Buffer.alloc(640), true);
    h.asr.commit();
    h.asr.discard();
    const pending = h.asr.whenDecoded();
    assert.ok(pending);
    let woke = false;
    const wait = pending.then(() => { woke = true; });
    await waitWithin(wait);
    assert.equal(woke, true);
    assert.equal(h.asr.decoding(), false);
    h.asr.feed(Buffer.alloc(640), true);
    h.asr.commit();
    assert.equal(
      h.socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
      2,
      '超时之后要能再封一段',
    );
    h.socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '超时后的下一句。',
    });
    assert.deepEqual(h.sentences.map((s) => s.text), ['超时后的下一句。']);
  } finally {
    h.asr.close();
  }
});

test('解码超时按结束流程冲刷暂存并补发延后的 commit', async () => {
  const h = await ready({ decodeTimeoutMs: 30 });
  try {
    h.asr.feed(Buffer.alloc(640), true);
    h.asr.commit();
    const commits = (): number => h.socket.types().filter((t) => t === 'input_audio_buffer.commit').length;
    const appends = (): number => h.socket.types().filter((t) => t === 'input_audio_buffer.append').length;
    const before = appends();
    assert.equal(commits(), 1);
    h.asr.feed(Buffer.alloc(640), true);
    h.asr.commit();
    assert.equal(commits(), 1, '解码期只能延后');
    const pending = h.asr.whenDecoded();
    assert.ok(pending);
    await waitWithin(pending);
    assert.equal(appends(), before + 1, '超时也要把窗口里的语音补推上去');
    assert.equal(commits(), 2, '延后的 commit 要补发');
    assert.equal(h.asr.decoding(), true, '补发的那一发重新进入等待');
  } finally {
    h.asr.close();
    assert.equal(h.asr.decoding(), false, 'close 清掉看门狗和等待');
  }
});

test('decodeTimeoutMs <= 0 不启动看门狗', async () => {
  const h = await ready({ decodeTimeoutMs: 0 });
  try {
    h.asr.feed(Buffer.alloc(640), true);
    h.asr.commit();
    const pending = h.asr.whenDecoded();
    assert.ok(pending);
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    assert.equal(h.asr.decoding(), true, '关闭看门狗时不能自己解锁');
    assert.equal(
      h.socket.types().filter((t) => t === 'input_audio_buffer.commit').length,
      1,
    );
    h.socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '还在。',
    });
    assert.deepEqual(h.sentences.map((s) => s.text), ['还在。']);
  } finally {
    h.asr.close();
  }
});

test('CLOSING/CLOSED 不把未发送 backlog 推进死 socket，drop 留给重连', async () => {
  const sockets: FakeSocket[] = [];
  const asr = new QwenRealtimeAsr({
    apiKey: 'k',
    onSentence: () => {},
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return asSocket(socket);
    },
  });
  try {
    const firstConnect = asr.connect();
    const first = sockets[0];
    assert.ok(first);
    first.open();
    await firstConnect;
    asr.feed(Buffer.from([1]), true);
    asr.feed(Buffer.from([2]), true);
    assert.deepEqual(first.types(), ['session.update']);

    first.readyState = 2;
    asr.feed(Buffer.from([3]), true);
    assert.equal(
      first.types().filter((t) => t === 'input_audio_buffer.append').length,
      0,
      'CLOSING 不能把 backlog 推进去',
    );
    assert.equal(sockets.length, 2);

    const second = sockets[1];
    assert.ok(second);
    second.open();
    await new Promise((resolve) => { setImmediate(resolve); });
    second.message({ type: 'session.updated', session: {} });
    assert.equal(
      second.types().filter((t) => t === 'input_audio_buffer.append').length,
      3,
      '三帧未发送音频要在新连接补发',
    );

    second.readyState = 3;
    asr.feed(Buffer.from([4]), true);
    assert.equal(
      second.types().filter((t) => t === 'input_audio_buffer.append').length,
      3,
      'CLOSED 同样不能再推进这个 socket',
    );
    assert.equal(sockets.length, 3);

    const third = sockets[2];
    assert.ok(third);
    third.open();
    await new Promise((resolve) => { setImmediate(resolve); });
    third.message({ type: 'session.updated', session: {} });
    assert.equal(
      third.types().filter((t) => t === 'input_audio_buffer.append').length,
      1,
      'CLOSED 时新到的那一帧要留给重连',
    );
  } finally {
    const before = sockets.length;
    asr.close();
    asr.feed(Buffer.from([5]), true);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(sockets.length, before, 'close 之后不再重连');
  }
});
