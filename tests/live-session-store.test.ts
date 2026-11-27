/**
 * Pure Live 数据面：同一串事件必须归约出同一份状态和同一批意图。
 * 这里不打时钟、不开连接，只喂事实。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  foregroundCoveredReport,
  hasVerifiedContextFor,
  initialLiveSessionState,
  listUnspokenReports,
  projectDshRecentDialog,
  projectLastAnsweredLane,
  projectOmniSnapshot,
  reduceLiveSession,
  type LiveSessionEvent,
  type LiveSessionState,
  type LiveTaskRecord,
} from '../src/pipelines/live-session-store.ts';
import type { BackgroundTaskReport } from '../src/providers.ts';

const SNAPSHOT_TITLE = '【当前后台任务与已核实事实（唯一真相源：未标注 completed 的一律视为尚未执行，禁止声称已办成）】';
const DIALOG_TITLE = '【最近前台对话（仅供理解代词与指代，不要重复回答）】';
const ACCEPTED_NOTE = '已交后台执行，尚未完成。在【当前后台任务与已核实事实】出现 completed 前，禁止声称已执行或编造结果。';

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** 冻住上一份状态再推进一步，归约器只要改到入参就会当场抛。 */
function step(state: LiveSessionState, event: LiveSessionEvent): {
  readonly state: LiveSessionState;
  readonly effects: readonly ReturnType<typeof reduceLiveSession>['effects'][number][];
} {
  deepFreeze(state);
  const next = reduceLiveSession(state, event);
  assert.equal(projectOmniSnapshot(next.state), next.state.lastSnapshot);
  const syncs = next.effects.filter((effect) => effect.type === 'sync_omni_snapshot');
  assert.equal(syncs.length <= 1, true);
  assert.equal(syncs.length === 1, next.state.lastSnapshot !== state.lastSnapshot);
  const sync = syncs[0];
  if (sync !== undefined && sync.type === 'sync_omni_snapshot') {
    assert.equal(sync.snapshot, next.state.lastSnapshot);
  }
  return next;
}

function taskOf(state: LiveSessionState, taskId: string): LiveTaskRecord {
  const task = state.tasks[taskId];
  assert.ok(task !== undefined, taskId);
  return task;
}

test('纯闲聊快照为空串', () => {
  const initial = initialLiveSessionState();
  assert.equal(projectOmniSnapshot(initial), '');
  assert.equal(projectOmniSnapshot(initial, 0), '');
  assert.equal(projectDshRecentDialog(initial), '');
  assert.equal(projectLastAnsweredLane(initial), null);
  assert.deepEqual(listUnspokenReports(initial), []);

  const chat = step(initial, {
    type: 'turn.recorded',
    turnNo: 1,
    rawAsr: '今天天气真好',
    lane: 'live',
    assistantSpoken: '是啊，出去走走吧。',
    endedAtMs: 1200,
  });
  assert.equal(projectOmniSnapshot(chat.state), '');
  assert.equal(chat.state.lastSnapshot, '');
  assert.deepEqual(chat.effects, []);
  assert.equal(projectLastAnsweredLane(chat.state), 'live');
  assert.equal(
    projectDshRecentDialog(chat.state),
    `${DIALOG_TITLE}\n用户：今天天气真好\n米馍：是啊，出去走走吧。`,
  );

  const dsh = step(chat.state, {
    type: 'turn.recorded',
    turnNo: 2,
    rawAsr: '帮我记一下',
    lane: 'dsh',
    assistantSpoken: '记下了。',
    endedAtMs: 1800,
  });
  assert.equal(dsh.state.lastSnapshot, '');
  assert.deepEqual(dsh.effects, []);
  assert.equal(projectLastAnsweredLane(dsh.state), 'dsh');

  const filler = step(dsh.state, {
    type: 'turn.recorded',
    turnNo: 3,
    rawAsr: '嗯',
    lane: 'live',
    assistantSpoken: '   ',
    endedAtMs: 1900,
  });
  assert.equal(projectLastAnsweredLane(filler.state), 'dsh');
  assert.equal(filler.state.lastSnapshot, '');
});

test('turn.delegated 产出工具回执和单槽快照', () => {
  const initial = initialLiveSessionState();
  const event: LiveSessionEvent = {
    type: 'turn.delegated',
    turnNo: 7,
    rawAsr: '帮我订明天的票',
    query: '订明天去上海的火车票',
    taskId: 'bg-7',
    toolCallId: 'call_abc',
    omniUserItemId: 'user-7',
    omniAssistantItemIds: ['asst-7'],
    nowMs: 50,
  };
  const expected = [
    SNAPSHOT_TITLE,
    '- 任务 bg-7 | 轮次 7 | 查询：订明天去上海的火车票 | 状态=queued（未执行完）',
  ].join('\n');

  const first = step(initial, event);
  const replay = reduceLiveSession(initial, event);
  assert.deepEqual(replay, first);

  assert.equal(first.effects.length, 2);
  const tool = first.effects[0];
  assert.ok(tool !== undefined && tool.type === 'send_tool_output');
  assert.equal(tool.callId, 'call_abc');
  assert.match(tool.output, /accepted_running/);
  assert.match(tool.output, /"executed":false/);
  assert.deepEqual(JSON.parse(tool.output), {
    taskId: 'bg-7',
    status: 'accepted_running',
    executed: false,
    note: ACCEPTED_NOTE,
  });
  const sync = first.effects[1];
  assert.ok(sync !== undefined && sync.type === 'sync_omni_snapshot');
  assert.equal(sync.snapshot, expected);
  assert.equal(first.state.lastSnapshot, expected);
  assert.equal(first.state.lastSnapshot.split('\n').length, 2);

  const task = taskOf(first.state, 'bg-7');
  assert.equal(task.state, 'queued');
  assert.equal(task.executed, false);
  assert.equal(task.delivered, 'pending');
  assert.equal(task.source, 'tool_call');
  assert.equal(task.epoch, 0);
  assert.equal(task.query, '订明天去上海的火车票');
  assert.equal(first.state.turns.length, 1);
  assert.equal(first.state.turns[0]?.omniUserItemId, 'user-7');
  assert.deepEqual(first.state.turns[0]?.omniAssistantItemIds, ['asst-7']);

  const bare = step(initial, {
    type: 'turn.delegated',
    turnNo: 8,
    rawAsr: '帮我看一眼',
    query: '看看门口',
    taskId: 'bg-8',
    toolCallId: '',
  });
  assert.deepEqual(bare.effects.map((effect) => effect.type), ['sync_omni_snapshot']);
});

