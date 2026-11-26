/**
 * 浏览器侧音效运行时：把 DSP 渲出来的 PCM 送进 WebAudio。
 *
 * 通话中优先复用语音客户端那个 `AudioContext`：浏览器的回声消除把**同一个
 * context** 的输出当参考信号，另开一个 context 放出来的提示音对 AEC 是"外人"，
 * 可能自激打断。空闲时再惰性建一个轻量独立 context，用户手势里 `prime()` 解锁。
 *
 * 这里只做调度（冷却、淡出、生命周期），波形与频谱全在 `pet-sfx-dsp.ts`。
 * 环境不支持 WebAudio、被静音、渲染失败 —— 一律静默空操作，不抛错。
 */
import {
  synthesizeCuePcm,
  type SfxCue,
  type SfxEnvironment,
} from './pet-sfx-dsp.ts';

/**
 * 只声明真正用到的那一小片 WebAudio 形状。
 *
 * 不直接引用 `AudioContext` 类型，是为了让这份文件在 `tsconfig.json`（无 DOM lib）
 * 下也能被 `node:test` 导入；真实 `AudioContext` 结构上天然满足这些接口。
 */
export interface SfxAudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}

export interface SfxAudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface SfxAudioNodeLike {
  connect(destination: object): unknown;
  disconnect?(): void;
}

export interface SfxAudioBufferSourceLike extends SfxAudioNodeLike {
  buffer: SfxAudioBufferLike | null;
  /** 只写不读：真实节点给的是 `(ev: Event) => void`，尽量放宽形状。 */
  onended?: unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface SfxGainLike extends SfxAudioNodeLike {
  gain: SfxAudioParamLike;
}

export interface SfxAudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: SfxAudioNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): SfxAudioBufferLike;
  createBufferSource(): SfxAudioBufferSourceLike;
  createGain(): SfxGainLike;
  resume(): Promise<void>;
  close?(): Promise<void>;
}

export interface PetSfxOptions {
  /** 通话中返回客户端共享的 context；空闲返回 null */
  readonly getSharedContext: () => SfxAudioContextLike | null;
  readonly isEnabled: () => boolean;
  readonly isRetroSpark: () => boolean;
}

export interface PetSfxPlayOverrides {
  readonly env?: SfxEnvironment;
  /** 绕过静音开关（试听 / 调试用），冷却仍然生效 */
  readonly force?: boolean;
}

export interface PetSfx {
  isEnabled(): boolean;
  isRetroSpark(): boolean;
  /** 必须在用户点击的调用栈里调：解锁备用 context */
  prime(): void;
  play(cue: SfxCue, overrides?: PetSfxPlayOverrides): void;
  /** 对正在播的某个 cue（或全部）做短淡出 */
  fadeOut(cue?: SfxCue, fadeMs?: number): void;
  dispose(): void;
}

interface BatteryLike {
  readonly level: number;
  readonly charging: boolean;
}

interface NavigatorLike {
  getBattery?: () => Promise<BatteryLike>;
}

type AudioContextConstructor = new () => SfxAudioContextLike;

interface ActiveVoice {
  readonly cue: SfxCue;
  readonly context: SfxAudioContextLike;
  readonly source: SfxAudioBufferSourceLike;
  readonly gain: SfxGainLike;
  fading: boolean;
}

/** 同一 cue 50 ms 内不叠第二发；`barge-in` 与 `mic-open` 不参与。 */
const COOLDOWN_MS = 50;
const DEFAULT_FADE_MS = 20;
const FADE_MIN_MS = 5;
const FADE_MAX_MS = 120;
const START_LEAD_SEC = 0.002;

function contextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as unknown as { AudioContext?: AudioContextConstructor };
  const ctor = scope.AudioContext;
  return typeof ctor === 'function' ? ctor : null;
}

function resumeQuietly(context: SfxAudioContextLike): void {
  // Safari 的 "interrupted" 也要 resume；running / closed 不必碰。
  if (context.state !== 'suspended' && context.state !== 'interrupted') return;
  try {
    void context.resume().catch(() => {
      // 自动播放策略拒绝时保持静音，等下一次用户手势。
    });
  } catch {
    // mock / 老实现可能同步抛错。
  }
}

