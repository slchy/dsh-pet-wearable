/**
 * 假的外部世界：agent / voice / device。
 *
 * 对应 ADR-0002 §3.3。约定：
 * - **每个延迟都用 `clock.after`**，不用真实时间。
 * - 每个假件都往时间线写事件，供 `timeline.ts` 的不变量检查。
 * - 说话时长按字数估（与生产同一个 `estimateSpeechMs`）。
 */
import type { DeviceCall, DeviceCapabilities } from '../../devices/primitives.ts';
import type { Emotion } from '../../emotion.ts';
import type { Clock } from '../../app/clock.ts';
import { estimateSpeechMs } from '../brain/registry.ts';
import type {
  AgentPort,
  DevicePort,
  PetContext,
  PetImage,
  PetReply,
  PetSource,
  SpeakResult,
  Voice,
} from '../brain/types.ts';
import type { TimelineSink } from './timeline.ts';

export const MIN = 60_000;

// ---------------------------------------------------------------- agent

/** 一次 agent 回复的脚本。 */
export interface AgentScript {
  /** 虚拟耗时；默认 0 */
  readonly latencyMs?: number;
  /** 回什么；`Error` = 抛错，`null` = 永不返回 */
  readonly reply?: PetReply | Error | null;
}

export class SimAgent implements AgentPort {
  readonly asked: Array<{ context: PetContext; image: PetImage | null; source: PetSource; at: number }> = [];

  private readonly clock: Clock;
  private readonly sink: TimelineSink;
  private readonly scripts: AgentScript[];
  private readonly fallback: AgentScript;
  /** 由世界按 `pet.out` 的 compose 事件设置，只用于时间线归属 */
  currentEngagementId: string | null = null;

  constructor(
    clock: Clock,
    sink: TimelineSink,
    scripts: AgentScript[] = [],
    fallback: AgentScript = { reply: { text: '' } },
  ) {
    this.clock = clock;
    this.sink = sink;
    this.scripts = [...scripts];
    this.fallback = fallback;
  }

  ask(context: PetContext, image: PetImage | null, source: PetSource): Promise<PetReply> {
    this.asked.push({ context, image, source, at: this.clock.now() });
    const script = this.scripts.length > 0 ? this.scripts.shift() ?? this.fallback : this.fallback;
    this.sink.push('agent', 'ask', {
      engagementId: this.currentEngagementId,
      sourceKind: source.kind,
      withImage: image !== null,
      hasImageHint: context.hasImage,
      latencyMs: script.latencyMs ?? 0,
    });
    return new Promise<PetReply>((resolve, reject) => {
      // `null` = 永不返回：只能靠 compose 截止救场
      if (script.reply === null) {
        return;
      }
      const reply = script.reply ?? { text: '' };
      const settle = (): void => {
        if (reply instanceof Error) {
          reject(reply);
          return;
        }
        resolve(reply);
      };
      const latency = script.latencyMs ?? 0;
      if (latency <= 0) {
        settle();
        return;
      }
      this.clock.after(latency, settle);
    });
  }
}

// ---------------------------------------------------------------- voice

/** 声音的说话人。`announce` = 后台汇报（不归宠物管）。 */
export type Speaker = 'pet' | 'announce' | 'reflex';

export interface Spoken {
  readonly speaker: Speaker;
  readonly text: string;
  readonly emotion: Emotion | null;
  readonly at: number;
  readonly result: SpeakResult;
  readonly engagementId: string | null;
}

export interface SimVoiceOptions {
  /** 每字耗时；不给就用 `estimateSpeechMs` */
  readonly perCharMs?: number;
  /** 由世界注入：当前话筒归属 */
  readonly floorOwner: () => string | null;
  /** 由世界注入：当前 engagement（用于时间线归属） */
  readonly engagementId: () => string | null;
}

export class SimVoice implements Voice {
  readonly spoken: Spoken[] = [];

