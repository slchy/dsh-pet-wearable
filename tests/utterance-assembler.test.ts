/**
 * 判停组装层：**一句话被 ASR 切成两句**时不要拿后半截当一轮。
 *
 * 真机（2026-11-15）：用户问「…你是怎么答的？」，ASR 断成
 * 「…你你是怎么点？」+「大的。」。SmartTurn 对「大的。」给了 0.985 ——
 * 它只看这两秒音频，「大的。」确实像个完整回答，判得不冤。
 * 于是碎片单独成轮，agent 对着两个字瞎猜，用户只好把整段话重说一遍。
 *
 * 修法是机械的：短碎片 + 紧跟上一轮 = 再等一拍看有没有后续。
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { UtteranceAssembler, type UtteranceAssemblerOptions } from '../src/utterance-assembler.ts';

interface Harness {
  assembler: UtteranceAssembler;
  utterances: Array<{ text: string; at: number }>;
}

function makeAssembler(overrides: Partial<UtteranceAssemblerOptions> = {}): Harness {
  const utterances: Array<{ text: string; at: number }> = [];
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 30,
    maxExtensions: 2,
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000,
    // 判停器一律说「说完了」—— 这里要验的是「短碎片即使被判完也要再等一拍」
    predict: async () => 0.99,
    onUtterance: (text) => { utterances.push({ text, at: Date.now() }); },
    log: () => {},
    ...overrides,
  });
  return { assembler, utterances };
}

test('紧跟上一轮的极短碎片会再等一拍，不在当口就成轮', async () => {
  const { assembler, utterances } = makeAssembler();

  assembler.addSentence('你刚刚是怎么答的');
  await delay(50);
  assert.equal(utterances.length, 1, '第一句正常收下');
  const firstAt = utterances[0]?.at ?? 0;

  assembler.addSentence('大的。');
  await delay(10);
  assert.equal(utterances.length, 1, '碎片该在等，而不是立刻成轮');

  await delay(80);
  assert.equal(utterances.length, 2, '等过一拍后还是要收下，不能吞掉');
  const secondAt = utterances[1]?.at ?? 0;
  assert.ok(
    secondAt - firstAt >= 40,
    `碎片应当被推迟（实际只隔 ${secondAt - firstAt} ms）`,
  );
  assert.equal(utterances[1]?.text, '大的。');
});

test('距上一轮已经过去的极短句照常立刻收下', async () => {
  // window 设 0：任何碎片都不算「紧跟」，用于模拟用户真的过了一会才说「好。」
  const { assembler, utterances } = makeAssembler({ shortFragmentWindowMs: 0 });

  assembler.addSentence('你刚刚是怎么答的');
  await delay(50);
  assembler.addSentence('好。');
  await delay(15);

  assert.equal(utterances.length, 2, '独立的一句短回答不该被拖');
});

test('正常长度的句子不受影响', async () => {
  const { assembler, utterances } = makeAssembler();

  assembler.addSentence('你刚刚是怎么答的');
  await delay(50);
  assembler.addSentence('我想知道具体用了哪个工具');
  await delay(15);

  assert.equal(utterances.length, 2, '长句本来就完整，不该多等');
});

test('只多等一次，不会一直拖', async () => {
  const { assembler, utterances } = makeAssembler({ maxExtensions: 1 });

  assembler.addSentence('第一句');
  await delay(50);
  const before = utterances.length;

  assembler.addSentence('嗯。');
  // 延一次 30 ms，之后必须收下；再等 200 ms 也不该出现第三次
  await delay(200);
  assert.equal(utterances.length, before + 1, '最多多等一次，之后必须收');
});
