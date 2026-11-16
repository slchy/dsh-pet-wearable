import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SentencePump, takeSentences } from '../src/sentence-pump.ts';

/** 假 TTS：记录每次合成的文本，吐一块固定 PCM */
function fakeTts(): { calls: Array<{ text: string; emotion?: string }>; synthesize: (t: string, e?: string) => AsyncIterable<Buffer> } {
  const calls: Array<{ text: string; emotion?: string }> = [];
  return {
    calls,
    async *synthesize(text: string, emotion?: string) {
      calls.push({ text, ...(emotion === undefined ? {} : { emotion }) });
      yield Buffer.from([1, 2]);
    },
  };
}

const clean = (text: string): string => text.replace(/\s+/g, '').replace(/\[[^\]]*\]/g, '');

test('takeSentences 按句读切开，剩下不成句的原样返回', () => {
  assert.deepEqual(takeSentences('你好。今天天气'), {
    sentences: ['你好。'],
    rest: '今天天气',
  });
  assert.deepEqual(takeSentences('真的吗？太好了！'), {
    sentences: ['真的吗？', '太好了！'],
    rest: '',
  });
});

test('没走流式时整段一次合成（不要退化成一句一次握手）', async () => {
  const tts = fakeTts();
  const chunks: Buffer[] = [];
  const pump = new SentencePump({
    synthesize: (t, e) => tts.synthesize(t, e),
    clean,
    resolveEmotion: () => undefined,
    onChunk: (c) => { chunks.push(c); },
  });
  await pump.drain('第一句。第二句。第三句。');
  assert.equal(tts.calls.length, 1);
  assert.equal(tts.calls[0]?.text, '第一句。第二句。第三句。');
  assert.equal(chunks.length, 1);
});

test('流式：凑满一句就合成，收尾只补没念的部分', async () => {
  const tts = fakeTts();
  const pump = new SentencePump({
    synthesize: (t, e) => tts.synthesize(t, e),
    clean,
    resolveEmotion: () => undefined,
    onChunk: () => {},
  });
  pump.push('第一句。');
  pump.push('第二');
  await pump.drain('第一句。第二句。');
  assert.deepEqual(tts.calls.map((c) => c.text), ['第一句。', '第二句。']);
});

test('情绪标签在首个增量里就认出来，并逐句带上', async () => {
  const tts = fakeTts();
  const pump = new SentencePump({
    synthesize: (t, e) => tts.synthesize(t, e),
    clean,
    resolveEmotion: (raw) => (raw.includes('[开心]') ? 'happy' : undefined),
    onChunk: () => {},
  });
  pump.push('[开心]好的。');
  await pump.drain('[开心]好的。');
  assert.equal(tts.calls[0]?.emotion, 'happy');
  // 标签不能进 TTS，否则会被念出来
  assert.equal(tts.calls[0]?.text, '好的。');
});

test('已念部分与最终文本对不上时，记一条并按最终文本补', async () => {
  const tts = fakeTts();
  const logs: string[] = [];
  const pump = new SentencePump({
    synthesize: (t, e) => tts.synthesize(t, e),
    clean,
    resolveEmotion: () => undefined,
    onChunk: () => {},
    log: (line) => { logs.push(line); },
  });
  pump.push('甲。乙。');
  await pump.drain('完全不同的答案。');
  assert.ok(logs.some((line) => line.includes('对不上')));
  // 已念过的不撤回（用户已经听到了），只补最终文本 —— 宁可多念，不能吞字
  assert.deepEqual(tts.calls.map((c) => c.text), ['甲。', '乙。', '完全不同的答案。']);
});

test('票据作废后不再合成（用户插话）', async () => {
  const tts = fakeTts();
  let stale = false;
  const pump = new SentencePump({
    synthesize: (t, e) => tts.synthesize(t, e),
    clean,
    resolveEmotion: () => undefined,
    onChunk: () => {},
    isStale: () => stale,
  });
  stale = true;
  pump.push('这句不该被合成。');
  await pump.drain('这句不该被合成。');
  assert.equal(tts.calls.length, 0);
});
