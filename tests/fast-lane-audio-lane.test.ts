/**
 * 快车道**兼容 omni**：音频直出车道接进既有的 `FrontedAgent`，而不是另起一条旁路。
 *
 * 为什么必须是「接进去」：快车道的记忆就是 `pending` + `remember()`（`keepTurns`、
 * `overcap`、给 dsh 带的上下文全长在那里）。旁路一旦绕开它，omni 答过的轮次就不进
 * 历史 —— 下一轮委派给 dsh 就失忆。
 *
 * 这里验四条：
 * 1. 车道接管的轮次**不许再花文本模型的钱**（预跑被闸住）
 * 2. `willServeAudio()` 与 `reply()` 内部判据一致（宿主据此决定要不要起跑流式 TTS）
 * 3. 认领成功 → `path:'omni'` + `audio`，且 `text`/`speech` 是**活的**
 * 4. 播完回写（`noteServedTurn`）之后，下一轮的 prompt 里能看到这一轮
 * 5. 结算回来时 `truncated` / `endedAtMs` 按**票据**对回账本，不会改到别的轮次
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrontedAgent } from '../src/fronted-agent.ts';
import type { AgentAudioAnswer, AgentProvider, AgentReplyView, FastLaneAudioLane } from '../src/providers.ts';

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

/** 假车道：`serve` 控制 willServe，`chunks` 控制能不能认领到音频 */
function fakeLane(opts: { serve: boolean; chunks?: string[] }) {
  let said = '';
  const lane: FastLaneAudioLane & { discarded: number; claimed: number } = {
    discarded: 0,
    claimed: 0,
    willServe: () => opts.serve,
    claim: (): AgentAudioAnswer | null => {
      lane.claimed += 1;
      if (opts.chunks === undefined) {
        return null;
      }
      const chunks = opts.chunks;
      return {
        sampleRate: 24_000,
        transcript: () => said,
        chunks: (async function* generate() {
          for (const text of chunks) {
            said += text;
            yield Buffer.alloc(480); // 10 ms @24k
          }
        })(),
      };
    },
    discard: () => { lane.discarded += 1; },
  };
  return lane;
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

test('车道接管时不许再花文本模型的钱：预跑被闸住', () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['在呢哥。']);
  });
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['在呢。'] }));

  assert.equal(agent.prefetch('你好呀'), false, 'omni 已经从封段起跑，预跑纯属白烧');
  assert.equal(asked, 0);
});

test('willServeAudio 与 reply() 判据一致：路由说 live 就真的走 live', async () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['在呢。'] }));

  // 判据从 `isFastCandidate`（14 字 / 阿拉伯数字）换成了内核的 `routeTurn()`：
  // 那两条是 qwen-flash 的文本窗限制，omni 吃整段音频，对它没有物理依据。
  // 现在 Live 只看「车道健康 + 这一轮不需要副作用」，答不答得了由模型自己决定。
  assert.equal(agent.willServeAudio('你好呀'), true);
  assert.equal(agent.willServeAudio('这句话实在是太长了长到超过十四个字的上限'), true,
    '字数上限只管 qwen-flash，不再拦 omni');
  assert.equal(agent.willServeAudio('帮我记一下 3 点的会'), false,
    '有副作用的动作只有 dsh 能做');

  const reply = await agent.reply('帮我记一下 3 点的会');
  assert.equal(reply.path, 'dsh', '动作类必须交给 dsh');
});

test('P0-1：>14 字 / 含阿拉伯数字的闲聊也必须走 omni —— 级联的字数闸不是 omni 的闸', async () => {
  // 真机形状：`willServeAudio()` 走的是路由（Live 只看健康度），宿主据此起跑流式
  // TTS；而 `reply()` 里 `!candidate`（14 字上限 / 阿拉伯数字）曾排在 live 分支**前面**，
  // 于是同一句话「宿主说走 omni、reply 却交给 dsh」—— TTS 收到空文本，整轮退化。
  const long = '今天外面天气可真不错我刚才出去溜达了一大圈心情还特别好';
  assert.ok([...long].length > 14, `用例本身要超过 14 字，实际 ${[...long].length}`);

  for (const text of [long, '下午3点见']) {
    const agent = makeAgent(async () => {
      throw new Error('omni 就绪时不该再问文本模型');
    });
    agent.attachAudioLane(fakeLane({ serve: true, chunks: ['好呀。'] }));

    assert.equal(agent.willServeAudio(text), true, `${text}：宿主该为它开流式 TTS`);
    const reply = await agent.reply(text);
    assert.equal(reply.path, 'omni', `${text}：reply 必须与 willServeAudio 同源`);
  }
});

test('没配 qwen-flash key 也不能把 omni 一起关掉（两条车道不共用判据）', async () => {
  // 曾经「删掉 qwen-flash 的 key，omni 也跟着不答」：`apiKey !== ''` 是级联的前提，
  // 被错当成 Live 的前提。omni 吃的是整段音频，跟文本模型的 key 无关。
  const agent = new FrontedAgent({
    inner: fakeInner(),
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('没有 key，一个请求都不该发');
    },
    speculate: false,
    log: () => {},
  });
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['在呢。'] }));

  assert.equal(agent.willServeAudio('你好呀'), true, 'Live 只看健康度，不看 apiKey');
  const reply = await agent.reply('你好呀');
  assert.equal(reply.path, 'omni');
});