test('turn.early_guarded 删掉未核实的助手项并标明未执行完', () => {
  const ids = ['item-a', 'item-b'];
  const recorded = step(initialLiveSessionState(), {
    type: 'turn.recorded',
    turnNo: 3,
    rawAsr: '空调 26 度',
    lane: 'live',
    assistantSpoken: '已经调好了',
    endedAtMs: 10,
    omniUserItemId: 'user-3',
    omniAssistantItemIds: ids,
  });
  assert.equal(recorded.state.lastSnapshot, '');
  assert.notEqual(recorded.state.turns[0]?.omniAssistantItemIds, ids);

  const guarded = step(recorded.state, {
    type: 'turn.early_guarded',
    turnNo: 3,
    rawAsr: '空调 26 度',
    query: '把空调调到26度',
    taskId: 'bg-ac',
    omniAssistantItemIds: ['item-b', '', 'item-c'],
  });
  assert.deepEqual(guarded.effects.map((effect) => effect.type), ['delete_omni_items', 'sync_omni_snapshot']);
  const deleted = guarded.effects[0];
  assert.ok(deleted !== undefined && deleted.type === 'delete_omni_items');
  assert.deepEqual(deleted.itemIds, ['item-a', 'item-b', 'item-c']);

  const expected = [
    SNAPSHOT_TITLE,
    '- 任务 bg-ac | 轮次 3 | 查询：把空调调到26度 | 状态=queued（未执行完，此前口头回复未经执行核实）',
  ].join('\n');
  assert.equal(guarded.state.lastSnapshot, expected);
  assert.doesNotMatch(guarded.state.lastSnapshot, /已经调好了/);
  assert.match(projectDshRecentDialog(guarded.state), /已经调好了/);

  const task = taskOf(guarded.state, 'bg-ac');
  assert.equal(task.source, 'early_rule');
  assert.equal(task.state, 'queued');
  assert.equal(task.executed, false);
  assert.equal(task.delivered, 'pending');
  assert.equal(task.unverifiedReplyCleared, true);
  assert.equal(guarded.state.turns.length, 1);
  assert.deepEqual(guarded.state.turns[0]?.omniAssistantItemIds, []);
  assert.equal(guarded.state.turns[0]?.omniUserItemId, 'user-3');
  assert.equal(guarded.state.turns[0]?.assistantSpoken, '已经调好了');

  const repeated = step(guarded.state, {
    type: 'turn.early_guarded',
    turnNo: 3,
    rawAsr: '空调 26 度',
    query: '把空调调到26度',
    taskId: 'bg-ac',
    omniAssistantItemIds: ['item-a', 'item-b', 'item-c'],
  });
  assert.equal(repeated.state, guarded.state);
  assert.deepEqual(repeated.effects, []);
});

