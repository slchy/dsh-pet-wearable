/**
 * omni 一体化车道（客户端这一侧）。
 *
 * 这里只验客户端行为 —— 计时口径、闭嘴（mute）、忙时排队、延迟删、回注。
 * 真实延迟 / 成本 / 服务端协议行为在 `tmp/omni-probe/` 里量。
 *
 * 三条最要紧的回归：
 * - **封段之后一块静音都不许发**（能量门 `holdMs` 2 s 比 `commitMs` 20 ms 长得多）
 * - **忙时不许发 `response.create`**（服务端会拒且那一次 create 永久丢失）
 * - **`delete` 不能当场发**（item id 在 `response.done` 里，那会儿通常连 created 都没到）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OmniShadow } from '../src/omni-shadow.ts';
import type { RealtimeSocket } from '../src/qwen-realtime-asr.ts';

interface Sent {
  type: string;
  audio?: string;
  item_id?: string;
  item?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  session?: {
    instructions?: string;
    tools?: Array<{ name?: string; description?: string }>;
  };
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

  count(type: string): number {
    return this.types().filter((t) => t === type).length;
  }
}

/** 32 字节 = 1 ms（16 kHz × 2 B） */
const MS = 32;
const SILENCE = Buffer.alloc(MS * 100);

function make(serve: 'off' | 'full' = 'off') {
  const socket = new FakeSocket();
  const events: Array<Record<string, unknown>> = [];
  let clock = 0;
  const shadow = new OmniShadow({
    apiKey: 'k',
    serve,
    now: () => clock,
    emit: (data) => { events.push(data); },
    socketFactory: () => socket as unknown as RealtimeSocket,
  });
  return {
    socket,
    events,
    shadow,
    at: (t: number) => { clock = t; },
    advance: (by: number) => { clock += by; },
    ready() {
      shadow.start();
      socket.open();
      socket.message({ type: 'session.updated' });
    },
  };
}

test('一轮正常：字段齐、audio_ms 从封段算起', () => {
  const h = make();
  h.ready();
  // 握手之后第一条必须是 session.update，且关掉服务端 VAD
  assert.equal(h.socket.types()[0], 'session.update');

  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]); // 预卷 100 ms
  h.shadow.feed(Buffer.alloc(MS * 100), true); // 有声 100 ms
  assert.equal(h.socket.count('input_audio_buffer.append'), 2);

  h.at(100);
  h.shadow.seal(1, 40); // 封段
  assert.deepEqual(h.socket.types().slice(-2), ['input_audio_buffer.commit', 'response.create']);

  h.at(110);
  h.socket.message({ type: 'input_audio_buffer.committed' });
  h.at(300);
  h.socket.message({ type: 'conversation.item.input_audio_transcription.completed' });
  h.at(350);
  h.socket.message({ type: 'response.text.delta', delta: '嗯' });
  h.at(700);
  // 15360 字节 = 320 ms（24 kHz × 2 B）；用 base64 传，不解码也能算对
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(15_360).toString('base64') });
  h.at(900);
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'completed',
      usage: {
        input_tokens: 722,
        input_tokens_details: { audio_tokens: 14, text_tokens: 708 },
        output_tokens_details: { audio_tokens: 82 },
      },
    },
  });

  assert.equal(h.events.length, 1);
  const e = h.events[0]!;
  assert.equal(e['seq'], 1);
  assert.equal(e['warmup'], true);
  assert.equal(e['seal_s'], 0.2, '预卷 100 ms + 有声 100 ms');
  assert.equal(e['silence_ms'], 40);
  assert.equal(e['ack_ms'], 10);
  assert.equal(e['final_ms'], 200);
  assert.equal(e['text_ms'], 250);
  assert.equal(e['audio_ms'], 600, '700（首块）−100（封段）');
  assert.equal(e['cancel_wait_ms'], 0);
  assert.equal(e['out_s'], 0.32);
  assert.equal(e['status'], 'completed');
  assert.equal(e['cancelled'], false);
  assert.equal(e['in_audio_tok'], 14);
  assert.equal(e['out_audio_tok'], 82);
});

