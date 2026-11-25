/**
 * 透明化清单只碰注入的临时目录，不读真实的 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SupersededStore } from '../src/session/superseded.ts';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-11-18T00:00:00Z');

function touch(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker'), 'keep');
}

function storeAt(dir: string): { store: SupersededStore; file: string; root: string } {
  const root = join(dir, 'sessions');
  const file = join(dir, 'superseded.jsonl');
  const store = new SupersededStore({
    supersededFile: file,
    sessionsRoot: root,
    now: () => NOW,
  });
  return { store, file, root };
}

test('retire 把找到的会话目录写进 jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superseded-'));
  try {
    const { store, file, root } = storeAt(dir);
    store.retire('missing', null);
    assert.equal(existsSync(file), false, '找不到目录时不建清单');

    const sessionDir = join(root, 'ws', 'session-a');
    touch(sessionDir);
    store.retire('session-a', null);
    const parsed = JSON.parse(readFileSync(file, 'utf8').trim()) as { id: string; at: number; dir: string };
    assert.equal(parsed.id, 'session-a');
    assert.equal(parsed.at, NOW);
    assert.equal(parsed.dir, sessionDir);
    assert.equal(existsSync(sessionDir), true, '刚登记的还在保留期内，不能删');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('过期目录删掉，未过期留在清单里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superseded-'));
  try {
    const { store, file, root } = storeAt(dir);
    const oldDir = join(root, 'ws', 'session-old');
    const freshDir = join(root, 'ws', 'session-fresh');
    touch(oldDir);
    touch(freshDir);
    writeFileSync(file, [
      JSON.stringify({ id: 'session-old', at: NOW - 8 * DAY, dir: oldDir }),
      JSON.stringify({ id: 'session-fresh', at: NOW - DAY, dir: freshDir }),
    ].join('\n') + '\n');

    store.collect(null);
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(join(freshDir, 'marker')), true);
    const kept = readFileSync(file, 'utf8');
    assert.match(kept, /session-fresh/);
    assert.doesNotMatch(kept, /session-old/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openSessionId 命中的过期条目不 rm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superseded-'));
  try {
    const { store, file, root } = storeAt(dir);
    const openDir = join(root, 'ws', 'session-open');
    touch(openDir);
    writeFileSync(file, `${JSON.stringify({
      id: 'session-open',
      at: NOW - 8 * DAY,
      dir: openDir,
    })}\n`);

    store.collect('session-open');
    assert.equal(existsSync(join(openDir, 'marker')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非法路径不 rm：根外和目录名对不上 id 都留着', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superseded-'));
  try {
    const { store, file, root } = storeAt(dir);
    const evil = join(dir, 'outside', 'session-evil');
    const mismatch = join(root, 'ws', 'not-the-id');
    touch(evil);
    touch(mismatch);
    writeFileSync(file, [
      JSON.stringify({ id: 'session-evil', at: NOW - 30 * DAY, dir: evil }),
      JSON.stringify({ id: 'session-x', at: NOW - 30 * DAY, dir: mismatch }),
    ].join('\n') + '\n');

    store.collect(null);
    assert.equal(existsSync(join(evil, 'marker')), true);
    assert.equal(existsSync(join(mismatch, 'marker')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
