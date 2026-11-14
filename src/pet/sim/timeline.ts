/**
 * 时间线与不变量。
 *
 * 对应 ADR-0002 §3.5 与 §3.7。**检查是对时间线的纯函数**，不嵌在执行过程里 ——
 * 同一套规则也能拿去离线检查生产档案。
 *
 * 编号沿用 ADR-0001 §8 的十条，再加上 ADR-0002 的 ⑪⑫⑬。
 */
import type { DeviceCapabilities } from '../../devices/primitives.ts';
import type { PetParams } from '../brain/registry.ts';

export type TimelineSource =
  | 'user'
  | 'device'
  | 'agent'
  | 'voice'
  | 'pet.in'
  | 'pet.out'
  | 'floor'
  | 'call'
  | 'announce'
  | 'system';

/** 一条时间线事件。`t` 是单调毫秒，`wallHour` 是当时的本地小时。 */
export interface TimelineEvent {
  readonly t: number;
  readonly wallHour: number;
  readonly src: TimelineSource;
  readonly kind: string;
  readonly [field: string]: unknown;
}

export type Timeline = readonly TimelineEvent[];

/** 一条不变量违反。 */
export interface Violation {
  /** 规则编号，如 `①` */
  readonly rule: string;
  /** 违反发生的时刻 */
  readonly at: number;
  readonly detail: string;
}

/** 收集时间线；`push` 时自动补 `t` / `wallHour`。 */
export class TimelineSink {
  readonly events: TimelineEvent[] = [];
  private readonly stamp: () => { t: number; wallHour: number };

  constructor(stamp: () => { t: number; wallHour: number }) {
    this.stamp = stamp;
  }

  push(src: TimelineSource, kind: string, fields: Record<string, unknown> = {}): void {
    const { t, wallHour } = this.stamp();
    this.events.push({ t, wallHour, src, kind, ...fields });
  }
}

export interface InvariantOptions {
  readonly params: PetParams;
  readonly caps: DeviceCapabilities;
  /** 用户开口之后允许还在响的余量（ADR-0002 ⑪） */
  readonly bargeInGraceMs?: number;
}

interface LiveEngagement {
  readonly id: string;
  readonly reason: string;
  readonly plan: readonly string[];
  readonly startedAt: number;
  readonly wallHour: number;
  readonly wearingAtStart: boolean | null;
  readonly batteryAtStart: number | null;
  sawLook: boolean;
  lookStartedAt: number | null;
  imageDelivered: boolean;
  /** `listen` 已经出过结果（`opened` 或 `timeout`） */
  listened: boolean;
  /** 本次 engagement 发 `listen.start` 的时刻 */
  listenStartedAt: number | null;
  endedAt: number | null;
  outcome: string | null;
}

/**
 * 跑全部不变量。
 *
 * @returns 违反列表；空 = 通过
 */
