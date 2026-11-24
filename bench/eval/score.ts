/**
 * 离线准确率 + 性能护栏打分器（纯本地计算，零网络调用）。
 *
 * 硬约束（见 `AGENTS.md`）：
 * - 延迟分段与汇总**唯一复用** `src/latency-report.ts` 的 `computeTurns()` / `summarize()`，
 *   绝不在本文件里另写一套统计口径。
 * - 所有准确率指标都可逐条溯源到原始 ASR 文本、前台说出的内容、`dsh-calls.jsonl` 与
 *   `bg-reports.jsonl`，既给汇总分也列全部失败明细。
 *
 * 用法：
 *   node bench/eval/score.ts --artifact /tmp/miai-eval/run1/run-artifact.json [--out baseline.json]
 *   node bench/eval/score.ts --compare base.json cand.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  computeTurns,
  percentile,
  summarize,
  type ArchiveEvent,
  type Sample,
  type TurnLatency,
} from '../../src/latency-report.ts';
import { isMainModule } from '../../src/main.ts';
import type {
  BgReportRecord,
  CaseRunTrace,
  DshCallRecord,
  EvalCase,
  EvalManifest,
  EvalRunArtifact,
} from './types.ts';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? fallback) : fallback;
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

/** 归一化中文/英文文本用于 CER 与关键词比对 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，。、！？；：,.!?;:"'“”‘’《》【】()（）\-—~～…]/gu, '');
}

/**
 * 中文数字字形 → 阿拉伯数字。只用于「连续数字串」比对，不解析十/百/千。
 * 「两」在逐字报号里读作 2（端口、订单号），不在这里做数量词换算。
 */
const CN_DIGIT_TO_ASCII: Readonly<Record<string, string>> = {
  零: '0',
  〇: '0',
  一: '1',
  幺: '1',
  二: '2',
  两: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

function isAsciiDigitChar(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** 七七八八 / 七八七八 这种叠词不是订单号或端口，不能当成数字串。 */
function isReduplicativeIdiom(chars: readonly string[]): boolean {
  if (chars.length !== 4) return false;
  const a = chars[0];
  const b = chars[1];
  const c = chars[2];
  const d = chars[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
  if (a === b && c === d && a !== c) return true;
  if (a === c && b === d && a !== b) return true;
  return false;
}

function touchesLatinLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z]/u.test(ch);
}

/**
 * 这一段是不是「逐字报出来的数字串」。
 * 三个及以上数字字形算数；两个只有在已经混了阿拉伯数字、带零/幺，或贴着拉丁字母时才算。
 * 这样「三五成群」「七八」不会被改掉。
 */
function runIsDigitString(
  chars: readonly string[],
  cnCount: number,
  prev: string | undefined,
  next: string | undefined,
): boolean {
  if (cnCount === 0 || chars.length < 2) return false;
  if (isReduplicativeIdiom(chars)) return false;
  if (chars.length >= 3) return true;
  for (const ch of chars) {
    if (ch === '零' || ch === '〇' || ch === '幺' || isAsciiDigitChar(ch)) return true;
  }
  return touchesLatinLetter(prev) || touchesLatinLetter(next);
}

/**
 * 把连续数字串里的 `零〇一幺二两三四五六七八九` 转成 `0123456789`。
 *
 * 单独的「一 / 两 / 三」仍是普通词（一下、两个、三月），原样保留。
 * 用来把「读音对、只是没做 ITN」和「真听错字」分开。
 */
export function normalizeDigitsForMatch(text: string): string {
  const chars = [...text];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === undefined) break;
    if (CN_DIGIT_TO_ASCII[ch] === undefined && !isAsciiDigitChar(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i;
    let cnCount = 0;
    while (j < chars.length) {
      const cur = chars[j];
      if (cur === undefined) break;
      if (CN_DIGIT_TO_ASCII[cur] !== undefined) {
        cnCount += 1;
        j += 1;
        continue;
      }
      if (isAsciiDigitChar(cur)) {
        j += 1;
        continue;
      }
      break;
    }
    const run = chars.slice(i, j);
    const asDigitString = runIsDigitString(run, cnCount, chars[i - 1], chars[j]);
    for (const cur of run) {
      out += asDigitString ? (CN_DIGIT_TO_ASCII[cur] ?? cur) : cur;
    }
    i = j;
  }
  return out;
}

function foldForTermMatch(text: string, foldDigits: boolean): string {
  const norm = normalizeText(text);
  return foldDigits ? normalizeDigitsForMatch(norm) : norm;
}

function matchExpectedTerms(
  asrJoined: string,
  terms: readonly string[],
  foldDigits: boolean,
): { readonly hits: number; readonly missing: readonly string[] } {
  const hay = foldForTermMatch(asrJoined, foldDigits);
  const missing = terms.filter((term) => {
    const needle = foldForTermMatch(term, foldDigits);
    return needle !== '' && !hay.includes(needle);
  });
  return { hits: terms.length - missing.length, missing };
}

/** 标准 Levenshtein 编辑距离，用来算 ASR 字错误率（CER） */
export function editDistance(a: string, b: string): number {
  const sa = [...a];
  const sb = [...b];
  const m = sa.length;
  const n = sb.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n] ?? 0;
}

