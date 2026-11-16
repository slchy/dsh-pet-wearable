/**
 * `latency-report` 的单测：钉住分段口径与「缺仪表不等于 0」这两件事。
 *
 * 背景：宠物形态的硬指标是「用户说完 → 听到第一个字」。这个数字以前只能从
 * console 日志人肉对，改动之后无法比较；折算规则一旦搞错，基线会被静悄悄伪造。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeTurns, formatReport, parseEvents, percentile, summarize } from '../src/latency-report.ts';

/** 把事件拼成 jsonl；传字符串表示「原样塞进去」，用来造坏行。 */
function jsonl(events: ReadonlyArray<Record<string, unknown> | string>): string {
  return events
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join('\n');
}

const NORMAL_TURN = jsonl([
  { t: 0, ev: 'open' },
  { t: 1000, ev: 'gate.open', peakDbfs: -20 },
  { t: 1500, ev: 'gate.close' },
  { t: 1900, ev: 'asr.sentence', text: '米馍在吗', index: 0 },
  { t: 1930, ev: 'turn.start', text_len: 4, image: false },
  { t: 3300, ev: 'tts.first', ms: 1370 },
  { t: 7000, ev: 'turn.end', interrupted: false, audio_s: 3.6, dsh_ms: 1250 },
]);

test('完整一轮：四段与首字总延迟都对得上', () => {
  const [turn] = computeTurns(parseEvents(NORMAL_TURN));
  assert.ok(turn);
  assert.equal(turn.turn, 1);
  assert.equal(turn.silenceToAsr, 400);
  assert.equal(turn.asrToTurn, 30);
  assert.equal(turn.turnToAudio, 1370);
  // 首字延迟以 gate.close 为起点：400 + 30 + 1370
  assert.equal(turn.firstWordMs, 1800);
  assert.equal(turn.playbackMs, 3700);
  assert.equal(turn.agentMs, 1250);
  assert.equal(turn.interrupted, false);
  assert.equal(turn.text, '米馍在吗');
});

test('缺 tts.first 的旧档案：首字延迟记 null，不拿 0 冒充', () => {
  const legacy = jsonl([
    { t: 1000, ev: 'gate.close' },
    { t: 1400, ev: 'asr.sentence', text: '喂', index: 0 },
    { t: 1420, ev: 'turn.start', text_len: 1, image: false },
    { t: 6000, ev: 'turn.end', interrupted: false, dsh_ms: 900 },
  ]);
  const [turn] = computeTurns(parseEvents(legacy));
  assert.ok(turn);
  assert.equal(turn.silenceToAsr, 400);
  assert.equal(turn.turnToAudio, null);
  assert.equal(turn.firstWordMs, null);
  assert.equal(turn.playbackMs, null);
  assert.deepEqual(turn.missing, ['tts.first']);
  assert.match(formatReport(computeTurns(parseEvents(legacy))), /tts\.first×1/);
});

test('gate.close 带 gapMs：起点取「停嘴时刻」，而不是记录时刻', () => {
  // 真实顺序：能量门要 holdMs（2 s）才关，所以 gate.close 记在 turn.start **之后**。
  // 停嘴 @1000，gate.close 记在 @3000（gapMs 2000）。
  const real = jsonl([
    { t: 1000, ev: 'gate.open', peakDbfs: -20 },
    { t: 1800, ev: 'asr.sentence', text: '我记得', index: 0 },
    { t: 2200, ev: 'turn.start', text_len: 3, image: false },
    { t: 3000, ev: 'gate.close', gapMs: 2000 },
    { t: 4000, ev: 'tts.first', ms: 1800 },
    { t: 7000, ev: 'turn.end', interrupted: false, dsh_ms: 1500 },
  ]);
  const [turn] = computeTurns(parseEvents(real));
  assert.ok(turn);
  // ① = asr.sentence - 停嘴 = 1800 - 1000
  assert.equal(turn.silenceToAsr, 800);
  // 首字延迟 = tts.first - 停嘴 = 4000 - 1000（若取记录时刻会误报 1000）
  assert.equal(turn.firstWordMs, 3000);
  assert.deepEqual(turn.missing, []);
});

test('多轮不串味：第二轮没有 gate.close 就记 null，不复用第一轮的', () => {
  const two = jsonl([
    { t: 1000, ev: 'gate.close' },
    { t: 1400, ev: 'asr.sentence', text: '第一句', index: 0 },
    { t: 1420, ev: 'turn.start', text_len: 3, image: false },
    { t: 2000, ev: 'tts.first', ms: 580 },
    { t: 4000, ev: 'turn.end', interrupted: false, dsh_ms: 500 },
    { t: 5000, ev: 'asr.sentence', text: '第二句', index: 1 },
    { t: 5100, ev: 'turn.start', text_len: 3, image: false },
    { t: 6000, ev: 'tts.first', ms: 900 },
    { t: 8000, ev: 'turn.end', interrupted: false, dsh_ms: 800 },
  ]);
  const turns = computeTurns(parseEvents(two));
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.firstWordMs, 1000);
  assert.equal(turns[1]?.silenceToAsr, null);
  assert.equal(turns[1]?.asrToTurn, 100);
  assert.equal(turns[1]?.turnToAudio, 900);
  assert.equal(turns[1]?.firstWordMs, null);
  assert.equal(turns[1]?.text, '第二句');
  // 第二轮缺的是 gate.close；有 tts.first，不能把它也算成"缺仪表"
  assert.deepEqual(turns[1]?.missing, ['gate.close']);
});