test('task.completed 的核实说法写回同一轮并立刻进入前台对话', () => {
  const delegated = step(initialLiveSessionState(), {
    type: 'turn.delegated',
    turnNo: 4,
    rawAsr: '空调二十六',
    query: '把空调调到26度',
    taskId: 'bg-air',
    toolCallId: 'call_air',
  });
  const recorded = step(delegated.state, {
    type: 'turn.recorded',
    turnNo: 4,
    rawAsr: '空调二十六',
    lane: 'live',
    assistantSpoken: '好，我看看。',
    endedAtMs: 2200,
  });
  assert.equal(recorded.state.turns.length, 1);
  assert.equal(recorded.state.turns[0]?.taskId, 'bg-air');
  assert.equal(recorded.state.turns[0]?.toolCallId, 'call_air');
  assert.deepEqual(recorded.effects, []);
  assert.equal(recorded.state.lastSnapshot, delegated.state.lastSnapshot);

  const report: BackgroundTaskReport = {
    taskId: 'bg-air',
    source: 'tool_call',
    query: '把空调调到26度',
    summary: '空调已经调到26度',
    verbatim: '订单 AB1234',
    emotion: 'calm',
  };
  const done = step(recorded.state, {
    type: 'task.completed',
    report,
    turnNo: 4,
    canonicalUser: '  把空调调到26度  ',
  });

  const expected = [
    SNAPSHOT_TITLE,
    '- 任务 bg-air | 轮次 4 | 查询：把空调调到26度 | 状态=completed（已核实，尚未播报给哥） | 结论：订单 AB1234',
    '- 已核实说法：第4轮「空调二十六」→「把空调调到26度」',
  ].join('\n');
  assert.deepEqual(done.effects.map((effect) => effect.type), [
    'emit_ui_asr_replace',
    'sync_omni_snapshot',
    'deliver_report',
  ]);
  const replace = done.effects[0];
  assert.ok(replace !== undefined && replace.type === 'emit_ui_asr_replace');
  assert.deepEqual(replace, {
    type: 'emit_ui_asr_replace',
    text: '把空调调到26度',
    previous: '空调二十六',
  });
  const sync = done.effects[1];
  assert.ok(sync !== undefined && sync.type === 'sync_omni_snapshot');
  assert.equal(sync.snapshot, expected);
  assert.match(sync.snapshot, /AB1234/, '逐字稿里的字面量必须进单槽，Omni 才念得准');
  const delivered = done.effects[2];
  assert.ok(delivered !== undefined && delivered.type === 'deliver_report');
  assert.equal(delivered.report, report);
  assert.equal(delivered.previousUserText, '空调二十六');
  assert.equal(delivered.canonicalUser, '把空调调到26度');
  assert.equal(delivered.turnNo, 4);

  assert.equal(done.state.turns.length, 1);
  assert.equal(done.state.turns[0]?.canonicalUser, '把空调调到26度');
  assert.equal(done.state.turns[0]?.rawAsr, '空调二十六');
  const task = taskOf(done.state, 'bg-air');
  assert.equal(task.state, 'completed');
  assert.equal(task.executed, true);
  assert.equal(task.canonicalUser, '把空调调到26度');
  assert.equal(task.summary, '空调已经调到26度');
  assert.equal(task.verbatim, '订单 AB1234');
  assert.equal(task.emotion, 'calm');
  assert.equal(task.delivered, 'pending');
  assert.deepEqual(listUnspokenReports(done.state).map((item) => item.taskId), ['bg-air']);
  assert.equal(
    projectDshRecentDialog(done.state),
    `${DIALOG_TITLE}\n用户：把空调调到26度\n米馍：好，我看看。`,
  );
  assert.doesNotMatch(projectDshRecentDialog(done.state), /空调二十六/);

  const rerecorded = step(done.state, {
    type: 'turn.recorded',
    turnNo: 4,
    rawAsr: '空调二十六',
    lane: 'live',
    assistantSpoken: '好，调好了再告诉你。',
    endedAtMs: 2300,
  });
  assert.equal(rerecorded.state.turns.length, 1);
  assert.equal(rerecorded.state.turns[0]?.canonicalUser, '把空调调到26度');
  assert.equal(rerecorded.state.turns[0]?.taskId, 'bg-air');
  assert.equal(rerecorded.state.turns[0]?.toolCallId, 'call_air');
  assert.equal(rerecorded.state.turns[0]?.assistantSpoken, '好，调好了再告诉你。');
  assert.deepEqual(rerecorded.effects, []);
  assert.match(projectDshRecentDialog(rerecorded.state), /用户：把空调调到26度/);
  assert.match(projectDshRecentDialog(rerecorded.state), /米馍：好，调好了再告诉你。/);

  const spoken = step(rerecorded.state, {
    type: 'announce.settled',
    taskId: 'bg-air',
    outcome: 'spoken',
  });
  assert.equal(taskOf(spoken.state, 'bg-air').delivered, 'spoken');
  assert.match(spoken.state.lastSnapshot, /已口头告知哥/);
  assert.doesNotMatch(spoken.state.lastSnapshot, /尚未播报给哥/);
  assert.deepEqual(listUnspokenReports(spoken.state), []);

  const regress = step(spoken.state, {
    type: 'task.lifecycle',
    taskId: 'bg-air',
    status: 'queued',
    query: '把空调再调一次',
  });
  assert.equal(regress.state, spoken.state);
  assert.equal(taskOf(regress.state, 'bg-air').state, 'completed');

  const lateFail = step(regress.state, {
    type: 'task.failed',
    report: { ...report, summary: '不该覆盖' },
  });
  assert.equal(lateFail.state, spoken.state);

  const lateDelegate = step(lateFail.state, {
    type: 'turn.delegated',
    turnNo: 4,
    rawAsr: '空调二十六',
    query: '把空调再调一次',
    taskId: 'bg-air',
    toolCallId: 'call_late',
  });
  assert.equal(lateDelegate.state, spoken.state);
  assert.equal(taskOf(lateDelegate.state, 'bg-air').state, 'completed');
  assert.equal(taskOf(lateDelegate.state, 'bg-air').toolCallId, 'call_air');
  assert.deepEqual(lateDelegate.effects.map((effect) => effect.type), ['send_tool_output']);
  const lateTool = lateDelegate.effects[0];
  assert.ok(lateTool !== undefined && lateTool.type === 'send_tool_output');
  assert.equal(lateTool.callId, 'call_late');
  assert.match(lateTool.output, /accepted_running/);
});

test('task.cancelled_all 之后迟到的 task.completed 被忽略', () => {
  const memory = step(initialLiveSessionState(), {
    type: 'task.lifecycle',
    taskId: 'mem-keep',
    status: 'queued',
    source: 'memory_silent',
    query: '记住哥怕热',
  });
  const queued = step(memory.state, {
    type: 'task.lifecycle',
    taskId: 'weather',
    status: 'queued',
    source: 'tool_call',
    query: '查天气',
    turnNo: 1,
  });
  assert.match(queued.state.lastSnapshot, /查天气/);
  assert.doesNotMatch(queued.state.lastSnapshot, /记住哥怕热/);

  const running = step(queued.state, {
    type: 'task.lifecycle',
    taskId: 'weather',
    status: 'running',
    turnNo: 1,
  });
  assert.match(running.state.lastSnapshot, /状态=running（未执行完）/);

  const cancelled = step(running.state, { type: 'task.cancelled_all' });
  const weather = taskOf(cancelled.state, 'weather');
  assert.equal(weather.state, 'cancelled');
  assert.equal(weather.executed, false);
  assert.equal(weather.delivered, 'dropped');
  assert.equal(weather.summary, undefined);
  const kept = taskOf(cancelled.state, 'mem-keep');
  assert.equal(kept.state, 'queued');
  assert.equal(kept.delivered, 'silent');
  assert.match(cancelled.state.lastSnapshot, /状态=cancelled（哥已取消，未执行完）/);
  assert.doesNotMatch(cancelled.state.lastSnapshot, /记住哥怕热/);

  const late = step(cancelled.state, {
    type: 'task.completed',
    report: {
      taskId: 'weather',
      source: 'tool_call',
      query: '查天气',
      summary: '晴天',
    },
    turnNo: 1,
    canonicalUser: '今天天气怎么样',
  });
  assert.equal(late.state, cancelled.state);
  assert.deepEqual(late.effects, []);
  assert.equal(taskOf(late.state, 'weather').state, 'cancelled');
  assert.equal(taskOf(late.state, 'weather').executed, false);
  assert.equal(taskOf(late.state, 'weather').summary, undefined);
  assert.equal(taskOf(late.state, 'mem-keep').state, 'queued');
});