test('封段之后的静音一块都不发（能量门比封段晚关约 2 s）', () => {
  const h = make();
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.at(100);
  h.shadow.seal(1, 40);
  const before = h.socket.count('input_audio_buffer.append');

  // 门还开着，这些块会进 `onSpeech`，但都没声音
  for (let i = 0; i < 20; i += 1) {
    h.shadow.feed(SILENCE, false);
  }
  assert.equal(
    h.socket.count('input_audio_buffer.append'),
    before,
    '封段后灌静音 = 白付 token + 下一轮 commit 出空白用户消息',
  );

  // 真又开口了：软起音不该被切掉，ring 里那 100 ms 要跟着一起走。
  // 但**这一刻不发** —— 生成期的 append 服务端会直接丢掉（见 `append()`），
  // 所以先攒在本地，`response.done` 到了再补推。
  h.shadow.feed(Buffer.alloc(MS * 50), true);
  assert.equal(h.socket.count('input_audio_buffer.append'), before,
    '生成期先攒着，现在推上去会被丢掉');
  h.at(200);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.socket.count('input_audio_buffer.append'), before + 2,
    'done 之后补推：ring 那 100 ms + 这一块');
});

test('并段：第二次封段能正常再起一份', () => {
  const h = make();
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  h.at(60);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });

  // 用户接着说：解除闭嘴、继续推
  h.at(200);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.at(300);
  h.shadow.seal(2, 60);
  assert.equal(h.socket.count('response.create'), 2);
  assert.equal(h.events.length, 1);

  h.at(400);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1]!['seq'], 2);
});

test('忙时封段：先 cancel，done 之前不许再发 create', () => {
  const h = make();
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(100);
  h.shadow.seal(1, 40);
  // 真的「忙」意味着服务端已经回过 `response.created` —— 只有 created 之后的
  // cancel 才合法（之前发会被拒，见 `cancelPending`）
  h.at(150);
  h.socket.message({ type: 'response.created' });

  // 第一份还在跑，第二段就来了
  h.at(200);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.at(300);
  h.shadow.seal(2, 50);
  assert.equal(h.socket.count('response.cancel'), 1, '必须取消，否则 create 会被拒且永久丢失');
  assert.equal(h.socket.count('response.create'), 1, 'done 之前不能发第二份');

  h.at(400);
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  // done 之后才补发第二份
  assert.equal(h.socket.count('response.create'), 2);
  assert.equal(h.events[0]!['cancelled'], true);
  assert.equal(h.events[0]!['audio_ms'], null, '一块音频都没出就不能拿 0 冒充');

  h.at(1100);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(4800).toString('base64') });
  h.at(1200);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const second = h.events[1]!;
  assert.equal(second['seq'], 2);
  assert.equal(second['audio_ms'], 800, '从 seal(2) 的 300 算起，不是从发送时刻的 400 算');
  assert.equal(second['cancel_wait_ms'], 100, '等 cancel 的那 100 ms 单独一列');
});

test('还没就绪就封段：记 skipped，不猜数据', () => {
  const h = make();
  h.shadow.start();
  h.socket.open();
  // 故意不喂 session.updated
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.shadow.seal(7, 40);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!['skipped'], 'connecting');
  assert.equal(h.socket.count('response.create'), 0);
});

test('空缓冲封段：不发 commit', () => {
  const h = make();
  h.ready();
  h.shadow.seal(3, 40);
  assert.equal(h.socket.count('input_audio_buffer.commit'), 0);
  assert.equal(h.events[0]!['skipped'], 'empty');
});

test('未启用（从未 start）时所有入口都是空操作', () => {
  const socket = new FakeSocket();
  const events: Array<Record<string, unknown>> = [];
  const shadow = new OmniShadow({
    apiKey: 'k',
    emit: (data) => { events.push(data); },
    socketFactory: () => socket as unknown as RealtimeSocket,
  });
  shadow.restart([Buffer.alloc(MS * 100)]);
  shadow.feed(Buffer.alloc(MS * 100), true);
  shadow.seal(1, 40);
  assert.equal(socket.sent.length, 0, '关掉时连一个字节都不许发');
  assert.equal(events[0]!['skipped'], 'idle');
});

test('restart 时把残留 flush 掉（commit 但不 create），并记在新一份上', () => {
  const h = make();
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(100);
  h.shadow.seal(1, 40);
  h.at(110);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });

  // 有人说了 50 ms 又停了，但没走到封段就又开口 —— 这段残留要清掉
  h.at(200);
  h.shadow.feed(Buffer.alloc(MS * 50), true);
  h.at(300);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  const commits = h.socket.count('input_audio_buffer.commit');
  assert.equal(commits, 2, '残留那次是不带 create 的 commit');
  assert.equal(h.socket.count('response.create'), 1, 'flush 不能产生回复');

  h.at(400);
  h.shadow.seal(2, 40);
  h.at(500);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.events[1]!['flushed_ms'], 50);
});

