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

import { UtteranceAssembler, looksUnfinished, type UtteranceAssemblerOptions } from '../src/utterance-assembler.ts';

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

// ------------------------------------------------- 结尾像没说完（order id 被切碎）
//
// `max_sentence_silence` 压到 200 ms 之后，说话人**数字组之间的换气**也会被当成
// 句尾。真机/bench 实测：「订单号是井号W8665881」被切成
// 「订单号是井号W866。」+「5881。」，后半截单独成轮，模型对着「5881」瞎猜。
//
// 修法和短碎片那条一样机械：结尾是数字/井号/连词就再等一拍。

test('looksUnfinished 只认「后面必须还有东西」的结尾', () => {
  for (const text of ['订单号是井号W866。', '第', '井号W.', '我和', '因为', '号码是123']) {
    assert.equal(looksUnfinished(text), true, `应当认为没说完：${text}`);
  }
  for (const text of ['就改成641室。', '好的。', '不对吗？', '没有了，谢谢。', '']) {
    assert.equal(looksUnfinished(text), false, `不该再多等：${text}`);
  }
});

test('结尾是数字时再等一拍，后半句并进来', async () => {
  const { assembler, utterances } = makeAssembler({ unfinishedWaitMs: 60, extendMs: 200 });

  assembler.addSentence('订单号是井号W866。');
  await delay(20);
  assert.equal(utterances.length, 0, '结尾是数字，不能当口就成轮');

  // 用户喘了口气继续说 —— 上一句还没定稿，应当并成一轮
  assembler.addSentence('5881。');
  await delay(150);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0]?.text, '订单号是井号W8665881。', '订单号不能被切成两轮');
});

test('结尾像没说完也只多等一次，没下文就照常收下', async () => {
  const { assembler, utterances } = makeAssembler({ unfinishedWaitMs: 40, extendMs: 40, maxExtensions: 7 });

  const t0 = Date.now();
  assembler.addSentence('订单号是井号W866。');
  await delay(200);

  assert.equal(utterances.length, 1, '等过一拍必须收下，不能无限拖');
  const waited = (utterances[0]?.at ?? 0) - t0;
  assert.ok(waited < 150, `只该多等一拍 40 ms，实际等了 ${waited} ms`);
});