test('turn.reconciled 只按票据 no/gen 改一条', () => {
  let state = initialLiveSessionState();
  const rows: readonly LiveSessionEvent[] = [
    {
      type: 'turn.recorded',
      turnNo: 1,
      rawAsr: '你好',
      lane: 'live',
      assistantSpoken: '在的',
      endedAtMs: 100,
      ticket: { no: 1, gen: 0 },
    },
    {
      type: 'turn.recorded',
      turnNo: 2,
      rawAsr: '讲个笑话',
      lane: 'live',
      assistantSpoken: '从前有座山',
      endedAtMs: 200,
      ticket: { no: 2, gen: 0 },
    },
    {
      type: 'turn.recorded',
      turnNo: 3,
      rawAsr: '继续',
      lane: 'dsh',
      assistantSpoken: '还没讲完',
      endedAtMs: 300,
      ticket: { no: 2, gen: 1 },
    },
  ];
  for (const event of rows) state = step(state, event).state;

  const hit = step(state, {
    type: 'turn.reconciled',
    ticket: { no: 2, gen: 0 },
    truncated: true,
    endedAtMs: 4242,
  });
  assert.equal(hit.state.turns[0]?.truncated, false);
  assert.equal(hit.state.turns[0]?.endedAtMs, 100);
  assert.equal(hit.state.turns[1]?.truncated, true);
  assert.equal(hit.state.turns[1]?.endedAtMs, 4242);
  assert.deepEqual(hit.state.turns[1]?.ticket, { no: 2, gen: 0 });
  assert.equal(hit.state.turns[2]?.truncated, false);
  assert.equal(hit.state.turns[2]?.endedAtMs, 300);
  assert.deepEqual(hit.state.turns[2]?.ticket, { no: 2, gen: 1 });
  assert.deepEqual(hit.effects, []);
  assert.equal(
    projectDshRecentDialog(hit.state),
    [
      DIALOG_TITLE,
      '用户：你好',
      '米馍：在的',
      '用户：讲个笑话',
      '米馍：从前有座山（被打断）',
      '用户：继续',
      '米馍：还没讲完',
    ].join('\n'),
  );

  const same = step(hit.state, {
    type: 'turn.reconciled',
    ticket: { no: 2, gen: 0 },
    truncated: true,
    endedAtMs: 4242,
  });
  assert.equal(same.state, hit.state);
  assert.deepEqual(same.effects, []);

  const miss = step(hit.state, {
    type: 'turn.reconciled',
    ticket: { no: 2, gen: 9 },
    truncated: true,
    endedAtMs: 9999,
  });
  assert.equal(miss.state, hit.state);
  assert.deepEqual(miss.effects, []);
});

test('lane.replaced 推进 epoch 并隔离旧连接', () => {
  let state = initialLiveSessionState();
  state = step(state, {
    type: 'turn.recorded',
    turnNo: 5,
    rawAsr: '今天星期几',
    lane: 'live',
    assistantSpoken: '我查一下。',
    endedAtMs: 20,
    omniUserItemId: 'user-5',
    omniAssistantItemIds: ['asst-5a', 'asst-5b'],
  }).state;
  state = step(state, {
    type: 'turn.delegated',
    turnNo: 1,
    rawAsr: '查天气',
    query: '今天天气',
    taskId: 'task-a',
    toolCallId: 'call-a',
    omniUserItemId: 'user-a',
    omniAssistantItemIds: ['asst-a'],
  }).state;
  state = step(state, {
    type: 'turn.delegated',
    turnNo: 2,
    rawAsr: '查日历',
    query: '今天星期几',
    taskId: 'task-b',
    toolCallId: 'call-b',
  }).state;
  state = step(state, {
    type: 'task.completed',
    report: {
      taskId: 'task-b',
      source: 'tool_call',
      query: '今天星期几',
      summary: '星期二',
    },
    turnNo: 2,
  }).state;
  assert.match(state.lastSnapshot, /task-a/);
  assert.match(state.lastSnapshot, /task-b/);
  assert.deepEqual(listUnspokenReports(state).map((task) => task.taskId), ['task-b']);

  const replaced = step(state, { type: 'lane.replaced' });
  assert.equal(replaced.state.epoch, state.epoch + 1);
  assert.equal(replaced.state.epoch, 1);
  assert.ok(replaced.effects.every((effect) => effect.type !== 'delete_omni_items'));
  assert.deepEqual(replaced.effects.map((effect) => effect.type), ['sync_omni_snapshot']);
  const sync = replaced.effects[0];
  assert.ok(sync !== undefined && sync.type === 'sync_omni_snapshot');
  assert.equal(sync.snapshot, '');
  assert.equal(replaced.state.lastSnapshot, '');
  assert.deepEqual(listUnspokenReports(replaced.state), []);
  for (const turn of replaced.state.turns) {
    assert.equal(turn.omniUserItemId, null);
    assert.deepEqual(turn.omniAssistantItemIds, []);
  }
  assert.equal(replaced.state.turns.some((turn) => turn.rawAsr === '今天星期几'), true);
  assert.equal(projectLastAnsweredLane(replaced.state), 'live');

  const taskA = taskOf(replaced.state, 'task-a');
  const taskB = taskOf(replaced.state, 'task-b');
  assert.equal(taskA.epoch, 0);
  assert.equal(taskA.state, 'queued');
  assert.equal(taskA.delivered, 'dropped');
  assert.equal(taskB.epoch, 0);
  assert.equal(taskB.state, 'completed');
  assert.equal(taskB.executed, true);
  assert.equal(taskB.delivered, 'dropped');
  assert.match(projectDshRecentDialog(replaced.state), /查天气/);
  assert.doesNotMatch(projectOmniSnapshot(replaced.state), /今天天气/);

  const late = step(replaced.state, {
    type: 'task.completed',
    report: {
      taskId: 'task-a',
      source: 'tool_call',
      query: '今天天气',
      summary: '今天晴',
    },
    turnNo: 1,
  });
  assert.equal(taskOf(late.state, 'task-a').state, 'completed');
  assert.equal(taskOf(late.state, 'task-a').epoch, 0);
  assert.equal(taskOf(late.state, 'task-a').delivered, 'pending');
  assert.equal(taskOf(late.state, 'task-b').delivered, 'dropped');
  assert.deepEqual(late.effects.map((effect) => effect.type), ['deliver_report']);
  assert.equal(late.state.lastSnapshot, '');
  assert.deepEqual(listUnspokenReports(late.state), []);

  const fresh = step(late.state, {
    type: 'turn.delegated',
    turnNo: 1,
    rawAsr: '来杯咖啡',
    query: '订一杯美式',
    taskId: 'task-c',
    toolCallId: 'call-c',
  });
  assert.equal(taskOf(fresh.state, 'task-c').epoch, 1);
  assert.match(fresh.state.lastSnapshot, /task-c/);
  assert.match(fresh.state.lastSnapshot, /订一杯美式/);
  assert.doesNotMatch(fresh.state.lastSnapshot, /task-a/);
  assert.doesNotMatch(fresh.state.lastSnapshot, /task-b/);
  assert.doesNotMatch(fresh.state.lastSnapshot, /今天晴/);
});

