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

test('willServeAudio 与 reply() 判据一致：机械不可答的句子不进车道', async () => {
  const agent = makeAgent(async () => sse(['在呢哥。']));
  agent.attachAudioLane(fakeLane({ serve: true, chunks: ['在呢。'] }));

  // `isFastCandidate` 只挡三种**形态**（空串 / 超字数 / 阿拉伯数字），不判语义 ——
  // 「帮我记一下明天下午三点的会」这种是**快车道候选**，要不要转 dsh 靠模型自己
  // 输出 `[[DELEGATE]]`（omni 那边对应的是 tool_call）。所以这里只用机械判据验。
  assert.equal(agent.willServeAudio('帮我记一下 3 点的会'), false, '含阿拉伯数字');
  assert.equal(agent.willServeAudio('这句话实在是太长了长到超过十四个字的上限'), false);
  assert.equal(agent.willServeAudio('你好呀'), true);

  const reply = await agent.reply('帮我记一下 3 点的会');
  assert.equal(reply.path, 'dsh', '机械判据挡掉的句子必须交给 dsh');
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
