/**
 * 三张登记表：**闸门**（Gate）、**触发器**（Trigger）、**阶段**（Phase）。
 *
 * 对应 ADR-0001 §5.3–§5.6。纪律：加东西只往表里加，**不改 reducer 内核**。
 * 需要改内核时说明扩展面设计错了，应先回到 ADR 修订。
 */
import type { DeviceCapabilities } from '../../devices/primitives.ts';
import { canCaptureUnprompted } from '../../devices/primitives.ts';
import { DEFAULT_PET_TIMING, type PetTimingOptions } from '../pet-timing.ts';
import type {
  GateId,
  Interrupt,
  PhaseId,
  Reason,
  Verdict,
  PetWorld,
} from './types.ts';

// ---------------------------------------------------------------- 参数

/** 宠物层的全部可调参数。时机那六项沿用 `PetTimingOptions`，不另立一套。 */
export interface PetParams extends PetTimingOptions {
  /** `look` 阶段等图的兜底时长（ms） */
  readonly captureTimeoutMs: number;
  /** `compose` 阶段等回复的兜底时长（ms） */
  readonly composeTimeoutMs: number;
  /** `listen` 阶段等首帧上行的兜底时长（ms）。超时也照常开口 */
  readonly micOpenTimeoutMs: number;
  /** `await` 阶段给用户的回应窗口（ms） */
  readonly replyWindowMs: number;
  /** 开麦后的预期听音时长（ms），会加到 `listen.start` 的 `maxMs` 上 */
  readonly listenMs: number;
}

export const DEFAULT_PET_PARAMS: PetParams = {
  ...DEFAULT_PET_TIMING,
  captureTimeoutMs: 4_000,
  composeTimeoutMs: 15_000,
  // 小米拉起会话实测约 0.62 s 出首帧上行（`Aivs` id=10），这里留一倍余量
  micOpenTimeoutMs: 1_500,
  replyWindowMs: 8_000,
  listenMs: 8_000,
};

/**
 * 估算朗读时长：中文口语大约 5 字/秒，再加一段起播开销。
 *
 * 只用于两件事：`listen.start` 的 `maxMs`，以及模拟器推进虚拟时钟。
 * **不参与任何判定** —— 判定只看 `Voice` 报回的 `done` / `cut`。
 */
export function estimateSpeechMs(text: string, perChar = 180, floorMs = 1_200): number {
  return Math.max(floorMs, [...text].length * perChar);
}

// ---------------------------------------------------------------- 闸门（扩展点 A 的一半）

/** 闸门：命名的纯谓词。被挡时档案记下闸门名。 */
export type GateFn = (w: PetWorld, p: PetParams) => boolean;

/** 深夜判定：支持跨零点区间（`from > to`）。 */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

export const GATES: Record<GateId, GateFn> = {
  /** 必须**明确戴着**。`null`（读不到）不通过 —— 不知道就不打扰。 */
  worn: (w) => w.wearing === true,
  /** 话筒空着，且没有待播的后台汇报 */
  floorFree: (w) => !w.floorBusy && !w.announcePending,
  notQuietHours: (w, p) => !inQuietHours(w.localHour, p.quietFromHour, p.quietToHour),
  /** 读不到电量时不受限（`null` 不是"没电"） */
  batteryOk: (w, p) => w.battery === null || w.battery > p.lowBatteryPercent,
  minGap: (w, p) => w.lastVoiceAt === null || w.now - w.lastVoiceAt >= p.minProactiveGapMs,
};

// ---------------------------------------------------------------- 触发器（扩展点 A）

/** 一个候选：去重键 + 供 agent 的补充事实。 */
export interface Candidate {
  readonly key: string;
  readonly elapsedMs: number;
  readonly notes?: Readonly<Record<string, string | number | boolean>>;
}

