/**
 * 延迟归因：把会话档案压成「各段对 p50 / p90 的贡献」，用来回答「该治哪一段」。
 *
 * 分段口径完全复用 `src/latency-report.ts::computeTurns`（唯一定义处），
 * 这里只做聚合与归因，不重新定义任何时刻。
 *
 * ```bash
 * node --experimental-strip-types scripts/latency-attribution.ts tmp/arch/20261118-124350
 * node --experimental-strip-types scripts/latency-attribution.ts tmp/arch --all
 * ```
 *
 * <h2>为什么不能只看各段中位数</h2>
 *
 * 总延迟不是「各段 p50 相加」——p50 之和 ≠ p50。要判断该治哪一段，必须看**同一轮里**
 * 谁占大头，以及 p90 那一轮是被哪一段顶上去的。所以这里做三件事：
 *
 * 1. 每段的 p50 / p90 / p95 / 最大（只在**该段有值**的轮次上算，缺失不当 0）；
 * 2. 完整轮次（①②③ 都有）上，各段占 `firstWordMs` 的份额；
 * 3. 对第 2 步的份额按轮次求「谁最大」，并单独列出 p90 那一轮的三段拆分。
 *
 * Pure Live 后台汇报（`announce` 带 `source`）是**异步段**：文末单独成节，
 * 指标一律叫「后台委派→汇报」。它不并进「闭嘴→出声」的 p50 / p90；
 * 配不到委派轮记 `null`，不拿 0 冒充。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isMainModule } from '../src/main.ts';
import {
  FIRST_WORD_BUDGET_MS,
  computeTurns,
  parseEvents,
  percentile,
  type ArchiveEvent,
  type TurnLatency,
} from '../src/latency-report.ts';

type Seg = 'silenceToAsr' | 'asrToTurn' | 'turnToAudio';

const SEGS: readonly { key: Seg; label: string }[] = [
  { key: 'silenceToAsr', label: '① 判停+ASR' },
  { key: 'asrToTurn', label: '② 定稿→开轮' },
  { key: 'turnToAudio', label: '③ agent+TTS' },
];

/**
 * 分位数**复用 `src/latency-report.ts` 的 `percentile`**（线性插值）。
 *
 * 这里曾经自己写了一个最近秩版本 —— 那正是 `percentile` 注释里点名禁止的：
 * 偶数样本会取偏小的那个，让延迟系统性偏乐观（本例 fast n=12 因此报成 1001，
 * 正确值是 1033）。口径只能有一个实现。
 */
function quantile(values: readonly number[], q: number): number | null {
  return percentile(values, q);
}

function describe(values: readonly number[]): string {
  if (values.length === 0) {
    return 'n=0';
  }
  const p50 = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  const p95 = quantile(values, 0.95);
  const max = Math.max(...values);
  const r = (v: number | null): string => (v === null ? '-' : String(Math.round(v)));
  return `n=${values.length}  p50 ${r(p50)}  p90 ${r(p90)}  p95 ${r(p95)}  max ${r(max)}`;
}

/** 把一轮里有的那几段取出来。 */
function segmentsOf(turn: TurnLatency): { key: Seg; label: string; value: number }[] {
  const out: { key: Seg; label: string; value: number }[] = [];
  for (const seg of SEGS) {
    const value = turn[seg.key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ ...seg, value });
    }
  }
  return out;
}

/**
 * 后台汇报离它认领的那次 `turn.start` 超过这么久，就不再当成同一次任务。
 * 5 分钟：再晚的播报对不上「用户刚说的那句」，硬配会把无关等待算进周转。
 */
const BACKGROUND_TURNAROUND_WINDOW_MS = 300_000;

/**
 * 从这一轮用户话派出去、和委派轮一一对应的来源。
 * 按汇报时间贪心认领「最近一条还没被配对的委派 `turn.start`」，同一轮不许分给两条。
 *
 * `dsh_background` 不在这里：那是 dsh 自己的播报，可以贴最近一条委派轮，但不占名额。
 */
