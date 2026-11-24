/**
 * 时序与状态轮转审计器（`src/fsm-trace.ts`）。
 *
 * 这一层是 bench 的主要出口：任务做没做成（reward）先不管，**这条链有没有一处
 * 不符合设计**才是要盯的。所以审计器本身必须可靠 —— 每条规则都要能被一条最小
 * 反例打红，健康档案一条违规都不许误报。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkTrace, parseTrace, type TraceEvent } from '../src/fsm-trace.ts';

type Ev = [number, string, Record<string, unknown>?];

function trace(rows: readonly Ev[]): TraceEvent[] {
  return rows.map(([t, ev, extra]) => ({ t, ev, ...(extra ?? {}) }));
}

/** 一轮健康的四段：停嘴 → 出句 → 开轮 → thinking → 首块 → speaking → 播完 → listening */
function healthyTurn(at: number, opts: { stopGap?: number; noStates?: boolean } = {}): Ev[] {
  const gap = opts.stopGap ?? 600;
  const gateAt = at + 400 + gap;
  const rows: Ev[] = [
    [at, 'asr.partial', { text: '嗯' }],
    [gateAt, 'gate.close', { gapMs: gap }],
    [at + 400, 'asr.sentence', { text: '你好。' }],
    [at + 500, 'turn.start', { text_len: 3 }],
  ];
  if (opts.noStates !== true) {
    rows.push(
      [at + 520, 'dialog.state', { from: 'listening', to: 'thinking' }],
      [at + 1200, 'llm.first', { ms: 700 }],
      [at + 1400, 'tts.first', { ms: 300 }],
      [at + 1400, 'dialog.state', { from: 'thinking', to: 'speaking' }],
      [at + 3400, 'turn.end', { interrupted: false, audio_s: 2 }],
      [at + 3410, 'dialog.state', { from: 'speaking', to: 'listening' }],
    );
  } else {
    rows.push(
      [at + 1200, 'llm.first', { ms: 700 }],
      [at + 1400, 'tts.first', { ms: 300 }],
      [at + 3400, 'turn.end', { interrupted: false, audio_s: 2 }],
    );
  }
  return rows;
}

test('健康的一轮：一条违规都没有', () => {
  const r = checkTrace(trace(healthyTurn(0)));
  assert.deepEqual(r.violations, []);
  assert.equal(r.turns.length, 1);
  assert.equal(r.states, 3);
  assert.equal(r.turns[0]!.turnToFirstMs, 900);
  assert.equal(r.turns[0]!.stopToFirstMs, 1000);
});

test('缺 dialog.state 的老档案：状态规则进 skipped，不误报', () => {
  const r = checkTrace(trace(healthyTurn(0, { noStates: true })));
  assert.deepEqual(r.violations, [], '没仪表不等于有违规');
  assert.ok(r.skipped.includes('state.whitelist'));
  assert.ok(r.skipped.includes('state.audioBeforeSpeaking'));
});

test('轮次嵌套：第二轮开在上一轮里', () => {
  const r = checkTrace(trace([
    ...healthyTurn(0).filter(([t]) => t < 3400),
    [2000, 'turn.start', { text_len: 2 }],
  ]));
  assert.ok(r.violations.some((v) => v.rule === 'turn.nested'), JSON.stringify(r.violations));
});

test('孤立的 turn.end', () => {
  const r = checkTrace(trace([[0, 'turn.end', { interrupted: false }]]));
  assert.ok(r.violations.some((v) => v.rule === 'turn.orphanEnd'));
});

test('开了没有结束、也没有断连', () => {
  const r = checkTrace(trace(healthyTurn(0).filter(([t]) => t < 3400)));
  assert.ok(r.violations.some((v) => v.rule === 'turn.unclosed'), JSON.stringify(r.violations));
});

test('白名单外转移：speaking → awaiting_shot', () => {
  const r = checkTrace(trace([
    ...healthyTurn(0).filter(([t]) => t < 3400),
    [1500, 'dialog.state', { from: 'speaking', to: 'awaiting_shot' }],
  ]));
  assert.ok(r.violations.some((v) => v.rule === 'state.whitelist'), JSON.stringify(r.violations));
});

