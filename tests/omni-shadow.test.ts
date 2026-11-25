/**
 * omni 一体化车道（客户端这一侧）。
 *
 * 这里只验客户端行为 —— 计时口径、闭嘴（mute）、忙时排队、延迟删、回注。
 * 真实延迟 / 成本 / 服务端协议行为在 `tmp/omni-probe/` 里量。
 *
 * 四条最要紧的回归：
 * - **封段之后一块静音都不许发**（能量门 `holdMs` 2 s 比 `commitMs` 20 ms 长得多）
 * - **忙时不许发 `response.create`**（服务端会拒且那一次 create 永久丢失）
 * - **`delete` 不能当场发**（item id 在 `response.done` 里，那会儿通常连 created 都没到）
 * - **后台汇报只在完全空闲时开**，读端只绑自己那一份，不许跟到用户的下一段
 * - **不传静态记忆 / 日期 / 热词时 `session.update` 与基线逐字一致**；传了只追加事实
 * - **健康 ready 上 `answerFromText` 用 user 源直答**，空文本和忙时一个帧都不发
 * - **临时 prompt user 项在 speakFromText / enqueueSpeech 结束时删掉**；answerFromText 的用户真话留下
 * - **首次就绪会冲刷 connecting 期间排队的回注、删项、工具回执和动态事实**
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OmniShadow, type OmniShadowOptions } from '../src/omni-shadow.ts';
import { OMNI_SHORT_INSTRUCTIONS } from '../src/persona.ts';
import type { AgentAudioAnswer } from '../src/providers.ts';
import type { RealtimeSocket } from '../src/qwen-realtime-asr.ts';

interface Sent {
  type: string;
  audio?: string;
  item_id?: string;
  item?: {
    role?: string;
    type?: string;
    call_id?: string;
    output?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  response?: { modalities?: readonly string[] };
  session?: {
    instructions?: string;
    modalities?: string[];
    turn_detection?: null;
    tools?: Array<{
      name?: string;
      description?: string;
      parameters?: {
        properties?: {
          request?: { description?: string };
        };
      };
    }>;
    tool_choice?: string;
    input_audio_transcription?: {
      model?: string;
      language?: string;
      corpus?: { text?: string };
    };
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

function make(
  serve: 'off' | 'full' = 'off',
  extra: Partial<Omit<OmniShadowOptions, 'apiKey' | 'emit' | 'socketFactory' | 'now' | 'serve'>> = {},
) {
  const socket = new FakeSocket();
  const events: Array<Record<string, unknown>> = [];
  let clock = 0;
  const shadow = new OmniShadow({
    apiKey: 'k',
    ...extra,
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

/** 生成器该马上结束。跟错 `next` 时会挂在 `waitLive`（5 s）上，这里先判超时。 */
function finishSoon(work: Promise<unknown>, ms = 400): Promise<'done' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    work.then(() => {
      clearTimeout(timer);
      resolve('done');
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
  assert.equal(h.socket.count('input_audio_buffer.commit'), 0);
  assert.equal(
    h.socket.count('input_audio_buffer.append'),
    0,
    '会话还没 updated，先别把音频推进未配置好格式的 socket',
  );
  // 封段作废也不能把字节账清零：就绪后预卷还在，下一次封段要能 commit。
  h.socket.message({ type: 'session.updated' });
  assert.equal(h.socket.count('input_audio_buffer.append'), 1, '就绪后补推 connecting 期间的预卷');
  assert.equal(h.socket.count('input_audio_buffer.commit'), 0);
  h.shadow.seal(8, 10);
  assert.equal(h.socket.count('input_audio_buffer.commit'), 1);
  assert.equal(h.socket.count('response.create'), 1);
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
  const description = tool?.description ?? '';
  assert.ok(
    description.includes('应一声'),
    `缺了这句委派轮就没有声音，得退回预录回执。实际描述：${description || '（没有工具）'}`,
  );
  assert.ok(description.includes('不要先讲答案'), '应声之后不能先讲正文');
  assert.equal(description.includes('查询实时信息'), false, '宽泛的实时查询会把闲聊拉去调工具');
  assert.ok(description.includes('冷门书名'), '听不清的冷门专名要能委派核实');
  assert.ok(description.includes('听岔'), '不能顺着近音词编造书名或电影');
  const request = tool?.parameters?.properties?.request?.description ?? '';
  assert.ok(request.includes('不要擅自换话题'), '用户在质疑时要照实写清要核实什么');
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

test('canSpeakBackground 只在完全空闲的 ready 上为真', () => {
  const idle = make('full');
  assert.equal(idle.shadow.currentState, 'idle');
  assert.equal(idle.shadow.canSpeakBackground(), false);
  assert.equal(idle.shadow.speakFromText('汇报'), null);
  assert.equal(idle.socket.sent.length, 0);

  const connecting = make('full');
  connecting.shadow.start();
  connecting.socket.open();
  assert.equal(connecting.shadow.currentState, 'connecting');
  assert.equal(connecting.shadow.canSpeakBackground(), false);
  const connectingSent = connecting.socket.sent.length;
  assert.equal(connecting.shadow.speakFromText('汇报'), null);
  assert.equal(connecting.socket.sent.length, connectingSent);
  assert.equal(connecting.socket.count('response.create'), 0);

  const off = make('off');
  off.ready();
  assert.equal(off.shadow.currentState, 'ready');
  assert.equal(off.shadow.canSpeakBackground(), false);
  const offSent = off.socket.sent.length;
  assert.equal(off.shadow.speakFromText('汇报'), null);
  assert.equal(off.socket.sent.length, offSent);
  assert.equal(off.socket.count('response.create'), 0);

  const quiet = make('full');
  quiet.ready();
  assert.equal(quiet.shadow.canSpeakBackground(), true, 'ready、无回复、无排队、无脏音频');

  quiet.shadow.feed(Buffer.alloc(MS * 40), true);
  assert.equal(quiet.shadow.canSpeakBackground(), false, '有未提交的用户音频');

  const busy = make('full');
  busy.ready();
  busy.shadow.restart([Buffer.alloc(MS * 40)]);
  busy.shadow.seal(1, 10);
  assert.equal(busy.shadow.currentState, 'busy');
  assert.equal(busy.shadow.canSpeakBackground(), false);
  busy.socket.message({ type: 'response.created' });
  busy.shadow.feed(Buffer.alloc(MS * 40), true);
  busy.shadow.seal(2, 10);
  assert.equal(busy.shadow.explain().pending, true);
  assert.equal(busy.shadow.canSpeakBackground(), false, '有排队封段');

  const broken = make('full');
  broken.ready();
  broken.socket.close();
  assert.equal(broken.shadow.currentState, 'broken');
  assert.equal(broken.shadow.canSpeakBackground(), false);
});

test('speakFromText：就绪时已冲掉排队回注，再开汇报，流式音频和转写，done 回到 ready', async () => {
  const h = make('full');
  h.shadow.start();
  h.socket.open();
  // 还在 connecting：回注只能排队。首次 session.updated 进入 ready 时统一冲刷。
  h.shadow.injectAnswer('灯关了吗', '已经关掉了。');
  assert.equal(h.socket.count('conversation.item.create'), 0);
  h.socket.message({ type: 'session.updated' });
  assert.equal(h.socket.count('conversation.item.create'), 1);
  assert.match(h.socket.sent.at(-1)?.item?.content?.[0]?.text ?? '', /已经关掉了/);
  assert.equal(h.shadow.canSpeakBackground(), true);

  const mark = h.socket.sent.length;
  const answer = h.shadow.speakFromText('用一两句告诉哥：灯已经关了。', {
    taskId: 'task-1',
    query: '关灯',
  });
  assert.ok(answer);
  const frames = h.socket.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), [
    'conversation.item.create',
    'response.create',
  ]);
  const prompt = frames[0]?.item;
  assert.equal(prompt?.role, 'user');
  assert.equal(prompt?.content?.[0]?.type, 'input_text');
  assert.equal(prompt?.content?.[0]?.text, '用一两句告诉哥：灯已经关了。');
  assert.deepEqual(frames[1]?.response, { modalities: ['audio', 'text'] });

  assert.equal(h.shadow.currentState, 'busy');
  assert.equal(h.shadow.willServe(), false, '后台汇报不是用户这一轮的答案');
  assert.equal(h.shadow.claim(), null);
  assert.equal(h.shadow.explain().turn_seqs, 0, '不许把汇报记成一次用户封段');

  assert.equal(answer!.transcript(), '');
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '灯' });
  assert.equal(answer!.transcript(), '灯');
  h.socket.message({ type: 'response.text.delta', delta: '关好了' });
  assert.equal(answer!.transcript(), '灯关好了');
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'completed',
      usage: {
        input_tokens_details: { text_tokens: 12 },
        output_tokens_details: { audio_tokens: 8 },
      },
      output: [{ id: 'asst_ann', role: 'assistant' }],
    },
  });

  const got: Buffer[] = [];
  for await (const chunk of answer!.chunks) {
    got.push(chunk);
  }
  assert.equal(got.length, 1);
  assert.equal(got[0]?.length, 480);
  assert.equal(h.shadow.currentState, 'ready');
  assert.equal(h.shadow.canSpeakBackground(), true);
  assert.equal(h.events.length, 0, '后台汇报不能记成 omni.shadow 用户封段');
  assert.equal(h.socket.count('conversation.item.delete'), 0, '正常说完的助手项要留在上下文里');
});

