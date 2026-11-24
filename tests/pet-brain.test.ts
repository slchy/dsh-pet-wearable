/**
 * `PetBrain` 的单测。
 *
 * 一半的断言在验证「**不该**开口时确实没开口」—— 这个模块最怕的不是沉默，
 * 是太勤。另一半在验证扩展面：决断表必须填满，计划必须自洽。
 *
 * 行为对照：`tests/pet-timing.test.ts`。唯一**故意不同**的一条是
 * `wearing === null`（ADR-0001 §9：读不到就不主动开口）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppSession } from '../src/app/session.ts';
import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import { EVENTS } from '../src/events.ts';
import { PetBrain } from '../src/pet/brain/brain.ts';
import { PHASES, TRIGGERS, planFor, validatePlan } from '../src/pet/brain/registry.ts';
import type { Interrupt, PetInput, PetIntent, PetState, PhaseId } from '../src/pet/brain/types.ts';
import { PetSession } from '../src/pet/brain/session.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';

const MIN = 60_000;

const CAPS: DeviceCapabilities = {
  audioIn: 'msbc',
  capture: { glance: { needsUser: false } },
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
  played: false,
  ignorePhrases: [],
};

interface Stamp {
  now: number;
  localHour?: number;
}

function at(stamp: Stamp): { now: number; localHour: number } {
  return { now: stamp.now, localHour: stamp.localHour ?? 12 };
}

/** 跑一串输入，返回最终状态与全部意图。 */
function drive(steps: readonly PetInput[], brain = new PetBrain()): { state: PetState; intents: PetIntent[] } {
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const intents: PetIntent[] = [];
  for (const input of steps) {
    const result = brain.step(state, input);
    state = result.state;
    intents.push(...result.intents);
  }
  return { state, intents };
}

const tick = (now: number, localHour = 12): PetInput => ({ kind: 'tick', now, localHour });
const presence = (wearing: boolean | null, now: number): PetInput => ({ kind: 'presence', wearing, ...at({ now }) });
const userFinal = (now: number): PetInput => ({ kind: 'userFinal', text: '你好', now, localHour: 12 });
const summon = (now: number, opensSession = false): PetInput =>
  ({ kind: 'summon', opensSession, ...at({ now }) });
const power = (percent: number | null, now: number): PetInput => ({ kind: 'power', percent, ...at({ now }) });
const phaseResult = (
  engagementId: string,
  step: number,
  phase: PhaseId,
  result: 'got' | 'none' | 'reply' | 'declined' | 'error' | 'done' | 'cut' | 'expired' | 'timeout',
  now: number,
  payload?: { text?: string },
): PetInput => ({
  kind: 'phaseResult',
  engagementId,
  step,
  phase,
  result,
  ...(payload === undefined ? {} : { payload }),
  ...at({ now }),
});

/** 从意图里挑出「进了哪个阶段」。 */
function phases(intents: readonly PetIntent[]): PhaseId[] {
  return intents
    .filter((intent): intent is Extract<PetIntent, { kind: 'phase.enter' }> => intent.kind === 'phase.enter')
    .map((intent) => intent.phase);
}

/** 从意图里挑出结局。 */
function outcomes(intents: readonly PetIntent[]): string[] {
  return intents
    .filter((intent): intent is Extract<PetIntent, { kind: 'end' }> => intent.kind === 'end')
    .map((intent) => intent.record.outcome);
}

/** 当前 engagement 在哪个阶段（没有就是 `null`）。 */
function currentPhaseOf(state: PetState): PhaseId | null {
  const engagement = state.engagement;
  if (engagement === null) {
    return null;
  }
  return engagement.plan[engagement.at] ?? null;
}

// ---------------------------------------------------------------- 扩展面

