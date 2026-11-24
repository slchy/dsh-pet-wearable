/**
 * `bench/eval/score.ts` 的打分口径：
 * 中文数字未 ITN 与真听错要能分开计，后台汇报不能因为播得慢被下一窗吃掉。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  computeCer,
  hasForeignHallucination,
  normalizeDigitsForMatch,
  renderMarkdown,
  scoreArtifact,
  type EvalSummaryReport,
} from '../bench/eval/score.ts';
import type {
  BgReportRecord,
  DshCallRecord,
  EvalCase,
  EvalManifest,
  EvalRunArtifact,
} from '../bench/eval/types.ts';

const ARCHIVE_STARTED_AT = '2026-11-24T00:00:00.000Z';
const ARCHIVE_EPOCH_MS = Date.parse(ARCHIVE_STARTED_AT);

function caseSpec(
  partial: Partial<EvalCase> & Pick<EvalCase, 'id' | 'suite' | 'group' | 'text'>,
): EvalCase {
  return {
    voice: 'female',
    expectDelegate: 'any',
    ...partial,
  };
}

function manifestOf(cases: readonly EvalCase[]): EvalManifest {
  return {
    version: 'eval-v1',
    corpusName: 'unit',
    memorySeed: [],
    sessions: [{
      id: 'sess',
      suite: cases[0]?.suite ?? 'S1',
      title: 'unit',
      cases,
    }],
  };
}

function artifactOf(opts: {
  readonly archiveDir?: string | null;
  readonly cases: readonly { readonly id: string; readonly start: number; readonly end: number }[];
}): EvalRunArtifact {
  const sessionId = 'sess';
  const first = opts.cases[0];
  const last = opts.cases[opts.cases.length - 1];
  return {
    version: 'eval-v1',
    runId: 'unit',
    startedAt: ARCHIVE_STARTED_AT,
    hourCst: 8,
    pipeline: 'live',
    backend: 'stub',
    corpusDir: 'corpus',
    archiveRoot: 'archives',
    dshCallsFile: 'dsh.jsonl',
    bgReportsFile: 'bg.jsonl',
    sessions: [{
      sessionId,
      suite: 'S1',
      archiveDir: opts.archiveDir ?? null,
      startedAtMs: first?.start ?? 0,
      finishedAtMs: last?.end ?? 0,
      cases: opts.cases.map((c) => ({
        caseId: c.id,
        sessionId,
        startedAtMs: c.start,
        audioDoneAtMs: c.start,
        finishedAtMs: c.end,
        sentBytes: 0,
        downlinkBytes: 0,
        downlinkFirstAtMs: null,
        callsReceived: [],
        controlsReceived: [],
      })),
    }],
  };
}

function withArchive(
  events: readonly Record<string, unknown>[],
  fn: (archiveDir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ startedAt: ARCHIVE_STARTED_AT })}\n`);
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${events.map((ev) => JSON.stringify(ev)).join('\n')}\n`,
    );
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function byId(report: EvalSummaryReport): Map<string, EvalSummaryReport['cases'][number]> {
  return new Map(report.cases.map((c) => [c.caseId, c]));
}

test('normalizeDigitsForMatch：订单号与端口的中文读法对齐阿拉伯数字，普通词不动', () => {
  assert.equal(normalizeDigitsForMatch('w八六六五八八幺'), 'w8665881');
  assert.equal(normalizeDigitsForMatch('W8665881'), 'W8665881');
  assert.equal(
    normalizeDigitsForMatch('w八六六五八八幺').toLowerCase(),
    normalizeDigitsForMatch('W8665881').toLowerCase(),
  );
  assert.equal(normalizeDigitsForMatch('八七六六'), '8766');
  assert.equal(normalizeDigitsForMatch('八七六六'), normalizeDigitsForMatch('8766'));

  assert.equal(
    normalizeDigitsForMatch('请检查一下订单号w八六六五八八幺的进度'),
    '请检查一下订单号w8665881的进度',
  );
  assert.equal(
    normalizeDigitsForMatch('把服务端口八七六六的回滚方案记一下'),
    '把服务端口8766的回滚方案记一下',
  );
  assert.equal(normalizeDigitsForMatch('二零二四'), '2024');
  assert.equal(normalizeDigitsForMatch('端口八766'), '端口8766');

  const untouched = [
    '一下',
    '两个',
    '三月',
    '一定',
    '一起',
    '一般',
    '第一',
    '九天',
    '两次',
    '零星',
    '三五成群',
    '七七八八',
    '三三两两',
    '我一下就买了两个苹果',
  ];
  for (const word of untouched) {
    assert.equal(normalizeDigitsForMatch(word), word, word);
  }
});

test('computeCer：标点大小写不计，听错字按编辑距离', () => {
  assert.equal(computeCer('你好。', '你好'), 0);
  assert.equal(computeCer('Hello, World!', 'helloworld'), 0);
  assert.equal(computeCer('', ''), 0);
  assert.equal(computeCer('', '啊'), 1);
  assert.equal(computeCer('其主之声', '棋手之声'), 0.5);
  assert.equal(computeCer('你好世界', '你好'), 0.5);
});

test('hasForeignHallucination：假名、西里尔、德语变音和幽灵英文算幻觉，听错汉字不算', () => {
  assert.equal(hasForeignHallucination('', '你好'), false);
  assert.equal(hasForeignHallucination('   ', '你好'), false);
  assert.equal(hasForeignHallucination('棋手之声', '其主之声'), false);
  assert.equal(hasForeignHallucination('谢谢', '你好'), false);
  assert.equal(hasForeignHallucination('こんにちは', '你好'), true);
  assert.equal(hasForeignHallucination('テスト', '你好'), true);
  assert.equal(hasForeignHallucination('Спасибо', '你好'), true);
  assert.equal(hasForeignHallucination('Straße', '你好'), true);
  assert.equal(hasForeignHallucination('Thank you', '你好'), true);
  assert.equal(hasForeignHallucination('okay', '你好'), true);
  assert.equal(hasForeignHallucination('dialogue', '你好'), false);
  assert.equal(hasForeignHallucination('Thank you', 'say thank you'), false);
});

test('scoreArtifact：中文数字未 ITN 仍记精确漏词，但 itnTermHits 算命中', () => {
  const cases = [
    caseSpec({
      id: 's2_asr_04',
      suite: 'S2',
      group: 'asr_noun',
      text: '请检查一下订单号W8665881的进度。',
      expectedTerms: ['W8665881'],
    }),
    caseSpec({
      id: 's2_asr_10',
      suite: 'S2',
      group: 'asr_noun',
      text: '把服务端口8766的回滚方案记一下。',
      expectedTerms: ['8766', '回滚'],
    }),
    caseSpec({
      id: 's2_asr_01',
      suite: 'S2',
      group: 'asr_noun',
      text: '你知道波兰作家莱姆写的其主之声吗？',
      expectedTerms: ['其主之声'],
    }),
  ];
  const t = (offset: number): number => ARCHIVE_EPOCH_MS + offset;
  withArchive(
    [
      { t: 11_000, ev: 'asr.sentence', text: '请检查一下订单号w八六六五八八幺的进度。' },
      { t: 21_000, ev: 'asr.sentence', text: '把服务端口八七六六的回滚方案记一下。' },
      { t: 31_000, ev: 'asr.sentence', text: '你知道波兰作家莱姆写的棋手之声吗？' },
    ],
    (archiveDir) => {
      const report = scoreArtifact(
        manifestOf(cases),
        artifactOf({
          archiveDir,
          cases: [
            { id: 's2_asr_04', start: t(10_000), end: t(12_000) },
            { id: 's2_asr_10', start: t(20_000), end: t(22_000) },
            { id: 's2_asr_01', start: t(30_000), end: t(32_000) },
          ],
        }),
        [],
        [],
      );
      const got = byId(report);
      assert.equal(got.get('s2_asr_04')?.expectedTermHits, 0);
      assert.equal(got.get('s2_asr_04')?.itnTermHits, 1);
      assert.equal(got.get('s2_asr_04')?.pass, false);
      assert.equal(got.get('s2_asr_10')?.expectedTermHits, 1);
      assert.equal(got.get('s2_asr_10')?.itnTermHits, 2);
      assert.equal(got.get('s2_asr_01')?.expectedTermHits, 0);
      assert.equal(got.get('s2_asr_01')?.itnTermHits, 0);
      assert.deepEqual(got.get('s2_asr_01')?.missingTerms, ['其主之声']);

      assert.equal(report.s2Asr.termHits, 1);
      assert.equal(report.s2Asr.termTotal, 4);
      assert.equal(report.s2Asr.termHitRate, 0.25);
      assert.equal(report.s2Asr.itnTermHits, 3);
      assert.equal(report.s2Asr.itnTermHitRate, 0.75);

      const s2 = renderMarkdown(report).split('\n').find((line) => line.includes('S2 ASR'));
      assert.ok(s2);
      assert.match(s2, /专名精确命中 \/ 忽略数字ITN命中/);
      assert.match(s2, /\*\*1\/4 \(25\.0%\)\*\*/);
      assert.match(s2, /\*\*3\/4 \(75\.0%\)\*\*/);
    },
  );
});

