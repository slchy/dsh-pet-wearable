/**
 * 判停组装层：**一句话被 ASR 切成两句**时不要拿后半截当一轮。
 *
 * 真机（2026-11-15）：用户问「…你是怎么答的？」，ASR 断成
 * 「…你你是怎么点？」+「大的。」。TurnJudge 对「大的。」给了 0.985 ——
 * 它只看这两秒音频，「大的。」确实像个完整回答，判得不冤。
 * 于是碎片单独成轮，agent 对着两个字瞎猜，用户只好把整段话重说一遍。
 *
 * 修法是机械的：短碎片 + 紧跟上一轮 = 再等一拍看有没有后续。
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type * as ort from 'onnxruntime-node';

import { UtteranceAssembler, looksUnfinished, type UtteranceAssemblerOptions } from '../src/utterance-assembler.ts';
import type { AudioFrame } from '../src/engine-contract.ts';
import { DEFAULT_PET_PARAMS } from '../src/pet/brain/registry.ts';
import { SilenceTriggers } from '../src/silence-triggers.ts';
import { UplinkPipeline } from '../src/uplink-pipeline.ts';
import { SileroVad } from '../src/vad.ts';
import { announceListenMs } from '../src/voice-session.ts';

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

test('中间结果自身不再拖住定稿（grace 已删）', async () => {
  // 2026-11-18 删除 grace：真机 2 场 87 次 extend 里「刚收到中间结果」命中 **0/8**、
  // 白等 3200 ms —— 每一次都是白等。拦住抢话的是**静音闸门**（用户真又出声了
  // 才会前移 `lastVoicedAt`），不是 ASR 出字这件事本身：qwen-realtime 在定稿前后
  // 还会连发几条 partial（同文的、尾巴上补个「嗯。」的），按时间戳判就全成了白等。
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 40,
    onJudge: (fact) => { facts.push(fact); },
  });

  assembler.addSentence('我想问一下那个');
  assembler.notePartial('我想问一下那个然后呢');

  await delay(20);
  assert.equal(utterances.length, 1, '光有中间结果不算「还在说」，不该多等一拍');
  assert.equal(facts.filter((f) => f.why === 'short').length, 0);
});

test('中间结果是过去的，不影响收敛', async () => {
  const { assembler, utterances } = makeAssembler({ extendMs: 40 });

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
    extendMs: 100,
    maxExtensions: 1,
    predict: async () => {
      calls += 1;
      return 0.99;
    },
  });

  assembler.addAudio(Buffer.alloc(3200));
  assembler.addSentence('我想问一下那个');
  await delay(20);
  assembler.notePartial('我想问一下那个然后呢');
  await delay(70); // 窗口关掉：预判早于 lastPartialAt，不能信

  assert.equal(calls, 2, '作废之后要现算一次，而不是拿旧的凑数');
  // 现算的这份 p=0.99 说「说完了」，拦截抢话的只剩静音闸门/统一上限 ——
  // 中间结果本身不再拖住定稿（grace 已删，见上面那条）
  assert.equal(utterances.length, 1, '现算一次后按 p 收下');
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

test('判停说没说完时，后半句照样并进同一轮', async () => {
  // 2026-11-18：`unfinishedWaitMs` 那条文本正则删了（真机 3 次命中 **0/3**、白等
  // 750 ms）。并句改由「p 说没说完」那条分支负责 —— 而念数字时模型本来就判得对，
  // 不需要再叠一层正则。
  const { assembler, utterances } = makeAssembler({
    extendMs: 200,
    maxExtensions: 3,
    maxUnsureExtensions: 3,
    predict: async () => 0.01,
  });

  assembler.addSentence('订单号是井号W866。');
  await delay(20);
  assert.equal(utterances.length, 0, '判停说没说完，先别成轮');

  // 用户喘了口气继续说 —— 上一句还没定稿，应当并成一轮
  assembler.addSentence('5881。');
  // 新段把拍数清零，unsure 要重新走满 maxUnsureExtensions（3 × 200 ms）才收下。
  await delay(800);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0]?.text, '订单号是井号W8665881。', '订单号不能被切成两轮');
});

test('判停说完了就照常收下，不再靠文本正则硬等一拍', async () => {
  const { assembler, utterances } = makeAssembler({ extendMs: 40, maxExtensions: 7 });

  const t0 = Date.now();
  assembler.addSentence('订单号是井号W866。');
  await delay(200);

  assert.equal(utterances.length, 1);
  const waited = (utterances[0]?.at ?? 0) - t0;
  assert.ok(waited < 150, `不该为「结尾是数字」额外等一拍，实际等了 ${waited} ms`);
});

test('判停器抛错按「不可用」处理，照常收下这一轮', async () => {
  const { assembler, utterances } = makeAssembler({
    quietMs: 30,
    predictAtMs: 0,
    predict: async () => {
      throw new Error('判停器崩了');
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
    onPartial: (text) => { seen.push(text); return true; },
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
    onPartial: (text) => { seen.push(text); return true; },
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
    onPartial: (text) => { seen.push(text); return true; },
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
    onPartial: (text) => { seen.push(text); return true; },
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

// ---------------------------------------------------------------- 投机记账（接收方说了算）
//
// 门槛（`specMinChars`、候选判据、配额）全在 `FrontedAgent`，组装器这边只负责
// 「到点了就问一句」。所以**它说没有真的发出去，就不能记成已投机** —— 以前无条件
// 记账，一句被挡掉的「嗯」会把整段语音的机会用光（真机 `20261119-071340` 轮 2/3/11）。

test('投机：接收方说没发出去，下一版 partial 还要再问一次', async () => {
  const tried: string[] = [];
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    speculateMs: 40,
    silencePauseMs: 400,
    now: () => clock,
    // 模拟「中间结果太短被门槛挡掉」：够 4 个字才真发
    onPartial: (text) => { tried.push(text); return text.length >= 4; },
  });

  const sayThenPause = (partial: string): void => {
    assembler.notePartial(partial);
    for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  };

  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  sayThenPause('你');
  sayThenPause('你好');
  assert.deepEqual(tried, ['你', '你好'], '前两版都被挡了，但每次都要真的问出去');

  sayThenPause('你好我想');
  assert.deepEqual(tried, ['你', '你好', '你好我想'], '够长度了就发');

  sayThenPause('你好我想问');
  assert.deepEqual(tried, ['你', '你好', '你好我想'], '发出去了就不再问，补充的 partial 不许重起跑');
});

test('投机：上一段语音残留的中间结果不能拿来猜这一句', async () => {
  const tried: string[] = [];
  let clock = 1000;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    speculateMs: 40,
    silencePauseMs: 400,
    now: () => clock,
    predict: async () => 0.99,
    onPartial: (text) => { tried.push(text); return true; },
  });

  // 第一段：说完、留下一版 partial「嗯」、定稿收下
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  assembler.notePartial('嗯');
  assembler.addSentence('你好。');
  assembler.flush();
  assert.deepEqual(tried, [], '定稿之前就静音了那么久，本来也不该投机');

  // 第二段：开口了，但 ASR 还没吐这一段的字
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(30);
  assert.deepEqual(tried, [], '「嗯」属于上一段，拿它去猜这一句等于乱猜');

  // 这一段的字到了才发
  assembler.notePartial('你看过吗');
  for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.deepEqual(tried, ['你看过吗']);
});

// ---------------------------------------------------------------- 判停提前（与 ASR 静音窗并行）
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
  // 声学判停的 p 是噪声（同一音频两次回放，同一句 0.549 vs 0.189），低分那条分支
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

test('判停一直说没说完时，unsure 拍数用满就收下（中间结果不再续命）', async () => {
  // 真机（2026-11-17 22:10）：用户一口气说完「…对吗？那句。台词的经典是台词是什么来着？」，
  // 判停给 0.007 —— 它判对了（话没说完）。原来「刚收到中间结果」那条宽限会再续一拍，
  // 但那 8 次里一次都没真救到（真机 0/8）。现在只做一次有上限的等待，到点就放行。
  const facts: Array<{ why?: string; waitMs: number }> = [];
  const utterances: string[] = [];
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 40,
    maxExtensions: 7,
    maxUnsureExtensions: 1,        // 只给 1 拍 unsure
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000,
    predict: async () => 0.01,     // 永远「没说完」
    onUtterance: (t) => { utterances.push(t); },
    onJudge: (f) => { facts.push(f); },
    log: () => {},
  });
  try {
    assembler.addSentence('对吗？那句。');
    await delay(20);
    assembler.notePartial('台词，');
    await delay(150);
  } finally {
    assembler.dispose();
  }
  assert.equal(utterances.length, 1, '拍数用满就该收下，不能无限等');
  const waited = facts.reduce((sum, f) => sum + f.waitMs, 0);
  assert.ok(waited <= 40, `只该等一拍 40 ms，实际 ${waited} ms`);
});

test('统一上限：静音到顶就放行，静音闸门也不许绕过', async () => {
  // 这是「谁都不能绕过」的那条闸。原来静音闸门在 `overBudget()` **之前** return ——
  // 它是唯一一条能绕开预算的路径，真机 2 场里 ② 被顶到 2264 ms。
  // 这里把门槛设成 600 ms（闸门会一直「还有下文」地等下去），上限设 200 ms。
  let clock = 1000;
  const facts: Array<{ why?: string; whyAccept?: string; waitMs: number }> = [];
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 600,
    maxExtensions: 20,
    maxUnsureExtensions: 20,
    maxOpenSilenceMs: 200,
    now: () => clock,
    predict: async () => 0.99,     // 就算判停说「说完了」，闸门也还要等静音
    onJudge: (fact) => { facts.push(fact); },
  });

  for (let i = 0; i < 10; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  assembler.addSentence('我让你挂断。');
  for (let i = 0; i < 25; i += 1) { clock += 20; assembler.addAudio(silent()); await delay(20); }

  assert.equal(utterances.length, 1, '静音到上限必须放行');
  assert.ok(
    facts.some((f) => f.whyAccept === 'cap'),
    `该记一次 whyAccept=cap，实际 ${JSON.stringify(facts)}`,
  );
  const waited = facts.reduce((sum, f) => sum + f.waitMs, 0);
  // 闸门要等 600 ms 静音；上限 200 必须把它压到一半以下（假时钟下每拍只走 20 ms，
  // 所以落地会比上限多出一拍的量级）
  assert.ok(waited <= 300, `上限该把等待压到 600 ms 门槛之下，实际 ${waited} ms`);
});

test('裁静音的門限要比开门門限低一截，否则会把语音尾巴当静音裁掉', async () => {
  // 真机（2026-11-17 22:10，v2 眼镜）：语音峰值只有 −32…−40 dBFS，而开门門限就是
  // −40。拿开门門限当「静音」判据 → 最后几个音节被裁掉，判停看到半句话，
  // 同一句 p 从 0.89 掉到 0.28，白等 800 ms。
  const seen: Buffer[] = [];
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 30,
    maxExtensions: 1,
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000 * 4,
    silenceDb: -40,                 // 开门門限（生产值）
    silenceFloorOffsetDb: 20,       // → 裁静音用 −60
    trailingTrimMs: 20,
    predict: async (pcm) => { seen.push(pcm); return 0.99; },
    onUtterance: () => {},
    log: () => {},
  });
  try {
    // 200 ms「响」（−20 dBFS），再 200 ms「轻但仍是语音」（−50 dBFS），再 600 ms 静音
    for (let k = 0; k < 10; k += 1) {
      const c = Buffer.alloc(640, 0);
      for (let i = 0; i < 320; i += 1) c.writeInt16LE(3000, i * 2);
      assembler.addAudio(c);
    }
    for (let k = 0; k < 10; k += 1) {
      const c = Buffer.alloc(640, 0);
      for (let i = 0; i < 320; i += 1) c.writeInt16LE(100, i * 2);
      assembler.addAudio(c);
    }
    for (let k = 0; k < 30; k += 1) assembler.addAudio(Buffer.alloc(640, 0));
    assembler.addSentence('嗯，对。');
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    assembler.dispose();
  }
  const last = seen.at(-1) as Buffer | undefined;
  assert.ok(last !== undefined);
  const ms = last.length / 32;
  // 语音 400 ms + 20 ms 余量；若用 −40 判静音，那段 −50 的尾巴会被裁掉（只剩 ~220 ms）
  assert.ok(ms >= 400, `轻的那 200 ms 也是语音，不该被裁掉（实际只留了 ${ms} ms）`);
});

/** 造一段「有声音」的 20 ms 块（峰值约 −18 dBFS） */
function voicedChunk(): Buffer {
  const c = Buffer.alloc(640, 0);
  for (let i = 0; i < 320; i += 1) c.writeInt16LE(i % 4000, i * 2);
  return c;
}

