/**
 * `SemanticGate.raisedCap` 的四条同步谓词。
 * 在途请求不许在顶部被 await；延长过一次之后天花板回到 `maxOpenSilenceMs`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SemanticGate,
  type SemanticBudgetContext,
  type SemanticGateOptions,
} from '../src/assembler/semantic-gate.ts';

const allowed: SemanticBudgetContext = {
  extensions: 1,
  unsureExtensions: 1,
  maxExtensions: 2,
  extendMs: 200,
  waitBudget: 200,
  overBudget: true,
};

const blocked: SemanticBudgetContext = {
  extensions: 0,
  unsureExtensions: 0,
  maxExtensions: 0,
  extendMs: 200,
  waitBudget: 200,
  overBudget: false,
};

function gate(
  endpoint: SemanticGateOptions['semanticEndpoint'],
  now: () => number = () => 0,
): SemanticGate {
  return new SemanticGate({
    semanticEndpoint: endpoint,
    maxOpenSilenceMs: 650,
    waitBudgetSequenceMs: 1_200,
    extendMs: 200,
    fragmentWaitMs: 400,
    hasPredictor: true,
    now,
    lastVoicedAtMs: () => 0,
    log: () => {},
  });
}

test('在途不抬；落定 more 且还允许延长才到 1200；不许延长或已延长则回到 650', async () => {
  let release: (verdict: 'more') => void = () => {};
  const now = { t: 0 };
  const semantic = gate(() => new Promise<'more'>((resolve) => { release = resolve; }), () => now.t);
  const text = '你帮我讲讲那本书里。';
  void semantic.ask(text);
  assert.equal(semantic.raisedCap(text, allowed), 650, '在途请求不能在顶部多等');

  release('more');
  await semantic.ask(text);
  assert.equal(semantic.raisedCap(text, allowed), 1_200);
  assert.equal(semantic.raisedCap(text, blocked), 650, 'maxExtensions 为 0 时不抬');

  now.t = 752;
  const decision = await semantic.allowsFlush(text, 0.02, allowed, () => false);
  assert.deepEqual(decision, { action: 'extend', waitMs: 448, text });
  assert.equal(semantic.raisedCap(text, allowed), 650, '延长过一次后回到 650');

  const again = await semantic.allowsFlush(text, 0.02, allowed, () => false);
  assert.equal(again.action, 'flush');
});

test('end、没有端点，都不抬天花板', async () => {
  const text = '今天天气真不错。';
  const ended = gate(async () => 'end');
  await ended.ask(text);
  assert.equal(ended.raisedCap(text, allowed), 650);

  const bare = new SemanticGate({
    maxOpenSilenceMs: 650,
    waitBudgetSequenceMs: 1_200,
    extendMs: 200,
    fragmentWaitMs: 400,
    hasPredictor: true,
    now: () => 752,
    lastVoicedAtMs: () => 0,
    log: () => {},
  });
  assert.equal(bare.raisedCap(text, allowed), 650);
  assert.equal((await bare.allowsFlush(text, 0.02, allowed, () => false)).action, 'flush');
});

test('shouldAwaitInFlightBeforeCap：仅低声学把握且确有在途请求且静音在 650–1200 之间时为真', async () => {
  let release: (verdict: 'end' | 'more') => void = () => {};
  const now = { t: 795 };
  const semantic = gate(() => new Promise<'end' | 'more'>((resolve) => { release = resolve; }), () => now.t);
  const text = '你帮我讲讲那本书里。';

  // 还没发过请求：不在 650 ms 现起冷请求
  assert.equal(semantic.shouldAwaitInFlightBeforeCap(text, 0.009, allowed, 795), false);

  // 发起在途请求后：低 p + 795 ms → 应等
  void semantic.ask(text);
  assert.equal(semantic.shouldAwaitInFlightBeforeCap(text, 0.009, allowed, 795), true);
  // 声学高把握完整句 → 0 ms，不等
  assert.equal(semantic.shouldAwaitInFlightBeforeCap(text, 0.9, allowed, 795), false);
  // 静音已达序列上限 1200 → 不等
  assert.equal(semantic.shouldAwaitInFlightBeforeCap(text, 0.009, allowed, 1_200), false);
  // 预算/拍数不允许延长 → 不等
  assert.equal(semantic.shouldAwaitInFlightBeforeCap(text, 0.009, blocked, 795), false);

  // 落定 end 后 → 0 ms，不等
  release('end');
  await semantic.ask(text);
  assert.equal(semantic.shouldAwaitInFlightBeforeCap(text, 0.009, allowed, 795), false);
});