test('决断表填满：每个结果、每种打断都有决断', () => {
  const interrupts: Interrupt[] = ['userActivity', 'tap', 'presenceLost', 'floorTaken'];
  for (const [id, spec] of Object.entries(PHASES)) {
    assert.equal(spec.id, id, '阶段 id 与键要一致');
    for (const result of [...spec.results, 'timeout']) {
      const verdict = spec.onResult[result];
      assert.ok(verdict !== undefined, `阶段 ${id} 缺结果 ${result}`);
    }
    for (const interrupt of interrupts) {
      const verdict = spec.onInterrupt[interrupt];
      assert.ok(verdict !== undefined, `阶段 ${id} 缺打断 ${interrupt}`);
    }
  }
});

test('每个触发器的计划都自洽', () => {
  for (const trigger of TRIGGERS) {
    validatePlan(trigger.plan({ ...emptyWorld(), caps: CAPS }), trigger.reason);
  }
});

test('validatePlan 拦得住写坏的计划', () => {
  assert.throws(() => validatePlan([], 'x'), /为空/);
  assert.throws(() => validatePlan(['compose', 'await'], 'x'), /缺 speak/);
  assert.throws(() => validatePlan(['speak', 'compose', 'await'], 'x'), /speak 必须在 compose 之后/);
  assert.throws(() => validatePlan(['compose', 'speak', 'speak', 'await'], 'x'), /重复/);
  // 末阶段还能 next → 走出计划之外
  assert.throws(() => validatePlan(['compose', 'speak'], 'x'), /末阶段/);
  // listen 必须在 speak 紧前面
  assert.throws(() => validatePlan(['look', 'compose', 'listen', 'await', 'speak'], 'x'), /listen 必须紧挨在 speak 之前/);
  assert.throws(() => validatePlan(['compose', 'listen', 'await', 'speak'], 'x'), /listen 必须紧挨在 speak 之前/);
});

test('同一 state + 同一 input，输出逐字段相同（纯函数）', () => {
  const brain = new PetBrain();
  const state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const first = brain.step(state, tick(20 * MIN));
  const second = brain.step(state, tick(20 * MIN));
  assert.deepEqual(first.intents, second.intents);
  assert.deepEqual([...first.state.fired], [...second.state.fired]);
});

test('不改传入的 state', () => {
  const brain = new PetBrain();
  const state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const before = JSON.stringify({ ...state, fired: [...state.fired] });
  brain.step(state, presence(true, 0));
  brain.step(state, tick(30 * MIN));
  assert.equal(JSON.stringify({ ...state, fired: [...state.fired] }), before);
});

// ---------------------------------------------------------------- 行为：对照 PetTiming

test('一直在场上、没人说话：不到门槛不开口', () => {
  const { intents } = drive([presence(true, 0), tick(10 * MIN), tick(19 * MIN)]);
  assert.deepEqual(phases(intents), []);
});

test('闲置到门槛就搭话，且只说一次', () => {
  const { intents } = drive([presence(true, 0), tick(20 * MIN), tick(20 * MIN + 1000)]);
  assert.deepEqual(phases(intents), ['look']);
  assert.equal(intents.filter((i) => i.kind === 'phase.enter').length, 1);
});

test('用户说话了：闲置计时重置', () => {
  const { intents } = drive([
    presence(true, 0),
    userFinal(18 * MIN),
    tick(30 * MIN),
    tick(18 * MIN + 20 * MIN),
  ]);
  assert.equal(phases(intents).length, 1, '刚好 20 分钟才开口');
});

test('离场一会儿就回来：不打招呼', () => {
  const { intents } = drive([
    presence(true, 0),
    presence(false, 10 * MIN),
    presence(true, 10 * MIN + 30_000),
    tick(10 * MIN + 31_000),
  ]);
  assert.deepEqual(phases(intents), []);
});

test('离场够久再回来：打招呼，且只说一次', () => {
  const { intents } = drive([
    presence(true, 0),
    presence(false, 10 * MIN),
    presence(true, 20 * MIN),
    tick(20 * MIN),
    tick(20 * MIN + 5000),
  ]);
  const enters = intents.filter((i) => i.kind === 'phase.enter');
  assert.equal(enters.length, 1);
  const first = enters[0];
  assert.ok(first !== undefined && first.kind === 'phase.enter');
  assert.equal(first.context.reason, 'greet');
  assert.equal(first.context.elapsedMs, 10 * MIN);
});

