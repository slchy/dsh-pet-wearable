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

test('多 step 的输入输出累加，contextTokens 取最后一步', () => {
  const first = foldStepUsage(null, { inputTokens: 10_000, outputTokens: 200, cacheReadTokens: 8_000 });
  assert.deepEqual(first, {
    inputTokens: 10_000,
    outputTokens: 200,
    cacheReadTokens: 8_000,
    contextTokens: 10_000,
  });

  const second = foldStepUsage(first, { inputTokens: 12_000, outputTokens: 300, cacheReadTokens: 9_000 });
  assert.equal(second.inputTokens, 22_000, '成本口径：两次都算');
  assert.equal(second.outputTokens, 500);
  assert.equal(second.contextTokens, 12_000, '上下文口径：只认最后一次');
});

test('step 没报输入时，上下文规模沿用上一个已知值', () => {
  const acc = foldStepUsage(null, { inputTokens: 5_000 });
  const next = foldStepUsage(acc, { outputTokens: 100 });
  assert.equal(next.contextTokens, 5_000, '别把已知的上下文规模抹成未知');
  assert.equal(next.inputTokens, 5_000);
});

test('headless 的 status usage 直接把 inputTokens 当上下文规模', () => {
  const ndjson = [
    '{"type":"session","sessionId":"session-x"}',
    '{"type":"final","text":"好了"}',
    '{"type":"status","status":"idle","usage":{"inputTokens":123456,"outputTokens":40,"cacheReadTokens":120000}}',
  ].join('\n');

  const parsed = parseEvents(ndjson);
  assert.equal(parsed.usage?.inputTokens, 123456);
  assert.equal(parsed.usage?.contextTokens, 123456, 'headless 收尾那次的输入就是上下文规模');
  assert.equal(parsed.final, '好了');
  assert.equal(parsed.sessionId, 'session-x');
});
