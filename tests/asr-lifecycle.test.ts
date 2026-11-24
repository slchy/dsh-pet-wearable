/**
 * 阿里云实时识别的**连接状态机**。
 *
 * 这些用例防的是同一类事故：连接明明已经不能用了，状态里却还写着「好着」，
 * 于是音频一路喂进黑洞 —— 现场表现是「跑一阵子就开始听不见话」，
 * 而且不报错、不重连、日志安静得像一切正常。
 *
 * 三条边各有一个坑（都是真机日志翻出来的）：
 *
 * 1. `hangup()` 先摘空 `this.ws`、500 ms 后才真 close。这 500 ms 里
 *    可能已经建了新连接，旧连接的 close 回调若无条件清状态，新连接就成孤儿
 *    （实测同时存活 4 条 ASR 连接）。
 * 2. 服务端发 `TranscriptionCompleted`（任务到期/被踢）后 socket 还开着，
 *    `feed()` 看到 `this.ws` 非空就以为「只是还没就绪」，只往 backlog 攒，
 *    满了就丢 —— 用户说什么都不会再被识别。
 * 3. 建连失败后 `this.ws` 残留，`feed()` 的 `!this.ws` 判断永远不成立。
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AliyunAsr, aliyunStt, type AliyunAsrOptions } from '../src/aliyun-asr.ts';

/** 够用的 WebSocket 替身：手动驱动 open/message/close。 */
class FakeWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWs[] = [];

  readyState = FakeWs.CONNECTING;
  sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void, opts?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    const wrapped = opts?.once === true
      ? (ev: unknown): void => {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== wrapped));
        fn(ev);
      }
      : fn;
    list.push(wrapped);
    this.listeners.set(type, list);
  }

  emit(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.emit('close', { code: 1005, reason: '' });
  }

  // ---- 测试驱动 ----

  open(): void {
    this.readyState = FakeWs.OPEN;
    this.emit('open', {});
  }

  msg(name: string, payload: Record<string, unknown> = {}): void {
    this.emit('message', { data: JSON.stringify({ header: { name }, payload }) });
  }

  get names(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { header: { name: string } }).header.name);
  }
}

const realWs = globalThis.WebSocket;
globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;

after(() => {
  globalThis.WebSocket = realWs;
});

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

interface Harness {
  asr: AliyunAsr;
  sentences: string[];
}

