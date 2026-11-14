/**
 * `BatteryCache`：异步电量 → 同步快照值。
 *
 * 这些断言守住的是「谁轮询、多久缓存一次」这条契约，以及两条反直觉的取舍：
 * 读取失败保留旧值、设备明确报 `null` 才置未知。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BatteryCache } from '../src/pet/battery-cache.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

test('初始为 null；refresh 后变成读数', async () => {
  const cache = new BatteryCache({ level: async () => 80 });
  assert.equal(cache.current(), null);
  assert.equal(await cache.refresh(), 80);
  assert.equal(cache.current(), 80);
});

test('读取失败保留旧值，不把一次抖动当成未知', async () => {
  let fail = false;
  const cache = new BatteryCache({
    level: async () => {
      if (fail) {
        throw new Error('transport');
      }
      return 55;
    },
  });
  await cache.refresh();
  fail = true;
  assert.equal(await cache.refresh(), 55);
  assert.equal(cache.current(), 55);
});

test('设备明确报 null → 缓存置 null', async () => {
  let level: number | null = 42;
  const cache = new BatteryCache({ level: async () => level });
  await cache.refresh();
  level = null;
  await cache.refresh();
  assert.equal(cache.current(), null);
});

test('start 立刻读一次，按周期更新；dispose 后停止轮询', async () => {
  let level = 10;
  let calls = 0;
  const cache = new BatteryCache(
    {
      level: async () => {
        calls += 1;
        return level;
      },
    },
    { pollMs: 10 },
  );

  cache.start();
  await sleep(5);
  assert.equal(cache.current(), 10);

  level = 30;
  await sleep(40);
  assert.equal(cache.current(), 30);

  const before = calls;
  cache.dispose();
  await sleep(40);
  assert.equal(calls, before, 'dispose 之后不该再读');
});
