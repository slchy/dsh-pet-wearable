/**
 * 用量记账。以前 SDK 模式永远打 `tokens=?/?`，等于没有仪表 ——
 * 刚把压缩阈值收到 12.5 万，却没有东西能证明它到底触没触发。
 *
 * 这里锁住两个口径不能混：
 * - 累加值（成本）
 * - 最后一个 step 的输入（上下文规模，压缩阈值的判据）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldStepUsage, parseEvents } from '../src/session.ts';

test('多 step 的输入输出累加，contextTokens 取最后一步且含缓存命中', () => {
  const first = foldStepUsage(null, { inputTokens: 10_000, outputTokens: 200, cacheReadTokens: 8_000 });
  assert.deepEqual(first, {
    inputTokens: 10_000,
    outputTokens: 200,
    cacheReadTokens: 8_000,
    // 真实上下文是「未命中 + 命中」，只算前者会低估一个数量级
    contextTokens: 18_000,
  });

  const second = foldStepUsage(first, { inputTokens: 12_000, outputTokens: 300, cacheReadTokens: 9_000 });
  assert.equal(second.inputTokens, 22_000, '成本口径：两次都算');
  assert.equal(second.outputTokens, 500);
  assert.equal(second.contextTokens, 21_000, '上下文口径：只认最后一次，且含缓存');
});

test('step 只报缓存、没报输入时，上下文照样算得出来', () => {
  // 真机形态：命中了 67584、只新进 144 —— 这才是上下文接近七万的真相
  const usage = foldStepUsage(null, { inputTokens: 144, outputTokens: 13, cacheReadTokens: 67_584 });
  assert.equal(usage.contextTokens, 67_728);
});

test('step 什么输入都没报时，上下文规模沿用上一个已知值', () => {
  const acc = foldStepUsage(null, { inputTokens: 5_000 });
  const next = foldStepUsage(acc, { outputTokens: 100 });
  assert.equal(next.contextTokens, 5_000, '别把已知的上下文规模抹成未知');
  assert.equal(next.inputTokens, 5_000);
});

test('headless 的 status usage 把输入与缓存相加当上下文规模', () => {
  const ndjson = [
    '{"type":"session","sessionId":"session-x"}',
    '{"type":"final","text":"好了"}',
    '{"type":"status","status":"idle","usage":{"inputTokens":3456,"outputTokens":40,"cacheReadTokens":120000}}',
  ].join('\n');

  const parsed = parseEvents(ndjson);
  assert.equal(parsed.usage?.inputTokens, 3456);
  assert.equal(parsed.usage?.contextTokens, 123456, '收尾那次的输入加缓存才是上下文规模');
  assert.equal(parsed.final, '好了');
  assert.equal(parsed.sessionId, 'session-x');
});