test('speakFromText 先删没人听过的孤儿回复，再开汇报', () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  h.socket.message({ type: 'conversation.item.created', item: { id: 'orphan_user', role: 'user' } });
  h.socket.message({
    type: 'response.done',
    response: { status: 'completed', output: [{ id: 'orphan_asst', role: 'assistant' }] },
  });
  assert.equal(h.socket.count('conversation.item.delete'), 0, '孤儿留到下一次开口再删');
  assert.equal(h.events.length, 1);

  const mark = h.socket.sent.length;
  const answer = h.shadow.speakFromText('结果是灯关了');
  assert.ok(answer);
  const frames = h.socket.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), [
    'conversation.item.delete',
    'conversation.item.delete',
    'conversation.item.create',
    'response.create',
  ]);
  assert.deepEqual(
    frames.slice(0, 2).map((frame) => frame.item_id),
    ['orphan_asst', 'orphan_user'],
  );
  assert.equal(frames[2]?.item?.content?.[0]?.text, '结果是灯关了');
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.events.length, 1, '汇报的 done 不能再记一条用户 seal');
  assert.equal(h.events[0]?.['seq'], 1);
});

test('speakFromText：忙或有脏音频时返回 null，一帧都不发', () => {
  const busy = make('full');
  busy.ready();
  busy.shadow.restart([Buffer.alloc(MS * 40)]);
  busy.shadow.seal(1, 10);
  busy.shadow.injectAnswer('灯关了吗', '已经关掉了。');
  assert.equal(busy.socket.count('conversation.item.create'), 0, '忙时回注只排队');
  const busySent = busy.socket.sent.length;
  assert.equal(busy.shadow.speakFromText('汇报'), null);
  assert.equal(busy.socket.sent.length, busySent, '拒绝时不许把排队的回注提前发出去');

  const dirty = make('full');
  dirty.ready();
  dirty.shadow.feed(Buffer.alloc(MS * 20), true);
  assert.equal(dirty.shadow.canSpeakBackground(), false);
  const dirtySent = dirty.socket.sent.length;
  assert.equal(dirty.shadow.speakFromText('汇报'), null);
  assert.equal(dirty.socket.sent.length, dirtySent);
  assert.equal(dirty.socket.count('response.create'), 0);
});

test('cancelBackgroundSpeech：created 之前推迟 cancel，没出声就删助手项并立刻结束', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  const answer = h.shadow.speakFromText('灯已经关了');
  assert.ok(answer);
  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  h.shadow.cancelBackgroundSpeech();
  assert.equal(await finishSoon(drain), 'done', '生成器必须马上醒，不能等 response.done');
  assert.equal(got.length, 0);
  assert.equal(h.socket.count('response.cancel'), 0, 'created 之前发会被服务端拒');

  h.socket.message({ type: 'conversation.item.created', item: { id: 'note_user', role: 'user' } });
  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1, 'created 到了才补发');

  h.socket.message({
    type: 'response.done',
    response: {
      status: 'cancelled',
      output: [
        { id: 'note_user', role: 'user' },
        { id: 'note_asst', role: 'assistant' },
      ],
    },
  });
  const deleted = h.socket.sent.filter((frame) => frame.type === 'conversation.item.delete')
    .map((frame) => frame.item_id);
  assert.deepEqual(deleted, ['note_asst', 'note_user'], '没出声：删助手项，并删掉临时 prompt user');
  assert.equal(h.shadow.currentState, 'ready');
  assert.equal(h.events.length, 0);
});

test('cancelBackgroundSpeech：出过声就留助手项，而且绝不取消用户回复', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  const answer = h.shadow.speakFromText('灯已经关了');
  assert.ok(answer);
  h.socket.message({ type: 'response.created' });
  h.socket.message({ type: 'conversation.item.created', item: { id: 'note_user', role: 'user' } });

  const got: Buffer[] = [];
  let resolvePulled: (() => void) | undefined;
  const pulled = new Promise<void>((resolve) => {
    resolvePulled = resolve;
  });
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
      resolvePulled?.();
    }
  })();
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '灯关了' });
  await pulled;
  assert.equal(got.length, 1);
  assert.equal(got[0]?.length, 480);
  assert.equal(answer!.transcript(), '灯关了');

  h.shadow.cancelBackgroundSpeech();
  assert.equal(h.socket.count('response.cancel'), 1);
  assert.equal(await finishSoon(drain), 'done');
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'cancelled',
      output: [
        { id: 'note_user', role: 'user' },
        { id: 'note_asst', role: 'assistant' },
      ],
    },
  });
  const deleted = h.socket.sent.filter((frame) => frame.type === 'conversation.item.delete')
    .map((frame) => frame.item_id);
  assert.deepEqual(deleted, ['note_user'], '出过声的助手项留下，临时 prompt user 删掉');
  assert.equal(h.events.length, 0);

  h.shadow.restart([Buffer.alloc(MS * 80)]);
  h.shadow.seal(3, 15);
  h.socket.message({ type: 'response.created' });
  assert.ok(h.shadow.claim() !== null, '这是用户自己的回复');
  const cancels = h.socket.count('response.cancel');
  h.shadow.cancelBackgroundSpeech();
  assert.equal(h.socket.count('response.cancel'), cancels, '用户回复不许被后台取消误伤');
  assert.equal(h.shadow.currentState, 'busy');
});