  private readonly clock: Clock;
  private readonly sink: TimelineSink;
  private readonly options: SimVoiceOptions;
  private current: (() => void) | null = null;

  constructor(clock: Clock, sink: TimelineSink, options: SimVoiceOptions) {
    this.clock = clock;
    this.sink = sink;
    this.options = options;
  }

  /** 宠物自己说话。 */
  speak(text: string, emotion: Emotion | null, signal: AbortSignal): Promise<SpeakResult> {
    return this.say('pet', text, emotion, signal);
  }

  /** 后台汇报。不归宠物，但同样要占时间线（ADR-0002 ③⑪）。 */
  speakAnnounce(text: string): Promise<SpeakResult> {
    return this.say('announce', text, null, null);
  }

  stop(): void {
    this.current?.();
  }

  private say(
    speaker: Speaker,
    text: string,
    emotion: Emotion | null,
    signal: AbortSignal | null,
  ): Promise<SpeakResult> {
    const at = this.clock.now();
    const engagementId = speaker === 'pet' ? this.options.engagementId() : null;
    this.sink.push('voice', 'start', {
      speaker,
      text,
      engagementId,
      floorOwner: this.options.floorOwner(),
    });
    const duration = this.options.perCharMs === undefined
      ? estimateSpeechMs(text)
      : Math.max(1, Math.round([...text].length * this.options.perCharMs));
    return new Promise<SpeakResult>((resolve) => {
      let settled = false;
      let cancel: () => void = () => {};
      const finish = (result: SpeakResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancel();
        signal?.removeEventListener('abort', onAbort);
        this.current = null;
        this.sink.push('voice', 'end', { speaker, result, engagementId, text });
        this.spoken.push({ speaker, text, emotion, at, result, engagementId });
        resolve(result);
      };
      const onAbort = (): void => finish('cut');
      cancel = this.clock.after(duration, () => finish('done'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.current = () => finish('cut');
      if (signal?.aborted === true) {
        finish('cut');
      }
    });
  }
}

// ---------------------------------------------------------------- device

/** 拍照的四种结局。 */
export type CaptureBehavior =
  /** 正常回图 */
  | 'ok'
  /** 永不回图（只能靠截止） */
  | 'never'
  /** 回一个"没拍到" */
  | 'fail'
  /** 回图但晚于截止 */
  | 'late';

export interface SimDeviceOptions {
  readonly behavior: CaptureBehavior;
  /** 回图延迟（ms） */
  readonly latencyMs: number;
  readonly image: PetImage;
  /** 世界注入：把图交回会话 */
  readonly deliver: (id: string, image: PetImage | null) => void;
  /** 世界注入：`listen.start` 之后安排一次 `micOpened` */
  readonly onListenStart?: () => void;
}

export class SimDevice implements DevicePort {
  readonly calls: DeviceCall[] = [];
  private readonly options: SimDeviceOptions;
  private readonly clock: Clock;
  private readonly sink: TimelineSink;

  constructor(clock: Clock, sink: TimelineSink, options: SimDeviceOptions) {
    this.clock = clock;
    this.sink = sink;
    this.options = options;
  }

  call(call: DeviceCall): void {
    this.calls.push(call);
    this.sink.push('call', call.op, { ...call });
    if (call.op === 'listen.start') {
      this.options.onListenStart?.();
      return;
    }
    if (call.op !== 'capture') {
      return;
    }
    const { behavior, latencyMs, image, deliver } = this.options;
    if (behavior === 'never') {
      return;
    }
    this.clock.after(latencyMs, () => {
      deliver(call.id, behavior === 'fail' ? null : image);
    });
  }

  of(op: DeviceCall['op']): DeviceCall[] {
    return this.calls.filter((call) => call.op === op);
  }
}

/** 设备能力集：直接引用真实档位，不另抄一份（ADR-0002 §3.3）。 */
export type { DeviceCapabilities };
