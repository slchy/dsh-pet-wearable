/**
 * L2：**口径基线** —— 守的不是系统，是测量。
 *
 * 这几天被纠正的每一处都属于这一类：「各段中位相加」「① 算成负数」
 * 「中位掩盖两头分布」。它们不会让任何功能测试变红，只会让**报告里的数字
 * 悄悄变成另一个东西**。所以这里用一份固定档案把数字钉死。
 *
 * 档案是**合成**的（无真实地址、无录音），期望值取一次运行后人工复核。
 * 风险是「红了就改数字」—— 所以字段少、改动一眼可见。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeTurns, formatStandard, groupBy, parseEvents } from '../src/latency-report.ts';

/**
 * 固定档案：6 轮，覆盖口径的四个角落。
 *
 * | 轮 | 设计 | 用来守什么 |
 * |---|---|---|
 * | 1 | fast，②=0 | 基线轮 |
 * | 2 | fast，②=450 | 两头分布里的「等了」那一头 |
 * | 3 | dsh，③ 很大 | 车道必须分开分组 |
 * | 4 | ①<0（门配到下一段） | 坏样本自动剔除 |
 * | 5 | 开头语「你说。」 | 台词分类 filler |
 * | 6 | 「Yeah.」 | 台词分类 noise（疑似误识别） |
 */
const GAP = 2000; // VOICE_HOLD_MS：能量门在停嘴后这么久才关

interface Spec {
  stop: number;
  asr: number;
  open: number;
  audio: number;
  text: string;
  path?: string;
  /**
   * 覆盖 `gate.close` 的时刻（默认 `stop + GAP`）。
   *
   * 用来构造**真实的坏样本**：`① = asr − (gate.t − GAP)`。想让 ① 为负，
   * 门必须晚于 `asr + GAP` —— 也就是配对抓到了**后一句**的门。
   * 这个坑踩过一次：一开始把门放在停嘴后 2000 ms，算出来 ① 仍是 +300，
   * 自己以为在测坏样本，其实什么都没测。
   */
  gateAt?: number;
  /** 不给 `turn.end`（构造「只缺这一个标记」的轮次） */
  end?: false;
}

const SPECS: Spec[] = [
  { stop: 1_000, asr: 300, open: 0, audio: 600, text: '你好啊。', path: 'fast' },
  { stop: 5_000, asr: 300, open: 450, audio: 300, text: '今天风挺大。', path: 'fast' },
  { stop: 9_000, asr: 300, open: 0, audio: 8_000, text: '帮我查一下天气。', path: 'dsh' },
  // 坏样本：这一轮没有自己的门，配对抓到 2317 ms 之后的那一个 →
  // 反推的停嘴 = 25300 + 2317 − 2000 = 25617 > 定稿 25300 → ① = −317
  { stop: 25_000, asr: 300, open: 0, audio: 500, text: '算错的一句。', path: 'fast', gateAt: 27_617 },
  { stop: 30_000, asr: 300, open: 0, audio: 500, text: '你说。', path: 'fast' },
  { stop: 34_000, asr: 300, open: 0, audio: 500, text: 'Yeah.', path: 'fast' },
];

/** 把 SPECS 展开成按时间排序的事件行（真机档案就是这个顺序） */
function archiveOf(specs: Spec[]): string {
  const lines: Array<{ t: number; body: Record<string, unknown> }> = [];
  for (const s of specs) {
    const asrAt = s.stop + s.asr;
    const openAt = asrAt + s.open;
    const audioAt = openAt + s.audio;
    lines.push({ t: s.gateAt ?? s.stop + GAP, body: { ev: 'gate.close', gapMs: GAP } });
    lines.push({ t: asrAt, body: { ev: 'asr.sentence', text: s.text } });
    lines.push({ t: openAt, body: { ev: 'turn.start' } });
    lines.push({ t: audioAt, body: { ev: 'tts.first', ms: s.audio } });
    // `end: false` 用来构造「只缺 turn.end」的轮次 —— 它不影响首字延迟
    if (s.end !== false) {
      lines.push({
        t: audioAt + 400,
        body: {
          ev: 'turn.end',
          interrupted: false,
          dsh_ms: 180,
          loop_max_ms: 2,
          ...(s.path === undefined ? {} : { path: s.path }),
        },
      });
    }
  }
  return lines
    .sort((a, b) => a.t - b.t)
    .map((l) => JSON.stringify({ t: l.t, ...l.body }))
    .join('\n');
}

const turns = computeTurns(parseEvents(archiveOf(SPECS)));

test('口径基线：逐轮分段与合计钉死', () => {
  const got = turns.map((t) => ({
    turn: t.turn,
    a1: t.silenceToAsr,
    a2: t.asrToTurn,
    a3: t.turnToAudio,
    total: t.firstWordMs,
    path: t.path,
    cat: t.category,
    bad: t.badSample,
  }));
  assert.deepEqual(got, [
    { turn: 1, a1: 300, a2: 0, a3: 600, total: 900, path: 'fast', cat: 'normal', bad: false },
    { turn: 2, a1: 300, a2: 450, a3: 300, total: 1050, path: 'fast', cat: 'normal', bad: false },
    { turn: 3, a1: 300, a2: 0, a3: 8000, total: 8300, path: 'dsh', cat: 'normal', bad: false },
    // ① 为负 → total 记 null（不拿负数冒充「很快」）
    { turn: 4, a1: -317, a2: 0, a3: 500, total: null, path: 'fast', cat: 'normal', bad: true },
    { turn: 5, a1: 300, a2: 0, a3: 500, total: 800, path: 'fast', cat: 'filler', bad: false },
    { turn: 6, a1: 300, a2: 0, a3: 500, total: 800, path: 'fast', cat: 'noise', bad: false },
  ]);
});