export interface Trigger {
  readonly reason: Reason;
  /** 同一 tick 多个候选时取大者 */
  readonly priority: number;
  /** 引用闸门表，**不内联条件** */
  readonly gates: readonly GateId[];
  /** 这次要按什么顺序走阶段 */
  readonly plan: (w: PetWorld) => readonly PhaseId[];
  /**
   * 是否够格。
   *
   * @param fired 已经触发过的键；实现必须自己判重
   * @returns 不够格时 `null`
   */
  readonly candidate: (w: PetWorld, fired: ReadonlySet<string>, p: PetParams) => Candidate | null;
}

/**
 * 计划的骨架。
 *
 * `look`：设备能**不用人动手**地看一眼才先拍。
 * `listen`：设备支持 `listen.start` 才在 `compose` 之后、`speak` 之前开麦 ——
 * agent 想话最长 15 s，这段时间不该开着麦（ADR-0001 §5.4）。
 */
export function planFor(reason: Reason, caps: DeviceCapabilities): readonly PhaseId[] {
  void reason;
  const plan: PhaseId[] = [];
  if (canCaptureUnprompted(caps, 'glance')) {
    plan.push('look');
  }
  plan.push('compose');
  if (caps.listenStart) {
    plan.push('listen');
  }
  plan.push('speak', 'await');
  return plan;
}

/**
 * 闲置锚点：**只看用户的动静** —— 用户说话、普通敲击、戴回。
 *
 * 宠物自己说话、后台播报出声都**不**重置闲置计时（ADR-0001 §5.3 修订）：
 * 它们由 `minGap` 管。否则"搭话门槛 20 分钟 > 最小间隔 10 分钟"会让 `minGap`
 * 永远挡不住任何东西 —— 验收时的变异测试就是这么发现它形同虚设的。
 */
