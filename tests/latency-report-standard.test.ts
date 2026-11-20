/**
 * 标准报告的**口径**测试。
 *
 * 这份报告是 `docs/QOS.md` 的执行体 —— 口径写在文档里、算法写在这里，两者不一致
 * 的时候以代码为准（文档得改）。所以下面每一条都对应文档里的一句规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTurns,
  formatStandard,
  groupBy,
  parseEvents,
  type TurnLatency,
} from '../src/latency-report.ts';

/** 造一条事件（只填报告要用的字段） */
function ev(t: number, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ev: name, t, ...extra });
}

/**
 * 造一轮：停嘴 → 定稿 → 开轮 → 首块 → 结束。
 *
 * @param stopAt - 停嘴时刻（`gate.close` 会写在这里，并用 `gapMs` 反推）
 * @param gap - `gate.close` 相对停嘴晚多少（模拟 `VOICE_HOLD_MS`）
 */
function turn(
  n: number,
  stopAt: number,
  segs: { asr: number; open: number; audio: number },
  extra: { text?: string; path?: string; interrupted?: boolean; loop?: number } = {},
): string[] {
  const asrAt = stopAt + segs.asr;
  const openAt = asrAt + segs.open;
  const audioAt = openAt + segs.audio;
  const gap = 2000;
  return [
    // 门在停嘴后 gap 才关 —— 真机就是这样，所以 ① 必须靠 gapMs 反推
    ev(stopAt + gap, 'gate.close', { gapMs: gap }),
    ev(asrAt, 'asr.sentence', { text: extra.text ?? `第${n}句。` }),
    ev(openAt, 'turn.start', {}),
    ev(audioAt, 'tts.first', { ms: segs.audio }),
    ev(audioAt + 500, 'turn.end', {
      interrupted: extra.interrupted ?? false,
      dsh_ms: 180,
      loop_max_ms: extra.loop ?? 3,
      ...(extra.path === undefined ? {} : { path: extra.path }),
    }),
  ];
}

/** 把若干轮拼成 events.jsonl 全文 */
function archive(turns: string[][]): TurnLatency[] {
  // 档案是**按时间排序**的。这里也要排 —— 真机的 `gate.close` 因为 `holdMs`
  // 常常晚于同一句的 `asr.sentence`，不排序会让配对逻辑抓到下一轮的门。
  const ordered = turns
    .flat()
    .map((line) => ({ line, t: (JSON.parse(line) as { t: number }).t }))
    .sort((a, b) => a.t - b.t)
    .map((item) => item.line);
  return computeTurns(parseEvents(ordered.join('\n')));
}

test('三段相加 = 合计（逐轮算，不是中位相加）', () => {
  const turns = archive([
    turn(1, 1000, { asr: 300, open: 0, audio: 600 }), // 900
    turn(2, 5000, { asr: 300, open: 0, audio: 900 }), // 1200
    turn(3, 9000, { asr: 300, open: 400, audio: 400 }), // 1100
  ]);
  for (const t of turns) {
    assert.equal(t.silenceToAsr, 300, `轮${t.turn} ①`);
    assert.equal(t.firstWordMs, 300 + (t.asrToTurn ?? 0) + (t.turnToAudio ?? 0));
  }
  // 各段中位相加 = 300+0+600 = 900，而合计的中位是 1100 —— 两者必须能分开
  const groups = groupBy(turns, () => 'all');
  assert.equal(groups[0]?.p50, 1100);
  const naive = (groups[0]?.seg1 ?? 0) + (groups[0]?.seg2 ?? 0) + (groups[0]?.seg3 ?? 0);
  assert.notEqual(naive, groups[0]?.p50, '中位相加不该等于合计的中位（这正是要提醒的坑）');
});

test('① < 0 的样本自动降成 null 并记账（不靠人眼剔除）', () => {
  // 真实形态：这一轮的门没等到，配对抓到了**后一句**的门（`gate.close` 在 `turn.end` 之后），
  // 于是反推出的「停嘴」落在定稿之后 → ① 为负。
  const bad = [
    ev(1200, 'asr.sentence', { text: '算错的一句。' }),
    ev(1300, 'turn.start', {}),
    ev(1900, 'tts.first', { ms: 600 }),
    ev(2400, 'turn.end', { interrupted: false, dsh_ms: 100, path: 'fast' }),
    ev(3000, 'gate.close', { gapMs: 500 }), // 停嘴 = 2500 > 定稿 1200
  ];
  const turns = computeTurns(parseEvents(bad.join('\n')));
  assert.equal(turns[0]?.silenceToAsr! < 0, true, '这一轮的 ① 应该是负数');
  assert.equal(turns[0]?.firstWordMs, null, '坏样本的合计必须记 null，不能是负数');
  assert.equal(turns[0]?.badSample, true);
  const groups = groupBy(turns, () => 'all');
  assert.equal(groups[0]?.count, 0, '坏样本不进分母');
  assert.equal(groups[0]?.bad, 1, '但必须记着被剔除了一轮');
  assert.equal(groups[0]?.p50, null, '没有可用样本时给 null，不给 0');
});