test('认领之前到的那块音频不能丢（判停延拍时认领会晚到 700–870 ms）', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  // 首块在 600 ms 到，认领在 800 ms 才发生（模拟 TurnJudge 延拍）
  h.at(600);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
  assert.equal(h.socket.count('response.create'), 1);

  h.at(800);
  const answer = h.shadow.claim();
  assert.ok(answer !== null, '单段轮应当可认领');
  assert.equal(answer!.sampleRate, 24_000);

  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  h.at(900);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await drain;
  assert.equal(got.length, 1, '认领之前到的那块必须在流里');
  assert.equal(got[0]!.length, 480);
});

test('并段轮：认领绑的那份被下一段顶掉时，音频跟到新那份（不能 0 音频）', async () => {
  // 真机 20261122-2243 第 13、16 轮：一句话被 ASR 切成好几段，认领绑在第一份上，
  // 那份被后面的封段取消 → 这一轮 audio_s=0；真正那份（2.16 s / 6.16 s）没人认领、
  // 被当幽灵删掉。这里钉住：一个字节都没播出去时，认领要跟到最新的那一份。
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();

  // 第二段紧跟着封上来：第一份被 cancel，第二份排队
  h.at(120);
  h.shadow.feed(Buffer.alloc(MS * 200), true);
  h.shadow.seal(2, 40);
  assert.equal(h.socket.count('response.create'), 1, '忙时不许再发 create');

  // 第一份 done（一个字节音频都没出过）→ 排队那份建出来
  h.at(400);
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(h.socket.count('response.create'), 2, 'done 之后要补发排队那份');

  // 第二份才是真正的答案
  h.at(900);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(960).toString('base64') });
  h.at(1000);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await drain;

  assert.equal(
    got.reduce((n, c) => n + c.length, 0),
    960,
    `认领必须跟到第二份，实际拿到 ${got.length} 块`,
  );
});

test('并段轮：已经播出去的那份不再跟到下一段（两段回答不能接在一起）', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  // 第一份已经出一块音频（用户听到了），之后才被下一段顶掉
  h.at(600);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });

  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));

  h.at(700);
  h.shadow.feed(Buffer.alloc(MS * 200), true);
  h.shadow.seal(2, 40);
  h.at(900);
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  h.at(1000);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(960).toString('base64') });
  h.at(1100);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await drain;

  assert.equal(
    got.reduce((n, c) => n + c.length, 0),
    480,
    '播过的就停在那儿 —— 把第二段的答案接上来会变成两句回答拼在一起',
  );
});

test('discard 后立刻不可认领（cancel 要等 created，见下一条）', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  assert.equal(h.shadow.willServe(), true);

  h.shadow.discard();
  assert.equal(h.shadow.willServe(), false);
  assert.equal(h.shadow.claim(), null, '取消过的就是死答案，不能再给出去');
});

test('并段轮也认（clip 档已砍掉：实测并段轮回答质量与单段轮无差别）', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  // 同一句里第二次封段：上一份还在生成，排队等 done
  h.at(30);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.at(40);
  h.shadow.seal(2, 40);
  h.at(50);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.shadow.willServe(), true, '第二份开始了就应当能答');
});

test('discard 之后：done 里带着 item id 时才删助手项，且只删助手项', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  // discard 当场拿不到 id（连 created 都还没到），只能记意图
  h.shadow.discard();
  assert.equal(h.socket.count('conversation.item.delete'), 0, 'discard 当场不该发 delete');

  h.at(80);
  h.socket.message({ type: 'response.created', response: { status: 'in_progress' } });
  assert.equal(h.socket.count('response.cancel'), 1, 'created 到了才补发 cancel');

  h.at(200);
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'cancelled',
      output: [
        { id: 'item_q', role: 'user' },
        { id: 'item_a', role: 'assistant' },
      ],
    },
  });
  const deleted = h.socket.sent.filter((s) => s.type === 'conversation.item.delete');
  assert.equal(deleted.length, 1, '只删助手那条：用户那条后面还要指代');
  assert.equal(deleted[0]!['item_id'], 'item_a');
});