export function checkInvariants(timeline: Timeline, options: InvariantOptions): Violation[] {
  const violations: Violation[] = [];
  const add = (rule: string, at: number, detail: string): void => {
    violations.push({ rule, at, detail });
  };

  const live = new Map<string, LiveEngagement>();
  let wearing: boolean | null = null;
  let battery: number | null = null;
  let lastVoiceAt: number | null = null;
  let voiceOpen: { at: number; speaker: string; engagementId: string | null } | null = null;
  let lastPartialAt: number | null = null;
  const spokeAt = new Map<string, number[]>();
  const ended = new Set<string>();

  const grace = options.bargeInGraceMs ?? 300;

  for (const event of timeline) {
    switch (`${event.src}/${event.kind}`) {
      // ---------------------------------------------------------- 事实
      case 'device/presence':
        wearing = typeof event['wearing'] === 'boolean' ? event['wearing'] : null;
        break;
      case 'device/power':
        battery = typeof event['percent'] === 'number' ? event['percent'] : null;
        break;

      // ---------------------------------------------------------- 话筒
      case 'floor/acquire':
      case 'floor/release':
        break;

      // ---------------------------------------------------------- 用户
      case 'user/partial':
        lastPartialAt = event.t;
        break;

      // ---------------------------------------------------------- 进阶段
      case 'pet.out/phase.enter': {
        const id = String(event['engagementId']);
        const phase = String(event['phase']);
        const isFirst = phase !== 'compose' || !live.has(id);
        let entry = live.get(id);
        if (entry === undefined) {
          entry = {
            id,
            reason: String(event['reason'] ?? ''),
            plan: Array.isArray(event['plan']) ? (event['plan'] as string[]) : ['compose', 'speak', 'await'],
            startedAt: event.t,
            wallHour: event.wallHour,
            wearingAtStart: wearing,
            batteryAtStart: battery,
            sawLook: false,
            lookStartedAt: null,
            imageDelivered: false,
            listened: false,
            listenStartedAt: null,
            endedAt: null,
            outcome: null,
          };
          live.set(id, entry);

          // ② 同时最多一个 engagement
          const others = [...live.values()].filter((item) => item.id !== id && item.endedAt === null);
          if (others.length > 0) {
            add('②', event.t, `同时有两个 engagement：${others.map((item) => item.id).join(', ')} + ${id}`);
          }
          // ④ 深夜 / 低电量不主动开口（打招呼不受限）
          if (entry.reason !== 'greet') {
            if (inQuiet(event.wallHour, options.params)) {
              add('④', event.t, `${entry.reason} 发生在深夜（${event.wallHour} 点）`);
            }
            if (battery !== null && battery <= options.params.lowBatteryPercent) {
              add('④', event.t, `${entry.reason} 发生在低电量（${battery}%）`);
            }
          }
          // ⑤ 读不到佩戴就不主动开口
          if (entry.wearingAtStart !== true) {
            add('⑤', event.t, `${entry.reason} 发生在 wearing=${String(entry.wearingAtStart)}`);
          }
          void isFirst;
        }
        if (phase === 'look') {
          entry.sawLook = true;
          entry.lookStartedAt = event.t;
        }
        // ⑫ 已经结束的 engagement 不该再进阶段
        if (ended.has(id)) {
          add('⑫', event.t, `${id} 已经结束，却又进了 ${phase}`);
        }
        break;
      }

      // ---------------------------------------------------------- 开麦
      case 'call/listen.start':
        // 最近一次开麦属于当前 engagement（计划里只有 listen 阶段会开麦）
        for (const entry of live.values()) {
          if (entry.endedAt === null && entry.plan.includes('listen')) {
            entry.listenStartedAt = event.t;
          }
        }
        break;
      case 'device/micOpened':
        for (const entry of live.values()) {
          if (entry.endedAt === null && entry.listenStartedAt !== null && !entry.listened) {
            entry.listened = true;
          }
        }
        break;

      // ---------------------------------------------------------- 图片
      case 'device/image': {
        const id = String(event['engagementId'] ?? '');
        const entry = live.get(id);
        if (entry !== undefined && event['image'] !== null) {
          entry.imageDelivered = true;
        }
        break;
      }

      // ---------------------------------------------------------- 结局
      case 'pet.out/end': {
        const id = String(event['id']);
        const entry = live.get(id);
        if (entry === undefined) {
          add('⑦', event.t, `${id} 有结局却没有开始的记录`);
          break;
        }
        if (entry.endedAt !== null) {
          add('⑦', event.t, `${id} 有两条结局`);
        }
        entry.endedAt = event.t;
        entry.outcome = String(event['outcome']);
        ended.add(id);
        break;
      }

      // ---------------------------------------------------------- agent
      case 'agent/ask': {
        // ⑨ 主动开口的 source 必须是 pet
        if (event['sourceKind'] !== 'pet') {
          add('⑨', event.t, `agent 收到的 source.kind 是 ${String(event['sourceKind'])}`);
        }
        const id = String(event['engagementId'] ?? '');
        const entry = live.get(id);
        // ⑧ 说要看一眼却没看到：必须明确告诉模型没有画面
        if (entry !== undefined && entry.sawLook && !entry.imageDelivered && event['withImage'] !== false) {
          add('⑧', event.t, `${id} 的 look 没拿到图，但 ask 仍声称有画面`);
        }
        break;
      }

      // ---------------------------------------------------------- 声音
      case 'voice/start': {
        const speaker = String(event['speaker']);
        const engagementId = typeof event['engagementId'] === 'string' ? event['engagementId'] : null;
        // ① 宠物出声时话筒必须是 pet
        if (speaker === 'pet' && event['floorOwner'] !== 'pet') {
          add('①', event.t, `宠物出声时话筒归属是 ${String(event['floorOwner'])}`);
        }
        // ⑪(listen) 计划含 listen 时，开口不得早于本次 engagement 的 listen 出结果
        if (speaker === 'pet' && engagementId !== null) {
          const entry = live.get(engagementId);
          if (entry !== undefined && entry.plan.includes('listen') && !entry.listened) {
            // 超时也算"出结果"：从开麦起算过 micOpenTimeoutMs 就放过
            const startedAt = entry.listenStartedAt;
            const timedOut = startedAt !== null
              && event.t >= startedAt + options.params.micOpenTimeoutMs;
            if (!timedOut) {
              add('⑪', event.t, `${engagementId} 计划含 listen，但开口前麦还没开也没超时`);
            }
          }
        }
        // ⑪(barge-in) 用户开口后 300 ms 内必须停
        if (speaker !== 'user' && lastPartialAt !== null && event.t > lastPartialAt + grace) {
          const stillOpen = voiceOpen !== null && voiceOpen.at <= lastPartialAt;
          if (stillOpen) {
            add('⑪', event.t, `用户 ${lastPartialAt} 开口后，声音到 ${event.t} 还没停`);
          }
        }
        voiceOpen = { at: event.t, speaker, engagementId };
        // ③ 两次出声之间的最小间隔（播报也算进"上一次出声"）
        if (lastVoiceAt !== null && speaker === 'pet') {
          const gap = event.t - lastVoiceAt;
          if (gap < options.params.minProactiveGapMs) {
            add('③', event.t, `两次出声只隔了 ${gap} ms（要求 ≥ ${options.params.minProactiveGapMs}）`);
          }
        }
        if (engagementId !== null) {
          const list = spokeAt.get(engagementId) ?? [];
          list.push(event.t);
          spokeAt.set(engagementId, list);
        }
        break;
      }
      case 'voice/end':
        lastVoiceAt = event.t;
        voiceOpen = null;
        break;

      default:
        break;
    }
  }

  // ⑥ abandoned 一个音节都不该出
  for (const [id, entry] of live) {
    if (entry.outcome === 'abandoned' && spokeAt.has(id)) {
      add('⑥', entry.endedAt ?? entry.startedAt, `${id} 结局是 abandoned，但它出过声`);
    }
    if (entry.endedAt === null) {
      add('⑦', entry.startedAt, `${id} 没有结局记录`);
    }
  }

  return violations;
}

function inQuiet(hour: number, params: PetParams): boolean {
  const from = params.quietFromHour;
  const to = params.quietToHour;
  const h = ((hour % 24) + 24) % 24;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** 时间线的一小段摘要（失败时打印用）。 */
export function summarizeWindow(timeline: Timeline, around: number, radiusMs: number): string[] {
  return timeline
    .filter((event) => Math.abs(event.t - around) <= radiusMs)
    .map((event) => {
      const detail = Object.entries(event)
        .filter(([key]) => !['t', 'wallHour', 'src', 'kind'].includes(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      return `  ${String(event.t).padStart(9)} ${String(event.wallHour).padStart(2)}h ${event.src}/${event.kind} ${detail}`;
    });
}
