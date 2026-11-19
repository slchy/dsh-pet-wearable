/**
 * 判停前起跑（`FrontedAgent.prefetch`）。
 *
 * 一句 ASR 定稿时文本就定了，判停器还要再花一拍决定「要不要并下一段」——
 * 这段时间本来完全可以用来跑模型。测四条边界：
 *
 * 1. 文本一字不差 → 认领，**只问一次**模型
 * 2. 预跑已经吐出的字不能丢，也不能乱序（认领时先补推再实时接）
 * 3. 判停并了段 → 预跑作废，按新文本重问，用户只听到新文本的答复
 * 4. 任务类句子不预跑（预跑一律挡在快车道门槛之外，否则就是白花钱）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrontedAgent, acceptsSpeculation } from '../src/fronted-agent.ts';
import { newActivityState, trackActivity } from '../src/keepalive.ts';
import type { AgentProvider, AgentReplyView } from '../src/providers.ts';

function fakeInner(): AgentProvider {
  return {
    name: 'dsh',
    reply: async (): Promise<AgentReplyView> => ({ text: '慢车道答复。', speech: '慢车道答复。' }),
    attachLiveSink: () => {},
  };
}

function sse(tokens: string[]): Response {
  const body = tokens
    .map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeAgent(fetchImpl: typeof fetch): FrontedAgent {
  return new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl,
    speculate: false,
    log: () => {},
  });
}

test('定稿先起跑：文本没变就认领，模型只被问一次', async () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['[平静]', '在呢哥。']);
  });

  agent.prefetch('你好呀');
  const reply = await agent.reply('你好呀');

  assert.equal(asked, 1, '预跑已经问过了，reply 不该再问一遍');
  assert.equal(reply.speech, '在呢哥。');
});

test('预跑先吐出来的字在认领时补推，不丢也不乱序', async () => {
  const agent = makeAgent(async () => sse(['[平静]', '我在', '呢。']));

  agent.prefetch('你好呀');
  // 等预跑把整句吐完 —— 这时还没有接收方，字全在缓冲里
  await new Promise((resolve) => setTimeout(resolve, 60));

  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });
  await agent.reply('你好呀');

  assert.equal(seen.join(''), '[平静]我在呢。', '缓冲的字必须按原顺序补推给 TTS（标签由 TTS 侧清洗）');
});

test('预跑认领**之后**才到的增量也要接到 TTS（不能只补历史那些）', async () => {
  // 这条钉的是「prefetch 的 slot 被换成了拷贝」那个 bug：`ask()` 的闭包捕获的是原对象，
  // 认领时若 `{ ...slot }`，listener 只装在拷贝上，后来的增量全堆进 buffered 没人取 ——
  // TTS 收到空文本、每轮退回整段合成，白付 300–500 ms。旧测试因为「答案在认领前就吐完」漏了它。
  const agent = makeAgent(async () => {
    const enc = new TextEncoder();
    const pieces = ['[平静]', '我在', '呢。'];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const piece of pieces) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  const seen: string[] = [];
  agent.attachLiveSink((text) => { seen.push(text); });
  agent.prefetch('你好呀');
  const reply = await agent.reply('你好呀');

  assert.equal(reply.speech, '我在呢。');
  assert.equal(seen.join(''), '[平静]我在呢。', '认领后逐字到达的增量必须实时推给 TTS');
});

test('判停并了段：预跑作废，按并完的新文本重问', async () => {
  const asked: string[] = [];
  const agent = makeAgent(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const last = body.messages[body.messages.length - 1]?.content ?? '';
    asked.push(last);
    return sse([`[平静]答的是${last}`]);
  });

  agent.prefetch('谢谢你');
  const reply = await agent.reply('谢谢你啦');

  assert.deepEqual(asked, ['谢谢你', '谢谢你啦'], '预跑一次 + 改文本后重问一次');
  assert.equal(reply.speech, '答的是谢谢你啦', '用户只能听到新文本的答复');
});

test('预跑只剩形态门槛：含数字/超长不预跑，语义交给模型', () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['不该被问到。']);
  });

  // 2026-11-19 起不再按词挡「帮我查一下订单」这类句子 —— 那是模型的语义判断，
  // 它会在流里输出 [[DELEGATE]]，预跑那趟作废即可。本地只挡形态不合格的。
  agent.prefetch('订单号是W8665881');
  assert.equal(asked, 0, '含阿拉伯数字 → 形态挡掉，预跑白花钱');
});

// ---------------------------------------------------------------- 生产装配
//
// `trackActivity` 是每个可选能力的**显式转发表**：漏一条就是静默降级，
// 而且不留任何日志（P0-2 的 `cancelTurn` 就是这么丢的，这次 `prefetch` 又丢了一次）。

test('trackActivity 必须转发 prefetch（漏了就是每次白等判停）', () => {
  const agent = makeAgent(async () => sse(['[平静]在呢哥。']));
  const tracked = trackActivity(agent, newActivityState(Date.now()));
  assert.equal(typeof tracked.prefetch, 'function', '不转发 = 宿主调不到，静默降级');
  assert.equal(
    typeof tracked.speculatePartial,
    'function',
    '中间结果投机同样要转发，否则少抢 500–1200 ms 而且日志里一行都没有',
  );

  tracked.prefetch?.('你好呀');
  tracked.speculatePartial?.('你好呀你知');
  assert.ok(true);
});

test('预跑的判据要与 reply() 同源：长期事实那句压根不该起跑', () => {
  let asked = 0;
  const agent = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl: async () => { asked += 1; return sse(['[平静]不该用上。']); },
    speculate: false,
    log: () => {},
  });
  agent.prefetch('我叫小明');
  assert.equal(asked, 0, '「我叫…」要交给 dsh 自己记，预跑纯属白花钱');
});

test('带图那一轮不走快车道：已起跑的预跑要作废，不能被认领', async () => {
  let asked = 0;
  const agent = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl: async () => { asked += 1; return sse(['[平静]不该用上。']); },
    speculate: false,
    log: () => {},
  });
  // 定稿时还没有图，按闲聊起跑
  agent.prefetch('谢谢你');
  const reply = await agent.reply('谢谢你', { mimeType: 'image/jpeg', data: 'AA==' });
  assert.equal(reply.speech, '慢车道答复。', '带图一律交 dsh');
  assert.equal(asked, 1, '只发了预跑那一次，没有第二次');
});

test('FAST_LANE_PREFETCH=0 就完全不预跑（A/B 对照用）', () => {
  let asked = 0;
  const withSwitch = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl: async () => { asked += 1; return sse(['在呢。']); },
    speculate: false,
    prefetch: false,
    log: () => {},
  });
  withSwitch.prefetch('你好呀');
  assert.equal(asked, 0, '关了就不该发请求');
});

test('prefetch 的返回值就是「这一趟已经在跑了」——宿主靠它决定要不要预开 TTS task', () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['在呢。']);
  });

  assert.equal(agent.prefetch('你好呀'), true, '起跑一次 → true');
  assert.equal(agent.prefetch('你好呀'), true, '同一句再报一次也是 true（那一趟确实在跑）');
  assert.equal(agent.prefetch('订单号是W8665881'), false, '形态不合格 → false（TTS 也不该预开）');
  assert.equal(asked, 1, '只有第一次真的发了请求');

  const withSwitch = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl: async () => sse(['在呢。']),
    speculate: false,
    prefetch: false,
    log: () => {},
  });
  assert.equal(withSwitch.prefetch('你好呀'), false, '开关关掉 → false');
});

test('并段的真实顺序：短句先起跑，长句到来时顶掉它，只答一次', async () => {
  const asked: string[] = [];
  const agent = makeAgent(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const last = body.messages[body.messages.length - 1]?.content ?? '';
    asked.push(last);
    return sse([`[平静]答的是${last}`]);
  });

  // 真机顺序：addSentence 两次 → prefetch 两次 → 最后 reply 一次（文本是并完的）
  agent.prefetch('谢谢你');
  agent.prefetch('谢谢你啦');
  const reply = await agent.reply('谢谢你啦');

  assert.deepEqual(asked, ['谢谢你', '谢谢你啦'], '短句那次被顶掉，长句重新起跑');
  assert.equal(reply.speech, '答的是谢谢你啦', '用户只会听到并完的那一句');
});

// ---------------------------------------------------------------- 中间结果投机
//
// partial 比定稿早 p50 731 ms（真机 47 轮），拿它先问出去能藏在「等定稿」里。
// 但 partial 在句末会大改（26% 的轮跟定稿连前缀关系都没有），所以定稿确认是
// 前缀才认领 —— 这批用例钉的就是那道闸门。

test('投机闸门：只有「去标点后完全一致」才认', () => {
  // 2026-11-19 收紧：以前是「前缀 + 覆盖 ≥60%」，但逐轮 dump 出来，被放过的
  // 那一半缺的正是宾语（「对呀，那你知道」←「那你知道蓝母吗？」），模型只能反问。
  const cases: Array<[string, string, boolean, string]> = [
    ['喂，你好，我想改一下订单的收货地址。', '喂，你好，我想改一下订单的收货地址。', true, '完全一致'],
    ['喂，你好，我想改一下订单的收货地址', '喂，你好，我想改一下订单的收货地址？', true, '尾标点先剥掉'],
    // —— 下面这些在旧门槛下会被认，现在一律不认（这就是收紧要的）——
    ['你好，我想改一下订单', '你好，我想改一下订单的收货地址。', false, '前缀 62%，但缺「的收货地址」'],
    ['台词的经典是台词是什么？', '台词的经典是台词是什么来着？', false, '旧的 79% 认领点；缺「来着」'],
    ['你看过星球大战吗？', '你看过星球大战吗？你知道吗？', false, '定稿更长'],
    ['对，我想改成6', '对，我想改成6414。', false, '数字被截断——看着合法，其实已经错了'],
    ['订单号是挺号W8665881', '订单号是#井号W8665881，我想改成…', false, 'ASR 改写：连前缀都不是'],
    // —— 长度门槛仍然生效（`SPEC_MIN_CHARS=6`）——
    ['喂，', '喂，', false, '太短（碎片问出去只会挨一句「你再说一遍」）'],
    ['你退下吧。', '你退下吧。', false, '4 字仍低于最小字数'],
  ];
  for (const [spec, final, want, why] of cases) {
    assert.equal(acceptsSpeculation(spec, final), want, `${why}：${spec} → ${final}`);
  }
});

test('投机：定稿确认是同一句 → 认那一趟，不再重复问模型', async () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['[平静]', '在呢哥。']);
  });

  agent.speculatePartial('你好呀你知道吗');
  assert.equal(asked, 1, '中间结果一到就该发出去');

  // 定稿只多一个标点（`stripPartialTail` 之后的文本一字不差）→ 认
  agent.prefetch('你好呀你知道吗？');
  assert.equal(asked, 1, '定稿确认了这份投机，不该重问');

  const reply = await agent.reply('你好呀你知道吗？');
  assert.equal(asked, 1, 'reply 认领同一趟');
  assert.equal(reply.speech, '在呢哥。');
});

test('投机：定稿对不上 → 作废并按定稿重问', async () => {
  const asked: string[] = [];
  const agent = makeAgent(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const last = body.messages[body.messages.length - 1]?.content ?? '';
    asked.push(last);
    return sse([`[平静]答的是${last}`]);
  });

  agent.speculatePartial('你好呀你知道吗');
  agent.prefetch('喂喂喂喂喂喂');
  const reply = await agent.reply('喂喂喂喂喂喂');

  assert.deepEqual(asked, ['你好呀你知道吗', '喂喂喂喂喂喂'], '猜错了就退回定稿后再问');
  assert.equal(reply.speech, '答的是喂喂喂喂喂喂');
});

test('投机：一句话最多起跑两次，中间结果被改写就收掉', async () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['[平静]在呢哥。']);
  });

  agent.speculatePartial('你好呀你知道吗');
  assert.equal(asked, 1);
  // 只多一个语气词（覆盖 7/8 = 88%）→ **沿用**，不为多的字重起
  agent.speculatePartial('你好呀你知道吗呢');
  assert.equal(asked, 1, '覆盖够就别重起，重来会把已经跑的时间扔掉');
  // 覆盖掉到 60% 以下 → 才允许重起一次
  agent.speculatePartial('你好呀你知道吗呢啊嗯那个事情');
  assert.equal(asked, 2);
  // 配额用满（2/2）后再变长：覆盖够就沿用，**不消耗**配额
  agent.speculatePartial('你好呀你知道吗呢啊嗯那个事情啊');
  assert.equal(asked, 2, '沿用不消耗配额');

  // 被改写（不是变长）→ 收掉，且不重发
  agent.speculatePartial('你号呀你知道吗呢啊嗯那个事情啊');
  assert.equal(asked, 2, '改写说明 ASR 在纠错，早期那版大概率对不上定稿');
});

test('投机：太短的中间结果一个请求都不发', () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['在呢。']);
  });
  for (const partial of ['喂', '喂，', '那。']) agent.speculatePartial(partial);
  assert.equal(asked, 0);
});

test('投机：默认门槛 6 —— 2–3 字的短句不发请求', () => {
  // 曾经降到 2（想在 2–5 字短句上把 agent 藏进 ①），真机向量 14 场回放测下来
  // 请求涨 2.5 倍、端到端 p50 没动，已退回 6（见 docs/OPS-RECORD.md §12.8）。
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['在呢。']);
  });
  agent.speculatePartial('你好');
  assert.equal(asked, 0, '默认 specMinChars=6，2 个字不发');
  agent.speculatePartial('你好呀你知道吗');
  assert.equal(asked, 1, '够 6 个字才发');
});

test('投机：specMinChars 调小到 2 才会让 2–3 字的短句起跑', () => {
  let asked = 0;
  const agent = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl: async () => {
      asked += 1;
      return sse(['在呢。']);
    },
    speculate: false,
    specMinChars: 2,
    log: () => {},
  });
  agent.speculatePartial('你好');
  assert.equal(asked, 1, 'minChars=2 时 2 个字就发');
  agent.speculatePartial('那。');
  assert.equal(asked, 1, '剥掉句尾标点后只剩 1 字，仍然不发');
});

test('投机：门槛只管「发不发」，认领规则一个字没动', () => {
  // 3 字能过 minChars=2 这道门槛，但覆盖不到定稿的 60% —— 仍然不许认领。
  assert.equal(acceptsSpeculation('改成', '改成641室。'), false, '覆盖率 29%，不许认');
  assert.equal(
    acceptsSpeculation('改成', '改成641室。', 2),
    false,
    'specMinChars 调小也不能让低覆盖的猜测被认下',
  );
  assert.equal(
    acceptsSpeculation('你好', '你好。', 2),
    true,
    '2 字、前缀、覆盖 67% → 认（但默认门槛下它压根发不出去）',
  );
});

test('投机已跑起来时，更长的 partial 不该重起（覆盖够就沿用）', () => {
  // 真机 `20261119-080409` 轮 11：投机提前 1370 ms 发出，ASR 又补了一版等于定稿的
  // partial，被判成「判停并了段」重起 —— 开轮时站在起跑线上的那趟只跑了 2 ms。
  // 认领门槛本来就是覆盖 ≥ 60%，所以照旧那版问出来的答案与新文本重问一样。
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['在呢。']);
  });

  agent.speculatePartial('你喜欢三体里');
  assert.equal(asked, 1, '中间结果先跑起来');

  // 6 → 10 字：覆盖 60%，正好卡在门槛上 → 沿用那一趟
  agent.speculatePartial('你喜欢三体里面哪个人');
  assert.equal(asked, 1, '覆盖够 → 不重起');

  // 6 → 11 字：覆盖 55% < 60%，这时必须重问，旧的那版答不了新问题
  agent.speculatePartial('你喜欢三体里面哪个人物');
  assert.equal(asked, 2, '覆盖不够 → 重起');
});

test('投机：与预跑同一组形态门槛（语义不归本地管）', () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['不该被问到。']);
  });
  agent.speculatePartial('订单号是W8665881');
  assert.equal(asked, 0, '含阿拉伯数字 → 形态挡掉，投机纯属白花钱');
});

// ---------------------------------------------------------------- 对冲
//
// 首字方差全在「等响应头」（实测 130–430，提示词/历史/缓存都排除了），
// 所以并发发 N 份抢最先回来的那份 —— 落败的必须在拿到响应头前被掐掉。

test('对冲：取最先回来的那份，落败的被 abort', async () => {
  const aborted: number[] = [];
  let calls = 0;
  const agent = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    hedge: 2,
    speculate: false,
    log: () => {},
    fetchImpl: ((_url: string, init?: RequestInit) => {
      const idx = calls;
      calls += 1;
      const slow = idx === 0;
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => aborted.push(idx));
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(sse(['[平静]', slow ? '慢的那份' : '快的那份'])), slow ? 200 : 30);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
    }) as unknown as typeof fetch,
  });

  const reply = await agent.reply('你好呀');
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(calls, 2, '应该发了两份');
  assert.equal(reply.speech, '快的那份', '取最先回来的');
  assert.ok(aborted.includes(0), '落败的那份要被 abort');
});

test('对冲：两份都失败才算失败', async () => {
  let calls = 0;
  const agent = new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    hedge: 2,
    speculate: false,
    log: () => {},
    fetchImpl: (async () => { calls += 1; return new Response('boom', { status: 500 }); }) as unknown as typeof fetch,
  });

  const reply = await agent.reply('你好呀');
  assert.equal(calls, 2, '两份都发了');
  assert.equal(reply.speech, '慢车道答复。', '全失败就退回 dsh，不能哑');
});
