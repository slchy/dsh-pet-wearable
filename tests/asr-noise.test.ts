/**
 * `asr-noise` —— 无汉字的转写当噪声。
 *
 * 这条闸门管的是**整类**故障：ASR 在静音上幻觉出的英文短句会走完整条链路
 * （打断播放 → 开轮 → 白烧 agent）。真机两次各丢一整条答案。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAsrNoise } from '../src/asr-noise.ts';

test('真机出现过的幽灵文本全部判噪声', () => {
  // 2026-11-22/23 八份档案里出现过的全部无汉字转写
  for (const text of ['Thank', 'Thank you.', 'Yeah.', 'Okay.', 'Oh.', 'These.', 'エピ。', 'ж.', 'die.']) {
    assert.equal(isAsrNoise(text), true, `${text} 应当判噪声`);
  }
});

test('中文转写一律放行', () => {
  for (const text of ['你看过三体吗？', '嗯。', '哲学思辨。', 'OK，那算了。']) {
    assert.equal(isAsrNoise(text), false, `${text} 是真实输入`);
  }
});

test('纯数字串是真实输入：电话号码、年份', () => {
  assert.equal(isAsrNoise('13800138000'), false, '报电话号码是真实场景');
  assert.equal(isAsrNoise('2024'), false, '年份四位');
  assert.equal(isAsrNoise('123'), true, '三位以内更像幻觉/尾音');
});

test('空白与空串算噪声（没有内容可判）', () => {
  assert.equal(isAsrNoise(''), true);
  assert.equal(isAsrNoise('   '), true);
  assert.equal(isAsrNoise('。。。'), true);
});
