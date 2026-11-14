/**
 * 主动开口的做法：看不看、开不开麦，只看能力。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { V1_BASELINE, type DeviceCapabilities } from '../src/devices/index.ts';
import { planProactive, proactivePrompt } from '../src/pet/proactive.ts';

const LOOKING: DeviceCapabilities = {
  ...V1_BASELINE,
  capture: { glance: { needsUser: false }, detail: { needsUser: false } },
  listenStart: true,
};

const NEEDS_USER: DeviceCapabilities = {
  ...V1_BASELINE,
  capture: { glance: { needsUser: true } },
  listenStart: false,
};
/** 连 glance 都没有：只能走「不看」 */
const NO_CAMERA: DeviceCapabilities = { ...V1_BASELINE, capture: {} };

const greet = { kind: 'greet', awayMs: 12 * 60_000 } as const;
const chatter = { kind: 'chatter', idleMs: 25 * 60_000 } as const;

test('能不用人动手拍 glance 才先看一眼', () => {
  assert.equal(planProactive(greet, LOOKING)?.look, 'glance');
  // 要人按快门的档不能用于主动拍照
  assert.equal(planProactive(greet, NEEDS_USER)?.look, null);
  // 根本没有 glance
  assert.equal(planProactive(greet, NO_CAMERA)?.look, null);
});

test('说完开麦：设备支持 listen.start 才开', () => {
  assert.equal(planProactive(chatter, LOOKING)?.listenMs, 8_000);
  assert.equal(planProactive(chatter, NEEDS_USER)?.listenMs, null);
});

test('只有 greet / chatter 才开口；reflect 与 idle 不管', () => {
  assert.equal(planProactive({ kind: 'reflect', cue: 'tap-ack' }, LOOKING), null);
  assert.equal(planProactive({ kind: 'idle' }, LOOKING), null);
});

test('提示词：标成系统提示，有图没图说法不一样', () => {
  const withImage = proactivePrompt(greet, true);
  const without = proactivePrompt(greet, false);
  assert.match(withImage, /系统提示，不是用户说的话/);
  assert.match(withImage, /12 分钟/);
  assert.match(withImage, /画面/);
  assert.match(without, /不要假装看见了什么/);
  assert.match(proactivePrompt(chatter, false), /25 分钟/);
});

test('不足一分钟也说一分钟，不说零分钟', () => {
  assert.match(proactivePrompt({ kind: 'greet', awayMs: 10_000 }, false), /1 分钟/);
});
