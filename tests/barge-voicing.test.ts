/**
 * `barge-voicing` —— 插话要求「转写底下有刚发出的声音」。
 *
 * 用真机档案里的实际数字当用例：真插话 0–120 ms，静音幻觉 885 ms / 2.7 s。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BARGE_VOICED_GAP_MS, hasVoicedEvidence } from '../src/barge-voicing.ts';

test('真插话：距上次有声 0–120 ms，放行', () => {
  // 69250「你看过」、179501「飞向」、218171「哈喽」都是紧接用户的声音
  for (const gap of [0, 7, 60, 120]) {
    assert.equal(hasVoicedEvidence(1_000 + gap, 1_000), true, `gap ${gap} ms 应放行`);
  }
});

test('静音幻觉：885 ms / 2.7 s，拦掉', () => {
  // 91351「Thank」（上行 −75.6 dBFS）、260134「Thank」（−71.8 dBFS）
  for (const gap of [885, 2_700]) {
    assert.equal(hasVoicedEvidence(10_000 + gap, 10_000), false, `gap ${gap} ms 应拦下`);
  }
});

test('阈值两侧：刚好 500 ms 仍算有声音，501 ms 就不算', () => {
  assert.equal(hasVoicedEvidence(1_000 + BARGE_VOICED_GAP_MS, 1_000), true);
  assert.equal(hasVoicedEvidence(1_001 + BARGE_VOICED_GAP_MS, 1_000), false);
});

test('没有音频证据（模拟器 / 还没接过上行）不拦', () => {
  // 按「静音」处理等于把插话功能整个关掉，保守方向是放行
  assert.equal(hasVoicedEvidence(1_000, Number.NEGATIVE_INFINITY), true);
});