test('没人认领就被顶掉的那份也删（它答的是半句话，没人听过）', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.at(30);
  h.shadow.seal(2, 40); // 撞 busy → cancelCurrent
  h.at(40);
  h.socket.message({
    type: 'response.done',
    response: { status: 'cancelled', output: [{ id: 'item_a1', role: 'assistant' }] },
  });
  const deleted = h.socket.sent.filter((s) => s.type === 'conversation.item.delete');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]!['item_id'], 'item_a1');
});

test('播到一半被打断（interrupt）：取消但**不删**已说出去的那条', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  h.at(60);
  h.socket.message({ type: 'response.created', response: { status: 'in_progress' } });
  assert.ok(h.shadow.claim() !== null);
  h.shadow.interrupt();
  h.at(200);
  h.socket.message({
    type: 'response.done',
    response: { status: 'cancelled', output: [{ id: 'item_a', role: 'assistant' }] },
  });
  assert.equal(h.socket.count('conversation.item.delete'), 0,
    '用户已经听到了一部分，删掉它就和快车道 pending 里记的半句对不上');
});

test('injectAnswer：忙的时候排队，done 回到 ready 才发；角色必须是 user', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  h.shadow.injectAnswer('塔可夫斯基怎么样', '他很厉害。');
  assert.equal(h.socket.count('conversation.item.create'), 0, 'busy 时不发，排队等');
  h.at(30);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const creates = h.socket.sent.filter((s) => s.type === 'conversation.item.create');
  assert.equal(creates.length, 1);
  const item = creates[0]!['item'] as { role?: string; content?: Array<{ type?: string; text?: string }> };
  assert.equal(item.role, 'user', 'assistant 角色服务端会当没看见（实测三种 content type 都不行）');
  assert.equal(item.content?.[0]?.type, 'input_text');
  assert.match(item.content?.[0]?.text ?? '', /塔可夫斯基怎么样/, '必须带原问题，否则长任务会乱序');
  assert.match(item.content?.[0]?.text ?? '', /他很厉害/, '答案也要在');
});

test('injectAnswer：超长答案硬截断', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.injectAnswer('问', '啊'.repeat(500));
  const creates = h.socket.sent.filter((s) => s.type === 'conversation.item.create');
  assert.equal(creates.length, 1);
  const text = (creates[0]!['item'] as { content: Array<{ text: string }> }).content[0]!.text;
  assert.ok(text.length < 300, `200 字上限 + 旁注框架，实际 ${text.length}`);
  assert.ok(text.endsWith('）'));
});

test('injectAnswer：车道不在（broken/idle）就丢，不排队', () => {
  const h = make('full');
  h.shadow.injectAnswer('问', '答');
  h.ready();
  assert.equal(h.socket.count('conversation.item.create'), 0);
});

test('手里那份被顶掉时认领「排队中的下一份」（空窗 92 ms，一放就整轮退回级联）', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  // 同一句第二次封段：seal#1 被 cancel、#2 排队。此刻 `this.resp` 指着已取消的 #1。
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.shadow.seal(2, 40);

  assert.equal(h.shadow.willServe(), true,
    '还有一份在排队就算能答 —— 判 false 会让这一轮整轮退回级联（听到两副嗓子）');
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();

  // #1 的 done 到达 → 排队那份建出来，并且**一建好就是已认领**
  h.at(30);
  h.socket.message({
    type: 'response.done',
    response: { status: 'cancelled', output: [{ id: 'item_a1', role: 'assistant' }] },
  });
  assert.equal(h.socket.count('response.create'), 2, '排队那份这时才发');
  h.at(40);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(960).toString('base64') });
  h.at(50);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await drain;
  assert.equal(got.length, 1, '下一份的音频必须能拿到');
  assert.equal(got[0]!.length, 960);
});

test('预留的那份被 discard 作废：不会被后面另一份顺手拿走', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.shadow.seal(2, 40);
  assert.ok(h.shadow.claim() !== null);
  h.shadow.discard();
  h.at(30);
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  // 下一轮的封段不该背着上一轮的预留
  h.at(40);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(3, 40);
  assert.equal(h.shadow.willServe(), true, '新的一份没被谁认领过');
});

test('等「下一份」的时候车道断了：流正常结束，不挂死', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.shadow.seal(2, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  h.socket.close();
  await drain;
  assert.equal(got.length, 0);
});