test('摘下期间永远不开口', () => {
  const { intents } = drive([presence(true, 0), presence(false, MIN), tick(60 * MIN)]);
  assert.deepEqual(phases(intents), []);
});

test('没戴 → 读不到 → 又读到戴着：不补打招呼', () => {
  const { intents } = drive([
    presence(true, 0),
    presence(false, 10 * MIN),
    presence(null, 11 * MIN),
    presence(true, 20 * MIN),
    tick(20 * MIN),
  ]);
  assert.deepEqual(phases(intents), []);
});

test('读不到之后直接读到戴着：不打招呼', () => {
  const { intents } = drive([presence(null, 0), presence(true, 20 * MIN), tick(20 * MIN)]);
  assert.deepEqual(phases(intents), []);
});

test('深夜不搭话，但离场回来照旧打招呼', () => {
  const quiet = drive([presence(true, 0), tick(60 * MIN, 23), tick(120 * MIN, 3)]);
  assert.deepEqual(phases(quiet.intents), []);

  const returned = drive([
    presence(true, 0),
    presence(false, MIN),
    presence(true, 20 * MIN),
    tick(20 * MIN, 2),
  ]);
  assert.equal(phases(returned.intents)[0], 'look');
});

test('深夜边界：22 点可以说，23 点不能说，7 点恢复', () => {
  const at = (hour: number): PhaseId[] =>
    phases(drive([presence(true, 0), tick(60 * MIN, hour)]).intents);
  assert.deepEqual(at(22), ['look']);
  assert.deepEqual(at(23), []);
  assert.deepEqual(at(0), []);
  assert.deepEqual(at(6), []);
  assert.deepEqual(at(7), ['look']);
});

test('电量低不搭话；读不到电量时不受限', () => {
  const low = drive([presence(true, 0), power(20, MIN), tick(60 * MIN)]);
  assert.deepEqual(phases(low.intents), [], '等于阈值也算低');
  const unknown = drive([presence(true, 0), power(null, MIN), tick(60 * MIN)]);
  assert.deepEqual(phases(unknown.intents), ['look']);
});

test('最小间隔真的起作用：播报出声后要等够 10 分钟', () => {
  // ADR-0001 §5.3 修订后的语义：闲置锚点只看用户动静，播报只更新 lastVoiceAt，
  // 由 minGap 把搭话推后 —— 删除 minGap 闸门时这条必须失败。
  const brain = new PetBrain({ chatterAfterIdleMs: 20 * MIN, minProactiveGapMs: 10 * MIN });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });

  run([presence(true, 0)]);
  // 19 分钟时后台播报出声
  run([{ kind: 'announce', pending: false, spoken: true, ...at({ now: 19 * MIN }) }]);
  assert.equal(state.world.lastVoiceAt, 19 * MIN);

  const at20 = run([tick(20 * MIN)]);
  assert.deepEqual(phases(at20), [], '离上次出声只有 1 分钟，minGap 应当挡住');
  const at29 = run([tick(29 * MIN)]);
  assert.deepEqual(phases(at29), ['look'], '满 10 分钟才允许搭话');
});

