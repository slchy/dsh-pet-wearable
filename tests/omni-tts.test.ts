/**
 * `omni-tts` —— 用 omni 念文本（S5）。
 *
 * 这里验的四条都是「拿真服务跑不出来、但错了就整轮哑」的东西：
 * 1. 一次合成只用**一条** user 项（`念这段：…`），并且**合成完会删掉** ——
 *    不删的话朗读历史滚起来，后面每次输入都背上前面所有句子
 * 2. 音频按 `response.audio.delta` 原样吐出（不做 base64 二次处理）
 * 3. `synthesizeStream` 是**攒完再念**，不是逐句 —— 逐句会在句间留 ~630 ms 死空气
 * 4. 服务端报错之后弃连接（同一条连接上后续合成会静默挂死）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { omniTts, type RealtimeLike } from '../src/omni-tts.ts';

interface Sent {
  type: string;
  item_id?: string;
  item?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  session?: { instructions?: string; tools?: unknown };
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
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...args: unknown[]) => void);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }

  types(): string[] {
    return this.sent.map((s) => s.type);
  }
}

function make() {
  const socket = new FakeSocket();
  const tts = omniTts({
    apiKey: 'k',
    log: () => {},
    socketFactory: () => socket as unknown as RealtimeLike,
  });
  return { socket, tts };
}

test('合成一条：读提示词 + 逐字指令，且会话里不挂 tools', async () => {
  const { socket, tts } = make();
  const got: Buffer[] = [];
  const pump = (async () => {
    for await (const chunk of tts.synthesize('你好呀。')) {
      got.push(chunk);
    }
  })();

  await new Promise((r) => { setImmediate(r); });
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated' });

  // 握手时的 session.update
  const update = socket.sent.find((s) => s.type === 'session.update');
  assert.ok(update, '要先发 session.update');
  assert.equal(update.session?.tools, undefined, '朗读连接不挂 tools —— 否则长文本会被判成要调工具');
  assert.match(String(update.session?.instructions ?? ''), /朗读器|逐字/, '必须是朗读器人格');

  await new Promise((r) => { setImmediate(r); });
  const create = socket.sent.find((s) => s.type === 'conversation.item.create');
  assert.ok(create, '要有一条 user 项');
  assert.equal(create.item?.role, 'user', 'assistant 角色服务端当没看见（实测三种 content type 都不行）');
  const text = create.item?.content?.[0]?.text ?? '';
  assert.match(text, /^念这段：/, '「念这段：」这个框架是逐字保真的关键');
  assert.match(text, /你好呀。/);

  socket.message({ type: 'conversation.item.created', item: { id: 'item_u', role: 'user' } });
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'response.output_item.added', item: { id: 'item_a', role: 'assistant' } });
  const audio = Buffer.alloc(960);
  socket.message({ type: 'response.audio.delta', delta: audio.toString('base64') });
  // 第二条音频 + 收尾
  socket.message({ type: 'response.audio.delta', delta: audio.toString('base64') });
  socket.message({ type: 'response.done', response: { status: 'completed' } });

  await pump;
  assert.equal(got.length, 2, '两个 delta 各算一块');
  assert.equal(got[0]!.length, 960);
});

test('下一次合成前删掉上一次用过的两条 item（别让朗读历史滚起来）', async () => {
  const { socket, tts } = make();

  async function one(text: string) {
    const pump = (async () => { for await (const _ of tts.synthesize(text)) { /* drain */ } })();
    await new Promise((r) => { setImmediate(r); });
    socket.message({ type: 'conversation.item.created', item: { id: 'item_u', role: 'user' } });
    await new Promise((r) => { setImmediate(r); });
    socket.message({ type: 'response.output_item.added', item: { id: 'item_a', role: 'assistant' } });
    socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
    socket.message({ type: 'response.done', response: { status: 'completed' } });
    await pump;
  }

  const pump0 = (async () => { for await (const _ of tts.synthesize('第一句。')) { /* drain */ } })();
  await new Promise((r) => { setImmediate(r); });
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated' });
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'conversation.item.created', item: { id: 'item_u1', role: 'user' } });
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'response.output_item.added', item: { id: 'item_a1', role: 'assistant' } });
  socket.message({ type: 'response.done', response: { status: 'completed' } });
  await pump0;

  assert.equal(socket.types().filter((t) => t === 'conversation.item.delete').length, 0,
    '第一次合成没有旧账可清');

  await one('第二句。');
  const deleted = socket.sent.filter((s) => s.type === 'conversation.item.delete').map((s) => s.item_id);
  assert.deepEqual(deleted.sort(), ['item_a1', 'item_u1'], '两条都要删：只删助手会留下假的用户消息');
});

test('synthesizeStream 攒完再念：只发一条 item.create，不是逐句', async () => {
  const { socket, tts } = make();
  const pump = (async () => {
    for await (const _ of tts.synthesizeStream!(
      (async function* gen() {
        yield '第一句话说完了。第二句';
        yield '也开始。第三句收尾。';
      })(),
    )) { /* drain */ }
  })();
  await new Promise((r) => { setImmediate(r); });
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated' });
  await new Promise((r) => { setImmediate(r); });

  const creates = socket.sent.filter((s) => s.type === 'conversation.item.create');
  assert.equal(creates.length, 1, '整段一次，逐句会在句间留 ~630 ms 死空气');
  assert.match(creates[0]!.item?.content?.[0]?.text ?? '', /第一句话说完了。第二句也开始。第三句收尾。/);

  socket.message({ type: 'response.done', response: { status: 'completed' } });
  await pump;
});

