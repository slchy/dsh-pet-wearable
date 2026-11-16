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

test('音频说完了，但刚收到中间结果 → 不收敛', async () => {
  // 这条是「判停不能只看音频」的核心：中间结果在出 = 用户还在说。
  const { assembler, utterances } = makeAssembler({ partialGraceMs: 20, extendMs: 40 });

  assembler.addSentence('我想问一下那个');
  assembler.notePartial('我想问一下那');

  await delay(15);
  assert.equal(utterances.length, 0, '用户还在出字，这时候收下就是抢话');

  await delay(120);
  assert.equal(utterances.length, 1, '等过 grace 之后还是要收，不能吞掉');
});

test('中间结果是过去的，不影响收敛', async () => {
  const { assembler, utterances } = makeAssembler({ partialGraceMs: 20, extendMs: 40 });

  assembler.notePartial('很久以前的一段');
  await delay(40);
  assembler.addSentence('这句话已经说完了');

  await delay(15);
  assert.equal(utterances.length, 1, 'partial 早就停了，没有理由再等');
});

// ---------------------------------------------------------------- 判停与静候窗重叠
//
// 判停器一趟往返实测约 70 ms，全部压在「用户说完 → 开一轮」里。提前发起请求
// 让它藏进静默窗，但**结果的有效性**要跟着音频走：句子换了、用户又开口了，
// 那份结果就不能用来定稿。

test('判停请求提前发起，到点复用结果而不是再请求一次', async () => {
  let calls = 0;
  let firstCallAt = 0;
  const { assembler, utterances } = makeAssembler({
    quietMs: 80,
    predictAtMs: 10,
    predict: async () => {
      calls += 1;
      firstCallAt ||= Date.now();
      return 0.99;
    },
  });

  assembler.addAudio(Buffer.alloc(3200));
  const t0 = Date.now();
  assembler.addSentence('帮我看看这个');

  await delay(35);
  assert.equal(calls, 1, '窗口还没到就该把请求发出去了');
  assert.ok(firstCallAt - t0 < 60, `请求发得比窗口早（${firstCallAt - t0} ms）`);
  assert.equal(utterances.length, 0, '窗口没到不能定稿');

  await delay(120);
  assert.equal(utterances.length, 1, '到点照常收下');
  assert.equal(calls, 1, '到点复用手上那份结果，不该再请求一次');
});

test('用户接着说第二句时，上一句的预判作废并重算', async () => {
  let calls = 0;
  const { assembler, utterances } = makeAssembler({
    quietMs: 60,
    predictAtMs: 0,
    predict: async () => {
      calls += 1;
      return 0.99;
    },
  });

  assembler.addAudio(Buffer.alloc(3200));
  assembler.addSentence('你刚刚是怎么答的');
  await delay(30); // 预判已发出，但静候窗还没关
  assert.equal(calls, 1);

  assembler.addSentence('具体用了哪个工具');
  await delay(150);

  assert.equal(utterances.length, 1, '两句要并成一轮，不能被上一句的判定提前收下');
  assert.equal(utterances[0]?.text, '你刚刚是怎么答的具体用了哪个工具');
  assert.equal(calls, 2, '新的一句要重新发起一次判停');
});

test('预判之后用户又开口，那份结果作废、现算一次', async () => {
  let calls = 0;
  const { assembler, utterances } = makeAssembler({
    quietMs: 60,
    predictAtMs: 0,
    partialGraceMs: 120,
    extendMs: 40,
    maxExtensions: 1,
    predict: async () => {
      calls += 1;
      return 0.99;
    },
  });

  assembler.addAudio(Buffer.alloc(3200));
  assembler.addSentence('我想问一下那个');
  await delay(20);
  assembler.notePartial('我想问一下那');
  await delay(70); // 窗口关掉：预判早于 lastPartialAt，不能信

  assert.equal(calls, 2, '作废之后要现算一次，而不是拿旧的凑数');
  assert.equal(utterances.length, 0, '用户刚又开口，这时候收下就是抢话');

  await delay(200);
  assert.equal(utterances.length, 1, '宽限过去之后还是要收下');
});

test('连接收尾时，在飞的判停结果不会把话再说一遍', async () => {
  const { assembler, utterances } = makeAssembler({
    quietMs: 40,
    predictAtMs: 0,
    predict: async () => {
      await delay(60);
      return 0.99;
    },
  });

  assembler.addAudio(Buffer.alloc(3200));
  assembler.addSentence('这句还没定下来');
  await delay(50); // evaluate 已经进入 await
  assembler.dispose();

  await delay(150);
  assert.equal(utterances.length, 0, 'dispose 之后迟到的判停结果必须丢掉');
});

test('判停器抛错按「不可用」处理，照常收下这一轮', async () => {
  const { assembler, utterances } = makeAssembler({
    quietMs: 30,
    predictAtMs: 0,
    predict: async () => {
      throw new Error('侧车崩了');
    },
  });

  assembler.addAudio(Buffer.alloc(3200));
  assembler.addSentence('这句话必须收下');
  await delay(150);

  assert.equal(utterances.length, 1, '判停器坏了也不能吞掉用户的话');
});
