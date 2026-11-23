/**
 * 控制口的 `GET /capabilities` —— MCP 拍照工具唯一的设备信息来源。
 *
 * 这条口一旦不对，MCP 侧会**安静地**给出错误的工具表：设备明明能拍高清却
 * 只暴露一个工具，或者设备没连上却仍然暴露工具（模型会对着空气调用，
 * 然后跟用户说「拍照失败了」）。两种情况都不报错，只会让人觉得「AI 今天有点笨」。
 *
 * 另一半是**热切换**：控制口是进程级常驻的（端口固定），设备重连只能换 handlers，
 * 不能关掉再开（旧 server 还握着端口 → `EADDRINUSE`，新设备的拍照和 `/say` 全失效）。
 * 这里锁住三件事：没设备时一律 503、旧连接的迟到断开不会顶掉新连接、
 * 旧连接卡住的拍照不会把新连接锁在 409。
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import type { PhotoOutcome } from '../src/photo-inbox.ts';
import {
  startToolControl,
  type ToolControl,
  type ToolControlHandlers,
} from '../src/tool-control.ts';

const XIAOMI_LIKE: DeviceCapabilities = {
  audioIn: 'msbc',
  capture: { glance: { needsUser: false }, detail: { needsUser: true } },
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
  played: false,
  ignorePhrases: ['小爱同学'],
};

/** 另一台设备：能力刻意不同，用 `audioIn` 就能看出「这条口现在连的是谁」 */
const GLASSES_LIKE: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: { glance: { needsUser: false } },
  presence: true,
  power: false,
  summon: false,
  listenStart: false,
  played: true,
  ignorePhrases: [],
};

/** 起一个控制口，等它真的 listen 完；跑完一定关掉（端口固定，漏关会影响后续用例）。 */
async function withControl(
  capabilities: (() => DeviceCapabilities | null) | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const control = startToolControl({
    port: 0,
    photoTimeoutMs: 200,
    handlers: {
      ...(capabilities === undefined ? {} : { capabilities }),
      takePhoto: async () => ({ ok: false, failure: { code: 'failed' } }),
      endSession: () => {},
    },
  });
  try {
    for (let i = 0; i < 100 && control.port === 0; i += 1) await delay(5);
    assert.notEqual(control.port, 0, '控制口没有监听成功');
    await fn(`http://127.0.0.1:${control.port}`);
  } finally {
    control.close();
  }
}

/** 进程级常驻版：初始 `handlers: null`，由用例自己 `setHandlers`。 */
async function withOpenControl(
  options: { readonly photoTimeoutMs?: number; readonly hqTimeoutMs?: number },
  fn: (control: ToolControl, base: string) => Promise<void>,
): Promise<void> {
  const control = startToolControl({
    port: 0,
    photoTimeoutMs: options.photoTimeoutMs ?? 200,
    ...(options.hqTimeoutMs === undefined ? {} : { hqTimeoutMs: options.hqTimeoutMs }),
    handlers: null,
  });
  try {
    for (let i = 0; i < 100 && control.port === 0; i += 1) await delay(5);
    assert.notEqual(control.port, 0, '控制口没有监听成功');
    await fn(control, `http://127.0.0.1:${control.port}`);
  } finally {
    control.close();
  }
}

interface FakeConn {
  readonly handlers: ToolControlHandlers;
  /** `/say` 收到的句子：用它判断请求到底打给了哪条连接 */
  readonly said: string[];
  /** 已经发出的拍照次数 */
  readonly shots: number;
}