test('服务端报错后弃连接（同一条连接上后续合成会静默挂死）', async () => {
  const { socket, tts } = make();
  const pump = (async () => { for await (const _ of tts.synthesize('你好。')) { /* drain */ } })();
  await new Promise((r) => { setImmediate(r); });
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated' });
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'error', error: { message: 'boom' } });
  await pump;
  assert.equal(socket.readyState, 3, '连接要关掉');
});

test('放弃一条流之后，下一条拿不到它的残留音频', async () => {
  // 真机 2026-11-23 08:24：一条被放弃的长流之后，4 个字的回执合成了
  // 506880 B / 10.56 s，且首块 0 ms（队列里现成的）。`bench/tts/reader-probe.mjs`
  // 能稳定复现同一现象：放弃一条长流，下一条请求首块 1 ms、拿到 3.52 s 残留。
  const { socket, tts } = make();
  // 注意：`synthesize()` 是 async generator，**第一次 `next()` 才会去建连**
  const first = tts.synthesize('第一句。')[Symbol.asyncIterator]();
  const head = first.next();
  await new Promise((r) => { setImmediate(r); });
  socket.open();
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'session.updated' });
  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'response.created', response: { id: 'r1' } });
  socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
  const firstChunk = await head;
  assert.equal(firstChunk.done, false);

  // 调用方不要这条了（插话 / 回执被顶掉）
  const closing = first.return!(undefined);
  await new Promise((r) => { setImmediate(r); });
  assert.ok(socket.sent.some((s) => s.type === 'response.cancel'), '放弃时要让服务端停下');

  // 它还在往下推：这些字节一个都不许进队列
  socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480, 9).toString('base64') });

  // 下一条不能抢在收尾之前发：服务端忙的时候会拒 `response.create`，而且不排队、直接丢
  const second = tts.synthesize('第二句。')[Symbol.asyncIterator]();
  const nextPending = second.next();
  await new Promise((r) => { setImmediate(r); });
  assert.equal(
    socket.sent.filter((s) => s.type === 'conversation.item.create').length,
    1,
    '上一条还没 done 就发新请求，会被服务端当忙丢掉',
  );

  socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  await closing;

  await new Promise((r) => { setImmediate(r); });
  socket.message({ type: 'response.created', response: { id: 'r2' } });
  socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(240, 7).toString('base64') });
  const next = await nextPending;
  assert.equal(next.done, false);
  const chunk = next.value as Buffer;
  assert.equal(chunk.length, 240, '必须是第二条自己的那块');
  assert.equal(chunk[0], 7, '残留那块（填 9）不许漏过来');

  socket.message({ type: 'response.done', response: { status: 'completed' } });
  const end = await second.next();
  assert.equal(end.done, true, '正常收尾：不该再去等一个已经到过的 done');
});

test('空文本不发任何请求', async () => {
  const { socket, tts } = make();
  const got: Buffer[] = [];
  for await (const chunk of tts.synthesize('   ')) {
    got.push(chunk);
  }
  assert.equal(got.length, 0);
  assert.deepEqual(socket.types(), [], '连连接都不该建');
});

test('握手超时关掉旧 socket，迟到的 session.updated 不能放行新连接', { timeout: 3000 }, async () => {
  const sockets: FakeSocket[] = [];
  const tts = omniTts({
    apiKey: 'k',
    connectTimeoutMs: 30,
    log: () => {},
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as RealtimeLike;
    },
  });
  const first = tts.synthesize('你好')[Symbol.asyncIterator]().next();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(sockets.length, 1);
  sockets[0]!.open();
  await assert.rejects(first, /握手超时/);
  assert.equal(sockets[0]!.readyState, 3);

  sockets[0]!.message({ type: 'session.updated' });
  const second = tts.synthesize('第二句')[Symbol.asyncIterator]();
  const pending = second.next();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  await new Promise((resolve) => { setImmediate(resolve); });
  sockets[0]!.message({ type: 'session.updated' });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(
    sockets[1]!.types().filter((type) => type === 'conversation.item.create').length,
    0,
  );
  sockets[1]!.message({ type: 'session.updated' });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(
    sockets[1]!.types().filter((type) => type === 'conversation.item.create').length,
    1,
  );
  sockets[1]!.message({ type: 'response.done', response: { status: 'completed' } });
  await pending;
});

test('take 超时清掉自己的 wake，迟到的音频帧不会被吞', { timeout: 3000 }, async () => {
  const { socket, tts } = make();
  const real = globalThis.setTimeout;
  const audio = Buffer.alloc(480, 4);
  let armed = false;
  const wrapped = (fn: (...handlerArgs: unknown[]) => void, ms?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
    if (ms === 1_000 && !armed) {
      armed = true;
      return real(() => {
        fn(...args);
        socket.message({ type: 'response.audio.delta', delta: audio.toString('base64') });
        socket.message({ type: 'response.done', response: { status: 'completed' } });
      }, ms);
    }
    return real(fn as (...handlerArgs: unknown[]) => void, ms, ...(args as []));
  };
  globalThis.setTimeout = wrapped as typeof setTimeout;
  try {
    const iter = tts.synthesize('你好。')[Symbol.asyncIterator]();
    const pending = iter.next();
    await new Promise((resolve) => { setImmediate(resolve); });
    socket.open();
    await new Promise((resolve) => { setImmediate(resolve); });
    socket.message({ type: 'session.updated' });
    const first = await pending;
    assert.equal(armed, true);
    assert.equal(first.done, false);
    assert.equal((first.value as Buffer).length, 480);
    assert.equal((first.value as Buffer)[0], 4);
    const end = await iter.next();
    assert.equal(end.done, true);
  } finally {
    globalThis.setTimeout = real;
  }
});
