/**
 * 上下文压缩的**可观测性**：压缩本身已由 dsh 的四层插件完成（摘要压缩 /
 * 工具结果剪裁 / 图片卸载 / 大结果外溢），我们不该再写一套。
 *
 * 缺的是「撞上压缩的那一轮为什么突然慢」—— `ctx` 只会一路涨，压缩后骤降。
 * 这里只在两个时刻各说一句，平时不加任何噪声。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compactionNote } from '../src/agent.ts';

test('平时不出声', () => {
  assert.equal(compactionNote(18_868, 18_500), '');
  assert.equal(compactionNote(21_132, 21_000), '');
});

test('接近阈值要提前说 —— 真机上「这轮怎么慢了三秒」多半是它', () => {
  const note = compactionNote(101_000, 99_000);
  assert.ok(note.includes('接近压缩阈值'), `实际：${note}`);
});

test('刚压缩过（ctx 骤降）要点名', () => {
  const note = compactionNote(29_000, 126_000);
  assert.ok(note.includes('刚压缩过'), `实际：${note}`);
  assert.ok(note.includes('126000'), '要把上一轮的规模写出来，方便回查日志');
});

test('小幅回落在缓存抖动范围，不算压缩', () => {
  assert.equal(compactionNote(19_000, 21_000), '', '只降 10% 不该报压缩');
});

test('没有上下文数据时什么都不说', () => {
  assert.equal(compactionNote(undefined, 20_000), '');
});
