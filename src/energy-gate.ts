/**
 * 上行能量门 —— 决定「这块音频要不要推给 ASR」。
 *
 * <h2>为什么需要它</h2>
 *
 * 阿里云网关对「没听到有效语音」的连接 **10 s 就判 `IDLE_TIMEOUT`**，
 * 而推静音不算活动。眼镜唤醒后会一直推帧，安静时是接近数字零的静音
 * （实测峰值 −78 dBFS、RMS −91.6）。所以不能一上来就建连，
 * 要用能量做闸门：没声音就不建连，有声音再建并把预卷补推上去。
 *
 * <h2>为什么是一个状态机而不是几个布尔量</h2>
 *
 * 「开着」「该关」「有预卷」这三种事实必须同时成立才能正确推流，
 * 用独立布尔量表达时漏同步一次就变成「门开着但没喂音频」——这类 bug
 * 不会崩，只会让识别无声无息地变差。
 *
 * 本模块**不做 I/O**：时钟可注入，输出只是一个决策对象。
 */
import { PcmPreroll, pcm16PeakDbfs, pcm16DurationMs } from './pcm.ts';

export interface EnergyGateOptions {
  /** 判定「有声音」的峰值门限（dBFS）。越接近 0 越严格。 */
  readonly thresholdDbfs: number;
  /** 最后一个有声块之后，再继续推这么久才关门。 */
  readonly holdMs: number;
  /** 开门前保留的音频长度（字节）。按毫秒换算，见 {@link PcmPreroll}。 */
  readonly prerollBytes: number;
  readonly sampleRate: number;
  /** 可注入时钟，测试用 */
  readonly now?: () => number;
}

/** 一次 `process` 的决策结果 */
export interface EnergyGateDecision {
  /** 这块音频是否应当送进 ASR */
  readonly forward: boolean;
  /**
   * 这一块**本身**有没有超过门限的有声帧。
   *
   * 与 {@link forward} 是两件事：`forward` 包住 `holdMs` 尾巴（默认 2 s），
   * 只说明「门还开着、这块该推给 ASR」；`voiced` 才是「这块真有声音」。
   * 封段发生在静音 20 ms 时，之后还有 ~1980 ms 的块满足 `forward` 却没有声音 ——
   * 凡是按「有声」而不是按「门开着」做判断的下游（omni 影子旁路就是），
   * 必须用这个字段，**不要自己按能量重算**：两处门限一漂移就分不出是丢字还是灌静音。
   */
  readonly voiced: boolean;
  /** 刚开门时附带的值：触发开门的那块音频的峰值与补推的预卷 */
  readonly opened?: {
    readonly peakDbfs: number;
    readonly preroll: readonly Buffer[];
    readonly prerollMs: number;
  };
  /** 刚关门（持续静音），调用方应当主动挂断以免 IDLE_TIMEOUT */
  readonly closed: boolean;
  /** 关门时距上次「有声」过去了多久 —— 用来区分「真的安静」和「上行断流」 */
  readonly closedGapMs?: number;
  /**
   * 距最近一块**有声**音频过去了多久（ms）。
   *
   * 这是全链路**唯一**的静音累计：封段（20/150）、投机（100）、判停（200）
   * 三个阈值都该读它，而不是各自按能量重算一遍（那正是"配置写 20 ms、实际门槛
   * 92 ms 还查不出来"的来源）。`voiced` 那一块本身返回 0。
   */
  readonly silenceMs: number;
}

const IDLE_DECISION: EnergyGateDecision = { forward: false, closed: false, voiced: false, silenceMs: 0 };

export class EnergyGate {
  private readonly options: EnergyGateOptions;
  private readonly preroll: PcmPreroll;
  private readonly now: () => number;
  private lastVoiceAtMs = 0;
  private open = false;

  constructor(options: EnergyGateOptions) {
    this.options = options;
    this.preroll = new PcmPreroll(options.prerollBytes);
    this.now = options.now ?? Date.now;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * 喂一块 PCM，返回该块引发的决策。
   *
   * 不抛异常、不记录日志 —— 日志由调用方按决策内容决定。
   */
  process(chunk: Buffer): EnergyGateDecision {
    const peakDbfs = pcm16PeakDbfs(chunk);

    if (peakDbfs > this.options.thresholdDbfs) {
      this.lastVoiceAtMs = this.now();
      if (!this.open) {
        this.open = true;
        const preroll = this.preroll.drain();
        const bytes = preroll.reduce((sum, part) => sum + part.length, 0);
        return {
          forward: true,
          closed: false,
          voiced: true,
          silenceMs: 0,
          opened: {
            peakDbfs,
            preroll,
            prerollMs: Math.round(pcm16DurationMs(bytes, this.options.sampleRate)),
          },
        };
      }
      return { forward: true, closed: false, voiced: true, silenceMs: 0 };
    }

    if (!this.open) {
      this.preroll.push(chunk);
      return IDLE_DECISION;
    }

    // 门开着但这块没有语音：仍在保持窗口内就继续推（尾巴不能截），
    // 超过保持窗口就关门；关门这一块本身仍然推出去，与历史行为一致。
    const gapMs = this.now() - this.lastVoiceAtMs;
    if (gapMs > this.options.holdMs) {
      this.open = false;
      return { forward: true, closed: true, voiced: false, closedGapMs: gapMs, silenceMs: gapMs };
    }
    return { forward: true, closed: false, voiced: false, silenceMs: gapMs };
  }
}
