/**
 * 控制口的 `GET /capabilities` —— MCP 拍照工具唯一的设备信息来源。
 *
 * 这条口一旦不对，MCP 侧会**安静地**给出错误的工具表：设备明明能拍高清却
 * 只暴露一个工具，或者设备没连上却仍然暴露工具（模型会对着空气调用，
 * 然后跟用户说「拍照失败了」）。两种情况都不报错，只会让人觉得「AI 今天有点笨」。
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import { startToolControl } from '../src/tool-control.ts';

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
