/**
 * 说话摆动：首帧 dt、dt 上限、跟手系数、倾角夹紧、静音回中性。不碰 DOM。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TALK_FIRST_DT,
  TALK_FOLLOW_FALL,
  TALK_FOLLOW_RISE,
  TALK_LIFT,
  TALK_MAX_DT,
  TALK_PHASE_PER_MS,
  TALK_SCALE_X,
  TALK_SCALE_Y,
  TALK_TILT_LIMIT,
  idleTalkPose,
  stepTalk,
} from '../src/browser/pet-talk.ts';

test('系数就是原来那一组', () => {
  assert.equal(TALK_FOLLOW_RISE, 0.62);
  assert.equal(TALK_FOLLOW_FALL, 0.16);
  assert.equal(TALK_PHASE_PER_MS, 0.006);
  assert.equal(TALK_TILT_LIMIT, 2.8);
  assert.equal(TALK_SCALE_Y, 0.048);
  assert.equal(TALK_SCALE_X, 0.02);
  assert.equal(TALK_LIFT, 3.2);
  assert.equal(TALK_FIRST_DT, 16);
  assert.equal(TALK_MAX_DT, 48);
});

test('空闲姿态是中性的，首帧 dt 固定 16，其后夹到 48', () => {
  const idle = idleTalkPose();
  assert.equal(idle.smoothRms, 0);
  assert.equal(idle.phase, 0);
  assert.equal(idle.stamp, 0);
  assert.equal(idle.tiltDeg, 0);
  assert.equal(idle.scaleX, 1);
  assert.equal(idle.scaleY, 1);
  assert.equal(idle.liftY, 0);
  assert.equal(idle.transform, 'none');

  const first = stepTalk(idle, 50_000, 0);
  assert.equal(first.phase, 16 * 0.006);
  assert.equal(first.stamp, 50_000);

  const stuck = stepTalk(idle, 0, 0);
  assert.equal(stuck.stamp, 0);
  assert.equal(stuck.phase, 16 * 0.006);

  const capped = stepTalk({ ...idle, stamp: 1_000 }, 1_000 + 10_000, 0);
  assert.equal(capped.phase, 48 * 0.006);

  const exact = stepTalk({ ...idle, stamp: 1_000 }, 1_016, 0);
  assert.equal(exact.phase, 16 * 0.006);
});

test('上升用 0.62，回落和持平用 0.16，倾角夹在 ±2.8', () => {
  const idle = idleTalkPose();
  const risen = stepTalk(idle, 1_000, 1);
  assert.equal(risen.smoothRms, 0.62);

  const fallen = stepTalk({ ...idle, smoothRms: 1, stamp: 5 }, 5, 0);
  assert.equal(fallen.smoothRms, 1 - 0.16);

  const held = stepTalk({ ...idle, smoothRms: 0.5, stamp: 5 }, 5, 0.5);
  assert.equal(held.smoothRms, 0.5);

  const hot = stepTalk({ ...idle, stamp: 5, phase: Math.PI / 2 }, 5, 10);
  assert.equal(hot.tiltDeg, 2.8);
  const cold = stepTalk({ ...idle, stamp: 5, phase: -Math.PI / 2 }, 5, 10);
  assert.equal(cold.tiltDeg, -2.8);
});

test('rms = 0 时缩放和上抬回到中性', () => {
  const quiet = stepTalk(idleTalkPose(), 1_000, 0);
  assert.equal(quiet.smoothRms, 0);
  assert.equal(quiet.scaleX, 1);
  assert.equal(quiet.scaleY, 1);
  assert.ok(quiet.liftY === 0);
  assert.equal(
    quiet.transform,
    'translateY(0.00px) rotate(0.06deg) scaleX(1.0000) scaleY(1.0000)',
  );

  let pose = stepTalk(idleTalkPose(), 1_000, 1);
  assert.equal(pose.scaleY, 1 + 0.62 * 0.048);
  assert.equal(pose.scaleX, 1 - 0.62 * 0.02);
  assert.equal(pose.liftY, -0.62 * 3.2);
  for (let i = 0; i < 100; i += 1) {
    pose = stepTalk(pose, pose.stamp + 16, 0);
  }
  assert.ok(pose.smoothRms < 1e-6);
  assert.ok(Math.abs(pose.scaleX - 1) < 1e-6);
  assert.ok(Math.abs(pose.scaleY - 1) < 1e-6);
  assert.ok(Math.abs(pose.liftY) < 1e-6);
  assert.equal(pose.liftY, -pose.smoothRms * 3.2);
});