test('预留认领期间被 discard：读端立刻退出，不空等（每圈 5 s）', { timeout: 4000 }, async () => {
  // 只预留、还没建出来的那一份，被 discard() 作废之后 `state` 仍是 `busy` ——
  // 原来只看 state 的循环会一圈接一圈地 `waitLive()`（每圈 5 s），
  // 而那一份永远不会再交过来了。
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  // 同一句的第二段把第一份顶掉 → claim 只能预留「排队中」的那份
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.shadow.seal(2, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  const started = Date.now();
  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  // 让读端先挂到 `waitLive` 上，再作废预留（委派轮 / 判据否决就是这条路径）
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.shadow.discard();
  await drain;

  const waited = Date.now() - started;
  assert.equal(got.length, 0);
  assert.ok(waited < 1000, `discard 之后应当立刻退出，实际等了 ${waited} ms`);
});

test('serve=full 的工具描述里必须带「先说一句再调」：委派轮的声音就靠这一句', () => {
  const h = make('full');
  h.ready();

  const update = h.socket.sent[0];
  assert.equal(update?.type, 'session.update');
  const tool = update?.session?.tools?.[0];
  assert.equal(tool?.name, 'delegate_to_assistant');
  // 真服务实测（`tmp/omni-probe/tool-leadin*.mjs`）：这句不写在**工具描述**里，
  // omni 调工具时就是 0 ms 音频 —— 整轮哑在那里等 dsh。写进 instructions 也不生效。
  assert.ok(
    (tool?.description ?? '').includes('应一声'),
    `缺了这句委派轮就没有声音，得退回预录回执。实际描述：${tool?.description ?? '（没有工具）'}`,
  );
});

test('omni 发 tool_call → delegateReason 非空；正常答 → null', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);
  assert.equal(answer!.delegateReason!(), null);

  h.at(700);
  h.socket.message({ type: 'response.function_call_arguments.delta', delta: '{"reason":"要查设备"}' });
  h.at(710);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(answer!.delegateReason!(), 'delegate', '本地判据分不出任务，只能靠它');
});

test('tool_call 里的 request 会被取出来交给 dsh（ASR 听错时靠它）', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);
  assert.equal(answer!.delegateText!(), null, '还没调用时是空的');

  // 完整参数走 `.done`（delta 是分段，拼起来容易漏引号）
  h.at(700);
  h.socket.message({
    type: 'response.function_call_arguments.done',
    arguments: '{"request":"把客厅的灯关掉","reason":"要操作设备"}',
  });
  h.at(710);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(answer!.delegateReason!(), 'delegate');
  assert.equal(answer!.delegateText!(), '把客厅的灯关掉');
});

test('tool_call 参数坏掉时 delegateText 回 null，不连累委派', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  h.at(700);
  h.socket.message({ type: 'response.function_call_arguments.done', arguments: '{"request":' });
  h.at(710);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(answer!.delegateReason!(), 'delegate', '委派照旧');
  assert.equal(answer!.delegateText!(), null, '取不到就退回 ASR 原话');
});

test('工具调用**之后**才到的音频也要播（真服务顺序是 call→audio）', async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  const answer = h.shadow.claim();
  assert.ok(answer !== null);

  // 实测：`function_call_arguments` 在 ~500 ms 先到，`audio.delta` 在 ~650 ms 后到 ——
  // 模型先决定调工具，再补一句「我看看。」垫着。这一段就是委派轮唯一的声源。
  h.at(500);
  h.socket.message({ type: 'response.function_call_arguments.delta', delta: '{"reason":"关灯"}' });
  h.at(650);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(24_000).toString('base64') });
  h.at(800);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });

  const chunks: Buffer[] = [];
  for await (const chunk of answer!.chunks) {
    chunks.push(chunk);
  }
  assert.equal(
    chunks.reduce((n, c) => n + c.length, 0),
    24_000,
    '工具调用之后到的音频不能丢 —— 那就是用户听到的垫话',
  );
  assert.equal(answer!.delegateReason!(), 'delegate');
});

test('serve=off 时 claim 恒 null（一个字节都不该被认领）', () => {
  const h = make('off');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  assert.equal(h.shadow.willServe(), false);
  assert.equal(h.shadow.claim(), null);
});
test('created 之前 discard 不立刻 cancel，等 created 到了再补发', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  // 委派轮就是这样：seal 之后几百毫秒就 discard，那时 response.created 还没到
  h.shadow.discard();
  assert.equal(h.socket.count('response.cancel'), 0, 'created 之前发会被服务端拒');
  assert.equal(h.shadow.willServe(), false);

  h.at(120);
  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1, 'created 一到就补发');
});