export function computeCer(refText: string, hypText: string): number {
  const ref = normalizeText(refText);
  const hyp = normalizeText(hypText);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return Number((editDistance(ref, hyp) / [...ref].length).toFixed(4));
}

/** 检查 ASR 转写里是否出现明显非中文/非预期的外语幻觉（如德语/俄语/日文假名或幽灵 Thank you） */
export function hasForeignHallucination(asrText: string, refText: string): boolean {
  const ref = refText.toLowerCase();
  const hyp = asrText.trim();
  if (hyp === '') return false;
  // 日文假名 / 西里尔字母 / 德语变音符等在纯中文参考句里绝不该出现
  if (/[\u3040-\u30ff\u0400-\u04ffäöüßÄÖÜ]/u.test(hyp)) return true;
  // 幽灵英文词（参考文本不含英文时）
  if (!/[a-z]/i.test(ref) && /\b(thank|okay|yeah|these|die|oh)\b/i.test(hyp)) return true;
  return false;
}

export interface CaseScore {
  readonly caseId: string;
  readonly sessionId: string;
  readonly suite: EvalCase['suite'];
  readonly group: EvalCase['group'];
  readonly refText: string;
  readonly asrTexts: readonly string[];
  readonly asrJoined: string;
  readonly turnsCount: number;
  readonly interruptedTurns: number;
  readonly fgSaid: string;
  readonly fgPaths: readonly string[];
  readonly fgDelegates: readonly string[];
  readonly dshCallCount: number;
  readonly dshReceivedNotes: readonly string[];
  readonly dshReceivedQueries: readonly string[];
  readonly bgReports: readonly {
    readonly kind: string;
    readonly result?: string;
    readonly verbatim?: boolean;
    readonly speech: string;
    readonly transcript?: string;
  }[];
  readonly announceEvents: readonly { readonly source?: string; readonly verbatim?: boolean }[];
  readonly judgeWaitsMs: readonly number[];
  readonly delegated: boolean;
  readonly dualAnswerConflict: boolean;
  readonly cer: number;
  readonly expectedTermHits: number;
  /** 同一批专名在 `normalizeDigitsForMatch` 之后的命中数（数字未 ITN 不再算漏） */
  readonly itnTermHits: number;
  readonly expectedTermTotal: number;
  readonly missingTerms: readonly string[];
  readonly foreignHallucination: boolean;
  readonly memoryOrFactPass: boolean | null;
  readonly dshContextPass: boolean | null;
  readonly verbatimPass: boolean | null;
  readonly eotPass: boolean | null;
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

export interface LatencyBand extends Sample {
  readonly min: number | null;
}

export interface EvalSummaryReport {
  readonly version: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly hourCst: number;
  readonly pipeline: 'live' | 'cascade';
  readonly backend: 'stub' | 'real-dsh';
  readonly totalCases: number;
  readonly s1Routing: {
    readonly chitchatTotal: number;
    readonly chitchatFalseDelegate: number;
    readonly actionTotal: number;
    readonly actionDelegated: number;
    readonly actionDualAnswerConflict: number;
    readonly realtimeTotal: number;
    readonly realtimeDelegated: number;
    readonly trapTotal: number;
    readonly trapClean: number;
    readonly precision: number | null;
    readonly recall: number | null;
    readonly f1: number | null;
  };
  readonly s2Asr: {
    readonly total: number;
    readonly meanCer: number;
    readonly termHits: number;
    readonly termTotal: number;
    readonly termHitRate: number;
    /** 忽略中文数字未 ITN 之后的专名命中（分母仍是 `termTotal`） */
    readonly itnTermHits: number;
    readonly itnTermHitRate: number;
    readonly foreignHallucinations: number;
  };
  readonly s3ContextMemory: {
    readonly memoryStaticPassed: number;
    readonly memoryStaticTotal: number;
    readonly crossLaneContextPassed: number;
    readonly crossLaneContextTotal: number;
    readonly reportFollowupPassed: number;
    readonly reportFollowupTotal: number;
    readonly verbatimPassed: number;
    readonly verbatimTotal: number;
  };
  readonly s4Eot: {
    readonly pauseMerged: number;
    readonly pauseTotal: number;
    readonly completeNoOverExtend: number;
    readonly completeTotal: number;
  };
  readonly s5Latency: {
    readonly firstWord: LatencyBand;
    readonly silenceToAsr: LatencyBand;
    readonly asrToTurn: LatencyBand;
    readonly turnToAudio: LatencyBand;
    readonly omniAudioMs: LatencyBand;
    readonly bgReportCount: number;
  };
  readonly cases: readonly CaseScore[];
}

type RawArchiveEvent = ArchiveEvent & Record<string, unknown>;

interface IndexedEvent {
  readonly epochMs: number;
  readonly raw: RawArchiveEvent;
}

function loadSessionEvents(archiveDir: string | null): {
  readonly rawEvents: RawArchiveEvent[];
  readonly indexed: IndexedEvent[];
} {
  if (archiveDir === null || !existsSync(archiveDir)) {
    return { rawEvents: [], indexed: [] };
  }
  const metaPath = join(archiveDir, 'meta.json');
  const eventsPath = join(archiveDir, 'events.jsonl');
  if (!existsSync(metaPath) || !existsSync(eventsPath)) {
    return { rawEvents: [], indexed: [] };
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { startedAt?: string };
  const baseEpoch = meta.startedAt ? Date.parse(meta.startedAt) : 0;
  const rawEvents = readJsonl<RawArchiveEvent>(eventsPath);
  const indexed = rawEvents.map((ev) => ({
    epochMs: baseEpoch + (typeof ev.t === 'number' ? ev.t : 0),
    raw: ev,
  }));
  return { rawEvents, indexed };
}

function toBand(values: readonly (number | null)[]): LatencyBand {
  return {
    ...summarize(values),
    min: percentile(values, 0),
  };
}

function checkMustIncludeAny(haystack: string, groups: readonly (readonly string[])[]): {
  ok: boolean;
  missing: string[];
} {
  const norm = normalizeText(haystack);
  const missing: string[] = [];
  for (const alts of groups) {
    const hit = alts.some((candidate) => norm.includes(normalizeText(candidate)));
    if (!hit) missing.push(alts.join('/'));
  }
  return { ok: missing.length === 0, missing };
}

interface PreparedCase {
  readonly spec: EvalCase;
  readonly winStart: number;
  readonly winEnd: number;
  readonly evs: readonly RawArchiveEvent[];
  readonly asrTexts: readonly string[];
  readonly asrJoined: string;
}

/** query 与某条用例原话的相似度：互相包含取短/长，否则用候选句的 bigram 召回。 */
function utteranceMatchScore(queryNorm: string, candidateNorm: string): number {
  if (queryNorm.length === 0 || candidateNorm.length === 0) return 0;
  if (queryNorm.includes(candidateNorm) || candidateNorm.includes(queryNorm)) {
    const shorter = Math.min(queryNorm.length, candidateNorm.length);
    const longer = Math.max(queryNorm.length, candidateNorm.length);
    return longer === 0 ? 0 : shorter / longer;
  }
  if (candidateNorm.length < 2) return 0;
  let hits = 0;
  const total = candidateNorm.length - 1;
  for (let i = 0; i + 1 < candidateNorm.length; i += 1) {
    if (queryNorm.includes(candidateNorm.slice(i, i + 2))) hits += 1;
  }
  return hits / total;
}

function caseQueryScore(queryNorm: string, item: PreparedCase): number {
  const asr = normalizeDigitsForMatch(normalizeText(item.asrJoined));
  const spec = normalizeDigitsForMatch(normalizeText(item.spec.text));
  return Math.max(utteranceMatchScore(queryNorm, asr), utteranceMatchScore(queryNorm, spec));
}

/** 覆盖度够高、且明显高于次优，才算「明确匹配」到这一条。 */
const QUERY_MATCH_MIN = 0.6;
const QUERY_MATCH_MARGIN = 0.15;

function clearQueryOwner(query: string, cases: readonly PreparedCase[]): string | null {
  const q = normalizeDigitsForMatch(normalizeText(query));
  if (q.length < 4) return null;
  let bestId: string | null = null;
  let best = 0;
  let second = 0;
  for (const item of cases) {
    const score = caseQueryScore(q, item);
    if (score > best) {
      second = best;
      best = score;
      bestId = item.spec.id;
    } else if (score > second) {
      second = score;
    }
  }
  if (bestId === null || best < QUERY_MATCH_MIN) return null;
  if (second >= QUERY_MATCH_MIN && best - second < QUERY_MATCH_MARGIN) return null;
  return bestId;
}

/**
 * 后台汇报归属。
 *
 * 有 `query` 时只按它和本会话用例的 `asrJoined` / 清单原文匹配：
 * 明确落到另一条上的，不能因为 TTS 结束得晚就算进当前时间窗。
 * 没有 `query` 才退回时间窗。带了 query 但本场对不上任何一条的，宁可丢掉，
 * 也不要按时间戳塞给正在播的下一条。
 */
function assignBgReports(
  cases: readonly PreparedCase[],
  reports: readonly BgReportRecord[],
): Map<string, BgReportRecord[]> {
  const buckets = new Map<string, BgReportRecord[]>();
  for (const item of cases) buckets.set(item.spec.id, []);
  const first = cases[0];
  if (first === undefined) return buckets;

  let spanLo = first.winStart;
  let spanHi = first.winEnd;
  for (const item of cases) {
    if (item.winStart < spanLo) spanLo = item.winStart;
    if (item.winEnd > spanHi) spanHi = item.winEnd;
  }
  // 逐字 TTS 可能在最后一条的时间窗之后才落盘，但不应跨到另一场会话。
  spanHi += 120_000;

  for (const report of reports) {
    const query = typeof report.query === 'string' ? report.query.trim() : '';
    if (query !== '') {
      if (report.ts < spanLo || report.ts > spanHi) continue;
      const owner = clearQueryOwner(query, cases);
      if (owner === null) continue;
      buckets.get(owner)?.push(report);
      continue;
    }
    for (const item of cases) {
      if (report.ts >= item.winStart && report.ts <= item.winEnd) {
        buckets.get(item.spec.id)?.push(report);
      }
    }
  }
  return buckets;
}

export function scoreArtifact(
  manifest: EvalManifest,
  artifact: EvalRunArtifact,
  dshCalls: readonly DshCallRecord[],
  bgReports: readonly BgReportRecord[],
): EvalSummaryReport {
  const caseById = new Map<string, EvalCase>();
  for (const s of manifest.sessions) {
    for (const c of s.cases) caseById.set(c.id, c);
  }

  const allTurnLatencies: TurnLatency[] = [];
  const omniAudioValues: number[] = [];
  const scoredCases: CaseScore[] = [];

  for (const session of artifact.sessions) {
    const { rawEvents, indexed } = loadSessionEvents(session.archiveDir);
    if (rawEvents.length > 0) {
      allTurnLatencies.push(...computeTurns(rawEvents));
      for (const ev of rawEvents) {
        if (ev.ev === 'omni.shadow' && typeof ev['audio_ms'] === 'number') {
          omniAudioValues.push(ev['audio_ms']);
        }
      }
    }

    const prepared: PreparedCase[] = [];
    for (let idx = 0; idx < session.cases.length; idx += 1) {
      const trace: CaseRunTrace | undefined = session.cases[idx];
      if (trace === undefined) continue;
      const spec = caseById.get(trace.caseId);
      if (spec === undefined) continue;

      const winStart = trace.startedAtMs - 150;
      const nextTrace = session.cases[idx + 1];
      const winEnd = nextTrace !== undefined
        ? Math.min(trace.finishedAtMs + 150, nextTrace.startedAtMs - 150)
        : trace.finishedAtMs + 500;

      const evs = indexed
        .filter((e) => e.epochMs >= winStart && e.epochMs <= winEnd)
        .map((e) => e.raw);

      const asrTexts = evs
        .filter((e) => e.ev === 'asr.sentence' && e['dropped'] === undefined && typeof e['text'] === 'string')
        .map((e) => String(e['text']));
      const asrJoined = asrTexts.join('');
      prepared.push({ spec, winStart, winEnd, evs, asrTexts, asrJoined });
    }

    const bgByCase = assignBgReports(prepared, bgReports);

    for (const item of prepared) {
      const { spec, winStart, winEnd, evs, asrTexts, asrJoined } = item;

      const turnEnds = evs.filter((e) => e.ev === 'turn.end');
      const turnsCount = turnEnds.length;
      const interruptedTurns = turnEnds.filter((e) => e['interrupted'] === true).length;
      const fgSaid = turnEnds.map((e) => String(e['said'] ?? '')).filter(Boolean).join(' ');
      const fgPaths = turnEnds.map((e) => String(e['path'] ?? '')).filter(Boolean);
      const fgDelegates = turnEnds
        .map((e) => (typeof e['delegate'] === 'string' ? e['delegate'] : ''))
        .filter(Boolean);

      const judgeWaitsMs = evs
        .filter((e) => e.ev === 'judge.decide' && typeof e['waitedMs'] === 'number')
        .map((e) => Number(e['waitedMs']));

      const announceEvents = evs
        .filter((e) => e.ev === 'announce')
        .map((e) => ({
          source: typeof e['source'] === 'string' ? e['source'] : undefined,
          verbatim: typeof e['verbatim'] === 'boolean' ? e['verbatim'] : undefined,
        }));

      const callsInWin = dshCalls.filter((c) => c.ts >= winStart && c.ts <= winEnd);
      const bgInWin = bgByCase.get(spec.id) ?? [];

      const delegated = callsInWin.length > 0 || fgDelegates.length > 0 || fgPaths.includes('dsh');

      // 双答冲突：动作轮触发了后台 dsh（通常是 early_rule），但 Omni 前台既没有发 tool_call，
      // 又自顾自讲了 >12 字正文（用户先听一遍 Omni 编的，几秒后又听一遍 dsh 结论）
      const omniSelfDelegated = fgDelegates.includes('delegate') || fgDelegates.includes('task');
      const fgSaidChars = [...normalizeText(fgSaid)].length;
      const dualAnswerConflict = Boolean(
        spec.checkDualAnswerConflict
        && callsInWin.length > 0
        && !omniSelfDelegated
        && fgSaidChars > 12,
      );

      const cer = computeCer(spec.text, asrJoined);
      const expectedTerms = spec.expectedTerms ?? [];
      const strictTerms = matchExpectedTerms(asrJoined, expectedTerms, false);
      const itnTerms = matchExpectedTerms(asrJoined, expectedTerms, true);
      const missingTerms = strictTerms.missing;
      const expectedTermHits = strictTerms.hits;
      const foreignHallucination = hasForeignHallucination(asrJoined, spec.text);

      // 合并本轮前台 + 后台实际念出的文本用于 S3 事实/记忆/逐字校验
      const spokenBgTexts = bgInWin
        .filter((r) => r.kind === 'fallback_spoken' || r.result === 'spoken')
        .map((r) => (r.transcript && r.transcript.trim() !== '' ? r.transcript : r.speech));
      const allSpoken = [fgSaid, ...spokenBgTexts].filter(Boolean).join(' ');

      const reasons: string[] = [];
      let pass = true;

      // S1 路由判定
      if (spec.expectDelegate === 'no' && delegated) {
        pass = false;
        reasons.push(`误委派(dsh=${callsInWin.length}, delegates=${fgDelegates.join(',') || 'none'})`);
      } else if (spec.expectDelegate === 'yes' && !delegated) {
        pass = false;
        reasons.push('漏委派(未触发 dsh)');
      }
      if (dualAnswerConflict) {
        pass = false;
        reasons.push(`双答冲突(early_rule 派了 dsh 但 Omni 未调工具且前台说了 ${fgSaidChars} 字)`);
      }
      if (spec.forbidCancel && fgSaid.includes('好，不查了')) {
        pass = false;
        reasons.push('误触发取消');
      }
      if (spec.forbidSilentMemory && callsInWin.length > 0) {
        pass = false;
        reasons.push('问句误触发静默记忆写 dsh');
      }

      // S2 ASR 判定
      if (expectedTerms.length > 0 && missingTerms.length > 0) {
        pass = false;
        reasons.push(`ASR 漏词: ${missingTerms.join(', ')}`);
      }
      if (foreignHallucination) {
        pass = false;
        reasons.push(`ASR 外语幻觉: ${JSON.stringify(asrJoined)}`);
      }

      // S3 事实 / 记忆 / 追问判定
      let memoryOrFactPass: boolean | null = null;
      if (spec.mustIncludeAny !== undefined && spec.mustIncludeAny.length > 0) {
        const res = checkMustIncludeAny(allSpoken, spec.mustIncludeAny);
        memoryOrFactPass = res.ok;
        if (!res.ok) {
          pass = false;
          reasons.push(`未命中关键事实: ${res.missing.join(', ')}（实际说出: ${JSON.stringify(allSpoken.slice(0, 60))}）`);
        }
      }
      if (spec.mustNotInclude !== undefined) {
        const normAll = normalizeText(allSpoken);
        const hitForbidden = spec.mustNotInclude.filter((w) => normAll.includes(normalizeText(w)));
        if (hitForbidden.length > 0) {
          memoryOrFactPass = false;
          pass = false;
          reasons.push(`命中禁用词: ${hitForbidden.join(', ')}`);
        }
      }

      // S3-M2 跨轨上下文判定（dsh 实际收到的 query + note）
      let dshContextPass: boolean | null = null;
      if (spec.expectDshContextTerms !== undefined && spec.expectDshContextTerms.length > 0) {
        const dshInput = callsInWin.map((c) => `${c.userText}\n${c.note}`).join('\n');
        const normIn = normalizeText(dshInput);
        const missingCtx = spec.expectDshContextTerms.filter((t) => !normIn.includes(normalizeText(t)));
        dshContextPass = callsInWin.length > 0 && missingCtx.length === 0;
        if (!dshContextPass) {
          pass = false;
          reasons.push(
            callsInWin.length === 0
              ? 'dsh 未被调用，无跨轨上下文'
              : `dsh 上下文缺前文指代: ${missingCtx.join(', ')}`,
          );
        }
      }

      // S3-M4 逐字保真判定
      let verbatimPass: boolean | null = null;
      if (spec.expectVerbatim === true) {
        const gotVerbatim = announceEvents.some((e) => e.verbatim === true)
          || bgInWin.some((r) => r.verbatim === true);
        const contentOk = memoryOrFactPass !== false;
        verbatimPass = gotVerbatim && contentOk;
        if (!gotVerbatim) {
          pass = false;
          reasons.push('未触发 verbatim 逐字朗读（被交给 Omni 口语改写）');
        }
      }

      // S4 EOT 判定
      let eotPass: boolean | null = null;
      if (spec.expectTurns !== undefined) {
        const turnsOk = turnsCount === spec.expectTurns && interruptedTurns === 0;
        const maxWait = judgeWaitsMs.length === 0 ? 0 : Math.max(...judgeWaitsMs);
        const waitOk = spec.maxExpectedWaitMs === undefined || maxWait <= spec.maxExpectedWaitMs;
        eotPass = turnsOk && waitOk;
        if (!turnsOk) {
          pass = false;
          reasons.push(`EOT 切分异常: turns=${turnsCount}(期望 ${spec.expectTurns}), interrupted=${interruptedTurns}`);
        }
        if (!waitOk) {
          pass = false;
          reasons.push(`完整句误延: judge.waitedMs=${maxWait} > ${spec.maxExpectedWaitMs}`);
        }
      }

      scoredCases.push({
        caseId: spec.id,
        sessionId: session.sessionId,
        suite: spec.suite,
        group: spec.group,
        refText: spec.text,
        asrTexts,
        asrJoined,
        turnsCount,
        interruptedTurns,
        fgSaid,
        fgPaths,
        fgDelegates,
        dshCallCount: callsInWin.length,
        dshReceivedNotes: callsInWin.map((c) => c.note),
        dshReceivedQueries: callsInWin.map((c) => c.userText),
        bgReports: bgInWin.map((r) => ({
          kind: r.kind,
          result: r.result,
          verbatim: r.verbatim,
          speech: r.speech,
          transcript: r.transcript,
        })),
        announceEvents,
        judgeWaitsMs,
        delegated,
        dualAnswerConflict,
        cer,
        expectedTermHits,
        itnTermHits: itnTerms.hits,
        expectedTermTotal: expectedTerms.length,
        missingTerms,
        foreignHallucination,
        memoryOrFactPass,
        dshContextPass,
        verbatimPass,
        eotPass,
        pass,
        reasons,
      });
    }
  }

  // 汇总统计
  const byGroup = (g: EvalCase['group']): CaseScore[] => scoredCases.filter((c) => c.group === g);
  const chitchat = byGroup('chitchat');
  const action = byGroup('action_tool');
  const realtime = byGroup('realtime_fact');
  const trap = byGroup('negative_trap');
  const asr = byGroup('asr_noun');
  const memStatic = byGroup('memory_static');
  const crossLane = byGroup('cross_lane').filter((c) => c.dshContextPass !== null);
  const followup = byGroup('report_followup').filter((c) => c.memoryOrFactPass !== null);
  const verbatim = byGroup('verbatim');
  const eotPause = byGroup('eot_pause');
  const eotComplete = byGroup('eot_complete');

  const tp = [...action, ...realtime].filter((c) => c.delegated).length;
  const fn = [...action, ...realtime].filter((c) => !c.delegated).length;
  const fp = [...chitchat, ...trap].filter((c) => c.delegated).length;
  const precision = tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(4));
  const recall = tp + fn === 0 ? null : Number((tp / (tp + fn)).toFixed(4));
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
    : null;

  const termHits = asr.reduce((n, c) => n + c.expectedTermHits, 0);
  const termTotal = asr.reduce((n, c) => n + c.expectedTermTotal, 0);
  const itnTermHits = asr.reduce((n, c) => n + c.itnTermHits, 0);
  const meanCer = asr.length === 0
    ? 0
    : Number((asr.reduce((n, c) => n + c.cer, 0) / asr.length).toFixed(4));

  return {
    version: artifact.version,
    runId: artifact.runId,
    startedAt: artifact.startedAt,
    hourCst: artifact.hourCst,
    pipeline: artifact.pipeline,
    backend: artifact.backend,
    totalCases: scoredCases.length,
    s1Routing: {
      chitchatTotal: chitchat.length,
      chitchatFalseDelegate: chitchat.filter((c) => c.delegated).length,
      actionTotal: action.length,
      actionDelegated: action.filter((c) => c.delegated).length,
      actionDualAnswerConflict: action.filter((c) => c.dualAnswerConflict).length,
      realtimeTotal: realtime.length,
      realtimeDelegated: realtime.filter((c) => c.delegated).length,
      trapTotal: trap.length,
      trapClean: trap.filter((c) => c.pass).length,
      precision,
      recall,
      f1,
    },
    s2Asr: {
      total: asr.length,
      meanCer,
      termHits,
      termTotal,
      termHitRate: termTotal === 0 ? 1 : Number((termHits / termTotal).toFixed(4)),
      itnTermHits,
      itnTermHitRate: termTotal === 0 ? 1 : Number((itnTermHits / termTotal).toFixed(4)),
      foreignHallucinations: scoredCases.filter((c) => c.foreignHallucination).length,
    },
    s3ContextMemory: {
      memoryStaticPassed: memStatic.filter((c) => c.memoryOrFactPass === true).length,
      memoryStaticTotal: memStatic.length,
      crossLaneContextPassed: crossLane.filter((c) => c.dshContextPass === true).length,
      crossLaneContextTotal: crossLane.length,
      reportFollowupPassed: followup.filter((c) => c.memoryOrFactPass === true).length,
      reportFollowupTotal: followup.length,
      verbatimPassed: verbatim.filter((c) => c.verbatimPass === true).length,
      verbatimTotal: verbatim.length,
    },
    s4Eot: {
      pauseMerged: eotPause.filter((c) => c.eotPass === true).length,
      pauseTotal: eotPause.length,
      completeNoOverExtend: eotComplete.filter((c) => c.eotPass === true).length,
      completeTotal: eotComplete.length,
    },
    s5Latency: {
      firstWord: toBand(allTurnLatencies.map((t) => t.firstWordMs)),
      silenceToAsr: toBand(allTurnLatencies.map((t) => t.silenceToAsr)),
      asrToTurn: toBand(allTurnLatencies.map((t) => t.asrToTurn)),
      turnToAudio: toBand(allTurnLatencies.map((t) => t.turnToAudio)),
      omniAudioMs: toBand(omniAudioValues),
      bgReportCount: bgReports.length,
    },
    cases: scoredCases,
  };
}

function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
}

