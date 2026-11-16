/**
 * 长期记忆的只读视图（`MEMORY.md`）。
 *
 * 关键约定：**写权限只在 L2（dsh 的 `remember` 工具）**，快车道只读。
 * 所以这里只测两件事 —— 能不能正确解析，和「挑几条」挑得对不对。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryFile } from '../src/memory-file.ts';

const HEADER = '# 长期记忆\n\n这一行之下每行一条，越新越靠下。\n';

function withFile(content: string, run: (file: MemoryFile) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const file = join(dir, 'MEMORY.md');
  writeFileSync(file, content, 'utf8');
  try {
    run(new MemoryFile(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('解析：只认 `- ` 开头的条目，并去掉日期前缀', () => {
  withFile(
    `${HEADER}- 2026-11-16 23:08 · 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n`,
    (mem) => {
      assert.deepEqual(mem.entries(), ['哥姓袁，称呼袁哥。', '哥住在杭州。']);
    },
  );
});

test('文件不存在就当没有记忆，不抛', () => {
  const mem = new MemoryFile(join(tmpdir(), '绝对不存在的记忆.md'));
  assert.deepEqual(mem.entries(), []);
  assert.deepEqual(mem.relevant('我叫什么'), []);
});

test('相关的那条排前面', () => {
  withFile(
    `${HEADER}- 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n- 哥每天十一点睡。\n`,
    (mem) => {
      assert.deepEqual(mem.relevant('我住在哪来着'), ['哥住在杭州。']);
    },
  );
});

test('一条都不沾边时给最近两条（宁可多给，别让模型说不知道）', () => {
  withFile(
    `${HEADER}- 哥姓袁，称呼袁哥。\n- 哥住在杭州。\n- 哥每天十一点睡。\n`,
    (mem) => {
      assert.deepEqual(mem.relevant('我有点困了'), ['哥住在杭州。', '哥每天十一点睡。']);
    },
  );
});

test('文件改了要能读到新的（按 mtime 缓存，不能缓存一辈子）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const path = join(dir, 'MEMORY.md');
  try {
    writeFileSync(path, `${HEADER}- 哥住在杭州。\n`, 'utf8');
    const mem = new MemoryFile(path);
    assert.deepEqual(mem.entries(), ['哥住在杭州。']);

    writeFileSync(path, `${HEADER}- 哥住在杭州。\n- 哥养了只橘猫。\n`, 'utf8');
    // 有些文件系统的 mtime 精度是秒，等一下确保变了
    const now = Date.now() + 5;
    while (Date.now() < now) { /* 空转几毫秒 */ }
    assert.equal(mem.entries().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