test('「created 之前 cancel」的服务端错误不判死车道', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(50);
  h.shadow.seal(1, 40);
  h.socket.message({ type: 'error', error: { message: 'Cannot cancel response before response.created' } });
  h.socket.message({ type: 'error', error: { message: 'Cannot cancel response before response.created' } });
  assert.equal(h.shadow.currentState, 'busy', '这个错误是我们自己的时序，不该把整条车道停掉');
});

test('插话时不许掐掉下一句的回复（interrupt 只动 claimedResp）', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  assert.ok(h.shadow.claim() !== null, '第 1 轮认领 #1 并开始播');

  // 用户开口说下一句 → 封段：把正在播的 #1 取消并排队
  h.at(30);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.shadow.seal(2, 40);
  // #1 的 done 到了 → 排队那份建出来（这时 `this.resp` 已经是 #2）
  h.at(40);
  h.socket.message({
    type: 'response.done',
    response: { status: 'cancelled', output: [{ id: 'item_a1', role: 'assistant' }] },
  });
  assert.equal(h.socket.count('response.create'), 2);

  // 插话处理才姗姗来迟：它该掐的是第 1 轮吃掉的 #1，不是 #2
  h.at(50);
  h.shadow.interrupt();
  assert.equal(h.shadow.willServe(), true,
    '#2 是下一句的回复，掐了它下一轮只能退回级联（用户听到换嗓子）');
});

test('这一轮没用 omni 时 interrupt 是空操作，不碰别人的回复', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  // 没人 claim，直接插话：不该把这一份取消掉（那一轮走的是别处）
  h.shadow.interrupt();
  assert.equal(h.shadow.willServe(), true);
});

test('没人认领就 completed 的回复：下一轮开口时连 user 项一起删（幽灵记忆）', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  h.socket.message({ type: 'conversation.item.created', item: { id: 'item_u1', role: 'user' } });
  h.at(30);
  h.socket.message({ type: 'response.output_item.added', item: { id: 'item_a1', role: 'assistant' } });
  h.at(40);
  // 答完了，但没人认领（ASR 没给整句 → 那一轮根本没开）
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.socket.count('conversation.item.delete'), 0, '当场不删，留到下一轮开口');

  // 下一轮开口
  h.at(50);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  const deleted = h.socket.sent.filter((s) => s.type === 'conversation.item.delete').map((s) => s.item_id);
  assert.deepEqual(deleted.sort(), ['item_a1', 'item_u1'],
    '助手和用户两条都要删：只删助手会留下「用户说了话、助手没答」的假记录');
});

test('认领过的回复下一轮不删（用户听过）', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  assert.ok(h.shadow.claim() !== null);
  h.at(20);
  h.socket.message({ type: 'response.output_item.added', item: { id: 'item_a1', role: 'assistant' } });
  h.at(30);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  h.at(40);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  assert.equal(h.socket.count('conversation.item.delete'), 0);
});

test('并段轮：B 段音频在生成期先攒着，done 之后补推再封段', () => {
  // 实测（omni-drop-probe.cjs）：同样 500 ms 语音，生成完之后推能听写出来，
  // 生成期推则只剩噪声 —— 服务端把这段 append 丢了。并段轮的真实形状正是后者。
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  const before = h.socket.count('input_audio_buffer.append');

  // 用户接着说 B（生成期）
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  assert.equal(h.socket.count('input_audio_buffer.append'), before, '生成期不直接发');

  // B 说完 → 第二次封段（撞 busy → 排队）
  h.at(30);
  h.shadow.seal(2, 40);
  assert.equal(h.socket.count('input_audio_buffer.commit'), 1, '第二发 commit 要等 done');

  // 第一份 done → 先补推 B，再发第二组 commit+create
  h.at(40);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const types = h.socket.types();
  const pushAt = types.lastIndexOf('input_audio_buffer.append');
  const commitAt = types.lastIndexOf('input_audio_buffer.commit');
  assert.equal(h.socket.count('input_audio_buffer.append'), before + 1, 'B 段补推上去了');
  assert.ok(pushAt < commitAt, '补推必须在 commit 之前，否则那一段还是空的');
  assert.equal(h.socket.count('input_audio_buffer.commit'), 2);
});
