/**
 * `Hello.resumed`：自动重连不该被当成「用户想说话」。
 *
 * 背景：连接就绪时服务端会发 `listen.start`，把设备侧自毁的采集拉回来（修「未响应」）。
 * 但手机 supervisor 在网络抖动/云端重启/心跳超时时会自己重连 —— 每次重连都开麦，
 * 用户就会莫名其妙看到眼镜被唤醒。所以设备在 `Hello` 里带 `resumed: true`。
 *
 * 这里钉的是**解析与缺省语义**：老 App 不带这个字段时必须当成 `false`（保持开麦），
 * 否则就成了「点开了却没声音」——比被打扰更难查。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHello } from '../src/transport.ts';

/** 拼一个 Hello 帧载荷。 */
function hello(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf8');
}

test('resumed: true 原样带出来', () => {
  const info = parseHello(hello({ proto: 2, deviceId: 'pixel', resumed: true }));
  assert.ok(info);
  assert.equal(info.resumed, true);
});

test('不带 resumed：当作 false（老 App 要保持开麦）', () => {
  const info = parseHello(hello({ proto: 2, deviceId: 'pixel' }));
  assert.ok(info);
  // 关键：不是 undefined 直接透传，调用方用 `=== true` 判，这里确认不会被误判成 true
  assert.notEqual(info.resumed, true);
});

test('resumed 不是布尔值时不采信', () => {
  for (const bad of ['true', 1, null, {}]) {
    const info = parseHello(hello({ proto: 2, resumed: bad }));
    assert.ok(info, `resumed=${JSON.stringify(bad)} 时不该解析失败`);
    assert.notEqual(info.resumed, true, `resumed=${JSON.stringify(bad)} 不该被当成 true`);
  }
});

test('坏 JSON 仍然返回 null（不因为新字段改变旧行为）', () => {
  assert.equal(parseHello(Buffer.from('{not json', 'utf8')), null);
});