test('用户开口打断后台汇报：生成器不追 next，用户封段等 announce done 再发', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  const answer = h.shadow.speakFromText('后台：灯已经关了');
  assert.ok(answer);
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '后台句' });
  assert.equal(answer!.transcript(), '后台句');
  assert.equal(h.shadow.willServe(), false);
  assert.equal(h.shadow.claim(), null, '后台这份不能被用户 claim 拿走');

  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.shadow.feed(Buffer.alloc(MS * 80), true);
  h.shadow.seal(9, 30);
  assert.equal(await finishSoon(drain), 'done', '必须停在自己这份上，不能去等用户的下一段');
  assert.equal(got.length, 0);
  assert.equal(h.socket.count('response.create'), 1, 'announce 的 done 之前不能发用户 create');
  assert.equal(h.shadow.willServe(), true, '排队中的用户封段算能答');

  const user = h.shadow.claim();
  assert.ok(user);
  assert.equal(user!.transcript(), '', '认领不能绑到后台那一份上');
  const userGot: Buffer[] = [];
  const userDrain = (async () => {
    for await (const chunk of user!.chunks) {
      userGot.push(chunk);
    }
  })();

  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1, 'created 之前的取消要补发');
  assert.equal(h.socket.count('response.create'), 1);
  h.socket.message({ type: 'conversation.item.created', item: { id: 'note_user', role: 'user' } });
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'cancelled',
      output: [
        { id: 'note_user', role: 'user' },
        { id: 'note_asst', role: 'assistant' },
      ],
    },
  });
  const deleted = h.socket.sent.filter((frame) => frame.type === 'conversation.item.delete')
    .map((frame) => frame.item_id);
  assert.deepEqual(deleted, ['note_asst', 'note_user'], '一个字都没播过：删助手项，并删掉临时 prompt user');
  assert.equal(h.socket.count('response.create'), 2, '用户排队的封段在 done 之后发出');
  const creates = h.socket.sent.filter((frame) => frame.type === 'response.create');
  assert.deepEqual(creates[0]?.response, { modalities: ['audio', 'text'] });
  assert.equal(creates[1]?.response, undefined, '用户封段仍是原来的 create，不带汇报的 modalities');

  assert.equal(user!.transcript(), '');
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '用户句' });
  assert.equal(user!.transcript(), '用户句');
  assert.equal(answer!.transcript(), '后台句', '后台转写不能被用户的下一段改写');
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(960).toString('base64') });
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await userDrain;
  assert.equal(userGot.reduce((sum, chunk) => sum + chunk.length, 0), 960);
  assert.equal(got.length, 0, 'announce 生成器不能去追用户的下一段');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.['seq'], 9);
  assert.equal(h.events[0]?.['warmup'], true, '汇报不能占掉用户封段的 warmup');
});

test('后台汇报途中断线、stop 或 response 超时：生成器结束，不挂死', { timeout: 2000 }, async () => {
  const closed = make('full');
  closed.ready();
  const closedAnswer = closed.shadow.speakFromText('灯关了');
  assert.ok(closedAnswer);
  const closedDrain = (async () => {
    for await (const chunk of closedAnswer!.chunks) {
      void chunk;
    }
  })();
  closed.socket.close();
  assert.equal(await finishSoon(closedDrain), 'done');
  assert.equal(closed.shadow.currentState, 'broken');

  const stopped = make('full');
  stopped.ready();
  const stoppedAnswer = stopped.shadow.speakFromText('灯关了');
  assert.ok(stoppedAnswer);
  const stoppedDrain = (async () => {
    for await (const chunk of stoppedAnswer!.chunks) {
      void chunk;
    }
  })();
  stopped.shadow.stop();
  assert.equal(await finishSoon(stoppedDrain), 'done');
  assert.equal(stopped.shadow.currentState, 'broken');

  const socket = new FakeSocket();
  const events: Array<Record<string, unknown>> = [];
  const shadow = new OmniShadow({
    apiKey: 'k',
    serve: 'full',
    responseTimeoutMs: 30,
    emit: (data) => { events.push(data); },
    socketFactory: () => socket as unknown as RealtimeSocket,
  });
  shadow.start();
  socket.open();
  socket.message({ type: 'session.updated' });
  const timed = shadow.speakFromText('灯关了');
  assert.ok(timed);
  const started = Date.now();
  const chunks: Buffer[] = [];
  for await (const chunk of timed!.chunks) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 0);
  assert.ok(Date.now() - started < 1000, 'response 超时要把读端叫醒');
  assert.equal(shadow.currentState, 'broken');
  assert.equal(events.some((event) => event['audio_ms'] !== undefined), false);
  assert.equal(events.some((event) => event['skipped'] === 'broken'), true);
});

test('不传静态记忆、日期、热词时 session.update 与基线逐字一致', () => {
  const baseline = make('full');
  baseline.ready();
  let clocks = 0;
  const empty = make('full', {
    memoryContext: ' \n\t',
    clockContext: () => {
      clocks += 1;
      return ' \n';
    },
    asrCorpusText: '',
    asrLanguage: '',
  });
  empty.ready();
  assert.equal(clocks, 1, '空白日期也只在建连时调用一次');
  assert.equal(JSON.stringify(empty.socket.sent[0]), JSON.stringify(baseline.socket.sent[0]));
  assert.equal(baseline.socket.sent[0]?.session?.instructions, OMNI_SHORT_INSTRUCTIONS);
  assert.deepEqual(baseline.socket.sent[0]?.session?.input_audio_transcription, {
    model: 'qwen3-asr-flash-realtime',
  });

  const custom = make('off', { instructions: 'BASE' });
  const customEmpty = make('off', {
    instructions: 'BASE',
    memoryContext: '',
    clockContext: () => '',
    asrLanguage: '',
    asrCorpusText: '',
  });
  custom.ready();
  customEmpty.ready();
  assert.equal(JSON.stringify(customEmpty.socket.sent[0]), JSON.stringify(custom.socket.sent[0]));
  assert.equal(custom.socket.sent[0]?.session?.instructions, 'BASE');
  assert.equal(custom.socket.sent[0]?.session?.tools, undefined);
});

test('建连只追加静态事实和 ASR 热词，热路径不再调用时钟', () => {
  let clocks = 0;
  const h = make('full', {
    clockContext: () => {
      clocks += 1;
      return '当前日期：2026年11月24日 星期二（北京时间）';
    },
    memoryContext: '  对花生过敏  ',
    asrLanguage: 'zh',
    asrCorpusText: '眼镜',
  });
  assert.equal(clocks, 0, '握手之前不调用');
  h.shadow.start();
  assert.equal(clocks, 0);
  h.socket.open();
  assert.equal(clocks, 1);
  h.socket.message({ type: 'session.updated' });
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  assert.equal(clocks, 1, '封段不再读日期');

  const session = h.socket.sent[0]?.session;
  assert.equal(
    session?.instructions,
    `${OMNI_SHORT_INSTRUCTIONS}\n\n【当前日期参考】\n`
      + '当前日期：2026年11月24日 星期二（北京时间）\n\n'
      + '【关于哥的已知长期记忆（仅供如实回答，不要主动复述）】\n对花生过敏',
  );
  assert.equal(session?.instructions?.includes('调用工具'), false);
  assert.equal(session?.instructions?.includes('要不要调'), false);
  assert.deepEqual(session?.input_audio_transcription, {
    model: 'qwen3-asr-flash-realtime',
    language: 'zh',
    corpus: { text: '眼镜' },
  });
  assert.equal(session?.tools?.[0]?.name, 'delegate_to_assistant');
  assert.equal(session?.tool_choice, 'auto');
});