test('scoreArtifact：bgReport 按 query 归属，时间窗只兜底没有 query 的记录', () => {
  const refund = '帮我查一下那笔退款订单号和回执码。';
  const port = '帮我查一下语音服务的端口号和版本号。';
  const cases = [
    caseSpec({
      id: 's3_m4_01',
      suite: 'S3',
      group: 'verbatim',
      text: refund,
      expectVerbatim: true,
      mustIncludeAny: [['W8665881'], ['904218']],
    }),
    caseSpec({
      id: 's3_m4_02',
      suite: 'S3',
      group: 'verbatim',
      text: port,
      expectVerbatim: true,
      mustIncludeAny: [['8766'], ['v2.3.1', '2.3.1']],
    }),
  ];
  const reports: BgReportRecord[] = [
    {
      ts: 9_000,
      kind: 'fallback_spoken',
      query: refund,
      speech: '退款已受理，订单号 W8665881，回执码 904218。',
      verbatim: true,
    },
    {
      ts: 2_000,
      kind: 'omni_attempt',
      query: port,
      speech: '服务跑在端口 8766，当前版本 v2.3.1。',
      verbatim: false,
      result: 'spoken',
    },
    {
      ts: 3_000,
      kind: 'fallback_spoken',
      speech: '无query的时间窗播报',
    },
    {
      ts: 2_500,
      kind: 'omni_attempt',
      query: '今天中午吃什么比较好呢',
      speech: '不该被任何一条吃掉',
      verbatim: true,
    },
  ];
  const report = scoreArtifact(
    manifestOf(cases),
    artifactOf({
      cases: [
        { id: 's3_m4_01', start: 1_000, end: 5_000 },
        { id: 's3_m4_02', start: 8_000, end: 10_000 },
      ],
    }),
    [],
    reports,
  );
  const got = byId(report);
  const first = got.get('s3_m4_01');
  const second = got.get('s3_m4_02');
  assert.ok(first);
  assert.ok(second);

  assert.deepEqual(first.bgReports.map((r) => r.speech), [
    '退款已受理，订单号 W8665881，回执码 904218。',
    '无query的时间窗播报',
  ]);
  assert.deepEqual(second.bgReports.map((r) => r.speech), [
    '服务跑在端口 8766，当前版本 v2.3.1。',
  ]);
  assert.equal(first.verbatimPass, true);
  assert.equal(first.memoryOrFactPass, true);
  assert.equal(first.pass, true);
  assert.equal(second.verbatimPass, false);
  assert.equal(second.memoryOrFactPass, true);
  assert.equal(second.pass, false);
  assert.equal(report.s3ContextMemory.verbatimPassed, 1);
  assert.equal(report.s3ContextMemory.verbatimTotal, 2);
});

