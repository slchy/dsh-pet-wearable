/**
 * 上行账本不变量：静音只进 ring、划段后脏账归零、溢出先丢 parked、discard 归还不 commit。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_HELD_BYTES, UplinkLedger } from '../src/omni/uplink-ledger.ts';

function ledger(): UplinkLedger {
  return new UplinkLedger(undefined, () => {});
}

test('静音期无声只进 ring，不进服务端缓冲也不进 held', () => {
  const book = ledger();
  const silence = Buffer.alloc(100);
  assert.deepEqual(book.accept(silence, false), []);
  assert.deepEqual(book.accept(Buffer.alloc(50), false), []);
  assert.equal(book.muted, true);
  assert.equal(book.ringBytes, 150);
  assert.equal(book.dirtyBytes, 0);
  assert.equal(book.serverBufferedBytes, 0);
  assert.equal(book.heldBytes, 0);
  assert.equal(book.parkedServerBytes, 0);
});

test('parkSegment 划走活账后 dirtyBytes === 0', () => {
  const book = ledger();
  book.noteServerAppend(320);
  book.hold(Buffer.alloc(64));
  assert.equal(book.dirtyBytes, 384);
  book.parkSegment();
  assert.equal(book.dirtyBytes, 0);
  assert.equal(book.serverBufferedBytes, 0);
  assert.equal(book.heldBytes, 0);
  assert.equal(book.parkedServerBytes, 320);
  assert.equal(book.parkedHeldBytes, 64);
});

test('暂存溢出优先丢 parkedHeld，活的 held 留下', () => {
  const book = ledger();
  const parkedSize = Math.floor(MAX_HELD_BYTES * 0.8);
  const heldSize = Math.floor(MAX_HELD_BYTES * 0.4);
  book.parkedHeld.push(Buffer.alloc(parkedSize));
  book.parkedHeldBytes = parkedSize;
  book.hold(Buffer.alloc(heldSize));
  assert.equal(book.parkedHeld.length, 0);
  assert.equal(book.parkedHeldBytes, 0);
  assert.equal(book.heldBytes, heldSize);
  assert.equal(book.held.length, 1);
});

test('discard 把 parkedServerBytes 归还 serverBufferedBytes，且不记 commit 残留', () => {
  const book = ledger();
  book.serverBufferedBytes = 100;
  book.parkedServerBytes = 40;
  book.held.push(Buffer.alloc(8));
  book.heldBytes = 8;
  book.parkedHeld.push(Buffer.alloc(4));
  book.parkedHeldBytes = 4;
  book.discard();
  assert.equal(book.serverBufferedBytes, 140);
  assert.equal(book.parkedServerBytes, 0);
  assert.equal(book.heldBytes, 0);
  assert.equal(book.parkedHeldBytes, 0);
  assert.equal(book.lastFlushedMs, 0);
  assert.equal(book.dirtyBytes, 140);
});

test('clearLocal 只丢本地帧，不动服务端计数', () => {
  const book = ledger();
  book.serverBufferedBytes = 10;
  book.parkedServerBytes = 20;
  book.held.push(Buffer.alloc(5));
  book.heldBytes = 5;
  book.parkedHeld.push(Buffer.alloc(7));
  book.parkedHeldBytes = 7;
  book.ring.push(Buffer.alloc(3));
  book.ringBytes = 3;
  book.clearLocal();
  assert.equal(book.serverBufferedBytes, 10);
  assert.equal(book.parkedServerBytes, 20);
  assert.equal(book.held.length, 0);
  assert.equal(book.heldBytes, 0);
  assert.equal(book.parkedHeld.length, 0);
  assert.equal(book.parkedHeldBytes, 0);
  assert.equal(book.ringBytes, 3);
});

test('restartSnapshot 先读服务端缓冲，held 不参与要不要裸 commit', () => {
  const book = ledger();
  book.serverBufferedBytes = 320;
  book.parkedServerBytes = 320;
  book.held.push(Buffer.alloc(32));
  book.heldBytes = 32;
  const snap = book.restartSnapshot();
  assert.equal(snap, 640);
  assert.equal(book.serverBufferedBytes, 0);
  assert.equal(book.parkedServerBytes, 0);
  assert.equal(book.heldBytes, 0);
  assert.equal(book.dirtyBytes, 0);
  assert.equal(book.lastFlushedMs, 20);
  assert.equal(book.muted, false);

  const empty = ledger();
  empty.lastFlushedMs = 7;
  assert.equal(empty.restartSnapshot(), 0);
  assert.equal(empty.lastFlushedMs, 7);
});
