/**
 * 随机探索与收缩。
 *
 * 对应 ADR-0002 §3.6。只检查不变量（不做场景自己的断言），发现违反就把步骤序列
 * **逐步删到最短**，输出成可以直接粘进 `scenarios.ts` 的声明式场景。
 *
 * 覆盖范围（§3.6 列的那几类）：
 * - 戴摘 / 说话 / 插话 / 敲击 / 电量 / 播报
 * - **agent 延迟与报错**（含永不返回）
 * - **拍照失败 / 回图晚于截止**（`fail` / `late` / `never`）
 * - **跨越深夜**：起始墙钟随机，含 22:00–03:00 这一段
 */
import type { Violation } from './timeline.ts';
import type { DevicePreset, SimWorldConfig } from './world.ts';
import { runScenario, type Scenario, type Step } from './scenarios.ts';

// ---------------------------------------------------------------- 随机源

/** mulberry32：小而确定的种子随机数。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, list: readonly T[]): T {
  const item = list[Math.floor(next() * list.length)];
  if (item === undefined) {
    throw new Error('pet: 空的候选列表');
  }
  return item;
}

// ---------------------------------------------------------------- 世界与步骤

const DEVICES: readonly DevicePreset[] = ['xiaomi-full', 'xiaomi', 'no-camera', 'v2-generic'];
const CAPTURES = ['ok', 'never', 'fail', 'late'] as const;
const REPLIES = ['嗯，在呢。', '哥，那辆车好吵。', '回来啦。', '   '] as const;

/**
 * 起始墙钟：一半落在全天随机，另一半落在**22:00–27:00**（即凌晨 3 点），
 * 这样"跨越深夜"能被真的走到。
 */
function randomStartMinute(next: () => number): number {
  if (next() < 0.5) {
    return Math.floor(next() * 24 * 60);
  }
  return 22 * 60 + Math.floor(next() * 5 * 60);
}

function randomWorld(next: () => number): SimWorldConfig {
  const capture = pick(next, CAPTURES);
  // `late` 要给一个确定晚于默认截止（4 s）的延迟
  const captureLatencyMs = capture === 'late'
    ? 5_000 + Math.floor(next() * 4_000)
    : 200 + Math.floor(next() * 1_500);
  const agent: Array<{ latencyMs?: number; reply?: unknown }> = [];
  const replies = 1 + Math.floor(next() * 2);
  for (let index = 0; index < replies; index += 1) {
    const roll = next();
    if (roll < 0.12) {
      agent.push({ latencyMs: 200, reply: new Error('模型挂了') });
    } else if (roll < 0.2) {
      agent.push({ reply: null });
    } else {
      agent.push({ latencyMs: Math.floor(next() * 4_000), reply: { text: pick(next, REPLIES) } });
    }
  }
  return { capture, captureLatencyMs, agent: agent as SimWorldConfig['agent'] };
}

/** 一个随机步骤（细节也随机）。 */
function randomStep(next: () => number, atMs: number): Step {
  const at = `+${Math.round(atMs / 1000)}s`;
  const kind = next();
  if (kind < 0.3) {
    const wearing = next();
    return { at, do: 'wear', wearing: wearing < 0.55 ? true : wearing < 0.8 ? false : null };
  }
  if (kind < 0.45) {
    return { at, do: 'say', text: '帮我看看这个' };
  }
  if (kind < 0.55) {
    return { at, do: 'partial' };
  }
  if (kind < 0.65) {
    return { at, do: 'tap', opensSession: next() < 0.3 };
  }
  if (kind < 0.75) {
    return { at, do: 'battery', percent: next() < 0.5 ? Math.round(next() * 100) : null };
  }
  if (kind < 0.85) {
    return { at, do: 'announce-pending' };
  }
  if (kind < 0.92) {
    return { at, do: 'announce-clear' };
  }
  return { at, do: 'close' };
}

// ---------------------------------------------------------------- 探索

