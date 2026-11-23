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

import {
  awaitsReply,
  FrontedAgent,
  isFastCandidate,
  isStatusQuestion,
  looksLikeAnswer,
  looksMemorable,
} from '../src/fronted-agent.ts';
import { trackActivity } from '../src/keepalive.ts';
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

/** 内层（dsh）慢吞吞的：用来测「那一轮还在飞的时候取消」 */
function slowInner(ms: number): FakeInner {
  const inner = fakeInner();
  return {
    agent: {
      ...inner.agent,
      reply: async (text, image, note) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return inner.agent.reply(text, image, note);
      },
    },
    calls: inner.calls,
    push: inner.push,
  };
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

test('判据只做形态判断：不再按关键词分流', () => {
  // 曾经「看 / 怎么 / 为什么 / 哪」一票否决，真机 92 轮里有 25 轮因此走进 dsh
  // （每轮还垫一句回执，用户以为快模型罢工）。现在这些都交给模型的语义判断。
  for (const text of [
    '你看过星球大战没？', '你今天怎么样啊？', '为什么？', '为什么他们呢？',
    '你觉得星球大战怎么样？', '今天天气怎么样', '外面下雨吗', '几点了',
    '帮我查一下订单', '把电话挂断。', '我的手机号是多少？',
  ]) {
    assert.equal(isFastCandidate(text), true, `形态上没问题就该让模型判语义：${text}`);
  }
  // 只剩两条硬边界：太长、含阿拉伯数字
  assert.equal(isFastCandidate('我觉得你今天特别好看而且心情看起来也很好呀'), false, '超 14 字交给 dsh');
  assert.equal(isFastCandidate('订单号是W8665881'), false, '数字必须精确，不让模型转述');
  assert.equal(isFastCandidate('等于多少？'), true, '不含阿拉伯数字 —— 由模型决定算不算需要工具');
  assert.equal(isFastCandidate(''), false);
});

test('判据：闲聊候选 vs 任务请求', () => {
  for (const text of ['你好呀', '谢谢你', '我可想你了', '你是谁', '你叫什么名字']) {
    assert.equal(isFastCandidate(text), true, `该走快车道：${text}`);
  }
  for (const text of [
    '订单号是W8665881',
    '我觉得你今天特别好看而且心情看起来也很好呀',
  ]) {
    assert.equal(isFastCandidate(text), false, `不该走快车道：${text}`);
  }
});

test('本地判据不再管词 —— 「几点了」也放给模型判（它会 [[DELEGATE]]）', () => {
  assert.equal(isFastCandidate('你叫什么名字'), true);
  assert.equal(isFastCandidate('你好呀今天'), true);
  // 2026-11-19 起不再按词挡：实时事实由 `SYSTEM_PROMPT` 的语义规则约束，
  // 模型拿不准就输出 [[DELEGATE]]，本地只留形态边界（长度 / 阿拉伯数字）。
  assert.equal(isFastCandidate('几点了'), true);
});

