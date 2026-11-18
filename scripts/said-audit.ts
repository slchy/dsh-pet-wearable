/**
 * 审计模型行为：把一轮里 **用户说了什么 → 被问了什么 → 模型答了什么 → 用户听到多少**
 * 摆成一段可读的时间线。
 *
 * ```bash
 * node --experimental-strip-types scripts/said-audit.ts tmp/arch/20261118-124350
 * node --experimental-strip-types scripts/said-audit.ts tmp/arch --all
 * ```
 *
 * <h2>它补的是哪一段</h2>
 *
 * `latency-report.ts` 只回答「快不快」，`dsh-timeline.ts` 只覆盖 `path=dsh` 的思考过程。
 * 但**快车道（qwen-flash）没有 session log**，而 `isFastCandidate()` 只挡 ASCII 数字 ——
 * 中文数字、短碎片、闲聊全走这条路。所以那批轮次「模型手上到底有什么、它答成了什么」
 * 只能从档案里的三条事件读：
 *
 * | 事件 | 谁写的 | 有什么 |
 * |---|---|---|
 * | `agent.ask` | `fronted-agent` | 发出去的**全量** `messages`（system + 历史窗 + 当前句） |
 * | `agent.done` | 同上 | `raw`（模型原文）、`opened`（有没有已经推给 TTS）、耗时 |
 * | `agent.claim` / `agent.drop` | 同上 | 预跑有没有被认领、为什么作废 |
 * | `turn.end` | `turn-runner` | `said`（实际播出的话）、`heard_s`、`path` |
 * | `receipt` | `turn-runner` | 委派轮先说的那句「嗯，我想想」 |
 *
 * **老档案里没有 `said` / `agent.*`** —— 打印成「缺仪表」，不当空字符串糊过去。
 *
 * <h2>怎么读「抢话之后接没接上」</h2>
 *
 * 一段真机里的典型形态：用户念号码被打断 → 后半截单独成轮。看两处：
 *
 * 1. 后一轮的 `agent.ask.msgs` 里，**前一轮的 user 文本在不在历史窗里**；
 * 2. 后一轮的 `agent.done.raw` / `turn.end.said` 有没有把两截拼回去。
 *
 * 所以本工具把每轮的分界定成 `turn.start`，并把该轮**之前**发生的 `agent.*`
 * 归到这一轮（预跑就发生在开轮之前）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Ev {
  readonly t: number;
  readonly ev: string;
  readonly [k: string]: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function readEvents(dir: string): Ev[] {
  const out: Ev[] = [];
  for (const line of readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Ev)['t'] === 'number') {
        out.push(parsed as Ev);
      }
    } catch {
      // 半行/坏行跳过：档案不该因为一行解析不了就整份读不出来
    }
  }
  return out;
}

/** 一句话截断成一行（只是排版，不丢数据 —— 原始字段还在 events.jsonl 里） */
function oneLine(text: string, width = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') {
    return '（空）';
  }
  const chars = [...flat];
  return chars.length <= width ? flat : `${chars.slice(0, width).join('')}…`;
}

/** `msgs` 里最后一条 user 的内容 —— 「模型最后被问的那一句」 */
function lastUser(msgs: unknown): string {
  if (!Array.isArray(msgs)) {
    return '';
  }
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i] as { role?: unknown; content?: unknown };
    if (m.role === 'user') {
      return str(m.content);
    }
  }
  return '';
}