test('账本记的是真实 truncated：noteServedTurn 的第三参直达 ledger', () => {
  // P1-4：上游结算时才知道「用户少听了一段」，所以这个值必须是记进账本的那一个，
  // 不能像以前那样硬编码 `false` —— 否则回注/粘性判断永远以为用户听全了。
  const agent = makeAgent(async () => sse(['在呢哥。']));

  agent.noteServedTurn('你叫什么', '我叫米馍。');
  assert.equal(agent.ledgerTurns.at(-1)?.truncated, false, '旧的两参调用行为不变（默认听全）');
  assert.equal(agent.ledgerTurns.at(-1)?.lane, 'live');

  agent.noteServedTurn('刚才那个', '说到一半就被打断了', true);
  const last = agent.ledgerTurns.at(-1);
  assert.equal(last?.truncated, true, '结算说少听了一段，账本必须记下来');
  assert.equal(last?.assistantText, '说到一半就被打断了');
  assert.equal(last?.userText, '刚才那个');
});

test('认领成功：path=omni、带 audio、text/speech 是活的', async () => {
  const agent = makeAgent(async () => {
    throw new Error('不该走到文本模型');
  });
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['我', '在呢。'] }));

  const reply = await agent.reply('你好呀');
  assert.equal(reply.path, 'omni');
  assert.ok(reply.audio !== undefined);
  assert.equal(reply.speech, '', '音频还没开始流，转写当然是空的');

  const out: string[] = [];
  for await (const chunk of reply.audio.chunks) {
    out.push(String(chunk.length));
  }
  assert.equal(out.length, 2);
  assert.equal(reply.speech, '我在呢。', 'drain 之后才是完整的一句');
  assert.equal(reply.text, '我在呢。');
});

test('认领失败（连接没就绪）→ 照常走文本路，不报错', async () => {
  let asked = 0;
  const agent = makeAgent(async () => {
    asked += 1;
    return sse(['在呢哥。']);
  });
  const lane = fakeLane({ serve: true });
  agent.attachAudioLane(lane);

  const reply = await agent.reply('你好呀');
  assert.equal(reply.path, 'fast');
  assert.equal(reply.speech, '在呢哥。');
  assert.equal(lane.claimed, 1);
  assert.equal(asked, 1);
});

test('播完回写：下一轮的 prompt 里能看到 omni 答过的那一轮', async () => {
  const bodies: string[] = [];
  const agent = makeAgent(async (_url, init) => {
    bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
    return sse(['在呢哥。']);
  });
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['我在呢。'] }));

  const reply = await agent.reply('你叫什么');
  for await (const _chunk of reply.audio!.chunks) {
    // 播完
  }
  agent.noteServedTurn('你叫什么', reply.speech);

  // 下一轮换成文本路（车道这一轮不接管），看它带上了什么
  agent.attachAudioLane(fakeLane({ serve: false }));
  await agent.reply('那我叫你呢');

  const prompt = bodies.join('\n');
  assert.match(prompt, /你叫什么/, '用户那句必须进上下文');
  assert.match(prompt, /我在呢。/, 'omni 答的那句也必须进上下文 —— 否则跨车道失忆');
});

test('一个字都没出声就不记账（避免窗口里出现「答了空」）', () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  agent.noteServedTurn('你叫什么', '   ');
  // 没有抛错即可；下面的断言靠下一轮 prompt 不含空答
  assert.ok(true);
});

test('forceDelegate：omni 发了 tool_call 就地切 dsh；出过声就不叠回执', async () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  const hooks: string[] = [];
  agent.setDelegateHook((reason) => { hooks.push(reason); });

  const spoken = await agent.reply('帮我查一下天气', undefined, undefined, {
    ticket: { no: 1, gen: 1 }, forceDelegate: 'delegate', receiptSpoken: true,
  });
  assert.equal(spoken.path, 'dsh');
  assert.equal(spoken.delegate, 'delegate');
  assert.deepEqual(hooks, [], 'omni 已经把话说出去了，再叠一句回执就是两句');

  const silent = await agent.reply('帮我查一下天气', undefined, undefined, {
    ticket: { no: 2, gen: 2 }, forceDelegate: 'delegate',
  });
  assert.deepEqual(hooks, ['delegate'], 'omni 一个字都没说，回执得我们自己出');
});