test('模型判 [[DELEGATE]] 时交给 dsh，一个字的正文都不出', async () => {
  const inner = fakeInner();
  let asked = 0;
  const agent = agentWith(inner.agent, async () => {
    asked += 1;
    return sse(['[[DELEGATE]]']);
  });
  const reply = await agent.reply('订单查到哪了');
  assert.equal(asked, 1, '本地不再按词挡 —— 是模型自己判的委派');
  assert.equal(reply.path, 'dsh');
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

test('投机：被取消的慢车道以 reject 收场时不能带走进程', async () => {
  // 线上真出现过：快车道先开口 → 掐掉在途 dsh 那一轮 → 取消后 dsh 没有可念的文本，
  // `VoiceAgent.reply` 抛错 → 这一轮已经没人 await 了 → 未捕获 rejection → harness 退出。
  let rejectInner: ((error: Error) => void) | null = null;
  const inner: AgentProvider = {
    name: 'dsh',
    reply: () => new Promise<AgentReplyView>((_resolve, reject) => { rejectInner = reject; }),
    cancelTurn: () => { rejectInner?.(new Error('清洗后没有可朗读的内容')); },
    attachLiveSink: () => {},
  };
  const agent = agentWith(
    inner,
    async () => slowSse(['我', '在', '呢', '。'], 15),
    { speculate: true },
  );
  agent.attachLiveSink(() => {});

  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
  // 取消发生在第一个字，rejection 在快模型还没说完时就落地了 —— 让它真的跑完
  await new Promise((resolve) => setTimeout(resolve, 80));
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

test('委派轮撞插话：放手让 dsh 说完，不取消（取消只作废下游，活儿白干）', async () => {
  // 真机（第 9、10 轮）：omni 说完垫话转 dsh，用户接着说了一句 → `session/cancel`
  // → dsh 那一轮判成 aborted。可 bash 还在跑（实测取消后 2 s 才结束），
  // 所以丢掉的不是那 10 秒，而是唯一那一步总结 —— 用户一个字都没听到。
  const inner = slowInner(150);
  let cancelled = 0;
  let detached = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
    detachTurn: () => { detached += 1; },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']));
  agent.attachLiveSink(() => {});

    // 第一轮照常走（生产里也是先有一次 reply 才会拿到 forceDelegate 那一轮）
    const ticket = { no: 1, gen: 1 };
    await agent.reply('你好呀', undefined, undefined, { ticket });
    cancelled = 0; // 第一轮快车道胜出时本来就会取消一条投机，不算这一条

    // `receiptSpoken: true` = omni 已经说过垫话（生产里就是这个形态）
    const pending = agent.reply('帮我查一下订单', undefined, undefined, {
      ticket,
      forceDelegate: 'delegate',
      receiptSpoken: true,
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  agent.cancelTurn(ticket);
  await pending;

  assert.equal(detached, 1, 'dsh 那一轮要放手，让它把答案说完');
  assert.equal(cancelled, 0, '取消只会把答案扔掉 —— 上游的活儿已经干过了');
});

test('普通轮撞插话照旧取消（这条边界不能一起放松）', async () => {
  const inner = slowInner(150);
  let cancelled = 0;
  let detached = 0;
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { cancelled += 1; },
    detachTurn: () => { detached += 1; },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']));
  agent.attachLiveSink(() => {});

  const ticket = { no: 1, gen: 1 };
  const pending = agent.reply('帮我查一下订单', undefined, undefined, { ticket });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = cancelled;
  agent.cancelTurn(ticket);
  await pending;

  assert.equal(cancelled, before + 1, '没在委派（dsh 没起）就是普通取消');
  assert.equal(detached, 0);
});

test('取消模式 interrupt 走硬中断而不是 rpc', async () => {
  const inner = slowInner(200);
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

test('快车道赢下的轮次不会在 dsh 那边蒸发（被掐掉的请求不算送达）', async () => {
  // 线上日志：`把缓冲的闲聊轮次补进 dsh 上下文` 紧接着 `path=fast dsh_ms=0.6`
  // —— 注记随一个随后被取消的请求送出，那批轮次在两边都不存在了。
  const inner = slowInner(120);
  let round = 0;
  const agent = agentWith(inner.agent, async () => {
    round += 1;
    return round < 3 ? sse(['[平静]', '我在呢。']) : sse(['[[', 'DELEGATE]]']);
  });
  agent.attachLiveSink(() => {});

  // 两轮闲聊：dsh 那两轮都被快车道掐掉，一批注记也没真正落地
  await agent.reply('你好呀');
  await agent.reply('我可想你了');
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 第三轮模型判委派 → 真的交给 dsh
  const third = await agent.reply('帮我查一下订单');

  assert.equal(third.path, 'dsh');
  const sent = inner.calls.at(-1)?.note ?? '';
  assert.match(sent, /你好呀/, '第一轮必须补进 dsh 的上下文（那两轮 dsh 从没真正收到）');
  assert.match(sent, /我可想你了/, '第二轮也要 —— 顺序不能靠运气');
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
  const inner = slowInner(200);
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: () => { throw new Error('IPC 挂了'); },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']));
  const reply = await agent.reply('你好呀');
  assert.equal(reply.speech, '我在呢。');
});

test('取消一定带着本轮的票据传给下层（由 session 按在途票据丢过期）', async () => {
  const inner = slowInner(200);
  const seen: Array<{ no: number; gen: number } | undefined> = [];
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: (ticket) => { seen.push(ticket); },
  };
  const agent = agentWith(wrapped, async () => sse(['我在呢。']), { speculate: true });
  agent.attachLiveSink(() => {});

  await agent.reply('你好呀', undefined, undefined, { ticket: { no: 3, gen: 7 } });
  assert.deepEqual(seen, [{ no: 3, gen: 7 }], '票据是唯一轮次令牌，必须原样传下去');
});

test('代次已经前进时，旧轮迟到的取消被丢弃', async () => {
  const inner = slowInner(400);
  const seen: Array<{ no: number; gen: number } | undefined> = [];
  const wrapped: AgentProvider = {
    ...inner.agent,
    cancelTurn: (ticket) => { seen.push(ticket); },
  };
  // 两个 token 之间隔 150 ms，好让第二轮插进来
  const agent = agentWith(wrapped, async () => slowSse(['我', '在呢。'], 150) as never);
  agent.attachLiveSink(() => {});

  const first = agent.reply('你好呀', undefined, undefined, { ticket: { no: 1, gen: 1 } });
  // 第二轮先把代次推到 2（`currentGen` 随之更新）
  const second = agent.reply('谢谢你', undefined, undefined, { ticket: { no: 2, gen: 2 } });
  await Promise.all([first, second]);

  assert.ok(
    seen.every((ticket) => ticket?.gen === 2),
    `第 1 轮的取消必须被丢弃，实际收到：${JSON.stringify(seen)}`,
  );
});

test('后台任务状态也要透传给外层（trackActivity 不能漏）', () => {
  const base: AgentProvider = {
    name: 'x',
    reply: async () => ({ text: '', speech: '' }),
    taskStatus: () => '后台任务：无',
  };
  const tracked = trackActivity(base, { inflight: 0, last: 0 });
  assert.equal(tracked.taskStatus?.(), '后台任务：无');
});

test('dsh 上一条在问话：短回话必须交给 dsh，不能被快模型抢答', async () => {
  const inner = fakeInner();
  let fastCalls = 0;
  const agent = agentWith(
    {
      ...inner.agent,
      reply: async () => ({ text: '确认要删这条备忘录吗？', speech: '确认要删这条备忘录吗？' }),
    },
    async () => {
      fastCalls += 1;
      // 第一轮模型判委派（本轮不再有本地任务词表）；「好的」不该再问到快模型
      return fastCalls === 1 ? sse(['[[', 'DELEGATE]]']) : sse(['好呀。']);
    },
    { speculate: false },
  );
  agent.attachLiveSink(() => {});

  const first = await agent.reply('订单查到哪了');
  assert.equal(first.path, 'dsh', '模型判委派 → 交给 dsh');
  const reply = await agent.reply('好的');
  assert.equal(fastCalls, 1, '「好的」是对 dsh 那句问话的回答，不是闲聊');
  assert.equal(reply.speech, '确认要删这条备忘录吗？');
});

test('dsh 上一条不是问话：短回话照旧走快车道（别过度拦）', async () => {
  const inner = fakeInner();
  let fastCalls = 0;
  const agent = agentWith(
    inner.agent,
    async () => {
      fastCalls += 1;
      return fastCalls === 1 ? sse(['[[', 'DELEGATE]]']) : sse(['嗯，我在。']);
    },
    { speculate: false },
  );
  agent.attachLiveSink(() => {});

  await agent.reply('订单查到哪了');
  const reply = await agent.reply('好的');
  assert.equal(fastCalls, 2, '上一句 dsh 不是问话 → 「好的」照旧问快模型');
  assert.equal(reply.path, 'fast');
});

test('暗号前面带了情绪标签也不许播出去', async () => {
  const inner = fakeInner();
  const emitted: string[] = [];
  let fastCalls = 0;
  const agent = agentWith(
    inner.agent,
    async () => { fastCalls += 1; return sse(['[平静]', '[[DELEGATE]]']); },
    { speculate: false },
  );
  agent.attachLiveSink((t) => emitted.push(t));

  const reply = await agent.reply('你叫什么名字');
  assert.equal(fastCalls, 1, '闲聊句会进快车道，暗号由模型判');
  assert.equal(reply.speech, '慢车道答复。');
  assert.deepEqual(emitted, [], '标签和暗号一个字都不能推给 TTS');
});

test('人设与情绪标签：和 dsh 是同一个角色，只是话更短', async () => {
  const inner = fakeInner();
  let system = '';
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'));
      system = (body.messages as Array<{ role: string; content: string }>)
        .find((m) => m.role === 'system')?.content ?? '';
      return sse(['[开心]在呢哥。']);
    },
    { speculate: false },
  );
  agent.attachLiveSink(() => {});

  const reply = await agent.reply('你好呀');
  assert.match(system, /米馍/, '人设要和 dsh 一致');
  assert.match(system, /情绪标签/);
  assert.match(system, /你没有工具/, '快车道不带 tools，必须明说');
  assert.equal(reply.emotion, 'happy', '情绪标签要被解析出来，语音才有语调');
  assert.equal(reply.speech, '在呢哥。');
});

test('审计：agent.ask 落全量 messages，agent.done 落模型原文', async () => {
  // 快车道没有 session log（dsh 那侧有 session.v4.jsonl.zstd）。不落这两条，
  // 「抢话之后模型有没有接上前半句」就无从审计 —— 只剩 console 截断的 120 字。
  const audit: Array<{ name: string; data: Record<string, unknown> }> = [];
  let round = 0;
  const agent = agentWith(
    fakeInner().agent,
    async () => {
      round += 1;
      if (round === 1) return sse(['那少穿点吧。']);
      if (round === 2) return sse(['你说今天热。']);
      if (round === 3) return sse(['[[', 'DELEGATE]]']);
      return sse(['嗯，我在。']);
    },
    { speculate: false, audit: (name, data) => { audit.push({ name, data }); } },
  );
  agent.attachLiveSink(() => {});

  await agent.reply('今天真热。');
  await agent.reply('我说什么来着');

  const asks = audit.filter((a) => a.name === 'agent.ask');
  assert.equal(asks.length, 2, '每次请求都要有一条 ask');
  const msgs = asks[1]?.data['msgs'] as Array<{ role: string; content: string }>;
  assert.ok(Array.isArray(msgs), 'ask 要带全量 messages');
  assert.equal(msgs[0]?.role, 'system');
  assert.deepEqual(
    msgs.slice(1).map((m) => [m.role, m.content]),
    [['user', '今天真热。'], ['assistant', '那少穿点吧。'], ['user', '我说什么来着']],
    '审计里的 messages 必须和真正发出去的一致（含历史窗）',
  );
  assert.equal(asks[1]?.data['kind'], 'live');

  const dones = audit.filter((a) => a.name === 'agent.done');
  assert.equal(dones.length, 2);
  assert.equal(dones[1]?.data['ok'], true);
  assert.equal(dones[1]?.data['raw'], '你说今天热。', 'raw 是模型原文，不是清洗后的');
  assert.equal(typeof dones[1]?.data['first_token_ms'], 'number');
});

test('对话窗口：自己答的和 dsh 答的都以 role 进 messages', async () => {
  const inner = fakeInner();
  const seen: Array<Array<{ role: string; content: string }>> = [];
  let round = 0;
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'));
      seen.push(body.messages as Array<{ role: string; content: string }>);
      round += 1;
      if (round === 1) return sse(['那少穿点吧。']);
      if (round === 2) return sse(['你说今天热。']);
      // 第三轮：模型判委派（本地已无任务词表）
      if (round === 3) return sse(['[[', 'DELEGATE]]']);
      return sse(['嗯，我在。']);
    },
    { speculate: false },
  );
  agent.attachLiveSink(() => {});

  await agent.reply('今天真热。');
  await agent.reply('我说什么来着');

  // 第二轮的 messages：system → user(今天真热) → assistant(那少穿点吧) → user(当前)
  const second = seen[1] ?? [];
  assert.equal(second[0]?.role, 'system');
  assert.deepEqual(
    second.slice(1).map((m) => [m.role, m.content]),
    [['user', '今天真热。'], ['assistant', '那少穿点吧。'], ['user', '我说什么来着']],
  );

  // 走一次 dsh，它说的话也要以 assistant 身份进窗口
  await agent.reply('帮我查一下订单');
  await agent.reply('你好呀');
  const last = seen.at(-1) ?? [];
  assert.ok(
    last.some((m) => m.role === 'assistant' && m.content === '慢车道答复。'),
    'dsh 说的话用户听到了，窗口里必须有',
  );
  assert.ok(last.some((m) => m.role === 'user' && m.content === '帮我查一下订单'));
});

test('窗口按整对裁剪：不留没有提问的回答', async () => {
  const inner = fakeInner();
  const seen: Array<Array<{ role: string; content: string }>> = [];
  const long = '很长的一句回答'.repeat(25); // ~175 字
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'));
      seen.push(body.messages as Array<{ role: string; content: string }>);
      return sse([long]);
    },
    { speculate: false },
  );
  agent.attachLiveSink(() => {});

  // 用户话术都很短（本来就该走快车道），靠长回答把 800 字预算撑爆
  for (let i = 0; i < 6; i += 1) {
    await agent.reply(`${'好'.repeat(3 + i)}呀`);
  }
  const last = seen.at(-1) ?? [];
  assert.ok(last.length <= 1 + 8 + 1, `窗口最多 8 条，实际 ${last.length}`);
  assert.equal(last[0]?.role, 'system');
  assert.equal(last[1]?.role, 'user', '裁完第一句仍然必须是用户提问，不能是孤儿回答');
  assert.equal(last.at(-1)?.role, 'user');
});

test('回话判据：短确认算回答，长句/新话题不算', () => {
  for (const text of ['好的', '嗯', '对。', '不用了谢谢', '确认']) {
    assert.equal(looksLikeAnswer(text), true, text);
  }
  for (const text of ['你叫什么名字', '我姓袁', '今天天气怎么样呀', '']) {
    assert.equal(looksLikeAnswer(text), false, text);
  }
  for (const speech of ['确认要删吗？', '还要别的吗', '你说呢。', '你要删哪条，说个大概内容，我找出来对一下再动手。']) {
    assert.equal(awaitsReply(speech), true, speech);
  }
  for (const speech of ['好的，已经删了。', '我叫米馍', '记下了，明天上午十点开会。']) {
    assert.equal(awaitsReply(speech), false, speech);
  }
});

test('长期记忆只读进系统消息（L1 看得到，但碰不到文件）', async () => {
  const inner = fakeInner();
  let body = '';
  const agent = agentWith(
    inner.agent,
    async (_url, init) => {
      body = String((init as RequestInit | undefined)?.body ?? '');
      return sse(['你姓袁呀。']);
    },
    { speculate: false, memory: (text) => (text.includes('姓') ? ['哥姓袁，称呼袁哥。'] : []) },
  );
  agent.attachLiveSink(() => {});

  const reply = await agent.reply('我姓什么来着');
  assert.equal(reply.speech, '你姓袁呀。');
  const system = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> })
    .messages.find((m) => m.role === 'system')?.content ?? '';
  assert.match(system, /长期记忆（由 dsh 维护，你只能读）/);
  assert.match(system, /哥姓袁/);
});

