/**
 * CosyVoice provider 的**不联网**契约测试。
 *
 * 首包延迟要真连服务端才能测（见 `scripts/probe-cosyvoice.mjs`），这里只钉住
 * 那些「改坏了不会立刻报错、但会让线上声音不对」的东西。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COSYVOICE_SAMPLE_RATE, CosyVoiceError, EMOTION_INSTRUCTIONS, EMOTION_PROSODY, cosyVoiceTts } from '../src/cosyvoice.ts';
import { EMOTIONS, type Emotion } from '../src/emotion.ts';

const KEYS = Object.keys(EMOTIONS) as Emotion[];

test('每个情绪都有 rate/pitch，且没多没少', () => {
  assert.deepEqual(Object.keys(EMOTION_PROSODY).sort(), [...KEYS].sort());
});

test('每个情绪都有自由指令，且没多没少', () => {
  assert.deepEqual(Object.keys(EMOTION_INSTRUCTIONS).sort(), [...KEYS].sort());
});

test('指令长度不超过阿里云上限（100 字符，汉字按 2 个计）', () => {
  for (const key of KEYS) {
    const text = EMOTION_INSTRUCTIONS[key];
    const cost = [...text].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0);
    assert.ok(cost <= 100, `${key} 指令 ${cost} 字符，超了`);
  }
});

test('情绪 → 语速是单调的：委屈最慢、开心最快', () => {
  const ordered = [...KEYS].sort((a, b) => EMOTION_PROSODY[a].rate - EMOTION_PROSODY[b].rate);
  assert.equal(ordered.at(0), 'sulk');
  assert.equal(ordered.at(-1), 'happy');
  // 平静必须是 1.0：它是「没有情绪」的基准，偏离了会让中性回复也变调
  assert.equal(EMOTION_PROSODY.calm.rate, 1);
  assert.equal(EMOTION_PROSODY.calm.pitch, 1);
});

test('rate/pitch 都落在阿里云的合法区间（0.5–2 / 0.5–2）', () => {
  for (const key of KEYS) {
    const { rate, pitch } = EMOTION_PROSODY[key];
    assert.ok(rate >= 0.5 && rate <= 2, `${key} rate=${rate}`);
    assert.ok(pitch >= 0.5 && pitch <= 2, `${key} pitch=${pitch}`);
  }
});

test('缺 API key 时立刻报错，不要等到第一句话才发现', () => {
  assert.throws(() => cosyVoiceTts({ apiKey: '' }), CosyVoiceError);
});

test('provider 声明自己的采样率（24 kHz，和 MiMo 一致，宿主不用改）', () => {
  const tts = cosyVoiceTts({ apiKey: 'sk-test', voice: 'longanhuan_v3' });
  assert.equal(tts.sampleRate, COSYVOICE_SAMPLE_RATE);
  assert.equal(tts.sampleRate, 24_000);
  assert.match(tts.name, /^cosyvoice:/);
});