test('口径基线：分组表 p50 钉死（按车道 / 按等待 / 按台词）', () => {
  const lanes = groupBy(turns, (t) => t.path ?? '未知');
  const fast = lanes.find((g) => g.label === 'fast');
  const dsh = lanes.find((g) => g.label === 'dsh');
  // fast 可用 4 轮：900 / 1050 / 800 / 800（坏样本被剔除，不进分母）
  assert.equal(fast?.count, 4);
  assert.equal(fast?.total, 5);
  assert.equal(fast?.bad, 1);
  assert.equal(fast?.p50, 850);
  assert.equal(dsh?.count, 1);
  assert.equal(dsh?.p50, 8300);

  const wait = groupBy(turns, (t) => (t.waitedInJudge ? '等了' : '没等'));
  assert.equal(wait.find((g) => g.label === '等了')?.count, 1);
  assert.equal(wait.find((g) => g.label === '没等')?.count, 4);
});

test('口径基线：三张表都存在，且各自提醒「不许相加」', () => {
  const text = formatStandard(turns);
  for (const title of ['按车道', '按判停是否等待', '按台词类别', '多余轮次的嫌疑']) {
    assert.ok(text.includes(title), `缺一节：${title}`);
  }
  assert.equal((text.match(/不许相加/g) ?? []).length, 3);
  // 疑似误识别 / 开头语要点名到轮次，否则没法回看
  assert.match(text, /轮6「Yeah\.」/);
  assert.match(text, /轮5「你说。」/);
  // 坏样本只出现在分组表的「可算/总轮」里，**不混进**那两张嫌疑清单 ——
  // 它是算错了，不是「多出来的一轮」
  assert.ok(!/算错的一句/.test(text), '坏样本不该被当成多余轮次');
});

test('口径基线：坏样本在表里显式标出「坏样本 N」', () => {
  const text = formatStandard(turns);
  assert.match(text, /4\/5（坏样本 1）/, '剔除必须留痕 —— 悄悄变小分母看不出来');
});

/**
 * 边界值：四个「恰好落在判据上」的轮次。
 *
 * 这一组是**变异测试逼出来的**。第一版 golden 只有 ①=−317（远离 0）、②∈{0,450}
 * （远离 100）、合计 ≤1050 或 8300（远离 1500），于是四个判据改成相邻值都能通过：
 *
 * | 变异 | 第一版为什么放过它 |
 * |---|---|
 * | `①<0` → `①<=0` | 样本里没有 `① == 0`（那是合法的，不该算坏样本） |
 * | 等待门槛 100 → 50 | ② 只有 0 和 450，两边都跨得过去 |
 * | 慢轮门槛 1500 → 3000 | 样本最大 1050、次大 8300，中间是空的 |
 * | 「只缺 turn.end」也被剔除 | 没有这种轮次 |
 */
const BOUNDARY: Spec[] = [
  // ① 恰好 0：ASR 与停嘴同一毫秒。合法，**不能**算坏样本
  { stop: 1_000, asr: 0, open: 0, audio: 500, text: '嗯。', path: 'fast' },
  // ② = 70：在 50 与 100 之间 → 按 100 的门槛算「没等」
  { stop: 5_000, asr: 300, open: 70, audio: 500, text: '好。', path: 'fast' },
  // 合计 = 2000：在 1500 与 3000 之间 → 必须算慢轮
  { stop: 9_000, asr: 300, open: 0, audio: 1_700, text: '那行吧。', path: 'fast' },
  // 只缺 turn.end：首字延迟仍然算得出来，**必须进分母**
  { stop: 13_000, asr: 300, open: 0, audio: 500, text: '先这样。', path: 'fast', end: false },
];

test('口径基线：边界值（变异测试逼出来的四条）', () => {
  const b = computeTurns(parseEvents(archiveOf(BOUNDARY)));
  assert.deepEqual(
    b.map((t) => ({ a1: t.silenceToAsr, a2: t.asrToTurn, total: t.firstWordMs, bad: t.badSample, wait: t.waitedInJudge })),
    [
      { a1: 0, a2: 0, total: 500, bad: false, wait: false }, // ①=0 不是坏样本
      { a1: 300, a2: 70, total: 870, bad: false, wait: false }, // 70 < 100 → 没等
      { a1: 300, a2: 0, total: 2_000, bad: false, wait: false }, // 2000 → 慢轮
      { a1: 300, a2: 0, total: 800, bad: false, wait: false }, // 缺 turn.end 仍可算
    ],
  );
  const g = groupBy(b, () => 'all')[0];
  assert.equal(g?.count, 4, '缺 turn.end 的轮次不该被剔出分母');
  assert.equal(g?.total, 4);
  assert.equal(g?.slow, 1, '2000 ms 必须算慢轮（门槛 1500，不是 3000）');
});