test('回执的 speaking → thinking 不算违规', () => {
  // 委派轮：开轮后先回执出声（thinking → speaking），播完退回 thinking 等答案，
  // 答案到了再进 speaking。这条链是真机行为，审计器不该把它判成非法转移。
  const r = checkTrace(trace([
    [0, 'asr.sentence', { text: '帮我查一下订单。' }],
    [100, 'turn.start', { text_len: 7 }],
    [120, 'dialog.state', { from: 'listening', to: 'thinking' }],
    [400, 'dialog.state', { from: 'thinking', to: 'speaking' }],
    [1100, 'dialog.state', { from: 'speaking', to: 'thinking' }],
    [1800, 'llm.first', { ms: 1700 }],
    [2000, 'tts.first', { ms: 200 }],
    [2000, 'dialog.state', { from: 'thinking', to: 'speaking' }],
    [4000, 'turn.end', { interrupted: false, audio_s: 2 }],
    [4010, 'dialog.state', { from: 'speaking', to: 'listening' }],
  ]));
  assert.deepEqual(
    r.violations.filter((v) => v.rule.startsWith('state.')),
    [],
    `回执的状态链符合设计，不该报违规：${JSON.stringify(r.violations)}`,
  );
});

test('closed 之后还在转移 / 还开新轮', () => {
  const r = checkTrace(trace([
    ...healthyTurn(0),
    [4000, 'dialog.state', { from: 'listening', to: 'closed' }],
    [5000, 'dialog.state', { from: 'closed', to: 'listening' }],
    [6000, 'turn.start', { text_len: 2 }],
  ]));
  assert.ok(r.violations.some((v) => v.rule === 'state.afterClose'), JSON.stringify(r.violations));
});

test('先出声后进 speaking：顺序反了', () => {
  const rows = healthyTurn(0).map(([t, ev, extra]) => {
    if (ev === 'dialog.state' && (extra as { to?: string }).to === 'speaking') {
      return [1600, ev, extra] as Ev;
    }
    return [t, ev, extra] as Ev;
  });
  const r = checkTrace(trace(rows));
  assert.ok(
    r.violations.some((v) => v.rule === 'state.audioBeforeSpeaking'),
    JSON.stringify(r.violations),
  );
});

test('被判插话却没有 audio.stop', () => {
  const rows = healthyTurn(0).map(([t, ev, extra]) => (
    ev === 'turn.end' ? [t, ev, { ...(extra as object), interrupted: true }] as Ev : [t, ev, extra] as Ev
  ));
  const r = checkTrace(trace(rows));
  assert.ok(r.violations.some((v) => v.rule === 'barge.noAudioStop'), JSON.stringify(r.violations));

  // 插话 + 真的发了 audio.stop：不报
  const withStop = [
    ...rows.filter(([t]) => t < 3400),
    [3380, 'call.send', { json: '{"op":"audio.stop"}' }],
    ...rows.filter(([t]) => t >= 3400),
  ] as Ev[];
  assert.deepEqual(checkTrace(trace(withStop)).violations, []);
});

test('一轮挂太久', () => {
  const rows = healthyTurn(0).map(([t, ev, extra]) => (
    ev === 'turn.end' ? [60_000, ev, extra] as Ev : [t, ev, extra] as Ev
  ));
  const r = checkTrace(trace(rows));
  assert.ok(r.violations.some((v) => v.rule === 'turn.tooLong'));
});

test('停嘴到首块超预算', () => {
  const r = checkTrace(trace(healthyTurn(0)), { maxStopToFirstMs: 500 });
  assert.ok(r.violations.some((v) => v.rule === 'timing.stopToFirst'), JSON.stringify(r.violations));
});

test('一次呼吸被切成两轮：停嘴只算给第一轮，第二轮记缺仪表', () => {
  // 真机日志里的那一处：「嗯，是的。」开一轮之后，「辣椒炒肉。」又开一轮，
  // 两轮共享同一个停嘴。把同一个停嘴记两次，第二轮会虚高到 3–5 秒。
  // 这条不变式现在由 `latency-report.computeTurns()` 的「一个 gate.close 只给
  // 一轮用」保证 —— 审计器只映射它的结果，不再自己配对（旧逻辑靠 usedStops）。
  const rows: Ev[] = [
    [0, 'asr.partial', { text: '嗯' }],
    [3200, 'gate.close', { gapMs: 600 }], // 停嘴 = 2600
    [2675, 'asr.sentence', { text: '嗯，是的。' }],
    [2767, 'turn.start', { text_len: 5 }],
    [2767, 'dialog.state', { from: 'listening', to: 'thinking' }],
    [4000, 'tts.first', { ms: 300 }],
    [4000, 'dialog.state', { from: 'thinking', to: 'speaking' }],
    [6000, 'turn.end', { interrupted: false }],
    [6000, 'dialog.state', { from: 'speaking', to: 'listening' }],
    [2920, 'asr.sentence', { text: '辣椒炒肉。' }],
    [6567, 'turn.start', { text_len: 5 }],
    [6567, 'dialog.state', { from: 'listening', to: 'thinking' }],
    [7500, 'tts.first', { ms: 300 }],
    [7500, 'dialog.state', { from: 'thinking', to: 'speaking' }],
    [9000, 'turn.end', { interrupted: false }],
    [9000, 'dialog.state', { from: 'speaking', to: 'listening' }],
  ];
  const r = checkTrace(trace(rows));
  assert.equal(r.turns.length, 2);
  assert.equal(r.turns[0]!.stopToFirstMs, 1400, '第一轮持有这次停嘴');
  assert.equal(r.turns[1]!.stopToFirstMs, null, '第二轮不许复用别人的停嘴');
  assert.deepEqual(r.violations, []);
});

