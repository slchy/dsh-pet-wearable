/**
 * v1 设备的型号提示：给不会自报能力的 v1 手机补默认值。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeCapabilities,
  DEVICE_MODELS,
  GENERIC_V1_DEVICE,
  resolveV1Device,
  V1_BASELINE,
  XIAOMI_GLASSES_CAPABILITIES,
  XIAOMI_V1_DEVICE,
} from '../src/devices/index.ts';

test('不给型号：v1 基线', () => {
  assert.equal(resolveV1Device(), GENERIC_V1_DEVICE);
  assert.equal(resolveV1Device(''), GENERIC_V1_DEVICE);
  assert.equal(GENERIC_V1_DEVICE.capabilities, V1_BASELINE);
});

test('未知型号：回落基线，不报错', () => {
  assert.equal(resolveV1Device('rayneo-x3-pro'), GENERIC_V1_DEVICE);
});

test('小米：别名与大小写都认', () => {
  for (const model of ['xiaomi-glasses', 'Xiaomi', ' mijia ']) {
    assert.equal(resolveV1Device(model), XIAOMI_V1_DEVICE, model);
  }
  assert.deepEqual(DEVICE_MODELS, ['xiaomi-glasses']);
});

test('小米能力：mSBC、低清直出、高清要人按快门、忽略「小爱同学」', () => {
  const caps = XIAOMI_GLASSES_CAPABILITIES;
  assert.equal(caps.audioIn, 'msbc');
  assert.deepEqual(caps.capture, { glance: { needsUser: false }, detail: { needsUser: true } });
  assert.deepEqual(caps.ignorePhrases, ['小爱同学']);
  // v1 手机端没转发佩戴 / 电量 / 长按
  assert.equal(caps.presence, false);
  assert.equal(caps.power, false);
  assert.equal(caps.summon, false);
});

test('v1 基线：只有 mSBC 和低清直出', () => {
  assert.deepEqual(V1_BASELINE.capture, { glance: { needsUser: false } });
  assert.equal(V1_BASELINE.listenStart, false);
  assert.deepEqual(V1_BASELINE.ignorePhrases, []);
});

test('describeCapabilities：横幅里的一行摘要', () => {
  assert.equal(
    describeCapabilities(XIAOMI_GLASSES_CAPABILITIES),
    '上行 msbc；拍照 glance/detail(等用户)；上报 无；忽略短语 1 条',
  );
  assert.equal(
    describeCapabilities({ ...V1_BASELINE, capture: {}, presence: true, played: true }),
    '上行 msbc；拍照 无；上报 presence played；忽略短语 0 条',
  );
});