test('结尾不像没说完的句子不受影响', async () => {
  const { assembler, utterances } = makeAssembler({ unfinishedWaitMs: 200 });

  assembler.addSentence('就改成641室。');
  await delay(15);

  assert.equal(utterances.length, 1, '正常句尾不该为这条判据多等');
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

// ---------------------------------------------------------------- 定稿即通知
//
// 判停之前文本就定了，快车道要靠这个通知提前起跑（省掉判停那一拍）。

test('一句定稿就通知一次，文本与本轮累积一致', async () => {
  const seen: string[] = [];
  const { assembler } = makeAssembler({ onSentence: (text) => { seen.push(text); } });

  assembler.addSentence('你好呀');
  assert.deepEqual(seen, ['你好呀'], '文本定稿就该通知，不等判停');

  await delay(60);
  assert.deepEqual(seen, ['你好呀'], '定稿只通知一次，收下不再重复');
});

test('并了第二段就再通知一次，带完整累积文本', async () => {
  const seen: string[] = [];
  // 判停器在第二段到来前一直说「没说完」，好让两段并成一轮
  let done = false;
  const { assembler } = makeAssembler({
    onSentence: (text) => { seen.push(text); },
    predict: async () => (done ? 0.99 : 0.1),
  });

  assembler.addSentence('我想问');
  await delay(60);
  done = true;
  assembler.addSentence('一下那个事');
  await delay(60);

  assert.deepEqual(seen, ['我想问', '我想问一下那个事'], '并段后要按新文本再通知，前面那句才作废');
});

test('中间结果在**静音那一刻**交给投机，且带的是最新一版 + 已定稿的部分', async () => {
  // 为什么不是「每来一版 partial 就发」：收益在「答案赶在定稿前出来」就饱和了
  // （模型首字 ~290 ms ≪ 停嘴→定稿 731 ms），提前更多不省时间，只是多花钱。
  const seen: string[] = [];
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    silencePauseMs: 40,
    speculateMs: 40,
    now: () => clock,
    predict: async () => 0.99,
    onPartial: (text) => { seen.push(text); },
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  assembler.notePartial('你好');
  assert.deepEqual(seen, [], '还在说话，这时候猜出去只会作废');

  assembler.notePartial('你好我想');
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.deepEqual(seen, ['你好我想'], '静音了才发，且要用最新那一版');

  // 并段的第二段：已定稿的部分要接在前面，否则问出去是半句话
  assembler.addSentence('你好呀。');
  assembler.notePartial('再');
  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.deepEqual(seen, ['你好我想', '你好呀。再']);
});

test('投机比判停预跑**更早**触发（100 vs 200），两条线各走各的', async () => {
  const seen: string[] = [];
  const fired: string[] = [];
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    speculateMs: 60,
    silencePauseMs: 120,
    now: () => clock,
    predict: async () => 0.99,
    onPartial: (text) => { seen.push(text); },
    log: (line) => { fired.push(line); },
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  assembler.notePartial('你好我想问问');
  // 静音 60 ms：只够投机，判停还要等
  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.deepEqual(seen, ['你好我想问问'], '静音 60 ms 就该投机');
  assert.ok(
    !fired.some((line) => line.includes('判停') && line.includes('先跑一遍')),
    '判停这时还不该跑（它要等 120 ms）',
  );

  // 静音 120 ms：判停也到点了
  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.ok(
    fired.some((line) => line.includes('判停') && line.includes('先跑一遍')),
    '静音 120 ms 判停预跑要跟上',
  );
  assert.deepEqual(seen, ['你好我想问问'], '没有新 partial 就不该重复投机');
});

test('投机：静音期间补来的 partial**不许顶掉**在跑的那一趟', async () => {
  const seen: string[] = [];
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    speculateMs: 40,
    silencePauseMs: 200,
    now: () => clock,
    onPartial: (text) => { seen.push(text); },
  });

  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  assembler.notePartial('你好我想');
  // 静音 40 ms → 投机
  for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.deepEqual(seen, ['你好我想']);
  // 静音期间 ASR 又补两版：不许重投机（重来等于把已经跑的作废）
  assembler.notePartial('你好我想问问');
  for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assembler.notePartial('你好我想问问你');
  for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.deepEqual(seen, ['你好我想'], '后来的 partial 只用来过定稿闸门，不该重起跑');
});

test('一句话最多投机 2 次（ASR 能给 5–14 版，别变成请求风暴）', async () => {
  const seen: string[] = [];
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    speculateMs: 40,
    silencePauseMs: 200,
    now: () => clock,
    onPartial: (text) => { seen.push(text); },
  });

  const sayThenPause = (partial: string): void => {
    for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
    assembler.notePartial(partial);
    for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  };

  sayThenPause('你');
  sayThenPause('你好');
  sayThenPause('你好我想');
  sayThenPause('你好我想问问');
  await delay(30);

  assert.equal(seen.length, 2, '第 3、4 版不该再发');
  assert.deepEqual(seen, ['你', '你好']);
});

// ---------------------------------------------------------------- 判停提前（与 ASR 静音窗并行）
//
// ASR 要等 200 ms 静音才发 SentenceEnd，而判停器看的是音频 —— 那 200 ms 里音频
// 早就够了。所以静音一到就先把判停跑掉，SentenceEnd 到时直接取用。

/** 一段「有声」PCM：20 ms、满量程的正弦，峰值远高于门限 */
function voiced(ms = 20): Buffer {
  const n = 16000 * 2 * ms / 1000;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 2) b.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i);
  return b;
}
const silent = (ms = 20): Buffer => Buffer.alloc(16000 * 2 * ms / 1000);

