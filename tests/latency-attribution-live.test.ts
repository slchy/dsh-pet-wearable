/**
 * Pure Live 后台汇报的归因：周转单独成节，不许混进「闭嘴→出声」。
 *
 * 缺配对记 `null`。写成 0 会把「还没对上」伪装成「瞬间汇报完」。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeBackgroundTurnarounds,
  formatAttribution,
} from '../scripts/latency-attribution.ts';
import { FIRST_WORD_BUDGET_MS, percentile } from '../src/latency-report.ts';

interface RawEvent {
  readonly t: number;
  readonly ev: string;
  readonly text?: string;
  readonly path?: string;
  readonly delegate?: string;
  readonly source?: string;
  readonly verbatim?: boolean;
  readonly len?: number;
  readonly emotion?: string;
  readonly ms?: number;
}

const HEADING = '## Pure Live 后台委派→汇报（异步段，不计入首声 p50）';

function speechTurn(spec: {
  readonly gate: number;
  readonly asr: number;
  readonly start: number;
  readonly first: number;
  readonly end: number;
  readonly text: string;
  readonly path?: string;
  readonly delegate?: string;
}): RawEvent[] {
  const end: RawEvent = spec.delegate === undefined
    ? { t: spec.end, ev: 'turn.end', path: spec.path ?? 'omni' }
    : { t: spec.end, ev: 'turn.end', path: spec.path ?? 'omni', delegate: spec.delegate };
  // `computeTurns` 从本轮 `asr.sentence` 往后认领第一条 `gate.close`。
  // 门事件若写在定稿前面，下一轮的门会被这一轮抢走，① 变成负数，首声整段作废。
  return [
    { t: spec.asr, ev: 'asr.sentence', text: spec.text },
    { t: spec.start, ev: 'turn.start' },
    { t: spec.gate, ev: 'gate.close' },
    { t: spec.first, ev: 'tts.first', ms: spec.first - spec.start },
    end,
  ];
}

function rounded(values: readonly number[], q: number): number {
  const value = percentile(values, q);
  assert.ok(value !== null);
  return Math.round(value);
}

test('Pure Live：两条 tool_call 汇报各认领一条委派轮，且不改闭嘴→出声', () => {
  // 两条委派轮都结束后才来汇报。贪心认领「最近一条还没配对的 turn.start」：
  // 先到的汇报拿走第 4 轮，后到的只能拿第 3 轮，不许两条都写成第 4 轮。
  const events: RawEvent[] = [
    ...speechTurn({ gate: 1000, asr: 1300, start: 1400, first: 1800, end: 2200, text: '今天天气', path: 'omni' }),
    ...speechTurn({ gate: 3000, asr: 3300, start: 3400, first: 3900, end: 4300, text: '再说一遍', path: 'omni' }),
    ...speechTurn({
      gate: 5000, asr: 5300, start: 5500, first: 6000, end: 6400,
      text: '查一下航班', path: 'omni', delegate: 'task',
    }),
    ...speechTurn({
      gate: 10000, asr: 10300, start: 10500, first: 11100, end: 11600,
      text: '帮我订票', path: 'omni', delegate: 'delegate',
    }),
    { t: 16000, ev: 'announce', source: 'tool_call', verbatim: false, len: 8 },
    { t: 20000, ev: 'announce', source: 'tool_call', verbatim: true, len: 40 },
  ];

  const rows = computeBackgroundTurnarounds(events);
  assert.deepEqual(
    rows.map((row) => ({
      announceAt: row.announceAt,
      source: row.source,
      verbatim: row.verbatim,
      turnaroundMs: row.turnaroundMs,
      matchedTurn: row.matchedTurn,
    })),
    [
      { announceAt: 16000, source: 'tool_call', verbatim: false, turnaroundMs: 5500, matchedTurn: 4 },
      { announceAt: 20000, source: 'tool_call', verbatim: true, turnaroundMs: 14500, matchedTurn: 3 },
    ],
  );
  assert.notEqual(rows[0]?.matchedTurn, rows[1]?.matchedTurn);

  const label = 'pure-live';
  const report = formatAttribution(events, label);
  const at = report.indexOf(HEADING);
  assert.ok(at > 0, report);
  const foreground = formatAttribution(events.filter((event) => event.ev !== 'announce'), label);
  assert.equal(report.slice(0, at), `${foreground}\n`);
  assert.equal(foreground.includes('Pure Live 后台委派→汇报'), false);

  const firstWord = [800, 900, 1000, 1100];
  const voiceP50 = rounded(firstWord, 0.5);
  const voiceP90 = rounded(firstWord, 0.9);
  assert.match(foreground, new RegExp(`\\*\\*闭嘴→出声\\*\\*：n=4  p50 ${voiceP50}  p90 ${voiceP90}`));

  const turnaround = [5500, 14500];
  const backP50 = rounded(turnaround, 0.5);
  const backP90 = rounded(turnaround, 0.9);
  assert.notEqual(backP50, voiceP50);
  assert.equal(foreground.includes(`p50 ${backP50}`), false);

  const section = report.slice(at);
  assert.match(section, /条数：2/);
  assert.match(section, /按 source：tool_call 2/);
  assert.match(section, /verbatim：1/);
  assert.ok(section.includes(`后台委派→汇报 p50 / p90：n=2  p50 ${backP50}  p90 ${backP90}`), section);
  assert.equal(section.includes('未配对'), false);
});

test('没有前序委派轮的汇报：turnaroundMs 是 null，不是 0', () => {
  const events: RawEvent[] = [
    ...speechTurn({ gate: 1000, asr: 1200, start: 1300, first: 1800, end: 2200, text: '你好', path: 'omni' }),
    { t: 3000, ev: 'announce', source: 'tool_call', verbatim: false, len: 4 },
    ...speechTurn({
      gate: 4000, asr: 4300, start: 4400, first: 5000, end: 5400,
      text: '查天气', path: 'omni', delegate: 'task',
    }),
  ];

  const rows = computeBackgroundTurnarounds(events);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.source, 'tool_call');
  assert.equal(row.turnaroundMs, null);
  assert.equal(row.matchedTurn, null);
  assert.notEqual(row.turnaroundMs, 0);

  const report = formatAttribution(events, 'unpaired');
  const at = report.indexOf(HEADING);
  assert.ok(at > 0);
  const section = report.slice(at);
  assert.match(section, /条数：1/);
  assert.match(section, /未配对：1（turnaroundMs = null，不拿 0 冒充）/);
  assert.match(section, /后台委派→汇报 p50 \/ p90：n=0/);
  assert.doesNotMatch(section, /p50 0/);

  const foreground = formatAttribution(events.filter((event) => event.ev !== 'announce'), 'unpaired');
  assert.equal(report.slice(0, at), `${foreground}\n`);
  assert.match(foreground, /\*\*闭嘴→出声\*\*：n=2 /);
});

test('Cascade 档案没有带 source 的 announce 时，不出现后台节', () => {
  const events: RawEvent[] = [
    ...speechTurn({ gate: 1000, asr: 1400, start: 1500, first: 2200, end: 3000, text: '在吗', path: 'fast' }),
    ...speechTurn({
      gate: 4000, asr: 4400, start: 4500, first: 5200, end: 6000,
      text: '帮我记一下', path: 'dsh', delegate: 'task',
    }),
    { t: 7000, ev: 'announce', len: 8, emotion: '平静' },
  ];

  assert.deepEqual(computeBackgroundTurnarounds(events), []);
  const report = formatAttribution(events, 'cascade');
  assert.equal(report.includes('Pure Live 后台委派→汇报'), false);
  assert.match(report, /## 各段分布/);
  assert.match(report, /## 份额/);
  assert.match(report, /## 按路径拆/);
  assert.match(report, /### ③ 内部拆分/);
  assert.match(report, /## p90 归因/);
  assert.match(report, /## 超预算轮次/);
  assert.match(report, /\*\*闭嘴→出声\*\*/);
});