test('同一段安静不会搭第二次（锚点只看用户动静）', () => {
  const brain = new PetBrain({ chatterAfterIdleMs: 1 * MIN, minProactiveGapMs: 0 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  run([presence(true, 0)]);
  assert.deepEqual(phases(run([tick(2 * MIN)])), ['look']);

  // 走完一整个计划（look → compose → listen → speak → await）
  run([phaseResult('pet-1', 1, 'look', 'none', 2 * MIN + 100)]);
  run([phaseResult('pet-1', 2, 'compose', 'reply', 2 * MIN + 200, { text: '嗯' })]);
  run([{ kind: 'micOpened', ...at({ now: 2 * MIN + 700 }) }]);
  run([phaseResult('pet-1', 4, 'speak', 'done', 2 * MIN + 2000)]);
  run([phaseResult('pet-1', 5, 'await', 'timeout', 2 * MIN + 20_000)]);
  assert.equal(state.engagement, null, '计划应当走完');

  // 用户没理 → 锚点没变 → 同一段安静不再开口
  assert.deepEqual(phases(run([tick(60 * MIN)])), [], '同一段安静不重复搭话');

  // 用户开口 → 新的一段安静
  run([userFinal(60 * MIN)]);
  assert.equal(phases(run([tick(62 * MIN)]))[0], 'look');
});

test('敲击等同用户说话：刷新闲置', () => {
  const { intents } = drive([presence(true, 0), summon(19 * MIN), tick(20 * MIN)]);
  assert.deepEqual(phases(intents), []);
});

test('普通敲击给一个快反射动作', () => {
  const { intents } = drive([presence(true, 0), summon(19 * MIN)]);
  assert.deepEqual(intents, [{ kind: 'reflex', cue: 'here' }]);
});

test('会打开语音会话的敲击不当作说话，也不给反射', () => {
  const { intents } = drive([presence(true, 0), summon(19 * MIN, true), tick(20 * MIN)]);
  assert.deepEqual(intents.filter((i) => i.kind === 'reflex'), []);
  assert.equal(phases(intents)[0], 'look', '闲置没被重置，门槛到了就搭话');
});

// ---------------------------------------------------------------- ADR §9：与旧行为的分歧

test('读不到佩戴（null）不主动开口 —— 与 PetTiming 不同', () => {
  const { intents } = drive([presence(null, 0), tick(60 * MIN)]);
  assert.deepEqual(phases(intents), [], 'null 不是"戴着"');
});

test('设备不报佩戴：wearing 恒为 null，永远不开口', () => {
  const caps: DeviceCapabilities = { ...CAPS, presence: false };
  const brain = new PetBrain();
  let state = brain.initial(caps, { now: 0, localHour: 12 });
  const out: PetIntent[] = [];
  for (const input of [presence(true, 0), tick(60 * MIN)] as PetInput[]) {
    const result = brain.step(state, input);
    state = result.state;
    out.push(...result.intents);
  }
  assert.deepEqual(phases(out), []);
});

// ---------------------------------------------------------------- 结局与去重

test('abandoned 不写出声、但会删掉候选键', () => {
  const { intents } = drive([
    presence(true, 0),
    tick(20 * MIN),
    userFinal(20 * MIN + 100),
  ]);
  assert.deepEqual(phases(intents), ['look'], '还没进 compose 就被打断');
  assert.deepEqual(outcomes(intents), ['abandoned']);
});

test('declined 出声为零，但候选键保留', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  run([presence(true, 0), tick(20 * MIN)]);
  run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 500)]);
  const declined = run([phaseResult('pet-1', 2, 'compose', 'declined', 20 * MIN + 600)]);
  assert.deepEqual(outcomes(declined), ['declined']);
  assert.equal(state.world.lastVoiceAt, null, 'declined 不算出声');
  assert.deepEqual(phases(run([tick(21 * MIN)])), [], '同一段安静不再试第二次');
});

test('阶段结果要带对 step，过期的直接丢', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  run([presence(true, 0), tick(20 * MIN)]);
  // 当前 step 是 1；报一个 step=2 的结果应当被丢
  const stale = run([phaseResult('pet-1', 2, 'look', 'got', 20 * MIN + 100)]);
  assert.deepEqual(stale, [], '过期结果不产生任何意图');
  assert.equal(state.engagement?.step, 1, '还在 look');
});