function fmtMs(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)} ms`;
}

export function renderMarkdown(r: EvalSummaryReport): string {
  const lines: string[] = [];
  lines.push(`# 离线评测报告：${r.runId}`);
  lines.push(`> 管道：\`${r.pipeline}\` | 后台：\`${r.backend}\` | 时刻：${r.startedAt}（CST ${r.hourCst} 时） | 用例：${r.totalCases} 轮`);
  lines.push('');
  lines.push('## 一、准确率汇总');
  lines.push('| 套件 | 指标 | 当前基线 |');
  lines.push('|:---|:---|:---|');
  lines.push(
    `| **S1 路由与委派** | Precision / Recall / F1 | **${pct(r.s1Routing.precision)}** / **${pct(r.s1Routing.recall)}** / **${pct(r.s1Routing.f1)}** |`,
  );
  lines.push(
    `| S1 · 纯闲聊误委派 | FP | ${r.s1Routing.chitchatFalseDelegate} / ${r.s1Routing.chitchatTotal} |`,
  );
  lines.push(
    `| S1 · 动作/设备委派 | 命中（含双答冲突） | ${r.s1Routing.actionDelegated} / ${r.s1Routing.actionTotal}（双答冲突 **${r.s1Routing.actionDualAnswerConflict}**） |`,
  );
  lines.push(
    `| S1 · 无动词实时事实 | 命中 | **${r.s1Routing.realtimeDelegated} / ${r.s1Routing.realtimeTotal}** |`,
  );
  lines.push(
    `| S1 · 边界陷阱 | 干净通过 | ${r.s1Routing.trapClean} / ${r.s1Routing.trapTotal} |`,
  );
  lines.push(
    `| **S2 ASR 听准** | 专名精确命中 / 忽略数字ITN命中 / 平均 CER / 外语幻觉 | **${r.s2Asr.termHits}/${r.s2Asr.termTotal} (${pct(r.s2Asr.termHitRate)})** / **${r.s2Asr.itnTermHits}/${r.s2Asr.termTotal} (${pct(r.s2Asr.itnTermHitRate)})** / ${(r.s2Asr.meanCer * 100).toFixed(1)}% / ${r.s2Asr.foreignHallucinations} |`,
  );
  lines.push(
    `| **S3-M1 静态记忆** | Omni 直接命中 MEMORY.md | **${r.s3ContextMemory.memoryStaticPassed} / ${r.s3ContextMemory.memoryStaticTotal}** |`,
  );
  lines.push(
    `| **S3-M2 跨轨指代** | dsh 收到前文 Omni 账本 | **${r.s3ContextMemory.crossLaneContextPassed} / ${r.s3ContextMemory.crossLaneContextTotal}** |`,
  );
  lines.push(
    `| **S3-M3 汇报闭环** | 追问命中（含未播回注） | **${r.s3ContextMemory.reportFollowupPassed} / ${r.s3ContextMemory.reportFollowupTotal}** |`,
  );
  lines.push(
    `| **S3-M4 逐字保真** | verbatim 路由与关键串命中 | **${r.s3ContextMemory.verbatimPassed} / ${r.s3ContextMemory.verbatimTotal}** |`,
  );
  lines.push(
    `| **S4 EOT 停顿合并** | 300/500/700/900 ms 合并 | **${r.s4Eot.pauseMerged} / ${r.s4Eot.pauseTotal}** |`,
  );
  lines.push(
    `| **S4 EOT 完整短句** | 无误切且不误延拍 | **${r.s4Eot.completeNoOverExtend} / ${r.s4Eot.completeTotal}** |`,
  );
  lines.push('');

  const l = r.s5Latency;
  lines.push('## 二、性能不劣化护栏（合成语料口径，与真机分表）');
  lines.push('| 指标 | n | min | p50 | p90 |');
  lines.push('|:---|---:|---:|---:|---:|');
  lines.push(`| 首声延迟（停嘴→首块） | ${l.firstWord.count} | ${fmtMs(l.firstWord.min)} | ${fmtMs(l.firstWord.median)} | ${fmtMs(l.firstWord.p90)} |`);
  lines.push(`| ① 停嘴→定稿 | ${l.silenceToAsr.count} | ${fmtMs(l.silenceToAsr.min)} | ${fmtMs(l.silenceToAsr.median)} | ${fmtMs(l.silenceToAsr.p90)} |`);
  lines.push(`| ② 定稿→开轮 | ${l.asrToTurn.count} | ${fmtMs(l.asrToTurn.min)} | ${fmtMs(l.asrToTurn.median)} | ${fmtMs(l.asrToTurn.p90)} |`);
  lines.push(`| ③ 开轮→首块 | ${l.turnToAudio.count} | ${fmtMs(l.turnToAudio.min)} | ${fmtMs(l.turnToAudio.median)} | ${fmtMs(l.turnToAudio.p90)} |`);
  lines.push(`| Omni \`audio_ms\`（封段→首块） | ${l.omniAudioMs.count} | ${fmtMs(l.omniAudioMs.min)} | ${fmtMs(l.omniAudioMs.median)} | ${fmtMs(l.omniAudioMs.p90)} |`);
  lines.push('');

  const failed = r.cases.filter((c) => !c.pass);
  lines.push(`## 三、未通过明细（${failed.length} / ${r.totalCases}）`);
  if (failed.length === 0) {
    lines.push('全部通过。');
  } else {
    lines.push('| 用例 | 分组 | ASR 识别 | 原因 |');
    lines.push('|:---|:---|:---|:---|');
    for (const c of failed) {
      lines.push(`| \`${c.caseId}\` | ${c.group} | ${c.asrJoined || '（空）'} | ${c.reasons.join('；')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderCompare(base: EvalSummaryReport, cand: EvalSummaryReport): string {
  const delta = (a: number | null | undefined, b: number | null | undefined, unit = ''): string => {
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return '—';
    const d = b - a;
    const sign = d > 0 ? '+' : '';
    return `${sign}${unit === '%' ? `${(d * 100).toFixed(1)}%` : `${Math.round(d)}${unit}`}`;
  };
  return [
    `# A/B 对比：${base.runId} → ${cand.runId}`,
    `> 时段：CST ${base.hourCst} 时 vs CST ${cand.hourCst} 时`,
    '',
    '| 指标 | Baseline | Candidate | Δ |',
    '|:---|---:|---:|---:|',
    `| S1 委派 F1 | ${pct(base.s1Routing.f1)} | ${pct(cand.s1Routing.f1)} | ${delta(base.s1Routing.f1, cand.s1Routing.f1, '%')} |`,
    `| S1 双答冲突 | ${base.s1Routing.actionDualAnswerConflict} | ${cand.s1Routing.actionDualAnswerConflict} | ${delta(base.s1Routing.actionDualAnswerConflict, cand.s1Routing.actionDualAnswerConflict)} |`,
    `| S1 实时事实命中 | ${base.s1Routing.realtimeDelegated}/${base.s1Routing.realtimeTotal} | ${cand.s1Routing.realtimeDelegated}/${cand.s1Routing.realtimeTotal} | ${delta(base.s1Routing.realtimeDelegated, cand.s1Routing.realtimeDelegated)} |`,
    `| S2 ASR 专名精确命中 | ${pct(base.s2Asr.termHitRate)} | ${pct(cand.s2Asr.termHitRate)} | ${delta(base.s2Asr.termHitRate, cand.s2Asr.termHitRate, '%')} |`,
    `| S2 忽略数字ITN命中 | ${pct(base.s2Asr.itnTermHitRate)} | ${pct(cand.s2Asr.itnTermHitRate)} | ${delta(base.s2Asr.itnTermHitRate, cand.s2Asr.itnTermHitRate, '%')} |`,
    `| S3-M1 静态记忆 | ${base.s3ContextMemory.memoryStaticPassed}/${base.s3ContextMemory.memoryStaticTotal} | ${cand.s3ContextMemory.memoryStaticPassed}/${cand.s3ContextMemory.memoryStaticTotal} | ${delta(base.s3ContextMemory.memoryStaticPassed, cand.s3ContextMemory.memoryStaticPassed)} |`,
    `| S3-M2 跨轨指代 | ${base.s3ContextMemory.crossLaneContextPassed}/${base.s3ContextMemory.crossLaneContextTotal} | ${cand.s3ContextMemory.crossLaneContextPassed}/${cand.s3ContextMemory.crossLaneContextTotal} | ${delta(base.s3ContextMemory.crossLaneContextPassed, cand.s3ContextMemory.crossLaneContextPassed)} |`,
    `| S3-M4 逐字保真 | ${base.s3ContextMemory.verbatimPassed}/${base.s3ContextMemory.verbatimTotal} | ${cand.s3ContextMemory.verbatimPassed}/${cand.s3ContextMemory.verbatimTotal} | ${delta(base.s3ContextMemory.verbatimPassed, cand.s3ContextMemory.verbatimPassed)} |`,
    `| S4 停顿合并 | ${base.s4Eot.pauseMerged}/${base.s4Eot.pauseTotal} | ${cand.s4Eot.pauseMerged}/${cand.s4Eot.pauseTotal} | ${delta(base.s4Eot.pauseMerged, cand.s4Eot.pauseMerged)} |`,
    `| 首声延迟 p50 | ${fmtMs(base.s5Latency.firstWord.median)} | ${fmtMs(cand.s5Latency.firstWord.median)} | ${delta(base.s5Latency.firstWord.median, cand.s5Latency.firstWord.median, ' ms')} |`,
    `| Omni \`audio_ms\` p50 | ${fmtMs(base.s5Latency.omniAudioMs.median)} | ${fmtMs(cand.s5Latency.omniAudioMs.median)} | ${delta(base.s5Latency.omniAudioMs.median, cand.s5Latency.omniAudioMs.median, ' ms')} |`,
  ].join('\n');
}

function main(): void {
  const compareIdx = process.argv.indexOf('--compare');
  if (compareIdx >= 0) {
    const aPath = process.argv[compareIdx + 1];
    const bPath = process.argv[compareIdx + 2];
    if (!aPath || !bPath) {
      console.error('用法: node bench/eval/score.ts --compare <base.json> <cand.json>');
      process.exit(2);
    }
    const base = JSON.parse(readFileSync(resolve(aPath), 'utf8')) as EvalSummaryReport;
    const cand = JSON.parse(readFileSync(resolve(bPath), 'utf8')) as EvalSummaryReport;
    console.log(renderCompare(base, cand));
    return;
  }

  const artifactPath = resolve(arg('artifact', 'bench/eval/out/run/run-artifact.json'));
  const manifestPath = resolve(arg('manifest', 'bench/eval/manifest.json'));
  const outPath = arg('out', '');

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as EvalRunArtifact;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvalManifest;
  const dshCalls = readJsonl<DshCallRecord>(artifact.dshCallsFile);
  const bgReports = readJsonl<BgReportRecord>(artifact.bgReportsFile);

  const report = scoreArtifact(manifest, artifact, dshCalls, bgReports);
  if (outPath) {
    writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(renderMarkdown(report));
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main();
}