const CLAIMING_SOURCES: ReadonlySet<string> = new Set(['tool_call', 'early_rule', 'image']);

export interface BackgroundTurnaround {
  readonly announceAt: number;
  readonly source: string;
  readonly verbatim: boolean;
  /** 距最近一条尚未配对的委派轮 `turn.start` 的时长（ms）；配不到则为 `null` */
  readonly turnaroundMs: number | null;
  readonly matchedTurn: number | null;
}

interface DelegatedTurn {
  /** 与 `computeTurns` 相同：按 `turn.start` 出现顺序，从 1 计 */
  readonly turn: number;
  readonly startAt: number;
  claimed: boolean;
}

function eventRecord(event: ArchiveEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

function stringField(event: ArchiveEvent, key: 'source' | 'delegate'): string | undefined {
  const value = eventRecord(event)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function verbatimField(event: ArchiveEvent): boolean {
  return eventRecord(event)['verbatim'] === true;
}

/**
 * 委派轮：某次 `turn.start` 对应的 `turn.end`（下一次 `turn.start` 之前）带有
 * `delegate` 字符串。时间窗与 `computeTurns` 相同；`path` 本身不在这里重算。
 */
function collectDelegatedTurns(events: readonly ArchiveEvent[]): DelegatedTurn[] {
  const startTimes: number[] = [];
  for (const event of events) {
    if (event.ev === 'turn.start') {
      startTimes.push(event.t);
    }
  }
  const out: DelegatedTurn[] = [];
  for (let i = 0; i < startTimes.length; i += 1) {
    const startAt = startTimes[i];
    if (startAt === undefined) {
      continue;
    }
    const next = startTimes[i + 1] ?? Number.POSITIVE_INFINITY;
    const end = events.find((event) => event.ev === 'turn.end' && event.t > startAt && event.t < next);
    if (end !== undefined && stringField(end, 'delegate') !== undefined) {
      out.push({ turn: i + 1, startAt, claimed: false });
    }
  }
  return out;
}

/** 开跑时刻 ≤ 汇报时刻、且落在窗口内的委派轮里，取最近的一条。 */
function nearestDelegated(
  turns: readonly DelegatedTurn[],
  announceAt: number,
  unclaimedOnly: boolean,
): DelegatedTurn | null {
  let best: DelegatedTurn | null = null;
  for (const turn of turns) {
    if (unclaimedOnly && turn.claimed) {
      continue;
    }
    if (!Number.isFinite(turn.startAt) || turn.startAt > announceAt) {
      continue;
    }
    const delta = announceAt - turn.startAt;
    if (delta > BACKGROUND_TURNAROUND_WINDOW_MS) {
      continue;
    }
    if (best === null || turn.startAt > best.startAt || (turn.startAt === best.startAt && turn.turn > best.turn)) {
      best = turn;
    }
  }
  return best;
}

/**
 * Pure Live 后台汇报的周转：每条带 `source` 的 `announce` 一条。
 *
 * - `tool_call` / `early_rule` / `image`：贪心认领最近一条**尚未配对**、
 *   且 `turn.start` ≤ 汇报时刻、间隔 ≤ 300_000 ms 的委派轮。
 * - `dsh_background`：贴最近一条满足同一时间窗的委派轮（不要求未被认领），
 *   也不把那一轮占掉。
 * - 配不到：`turnaroundMs` 与 `matchedTurn` 都是 `null`，绝不写成 0。
 */
export function computeBackgroundTurnarounds(events: readonly ArchiveEvent[]): BackgroundTurnaround[] {
  const turns = collectDelegatedTurns(events);
  const announces: { readonly at: number; readonly source: string; readonly verbatim: boolean; readonly order: number }[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined || event.ev !== 'announce') {
      continue;
    }
    const source = stringField(event, 'source');
    if (source === undefined) {
      continue;
    }
    announces.push({ at: event.t, source, verbatim: verbatimField(event), order: i });
  }
  announces.sort((a, b) => a.at - b.at || a.order - b.order);

  const out: BackgroundTurnaround[] = [];
  for (const announce of announces) {
    let matched: DelegatedTurn | null = null;
    if (announce.source === 'dsh_background') {
      matched = nearestDelegated(turns, announce.at, false);
    } else if (CLAIMING_SOURCES.has(announce.source)) {
      matched = nearestDelegated(turns, announce.at, true);
      if (matched !== null) {
        matched.claimed = true;
      }
    }
    out.push({
      announceAt: announce.at,
      source: announce.source,
      verbatim: announce.verbatim,
      turnaroundMs: matched === null ? null : announce.at - matched.startAt,
      matchedTurn: matched === null ? null : matched.turn,
    });
  }
  return out;
}

function appendBackground(lines: string[], events: readonly ArchiveEvent[]): void {
  const rows = computeBackgroundTurnarounds(events);
  if (rows.length === 0) {
    return;
  }
  lines.push('## Pure Live 后台委派→汇报（异步段，不计入首声 p50）');
  lines.push(`- 条数：${rows.length}`);
  const bySource = new Map<string, number>();
  for (const row of rows) {
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
  }
  const breakdown = [...bySource.entries()].map(([source, count]) => `${source} ${count}`).join('、');
  lines.push(`- 按 source：${breakdown}`);
  let verbatim = 0;
  const paired: number[] = [];
  for (const row of rows) {
    if (row.verbatim) {
      verbatim += 1;
    }
    if (row.turnaroundMs !== null) {
      paired.push(row.turnaroundMs);
    }
  }
  lines.push(`- verbatim：${verbatim}`);
  lines.push(`- 后台委派→汇报 p50 / p90：${describe(paired)}`);
  const unpaired = rows.length - paired.length;
  if (unpaired > 0) {
    lines.push(`- 未配对：${unpaired}（turnaroundMs = null，不拿 0 冒充）`);
  }
  lines.push('');
}

/**
 * `parseEvents` 只抄延迟分段要的字段，`source` / `verbatim` / `delegate` 会丢。
 * 那份解析器在 `src/latency-report.ts`，归 `npm run mutate` 守着，这里不能改。
 * 跳行规则与它保持一致，再把这三项贴回到同一条事件上。
 */
function overlayLiveFields(jsonl: string, events: readonly ArchiveEvent[]): ArchiveEvent[] {
  const rawKept: Record<string, unknown>[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const t = obj['t'];
    const ev = obj['ev'];
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof ev !== 'string' || ev === '') {
      continue;
    }
    rawKept.push(obj);
  }
  if (rawKept.length !== events.length) {
    return [...events];
  }
  return events.map((event, index) => {
    const raw = rawKept[index];
    if (raw === undefined || raw['t'] !== event.t || raw['ev'] !== event.ev) {
      return event;
    }
    const extra: { source?: string; verbatim?: boolean; delegate?: string } = {};
    if (typeof raw['source'] === 'string') {
      extra.source = raw['source'];
    }
    if (typeof raw['verbatim'] === 'boolean') {
      extra.verbatim = raw['verbatim'];
    }
    if (typeof raw['delegate'] === 'string') {
      extra.delegate = raw['delegate'];
    }
    return { ...event, ...extra };
  });
}

