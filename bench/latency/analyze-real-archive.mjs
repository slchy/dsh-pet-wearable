/**
 * 真机档案速览：在 `latency-report.ts` 的分段之上，多一列**「等关门」**。
 *
 * 分段口径**不在这里重算** —— ① ② ③ ④ 一律来自 `src/latency-report.ts` 的
 * `computeTurns()`。这里只补两件它没有的事：
 *
 * 1. 把 ② 拆出「等关门」：`gate.close − asr.sentence`。② 大的时候看一眼这列就能
 *    分清是「在等设备静音窗走满」（判停不敢收）还是「同进程排队」。
 * 2. 一屏看完所有轮，便于人肉对上下文（`formatReport` 是给单场读的长文本）。
 *
 * 为什么要复用而不是另写一套：第一版这里自己配了一遍轮次，用了 `Array.find`
 * （给的是**最靠前**的那条定稿），第 2 轮配到第 1 轮的句子，② 直接算出 63543 ms。
 * 口径只有一个实现，见 `docs/TOOLS.md` §2。
 *
 * 跑法：node bench/latency/analyze-real-archive.mjs <档案目录|events.jsonl>
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { computeTurns, parseEvents, summarize } from '../../src/latency-report.ts';

const target = process.argv[2];
if (target === undefined) {
  console.error('用法: node bench/latency/analyze-real-archive.mjs <档案目录|events.jsonl>');
  process.exit(2);
}

const file = statSync(target).isDirectory() ? join(target, 'events.jsonl') : target;
const events = parseEvents(readFileSync(file, 'utf8'));
const turns = computeTurns(events);

const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? '   —' : String(Math.round(v)).padStart(4));

// 「等关门」要自己算 —— 但**轮次已经由 `computeTurns` 配好了**，这里只按同样的
// 顺序把「开轮之前最近的那句定稿」领掉，再找它之后的第一扇门。
// `gate.close` 记在 `asr.sentence` **之后**：能量门要等 `gapMs`（真机 ~2 s）走满，
// 往前找会一条都找不到，或者找到上一段的那扇门。
const sentences = events.filter((e) => e.ev === 'asr.sentence');
const closes = events.filter((e) => e.ev === 'gate.close');
// `computeTurns` 按 `turn.start` 出现顺序编号，所以这两个数组一一对应
const starts = events.filter((e) => e.ev === 'turn.start').map((e) => e.t);
const claimed = new Set();
function gateWaitFor(turn, index) {
  const startAt = starts[index];
  if (startAt === undefined) {
    return null;
  }
  const sentence = sentences
    .filter((s) => s.t <= startAt && !claimed.has(s))
    .pop();
  if (sentence === undefined) {
    return null;
  }
  claimed.add(sentence);
  if (turn.asrToTurn === null) {
    return null;
  }
  const close = closes.find((c) => c.t >= sentence.t && c.t - sentence.t < 5_000);
  return close === undefined ? null : close.t - sentence.t;
}

const rows = turns.map((t, i) => ({ ...t, gateWait: gateWaitFor(t, i) }));

console.log('轮  ①说完→定稿  ②定稿→开轮  等关门  ③开轮→首块  agent自报  ④播放  闭嘴→出声   文本');
for (const r of rows) {
  console.log(
    `${String(r.turn).padStart(2)}  ${fmt(r.silenceToAsr)}        ${fmt(r.asrToTurn)}        ${fmt(r.gateWait)}     `
    + `${fmt(r.turnToAudio)}        ${fmt(r.agentMs)}       ${fmt(r.playbackMs)}     ${fmt(r.firstWordMs)}    `
    + JSON.stringify(r.text.slice(0, 18)),
  );
}

// p50/p90 只给「闭嘴→出声」——项目级约定，见 src/latency-report.ts 的表头说明。
// 单段一律印「该段中位」，免得多一份裸 p50 被人引用。
// 统计算法也不自己写：`summarize()` 是唯一实现（它按线性插值算 p90，
// 最近秩会和正式报告差几十毫秒 —— 同口径两种算法等于没有口径）。
const summary = summarize(rows.map((r) => r.firstWordMs));
const segMedian = (k) => {
  const s = summarize(rows.map((r) => r[k]));
  return s.median === null ? '   —' : String(Math.round(s.median)).padStart(4);
};
console.log(
  `\n闭嘴→出声  p50 ${Math.round(summary.median ?? NaN)}   p90 ${Math.round(summary.p90 ?? NaN)} ms`
  + `  （n=${summary.count}）`,
);
console.log(
  `各段该段中位  ① ${segMedian('silenceToAsr')}   ② ${segMedian('asrToTurn')}   `
  + `③ ${segMedian('turnToAudio')}   其中模型首字 ${segMedian('agentMs')}`,
);

const slow = rows.filter((r) => r.asrToTurn !== null && r.asrToTurn > 300 && r.gateWait !== null);
if (slow.length > 0) {
  console.log(
    `\n② > 300 ms 的 ${slow.length} 轮里，「等关门」占 `
    + slow.map((r) => `${Math.round(r.gateWait)}/${Math.round(r.asrToTurn)}`).join(', ')
    + ' ms  → 慢在等设备静音窗走满（判停没敢收），不是开轮排队',
  );
}