test('音频和文本都没变时不再干等：判停说没说完也只等一拍', async () => {
  // 真机（2026-11-17 22:10）`judge.decide` 里出现过 0.412 → 0.280 → 0.280：
  // 最后一个 0.280 是拿**同一段音频**重算的 —— 静音期间尾巴被裁掉，快照一个字节
  // 都没多，重算必然得到同一个数。那一拍 400 ms 是纯损失。
  const facts: Array<{ action: string; why?: string }> = [];
  let calls = 0;
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 30,
    maxExtensions: 7,
    maxUnsureExtensions: 2,
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000,
    silenceDb: -40,
    trailingTrimMs: 20,
    predict: async () => { calls += 1; return 0.28; },
    onUtterance: () => {},
    onJudge: (f) => { facts.push(f); },
    log: () => {},
  });
  try {
    for (let k = 0; k < 10; k += 1) assembler.addAudio(voicedChunk());   // 200 ms 语音
    assembler.addSentence('嗯，对。');
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    assembler.dispose();
  }
  const judges = facts.filter((f) => f.action !== 'error');
  assert.equal(judges.length, 2, `第一拍之后输入没变，不该再等第二拍（实际判了 ${judges.length} 次）`);
  assert.equal(judges[0]!.action, 'extend');
  assert.equal(judges[1]!.action, 'accept');
  assert.equal(calls, 2, '第二次仍然要真的问一次（才知道输入没变）');
});

test('中文用更低的阈值，英文用默认', async () => {
  // 官方 benchmark 中文 85.8%（漏报 9.26% / 误报 4.95%）—— 模型偏向说「没说完」。
  // 真机上完整短句「嗯，对。」给 0.22–0.41，而门槛是 0.5 → 白等 400–800 ms。
  const run = async (text: string): Promise<string> => {
    const facts: Array<{ action: string; threshold?: number }> = [];
    const assembler = new UtteranceAssembler({
      quietMs: 0,
      extendMs: 30,
      maxExtensions: 1,
      fallbackWindowMs: 0,
      threshold: 0.5,
      thresholdCjk: 0.35,
      recentMaxBytes: 16_000,
      silenceDb: -40,
      predict: async () => 0.4,          // 落在两个阈值之间
      onUtterance: () => {},
      onJudge: (f) => { facts.push(f); },
      log: () => {},
    });
    try {
      for (let k = 0; k < 5; k += 1) assembler.addAudio(voicedChunk());
      assembler.addSentence(text);
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      assembler.dispose();
    }
    return facts[0]?.action ?? 'none';
  };
  assert.equal(await run('嗯，对。'), 'accept', '中文：0.4 ≥ 0.35，该当场收');
  assert.equal(await run('yeah right'), 'extend', '非中文：0.4 < 0.5，仍要再等一拍');
});

// ---------------------------------------------------------------- 封段（commit）
// 端点由我们控的 ASR（DashScope realtime）里，`commit` 就是「这句话到此为止」。
// 这条线错了的后果是文本被切成两半 —— 所以「一段语音只封一次」是硬要求：
// 空缓冲的 commit 会被服务端回 `maybe no invalid audio stream`，而且会把
// 后续的定稿顺序搅乱。

test('静音到点就请求 ASR 封段，一段语音只封一次', () => {
  let clock = 1000;
  let commits = 0;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    commitAfterMs: 40,
    now: () => clock,
    onCommit: () => { commits += 1; },
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  assert.equal(commits, 0, '还在说话，不能封段');

  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 1, '静音满 40 ms 就该封');

  for (let i = 0; i < 5; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 1, '同一段静音不重复封（空缓冲的 commit 会被服务端拒）');

  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 2, '又来声音说明是下一段，该重新武装');

  assembler.dispose();
});

test('没配 commitAfterMs 或没接 onCommit 就完全不封段', () => {
  const run = (commitAfterMs: number | undefined, withHandler: boolean): number => {
    let clock = 1000;
    let commits = 0;
    const { assembler } = makeAssembler({
      silenceDb: -40,
      ...(commitAfterMs === undefined ? {} : { commitAfterMs }),
      now: () => clock,
      ...(withHandler ? { onCommit: () => { commits += 1; } } : {}),
    });
    for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
    for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
    assembler.dispose();
    return commits;
  };
  assert.equal(run(undefined, true), 0, '没设值就不该有动作（NLS 自己判句）');
  assert.equal(run(40, false), 0, '没接处理器时更不该炸');
  assert.equal(run(40, true), 1, '配齐了就该封');
});

test('极短的换气不会触发封段：静音没到点就不发', () => {
  let clock = 1000;
  let commits = 0;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    commitAfterMs: 120,
    now: () => clock,
    onCommit: () => { commits += 1; },
  });

  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 60 ms
  assert.equal(commits, 0, '60 < 120，这只是换气');

  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(voiced()); } // 又说了
  for (let i = 0; i < 7; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 1, '这次真停了才封');

  assembler.dispose();
});

// ------------------------------------------------------- 开轮门槛 / 静音去抖
// 提交只管切段（越早越好，解码 261 ms 是链路里最长的一段）；开轮不可逆，要保守。
// 判据：定稿到达时「截至此刻」的连续静音够不够 —— 不够说明用户又开口了。

test('定稿在换气处到达时不开轮，等静音够门槛再开', async () => {
  let clock = 1000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 100,
    extendMs: 20,
    now: () => clock,
    predict: async () => 0.99,
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 静音 80 ms
  assembler.addSentence('对吗？');
  await delay(5);
  assert.equal(utterances.length, 0, '静音才 80 < 门槛 100，不能开轮');

  for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 120 ms
  await delay(40);
  assert.deepEqual(utterances.map((u) => u.text), ['对吗？'], '够门槛了才开');
  assembler.dispose();
});

test('换气后接着说的后半句会并进同一轮', async () => {
  let clock = 1000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 100,
    extendMs: 20,
    now: () => clock,
    predict: async () => 0.99,
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assembler.addSentence('对吗？');
  await delay(5);

  // 用户又开口了（连续两帧才算），静音计时归零
  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assembler.addSentence('那句。');
  await delay(5);
  assert.equal(utterances.length, 0, '后半句刚到，静音不够就别急着开');

  for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  await delay(40);
  assert.deepEqual(utterances.map((u) => u.text), ['对吗？那句。'], '要并成一句');
  assembler.dispose();
});

test('服务端判句（静音已够）时门槛不花时间', async () => {
  let clock = 1000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 300,
    extendMs: 20,
    now: () => clock,
    predict: async () => 0.5, // 低于阈值也要走完门槛判断
    threshold: 0.5,
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 22; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 静音 440 ms
  assembler.addSentence('你好。');
  await delay(10);
  assert.deepEqual(utterances.map((u) => u.text), ['你好。'], '静音早就够了，不该再等');
  assembler.dispose();
});

test('单帧「有声」不算重新开口，连续两帧才算', () => {
  let clock = 1000;
  let commits = 0;
  const { assembler } = makeAssembler({
    silenceDb: -40,
    commitAfterMs: 40,
    now: () => clock,
    onCommit: () => { commits += 1; },
  });

  for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
  for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 1, '第一次封段');

  // 20 ms 的「有声」：塞音闭塞段或门限抖动，不该重新武装
  clock += 20; assembler.addAudio(voiced());
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 1, '单帧不算重新开口，不该再封一段');

  // 连续两帧才算真的又说话了
  clock += 20; assembler.addAudio(voiced());
  clock += 20; assembler.addAudio(voiced());
  for (let i = 0; i < 4; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
  assert.equal(commits, 2, '连续两帧才算，这时才该封下一段');
  assembler.dispose();
});

// ---------------------------------------------------------------- QoS（② 的预算）
//
// 真机 2026-11-18：7/29 轮把分支额度吃干净，单轮白等 1.4 s；同一场里一句手机号
// 被拆成 3–4 轮（念数字时每停顿一次 p 判「没说完」都是对的，却被额度提前掐掉）。

test('QoS：总预算用完就收下，不再按分支额度等', async () => {
  const facts: Array<{ why?: string; waitMs: number; budgetMs?: number }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 40,
    maxExtensions: 7,
    maxUnsureExtensions: 7,
    waitBudgetMs: 80,
    predict: async () => 0.01,
    onJudge: (fact) => { facts.push(fact); },
  });

  assembler.addSentence('我让你挂断。');
  await delay(400);

  assert.equal(utterances.length, 1, '预算到点必须收下');
  const waited = facts.reduce((sum, f) => sum + f.waitMs, 0);
  assert.ok(waited <= 80, `不该超过预算，实际等了 ${waited} ms`);
  assert.ok(facts.some((f) => f.budgetMs === 80), '落档要带上预算');
});

test('QoS：结尾是数字序列时给更大的预算，但不给更多拍数', async () => {
  // 2026-11-18 改：序列形态原来靠一条文本正则在 `maxExtensionsNow()` 里开 12 倍
  // 豁免 —— 一个正则压过所有数值限额，实测一场里 `#13` 打 10 拍、`#16` 打 8 拍。
  // 现在序列只换**预算**（`waitBudgetSequenceMs`），拍数仍由 `maxExtensions` 管。
  const facts: Array<{ why?: string; waitMs: number }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 40,
    maxExtensions: 3,
    maxUnsureExtensions: 3,
    waitBudgetMs: 40,
    waitBudgetSequenceMs: 200,
    predict: async () => 0.01,
    onJudge: (fact) => { facts.push(fact); },
  });

  assembler.addSentence('我的手机号是幺三八');
  await delay(600);

  assert.equal(utterances.length, 1, '最后还是要收下，不能吞掉');
  const waited = facts.reduce((sum, f) => sum + f.waitMs, 0);
  assert.ok(waited > 40, `序列该拿到比总预算更大的额度，实际只等了 ${waited} ms`);
  assert.ok(waited <= 200, `不该超过序列预算，实际等了 ${waited} ms`);
  const unsure = facts.filter((f) => f.why === 'unsure').length;
  assert.ok(unsure <= 3, `拍数仍由 maxExtensions 管，实际 ${unsure} 拍`);
});