test('没有 glance 能力时计划里没有 look', () => {
  const caps: DeviceCapabilities = { ...CAPS, capture: {} };
  const brain = new PetBrain();
  let state = brain.initial(caps, { now: 0, localHour: 12 });
  const out: PetIntent[] = [];
  for (const input of [presence(true, 0), tick(20 * MIN)] as PetInput[]) {
    const result = brain.step(state, input);
    state = result.state;
    out.push(...result.intents);
  }
  assert.deepEqual(phases(out), ['compose']);
  const enter = out[0];
  assert.ok(enter !== undefined && enter.kind === 'phase.enter');
  assert.equal(enter.context.hasImage, false);
  assert.equal(enter.listenMs, null, 'compose 不开麦');
});

test('上一次 engagement 的晚到结果不会串进下一次', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };

  // 第一次开口：look 阶段被用户打断 → abandoned
  run([presence(true, 0), tick(20 * MIN)]);
  assert.equal(state.engagement?.id, 'pet-1');
  run([userFinal(20 * MIN + 100)]);
  const ended = state.engagement;
  assert.equal(ended, null);

  // 第二次开口：又是 step 1 的 look
  run([tick(60 * MIN)]);
  assert.equal(state.engagement?.id, 'pet-2');
  assert.equal(state.engagement?.step, 1);

  // pet-1 的照片迟到：step / phase 都和当前一致，只有 engagementId 不同
  const late = run([phaseResult('pet-1', 1, 'look', 'got', 60 * MIN + 100)]);
  assert.deepEqual(late, [], '属于上一次的结果必须丢掉');
  assert.equal(state.engagement?.id, 'pet-2');
  assert.equal(state.engagement?.step, 1, '没有推进阶段');
});

// ---------------------------------------------------------------- listen 阶段

test('计划含 listen：设备支持 listen.start 才有', () => {
  const withMic = planFor('chatter', { ...CAPS, listenStart: true });
  assert.deepEqual(withMic, ['look', 'compose', 'listen', 'speak', 'await']);

  const noMic = planFor('chatter', { ...CAPS, listenStart: false });
  assert.deepEqual(noMic, ['look', 'compose', 'speak', 'await'], '不支持开麦就没有 listen');
});

test('首帧上行到了才进 speak，结局记 micOpened=true', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };

  run([presence(true, 0)]);
  run([tick(20 * MIN)]);
  run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 500)]);
  run([phaseResult('pet-1', 2, 'compose', 'reply', 20 * MIN + 600, { text: '嗯' })]);

  assert.equal(state.engagement?.step, 3, '当前在 listen');
  assert.equal(currentPhaseOf(state), 'listen');

  // 首帧上行 → 进 speak
  const opened = run([{ kind: 'micOpened', ...at({ now: 20 * MIN + 1200 }) }]);
  assert.equal(phases(opened)[0], 'speak', '麦开了才进 speak');
  assert.equal(state.engagement?.micOpened, true);

  run([phaseResult('pet-1', 4, 'speak', 'done', 20 * MIN + 4000)]);
  const done = run([phaseResult('pet-1', 5, 'await', 'timeout', 20 * MIN + 12_000)]);
  const end = done.find((intent) => intent.kind === 'end');
  assert.ok(end !== undefined && end.kind === 'end');
  assert.equal(end.record.micOpened, true, '结局要记麦开了');
  assert.equal(end.closeMic, true, 'await 结束要关麦');
});

test('开麦超时：照常开口，结局记 micOpened=false', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };

  run([presence(true, 0)]);
  run([tick(20 * MIN)]);
  run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 500)]);
  run([phaseResult('pet-1', 2, 'compose', 'reply', 20 * MIN + 600, { text: '嗯' })]);
  // listen 超时（step 3）
  const afterTimeout = run([phaseResult('pet-1', 3, 'listen', 'timeout', 20 * MIN + 2100)]);
  assert.equal(phases(afterTimeout)[0], 'speak', '超时也要开口');
  assert.equal(state.engagement?.micOpened, false);

  run([phaseResult('pet-1', 4, 'speak', 'done', 20 * MIN + 5000)]);
  const done = run([phaseResult('pet-1', 5, 'await', 'timeout', 20 * MIN + 13_000)]);
  const end = done.find((intent) => intent.kind === 'end');
  assert.ok(end !== undefined && end.kind === 'end');
  assert.equal(end.record.micOpened, false, '结局要记麦没开');
});

