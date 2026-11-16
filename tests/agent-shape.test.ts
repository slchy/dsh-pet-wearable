/**
 * 主对话 / 子代理的**能力分工**是写在 `mcp/camera.yml` 里的配置，不是代码。
 * 配置最容易出的两类事故都是静默的：
 *
 *  1. 有人把 bash（或 job / 搜索）@ 回主对话 —— 提示词那边已经不再教怎么用它们了，
 *     模型要么调了不会用，要么又在语音里跑一条命令把主对话卡上十秒。
 *  2. 子代理的 preset 少了哪个插件 —— 「派活」照样成功，但子代理干不了那件事，
 *     表现为派出去的任务永远挂着或者直接报权限错，而主对话看起来一切正常。
 *
 * 这些断言只钉住**分工本身**，不重复 YAML 的每一行。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const yml = readFileSync(new URL('../mcp/camera.yml', import.meta.url), 'utf8');

/** 取某个 `- id: xxx` 条目的正文（到下一个**同级或更浅**的 `- id:` 或文件结束）。 */
function entry(id: string): string {
  // 必须整行匹配：`- id: tool-fs` 是 `- id: tool-fs-search` 的前缀。
  // 也不能要求顶格：preset 的条目缩在 `insert:` 里。
  const startMatch = new RegExp(`^( *) *- id: ${id}(?:\\s+#.*)?$`, 'm').exec(yml);
  assert.ok(startMatch, `camera.yml 里找不到条目 ${id}`);
  const indent = startMatch[1].length;
  const rest = yml.slice(startMatch.index + startMatch[0].length);
  const next = new RegExp(`^ {0,${indent}}- id: `, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

const DISABLED_IN_MAIN = [
  'tool-bash',
  'tool-jobs',
  'tool-fs-search',
  'tool-workflow',
  'tool-todo',
  'tool-goal',
];

test('主对话不挂命令、job、搜索类工具', () => {
  for (const id of DISABLED_IN_MAIN) {
    assert.ok(
      /disabled:\s*true/.test(entry(id)),
      `主对话应当关掉 ${id}：它占着 schema，而语音里一次都用不上；`
      + ' 真要跑命令就该派子代理，否则主对话会被卡住（语音是同步的，卡住等于失聪）',
    );
  }
});

test('子代理挂的是独立 preset，而不是共享主对话的那套', () => {
  const preset = entry('preset-voice-deep');
  assert.ok(preset.includes('id: voice-deep'), 'preset 的 config.id 是会话里保存的身份，必须写死');

  // 「能力下发」全部落在这三行上。少了它们，subagent 就是个干不了活的壳子。
  for (const plugin of ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs']) {
    assert.ok(
      preset.includes(`name: '@deepseek-ai/dsh-${plugin}'`),
      `preset-voice-deep 必须声明 ${plugin}，否则子代理没有这项能力`,
    );
  }

  const subagent = entry('tool-subagent');
  assert.match(
    subagent,
    /agentPreset:\s*voice-deep/,
    'tool-subagent 要显式钉住 preset，不能靠「省略即共享父代」的默认行为',
  );
  assert.match(
    entry('agent-preset-registry'),
    /default:\s*voice-deep/,
    'registry 的默认值要和钉住的 preset 一致，否则新起的子代理会落到别的组合上',
  );
});

test('fork 版子代理是关掉的', () => {
  // fork 继承对话历史，而 dsh 拒绝「继承历史的 provider 用独立组合」——
  // 它只能共享主对话那套狭窄工具，派了等于没派。
  assert.ok(
    /disabled:\s*true/.test(entry('tool-subagent-fork')),
    'fork 版子代理用不了独立 preset，留着只会让模型挑到一个没用的出口',
  );
});

test('拍照与挂断留在主对话', () => {
  for (const id of ['mcp-camera', 'mcp-session', 'mcp-realtime']) {
    assert.ok(!/disabled:\s*true/.test(entry(id)), `${id} 是主对话自己的出口，不能关`);
  }
  assert.ok(
    !/disabled:\s*true/.test(entry('tool-fs')),
    'tool-fs 是关掉 read/write/edit 的单子，条目本身要留着（拍照回图靠 readImage）',
  );
});
