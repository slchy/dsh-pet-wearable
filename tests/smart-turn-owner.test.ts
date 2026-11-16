/**
 * 判停器的**归属**判定：共享的那份不许在断开时销毁。
 *
 * 这条判据看着琐碎，代价却是实打实的：侧车是 python + 8.7 MB ONNX，冷启动实测
 * ~300 ms，而它刚好落在「用户说完 → 开一轮」里。以前每条连接建一个、断开就
 * `stop()`，于是真机每次重连（网络抖动 / 服务重启 / 重开 App）的第一句都要付
 * 这一刀 —— 端到端实测第 1 轮 309 ms、第 2 轮 150 ms，差的就是它。
 *
 * 这两条断言就是那个 bug 的回归测试：谁把 `owned` 改回 true，谁就让第一句又慢
 * 300 ms，而且不会有任何报错。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEndpointDetector, type EndpointDetector } from '../src/voice-session.ts';

function fakeDetector(): EndpointDetector & { stopped: boolean } {
  return {
    stopped: false,
    async predict() { return 0.5; },
    stop() { this.stopped = true; },
  };
}

const params = {
  pythonPath: '/dev/null',
  scriptPath: '/dev/null',
  quietMs: 150,
  extendMs: 400,
  maxExtensions: 7,
  threshold: 0.5,
};

const noop = (): void => {};

test('共享的判停器：用它，但不归这条连接所有', () => {
  const shared = fakeDetector();
  const r = resolveEndpointDetector({ smartTurn: params, smartTurnClient: shared }, () => {
    throw new Error('给了共享实例就不该再新建一个');
  }, noop);
  assert.equal(r.client, shared);
  assert.equal(r.owned, false, '共享实例必须 owned=false，否则断开时会把它杀掉');
});

test('没给共享实例：自己建一个，并且是它的主人', () => {
  const mine = fakeDetector();
  const r = resolveEndpointDetector({ smartTurn: params }, () => mine, noop);
  assert.equal(r.client, mine);
  assert.equal(r.owned, true, '自建实例必须 owned=true，否则进程退不掉');
});

test('没配判停器：null，不新建', () => {
  const r = resolveEndpointDetector({}, () => {
    throw new Error('没配就不该新建');
  }, noop);
  assert.equal(r.client, null);
  assert.equal(r.owned, false);
});

test('只给共享实例不给参数表：仍然共享，但要说一声', () => {
  const shared = fakeDetector();
  const lines: string[] = [];
  const r = resolveEndpointDetector({ smartTurnClient: shared }, () => fakeDetector(), (l) => {
    lines.push(l);
  });
  assert.equal(r.client, shared);
  assert.equal(r.owned, false);
  assert.ok(lines.some((l) => l.includes('没有参数表')), '静默退化成 quietMs=0 太难查');
});
