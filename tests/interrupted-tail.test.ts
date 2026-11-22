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

test('注记里说的是"他真的没听到"，不是"你可以忽略"', () => {
  const note = interruptionNote('第二点是确认边界条件。');
  assert.ok(note.includes('打断'));
  // 真机 05:40:51：模型收到注记却答「说完了，就这些」——措辞必须堵死这条路
  assert.ok(note.includes('没听到'), `要说明用户没听到，实际：${note}`);
  assert.ok(note.includes('如实'), '要明确要求"问就说没说完"');
  assert.ok(note.includes('第二点是确认边界条件。'));
});

test('注记要解开「你: 全文」和「没说完」的自相矛盾', () => {
  // `pending` 里记的是**生成**出来的全文（被打断时通常已经写完），而注记说"没说完"。
  // 两句同时进 prompt，模型只会在两套说法之间猜 —— 所以注记得把"写完了但只念了一半"讲明。
  const note = interruptionNote('第二点是确认边界条件。');
  assert.ok(
    note.includes('全文你已经写出来了'),
    `要区分「写完」和「念完」，实际：${note}`,
  );
});

test('注记给了"换话题就别翻旧账"的出口', () => {
  const note = interruptionNote('第一点是先看清楚需求。');
  assert.ok(note.includes('换了话题'), '不能逼模型每次都硬接');
});

test('注记有上限，长回答不会把下一轮 prompt 塞爆', () => {
  const note = interruptionNote('啊'.repeat(1000));
  assert.ok([...note].length < 400, `注记太长：${[...note].length} 字`);
});

test('速率是标定值而非臆造：4–6 字/秒之间', () => {
  assert.ok(TTS_CHARS_PER_SEC >= 4 && TTS_CHARS_PER_SEC <= 6);
});