test('长期记忆超过 600 字截断；缺的事实块和空热词都不写', () => {
  const memoryOnly = make('off', { memoryContext: `头${'记'.repeat(600)}` });
  memoryOnly.ready();
  const memoryText = memoryOnly.socket.sent[0]?.session?.instructions ?? '';
  const marker = '\n\n【关于哥的已知长期记忆（仅供如实回答，不要主动复述）】\n';
  assert.equal(memoryText.startsWith(OMNI_SHORT_INSTRUCTIONS), true);
  assert.equal(memoryText.includes('【当前日期参考】'), false);
  const fact = memoryText.slice(OMNI_SHORT_INSTRUCTIONS.length + marker.length);
  assert.equal(fact, `头${'记'.repeat(599)}`);
  assert.equal(fact.length, 600);
  assert.equal(memoryText.length, OMNI_SHORT_INSTRUCTIONS.length + marker.length + 600);

  const clockOnly = make('off', {
    instructions: 'BASE',
    clockContext: () => '当前日期：2026年11月24日 星期二（北京时间）',
    memoryContext: '',
  });
  clockOnly.ready();
  assert.equal(
    clockOnly.socket.sent[0]?.session?.instructions,
    'BASE\n\n【当前日期参考】\n当前日期：2026年11月24日 星期二（北京时间）',
  );
  assert.deepEqual(clockOnly.socket.sent[0]?.session?.input_audio_transcription, {
    model: 'qwen3-asr-flash-realtime',
  });

  const langOnly = make('off', { asrLanguage: 'zh' });
  langOnly.ready();
  assert.deepEqual(langOnly.socket.sent[0]?.session?.input_audio_transcription, {
    model: 'qwen3-asr-flash-realtime',
    language: 'zh',
  });

  const corpusOnly = make('off', { asrCorpusText: '眼镜' });
  corpusOnly.ready();
  assert.deepEqual(corpusOnly.socket.sent[0]?.session?.input_audio_transcription, {
    model: 'qwen3-asr-flash-realtime',
    corpus: { text: '眼镜' },
  });
});

test('canAnswerText 只在车道开着且 ready、没有在途回复时为真', () => {
  const off = make('off');
  off.ready();
  assert.equal(off.shadow.canAnswerText(), false);

  const idle = make('full');
  assert.equal(idle.shadow.currentState, 'idle');
  assert.equal(idle.shadow.canAnswerText(), false);

  const connecting = make('full');
  connecting.shadow.start();
  connecting.socket.open();
  assert.equal(connecting.shadow.currentState, 'connecting');
  assert.equal(connecting.shadow.canAnswerText(), false);

  const ready = make('full');
  ready.ready();
  assert.equal(ready.shadow.canAnswerText(), true);
  ready.shadow.feed(Buffer.alloc(MS * 20), true);
  assert.equal(ready.shadow.canSpeakBackground(), false);
  assert.equal(ready.shadow.canAnswerText(), true, '残留音频不挡文本直答');

  const busy = make('full');
  busy.ready();
  busy.shadow.restart([Buffer.alloc(MS * 40)]);
  busy.shadow.seal(1, 10);
  assert.equal(busy.shadow.currentState, 'busy');
  assert.equal(busy.shadow.canAnswerText(), false);
  busy.socket.message({ type: 'response.created' });
  busy.shadow.feed(Buffer.alloc(MS * 40), true);
  busy.shadow.seal(2, 10);
  assert.equal(busy.shadow.explain().pending, true);
  assert.equal(busy.shadow.canAnswerText(), false, '有排队封段');

  const broken = make('full');
  broken.ready();
  broken.socket.close();
  assert.equal(broken.shadow.currentState, 'broken');
  assert.equal(broken.shadow.canAnswerText(), false);
});

test('answerFromText：就绪时已冲掉回注，再以 user 源开答，claim 和后台取消都拿不走', () => {
  const h = make('full');
  h.shadow.start();
  h.socket.open();
  h.shadow.injectAnswer('灯关了吗', '已经关掉了。');
  assert.equal(h.socket.count('conversation.item.create'), 0);
  h.socket.message({ type: 'session.updated' });
  assert.equal(h.socket.count('conversation.item.create'), 1);
  assert.match(h.socket.sent.at(-1)?.item?.content?.[0]?.text ?? '', /已经关掉了/);
  assert.equal(h.shadow.canAnswerText(), true);
  assert.equal(h.shadow.willServe(), false, '没有封段时 willServe 仍是 false');

  const mark = h.socket.sent.length;
  const answer = h.shadow.answerFromText('  今天星期几  ');
  assert.ok(answer);
  const frames = h.socket.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), [
    'conversation.item.create',
    'response.create',
  ]);
  assert.equal(frames[0]?.item?.role, 'user');
  assert.equal(frames[0]?.item?.content?.[0]?.type, 'input_text');
  assert.equal(frames[0]?.item?.content?.[0]?.text, '  今天星期几  ');
  assert.deepEqual(frames[1]?.response, { modalities: ['audio', 'text'] });
  assert.equal(h.shadow.currentState, 'busy');
  assert.equal(h.shadow.canAnswerText(), false);
  assert.equal(h.shadow.willServe(), false);
  assert.equal(h.shadow.claim(), null, '已认领的文本直答不能再被 claim 拿走');
  const cancels = h.socket.count('response.cancel');
  h.shadow.cancelBackgroundSpeech();
  assert.equal(h.socket.count('response.cancel'), cancels, 'user 源不许被后台取消误伤');
  assert.equal(h.shadow.currentState, 'busy');
});

test('answerFromText：空文本、车道关掉、忙着时返回 null，一帧都不发', () => {
  const ready = make('full');
  ready.ready();
  const sent = ready.socket.sent.length;
  assert.equal(ready.shadow.answerFromText(''), null);
  assert.equal(ready.shadow.answerFromText(' \n\t'), null);
  assert.equal(ready.socket.sent.length, sent);
  assert.equal(ready.shadow.currentState, 'ready');
  assert.equal(ready.shadow.canAnswerText(), true);

  const off = make('off');
  off.ready();
  const offSent = off.socket.sent.length;
  assert.equal(off.shadow.answerFromText('你好'), null);
  assert.equal(off.socket.sent.length, offSent);
  assert.equal(off.socket.count('response.create'), 0);

  const busy = make('full');
  busy.ready();
  busy.shadow.restart([Buffer.alloc(MS * 40)]);
  busy.shadow.seal(1, 10);
  busy.shadow.injectAnswer('灯关了吗', '已经关掉了。');
  assert.equal(busy.socket.count('conversation.item.create'), 0, '忙时回注只排队');
  const busySent = busy.socket.sent.length;
  assert.equal(busy.shadow.answerFromText('今天星期几'), null);
  assert.equal(busy.socket.sent.length, busySent, '拒绝时不许把排队的回注提前发出去');
  assert.equal(busy.socket.count('response.create'), 1);
});

test('answerFromText 先删没人听过的孤儿回复，再开答', () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  h.socket.message({ type: 'conversation.item.created', item: { id: 'orphan_user', role: 'user' } });
  h.socket.message({
    type: 'response.done',
    response: { status: 'completed', output: [{ id: 'orphan_asst', role: 'assistant' }] },
  });
  assert.equal(h.socket.count('conversation.item.delete'), 0);
  assert.equal(h.events.length, 1);

  const mark = h.socket.sent.length;
  const answer = h.shadow.answerFromText('今天星期几');
  assert.ok(answer);
  const frames = h.socket.sent.slice(mark);
  assert.deepEqual(frames.map((frame) => frame.type), [
    'conversation.item.delete',
    'conversation.item.delete',
    'conversation.item.create',
    'response.create',
  ]);
  assert.deepEqual(
    frames.slice(0, 2).map((frame) => frame.item_id),
    ['orphan_asst', 'orphan_user'],
  );
  assert.equal(frames[2]?.item?.content?.[0]?.text, '今天星期几');
  assert.equal(h.events.length, 1, '开答本身先不记 seal，等 response.done');
});