function idleAnchor(w: PetWorld): number | null {
  const candidates = [w.lastUserAt, w.donnedAt].filter((v): v is number => v !== null);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

export const TRIGGERS: readonly Trigger[] = [
  {
    reason: 'greet',
    priority: 20,
    // 打招呼不受深夜 / 电量 / 最小间隔限制：回来的第一句比「不打扰」重要
    gates: ['worn', 'floorFree'],
    plan: (w) => planFor('greet', w.caps),
    candidate: (w, fired, p) => {
      if (w.donnedAt === null || w.lastAwayMs === null) {
        return null;
      }
      if (w.lastAwayMs < p.greetAfterAwayMs) {
        return null;
      }
      const key = `greet:${w.donnedAt}`;
      return fired.has(key) ? null : { key, elapsedMs: w.lastAwayMs };
    },
  },
  {
    reason: 'chatter',
    priority: 10,
    gates: ['worn', 'floorFree', 'notQuietHours', 'batteryOk', 'minGap'],
    plan: (w) => planFor('chatter', w.caps),
    candidate: (w, fired, p) => {
      const anchor = idleAnchor(w);
      if (anchor === null) {
        return null;
      }
      const idleMs = w.now - anchor;
      if (idleMs < p.chatterAfterIdleMs) {
        return null;
      }
      const key = `chatter:${anchor}`;
      const notes = w.battery === null ? undefined : { battery: w.battery };
      return fired.has(key) ? null : { key, elapsedMs: idleMs, notes };
    },
  },
];

// ---------------------------------------------------------------- 阶段（扩展点 B）

/** 阶段规格。`onResult` / `onInterrupt` 是 `Record`，漏填一格就是类型错误。 */
export interface PhaseSpec<R extends string = string> {
  readonly id: PhaseId;
  /** 本阶段可能报回的结果；`timeout` 隐含存在，不必列 */
  readonly results: readonly R[];
  /** 截止时长；`null` = 无截止（由 `Voice` 自己结束） */
  readonly deadlineMs: (p: PetParams) => number | null;
  /** 这一阶段要不要把话筒占成 `pet` */
  readonly holdsFloor: boolean;
  readonly onResult: Record<R | 'timeout', Verdict>;
  readonly onInterrupt: Record<Interrupt, Verdict>;
}

/** 构造时把窄类型抹平成 `PhaseSpec`，但**定义处**仍然强制填满每一格。 */
function phase<R extends string>(spec: PhaseSpec<R>): PhaseSpec {
  return spec as unknown as PhaseSpec;
}

const abandonAll: Record<Interrupt, Verdict> = {
  userActivity: { kind: 'end', outcome: 'abandoned' },
  tap: { kind: 'end', outcome: 'abandoned' },
  presenceLost: { kind: 'end', outcome: 'abandoned' },
  floorTaken: { kind: 'end', outcome: 'abandoned' },
};

export const PHASES: Record<PhaseId, PhaseSpec> = {
  /** 看一眼：只在设备能不用人动手地拍 `glance` 时才进计划 */
  look: phase({
    id: 'look',
    results: ['got', 'none'],
    deadlineMs: (p) => p.captureTimeoutMs,
    holdsFloor: false,
    onResult: {
      // 没拍到也照常开口，只是 bag.image 为 null（别假装看见了）
      got: { kind: 'next' },
      none: { kind: 'next' },
      timeout: { kind: 'next' },
    },
    onInterrupt: abandonAll,
  }),
  /** 要一句话 */
  compose: phase({
    id: 'compose',
    results: ['reply', 'declined', 'error'],
    deadlineMs: (p) => p.composeTimeoutMs,
    holdsFloor: false,
    onResult: {
      reply: { kind: 'next' },
      declined: { kind: 'end', outcome: 'declined' },
      error: { kind: 'end', outcome: 'failed' },
      timeout: { kind: 'end', outcome: 'failed' },
    },
    onInterrupt: abandonAll,
  }),
  /**
   * 开麦、等首帧上行。
   *
   * 只决定"能不能被插话"，不决定"能不能说"：超时照样开口，结局里记 `micOpened: false`。
   * 小米没有会话时也能出声 —— 宁可听不见插话，也不能沉默（ADR-0001 §5.4）。
   */
  listen: phase({
    id: 'listen',
    results: ['opened'],
    deadlineMs: (p) => p.micOpenTimeoutMs,
    holdsFloor: true,
    onResult: {
      opened: { kind: 'next' },
      timeout: { kind: 'next' },
    },
    onInterrupt: {
      // 用户已经在说这个会话里的话：麦留着，交给 dialogue 层继续
      userActivity: { kind: 'end', outcome: 'abandoned' },
      tap: { kind: 'end', outcome: 'abandoned', closeMic: true },
      presenceLost: { kind: 'end', outcome: 'abandoned', closeMic: true },
      floorTaken: { kind: 'end', outcome: 'abandoned' },
    },
  }),
  /** 念出来 */
  speak: phase({
    id: 'speak',
    results: ['done', 'cut', 'error'],
    deadlineMs: () => null,
    holdsFloor: true,
    onResult: {
      done: { kind: 'next' },
      // `cut` 是被停播/打断：用户接住了，算 engaged
      cut: { kind: 'end', outcome: 'engaged' },
      // 朗读抛错不是被打断。再报 `cut` 会把故障记成 engaged
      error: { kind: 'end', outcome: 'failed' },
      // speak 没有截止，这条只是补齐类型；真出现按失败算
      timeout: { kind: 'end', outcome: 'failed' },
    },
    onInterrupt: {
      userActivity: { kind: 'end', outcome: 'engaged' },
      tap: { kind: 'end', outcome: 'dismissed', dismiss: true, closeMic: true },
      presenceLost: { kind: 'end', outcome: 'aborted', dismiss: true, closeMic: true },
      floorTaken: { kind: 'end', outcome: 'aborted' },
    },
  }),
  /** 等一会儿，看用户接不接话 */
  await: phase({
    id: 'await',
    results: ['expired'],
    deadlineMs: (p) => p.replyWindowMs,
    holdsFloor: false,
    onResult: {
      expired: { kind: 'end', outcome: 'ignored', closeMic: true },
      timeout: { kind: 'end', outcome: 'ignored', closeMic: true },
    },
    onInterrupt: {
      userActivity: { kind: 'end', outcome: 'engaged' },
      tap: { kind: 'end', outcome: 'dismissed', closeMic: true },
      presenceLost: { kind: 'end', outcome: 'aborted', closeMic: true },
      // await 里的 floorTaken 只可能是用户从别的入口发起了对话
      floorTaken: { kind: 'end', outcome: 'engaged' },
    },
  }),
};

// ---------------------------------------------------------------- 计划校验

/**
 * 启动时对每个触发器跑一遍，把"计划写错了"从运行时错误提前到启动失败。
 *
 * @throws 计划为空 / 缺 `speak` / `speak` 在 `compose` 之前 / 阶段重复 / 末阶段还能 `next`
 */
export function validatePlan(plan: readonly PhaseId[], label: string): void {
  if (plan.length === 0) {
    throw new Error(`pet: ${label} 的计划为空`);
  }
  if (new Set(plan).size !== plan.length) {
    throw new Error(`pet: ${label} 的计划里有重复阶段：${plan.join(' → ')}`);
  }
  const speak = plan.indexOf('speak');
  const compose = plan.indexOf('compose');
  if (speak < 0) {
    throw new Error(`pet: ${label} 的计划缺 speak：${plan.join(' → ')}`);
  }
  if (compose < 0 || speak < compose) {
    throw new Error(`pet: ${label} 的计划里 speak 必须在 compose 之后：${plan.join(' → ')}`);
  }
  // `listen` 若在计划里，必须紧挨在 `speak` 之前
  const listen = plan.indexOf('listen');
  if (listen >= 0 && plan[listen + 1] !== 'speak') {
    throw new Error(`pet: ${label} 的计划里 listen 必须紧挨在 speak 之前：${plan.join(' → ')}`);
  }
  const last = plan[plan.length - 1];
  const spec = last === undefined ? undefined : PHASES[last];
  if (spec === undefined) {
    throw new Error(`pet: ${label} 的计划末阶段未知：${String(last)}`);
  }
  // 末阶段的所有决断都必须是 end，否则会走进 plan 之外
  for (const [result, verdict] of Object.entries(spec.onResult)) {
    if (verdict.kind !== 'end') {
      throw new Error(`pet: ${label} 的末阶段 ${spec.id} 在结果 ${result} 上还要 next —— 计划之外没有阶段`);
    }
  }
  for (const [interrupt, verdict] of Object.entries(spec.onInterrupt)) {
    if (verdict.kind !== 'end') {
      throw new Error(`pet: ${label} 的末阶段 ${spec.id} 在打断 ${interrupt} 上还要 next —— 计划之外没有阶段`);
    }
  }
}

/** 对每种能力组合跑一遍计划校验（启动时调用一次）。 */
export function validateAllPlans(): void {
  const combos: DeviceCapabilities[] = [
    { ...BASELINE_CAPS, presence: true },
    { ...BASELINE_CAPS, capture: { glance: { needsUser: false } } },
    { ...BASELINE_CAPS, capture: { glance: { needsUser: true } } },
    { ...BASELINE_CAPS, listenStart: true },
    { ...BASELINE_CAPS, capture: { glance: { needsUser: false } }, listenStart: true },
    { ...BASELINE_CAPS, capture: { glance: { needsUser: true } }, listenStart: true },
  ];
  for (const trigger of TRIGGERS) {
    for (const caps of combos) {
      validatePlan(trigger.plan({ ...EMPTY_WORLD, caps }), trigger.reason);
    }
  }
}

/** 校验用的空世界（只有 `caps` 有意义）。 */
const EMPTY_WORLD: PetWorld = {
  now: 0,
  localHour: 12,
  wearing: null,
  donnedAt: null,
  lastAwayMs: null,
  battery: null,
  lastUserAt: null,
  lastVoiceAt: null,
  floorBusy: false,
  floorOwner: null,
  announcePending: false,
  caps: {
    audioIn: 'msbc',
    capture: {},
    presence: false,
    power: false,
    summon: false,
    listenStart: false,
    played: false,
    ignorePhrases: [],
  },
  awaySince: null,
};

const BASELINE_CAPS: DeviceCapabilities = EMPTY_WORLD.caps;

// 模块加载时就校验一遍：计划写错了该在启动时炸，而不是等到第一次开口
validateAllPlans();