function makeConn(
  caps: DeviceCapabilities | null,
  shoot: () => Promise<PhotoOutcome>,
): FakeConn {
  const said: string[] = [];
  let shots = 0;
  const handlers: ToolControlHandlers = {
    capabilities: () => caps,
    takePhoto: () => {
      shots += 1;
      return shoot();
    },
    endSession: () => {},
    say: (text) => { said.push(text); },
  };
  return {
    handlers,
    said,
    get shots() { return shots; },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 等一个「异步侧真的发生了」的条件；超时直接失败并说明在等什么 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(`等不到：${what}`);
}

test('有设备时返回当前能力，档位与 needsUser 原样透出', async () => {
  await withControl(() => XIAOMI_LIKE, async (base) => {
    const res = await fetch(`${base}/capabilities`);
    assert.equal(res.status, 200);
    const caps = await res.json() as DeviceCapabilities;
    assert.deepEqual(caps.capture, XIAOMI_LIKE.capture);
    assert.equal(caps.audioIn, 'msbc');
  });
});

test('设备没连上时回 503，而不是一份「看起来能用」的能力', async () => {
  await withControl(() => null, async (base) => {
    const res = await fetch(`${base}/capabilities`);
    assert.equal(res.status, 503, '没设备必须让 MCP 侧知道，否则会暴露用不了的工具');
  });
});

test('没注入能力查询时也只是 503，不崩', async () => {
  await withControl(undefined, async (base) => {
    const res = await fetch(`${base}/capabilities`);
    assert.equal(res.status, 503);
  });
});

test('能力变化后同一个端口读到的就是新值（设备换机场景）', async () => {
  let caps: DeviceCapabilities | null = XIAOMI_LIKE;
  await withControl(() => caps, async (base) => {
    const before = await (await fetch(`${base}/capabilities`)).json() as DeviceCapabilities;
    assert.notEqual(before.capture.detail, undefined);

    // 换一台只有 glance 的设备：MCP 侧轮询到后会把 hq 从工具表里摘掉
    caps = { ...XIAOMI_LIKE, capture: { glance: { needsUser: false } } };
    const after = await (await fetch(`${base}/capabilities`)).json() as DeviceCapabilities;
    assert.equal(after.capture.detail, undefined, '不能还报着上一台设备的能力');
  });
});

// ---------------------------------------------------------------- 热切换

test('初始 handlers 为 null：能力查询与所有 POST 入口都是 503，不抛异常', async () => {
  await withOpenControl({}, async (_control, base) => {
    const caps = await fetch(`${base}/capabilities`);
    assert.equal(caps.status, 503);
    assert.equal(await caps.text(), '{"error":"no-device"}');

    for (const path of ['/take_photo', '/take_photo_hq', '/say', '/end_session', '/control']) {
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      assert.equal(res.status, 503, `${path} 没设备时必须是 503`);
      assert.equal(await res.text(), 'no device connected', `${path} 的 503 要说明原因`);
    }
  });
});

test('旧连接迟到的 setHandlers(null, 自己) 不会顶掉已经接管的新连接', async () => {
  await withOpenControl({}, async (control, base) => {
    const a = makeConn(XIAOMI_LIKE, async () => ({ ok: false, failure: { code: 'failed' } }));
    const b = makeConn(GLASSES_LIKE, async () => ({ ok: false, failure: { code: 'failed' } }));

    control.setHandlers(a.handlers);
    control.setHandlers(b.handlers); // 弱网重连：B 先建好并接管
    control.setHandlers(null, a.handlers); // A 这时才断开 —— 迟到的清空

    const caps = await (await fetch(`${base}/capabilities`)).json() as DeviceCapabilities;
    assert.equal(caps.audioIn, GLASSES_LIKE.audioIn, '能力必须还是 B 的');

    const said = await fetch(`${base}/say`, { method: 'POST', body: '你好' });
    assert.equal(said.status, 200);
    assert.deepEqual(b.said, ['你好'], '/say 必须打给 B');
    assert.deepEqual(a.said, [], 'A 已经断开，不能再收到注入');
  });
});

test('当前连接自己调用 setHandlers(null, 自己) 才真的清空，回到 503', async () => {
  await withOpenControl({}, async (control, base) => {
    const b = makeConn(GLASSES_LIKE, async () => ({ ok: false, failure: { code: 'failed' } }));

    control.setHandlers(b.handlers);
    assert.equal((await fetch(`${base}/capabilities`)).status, 200);

    control.setHandlers(null, b.handlers);
    assert.equal((await fetch(`${base}/capabilities`)).status, 503);

    const said = await fetch(`${base}/say`, { method: 'POST', body: '你好' });
    assert.equal(said.status, 503);
    assert.equal(await said.text(), 'no device connected');
    assert.deepEqual(b.said, [], '已经摘掉的连接不能再收到注入');
  });
});

test('旧连接的在途拍照：不挡新连接，迟到结算也不清新连接的在途标记', async () => {
  await withOpenControl({ photoTimeoutMs: 5_000 }, async (control, base) => {
    const aShot = deferred<PhotoOutcome>();
    const a = makeConn(XIAOMI_LIKE, () => aShot.promise);
    control.setHandlers(a.handlers);

    const aRequest = fetch(`${base}/take_photo`, { method: 'POST' });
    await waitFor(() => a.shots === 1, 'A 的拍照真的发出去了');

    // A 的图一直没回来，连接先断了：B 接管（这一步若没重置在途标记，B 会拿到 409）
    const bShot = deferred<PhotoOutcome>();
    const b = makeConn(GLASSES_LIKE, () => bShot.promise);
    control.setHandlers(b.handlers);

    const bRequest = fetch(`${base}/take_photo`, { method: 'POST' });
    await waitFor(() => b.shots === 1, 'B 的拍照被 A 的在途请求挡成了 409');

    // A 这时才「迟到」结算：只能收自己那一张，不能碰 B 刚发起的在途标记
    aShot.resolve({ ok: false, failure: { code: 'failed' } });
    assert.equal((await aRequest).status, 504, 'A 的请求应当拿到失败，而不是一直挂着');

    const blocked = await fetch(`${base}/take_photo`, { method: 'POST' });
    assert.equal(blocked.status, 409, 'B 的那张还在途，并发保护必须仍然生效');
    assert.equal(b.shots, 1, '409 的请求不能真的发到设备');

    bShot.resolve({ ok: true, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    const bPhoto = await bRequest;
    assert.equal(bPhoto.status, 200);
    assert.equal((await bPhoto.arrayBuffer()).byteLength, 4);
  });
});