export interface ExploreRun {
  readonly seed: number;
  readonly run: number;
  readonly device: DevicePreset;
  readonly startAt: string;
  readonly world: SimWorldConfig;
  readonly violations: readonly Violation[];
  /** 收缩后的最小复现 */
  readonly minimal: readonly Step[];
}

export interface ExploreOptions {
  readonly seed: number;
  readonly runs: number;
  /** 每次探索的时间跨度 */
  readonly horizonMs: number;
  readonly maxSteps?: number;
}

function clockLabel(minute: number): string {
  const hh = Math.floor(minute / 60) % 24;
  const mm = minute % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

type Base = Omit<Scenario, 'script' | 'name'>;

async function attempt(base: Base, script: readonly Step[]): Promise<readonly Violation[] | null> {
  try {
    await runScenario({ ...base, name: `explore ${base.device}`, script });
    return null;
  } catch (error) {
    const violations = (error as { violations?: Violation[] }).violations;
    if (violations !== undefined && violations.length > 0) {
      return violations;
    }
    // 断言失败 / 抛错也算问题：说明这条输入序列把状态机打崩了
    return [{ rule: '?', at: 0, detail: (error as Error).message.split('\n')[0] ?? '未知失败' }];
  }
}

/**
 * 收缩：逐个删步骤，直到删不动为止。
 *
 * 从后往前删 —— 前面的事件往往是"把世界摆到位"的前提，删了就不复现了。
 */
async function shrink(base: Base, script: readonly Step[]): Promise<Step[]> {
  let best = [...script];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = best.length - 1; index >= 0; index -= 1) {
      const candidate = [...best.slice(0, index), ...best.slice(index + 1)];
      if (!candidate.some((step) => step.do === 'wear')) {
        continue;
      }
      const violations = await attempt(base, candidate);
      if (violations !== null) {
        best = candidate;
        changed = true;
      }
    }
  }
  return best;
}

function parseSeconds(at: string): number {
  const match = /^\+(\d+)s$/.exec(at);
  return match === null ? 0 : Number(match[1]);
}

/** 跑一轮随机探索。 */
export async function explore(options: ExploreOptions): Promise<ExploreRun[]> {
  const next = rng(options.seed);
  const failures: ExploreRun[] = [];
  const maxSteps = options.maxSteps ?? 12;

  for (let run = 0; run < options.runs; run += 1) {
    const device = pick(next, DEVICES);
    const startMinute = randomStartMinute(next);
    const world = randomWorld(next);
    const count = 1 + Math.floor(next() * maxSteps);
    const script: Step[] = [];
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      at += Math.round(next() * (options.horizonMs / (count + 1)));
      script.push(randomStep(next, at));
    }
    // 起手必须有"戴着"：否则什么都不会发生，探索没有意义
    script.unshift({ at: '+0', do: 'wear', wearing: true });
    script.sort((a, b) => parseSeconds(a.at) - parseSeconds(b.at));

    const base: Base = {
      device,
      startAt: `2026-11-14T${clockLabel(startMinute)}`,
      world,
    };
    const startAt = base.startAt ?? '2026-11-14T12:00';

    const violations = await attempt(base, script);
    if (violations === null) {
      continue;
    }
    const minimal = await shrink(base, script);
    failures.push({
      seed: options.seed,
      run,
      device,
      startAt,
      world,
      violations,
      minimal,
    });
  }
  return failures;
}

/** 把收缩结果打印成可以直接粘进 `scenarios.ts` 的形状。 */
export function formatRepro(failure: ExploreRun): string {
  const script = failure.minimal
    .map((step) => `      ${JSON.stringify(step)},`)
    .join('\n');
  return [
    `  {`,
    `    name: '探索复现 seed=${failure.seed} run=${failure.run}',`,
    `    device: '${failure.device}',`,
    `    startAt: '${failure.startAt}',`,
    `    world: ${JSON.stringify(failure.world)},`,
    `    script: [`,
    script,
    `    ],`,
    `    // 违反：${failure.violations.map((violation) => `${violation.rule} ${violation.detail}`).join('；')}`,
    `  },`,
  ].join('\n');
}
