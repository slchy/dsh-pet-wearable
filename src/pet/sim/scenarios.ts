/**
 * 声明式场景 + 运行器。
 *
 * 对应 ADR-0002 §3.4–§3.5。写法：
 *
 * ```ts
 * { name, device, startAt?, world?, script: [{ at: '+20m', do: 'wear', ... }], expect: [...] }
 * ```
 *
 * `at` 是相对开局的偏移（`+25m` / `+3s`）。需要条件逻辑时用 `check` 逃逸口 ——
 * 它拿到的是只读的世界，碰不到会话内部。
 */
import assert from 'node:assert/strict';

import type { DeviceCall } from '../../devices/primitives.ts';
import type { PetParams } from '../brain/registry.ts';
import { DEFAULT_PET_PARAMS } from '../brain/registry.ts';
import type { Outcome, Reason } from '../brain/types.ts';
import { MIN } from './host.ts';
import { SimWorld, capabilitiesOf, type DevicePreset, type SimWorldConfig } from './world.ts';
import { checkInvariants, type Violation } from './timeline.ts';

// ---------------------------------------------------------------- 声明式脚本

export type Step =
  | { readonly at: string; readonly do: 'wear'; readonly wearing: boolean | null }
  | { readonly at: string; readonly do: 'say'; readonly text: string }
  | { readonly at: string; readonly do: 'partial' }
  | { readonly at: string; readonly do: 'tap'; readonly opensSession?: boolean }
  | { readonly at: string; readonly do: 'battery'; readonly percent: number | null }
  /** 后台汇报：排队 + 真播一遍 */
  | { readonly at: string; readonly do: 'announce'; readonly text: string }
  /** 只让"有待播汇报"为真，不真的出声（测让位闸门） */
  | { readonly at: string; readonly do: 'announce-pending' }
  | { readonly at: string; readonly do: 'announce-clear' }
  | { readonly at: string; readonly do: 'close' };

export type Expectation =
  | { readonly pet: Outcome; readonly reason?: Reason }
  | { readonly outcomes: readonly Outcome[] }
  | { readonly spoke: RegExp | 'nothing'; readonly times?: number }
  | { readonly calls: readonly DeviceCall['op'][] }
  /** 逃逸口：看细节用，只读 */
  | { readonly check: (world: SimWorld, result: ScenarioResult) => void };

export interface Scenario {
  readonly name: string;
  readonly device: DevicePreset;
  /** 起始墙钟，只用来定"几点"；默认 `2026-11-14T12:00` */
  readonly startAt?: string;
  readonly world?: SimWorldConfig;
  readonly params?: Partial<PetParams>;
  readonly script: readonly Step[];
  /** 场景跑到哪；默认 = 最后一个 step + 2 分钟 */
  readonly horizon?: string;
  readonly expect?: readonly Expectation[];
}

export interface ScenarioResult {
  readonly world: SimWorld;
  readonly violations: readonly Violation[];
  readonly outcomes: readonly { id: string; outcome: string; reason: string; phase: string }[];
  readonly horizon: number;
}

// ---------------------------------------------------------------- 时间

const UNIT: Record<string, number> = { ms: 1, s: 1_000, m: MIN, h: 3_600_000 };

/** `+25m` / `+3s` / `+1m30s` / `+90` → 毫秒偏移。支持多段单位相加。 */
export function parseAt(at: string): number {
  const trimmed = at.trim().replace(/^\+/, '');
  const parts = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h)?)+$/.test(trimmed)
    ? trimmed.match(/\d+(?:\.\d+)?(?:ms|s|m|h)?/g)
    : null;
  if (parts === null || parts.length === 0) {
    throw new Error(`场景时间写法不对："${at}"（要 +25m / +1m30s 这种）`);
  }
  let total = 0;
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(part);
    if (match === null) {
      throw new Error(`场景时间写法不对："${at}"`);
    }
    total += Number(match[1]) * (UNIT[match[2] ?? 'ms'] ?? 1);
  }
  return Math.round(total);
}

