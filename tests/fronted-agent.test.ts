/**
 * 快车道装饰器：本地判据 + 流式传输 + 投机双轨。
 *
 * 测的是**四条必须成立的边界**：
 * 1. 任务类请求永远不进快车道（误判成闲聊的代价比多等 690 ms 大得多）
 * 2. 快模型判自己答不了（`[[DELEGATE]]`）/ 超时 / 报错 → 原样交给 dsh，不能哑
 * 3. 流式：过了暗号判定就逐字推给 TTS，不等整句；暗号本身一个字都不能推
 * 4. 投机：dsh 与快模型同时起跑；快车道赢则丢掉 dsh 的增量，输则把它补放出来
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrontedAgent, isFastCandidate, isStatusQuestion } from '../src/fronted-agent.ts';
import type { AgentProvider, AgentReplyView } from '../src/providers.ts';

interface FakeInner {
  readonly agent: AgentProvider;
  readonly calls: Array<{ text: string; note?: string | undefined }>;
  /** 模拟 dsh 往流式通道推一段增量（走 FrontedAgent 装的闸门） */
  readonly push: (text: string) => void;
}

function fakeInner(): FakeInner {
  const calls: Array<{ text: string; note?: string | undefined }> = [];
  let sink: ((text: string) => void) | null = null;
  const agent: AgentProvider = {
    name: 'dsh',
    reply: async (text: string, _image, note): Promise<AgentReplyView> => {
      calls.push({ text, note });
      return { text: '慢车道答复。', speech: '慢车道答复。' };
    },
    attachLiveSink: (next) => { sink = next; },
  };
  return { agent, calls, push: (text) => { sink?.(text); } };
}

/** 把若干 token 拼成一条 SSE 响应（DeepSeek 兼容格式） */
function sse(tokens: string[], status = 200): Response {
  const body = tokens
    .map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** 每个 token 之间隔 `gapMs`，用来模拟「整句要几百毫秒才说完」 */
function slowSse(tokens: string[], gapMs: number): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const t of tokens) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function agentWith(
  inner: AgentProvider,
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof FrontedAgent>[0]> = {},
): FrontedAgent {
  return new FrontedAgent({
    inner,
    apiKey: 'k',
    fetchImpl,
    log: () => {},
    ...extra,
  });
}

test('判据：闲聊候选 vs 任务请求', () => {
  for (const text of ['你好呀', '谢谢你', '我可想你了', '你是谁', '你叫什么名字']) {
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

test('「什么」不进任务词 —— 它会把「你叫什么名字」一起挡掉', () => {
  assert.equal(isFastCandidate('你叫什么名字'), true);
  assert.equal(isFastCandidate('几点了'), true, '要事实的问题交给快模型自己判委派');
});

test('任务类请求完全不问快模型', async () => {
  const inner = fakeInner();
  let asked = 0;
  const agent = agentWith(inner.agent, async () => {
    asked += 1;
    return sse(['不该被问到。']);
  });
  await agent.reply('帮我查一下订单');
  assert.equal(asked, 0, '本地判据就该挡住');
  assert.equal(inner.calls.length, 1);
});

test('流式：第一段文字不等整句说完就推给 TTS', async () => {
  const inner = fakeInner();
  const agent = agentWith(inner.agent, async () => slowSse(['我在', '呢', '。'], 40));
  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });

  const reply = await agent.reply('你好呀');

  assert.equal(reply.speech, '我在呢。');
  // 断言的是**边界**而不是耗时：第一段只有第一个 token，说明没等整句说完。
  // 用时间阈值会在 `node --test` 并行跑多个文件时随机失败（踩过）。
  assert.deepEqual(seen, ['我在', '呢', '。'], '应当逐段推出，且分段边界与 token 对齐');
});

test('暗号一个字都不推给 TTS', async () => {
  const inner = fakeInner();
  const agent = agentWith(inner.agent, async () => sse(['[[', 'DELEGATE]]']));
  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });

  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '慢车道答复。');
  assert.deepEqual(seen, [], '`[[` 一旦出现就作废这条路，绝不能推进 TTS');
  assert.equal(inner.calls.length, 1);
});

test('单个 `[` 不会被当成暗号（情绪标签是单方括号）', async () => {
  const inner = fakeInner();
  const agent = agentWith(inner.agent, async () => slowSse(['[开', '心]你好呀。'], 10));
  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });

  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '你好呀。', '情绪标签要被清洗掉');
  assert.ok(seen.join('').includes('开'), '标签本身会推给 TTS（由 TTS 侧清洗）');
});

