/**
 * 宠物编排的**可读轨迹**。
 *
 * 现网事故形状：`proactive` 没配 → `AppSession` 不构造 → 整层不存在，
 * 而日志里既不报错也不留痕，于是「它一直不说话」分不清是
 * 「判断了但决定不说」还是「这层压根没装」。
 *
 * 这两个 describe 函数就是为此存在的：每种输入/意图都要有一行说得清的话。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describePetInput, describePetIntent } from '../src/pet/brain/session.ts';
import type { PetInput, PetIntent } from '../src/pet/brain/types.ts';

const stamp = { now: 1_000, localHour: 15 };

const inputs: PetInput[] = [
  { kind: 'tick', ...stamp },
  { kind: 'userPartial', ...stamp },
  { kind: 'userFinal', text: '今天天气怎么样', ...stamp },
  { kind: 'presence', wearing: true, ...stamp },
  { kind: 'presence', wearing: false, ...stamp },
  { kind: 'presence', wearing: null, ...stamp },
  { kind: 'power', percent: 37, ...stamp },
  { kind: 'power', percent: null, ...stamp },
  { kind: 'summon', opensSession: true, ...stamp },
  { kind: 'summon', opensSession: false, ...stamp },
  { kind: 'floor', busy: true, owner: 'reply', ...stamp },
  { kind: 'floor', busy: false, owner: null, ...stamp },
  { kind: 'announce', pending: true, spoken: false, ...stamp },
  { kind: 'announce', pending: false, spoken: true, ...stamp },
  { kind: 'image', id: 'c1', image: null, ...stamp },
  { kind: 'image', id: 'c1', image: { mimeType: 'image/jpeg', data: 'A'.repeat(400) }, ...stamp },
  { kind: 'phaseResult', engagementId: 'e1', step: 2, phase: 'compose', result: 'ok', ...stamp },
  { kind: 'micOpened', ...stamp },
  { kind: 'closed', ...stamp },
];

test('每条输入都有一行可读描述，且不带 undefined/null', () => {
  for (const input of inputs) {
    const line = describePetInput(input);
    assert.ok(line.length > 0, `${input.kind} 描述为空`);
    assert.doesNotMatch(line, /undefined|null/, `${input.kind} 描述里漏了字段：${line}`);
  }
});

test('关键输入要把判断所需的事实写出来（否则看日志也判不出该不该开口）', () => {
  assert.match(describePetInput({ kind: 'presence', wearing: null, ...stamp }), /未知/);
  assert.match(describePetInput({ kind: 'power', percent: 37, ...stamp }), /37%/);
  assert.match(describePetInput({ kind: 'floor', busy: true, owner: 'pet', ...stamp }), /被占\(pet\)/);
  assert.match(describePetInput({ kind: 'image', id: 'c1', image: null, ...stamp }), /没拍到/);
  // 长文本要截断，一行日志不能被一句话刷满
  const long = describePetInput({ kind: 'userFinal', text: '一'.repeat(200), ...stamp });
  assert.ok(long.length < 40, `没截断：${long.length} 字`);
});

test('每种意图都有一行可读描述', () => {
  const intents: PetIntent[] = [
    {
      kind: 'phase.enter',
      engagementId: 'e1',
      phase: 'look',
      step: 1,
      plan: ['look', 'compose', 'speak'],
      context: { reason: 'greet', elapsedMs: 1_000, hasImage: true },
      deadlineMs: 4_000,
      captureId: 'c1',
      text: null,
      emotion: null,
      image: null,
      listenMs: null,
      holdsFloor: false,
    },
    {
      kind: 'end',
      record: {
        id: 'e1',
        reason: 'greet',
        outcome: 'engaged',
        phase: 'speak',
        durations: {},
        startedAt: 0,
        endedAt: 1_000,
      },
      dismiss: false,
      closeMic: true,
    },
    { kind: 'reflex', cue: 'here' },
    { kind: 'announce.dismiss' },
  ];

  for (const intent of intents) {
    const line = describePetIntent(intent);
    assert.ok(line.length > 0, `${intent.kind} 描述为空`);
    assert.doesNotMatch(line, /undefined/, `${intent.kind} 描述里漏了字段：${line}`);
  }
});

test('阶段与截止时长要写出来 —— 这是判断「它卡住了」还是「它在等」的依据', () => {
  const line = describePetIntent({
    kind: 'phase.enter',
    engagementId: 'e1',
    phase: 'look',
    step: 1,
    plan: ['look', 'listen'],
    context: { reason: 'chatter', elapsedMs: 1_000, hasImage: false },
    deadlineMs: 4_000,
    captureId: null,
    text: null,
    emotion: null,
    image: null,
    listenMs: null,
    holdsFloor: false,
  });
  assert.match(line, /look/);
  assert.match(line, /4000 ms/);
  assert.match(line, /不占话筒/);
});