test('memory_silent 不进入 Omni 快照', () => {
  const queued = step(initialLiveSessionState(), {
    type: 'task.lifecycle',
    taskId: 'mem-1',
    status: 'queued',
    source: 'memory_silent',
    query: '记住哥怕热',
  });
  assert.equal(queued.state.lastSnapshot, '');
  assert.deepEqual(queued.effects, []);
  assert.equal(taskOf(queued.state, 'mem-1').delivered, 'silent');
  assert.equal(taskOf(queued.state, 'mem-1').state, 'queued');

  const skipped = step(queued.state, { type: 'task.cancelled_all' });
  assert.equal(skipped.state, queued.state);
  assert.equal(taskOf(skipped.state, 'mem-1').state, 'queued');

  const done = step(skipped.state, {
    type: 'task.completed',
    report: {
      taskId: 'mem-1',
      source: 'memory_silent',
      query: '记住哥怕热',
      summary: '已悄悄记下',
    },
  });
  assert.equal(done.state.lastSnapshot, '');
  assert.equal(projectOmniSnapshot(done.state), '');
  assert.deepEqual(done.effects, []);
  assert.equal(taskOf(done.state, 'mem-1').state, 'completed');
  assert.equal(taskOf(done.state, 'mem-1').executed, true);
  assert.equal(taskOf(done.state, 'mem-1').delivered, 'silent');
  assert.deepEqual(listUnspokenReports(done.state), []);

  const announced = step(done.state, {
    type: 'announce.settled',
    taskId: 'mem-1',
    outcome: 'spoken',
  });
  assert.equal(announced.state, done.state);
  assert.equal(taskOf(announced.state, 'mem-1').delivered, 'silent');

  const visible = step(announced.state, {
    type: 'task.lifecycle',
    taskId: 'visible-1',
    status: 'queued',
    source: 'tool_call',
    query: '把灯打开',
    turnNo: 2,
  });
  assert.match(visible.state.lastSnapshot, /把灯打开/);
  assert.doesNotMatch(visible.state.lastSnapshot, /记住哥怕热/);
  assert.doesNotMatch(visible.state.lastSnapshot, /已悄悄记下/);
});

test('快照不超过 3200 字，文本没变不重复同步', () => {
  const queryOf = (index: number): string => `标记${index}号${'长'.repeat(900)}`;
  let state = initialLiveSessionState();
  for (let index = 0; index < 6; index += 1) {
    state = step(state, {
      type: 'task.lifecycle',
      taskId: `bulk-${index}`,
      status: 'queued',
      source: 'tool_call',
      query: queryOf(index),
    }).state;
  }
  const snapshot = state.lastSnapshot;
  assert.equal(projectOmniSnapshot(state), snapshot);
  assert.ok(snapshot.length <= 3200);
  assert.ok([...snapshot].length <= 3200);
  assert.equal([...snapshot].length, 3200, '预算见底时最后一行裁到刚好用满');
  assert.ok(snapshot.startsWith(SNAPSHOT_TITLE));
  assert.match(snapshot, /bulk-0/);
  assert.match(snapshot, /标记0号/);
  assert.match(snapshot, /bulk-3/);
  assert.match(snapshot, /标记3号/);
  assert.doesNotMatch(snapshot, /bulk-4/);
  assert.doesNotMatch(snapshot, /标记4号/);
  assert.doesNotMatch(snapshot, /bulk-5/);
  assert.doesNotMatch(snapshot, /标记5号/);
  assert.ok([...projectOmniSnapshot(state, 80)].length <= 80);
  assert.equal(projectOmniSnapshot(state, 0), '');

  const again = step(state, {
    type: 'task.lifecycle',
    taskId: 'bulk-0',
    status: 'queued',
    source: 'tool_call',
    query: queryOf(0),
  });
  assert.equal(again.state, state);
  assert.deepEqual(again.effects, []);

  const noted = step(again.state, {
    type: 'turn.recorded',
    turnNo: 1,
    rawAsr: '随便聊聊',
    lane: 'live',
    assistantSpoken: '嗯。',
    endedAtMs: 10,
  });
  assert.equal(noted.state.lastSnapshot, state.lastSnapshot);
  assert.ok(noted.effects.every((effect) => effect.type !== 'sync_omni_snapshot'));
});

test('排队中的查询才能升级，跑起来之后不再倒退', () => {
  const queued = step(initialLiveSessionState(), {
    type: 'task.lifecycle',
    taskId: 'up-1',
    status: 'queued',
    source: 'early_rule',
    query: '粗查询',
    turnNo: 8,
  });
  assert.equal(taskOf(queued.state, 'up-1').source, 'early_rule');

  const upgraded = step(queued.state, {
    type: 'task.lifecycle',
    taskId: 'up-1',
    status: 'upgraded',
    query: '细查询',
  });
  assert.equal(taskOf(upgraded.state, 'up-1').query, '细查询');
  assert.equal(taskOf(upgraded.state, 'up-1').state, 'queued');
  assert.equal(taskOf(upgraded.state, 'up-1').source, 'early_rule');
  assert.match(upgraded.state.lastSnapshot, /细查询/);
  assert.doesNotMatch(upgraded.state.lastSnapshot, /粗查询/);

  const running = step(upgraded.state, {
    type: 'task.lifecycle',
    taskId: 'up-1',
    status: 'running',
  });
  assert.equal(taskOf(running.state, 'up-1').state, 'running');
  assert.equal(taskOf(running.state, 'up-1').query, '细查询');

  const lateUpgrade = step(running.state, {
    type: 'task.lifecycle',
    taskId: 'up-1',
    status: 'upgraded',
    query: '太晚了',
  });
  assert.equal(lateUpgrade.state, running.state);
  assert.equal(taskOf(lateUpgrade.state, 'up-1').query, '细查询');

  const back = step(lateUpgrade.state, {
    type: 'task.lifecycle',
    taskId: 'up-1',
    status: 'queued',
    query: '退回去',
  });
  assert.equal(back.state, running.state);
  assert.equal(taskOf(back.state, 'up-1').state, 'running');
});

