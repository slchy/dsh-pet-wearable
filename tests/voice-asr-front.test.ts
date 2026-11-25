/**
 * ASR 前端：时钟接错只报一次，开轮前的片段不进装配器，封段序号只增。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CoreEffect } from '../src/session-core.ts';
import { AsrFront, type AsrFrontPorts } from '../src/voice/asr-front.ts';

function ports(over: Partial<AsrFrontPorts> = {}): AsrFrontPorts {
  return {
    now: () => 20_000,
    lastVoicedAtMs: () => 1.7e12,
    isSpeaking: () => false,
    generation: () => 1,
    dispatch: () => [],
    notePartial: () => {},
    userPartial: () => {},
    emitAsr: () => {},
    archive: () => {},
    decodeSettled: () => {},
    ...over,
  };
}

test('时钟量级不一致只打一次日志', () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(' '));
  };
  try {
    let speaking = false;
    const asr = new AsrFront(ports({
      isSpeaking: () => speaking,
    }));
    asr.onSentence('你好', 0);
    speaking = true;
    asr.onPartial('Thank');
    asr.onPartial('Okay');
    const mismatches = errors.filter((line) => line.includes('两把时钟不同源'));
    assert.equal(mismatches.length, 1);
  } finally {
    console.error = orig;
  }
});

test('pre-turn drop 不调用 notePartial', () => {
  let noted = 0;
  let users = 0;
  let emitted = 0;
  const effects: readonly CoreEffect[] = [{ type: 'drop', why: 'pre-turn' }];
  const asr = new AsrFront(ports({
    now: () => 10,
    lastVoicedAtMs: () => 10,
    dispatch: () => effects,
    notePartial: () => { noted += 1; },
    userPartial: () => { users += 1; },
    emitAsr: () => { emitted += 1; },
  }));
  asr.onPartial('置身吗', 4);
  assert.equal(noted, 0);
  assert.equal(users, 0);
  assert.equal(emitted, 0);
});

test('sealSeq 单调递增', () => {
  const asr = new AsrFront(ports({
    now: () => 0,
    lastVoicedAtMs: () => 0,
  }));
  assert.equal(asr.sealSeq, 0);
  assert.equal(asr.nextSealSeq(), 1);
  assert.equal(asr.nextSealSeq(), 2);
  asr.noteFrame(150);
  assert.equal(asr.lastFrameSilenceMs, 150);
  assert.equal(asr.sealSeq, 2, '记一帧静音不能改封段序号');
  assert.equal(asr.nextSealSeq(), 3);
});