test('QoS：不在序列形态时，普通句尾仍按小预算收下', async () => {
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 40,
    maxExtensions: 2,
    maxUnsureExtensions: 1,
    waitBudgetMs: 40,
    waitBudgetSequenceMs: 240,
    predict: async () => 0.01,
    onJudge: (fact) => { facts.push(fact); },
  });

  assembler.addSentence('说得好');
  await delay(300);

  assert.equal(utterances.length, 1);
  const unsure = facts.filter((f) => f.why === 'unsure').length;
  assert.ok(unsure <= 1, `普通句尾不该拿到序列豁免，实际 ${unsure} 拍`);
});

// ── 语义判停（END 标签） ────────────────────────────────────────────────
//
// 声学判停回答「这段像不像句尾」，回答不了「这句话说完了没有」：真机
// 20261122-2259 里 7 次 `p=0.985 静音 ≥ 门槛，放行` 全是半句被当成整句
// （「实在不甘心的话，可以趁现在停一下想想。」/「如果你发现自己。」）。
// 文本这一层只补这一个洞 —— 说 `MORE` 就再等一拍。

test('语义判停说 MORE 时再等一拍，不在当口成轮', async () => {
  const facts: Array<{ why?: string; action: string }> = [];
  const { assembler, utterances } = makeAssembler({
    semanticEndpoint: async () => 'more',
    onJudge: (fact) => { facts.push({ why: fact.why, action: fact.action }); },
  });

  assembler.addSentence('如果你发现自己');
  await delay(10);
  assert.equal(utterances.length, 0, 'MORE 不该立刻成轮');

  await delay(80);
  assert.equal(utterances.length, 1, '延长一拍之后还是要收下，不能吞');
  assert.equal(utterances[0]?.text, '如果你发现自己');
  assert.equal(facts.filter((f) => f.why === 'meaning').length, 1, '只延长一次');
});

test('语义判停说 END 时照常成轮，不多等', async () => {
  const { assembler, utterances } = makeAssembler({
    semanticEndpoint: async () => 'end',
  });

  assembler.addSentence('把灯关掉。');
  await delay(10);
  assert.equal(utterances.length, 1);
});

test('语义判停超时按「说完了」放行，不卡住开轮', async () => {
  const { assembler, utterances } = makeAssembler({
    // 永远不回话：模拟服务端慢/挂住
    semanticEndpoint: () => new Promise<'end' | 'more' | null>(() => {}),
    semanticBudgetMs: 25,
  });

  const startedAt = Date.now();
  assembler.addSentence('把灯关掉。');
  await delay(80);
  assert.equal(utterances.length, 1, '超时必须放行');
  assert.ok(Date.now() - startedAt < 300, '超时按预算走，不该拖到天荒地老');
});

test('语义判停不许绕过拍数上限', async () => {
  const { assembler, utterances } = makeAssembler({
    maxExtensions: 0,
    semanticEndpoint: async () => 'more',
  });

  assembler.addSentence('如果你发现自己');
  await delay(10);
  assert.equal(utterances.length, 1, '拍数和预算都用完了，MORE 也只能放行');
});

test('语义判停只能问一次：同一段文字不重复发请求', async () => {
  let calls = 0;
  const { assembler, utterances } = makeAssembler({
    semanticEndpoint: async () => {
      calls += 1;
      return 'more';
    },
    maxExtensions: 4,
  });

  assembler.addSentence('如果你发现自己');
  await delay(80);
  assembler.addSentence('对。');
  await delay(120);

  assert.equal(utterances.length >= 1, true);
  // 两段文字 = 最多两次请求；同一段被 evaluate 多次时不许重复问
  assert.ok(calls <= 2, `同一段只该问一次（实际 ${calls} 次）`);
});
test('中间结果一律不触发语义判停，只有定稿问一趟', async () => {
  // 真机 `20261123-053719` 第 4 轮：一句话在中间结果上发了 **9 趟**语义请求
  // （`würde ich` / `würde ich sch` / `würde ich schreiben` / `Thank you` 各问一遍），
  // 没有一趟改变结论 —— 全是白花的往返和服务端配额。语义只补「声学拿不准」这一层，
  // 而声学拿不准的时刻是**定稿**那一刻，不是逐字改写的过程。
  const asked: string[] = [];
  const { assembler, utterances } = makeAssembler({
    semanticEndpoint: async (text) => { asked.push(text); return 'end'; },
  });

  assembler.notePartial('如果你发现自己在想');
  assembler.notePartial('如果你发现自己在想啊这件事是不是有点奇怪');
  assembler.notePartial('如果你发现自己在想啊这件事是不是有点奇怪呢');
  await delay(20);
  assert.deepEqual(asked, [], '中间结果不花这趟钱');

  assembler.addSentence('如果你发现自己在想啊这件事是不是有点奇怪呢？');
  await delay(40);
  assert.equal(asked.length, 1, '定稿才问，且只问一趟');
  assert.equal(utterances.length, 1, '定稿照常收下');
});

test('判停并段：延长版复用前一趟的判定，不再问第二趟', async () => {
  // 真机 `20261123-051448` 第 6/8/9 轮各对同一句话发了两趟（319 ms / 398 ms）。
  // 并段时先定稿的那半句已经问过，延长版只多几个字 —— 复用。
  const asked: string[] = [];
  const { assembler, utterances } = makeAssembler({
    // 两条定稿必须落进**同一轮**才谈得上复用：`quietMs` 要比两次 `addSentence`
    // 的间隔长，否则第一条已经 flush 成一轮，第二条天然是新的一轮。
    quietMs: 200,
    predict: async () => 0.5, // 留在模糊带，前缀复用才有意义
    semanticEndpoint: async (text) => { asked.push(text); return 'end'; },
  });

  assembler.addSentence('你看过莱姆写的《基础之森》');
  await delay(20);
  assert.equal(asked.length, 1, '前半句定稿时问一趟');

  assembler.addSentence('那本书吗？');
  await delay(400);
  assert.equal(asked.length, 1, '延长版只多四个字，复用前一趟');
  assert.equal(utterances.length, 1, '并段后只收下一轮');
});

test('定稿判了 MORE → 再等一拍，仍不重问', async () => {
  const asked: string[] = [];
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    semanticEndpoint: async (text) => {
      asked.push(text);
      return 'more';
    },
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });

  assembler.addSentence('你讲一下莱姆写的棋谱');
  await delay(20);
  assert.equal(utterances.length, 0, 'MORE 就该再等一拍');
  await delay(90);
  assert.equal(utterances.length, 1, '等完照样收下，不能吞掉');
  assert.equal(facts.filter((f) => f.why === 'meaning').length, 1);
  assert.equal(asked.length, 1, '同一段文字只问一趟');
});

// ---------------------------------------------------------------- 语义判停：半句要等、预算豁免、静音天花板
//
// 契约（eval-v1 S4，不要再放宽）：
// 1. p ≥ 0.80 且 `looksUnfinished` 为假：不等还没回来的语义，0 额外延迟。
//    判定已经在手上（settled / 前缀）时仍按原样用，不把这条捷径提前。
// 2. p ≥ 0.80 且 `looksUnfinished`：等已经在飞的 semanticEndpoint，上限 semanticBudgetMs。
//    end / null / timeout → 放行；明确 more → 再等一拍。
// 3. 这一拍在没设 maxOpenSilenceMs 时仍是 min(extendMs, shortFragmentWaitMs ?? 400)。
//    设了天花板时是 max(1, min(max(extendMs, 350), cap - quietNow))，再被
//    shortFragmentWaitMs（默认 400）夹住。quietNow ≥ cap 立刻放行，不许绕过。
// 4. unsure 吃光当前预算（waitBudget()）且 extensions ≤ maxExtensions 时，
//    明确 more 仍给这一次。extensions 已经越过上限，或预算是静音闸门 / 短碎片
//    吃掉的，不豁免。maxExtensions 为 0（unsure 一拍都不会发生）仍然立刻放行。

test('半句即使 p≥0.80 也要等在飞的语义；MORE 再等一拍', async () => {
  let release: (verdict: 'more') => void = () => {};
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 40,
    maxExtensions: 2,
    predict: async () => 0.977,
    semanticEndpoint: () => new Promise<'more'>((resolve) => { release = resolve; }),
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });
  try {
    assembler.addSentence('实在不甘心的话。');
    await delay(30);
    assert.equal(utterances.length, 0, '以「的话」结尾不能因 p 高就跳过语义');
    release('more');
    await delay(15);
    assert.equal(utterances.length, 0, '明确 MORE 要再等一拍');
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 1);
    await delay(70);
    assert.equal(utterances.length, 1, '等完这一拍必须收下');
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 1, '同一段只延长一次');
  } finally {
    assembler.dispose();
  }
});

test('半句等高 p 的语义 END 时放行，不再多等一拍', async () => {
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    predict: async () => 0.873,
    semanticEndpoint: async () => {
      await delay(80);
      return 'end';
    },
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });
  try {
    assembler.addSentence('如果明天下午不下雨的话。');
    await delay(30);
    assert.equal(utterances.length, 0, '半句要等在飞的语义，不能先开轮');
    await delay(120);
    assert.equal(utterances.length, 1, 'END 回来后照常收下');
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 0, 'END 不占语义延长');
  } finally {
    assembler.dispose();
  }
});

test('半句等语义超时按说完了放行，不卡住开轮', async () => {
  const { assembler, utterances } = makeAssembler({
    predict: async () => 0.95,
    semanticEndpoint: () => new Promise<'end' | 'more' | null>(() => {}),
    semanticBudgetMs: 30,
  });
  try {
    const startedAt = Date.now();
    assembler.addSentence('因为');
    await delay(80);
    assert.equal(utterances.length, 1, '超时必须放行');
    assert.ok(Date.now() - startedAt < 250, '超时按 semanticBudgetMs 走');
  } finally {
    assembler.dispose();
  }
});

test('完整句 p≥0.80 时不等还在飞的语义，0 额外延迟', async () => {
  let resolved = false;
  let late: ReturnType<typeof setTimeout> | undefined;
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    predict: async () => 0.977,
    semanticBudgetMs: 400,
    semanticEndpoint: () => new Promise<'more'>((resolve) => {
      late = setTimeout(() => { resolved = true; resolve('more'); }, 400);
    }),
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });
  try {
    const startedAt = Date.now();
    assembler.addSentence('今天天气真不错。');
    await delay(40);
    const elapsed = Date.now() - startedAt;
    assert.equal(utterances.length, 1, '完整句该直接收下');
    assert.equal(resolved, false, '不该等语义那一趟回来');
    assert.ok(elapsed < 250, `不该付出语义往返，实际 ${elapsed} ms`);
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 0);
  } finally {
    if (late !== undefined) clearTimeout(late);
    assembler.dispose();
  }
});

test('unsure 吃光 waitBudget 后，明确 MORE 仍给一次（拍数刚用满也行）', async () => {
  const facts: Array<{ why?: string; waitedMs?: number }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 40,
    maxExtensions: 1,
    maxUnsureExtensions: 1,
    waitBudgetMs: 40,
    predict: async () => 0.022,
    semanticEndpoint: async () => 'more',
    onJudge: (fact) => { facts.push({ why: fact.why, waitedMs: fact.waitedMs }); },
  });
  try {
    assembler.addSentence('我觉得这件事吧。');
    await delay(160);
    assert.equal(utterances.length, 1, '延长这一次之后必须收下');
    assert.equal(facts.filter((f) => f.why === 'unsure').length, 1, 'unsure 先吃掉那 40 ms');
    const meaning = facts.filter((f) => f.why === 'meaning');
    assert.equal(meaning.length, 1, '预算被 unsure 吃光时 MORE 仍要再等');
    assert.ok((meaning[0]?.waitedMs ?? 0) > 40, '这一拍落在预算用完之后');
  } finally {
    assembler.dispose();
  }
});

