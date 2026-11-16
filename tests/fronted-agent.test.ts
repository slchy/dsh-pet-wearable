/**
 * 快车道装饰器：只在「本地判据认定是闲聊」时才先问快模型，其余轮次零开销。
 *
 * 这里不测 HTTP 细节，测的是**四条必须成立的边界**：
 * 1. 任务类请求永远不进快车道（误判成闲聊的代价比多等 690 ms 大得多）
 * 2. 快模型判自己答不了（`[[DELEGATE]]`）/ 超时 / 报错 → 必须原样交给 dsh，不能哑
 * 3. 快车道的回答要进流式通道，否则 TTS 那条路先付一次「拒空任务」再退回整段
 * 4. 攒满的闲聊轮次要在下一次委派时补进 dsh 的上下文注记
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrontedAgent, isFastCandidate } from '../src/fronted-agent.ts';
import type { AgentProvider, AgentReplyView } from '../src/providers.ts';

/** 假 dsh：记录收到什么 */
function fakeInner(): {
  calls: Array<{ text: string; note?: string | undefined }>;
  sinks: Array<((text: string) => void) | null>;
  agent: AgentProvider;
} {
  const calls: Array<{ text: string; note?: string | undefined }> = [];
  const sinks: Array<((text: string) => void) | null> = [];
  const agent: AgentProvider = {
    name: 'dsh',
    reply: async (text: string, _image, note): Promise<AgentReplyView> => {
      calls.push({ text, note });
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    attachLiveSink: (sink) => { sinks.push(sink); },
  };
  return { calls, sinks, agent };
}

/** 把若干 token 拼成一条 SSE 响应（DeepSeek 兼容格式） */
function sse(tokens: string[], status = 200): Response {
  const body = tokens
    .map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function agentWith(
  inner: AgentProvider,
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof FrontedAgent>[0]> = {},
): { agent: FrontedAgent; lines: string[] } {
  const lines: string[] = [];
  const agent = new FrontedAgent({
    inner,
    apiKey: 'k',
    fetchImpl,
    log: (line) => { lines.push(line); },
    ...extra,
  });
  return { agent, lines };
}

test('判据：闲聊候选 vs 任务请求', () => {
  for (const text of ['你好呀', '谢谢你', '我可想你了', '你是谁']) {
    assert.equal(isFastCandidate(text), true, `该走快车道：${text}`);
  }
  for (const text of [
    '帮我查一下订单',
    '今天天气怎么样',
    '看看我拍照的这张',
    '订单号是W8665881',
    '我觉得你今天特别好看而且心情看起来也很好呀',
  ]) {
    assert.equal(isFastCandidate(text), false, `不该走快车道：${text}`);
  }
});

test('闲聊：用快模型的回答，dsh 一次都不调', async () => {
  const inner = fakeInner();
  const { agent } = agentWith(inner.agent, async () => sse(['我在', '呢。']));
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
  assert.equal(inner.calls.length, 0, '命中快车道就不该惊动 dsh');
});

test('快车道的回答要推给流式通道', async () => {
  const inner = fakeInner();
  const { agent } = agentWith(inner.agent, async () => sse(['我在呢。']));
  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });
  await agent.reply('你好呀');
  assert.deepEqual(seen, ['我在呢。'], '不推的话 turn-runner 会先付一次「拒空任务」');
  assert.equal(inner.sinks.length, 1, 'attachLiveSink 必须透传给 dsh');
});

test('快模型说要委派：交给 dsh', async () => {
  const inner = fakeInner();
  const { agent, lines } = agentWith(inner.agent, async () => sse(['[[', 'DELEGATE]]']));
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '慢车道答复。');
  assert.equal(inner.calls.length, 1);
  assert.ok(lines.some((l) => l.includes('快车道')), '要留下判为委派的日志');
});

test('首字符是 [[ 就早退，不等整句说完', async () => {
  const inner = fakeInner();
  const { agent } = agentWith(inner.agent, async () => {
    const enc = new TextEncoder();
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: '[[' } }] })}\n\n`;
    const rest = `data: ${JSON.stringify({ choices: [{ delta: { content: 'DELEGATE]]' } }] })}\n\ndata: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(first));
        // 句子的其余部分 300 ms 后才到 —— 早退的话根本不会等到它
        await new Promise((resolve) => setTimeout(resolve, 300));
        controller.enqueue(enc.encode(rest));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }, { timeoutMs: 2_000 });

  const startedAt = Date.now();
  const reply = await agent.reply('你好呀');
  const elapsed = Date.now() - startedAt;

  assert.equal(reply.speech, '慢车道答复。');
  assert.equal(inner.calls.length, 1);
  assert.ok(elapsed < 200, `看见 [[ 就该停，实际等了 ${elapsed} ms`);
});

test('超时：交给 dsh，不能哑', async () => {
  const inner = fakeInner();
  const { agent } = agentWith(
    inner.agent,
    (...args) => new Promise<Response>((_resolve, reject) => {
      const signal = (args[1] as RequestInit | undefined)?.signal;
      signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
    }),
    { timeoutMs: 20 },
  );
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '慢车道答复。');
  assert.equal(inner.calls.length, 1);
});

test('快模型 HTTP 出错：交给 dsh', async () => {
  const inner = fakeInner();
  const { agent } = agentWith(inner.agent, async () => new Response('', { status: 500 }));
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '慢车道答复。');
  assert.equal(inner.calls.length, 1);
});

test('任务类请求完全不问快模型', async () => {
  const inner = fakeInner();
  let asked = 0;
  const { agent } = agentWith(inner.agent, async () => {
    asked += 1;
    return sse(['不该被问到。']);
  });
  await agent.reply('帮我查一下订单');
  assert.equal(asked, 0, '本地判据就该挡住，不能多花一趟');
  assert.equal(inner.calls.length, 1);
});

test('攒满上限的闲聊轮次，下次委派时补进 dsh 的注记', async () => {
  const inner = fakeInner();
  let n = 0;
  const { agent } = agentWith(
    inner.agent,
    async () => sse([`闲聊第${++n}句。`]),
    { keepTurns: 2 },
  );
  await agent.reply('你好呀');
  await agent.reply('谢谢你');
  // 第 3 轮：攒满 2 轮，强制走 dsh 并带上缓冲
  await agent.reply('不用谢');
  assert.equal(inner.calls.length, 1);
  const note = inner.calls[0]?.note ?? '';
  assert.ok(note.includes('用户: 你好呀'), `注记里要有第一轮，实际：${note}`);
  assert.ok(note.includes('用户: 谢谢你'), `注记里要有第二轮，实际：${note}`);
  assert.equal(inner.calls[0]?.text, '不用谢', '用户原话不能被改写');
});