/** `2026-11-14T22:40` → 一天里的第几分钟（1360）。 */
function minuteOf(startAt: string): number {
  const match = /T(\d{1,2}):(\d{2})/.exec(startAt);
  if (match === null) {
    return 12 * 60;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// ---------------------------------------------------------------- 运行

/** 跑一个场景：执行脚本 → 收尾 → 查不变量 → 查期望。 */
export async function runScenario(
  scenario: Scenario,
  params: PetParams = DEFAULT_PET_PARAMS,
): Promise<ScenarioResult> {
  const caps = capabilitiesOf(scenario.device);
  const world = new SimWorld({
    caps,
    startMinute: minuteOf(scenario.startAt ?? '2026-11-14T12:00'),
    ...(scenario.params === undefined ? {} : { params: scenario.params }),
    ...(scenario.world === undefined ? {} : { world: scenario.world }),
  });

  let closed = false;
  const steps = [...scenario.script].sort((a, b) => parseAt(a.at) - parseAt(b.at));

  try {
    for (const step of steps) {
      await world.until(parseAt(step.at));
      switch (step.do) {
        case 'wear':
          await world.wear(step.wearing);
          break;
        case 'say':
          await world.say(step.text);
          break;
        case 'partial':
          await world.partial();
          break;
        case 'tap':
          await world.tap(step.opensSession === true);
          break;
        case 'battery':
          await world.battery(step.percent);
          break;
        case 'announce':
          world.startAnnounce(step.text);
          await world.flush();
          break;
        case 'announce-pending':
          world.app.announce(true);
          await world.flush();
          break;
        case 'announce-clear':
          world.app.announce(false);
          await world.flush();
          break;
        case 'close':
          await world.close();
          closed = true;
          break;
      }
    }

    const lastStep = steps.length === 0 ? 0 : parseAt(steps[steps.length - 1]?.at ?? '+0');
    const horizon = scenario.horizon === undefined ? lastStep + 2 * MIN : parseAt(scenario.horizon);
    await world.until(horizon);
    // 还在播的后台汇报要等它自己说完，否则 ⑬ 会报"计时器没取消"
    await world.settleAnnounce();

    // 场景结束必须收干净：关连接 → 在途开口记 aborted → 计时器归零（ADR-0002 ⑬）
    if (!closed) {
      await world.close();
    }
    await world.flush();
    world.dispose();
    await world.flush();

    const outcomes = world.timeline
      .filter((event) => event.src === 'pet.out' && event.kind === 'end')
      .map((event) => ({
        id: String(event['id']),
        outcome: String(event['outcome']),
        reason: String(event['reason']),
        phase: String(event['phase']),
      }));

    const violations = [
      ...checkInvariants(world.timeline, { params, caps }),
      ...checkQuietEnd(world, outcomes),
    ];

    const result: ScenarioResult = { world, violations, outcomes, horizon };

    if (violations.length > 0) {
      const error = new Error(
        `[${scenario.name}] 违反不变量：\n${violations
          .map((violation) => `  ${violation.rule} t=${violation.at} ${violation.detail}`)
          .join('\n')}`,
      ) as Error & { violations: Violation[] };
      // 探索器要拿到结构化结果才能收缩
      error.violations = violations;
      throw error;
    }

    for (const expectation of scenario.expect ?? []) {
      expectOne(scenario.name, expectation, result);
    }
    return result;
  } finally {
    world.dispose();
  }
}

/** ⑬ 收尾之后不该还挂着计时器、也不该有没结局的 engagement。 */
function checkQuietEnd(world: SimWorld, outcomes: readonly { id: string }[]): Violation[] {
  const started = [...new Set(
    world.timeline
      .filter((event) => event.src === 'pet.out' && event.kind === 'phase.enter')
      .map((event) => String(event['engagementId'])),
  )];
  const ended = new Set(outcomes.map((outcome) => outcome.id));
  const violations: Violation[] = started
    .filter((id) => !ended.has(id))
    .map((id) => ({ rule: '⑬', at: world.clock.now(), detail: `${id} 关连接后还没有结局` }));
  if (world.clock.pending !== 0) {
    violations.push({
      rule: '⑬',
      at: world.clock.now(),
      detail: `收尾后还有 ${world.clock.pending} 个计时器没取消`,
    });
  }
  return violations;
}

function expectOne(name: string, expectation: Expectation, result: ScenarioResult): void {
  if ('check' in expectation) {
    expectation.check(result.world, result);
    return;
  }
  if ('pet' in expectation) {
    const hit = result.outcomes.some(
      (outcome) => outcome.outcome === expectation.pet
        && (expectation.reason === undefined || outcome.reason === expectation.reason),
    );
    assert.ok(
      hit,
      `[${name}] 期望至少有一次 ${expectation.pet}${expectation.reason === undefined ? '' : `/${expectation.reason}`}，实际：${JSON.stringify(result.outcomes)}`,
    );
    return;
  }
  if ('outcomes' in expectation) {
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.outcome),
      expectation.outcomes,
      `[${name}] 结局序列不符`,
    );
    return;
  }
  if ('spoke' in expectation) {
    const petLines = result.world.voice.spoken.filter((line) => line.speaker === 'pet');
    if (expectation.spoke === 'nothing') {
      assert.equal(
        petLines.length,
        0,
        `[${name}] 期望一句都没说，实际：${JSON.stringify(petLines.map((line) => line.text))}`,
      );
      return;
    }
    const matched = petLines.filter((line) => expectation.spoke instanceof RegExp && expectation.spoke.test(line.text));
    if (expectation.times === undefined) {
      assert.ok(
        matched.length > 0,
        `[${name}] 期望说过 ${String(expectation.spoke)}，实际：${JSON.stringify(petLines.map((line) => line.text))}`,
      );
      return;
    }
    assert.equal(
      matched.length,
      expectation.times,
      `[${name}] ${String(expectation.spoke)} 的出现次数不对（实际 ${matched.length}）`,
    );
    return;
  }
  const calls = result.world.device.calls.map((call) => call.op);
  for (const op of expectation.calls) {
    assert.ok(calls.includes(op), `[${name}] 期望下发过 ${op}，实际：${JSON.stringify(calls)}`);
  }
}

