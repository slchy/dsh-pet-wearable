import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokenQueue } from '../src/token-queue.ts';

/** 把迭代器前 n 个元素收起来（带上超时，卡死要报错而不是挂住） */
async function take(queue: TokenQueue, n: number, timeoutMs = 200): Promise<string[]> {
  const got: string[] = [];
  const iter = queue[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (got.length < n) {
    const left = deadline - Date.now();
    assert.ok(left > 0, `只拿到 ${got.length}/${n} 个：${JSON.stringify(got)}`);
    const step = await Promise.race([
      iter.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('超时')), left)),
    ]);
    if (step.done === true) {
      assert.fail(`迭代提前结束，只拿到 ${got.length}/${n} 个`);
    }
    got.push(step.value);
  }
  return got;
}

test('先 push 后迭代：攒下的立刻吐出来', async () => {
  const queue = new TokenQueue();
  queue.push('甲');
  queue.push('乙');
  assert.deepEqual(await take(queue, 2), ['甲', '乙']);
});

test('先迭代后 push：挂起时被叫醒（这是之前卡死的那条）', async () => {
  const queue = new TokenQueue();
  const pending = take(queue, 2);
  // 让迭代器先跑到 await 上，再推 —— 早先写的版本在这里会丢掉唤醒
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.push('甲');
  queue.push('乙');
  assert.deepEqual(await pending, ['甲', '乙']);
});

test('交错：一推一取、顺序不乱、不丢不重', async () => {
  const queue = new TokenQueue();
  const parts = ['一', '二', '三', '四'];
  const pending = (async () => {
    const got: string[] = [];
    for await (const text of queue) got.push(text);
    return got;
  })();
  for (const part of parts) {
    queue.push(part);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  queue.close();
  assert.deepEqual(await pending, parts);
});

test('close 之后剩余元素仍要吐完', async () => {
  const queue = new TokenQueue();
  queue.push('甲');
  queue.close();
  assert.deepEqual(await take(queue, 1), ['甲']);
});

test('空串直接丢，不占位置', async () => {
  const queue = new TokenQueue();
  queue.push('');
  queue.push('甲');
  queue.push('');
  assert.equal(queue.size, 1);
  assert.deepEqual(await take(queue, 1), ['甲']);
});

test('close 后再 push 不会让迭代器永远等下去', async () => {
  const queue = new TokenQueue();
  queue.close();
  const got: string[] = [];
  for await (const text of queue) got.push(text);
  assert.deepEqual(got, []);
});
