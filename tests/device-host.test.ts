/**
 * 设备事件 → 宠物端口：一个适配器，不按设备各写一份。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeviceEventHost } from '../src/pet/device-host.ts';
import { V1_BASELINE, type DeviceCapabilities, type DeviceEvent } from '../src/devices/index.ts';

const ALL: DeviceCapabilities = {
  ...V1_BASELINE,
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
  played: true,
};

test('没声明的能力：端口缺省，不是永远 null 的假端口', () => {
  const host = new DeviceEventHost(V1_BASELINE, () => 0);
  assert.equal(host.presence, undefined);
  assert.equal(host.battery, undefined);
  assert.equal(host.touch, undefined);
});

test('presence：去重，只在翻转时通知', () => {
  const host = new DeviceEventHost(ALL, () => 0);
  const seen: Array<boolean | null> = [];
  host.presence?.onChange((wearing) => { seen.push(wearing); });

  host.feed({ kind: 'presence', wearing: true });
  host.feed({ kind: 'presence', wearing: true }); // 重复，不通知
  host.feed({ kind: 'presence', wearing: false });
  host.feed({ kind: 'presence', wearing: null });
  assert.deepEqual(seen, [true, false, null]);
  assert.equal(host.presence?.wearing(), null);
});

test('power：读到的百分比进缓存；没声明 power 的设备喂了也不记', async () => {
  const host = new DeviceEventHost(ALL, () => 0);
  host.feed({ kind: 'power', percent: 60, charging: false });
  assert.equal(await host.battery?.level(), 60);

  const none = new DeviceEventHost(V1_BASELINE, () => 0);
  none.feed({ kind: 'power', percent: 10, charging: null });
  assert.equal(none.battery, undefined);
});

test('summon：只有 opensSession 为 true 才带上', () => {
  const host = new DeviceEventHost(ALL, () => 0);
  const taps: Array<{ opensSession: boolean }> = [];
  host.touch?.onTap((tap) => { taps.push(tap); });

  host.feed({ kind: 'summon' });
  host.feed({ kind: 'summon', opensSession: true });
  assert.deepEqual(taps, [{ opensSession: false }, { opensSession: true }]);
});

test('没声明 summon：喂了招呼也不回调', () => {
  const host = new DeviceEventHost({ ...V1_BASELINE, presence: true }, () => 0);
  let called = false;
  host.feed({ kind: 'summon' } as DeviceEvent);
  assert.equal(called, false);
  assert.equal(host.touch, undefined);
});

test('拍照事件不归这里：喂了没有副作用', () => {
  const host = new DeviceEventHost(ALL, () => 0);
  const seen: unknown[] = [];
  host.presence?.onChange((v) => { seen.push(v); });
  host.touch?.onTap((v) => { seen.push(v); });
  host.feed({ kind: 'capture.waiting', id: 'c1' });
  host.feed({ kind: 'capture.failed', id: 'c1', code: 'timeout' });
  assert.deepEqual(seen, []);
});