test('窗口、dsh_background 不占名额，其它来源按认领规则配对', () => {
  const shared: RawEvent[] = [
    ...speechTurn({
      gate: 100, asr: 200, start: 1000, first: 1400, end: 1600,
      text: '第一件', path: 'omni', delegate: 'delegate',
    }),
    ...speechTurn({
      gate: 2000, asr: 2200, start: 5000, first: 5400, end: 5600,
      text: '第二件', path: 'omni', delegate: 'task',
    }),
    { t: 6000, ev: 'announce', source: 'tool_call', verbatim: false, len: 4 },
    { t: 7000, ev: 'announce', source: 'dsh_background', verbatim: true, len: 12 },
    { t: 8000, ev: 'announce', source: 'early_rule', verbatim: false, len: 4 },
    { t: 9000, ev: 'announce', source: 'image', verbatim: false, len: 4 },
  ];
  assert.deepEqual(
    computeBackgroundTurnarounds(shared).map((row) => ({
      source: row.source,
      verbatim: row.verbatim,
      turnaroundMs: row.turnaroundMs,
      matchedTurn: row.matchedTurn,
    })),
    [
      // 最近的未认领委派轮是第 2 轮（start 5000）
      { source: 'tool_call', verbatim: false, turnaroundMs: 1000, matchedTurn: 2 },
      // dsh 贴最近一条，哪怕刚被 tool_call 认领过，而且不占名额
      { source: 'dsh_background', verbatim: true, turnaroundMs: 2000, matchedTurn: 2 },
      // 第 2 轮已被占，early_rule 退回第 1 轮
      { source: 'early_rule', verbatim: false, turnaroundMs: 7000, matchedTurn: 1 },
      { source: 'image', verbatim: false, turnaroundMs: null, matchedTurn: null },
    ],
  );

  const atWindow = [
    ...speechTurn({
      gate: 0, asr: 10, start: 0, first: 40, end: 50,
      text: '刚好', path: 'omni', delegate: 'task',
    }),
    { t: 300_000, ev: 'announce', source: 'tool_call', verbatim: false, len: 2 },
  ];
  const inside = computeBackgroundTurnarounds(atWindow);
  assert.equal(inside.length, 1);
  assert.equal(inside[0]?.turnaroundMs, 300_000);
  assert.equal(inside[0]?.matchedTurn, 1);

  const pastWindow = [
    ...speechTurn({
      gate: 0, asr: 10, start: 0, first: 40, end: 50,
      text: '太晚', path: 'omni', delegate: 'task',
    }),
    { t: 300_001, ev: 'announce', source: 'early_rule', verbatim: false, len: 2 },
  ];
  const outside = computeBackgroundTurnarounds(pastWindow);
  assert.equal(outside[0]?.turnaroundMs, null);
  assert.equal(outside[0]?.matchedTurn, null);
  assert.notEqual(outside[0]?.turnaroundMs, 0);

  const sameInstant = [
    ...speechTurn({
      gate: 100, asr: 200, start: 8000, first: 8400, end: 8600,
      text: '同时', path: 'omni', delegate: 'task',
    }),
    { t: 8000, ev: 'announce', source: 'image', verbatim: true, len: 3 },
  ];
  const zero = computeBackgroundTurnarounds(sameInstant);
  assert.equal(zero[0]?.turnaroundMs, 0);
  assert.equal(zero[0]?.matchedTurn, 1);
  assert.equal(zero[0]?.verbatim, true);

  const silent = [
    ...speechTurn({
      gate: 100, asr: 200, start: 1000, first: 1400, end: 1600,
      text: '记住', path: 'omni', delegate: 'task',
    }),
    { t: 2000, ev: 'announce', source: 'memory_silent', verbatim: false, len: 2 },
    { t: 3000, ev: 'announce', source: 'tool_call', verbatim: false, len: 2 },
  ];
  const silentRows = computeBackgroundTurnarounds(silent);
  assert.equal(silentRows[0]?.source, 'memory_silent');
  assert.equal(silentRows[0]?.turnaroundMs, null);
  assert.equal(silentRows[0]?.matchedTurn, null);
  assert.equal(silentRows[1]?.matchedTurn, 1);
  assert.equal(silentRows[1]?.turnaroundMs, 2000);
});

