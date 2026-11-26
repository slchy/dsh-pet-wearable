/**
 * TTS provider 的跨实现契约。
 *
 * 重点不是「合成得好不好听」，而是三条会静默出错的边界：
 *  - 空白文本必须产出 0 块（否则宿主会把一段静音当成"这一轮说过话"）；
 *  - `close()` 幂等（宿主退出 / 断线回收时连调多次不能炸）；
 *  - 消费者中途 `break`（插话）之后，下一句合成不许捡到上一句的残留音频。
 *
 * omni 用假 socket，零真实网络；cosyvoice 没有 socket 注入点，只验形状与
 * 未建连时的 `close()`，不触发任何网络调用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cosyVoiceTts, COSYVOICE_SAMPLE_RATE } from '../../src/cosyvoice.ts';
import { omniTts, type RealtimeLike } from '../../src/omni-tts.ts';
import { openAiTts } from '../../src/openai-tts.ts';
import { silentTts, type TtsProvider } from '../../src/providers.ts';

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

type WireEvent = Record<string, unknown> & { readonly type: string };

/**
 * omni-tts 只依赖 `on/send/close/readyState`。`session.update` 自动回
 * `session.updated`；`response.cancel` 自动回 `response.done`，这样被放弃
 * 的那条不会让测试白等 3 s。
 */
class FakeSocket {
  readyState = 0;
  readonly sent: WireEvent[] = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  private readonly onResponseCreate: ((socket: FakeSocket) => void) | undefined;

  constructor(onResponseCreate?: (socket: FakeSocket) => void) {
    this.onResponseCreate = onResponseCreate;
  }

