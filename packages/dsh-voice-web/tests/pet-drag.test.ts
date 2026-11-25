/**
 * 拖拽：3px 内算点击，(0,0) 已移动只回退，没移动算点击，取消只回退。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyRelease,
  notePointerMove,
  type DragGesture,
} from '../src/browser/pet-drag.ts';

const VIEW = { w: 1000, h: 800 };

function gesture(over: Partial<DragGesture> = {}): DragGesture {
  return {
    pointerId: 1,
    startX: 0,
    startY: 0,
    origLeft: 40,
    origTop: 80,
    moved: false,
    active: true,
    ...over,
  };
}

test('位移平方小于 9 不算拖，大于等于 9 才算', () => {
  const start = gesture();
  const inside = notePointerMove(start, 2, 2);
  assert.equal(inside, start);
  assert.equal(inside.moved, false);

  const edge = notePointerMove(start, 3, 0);
  assert.equal(edge.moved, true);
  assert.equal(notePointerMove(edge, 3.5, 0), edge);

  const nan = notePointerMove(start, Number.NaN, 0);
  assert.equal(nan.moved, false);
});

test('(0,0) 已移动只回退，没移动算点击，取消只回退', () => {
  const base = {
    sizePx: 144,
    viewport: VIEW,
    rightGap: 12,
  };
  const movedOrigin = classifyRelease({
    ...base,
    gesture: gesture({ moved: true }),
    cancelled: false,
    clientX: 0,
    clientY: 0,
  });
  assert.deepEqual(movedOrigin, { kind: 'revert' });

  const still = classifyRelease({
    ...base,
    gesture: gesture({ moved: false }),
    cancelled: false,
    clientX: 0,
    clientY: 0,
  });
  assert.deepEqual(still, { kind: 'click' });

  const click = classifyRelease({
    ...base,
    gesture: gesture({ moved: false }),
    cancelled: false,
    clientX: 40,
    clientY: 80,
  });
  assert.deepEqual(click, { kind: 'click' });

  const cancelled = classifyRelease({
    ...base,
    gesture: gesture({ moved: true }),
    cancelled: true,
    clientX: 400,
    clientY: 300,
  });
  assert.deepEqual(cancelled, { kind: 'revert' });

  const cancelledStill = classifyRelease({
    ...base,
    gesture: gesture({ moved: false }),
    cancelled: true,
    clientX: 0,
    clientY: 0,
  });
  assert.deepEqual(cancelledStill, { kind: 'revert' });

  const dropped = classifyRelease({
    ...base,
    gesture: gesture({ moved: true, origLeft: 0, origTop: 100, startX: 0, startY: 100 }),
    cancelled: false,
    clientX: 10,
    clientY: 100,
  });
  assert.equal(dropped.kind, 'drop');
  if (dropped.kind === 'drop') {
    assert.equal(dropped.drop.anchor.v, 2);
    assert.equal(dropped.drop.anchor.hSnapped, 'left');
  }
});