test('task.failed 进入未播列表，终态之后不再改写', () => {
  const queued = step(initialLiveSessionState(), {
    type: 'task.lifecycle',
    taskId: 'fail-1',
    status: 'queued',
    source: 'tool_call',
    query: '打开灯',
    turnNo: 6,
  });
  const running = step(queued.state, {
    type: 'task.lifecycle',
    taskId: 'fail-1',
    status: 'running',
    turnNo: 6,
  });
  const report: BackgroundTaskReport = {
    taskId: 'fail-1',
    source: 'tool_call',
    query: '打开灯',
    summary: '灯没打开',
  };
  const failed = step(running.state, { type: 'task.failed', report, turnNo: 6 });
  assert.deepEqual(failed.effects.map((effect) => effect.type), ['sync_omni_snapshot', 'deliver_report']);
  const delivered = failed.effects[1];
  assert.ok(delivered !== undefined && delivered.type === 'deliver_report');
  assert.equal(delivered.report, report);
  assert.equal(delivered.turnNo, 6);
  const task = taskOf(failed.state, 'fail-1');
  assert.equal(task.state, 'failed');
  assert.equal(task.executed, false);
  assert.equal(task.delivered, 'pending');
  assert.equal(task.summary, '灯没打开');
  assert.match(failed.state.lastSnapshot, /状态=failed（未成功，尚未播报给哥）/);
  assert.match(failed.state.lastSnapshot, /说明：灯没打开/);
  assert.deepEqual(listUnspokenReports(failed.state).map((item) => item.taskId), ['fail-1']);

  const interrupted = step(failed.state, {
    type: 'announce.settled',
    taskId: 'fail-1',
    outcome: 'interrupted',
  });
  assert.equal(taskOf(interrupted.state, 'fail-1').delivered, 'interrupted');
  assert.match(interrupted.state.lastSnapshot, /播报被打断/);
  assert.doesNotMatch(interrupted.state.lastSnapshot, /尚未播报给哥/);
  assert.deepEqual(listUnspokenReports(interrupted.state), []);

  const again = step(interrupted.state, { type: 'task.failed', report });
  assert.equal(again.state, interrupted.state);
  const completed = step(again.state, { type: 'task.completed', report });
  assert.equal(completed.state, interrupted.state);
  const cancel = step(completed.state, { type: 'task.cancelled_all' });
  assert.equal(cancel.state, interrupted.state);
});

test('前台轮次只留最近 12 条，终态快照只留最近 4 条', () => {
  let state = initialLiveSessionState();
  for (let turnNo = 1; turnNo <= 13; turnNo += 1) {
    state = step(state, {
      type: 'turn.recorded',
      turnNo,
      rawAsr: `问${turnNo}`,
      lane: turnNo === 13 ? 'dsh' : 'live',
      assistantSpoken: `答${turnNo}`,
      endedAtMs: turnNo,
    }).state;
  }
  assert.equal(state.turns.length, 12);
  assert.equal(state.turns[0]?.turnNo, 2);
  assert.equal(state.turns[11]?.turnNo, 13);
  assert.equal(projectLastAnsweredLane(state), 'dsh');
  const dialog = projectDshRecentDialog(state, 2);
  assert.match(dialog, /用户：问12/);
  assert.match(dialog, /用户：问13/);
  assert.doesNotMatch(dialog, /问11/);
  assert.equal(state.lastSnapshot, '');

  state = step(state, {
    type: 'task.lifecycle',
    taskId: 'still',
    status: 'queued',
    source: 'tool_call',
    query: '仍在排队',
  }).state;
  for (let index = 0; index < 6; index += 1) {
    state = step(state, {
      type: 'task.completed',
      report: {
        taskId: `done-${index}`,
        source: 'dsh_background',
        query: `问${index}`,
        summary: `结论${index}`,
      },
    }).state;
  }
  const snapshot = state.lastSnapshot;
  assert.match(snapshot, /仍在排队/);
  assert.doesNotMatch(snapshot, /结论0/);
  assert.doesNotMatch(snapshot, /结论1/);
  assert.match(snapshot, /结论2/);
  assert.match(snapshot, /结论5/);
  assert.ok(snapshot.indexOf('仍在排队') < snapshot.indexOf('结论5'), '在跑的任务永远排在终态前面');
  assert.ok(snapshot.indexOf('结论5') < snapshot.indexOf('结论2'), '终态最新的排最前');
  assert.equal(listUnspokenReports(state).length, 6);
});

const LONG_REPORT = '北之战是漫画《大剑》的最终战役，克蕾雅与米里雅率领七剑对抗觉醒者与深渊者，揭开组织真相，'
  + '并让所有战士在北方战场上做出各自的抉择。此外还交代了组织内部的派系斗争、战士们的过往与训练细节，'
  + '以及大剑这个名字在民间流传的由来。';

test('前台代播覆盖：近原样、浓缩、短事实都算讲过，敷衍和闲聊不算', () => {
  assert.equal(foregroundCoveredReport(LONG_REPORT, LONG_REPORT), true, '近原样复述');
  assert.equal(
    foregroundCoveredReport('北之战是漫画大剑的最终战役，克蕾雅与米里雅率七剑对抗觉醒者与深渊者。', LONG_REPORT),
    true,
    '长报告浓缩复述：整段 2-gram 几乎都在短侧出现',
  );
  assert.equal(
    foregroundCoveredReport('今天北京多云，最高气温18度，出门记得带伞。', '今天北京多云，最高气温18度。'),
    true,
    '短事实：天气',
  );
  assert.equal(foregroundCoveredReport('好了，客厅灯已经打开了。', '客厅灯已经打开了'), true, '短事实：开灯');
  assert.equal(foregroundCoveredReport('端口是9420，已经打开了。', '端口是9420'), true, '短事实：端口');

  assert.equal(foregroundCoveredReport('还在查，等下。', LONG_REPORT), false, '短回执');
  assert.equal(foregroundCoveredReport('还没呢，正在搜，稍等一下。', LONG_REPORT), false, '进度敷衍');
  assert.equal(
    foregroundCoveredReport('《少女革命》是部很特别的动画，里面的台词和分镜都值得反复看。', LONG_REPORT),
    false,
    '无关闲聊',
  );
  assert.equal(foregroundCoveredReport('好的', '客厅灯已经打开了'), false, '八个字以下一律不算');
  assert.equal(foregroundCoveredReport(LONG_REPORT, ''), false, '空总结');
  assert.equal(foregroundCoveredReport(LONG_REPORT, '。'), false, '只有标点');
});