test('上一轮的 gate.close 落在本轮 turn.start 之后，也不能被本轮抢走', () => {
  // 真机档案（20261116-003955）的形状：能量门要 2 s 才关，所以上一轮的
  // gate.close 记在**上一轮 turn.start 之后**；随后用户静音 6 s 才开口，
  // 本轮没有自己的 gate.close。
  // 旧逻辑回退搜索 [上一轮 turn.start, 本轮 turn.start) 会抓到上一轮那个，
  // 把 6 s 静音算进 ①，把真实的 1.3 s 报成 7.6 s。
  const real = jsonl([
    { t: 81787, ev: 'asr.sentence', text: '退一下。', index: 1 },
    { t: 82011, ev: 'turn.start', text_len: 4, image: false },
    { t: 83203, ev: 'gate.close', gapMs: 2011 },
    { t: 83489, ev: 'tts.first', ms: 338 },
    { t: 85325, ev: 'turn.end', interrupted: false, dsh_ms: 1138 },
    // 用户静音 6 s 后才开口
    { t: 87522, ev: 'gate.open', peakDbfs: -28.5, prerollMs: 795 },
    { t: 88823, ev: 'asr.sentence', text: '断开连接。', index: 1 },
    { t: 89047, ev: 'turn.start', text_len: 5, image: false },
    { t: 91135, ev: 'tts.first', ms: 347 },
    { t: 93693, ev: 'turn.end', interrupted: false, dsh_ms: 1740 },
  ]);
  const turns = computeTurns(parseEvents(real));
  assert.equal(turns.length, 2);
  // 第一轮正常拿到自己的 gate.close：81787 - (83203 - 2011)
  assert.equal(turns[0]?.silenceToAsr, 595);
  // 第二轮没有自己的 gate.close → 记缺失，绝不复用上一轮的
  assert.equal(turns[1]?.silenceToAsr, null);
  assert.equal(turns[1]?.firstWordMs, null);
  assert.deepEqual(turns[1]?.missing, ['gate.close']);
  // ③④ 不受影响
  assert.equal(turns[1]?.turnToAudio, 2088);
});

test('主动播报轮：没有 asr.sentence 时 ①② 为 null，③④ 照算', () => {
  const announce = jsonl([
    { t: 100, ev: 'announce', len: 12 },
    { t: 200, ev: 'turn.start', text_len: 12, image: false },
    { t: 900, ev: 'tts.first', ms: 700 },
    { t: 3000, ev: 'turn.end', interrupted: false, audio_s: 2.1, dsh_ms: 650 },
  ]);
  const [turn] = computeTurns(parseEvents(announce));
  assert.ok(turn);
  assert.equal(turn.silenceToAsr, null);
  assert.equal(turn.asrToTurn, null);
  assert.equal(turn.turnToAudio, 700);
  assert.equal(turn.firstWordMs, null);
  assert.equal(turn.playbackMs, 2100);
  assert.deepEqual(turn.missing, ['gate.close', 'asr.sentence']);
});

test('被插话中断的轮次标记为 interrupted', () => {
  const barge = jsonl([
    { t: 1000, ev: 'gate.close' },
    { t: 1200, ev: 'asr.sentence', text: '讲个故事', index: 0 },
    { t: 1210, ev: 'turn.start', text_len: 4, image: false },
    { t: 2100, ev: 'tts.first', ms: 890 },
    { t: 2600, ev: 'turn.end', interrupted: true, dsh_ms: 870 },
  ]);
  const [turn] = computeTurns(parseEvents(barge));
  assert.ok(turn);
  assert.equal(turn.interrupted, true);
});

test('坏行与空行被跳过，不影响其余事件', () => {
  const dirty = `${jsonl([
    { t: 0, ev: 'open' },
    { t: 500, ev: 'gate.close' },
  ])}\n\n这不是 JSON\n{"t":"x","ev":"bad"}\n${JSON.stringify({ t: 900, ev: 'asr.sentence', text: 'ok', index: 0 })}`;
  const events = parseEvents(dirty);
  assert.equal(events.length, 3);
  assert.equal(events[2]?.ev, 'asr.sentence');
});

test('分位数用线性插值，null 被剔除', () => {
  const values = [100, null, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  // 10 个样本：中位取中间两个的平均，不让延迟数字偏乐观
  assert.equal(percentile(values, 0.5), 550);
  assert.equal(percentile(values, 0.9), 910);
  assert.equal(percentile([null, null], 0.5), null);
  assert.equal(percentile([42], 0.9), 42);
  const s = summarize(values);
  assert.equal(s.count, 10);
  assert.equal(s.median, 550);
  assert.equal(s.max, 1000);
});

test('报告在 p90 超预算时给出「先治 ③」的判断', () => {
  const slow = jsonl([
    { t: 1000, ev: 'gate.close' },
    { t: 1400, ev: 'asr.sentence', text: '你好', index: 0 },
    { t: 1420, ev: 'turn.start', text_len: 2, image: false },
    { t: 5000, ev: 'tts.first', ms: 3580 },
    { t: 8000, ev: 'turn.end', interrupted: false, dsh_ms: 3500 },
  ]);
  const text = formatReport(computeTurns(parseEvents(slow)));
  assert.match(text, /超预算/);
  assert.match(text, /先治 ③/);
});
