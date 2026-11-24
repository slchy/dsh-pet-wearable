/**
 * `AnnounceStore` 的单测：离线期间攒下的后台汇报，下次连上要能完整取走。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AnnounceStore } from '../src/announce-store.ts';

function store(dir: string, maxItems = 20): AnnounceStore {
  const s = AnnounceStore.open({ file: join(dir, 'announce.jsonl'), maxItems, log: () => {} });
  assert.ok(s);
  return s;
}

test('push 后能按顺序 drain 出来，并且清空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-'));
  try {
    const s = store(dir);
    s.push('第一条');
    assert.equal(s.push('第二条'), 2);
    assert.deepEqual(s.drain(), [{ text: '第一条' }, { text: '第二条' }]);
    assert.equal(s.size, 0);
    assert.deepEqual(s.drain(), [], '取空之后再取应当为空');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('超过上限时丢最旧的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-cap-'));
  try {
    const s = store(dir, 3);
    for (const t of ['a', 'b', 'c', 'd']) {
      s.push(t);
    }
    assert.deepEqual(s.drain(), [{ text: 'b' }, { text: 'c' }, { text: 'd' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏行被跳过，好行仍然可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-bad-'));
  try {
    const file = join(dir, 'announce.jsonl');
    writeFileSync(file, `${JSON.stringify({ t: 1, text: '好的' })}\nnot-json\n{"t":2}\n`);
    const s = AnnounceStore.open({ file, log: () => {} });
    assert.ok(s);
    assert.deepEqual(s.drain(), [{ text: '好的' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('情绪跟着一起存取（离线攒的播报不该变回平静语气）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-mood-'));
  try {
    const file = join(dir, 'announce.jsonl');
    const s = AnnounceStore.open({ file, log: () => {} });
    assert.ok(s);
    s.push('跑完了', 'happy');
    s.push('出了点问题', 'worried');
    s.push('没情绪的');
    assert.deepEqual(s.drain(), [
      { text: '跑完了', emotion: 'happy' },
      { text: '出了点问题', emotion: 'worried' },
      { text: '没情绪的' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧文件没有 emotion 字段也能读（向前兼容）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-legacy-'));
  try {
    const file = join(dir, 'announce.jsonl');
    writeFileSync(file, `${JSON.stringify({ t: 1, text: '老格式的一条' })}\n`);
    const s = AnnounceStore.open({ file, log: () => {} });
    assert.ok(s);
    assert.deepEqual(s.drain(), [{ text: '老格式的一条' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('路径为空时不持久化（返回 null）', () => {
  assert.equal(AnnounceStore.open({ file: '' }), null);
});

test('写入是同步的：push 之后文件立刻可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-sync-'));
  try {
    const file = join(dir, 'announce.jsonl');
    const s = AnnounceStore.open({ file, log: () => {} });
    assert.ok(s);
    s.push('断线期间的汇报');
    assert.match(readFileSync(file, 'utf8'), /断线期间的汇报/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入失败时回滚本次入队并返回 0，不虚报积压', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announce-fail-'));
  const file = join(dir, 'announce.jsonl');
  try {
    const logs: string[] = [];
    const s = AnnounceStore.open({ file, maxItems: 2, log: (line) => { logs.push(line); } });
    assert.ok(s);
    assert.equal(s.push('已有'), 1);
    assert.equal(s.push('还在'), 2);
    chmodSync(file, 0o444);
    try {
      assert.equal(s.push('写不进去'), 0, '没写上的条目不能算进积压');
      assert.ok(logs.some((line) => line.includes('写入失败')));
    } finally {
      chmodSync(file, 0o666);
    }
    assert.equal(s.size, 2, '失败的入队不能把已经落盘的队列改掉');
    assert.deepEqual(s.drain(), [{ text: '已有' }, { text: '还在' }]);
  } finally {
    try { chmodSync(file, 0o666); } catch { /* 文件可能还没建出来 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
