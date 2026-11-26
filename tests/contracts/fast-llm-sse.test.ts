/**
 * 快车道 SSE 的夹具契约。
 *
 * 这里防的全是"不会抛错、只会答错"的形状：
 *  - 跨 chunk 拆开的多字节汉字 / `\n` 边界不能丢字；
 *  - 畸形 JSON、SSE 注释行要跳过而不是打崩整条流；
 *  - `[[DELEGATE]]`（含情绪标签前置）必须早退且不把暗号念出去；
 *  - `allowDelegate=false` 时 **无论 [DONE] 还是提前 EOF** 都不能翻成委派
 *    （`fast-llm-client.ts` 的 L125 曾经只改了一边）。
 *
 * 全部通过 mock `fetch` / 直接喂 `readStream`，零真实网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DELEGATE, FastLlmClient, readStream, type StreamHooks } from '../../src/fast-llm-client.ts';
import { EVENTS } from '../../src/events.ts';

const encoder = new TextEncoder();

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function sseLine(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function streamOfText(raw: string, chunkBytes = 3): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(raw);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += chunkBytes) {
    chunks.push(bytes.slice(at, at + chunkBytes));
  }
  return streamOf(chunks);
}

function hooks(): StreamHooks & { emitted: string; firstTokens: number } {
  const state = {
    emitted: '',
    firstTokens: 0,
    onFirstToken: () => { state.firstTokens += 1; },
    emit: (text: string) => { state.emitted += text; },
  };
  return state;
}

test('readStream：跨 chunk 拆开的多字节汉字与换行边界不丢字，首字只报一次', async () => {
  const raw = [
    sseLine('你好'),
    ': keep-alive\n\n',
    'data: not-json\n\n',
    sseLine('呀。'),
    'data: [DONE]\n\n',
  ].join('');
  const h = hooks();
  let now = 1000;
  const answer = await readStream(streamOfText(raw), 1000, () => {
    now += 7;
    return now;
  }, h);

  assert.equal(answer.text, '你好呀。');
  assert.equal(answer.delegated, false);
  assert.equal(answer.opened, true);
  assert.equal(h.emitted, '你好呀。');
  assert.equal(h.firstTokens, 1, 'onFirstToken 只能在首字时触发一次');
  assert.equal(answer.firstTokenMs, 7);
});

test('readStream：畸形 JSON 与非 data 注释行安全跳过，后面的正常增量照常开闸', async () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"先"}}]}\n\n',
    ': 这是注释\n',
    'event: ping\n',
    'data: {oops\n\n',
    'data: {"choices":[]}\n\n',
    sseLine('后'),
    'data: [DONE]\n\n',
  ].join('');
  const h = hooks();
  const answer = await readStream(streamOfText(raw), 0, () => 1, h);
  assert.equal(answer.text, '先后');
  assert.equal(answer.delegated, false);
  assert.equal(h.emitted, '先后');
});

test('readStream：裸 [[DELEGATE]] 早退，不泄漏正文', async () => {
  const raw = `${sseLine(DELEGATE)}${sseLine('不该念出来')}`;
  const h = hooks();
  const answer = await readStream(streamOfText(raw), 0, () => 1, h);
  assert.equal(answer.delegated, true);
  assert.equal(answer.opened, false);
  assert.equal(h.emitted, '');
});

test('readStream：[平静][[DELEGATE]] 也早退，标签不算正文', async () => {
  const raw = `${sseLine('[平静]')}${sseLine(DELEGATE)}${sseLine('不该念出来')}`;
  const h = hooks();
  const answer = await readStream(streamOfText(raw), 0, () => 1, h);
  assert.equal(answer.delegated, true);
  assert.equal(answer.opened, false);
  assert.equal(h.emitted, '');
});

test('readStream：单个 [ 跨 chunk 拼成 [开心]你好 时正常开闸播出', async () => {
  const raw = `${sseLine('[')}${sseLine('开心]你好')}`;
  const h = hooks();
  const answer = await readStream(streamOfText(raw), 0, () => 1, h);
  assert.equal(answer.delegated, false);
  assert.equal(answer.opened, true);
  assert.equal(answer.text, '[开心]你好');
  assert.equal(h.emitted, '[开心]你好', '闸门打开后必须把攒着的字一起吐出去');
});

function askClient(
  fetchImpl: typeof fetch,
  options: { delegateEnabled?: boolean; audit?: (name: string, data: Record<string, unknown>) => void } = {},
): { client: FastLlmClient; emitted: string[] } {
  const emitted: string[] = [];
  const client = new FastLlmClient({
    apiKey: 'k',
    fetchImpl,
    timeoutMs: 500,
    totalMs: 1000,
    now: (() => {
      let now = 0;
      return () => { now += 10; return now; };
    })(),
    ...(options.delegateEnabled === undefined ? {} : { delegateEnabled: options.delegateEnabled }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
  return { client, emitted };
}

function ask(client: FastLlmClient, emit: (text: string) => void): Promise<unknown> {
  return client.ask({
    userText: '在吗',
    startedAt: 0,
    emit,
    kind: 'live',
    messages: [{ role: 'user', content: '在吗' }],
  });
}

function responseOf(stream: ReadableStream<Uint8Array>): typeof fetch {
  return (() => Promise.resolve(new Response(stream, { status: 200 }))) as unknown as typeof fetch;
}

test('FastLlmClient：正常 SSE + [DONE] 收口，首字只报一次', async () => {
  const body = `${sseLine('你好')}${sseLine('呀')}data: [DONE]\n\n`;
  const emitted: string[] = [];
  const { client } = askClient(responseOf(streamOfText(body)));
  const answer = await ask(client, (text) => { emitted.push(text); }) as {
    text: string;
    delegated: boolean;
    opened: boolean;
    firstTokenMs: number;
  };
  assert.equal(answer.text, '你好呀');
  assert.equal(answer.delegated, false);
  assert.equal(answer.opened, true);
  assert.equal(answer.firstTokenMs, 20, '第一次是响应头计时，第二次才是首字');
  assert.deepEqual(emitted, ['你好', '呀']);
});

test('FastLlmClient：allowDelegate=false + [DONE] 不误判委派', async () => {
  const body = `${sseLine(DELEGATE)}data: [DONE]\n\n`;
  const emitted: string[] = [];
  const { client } = askClient(responseOf(streamOfText(body)), { delegateEnabled: false });
  const answer = await ask(client, (text) => { emitted.push(text); }) as {
    text: string;
    delegated: boolean;
    opened: boolean;
  };
  assert.equal(answer.delegated, false);
  assert.equal(answer.opened, true);
  assert.equal(answer.text, DELEGATE, '关掉委派时暗号就是普通正文');
  assert.deepEqual(emitted, [DELEGATE]);
});

test('FastLlmClient：allowDelegate=false + 提前 EOF 也不误判委派（锁定 L125）', async () => {
  const body = sseLine(DELEGATE); // 故意没有 [DONE]
  const emitted: string[] = [];
  const { client } = askClient(responseOf(streamOfText(body)), { delegateEnabled: false });
  const answer = await ask(client, (text) => { emitted.push(text); }) as {
    text: string;
    delegated: boolean;
    opened: boolean;
  };
  assert.equal(answer.delegated, false, 'EOF 不能把 allowDelegate=false 翻成 true');
  assert.equal(answer.opened, true);
  assert.equal(answer.text, DELEGATE);
  assert.deepEqual(emitted, [DELEGATE]);
});

test('FastLlmClient：HTTP 5xx 有明确错误并记录审计', async () => {
  const audit: Array<{ name: string; data: Record<string, unknown> }> = [];
  const { client } = askClient(
    (() => Promise.resolve(new Response('boom', { status: 503 }))) as unknown as typeof fetch,
    { audit: (name, data) => { audit.push({ name, data }); } },
  );
  await assert.rejects(() => ask(client, () => {}), /HTTP 503/);
  assert.deepEqual(audit.map((item) => item.name), [EVENTS.agentAsk, EVENTS.agentDone]);
  assert.equal(audit[1]?.data['ok'], false);
  assert.match(String(audit[1]?.data['err']), /HTTP 503/);
});

test('FastLlmClient：空响应体（body=null）有明确错误并记录审计', async () => {
  const audit: Array<{ name: string; data: Record<string, unknown> }> = [];
  const { client } = askClient(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch,
    { audit: (name, data) => { audit.push({ name, data }); } },
  );
  await assert.rejects(() => ask(client, () => {}), /空响应体/);
  assert.equal(audit[1]?.data['ok'], false);
  assert.match(String(audit[1]?.data['err']), /空响应体/);
});

test('FastLlmClient：空流收口为空答案（不是错误）', async () => {
  const audit: Array<{ name: string; data: Record<string, unknown> }> = [];
  const { client } = askClient(responseOf(streamOf([])), {
    audit: (name, data) => { audit.push({ name, data }); },
  });
  const answer = await ask(client, () => {}) as {
    text: string;
    delegated: boolean;
    opened: boolean;
  };
  assert.equal(answer.text, '');
  assert.equal(answer.delegated, false);
  assert.equal(answer.opened, false);
  assert.equal(audit[1]?.data['ok'], true);
});

test('FastLlmClient：流中 AbortSignal 中止 → 明确失败并记录审计', async () => {
  let started: () => void = () => {};
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const audit: Array<{ name: string; data: Record<string, unknown> }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const fetchImpl = ((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(sseLine('第一句')));
        started();
        signal?.addEventListener('abort', () => {
          // 真 fetch 在 abort 时会让读端报错；这里模拟同一条路径。
          try {
            controller.error(new Error('aborted by signal'));
          } catch {
            // 已经关了
          }
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;

  const { client } = askClient(fetchImpl, {
    audit: (name, data) => { audit.push({ name, data }); },
  });
  const pending = ask(client, () => {});
  await startedPromise;
  client.abortCurrent(new Error('插话取消'));
  await assert.rejects(() => pending, /aborted by signal|HTTP 全部失败/);
  assert.equal(audit[0]?.name, EVENTS.agentAsk);
  const done = audit.find((item) => item.name === EVENTS.agentDone);
  assert.ok(done !== undefined);
  assert.equal(done.data['ok'], false);
  assert.ok(streamController !== null, '测试自己应该拿到过流控制器');
});