test('listen 期间敲击：abandoned + 关麦', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  run([presence(true, 0)]);
  run([tick(20 * MIN)]);
  run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 500)]);
  run([phaseResult('pet-1', 2, 'compose', 'reply', 20 * MIN + 600, { text: '嗯' })]);
  const tapped = run([summon(20 * MIN + 700)]);

  const end = tapped.find((intent) => intent.kind === 'end');
  assert.ok(end !== undefined && end.kind === 'end');
  assert.equal(end.record.outcome, 'abandoned', '还没出声，算 abandoned');
  assert.equal(end.closeMic, true, '敲击要关麦');
});

test('listen 期间用户开口：abandoned 但**不**关麦', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  run([presence(true, 0)]);
  run([tick(20 * MIN)]);
  run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 500)]);
  run([phaseResult('pet-1', 2, 'compose', 'reply', 20 * MIN + 600, { text: '嗯' })]);
  const spoke = run([userFinal(20 * MIN + 700)]);

  const end = spoke.find((intent) => intent.kind === 'end');
  assert.ok(end !== undefined && end.kind === 'end');
  assert.equal(end.record.outcome, 'abandoned');
  assert.equal(end.closeMic, false, '用户正在这个会话里说话，麦留着');
});

test('speak 期间敲击：dismissed + 关麦', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };
  run([presence(true, 0)]);
  run([tick(20 * MIN)]);
  run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 500)]);
  run([phaseResult('pet-1', 2, 'compose', 'reply', 20 * MIN + 600, { text: '嗯' })]);
  run([{ kind: 'micOpened', ...at({ now: 20 * MIN + 1200 }) }]);
  const tapped = run([summon(20 * MIN + 1500)]);

  const end = tapped.find((intent) => intent.kind === 'end');
  assert.ok(end !== undefined && end.kind === 'end');
  assert.equal(end.record.outcome, 'dismissed');
  assert.equal(end.closeMic, true);
  assert.equal(end.dismiss, true);
});

test('greet 被 abandoned 后，同一次佩戴的下一次心跳还能再打招呼', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };

  const started = run([
    presence(true, 0),
    presence(false, 10 * MIN),
    presence(true, 20 * MIN),
    tick(20 * MIN),
  ]);
  assert.equal(started.find((intent) => intent.kind === 'phase.enter')?.context.reason, 'greet');
  assert.equal(state.world.lastAwayMs, 10 * MIN, '开场不能把离场时长清掉');
  assert.equal(state.engagement?.reason, 'greet');

  const abandoned = run([userFinal(20 * MIN + 100)]);
  assert.deepEqual(outcomes(abandoned), ['abandoned']);
  assert.equal(state.engagement, null);
  assert.equal(state.world.lastAwayMs, 10 * MIN, 'abandoned 必须留着 lastAwayMs');
  assert.equal(state.fired.has(`greet:${20 * MIN}`), false, 'abandoned 会删掉候选键');

  const again = run([tick(20 * MIN + 200)]);
  const enter = again.find((intent) => intent.kind === 'phase.enter');
  assert.ok(enter !== undefined && enter.kind === 'phase.enter');
  assert.equal(enter.context.reason, 'greet');
  assert.equal(enter.context.elapsedMs, 10 * MIN);
});

