/**
 * `BackgroundTaskBus`：同一轮只打一次 dsh、静默记忆不插队、取消后迟到的结果不播。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BackgroundTaskBus,
  clipSummary,
  needsVerbatimRead,
  parseCanonicalUserTag,
  stripVerbatimTag,
  type BackgroundTaskLifecycleEvent,
  type BackgroundTaskRunner,
} from '../src/background-task-bus.ts';
import type { AgentImage, BackgroundTaskReport } from '../src/providers.ts';

const FAILURE = '刚才那个任务没跑成，稍后可以再让我试一次。';

interface ExecCall {
  readonly taskId: string;
  readonly query: string;
  readonly image?: AgentImage;
  readonly note?: string;
  readonly silent: boolean;
  readonly utterancePcm?: Buffer;
  readonly signal: AbortSignal;
}

interface Slot {
  readonly resolve: (value: {
    text: string;
    speech?: string;
    emotion?: string;
    asyncDispatched?: boolean;
    asyncTargetId?: string;
  }) => void;
  readonly reject: (err: unknown) => void;
}

function must<T>(value: T | undefined, what: string): T {
  assert.ok(value, what);
  return value;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function holdRunner(): {
  runner: BackgroundTaskRunner;
  calls: ExecCall[];
  cancels: string[];
  pending: Slot[];
} {
  const calls: ExecCall[] = [];
  const cancels: string[] = [];
  const pending: Slot[] = [];
  const runner: BackgroundTaskRunner = {
    execute(req) {
      calls.push(req);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    cancelRunning(reason) {
      cancels.push(reason);
    },
  };
  return { runner, calls, cancels, pending };
}

test('dispatch 排队、开跑、完成，播报前剥掉情绪和排版', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  const handle = bus.dispatch({
    query: '天气怎么样',
    source: 'tool_call',
    turnNo: 1,
    note: '上一轮被打断',
    image: { mimeType: 'image/jpeg', data: 'img' },
  });

  assert.equal(handle.state(), 'queued');
  assert.equal(handle.deduplicated, false);
  assert.equal(handle.turnNo, 1);
  assert.equal(handle.source, 'tool_call');
  assert.equal(handle.silent, false);
  assert.equal(bus.activeCount(), 1);
  assert.equal(bus.hasActiveReportable(), true);

  await flush();
  assert.equal(handle.state(), 'running');
  assert.equal(bus.activeCount(), 1);
  assert.equal(held.calls.length, 1);
  const call = must(held.calls[0], 'execute');
  assert.equal(call.taskId, handle.taskId);
  assert.equal(call.query, '天气怎么样');
  assert.equal(call.note, '上一轮被打断');
  assert.equal(call.silent, false);
  assert.equal(call.signal.aborted, false);
  assert.deepEqual(call.image, { mimeType: 'image/jpeg', data: 'img' });

  must(held.pending[0], 'slot').resolve({ text: '[开心]**明天北京晴，12到22度**' });
  await flush();
  assert.equal(handle.state(), 'completed');
  assert.equal(bus.activeCount(), 0);
  assert.equal(bus.hasActiveReportable(), false);
  assert.equal(reports.length, 1);
  const report = must(reports[0], 'report');
  assert.equal(report.taskId, handle.taskId);
  assert.equal(report.source, 'tool_call');
  assert.equal(report.query, '天气怎么样');
  assert.equal(report.summary, '明天北京晴，12到22度');
  assert.equal(report.emotion, 'happy');
  assert.equal(report.verbatim, undefined);
  assert.equal(report.summary.includes('开心'), false);
  assert.equal(report.summary.includes('*'), false);

  const hinted = bus.dispatch({ query: '再问一句', source: 'early_rule' });
  await flush();
  must(held.pending[1], 'hint slot').resolve({ text: '没有标签', emotion: '开心' });
  await flush();
  assert.equal(hinted.state(), 'completed');
  const hintedReport = must(reports[1], 'hint report');
  assert.equal(hintedReport.summary, '没有标签');
  assert.equal(hintedReport.emotion, 'happy');
  assert.equal(hintedReport.verbatim, undefined);
});

test('同一轮 early_rule 接着 tool_call 只执行一次，还在排队就升级查询', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });

  const early = bus.dispatch({
    query: 'asr原话',
    source: 'early_rule',
    turnNo: 7,
    note: '旧注',
  });
  const tool = bus.dispatch({
    query: '听见的完整问题',
    source: 'tool_call',
    turnNo: 7,
    note: '新注',
  });
  assert.equal(early.state(), 'queued');
  assert.equal(early.deduplicated, false);
  assert.equal(tool.deduplicated, true);
  assert.equal(tool.taskId, early.taskId);
  assert.equal(tool.source, 'early_rule');
  assert.equal(bus.activeCount(), 1);

  await flush();
  assert.equal(held.calls.length, 1);
  assert.equal(early.state(), 'running');
  const call = must(held.calls[0], 'execute');
  assert.equal(call.taskId, early.taskId);
  assert.equal(call.query, '听见的完整问题');
  assert.equal(call.note, '新注');

  const late = bus.dispatch({
    query: '太晚了不该覆盖',
    source: 'tool_call',
    turnNo: 7,
    note: '晚注',
  });
  assert.equal(late.deduplicated, true);
  assert.equal(late.taskId, early.taskId);
  assert.equal(held.calls.length, 1);

  must(held.pending[0], 'slot').resolve({ text: '[开心]查到了' });
  await flush();
  assert.equal(early.state(), 'completed');
  assert.equal(tool.state(), 'completed');
  assert.equal(late.state(), 'completed');
  assert.equal(reports.length, 1);
  const report = must(reports[0], 'report');
  assert.equal(report.taskId, early.taskId);
  assert.equal(report.source, 'early_rule');
  assert.equal(report.query, '听见的完整问题');
  assert.equal(report.summary, '查到了');
  assert.equal(report.emotion, 'happy');

  const again = bus.dispatch({ query: '再来一次', source: 'tool_call', turnNo: 7 });
  assert.equal(again.deduplicated, true);
  assert.equal(again.state(), 'completed');
  await flush();
  assert.equal(held.calls.length, 1);
  assert.equal(reports.length, 1);

  const early2 = bus.dispatch({
    query: '原话',
    source: 'early_rule',
    turnNo: 8,
    note: '保留',
  });
  const tool2 = bus.dispatch({ query: '更全的问法', source: 'tool_call', turnNo: 8 });
  const rule2 = bus.dispatch({ query: '不要退回这句', source: 'early_rule', turnNo: 8 });
  assert.equal(tool2.deduplicated, true);
  assert.equal(rule2.deduplicated, true);
  assert.equal(rule2.taskId, early2.taskId);
  await flush();
  const second = must(held.calls[1], 'second execute');
  assert.equal(second.query, '更全的问法');
  assert.equal(second.note, '保留');
  must(held.pending[1], 'second slot').resolve({ text: '好' });
  await flush();
  assert.equal(must(reports[1], 'second report').query, '更全的问法');
});

test('空闲总线直接收到 tool_call 时执行改写查询；开跑后不能再改', async () => {
  const held = holdRunner();
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: () => {},
  });
  const rewritten = '改写后的问题\n用户原话：「原话」';
  const idle = bus.dispatch({
    query: rewritten,
    source: 'tool_call',
    turnNo: 3,
  });
  assert.equal(idle.deduplicated, false);
  assert.equal(idle.state(), 'queued');
  await flush();
  assert.equal(must(held.calls[0], 'idle').query, rewritten);
  assert.equal(idle.state(), 'running');

  const late = bus.dispatch({
    query: '开跑之后不该覆盖',
    source: 'tool_call',
    turnNo: 3,
  });
  assert.equal(late.deduplicated, true);
  assert.equal(late.taskId, idle.taskId);
  assert.equal(must(held.calls[0], '仍是改写').query, rewritten);
  must(held.pending[0], 'slot').resolve({ text: '好' });
  await flush();
  assert.equal(held.calls.length, 1);
});

test('静默任务不参与 turnNo 去重', async () => {
  const held = holdRunner();
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: () => { throw new Error('静默轮不该汇报'); },
  });
  const loud = bus.dispatch({ query: '要说', source: 'tool_call', turnNo: 9 });
  const quiet = bus.dispatch({ query: '只记', source: 'memory_silent', turnNo: 9 });
  assert.equal(loud.deduplicated, false);
  assert.equal(quiet.deduplicated, false);
  assert.equal(quiet.silent, true);
  assert.notEqual(loud.taskId, quiet.taskId);
  await flush();
  assert.equal(must(held.calls[0], 'loud').query, '要说');
  assert.equal(quiet.state(), 'queued');
  must(held.pending[0], 'loud slot').resolve({ text: '说了' });
  await flush();
  assert.equal(must(held.calls[1], 'quiet').query, '只记');
  assert.equal(must(held.calls[1], 'quiet').silent, true);
  must(held.pending[1], 'quiet slot').resolve({ text: '记下了' });
  await flush();
  assert.equal(quiet.state(), 'completed');
});

test('要播报的任务排在静默记忆前面，静默成功和失败都不播报', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const lines: string[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    now: () => 50,
    log: (line) => { lines.push(line); },
    onReport: (report) => { reports.push(report); },
  });

  bus.dispatch({ query: '占线', source: 'image' });
  await flush();
  const silent = bus.dispatch({ query: '写记忆', source: 'memory_silent', turnNo: 3 });
  const urgent = bus.dispatch({ query: '现在几点', source: 'tool_call', turnNo: 4 });
  assert.equal(silent.silent, true);
  assert.equal(silent.state(), 'queued');
  assert.equal(urgent.state(), 'queued');
  assert.equal(bus.activeCount(), 3);
  assert.equal(bus.hasActiveReportable(), true);

  must(held.pending[0], 'blocker').resolve({ text: '占线结束' });
  await flush();
  assert.equal(must(held.calls[1], 'urgent').query, '现在几点');
  assert.equal(urgent.state(), 'running');
  assert.equal(silent.state(), 'queued');

  must(held.pending[1], 'urgent slot').resolve({ text: '三点' });
  await flush();
  assert.equal(must(held.calls[2], 'silent').query, '写记忆');
  assert.equal(must(held.calls[2], 'silent').silent, true);
  assert.equal(bus.hasActiveReportable(), false);
  assert.equal(bus.activeCount(), 1);

  must(held.pending[2], 'silent slot').resolve({ text: '记好了不该播' });
  await flush();
  assert.equal(silent.state(), 'completed');
  assert.deepEqual(reports.map((report) => report.summary), ['占线结束', '三点']);
  assert.equal(reports.some((report) => report.source === 'memory_silent'), false);
  assert.equal(lines.some((line) => line.includes('不播报')), true);

  const bad = bus.dispatch({ query: '再写', source: 'memory_silent', silent: true });
  const after = bus.dispatch({ query: '接着说', source: 'early_rule' });
  await flush();
  assert.equal(must(held.calls[3], 'after').query, '接着说');
  assert.equal(bad.state(), 'queued');
  must(held.pending[3], 'after slot').resolve({ text: '接着说完了' });
  await flush();
  assert.equal(must(held.calls[4], 'bad').query, '再写');
  must(held.pending[4], 'bad slot').reject(new Error('disk'));
  await flush();
  assert.equal(bad.state(), 'failed');
  assert.equal(after.state(), 'completed');
  assert.deepEqual(reports.map((report) => report.summary), ['占线结束', '三点', '接着说完了']);
  assert.equal(reports.some((report) => report.summary === FAILURE), false);
});

test('cancelAll 打断在跑的任务并丢掉排队的播报，迟到结果不发', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });

  const running = bus.dispatch({ query: '在查', source: 'tool_call', turnNo: 1 });
  await flush();
  const queued = bus.dispatch({ query: '还没开始', source: 'early_rule', turnNo: 2 });
  const silent = bus.dispatch({ query: '写记忆', source: 'memory_silent' });
  const signal = must(held.calls[0], 'call').signal;

  assert.equal(bus.cancelAll('别查了'), true);
  assert.equal(running.state(), 'cancelled');
  assert.equal(queued.state(), 'cancelled');
  assert.equal(silent.state(), 'queued');
  assert.equal(signal.aborted, true);
  assert.deepEqual(held.cancels, ['别查了']);
  assert.equal(bus.hasActiveReportable(), false);

  must(held.pending[0], 'late').resolve({ text: '查到了不该播' });
  await flush();
  assert.equal(reports.length, 0);
  assert.equal(running.state(), 'cancelled');
  assert.equal(held.calls.every((call) => call.query !== '还没开始'), true);
  assert.equal(must(held.calls[1], 'silent').query, '写记忆');

  must(held.pending[1], 'silent slot').resolve({ text: '记忆写了' });
  await flush();
  assert.equal(reports.length, 0);
  assert.equal(silent.state(), 'completed');
  assert.equal(bus.cancelAll(), false);
  assert.equal(bus.activeCount(), 0);
});

test('取消之后 runner 拒绝也不会变成失败播报', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  const handle = bus.dispatch({ query: '在查', source: 'tool_call' });
  await flush();
  assert.equal(bus.cancelAll(), true);
  assert.deepEqual(held.cancels, ['user_cancel']);
  must(held.pending[0], 'slot').reject(new Error('aborted'));
  await flush();
  assert.equal(reports.length, 0);
  assert.equal(handle.state(), 'cancelled');
  assert.equal(bus.hasActiveReportable(), false);
});

test('cancelAll 默认留着静默记忆，includeSilent 才一起停', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  assert.equal(bus.cancelAll(), false);

  const silent = bus.dispatch({ query: '写记忆', source: 'memory_silent' });
  assert.equal(bus.hasActiveReportable(), false);
  assert.equal(bus.activeCount(), 1);
  assert.equal(bus.cancelAll('别查了'), false);
  assert.equal(silent.state(), 'queued');
  assert.equal(held.cancels.length, 0);

  await flush();
  assert.equal(silent.state(), 'running');
  assert.equal(bus.cancelAll(), false);
  assert.equal(must(held.calls[0], 'call').signal.aborted, false);
  assert.equal(held.cancels.length, 0);

  assert.equal(bus.cancelAll('停', { includeSilent: true }), false);
  assert.equal(silent.state(), 'cancelled');
  assert.equal(must(held.calls[0], 'call').signal.aborted, true);
  assert.deepEqual(held.cancels, ['停']);

  must(held.pending[0], 'slot').resolve({ text: '不该播' });
  await flush();
  assert.equal(reports.length, 0);
  assert.equal(silent.state(), 'cancelled');
  assert.equal(bus.activeCount(), 0);
});

test('外部 onAnnounce 收成 dsh_background，剥情绪并认出逐字稿', async () => {
  const reports: BackgroundTaskReport[] = [];
  let executed = 0;
  const bus = new BackgroundTaskBus({
    runner: {
      async execute() {
        executed += 1;
        return { text: '' };
      },
    },
    onReport: (report) => { reports.push(report); },
  });

  bus.ingestExternalAnnouncement('[开心]查好了', undefined, '刚才那个');
  bus.ingestExternalAnnouncement('[VERBATIM]单号 W8665881');
  bus.ingestExternalAnnouncement('   ');
  bus.ingestExternalAnnouncement('[开心]');
  bus.ingestExternalAnnouncement('[VERBATIM]');
  bus.ingestExternalAnnouncement('到了', '惊讶', '快递');

  assert.equal(executed, 0);
  assert.equal(reports.length, 3);
  const spoken = must(reports[0], 'spoken');
  assert.equal(spoken.source, 'dsh_background');
  assert.equal(spoken.summary, '查好了');
  assert.equal(spoken.emotion, 'happy');
  assert.equal(spoken.query, '刚才那个');
  assert.equal(spoken.verbatim, undefined);
  assert.equal(spoken.summary.includes('开心'), false);

  const verbatim = must(reports[1], 'verbatim');
  assert.equal(verbatim.source, 'dsh_background');
  assert.equal(verbatim.query, '');
  assert.equal(verbatim.summary, '单号 W8665881');
  assert.equal(verbatim.verbatim, '单号 W8665881');
  assert.equal(verbatim.emotion, 'calm');
  assert.equal(verbatim.verbatim.includes('VERBATIM'), false);

  const hinted = must(reports[2], 'hinted');
  assert.equal(hinted.summary, '到了');
  assert.equal(hinted.emotion, 'surprised');
  assert.equal(hinted.query, '快递');
  assert.notEqual(spoken.taskId, verbatim.taskId);

  bus.dispose();
  bus.ingestExternalAnnouncement('不该出现');
  assert.equal(reports.length, 3);
});

test('needsVerbatimRead 只在必须逐字念的时候为真', () => {
  assert.equal(needsVerbatimRead('明天北京晴，12到22度'), false);
  assert.equal(needsVerbatimRead('已经帮你把闹钟定在明天早上七点了'), false);
  assert.equal(needsVerbatimRead('今年是2024年'), false);
  assert.equal(needsVerbatimRead('main.ts'), false);
  assert.equal(needsVerbatimRead('明天 10 到 22 度'), false);
  assert.equal(needsVerbatimRead('2026年11月'), false);
  assert.equal(needsVerbatimRead('晚上8点15分'), false);
  assert.equal(needsVerbatimRead('晚上8:15'), false);
  assert.equal(needsVerbatimRead('甲'.repeat(180)), false);
  assert.equal(needsVerbatimRead(`  ${'甲'.repeat(180)}  `), false);

  assert.equal(needsVerbatimRead('[VERBATIM]就这句'), true);
  assert.equal(needsVerbatimRead('【VERBATIM】念这个'), true);
  assert.equal(needsVerbatimRead('[开心][VERBATIM]你好'), true);
  assert.equal(needsVerbatimRead('端口 63993'), true);
  assert.equal(needsVerbatimRead('端口8080'), true);
  assert.equal(needsVerbatimRead('端口 8766'), true);
  assert.equal(needsVerbatimRead('端口:8766'), true);
  assert.equal(needsVerbatimRead('port=8080'), true);
  assert.equal(needsVerbatimRead(':8766'), true);
  assert.equal(needsVerbatimRead('v2.3.1'), true);
  assert.equal(needsVerbatimRead('v2.3.1-beta.1'), true);
  assert.equal(needsVerbatimRead('服务跑在端口 8766，当前版本 v2.3.1。'), true);
  assert.equal(needsVerbatimRead('单号 W8665881'), true);
  assert.equal(needsVerbatimRead('单号AB1234'), true);
  assert.equal(needsVerbatimRead('改在 src/main.ts'), true);
  assert.equal(needsVerbatimRead('src\\main.py'), true);
  assert.equal(needsVerbatimRead('deploy/app.yml'), true);
  assert.equal(needsVerbatimRead('地址 10.1.2.3'), true);
  assert.equal(needsVerbatimRead('甲'.repeat(181)), true);

  assert.equal(stripVerbatimTag('[VERBATIM]你好'), '你好');
  assert.equal(stripVerbatimTag('前[VERBATIM]后'), '前后');
  assert.equal(stripVerbatimTag('【VERBATIM】留下'), '留下');
  assert.equal(clipSummary('abc', 10), 'abc');
  assert.equal(clipSummary('甲'.repeat(20), 5), '甲'.repeat(5));
});

test('逐字结果带 verbatim，普通短句不带，超长摘要被截断', async () => {
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: {
      async execute(req) {
        return { text: req.query };
      },
    },
    onReport: (report) => { reports.push(report); },
  });
  const long = '甲'.repeat(181);
  const cases: ReadonlyArray<{
    query: string;
    summary: string;
    emotion: string;
    verbatim?: string;
  }> = [
    {
      query: '明天北京晴，12到22度',
      summary: '明天北京晴，12到22度',
      emotion: 'calm',
    },
    {
      query: '已经帮你把闹钟定在明天早上七点了',
      summary: '已经帮你把闹钟定在明天早上七点了',
      emotion: 'calm',
    },
    {
      query: '[VERBATIM]就这一句',
      summary: '就这一句',
      emotion: 'calm',
      verbatim: '就这一句',
    },
    {
      query: '[开心][VERBATIM]端口63993',
      summary: '端口63993',
      emotion: 'happy',
      verbatim: '端口63993',
    },
    {
      query: '[VERBATIM][开心]端口63993',
      summary: '端口63993',
      emotion: 'happy',
      verbatim: '端口63993',
    },
    {
      query: '[VERBATIM]**端口63993**',
      summary: '端口63993',
      emotion: 'calm',
      verbatim: '端口63993',
    },
    {
      query: '单号 W8665881',
      summary: '单号 W8665881',
      emotion: 'calm',
      verbatim: '单号 W8665881',
    },
    {
      query: '改好了 src/main.ts',
      summary: '改好了 src/main.ts',
      emotion: 'calm',
      verbatim: '改好了 src/main.ts',
    },
    {
      query: long,
      summary: '甲'.repeat(160),
      emotion: 'calm',
      verbatim: long,
    },
  ];

  const empty = bus.dispatch({ query: '[开心]', source: 'tool_call' });
  for (const item of cases) {
    bus.dispatch({ query: item.query, source: 'tool_call' });
  }
  await flush();
  assert.equal(empty.state(), 'completed');
  assert.equal(reports.length, cases.length);
  for (let i = 0; i < cases.length; i += 1) {
    const item = must(cases[i], `case ${i}`);
    const report = must(reports[i], `report ${i}`);
    assert.equal(report.query, item.query);
    assert.equal(report.summary, item.summary);
    assert.equal(report.emotion, item.emotion);
    assert.equal(report.verbatim, item.verbatim);
    assert.equal(report.summary.includes('[VERBATIM]'), false);
    assert.equal(report.summary.includes('开心'), false);
  }
  const longReport = must(reports[cases.length - 1], 'long');
  assert.equal(longReport.summary.length, 160);
  assert.equal(longReport.verbatim?.startsWith(longReport.summary), true);
});

test('执行失败给兜底句，并继续后面的任务', async () => {
  const calls: string[] = [];
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: {
      async execute(req) {
        calls.push(req.query);
        if (req.query === '会失败') throw new Error('boom');
        return { text: `[得意]${req.query}好了` };
      },
    },
    onReport: (report) => { reports.push(report); },
  });
  const failed = bus.dispatch({ query: '会失败', source: 'tool_call', turnNo: 2 });
  const next = bus.dispatch({ query: '下一件', source: 'early_rule', turnNo: 3 });
  await flush();
  assert.equal(failed.state(), 'failed');
  assert.equal(next.state(), 'completed');
  assert.deepEqual(calls, ['会失败', '下一件']);
  assert.equal(reports.length, 2);
  const failure = must(reports[0], 'failure');
  assert.equal(failure.summary, FAILURE);
  assert.equal(failure.source, 'tool_call');
  assert.equal(failure.query, '会失败');
  assert.equal(failure.taskId, failed.taskId);
  assert.equal(failure.verbatim, undefined);
  assert.equal(failure.emotion, undefined);
  const followed = must(reports[1], 'next');
  assert.equal(followed.summary, '下一件好了');
  assert.equal(followed.emotion, 'proud');
  assert.equal(followed.query, '下一件');
  assert.equal(followed.source, 'early_rule');

  const retry = bus.dispatch({ query: '再试', source: 'tool_call', turnNo: 2 });
  assert.equal(retry.deduplicated, false);
  await flush();
  assert.equal(retry.state(), 'completed');
  assert.equal(must(reports[2], 'retry').summary, '再试好了');
  assert.deepEqual(calls, ['会失败', '下一件', '再试']);
});

test('dispose 吃掉在途完成，而且不调用 cancelRunning', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  const running = bus.dispatch({ query: '在查', source: 'tool_call' });
  const queued = bus.dispatch({ query: '还没开始', source: 'early_rule' });
  const silent = bus.dispatch({ query: '写记忆', source: 'memory_silent' });
  await flush();
  const signal = must(held.calls[0], 'call').signal;

  bus.dispose();
  bus.dispose();
  assert.equal(running.state(), 'cancelled');
  assert.equal(queued.state(), 'cancelled');
  assert.equal(silent.state(), 'cancelled');
  assert.equal(signal.aborted, true);
  assert.equal(held.cancels.length, 0);
  assert.equal(bus.activeCount(), 0);
  assert.equal(bus.hasActiveReportable(), false);

  must(held.pending[0], 'late').resolve({ text: '迟到' });
  await flush();
  assert.equal(reports.length, 0);
  assert.equal(running.state(), 'cancelled');
  assert.equal(held.calls.length, 1);

  const ghost = bus.dispatch({ query: '新的', source: 'tool_call' });
  assert.equal(ghost.state(), 'cancelled');
  assert.equal(ghost.deduplicated, false);
  bus.ingestExternalAnnouncement('[开心]不该出现', undefined, '问');
  await flush();
  assert.equal(reports.length, 0);
  assert.equal(held.calls.length, 1);
});

test('还没开跑就 dispose，一条都不会执行', async () => {
  const held = holdRunner();
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: () => { throw new Error('不该汇报'); },
  });
  const first = bus.dispatch({ query: '一', source: 'tool_call' });
  const second = bus.dispatch({ query: '二', source: 'memory_silent' });
  assert.equal(first.state(), 'queued');
  bus.dispose();
  await flush();
  assert.equal(held.calls.length, 0);
  assert.equal(held.cancels.length, 0);
  assert.equal(first.state(), 'cancelled');
  assert.equal(second.state(), 'cancelled');
});

test('汇报回调抛错不会停掉后面的任务', async () => {
  const reports: string[] = [];
  const bus = new BackgroundTaskBus({
    runner: {
      async execute(req) {
        return { text: req.query };
      },
    },
    onReport(report) {
      reports.push(report.summary);
      if (report.summary === '第一') throw new Error('下游挂了');
    },
  });
  const first = bus.dispatch({ query: '第一', source: 'tool_call' });
  const second = bus.dispatch({ query: '第二', source: 'early_rule' });
  await flush();
  assert.deepEqual(reports, ['第一', '第二']);
  assert.equal(first.state(), 'completed');
  assert.equal(second.state(), 'completed');
});

test('同一时间只有一个 runner.execute', async () => {
  let active = 0;
  let max = 0;
  const bus = new BackgroundTaskBus({
    onReport: () => {},
    runner: {
      async execute() {
        active += 1;
        max = Math.max(max, active);
        await Promise.resolve();
        active -= 1;
        return { text: '好' };
      },
    },
  });
  bus.dispatch({ query: 'a', source: 'tool_call' });
  bus.dispatch({ query: 'b', source: 'early_rule' });
  bus.dispatch({ query: 'c', source: 'image' });
  await flush();
  assert.equal(max, 1);
  assert.equal(active, 0);
});

test('队列超过上限就丢，去重不算新任务', async () => {
  const held = holdRunner();
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: () => {},
    maxQueue: 1,
  });
  const first = bus.dispatch({ query: '先', source: 'early_rule', turnNo: 1 });
  const upgraded = bus.dispatch({ query: '先的完整版', source: 'tool_call', turnNo: 1 });
  const dropped = bus.dispatch({ query: '多余', source: 'tool_call', turnNo: 2 });
  assert.equal(upgraded.deduplicated, true);
  assert.equal(upgraded.taskId, first.taskId);
  assert.equal(dropped.state(), 'cancelled');
  assert.equal(dropped.deduplicated, false);
  await flush();
  assert.equal(held.calls.length, 1);
  assert.equal(must(held.calls[0], 'call').query, '先的完整版');
  assert.equal(bus.activeCount(), 1);

  const next = bus.dispatch({ query: '后续', source: 'image' });
  assert.equal(next.state(), 'queued');
  assert.equal(bus.activeCount(), 2);
  must(held.pending[0], 'first').resolve({ text: '好' });
  await flush();
  assert.equal(must(held.calls[1], 'next').query, '后续');
  must(held.pending[1], 'next slot').resolve({ text: '也好' });
  await flush();
  assert.equal(next.state(), 'completed');
  assert.equal(bus.activeCount(), 0);
});

test('resetSession 后重连的 turnNo 不再被旧会话吞掉，同会话去重仍在', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });

  const old = bus.dispatch({ query: '旧会话', source: 'tool_call', turnNo: 1 });
  await flush();
  must(held.pending[0], 'old slot').resolve({ text: '旧答案' });
  await flush();
  assert.equal(old.state(), 'completed');

  const dup = bus.dispatch({ query: '同一会话', source: 'early_rule', turnNo: 1 });
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.taskId, old.taskId);
  assert.equal(dup.state(), 'completed');
  assert.equal(held.calls.length, 1);

  bus.resetSession();
  bus.resetSession();

  const early = bus.dispatch({
    query: '重连原话',
    source: 'early_rule',
    turnNo: 1,
    note: '旧注',
  });
  const tool = bus.dispatch({
    query: '重连后的完整问题',
    source: 'tool_call',
    turnNo: 1,
    note: '新注',
  });
  assert.equal(early.deduplicated, false);
  assert.equal(early.state(), 'queued');
  assert.notEqual(early.taskId, old.taskId);
  assert.equal(tool.deduplicated, true);
  assert.equal(tool.taskId, early.taskId);
  assert.equal(tool.source, 'early_rule');
  assert.equal(bus.activeCount(), 1);

  const early2 = bus.dispatch({
    query: '第二轮原话',
    source: 'early_rule',
    turnNo: 2,
    note: '保留',
  });
  const tool2 = bus.dispatch({ query: '第二轮完整问题', source: 'tool_call', turnNo: 2 });
  assert.equal(tool2.deduplicated, true);
  assert.equal(tool2.taskId, early2.taskId);

  await flush();
  assert.equal(held.calls.length, 2);
  const first = must(held.calls[1], 'reconnect execute');
  assert.equal(first.taskId, early.taskId);
  assert.equal(first.query, '重连后的完整问题');
  assert.equal(first.note, '新注');
  assert.equal(early.state(), 'running');
  assert.equal(early2.state(), 'queued');

  must(held.pending[1], 'reconnect slot').resolve({ text: '新答案' });
  await flush();
  assert.equal(early.state(), 'completed');
  assert.equal(tool.state(), 'completed');
  const second = must(held.calls[2], 'turn 2 execute');
  assert.equal(second.query, '第二轮完整问题');
  assert.equal(second.note, '保留');

  const blocked = bus.dispatch({ query: '新会话里不该再跑', source: 'tool_call', turnNo: 1 });
  assert.equal(blocked.deduplicated, true);
  assert.equal(blocked.taskId, early.taskId);
  assert.equal(blocked.state(), 'completed');
  assert.equal(held.calls.length, 3);

  must(held.pending[2], 'turn 2 slot').resolve({ text: '第二轮答案' });
  await flush();
  assert.equal(early2.state(), 'completed');
  assert.equal(must(reports[1], 'new report').summary, '新答案');
  assert.equal(must(reports[1], 'new report').query, '重连后的完整问题');
  assert.equal(must(reports[2], 'turn 2 report').summary, '第二轮答案');
  assert.equal(old.state(), 'completed');
});

test('resetSession 不取消在跑和排队的任务，也不释放总线', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });

  const running = bus.dispatch({ query: '还在跑', source: 'tool_call', turnNo: 1 });
  await flush();
  const queued = bus.dispatch({ query: '还在排队', source: 'early_rule', turnNo: 2 });
  assert.equal(running.state(), 'running');
  assert.equal(queued.state(), 'queued');

  bus.resetSession();
  assert.equal(running.state(), 'running');
  assert.equal(queued.state(), 'queued');
  assert.equal(must(held.calls[0], 'running call').signal.aborted, false);
  assert.equal(held.cancels.length, 0);

  const again = bus.dispatch({ query: '重连第一轮', source: 'early_rule', turnNo: 1 });
  const turn2 = bus.dispatch({ query: '新的第二轮', source: 'tool_call', turnNo: 2 });
  assert.equal(again.deduplicated, false);
  assert.equal(again.state(), 'queued');
  assert.notEqual(again.taskId, running.taskId);
  assert.equal(turn2.deduplicated, false);
  assert.notEqual(turn2.taskId, queued.taskId);

  must(held.pending[0], 'running slot').resolve({ text: '旧的跑完了' });
  await flush();
  assert.equal(running.state(), 'completed');
  assert.equal(must(reports[0], 'running report').summary, '旧的跑完了');
  assert.equal(must(held.calls[1], 'queued call').query, '还在排队');
  assert.equal(queued.state(), 'running');

  must(held.pending[1], 'queued slot').resolve({ text: '排队的也说' });
  await flush();
  assert.equal(queued.state(), 'completed');
  assert.equal(must(held.calls[2], 'reconnect call').query, '重连第一轮');
  assert.equal(again.state(), 'running');

  must(held.pending[2], 'again slot').resolve({ text: '新的第一轮' });
  await flush();
  assert.equal(again.state(), 'completed');
  assert.equal(turn2.state(), 'running');
  assert.equal(must(held.calls[3], 'turn 2 call').query, '新的第二轮');
  must(held.pending[3], 'turn 2 slot').resolve({ text: '新的第二轮说完' });
  await flush();
  assert.equal(turn2.state(), 'completed');
  assert.equal(bus.activeCount(), 0);
  assert.deepEqual(reports.map((report) => report.summary), [
    '旧的跑完了',
    '排队的也说',
    '新的第一轮',
    '新的第二轮说完',
  ]);
});

test('四位端口和版本号走逐字，天气年份钟点不走', async () => {
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: {
      async execute(req) {
        return { text: req.query };
      },
    },
    onReport: (report) => { reports.push(report); },
  });
  const cases: ReadonlyArray<{ query: string; verbatim?: string }> = [
    { query: '端口 8766', verbatim: '端口 8766' },
    { query: 'v2.3.1', verbatim: 'v2.3.1' },
    {
      query: '服务跑在端口 8766，当前版本 v2.3.1。',
      verbatim: '服务跑在端口 8766，当前版本 v2.3.1。',
    },
    { query: '明天 10 到 22 度' },
    { query: '2026年11月' },
    { query: '晚上8点15分' },
  ];
  for (const item of cases) {
    bus.dispatch({ query: item.query, source: 'tool_call' });
  }
  await flush();
  assert.equal(reports.length, cases.length);
  for (let i = 0; i < cases.length; i += 1) {
    const item = must(cases[i], `case ${i}`);
    const report = must(reports[i], `report ${i}`);
    assert.equal(needsVerbatimRead(item.query), item.verbatim !== undefined);
    assert.equal(report.query, item.query);
    assert.equal(report.summary, item.query);
    assert.equal(report.verbatim, item.verbatim);
  }
});

test('parseCanonicalUserTag 认中英文括号和冒号，空标签与无标签不编原意', () => {
  assert.deepEqual(parseCanonicalUserTag('[原意: 帮我打开空调]\n[开心]空调已打开'), {
    canonicalUser: '帮我打开空调',
    body: '[开心]空调已打开',
  });
  assert.deepEqual(parseCanonicalUserTag('[原意：帮我打开空调]\n第一行\n第二行'), {
    canonicalUser: '帮我打开空调',
    body: '第一行\n第二行',
  });
  assert.deepEqual(parseCanonicalUserTag('【原意: 帮我打开空调】\r\n已打开'), {
    canonicalUser: '帮我打开空调',
    body: '已打开',
  });
  assert.deepEqual(parseCanonicalUserTag('【原意：帮我打开空调】空调已打开'), {
    canonicalUser: '帮我打开空调',
    body: '空调已打开',
  });
  assert.deepEqual(parseCanonicalUserTag('  【 原意 ： 帮我 打开空调 】 \n已打开'), {
    canonicalUser: '帮我 打开空调',
    body: '已打开',
  });
  assert.deepEqual(parseCanonicalUserTag('[原意: 我说: 打开空调] 下一句'), {
    canonicalUser: '我说: 打开空调',
    body: '下一句',
  });
  assert.deepEqual(parseCanonicalUserTag('[原意: x]  \n空调'), {
    canonicalUser: 'x',
    body: '空调',
  });
  assert.deepEqual(parseCanonicalUserTag('[原意: x]\n  空调'), {
    canonicalUser: 'x',
    body: '  空调',
  });
  assert.deepEqual(parseCanonicalUserTag('[原意: x]\n\n空调'), {
    canonicalUser: 'x',
    body: '\n空调',
  });

  assert.deepEqual(parseCanonicalUserTag('[原意:]后文'), { body: '后文' });
  assert.deepEqual(parseCanonicalUserTag('[原意:   ]\n后文'), { body: '后文' });
  assert.deepEqual(parseCanonicalUserTag('[原意：]'), { body: '' });
  assert.deepEqual(parseCanonicalUserTag('【原意：】'), { body: '' });
  assert.deepEqual(parseCanonicalUserTag('【原意:   】下一句'), { body: '下一句' });

  const plain = '没有标签';
  assert.deepEqual(parseCanonicalUserTag(plain), { body: plain });
  assert.deepEqual(parseCanonicalUserTag(''), { body: '' });
  assert.deepEqual(parseCanonicalUserTag('  前有空白'), { body: '  前有空白' });
  assert.deepEqual(parseCanonicalUserTag('先说[原意: 不该吃掉]'), {
    body: '先说[原意: 不该吃掉]',
  });
  assert.deepEqual(parseCanonicalUserTag('[开心]这不是原意'), { body: '[开心]这不是原意' });
  assert.deepEqual(parseCanonicalUserTag('[原意开心]正文'), { body: '[原意开心]正文' });
});

test('dsh 返回的原意标签进 canonicalUser，不进播报正文', async () => {
  const scripts: Array<{ text: string; speech?: string; emotion?: string }> = [
    { text: '[原意: 帮我打开空调]\n[开心]空调已打开' },
    { text: '【原意：帮我开灯】\n[惊讶]灯开了' },
    {
      text: '[开心]空调已打开',
      speech: '[原意: 帮我打开空调]',
    },
    {
      text: '[原意: 以文本为准]\n文本结论',
      speech: '[原意: 不该用这句]\n[开心]语音结论',
    },
    { text: '[原意: 帮我查一下]\n[VERBATIM][开心]端口 8766' },
    { text: '[原意: 单号 W8665881]\n查好了' },
    { text: '[原意:]\n[开心]还是这句' },
    { text: '[原意:   ]\n[得意]空标签不算' },
    { text: '空调已打开' },
    { text: '[原意: 开灯]\n[开心]灯开了', emotion: '惊讶' },
  ];
  let cursor = 0;
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: {
      async execute() {
        const script = must(scripts[cursor], `script ${cursor}`);
        cursor += 1;
        return script;
      },
    },
    onReport: (report) => { reports.push(report); },
  });

  const main = bus.dispatch({
    query: '帮我打开空条',
    source: 'tool_call',
    turnNo: 6,
  });
  bus.dispatch({ query: '开灯', source: 'early_rule', turnNo: 7 });
  bus.dispatch({ query: '语音里才有原意', source: 'tool_call', turnNo: 8 });
  bus.dispatch({ query: '两边都有', source: 'image', turnNo: 9 });
  bus.dispatch({ query: '查端口', source: 'tool_call', turnNo: 10 });
  bus.dispatch({ query: '查单号', source: 'early_rule', turnNo: 11 });
  bus.dispatch({ query: '空标签', source: 'tool_call', turnNo: 12 });
  bus.dispatch({ query: '空白标签', source: 'tool_call', turnNo: 13 });
  bus.dispatch({ query: '[原意: 不该从查询里取]', source: 'tool_call' });
  bus.dispatch({ query: '情绪提示盖过标签', source: 'tool_call', turnNo: 14 });
  await flush();

  assert.equal(cursor, scripts.length);
  assert.equal(main.state(), 'completed');
  assert.equal(reports.length, scripts.length);

  const report = must(reports[0], 'report');
  assert.equal(report.taskId, main.taskId);
  assert.equal(report.query, '帮我打开空条');
  assert.equal(report.canonicalUser, '帮我打开空调');
  assert.equal(report.summary, '空调已打开');
  assert.equal(report.emotion, 'happy');
  assert.equal(report.turnNo, 6);
  assert.equal(report.verbatim, undefined);
  assert.equal(report.summary.includes('原意'), false);
  assert.equal(report.summary.includes('帮我打开空调'), false);
  assert.equal(report.summary.includes('['), false);
  assert.equal(report.summary.includes('开心'), false);

  const lamp = must(reports[1], 'lamp');
  assert.equal(lamp.canonicalUser, '帮我开灯');
  assert.equal(lamp.summary, '灯开了');
  assert.equal(lamp.emotion, 'surprised');
  assert.equal(lamp.turnNo, 7);
  assert.equal(lamp.verbatim, undefined);

  const speechOnly = must(reports[2], 'speech only');
  assert.equal(speechOnly.canonicalUser, '帮我打开空调');
  assert.equal(speechOnly.summary, '空调已打开');
  assert.equal(speechOnly.emotion, 'happy');
  assert.equal(speechOnly.turnNo, 8);
  assert.equal(speechOnly.verbatim, undefined);
  assert.equal(speechOnly.summary.includes('原意'), false);

  const textWins = must(reports[3], 'text wins');
  assert.equal(textWins.canonicalUser, '以文本为准');
  assert.equal(textWins.summary, '语音结论');
  assert.equal(textWins.emotion, 'happy');
  assert.equal(textWins.turnNo, 9);
  assert.equal(textWins.summary.includes('不该用这句'), false);
  assert.equal(textWins.summary.includes('原意'), false);

  const verbatim = must(reports[4], 'verbatim');
  assert.equal(verbatim.canonicalUser, '帮我查一下');
  assert.equal(verbatim.summary, '端口 8766');
  assert.equal(verbatim.verbatim, '端口 8766');
  assert.equal(verbatim.emotion, 'happy');
  assert.equal(verbatim.turnNo, 10);
  assert.equal(verbatim.summary.includes('原意'), false);
  assert.equal(verbatim.summary.includes('VERBATIM'), false);
  assert.equal(verbatim.summary.includes('开心'), false);
  assert.equal(verbatim.verbatim.includes('原意'), false);
  assert.equal(verbatim.verbatim.includes('VERBATIM'), false);
  assert.equal(verbatim.verbatim.includes('开心'), false);

  const orderInTag = must(reports[5], 'order in tag');
  assert.equal(orderInTag.canonicalUser, '单号 W8665881');
  assert.equal(orderInTag.summary, '查好了');
  assert.equal(orderInTag.emotion, 'calm');
  assert.equal(orderInTag.turnNo, 11);
  assert.equal(orderInTag.verbatim, undefined);
  assert.equal(orderInTag.summary.includes('W8665881'), false);
  assert.equal(orderInTag.summary.includes('原意'), false);

  const emptyTag = must(reports[6], 'empty tag');
  assert.equal(emptyTag.canonicalUser, undefined);
  assert.equal(Object.hasOwn(emptyTag, 'canonicalUser'), false);
  assert.equal(emptyTag.summary, '还是这句');
  assert.equal(emptyTag.emotion, 'happy');
  assert.equal(emptyTag.turnNo, 12);
  assert.equal(emptyTag.summary.includes('原意'), false);

  const blankTag = must(reports[7], 'blank tag');
  assert.equal(blankTag.canonicalUser, undefined);
  assert.equal(Object.hasOwn(blankTag, 'canonicalUser'), false);
  assert.equal(blankTag.summary, '空标签不算');
  assert.equal(blankTag.emotion, 'proud');
  assert.equal(blankTag.turnNo, 13);

  const queryOnly = must(reports[8], 'query only');
  assert.equal(queryOnly.query, '[原意: 不该从查询里取]');
  assert.equal(queryOnly.canonicalUser, undefined);
  assert.equal(Object.hasOwn(queryOnly, 'canonicalUser'), false);
  assert.equal(Object.hasOwn(queryOnly, 'turnNo'), false);
  assert.equal(queryOnly.summary, '空调已打开');
  assert.equal(queryOnly.emotion, 'calm');
  assert.equal(queryOnly.summary.includes('原意'), false);

  const hinted = must(reports[9], 'hinted');
  assert.equal(hinted.canonicalUser, '开灯');
  assert.equal(hinted.summary, '灯开了');
  assert.equal(hinted.emotion, 'surprised');
  assert.equal(hinted.turnNo, 14);
  assert.equal(hinted.summary.includes('原意'), false);
  assert.equal(hinted.summary.includes('开心'), false);

  const beforeExternal = reports.length;
  bus.ingestExternalAnnouncement('[原意: 快递到了]\n[惊讶]放门口了', undefined, '快递');
  assert.equal(reports.length, beforeExternal + 1);
  const external = must(reports[beforeExternal], 'external');
  assert.equal(external.source, 'dsh_background');
  assert.equal(external.query, '快递');
  assert.equal(external.canonicalUser, '快递到了');
  assert.equal(external.summary, '放门口了');
  assert.equal(external.emotion, 'surprised');
  assert.equal(external.turnNo, undefined);
  assert.equal(Object.hasOwn(external, 'turnNo'), false);
  assert.equal(external.verbatim, undefined);
  assert.equal(external.summary.includes('原意'), false);
  assert.equal(external.summary.includes('快递到了'), false);
});

test('onLifecycle 按排队、升级、运行到完成、失败或取消的顺序通知', async () => {
  const held = holdRunner();
  const events: BackgroundTaskLifecycleEvent[] = [];
  const reports: BackgroundTaskReport[] = [];
  const trace: string[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onLifecycle(event) {
      events.push(event);
      trace.push(event.type);
    },
    onReport(report) {
      reports.push(report);
      trace.push('report');
    },
  });

  const early = bus.dispatch({
    query: '原话',
    source: 'early_rule',
    turnNo: 4,
    note: '旧注',
  });
  const tool = bus.dispatch({
    query: '改写后的问题',
    source: 'tool_call',
    turnNo: 4,
    note: '新注',
  });
  assert.equal(tool.deduplicated, true);
  assert.equal(tool.taskId, early.taskId);
  assert.deepEqual(trace, ['queued', 'upgraded']);

  const queued = must(events[0], 'queued');
  assert.equal(queued.type, 'queued');
  assert.equal(queued.taskId, early.taskId);
  assert.equal(queued.turnNo, 4);
  assert.equal(queued.source, 'early_rule');
  assert.equal(queued.query, '原话');
  assert.equal(queued.silent, false);

  const upgraded = must(events[1], 'upgraded');
  assert.equal(upgraded.type, 'upgraded');
  assert.equal(upgraded.taskId, early.taskId);
  assert.equal(upgraded.turnNo, 4);
  assert.equal(upgraded.source, 'early_rule');
  assert.equal(upgraded.query, '改写后的问题');
  assert.equal(upgraded.silent, false);

  await flush();
  assert.equal(early.state(), 'running');
  assert.equal(must(held.calls[0], 'upgraded call').query, '改写后的问题');
  assert.equal(must(held.calls[0], 'upgraded call').note, '新注');
  assert.deepEqual(trace, ['queued', 'upgraded', 'running']);
  const running = must(events[2], 'running');
  assert.equal(running.type, 'running');
  assert.equal(running.taskId, early.taskId);
  assert.equal(running.turnNo, 4);
  assert.equal(running.source, 'early_rule');
  assert.equal(running.query, '改写后的问题');
  assert.equal(running.silent, false);

  const late = bus.dispatch({
    query: '太晚了不该升级',
    source: 'tool_call',
    turnNo: 4,
  });
  assert.equal(late.deduplicated, true);
  assert.deepEqual(trace, ['queued', 'upgraded', 'running']);

  must(held.pending[0], 'done').resolve({ text: '[开心]查到了' });
  await flush();
  assert.equal(early.state(), 'completed');
  assert.deepEqual(trace, ['queued', 'upgraded', 'running', 'completed', 'report']);
  const completed = must(events[3], 'completed');
  assert.equal(completed.type, 'completed');
  assert.equal(completed.taskId, early.taskId);
  assert.equal(completed.turnNo, 4);
  assert.equal(completed.silent, false);
  assert.equal(completed.query, '改写后的问题');
  const completedReport = must(reports[0], 'completed report');
  assert.equal(completed.report, completedReport);
  assert.equal(completedReport.summary, '查到了');
  assert.equal(completedReport.emotion, 'happy');
  assert.equal(completedReport.turnNo, 4);
  assert.equal(completedReport.query, '改写后的问题');

  trace.length = 0;
  events.length = 0;
  const failed = bus.dispatch({ query: '会失败', source: 'image', turnNo: 9 });
  await flush();
  must(held.pending[1], 'fail').reject(new Error('boom'));
  await flush();
  assert.equal(failed.state(), 'failed');
  assert.deepEqual(trace, ['queued', 'running', 'failed', 'report']);
  const failedEvent = must(events[2], 'failed');
  assert.equal(failedEvent.type, 'failed');
  if (failedEvent.type !== 'failed') return;
  assert.equal(failedEvent.taskId, failed.taskId);
  assert.equal(failedEvent.turnNo, 9);
  assert.equal(failedEvent.source, 'image');
  assert.equal(failedEvent.query, '会失败');
  assert.equal(failedEvent.silent, false);
  assert.equal(failedEvent.error, 'boom');
  const failedReport = must(reports[1], 'failed report');
  assert.equal(failedEvent.report, failedReport);
  assert.equal(failedReport.summary, FAILURE);
  assert.equal(failedReport.turnNo, 9);
  assert.equal(failedReport.emotion, undefined);
  assert.equal(failedReport.canonicalUser, undefined);
  assert.equal(Object.hasOwn(failedReport, 'canonicalUser'), false);

  trace.length = 0;
  events.length = 0;
  const notStarted = bus.dispatch({
    query: '还没开始',
    source: 'early_rule',
    turnNo: 3,
  });
  assert.deepEqual(trace, ['queued']);
  assert.equal(bus.cancelAll('先别查'), true);
  await flush();
  assert.equal(notStarted.state(), 'cancelled');
  assert.deepEqual(trace, ['queued', 'cancelled']);
  assert.equal(held.calls.some((call) => call.query === '还没开始'), false);
  const queuedCancel = must(events[1], 'queued cancel');
  assert.equal(queuedCancel.type, 'cancelled');
  if (queuedCancel.type !== 'cancelled') return;
  assert.equal(queuedCancel.taskId, notStarted.taskId);
  assert.equal(queuedCancel.turnNo, 3);
  assert.equal(queuedCancel.source, 'early_rule');
  assert.equal(queuedCancel.query, '还没开始');
  assert.equal(queuedCancel.silent, false);
  assert.equal(queuedCancel.reason, '先别查');

  trace.length = 0;
  events.length = 0;
  const runningCancel = bus.dispatch({ query: '在查', source: 'tool_call', turnNo: 2 });
  await flush();
  assert.deepEqual(trace, ['queued', 'running']);
  assert.equal(bus.cancelAll('别查了'), true);
  assert.deepEqual(trace, ['queued', 'running', 'cancelled']);
  must(held.pending.at(-1), 'aborted').reject(new Error('aborted'));
  await flush();
  assert.equal(runningCancel.state(), 'cancelled');
  assert.deepEqual(trace, ['queued', 'running', 'cancelled']);
  assert.equal(reports.length, 2);
  const runningCancelled = must(events[2], 'running cancel');
  assert.equal(runningCancelled.type, 'cancelled');
  if (runningCancelled.type !== 'cancelled') return;
  assert.equal(runningCancelled.taskId, runningCancel.taskId);
  assert.equal(runningCancelled.reason, '别查了');
  assert.equal(runningCancelled.silent, false);
  assert.equal(runningCancelled.query, '在查');
  assert.equal(runningCancelled.turnNo, 2);
  assert.equal(runningCancelled.source, 'tool_call');

  trace.length = 0;
  events.length = 0;
  const reportsBeforeSilent = reports.length;
  const quiet = bus.dispatch({
    query: '只记不说',
    source: 'tool_call',
    silent: true,
    turnNo: 11,
  });
  await flush();
  must(held.pending.at(-1), 'silent done').resolve({
    text: '[原意: 不该播出来]\n[开心]记好了',
  });
  await flush();
  assert.equal(quiet.state(), 'completed');
  assert.deepEqual(trace, ['queued', 'running', 'completed']);
  assert.equal(events.every((event) => event.silent === true), true);
  assert.equal(reports.length, reportsBeforeSilent);
  const silentDone = must(events[2], 'silent done');
  assert.equal(silentDone.type, 'completed');
  if (silentDone.type !== 'completed') return;
  assert.equal(silentDone.report, undefined);
  assert.equal(Object.hasOwn(silentDone, 'report'), false);
  assert.equal(silentDone.taskId, quiet.taskId);
  assert.equal(silentDone.turnNo, 11);
  assert.equal(silentDone.source, 'tool_call');
  assert.equal(silentDone.query, '只记不说');
  assert.equal(silentDone.silent, true);

  trace.length = 0;
  events.length = 0;
  const silentFail = bus.dispatch({
    query: '写失败',
    source: 'memory_silent',
    turnNo: 12,
  });
  await flush();
  must(held.pending.at(-1), 'silent fail').reject(new Error('disk'));
  await flush();
  assert.equal(silentFail.state(), 'failed');
  assert.deepEqual(trace, ['queued', 'running', 'failed']);
  assert.equal(reports.length, reportsBeforeSilent);
  const silentFailed = must(events[2], 'silent failed');
  assert.equal(silentFailed.type, 'failed');
  if (silentFailed.type !== 'failed') return;
  assert.equal(silentFailed.silent, true);
  assert.equal(silentFailed.error, 'disk');
  assert.equal(silentFailed.report, undefined);
  assert.equal(Object.hasOwn(silentFailed, 'report'), false);
  assert.equal(silentFailed.source, 'memory_silent');
  assert.equal(silentFailed.query, '写失败');
  assert.equal(silentFailed.turnNo, 12);
  assert.equal(events[0]?.silent, true);
  assert.equal(events[1]?.silent, true);

  trace.length = 0;
  events.length = 0;
  const silentQueued = bus.dispatch({
    query: '别说',
    source: 'early_rule',
    silent: true,
    turnNo: 8,
  });
  assert.equal(events[0]?.type, 'queued');
  assert.equal(events[0]?.silent, true);
  assert.equal(bus.cancelAll('停掉', { includeSilent: true }), false);
  await flush();
  assert.equal(silentQueued.state(), 'cancelled');
  assert.deepEqual(trace, ['queued', 'cancelled']);
  assert.equal(held.calls.some((call) => call.query === '别说'), false);
  const silentCancelled = must(events[1], 'silent cancel');
  assert.equal(silentCancelled.type, 'cancelled');
  if (silentCancelled.type !== 'cancelled') return;
  assert.equal(silentCancelled.reason, '停掉');
  assert.equal(silentCancelled.silent, true);
  assert.equal(silentCancelled.taskId, silentQueued.taskId);
  assert.equal(silentCancelled.query, '别说');
  assert.equal(silentCancelled.turnNo, 8);
  assert.equal(silentCancelled.source, 'early_rule');

  const overflow: BackgroundTaskLifecycleEvent[] = [];
  const capped = holdRunner();
  const full = new BackgroundTaskBus({
    runner: capped.runner,
    maxQueue: 1,
    onLifecycle: (event) => { overflow.push(event); },
    onReport: () => { throw new Error('丢弃的任务不该汇报'); },
  });
  const kept = full.dispatch({ query: '占位', source: 'tool_call', turnNo: 1 });
  const dropped = full.dispatch({ query: '丢掉', source: 'early_rule', turnNo: 2 });
  assert.equal(dropped.state(), 'cancelled');
  assert.equal(dropped.deduplicated, false);
  assert.deepEqual(overflow.map((event) => event.type), ['queued']);
  assert.equal(overflow[0]?.query, '占位');
  assert.equal(overflow[0]?.taskId, kept.taskId);
  assert.notEqual(dropped.taskId, kept.taskId);
});

test('onLifecycle 抛错不会打断入队和播报', async () => {
  const reports: string[] = [];
  const lines: string[] = [];
  const bus = new BackgroundTaskBus({
    now: () => 1,
    log: (line) => { lines.push(line); },
    runner: {
      async execute() {
        return { text: '好' };
      },
    },
    onLifecycle() {
      throw new Error('监听挂了');
    },
    onReport(report) {
      reports.push(report.summary);
    },
  });
  const handle = bus.dispatch({ query: '问', source: 'tool_call', turnNo: 3 });
  await flush();
  assert.equal(handle.state(), 'completed');
  assert.deepEqual(reports, ['好']);
  assert.equal(lines.some((line) => line.includes('生命周期回调异常')), true);
  assert.equal(lines.some((line) => line.includes('监听挂了')), true);
});

test('BusPhase：dispose 在 scheduled 挡住已入队 drain，取消未收尾时 activeCount 不自相矛盾', async () => {
  const cycleHeld = holdRunner();
  const cycle = new BackgroundTaskBus({
    runner: cycleHeld.runner,
    onReport: () => {},
  });
  const first = cycle.dispatch({ query: '先跑', source: 'tool_call' });
  assert.equal(first.state(), 'queued');
  assert.equal(cycleHeld.calls.length, 0, '同步段只预约，还没 drain');
  await flush();
  assert.equal(first.state(), 'running');
  assert.equal(cycleHeld.calls.length, 1);
  must(cycleHeld.pending[0], 'cycle slot').resolve({ text: '好' });
  await flush();
  assert.equal(first.state(), 'completed');
  assert.equal(cycle.activeCount(), 0);

  const again = cycle.dispatch({ query: '再跑', source: 'early_rule' });
  await flush();
  assert.equal(again.state(), 'running', '回到 idle 之后还要能再 scheduled → draining');
  must(cycleHeld.pending[1], 'again slot').resolve({ text: '也好' });
  await flush();
  assert.equal(again.state(), 'completed');
  assert.equal(cycle.activeCount(), 0);

  let ran = false;
  const parked = new BackgroundTaskBus({
    runner: {
      async execute() {
        ran = true;
        return { text: '不该跑' };
      },
    },
    onReport: () => { throw new Error('不该汇报'); },
  });
  const queued = parked.dispatch({ query: '还在微任务里', source: 'tool_call' });
  const quietQueued = parked.dispatch({ query: '静默也在队列', source: 'memory_silent' });
  assert.equal(queued.state(), 'queued');
  assert.equal(quietQueued.state(), 'queued');
  assert.equal(ran, false);
  parked.dispose();
  await flush();
  assert.equal(ran, false, 'scheduled → disposed 后已入队微任务不得再 drain');
  assert.equal(queued.state(), 'cancelled');
  assert.equal(quietQueued.state(), 'cancelled');
  assert.equal(parked.activeCount(), 0);
  const ghost = parked.dispatch({ query: '释放后', source: 'early_rule' });
  await flush();
  assert.equal(ghost.state(), 'cancelled');
  assert.equal(ran, false);

  const held = holdRunner();
  const reports: string[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report.summary); },
  });
  const running = bus.dispatch({ query: '在查', source: 'tool_call', turnNo: 1 });
  await flush();
  const quiet = bus.dispatch({ query: '写记忆', source: 'memory_silent' });
  assert.equal(running.state(), 'running');
  assert.equal(quiet.state(), 'queued');
  assert.equal(bus.activeCount(), 2);
  assert.equal(bus.cancelAll('别查了'), true);
  assert.equal(running.state(), 'cancelled');
  assert.equal(quiet.state(), 'queued');
  assert.equal(held.pending.length, 1, 'execute 还没 settle，finally 还没摘掉 running 槽');
  assert.equal(bus.activeCount(), 1, 'cancelled 槽不能再算活跃，静默排队仍要算');
  assert.equal(bus.hasActiveReportable(), false);

  must(held.pending[0], 'late').resolve({ text: '迟到不该播' });
  await flush();
  assert.deepEqual(reports, []);
  assert.equal(running.state(), 'cancelled');
  assert.equal(must(held.calls[1], 'silent still runs').query, '写记忆');
  must(held.pending[1], 'silent done').resolve({ text: '记了' });
  await flush();
  assert.equal(quiet.state(), 'completed');
  assert.equal(bus.activeCount(), 0);
  assert.deepEqual(reports, []);
});

test('上游 AbortError 记为取消，不播假失败，同轮可再派单', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const events: BackgroundTaskLifecycleEvent[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
    onLifecycle: (event) => { events.push(event); },
  });
  const task = bus.dispatch({ query: '会被宿主取消', source: 'tool_call', turnNo: 5 });
  await flush();
  assert.equal(task.state(), 'running');

  const aborted = new Error('任务已在宿主侧取消');
  aborted.name = 'AbortError';
  (aborted as Error & { code?: string }).code = 'TURN_ABORTED';
  must(held.pending[0], 'slot').reject(aborted);
  await flush();

  assert.equal(task.state(), 'cancelled');
  assert.equal(reports.length, 0);
  assert.equal(events.some((event) => event.type === 'failed'), false);
  const cancelled = must(events.find((event) => event.type === 'cancelled'), 'cancel event');
  assert.equal(cancelled.type, 'cancelled');
  if (cancelled.type !== 'cancelled') return;
  assert.equal(cancelled.taskId, task.taskId);
  assert.equal(cancelled.reason, 'host_aborted');
  assert.equal(cancelled.turnNo, 5);

  const again = bus.dispatch({ query: '再来一次', source: 'tool_call', turnNo: 5 });
  assert.equal(again.deduplicated, false);
  assert.notEqual(again.taskId, task.taskId);
  await flush();
  assert.equal(again.state(), 'running');
  must(held.pending[1], 'again slot').resolve({ text: '这次好了' });
  await flush();
  assert.equal(again.state(), 'completed');
  assert.deepEqual(reports.map((report) => report.summary), ['这次好了']);
});

test('utterancePcm 透传 execute，early_rule 升级 tool_call 时保留', async () => {
  const held = holdRunner();
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: () => {},
  });
  const pcm = Buffer.from([1, 2, 3, 4]);
  const upgradedPcm = Buffer.from([5, 6, 7, 8]);

  const early = bus.dispatch({
    query: '原话',
    source: 'early_rule',
    turnNo: 2,
    utterancePcm: pcm,
  });
  const tool = bus.dispatch({
    query: '听见的完整问题',
    source: 'tool_call',
    turnNo: 2,
    utterancePcm: upgradedPcm,
  });
  assert.equal(tool.deduplicated, true);
  assert.equal(tool.taskId, early.taskId);
  await flush();
  const upgraded = must(held.calls[0], 'upgraded call');
  assert.equal(upgraded.query, '听见的完整问题');
  assert.equal(upgraded.utterancePcm, upgradedPcm);
  must(held.pending[0], 'slot').resolve({ text: '好' });
  await flush();
  assert.equal(early.state(), 'completed');

  const later = bus.dispatch({
    query: '开跑之后不改',
    source: 'tool_call',
    turnNo: 2,
    utterancePcm: pcm,
  });
  assert.equal(later.deduplicated, true);
  await flush();
  assert.equal(held.calls.length, 1);

  const plain = bus.dispatch({ query: '没给人声', source: 'image' });
  await flush();
  const plainCall = must(held.calls[1], 'plain call');
  assert.equal(plainCall.taskId, plain.taskId);
  assert.equal(Object.hasOwn(plainCall, 'utterancePcm'), false);
  must(held.pending[1], 'plain slot').resolve({ text: '好' });
  await flush();
  assert.equal(plain.state(), 'completed');
});

// ---------------------------------------------------------------- 异步移交（asyncDispatched）

test('asyncDispatched 立刻放开工人循环，后一条不等前一条，前一条仍算 running', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });

  const first = bus.dispatch({ query: '多步任务一', source: 'tool_call', turnNo: 1 });
  const second = bus.dispatch({ query: '单步任务二', source: 'early_rule', turnNo: 2 });

  await flush();
  assert.equal(held.calls.length, 1);
  assert.equal(first.state(), 'running');
  assert.equal(second.state(), 'queued');

  // 第一条只回「已派出去」，工人循环必须马上取第二条
  must(held.pending[0], 'first async slot').resolve({ text: '', asyncDispatched: true });
  await flush();

  assert.equal(first.state(), 'running', '异步移交后任务仍要留在 running，等回调结算');
  assert.equal(second.state(), 'running', '第二条不得被第一条的异步任务堵住');
  assert.equal(held.calls.length, 2);
  assert.equal(reports.length, 0, '异步移交不是完成，不能提前发汇报');
  assert.equal(bus.hasActiveReportable(), true);
  assert.ok(bus.activeCount() >= 1);

  // 第二条正常完成，第一条仍在等回调
  must(held.pending[1], 'second slot').resolve({ text: '单步好了' });
  await flush();
  assert.equal(second.state(), 'completed');
  assert.equal(first.state(), 'running');
  assert.equal(reports.length, 1);
  assert.equal(must(reports[0], 'second report').taskId, second.taskId);
  assert.equal(bus.hasActiveReportable(), true);
});

test('异步回调结算 asyncPending：沿用 taskId/turnNo/query/原意与全文 verbatim', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const events: BackgroundTaskLifecycleEvent[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
    onLifecycle: (event) => { events.push(event); },
  });

  const task = bus.dispatch({ query: '查一下端口', source: 'tool_call', turnNo: 3 });
  await flush();
  must(held.pending[0], 'async slot').resolve({ text: '', asyncDispatched: true });
  await flush();
  assert.equal(task.state(), 'running');
  events.length = 0;

  bus.ingestExternalAnnouncement('[原意: 查一下端口]\n[VERBATIM][开心]端口 8766', undefined, '查一下端口');

  assert.equal(task.state(), 'completed');
  assert.equal(bus.hasActiveReportable(), false);
  assert.equal(bus.activeCount(), 0);
  assert.equal(reports.length, 1, '回调只发一次，不额外造 dsh_background');
  const report = must(reports[0], 'report');
  assert.equal(report.taskId, task.taskId, '沿用原 taskId，不能让快照里的任务对不上');
  assert.equal(report.taskId.startsWith('bg-'), true);
  assert.equal(report.turnNo, 3);
  assert.equal(report.query, '查一下端口');
  assert.equal(report.canonicalUser, '查一下端口');
  assert.equal(report.summary, '端口 8766');
  assert.equal(report.verbatim, '端口 8766');
  assert.equal(report.source, 'tool_call');

  const completed = must(events.find((event) => event.type === 'completed'), 'completed event');
  assert.equal(completed.type, 'completed');
  if (completed.type !== 'completed') return;
  assert.equal(completed.taskId, task.taskId);
  assert.equal(completed.turnNo, 3);
  assert.equal(completed.query, '查一下端口');
  assert.equal(completed.report, report);
});

test('ingestExternalAnnouncement 忽略 [ASYNC] / 【ASYNC】，不结算也不播报', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  const task = bus.dispatch({ query: '等回调', source: 'tool_call', turnNo: 1 });
  await flush();
  must(held.pending[0], 'async slot').resolve({ text: '', asyncDispatched: true });
  await flush();

  bus.ingestExternalAnnouncement('[ASYNC]');
  bus.ingestExternalAnnouncement('【ASYNC】');
  bus.ingestExternalAnnouncement('[开心][ASYNC]');

  assert.equal(reports.length, 0);
  assert.equal(task.state(), 'running');
  assert.equal(bus.hasActiveReportable(), true);
});

test('只剩 asyncPending 时 cancelAll 仍取消任务并回传 cancelRunning', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const events: BackgroundTaskLifecycleEvent[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
    onLifecycle: (event) => { events.push(event); },
  });
  const task = bus.dispatch({ query: '等回调', source: 'tool_call', turnNo: 4 });
  await flush();
  must(held.pending[0], 'async slot').resolve({ text: '', asyncDispatched: true });
  await flush();
  assert.equal(bus.hasActiveReportable(), true);
  assert.equal(bus.activeCount(), 1);

  assert.equal(bus.cancelAll('user_cancel'), true);
  assert.equal(task.state(), 'cancelled');
  assert.deepEqual(held.cancels, ['user_cancel'], '异步任务也必须通知底层取消');
  assert.equal(bus.hasActiveReportable(), false);
  assert.equal(bus.activeCount(), 0);
  assert.equal(reports.length, 0, '取消不播假失败');
  assert.equal(bus.cancelAll(), false, '再取消一次没有活可停');

  const cancelled = must(events.find((event) => event.type === 'cancelled'), 'cancel event');
  assert.equal(cancelled.type, 'cancelled');
  if (cancelled.type !== 'cancelled') return;
  assert.equal(cancelled.taskId, task.taskId);
  assert.equal(cancelled.reason, 'user_cancel');
});

test('多个 asyncPending 按查询重合度对号结算，完全不重合时 FIFO', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  const a = bus.dispatch({ query: '查一下明天北京天气', source: 'tool_call', turnNo: 1 });
  const b = bus.dispatch({ query: '查一下英伟达股价', source: 'tool_call', turnNo: 2 });
  const c = bus.dispatch({ query: '帮我订一杯咖啡', source: 'tool_call', turnNo: 3 });

  await flush();
  must(held.pending[0], 'a slot').resolve({ text: '', asyncDispatched: true });
  await flush();
  must(held.pending[1], 'b slot').resolve({ text: '', asyncDispatched: true });
  await flush();
  must(held.pending[2], 'c slot').resolve({ text: '', asyncDispatched: true });
  await flush();
  assert.equal(a.state(), 'running');
  assert.equal(b.state(), 'running');
  assert.equal(c.state(), 'running');
  assert.equal(bus.activeCount(), 3);

  // 股价先回来：只能结算 b，不能误伤最早的 a
  bus.ingestExternalAnnouncement('涨了三个点', undefined, '英伟达股价');
  assert.equal(b.state(), 'completed');
  assert.equal(a.state(), 'running');
  assert.equal(c.state(), 'running');
  assert.equal(must(reports[0], 'b report').taskId, b.taskId);
  assert.equal(must(reports[0], 'b report').query, '查一下英伟达股价');

  // 完全不带 query 的回调没有重合 → FIFO 取最早还在等的 a
  bus.ingestExternalAnnouncement('晴，二十度');
  assert.equal(a.state(), 'completed');
  assert.equal(c.state(), 'running');
  assert.equal(must(reports[1], 'a report').taskId, a.taskId);

  bus.ingestExternalAnnouncement('下好单了', undefined, '咖啡');
  assert.equal(c.state(), 'completed');
  assert.equal(must(reports[2], 'c report').taskId, c.taskId);
  assert.deepEqual(reports.map((report) => report.taskId), [b.taskId, a.taskId, c.taskId]);
});

test('同一 asyncTargetId 的多条任务一次回调全部结算，只播报合并后的一条', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const events: BackgroundTaskLifecycleEvent[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
    onLifecycle: (event) => { events.push(event); },
  });
  const first = bus.dispatch({ query: '卷一', source: 'tool_call', turnNo: 1 });
  const second = bus.dispatch({ query: '卷二', source: 'tool_call', turnNo: 2 });
  const third = bus.dispatch({ query: '卷三', source: 'tool_call', turnNo: 3 });

  for (let i = 0; i < 3; i += 1) {
    await flush();
    must(held.pending[i], `async slot ${i}`).resolve({
      text: '',
      asyncDispatched: true,
      asyncTargetId: 'sub-1',
    });
  }
  await flush();
  assert.equal(first.state(), 'running');
  assert.equal(second.state(), 'running');
  assert.equal(third.state(), 'running');
  assert.equal(bus.activeCount(), 3);
  events.length = 0;

  bus.ingestExternalAnnouncement('三卷都读完了', undefined, '卷一', 'sub-1');

  assert.equal(first.state(), 'completed');
  assert.equal(second.state(), 'completed');
  assert.equal(third.state(), 'completed');
  assert.equal(bus.hasActiveReportable(), false, '同目标的兄弟任务不得残留 running');
  assert.equal(bus.activeCount(), 0);
  assert.equal(reports.length, 1, '一次回调只播报一次');
  const report = must(reports[0], 'merged report');
  assert.equal(report.taskId, first.taskId);
  assert.equal(report.query, '卷一；卷二；卷三');
  assert.equal(report.summary, '三卷都读完了');

  const completed = events.filter(
    (event): event is Extract<BackgroundTaskLifecycleEvent, { type: 'completed' }> =>
      event.type === 'completed',
  );
  assert.equal(completed.length, 3, '三条任务都要发 completed 生命周期');
  const withReport = completed.filter((event) => event.report !== undefined);
  assert.equal(withReport.length, 1, '只有 primary 带 report');
  assert.equal(must(withReport[0], 'primary completed').taskId, first.taskId);
  assert.equal(must(withReport[0], 'primary completed').query, '卷一；卷二；卷三');
});

test('按 targetId 精准结算：乱序回调只结对应任务，未知 target 不误吞已绑定的任务', async () => {
  const held = holdRunner();
  const reports: BackgroundTaskReport[] = [];
  const bus = new BackgroundTaskBus({
    runner: held.runner,
    onReport: (report) => { reports.push(report); },
  });
  const subAgent = bus.dispatch({ query: '查子代理 A', source: 'tool_call', turnNo: 1 });
  const job = bus.dispatch({ query: '跑后台 job B', source: 'tool_call', turnNo: 2 });

  await flush();
  must(held.pending[0], 'sub-A slot').resolve({
    text: '',
    asyncDispatched: true,
    asyncTargetId: 'sub-A',
  });
  await flush();
  must(held.pending[1], 'job-B slot').resolve({
    text: '',
    asyncDispatched: true,
    asyncTargetId: 'job-B',
  });
  await flush();
  assert.equal(bus.activeCount(), 2);

  // 后派出的 job-B 先回来：只结 job-B，不碰更早的 sub-A。
  bus.ingestExternalAnnouncement('B 跑完了', undefined, '跑后台 job B', 'job-B');
  assert.equal(job.state(), 'completed');
  assert.equal(subAgent.state(), 'running');
  assert.equal(must(reports[0], 'job-B report').taskId, job.taskId);

  // 未知 target 不得把任何一个已绑定的在跑任务算完成。
  bus.ingestExternalAnnouncement('未知来源的公告', undefined, undefined, 'sub-UNKNOWN');
  assert.equal(subAgent.state(), 'running', '未知 target 绝不误吞已绑定任务');
  assert.equal(bus.activeCount(), 1);
  assert.equal(reports.length, 2);
  assert.equal(must(reports[1], 'external report').source, 'dsh_background');

  bus.ingestExternalAnnouncement('A 也跑完了', undefined, '查子代理 A', 'sub-A');
  assert.equal(subAgent.state(), 'completed');
  assert.equal(bus.activeCount(), 0);
  assert.equal(must(reports[2], 'sub-A report').taskId, subAgent.taskId);
});