test('answerFromText：转写、委派和音频都在这份上，interrupt 不等 done', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.feed(Buffer.alloc(MS * 20), true);
  assert.equal(h.shadow.canAnswerText(), true);
  assert.equal(h.socket.count('input_audio_buffer.commit'), 0);
  const answer = h.shadow.answerFromText('今天吃什么') as AgentAudioAnswer & { interrupt(): void };
  assert.equal(typeof answer.interrupt, 'function');
  assert.equal(h.socket.count('input_audio_buffer.commit'), 0, '文本直答不 commit 残留音频');
  assert.equal(h.socket.count('response.create'), 1);

  assert.equal(answer.transcript(), '');
  assert.equal(answer.delegateReason?.(), null);
  assert.equal(answer.delegateText?.(), null);
  h.at(40);
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '别' });
  h.socket.message({ type: 'response.text.delta', delta: '吃花生' });
  assert.equal(answer.transcript(), '别吃花生');
  h.socket.message({
    type: 'response.function_call_arguments.done',
    arguments: '{"request":"查不含花生的菜","reason":"要查记忆"}',
  });
  assert.equal(answer.delegateReason?.(), 'delegate');
  assert.equal(answer.delegateText?.(), '查不含花生的菜');

  const got: Buffer[] = [];
  let resolvePulled: (() => void) | undefined;
  const pulled = new Promise<void>((resolve) => {
    resolvePulled = resolve;
  });
  const drain = (async () => {
    for await (const chunk of answer.chunks) {
      got.push(chunk);
      resolvePulled?.();
    }
  })();
  h.at(80);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
  await pulled;
  assert.equal(got.length, 1);
  assert.equal(got[0]?.length, 480);
  h.shadow.interrupt();
  assert.equal(await finishSoon(drain), 'done', '打断必须马上结束读端，不能等 response.done');
  assert.equal(h.socket.count('response.cancel'), 0, 'created 之前发会被服务端拒');

  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1, 'created 到了才补发');
  h.at(120);
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'cancelled',
      output: [
        { id: 'txt_user', role: 'user' },
        { id: 'txt_asst', role: 'assistant' },
      ],
    },
  });
  assert.equal(h.socket.count('conversation.item.delete'), 0, '认领过的回复打断后不删');
  assert.equal(h.shadow.currentState, 'ready');
  assert.equal(h.shadow.canAnswerText(), true);
  assert.equal(answer.transcript(), '别吃花生');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.['seq'], 0);
  assert.equal(h.events[0]?.['cancelled'], true);
  assert.equal(h.events[0]?.['warmup'], true);
});

test('answerFromText 读端自己的 interrupt 也立刻停，并且不追下一段封段', { timeout: 2000 }, async () => {
  const stopped = make('full');
  stopped.ready();
  const early = stopped.shadow.answerFromText('你好') as AgentAudioAnswer & { interrupt(): void };
  const earlyGot: Buffer[] = [];
  const earlyDrain = (async () => {
    for await (const chunk of early.chunks) {
      earlyGot.push(chunk);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  early.interrupt();
  assert.equal(await finishSoon(earlyDrain), 'done');
  assert.equal(earlyGot.length, 0);
  stopped.socket.message({ type: 'response.created' });
  assert.equal(stopped.socket.count('response.cancel'), 1);

  const h = make('full');
  h.ready();
  const answer = h.shadow.answerFromText('今天星期几');
  assert.ok(answer);
  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.shadow.feed(Buffer.alloc(MS * 80), true);
  h.shadow.seal(4, 10);
  assert.equal(h.socket.count('response.create'), 1, '文本直答还没 done，不能再发 create');
  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1);
  h.socket.message({
    type: 'response.done',
    response: { status: 'cancelled', output: [{ id: 'txt_asst', role: 'assistant' }] },
  });
  assert.equal(await finishSoon(drain), 'done');
  assert.equal(h.socket.count('response.create'), 2, '排队的封段在 done 之后发出');
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(960).toString('base64') });
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(got.length, 0, '文本直答不能把下一段封段的音频读走');
});

test('interrupt 立刻结束认领流，不等 response.done', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  const answer = h.shadow.claim();
  assert.ok(answer);
  const got: Buffer[] = [];
  const drain = (async () => {
    for await (const chunk of answer!.chunks) {
      got.push(chunk);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.shadow.interrupt();
  assert.equal(await finishSoon(drain), 'done');
  assert.equal(got.length, 0);
  assert.equal(h.socket.count('response.cancel'), 0);
  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1);
});

test('并段 pending 在 break 之后 willServe 必为 false', () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.shadow.seal(1, 40);
  h.shadow.feed(Buffer.alloc(MS * 100), true);
  h.shadow.seal(2, 40);
  assert.equal(h.shadow.explain().pending, true);
  assert.equal(h.shadow.willServe(), true);
  assert.equal(h.shadow.currentState, 'busy');

  h.socket.close();
  assert.equal(h.shadow.currentState, 'broken');
  assert.equal(h.shadow.explain().pending, false);
  assert.equal(h.shadow.willServe(), false);
  assert.equal(h.shadow.canAnswerText(), false);
  assert.equal(h.shadow.canSpeakBackground(), false);
  assert.equal(h.shadow.claim(), null);

  const stopped = make('full');
  stopped.ready();
  stopped.shadow.restart([Buffer.alloc(MS * 100)]);
  stopped.shadow.seal(1, 40);
  stopped.shadow.feed(Buffer.alloc(MS * 80), true);
  stopped.shadow.seal(2, 40);
  assert.equal(stopped.shadow.explain().pending, true);
  stopped.shadow.stop();
  assert.equal(stopped.shadow.currentState, 'broken');
  assert.equal(stopped.shadow.explain().pending, false);
  assert.equal(stopped.shadow.willServe(), false);
});

test('injectAnswer 在 broken 或 socket 未打开时不计数', () => {
  const idle = make('full');
  idle.shadow.injectAnswer('问', '答');
  idle.ready();
  idle.shadow.restart([Buffer.alloc(MS * 40)]);
  idle.shadow.seal(1, 10);
  idle.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(idle.events.at(-1)?.['injects_sent'], 0);

  const live = make('full');
  live.ready();
  live.shadow.injectAnswer('问', '答');
  live.shadow.restart([Buffer.alloc(MS * 40)]);
  live.shadow.seal(1, 10);
  live.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(live.events.at(-1)?.['injects_sent'], 1);

  const broken = make('full');
  broken.ready();
  broken.socket.close();
  const sent = broken.socket.sent.length;
  broken.shadow.injectAnswer('问', '还在吗');
  assert.equal(broken.socket.sent.length, sent);
});

