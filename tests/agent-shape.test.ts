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
