/**
 * 一轮的系统注记怎么拼。
 *
 * 两段各自独立、都只在当下有效：
 * - **设备现状**：电量、戴没戴。模型看不见上行事件流，不给它这行就会瞎答
 *   （真机问「眼镜还剩多少电」，agent 回「读不到，我手上没有拿电量的接口」，
 *   而设备每 30 s 就在报 `{"kind":"power","percent":77}`）。
 * - **续话尾巴**：上一轮被打断、没念出口的那一段，只活到下一轮。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeTurnNote } from '../src/app/dialog.ts';

test('两段都有时按「设备 → 续话」拼接', () => {
  const note = composeTurnNote('设备现状：电量 77%', '上一轮还剩「我还没说完」');
  assert.equal(note, '设备现状：电量 77%；上一轮还剩「我还没说完」');
});

test('只有一段时不带多余分隔符', () => {
  assert.equal(composeTurnNote('设备现状：电量 77%', undefined), '设备现状：电量 77%');
  assert.equal(composeTurnNote(undefined, '上一轮的尾巴'), '上一轮的尾巴');
});

test('两段都没有时返回 undefined，让调用方干净地略过', () => {
  assert.equal(composeTurnNote(undefined, undefined), undefined);
  assert.equal(composeTurnNote('', ''), undefined, '空串不该被当成内容');
});