test('enqueueSpeech：discard 后在途未完时入队，等 response.done 才发，不撞 busy；多条 FIFO 串行', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.shadow.seal(1, 30);
  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.create'), 1);

  // 模拟 clock_override / cancel_bg：先 discard（cancel 已发出，但还没 response.done），紧接着 enqueueSpeech
  h.shadow.discard();
  assert.equal(h.socket.count('response.cancel'), 1);
  const first = h.shadow.enqueueSpeech('应一声：我看一眼时间', { kind: 'ack' });
  const second = h.shadow.enqueueSpeech('再说一句：顺带报结果', { kind: 'ack' });
  assert.ok(first !== null && second !== null);
  assert.equal(h.socket.count('response.create'), 1, '上一份 response.done 之前绝不能抢发第二条 create');

  const chunks1: Buffer[] = [];
  const chunks2: Buffer[] = [];
  const drain1 = (async () => { for await (const c of first.chunks) chunks1.push(c); })();
  const drain2 = (async () => { for await (const c of second.chunks) chunks2.push(c); })();

  // 被丢弃的那份收尾 → 队列第 1 条自动发出
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(h.socket.count('response.create'), 2);
  h.socket.message({ type: 'response.created' });
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.from([1, 2, 3, 4]).toString('base64') });
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '我看一眼。' });
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await drain1;
  assert.equal(first.transcript(), '我看一眼。');
  assert.equal(chunks1.length, 1);

  // 第 1 条收尾 → 队列第 2 条自动按 FIFO 发出
  assert.equal(h.socket.count('response.create'), 3);
  h.socket.message({ type: 'response.created' });
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.from([5, 6]).toString('base64') });
  h.socket.message({ type: 'response.audio_transcript.delta', delta: '四点整。' });
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await drain2;
  assert.equal(second.transcript(), '四点整。');
  assert.equal(chunks2.length, 1);
  assert.equal(h.shadow.currentState, 'ready');
});

test('enqueueSpeech：排队期间被 interrupt / restart / break 干净收尾不挂死', { timeout: 2000 }, async () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.shadow.seal(1, 30);
  h.socket.message({ type: 'response.created' });

  const q1 = h.shadow.enqueueSpeech('第一条', { kind: 'ack' });
  const q2 = h.shadow.enqueueSpeech('第二条', { kind: 'announce', taskId: 't2' });
  assert.ok(q1 !== null && q2 !== null);

  q1.interrupt();
  const got1: Buffer[] = [];
  for await (const c of q1.chunks) got1.push(c);
  assert.equal(got1.length, 0);

  // 用户重新开口清空还没发出的队列
  h.shadow.restart([Buffer.alloc(MS * 60)]);
  const got2: Buffer[] = [];
  for await (const c of q2.chunks) got2.push(c);
  assert.equal(got2.length, 0);
  assert.equal(h.socket.count('response.create'), 1, '被取消的排队项一帧都不许发出去');
});

test('捕获 function_call 的 call_id，answer 能读出 delegateCallId 和助手项 id', () => {
  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  const answer = h.shadow.claim();
  assert.ok(answer);
  assert.equal(answer.delegateCallId?.(), null);
  assert.equal(answer.userItemId?.(), null);
  assert.deepEqual(answer.assistantItemIds?.(), []);

  h.socket.message({
    type: 'response.output_item.added',
    item: { id: '', type: 'function_call', call_id: '' },
  });
  assert.equal(answer.delegateCallId?.(), null, '空 call_id / 空 item id 不记');
  assert.deepEqual(answer.assistantItemIds?.(), []);

  h.socket.message({
    type: 'response.output_item.added',
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_added' },
  });
  h.socket.message({
    type: 'response.output_item.added',
    item: { id: 'asst_1', role: 'assistant' },
  });
  h.socket.message({ type: 'conversation.item.created', item: { id: 'user_1', role: 'user' } });
  assert.equal(answer.delegateCallId?.(), 'call_added');
  assert.deepEqual(answer.assistantItemIds?.(), ['fc_1', 'asst_1']);
  assert.equal(answer.userItemId?.(), 'user_1');

  h.socket.message({
    type: 'response.function_call_arguments.done',
    call_id: 'call_done',
    arguments: '{"request":"把灯关上","reason":"要操作设备"}',
  });
  assert.equal(answer.delegateCallId?.(), 'call_done', 'arguments.done 覆盖 added 里的 call_id');
  assert.equal(answer.delegateReason?.(), 'delegate');
  assert.equal(answer.delegateText?.(), '把灯关上');

  h.socket.message({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [
        { id: 'fc_1', type: 'function_call', call_id: 'call_done' },
        { id: 'asst_1', role: 'assistant' },
        { id: 'fc_late', type: 'function_call', call_id: 'call_should_not_override' },
      ],
    },
  });
  assert.equal(answer.delegateCallId?.(), 'call_done', '已经有 call_id 时终态 output 不覆盖');
  assert.deepEqual(answer.assistantItemIds?.(), ['fc_1', 'asst_1', 'fc_late']);

  const backfill = make('full');
  backfill.ready();
  backfill.shadow.restart([Buffer.alloc(MS * 40)]);
  backfill.shadow.seal(1, 10);
  const late = backfill.shadow.claim();
  assert.ok(late);
  backfill.socket.message({
    type: 'response.output_item.added',
    item: { id: 'fc_only', type: 'function_call' },
  });
  backfill.socket.message({
    type: 'response.function_call_arguments.done',
    arguments: '{"request":"开灯","reason":"操作"}',
  });
  assert.equal(late.delegateCallId?.(), null);
  backfill.socket.message({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ id: 'fc_only', type: 'function_call', call_id: 'call_from_output' }],
    },
  });
  assert.equal(late.delegateCallId?.(), 'call_from_output');
  assert.deepEqual(late.assistantItemIds?.(), ['fc_only']);
});

