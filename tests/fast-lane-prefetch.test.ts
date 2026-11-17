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

import { FrontedAgent } from '../src/fronted-agent.ts';
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

test('任务类句子不预跑：本地判据就该挡住', () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['不该被问到。']);
  });

  agent.prefetch('帮我查一下订单');
  assert.equal(asked, 0, '要工具的句子预跑纯属白花钱');
});

// ---------------------------------------------------------------- 生产装配
//
// `trackActivity` 是每个可选能力的**显式转发表**：漏一条就是静默降级，
// 而且不留任何日志（P0-2 的 `cancelTurn` 就是这么丢的，这次 `prefetch` 又丢了一次）。

test('trackActivity 必须转发 prefetch（漏了就是每次白等判停）', () => {
  const agent = makeAgent(async () => sse(['[平静]在呢哥。']));
  const tracked = trackActivity(agent, newActivityState(Date.now()));
  assert.equal(typeof tracked.prefetch, 'function', '不转发 = 宿主调不到，静默降级');

  tracked.prefetch?.('你好呀');
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