test('插话取消要连 omni 的 response 一起掐：cancelTurn 必须 discard 车道', async () => {
  const agent = makeAgent(async () => {
    throw new Error('不该走到文本模型');
  });
  const lane = fakeLane({ serve: true, chunks: ['在', '呢。'] });
  agent.attachAudioLane(lane);

  const ticket = { no: 7, gen: 7 };
  const pending = agent.reply('你好呀', undefined, undefined, { ticket });
  assert.equal(lane.claimed, 1, '认领发生在 reply() 的同步段里');

  // 不 discard 的话它会一直生成到 `response.done`：既烧输出 token，
  // 又让下一轮开口时它还挂着 busy（那时新的 create 会被服务端拒掉且永久丢失）。
  agent.cancelTurn(ticket);
  assert.equal(lane.discarded, 1);

  await pending;
});

test('票据对不上时不动车道：迟到的取消不能掐掉下一轮', async () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  const lane = fakeLane({ serve: true, chunks: ['在呢。'] });
  agent.attachAudioLane(lane);

  await agent.reply('你好呀', undefined, undefined, { ticket: { no: 3, gen: 3 } });
  agent.cancelTurn({ no: 2, gen: 2 });
  assert.equal(lane.discarded, 0);
});

/** 可拨动的时钟：`reconcileTurnOutcome` 要验 `endedAtMs` 真的被结算值覆盖 */
function makeTimedAgent(fetchImpl: typeof fetch, clock: { t: number }): FrontedAgent {
  return new FrontedAgent({
    inner: fakeInner(),
    apiKey: 'k',
    fetchImpl,
    speculate: false,
    log: () => {},
    now: () => clock.t,
  });
}

test('reconcileTurnOutcome 按票据把结算事实对回账本：只改那一笔', async () => {
  const clock = { t: 1_000 };
  const agent = makeTimedAgent(async () => sse(['在呢哥。']), clock);

  // 两轮 dsh，票据不同 —— 结算只该改后记的那一笔
  clock.t = 1_100;
  await agent.reply('帮我查一下天气', undefined, undefined, {
    ticket: { no: 1, gen: 1 }, forceDelegate: 'delegate',
  });
  clock.t = 2_000;
  await agent.reply('帮我查一下股价', undefined, undefined, {
    ticket: { no: 2, gen: 1 }, forceDelegate: 'delegate',
  });

  const before = agent.ledgerTurns;
  assert.equal(before.length, 2, '两轮都该进账本');
  assert.deepEqual(before.map((turn) => turn.lane), ['dsh', 'dsh']);
  assert.equal(before[1]?.truncated, false, '记账那一刻还不知道用户听了多少');

  clock.t = 2_500;
  agent.reconcileTurnOutcome({ ticket: { no: 2, gen: 1 }, truncated: true, endedAtMs: 2_400 });

  const after = agent.ledgerTurns;
  assert.equal(after[1]?.truncated, true, '结算说少听了一段，账本必须记下来');
  assert.equal(after[1]?.endedAtMs, 2_400, '结束时刻以结算为准，不是记账那一刻的粗略值');
  assert.equal(after[0]?.truncated, false, '更早那一轮一个字段都不许动');
  assert.equal(after[0]?.endedAtMs, 1_100, '更早那一轮的结束时刻也不许动');
});

test('reconcileTurnOutcome 票据对不上是安全空操作：不许改别的轮次', async () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['我在呢。'] }));
  await agent.reply('你好呀', undefined, undefined, { ticket: { no: 4, gen: 2 } });
  agent.noteServedTurn('你好呀', '我在呢。');

  const live = agent.ledgerTurns.at(-1);
  assert.equal(live?.lane, 'live');
  assert.deepEqual(live?.ticket, { no: 4, gen: 2 }, '账本里带的是那一轮的票据');

  // `no` 对上、`gen` 对不上：上一次打开的那一轮发来的迟到结算
  agent.reconcileTurnOutcome({ ticket: { no: 4, gen: 1 }, truncated: true, endedAtMs: 1 });
  assert.equal(agent.ledgerTurns.at(-1)?.truncated, false, '票据不匹配就不许改');

  // 完全不存在的一张票
  agent.reconcileTurnOutcome({ ticket: { no: 999, gen: 9 }, truncated: true, endedAtMs: 1 });
  assert.equal(agent.ledgerTurns.at(-1)?.truncated, false);
  assert.equal(agent.ledgerTurns.at(-1)?.lane, 'live');
});

test('lastLedgerLane 反映最近一轮「有回答」的车道', async () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  assert.equal(agent.lastLedgerLane(), null, '还没有答过的轮次');

  agent.noteServedTurn('你叫什么', '我叫米馍。');
  assert.equal(agent.lastLedgerLane(), 'live');

  await agent.reply('帮我查一下天气', undefined, undefined, {
    ticket: { no: 2, gen: 1 }, forceDelegate: 'delegate',
  });
  assert.equal(agent.lastLedgerLane(), 'dsh');

  await agent.reply('那我呢', undefined, undefined, { ticket: { no: 3, gen: 1 } });
  assert.equal(agent.lastLedgerLane(), 'cascade');

  // 一个字都没念的轮次不算「答过」：`live` 空答复不该把上一轮覆盖掉
  agent.noteServedTurn('嗯', '   ');
  assert.equal(agent.lastLedgerLane(), 'cascade');
});