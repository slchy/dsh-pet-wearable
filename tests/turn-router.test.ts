import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCancelRequest, routeTurn, type RouteContext } from '../src/turn-router.ts';

const base: RouteContext = { live: 'ready', cascade: true, dshAwaiting: false, lastLane: null };

test('Live 只要健康就接活 —— 与字数/形态无关', () => {
  // 这条是重构的核心：omni 的准入曾经被 qwen-flash 的 14 字上限决定，
  // 于是「22 字的知识题」被拒在 omni 门外，而 6 字的「你讲讲梗概」反而放进去。
  const long = '你看过波兰作家莱姆写的《其主之声》吗？';
  assert.deepEqual(routeTurn(long, base), { lane: 'live', why: 'live-ready' });
  assert.deepEqual(routeTurn('好。', base), { lane: 'live', why: 'live-ready' });
});

test('dsh 在等回话：短回话直接给 dsh，不喂给快车道当闲聊', () => {
  const ctx: RouteContext = { ...base, dshAwaiting: true };
  assert.deepEqual(routeTurn('好的。', ctx), { lane: 'dsh', why: 'dsh-awaiting' });
  // 不是回话形状就照常走 Live
  assert.equal(routeTurn('今天天气怎么样', ctx).lane, 'live');
});

test('记忆提议必须走 dsh', () => {
  assert.deepEqual(routeTurn('记住我叫小林', base), { lane: 'dsh', why: 'memorable' });
});

test('上一轮 dsh 答过 + 本轮无主语短追问 → 粘回 dsh', () => {
  // 真机 `20261123-053719` 第 5 轮：第 4 轮 dsh 说「只是知道梗概」，
  // 用户追问「你讲讲梗概。」6 个字进了 omni，omni 编了 10.40 s 的《奇书》。
  const ctx: RouteContext = { ...base, lastLane: 'dsh' };
  assert.deepEqual(routeTurn('你讲讲梗概。', ctx), { lane: 'dsh', why: 'stick-to-dsh' });
});

test('粘性只认短追问：带专名/书名的长句照常给 Live', () => {
  const ctx: RouteContext = { ...base, lastLane: 'dsh' };
  assert.equal(routeTurn('那你觉得《其主之声》这本书值得读吗？', ctx).lane, 'live');
});

test('上一轮是 Live 时不触发粘性', () => {
  const ctx: RouteContext = { ...base, lastLane: 'live' };
  assert.equal(routeTurn('你讲讲梗概。', ctx).lane, 'live');
});

test('只会说的两条车道接不了「有副作用」的动作 → 直接给 dsh', () => {
  // 这几条交给快车道的后果不是慢，是**静默失败**：它答"好的，记下了"，
  // 而提醒根本没建。判据只看动作词，不看引擎、不看字数、不看有没有阿拉伯数字。
  for (const text of ['帮我记一下 3 点的会', '提醒我明天交电费', '把那个闹钟关掉']) {
    assert.deepEqual(routeTurn(text, base), { lane: 'dsh', why: 'action' }, text);
  }
});

test('Live 断了退级联，没开就直说 cascade-only', () => {
  assert.deepEqual(routeTurn('你好。', { ...base, live: 'down' }), {
    lane: 'cascade',
    why: 'live-down',
  });
  assert.deepEqual(routeTurn('你好。', { ...base, live: 'off' }), {
    lane: 'cascade',
    why: 'cascade-only',
  });
});

test('两条快车道都不可用 → dsh（出声优先于速度）', () => {
  assert.deepEqual(routeTurn('你好。', { ...base, live: 'down', cascade: false }), {
    lane: 'dsh',
    why: 'no-fast-lane',
  });
});

test('显式取消：只认短句，别把正常说话当成中断指令', () => {
  // 用户明确说「不要了」才取消在跑的 dsh 任务；插话（打断）走的是**放手**，
  // 答案跑完会回注记忆。这条判据把两种意图分开。
  for (const said of ['算了', '算了。', '别查了', '不用了', '取消', '停一下']) {
    assert.equal(isCancelRequest(said), true, `「${said}」应当算取消`);
  }
  for (const said of ['算了算了他算得对', '你算什么？', '不用了但我还想知道结果', '那台机器算什么配置']) {
    assert.equal(isCancelRequest(said), false, `「${said}」是正常说话`);
  }
});
