/**
 * 命中：矩形外放过，没 alpha 时矩形内算中，镜像、下标夹紧、alpha 阈值。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALPHA_THRESHOLD,
  HIT_SIZE,
  samplePetHit,
  type PetHitProbe,
  type PetHitRect,
} from '../src/browser/pet-hit.ts';

function square(): PetHitRect {
  return {
    left: 0,
    top: 0,
    right: HIT_SIZE,
    bottom: HIT_SIZE,
    width: HIT_SIZE,
    height: HIT_SIZE,
  };
}

function grid(): Uint8ClampedArray {
  return new Uint8ClampedArray(HIT_SIZE * HIT_SIZE * 4);
}

function setAlpha(data: Uint8ClampedArray, x: number, y: number, alpha: number): void {
  data[(y * HIT_SIZE + x) * 4 + 3] = alpha;
}

function probe(over: Partial<PetHitProbe> & Pick<PetHitProbe, 'clientX' | 'clientY'>): boolean {
  return samplePetHit({
    rect: square(),
    mirror: false,
    hitMode: 'alpha',
    alpha: grid(),
    ...over,
  });
}

test('矩形外是假，没有 alpha 时矩形内是真', () => {
  assert.equal(HIT_SIZE, 256);
  assert.equal(ALPHA_THRESHOLD, 10);
  const opaque = grid();
  setAlpha(opaque, 10, 20, 255);
  assert.equal(probe({ clientX: -1, clientY: 20, alpha: opaque }), false);
  assert.equal(probe({ clientX: 10, clientY: -1, alpha: opaque }), false);
  assert.equal(probe({ clientX: HIT_SIZE + 1, clientY: 20, alpha: opaque }), false);
  assert.equal(probe({
    clientX: 10,
    clientY: 20,
    hitMode: 'rect',
    alpha: grid(),
  }), true);
  assert.equal(probe({
    clientX: 10,
    clientY: 20,
    hitMode: 'alpha',
    alpha: null,
  }), true);
  assert.equal(probe({
    clientX: 10,
    clientY: 20,
    rect: { ...square(), width: 0 },
    hitMode: 'rect',
  }), false);
});

test('镜像采样 256 - x，下标 floor 后夹到 0..255，alpha 等于 10 不命中', () => {
  const mirrored = grid();
  setAlpha(mirrored, 246, 20, 255);
  assert.equal(probe({
    clientX: 10,
    clientY: 20,
    mirror: true,
    alpha: mirrored,
  }), true);
  assert.equal(probe({
    clientX: 10,
    clientY: 20,
    mirror: false,
    alpha: mirrored,
  }), false);

  const clamped = grid();
  setAlpha(clamped, 255, 0, 255);
  setAlpha(clamped, 0, 1, 0);
  assert.equal(probe({
    clientX: HIT_SIZE,
    clientY: 0,
    alpha: clamped,
  }), true);

  const floored = grid();
  setAlpha(floored, 10, 0, 255);
  setAlpha(floored, 11, 0, 0);
  assert.equal(probe({ clientX: 10.9, clientY: 0, alpha: floored }), true);

  const threshold = grid();
  setAlpha(threshold, 10, 20, 10);
  assert.equal(probe({ clientX: 10, clientY: 20, alpha: threshold }), false);
  setAlpha(threshold, 10, 20, 11);
  assert.equal(probe({ clientX: 10, clientY: 20, alpha: threshold }), true);

  const rgb = grid();
  const offset = (20 * HIT_SIZE + 10) * 4;
  rgb[offset] = 255;
  rgb[offset + 3] = 0;
  assert.equal(probe({ clientX: 10, clientY: 20, alpha: rgb }), false);
});