function reportOne(dir: string): string {
  let events: Ev[];
  try {
    events = readEvents(dir);
  } catch {
    return `${dir}: 没有 events.jsonl`;
  }
  const starts = events.filter((e) => e.ev === 'turn.start');
  const out: string[] = [`== ${dir}（${starts.length} 轮）==`];
  let missingSaid = 0;
  let nEnd = 0;

  starts.forEach((start, i) => {
    const from = start.t;
    const to = i + 1 < starts.length ? (starts[i + 1] as Ev).t : Number.POSITIVE_INFINITY;
    // 预跑发生在开轮**之前**：把「上一轮收尾 ~ 本轮开轮」这一段也算进来
    const prevT = i > 0 ? (starts[i - 1] as Ev).t : Number.NEGATIVE_INFINITY;
    const asks = events.filter(
      (e) => e.ev === 'agent.ask' && e.t > prevT && e.t < from,
    );
    const settled = events.filter(
      (e) => (e.ev === 'agent.done' || e.ev === 'agent.claim' || e.ev === 'agent.drop')
        && e.t > prevT && e.t < to,
    );
    const end = events.find((e) => e.ev === 'turn.end' && e.t > from && e.t < to);
    const receipts = events.filter((e) => e.ev === 'receipt' && e.t > from && e.t < to);
    const sentence = [...events].reverse().find(
      (e) => (e.ev === 'asr.sentence' || (e.ev === 'pet.in' && e['kind'] === 'userFinal'))
        && e.t <= from && str(e['text']) !== '',
    );

    const said = end === undefined ? null : end['said'];
    if (end !== undefined) {
      nEnd += 1;
      if (typeof said !== 'string') {
        missingSaid += 1;
      }
    }
    const audio = end === undefined ? null : num(end['audio_s']);
    const heard = end === undefined ? null : num(end['heard_s']);
    const heardPct = audio !== null && heard !== null && audio > 0
      ? `${Math.round((heard / audio) * 100)}%`
      : '-';

    out.push('');
    out.push(
      `#${i + 1}  用户 ${JSON.stringify(oneLine(str(sentence?.['text'])))}`
      + `  路径 ${str(end?.['path']) || '-'}`
      + `  听到 ${heard === null ? '-' : heard}s/${audio === null ? '-' : audio}s（${heardPct}）`
      + (end?.['interrupted'] === true ? '  [被打断]' : ''),
    );
    if (receipts.length > 0) {
      out.push(`   回执 ${receipts.map((r) => JSON.stringify(oneLine(str(r['text']), 24))).join(' + ')}`);
    }
    if (typeof said === 'string') {
      out.push(`   说   ${JSON.stringify(oneLine(said))}`);
    } else if (end !== undefined) {
      out.push('   说   （缺仪表：这条档案没有 turn.end.said）');
    }
    for (const a of asks) {
      const msgs = a['msgs'];
      const n = Array.isArray(msgs) ? msgs.length : 0;
      out.push(
        `   问   ${str(a['kind']) || '?'}：${JSON.stringify(oneLine(lastUser(msgs)))}`
        + `（${n} 条 messages${n === 0 ? '，缺仪表' : ''}）`,
      );
    }
    for (const s of settled) {
      if (s.ev === 'agent.done') {
        const ok = s['ok'] === true;
        out.push(ok
          ? `   答   ${JSON.stringify(oneLine(str(s['raw'])))}`
            + `  ${s['first_token_ms']}ms 首字 / ${s['ms']}ms 到手`
            + (s['opened'] === true ? '  已推 TTS' : '')
            + (s['delegated'] === true ? '  [[DELEGATE]]' : '')
          : `   答   ✗ ${str(s['err'])}（${s['ms']}ms）`);
      } else if (s.ev === 'agent.claim') {
        out.push(`   认领 ${s['ok'] === true ? '✓' : `✗ ${str(s['why'])}`}`);
      } else {
        out.push(`   作废 ${str(s['why'])}`);
      }
    }
  });

  if (nEnd > 0 && missingSaid === nEnd) {
    out.push('');
    out.push('（这份档案是补仪表之前采的：没有 turn.end.said / agent.*，只有 ①②③ 和打断）');
  }
  return out.join('\n');
}

function main(argv: readonly string[]): number {
  const args = argv.filter((a) => !a.startsWith('--'));
  const all = argv.includes('--all');
  const target = args[0];
  if (target === undefined) {
    console.error('用法: node --experimental-strip-types scripts/said-audit.ts <会话目录|档案根> [--all]');
    return 2;
  }
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

process.exitCode = main(process.argv.slice(2));
