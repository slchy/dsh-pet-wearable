/**
 * `barge-voicing` —— 插话要求「上一次定稿之后还有新的声音」。
 *
 * 用例取 8 份真机档案里 17 次 `partial` 插话的实测值（逐条压在录音上算过）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { voicedSinceLastSentence } from '../src/barge-voicing.ts';

test('尾静音幻觉：定稿之后没有新声音 → 拦下', () => {
  // `Thank` ×3：定稿后 835 / 1395 / 2725 ms 才冒出来，这期间一个有声帧都没有
  for (const gap of [835, 1395, 2725]) {
    assert.equal(voicedSinceLastSentence(1_000_000, 1_000_000 + gap), false, `gap ${gap} ms 应拦下`);
  }
});

test('真插话：定稿之后用户又开口了 → 放行', () => {
  // 你看过 / 飞向 / 哈喽 / Oh / These 全是「话音刚落」，`没印象` 慢到 795 ms 也是真话
  for (const after of [1, 10, 120, 795]) {
    assert.equal(voicedSinceLastSentence(1_000_000 + after, 1_000_000), true, `+${after} ms 应放行`);
  }
});

test('没有音频证据（模拟器 / 还没接过上行）不拦', () => {
  // 按「没声音」处理等于把插话功能整个关掉，保守方向是放行
  assert.equal(voicedSinceLastSentence(Number.NEGATIVE_INFINITY, 1_000), true);
  assert.equal(voicedSinceLastSentence(1_000, Number.NEGATIVE_INFINITY), true);
});
