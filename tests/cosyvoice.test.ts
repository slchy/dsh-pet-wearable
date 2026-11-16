/**
 * CosyVoice provider 的**不联网**契约测试。
 *
 * 首包延迟要真连服务端才能测（见 `scripts/probe-cosyvoice.mjs`），这里只钉住
 * 那些「改坏了不会立刻报错、但会让线上声音不对」的东西。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COSYVOICE_SAMPLE_RATE, CosyVoiceError, EMOTION_INSTRUCTIONS, EMOTION_PROSODY, cosyVoiceTts, isSilentChunk } from '../src/cosyvoice.ts';
import { EMOTIONS, type Emotion } from '../src/emotion.ts';

const KEYS = Object.keys(EMOTIONS) as Emotion[];

test('每个情绪都有 rate/pitch，且没多没少', () => {
  assert.deepEqual(Object.keys(EMOTION_PROSODY).sort(), [...KEYS].sort());
});

test('每个情绪都有自由指令，且没多没少', () => {
  assert.deepEqual(Object.keys(EMOTION_INSTRUCTIONS).sort(), [...KEYS].sort());
});

test('指令都用阿里云认的单一情感句式，且以句号结尾', () => {
  const VALUES = new Set(['neutral', 'happy', 'surprised', 'angry', 'sad', 'fearful', 'disgusted']);
  for (const key of KEYS) {
    const text = EMOTION_INSTRUCTIONS[key];
    const m = /^你说话的情感是([a-z]+)。$/.exec(text);
    assert.ok(m, `${key} 的指令不是「你说话的情感是X。」句式：${text}`);
    assert.ok(VALUES.has(m[1]), `${key} 用了不认识的情感值 ${m[1]}`);
  }
});

test('委屈是最慢最沉的，得意比开心更高更急', () => {
  const ordered = [...KEYS].sort((a, b) => EMOTION_PROSODY[a].rate - EMOTION_PROSODY[b].rate);
  assert.equal(ordered.at(0), 'sulk');
  // 平静必须是 1.0：它是「没有情绪」的基准，偏离了会让中性回复也变调
  assert.equal(EMOTION_PROSODY.calm.rate, 1);
  assert.equal(EMOTION_PROSODY.calm.pitch, 1);
  // 得意和开心都用 happy 这条指令，靠 rate/pitch 拉开：得意要更高更急
  assert.ok(EMOTION_PROSODY.proud.rate > EMOTION_PROSODY.happy.rate);
  assert.ok(EMOTION_PROSODY.proud.pitch > EMOTION_PROSODY.happy.pitch);
  // 担心应该是往下压的，不能反而更急
  assert.ok(EMOTION_PROSODY.worried.rate < EMOTION_PROSODY.calm.rate);
  assert.ok(EMOTION_PROSODY.worried.pitch < EMOTION_PROSODY.calm.pitch);
});

test('得意和开心共用同一条指令，所以必须靠 rate/pitch 区分开', () => {
  assert.equal(EMOTION_INSTRUCTIONS.proud, EMOTION_INSTRUCTIONS.happy);
  assert.notDeepEqual(EMOTION_PROSODY.proud, EMOTION_PROSODY.happy);
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
  const tts = cosyVoiceTts({ apiKey: 'sk-test', voice: 'longanhuan' });
  assert.equal(tts.sampleRate, COSYVOICE_SAMPLE_RATE);
  assert.equal(tts.sampleRate, 24_000);
  assert.match(tts.name, /^cosyvoice:/);
});

test('静音块判定：数字静音算静音，正常说话不算', () => {
  // 全零
  assert.equal(isSilentChunk(Buffer.alloc(8000)), true);
  // ±1 LSB 的底噪（CosyVoice 句尾就是这种，实测 -113…-93 dBFS）
  const dither = Buffer.alloc(8000);
  for (let i = 0; i < dither.length; i += 2) {
    dither.writeInt16LE(i % 4 === 0 ? 1 : -1, i);
  }
  assert.equal(isSilentChunk(dither), true);
  // 正常说话（满量程约 10%）
  const speech = Buffer.alloc(8000);
  for (let i = 0; i < speech.length; i += 2) {
    speech.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i);
  }
  assert.equal(isSilentChunk(speech), false);
  // 很轻的气声（约 -60 dBFS）也得留住，那是语音不是静音
  const breath = Buffer.alloc(8000);
  for (let i = 0; i < breath.length; i += 2) {
    breath.writeInt16LE(Math.round(33 * Math.sin(i / 20)), i);
  }
  assert.equal(isSilentChunk(breath), false);
});