test('parseTrace：坏行要抛，不能当成"没有违规"', () => {
  assert.throws(() => parseTrace('{"t":1,"ev":"turn.start"}\n这不是 JSON'),
    /档案行不像事件|JSON/);
  assert.equal(parseTrace('\n\n{"t":1,"ev":"close"}\n').length, 1);
});

test('omni 该答却退回级联：lane.fallback 报红（用户会听到两副嗓子）', () => {
  const rows = healthyTurn(0);
  // 插在开轮之后、首块之前 —— 和真实档案里 `agent.lane` 的位置一致
  rows.splice(4, 0, [at(0, 505), 'agent.lane', { lane_ok: false, text_ok: true, state: 'busy', has_resp: true }]);
  const r = checkTrace(trace(rows));
  assert.ok(r.violations.some((v) => v.rule === 'lane.fallback'), JSON.stringify(r.violations));
});

test('文本闸拒掉的轮次不算违约：它本来就不属于快车道', () => {
  const rows = healthyTurn(0);
  rows.splice(4, 0, [at(0, 505), 'agent.lane', { lane_ok: true, text_ok: false }]);
  const r = checkTrace(trace(rows));
  assert.deepEqual(r.violations.filter((v) => v.rule === 'lane.fallback'), []);
});

test('接管成功的轮次不报 lane.fallback', () => {
  const rows = healthyTurn(0);
  rows.splice(4, 0, [at(0, 505), 'agent.lane', { lane_ok: true, text_ok: true }]);
  const r = checkTrace(trace(rows));
  assert.deepEqual(r.violations.filter((v) => v.rule === 'lane.fallback'), []);
});

test('新版 agent.lane：车道挂了退回级联（why=live-down）要报红', () => {
  // 新版事件已经没有 `text_ok`。以前按 `lane_ok:false && text_ok:true` 判，
  // 这条规则永远不成立 —— 上线以来一次没报过（静默失明）。
  const rows = healthyTurn(0);
  rows.splice(4, 0, [at(0, 505), 'agent.lane', {
    has_lane: true, lane_ok: false, ok: false, lane: 'cascade', why: 'live-down', state: 'broken',
  }]);
  const r = checkTrace(trace(rows));
  assert.ok(r.violations.some((v) => v.rule === 'lane.fallback'), JSON.stringify(r.violations));
});

test('新版 agent.lane：正常交给 dsh（lane=dsh, why=action）不报', () => {
  // lane_ok:false 只说明车道没接活，这一句本来就归 dsh（含动作词），
  // 用户只会听到一副嗓子，不该算「退回级联」。
  const rows = healthyTurn(0);
  rows.splice(4, 0, [at(0, 505), 'agent.lane', {
    has_lane: true, lane_ok: false, ok: false, lane: 'dsh', why: 'action',
  }]);
  const r = checkTrace(trace(rows));
  assert.deepEqual(r.violations.filter((v) => v.rule === 'lane.fallback'), []);
});

test('旧版 agent.lane（无 lane 字段）：text_ok:true + lane_ok:false 仍兼容报红', () => {
  // 历史档案里 `agent.lane` 只有 {lane_ok, text_ok}，没有 lane/why。
  // 兼容分支必须继续认得这种格式，否则旧档案回放时会漏掉违约。
  const rows = healthyTurn(0);
  rows.splice(4, 0, [at(0, 505), 'agent.lane', { lane_ok: false, text_ok: true }]);
  const r = checkTrace(trace(rows));
  assert.ok(r.violations.some((v) => v.rule === 'lane.fallback'), JSON.stringify(r.violations));
});

/** 健康轮里的相对时刻 */
function at(base: number, offset: number): number {
  return base + offset;
}