test('maxExtensions 为 0 时 MORE 不能靠预算豁免再等', async () => {
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    maxExtensions: 0,
    waitBudgetMs: 40,
    extendMs: 40,
    predict: async () => 0.022,
    semanticEndpoint: async () => 'more',
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });
  try {
    assembler.addSentence('我觉得这件事吧。');
    await delay(30);
    assert.equal(utterances.length, 1, '拍数是 0 时 unsure 不会发生，MORE 立刻放行');
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 0);
    assert.equal(facts.filter((f) => f.why === 'unsure').length, 0);
  } finally {
    assembler.dispose();
  }
});

test('预算被静音闸门吃光时，语义 MORE 不豁免', async () => {
  let clock = 1_000;
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 400,
    extendMs: 40,
    maxExtensions: 4,
    waitBudgetMs: 40,
    now: () => clock,
    predict: async () => 0.9,
    semanticEndpoint: async () => 'more',
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });
  try {
    clock = 1_000;
    assembler.addAudio(voiced());
    clock = 1_020;
    assembler.addAudio(voiced());
    clock = 1_040;
    assembler.addSentence('把灯关掉。');
    await delay(120);
    assert.equal(utterances.length, 1, '静音闸门吃光预算后必须放行');
    assert.equal(facts.filter((f) => f.why === 'silence').length, 1);
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 0, '不是 unsure 吃掉的预算，不豁免');
  } finally {
    assembler.dispose();
  }
});

test('没设静音天花板时，MORE 这一拍仍是 min(extendMs, shortFragment)，不抬到 350', async () => {
  const facts: Array<{ why?: string; waitMs: number }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 200,
    maxExtensions: 2,
    shortFragmentWaitMs: 400,
    predict: async () => 0.5,
    semanticEndpoint: async () => 'more',
    onJudge: (fact) => { facts.push({ why: fact.why, waitMs: fact.waitMs }); },
  });
  try {
    assembler.addSentence('你帮我讲讲那本书里。');
    await delay(30);
    assert.equal(utterances.length, 0);
    const meaning = facts.filter((f) => f.why === 'meaning');
    assert.equal(meaning.length, 1);
    assert.equal(meaning[0]?.waitMs, 200, '没给天花板时不改用 350');
  } finally {
    assembler.dispose();
  }
});

test('设了静音天花板时，MORE 这一拍取 max(extendMs, 350) 并夹在剩余额度与碎片上限里', async () => {
  const run = async (
    quietMs: number,
    shortFragmentWaitMs: number | undefined,
    extendMs: number,
  ): Promise<number | undefined> => {
    let clock = 5_000;
    const facts: Array<{ why?: string; waitMs: number }> = [];
    const { assembler } = makeAssembler({
      extendMs,
      maxExtensions: 3,
      maxOpenSilenceMs: 650,
      ...(shortFragmentWaitMs === undefined ? {} : { shortFragmentWaitMs }),
      silenceDb: -40,
      now: () => clock,
      predict: async () => 0.5,
      semanticEndpoint: async () => 'more',
      onJudge: (fact) => { facts.push({ why: fact.why, waitMs: fact.waitMs }); },
    });
    try {
      assembler.addAudio(voiced());
      clock = 5_020;
      assembler.addAudio(voiced());
      clock = 5_020 + quietMs;
      assembler.addSentence('你帮我讲讲那本书里。');
      await delay(30);
      return facts.find((f) => f.why === 'meaning')?.waitMs;
    } finally {
      assembler.dispose();
    }
  };

  assert.equal(await run(100, 400, 200), 350, '剩余额度够时用 max(extendMs, 350)');
  assert.equal(await run(400, 400, 200), 250, '不超过 cap - quietNow（650-400）');
  assert.equal(await run(100, 100, 200), 100, '再被 shortFragmentWaitMs 夹住');
  assert.equal(await run(0, undefined, 500), 400, 'extendMs 大于 350 时仍不超碎片默认 400');
});

test('等语义期间静音到顶，明确 MORE 也不再延长', async () => {
  let clock = 5_000;
  let release: (verdict: 'more') => void = () => {};
  let markPredict: () => void = () => {};
  const predictEntered = new Promise<void>((resolve) => { markPredict = resolve; });
  const facts: Array<{ why?: string }> = [];
  const { assembler, utterances } = makeAssembler({
    extendMs: 200,
    maxExtensions: 3,
    maxOpenSilenceMs: 300,
    silenceDb: -40,
    now: () => clock,
    predict: async () => {
      markPredict();
      return 0.95;
    },
    semanticEndpoint: () => new Promise<'more'>((resolve) => { release = resolve; }),
    onJudge: (fact) => { facts.push({ why: fact.why }); },
  });
  try {
    assembler.addAudio(voiced());
    clock = 5_020;
    assembler.addAudio(voiced());
    clock = 5_120; // 静音 100 ms，低于上限 300
    assembler.addSentence('实在不甘心的话。');
    await predictEntered;
    await delay(0); // 让 evaluate 通过开头的天花板检查，停在等语义
    assert.equal(utterances.length, 0, '还在等语义，不该先开轮');
    clock = 5_020 + 400; // 等的过程中静音越过上限
    release('more');
    await delay(30);
    assert.equal(utterances.length, 1, '到顶必须放行');
    assert.equal(facts.filter((f) => f.why === 'meaning').length, 0, '到顶后不许再延一拍');
  } finally {
    assembler.dispose();
  }
});

// ------------------------------------------------ 声学前端统一入口（AudioFrame）
//
// 能量门已经算过 `voiced`，组装器不该再按能量算一遍：同一段音频在门与判停两处
// 得到两个「有没有人说话」，正是「有时候丢字、有时候灌静音」的来源。

function frameAt(
  tsMs: number,
  voiced: boolean,
  pcm: Buffer = Buffer.alloc(640),
  silenceMs = 0,
): AudioFrame {
  return { pcm, voiced, silenceMs, gateSeq: 1, tsMs };
}

test('addFrame：已去抖的 voiced 立刻算数，静音只信 frame.silenceMs', () => {
  const commits: number[] = [];
  let clock = 1;                       // 故意和 frame.tsMs 差得很远：用错时钟一眼就露
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 30,
    maxExtensions: 1,
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000,
    silenceDb: -40,                    // 全零 PCM = −120 dBFS，按能量算必然是静音
    commitAfterMs: 40,
    now: () => clock,
    onCommit: (silenceMs) => { commits.push(silenceMs); },
    onUtterance: () => {},
    log: () => {},
  });
  try {
    // 全零 PCM。若在组装器里重算峰值，这一帧会被判成静音，lastVoicedAt 停在 −∞。
    assembler.addFrame(frameAt(5_000, true));
    assert.equal(assembler.lastVoicedAtMs, 5_000, '上游已去抖：第一帧就推进，且用 frame.tsMs');

    // 墙钟几乎没动，帧时间戳只差 20，前端静音却报 40。必须用 silenceMs。
    clock = 2;
    assembler.addFrame(frameAt(5_020, false, Buffer.alloc(640), 40));
    assert.deepEqual(commits, [40], '封段静音 === frame.silenceMs');
    assert.equal(assembler.lastVoicedAtMs, 5_000, '静音帧不推进「最近有声」');
  } finally {
    assembler.dispose();
  }
});

test('addAudio 仍做两帧去抖：单帧尖峰不推进 lastVoicedAt', () => {
  let clock = 5_000;
  const assembler = new UtteranceAssembler({
    quietMs: 0,
    extendMs: 30,
    maxExtensions: 1,
    fallbackWindowMs: 0,
    threshold: 0.5,
    recentMaxBytes: 16_000,
    silenceDb: -40,
    now: () => clock,
    onUtterance: () => {},
    log: () => {},
  });
  try {
    assembler.addAudio(voiced());
    assert.equal(assembler.lastVoicedAtMs, Number.NEGATIVE_INFINITY, '第一帧只计数');
    clock = 5_020;
    assembler.addAudio(voiced());
    assert.equal(assembler.lastVoicedAtMs, 5_020, '第二帧起推进');
    clock = 5_040;
    assembler.addAudio(silent());
    assert.equal(assembler.lastVoicedAtMs, 5_020, '静音帧不推进');
  } finally {
    assembler.dispose();
  }
});

test('addFrame 的四路触发与 addAudio 完全一致', async () => {
  const run = async (kind: 'audio' | 'frame'): Promise<string[]> => {
    const events: string[] = [];
    let clock = 1_000;
    const { assembler } = makeAssembler({
      silenceDb: -40,
      commitAfterMs: 40,
      sttCommitAfterMs: 60,
      speculateMs: 40,
      silencePauseMs: 60,
      now: () => clock,
      predict: async () => { events.push('predict'); return 0.99; },
      onCommit: (ms) => { events.push(`commit:${Math.round(ms)}`); },
      onSttCommit: (ms) => { events.push(`stt:${Math.round(ms)}`); },
      onPartial: (text) => { events.push(`partial:${text}`); return true; },
      log: () => {},
    });
    try {
      // addFrame 吃的是能量门去抖之后的帧：第一块过门限还不算有声。
      let heard = 0;
      let lastVoicedAt = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < 6; i += 1) {
        clock += 20;
        const chunk = voiced();
        if (kind === 'audio') {
          assembler.addAudio(chunk);
        } else {
          heard += 1;
          const confirmed = heard >= 2;
          if (confirmed) lastVoicedAt = clock;
          assembler.addFrame(frameAt(clock, confirmed, chunk, 0));
        }
      }
      assembler.notePartial('你好');
      for (let i = 0; i < 4; i += 1) {
        clock += 20;
        const chunk = silent(20);
        if (kind === 'audio') {
          assembler.addAudio(chunk);
        } else {
          heard = 0;
          const silenceMs = lastVoicedAt === Number.NEGATIVE_INFINITY ? 0 : clock - lastVoicedAt;
          assembler.addFrame(frameAt(clock, false, chunk, silenceMs));
        }
      }
      await delay(30);
    } finally {
      assembler.dispose();
    }
    return events;
  };

  const fromAudio = await run('audio');
  const fromFrame = await run('frame');
  assert.deepEqual(fromFrame, fromAudio, '两条入口必须给出同一串四路事件');
  for (const expected of ['partial:你好', 'commit:40', 'stt:60', 'predict']) {
    assert.ok(fromFrame.includes(expected), `缺了 ${expected}：${JSON.stringify(fromFrame)}`);
  }
});

test('UplinkPipeline 把注入的时钟同时交给能量门与 AudioFrame.tsMs', () => {
  let clock = 500_000;
  const frames: AudioFrame[] = [];
  const closes: Array<number | undefined> = [];
  const pipeline = new UplinkPipeline({
    ffmpegPath: 'ffmpeg',              // codec=pcm16 时不会真的 spawn
    codec: 'pcm16',
    sampleRate: 16_000,
    gate: { thresholdDbfs: -40, holdMs: 2_000, prerollMs: 800 },
    now: () => clock,
    log: () => {},
    onError: () => {},
    onPcm: () => {},
    onSpeechOpen: () => {},
    onFrame: (frame) => { frames.push(frame); },
    onSpeechClose: (gapMs) => { closes.push(gapMs); },
  });
  try {
    pipeline.push(Buffer.alloc(640));          // 纯静音：门不开、不吐帧
    assert.equal(frames.length, 0);

    clock += 1_000;
    pipeline.push(voiced());                   // 有声（约 −12 dBFS）：开门
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.voiced, true);
    assert.equal(frames[0]!.tsMs, clock, '帧时戳要来自注入的时钟，不是 Date.now()');

    // 门开着再喂一块静音：保持窗口也得按同一把尺算。漏传 `now` 时门里是
    // `Date.now()`、这里是假时钟，gap 会是天文数字 —— 第一块静音就把门关了。
    clock += 20;
    pipeline.push(Buffer.alloc(640));
    assert.equal(closes.length, 0, '20 ms 静音不该关门');
    assert.equal(frames.length, 2);
    assert.equal(frames[1]!.silenceMs, 20, '静音时长按注入的时钟算');
  } finally {
    pipeline.end();
  }
});