// ---------------------------------------------------------------- 场景库

const LONG = '今天天气不错，要不要出去走走看看？';
const CHATTER = '哥，那辆车好吵。';

export const SCENARIOS: readonly Scenario[] = [
  {
    name: '安静久了主动搭话',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+22m',
    expect: [
      { spoke: /哥，那辆车好吵/, times: 1 },
      { pet: 'ignored', reason: 'chatter' },
    ],
  },
  {
    name: '不到门槛不开口',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+19m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '用户说话了：闲置计时重置',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+18m', do: 'say', text: '帮我看看这个' },
    ],
    horizon: '+33m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '重新安静够了才开口',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+18m', do: 'say', text: '帮我看看这个' },
    ],
    horizon: '+42m',
    expect: [{ spoke: /哥，那辆车好吵/, times: 1 }],
  },
  {
    name: '离场回来打招呼，只说一次',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: '回来啦。' } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'wear', wearing: false },
      { at: '+20m', do: 'wear', wearing: true },
    ],
    horizon: '+30m',
    expect: [
      { spoke: /回来啦/, times: 1 },
    ],
  },
  {
    name: '离场一会儿就回来：不打招呼',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: '回来啦。' } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'wear', wearing: false },
      { at: '+1m30s', do: 'wear', wearing: true },
    ],
    horizon: '+10m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '拍照永不回：照常开口，但不假装看见',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: '嗯，在呢。' } }], capture: 'never' },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { spoke: /嗯，在呢/, times: 1 },
      {
        check: (world) => {
          const asked = world.agent.asked[0];
          assert.ok(asked !== undefined, 'agent 应当被问过');
          assert.equal(asked.image, null, '超时的 look 必须交出 null 画面');
          assert.equal(asked.context.hasImage, true, '计划里有 look，上下文要说明本想看一眼');
        },
      },
    ],
  },
  {
    name: '播报在播：让位',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'announce-pending' },
      { at: '+21m', do: 'announce-clear' },
    ],
    horizon: '+25m',
    expect: [{ spoke: /哥，那辆车好吵/, times: 1 }],
  },
  {
    name: '深夜不搭话',
    device: 'xiaomi-full',
    startAt: '2026-11-14T22:40',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+60m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '深夜回来照旧打招呼',
    device: 'xiaomi-full',
    startAt: '2026-11-14T22:00',
    world: { agent: [{ reply: { text: '回来啦。' } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'wear', wearing: false },
      { at: '+70m', do: 'wear', wearing: true },
    ],
    horizon: '+80m',
    expect: [{ spoke: /回来啦/, times: 1 }],
  },
  {
    name: '电量低不搭话；读不到电量不受限',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'battery', percent: 15 },
      { at: '+30m', do: 'battery', percent: null },
    ],
    horizon: '+34m',
    expect: [{ spoke: /哥，那辆车好吵/, times: 1 }],
  },
  {
    name: '读不到佩戴就不主动开口',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: null }],
    horizon: '+60m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '设备不报佩戴：永远不主动开口',
    device: 'xiaomi',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+60m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '说话被用户打断：算 engaged',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: LONG } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+20m2s', do: 'partial' },
    ],
    horizon: '+24m',
    expect: [
      { pet: 'engaged' },
      { check: (world) => { assert.equal(world.voice.spoken[0]?.result, 'cut'); } },
    ],
  },
  {
    name: '敲击打断：dismissed 且立刻停播',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: LONG } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+20m2s', do: 'tap' },
    ],
    horizon: '+24m',
    expect: [
      { pet: 'dismissed' },
      { check: (world) => { assert.equal(world.voice.spoken[0]?.result, 'cut'); } },
    ],
  },
  {
    name: '模型选择不说：declined',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: '   ' } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { pet: 'declined' },
      { spoke: 'nothing' },
    ],
  },
  {
    name: 'agent 出错：failed，不重试同一候选',
    device: 'xiaomi-full',
    world: { agent: [{ reply: new Error('模型挂了') }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+26m',
    expect: [
      { pet: 'failed' },
      { spoke: 'nothing' },
      { check: (world) => { assert.equal(world.agent.asked.length, 1, '同一段安静只撞一次错'); } },
    ],
  },
  {
    name: '敲击（没开麦）给快反射，且重置闲置',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+19m', do: 'tap' },
    ],
    horizon: '+23m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '会开语音会话的敲击不当作宠物回合',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+19m', do: 'tap', opensSession: true },
    ],
    horizon: '+23m',
    expect: [{ spoke: /哥，那辆车好吵/, times: 1 }],
  },
  {
    name: '连接关闭：在途开口记 aborted',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: LONG } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+20m2s', do: 'close' },
    ],
    horizon: '+22m',
    expect: [{ pet: 'aborted' }],
  },
  {
    name: '关闭之后不再开口',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'close' },
    ],
    horizon: '+60m',
    expect: [{ spoke: 'nothing' }],
  },
  {
    name: '敲击关播报：不伪造一条结局',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'announce-pending' },
      { at: '+2m', do: 'tap' },
    ],
    horizon: '+5m',
    expect: [
      { outcomes: [] },
      {
        check: (world) => {
          assert.ok(
            world.timeline.some((event) => event.src === 'pet.in' && event.kind === 'announce.dismissed'),
            '应当发出 announce.dismissed',
          );
        },
      },
    ],
  },
  {
    name: '设备不支持被动拍照：不排 look 阶段',
    device: 'no-camera',
    world: { agent: [{ reply: { text: '嗯。' } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { spoke: /嗯。/, times: 1 },
      {
        check: (world) => {
          assert.equal(world.device.of('capture').length, 0, '不该下发 capture');
          assert.equal(world.agent.asked[0]?.context.hasImage, false);
        },
      },
    ],
  },
  {
    name: '播报出声会推迟下一次搭话',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      // 19:00 播一条：锚点还在 0（闲置到 20 分钟），但 minGap 会把搭话推到 29:00
      { at: '+19m', do: 'announce', text: '后台那条跑完了。' },
    ],
    horizon: '+28m',
    expect: [
      { spoke: 'nothing' },
      { check: (world) => {
        assert.equal(world.voice.spoken.filter((line) => line.speaker === 'announce').length, 1);
      } },
    ],
  },
  {
    // ADR-0001 §5.3 的例子：播报在 19 分钟说完，搭话从 20 分钟推到 29 分钟。
    // 去掉 `minGap` 闸门时这条**必须**失败。
    name: 'minGap：播报把搭话推后到 29 分钟',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+19m', do: 'announce', text: '后台那条跑完了。' },
    ],
    horizon: '+31m',
    expect: [
      { spoke: /哥，那辆车好吵/, times: 1 },
      {
        check: (world) => {
          const petLines = world.voice.spoken.filter((line) => line.speaker === 'pet');
          const first = petLines[0];
          assert.ok(first !== undefined);
          assert.ok(
            first.at >= 29 * MIN,
            `搭话发生在 ${Math.round(first.at / MIN)} 分钟，应当被 minGap 推到 29 分钟之后`,
          );
        },
      },
    ],
  },
  {
    // 不变量 ⑫：look 超时之后、compose 进行中才到的图，不能进 agent
    name: '晚到的图不进 agent（look 超时后才回）',
    device: 'xiaomi-full',
    params: { captureTimeoutMs: 4_000 },
    world: {
      capture: 'late',
      captureLatencyMs: 6_000,
      agent: [{ latencyMs: 10_000, reply: { text: '嗯，在呢。' } }],
    },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { spoke: /嗯，在呢/, times: 1 },
      {
        check: (world, result) => {
          const asked = world.agent.asked[0];
          assert.ok(asked !== undefined);
          assert.equal(asked.image, null, 'look 超时后到的图必须被丢掉，不能交给 agent');
          assert.equal(asked.context.hasImage, true);
          // 图确实到过设备侧（否则这条场景什么也没测）
          assert.ok(
            result.world.timeline.some((event) => event.src === 'device' && event.kind === 'image'),
            '应当在 look 之后真的收到过一张图',
          );
        },
      },
    ],
  },
  {
    name: '开麦成功：结局记 micOpened=true，且下发过 listen.stop',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { spoke: /哥，那辆车好吵/, times: 1 },
      { calls: ['listen.start', 'listen.stop'] },
      {
        check: (world, result) => {
          // 先开麦、再开口：`voice/start` 必须晚于 `call/listen.start`
          const listen = world.timeline.find((event) => event.src === 'call' && event.kind === 'listen.start');
          const speak = world.timeline.find((event) => event.src === 'voice' && event.kind === 'start');
          assert.ok(listen !== undefined && speak !== undefined);
          assert.ok(speak.t > listen.t, '开口必须晚于开麦');
          // 结局记了麦开了
          const end = result.world.timeline.find((event) => event.src === 'pet.out' && event.kind === 'end');
          assert.ok(end !== undefined);
          assert.equal(end['micOpened'], true, '结局要记 micOpened=true');
        },
      },
    ],
  },
  {
    name: '开麦超时：照常开口，结局记 micOpened=false',
    device: 'xiaomi-full',
    params: { micOpenTimeoutMs: 1_500 },
    world: { agent: [{ reply: { text: CHATTER } }], micOpenLatencyMs: null },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+24m',
    expect: [
      { spoke: /哥，那辆车好吵/, times: 1 },
      {
        check: (world, result) => {
          assert.equal(
            world.timeline.some((event) => event.src === 'device' && event.kind === 'micOpened'),
            false,
            '这条场景里麦永远不开',
          );
          // 开口要晚于 listen.start，且至少等了超时时长
          const listen = world.timeline.find((event) => event.src === 'call' && event.kind === 'listen.start');
          const speak = world.timeline.find((event) => event.src === 'voice' && event.kind === 'start');
          assert.ok(listen !== undefined && speak !== undefined);
          assert.ok(speak.t - listen.t >= 1_500, `只等了 ${speak.t - listen.t} ms，应当等到 1.5 s 超时`);
          const end = result.world.timeline.find((event) => event.src === 'pet.out' && event.kind === 'end');
          assert.ok(end !== undefined);
          assert.equal(end['micOpened'], false, '结局要记 micOpened=false');
        },
      },
    ],
  },
  {
    name: '设备不支持开麦：计划里没有 listen，也不下发 listen.start',
    device: 'no-mic',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { spoke: /哥，那辆车好吵/, times: 1 },
      {
        check: (world) => {
          assert.equal(
            world.device.of('listen.start').length,
            0,
            '不支持 listenStart 的设备不该收到 listen.start',
          );
        },
      },
    ],
  },
  {
    // 断言的是"什么时候、因为什么关麦"，不只是"最后关过麦"：
    // 关早了（比如一进 speak 就关）也算失败。
    name: '敲击打断：在敲击那一刻关麦，且只关一次',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: LONG } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+20m2s', do: 'tap' },
    ],
    horizon: '+24m',
    expect: [
      { pet: 'dismissed' },
      {
        check: (world) => {
          const tap = parseAt('+20m2s');
          const stops = world.timeline.filter((event) => event.src === 'call' && event.kind === 'listen.stop');
          assert.equal(stops.length, 1, `敲击只该关一次麦，实际 ${stops.length} 次`);
          const stop = stops[0];
          assert.ok(stop !== undefined);
          assert.ok(
            stop.t >= tap,
            `关麦发生在 ${stop.t}，早于敲击 ${tap} —— 说明是别的原因关的，不是敲击`,
          );
          // 上一次出声在敲击之后才结束，说明确实是打断而不是自然播完
          const end = world.timeline.find(
            (event) => event.src === 'voice' && event.kind === 'end' && event['speaker'] === 'pet',
          );
          assert.ok(end !== undefined);
          assert.equal(end['result'], 'cut', '敲击应当把朗读打断，不是让它在敲击前就播完');
        },
      },
    ],
  },
  {
    // ADR-0001 §5.5：`speak` 里的 `userActivity` **不**关麦 ——
    // 用户正在这个会话里说话，会话交给对话层继续。
    name: '播放中用户开口：算 engaged，且不关麦',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: LONG } }] },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+20m3s', do: 'partial' },
    ],
    horizon: '+24m',
    expect: [
      { pet: 'engaged' },
      {
        check: (world, result) => {
          // 连接关闭会补一次 listen.stop；只看关闭之前有没有提前关麦
          const closed = world.timeline.find((event) => event.src === 'system' && event.kind === 'close');
          const closedAt = closed?.t ?? Number.POSITIVE_INFINITY;
          const early = world.timeline.filter(
            (event) => event.src === 'call' && event.kind === 'listen.stop' && event.t < closedAt,
          );
          assert.deepEqual(
            early.map((event) => event.t),
            [],
            `用户开口不该关麦，却在 ${JSON.stringify(early.map((event) => event.t))} 关过`,
          );
          // 结局里 closeMic 也不能是 true
          const end = result.world.timeline.find((event) => event.src === 'pet.out' && event.kind === 'end');
          assert.ok(end !== undefined);
          assert.equal(end['closeMic'], false, 'userActivity 的决断不该带 closeMic');
        },
      },
    ],
  },
  {
    // ADR-0001 §6：播报也先开麦、等首帧（超时照播），整批播完才关。
    name: '播报也先开麦：等首帧再出声，播完才关麦',
    device: 'xiaomi-full',
    world: { agent: [{ reply: { text: CHATTER } }], micOpenLatencyMs: 620 },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'announce', text: '后台那条跑完了。' },
    ],
    horizon: '+3m',
    expect: [
      {
        check: (world) => {
          const start = world.timeline.find((event) => event.src === 'call' && event.kind === 'listen.start');
          const spoken = world.timeline.find(
            (event) => event.src === 'voice' && event.kind === 'start' && event['speaker'] === 'announce',
          );
          const stopped = world.timeline.find((event) => event.src === 'call' && event.kind === 'listen.stop');
          const end = world.timeline.find(
            (event) => event.src === 'voice' && event.kind === 'end' && event['speaker'] === 'announce',
          );
          assert.ok(start !== undefined, '播报应当先开麦');
          assert.ok(spoken !== undefined, '播报应当真的出声');
          assert.ok(start.t < spoken.t, '开麦必须在出声之前');
          assert.ok(
            spoken.t - start.t >= 620,
            `只等了 ${spoken.t - start.t} ms，应当在首帧上行（620 ms）之后才开口`,
          );
          assert.ok(stopped !== undefined, '播完应当关麦');
          assert.ok(end !== undefined);
          assert.ok(stopped.t >= end.t, '关麦必须在播完之后');
        },
      },
    ],
  },
  {
    // 麦一直不开时，播报也不能被拖住：等满 1.5 s 就照播
    name: '播报开麦超时：照常出声',
    device: 'xiaomi-full',
    params: { micOpenTimeoutMs: 1_500 },
    world: { agent: [{ reply: { text: CHATTER } }], micOpenLatencyMs: null },
    script: [
      { at: '+0', do: 'wear', wearing: true },
      { at: '+1m', do: 'announce', text: '后台那条跑完了。' },
    ],
    horizon: '+3m',
    expect: [
      {
        check: (world) => {
          const start = world.timeline.find((event) => event.src === 'call' && event.kind === 'listen.start');
          const spoken = world.timeline.find(
            (event) => event.src === 'voice' && event.kind === 'start' && event['speaker'] === 'announce',
          );
          assert.ok(start !== undefined && spoken !== undefined);
          const waited = spoken.t - start.t;
          assert.ok(waited >= 1_500, `只等了 ${waited} ms，应当等满 1.5 s 超时`);
          assert.ok(waited < 3_000, `等了 ${waited} ms，超时不该更久`);
        },
      },
    ],
  },
  {
    name: 'v2 设备也能跑：能力集换成通用档',
    device: 'v2-generic',
    world: { agent: [{ reply: { text: CHATTER } }] },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
    expect: [
      { spoke: /哥，那辆车好吵/, times: 1 },
      { calls: ['capture', 'listen.start'] },
    ],
  },
];

/** 跑全部场景。 */
export async function runAllScenarios(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const scenario of SCENARIOS) {
    try {
      await runScenario(scenario);
      results.push({ name: scenario.name, ok: true });
    } catch (error) {
      results.push({ name: scenario.name, ok: false, error: (error as Error).message });
    }
  }
  return results;
}
