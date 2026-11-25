/**
 * PendingResponse 的相位与读端。不碰 socket。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blankPending,
  isCancelled,
  isClosed,
  isSettled,
  iterateSolo,
  markPhaseDone,
  openExclusiveReader,
  takeChunk,
} from '../src/omni/response.ts';
import type { SealMeta } from '../src/omni/types.ts';

const META: SealMeta = { seq: 1, silenceMs: 0, anchor: 0, bytes: 0, flushedMs: 0 };

test('相位迁到 done；已 done 时二次 markPhaseDone 不改 endedByCancel', () => {
  const starting = blankPending(META, 'user', 0);
  assert.equal(starting.phase, 'starting');
  assert.equal(isCancelled(starting), false);
  assert.equal(isClosed(starting), false);
  assert.equal(isSettled(starting), false);

  starting.phase = 'live';
  assert.equal(isCancelled(starting), false);
  markPhaseDone(starting);
  assert.equal(starting.phase, 'done');
  assert.equal(starting.endedByCancel, false);
  assert.equal(isClosed(starting), true);
  assert.equal(isCancelled(starting), false);
  markPhaseDone(starting, true);
  assert.equal(starting.phase, 'done');
  assert.equal(starting.endedByCancel, false);

  const cancelling = blankPending(META, 'user', 1);
  cancelling.phase = 'cancel_when_created';
  assert.equal(isCancelled(cancelling), true);
  assert.equal(isSettled(cancelling), true);
  assert.equal(isClosed(cancelling), false);
  markPhaseDone(cancelling, false);
  assert.equal(cancelling.phase, 'done');
  assert.equal(cancelling.endedByCancel, true);
  markPhaseDone(cancelling, false);
  assert.equal(cancelling.endedByCancel, true);

  const liveCancel = blankPending(META, 'announce', 2);
  liveCancel.phase = 'cancelling';
  markPhaseDone(liveCancel);
  assert.equal(liveCancel.endedByCancel, true);
  assert.equal(isCancelled(liveCancel), true);
});

test('openExclusiveReader 让旧 epoch 的 takeChunk 返回 stale', () => {
  const resp = blankPending(META, 'user', 0);
  resp.audio.push(Buffer.from([1]), Buffer.from([2]));
  const old = openExclusiveReader(resp);
  const fresh = openExclusiveReader(resp);
  assert.equal(takeChunk(resp, old), 'stale');
  const chunk = takeChunk(resp, fresh);
  assert.ok(Buffer.isBuffer(chunk));
  assert.equal(chunk[0], 1);
  assert.equal(fresh.index, 1);
});

test('iterateSolo 只读自己这份，不跨 next', async () => {
  const head = blankPending(META, 'announce', 0);
  const next = blankPending(META, 'user', 1);
  head.next = next;
  head.audio.push(Buffer.from([4, 5]));
  next.audio.push(Buffer.from([9]));
  markPhaseDone(head);

  const got: number[] = [];
  for await (const chunk of iterateSolo(head)) {
    got.push(...chunk);
  }
  assert.deepEqual(got, [4, 5]);
  assert.equal(next.audio.length, 1);
  assert.equal(next.audio[0]?.[0], 9);
  assert.equal(next.readerEpoch, 0);
});