test('静音一到就提前跑判停，定稿时不再问第二遍', async () => {
  let calls = 0;
  let clock = 1000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    silencePauseMs: 40,
    now: () => clock,
    predict: async () => { calls += 1; return 0.99; },
  });

  for (let i = 0; i < 10; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.equal(calls, 1, '静音够久就该先把判停跑掉');

  assembler.addSentence('你好呀');
  await delay(80);
  assert.equal(utterances.length, 1, '照常定稿');
  assert.equal(calls, 1, '概率已经算好，不该再问一遍判停器');
});

test('预跑之后又来声音 → 那份判停作废，定稿时重算', async () => {
  let calls = 0;
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    silencePauseMs: 40,
    now: () => clock,
    predict: async () => { calls += 1; return 0.99; },
  });

  for (let i = 0; i < 10; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.equal(calls, 1);

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }   // 用户又说了
  assembler.addSentence('你好呀');
  await delay(80);
  assert.equal(calls, 2, '音频变了，预跑的那份不能再用');
});

test('没说过话的长时间静音不预跑（别白烧判停器）', async () => {
  let calls = 0;
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    silencePauseMs: 40,
    now: () => clock,
    predict: async () => { calls += 1; return 0.99; },
  });

  for (let i = 0; i < 20; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.equal(calls, 0);
});

test('ASR 的中间结果比预跑晚到，也不能把预跑作废', async () => {
  // 实测 ASR 的 partial 比真实停嘴晚 98–140 ms：拿它当「用户还在说」的证据，
  // 会把静音时就跑好的那份判停全废掉，等于没预跑。
  let calls = 0;
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    silencePauseMs: 40,
    now: () => clock,
    predict: async () => { calls += 1; return 0.99; },
  });

  for (let i = 0; i < 10; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.equal(calls, 1);

  clock += 30;
  assembler.notePartial('你好');            // 迟到的中间结果（音频维度早已静音）
  assembler.addSentence('你好呀');
  await delay(80);
  assert.equal(calls, 1, '音频没再变，预跑仍然有效');
});

test('判停每次决定都报一条：p 与「还要等多久」要落进档案', async () => {
  // ② 定稿→开轮 在档案里一直是个黑盒：1 ms 和 2400 ms 都可能是这个数。
  // 不看 p 就分不清「判停不敢收」（连说六次没说完，每拍 400 ms）和「排队」——
  // 真机实测同一句完整问句 p 从 0.083 一路掉到 0.008，白等 2400 ms。
  const facts: Array<{ p: number; waitMs: number; action: string; why?: string }> = [];
  let round = 0;
  const { assembler } = makeAssembler({
    maxExtensions: 1,
    predict: async () => {
      round += 1;
      // 第一次说「没说完」，第二次说「说完了」—— 逼出 extend 然后 accept
      return round === 1 ? 0.02 : 0.98;
    },
    onJudge: (fact) => { facts.push(fact); },
  });
  try {
    assembler.notePartial('你好');
    assembler.addSentence('你好。');
    await delay(200);
  } finally {
    assembler.dispose();
  }
  assert.ok(facts.length >= 2, `该至少报两条（extend + accept），实际 ${JSON.stringify(facts)}`);
  assert.equal(facts[0]!.action, 'extend');
  assert.equal(facts[0]!.why, 'unsure');
  assert.ok(facts[0]!.p < 0.5, `低分要原样报出来，实际 ${facts[0]!.p}`);
  assert.ok(facts[0]!.waitMs > 0, 'extend 必须说清还要等多久');
  assert.equal(facts.at(-1)!.action, 'accept');
  assert.equal(facts.at(-1)!.waitMs, 0);
});