/**
 * 归因报告。`label` 写在标题上（通常是会话目录）。
 *
 * 各段分布、份额、按路径拆、③ 内部拆分、p90 归因、超预算轮次与原先一致。
 * 有后台汇报时，文末另起一节，不改上面任何一行。
 */
export function formatAttribution(events: readonly ArchiveEvent[], label: string): string {
  const turns = computeTurns(events);

  const lines: string[] = [`# ${label}（${turns.length} 轮）`, ''];

  // ---- 1. 每段自己的分布 ----
  lines.push('## 各段分布（只在该段有值的轮次上算，缺失不补 0）');
  for (const seg of SEGS) {
    const values = turns
      .map((t) => t[seg.key])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const negative = values.filter((v) => v < 0).length;
    lines.push(`- ${seg.label}：${describe(values)}${negative > 0 ? `（含 ${negative} 个负值，起点不可靠）` : ''}`);
  }
  const totals = turns
    .map((t) => t.firstWordMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  lines.push(`- **闭嘴→出声**：${describe(totals)}`);
  lines.push('');

  // ---- 2. 完整轮次上的份额 ----
  // 负值必须剔除：旧档案的 `gate.close` 没有 `gapMs`，停嘴时刻只能取记录时刻，
  // ① 会算出负数。带进份额里会把「总和」冲掉，得出「① 占 -4.6%」这种废话。
  const complete = turns.filter((t) => {
    const segs = segmentsOf(t);
    return segs.length === 3 && segs.every((s) => s.value >= 0);
  });
  const dropped = turns.filter((t) => segmentsOf(t).length === 3 && segmentsOf(t).some((s) => s.value < 0)).length;
  lines.push(
    `## 份额（完整轮次 ${complete.length}/${turns.length}：①②③ 都在且非负`
      + `${dropped > 0 ? `；另有 ${dropped} 轮含负段，已剔除` : ''}）`,
  );
  if (complete.length === 0) {
    lines.push('- 没有完整轮次，无法归因');
  } else {
    const sums: Record<Seg, number> = { silenceToAsr: 0, asrToTurn: 0, turnToAudio: 0 };
    const winners: Record<Seg, number> = { silenceToAsr: 0, asrToTurn: 0, turnToAudio: 0 };
    for (const turn of complete) {
      const segs = segmentsOf(turn);
      for (const seg of segs) {
        sums[seg.key] += seg.value;
      }
      const top = [...segs].sort((a, b) => b.value - a.value)[0];
      if (top) {
        winners[top.key] += 1;
      }
    }
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    for (const seg of SEGS) {
      const share = total > 0 ? (sums[seg.key] / total) * 100 : 0;
      lines.push(
        `- ${seg.label}：合计 ${Math.round(sums[seg.key])} ms（${share.toFixed(1)}%），是当年最大段的有 ${winners[seg.key]} 轮`,
      );
    }
    const worst = SEGS.map((s) => ({ ...s, share: total > 0 ? sums[s.key] / total : 0 })).sort(
      (a, b) => b.share - a.share,
    )[0];
    if (worst) {
      lines.push(`- **结论：按总量，${worst.label} 占 ${(worst.share * 100).toFixed(1)}%，是首要项**`);
    }
  }
  lines.push('');

  // ---- 1b. 按路径拆「闭嘴→出声」----
  // 这是本项目唯一可以叫 p50 的量（§12.1）。分路径看才回答得了「快车道多快」。
  lines.push('## 按路径拆：闭嘴 → 出声（= 项目 p50 口径）');
  const byPath = new Map<string, number[]>();
  for (const turn of turns) {
    const value = turn.firstWordMs;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    const path = turn.path ?? '（未记 path）';
    const list = byPath.get(path) ?? [];
    list.push(value);
    byPath.set(path, list);
  }
  if (byPath.size === 0) {
    lines.push('- 没有可用的 firstWordMs');
  }
  for (const [path, values] of [...byPath.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const p50 = quantile(values, 0.5);
    const p90 = quantile(values, 0.9);
    const sorted = [...values].sort((a, b) => a - b);
    lines.push(`- **${path}**：${describe(values)}  取值 ${sorted.join(' / ')}`);
    if (p50 !== null && p90 !== null) {
      lines.push(`  → p50 ${Math.round(p50)} / p90 ${Math.round(p90)}（预算 ${FIRST_WORD_BUDGET_MS}）`);
    }
  }
  lines.push('');

  // ---- 2b. ③ 内部拆分：agent 自报 vs 其余 ----
  // ③ 是最大一块，但它混了「agent 想」和「TTS 出声前那段」。`agentMs` 是 agent 自报，
  // 所以 ③ − agentMs 就是进程开销 + TTS 首包。注意两者**不是相加关系**：
  // 文本一边生成一边送 TTS，实测 tts_first 有时反而大于 ③ − agentMs。
  const withAgent = turns.filter(
    (t) => typeof t.turnToAudio === 'number' && typeof t.agentMs === 'number' && t.agentMs >= 0,
  );
  lines.push(`### ③ 内部拆分（n=${withAgent.length}）`);
  if (withAgent.length === 0) {
    lines.push('- 没有 agent 自报耗时，无法拆分');
  } else {
    const agent = withAgent.map((t) => t.agentMs as number);
    const rest = withAgent.map((t) => (t.turnToAudio as number) - (t.agentMs as number));
    lines.push(`- agent 自报：${describe(agent)}`);
    lines.push(`- ③ − agent（进程开销 + TTS 首包）：${describe(rest)}`);
  }
  lines.push('');
  lines.push('');

  // ---- 3. p90 那一轮是谁顶上去的 ----
  const sortedTotals = [...totals].sort((a, b) => a - b);
  const p90 = quantile(sortedTotals, 0.9);
  lines.push(`## p90 归因（闭嘴→出声 p90 = ${p90} ms）`);
  if (p90 !== null) {
    const near = turns.filter(
      (t) => typeof t.firstWordMs === 'number' && Math.abs(t.firstWordMs - p90) <= 120,
    );
    for (const turn of near) {
      const segs = segmentsOf(turn);
      const top = [...segs].sort((a, b) => b.value - a.value)[0];
      lines.push(
        `- 第 ${turn.turn} 轮 ${turn.firstWordMs} ms（${turn.text}）`
          + ` → ${segs.map((s) => `${s.label} ${s.value}`).join(' / ')}`
          + (top ? `  ← 最大段 ${top.label}` : ''),
      );
    }
  }
  lines.push('');

  // ---- 4. 慢轮清单：超过预算的轮次逐条摊开 ----
  const slow = turns
    .filter((t) => typeof t.firstWordMs === 'number' && t.firstWordMs > FIRST_WORD_BUDGET_MS)
    .sort((a, b) => (b.firstWordMs ?? 0) - (a.firstWordMs ?? 0));
  lines.push(`## 超预算轮次（> ${FIRST_WORD_BUDGET_MS} ms，共 ${slow.length}/${turns.length}）`);
  for (const turn of slow) {
    const segs = segmentsOf(turn);
    const top = [...segs].sort((a, b) => b.value - a.value)[0];
    lines.push(
      `- #${turn.turn} ${turn.firstWordMs} ms：`
        + segs.map((s) => `${s.label} ${s.value}`).join(' / ')
        + (top ? `（主因 ${top.label}，占 ${((top.value / (turn.firstWordMs ?? 1)) * 100).toFixed(0)}%）` : '')
        + ` ${turn.text}`,
    );
  }
  lines.push('');
  appendBackground(lines, events);
  return lines.join('\n');
}

function reportOne(dir: string): string {
  const file = join(dir, 'events.jsonl');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return `# ${dir}\n\n读不到 events.jsonl：${(error as Error).message}\n`;
  }
  return formatAttribution(overlayLiveFields(text, parseEvents(text)), dir);
}

function main(argv: readonly string[]): number {
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('用法: node scripts/latency-attribution.ts <会话目录|档案根目录> [--all]');
    return 2;
  }
  const all = argv.includes('--all');
  let isDir: boolean;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    console.error(`目录不存在: ${target}`);
    return 2;
  }
  if (!isDir) {
    console.error(`不是目录: ${target}`);
    return 2;
  }
  if (!all) {
    console.log(reportOne(target));
    return 0;
  }
  for (const name of readdirSync(target).sort()) {
    const dir = join(target, name);
    try {
      if (!statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    console.log(reportOne(dir));
  }
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