test('greet 非 abandoned 收场后不再因同一次离场打招呼', () => {
  const caps: DeviceCapabilities = { ...CAPS, capture: {}, listenStart: false };
  const brain = new PetBrain();
  let state = brain.initial(caps, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };

  run([
    presence(true, 0),
    presence(false, 10 * MIN),
    presence(true, 20 * MIN),
    tick(20 * MIN),
  ]);
  assert.equal(state.engagement?.reason, 'greet');
  const declined = run([phaseResult('pet-1', 1, 'compose', 'declined', 20 * MIN + 100)]);
  assert.deepEqual(outcomes(declined), ['declined']);
  assert.equal(state.world.lastAwayMs, null, '非 abandoned 才消费离场时长');
  assert.deepEqual(phases(run([tick(20 * MIN + 200)])), [], '同一次佩戴不能再 greet');
});

test('speak 的 error 是 failed，cut 仍是 engaged', () => {
  const brain = new PetBrain();
  let state = brain.initial(CAPS, { now: 0, localHour: 12 });
  const run = (inputs: PetInput[]): PetIntent[] => {
    const out: PetIntent[] = [];
    for (const input of inputs) {
      const result = brain.step(state, input);
      state = result.state;
      out.push(...result.intents);
    }
    return out;
  };

  const reachSpeak = (): void => {
    run([presence(true, 0), tick(20 * MIN)]);
    run([phaseResult('pet-1', 1, 'look', 'none', 20 * MIN + 100)]);
    run([phaseResult('pet-1', 2, 'compose', 'reply', 20 * MIN + 200, { text: '在呢' })]);
    run([{ kind: 'micOpened', ...at({ now: 20 * MIN + 300 }) }]);
    assert.equal(currentPhaseOf(state), 'speak');
  };

  reachSpeak();
  const failed = run([phaseResult('pet-1', 4, 'speak', 'error', 20 * MIN + 400)]);
  assert.deepEqual(outcomes(failed), ['failed']);

  state = brain.initial(CAPS, { now: 0, localHour: 12 });
  reachSpeak();
  const cut = run([phaseResult('pet-1', 4, 'speak', 'cut', 20 * MIN + 400)]);
  assert.deepEqual(outcomes(cut), ['engaged']);
});

test('closed 把话筒投影清成空闲', () => {
  const { state } = drive([
    { kind: 'floor', busy: true, owner: 'reply', ...at({ now: 1 }) },
    { kind: 'closed', ...at({ now: 2 }) },
  ]);
  assert.equal(state.world.floorBusy, false);
  assert.equal(state.world.floorOwner, null);
});

test('对话、播报、反射改话筒时，宠物投影与仲裁器一致；关闭后也是', () => {
  const clock = new VirtualClock(0, 12 * 60);
  const app = new AppSession({
    clock,
    caps: CAPS,
    voice: { speak: async () => 'done', stop: () => {} },
    device: { call: () => {} },
    agent: { ask: async () => ({ text: '在呢' }) },
    tickMs: 86_400_000,
  });
  const same = (owner: string | null): void => {
    assert.equal(app.floor.owner, owner);
    assert.equal(app.snapshot()?.world.floorOwner, owner);
    assert.equal(app.snapshot()?.world.floorBusy, owner !== null);
  };

  app.userPartial();
  same('user');
  app.userFinal('你好');
  same('reply');
  app.onDialogState('listening');
  same(null);
  app.announce(true);
  same('announce');
  app.announce(false);
  same(null);
  app.reflexStart();
  same('reflex');
  app.reflexEnd();
  same(null);
  app.userFinal('还在');
  same('reply');
  app.close();
  same(null);
  app.dispose();
});