test('sendFunctionCallOutput：忙时排队，回到 ready 先于下一次 response.create', () => {
  const ready = make('full');
  ready.ready();
  const before = ready.socket.sent.length;
  ready.shadow.sendFunctionCallOutput('call_now', 'ok');
  ready.shadow.sendFunctionCallOutput('', 'no');
  ready.shadow.sendFunctionCallOutput('call_empty', '');
  assert.equal(ready.socket.sent.length, before + 1);
  assert.equal(ready.socket.sent[before]?.item?.type, 'function_call_output');
  assert.equal(ready.socket.sent[before]?.item?.call_id, 'call_now');
  assert.equal(ready.socket.sent[before]?.item?.output, 'ok');
  ready.socket.close();
  const closed = ready.socket.sent.length;
  ready.shadow.sendFunctionCallOutput('call_dead', '不再发');
  assert.equal(ready.socket.sent.length, closed);

  const h = make('full');
  h.ready();
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  assert.equal(h.socket.count('response.create'), 1);
  const mark = h.socket.sent.length;
  h.shadow.sendFunctionCallOutput('call_a', '第一份');
  h.shadow.sendFunctionCallOutput('call_b', '第二份');
  h.shadow.sendFunctionCallOutput('', '忽略');
  h.shadow.sendFunctionCallOutput('call_c', '');
  assert.equal(
    h.socket.sent.slice(mark).some((frame) => frame.item?.type === 'function_call_output'),
    false,
    '忙时只排队',
  );
  const queued = h.shadow.enqueueSpeech('补一句结果', { kind: 'ack' });
  assert.ok(queued);
  assert.equal(h.socket.count('response.create'), 1, '上一条 response.done 之前不能抢发');

  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const tail = h.socket.sent.slice(mark);
  const outputs = tail.filter((frame) => frame.item?.type === 'function_call_output');
  assert.deepEqual(
    outputs.map((frame) => [frame.item?.call_id, frame.item?.output]),
    [
      ['call_a', '第一份'],
      ['call_b', '第二份'],
    ],
  );
  const createAt = tail.findIndex((frame) => frame.type === 'response.create');
  const lastOutput = tail.reduce(
    (acc, frame, idx) => (frame.item?.type === 'function_call_output' ? idx : acc),
    -1,
  );
  assert.ok(createAt > lastOutput && lastOutput >= 0, '工具回执必须先于下一次 response.create');

  const capped = make('full');
  capped.ready();
  capped.shadow.restart([Buffer.alloc(MS * 20)]);
  capped.shadow.seal(1, 5);
  for (let i = 0; i < 9; i += 1) {
    capped.shadow.sendFunctionCallOutput(`c${i}`, `o${i}`);
  }
  capped.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const cappedIds = capped.socket.sent
    .filter((frame) => frame.item?.type === 'function_call_output')
    .map((frame) => frame.item?.call_id);
  assert.deepEqual(cappedIds, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
});

test('updateDynamicContext：单槽合并、去重，并发完整 session 配置', () => {
  const h = make('full');
  h.ready();
  assert.equal(h.socket.count('session.update'), 1);
  const handshake = h.socket.sent[0]?.session?.instructions;
  assert.equal(handshake, OMNI_SHORT_INSTRUCTIONS);

  h.shadow.updateDynamicContext('  事实A  ');
  assert.equal(h.socket.count('session.update'), 2);
  const updated = h.socket.sent.at(-1)?.session;
  assert.equal(updated?.instructions, `${handshake}\n\n事实A`);
  assert.equal(updated?.turn_detection, null);
  assert.deepEqual(updated?.modalities, ['text', 'audio']);
  assert.equal(updated?.tool_choice, 'auto');
  assert.equal(updated?.tools?.length, 1);
  assert.equal(updated?.tools?.[0]?.name, 'delegate_to_assistant');

  h.shadow.updateDynamicContext('事实A');
  h.shadow.updateDynamicContext('  事实A');
  assert.equal(h.socket.count('session.update'), 2, '与已发送内容相同就不再发');

  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  h.shadow.updateDynamicContext('第一份');
  h.shadow.updateDynamicContext('第二份');
  h.shadow.updateDynamicContext('  最后一份  ');
  assert.equal(h.socket.count('session.update'), 2, '忙时多次调用只保留最后一份');
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.socket.count('session.update'), 3);
  const merged = h.socket.sent.at(-1)?.session;
  assert.equal(merged?.instructions, `${handshake}\n\n最后一份`);
  assert.equal(merged?.instructions?.includes('第一份'), false);
  assert.equal(merged?.instructions?.includes('第二份'), false);
  assert.equal(merged?.turn_detection, null);
  assert.equal(merged?.tools?.[0]?.name, 'delegate_to_assistant');
  assert.equal(merged?.tool_choice, 'auto');

  h.shadow.updateDynamicContext('   ');
  assert.equal(h.socket.count('session.update'), 4);
  assert.equal(h.socket.sent.at(-1)?.session?.instructions, handshake, '清空后与原来逐字一致');

  let clocks = 0;
  const rich = make('full', {
    instructions: 'BASE',
    clockContext: () => {
      clocks += 1;
      return '今天';
    },
    memoryContext: '花生',
  });
  rich.ready();
  assert.equal(clocks, 1);
  rich.shadow.updateDynamicContext('动态');
  assert.equal(clocks, 2, '刷新动态事实会再组一次 instructions');
  assert.equal(
    rich.socket.sent.at(-1)?.session?.instructions,
    'BASE\n\n【当前日期参考】\n今天\n\n'
      + '【关于哥的已知长期记忆（仅供如实回答，不要主动复述）】\n花生\n\n动态',
  );
  assert.equal(rich.socket.sent.at(-1)?.session?.turn_detection, null);
  assert.equal(rich.socket.sent.at(-1)?.session?.tools?.[0]?.name, 'delegate_to_assistant');

  const off = make('off', { instructions: 'BASE' });
  off.ready();
  off.shadow.updateDynamicContext('只是事实');
  const offSession = off.socket.sent.at(-1)?.session;
  assert.equal(offSession?.instructions, 'BASE\n\n只是事实');
  assert.equal(offSession?.tools, undefined);
  assert.equal(offSession?.turn_detection, null);
});

test('回到 ready 时控制帧按删除、工具回执、动态事实、回注的顺序冲刷', () => {
  const h = make('full');
  h.shadow.start();
  h.socket.open();
  h.shadow.deleteItems(['pend_del', '', 'pend_del']);
  h.shadow.sendFunctionCallOutput('call_q', '回执');
  h.shadow.updateDynamicContext('动态事实');
  h.shadow.injectAnswer('问', '答');
  assert.equal(h.socket.count('conversation.item.create'), 0);
  assert.equal(h.socket.count('conversation.item.delete'), 0);
  assert.equal(h.socket.count('session.update'), 1, '握手那一份还没有动态事实');
  const mark = h.socket.sent.length;
  h.socket.message({ type: 'session.updated' });
  const tail = h.socket.sent.slice(mark);
  assert.deepEqual(tail.map((frame) => {
    if (frame.type === 'conversation.item.delete') return `delete:${frame.item_id}`;
    if (frame.item?.type === 'function_call_output') return `output:${frame.item.call_id}`;
    if (frame.type === 'session.update') return 'session.update';
    if (frame.type === 'conversation.item.create') return 'inject';
    return frame.type;
  }), [
    'delete:pend_del',
    'output:call_q',
    'session.update',
    'inject',
  ]);
  assert.match(tail[2]?.session?.instructions ?? '', /\n\n动态事实$/);
  assert.equal(tail[2]?.session?.turn_detection, null);
  assert.equal(tail[2]?.session?.tools?.[0]?.name, 'delegate_to_assistant');
  assert.match(tail[3]?.item?.content?.[0]?.text ?? '', /答/);
});

test('临时 prompt user 在 done 时删掉，answerFromText 的用户真话留下', () => {
  const spoken = make('full');
  spoken.ready();
  const announce = spoken.shadow.speakFromText('用一两句告诉哥：灯关了。');
  assert.ok(announce);
  spoken.socket.message({ type: 'conversation.item.created', item: { id: 'inject_user', role: 'user' } });
  spoken.socket.message({ type: 'conversation.item.created', item: { id: 'prompt_user', role: 'user' } });
  spoken.socket.message({ type: 'response.output_item.added', item: { id: 'prompt_asst', role: 'assistant' } });
  spoken.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(480).toString('base64') });
  spoken.socket.message({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [
        { id: 'prompt_user', role: 'user' },
        { id: 'prompt_asst', role: 'assistant' },
      ],
    },
  });
  assert.deepEqual(
    spoken.socket.sent.filter((frame) => frame.type === 'conversation.item.delete').map((frame) => frame.item_id),
    ['prompt_user'],
  );
  assert.equal(announce.userItemId?.(), 'prompt_user');
  assert.deepEqual(announce.assistantItemIds?.(), ['prompt_asst']);

  const queuedHost = make('full');
  queuedHost.ready();
  const queued = queuedHost.shadow.enqueueSpeech('应一声：我看一下', { kind: 'ack' });
  assert.ok(queued);
  queuedHost.socket.message({ type: 'conversation.item.created', item: { id: 'ack_user', role: 'user' } });
  queuedHost.socket.message({
    type: 'response.done',
    response: { status: 'completed', output: [{ id: 'ack_asst', role: 'assistant' }] },
  });
  assert.deepEqual(
    queuedHost.socket.sent.filter((frame) => frame.type === 'conversation.item.delete').map((frame) => frame.item_id),
    ['ack_user'],
  );
  assert.equal(queued.userItemId?.(), 'ack_user');
  assert.deepEqual(queued.assistantItemIds?.(), ['ack_asst']);

  const answerHost = make('full');
  answerHost.ready();
  const answer = answerHost.shadow.answerFromText('今天星期几');
  assert.ok(answer);
  answerHost.socket.message({ type: 'conversation.item.created', item: { id: 'real_user', role: 'user' } });
  answerHost.socket.message({ type: 'conversation.item.created', item: { id: 'later_user', role: 'user' } });
  answerHost.socket.message({
    type: 'response.done',
    response: { status: 'completed', output: [{ id: 'real_asst', role: 'assistant' }] },
  });
  assert.equal(answerHost.socket.count('conversation.item.delete'), 0);
  assert.equal(answer.userItemId?.(), 'real_user', '用户真话保留第一次见到的 user 项');
  assert.deepEqual(answer.assistantItemIds?.(), ['real_asst']);
});