test('投机：dsh 与快模型同时起跑，命中时 dsh 的增量被丢掉', async () => {
  const inner = fakeInner();
  let innerCalledAt = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    reply: async (text, image, note) => {
      innerCalledAt = Date.now();
      inner.push('慢车道已经开始说话了');
      await new Promise((resolve) => setTimeout(resolve, 80));
      return inner.agent.reply(text, image, note);
    },
  };
  const agent = agentWith(wrapped, async () => slowSse(['我在', '呢。'], 40));
  const seen: string[] = [];
  const startedAt = Date.now();
  agent.attachLiveSink((text) => { seen.push(text); });

  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
  assert.ok(innerCalledAt - startedAt < 40, '投机下 dsh 必须立刻开跑，不能等快模型判定');
  assert.ok(!seen.includes('慢车道已经开始说话了'), '快车道胜出后，dsh 的增量不能混进 TTS');
  assert.equal(inner.calls.length, 1, 'dsh 确实被跑了一次（代价：白花一次调用）');
});

test('投机：快车道让位时，dsh 已经推进来的增量要补放出去', async () => {
  const inner = fakeInner();
  const wrapped: AgentProvider = {
    ...inner.agent,
    reply: async (text, image, note) => {
      inner.push('早就说出来的前半句');
      return inner.agent.reply(text, image, note);
    },
  };
  const agent = agentWith(wrapped, async () => sse(['[[', 'DELEGATE]]']));
  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });

  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '慢车道答复。');
  assert.deepEqual(seen, ['早就说出来的前半句'], '缓冲的增量不能丢，也不能重复');
});

test('串行模式：命中闲聊时 dsh 一次都不调', async () => {
  const inner = fakeInner();
  const agent = agentWith(inner.agent, async () => sse(['我在呢。']), { speculate: false });
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
  assert.equal(inner.calls.length, 0, '关掉投机就不该白花 dsh 调用');
});

test('超时：交给 dsh，不能哑', async () => {
  const inner = fakeInner();
  const agent = agentWith(
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
  const agent = agentWith(inner.agent, async () => new Response('', { status: 500 }));
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '慢车道答复。');
  assert.equal(inner.calls.length, 1);
});

test('投机：快车道胜出时取消掉慢车道那一轮', async () => {
  const inner = fakeInner();
  let cancelled = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
    reply: async (text, image, note) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return inner.agent.reply(text, image, note);
    },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']));
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀');
  assert.equal(cancelled, 1, '没人要的那一轮必须尝试取消：省一次调用，也不留幽灵历史');
});

test('投机：第一个字推给 TTS 的那一刻就取消，不等快模型把整句说完', async () => {
  const inner = fakeInner();
  let cancelled = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
    reply: async (text, image, note) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return inner.agent.reply(text, image, note);
    },
  };
  // 每字隔 60 ms：整句要 180 ms 才说完，首字只要 60 ms
  const agent = agentWith(wrapped, async () => slowSse(['我', '在', '呢。'], 60) as never);
  let atFirstChar = -1;
  agent.attachLiveSink(() => {
    if (atFirstChar < 0) {
      atFirstChar = cancelled;
    }
  });

  await agent.reply('你好呀');
  assert.equal(atFirstChar, 1, '首字一出就没回头路了，这时候就该掐掉 dsh');
  assert.equal(cancelled, 1, '只掐一次');
});

test('不投机时绝不动手取消：dsh 里在跑的可能是后台任务的旁白', async () => {
  const inner = fakeInner();
  let cancelled = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']), { speculate: false });
  agent.attachLiveSink(() => {});

  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
  assert.equal(cancelled, 0);
});

test('取消模式 interrupt 走硬中断而不是 rpc', async () => {
  const inner = fakeInner();
  let rpc = 0;
  let hard = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { rpc += 1; },
    interruptTurn: () => { hard += 1; },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']), { cancelMode: 'interrupt' });
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀');
  assert.equal(hard, 1);
  assert.equal(rpc, 0, '硬中断会杀进程，不能两条路都发');
});

test('cancelMode=off 时什么都不做', async () => {
  const inner = fakeInner();
  let called = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { called += 1; },
    interruptTurn: () => { called += 1; },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']), { cancelMode: 'off' });
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀');
  assert.equal(called, 0);
});

test('投机：快车道让位时不取消（那一轮正是我们要的结果）', async () => {
  const inner = fakeInner();
  let cancelled = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
  };
  const agent = agentWith(wrapped, async () => sse(['[[', 'DELEGATE]]']));
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀');
  assert.equal(cancelled, 0, '让位说明 dsh 的答案要用，绝不能取消');
});

