/**
 * 语义判停：只验「标签怎么解析」和「出错绝不阻塞开轮」这两件事。
 *
 * 判得准不准得靠真机档案（`judge.decide` 里 `why:'meaning'` 的那几拍到底有没有
 * 等到下文），不是靠这里的假响应。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { semanticEndpoint } from '../src/semantic-endpoint.ts';

function stubFetch(reply: () => Promise<Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${url} ${String(init?.body ?? '')}`);
    return reply();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('MORE / END 两种标签都能认', async () => {
  for (const [content, expected] of [['MORE', 'more'], ['END', 'end'], [' more\n', 'more']] as const) {
    const { fetchImpl } = stubFetch(async () => json(content));
    const endpoint = semanticEndpoint({ apiKey: 'k', fetchImpl });
    assert.equal(await endpoint.judge('如果你发现自己'), expected);
  }
});

test('模型吐了别的东西 → 拿不准（null），由调用方按「说完了」处理', async () => {
  const { fetchImpl } = stubFetch(async () => json('这句话明显还没说完，因为用户提到了「如果」'));
  const endpoint = semanticEndpoint({ apiKey: 'k', fetchImpl });
  // 「还没说完」里没有 END/MORE 这两个词，解析不出标签
  assert.equal(await endpoint.judge('如果你发现自己'), null);
});

test('HTTP 失败 / 抛异常都回 null，不把异常抛给语音链路', async () => {
  const bad = stubFetch(async () => new Response('nope', { status: 500 }));
  assert.equal(
    await semanticEndpoint({ apiKey: 'k', fetchImpl: bad.fetchImpl }).judge('把灯关掉。'),
    null,
  );
  const boom = stubFetch(async () => { throw new Error('ECONNRESET'); });
  assert.equal(
    await semanticEndpoint({ apiKey: 'k', fetchImpl: boom.fetchImpl }).judge('把灯关掉。'),
    null,
  );
});

test('挂住的请求按超时回 null', async () => {
  const { fetchImpl } = stubFetch(() => new Promise<Response>(() => {}));
  const endpoint = semanticEndpoint({ apiKey: 'k', fetchImpl, timeoutMs: 30 });
  const startedAt = Date.now();
  assert.equal(await endpoint.judge('把灯关掉。'), null);
  assert.ok(Date.now() - startedAt < 500);
});

test('空文本不问服务端（省一次往返）', async () => {
  const { fetchImpl, calls } = stubFetch(async () => json('END'));
  const endpoint = semanticEndpoint({ apiKey: 'k', fetchImpl });
  assert.equal(await endpoint.judge('   '), 'end');
  assert.equal(calls.length, 0);
});
