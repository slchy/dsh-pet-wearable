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

import { connect } from 'node:net';

import { LiveGate, LiveTextRelay, type LiveMessage } from '../src/live-text.ts';

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

test('一整句就说完：立刻释放，不等门槛', () => {
  const gate = new LiveGate(20);
  // 真机「好，我搜一下。」= 9 个 token，之后模型就去调工具了
  const out = feed(gate, ['好', '，', '我', '搜', '一', '下', '。']);
  assert.deepEqual(out, ['start:好，我搜一下。'], '句子完整就该出声，不该扣到 20 个 token');
  assert.equal(gate.streaming, true);
});

test('句末标点之后继续出字：接续走直通', () => {
  const gate = new LiveGate(20);
  const out = feed(gate, ['好', '的', '。', '那', '我', '去']);
  assert.deepEqual(out, ['start:好的。', 'delta:那', 'delta:我', 'delta:去']);
});

test('没到阈值就结束：整段一次交出，不算流式', () => {
  const gate = new LiveGate(20);
  // 故意不带句末标点 —— 带了就会走「整句立刻释放」那条
  feed(gate, ['你', '好']);
  const out = gate.finish();
  assert.deepEqual(out.map((e) => e.type), ['start', 'end']);
  assert.equal(out[0]?.type === 'start' ? out[0].text : '', '你好');
  const end = out[1];
  assert.equal(end?.type === 'end' ? end.streaming : null, false, '这条仍然是"非流式"');
  assert.equal(end?.type === 'end' ? end.tokens : null, 2);
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

test('ready() 等到系统分配的真实端口，重复调用还是同一个', async () => {
  const relay = new LiveTextRelay();
  try {
    const syncPort = relay.start();
    const port = await relay.ready();
    assert.ok(port > 0 && port <= 65535, `端口应当已经绑定，实际 ${port}`);
    if (syncPort > 0) {
      assert.equal(syncPort, port, '同步已经读到端口时，ready 不能另绑一个');
    }
    assert.equal(await relay.ready(), port);
    assert.equal(relay.port, port);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });
  } finally {
    relay.close();
  }
});

test('坏 JSON 行记解析失败，下一行仍交给 handler', async () => {
  const logs: string[] = [];
  const relay = new LiveTextRelay((line) => { logs.push(line); });
  const seen = new Promise<LiveMessage>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('合法行没有送到 handler')); }, 2000);
    relay.onMessage((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
  try {
    const port = await relay.ready();
    assert.ok(port > 0);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write('not-json\n{"t":"delta","s":"s1","text":"hi"}\n');
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });
    const msg = await seen;
    assert.equal(msg.t, 'delta');
    assert.equal(msg.text, 'hi');
    assert.ok(
      logs.some((line) => line.includes('解析失败') && line.includes('not-json')),
      `应当记下坏行，实际日志：${logs.join(' | ')}`,
    );
  } finally {
    relay.close();
  }
});
