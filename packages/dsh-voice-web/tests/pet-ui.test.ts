/**
 * 界面状态机：字幕拼接、转写替换、委派徽章、气泡超时、关闭码。不碰 DOM。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOSE_NOTE_FALLBACK,
  CLOSE_NOTE_MS,
  bubbleView,
  dismissIdleBubble,
  initialPetUiState,
  markBubbleHover,
  reduceClientEvent,
  reducePetUi,
  type PetEffect,
} from '../src/browser/pet-ui.ts';

function effectTypes(effects: readonly PetEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

test('收口后的 delta 另起一段，未收口则拼接', () => {
  let step = reducePetUi(initialPetUiState(), {
    type: 'reply.delta',
    delta: '你',
    path: 'fast',
  }, 1_000);
  assert.equal(step.state.replyText, '你');
  assert.equal(step.state.replySealed, false);
  assert.equal(step.state.replyPath, 'fast');
  assert.equal(step.state.captionsOn, true);
  assert.deepEqual(effectTypes(step.effects), ['poke-captions']);

  step = reducePetUi(step.state, { type: 'reply.delta', delta: '好', path: 'fast' }, 1_100);
  assert.equal(step.state.replyText, '你好');

  step = reducePetUi(step.state, { type: 'reply.delta', delta: '呀' }, 1_200);
  assert.equal(step.state.replyText, '你好呀');
  assert.equal(step.state.replyPath, undefined);

  step = reducePetUi(step.state, {
    type: 'reply.final',
    text: '你好呀',
    emotion: 'happy',
    path: 'omni',
  }, 2_000);
  assert.equal(step.state.replyText, '你好呀');
  assert.equal(step.state.replySealed, true);
  assert.equal(step.state.replyPath, 'omni');
  assert.equal(step.state.activeEmotion, 'happy');
  assert.equal(step.state.emotionUntil, 2_000 + 4_500);
  assert.equal(step.state.previewName, null);
  assert.deepEqual(effectTypes(step.effects), ['render-expression', 'poke-captions']);

  step = reducePetUi(step.state, { type: 'reply.delta', delta: '新', path: 'dsh' }, 3_000);
  assert.equal(step.state.replyText, '新');
  assert.equal(step.state.replyPath, 'dsh');
  assert.equal(bubbleView(step.state).laneText, 'L2');
  assert.equal(bubbleView({ ...step.state, replyPath: 'fast' }).laneText, 'L1');

  const announced = reducePetUi(step.state, {
    type: 'announce',
    text: '播报',
    emotion: 'proud',
  }, 4_000);
  assert.equal(announced.state.replyText, '播报');
  assert.equal(announced.state.replyPath, undefined);
  assert.equal(announced.state.replySealed, true);
  assert.equal(announced.state.activeEmotion, 'proud');
  assert.equal(bubbleView(announced.state).laneHidden, true);
});

test('asr.replace 对得上才替换，asr 清掉委派徽章', () => {
  const delegated = {
    ...initialPetUiState(),
    delegated: true,
    captionsOn: true,
    asrText: ' 你好 ',
  };
  assert.equal(bubbleView(delegated).badgeHidden, false);

  const matched = reducePetUi(delegated, {
    type: 'asr.replace',
    text: ' 你好呀 ',
    previous: '你好',
  }, 0);
  assert.equal(matched.state.asrText, '你好呀');
  assert.equal(matched.state.delegated, true);
  assert.equal(matched.state.captionsOn, true);
  assert.equal(bubbleView(matched.state).badgeHidden, false);

  const open = reducePetUi(delegated, {
    type: 'asr.replace',
    text: '直接换',
  }, 0);
  assert.equal(open.state.asrText, '直接换');
  assert.equal(open.state.delegated, true);

  const missed = reducePetUi(delegated, {
    type: 'asr.replace',
    text: '别的',
    previous: '不匹配',
  }, 0);
  assert.equal(missed.state, delegated);

  const blank = reducePetUi(delegated, {
    type: 'asr.replace',
    text: '   ',
    previous: '你好',
  }, 0);
  assert.equal(blank.state, delegated);

  const asr = reducePetUi(delegated, { type: 'asr', text: '喂', final: false }, 0);
  assert.equal(asr.state.delegated, false);
  assert.equal(asr.state.asrText, '喂');
  assert.equal(asr.state.captionsOn, true);
  assert.equal(bubbleView(asr.state).badgeHidden, true);
  assert.equal(bubbleView(asr.state).asrHidden, false);
});

test('气泡超时关掉字幕和委派；悬停不续期，离开再重约', () => {
  const showing = {
    ...initialPetUiState(),
    captionsOn: true,
    delegated: true,
    bubbleHover: false,
  };
  const expired = dismissIdleBubble(showing);
  assert.equal(expired.captionsOn, false);
  assert.equal(expired.delegated, false);

  const hovering = { ...showing, bubbleHover: true };
  assert.equal(dismissIdleBubble(hovering), hovering);
  assert.equal(dismissIdleBubble(hovering).captionsOn, true);
  assert.equal(dismissIdleBubble(hovering).delegated, true);

  const entered = markBubbleHover(showing, true);
  assert.equal(entered.state.bubbleHover, true);
  assert.equal(entered.state.captionsOn, true);
  assert.deepEqual(entered.effects, []);

  const left = markBubbleHover(hovering, false);
  assert.equal(left.state.bubbleHover, false);
  assert.equal(left.state.captionsOn, true);
  assert.equal(left.state.delegated, true);
  assert.deepEqual(left.effects, [{ type: 'poke-captions', render: false }]);
});

test('1000 关闭不闪注，4503 挂担心表情 4500ms', () => {
  const happy = reducePetUi(initialPetUiState(), {
    type: 'reply.final',
    text: '好',
    emotion: 'happy',
    path: 'fast',
  }, 1_000);
  const normal = reduceClientEvent(
    { ...happy.state, speaking: true, previewName: 'angry', previewUntil: 99_000 },
    { type: 'close', code: 1000, reason: 'bye' },
    5_000,
  );
  assert.equal(normal.state.noteText, '');
  assert.equal(normal.state.link, 'off');
  assert.equal(normal.state.phase, 'idle');
  assert.equal(normal.state.speaking, false);
  assert.equal(normal.state.activeEmotion, 'happy');
  assert.equal(normal.state.previewName, 'angry');
  assert.equal(normal.effects.some((effect) => effect.type === 'flash-note'), false);
  assert.equal(normal.effects.some((effect) => effect.type === 'stop-speaking'), true);

  const quiet = reduceClientEvent(initialPetUiState(), {
    type: 'close',
    code: 1006,
    reason: '',
  }, 5_000);
  assert.equal(quiet.effects.some((effect) => effect.type === 'flash-note'), false);
  assert.equal(quiet.effects.some((effect) => effect.type === 'stop-speaking'), false);

  const voiced = reduceClientEvent(initialPetUiState(), {
    type: 'close',
    code: 1006,
    reason: '重置了',
  }, 8_000);
  assert.equal(voiced.state.activeEmotion, 'worried');
  assert.equal(voiced.state.emotionUntil, 8_000 + CLOSE_NOTE_MS);
  assert.equal(voiced.state.noteText, '重置了');

  const now = 10_000;
  const failed = reduceClientEvent({
    ...initialPetUiState(),
    speaking: true,
    previewName: 'angry',
    previewUntil: 99_000,
  }, { type: 'close', code: 4503, reason: '' }, now);
  assert.equal(CLOSE_NOTE_MS, 4500);
  assert.equal(failed.state.activeEmotion, 'worried');
  assert.equal(failed.state.emotionUntil, now + 4500);
  assert.equal(failed.state.previewName, null);
  assert.equal(failed.state.noteText, CLOSE_NOTE_FALLBACK);
  assert.equal(failed.state.noteText, '语音后端未就绪，请检查 ~/.dsh/.env 凭据');
  assert.equal(failed.state.link, 'off');
  assert.equal(failed.state.phase, 'idle');
  assert.equal(failed.state.speaking, false);
  const note = failed.effects.find((effect) => effect.type === 'flash-note');
  assert.ok(note !== undefined && note.type === 'flash-note');
  if (note !== undefined && note.type === 'flash-note') {
    assert.equal(note.durationMs, 4500);
    assert.equal(note.text, CLOSE_NOTE_FALLBACK);
  }
  assert.equal(failed.effects.some((effect) => effect.type === 'render-expression' && effect.schedule), true);

  const named = reduceClientEvent(initialPetUiState(), {
    type: 'close',
    code: 4503,
    reason: '断了',
  }, now);
  assert.equal(named.state.noteText, '断了');
  assert.equal(named.state.activeEmotion, 'worried');
});