test('turn.recorded 发现前台已代播时把任务改成 spoken，并刷新单槽', () => {
  let state = initialLiveSessionState();
  state = step(state, {
    type: 'turn.delegated',
    turnNo: 7,
    rawAsr: '搜一下北之战',
    query: '搜一下北之战',
    taskId: 'bg-battle',
    toolCallId: 'call-battle',
  }).state;
  const done = step(state, {
    type: 'task.completed',
    report: {
      taskId: 'bg-battle',
      source: 'tool_call',
      query: '搜一下北之战',
      summary: LONG_REPORT,
    },
    turnNo: 7,
  });
  assert.equal(taskOf(done.state, 'bg-battle').delivered, 'pending');
  assert.match(done.state.lastSnapshot, /尚未播报给哥/);
  assert.deepEqual(listUnspokenReports(done.state).map((task) => task.taskId), ['bg-battle']);

  const covered = step(done.state, {
    type: 'turn.recorded',
    turnNo: 8,
    rawAsr: '搜好没？',
    lane: 'live',
    assistantSpoken: LONG_REPORT,
    endedAtMs: 25_600,
  });
  assert.equal(taskOf(covered.state, 'bg-battle').delivered, 'spoken');
  assert.equal(taskOf(covered.state, 'bg-battle').updatedSeq, covered.state.seq);
  assert.equal(taskOf(covered.state, 'bg-battle').summary, LONG_REPORT);
  assert.match(covered.state.lastSnapshot, /已口头告知哥/);
  assert.doesNotMatch(covered.state.lastSnapshot, /尚未播报给哥/);
  assert.deepEqual(listUnspokenReports(covered.state), []);
  const sync = covered.effects.find((effect) => effect.type === 'sync_omni_snapshot');
  assert.ok(sync !== undefined && sync.type === 'sync_omni_snapshot');
  assert.equal(sync.snapshot, covered.state.lastSnapshot);

  // 同一条 turn 再来一遍：turn 没变、任务也没变，必须早退（不能因为任务判据误跳过上一次）。
  const repeated = step(covered.state, {
    type: 'turn.recorded',
    turnNo: 8,
    rawAsr: '搜好没？',
    lane: 'live',
    assistantSpoken: LONG_REPORT,
    endedAtMs: 25_600,
  });
  assert.equal(repeated.state, covered.state);
  assert.deepEqual(repeated.effects, []);
});

test('前台只答敷衍、闲聊或本轮被打断时，任务保持 pending', () => {
  const withTask = (): LiveSessionState => {
    let state = initialLiveSessionState();
    state = step(state, {
      type: 'turn.delegated',
      turnNo: 3,
      rawAsr: '查一下',
      query: '查一下',
      taskId: 'bg-stay',
    }).state;
    return step(state, {
      type: 'task.completed',
      report: {
        taskId: 'bg-stay',
        source: 'tool_call',
        query: '查一下',
        summary: LONG_REPORT,
      },
      turnNo: 3,
    }).state;
  };

  for (const [spoken, why] of [
    ['还在查，等下。', '短回执'],
    ['《少女革命》是部很特别的动画，里面的台词和分镜都值得反复看。', '无关闲聊'],
  ] as const) {
    const next = step(withTask(), {
      type: 'turn.recorded',
      turnNo: 4,
      rawAsr: '搜好没？',
      lane: 'live',
      assistantSpoken: spoken,
      endedAtMs: 1_000,
    });
    assert.equal(taskOf(next.state, 'bg-stay').delivered, 'pending', why);
    assert.deepEqual(listUnspokenReports(next.state).map((task) => task.taskId), ['bg-stay'], why);
  }

  // 被打断：先记一轮、结算成 truncated，再用同一轮记录完整内容，仍不得算代播。
  let truncated = withTask();
  truncated = step(truncated, {
    type: 'turn.recorded',
    turnNo: 4,
    rawAsr: '搜好没？',
    lane: 'live',
    assistantSpoken: '北之战是漫画',
    endedAtMs: 900,
    ticket: { no: 4, gen: 1 },
  }).state;
  truncated = step(truncated, {
    type: 'turn.reconciled',
    ticket: { no: 4, gen: 1 },
    truncated: true,
    endedAtMs: 1_000,
  }).state;
  const cut = step(truncated, {
    type: 'turn.recorded',
    turnNo: 4,
    rawAsr: '搜好没？',
    lane: 'live',
    assistantSpoken: LONG_REPORT,
    endedAtMs: 1_000,
  });
  assert.equal(cut.state.turns.at(-1)?.truncated, true);
  assert.equal(taskOf(cut.state, 'bg-stay').delivered, 'pending');
  assert.deepEqual(listUnspokenReports(cut.state).map((task) => task.taskId), ['bg-stay']);
});

const NVIDIA_LEAD = '英伟达最近有三件事。第一，第三季度财报显示数据中心收入同比增长百分之九十四，游戏业务环比持平，'
  + '毛利率维持在七成以上，公司还上调了下一季度指引。第二，对华出口管制再次收紧，'
  + '部分高端芯片的交付许可被推迟，公司正在申请新的豁免，并强调会遵守所有适用法规。';
const NVIDIA_FILLER = '补充背景：供应链、产能与回购计划的更多细节以公司公告为准。'.repeat(30);
const NVIDIA_POINT3 = '第三，11月12日黄仁勋辞去CEO职务，11月23日复职；期间由临时管理委员会代行职责，管理层剧变引发市场关注。';
const NVIDIA_SOURCES = '信源：[英伟达投资者关系](https://investor.nvidia.com/earnings) https://example.com/nvidia-news\n'
  + '来源：https://example.com/nvidia-only-source';
const NVIDIA_VERBATIM = `${NVIDIA_LEAD}${NVIDIA_FILLER}${NVIDIA_POINT3}\n${NVIDIA_SOURCES}`;
const NVIDIA_SUMMARY = [...NVIDIA_VERBATIM].slice(0, 160).join('');