test('取消抛错不能影响本轮', async () => {
  const inner = fakeInner();
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { throw new Error('IPC 挂了'); },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']));
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
});

test('攒满上限的闲聊轮次，下次委派时补进 dsh 的注记', async () => {
  const inner = fakeInner();
  let n = 0;
  const agent = agentWith(
    inner.agent,
    async () => sse([`闲聊第${++n}句。`]),
    { keepTurns: 2, speculate: false },
  );
  await agent.reply('你好呀');
  await agent.reply('谢谢你');
  await agent.reply('不用谢');
  assert.equal(inner.calls.length, 1);
  const note = inner.calls[0]?.note ?? '';
  assert.ok(note.includes('用户: 你好呀'), `注记里要有第一轮，实际：${note}`);
  assert.ok(note.includes('用户: 谢谢你'), `注记里要有第二轮，实际：${note}`);
  assert.equal(inner.calls[0]?.text, '不用谢', '用户原话不能被改写');
});

test('后台任务事实进的是系统消息，不是用户话术', async () => {
  const inner = fakeInner();
  let body = '';
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      body = String((init as RequestInit | undefined)?.body ?? '');
      return sse(['还在跑，哥。']);
    },
    { speculate: false, taskStatus: () => '后台任务：在跑 1 个 —— bash「sleep 20」已跑 12 秒。' },
  );
  agent.attachLiveSink(() => {});

  const reply = await agent.reply('好了吗');
  assert.equal(reply.speech, '还在跑，哥。');

  const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
  const system = payload.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = payload.messages.find((m) => m.role === 'user')?.content ?? '';
  assert.match(system, /sleep 20/, '事实要在系统消息里给模型');
  assert.match(system, /照那条事实说/, '还要告诉它别编');
  assert.equal(user, '好了吗', '用户话术原样，不能把事实混进去');
});

test('没有事实时不追加规则（空串 = 保持原样）', async () => {
  const inner = fakeInner();
  let body = '';
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      body = String((init as RequestInit | undefined)?.body ?? '');
      return sse(['嗯。']);
    },
    { speculate: false, taskStatus: () => '' },
  );
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀');
  const system = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> })
    .messages.find((m) => m.role === 'system')?.content ?? '';
  assert.ok(!system.includes('后台任务'), system);
});

test('状态询问绕过任务词表（有事实才放行）', async () => {
  const inner = fakeInner();
  const asked: string[] = [];
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      const body = String((init as RequestInit | undefined)?.body ?? '');
      asked.push(body);
      return sse(['还在跑呢。']);
    },
    { speculate: false, taskStatus: () => '后台任务：在跑 1 个 —— bash「sleep 20」已跑 12 秒。' },
  );
  agent.attachLiveSink(() => {});

  // 「查」在任务词表里，但这句问的是进度
  const reply = await agent.reply('查到了吗');
  assert.equal(reply.speech, '还在跑呢。');
  assert.equal(asked.length, 1);

  // 没有事实来源时不能放行：那样它只会瞎猜
  const plain = agentWith(fakeInner().agent, async () => sse(['嗯。']), { speculate: false });
  plain.attachLiveSink(() => {});
  const delegated = await plain.reply('查到了吗');
  assert.equal(delegated.speech, '慢车道答复。');
});

test('发起任务的句子不算状态询问', () => {
  for (const text of ['帮我查一下订单', '请查一下天气', '给我看看现在几点']) {
    assert.equal(isStatusQuestion(text), false, text);
  }
  for (const text of ['好了吗', '查到了吗', '还在跑吗', '怎么样了']) {
    assert.equal(isStatusQuestion(text), true, text);
  }
});

test('事实不能混进待同步给 dsh 的注记', async () => {
  const inner = fakeInner();
  let round = 0;
  const agent = agentWith(
    inner.agent,
    async () => sse([`好呀第${++round}句。`]),
    {
      speculate: false,
      keepTurns: 2,
      taskStatus: () => '后台任务：在跑 1 个 —— bash「sleep 20」已跑 12 秒。',
    },
  );
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀');
  await agent.reply('谢谢你');
  await agent.reply('帮我查一下订单');
  const note = inner.calls[0]?.note ?? '';
  assert.ok(note.includes('用户: 你好呀'), note);
  assert.ok(!note.includes('sleep 20'), `注记里不该有后台事实：${note}`);
});