test('判停低分有独立预算：unsure 到上限就收下，不占文本判据的额度', async () => {
  // 侧车的 p 是噪声（同一音频两次回放，同一句 0.549 vs 0.189），低分那条分支
  // 又完全不看文本信号 —— 所以它必须有自己的上限，否则一句话能把 2.8 s 总预算
  // 吃干净，而 grace/短片段/结尾像没说完那三条安全闸也跟着没额度可用。
  const facts: Array<{ action: string; why?: string }> = [];
  let round = 0;
  const { assembler, utterances } = (() => {
    const utterances: Array<{ text: string; at: number }> = [];
    const a = new UtteranceAssembler({
      quietMs: 0,
      extendMs: 20,
      maxExtensions: 7,
      maxUnsureExtensions: 2,
      fallbackWindowMs: 0,
      threshold: 0.5,
      recentMaxBytes: 16_000,
      predict: async () => {
        round += 1;
        // 永远说「没说完」—— 只有上限能把它停下来
        return 0.01;
      },
      onUtterance: (text) => { utterances.push({ text, at: 0 }); },
      onJudge: (f) => { facts.push(f); },
      log: () => {},
    });
    return { assembler: a, utterances };
  })();
  try {
    assembler.notePartial('你好');
    assembler.addSentence('你好。');
    await delay(300);
  } finally {
    assembler.dispose();
  }
  const unsure = facts.filter((f) => f.why === 'unsure');
  assert.equal(unsure.length, 2, `应该只再等 2 拍就收下，实际 ${unsure.length} 拍`);
  assert.ok(utterances.length === 1, '最后必须收下这一轮，不能把话吞掉');
  assert.ok(facts.some((f) => f.action === 'accept'), '该有一条 accept');
});

test('开口时重置音频窗口：判停器只看到这一句', async () => {
  // 官方 smart-turn 是按句裁窗口的（"audio from previous turns does not need to
  // be included"）。原来是连续 8 s 滚动，短句子的窗口里大半是上一轮 —— 实测同一句
  // 「我问你看最近看过哪些电影？」滚动窗口 p=0.26、按句裁 p=0.95。
  const seen: Buffer[] = [];
  const { assembler, utterances } = makeAssembler({
    predict: async (pcm) => { seen.push(pcm); return 0.99; },
    recentMaxBytes: 64,
  });
  try {
    // 上一轮：一大段音频（远超窗口上限），
    assembler.addAudio(Buffer.alloc(40, 7));
    assembler.addSentence('上一轮的问题');
    await delay(50);
    assert.equal(utterances.length, 1);

    // 新一轮开口：窗口只剩这段预卷
    assembler.resetAudio([Buffer.alloc(8, 1), Buffer.alloc(8, 2)]);
    assembler.addAudio(Buffer.alloc(8, 3));
    assembler.addSentence('这一轮');

    await delay(60);
    const last = seen.at(-1);
    assert.ok(last !== undefined, '判停器应该被调用');
    assert.equal(last.length, 24, `窗口应当只有预卷 + 这一句（实际 ${last.length} 字节）`);
    assert.ok(!last.includes(7), '上一轮的音频不能出现在这一句的窗口里');
  } finally {
    assembler.dispose();
  }
});

test('判停快照裁掉尾巴上的静音（训练样本切在停嘴那一点）', async () => {
  const seen: Buffer[] = [];
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 30,
    maxExtensions: 2,
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000 * 2 * 4,      // 4 s，不会因为超限丢块
    silenceDb: -45,                      // 判「有声」的门限
    trailingTrimMs: 100,                 // 只留 100 ms 余量
    predict: async (pcm) => { seen.push(pcm); return 0.99; },
    onUtterance: () => {},
    log: () => {},
  });
  try {
    // 按真实的 20 ms 块喂：200 ms 有声 + 1000 ms 数字静音
    for (let k = 0; k < 10; k += 1) {
      const chunk = Buffer.alloc(640, 0);
      for (let i = 0; i < 320; i += 1) chunk.writeInt16LE(i % 4000, i * 2);  // ≈ −18 dBFS
      assembler.addAudio(chunk);
    }
    for (let k = 0; k < 50; k += 1) assembler.addAudio(Buffer.alloc(640, 0));
    assembler.addSentence('嗯。');
    await delay(60);
  } finally {
    assembler.dispose();
  }
  const last = seen.at(-1);
  assert.ok(last !== undefined, '判停器应该被调用');
  const ms = (last as Buffer).length / 32;
  assert.ok(ms >= 280 && ms <= 320, `快照应当只剩 200 ms 语音 + 100 ms 余量（实际 ${ms} ms）`);
});
