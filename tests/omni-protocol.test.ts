/**
 * 协议纯函数：工具描述（s1 记备忘/提醒）、instructions 不含工具暗示、坏 JSON。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeInstructions,
  DELEGATE_TOOL,
  parseDelegateRequest,
} from '../src/omni/protocol.ts';
import { OMNI_SHORT_INSTRUCTIONS } from '../src/persona.ts';

test('DELEGATE_TOOL 记备忘/提醒正例，并保留应声与听岔约束', () => {
  const description = DELEGATE_TOOL.description;
  for (const phrase of [
    '记一下',
    '提醒我',
    '写下备忘',
    '设定提醒',
    '没有让你去查、记下或提醒',
    '分享买到的书',
    '已有记忆能直接答出',
    '应一声',
    '不要先讲答案',
    '冷门书名',
    '听岔',
    '具体书籍',
    '电影',
    '作品',
    '论文',
    '专有名词',
    '由谁创作',
    '必须调用',
    '你看过星球大战没',
    '水的沸点',
    '日常聊天',
    '问你的看法',
    '普通闲聊',
    '情绪安慰',
    '讲笑话',
    '脑补成另一部书名',
    '长期记忆',
  ]) {
    assert.equal(description.includes(phrase), true, `工具描述缺了「${phrase}」`);
  }
  assert.equal(description.includes('查询实时信息'), false);
  assert.equal(
    DELEGATE_TOOL.parameters.properties.request.description.includes('不要擅自换话题'),
    true,
  );
});

test('DELEGATE_TOOL 收紧了职责：用户纠正必须查、本机/项目必须查、不许假装查过', () => {
  const description = DELEGATE_TOOL.description;

  // 用户纠正 / 质疑（真机：「我说的是本古迷」之后它还接着猜「喜欢班固的人吧」）
  for (const phrase of [
    '我说的是',
    '不对',
    '错了',
    '你听错了',
    '你搞错了',
    '用工具',
    '核实',
  ]) {
    assert.equal(description.includes(phrase), true, `工具描述缺了纠正类约束「${phrase}」`);
  }

  // 不许假装已经查过（真机：「我看了一下，确实已经失败了」）
  assert.equal(description.includes('假装已经查过'), true, '要明确禁止假装查过');
  assert.equal(description.includes('我看了一下'), true, '要把它编过的那句原样点出来');
  assert.equal(description.includes('宁可委派'), true, '拿不准时的取向要写死');

  // 本机 / 代码 / 项目 / 新闻这一整片必须检索
  for (const phrase of [
    '本机',
    '工作区',
    '代码',
    '项目',
    '仓库',
    '日志',
    '构建',
    '测试',
    '命令',
    '新闻',
    '版本',
  ]) {
    assert.equal(description.includes(phrase), true, `工具描述缺了查证对象「${phrase}」`);
  }

  // 「不调用」的范围必须写死，否则闲聊会被卷进工具调用（实测 3/3 零音频）
  assert.equal(description.includes('不调用只限'), true, '要写清哪些不调用');

  // 委派参数要把争议词原样带给后台，方便结合上下文纠偏
  const request = DELEGATE_TOOL.parameters.properties.request.description;
  assert.equal(request.includes('发音词'), true, '请求里要保留原始发音词');
  assert.equal(request.includes('原样照抄'), true, '专名、路径、数字不能改写');
});

test('omni 短人设只划职责边界：不给字数上限，也不写工具名', () => {
  // 2026-11-23 的教训：写成「不超过 20 个字」之后，真机 7 轮事实题全部编造 ——
  // 「必须简短」的压力下，编一句十几个字的话是成本最低的解。这条不许长回去。
  assert.equal(OMNI_SHORT_INSTRUCTIONS.includes('不超过'), false, '不要给字数上限');
  assert.equal(OMNI_SHORT_INSTRUCTIONS.includes('20 个字'), false);

  // 工具纪律只有 `DELEGATE_TOOL.description` 一份：名字与「调用工具」混进 instructions
  // 会把闲聊判成工具调用（实测 3/3 零音频）。
  assert.equal(OMNI_SHORT_INSTRUCTIONS.includes('delegate_to_assistant'), false);
  assert.equal(OMNI_SHORT_INSTRUCTIONS.includes('调用工具'), false);

  // 两次真机越权对应的边界必须写在正文里。
  for (const phrase of ['事实查证', '专有名词', '本机', '任务核查', '听错', '假装']) {
    assert.equal(
      OMNI_SHORT_INSTRUCTIONS.includes(phrase),
      true,
      `短人设少了边界「${phrase}」`,
    );
  }
});

test('composeInstructions 空动态事实与短人设逐字一致，且不含工具暗示', () => {
  assert.equal(composeInstructions({}), OMNI_SHORT_INSTRUCTIONS);
  assert.equal(
    composeInstructions({ dynamicContext: ' \n\t', memoryContext: '  ', clock: ' \n' }),
    OMNI_SHORT_INSTRUCTIONS,
  );
  assert.equal(
    composeInstructions({ instructions: 'BASE', dynamicContext: '', memoryContext: '', clock: '' }),
    'BASE',
  );

  const withFacts = composeInstructions({
    clock: '当前日期：2026年11月24日 星期二（北京时间）',
    memoryContext: '对花生过敏',
    dynamicContext: '在公司',
  });
  assert.equal(withFacts.includes('调用工具'), false);
  assert.equal(withFacts.includes('要不要调'), false);
  assert.equal(withFacts.includes('查询实时信息'), false);
  assert.equal(withFacts.includes('应一声'), false);
  assert.equal(withFacts.includes('delegate_to_assistant'), false);
  assert.equal(
    withFacts,
    `${OMNI_SHORT_INSTRUCTIONS}\n\n【当前日期参考】\n`
      + '当前日期：2026年11月24日 星期二（北京时间）\n\n'
      + '【关于哥的已知长期记忆（仅供如实回答，不要主动复述）】\n对花生过敏\n\n在公司',
  );
});

test('长期记忆超过 600 字截断，不加省略号', () => {
  const memory = `头${'记'.repeat(600)}`;
  const text = composeInstructions({ memoryContext: memory });
  const marker = '\n\n【关于哥的已知长期记忆（仅供如实回答，不要主动复述）】\n';
  assert.equal(text.startsWith(OMNI_SHORT_INSTRUCTIONS), true);
  const fact = text.slice(OMNI_SHORT_INSTRUCTIONS.length + marker.length);
  assert.equal(fact, `头${'记'.repeat(599)}`);
  assert.equal(fact.length, 600);
  assert.equal(fact.endsWith('…'), false);
});

test('parseDelegateRequest：坏 JSON 返回 null，完整 request 去掉空白', () => {
  assert.equal(parseDelegateRequest('{"request":'), null);
  assert.equal(parseDelegateRequest('{'), null);
  assert.equal(parseDelegateRequest(''), null);
  assert.equal(parseDelegateRequest(null), null);
  assert.equal(parseDelegateRequest(1), null);
  assert.equal(parseDelegateRequest({}), null);
  assert.equal(parseDelegateRequest({ request: 1 }), null);
  assert.equal(parseDelegateRequest({ request: '   ' }), null);
  assert.equal(parseDelegateRequest('{"request":"  记一下  "}'), '记一下');
  assert.equal(parseDelegateRequest({ request: '提醒我' }), '提醒我');
});
