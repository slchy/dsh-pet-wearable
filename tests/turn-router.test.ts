import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  isActionRequest,
  isCancelRequest,
  isClockTimeRequest,
  isRealtimeFactRequest,
  looksLikeAnswer,
  looksLikeFollowUp,
  looksMemorable,
  routeTurn,
  type RouteContext,
} from '../src/turn-router.ts';

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

test('isActionRequest 与 routeTurn 共用同一份动作动词表', () => {
  for (const text of ['帮我查一下天气', '定个明天八点的闹钟', '记一下这个单号']) {
    assert.equal(isActionRequest(text), true, `「${text}」应当算动作`);
  }
  for (const text of ['你今天怎么样', '你看过星球大战没']) {
    assert.equal(isActionRequest(text), false, `「${text}」不是动作请求`);
  }
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

test('叙述句里的动作动词不误判成命令', () => {
  // 真机：含「关掉」但是在讲电影，不该派 dsh。
  for (const text of [
    '电影里主角把门关掉那段真紧张。',
    '小说里他把门关掉了',
    '书里写他关掉了灯',
    '故事里主角把城门关掉',
    '这段剧情是他把门关掉',
    '那一幕他把灯关掉了',
    '演的就是把门关掉',
  ]) {
    assert.equal(isActionRequest(text), false, `「${text}」是叙述`);
  }
  // 同一批叙述词，一旦对着助手下令，仍是动作。
  for (const text of [
    '帮我把电影里那盏灯关掉',
    '给我把那段删掉',
    '请关掉那段提醒',
    '替我把故事里的闹钟关掉',
    '把我那段录音删掉',
    '把刚才电影里定的闹钟关掉',
  ]) {
    assert.equal(isActionRequest(text), true, `「${text}」是在下令`);
  }
});

test('真实指令仍命中动作表，叙述句不再因关掉进 dsh', () => {
  for (const text of [
    '帮我打开客厅的灯',
    '把刚才定的七点闹钟关掉',
    '关掉提醒',
    '删掉这条',
    '记一下这个单号',
    '查一下天气',
  ]) {
    assert.equal(isActionRequest(text), true, `「${text}」应当算动作`);
    assert.equal(routeTurn(text, base).why, 'action', `「${text}」仍走 action`);
  }
  assert.equal(routeTurn('电影里主角把门关掉那段真紧张。', base).lane, 'live');
});

test('isClockTimeRequest 只认此刻钟点与今天日期', () => {
  for (const text of [
    '现在几点',
    '现在几点了？',
    '几点了',
    '几点钟',
    '现在什么时间',
    '现在是什么时间',
    '今天几月几号',
    '今天是几月几号星期几？',
    '今天几月几号星期几',
    '今天几号',
    '今天是几号',
    '今天星期几',
    '今天是星期几',
    '今天周几',
    '今天礼拜几',
    '现在几号',
    '现在是几点了',
  ]) {
    assert.equal(isClockTimeRequest(text), true, `「${text}」是钟点/日期`);
    assert.equal(isRealtimeFactRequest(text), true, `「${text}」也是实时事实`);
  }
  for (const text of [
    '我明天下午三点开会',
    '今天心情不错',
    '我觉得今天心情还不错。',
    '现在停下来想想',
    '记一下我明天下午三点要开会。',
    '你看过星球大战没',
  ]) {
    assert.equal(isClockTimeRequest(text), false, `「${text}」不是在问钟点`);
  }
});

test('isRealtimeFactRequest 只认会过期的外部事实', () => {
  for (const text of [
    '明天北京天气怎么样？',
    '今天天气怎么样',
    '外面现在在下雨吗？',
    '后天会下雪吗',
    '现在空气质量怎么样',
    '外面温度多少',
    '天气怎么样',
    '下不下雨',
    '会下雨吗',
    '英伟达今天股价多少？',
    '股价多少',
    '股票怎么样',
    '汇率涨了吗',
    '比分多少',
    '金价跌了没',
    '油价多少',
    '今天的汇率',
    '今天比分',
    '从这里开车去双流机场堵不堵？',
    '堵车吗',
    '路况怎么样',
    '开过去要多久',
    '开车去公司要多久',
  ]) {
    assert.equal(isRealtimeFactRequest(text), true, `「${text}」要查实时`);
  }
  for (const text of [
    '水在标准大气压下多少度沸腾',
    '水在标准大气压下多少度沸腾？',
    '他还写过哪些作品',
    '他还写过哪些作品？',
    '你看过星球大战没',
    '你看过星球大战没？',
    '今天心情不错',
    '我觉得今天心情还不错。',
    '我今天加班好累啊',
    '我今天加班好累啊。',
    '我明天下午三点开会',
    '现在停下来想想',
    '你好呀，今天过得怎么样？',
    '电影里主角把门关掉那段真紧张。',
    '眼镜现在还剩多少电？',
    '记一下我明天下午三点要开会。',
  ]) {
    assert.equal(isRealtimeFactRequest(text), false, `「${text}」不是实时事实`);
    assert.equal(isClockTimeRequest(text), false, `「${text}」也不是钟点`);
  }
});

test('条件假设句不是天气查询，显式发问仍是', () => {
  for (const text of [
    '如果明天下午不下雨的话我们就去公园走一圈。',
    '要是今天不下雨我就去跑步。',
    '假如明天下雪的话就不出门了。',
  ]) {
    assert.equal(isRealtimeFactRequest(text), false, `「${text}」是条件假设，不是在问天气`);
  }
  for (const text of [
    '明天北京天气怎么样？',
    '外面现在在下雨吗？',
    '今天会下雨吗',
    '今天温度多少',
    '今天空气质量怎么样',
    '现在外面下不下雨',
    '如果今天下雨的话，明天天气怎么样？',
  ]) {
    assert.equal(isRealtimeFactRequest(text), true, `「${text}」仍是天气提问`);
  }
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

// ---------------------------------------------------------------- 依赖方向
//
// 这三条判据原来住在 `fronted-agent.ts`，而 `routeTurn()` 又要用它们 ——
// `turn-router` → `fronted-agent` → `turn-router` 的循环依赖在 ESM 下能跑，
// 但谁先初始化谁就踩 TDZ，而且「内核不 import 引擎」这个分层名存实亡。

test('内核不反向依赖引擎：turn-router 不导入 fronted-agent', () => {
  const source = readFileSync(new URL('../src/turn-router.ts', import.meta.url), 'utf8');
  const imports = source.match(/from\s+'[^']+'/gu) ?? [];
  assert.deepEqual(
    imports.filter((line) => line.includes('fronted-agent')),
    [],
    `内核不许 import 引擎（循环依赖）：${JSON.stringify(imports)}`,
  );
  // 正向的依赖仍然只有 `conversation-ledger` 之类纯类型（这里不断言具体清单，
  // 只保证没有回到引擎那条边 —— 上面那条就是它）。
});

test('句子的形态判据住在内核里：三条都还能用', () => {
  // 直接引用的是 `turn-router.ts` 的导出（不是 `fronted-agent` 的转出）。
  assert.equal(looksLikeAnswer('好的。'), true);
  assert.equal(looksLikeAnswer('你叫什么名字'), false);
  assert.equal(looksMemorable('我姓袁。'), true);
  assert.equal(looksMemorable('我姓什么来着'), false);
  assert.equal(looksLikeFollowUp('你讲讲梗概。'), true);
  assert.equal(looksLikeFollowUp('那你觉得《其主之声》这本书值得读吗？'), false);
});
