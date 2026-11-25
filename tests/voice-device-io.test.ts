/**
 * 设备状态：能力不够不能推进开麦相位；电量 / 佩戴只在字段有值时合并。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppDeviceEvent } from '../src/app/session.ts';
import {
  V1Session,
  type DeviceCapabilities,
  type DeviceLink,
} from '../src/devices/index.ts';
import type { DeviceCall } from '../src/devices/primitives.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';
import {
  DeviceReading,
  type DeviceReadingPorts,
} from '../src/voice/device-io.ts';
import { MicController } from '../src/voice/mic-phase.ts';
import type { Connection } from '../src/transport.ts';

const BASE_CAPS: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: {},
  presence: true,
  power: true,
  summon: false,
  listenStart: false,
  played: false,
  ignorePhrases: [],
};

function reading(link: DeviceLink, caps: DeviceCapabilities = link.capabilities): {
  readonly device: DeviceReading;
  readonly mic: MicController;
  readonly app: AppDeviceEvent[];
  readonly calls: string[];
  readonly controls: string[];
} {
  const app: AppDeviceEvent[] = [];
  const calls: string[] = [];
  const controls: string[] = [];
  const conn = {
    sendCall: (json: string) => { calls.push(json); },
    sendControl: (text: string) => { controls.push(text); },
  } as Connection;
  const mic = new MicController({
    clock: new VirtualClock(),
    wearing: () => null,
    connClosed: () => false,
    sendCall: () => true,
    onOpened: () => {},
  });
  const ports: DeviceReadingPorts = {
    conn,
    link,
    caps,
    v1: link.v1,
    mic,
    pipelineMode: () => undefined,
    archive: () => {},
    onCapture: () => null,
    appDevice: (event) => { app.push(event); },
    enqueueAnnounce: () => {},
    speakCanned: () => {},
    devicePlayed: () => {},
    requestPhoto: () => Promise.resolve({ ok: false, failure: { code: 'unsupported' } }),
    forget: () => {},
  };
  return { device: new DeviceReading(ports), mic, app, calls, controls };
}

test('supportsCall 不支持时不推进 MicPhase', () => {
  const link: DeviceLink = {
    proto: 2,
    label: 'no-listen',
    capabilities: BASE_CAPS,
    v1: null,
  };
  const { device, mic, calls } = reading(link);
  const call: DeviceCall = { op: 'listen.start', maxMs: 1_000 };
  assert.equal(device.sendCall(call), false);
  assert.equal(mic.phase, 'idle');
  assert.equal(calls.length, 0);
});

test('v1 状态帧与 v2 Event 电量/佩戴合并', () => {
  const v2: DeviceLink = {
    proto: 2,
    label: 'glasses',
    capabilities: BASE_CAPS,
    v1: null,
  };
  const live = reading(v2);
  live.device.onV2Event(Buffer.from(JSON.stringify({ kind: 'presence', wearing: true })));
  live.device.onV2Event(Buffer.from(JSON.stringify({
    kind: 'power',
    percent: 77,
    charging: true,
  })));
  // 缺字段被解析成 null，不能盖掉上一次的 77% / 充电中
  live.device.onV2Event(Buffer.from(JSON.stringify({ kind: 'power' })));
  assert.equal(live.device.deviceNote(), '设备现状：用户正戴着；电量 77%，充电中');
  assert.deepEqual(
    live.app.filter((event) => event.kind === 'power'),
    [
      { kind: 'power', percent: 77 },
      { kind: 'power', percent: 77 },
    ],
  );

  // v2 连接上的 v1 状态帧整段忽略，已经合并的电量还在
  live.device.onStatus(Buffer.from(JSON.stringify({ ev: 'battery', percent: 1, charging: false })));
  assert.equal(live.device.deviceNote(), '设备现状：用户正戴着；电量 77%，充电中');

  const v1: DeviceLink = {
    proto: 1,
    label: 'phone',
    capabilities: { ...BASE_CAPS, presence: false, power: false },
    v1: new V1Session(),
  };
  const legacy = reading(v1);
  legacy.device.onStatus(Buffer.from(JSON.stringify({
    ev: 'battery',
    percent: 10,
    charging: true,
    wearing: false,
  })));
  assert.equal(legacy.device.deviceNote(), undefined, 'v1 不认识的状态帧不能冒充电量');
  assert.equal(legacy.app.length, 0);
});

test('deviceNote 格式化', () => {
  const link: DeviceLink = {
    proto: 2,
    label: 'glasses',
    capabilities: BASE_CAPS,
    v1: null,
  };
  const { device } = reading(link);
  assert.equal(device.deviceNote(), undefined);

  device.onDeviceEvent({ kind: 'presence', wearing: false });
  assert.equal(device.deviceNote(), '设备现状：用户摘下了');

  device.onDeviceEvent({ kind: 'presence', wearing: true });
  device.onDeviceEvent({ kind: 'power', percent: 40, charging: false });
  assert.equal(device.deviceNote(), '设备现状：用户正戴着；电量 40%');

  device.onDeviceEvent({ kind: 'power', percent: 12, charging: true });
  assert.equal(device.deviceNote(), '设备现状：用户正戴着；电量 12%，充电中');

  device.onDeviceEvent({ kind: 'power', percent: 0, charging: null });
  assert.equal(device.deviceNote(), '设备现状：用户正戴着；电量 0%，充电中');
});