test('按路径拆读这一轮的 path，预算不另写死', () => {
  // turn.end 与 turn.start 同一时刻。按 t > start 再扫一遍会把它看成「没记 path」。
  const report = formatAttribution([
    { t: 180, ev: 'asr.sentence', text: '甲' },
    { t: 200, ev: 'turn.start' },
    { t: 200, ev: 'turn.end', path: 'live' },
    { t: 220, ev: 'gate.close', gapMs: 40 },
    { t: 400, ev: 'tts.first' },
  ], 'same-stamp');
  assert.match(report, /\*\*live\*\*/);
  assert.doesNotMatch(report, /未记 path/);
  assert.match(report, new RegExp(`预算 ${FIRST_WORD_BUDGET_MS}`));
  assert.match(report, new RegExp(`> ${FIRST_WORD_BUDGET_MS} ms`));
});

test('events.jsonl 上的 source / delegate 穿过 parseEvents 后仍能归因', { timeout: 60_000 }, () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/latency-attribution.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'lat-attr-'));
  const lines = [
    { t: 1000, ev: 'gate.close' },
    { t: 1300, ev: 'asr.sentence', text: '查一下' },
    { t: 1400, ev: 'turn.start' },
    { t: 1800, ev: 'tts.first', ms: 400 },
    { t: 2200, ev: 'turn.end', path: 'omni', delegate: 'task' },
    { t: 5000, ev: 'announce', len: 6, source: 'tool_call', verbatim: true },
  ];
  try {
    writeFileSync(join(dir, 'events.jsonl'), `${lines.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', script, dir], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const stdout = run.stdout;
    assert.match(stdout, /Pure Live 后台委派→汇报/);
    assert.match(stdout, /\*\*闭嘴→出声\*\*：n=1  p50 800/);
    assert.match(stdout, /后台委派→汇报 p50 \/ p90：n=1  p50 3600/);
    assert.match(stdout, /按 source：tool_call 1/);
    assert.match(stdout, /verbatim：1/);
    assert.doesNotMatch(stdout, /闭嘴→出声\*\*：n=1  p50 3600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
