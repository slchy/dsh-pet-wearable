import assert from 'node:assert/strict';
import { test } from 'node:test';

import { voicingVerdict, voicedSinceLastSentence } from '../src/barge-voicing.ts';

test('尾静音幻觉：定稿之后没有新声音 → silent', () => {
  // `Thank` ×3：定稿后 835 / 1395 / 2725 ms 才冒出来，这期间一个有声帧都没有
  for (const gap of [835, 1395, 2725]) {
    assert.equal(voicingVerdict(1_000_000, 1_000_000 + gap), 'silent', `gap ${gap} ms`);
  }
});

test('真插话：定稿之后用户又开口了 → voiced', () => {
  // 你看过 / 飞向 / 哈喽 / Oh / These 全是「话音刚落」，`没印象` 慢到 795 ms 也是真话
  for (const after of [1, 10, 120, 795]) {
    assert.equal(voicingVerdict(1_000_000 + after, 1_000_000), 'voiced', `+${after} ms`);
  }
});

test('两把时钟：epoch 毫秒 vs 进程单调毫秒 → clock-mismatch（真机踩过，闸静默失效）', () => {
  // `UtteranceAssembler` 默认 `Date.now()`（≈1.76e12），`SystemClock.now()` ≈2e4
  assert.equal(voicingVerdict(1_764_000_000_000, 18_491), 'clock-mismatch');
  // 接错时**偏向放行**，但调用方必须把这条报出来
  assert.equal(voicedSinceLastSentence(1_764_000_000_000, 18_491), true);
});

test('没有音频证据（模拟器 / 还没接过上行）→ no-evidence，放行', () => {
  assert.equal(voicingVerdict(Number.NEGATIVE_INFINITY, 1_000), 'no-evidence');
  assert.equal(voicingVerdict(1_000, Number.NEGATIVE_INFINITY), 'no-evidence');
  assert.equal(voicedSinceLastSentence(Number.NEGATIVE_INFINITY, 1_000), true);
});
