/**
 * 人设提示词的**单一存放处**是 `mcp/profile.cordis.yml` 的 `personaPrefix`。
 *
 * 不走 dsh 系统提示词的两条短链路（omni 一体模型、快车道）只拿得到 `instructions`，
 * 它们的身份与定位统一收在 `src/persona.ts` —— 那是代码层的唯一导出源。
 *
 * 这些断言防的是同一类事故：提示词改了但配置没跟上，线上**静默**退化 ——
 * 模型不再写情绪标签（TTS 永远平静）、或者整段人设丢失（退回通用助手腔），
 * 而日志里一切正常。名字漂移是其中最难发现的一种：`profile.cordis.yml` 叫「米馍」、
 * 短链路里还叫旧名字时，用户听到的是两个人，日志里一个字都不会提。
 *
 * 最危险的是缩进：YAML 字面块少一格会被当成结构而不是文本，dsh 只读到半截
 * 提示词，不报错、也不警告。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EMOTION_LABELS, emotionTagList, type Emotion } from '../src/emotion.ts';
import { FAST_LANE_PERSONA_HEADER, OMNI_SHORT_INSTRUCTIONS, PERSONA_NAME, PERSONA_ROLE } from '../src/persona.ts';

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
    '【怎么干活】',
  ];
  for (const section of sections) {
    assert.ok(yml.includes(section), `profile.cordis.yml 缺少小节 ${section}`);
  }
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
  // 无正相关），但它是**每轮都要付的钱**，涨过这个数说明又有整段规则被塞回主对话了。
  //
  // 上限 3200 对应「工具面保持全量」这一版：`【怎么干活】`（bash 前后台判断、
  // 三种走法）还在里面。若哪天把工具砍到主对话只剩几个，那段就该一起删掉，
  // 上限也要跟着降到 2400 左右。
  assert.ok(size < 3200, `personaPrefix 已经 ${size} 字符，超过 3200 —— 该挪走的规则又塞回来了`);
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

// ---------------------------------------------------------------- 人设名称三处一致
//
// 三条链路各有一份短人设：dsh 的系统提示词（YAML）、omni 的 `instructions`、
// 快车道的 prompt 头。**名字必须同一个**。漂了不会报错，只会让用户在不同轮次里
// 听到两个名字 —— 而这两种声音交替出现时，人第一反应是「刚才那个是谁」。

test('人设名字三处一致：YAML / omni 短人设 / 快车道人设头', () => {
  // 先把字面量钉死：改名字是有意的决定，得同时动这里，不能靠改变量悄悄溜过去。
  assert.equal(PERSONA_NAME, '米馍', '助手名字变了？三份人设与 docs 都要一起改');
  assert.equal(PERSONA_ROLE, '中文语音助手');

  const fastLane = FAST_LANE_PERSONA_HEADER.join('\n');
  const places = [
    { where: 'mcp/profile.cordis.yml 的 personaPrefix', text: yml },
    { where: 'src/persona.ts 的 OMNI_SHORT_INSTRUCTIONS', text: OMNI_SHORT_INSTRUCTIONS },
    { where: 'src/persona.ts 的 FAST_LANE_PERSONA_HEADER', text: fastLane },
  ];
  for (const { where, text } of places) {
    assert.ok(
      text.includes(PERSONA_NAME),
      `${where} 里没有「${PERSONA_NAME}」—— 人设名字漂了，`
      + ' 用户会在不同轮次里听到两个名字。',
    );
  }
});

test('omni 短人设带上了定位，快车道人设头说清了「哥」与语音', () => {
  // 只钉**语义要素**，不钉整句：这两段都要允许继续打磨措辞（真机上一直在改）。
  assert.ok(
    OMNI_SHORT_INSTRUCTIONS.includes(PERSONA_ROLE),
    'omni 的 instructions 少了「中文语音助手」这个定位，它会滑回通用英文助手腔',
  );
  const fastLane = FAST_LANE_PERSONA_HEADER.join('\n');
  assert.ok(fastLane.includes('「哥」'), '快车道人设头要保留对用户的称呼，否则口吻会变生分');
  assert.ok(fastLane.includes('语音'), '快车道人设头要说明「你的话会变成语音」，不然它会写 markdown');
});

const FAST_LANE_EMOTION_KEYS = [
  'happy',
  'proud',
  'surprised',
  'calm',
  'worried',
  'sulk',
] as const satisfies readonly Emotion[];

test('快车道六个情绪标签从 EMOTION_LABELS 派生，不另写一份中文', () => {
  const tags = FAST_LANE_EMOTION_KEYS.map((key) => `[${EMOTION_LABELS[key]}]`).join(' ');
  const fastLane = FAST_LANE_PERSONA_HEADER.join('\n');
  const persona = readFileSync(new URL('../src/persona.ts', import.meta.url), 'utf8');
  assert.ok(
    fastLane.includes(`从这六个里选：${tags}。`),
    '快车道情绪枚举必须等于 EMOTION_LABELS 里那六个 key 的标签',
  );
  assert.equal(fastLane.includes(`[${EMOTION_LABELS.angry}]`), false);
  assert.equal(fastLane.includes(`[${EMOTION_LABELS.disgust}]`), false);
  assert.equal(
    persona.includes(tags),
    false,
    'persona.ts 里不应再手写那一串中文标签',
  );
});

test('快车道四条系统提示词只在 persona.ts 定义', () => {
  const names = [
    'SYSTEM_PROMPT_WITH_DELEGATE',
    'SYSTEM_PROMPT_PLAIN',
    'TASK_RULE',
    'TASK_RULE_PLAIN',
  ];
  const persona = readFileSync(new URL('../src/persona.ts', import.meta.url), 'utf8');
  const fronted = readFileSync(new URL('../src/fronted-agent.ts', import.meta.url), 'utf8');
  const cascade = readFileSync(new URL('../src/pipelines/cascade-agent.ts', import.meta.url), 'utf8');
  for (const name of names) {
    assert.match(persona, new RegExp(`export const ${name}\\b`));
    assert.equal(fronted.includes(`const ${name}`), false, `fronted-agent.ts 又定义了 ${name}`);
    assert.equal(cascade.includes(`const ${name}`), false, `cascade-agent.ts 又定义了 ${name}`);
    assert.ok(fronted.includes(name), `fronted-agent.ts 应该引用 ${name}`);
    assert.ok(cascade.includes(name), `cascade-agent.ts 应该引用 ${name}`);
  }
});