test('按车道分组：两条车道不许混在一起算 p50', () => {
  const turns = archive([
    turn(1, 1000, { asr: 300, open: 0, audio: 600 }, { path: 'fast' }),
    turn(2, 5000, { asr: 300, open: 0, audio: 700 }, { path: 'fast' }),
    turn(3, 9000, { asr: 300, open: 80, audio: 8000 }, { path: 'dsh' }),
  ]);
  const lanes = groupBy(turns, (t) => t.path ?? '未知');
  assert.equal(lanes.length, 2);
  const fast = lanes.find((g) => g.label === 'fast');
  const dsh = lanes.find((g) => g.label === 'dsh');
  assert.equal(fast?.count, 2);
  assert.ok((fast?.p50 ?? 0) < 1000, 'fast 的 p50 不该被 dsh 拉高');
  assert.ok((dsh?.p50 ?? 0) > 8000, 'dsh 自成一组');
});

test('按判停是否等待分组：② 是两头分布，中位会掩盖那三成', () => {
  const turns = archive([
    turn(1, 1000, { asr: 300, open: 0, audio: 600 }),
    turn(2, 5000, { asr: 300, open: 0, audio: 600 }),
    turn(3, 9000, { asr: 300, open: 0, audio: 600 }),
    turn(4, 13000, { asr: 300, open: 450, audio: 300 }), // 等了
  ]);
  const groups = groupBy(turns, (t) => (t.waitedInJudge ? '等了' : '没等'));
  const waited = groups.find((g) => g.label === '等了');
  const notWaited = groups.find((g) => g.label === '没等');
  assert.equal(waited?.count, 1);
  assert.equal(notWaited?.count, 3);
  // 等的那些门槛明显更高 —— 混在一起时中位会落在「没等」那一侧，把成本藏起来
  assert.ok((waited?.seg2 ?? 0) > 400);
  assert.ok((notWaited?.seg2 ?? 0) < 10);
});

test('台词分类：短开头语算 filler，完整问句不算', () => {
  const turns = archive([
    turn(1, 1000, { asr: 300, open: 0, audio: 600 }, { text: '你说。' }),
    turn(2, 5000, { asr: 300, open: 0, audio: 600 }, { text: '你觉得。' }),
    turn(3, 9000, { asr: 300, open: 0, audio: 600 }, { text: '你觉得哪首音乐好听？' }),
    turn(4, 13000, { asr: 300, open: 0, audio: 600 }, { text: 'Yeah.' }),
    turn(5, 17000, { asr: 300, open: 0, audio: 600 }, { text: '我想问你你会做梦吗？' }),
  ]);
  assert.equal(turns[0]?.category, 'filler', '「你说。」是会被切开的开头语');
  assert.equal(turns[1]?.category, 'filler', '「你觉得。」同上');
  assert.equal(turns[2]?.category, 'normal', '完整问句不该被算成半句');
  assert.equal(turns[3]?.category, 'noise', '「Yeah.」疑似误识别');
  assert.equal(turns[4]?.category, 'normal', '长句不是开头语');
});

test('标准报告固定输出三张表 + 多余轮次，且三张表口径一致', () => {
  const turns = archive([
    turn(1, 1000, { asr: 300, open: 0, audio: 600 }, { path: 'fast', text: '你好。' }),
    turn(2, 5000, { asr: 300, open: 400, audio: 400 }, { path: 'fast', text: '你说。' }),
    turn(3, 9000, { asr: 300, open: 0, audio: 800 }, { path: 'dsh', text: 'Yeah.' }),
  ]);
  const text = formatStandard(turns);
  assert.match(text, /### 按车道/);
  assert.match(text, /### 按判停是否等待/);
  assert.match(text, /### 按台词类别/);
  assert.match(text, /### 多余轮次的嫌疑/);
  // 每条分组表都必须带「不许相加」的提醒，否则读的人迟早会加
  assert.equal(text.match(/不许相加/g)?.length, 3);
  // 疑似误识别要点名到轮次，不然没法回看
  assert.match(text, /轮3「Yeah\.」/);
});
