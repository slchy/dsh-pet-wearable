/**
 * 立绘名与宿主白名单锁死，优先级和过期也不靠 DOM。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PET_SPRITE_NAMES } from '../src/host-mount.ts';
import {
  EMOTION_HOLD_MS,
  SPRITE_LABELS,
  SPRITE_NAMES,
  armEmotion,
  armPreview,
  initialSpriteState,
  nextSpriteDelay,
  selectSprite,
  type SpriteState,
} from '../src/browser/pet-sprites.ts';

test('浏览器立绘名与宿主 PET_SPRITE_NAMES 全等', () => {
  assert.deepEqual(SPRITE_NAMES, PET_SPRITE_NAMES);
  assert.equal(EMOTION_HOLD_MS, 4500);
  assert.deepEqual(SPRITE_LABELS, {
    calm: '平静',
    speaking: '说话',
    listening: '倾听',
    happy: '开心',
    proud: '得意',
    surprised: '惊讶',
    worried: '担心',
    sulk: '委屈',
    angry: '生气',
    disgust: '厌恶',
  });
});

test('说话 > 倾听 > 预览 > 保持情绪 > 平静，thinking 不占图', () => {
  const base: SpriteState = {
    speaking: false,
    phase: 'thinking',
    previewName: 'angry',
    previewUntil: 5_000,
    activeEmotion: 'happy',
    emotionUntil: 9_000,
  };
  assert.equal(selectSprite({ ...base, speaking: true, phase: 'listening' }, 0).name, 'speaking');
  assert.equal(selectSprite({ ...base, phase: 'listening' }, 0).name, 'listening');
  assert.equal(selectSprite(base, 1_000).name, 'angry');
  assert.equal(selectSprite({ ...base, previewName: null }, 1_000).name, 'happy');
  assert.equal(selectSprite(initialSpriteState(), 0).name, 'calm');

  const phaseSpeaking = selectSprite({
    ...initialSpriteState(),
    phase: 'speaking',
    activeEmotion: 'happy',
    emotionUntil: 5_000,
  }, 0);
  assert.equal(phaseSpeaking.name, 'happy');
});

test('预览过期才清，倾听和说话都不清', () => {
  const state: SpriteState = {
    speaking: false,
    phase: 'listening',
    previewName: 'happy',
    previewUntil: 1_000,
    activeEmotion: 'worried',
    emotionUntil: 9_000,
  };
  const listening = selectSprite(state, 5_000);
  assert.equal(listening.name, 'listening');
  assert.equal(listening.state.previewName, 'happy');

  const speaking = selectSprite({ ...state, speaking: true }, 5_000);
  assert.equal(speaking.name, 'speaking');
  assert.equal(speaking.state.previewName, 'happy');

  const expired = selectSprite({ ...state, phase: 'thinking' }, 1_000);
  assert.equal(expired.name, 'worried');
  assert.equal(expired.state.previewName, null);

  const calm = selectSprite(expired.state, 9_000);
  assert.equal(calm.name, 'calm');
  assert.equal(calm.state.previewName, null);
});

test('armEmotion 清预览名，未知情绪回平静；预览说话不改保持情绪', () => {
  const preview = armPreview(initialSpriteState(), 'happy', 100);
  assert.equal(preview.previewName, 'happy');
  assert.equal(preview.previewUntil, 100 + EMOTION_HOLD_MS);
  assert.equal(preview.activeEmotion, 'happy');
  assert.equal(preview.emotionUntil, preview.previewUntil);

  const armed = armEmotion(preview, 'thinking', 200);
  assert.equal(armed.previewName, null);
  assert.equal(armed.previewUntil, preview.previewUntil);
  assert.equal(armed.activeEmotion, 'calm');
  assert.equal(armed.emotionUntil, 0);

  const held = armEmotion(preview, 'sulk', 200);
  assert.equal(held.activeEmotion, 'sulk');
  assert.equal(held.emotionUntil, 200 + EMOTION_HOLD_MS);
  assert.equal(held.previewName, null);

  const mouth = armPreview(held, 'speaking', 300);
  assert.equal(mouth.previewName, 'speaking');
  assert.equal(mouth.previewUntil, 300 + EMOTION_HOLD_MS);
  assert.equal(mouth.activeEmotion, 'sulk');
  assert.equal(mouth.emotionUntil, held.emotionUntil);

  const ear = armPreview(held, 'listening', 300);
  assert.equal(ear.activeEmotion, 'sulk');
  assert.equal(ear.emotionUntil, held.emotionUntil);

  const calm = armPreview(held, 'calm', 300);
  assert.equal(calm.previewName, 'calm');
  assert.equal(calm.activeEmotion, 'calm');
  assert.equal(calm.emotionUntil, 0);
});

test('下一次换图等到最近的未来时刻再加 16ms', () => {
  const now = 1_000;
  const state: SpriteState = {
    ...initialSpriteState(),
    previewUntil: now + 400,
    emotionUntil: now + 100,
  };
  assert.equal(nextSpriteDelay(state, now), 116);
  assert.equal(nextSpriteDelay({ ...state, emotionUntil: now }, now), 416);
  assert.equal(nextSpriteDelay({
    ...state,
    previewUntil: now,
    emotionUntil: now - 1,
  }, now), null);
  assert.equal(nextSpriteDelay(initialSpriteState(), now), null);
});
