/**
 * Pure Live 数据面：同一串事件必须归约出同一份状态和同一批意图。
 * 这里不打时钟、不开连接，只喂事实。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
    '- 任务 bg-air | 轮次 4 | 查询：把空调调到26度 | 状态=completed（已核实，尚未播报给哥） | 结论：空调已经调到26度',
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
  assert.doesNotMatch(sync.snapshot, /AB1234/);
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

test('快照不超过 800 字，文本没变不重复同步', () => {
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
  assert.ok(snapshot.length <= 800);
  assert.ok([...snapshot].length <= 800);
  assert.equal([...snapshot].length, 800);
  assert.ok(snapshot.startsWith(SNAPSHOT_TITLE));
  assert.match(snapshot, /bulk-0/);
  assert.match(snapshot, /标记0号/);
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
  assert.ok(snapshot.indexOf('仍在排队') < snapshot.indexOf('结论2'));
  assert.ok(snapshot.indexOf('结论2') < snapshot.indexOf('结论5'));
  assert.equal(listUnspokenReports(state).length, 6);
});