  send(data: string): void {
    const event = JSON.parse(data) as WireEvent;
    this.sent.push(event);
    if (event.type === 'session.update') {
      this.message({ type: 'session.updated' });
    }
    if (event.type === 'response.create') {
      this.onResponseCreate?.(this);
    }
    if (event.type === 'response.cancel') {
      this.message({ type: 'response.done', response: { status: 'cancelled' } });
    }
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

  message(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }

  types(): string[] {
    return this.sent.map((event) => event.type);
  }
}

function makeOmniSocket(onResponseCreate?: (socket: FakeSocket) => void): FakeSocket {
  const socket = new FakeSocket(onResponseCreate);
  // `ensure()` 在 factory 返回之后才挂 `open` 监听，同步触发会丢；推到微任务。
  queueMicrotask(() => { socket.open(); });
  return socket;
}

function omniWith(
  onResponseCreate?: (socket: FakeSocket) => void,
): { tts: TtsProvider; sockets: FakeSocket[]; current: () => FakeSocket } {
  const sockets: FakeSocket[] = [];
  const tts = omniTts({
    apiKey: 'k',
    socketFactory: () => {
      const socket = makeOmniSocket(onResponseCreate);
      sockets.push(socket);
      return socket as unknown as RealtimeLike;
    },
  });
  return {
    tts,
    sockets,
    current: () => {
      const socket = sockets[sockets.length - 1];
      assert.ok(socket !== undefined, '还没有创建 socket');
      return socket;
    },
  };
}

/** 正常一轮：一条音频 + 正常收尾。 */
function normalOmni(): { tts: TtsProvider; sockets: FakeSocket[]; current: () => FakeSocket } {
  return omniWith((socket) => {
    socket.message({ type: 'response.created' });
    socket.message({
      type: 'response.audio.delta',
      delta: Buffer.from([9, 9]).toString('base64'),
    });
    socket.message({ type: 'response.done', response: { status: 'completed' } });
  });
}

function fakeOpenAiTts(): TtsProvider {
  return openAiTts({
    apiKey: 'sk-test',
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
  });
}

const CASES: ReadonlyArray<{ name: string; make: () => TtsProvider; canSynthesize: boolean }> = [
  { name: 'silentTts', make: () => silentTts(24_000), canSynthesize: true },
  { name: 'omniTts', make: () => normalOmni().tts, canSynthesize: true },
  { name: 'openAiTts', make: fakeOpenAiTts, canSynthesize: true },
  { name: 'cosyVoiceTts', make: () => cosyVoiceTts({ apiKey: 'k' }), canSynthesize: false },
];

for (const entry of CASES) {
  test(`${entry.name}：name 非空、sampleRate 正有限、空白输入零音频、close 幂等`, async () => {
    const tts = entry.make();
    assert.ok(tts.name.trim() !== '');
    assert.ok(Number.isFinite(tts.sampleRate) && tts.sampleRate > 0);

    // cosyvoice 没有 socket 注入点，触发 synthesize 会真连网 —— 只验形状与 close。
    if (entry.canSynthesize) {
      assert.deepEqual(await collect(tts.synthesize('')), [], '空串必须零音频');
      assert.deepEqual(await collect(tts.synthesize('   \n\t')), [], '纯空白也必须零音频');
    }

    assert.doesNotThrow(() => { tts.close?.(); });
    assert.doesNotThrow(() => { tts.close?.(); });
    assert.doesNotThrow(() => { tts.close?.(); });

    if (entry.canSynthesize) {
      const chunks = await collect(tts.synthesize('你好。'));
      assert.ok(chunks.length > 0, '正常文本必须出音频');
      assert.ok(chunks.every((chunk) => chunk.length > 0));
      assert.doesNotThrow(() => { tts.close?.(); });
      assert.doesNotThrow(() => { tts.close?.(); });
    }
  });
}

test('cosyVoiceTts：默认采样率只从 COSYVOICE_SAMPLE_RATE 来', () => {
  const tts = cosyVoiceTts({ apiKey: 'k' });
  assert.equal(tts.sampleRate, COSYVOICE_SAMPLE_RATE);
  assert.match(tts.name, /^cosyvoice:/);
  tts.close?.();
});

test('omniTts：消费者 break 后下一句不捡上一句的残留音频', async () => {
  let round = 1;
  const { tts } = omniWith((socket) => {
    if (round === 1) {
      // 第一句：只发一块，不发 done —— 模拟"服务端还在推，调用方已经插话"
      socket.message({ type: 'response.created' });
      socket.message({
        type: 'response.audio.delta',
        delta: Buffer.from([1, 1]).toString('base64'),
      });
      return;
    }
    socket.message({ type: 'response.created' });
    socket.message({
      type: 'response.audio.delta',
      delta: Buffer.from([2, 2]).toString('base64'),
    });
    socket.message({ type: 'response.done', response: { status: 'completed' } });
  });

  const first: Buffer[] = [];
  for await (const chunk of tts.synthesize('第一句。')) {
    first.push(chunk);
    break; // 插话：消费者中途退出
  }
  assert.deepEqual([...first[0] ?? []], [1, 1], '第一句自己的音频要先到');

  round = 2;
  const second = await collect(tts.synthesize('第二句。'));
  assert.equal(second.length, 1);
  assert.deepEqual([...second[0] ?? []], [2, 2], '第二句不许捡第一句的残留');
  assert.ok(
    !second.some((chunk) => chunk.length === 2 && chunk[0] === 1 && chunk[1] === 1),
    '上一句的 1 字节音频不能串进来',
  );

  tts.close?.();
  tts.close?.();
});

test('omniTts：合成后 close 也不抛错，下一句重建连接', async () => {
  const rig = normalOmni();
  const chunks = await collect(rig.tts.synthesize('第一句。'));
  assert.ok(chunks.length > 0);
  const firstSocket = rig.current();
  rig.tts.close?.();
  assert.equal(firstSocket.readyState, 3, 'close 应该关掉底层连接');

  // 同一个 provider 再合成：必须重新建一条连接（工厂每次给新 socket）。
  const again = await collect(rig.tts.synthesize('第二句。'));
  assert.ok(again.length > 0);
  assert.equal(rig.sockets.length, 2, 'close 之后应该重新建连');
  assert.notEqual(rig.current(), firstSocket);
  rig.tts.close?.();
});
