/**
 * 流式文本的**门槛**与**分段**：这两件事错了会让短答变慢、长答重复。
 *
 * 真机上的取舍写在这里，改之前先读一遍：
 * - 20 token 之内不流式：语音回复的中位长度就是十几二十个 token，给它们分段的
 *   唯一效果是多几次 TTS 调用、多几处接缝，首字一点没提前。
 * - 超过之后**一次性释放前 20 个**，不是从第 21 个才开始：那 20 个已经在缓冲里，
 *   不释放的话出声时间反而比整段还晚。
 * - 没到阈值就结束 → 走 `start` + `end`，调用方按"整段"处理，和没有流式一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LiveGate } from '../src/live-text.ts';

function feed(gate: LiveGate, tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    for (const ev of gate.push(t)) {
      out.push(`${ev.type}:${ev.type === 'end' ? '' : ev.text}`);
    }
  }
  return out;
}

test('不到 20 个 token 一个都不放', () => {
  const gate = new LiveGate(20);
  const tokens = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.deepEqual(feed(gate, tokens), [], '前 20 个只进缓冲');
  assert.equal(gate.streaming, false);
  assert.equal(gate.tokensSeen, 20);
});

test('第 21 个 token 到达时释放前 20 个，它自己走直通', () => {
  const gate = new LiveGate(20);
  const tokens = Array.from({ length: 21 }, (_, i) => `t${i}`);
  const out = feed(gate, tokens);
  assert.equal(out.length, 2, '一次 start + 一个直通的 delta');
  const released = out[0] ?? '';
  assert.ok(released.startsWith('start:'), `应当是 start，实际 ${released.slice(0, 12)}`);
  assert.equal(
    released.slice('start:'.length),
    tokens.slice(0, 20).join(''),
    '释放的必须是完整的前 20 个 token',
  );
  assert.equal(out[1], 'delta:t20', '第 21 个自己直通，不能丢也不能并进前缀');
  assert.equal(gate.streaming, true);
});

test('释放之后逐 token 直通', () => {
  const gate = new LiveGate(20);
  feed(gate, Array.from({ length: 21 }, (_, i) => `t${i}`));
  assert.deepEqual(feed(gate, ['你', '好']), ['delta:你', 'delta:好']);
});

test('没到阈值就结束：整段一次交出，不算流式', () => {
  const gate = new LiveGate(20);
  feed(gate, ['你', '好', '。']);
  const out = gate.finish();
  assert.deepEqual(out.map((e) => e.type), ['start', 'end']);
  assert.equal(out[0]?.type === 'start' ? out[0].text : '', '你好。');
  const end = out[1];
  assert.equal(end?.type === 'end' ? end.streaming : null, false, '这条仍然是"非流式"');
  assert.equal(end?.type === 'end' ? end.tokens : null, 3);
  assert.equal(gate.streaming, false, '调用方不该走分段播报');
});

test('已经流式之后再结束：只补一个 end，并标明走过流式', () => {
  const gate = new LiveGate(20);
  feed(gate, Array.from({ length: 25 }, (_, i) => `t${i}`));
  const out = gate.finish();
  assert.deepEqual(out.map((e) => e.type), ['end']);
  const end = out[0];
  assert.equal(end?.type === 'end' ? end.streaming : null, true);
  assert.equal(end?.type === 'end' ? end.tokens : null, 25);
});

test('空 token 与重复 end 都不产生事件', () => {
  const gate = new LiveGate(20);
  assert.deepEqual(gate.push(''), []);
  gate.finish();
  assert.deepEqual(gate.finish(), [], 'end 只算一次');
  assert.deepEqual(gate.push('迟到的 token'), [], 'end 之后的 token 不该再放出去');
});
