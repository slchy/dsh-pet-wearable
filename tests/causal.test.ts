/**
 * 因果谓词只留有调用点的两个。`mayBargeIn` 全仓无引用，已删。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPreTurnSegment, isStaleTicket } from '../src/causal.ts';
import * as causal from '../src/causal.ts';

test('mayBargeIn 不再导出', () => {
  assert.equal('mayBargeIn' in causal, false);
});

test('旧段只比 commitSeq，没有水位线时放行', () => {
  assert.equal(isPreTurnSegment({ commitSeq: 3 }, { baseCommitSeq: 3 }), true);
  assert.equal(isPreTurnSegment({ commitSeq: 4 }, { baseCommitSeq: 3 }), false);
  assert.equal(isPreTurnSegment({ commitSeq: 1 }, {}), false);
});

test('票据过期要轮次和代次一起比', () => {
  assert.equal(isStaleTicket({ no: 2, gen: 1 }, { no: 2, gen: 1 }), false);
  assert.equal(isStaleTicket({ no: 2, gen: 1 }, { no: 1, gen: 1 }), true);
  assert.equal(isStaleTicket(null, { no: 1, gen: 0 }), true);
});
