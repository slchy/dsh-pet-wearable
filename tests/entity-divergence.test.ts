/**
 * ASR 与 Omni 答复的专名听岔：窄句型命中才报，闲聊和诚实澄清必须放过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectSubjectHallucination,
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