test('UplinkPipeline voiceDebounceFrames:2 单帧尖峰不归零，预卷带 voiced，时钟只读一次', () => {
  let clock = 10_000;
  let nowCalls = 0;
  const frames: AudioFrame[] = [];
  const opens: Array<readonly { readonly pcm: Buffer; readonly voiced: boolean }[] | undefined> = [];
  const pipeline = new UplinkPipeline({
    ffmpegPath: 'ffmpeg',
    codec: 'pcm16',
    sampleRate: 16_000,
    gate: { thresholdDbfs: -40, holdMs: 2_000, prerollMs: 800 },
    voiceDebounceFrames: 2,
    now: () => {
      nowCalls += 1;
      return clock;
    },
    log: () => {},
    onError: () => {},
    onPcm: () => {},
    onSpeechOpen: (_peak, _preroll, _ms, prerollFrames) => { opens.push(prerollFrames); },
    onFrame: (frame) => { frames.push(frame); },
    onSpeechClose: () => {},
  });
  try {
    pipeline.push(Buffer.alloc(640));
    assert.equal(frames.length, 0, '纯静音不开门');
    assert.equal(nowCalls, 1, '每块只读一次时钟');

    clock += 20;
    pipeline.push(voiced());
    assert.equal(frames.length, 0, '单帧尖峰还不开门、也不吐有声帧');
    assert.equal(nowCalls, 2);

    clock += 20;
    pipeline.push(voiced());
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.voiced, true, '连续第二帧才算有声');
    assert.equal(frames[0]!.silenceMs, 0);
    assert.equal(frames[0]!.tsMs, clock);
    assert.equal(nowCalls, 3, '开门这一帧也不能把 now() 读两次');
    const labeled = opens[0];
    assert.ok(labeled);
    assert.equal(labeled.length, 2);
    assert.equal(labeled[0]!.voiced, false, '预卷里的静音块在门内标成无声');
    assert.equal(labeled[1]!.voiced, true, '开门前那块有声预卷在门内标好');

    clock += 100;
    pipeline.push(Buffer.alloc(640));
    assert.equal(frames[1]!.voiced, false);
    assert.equal(frames[1]!.silenceMs, 100);

    clock += 20;
    pipeline.push(voiced());
    assert.equal(frames[2]!.voiced, false, '门开着的单帧尖峰不算有声');
    assert.equal(frames[2]!.silenceMs, 120, '单帧尖峰不把 silenceMs 打回 0');

    clock += 20;
    pipeline.push(voiced());
    assert.equal(frames[3]!.voiced, true);
    assert.equal(frames[3]!.silenceMs, 0, '连续第二帧才把静音归零');

    clock += 20;
    pipeline.push(Buffer.alloc(640));
    assert.equal(frames[4]!.silenceMs, 20, '最近有声停在第二帧，不停在尖峰那一帧');
    assert.equal(nowCalls, 7);
  } finally {
    pipeline.end();
  }
});

// ------------------------------------------------ 语义判停缓存的上限
//
// 两个 Map 都是「最近几句」的窗口，不是历史账本。`semanticSettled` 曾经只进不出：
// 随会话无限长，`hasPrefixEnd` / `hasPrefixMore` 会把几小时前的前缀判定借给新句。

test('语义判停缓存只留最近 8 条：陈旧的前缀判定不许复用到新句', async () => {
  const asked: string[] = [];
  const { assembler } = makeAssembler({
    semanticEndpoint: async (text) => { asked.push(text); return 'end'; },
  });

  try {
    assembler.addSentence('莱姆写的书');
    await delay(10);
    assert.equal(asked.length, 1);

    for (const filler of ['第二句啊', '第三句啊', '第四句啊', '第五句啊', '第六句啊', '第七句啊', '第八句啊', '第九句啊']) {
      assembler.addSentence(filler);
      await delay(10);
    }
    assert.equal(asked.length, 9, '九段文字各问一趟');

    // 只多一个字：没被淘汰的话 `hasPrefixEnd` 会直接复用第一句的 END，一趟都不问 ——
    // 那正是把几分钟前的判定借给新句。
    assembler.addSentence('莱姆写的书吗');
    await delay(10);
    assert.equal(asked.length, 10, '最老那条必须被淘汰，这里要重新问');
  } finally {
    assembler.dispose();
  }
});

// ------------------------------------------------ 有限状态与物理不变量（FSM 收口）
//
// 守三条硬不变量：
// 1. 预算耗尽（`overBudget`）只限制「安静时多等几拍」，绝不能盖过「人此刻正在说话」：
//    缓冲句非空期间收到去抖后的真实新语音，必迁入 `speaking_more` 并取消在途定时器。
// 2. 任何异步恢复点（`takeProbability` / `awaitSemantics` / `awaitDecode`）醒来见到
//    `speaking_more`、`seq` 变更或 `evalEpoch` 过期都必须让位，绝不拿旧判定冲掉新句。
// 3. 活性保证：清嗓子/空解码在静音达标后先进入 `rearming`（不是 `judging`），
//    等在途解码再收口；彻底停帧也有兜底定时器；`disposed` 为吸收态。

test('FSM 不变量 1a（s1_act_01/s2_asr_04 复现）：静音闸耗光预算后用户仍在说话，绝不中途截断', async () => {
  let clock = 1_000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 300,
    extendMs: 40,
    waitBudgetMs: 40,
    maxExtensions: 4,
    now: () => clock,
    predict: async () => 0.92,
  });
  try {
    // 前半句停嘴后 10 ms 收到定稿（用户其实已开口说后半句）
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 10;
    assembler.addSentence('记一下。');
    await delay(5);
    assert.equal(assembler.phase, 'extending', '静音不够，进入 extending 且吃光 40 ms 预算');
    assert.equal(utterances.length, 0);

    // 预算虽已耗光，但用户正在持续发声：必须迁入 speaking_more，绝不放行「记一下。」
    for (let i = 0; i < 6; i += 1) {
      clock += 20;
      assembler.addAudio(voiced());
    }
    assert.equal(assembler.phase, 'speaking_more');
    await delay(80); // 远超原来的 40 ms 延长定时器
    assert.equal(utterances.length, 0, '用户正在说话期间绝对不能提交旧缓冲句');

    // 后半句停嘴、定稿并段
    for (let i = 0; i < 16; i += 1) {
      clock += 20;
      assembler.addAudio(silent(20));
    }
    assembler.addSentence('我明天下午三点要开会。');
    await delay(30);
    assert.deepEqual(utterances.map((u) => u.text), ['记一下。我明天下午三点要开会。']);
    assert.equal(assembler.phase, 'idle');
  } finally {
    assembler.dispose();
  }
});

test('FSM 不变量 1b（s4_p_300 复现）：semantic=more 续等期间用户重新开口，取消旧定时器并并句', async () => {
  let clock = 2_000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 300,
    extendMs: 40,
    waitBudgetMs: 40,
    maxExtensions: 2,
    maxUnsureExtensions: 1,
    now: () => clock,
    predict: async () => 0.02,
    semanticEndpoint: async () => 'more',
  });
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 340; // 静音已过 openQuiet，先走 unsure 吃光预算，再走 semantic=more
    assembler.addSentence('我觉得这件事吧。');
    await delay(60);
    assert.equal(assembler.phase, 'extending', 'semantic=more 应进入 extending');
    assert.equal(utterances.length, 0);

    // 续等期间用户开口说后半句
    for (let i = 0; i < 4; i += 1) {
      clock += 20;
      assembler.addAudio(voiced());
    }
    assert.equal(assembler.phase, 'speaking_more');
    await delay(80);
    assert.equal(utterances.length, 0, '续等定时器已被取消，不许把前半句误提交');

    for (let i = 0; i < 18; i += 1) {
      clock += 20;
      assembler.addAudio(silent(20));
    }
    assembler.addSentence('最后还是得靠自己。');
    // 新段把拍数清零，要重新走完 unsure 一拍 + 语义 MORE 一拍才收下。
    await delay(180);
    assert.deepEqual(utterances.map((u) => u.text), ['我觉得这件事吧。最后还是得靠自己。']);
  } finally {
    assembler.dispose();
  }
});

test('FSM 不变量 1c（s4_p_500 复现）：awaitSemantics 期间用户重新开口，即使超时/END 也不许提交', async () => {
  let clock = 3_000;
  let release: (verdict: 'end' | 'more' | null) => void = () => {};
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 200,
    extendMs: 40,
    maxExtensions: 2,
    now: () => clock,
    predict: async () => 0.97,
    semanticBudgetMs: 200,
    semanticEndpoint: () => new Promise<'end' | 'more' | null>((r) => { release = r; }),
  });
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 350;
    assembler.addSentence('实在不甘心的话。');
    await delay(10);
    assert.equal(assembler.phase, 'judging', '半句正在等语义判停');

    // 在等语义期间用户开始说后半句
    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    assert.equal(assembler.phase, 'speaking_more');

    // 即使语义此刻回 END（或超时），也不能把前半句冲出去
    release('end');
    await delay(30);
    assert.equal(utterances.length, 0, 'speaking_more 下迟到的语义回执必须让位');

    for (let i = 0; i < 12; i += 1) {
      clock += 20;
      assembler.addAudio(silent(20));
    }
    assembler.addSentence('可以再试一次。');
    await delay(30);
    assert.deepEqual(utterances.map((u) => u.text), ['实在不甘心的话可以再试一次。']);
  } finally {
    assembler.dispose();
  }
});

test('FSM 并发守卫：awaitSemantics 期间新 addSentence 到达，旧协程返回不得误冲新句', async () => {
  let releaseFirst: (verdict: 'end') => void = () => {};
  let call = 0;
  const { assembler, utterances } = makeAssembler({
    quietMs: 80,
    predict: async () => 0.5,
    semanticEndpoint: () => {
      call += 1;
      if (call === 1) {
        return new Promise<'end'>((r) => { releaseFirst = r; });
      }
      return new Promise<'end'>(() => {}); // 第二句故意挂住，用来验证旧协程不会提前冲掉它
    },
    semanticBudgetMs: 200,
  });
  try {
    assembler.addSentence('前半句');
    await delay(95); // 第一句进入 awaitSemantics
    assert.equal(assembler.phase, 'judging');

    // 第二句到达，seq 递增，并重新进入 80 ms quietMs
    assembler.addSentence('后半句');
    assert.equal(assembler.phase, 'armed');

    // 第一句的语义此时返回：旧协程必须放弃，绝不能把「前半句后半句」在 quietMs 内冲掉
    releaseFirst('end');
    await delay(20);
    assert.equal(utterances.length, 0, '旧协程见到 seq 变更必须返回 false，不能误调 flush()');
  } finally {
    assembler.dispose();
  }
});

