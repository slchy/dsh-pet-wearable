import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DialogFsm } from '../src/dialog-fsm.ts';

test('票据带开轮时锁存的 baseCommitSeq / startedAtMs', () => {
  let commits = 3;
  let now = 1000;
  const fsm = new DialogFsm(() => {}, { baseCommitSeq: () => commits, now: () => now });

  fsm.beginTurn();
  const t = fsm.ticket();
  assert.equal(t.baseCommitSeq, 3, '开轮那一刻已经发出 3 发 commit');
  assert.equal(t.startedAtMs, 1000);
});

test('开了新的一轮之后，**老票据**上的 baseCommitSeq 不变', () => {
  // 这条是「自己后半句杀自己」的结构性防线：老段的迟到转写要拿**它自己那一轮**
  // 的基线去比。若 `ticket()` 现取，下一轮一开始，老票据就会被判成
  // 「这段是开轮之后录的」，于是又一次自己打断自己（真机 053719 第 2 轮）。
  let commits = 3;
  const fsm = new DialogFsm(() => {}, { baseCommitSeq: () => commits, now: () => 0 });

  fsm.beginTurn();
  const first = fsm.ticket();
  commits = 5;
  fsm.audioStarted(first);
  fsm.audioDone(first);
  fsm.beginTurn();
  const second = fsm.ticket();

  assert.equal(first.baseCommitSeq, 3, '老票据保持开轮时的值');
  assert.equal(second.baseCommitSeq, 5, '新票据记的是新基线');
});

test('没注入 context 时票据上不带这两个字段（离线/单测不假装有 ASR）', () => {
  const fsm = new DialogFsm(() => {});
  fsm.beginTurn();
  const t = fsm.ticket();
  assert.equal('baseCommitSeq' in t, false);
  assert.equal('startedAtMs' in t, false);
});

test('speaking ↔ thinking 回摆不刷新基线（同一轮内部的事）', () => {
  let commits = 2;
  const fsm = new DialogFsm(() => {}, { baseCommitSeq: () => commits, now: () => 0 });
  fsm.beginTurn();
  commits = 7;
  fsm.receiptStarted();      // thinking → speaking
  fsm.receiptEnded();        // speaking → thinking
  assert.equal(fsm.ticket().baseCommitSeq, 2, '回执来回不该把基线推前');
});
