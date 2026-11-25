/**
 * 桌宠几何：吸附区、锚点自愈、拖拽回退、凸包裁切。不碰 DOM。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLICK_DISTANCE_SQ,
  DEFAULT_SNAP_CONFIG,
  PRESS_SPRING_TRANSITION,
  PRESS_SQUISH_TRANSFORM,
  type Point2D,
  type SavedAnchorPos,
  type SnapConfig,
  anchorFromDrop,
  buildAlphaClipPath,
  clamp,
  computeSnapBounds,
  convexHull,
  evaluateSnapZones,
  hasOpaqueProbePixels,
  resolveAnchorPosition,
  shouldMirrorArt,
  shouldRevertDrag,
} from '../src/browser/pet-geometry.ts';

const VIEW = { w: 1000, h: 800 };
const SIZE = { w: 100, h: 80 };
const GAP = 16;

test('按压参数和点击阈值是固定常量', () => {
  assert.equal(CLICK_DISTANCE_SQ, 9);
  assert.equal(PRESS_SQUISH_TRANSFORM, 'scaleY(0.88) scaleX(1.05)');
  assert.equal(PRESS_SPRING_TRANSITION, 'transform 0.22s cubic-bezier(.34, 1.56, .64, 1)');
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(4, 0, 10), 4);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 10), 10);
  assert.equal(Number.isNaN(clamp(Number.NaN, 0, 10)), true);
});

test('默认 v3 吸附区：左右下生效，上沿为 0，px 和 off 各走各的边界', () => {
  assert.deepEqual(DEFAULT_SNAP_CONFIG, {
    mode: 'ratio',
    ratio: { L: 10, T: 0, R: 10, B: 15, F: 50 },
    px: { L: 120, T: 0, R: 120, B: 120, F: 640 },
  });
  assert.deepEqual(computeSnapBounds(VIEW, DEFAULT_SNAP_CONFIG), {
    L: 100,
    T: 0,
    R: 900,
    B: 680,
    F: 500,
  });

  assert.deepEqual(evaluateSnapZones(99, 20, 20, VIEW, DEFAULT_SNAP_CONFIG), {
    zH: 'left',
    zV: null,
    onLeftHalf: true,
  });
  assert.deepEqual(evaluateSnapZones(100, 20, 20, VIEW, DEFAULT_SNAP_CONFIG).zH, null);
  assert.deepEqual(evaluateSnapZones(901, 400, 400, VIEW, DEFAULT_SNAP_CONFIG), {
    zH: 'right',
    zV: null,
    onLeftHalf: false,
  });
  assert.equal(evaluateSnapZones(900, 400, 400, VIEW, DEFAULT_SNAP_CONFIG).zH, null);
  assert.equal(evaluateSnapZones(500, 400, 681, VIEW, DEFAULT_SNAP_CONFIG).zV, 'bottom');
  assert.equal(evaluateSnapZones(500, 400, 680, VIEW, DEFAULT_SNAP_CONFIG).zV, null);
  // 下沿看画心，不看盒心：盒心还在顶上，画心已经过了底边。
  assert.equal(evaluateSnapZones(500, 0, 790, VIEW, DEFAULT_SNAP_CONFIG).zV, 'bottom');
  assert.equal(evaluateSnapZones(500, 0, 40, VIEW, DEFAULT_SNAP_CONFIG).zV, null);
  assert.equal(evaluateSnapZones(500, 1, 40, VIEW, DEFAULT_SNAP_CONFIG).zV, null);

  const topOpen: SnapConfig = {
    mode: 'ratio',
    ratio: { L: 10, T: 25, R: 10, B: 15, F: 50 },
    px: DEFAULT_SNAP_CONFIG.px,
  };
  const topView = { w: 1000, h: 1000 };
  assert.equal(computeSnapBounds(topView, topOpen).T, 250);
  assert.equal(evaluateSnapZones(500, 100, 900, topView, topOpen).zV, 'top');

  const px: SnapConfig = {
    mode: 'px',
    ratio: { L: 0, T: 0, R: 0, B: 0, F: 0 },
    px: { L: 80, T: 30, R: 50, B: 70, F: 400 },
  };
  assert.deepEqual(computeSnapBounds(VIEW, px), { L: 80, T: 30, R: 950, B: 730, F: 400 });
  assert.deepEqual(evaluateSnapZones(79, 29, 100, VIEW, px), {
    zH: 'left',
    zV: 'top',
    onLeftHalf: true,
  });
  assert.equal(evaluateSnapZones(80, 30, 730, VIEW, px).zH, null);
  assert.equal(evaluateSnapZones(80, 30, 730, VIEW, px).zV, null);
  assert.deepEqual(evaluateSnapZones(951, 400, 731, VIEW, px), {
    zH: 'right',
    zV: 'bottom',
    onLeftHalf: false,
  });

  const off: SnapConfig = {
    mode: 'off',
    ratio: { L: 50, T: 50, R: 50, B: 50, F: 10 },
    px: { L: 400, T: 400, R: 400, B: 400, F: 10 },
  };
  assert.deepEqual(computeSnapBounds(VIEW, off), { L: 0, T: 0, R: 1000, B: 800, F: 500 });
  assert.deepEqual(evaluateSnapZones(100, 0, 9999, VIEW, off), {
    zH: null,
    zV: null,
    onLeftHalf: true,
  });
  assert.equal(evaluateSnapZones(1000, 0, 0, VIEW, off).onLeftHalf, false);
});

test('松手贴左、贴右、贴底，自由位记下离最近边的距离', () => {
  const left = anchorFromDrop(0, 200, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(left.left, 0);
  assert.equal(left.top, 200);
  assert.equal(left.bubbleSide, 'right');
  assert.deepEqual(left.anchor, {
    v: 2,
    hAnchor: 'left',
    hDist: 0,
    vAnchor: 'top',
    vDist: 200,
    hSnapped: 'left',
    vSnapped: null,
  });

  const right = anchorFromDrop(900, 200, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(right.left, VIEW.w - SIZE.w - GAP);
  assert.equal(right.top, 200);
  assert.equal(right.bubbleSide, 'left');
  assert.equal(right.anchor.hSnapped, 'right');
  assert.equal(right.anchor.hAnchor, 'right');
  assert.equal(right.anchor.hDist, 0);
  assert.equal(right.anchor.vSnapped, null);

  const bottom = anchorFromDrop(400, 700, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(bottom.top, VIEW.h - SIZE.h);
  assert.equal(bottom.left, 400);
  assert.equal(bottom.anchor.vSnapped, 'bottom');
  assert.equal(bottom.anchor.vAnchor, 'bottom');
  assert.equal(bottom.anchor.vDist, 0);
  assert.equal(bottom.anchor.hSnapped, null);
  assert.equal(bottom.anchor.hAnchor, 'left');
  assert.equal(bottom.anchor.hDist, 400);

  const free = anchorFromDrop(420, 300, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(free.anchor.hSnapped, null);
  assert.equal(free.anchor.vSnapped, null);
  assert.equal(free.anchor.hAnchor, 'left');
  assert.equal(free.anchor.hDist, 420);
  assert.equal(free.anchor.vAnchor, 'top');
  assert.equal(free.anchor.vDist, 300);
  assert.equal(free.left, 420);
  assert.equal(free.top, 300);
  assert.equal(free.bubbleSide, 'right');
  const grown = resolveAnchorPosition(free.anchor, SIZE, { w: 1600, h: 1100 }, GAP);
  assert.equal(grown.healed, false);
  assert.equal(grown.left, 420);
  assert.equal(grown.top, 300);

  const freeRight = anchorFromDrop(700, 300, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(freeRight.anchor.hSnapped, null);
  assert.equal(freeRight.anchor.hAnchor, 'right');
  assert.equal(freeRight.anchor.hDist, 200 - GAP);
  assert.equal(freeRight.left, 700);
  assert.equal(freeRight.bubbleSide, 'left');
  const wider = resolveAnchorPosition(freeRight.anchor, SIZE, { w: 1400, h: VIEW.h }, GAP);
  assert.equal(wider.healed, false);
  assert.equal(wider.left, 1400 - SIZE.w - GAP - freeRight.anchor.hDist);

  const nearTop = anchorFromDrop(420, 10, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(nearTop.top, 10);
  assert.equal(nearTop.anchor.vSnapped, null);

  for (const drop of [left, right, bottom, free, freeRight]) {
    const again = resolveAnchorPosition(drop.anchor, SIZE, VIEW, GAP);
    assert.equal(again.healed, false);
    assert.equal(again.left, drop.left);
    assert.equal(again.top, drop.top);
    assert.deepEqual(again.anchor, drop.anchor);
  }

  const wideRight = resolveAnchorPosition(right.anchor, SIZE, { w: 1600, h: VIEW.h }, GAP);
  assert.equal(wideRight.healed, false);
  assert.equal(wideRight.left, 1600 - SIZE.w - GAP);
  const tallBottom = resolveAnchorPosition(bottom.anchor, SIZE, { w: VIEW.w, h: 1100 }, GAP);
  assert.equal(tallBottom.top, 1100 - SIZE.h);

  const off = anchorFromDrop(0, 700, SIZE, VIEW, { ...DEFAULT_SNAP_CONFIG, mode: 'off' }, GAP);
  assert.equal(off.left, 0);
  assert.equal(off.top, 700);
  assert.equal(off.anchor.hSnapped, null);
  assert.equal(off.anchor.vSnapped, null);
});

test('坏距离和缩窗把锚点夹回视口，并写出可再存的干净值', () => {
  const negative: SavedAnchorPos = {
    v: 2,
    hAnchor: 'left',
    hDist: -25,
    vAnchor: 'bottom',
    vDist: Number.NaN,
    hSnapped: null,
    vSnapped: null,
  };
  const fixed = resolveAnchorPosition(negative, SIZE, VIEW, GAP);
  assert.equal(fixed.healed, true);
  assert.equal(fixed.left, 0);
  assert.equal(fixed.top, VIEW.h - SIZE.h);
  assert.equal(fixed.anchor.hDist, 0);
  assert.equal(fixed.anchor.vDist, 0);
  assert.ok(fixed.left >= 0 && fixed.left + SIZE.w <= VIEW.w);
  assert.ok(fixed.top >= 0 && fixed.top + SIZE.h <= VIEW.h);

  const infinite: SavedAnchorPos = {
    v: 2,
    hAnchor: 'left',
    hDist: Number.POSITIVE_INFINITY,
    vAnchor: 'top',
    vDist: Number.NEGATIVE_INFINITY,
    hSnapped: null,
    vSnapped: null,
  };
  const infiniteFixed = resolveAnchorPosition(infinite, SIZE, VIEW, GAP);
  assert.equal(infiniteFixed.healed, true);
  assert.equal(infiniteFixed.anchor.hDist, 0);
  assert.equal(infiniteFixed.anchor.vDist, 0);
  assert.equal(infiniteFixed.left, 0);
  assert.equal(infiniteFixed.top, 0);

  const small = { w: 360, h: 240 };
  const shrunkSource: SavedAnchorPos = {
    v: 2,
    hAnchor: 'right',
    hDist: 900,
    vAnchor: 'top',
    vDist: 700,
    hSnapped: null,
    vSnapped: null,
  };
  const shrunk = resolveAnchorPosition(shrunkSource, SIZE, small, GAP);
  assert.equal(shrunk.healed, true);
  assert.equal(shrunk.anchor.hDist, small.w - SIZE.w - GAP);
  assert.equal(shrunk.anchor.vDist, small.h - SIZE.h);
  assert.equal(shrunk.left, 0);
  assert.equal(shrunk.top, small.h - SIZE.h);
  assert.ok(shrunk.left + SIZE.w <= small.w);
  assert.ok(shrunk.top + SIZE.h <= small.h);
  const again = resolveAnchorPosition(shrunk.anchor, SIZE, small, GAP);
  assert.equal(again.healed, false);
  assert.equal(again.left, shrunk.left);
  assert.equal(again.top, shrunk.top);

  const missing = resolveAnchorPosition(null, SIZE, VIEW, GAP);
  assert.equal(missing.healed, true);
  assert.equal(missing.left, VIEW.w - SIZE.w - GAP);
  assert.equal(missing.top, VIEW.h - SIZE.h);
  assert.equal(missing.bubbleSide, 'left');
  assert.equal(missing.anchor.hSnapped, 'right');
  assert.equal(missing.anchor.vSnapped, 'bottom');
  assert.equal(missing.anchor.hDist, 0);
  assert.equal(missing.anchor.vDist, 0);

  const stale = { v: 1, hAnchor: 'left', hDist: 10, vAnchor: 'top', vDist: 10, hSnapped: null, vSnapped: null };
  const replaced = resolveAnchorPosition(stale as SavedAnchorPos, SIZE, VIEW, GAP);
  assert.equal(replaced.healed, true);
  assert.equal(replaced.left, missing.left);
  assert.equal(replaced.top, missing.top);
});

test('取消、缺坐标、NaN、以及拖动后的 (0, 0) 都回退', () => {
  assert.equal(shouldRevertDrag({ cancelled: true, clientX: 12, clientY: 40, moved: false }), true);
  assert.equal(shouldRevertDrag({ clientX: Number.NaN, clientY: 4, moved: false }), true);
  assert.equal(shouldRevertDrag({ clientX: 4, clientY: Number.POSITIVE_INFINITY, moved: true }), true);
  assert.equal(shouldRevertDrag({ moved: true }), true);
  assert.equal(shouldRevertDrag({ clientX: 0, clientY: 0, moved: true }), true);
  assert.equal(shouldRevertDrag({ cancelled: false, clientX: 0, clientY: 0, moved: false }), false);
  assert.equal(shouldRevertDrag({ clientX: 0, clientY: 4, moved: true }), false);
  assert.equal(shouldRevertDrag({ clientX: 18, clientY: 24, moved: true }), false);
});

test('默认两侧都不镜像；只有人在左侧且打开 mirrorOnLeft 才镜像', () => {
  assert.equal(shouldMirrorArt('left'), false);
  assert.equal(shouldMirrorArt('right'), false);
  assert.equal(shouldMirrorArt('left', false), false);
  assert.equal(shouldMirrorArt('right', false), false);
  assert.equal(shouldMirrorArt('right', true), true);
  assert.equal(shouldMirrorArt('left', true), false);

  const onLeft = anchorFromDrop(0, 200, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  const onRight = anchorFromDrop(900, 200, SIZE, VIEW, DEFAULT_SNAP_CONFIG, GAP);
  assert.equal(onLeft.bubbleSide, 'right');
  assert.equal(onRight.bubbleSide, 'left');
  assert.equal(shouldMirrorArt(onLeft.bubbleSide), false);
  assert.equal(shouldMirrorArt(onRight.bubbleSide), false);
  assert.equal(shouldMirrorArt(onLeft.bubbleSide, true), true);
  assert.equal(shouldMirrorArt(onRight.bubbleSide, true), false);
});

test('凸包去掉内点和重复点，方块和菱形能裁出外角，全透明则空', () => {
  assert.deepEqual(convexHull([]), []);
  assert.deepEqual(convexHull([[2, 2], [1, 1], [1, 1]]), [[1, 1], [2, 2]]);
  assert.deepEqual(convexHull([[0, 0], [2, 0], [1, 0]]), [[0, 0], [2, 0]]);
  const square: Point2D[] = [[0, 0], [3, 0], [3, 3], [0, 3], [1, 1], [2, 2], [0, 0]];
  assert.deepEqual(convexHull(square), [[0, 0], [3, 0], [3, 3], [0, 3]]);

  const width = 10;
  const height = 10;
  const block = new Uint8ClampedArray(width * height * 4);
  for (let y = 3; y <= 8; y += 1) {
    for (let x = 2; x <= 7; x += 1) {
      block[(y * width + x) * 4 + 3] = 255;
    }
  }
  const blockPath = buildAlphaClipPath(block, width, height);
  assert.match(blockPath, /^polygon\(/);
  assert.equal(blockPath.endsWith(')'), true);
  for (const [x, y] of [[2, 3], [7, 3], [7, 8], [2, 8]] as const) {
    assert.equal(blockPath.includes(`${(x / width * 100).toFixed(2)}% ${(y / height * 100).toFixed(2)}%`), true);
  }
  assert.equal(hasOpaqueProbePixels(block, width, height), true);

  const diamondSize = 11;
  const diamond = new Uint8ClampedArray(diamondSize * diamondSize * 4);
  const radius = 4;
  const center = 5;
  for (let y = 0; y < diamondSize; y += 1) {
    for (let x = 0; x < diamondSize; x += 1) {
      if (Math.abs(x - center) + Math.abs(y - center) <= radius) diamond[(y * diamondSize + x) * 4 + 3] = 255;
    }
  }
  const diamondPath = buildAlphaClipPath(diamond, diamondSize, diamondSize);
  assert.match(diamondPath, /^polygon\(/);
  const body = diamondPath.slice('polygon('.length, -1);
  assert.equal(body.split(', ').length, 4);
  for (const [x, y] of [[5, 1], [9, 5], [5, 9], [1, 5]] as const) {
    const token = `${(x / diamondSize * 100).toFixed(2)}% ${(y / diamondSize * 100).toFixed(2)}%`;
    assert.equal(diamondPath.includes(token), true, token);
  }
  assert.equal(hasOpaqueProbePixels(diamond, diamondSize, diamondSize), true);

  const blank = new Uint8Array(8 * 8 * 4);
  assert.equal(buildAlphaClipPath(blank, 8, 8), '');
  assert.equal(hasOpaqueProbePixels(blank, 8, 8), false);

  const threshold = new Uint8ClampedArray(8 * 8 * 4);
  threshold[3] = 10;
  assert.equal(buildAlphaClipPath(threshold, 8, 8), '');
  assert.equal(hasOpaqueProbePixels(threshold, 8, 8, 10), false);
  const probeX = Math.min(11, Math.floor((12 * 2.5) / 6));
  const probeY = probeX;
  const probed = new Uint8Array(12 * 12 * 4);
  const probeIndex = (probeY * 12 + probeX) * 4 + 3;
  const alpha = probed[probeIndex];
  assert.equal(alpha, 0);
  probed[probeIndex] = 11;
  assert.equal(hasOpaqueProbePixels(probed, 12, 12), true);
  assert.equal(buildAlphaClipPath(probed, 12, 12), '');
});