test('像长期事实的话交给 dsh 亲耳听（注记转述它一次都不写）', async () => {
  const inner = fakeInner();
  let fastCalls = 0;
  const agent = agentWith(
    inner.agent,
    async () => { fastCalls += 1; return sse(['记心里了。']); },
    { speculate: false },
  );
  agent.attachLiveSink(() => {});

  await agent.reply('我姓袁。');
  assert.equal(fastCalls, 0, '记忆只能由 dsh 写，所以这句必须让它自己听');
  assert.equal(inner.calls[0]?.text, '我姓袁。', '用户原话原样交给 dsh，不改写');
});

test('提议判据：长期事实才提议，寒暄不提议', () => {
  for (const text of ['我姓袁。', '记住我不吃香菜', '我住在杭州', '我最喜欢蓝色']) {
    assert.equal(looksMemorable(text), true, text);
  }
  for (const text of ['你好呀', '有点冷', '那我该睡了不', '我姓什么来着', '我叫什么名字', '']) {
    assert.equal(looksMemorable(text), false, text);
  }
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
  assert.match(system, /不要委派/, '还要告诉它问进度别委派');
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

test('禁用委派：提示词不带暗号，模型写出暗号也不转 dsh', async () => {
  // `FAST_LANE_DELEGATE=0` = 快车道只当聊天模型。两件事都要验：
  // 提示词里不能出现 `[[DELEGATE]]`（否则等于把不存在的选项摆到它面前），
  // 而且就算模型自己写出来，也不能当成委派信号。
  const inner = fakeInner();
  let systemMsg = '';
  const agent = new FrontedAgent({
    inner: inner.agent,
    apiKey: 'k',
    speculate: false,
    delegateEnabled: false,
    log: () => {},
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      systemMsg = String((body.messages?.[0] as { content?: string } | undefined)?.content ?? '');
      return sse(['[[', 'DELEGATE]]']);
    }) as unknown as typeof fetch,
  });
  agent.attachLiveSink(() => {});

  const reply = await agent.reply('订单查到哪了');

  assert.ok(!systemMsg.includes('[[DELEGATE]]'), '纯聊天版提示词不该提暗号');
  assert.ok(!systemMsg.includes('委派'), '也不该提「委派」这件事');
  assert.equal(reply.path, 'fast', '禁用委派 → 不转 dsh');
  assert.equal(inner.calls.length, 0, 'dsh 一次都没被问');
});

