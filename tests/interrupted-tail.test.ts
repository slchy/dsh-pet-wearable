/**
 * 「被打断的那半句」怎么算。
 *
 * 真机现场（05:04:55）：
 *
 * ```text
 * 状态 speaking        ← 正在念回答
 * 句 1  "调用CBC的D。"  ← 用户插话
 * 状态 speaking → listening (插话「调用CBC的D。」→ 代次 3)
 * …
 * 句 1  "你刚刚想说什么？"   ← 它自己也不知道刚才说到哪了
 * ```
 *
 * 这里只验证纯计算：按已播时长切出剩下没念的那段，以及交给模型的那句注记。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TTS_CHARS_PER_SEC,
  interruptionNote,
  remainingSpeech,
} from '../src/interrupted-tail.ts';

const SPEECH = '这件事我分成三点来说，第一点是先看清楚需求，第二点是确认边界条件。';

test('一句没错过：什么都没剩下', () => {
  assert.equal(remainingSpeech(SPEECH, 0), SPEECH);
  assert.equal(remainingSpeech(SPEECH, 60), '');
});

test('播到一半：从最近的标点之后接着念，不切在词中间', () => {
  // 4.8 字/秒 × 2.6 s ≈ 12 字 → 落在「，」之后
  const rest = remainingSpeech(SPEECH, 2.6);
  assert.ok(rest.startsWith('第一点'), `应当从「第一点」接上，实际：${rest}`);
  assert.ok(rest.endsWith('确认边界条件。'));
});

test('才开口就打断：整句都还在', () => {
  assert.equal(remainingSpeech(SPEECH, 0.1), SPEECH);
});

test('只剩标点就不算剩下东西', () => {
  // 正好停在结尾的句号上：不该给模型一句「。」
  const endsWithPeriod = '好。';
  assert.equal(remainingSpeech(endsWithPeriod, 0.4), '');
});

test('空文本 / 负时长不炸', () => {
  assert.equal(remainingSpeech('', 1), '');
  assert.equal(remainingSpeech(SPEECH, -5), SPEECH);
});

test('注记里说得清「没说出口」而不是「说到一半」', () => {
  const note = interruptionNote('第二点是确认边界条件。');
  assert.ok(note.includes('打断'));
  assert.ok(note.includes('没说出口'));
  assert.ok(note.includes('第二点是确认边界条件。'));
  // 要给它「可以不理」的出口，否则用户只是不想听了它还在硬接
  assert.ok(note.includes('否则'));
});

test('注记有上限，长回答不会把下一轮 prompt 塞爆', () => {
  const note = interruptionNote('啊'.repeat(1000));
  assert.ok([...note].length < 400, `注记太长：${[...note].length} 字`);
});

test('速率是标定值而非臆造：4–6 字/秒之间', () => {
  assert.ok(TTS_CHARS_PER_SEC >= 4 && TTS_CHARS_PER_SEC <= 6);
});