function makeAsr(overrides: Partial<AliyunAsrOptions> = {}): Harness {
  FakeWs.instances = [];
  const sentences: string[] = [];
  const asr = new AliyunAsr({
    akId: 'ak',
    akSecret: 'sk',
    appkey: 'appkey',
    region: 'cn-shanghai',
    onSentence: (text) => { sentences.push(text); },
    tokenProvider: async () => ({ id: 'tok', expireAtSec: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
  return { asr, sentences };
}

/** 建一条连接并把它推到「已就绪」 */
async function connectReady(asr: AliyunAsr): Promise<FakeWs> {
  const before = FakeWs.instances.length;
  asr.feed(Buffer.alloc(320));
  await tick();
  const ws = FakeWs.instances[before];
  assert.ok(ws, '应当新建一条连接');
  ws.open();
  await tick();
  ws.msg('TranscriptionStarted');
  return ws;
}

test('旧连接迟到的 close 不能把新连接的状态清掉', async () => {
  const { asr } = makeAsr();
  const first = await connectReady(asr);
  assert.equal(asr.isReady, true);

  // 上行静音关门：立刻摘空 ws，500 ms 后才真 close
  asr.hangup();
  assert.equal(asr.isReady, false);

  // 这 500 ms 里用户又开口 → 新连接
  const second = await connectReady(asr);
  assert.notEqual(second, first);
  assert.equal(asr.isReady, true);

  // 旧连接的 close 现在才到
  first.close();
  assert.equal(asr.isReady, true, '新连接不该被旧连接的 close 带下水');
  assert.deepEqual(first.names, ['StartTranscription', 'StopTranscription']);

  // 新连接仍然能正常出结果
  second.msg('SentenceEnd', { result: '还在', index: 1 });
  await tick();
});

test('识别任务结束后要重连，不能只攒 backlog', async () => {
  const { asr } = makeAsr();
  const first = await connectReady(asr);

  first.msg('TranscriptionCompleted');
  assert.equal(asr.isReady, false);
  assert.equal(first.readyState, FakeWs.CLOSED, '结束的任务要顺手关掉');

  // 关键：这时再喂音频必须建新连接，而不是往 backlog 里无声地攒
  const second = await connectReady(asr);
  assert.notEqual(second, first);
  assert.equal(asr.isReady, true);

  second.msg('SentenceEnd', { result: '听见了', index: 1 });
  await tick();
});

test('建连失败之后还要能重连', async () => {
  const { asr } = makeAsr();
  asr.feed(Buffer.alloc(320));
  await tick();
  const failed = FakeWs.instances[0];
  assert.ok(failed);
  failed.emit('error', {});
  await tick();

  // 以前这里 `this.ws` 残留，之后永远不再重连
  const second = await connectReady(asr);
  assert.notEqual(second, failed);
  second.msg('TranscriptionStarted');
  assert.equal(asr.isReady, true);
});

test('挂断是幂等的：没有连接时不出声、不抛异常', () => {
  const { asr } = makeAsr();
  asr.hangup();
  asr.hangup();
  assert.equal(FakeWs.instances.length, 0);
});

test('热词表：只有配置了真 ID 才下发 vocabulary_id', async () => {
  const startParams = async (overrides: Partial<AliyunAsrOptions> = {}): Promise<Record<string, unknown>> => {
    const { asr } = makeAsr(overrides);
    const ws = await connectReady(asr);
    const raw = ws.sent[0];
    assert.ok(raw, '应当发出 StartTranscription');
    return (JSON.parse(raw) as { payload: Record<string, unknown> }).payload;
  };

  // 没配就别下发：控制台的「项目热词」与 appkey 绑定、自动生效，不走这个字段；
  // 只有 POP API 建的业务专属词表才需要真 ID。下发假值除了制造"已启用"的错觉
  // 没有任何用处，所以宁可不下发。
  const plain = await startParams();
  assert.equal('vocabulary_id' in plain, false);
  assert.equal(plain['sample_rate'], 16000, '其它 Start 参数不受影响');

  const withVocab = await startParams({ vocabularyId: 'voc-123' });
  assert.equal(withVocab['vocabulary_id'], 'voc-123');
});

// ---------------------------------------------------------------- 因果出生证
//
// NLS 由**服务端 VAD** 判句，客户端根本没有「第几发 commit」这个概念。
// 所以 `SentenceEnd` 的第三个参数必须是 `undefined`，不能硬编一个序号：
// `causal.ts` 把 `undefined` 解释为「没有因果坐标」→ 一律判「不是旧段」，
// 宁可让一次插话通过，也不能凭空吞掉一轮回答。

test('SentenceEnd 不带 commitSeq（服务端判句，没有客户端封段号）', async () => {
  const stamps: Array<number | undefined> = [];
  const onSentence = (_text: string, _index: number, commitSeq?: number): void => {
    stamps.push(commitSeq);
  };
  const { asr } = makeAsr({ onSentence });
  const ws = await connectReady(asr);

  ws.msg('SentenceEnd', { result: '你好', index: 1 });
  await tick();

  assert.deepEqual(stamps, [undefined]);
});

// ---------------------------------------------------------------- 预热
//
// token 缓存必须是**进程级**的：`open()` 每台设备 new 一个实例，缓存若跟着实例走，
// 每台设备的**第一句话**都要付一次 `CreateToken`（实测 334 / 170 / 147 / 134 ms），
// 而那一发恰好发生在「用户已经开口」的时候。

test('token 缓存跨实例复用：第二台设备不再换 token', async () => {
  let calls = 0;
  const provider = async (): Promise<{ id: string; expireAtSec: number }> => {
    calls += 1;
    return { id: `tok${calls}`, expireAtSec: Math.floor(Date.now() / 1000) + 3600 };
  };
  const stt = aliyunStt(
    { akId: 'ak', akSecret: 'sk', appkey: 'appkey', region: 'cn-shanghai', tokenProvider: provider },
  );

  const handlers = { onSentence: () => {}, onPartial: () => {}, onError: () => {} } as never;
  const first = stt.open(handlers);
  await tick();
  const second = stt.open(handlers);
  await tick();
  first.close();
  second.close();

  assert.equal(calls, 1, 'token 24 h 有效，换第二台设备不该再换一次');
});

test('open() 就把 token 取回来 —— 别等 feed() 那一刻', async () => {
  let calls = 0;
  const stt = aliyunStt({
    akId: 'ak', akSecret: 'sk', appkey: 'appkey', region: 'cn-shanghai',
    tokenProvider: async () => {
      calls += 1;
      return { id: 'tok', expireAtSec: Math.floor(Date.now() / 1000) + 3600 };
    },
  });
  FakeWs.instances = [];

  const session = stt.open({ onSentence: () => {}, onPartial: () => {}, onError: () => {} } as never);
  await tick();

  assert.equal(calls, 1, '设备刚连上就该把 token 拿好，用户开口时只剩建链');
  assert.equal(FakeWs.instances.length, 0, '只预取 token，不建空连接（会被服务端判 IDLE_TIMEOUT）');
  session.close();
});