test('状态询问：本地不再拦，「查到了吗」由模型自己决定答还是委派', async () => {
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

  const reply = await agent.reply('查到了吗');
  assert.equal(reply.path, 'fast', '形态合格 → 照常问快模型');
  assert.equal(asked.length, 1);

  // 模型自己判委派（比如它没有事实可依据）
  const plain = agentWith(fakeInner().agent, async () => sse(['[[', 'DELEGATE]]']), { speculate: false });
  plain.attachLiveSink(() => {});
  const delegated = await plain.reply('查到了吗');
  assert.equal(delegated.speech, '慢车道答复。');
  assert.equal(delegated.path, 'dsh');
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

test('对冲：第 2 份赢的时候，插话取消必须掐得住它', async () => {
  // 对冲是谁先拿回响应头谁赢 —— 实测第 1 份赢的概率约一半（10 轮 5:5）。
  // 取消句柄原来存的是「第 0 份」的 controller，于是胜者是第 1 份时插话取消
  // 打在已经作废的那个上，胜者该吐还吐（服务器上实测又吐了 1921 字节）。
  const signals: AbortSignal[] = [];
  let asked = 0;
  const agent = agentWith(fakeInner().agent, (async (_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    asked += 1;
    if (asked === 1) {
      // 第 1 份：响应头慢，落败
      await new Promise((resolve) => setTimeout(resolve, 300));
      return sse(['慢的那份。']);
    }
    // 第 2 份：立刻给响应头、但整句要几百毫秒才说完 —— 这一份是胜者
    return slowSse(['我', '在', '呢', '。'], 120);
  }) as unknown as typeof fetch, { hedge: 2 });
  agent.attachLiveSink(() => {});

  const reply = agent.reply('你好呀', undefined, undefined, { ticket: { no: 1, gen: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 80));            // 胜者已定、还在吐字
  agent.cancelTurn({ no: 1, gen: 1 });
  // 必须**这一趟还没收尾**就查：`ask()` 的 finally 里会 abortAll，等它跑完再断言
  // 就什么都测不出来了（旧代码也是这么"绿"的）。
  await new Promise((resolve) => setTimeout(resolve, 60));
  const mid = [signals[0]!.aborted, signals[1]!.aborted];
  await reply.catch(() => undefined);

  assert.ok(signals.length >= 2, `对冲应当真的发了两份，实际 ${signals.length}`);
  assert.equal(mid[0], true, '落败的那份要掐掉（省钱）');
  assert.equal(
    mid[1],
    true,
    '★ 胜出的那份也必须被取消掐住 —— 否则插话之后快模型还在生成、继续往 TTS 推字',
  );
});

test('判据搬进内核后对外导出不变：fronted-agent 的转出与 turn-router 是同一个函数', async () => {
  // 拆分（Stage 2A）只搬了实现，**没有搬导出**：外部（含本文件的导入）永远从
  // `fronted-agent.ts` 拿，拿到的必须还是内核里那一个 —— 否则两份实现迟早漂移。
  const router = await import('../src/turn-router.ts');
  const slots = await import('../src/prefetch-slot.ts');
  const agent = await import('../src/fronted-agent.ts');

  assert.equal(looksLikeAnswer, router.looksLikeAnswer);
  assert.equal(looksMemorable, router.looksMemorable);
  assert.equal(agent.looksLikeFollowUp, router.looksLikeFollowUp);
  assert.equal(agent.acceptsSpeculation, slots.acceptsSpeculation);
});

test('「算了」且有活儿在跑：取消那一轮，回一句短的，不再交给 dsh', async () => {
  // 用户显式下令取消是**唯一**会真的取消在跑 dsh 任务的路径：插话只放手
  // （活儿取消不了，答案跑完回注记忆），"不要了"才是取消。
  const inner = fakeInner();
  let cancelled = 0;
  const busyInner: AgentProvider = {
    ...inner.agent,
    dshBusy: () => true,
    cancelTurn: () => { cancelled += 1; },
  };
  const agent = agentWith(busyInner, async () => sse(['不该被问到']));

  const reply = await agent.reply('算了。');
  assert.equal(cancelled, 1, '要真的发出取消，不能只回一句话');
  assert.equal(reply.speech, '好，不查了。');
  assert.deepEqual(inner.calls, [], '取消轮不该再往 dsh 送一轮');
});

test('「算了」但手上没活儿：它就是一句普通闲聊，不要回执也不要乱取消', async () => {
  const inner = fakeInner();
  const idleInner: AgentProvider = {
    ...inner.agent,
    dshBusy: () => false,
    cancelTurn: () => {},
  };
  const agent = agentWith(idleInner, async () => sse(['算就算了吧。']));

  const reply = await agent.reply('算了。');
  assert.notEqual(reply.speech, '好，不查了。', '没有在跑的东西，就别假装替他取消了');
  assert.equal(reply.speech, '算就算了吧。', '照常走快车道/慢车道');
});