export function createPetSfx(options: PetSfxOptions): PetSfx {
  let localContext: SfxAudioContextLike | null = null;
  let disposed = false;
  let lowPower = false;
  let batteryProbed = false;
  const lastPlayAt = new Map<SfxCue, number>();
  const voices: ActiveVoice[] = [];

  function probeBattery(): void {
    if (batteryProbed) return;
    batteryProbed = true;
    try {
      const nav = (globalThis as unknown as { navigator?: NavigatorLike }).navigator;
      const read = nav?.getBattery;
      if (nav === undefined || typeof read !== 'function') return;
      void read.call(nav).then((battery) => {
        lowPower = battery.level < 0.2 && !battery.charging;
      }).catch(() => {
        // 不支持或拒绝时按"不低电"处理。
      });
    } catch {
      // 某些内嵌 WebView 里 navigator 的访问器会抛。
    }
  }

  probeBattery();

  function detectEnvironment(): SfxEnvironment {
    const hour = new Date().getHours();
    return { isNight: hour >= 22 || hour < 7, lowPower };
  }

  function safeEnabled(): boolean {
    try {
      return options.isEnabled();
    } catch {
      return false;
    }
  }

  function safeRetro(): boolean {
    try {
      return options.isRetroSpark();
    } catch {
      return false;
    }
  }

  function safeShared(): SfxAudioContextLike | null {
    try {
      return options.getSharedContext();
    } catch {
      return null;
    }
  }

  function ensureLocalContext(): SfxAudioContextLike | null {
    if (disposed) return null;
    if (localContext !== null && localContext.state !== 'closed') return localContext;
    const Ctor = contextConstructor();
    if (Ctor === null) return null;
    try {
      localContext = new Ctor();
    } catch {
      localContext = null;
    }
    return localContext;
  }

  function resolveContext(): SfxAudioContextLike | null {
    const shared = safeShared();
    if (shared !== null && shared.state !== 'closed') return shared;
    return ensureLocalContext();
  }

  function removeVoice(voice: ActiveVoice): void {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
  }

  function play(cue: SfxCue, overrides?: PetSfxPlayOverrides): void {
    if (disposed) return;
    if (overrides?.force !== true && !safeEnabled()) return;

    const now = Date.now();
    const last = lastPlayAt.get(cue);
    if (cue !== 'barge-in' && cue !== 'mic-open'
      && last !== undefined && now - last < COOLDOWN_MS) {
      return;
    }
    lastPlayAt.set(cue, now);

    const context = resolveContext();
    if (context === null) return;

    try {
      const rendered = synthesizeCuePcm(cue, {
        sampleRate: context.sampleRate,
        retroSpark: safeRetro(),
        env: overrides?.env ?? detectEnvironment(),
      });
      const buffer = context.createBuffer(1, rendered.samples.length, rendered.sampleRate);
      buffer.getChannelData(0).set(rendered.samples);

      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(context.destination);

      const startAt = context.currentTime + START_LEAD_SEC;
      source.start(startAt);

      const voice: ActiveVoice = { cue, context, source, gain, fading: false };
      voices.push(voice);
      source.onended = () => {
        removeVoice(voice);
        // 非循环源播完即结束；顺手断开图节点，Safari 上也能立刻回收。
        try {
          source.disconnect?.();
          gain.disconnect?.();
        } catch {
          // 已经断开或 mock 不支持。
        }
      };
    } catch {
      // 渲染或建图失败就当没这个音效。
    }

    resumeQuietly(context);
  }

  function fadeOut(cue?: SfxCue, fadeMs: number = DEFAULT_FADE_MS): void {
    const fade = clampFade(fadeMs);
    for (const voice of [...voices]) {
      if (voice.fading) continue;
      if (cue !== undefined && voice.cue !== cue) continue;
      voice.fading = true;
      const now = voice.context.currentTime;
      const end = now + fade / 1000;
      try {
        const param = voice.gain.gain;
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(0, end);
      } catch {
        // 参数调度失败也继续把节点停掉。
      }
      try {
        voice.source.stop(end + 0.005);
      } catch {
        // 已经停过。
      }
      removeVoice(voice);
    }
  }

  function prime(): void {
    if (disposed || !safeEnabled()) return;
    const shared = safeShared();
    if (shared !== null && shared.state !== 'closed') resumeQuietly(shared);
    const local = ensureLocalContext();
    if (local !== null) resumeQuietly(local);
  }

  function dispose(): void {
    disposed = true;
    for (const voice of voices.splice(0)) {
      try {
        voice.source.stop();
      } catch {
        // 已经自然结束。
      }
      try {
        voice.source.disconnect?.();
      } catch {
        // mock 没有 disconnect。
      }
      try {
        voice.gain.disconnect?.();
      } catch {
        // 同上。
      }
    }
    const local = localContext;
    localContext = null;
    if (local !== null && local.state !== 'closed') {
      const close = local.close;
      if (typeof close === 'function') {
        try {
          void close.call(local).catch(() => {
            // 有些实现不返回 Promise。
          });
        } catch {
          // 关不掉也不影响页面。
        }
      }
    }
  }

  return {
    isEnabled: safeEnabled,
    isRetroSpark: safeRetro,
    prime,
    play,
    fadeOut,
    dispose,
  };
}

function clampFade(fadeMs: number): number {
  if (!Number.isFinite(fadeMs)) return DEFAULT_FADE_MS;
  return fadeMs < FADE_MIN_MS ? FADE_MIN_MS : fadeMs > FADE_MAX_MS ? FADE_MAX_MS : fadeMs;
}