function nvidiaCompletedState(): LiveSessionState {
  return step(initialLiveSessionState(), {
    type: 'task.completed',
    report: {
      taskId: 'bg-nv',
      source: 'tool_call',
      query: '查一下英伟达最近的新闻',
      summary: NVIDIA_SUMMARY,
      verbatim: NVIDIA_VERBATIM,
    },
  }).state;
}

test('长报告全文进 Omni 单槽：160 字 summary 之外的第三点也能被追问', () => {
  assert.ok([...NVIDIA_VERBATIM].length > 1_000, '构造的是千字级长报告');
  assert.equal([...NVIDIA_SUMMARY].length, 160);
  assert.equal(NVIDIA_SUMMARY.includes('黄仁勋'), false, 'summary 只覆盖前半段，第三点被截在外面');

  const snapshot = projectOmniSnapshot(nvidiaCompletedState());
  assert.ok([...snapshot].length <= 3200);
  assert.match(snapshot, /11月12日黄仁勋辞去CEO职务/);
  assert.match(snapshot, /11月23日复职/);
  assert.match(snapshot, /管理层剧变/);
  assert.doesNotMatch(snapshot, /https?:\/\//, 'Markdown 与裸链接都要剥掉');
  assert.match(snapshot, /英伟达投资者关系/, '链接文字保留');
  assert.doesNotMatch(snapshot, /来源：/, '剥掉链接后只剩空标签的行整行抹掉');
});

test('多条终态时最新一条保真到 1800 字，旧的压到 260 字，不许挤掉最新', () => {
  let state = initialLiveSessionState();
  const older = [
    { taskId: 'bg-old-a', query: '旧任务甲', body: `${'甲'.repeat(600)}甲尾部` },
    { taskId: 'bg-old-b', query: '旧任务乙', body: `${'乙'.repeat(600)}乙尾部` },
    { taskId: 'bg-old-c', query: '旧任务丙', body: `${'丙'.repeat(600)}丙尾部` },
  ];
  for (const row of older) {
    state = step(state, {
      type: 'task.completed',
      report: {
        taskId: row.taskId,
        source: 'tool_call',
        query: row.query,
        summary: row.body.slice(0, 160),
        verbatim: row.body,
      },
    }).state;
  }
  const latest = `${'新'.repeat(2_000)}最新报告尾部`;
  state = step(state, {
    type: 'task.completed',
    report: {
      taskId: 'bg-new',
      source: 'tool_call',
      query: '最新任务',
      summary: latest.slice(0, 160),
      verbatim: latest,
    },
  }).state;

  const snapshot = projectOmniSnapshot(state);
  assert.ok([...snapshot].length <= 3200);
  assert.match(snapshot, /新{1799}…/u, '最新报告保真到 1800 字再裁');
  assert.doesNotMatch(snapshot, /新{1800}/u);
  assert.doesNotMatch(snapshot, /最新报告尾部/, '超出上限的尾部被裁掉');
  assert.match(snapshot, /甲{259}…/u, '旧报告压到 260 字');
  assert.doesNotMatch(snapshot, /甲{260}/u);
  assert.doesNotMatch(snapshot, /甲尾部/);
  assert.match(snapshot, /乙{259}…/u);
  assert.match(snapshot, /丙{259}…/u);
  assert.ok(snapshot.indexOf('最新任务') < snapshot.indexOf('旧任务丙'));
  assert.ok(snapshot.indexOf('旧任务丙') < snapshot.indexOf('旧任务甲'), '终态最新的排最前');
});

test('hasVerifiedContextFor 认已核实实体事实，拒绝空会话、无关话题与上一代际', () => {
  assert.equal(hasVerifiedContextFor(initialLiveSessionState(), '黄仁勋离职'), false);
  const state = nvidiaCompletedState();
  assert.equal(hasVerifiedContextFor(state, '黄仁勋离职'), true, '同义转述：离职 / 辞去');
  assert.equal(hasVerifiedContextFor(state, '管理层巨变'), true, 'ASR 同音词：巨变 / 剧变');
  assert.equal(hasVerifiedContextFor(state, '英伟达'), true, '原串直接命中');
  assert.equal(hasVerifiedContextFor(state, '班公秘'), false);
  assert.equal(hasVerifiedContextFor(state, ''), false);
  assert.equal(hasVerifiedContextFor(state, '离'), false);

  const replaced = step(state, { type: 'lane.replaced' }).state;
  assert.equal(hasVerifiedContextFor(replaced, '黄仁勋离职'), false, '上一代际的任务不再算数');
});

test('前台口述长报告后半段也算代播，按 verbatim 覆盖而不是只看 160 字 summary', () => {
  let state = step(initialLiveSessionState(), {
    type: 'turn.delegated',
    turnNo: 7,
    rawAsr: '查一下英伟达最近的新闻',
    query: '查一下英伟达最近的新闻',
    taskId: 'bg-nv',
  }).state;
  state = step(state, {
    type: 'task.completed',
    report: {
      taskId: 'bg-nv',
      source: 'tool_call',
      query: '查一下英伟达最近的新闻',
      summary: NVIDIA_SUMMARY,
      verbatim: NVIDIA_VERBATIM,
    },
    turnNo: 7,
  }).state;
  assert.equal(taskOf(state, 'bg-nv').delivered, 'pending');

  const spoken = '第三，11月12日黄仁勋辞去CEO职务，11月23日复职；期间由临时管理委员会代行职责，管理层剧变引发市场关注。';
  assert.equal(foregroundCoveredReport(spoken, NVIDIA_SUMMARY), false, '前半段 summary 覆盖不到第三点');

  const covered = step(state, {
    type: 'turn.recorded',
    turnNo: 8,
    rawAsr: '你刚刚查的管理层巨变是什么东西？',
    lane: 'live',
    assistantSpoken: spoken,
    endedAtMs: 20_000,
  });
  assert.equal(taskOf(covered.state, 'bg-nv').delivered, 'spoken');
  assert.match(covered.state.lastSnapshot, /已口头告知哥/);
  assert.doesNotMatch(covered.state.lastSnapshot, /尚未播报给哥/);
});