test('FSM 活性 1：speaking_more 后只是清嗓子无新定稿，静音达标后自动收口不吞话', async () => {
  let clock = 4_000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 120,
    extendMs: 20,
    maxExtensions: 2,
    now: () => clock,
    predict: async () => 0.99,
  });
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 40;
    assembler.addSentence('把灯关掉。');
    await delay(5);

    // 清嗓子触发 speaking_more，但 ASR 没有吐新定稿
    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    assert.equal(assembler.phase, 'speaking_more');

    // 连续静音达标（≥ 120 ms）后退出 speaking_more 并正常收下原句
    for (let i = 0; i < 7; i += 1) {
      clock += 20;
      assembler.addAudio(silent(20));
    }
    await delay(30);
    assert.deepEqual(utterances.map((u) => u.text), ['把灯关掉。']);
    assert.equal(assembler.phase, 'idle');
  } finally {
    assembler.dispose();
  }
});

test('FSM 活性 2：speaking_more 退出前先等 awaitDecode，等来新定稿时不浪费旧 predict', async () => {
  let clock = 5_000;
  let releaseDecode: () => void = () => {};
  let decoding = false;
  let predictCalls = 0;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 120,
    sttCommitAfterMs: 80,
    extendMs: 20,
    maxExtensions: 2,
    decodeWaitMs: 200,
    now: () => clock,
    predict: async () => {
      predictCalls += 1;
      return 0.99;
    },
    awaitDecode: () => (decoding ? new Promise<void>((r) => { releaseDecode = r; }) : null),
  });
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 40;
    assembler.addSentence('请检查订单号');
    await delay(5);
    const beforeCalls = predictCalls;

    // 说话进入 speaking_more
    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    assert.equal(assembler.phase, 'speaking_more');

    // 停嘴后 ASR 正在解码后半句
    decoding = true;
    for (let i = 0; i < 7; i += 1) {
      clock += 20;
      assembler.addAudio(silent(20));
    }
    await delay(10);
    assert.equal(predictCalls, beforeCalls, '退出 speaking_more 应先等解码，不要先白跑旧句的 predict');
    assert.equal(utterances.length, 0);

    // 解码完成并送入后半句
    decoding = false;
    assembler.addSentence('W8665881');
    releaseDecode();
    await delay(30);
    assert.deepEqual(utterances.map((u) => u.text), ['请检查订单号W8665881']);
  } finally {
    assembler.dispose();
  }
});

test('FSM 活性 3：speaking_more 后彻底断流停帧，兜底定时器保证不死锁', async () => {
  let clock = 6_000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 100,
    extendMs: 20,
    maxExtensions: 2,
    now: () => clock,
    predict: async () => 0.99,
  });
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addSentence('今天天气不错。');
    await delay(5);

    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    assert.equal(assembler.phase, 'speaking_more');

    // 模拟设备断流/能量门关闭：之后再无任何帧，把时钟拨过 openQuiet 后等兜底唤醒
    clock += 200;
    await delay(420);
    assert.deepEqual(utterances.map((u) => u.text), ['今天天气不错。']);
    assert.equal(assembler.phase, 'idle');
  } finally {
    assembler.dispose();
  }
});

test('FSM 语义 MORE 与序列上限（s4_p_700/s4_p_900）：配了序列预算时接住 900 ms 停顿，完整句零开销', async () => {
  let clock = 7_000;
  const facts: Array<{ why?: string; waitMs: number }> = [];
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    openQuietMs: 300,
    openQuietShortMs: 200,
    extendMs: 200,
    maxExtensions: 3,
    waitBudgetMs: 200,
    waitBudgetSequenceMs: 1_200,
    maxOpenSilenceMs: 650,
    now: () => clock,
    predict: async () => 0.92,
    semanticEndpoint: async (text) => (text.includes('公园') ? 'end' : 'more'),
    onJudge: (f) => { facts.push({ why: f.why, waitMs: f.waitMs }); },
  });
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 640; // 定稿+语义返回后静音已到 640 ms（距普通 650 上限仅剩 10 ms）
    assembler.addSentence('如果明天下午不下雨的话。');
    await delay(20);
    assert.equal(utterances.length, 0, '明确 MORE 在 1200 ms 序列上限内应给足续等窗口');
    const meaning = facts.find((f) => f.why === 'meaning');
    assert.ok(meaning !== undefined && meaning.waitMs >= 500, `期望给足 ≥500 ms 续等，实际 ${meaning?.waitMs}`);

    // 900 ms 停顿后用户继续说后半句
    clock += 260;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    assert.equal(assembler.phase, 'speaking_more');

    clock += 350;
    assembler.addSentence('我们就去公园走一圈。');
    await delay(20);
    assert.deepEqual(utterances.map((u) => u.text), ['如果明天下午不下雨的话我们就去公园走一圈。']);
  } finally {
    assembler.dispose();
  }
});

test('FSM 吸收态：dispose 之后任何输入均不可离开 disposed 或再发射定稿', async () => {
  let clock = 8_000;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    now: () => clock,
  });
  assembler.addSentence('半句话');
  assembler.dispose();
  assert.equal(assembler.phase, 'disposed');

  clock += 20;
  assembler.addAudio(voiced());
  clock += 20;
  assembler.addAudio(voiced());
  assembler.addSentence('后续');
  assembler.flush();
  await delay(50);
  assert.equal(assembler.phase, 'disposed');
  assert.equal(utterances.length, 0);
});

test('并入新定稿时拍数从零起算，前一段耗尽的额度不带走后一段', async () => {
  const { assembler, utterances } = makeAssembler({
    quietMs: 0,
    extendMs: 40,
    maxExtensions: 1,
    maxUnsureExtensions: 1,
    predict: async () => 0.01,
  });
  try {
    assembler.addSentence('前半句');
    await delay(10);
    assembler.addSentence('后半句');
    await delay(10);
    assert.equal(utterances.length, 0, '新段的拍数已清零，低分还要再等一拍');
    await delay(80);
    assert.deepEqual(utterances.map((u) => u.text), ['前半句后半句']);
  } finally {
    assembler.dispose();
  }
});

test('A2 P0：旧 evaluate 在 rearming 醒来时因 evalEpoch 过期必须放弃', async () => {
  let clock = 10_000;
  let releaseSemantic: (verdict: 'end') => void = () => {};
  let releaseDecode: () => void = () => {};
  let decoding = false;
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    quietMs: 0,
    extendMs: 20,
    maxExtensions: 2,
    decodeWaitMs: 200,
    now: () => clock,
    // 0.60：高于声学阈值所以会走向收下，又低于 0.80，完整句必须等语义。
    predict: async () => 0.6,
    semanticEndpoint: () => new Promise<'end'>((resolve) => { releaseSemantic = resolve; }),
    awaitDecode: () => (decoding ? new Promise<void>((resolve) => { releaseDecode = resolve; }) : null),
  });
  const epochOf = (): number => (assembler as unknown as { evalEpoch: number }).evalEpoch;
  try {
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addSentence('今天天气不错。');
    const born = epochOf();
    await delay(15);
    assert.equal(assembler.phase, 'judging', '应挂在 awaitSemantics');

    clock += 20;
    assembler.addAudio(voiced());
    clock += 20;
    assembler.addAudio(voiced());
    assert.equal(assembler.phase, 'speaking_more');
    assert.ok(epochOf() > born, '重新开口必须推进 evalEpoch');

    decoding = true;
    for (let i = 0; i < 6; i += 1) {
      clock += 20;
      assembler.addAudio(silent(20));
    }
    await delay(15);
    assert.equal(assembler.phase, 'rearming', '退出 speaking_more 必须先进入 rearming');
    const latched = epochOf();
    assert.ok(latched > born);

    // 旧协程在 rearming 醒来。相位不是 speaking_more / idle / disposed，seq 也没变，
    // 只有代次能拦住它。
    releaseSemantic('end');
    await delay(20);
    assert.equal(utterances.length, 0, '过期的 evaluate 不许在 rearming 里提交');
    assert.equal(assembler.phase, 'rearming');
    assert.equal(epochOf(), latched, '放弃旧判定时不能再改代次');

    decoding = false;
    releaseDecode();
    await delay(40);
    assert.deepEqual(utterances.map((u) => u.text), ['今天天气不错。']);
    assert.equal(assembler.phase, 'idle');
  } finally {
    releaseDecode();
    assembler.dispose();
  }
});

test('disposed 吸收 addFrame / addAudio：尾帧不得再封段或投机', () => {
  let clock = 9_000;
  const commits: number[] = [];
  const partials: string[] = [];
  const predicts: number[] = [];
  const { assembler } = makeAssembler({
    silenceDb: -40,
    commitAfterMs: 40,
    speculateMs: 40,
    silencePauseMs: 40,
    now: () => clock,
    predict: async () => { predicts.push(1); return 0.2; },
    onCommit: (ms) => { commits.push(ms); },
    onPartial: (text) => { partials.push(text); return true; },
  });
  assembler.addFrame(frameAt(clock, true, voiced()));
  clock += 20;
  assembler.addFrame(frameAt(clock, true, voiced()));
  assembler.notePartial('你好');
  const voicedAt = assembler.lastVoicedAtMs;
  assembler.addSentence('你好');
  assembler.dispose();
  assert.equal(assembler.phase, 'disposed');

  for (let i = 0; i < 8; i += 1) {
    clock += 20;
    const pcm = i < 2 ? voiced() : silent(20);
    assembler.addFrame(frameAt(clock, i < 2, pcm));
    assembler.addAudio(pcm);
    assembler.notePartial('尾巴');
  }
  assembler.addSentence('不该再收');
  assembler.flush();
  assert.equal(assembler.phase, 'disposed');
  assert.equal(assembler.lastVoicedAtMs, voicedAt, '吸收态不得再 noteFrame');
  assert.deepEqual(commits, [], '吸收态不得封段');
  assert.deepEqual(partials, [], '吸收态不得投机');
  assert.deepEqual(predicts, [], '吸收态不得预跑判停');
});

test('UplinkPipeline.closed 吸收 push 与 onPcm，断连后的尾包不再进门', () => {
  let pcmCount = 0;
  let frameCount = 0;
  const pipeline = new UplinkPipeline({
    ffmpegPath: 'ffmpeg',
    codec: 'pcm16',
    sampleRate: 16_000,
    gate: { thresholdDbfs: -40, holdMs: 2_000, prerollMs: 800 },
    log: () => {},
    onError: () => {},
    onPcm: () => { pcmCount += 1; },
    onSpeechOpen: () => {},
    onFrame: () => { frameCount += 1; },
    onSpeechClose: () => {},
  });
  pipeline.push(voiced());
  pipeline.push(voiced());
  const pcmBefore = pcmCount;
  const framesBefore = frameCount;
  assert.ok(pcmBefore > 0, '关闭前的音频要进管道');
  pipeline.end();
  pipeline.push(voiced());
  (pipeline as unknown as { onPcm(raw: Buffer): void }).onPcm(voiced());
  assert.equal(pcmCount, pcmBefore, 'closed 之后 push / ffmpeg 尾包都不得再回调 onPcm');
  assert.equal(frameCount, framesBefore, 'closed 之后不得再吐 AudioFrame');
});

