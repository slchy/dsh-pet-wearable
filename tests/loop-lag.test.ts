/**
 * `loop-lag` 的单测：钉住两件事 —— 数字是「延迟」不是间隔，以及**取完就清零**。
 *
 * 清零那条是这文件存在的理由：如果不 reset，一轮卡过之后每一轮都会继承那个尖峰，
 * 「这一轮卡了没有」就永远回答不了（见 `src/loop-lag.ts` 的注释）。
 *
 * 顺带钉住「不用 `perf_hooks.monitorEventLoopDelay`」这个决定：它两个平台上都抓不到
 * 同步阻塞（Linux 报 resolution、Windows 报定时器粒度），自己排定时器量漂移才抓得到。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loopLagSnapshot } from '../src/loop-lag.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('同步阻塞会被记下来，取完清零后不该再带着它', async () => {
  // 先清一次，免得前面用例留下的样本混进来
  loopLagSnapshot();

  const until = Date.now() + 120;
  while (Date.now() < until) {
    // 故意卡住事件循环 120 ms
  }
  // 定时器得有机会跑一次，采样才会把这段延迟记进去
  await sleep(80);

  const blocked = loopLagSnapshot();
  assert.ok(
    blocked.loop_max_ms >= 40,
    `卡了 120 ms，max 该看得出来，实际 ${blocked.loop_max_ms}`,
  );

  await sleep(80);
  const clean = loopLagSnapshot();
  assert.ok(
    clean.loop_max_ms < blocked.loop_max_ms,
    `取完该清零，第二次不该再带着上一次的尖峰（${clean.loop_max_ms} vs ${blocked.loop_max_ms}）`,
  );
});

test('没有样本时给 -1，不拿 0 冒充「没卡过」', () => {
  // 清完之后立刻再取：中间一个 25 ms 的采样点都没有
  loopLagSnapshot();
  const snap = loopLagSnapshot();
  assert.equal(snap.loop_max_ms, -1);
  assert.equal(snap.loop_p99_ms, -1);
});