test('scoreArtifact：双答冲突只在未自委派且前台说了长答案时成立', () => {
  const longSaid = '我先随便编一段完全不靠谱的长答案给你听';
  const cases = [
    caseSpec({
      id: 'conflict',
      suite: 'S1',
      group: 'action_tool',
      text: '帮我把客厅的灯关掉。',
      expectDelegate: 'yes',
      checkDualAnswerConflict: true,
    }),
    caseSpec({
      id: 'self_delegate',
      suite: 'S1',
      group: 'action_tool',
      text: '帮我把空调调到二十六度。',
      expectDelegate: 'yes',
      checkDualAnswerConflict: true,
    }),
    caseSpec({
      id: 'short_reply',
      suite: 'S1',
      group: 'action_tool',
      text: '帮我看一下门锁状态。',
      expectDelegate: 'yes',
      checkDualAnswerConflict: true,
    }),
  ];
  const t = (offset: number): number => ARCHIVE_EPOCH_MS + offset;
  const call = (seq: number, offset: number, userText: string): DshCallRecord => ({
    seq,
    ts: t(offset),
    userText,
    note: '',
    hasImage: false,
    returnedSpeech: '已处理',
    matchedCaseId: null,
  });
  withArchive(
    [
      { t: 11_000, ev: 'turn.end', said: longSaid, path: 'omni', interrupted: false },
      { t: 21_000, ev: 'turn.end', said: longSaid, path: 'omni', interrupted: false, delegate: 'delegate' },
      { t: 31_000, ev: 'turn.end', said: '好，我看看。', path: 'omni', interrupted: false },
    ],
    (archiveDir) => {
      const report = scoreArtifact(
        manifestOf(cases),
        artifactOf({
          archiveDir,
          cases: [
            { id: 'conflict', start: t(10_000), end: t(12_000) },
            { id: 'self_delegate', start: t(20_000), end: t(22_000) },
            { id: 'short_reply', start: t(30_000), end: t(32_000) },
          ],
        }),
        [
          call(1, 11_000, cases[0]?.text ?? ''),
          call(2, 21_000, cases[1]?.text ?? ''),
          call(3, 31_000, cases[2]?.text ?? ''),
        ],
        [],
      );
      const got = byId(report);
      assert.equal(got.get('conflict')?.dualAnswerConflict, true);
      assert.equal(got.get('conflict')?.pass, false);
      assert.ok(got.get('conflict')?.reasons.some((r) => r.includes('双答冲突')));
      assert.equal(got.get('self_delegate')?.dualAnswerConflict, false);
      assert.equal(got.get('self_delegate')?.pass, true);
      assert.equal(got.get('short_reply')?.dualAnswerConflict, false);
      assert.equal(got.get('short_reply')?.pass, true);
      assert.equal(report.s1Routing.actionDualAnswerConflict, 1);
      assert.equal(report.s1Routing.actionTotal, 3);
    },
  );
});