test('宠物占麦时投影是 pet，close 返回前就 listen.stop', async () => {
  const clock = new VirtualClock(0, 12 * 60);
  const calls: string[] = [];
  const app = new AppSession({
    clock,
    caps: { ...CAPS, capture: {} },
    voice: { speak: async () => 'done', stop: () => {} },
    device: { call: (call) => { calls.push(call.op); } },
    agent: { ask: async () => ({ text: '在呢' }) },
    params: { greetAfterAwayMs: 60_000, chatterAfterIdleMs: 86_400_000 },
    tickMs: 86_400_000,
  });

  app.deviceEvent({ kind: 'presence', wearing: false });
  await clock.runUntil(60_000, () => app.isQuiet());
  app.deviceEvent({ kind: 'presence', wearing: true });
  await clock.drain(() => app.isQuiet());

  assert.equal(app.floor.owner, 'pet', 'listen 阶段宠物必须占上话筒');
  assert.equal(app.snapshot()?.world.floorOwner, 'pet');
  assert.equal(app.snapshot()?.world.floorBusy, true);
  assert.ok(calls.includes('listen.start'));
  assert.equal(calls.filter((op) => op === 'listen.stop').length, 0);

  app.close();
  const stopsAtClose = calls.filter((op) => op === 'listen.stop').length;
  assert.equal(stopsAtClose, 1, 'close() 返回前就要发出 listen.stop');
  app.dispose();
  assert.equal(calls.filter((op) => op === 'listen.stop').length, 1, 'dispose 不能再补一次关麦');
  assert.equal(app.floor.owner, null);
  assert.equal(app.snapshot()?.world.floorOwner, null);
});

test('朗读抛错上报 error，结局是 failed 而不是 engaged', async () => {
  const clock = new VirtualClock(0, 12 * 60);
  const names: string[] = [];
  const outcomes: string[] = [];
  const app = new AppSession({
    clock,
    caps: { ...CAPS, capture: {} },
    voice: {
      speak: async () => {
        throw new Error('synth down');
      },
      stop: () => {},
    },
    device: { call: () => {} },
    agent: { ask: async () => ({ text: '在呢' }) },
    params: { greetAfterAwayMs: 60_000, chatterAfterIdleMs: 86_400_000 },
    tickMs: 86_400_000,
    onEvent: (name, fields) => {
      names.push(name);
      if (name === EVENTS.petOutcome && typeof fields['outcome'] === 'string') {
        outcomes.push(fields['outcome']);
      }
    },
  });

  app.deviceEvent({ kind: 'presence', wearing: false });
  await clock.runUntil(60_000, () => app.isQuiet());
  app.deviceEvent({ kind: 'presence', wearing: true });
  await clock.drain(() => app.isQuiet());
  app.micOpened();
  await clock.drain(() => app.isQuiet());

  assert.deepEqual(outcomes, ['failed']);
  assert.equal(outcomes.includes('engaged'), false);
  assert.ok(names.includes(EVENTS.petOut));
  assert.ok(names.includes(EVENTS.petSpeak));
  assert.ok(names.includes(EVENTS.petOutcome));
  app.dispose();
});

test('dispose 是吸收态：之后的心跳和敲击撤播报不再入队', async () => {
  const names: string[] = [];
  const session = new PetSession({
    caps: CAPS,
    clock: new VirtualClock(0, 12 * 60),
    voice: { speak: async () => 'done', stop: () => {} },
    device: { call: () => {} },
    agent: { ask: async () => ({ text: '' }) },
    onEvent: (name) => { names.push(name); },
    dismissAnnounce: () => { names.push('dismiss-hook'); },
  });
  session.announce(true);
  session.summon(false);
  await session.whenIdle();
  assert.ok(names.includes(EVENTS.announceDismissed));
  assert.ok(names.includes('dismiss-hook'));

  const marked = names.length;
  session.dispose();
  session.tick();
  session.presence(true);
  session.summon(false);
  await session.whenIdle();
  assert.equal(names.length, marked, '吸收态之后不能再收输入');
});

/** 只为 `validatePlan` 的类型检查造一个空世界。 */
function emptyWorld(): Parameters<typeof TRIGGERS[number]['plan']>[0] {
  return {
    now: 0,
    localHour: 12,
    wearing: true,
    donnedAt: 0,
    lastAwayMs: 10 * MIN,
    battery: null,
    lastUserAt: null,
    lastVoiceAt: null,
    floorBusy: false,
    floorOwner: null,
    announcePending: false,
    caps: CAPS,
    awaySince: null,
  };
}
