/**
 * 单飞：并发调用共享同一次尝试。
 *
 * 这条规则是给 dsh 握手用的（见 `session.ts` 的 `ensureSdk`）：`spawn + initialize`
 * 要 ~2 s，这期间再来一轮对话时，如果各自起进程 —— 会把刚起的那个停掉，连在途
 * 握手一起杀掉（实测现象：`sdk 进程退出（code=0）`，那一轮直接失败）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SingleFlight } from '../src/single-flight.ts';

test('并发调用只跑一次，所有调用者拿同一个结果', async () => {
  const flight = new SingleFlight<number>();
  let started = 0;
  const factory = async (): Promise<number> => {
    started += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return 42;
  };

  const [a, b, c] = await Promise.all([flight.run(factory), flight.run(factory), flight.run(factory)]);
  assert.equal(started, 1, '只能起一次');
  assert.deepEqual([a, b, c], [42, 42, 42]);
  assert.equal(flight.busy, false);
});

test('跑完之后能再跑一次（不是永久缓存）', async () => {
  const flight = new SingleFlight<number>();
  let started = 0;
  const factory = async (): Promise<number> => ++started;

  assert.equal(await flight.run(factory), 1);
  assert.equal(await flight.run(factory), 2);
});

test('失败不粘住：错误传给所有等待者，下次重新尝试', async () => {
  const flight = new SingleFlight<void>();
  let calls = 0;
  const failing = async (): Promise<void> => {
    calls += 1;
    throw new Error('initialize 超时');
  };

  const results = await Promise.allSettled([flight.run(failing), flight.run(failing)]);
  assert.equal(calls, 1);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.match(String((r as PromiseRejectedResult).reason), /initialize 超时/);
  }
  assert.equal(flight.busy, false, '失败后要能重试');

  let ok = 0;
  await flight.run(async () => { ok += 1; });
  assert.equal(ok, 1);
});

test('factory 同步抛错也按失败处理，不会卡住单飞', async () => {
  const flight = new SingleFlight<void>();
  await assert.rejects(
    flight.run(() => { throw new Error('炸了'); }),
    /炸了/,
  );
  assert.equal(flight.busy, false);
});