test('SilenceTriggers 传 0 彻底关闭预跑和投机，不传则仍用 100/200', () => {
  const host = (events: { predicts: number; partials: number }) => ({
    pendingText: () => '',
    lastUtteranceAt: () => Number.NEGATIVE_INFINITY,
    lastPartialAt: () => 1_000,
    lastPartialText: () => '你好呀',
    hasPredictor: () => true,
    predictionPending: () => false,
    startUpcomingPrediction: () => { events.predicts += 1; },
    onVoiced: () => {},
  });

  const closed = { predicts: 0, partials: 0 };
  const off = new SilenceTriggers({
    silencePauseMs: 0,
    speculateMs: 0,
    log: () => {},
    onPartial: () => { closed.partials += 1; return true; },
  }, host(closed));
  off.noteFrame(true, 1_000);
  off.noteFrame(true, 1_020);
  off.noteFrame(false, 1_040);
  off.noteFrame(false, 2_000);
  off.noteFrame(false, 5_000);
  assert.equal(closed.predicts, 0, 'silencePauseMs=0 不能在静音差值为 0 时立刻预跑');
  assert.equal(closed.partials, 0, 'speculateMs=0 不能在静音一到就投机');

  const opened = { predicts: 0, partials: 0 };
  const on = new SilenceTriggers({
    log: () => {},
    onPartial: () => { opened.partials += 1; return true; },
  }, host(opened));
  on.noteFrame(true, 1_000);
  on.noteFrame(true, 1_020);
  on.noteFrame(false, 1_110);
  assert.equal(opened.partials, 0, '默认投机门槛是 100 ms');
  assert.equal(opened.predicts, 0, '默认预跑门槛是 200 ms');
  on.noteFrame(false, 1_120);
  assert.equal(opened.partials, 1, '不传 speculateMs 时静音 100 ms 要投机');
  assert.equal(opened.predicts, 0);
  on.noteFrame(false, 1_220);
  assert.equal(opened.predicts, 1, '不传 silencePauseMs 时静音 200 ms 要预跑');
});

test('SilenceTriggers alreadyDebounced 信任 frontSilenceMs，不再做第二套去抖', () => {
  const commits: number[] = [];
  const voicedAt: number[] = [];
  const silences: number[] = [];
  const triggers = new SilenceTriggers({
    commitAfterMs: 40,
    log: () => {},
    onCommit: (ms) => { commits.push(ms); },
  }, {
    pendingText: () => '',
    lastUtteranceAt: () => Number.NEGATIVE_INFINITY,
    lastPartialAt: () => Number.NEGATIVE_INFINITY,
    lastPartialText: () => '',
    hasPredictor: () => false,
    predictionPending: () => false,
    startUpcomingPrediction: () => {},
    onVoiced: (at) => { voicedAt.push(at); },
    onSilence: (_at, ms) => { silences.push(ms); },
  });
  triggers.noteFrame(true, 5_000, 0, true);
  assert.deepEqual(voicedAt, [5_000], '已去抖的单帧立刻推进');
  assert.equal(triggers.lastVoicedAtMs, 5_000);
  // 时间戳只过了 20，前端静音报 90。按时刻另算会得到 20，封段门槛 40 不会响。
  triggers.noteFrame(false, 5_020, 90, true);
  assert.deepEqual(commits, [90], '封段静音就是 frontSilenceMs');
  assert.deepEqual(silences, [90]);

  const legacy = new SilenceTriggers({
    log: () => {},
  }, {
    pendingText: () => '',
    lastUtteranceAt: () => Number.NEGATIVE_INFINITY,
    lastPartialAt: () => Number.NEGATIVE_INFINITY,
    lastPartialText: () => '',
    hasPredictor: () => false,
    predictionPending: () => false,
    startUpcomingPrediction: () => {},
    onVoiced: () => {},
  });
  legacy.noteFrame(true, 1_000);
  assert.equal(legacy.lastVoicedAtMs, Number.NEGATIVE_INFINITY, '老路径第一帧只计数');
  legacy.noteFrame(true, 1_020);
  assert.equal(legacy.lastVoicedAtMs, 1_020);
});

test('announceListenMs 认 params.listenMs，其次认 PET_LISTEN_MS 那一层', () => {
  assert.equal(announceListenMs(undefined), DEFAULT_PET_PARAMS.listenMs);
  assert.equal(announceListenMs(null), DEFAULT_PET_PARAMS.listenMs);
  assert.equal(announceListenMs({ listenMs: 1_500 }), 1_500);
  assert.equal(announceListenMs({ params: { listenMs: 2_500 } }), 2_500);
  assert.equal(
    announceListenMs({ params: { listenMs: 2_500 }, listenMs: 1_500 }),
    2_500,
    'params.listenMs 优先于这一层的 listenMs',
  );
});

test('SileroVad.reset() 无参清零复用已 init 的 state，不退回未就绪', async () => {
  const fresh = new SileroVad();
  fresh.reset();
  assert.equal((fresh as unknown as { state: unknown }).state, null, '还没 init 时无参 reset 保持未就绪');

  const ortMod = await import('onnxruntime-node') as typeof ort;
  const vad = new SileroVad();
  vad.reset(ortMod);
  const internal = vad as unknown as { state: { data: Float32Array } | null };
  const state = internal.state;
  assert.ok(state, 'reset(ort) 要建出合法 Tensor');
  state.data[0] = 1;
  vad.reset();
  assert.equal(internal.state, state, '无参 reset 必须留着原来的 Tensor');
  assert.equal(state.data[0], 0, 'state.data 要清零复用');
});

// --------------------------------------- 无判停器（Pure Live 手动端点）
//
// 没配 TURN_JUDGE 时 `predict === undefined`。这条路径以前两处都是空转：
// 每句都发一次没人读的语义请求，并且不管静音够不够都盲等 fallbackWindowMs。

test('无判停器时不空发 semanticEndpoint', { timeout: 2_000 }, async () => {
  let semanticCalls = 0;
  const { assembler, utterances } = makeAssembler({
    predict: undefined,
    fallbackWindowMs: 0,
    semanticEndpoint: () => {
      semanticCalls += 1;
      return new Promise(() => {});
    },
  });
  try {
    assembler.addSentence('你好。');
    await delay(40);
    assert.equal(semanticCalls, 0, '没有判停器时结果没人读，不能发远程请求');
    assert.deepEqual(utterances.map((u) => u.text), ['你好。']);
  } finally {
    assembler.dispose();
  }
});

test('无判停器 + openQuietMs：静音早已够时不盲等 fallbackWindowMs', { timeout: 2_000 }, async () => {
  let clock = 1_000;
  const { assembler, utterances } = makeAssembler({
    predict: undefined,
    fallbackWindowMs: 600,
    openQuietMs: 300,
    maxOpenSilenceMs: 650,
    silenceDb: -40,
    now: () => clock,
  });
  try {
    for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
    for (let i = 0; i < 20; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 400 ≥ 300
    const t0 = Date.now();
    assembler.addSentence('你好。');
    await delay(80);
    assert.equal(utterances.length, 1, '静音已经超过 openQuietMs，不该再盲等 600 ms');
    assert.equal(utterances[0]?.text, '你好。');
    const elapsed = (utterances[0]?.at ?? t0) - t0;
    assert.ok(elapsed < 80, `应在几十毫秒内出句，实际 ${elapsed} ms`);
  } finally {
    assembler.dispose();
  }
});

test('无判停器 + openQuietMs：静音不够时守门并合并换气续句', { timeout: 2_000 }, async () => {
  let clock = 1_000;
  const { assembler, utterances } = makeAssembler({
    predict: undefined,
    fallbackWindowMs: 600,
    openQuietMs: 120,
    maxOpenSilenceMs: 400,
    silenceDb: -40,
    now: () => clock,
  });
  try {
    for (let i = 0; i < 6; i += 1) { clock += 20; assembler.addAudio(voiced()); }
    for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 40 < 120
    assembler.addSentence('对吗？');
    await delay(30);
    assert.equal(utterances.length, 0, '静音才 40 ms，不到开轮门槛，不能放行');

    // 换气后续上后半句。连续两帧才算重新开口，定时器随之作废。
    for (let i = 0; i < 3; i += 1) { clock += 20; assembler.addAudio(voiced()); }
    for (let i = 0; i < 2; i += 1) { clock += 20; assembler.addAudio(silent(20)); }
    assembler.addSentence('那句。');
    await delay(30);
    assert.equal(utterances.length, 0, '后半句刚到，静音仍不够');

    for (let i = 0; i < 5; i += 1) { clock += 20; assembler.addAudio(silent(20)); } // 40 + 100 ≥ 120
    await delay(200);
    assert.deepEqual(utterances.map((u) => u.text), ['对吗？那句。']);
  } finally {
    assembler.dispose();
  }
});

test('无判停器 + openQuietMs：假时钟不推进时受 maxOpenSilenceMs 封顶', { timeout: 2_000 }, async () => {
  // 时钟冻住之后静音不会再涨。若只看 openQuietMs（300）又忘了把已排上的等待
  // 记进预算，evaluate 会一拍接一拍地空转。上限 80 必须把这条路掐断。
  const clock = 5_000;
  const logs: string[] = [];
  const { assembler, utterances } = makeAssembler({
    predict: undefined,
    fallbackWindowMs: 600,
    openQuietMs: 300,
    maxOpenSilenceMs: 80,
    silenceDb: -40,
    now: () => clock,
    log: (line) => { logs.push(line); },
  });
  try {
    // 两帧才把 lastVoicedAt 从 −∞ 推上来。只喂一帧的话静音差分是 +∞，会走「早已够」而不是上限。
    assembler.addAudio(voiced());
    assembler.addAudio(voiced());
    const t0 = Date.now();
    assembler.addSentence('你好。');
    await delay(250);
    assert.equal(utterances.length, 1, '假时钟不走也必须放行，不能死循环');
    assert.equal(utterances[0]?.text, '你好。');
    const elapsed = (utterances[0]?.at ?? t0) - t0;
    assert.ok(elapsed < 250, `应在 maxOpenSilenceMs=80 的量级结束，实际 ${elapsed} ms`);
    assert.equal(
      logs.filter((line) => line.includes('再等')).length,
      0,
      `预算在第一拍就顶满上限，不该再续：${JSON.stringify(logs)}`,
    );
  } finally {
    assembler.dispose();
  }
});

// ------------------------------------------------ S4：650 ms 不得截胡已落定的 semantic=more
//
// 第 1 拍 unsure（200 ms）期间语义已经落成 `more`。第 2 拍静音走到 752/761 ms 时，
// 顶部闸门若仍读 650，会在 `semanticAllowsFlush` 之前 `whyAccept: 'cap'` 把
// 1200 ms 的序列天花板压成死代码。假时钟要在真实 `setTimeout` 到期前拨过去。

interface S4Run {
  assembler: UtteranceAssembler;
  utterances: Array<{ text: string; at: number }>;
  facts: Array<{ why?: string; whyAccept?: string; waitMs: number; action: string }>;
  logs: string[];
  /** 把假时钟拨到「距最初那两帧有声」这么久。必须早于真实定时器到期。 */
  silence(ms: number): void;
}

function makeS4(overrides: Partial<UtteranceAssemblerOptions> = {}): S4Run {
  const clock = { t: 20_000 };
  const facts: S4Run['facts'] = [];
  const logs: string[] = [];
  const { assembler, utterances } = makeAssembler({
    silenceDb: -40,
    extendMs: 200,
    maxExtensions: 2,
    maxUnsureExtensions: 1,
    waitBudgetMs: 200,
    waitBudgetSequenceMs: 1_200,
    maxOpenSilenceMs: 650,
    now: () => clock.t,
    predict: async () => 0.02,
    onJudge: (fact) => {
      facts.push({
        why: fact.why,
        whyAccept: fact.whyAccept,
        waitMs: fact.waitMs,
        action: fact.action,
      });
    },
    log: (line) => { logs.push(line); },
    ...overrides,
  });
  assembler.addAudio(voiced());
  clock.t += 20;
  assembler.addAudio(voiced());
  const voicedAt = clock.t;
  return {
    assembler,
    utterances,
    facts,
    logs,
    silence(ms: number) {
      clock.t = voicedAt + ms;
    },
  };
}

/** 第 1 拍 unsure，再把时钟拨到第 2 拍静音，等到 meaning / cap 那次 evaluate 跑完。 */
async function secondBeat(s: S4Run, text: string, firstSilenceMs: number, secondSilenceMs: number): Promise<void> {
  s.silence(firstSilenceMs);
  s.assembler.addSentence(text);
  await delay(80);
  s.silence(secondSilenceMs);
  await delay(320);
}

function meaningWaits(s: S4Run): number[] {
  return s.facts.filter((fact) => fact.why === 'meaning').map((fact) => fact.waitMs);
}

test('s4_p_700：第 2 拍静音 752 ms 不按 cap 放行，语义 more 延长 448 ms', { timeout: 5_000 }, async () => {
  const s = makeS4({ semanticEndpoint: async () => 'more' });
  try {
    s.silence(552);
    s.assembler.addSentence('你帮我讲讲那本书里。');
    await delay(80);
    const unsure = s.facts.filter((fact) => fact.why === 'unsure');
    assert.equal(unsure.length, 1);
    assert.equal(unsure[0]?.waitMs, 200);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), false);
    assert.equal(s.assembler.phase, 'extending');

    s.silence(752);
    await delay(320);
    assert.deepEqual(meaningWaits(s), [448]);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), false);
    assert.equal(s.assembler.phase, 'extending');
    assert.equal(s.utterances.length, 0);
  } finally {
    s.assembler.dispose();
  }
});

