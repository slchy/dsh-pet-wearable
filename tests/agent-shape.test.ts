/**
 * 这一版**故意只上记忆，不上工具面改动**。
 *
 * 背景：曾经做过一版「主对话砍掉 19 个工具、能力全部下发子代理」（工具面 −80%）。
 * 实测对首字延迟**没有收益**（20 样本/臂：旧 991 ms vs 新 1054 ms，差值在模型抖动
 * 里），于是回滚了。记忆 / 保活 / 检索是另一回事，跟工具面无关，所以单独上线。
 *
 * 这两件事必须钉住，否则都会静默出问题：
 *
 *  1. 记忆的两个 MCP 挂丢了 —— `remember` 用不了，模型会**嘴上答应记住**却什么都
 *     没写；`search_sessions` 没了，它就开始凭印象编「你上次说过……」。
 *  2. 工具面被半推半就地改了一半 —— 比如只关了 bash 却留着教怎么用 bash 的人设，
 *     或者只挂了 preset 却没关工具。这种中间态跑起来不报错，只是变慢、变怪。
 *
 * 真要把工具面那套重新上线，请连人设的【怎么干活】、preset、`mcp-realtime` 一起改，
 * 并先改这个测试 —— 它就是为了当这个刹车才存在的。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const yml = readFileSync(new URL('../mcp/camera.yml', import.meta.url), 'utf8');

test('记忆的读写两条路都挂着', () => {
  assert.ok(/id: mcp-memory/.test(yml), 'remember 没了，模型会嘴上答应记住、实际什么都没写');
  assert.ok(/id: mcp-sessions/.test(yml), 'search_sessions 没了，模型只能凭印象编「上次说过」');
});

test('长期记忆是注入进提示词的，不是每轮去查的', () => {
  assert.ok(/id: agent-instructions/.test(yml), 'agent-instructions 是 MEMORY.md 的注入通道');
  assert.ok(
    /instructionFileCandidates:\s*\n\s+- MEMORY\.md/.test(yml),
    '注入清单里必须有 MEMORY.md，否则记忆文件写在哪都没人读',
  );
});

test('拍照与挂断仍在主对话', () => {
  assert.ok(/id: mcp-camera/.test(yml));
  assert.ok(/id: mcp-session/.test(yml));
});

test('工具面保持全量：没有偷偷关掉的主对话工具', () => {
  assert.ok(
    !/disabled:\s*true/.test(yml),
    '这一版不砍工具面。要砍请连人设的【怎么干活】一起改，并先改这个测试',
  );
});

test('没有半挂着的子代理 preset', () => {
  assert.ok(!/agentPreset/.test(yml), 'agentPreset 指向的 preset 必须同时声明，不能只留一边');
  assert.ok(!/preset-voice-deep/.test(yml), 'preset 属于工具面那套，这一版不挂');
});

// ---------------------------------------------------------------- 两套并存
//
// `full`（上面钉的）与 `delegate` 两套都在仓里，用 `MIAI_AGENT_SHAPE` 切换。
// delegate 那份是**实测对比用**的，放在这里钉住的关键是：它必须自洽 ——
// 关了工具却忘了挂 preset，或者挂了 preset 却没关工具，跑起来都不报错，
// 只是子代理干不了活、或者主对话又变成两套能力混着用。

const delegateTools = readFileSync(new URL('../mcp/camera.delegate.yml', import.meta.url), 'utf8');
const delegatePersona = readFileSync(
  new URL('../mcp/profile.delegate.cordis.yml', import.meta.url),
  'utf8',
);

test('delegate 形态：能力确实下发了，而且子代理接得住', () => {
  assert.match(delegateTools, /agentPreset:\s*voice-deep/, '主对话要钉住 preset');
  assert.match(delegateTools, /id:\s*preset-voice-deep/, 'preset 本身必须在文件里声明');
  for (const plugin of ['tool-bash', 'tool-fs', 'tool-fs-search']) {
    assert.ok(
      delegateTools.includes(`name: '@deepseek-ai/dsh-${plugin}'`),
      `preset 里少了 ${plugin}，子代理就干不了对应的活`,
    );
  }
  assert.match(delegateTools, /^- id: tool-bash\s/m, '主对话的 bash 必须关掉');
  assert.ok(
    (delegateTools.match(/disabled:\s*true/g) ?? []).length >= 10,
    'delegate 形态应当关掉一批工具，数量对不上说明改漏了',
  );
});

test('delegate 形态：记忆和实时信息仍然齐全', () => {
  for (const id of ['mcp-memory', 'mcp-sessions', 'mcp-realtime', 'mcp-camera', 'mcp-session']) {
    assert.ok(delegateTools.includes(`id: ${id}`), `delegate 形态缺了 ${id}`);
  }
  assert.match(
    delegateTools,
    /instructionFileCandidates:\s*\n\s+- MEMORY\.md/,
    'delegate 形态也要注入 MEMORY.md',
  );
});

test('两套人设都带记忆小节，切形态不会把记忆弄丢', () => {
  const full = readFileSync(new URL('../mcp/profile.cordis.yml', import.meta.url), 'utf8');
  assert.ok(full.includes('【记忆】'));
  assert.ok(delegatePersona.includes('【记忆】'));
  assert.ok(!full.includes('【找人干活】'), 'full 形态用的是【怎么干活】');
  assert.ok(delegatePersona.includes('【找人干活】'), 'delegate 形态才有【找人干活】');
});
