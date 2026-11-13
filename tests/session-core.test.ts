/**
 * `SessionCore` 的单测：只喂事件，断言「产出什么动作」。
 *
 * 这些判断以前散在 socket 回调里，只能靠真机听感验证；现在纯到可以直接断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionCore } from '../src/session-core.ts';

function newCore(): { core: SessionCore; lines: string[] } {
  const lines: string[] = [];
  const core = new SessionCore({
    imageQuestion: '这张图里有什么？',
    log: (line) => { lines.push(line); },
  });
  return { core, lines };
}

/** 把会话推到 speaking：开一轮 + 首块音频。 */
function toSpeaking(core: SessionCore): void {
  const ticket = core.fsm.beginTurn();
  assert.ok(ticket);
  core.fsm.audioStarted(ticket);
  assert.equal(core.phase, 'speaking');
}

test('唤醒词：不过成句合并', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '小爱同学。' }), [
    { type: 'drop', why: 'wake-word' },
  ]);
});

test('正常一句话：交给合并器', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '今天天气怎么样' }), [
    { type: 'assemble', text: '今天天气怎么样' },
  ]);
});

test('旁听反馈：不成轮', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'utterance', text: '嗯嗯，我知道了我知道了。' }), [
    { type: 'drop', why: 'backchannel' },
  ]);
  assert.equal(core.turn, 0);
});

test('定稿一句话：开一轮并带上票据', () => {
  const { core } = newCore();
  const effects = core.dispatch({ type: 'utterance', text: '帮我看看这个' });
  assert.equal(effects.length, 1);
  assert.equal(effects[0]?.type, 'turn');
  assert.equal(effects[0]?.type === 'turn' && effects[0].text, '帮我看看这个');
});

test('插话只在 speaking 成立', () => {
  const { core } = newCore();
  // listening：不算插话
  assert.deepEqual(core.dispatch({ type: 'partial', text: '等一下' }), []);

  toSpeaking(core);
  assert.deepEqual(core.dispatch({ type: 'partial', text: '等一下' }), [{ type: 'stop' }]);
  assert.equal(core.phase, 'listening');
});

test('太短的中间结果不触发插话', () => {
  const { core } = newCore();
  toSpeaking(core);
  assert.deepEqual(core.dispatch({ type: 'partial', text: '嗯' }), []);
  assert.equal(core.phase, 'speaking');
});

test('没人等的图：起一轮识图', () => {
  const { core } = newCore();
  const effects = core.dispatch({ type: 'image', jpeg: Buffer.from([1, 2, 3]) });
  assert.equal(effects.length, 1);
  const effect = effects[0];
  assert.ok(effect && effect.type === 'turn');
  assert.equal(effect.text, '这张图里有什么？');
  assert.equal(effect.image?.mimeType, 'image/jpeg');
  assert.equal(effect.image?.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('模型要求结束：告别语播完才挂断', () => {
  const { core } = newCore();
  toSpeaking(core);
  assert.deepEqual(core.dispatch({ type: 'endRequested' }), []); // 还在播，先等
  const ticket = core.fsm.ticket();
  core.fsm.audioDone(ticket);
  assert.equal(core.phase, 'ending');
  assert.deepEqual(core.dispatch({ type: 'turnFinished' }), [{ type: 'end' }]);
});

test('空闲时要求结束：立刻挂断', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'endRequested' }), [{ type: 'end' }]);
  assert.equal(core.phase, 'ending');
});

test('连接结束是吸收态', () => {
  const { core } = newCore();
  core.dispatch({ type: 'closed' });
  assert.equal(core.phase, 'closed');
  core.dispatch({ type: 'endRequested' });
  assert.equal(core.phase, 'closed');
});
