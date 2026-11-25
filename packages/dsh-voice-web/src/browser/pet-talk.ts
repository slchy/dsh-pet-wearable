/**
 * 说话时的口型摆动。只在出声期间步进；停下来由调用方把 DOM 收回 `none`。
 *
 * 首帧 dt 固定 16（`stamp === 0` 是哨兵，不是时间原点）。其后 dt 夹到 48。
 * 上升跟手 0.62，回落 0.16。倾角夹在 ±2.8。形变是 0.048 / 0.02 / 3.2。
 * `rms = 0` 时缩放和上抬回到中性，倾角仍留着 0.6° 的基础摆动。
 */
import { clamp } from './pet-geometry.ts';

export const TALK_FOLLOW_RISE = 0.62;
export const TALK_FOLLOW_FALL = 0.16;
export const TALK_PHASE_PER_MS = 0.006;
export const TALK_TILT_LIMIT = 2.8;
export const TALK_SCALE_Y = 0.048;
export const TALK_SCALE_X = 0.02;
export const TALK_LIFT = 3.2;
export const TALK_FIRST_DT = 16;
export const TALK_MAX_DT = 48;

const TILT_BASE = 0.6;
const TILT_RMS = 2.1;

export interface TalkPose {
  readonly smoothRms: number;
  readonly phase: number;
  readonly stamp: number;
  readonly tiltDeg: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly liftY: number;
  readonly transform: string;
}

export function idleTalkPose(): TalkPose {
  return {
    smoothRms: 0,
    phase: 0,
    stamp: 0,
    tiltDeg: 0,
    scaleX: 1,
    scaleY: 1,
    liftY: 0,
    transform: 'none',
  };
}

export function stepTalk(pose: TalkPose, now: number, rms: number): TalkPose {
  const dt = pose.stamp === 0 ? TALK_FIRST_DT : Math.min(TALK_MAX_DT, now - pose.stamp);
  const follow = rms > pose.smoothRms ? TALK_FOLLOW_RISE : TALK_FOLLOW_FALL;
  const smoothRms = pose.smoothRms + (rms - pose.smoothRms) * follow;
  const phase = pose.phase + dt * TALK_PHASE_PER_MS;
  const tiltDeg = clamp(
    Math.sin(phase) * (TILT_BASE + smoothRms * TILT_RMS),
    -TALK_TILT_LIMIT,
    TALK_TILT_LIMIT,
  );
  const scaleY = 1 + smoothRms * TALK_SCALE_Y;
  const scaleX = 1 - smoothRms * TALK_SCALE_X;
  const liftY = -smoothRms * TALK_LIFT;
  return {
    smoothRms,
    phase,
    stamp: now,
    tiltDeg,
    scaleX,
    scaleY,
    liftY,
    transform: `translateY(${liftY.toFixed(2)}px) rotate(${tiltDeg.toFixed(2)}deg) scaleX(${scaleX.toFixed(4)}) scaleY(${scaleY.toFixed(4)})`,
  };
}
