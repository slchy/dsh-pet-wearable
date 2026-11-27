/**
 * ASR 与 Omni 答复的专名听岔：窄句型命中才报，闲聊和诚实澄清必须放过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectSubjectHallucination,
  extractQuestionSubject,
  hasEntityQuery,
  type SubjectHallucination,
} from '../src/pipelines/entity-divergence.ts';

const WRONG_BOOK = '《技术哲学》是莱姆探讨科技与人类关系的随笔集。';

function hit(asr: string, reply: string): SubjectHallucination {
  const found = detectSubjectHallucination(asr, reply);
  assert.ok(found !== null, `应当听出听岔：${asr}`);
  return found;
}

test('奇耻之身被答成《技术哲学》', () => {
  const found = hit('奇耻之身是什么？', WRONG_BOOK);
  assert.equal(found.subject, '奇耻之身');
  assert.equal(found.replySubject, '《技术哲学》');
});

test('七主之身被答成《技术哲学》', () => {
  const found = hit('七主之身是什么？', WRONG_BOOK);
  assert.equal(found.subject, '七主之身');
  assert.equal(found.replySubject, '《技术哲学》');
});

test('其主之声被答成《技术哲学》', () => {
  const found = hit('其主之声是什么？', WRONG_BOOK);
  assert.equal(found.subject, '其主之声');
  assert.equal(found.replySubject, '《技术哲学》');
});

test('没有书名号的定义句，核心字零重叠也算听岔', () => {
  const found = hit(
    '介绍一下阿西莫夫的基地',
    '费米悖论是探讨外星文明为什么还没联系我们的著名假设。',
  );
  assert.equal(found.subject, '阿西莫夫的基地');
  assert.equal(found.replySubject, '费米悖论');
});

test('问句里的专名在答复里出现过，不算听岔', () => {
  assert.equal(
    detectSubjectHallucination(
      '索拉里斯星是什么？',
      '《索拉里斯星》是波兰科幻作家莱姆的代表作。',
    ),
    null,
  );
});

test('诚实说没听清或在反问，不算听岔', () => {
  assert.equal(
    detectSubjectHallucination('奇耻之身是什么？', '我刚才没听清，你问的是哪本书呀？'),
    null,
  );
  assert.equal(detectSubjectHallucination('奇耻之身是什么？', '不知道。'), null);
});

test('「你知道 X 是谁吗」剥掉外框和语气词后取到 X', () => {
  const found = hit(
    '你知道齐主是谁吗？',
    '知道啊，就是那本《基督山伯爵》。讲的是爱德蒙·唐泰斯被陷害入狱后复仇的故事。',
  );
  assert.equal(found.subject, '齐主');
  assert.equal(found.replySubject, '《基督山伯爵》');
});

test('「你知道 X 吗 / 你听说过 X 吗」整段主体是专名', () => {
  const found = hit(
    '你知道奇耻之身吗？',
    '《技术哲学》是莱姆探讨科技与人类关系的随笔集。',
  );
  assert.equal(found.subject, '奇耻之身');
  assert.equal(found.replySubject, '《技术哲学》');

  const heard = hit(
    '你听说过其主之声吗？',
    '《技术哲学》是莱姆探讨科技与人类关系的随笔集。',
  );
  assert.equal(heard.subject, '其主之声');
  assert.equal(heard.replySubject, '《技术哲学》');
});

test('外框里带字面重叠或不是专名从句时不误报', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [
      '你知道大贱这部动画吗？',
      '知道，《大剑》是部挺有辨识度的动画。它讲的是半人半妖的战士。',
    ],
    [
      '你知道波兰作家莱姆吗？',
      '波兰作家莱姆是科幻文学巨匠，代表作有《索拉里斯星》。',
    ],
    ['你看过星球大战没？', '看过啊，从1977年第一部就开始追了。'],
    ['你知道怎么去机场吗？', '坐地铁或者打车都可以过去。'],
    ['你知道水多少度沸腾吗？', '标准大气压下是一百度。'],
    ['你知道你叫什么名字吗？', '我叫米馍呀。'],
  ];
  for (const [asr, reply] of cases) {
    assert.equal(detectSubjectHallucination(asr, reply), null, asr);
  }
});

test('闲聊、常识、代词问句即使答复像在编书，也不报听岔', () => {
  const phrases = [
    '你叫什么名字来着？',
    '水在标准大气压下多少度沸腾？',
    '他还写过哪些作品？',
    '你看过星球大战没？',
    '我最喜欢的科幻作家是谁？',
    '你在说什么啊？',
    '刚才那个会议室在几楼来着？',
    '那本书里主角是谁？',
  ];
  for (const phrase of phrases) {
    assert.equal(detectSubjectHallucination(phrase, WRONG_BOOK), null, phrase);
  }
});

test('实体事件问句取出主语：X是怎么回事 / X是什么东西', () => {
  assert.equal(extractQuestionSubject('黄仁勋离职是怎么回事？'), '黄仁勋离职');
  assert.equal(extractQuestionSubject('管理层剧变是什么东西？'), '管理层剧变');
  assert.equal(hasEntityQuery('黄仁勋离职是怎么回事？'), true);
  assert.equal(hasEntityQuery('管理层剧变是什么东西？'), true);
});

test('代词与口语事件问句不是专名，抽取和守卫都要放过', () => {
  for (const phrase of ['今天怎么回事？', '这怎么回事？', '怎么回事？', '你最近怎么回事？']) {
    assert.equal(extractQuestionSubject(phrase), null, phrase);
    assert.equal(hasEntityQuery(phrase), false, phrase);
  }
  for (const phrase of ['水在标准大气压下多少度沸腾？', '你看过星球大战没？']) {
    assert.equal(extractQuestionSubject(phrase), null, phrase);
    assert.equal(hasEntityQuery(phrase), false, phrase);
  }
});
