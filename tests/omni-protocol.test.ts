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
    '没有让你记下或提醒',
    '应一声',
    '不要先讲答案',
    '冷门书名',
    '听岔',
  ]) {
    assert.equal(description.includes(phrase), true, `工具描述缺了「${phrase}」`);
  }
  assert.equal(description.includes('查询实时信息'), false);
  assert.equal(
    DELEGATE_TOOL.parameters.properties.request.description.includes('不要擅自换话题'),
    true,
  );
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