test('s4_p_900：第 2 拍静音 761 ms 语义 more 延长 439 ms', { timeout: 5_000 }, async () => {
  const s = makeS4({ semanticEndpoint: async () => 'more' });
  try {
    await secondBeat(s, '如果明天下午不下雨的话。', 561, 761);
    assert.deepEqual(meaningWaits(s), [439]);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), false);
    assert.equal(s.assembler.phase, 'extending');
    assert.equal(s.utterances.length, 0);
  } finally {
    s.assembler.dispose();
  }
});

test('s4_p_700 续说：静音 775 ms 重新开口，并成单轮完整句', { timeout: 8_000 }, async () => {
  const s = makeS4({
    semanticEndpoint: async (text) => (text.includes('离开城市') ? 'end' : 'more'),
  });
  try {
    await secondBeat(s, '你帮我讲讲那本书里。', 552, 752);
    assert.deepEqual(meaningWaits(s), [448]);
    assert.equal(s.assembler.phase, 'extending');

    s.silence(775);
    s.assembler.addAudio(voiced());
    s.assembler.addAudio(voiced());
    assert.equal(s.assembler.phase, 'speaking_more');
    assert.equal(s.utterances.length, 0);

    s.assembler.addSentence('主角最后为什么离开城市啦？');
    await delay(500);
    assert.deepEqual(
      s.utterances.map((item) => item.text),
      ['你帮我讲讲那本书里。主角最后为什么离开城市啦？'],
    );
    assert.deepEqual(meaningWaits(s), [448]);
  } finally {
    s.assembler.dispose();
  }
});

test('s4_p_900 续说：静音 900 ms 重新开口，并成单轮完整句', { timeout: 8_000 }, async () => {
  const s = makeS4({
    semanticEndpoint: async (text) => (text.includes('公园') ? 'end' : 'more'),
  });
  try {
    await secondBeat(s, '如果明天下午不下雨的话。', 561, 761);
    assert.deepEqual(meaningWaits(s), [439]);

    s.silence(900);
    s.assembler.addAudio(voiced());
    s.assembler.addAudio(voiced());
    assert.equal(s.assembler.phase, 'speaking_more');

    s.assembler.addSentence('我们就去公园走一圈。');
    await delay(500);
    assert.deepEqual(
      s.utterances.map((item) => item.text),
      ['如果明天下午不下雨的话我们就去公园走一圈。'],
    );
    assert.deepEqual(meaningWaits(s), [439]);
  } finally {
    s.assembler.dispose();
  }
});

test('s4 第 3 拍：延长到 1200 ms 后收口，语义 more 只延长一次', { timeout: 8_000 }, async () => {
  const s = makeS4({ semanticEndpoint: async () => 'more' });
  try {
    await secondBeat(s, '你帮我讲讲那本书里。', 552, 752);
    assert.deepEqual(meaningWaits(s), [448]);
    assert.equal(s.assembler.phase, 'extending');

    s.silence(1_200);
    await delay(520);
    assert.deepEqual(s.utterances.map((item) => item.text), ['你帮我讲讲那本书里。']);
    assert.deepEqual(meaningWaits(s), [448]);
    assert.equal(s.assembler.phase, 'idle');
    assert.ok(
      s.logs.some((line) => line.includes('上限 650')),
      `第 3 拍应回到 650 ms 收口，实际 ${JSON.stringify(s.logs)}`,
    );
  } finally {
    s.assembler.dispose();
  }
});

test('semantic=end：静音 752 ms 按 650 cap 放行，不再等 550 ms', { timeout: 5_000 }, async () => {
  const s = makeS4({ semanticEndpoint: async () => 'end' });
  try {
    await secondBeat(s, '今天天气真不错。', 552, 752);
    assert.deepEqual(meaningWaits(s), []);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), true);
    assert.equal(s.facts.reduce((sum, fact) => sum + fact.waitMs, 0), 200);
    assert.deepEqual(s.utterances.map((item) => item.text), ['今天天气真不错。']);
    assert.ok(s.logs.some((line) => line.includes('752 ms ≥ 上限 650')));
  } finally {
    s.assembler.dispose();
  }
});

test('无 semanticEndpoint：静音 752 ms 按 650 cap 放行', { timeout: 5_000 }, async () => {
  const s = makeS4();
  try {
    await secondBeat(s, '今天天气真不错。', 552, 752);
    assert.deepEqual(meaningWaits(s), []);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), true);
    assert.equal(s.facts.reduce((sum, fact) => sum + fact.waitMs, 0), 200);
    assert.deepEqual(s.utterances.map((item) => item.text), ['今天天气真不错。']);
    assert.ok(s.logs.some((line) => line.includes('752 ms ≥ 上限 650')));
  } finally {
    s.assembler.dispose();
  }
});

test('已经因语义延长过：静音 800 ms 回到 650 cap，不再第二次 meaning', { timeout: 8_000 }, async () => {
  const s = makeS4({ semanticEndpoint: async () => 'more' });
  try {
    await secondBeat(s, '你帮我讲讲那本书里。', 552, 752);
    assert.deepEqual(meaningWaits(s), [448]);

    s.silence(800);
    await delay(520);
    assert.deepEqual(meaningWaits(s), [448]);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), true);
    assert.deepEqual(s.utterances.map((item) => item.text), ['你帮我讲讲那本书里。']);
    assert.ok(
      s.logs.some((line) => line.includes('800 ms ≥ 上限 650')),
      `已延长过仍应按 650 放行，实际 ${JSON.stringify(s.logs)}`,
    );
    assert.equal(s.logs.some((line) => line.includes('上限 1200')), false);
  } finally {
    s.assembler.dispose();
  }
});

test('more 已落定但 maxExtensions 为 0：静音 700 ms 仍按 650 cap 放行', { timeout: 5_000 }, async () => {
  const s = makeS4({
    maxExtensions: 0,
    semanticEndpoint: async () => 'more',
  });
  try {
    s.silence(700);
    s.assembler.addSentence('你帮我讲讲那本书里。');
    await delay(80);
    assert.deepEqual(meaningWaits(s), []);
    assert.equal(s.facts.filter((fact) => fact.why === 'unsure').length, 0);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), true);
    assert.deepEqual(s.utterances.map((item) => item.text), ['你帮我讲讲那本书里。']);
    assert.ok(s.logs.some((line) => line.includes('700 ms ≥ 上限 650')));
  } finally {
    s.assembler.dispose();
  }
});

test('s4_p_700 在途竞态：第 2 拍 795 ms 时语义仍在途，27 ms 后落定 more 应延长并合并成单轮', { timeout: 8_000 }, async () => {
  let releaseFirst: (verdict: 'more') => void = () => {};
  let calls = 0;
  const s = makeS4({
    predict: async () => 0.009,
    semanticBudgetMs: 400,
    semanticEndpoint: (text) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<'more'>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve(text.includes('离开城市') ? 'end' : 'more');
    },
  });
  try {
    // 第 1 拍（499 ms 定稿，p=0.009 → unsure 等 200 ms），语义仍在途
    s.silence(499);
    s.assembler.addSentence('你帮我讲讲那本书里。');
    await delay(80);
    assert.equal(s.assembler.phase, 'extending');

    // 第 2 拍醒来时静音已到 795 ms（超过基础 cap 650），语义仍在途
    s.silence(795);
    await delay(180);
    assert.equal(s.utterances.length, 0, '在途语义未回前不得抢先按 650 cap 截断');
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), false);

    // 27 ms 后语义落定 more（静音 822 ms），应给出 378 ms 续等窗到 1200 ms
    s.silence(822);
    releaseFirst('more');
    await delay(60);
    assert.deepEqual(meaningWaits(s), [378]);
    assert.equal(s.assembler.phase, 'extending');
    assert.equal(s.utterances.length, 0);

    // 用户续说后半句，并成单轮
    s.silence(860);
    s.assembler.addAudio(voiced());
    s.assembler.addAudio(voiced());
    assert.equal(s.assembler.phase, 'speaking_more');
    s.assembler.addSentence('主角最后为什么离开城市啦？');
    await delay(500);
    assert.deepEqual(
      s.utterances.map((item) => item.text),
      ['你帮我讲讲那本书里。主角最后为什么离开城市啦？'],
    );
  } finally {
    s.assembler.dispose();
  }
});

test('s4_p_700 在途竞态对照：第 2 拍 795 ms 在途语义返回 end 时仍按 cap 放行', { timeout: 5_000 }, async () => {
  let release: (verdict: 'end') => void = () => {};
  const s = makeS4({
    predict: async () => 0.009,
    semanticBudgetMs: 400,
    semanticEndpoint: () => new Promise<'end'>((resolve) => { release = resolve; }),
  });
  try {
    s.silence(499);
    s.assembler.addSentence('外面现在在下雨吗？');
    await delay(80);
    s.silence(795);
    await delay(180);
    s.silence(820);
    release('end');
    await delay(80);
    assert.deepEqual(meaningWaits(s), []);
    assert.equal(s.facts.some((fact) => fact.whyAccept === 'cap'), true);
    assert.deepEqual(s.utterances.map((item) => item.text), ['外面现在在下雨吗？']);
  } finally {
    s.assembler.dispose();
  }
});

test('无判停器且未设 openQuietMs：保留 fallbackWindowMs', { timeout: 2_000 }, async () => {
  const { assembler, utterances } = makeAssembler({
    predict: undefined,
    fallbackWindowMs: 120,
  });
  try {
    assembler.addSentence('你好。');
    await delay(40);
    assert.equal(utterances.length, 0, '40 ms 还没到 fallbackWindowMs，不该提前出句');
    await delay(140);
    assert.deepEqual(utterances.map((u) => u.text), ['你好。']);
  } finally {
    assembler.dispose();
  }
});