test('deleteItems：忙时排队，ready 时删除；discard 删得掉 function_call 项', () => {
  const h = make('full');
  h.ready();
  h.shadow.deleteItems(['ready_id', '', 'ready_id']);
  assert.deepEqual(
    h.socket.sent.filter((frame) => frame.type === 'conversation.item.delete').map((frame) => frame.item_id),
    ['ready_id'],
  );

  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(1, 10);
  h.shadow.deleteItems(['busy_a', '', 'busy_b', 'busy_a', 'busy_c']);
  assert.equal(
    h.socket.sent.filter((frame) => frame.item_id?.startsWith('busy_')).length,
    0,
  );
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(
    h.socket.sent.filter((frame) => frame.item_id?.startsWith('busy_')).map((frame) => frame.item_id),
    ['busy_a', 'busy_b', 'busy_c'],
  );

  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.shadow.seal(2, 10);
  h.socket.message({
    type: 'response.output_item.added',
    item: { id: 'fc_item', type: 'function_call', call_id: 'call_fc' },
  });
  h.shadow.discard();
  assert.equal(
    h.socket.sent.filter((frame) => frame.item_id === 'fc_item').length,
    0,
    'discard 当场还没有 done，不能先删',
  );
  h.socket.message({
    type: 'response.done',
    response: {
      status: 'cancelled',
      output: [{ id: 'fc_item', type: 'function_call', call_id: 'call_fc' }],
    },
  });
  assert.ok(
    h.socket.sent.some((frame) => frame.type === 'conversation.item.delete' && frame.item_id === 'fc_item'),
  );

  const capped = make('full');
  capped.ready();
  capped.shadow.restart([Buffer.alloc(MS * 20)]);
  capped.shadow.seal(1, 5);
  capped.shadow.deleteItems(Array.from({ length: 33 }, (_, i) => `id_${i}`));
  capped.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const deletedIds = capped.socket.sent
    .filter((frame) => frame.type === 'conversation.item.delete')
    .map((frame) => frame.item_id);
  assert.equal(deletedIds.length, 32);
  assert.equal(deletedIds[0], 'id_1');
  assert.equal(deletedIds.at(-1), 'id_32');

  const dead = make('full');
  dead.ready();
  dead.socket.close();
  const sent = dead.socket.sent.length;
  dead.shadow.deleteItems(['gone']);
  assert.equal(dead.socket.sent.length, sent);
});

test('生成期暂存的音频在 restart 时丢弃，不对空服务端缓冲发 commit', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  const commits = h.socket.count('input_audio_buffer.commit');
  const appends = h.socket.count('input_audio_buffer.append');

  // 生成期开口：只进 held，服务端缓冲仍是空的
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 80), true);
  assert.equal(h.socket.count('input_audio_buffer.append'), appends);

  h.at(30);
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  assert.equal(
    h.socket.count('input_audio_buffer.commit'),
    commits,
    'held 没上过服务端，restart 不能发空 commit',
  );

  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1);
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(
    h.socket.count('input_audio_buffer.commit'),
    commits,
    'response.done 也不能把上一轮 held 补 commit 掉',
  );
  const lengths = h.socket.sent
    .filter((frame) => frame.type === 'input_audio_buffer.append')
    .map((frame) => Buffer.from(frame.audio ?? '', 'base64').length);
  assert.deepEqual(lengths, [MS * 100, MS * 40], '80ms 的 held 不能在 done 之后漏进下一轮');

  h.at(40);
  h.shadow.seal(2, 10);
  h.at(50);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  const second = h.events.at(-1)!;
  assert.equal(second['seq'], 2);
  assert.equal(second['seal_s'], 0.04, '下一轮只有新预卷 40ms');
  assert.equal(second['flushed_ms'], 0);
});

test('取消相位 starting → cancel_when_created → cancelling → done，created 之后才补一次 cancel', () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 40)]);
  h.at(10);
  h.shadow.seal(1, 10);
  assert.equal(h.shadow.explain().phase, 'starting');

  h.shadow.discard();
  assert.equal(h.shadow.explain().phase, 'cancel_when_created');
  assert.equal(h.socket.count('response.cancel'), 0, 'created 之前发会被服务端拒');

  h.socket.message({ type: 'response.created' });
  assert.equal(h.shadow.explain().phase, 'cancelling');
  assert.equal(h.socket.count('response.cancel'), 1);

  h.socket.message({ type: 'response.created' });
  assert.equal(h.socket.count('response.cancel'), 1, '重复 created 不能再补一次 cancel');

  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(h.shadow.explain().phase, 'done');
  assert.equal(h.socket.count('response.cancel'), 1, 'done 不能再补一次 cancel');
  assert.equal(h.events[0]!['cancelled'], true);
  assert.equal(h.shadow.currentState, 'ready');
});

test('重复 claim() 不会让两个读端互相抢 audio 块', { timeout: 4000 }, async () => {
  const h = make('full');
  h.ready();
  h.at(0);
  h.shadow.restart([Buffer.alloc(MS * 100)]);
  h.at(10);
  h.shadow.seal(1, 40);
  h.at(20);
  h.shadow.feed(Buffer.alloc(MS * 80), true);
  h.at(30);
  h.shadow.seal(2, 40);

  const first = h.shadow.claim();
  const second = h.shadow.claim();
  assert.ok(first !== null && second !== null, '排队中的下一份让两次 claim 都拿得到读端');

  const got1: Buffer[] = [];
  const got2: Buffer[] = [];
  const drain1 = (async () => {
    for await (const chunk of first.chunks) {
      got1.push(chunk);
    }
  })();
  const drain2 = (async () => {
    for await (const chunk of second.chunks) {
      got2.push(chunk);
    }
  })();

  h.at(40);
  h.socket.message({ type: 'response.done', response: { status: 'cancelled' } });
  h.at(50);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(300).toString('base64') });
  h.at(60);
  h.socket.message({ type: 'response.audio.delta', delta: Buffer.alloc(500).toString('base64') });
  h.at(70);
  h.socket.message({ type: 'response.done', response: { status: 'completed' } });
  await Promise.all([drain1, drain2]);

  const n1 = got1.reduce((sum, chunk) => sum + chunk.length, 0);
  const n2 = got2.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.ok(
    (n1 === 800 && n2 === 0) || (n1 === 0 && n2 === 800),
    `两个读端把同一份 audio 拆开了：${n1}+${n2}`,
  );
});
