/**
 * 人设提示词的**单一存放处**是 `mcp/profile.cordis.yml` 的 `personaPrefix`。
 *
 * 这些断言防的是同一类事故：提示词改了但配置没跟上，线上**静默**退化 ——
 * 模型不再写情绪标签（TTS 永远平静）、或者整段人设丢失（退回通用助手腔），
 * 而日志里一切正常。
 *
 * 最危险的是缩进：YAML 字面块少一格会被当成结构而不是文本，dsh 只读到半截
 * 提示词，不报错、也不警告。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { emotionTagList } from '../src/emotion.ts';

const yml = readFileSync(new URL('../mcp/profile.cordis.yml', import.meta.url), 'utf8');

test('情绪标签枚举与 emotion.ts 保持一致', () => {
  const expected = emotionTagList();
  assert.ok(
    yml.includes(expected),
    `profile.cordis.yml 里应当出现 ${expected}。`
    + ' emotion.ts 的 EMOTION_LABELS 改了名字就必须同步这里，'
    + ' 否则模型会写一个 TTS 不认识的标签，情绪永远回落平静。',
  );
});

test('人设提示词的各个小节都在', () => {
  const sections = [
    '【身份】',
    '【性格】',
    '【怎么说话】',
    '【听岔了怎么办】',
    '【场景规则】',
    '【记忆】',
    '【情绪标签】',
    '【找人干活】',
  ];
  for (const section of sections) {
    assert.ok(yml.includes(section), `profile.cordis.yml 缺少小节 ${section}`);
  }
});

test('工具用法已经不在主对话的人设里', () => {
  // 【怎么干活】整段（bash 前后台判断、run_in_background、三种走法）随着工具一起
  // 下发给子代理了。主对话不挂 bash，留着这段等于教模型去调不存在的工具。
  assert.ok(
    !yml.includes('【怎么干活】'),
    '主对话已经没有 bash/job 工具了，人设里不该再教怎么用它们',
  );
  assert.ok(!yml.includes('run_in_background'), '主对话不挂 bash，不该再提 run_in_background');
});

test('人设不会重新长回去', () => {
  const lines = yml.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith('personaPrefix: |-'));
  assert.ok(start >= 0, '找不到 personaPrefix 字面块');
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    if (line.length - line.trimStart().length < 6) break;
    body.push(line);
  }
  const size = body.map((line) => line.slice(6)).join('\n').trim().length;
  // 系统提示词每个请求都要重发一遍。这里不是首字延迟的瓶颈（实测上下文与 TTFT
  // 无正相关），但它是**每轮都要付的钱**，涨到三千字说明又有规则被塞回主对话了。
  assert.ok(size < 2400, `personaPrefix 已经 ${size} 字符，超过 2400 —— 该挪去子代理的规则又塞回来了`);
});

test('personaPrefix 的内容没有跑出块缩进', () => {
  const lines = yml.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith('personaPrefix: |-'));
  assert.ok(start >= 0, '找不到 personaPrefix 字面块');

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    // 块内容是 6 空格缩进；缩进不足说明已经进入下一个 YAML 键
    if (indent < 6) break;
    body.push(line);
  }

  assert.ok(body.length > 40, `personaPrefix 只解析出 ${body.length} 行，缩进可能断了`);
  const firstContentLine = body.find((line) => line.trim() !== '') ?? '';
  assert.ok(firstContentLine.includes('【身份】'), '第一行应当是【身份】那一段');
});
