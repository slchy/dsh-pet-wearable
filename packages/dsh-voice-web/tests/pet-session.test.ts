/**
 * 宿主状态投影：sessionId/id、displayTitle/title、voiceReady 只有 false 才算未就绪。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectHostState, readSession } from '../src/browser/pet-session.ts';

test('sessionId 优先于 id，空 sessionId 不再去看 id', () => {
  assert.deepEqual(readSession({
    sessionId: 'a',
    id: 'b',
    displayTitle: '显示',
    title: '标题',
  }), { id: 'a', title: '显示' });
  assert.deepEqual(readSession({ id: 'b', title: '标题' }), { id: 'b', title: '标题' });
  assert.deepEqual(readSession({ sessionId: 'a' }), { id: 'a', title: 'a' });
  assert.deepEqual(readSession({
    sessionId: 'a',
    displayTitle: '',
    title: '标题',
  }), { id: 'a', title: '标题' });
  assert.deepEqual(readSession({ id: 'b', title: '' }), { id: 'b', title: 'b' });
  assert.equal(readSession({ sessionId: '', id: 'b' }), null);
  assert.equal(readSession({}), null);
  assert.equal(readSession(null), null);
  assert.equal(readSession([]), null);
});

test('voiceReady === false 才报未就绪，字段缺失不当成失败', () => {
  const ready = projectHostState({
    pipelineMode: 'live',
    boundSessionId: 's1',
    voiceReady: true,
    sessions: [
      { sessionId: 's1', displayTitle: '一' },
      { nope: true },
      { id: 's2', title: '二' },
    ],
  });
  assert.equal(ready.known, true);
  assert.equal(ready.statusText, '');
  assert.equal(ready.pipelineLabel, '管线：live');
  assert.equal(ready.boundSessionId, 's1');
  assert.equal(ready.boundLabel, '当前会话：s1');
  assert.deepEqual(ready.sessions, [
    { id: 's1', title: '一' },
    { id: 's2', title: '二' },
  ]);

  assert.equal(projectHostState({}).statusText, '');
  assert.equal(projectHostState({ voiceReady: true }).statusText, '');
  assert.equal(projectHostState({ voiceReady: 0 }).statusText, '');
  assert.equal(projectHostState({ voiceReady: 'false' }).statusText, '');
  assert.equal(projectHostState({ pipelineMode: '' }).pipelineLabel, '管线：未知');
  assert.equal(projectHostState({}).pipelineLabel, '管线：未知');
  assert.equal(projectHostState({ boundSessionId: '' }).boundSessionId, null);
  assert.equal(projectHostState({ boundSessionId: '' }).boundLabel, '当前会话：未绑定');

  assert.equal(
    projectHostState({ voiceReady: false }).statusText,
    '语音未就绪：请检查 ~/.dsh/.env 中的 STT/TTS 凭据',
  );
  assert.equal(
    projectHostState({ voiceReady: false, voiceError: 'boom' }).statusText,
    '语音未就绪：boom',
  );
  assert.equal(
    projectHostState({ voiceReady: false, voiceError: '' }).statusText,
    '语音未就绪：请检查 ~/.dsh/.env 中的 STT/TTS 凭据',
  );

  const missing = projectHostState(null);
  assert.equal(missing.known, false);
  assert.equal(missing.statusText, '读不到会话状态');
  assert.deepEqual(missing.sessions, []);
});
