/**
 * 执行一轮完整对话：agent → TTS → 下发 → 等播放结束。
 *
 * <h2>职责边界</h2>
 *
 * 只管「一轮怎么跑完」，不关心：
 * - 音频从哪来（见 {@link EnergyGate}）
 * - 文本怎么攒出来（见 {@link UtteranceAssembler}）
 * - 现在能不能开新一轮（见 {@link DialogFsm}）
 *
 * 依赖全部注入，自身不 import 任何具体供应商实现
 * （`synthesize` 是函数，不是 TTS 客户端）。
 */
import { DialogFsm } from './dialog-fsm.ts';
import { fillerLine } from './filler.ts';
import type { Clock, Cancel } from './app/clock.ts';
import type { DownlinkSink } from './transport.ts';
import { pcm16DurationMs, pcm16Gain } from './pcm.ts';
import type { AgentProvider, TtsProvider } from './providers.ts';
import type { ImageAttachment } from './session.ts';

/**
 * 等播放结束时的轮询间隔。
 *
 * 播放进度只能靠时间估（PCM 时长 + 余量），所以要隔一会儿看一眼「是不是被打断了」。
 * 100 ms 是「用户感觉不到延迟」和「不空转 CPU」的折中。
 */
const PLAYBACK_POLL_MS = 100;

export interface TurnRunnerOptions {
  /** 时钟端口：一轮里的所有等待与计时都走它（模拟器要用虚拟时间） */
  readonly clock: Clock;
  readonly agent: AgentProvider;
  /** TTS provider：采样率与合成都在里面，宿主不再各配一份 */
  readonly tts: TtsProvider;
  readonly downlink: DownlinkSink;
  readonly fsm: DialogFsm;
  /** 预估播放时长之外再多等的余量 */
  readonly playbackTailMs: number;
  /**
   * 下行语音增益（线性倍数，默认 1）。MiMo 输出偏小，实机听感要开到接近满格，
   * 所以默认放大一档；压峰用软限幅（见 `pcm.ts` 的 `pcm16Gain`）。
   */
  readonly ttsGain?: number;
  /** 每块下行音频（AEC 分析落盘用） */
  readonly onDownlinkChunk?: (chunk: Buffer) => void;
  /**
   * 时间线事件（进会话档案）。
   *
   * `tts.first` 与 `turn.end` 是延迟复算必需的仪表：缺了它们，「用户说完 → 听到第一个字」
   * 只散在 console 里，改动之后没法比快慢（见 `latency-report.ts`）。
   */
  readonly onEvent?: (name: string, fields?: Record<string, unknown>) => void;
  /** 一轮结束（落盘用），无论成功失败都会调用 */
  readonly onTurnFinished: () => void;
  /**
   * 长任务填充（filler scheduler，见 ADR-004 §7 / SELF-CLIENT-DESIGN §2.11）。
   *
   * 从「开始跑」到「首块音频下发」之间：先等 `firstAfterMs`，之后每 `intervalMs`
   * 说 `lines` 里的下一句（说满就彻底安静）。用户一开口、模型一回来都立刻停。
   *
   * 不给就不填充；`firstAfterMs <= 0` 也等于关掉。
   */
  readonly filler?: {
    readonly firstAfterMs: number;
    readonly intervalMs: number;
    readonly lines: readonly string[];
  };
  readonly log: (line: string) => void;
}

/** 一轮的执行结果，供调用方决定是否收尾 */
export interface TurnResult {
  /** 是否被用户插话中断 */
  readonly interrupted: boolean;
  /** 模型给的、准备念的全文（被打断时用来算"还剩哪段没说完"） */
  readonly speech: string;
  /** 下发的字节数 */
  readonly audioBytes: number;
  /** 整段音频时长（秒） */
  readonly audioSeconds: number;
  /**
   * **用户实际听到的**时长（秒）。
   *
   * 不等于 `audioSeconds`：回答是先整段合成再等的，用户插话那会儿音频早就
   * 全发出去了 —— 所以只能按"首块发出去之后过了多久"算。
   */
  readonly playedSeconds: number;
  /** TTS 首块耗时（毫秒），-1 表示没拿到音频 */
  readonly firstChunkLatencyMs: number;
  /** agent 耗时（毫秒） */
  readonly agentLatencyMs: number;
}

export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly log: (line: string) => void;
  /** 旁白与本轮回答共用一条下行音频，必须串行，否则两段 PCM 会交织在一起 */
  private speechChain: Promise<void> = Promise.resolve();
  /** 用户在旁白播到一半改主意：停止下发，也别让下一轮排在它后面 */
  private cannedCancelled = false;
  /** 填充用的定时器（到点前收回音就该取消） */
  private fillerTimer: Cancel | null = null;
  /** 用户一开口就别再"嗯"了 */
  private fillerCancelled = false;
  /** 已经说到第几句（说满 `lines` 就不再开口） */
  private fillerIndex = 0;
  /** 「此刻正在念的那段旁白就是填充」—— 收回时只掐它，别误伤别的旁白 */
  private fillerSpeaking = false;
  /** 本轮的回答已经开始出声 —— 回执不再有意义 */
  private replyStarted = false;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.log = options.log;
  }

  /** 等 ms：走 Clock，虚拟时钟下就是推进虚拟时间。 */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.options.clock.after(ms, resolve);
    });
  }

  /**
   * 播一句**系统旁白**（不是模型的回答）。
   *
   * 高清照要等用户按下快门，这几十秒里没有「一轮」可挂 —— 但总得有人告诉他去按。
   * 所以旁白**不改状态机**，只借同一条 TTS 通道说话；它和本轮回答通过
   * {@link speechChain} 串行，两段音频不会撞在一起。
   */
  speakCanned(text: string, emotion?: string): Promise<void> {
    this.cannedCancelled = false;
    const run = async (): Promise<void> => {
      const startedAt = this.options.clock.now();
      let bytes = 0;
      let firstChunkAtMs = -1;
      for await (const chunk of this.options.tts.synthesize(text, emotion)) {
        if (this.cannedCancelled) {
          this.log('  旁白    被打断，停止下发');
          return;
        }
        if (firstChunkAtMs < 0) {
          firstChunkAtMs = this.options.clock.now() - startedAt;
        }
        bytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }
      const seconds = pcm16DurationMs(bytes, this.options.tts.sampleRate) / 1000;
      this.log(
        `  旁白    ${JSON.stringify(text)} ${bytes} B / ${seconds.toFixed(2)} s`
        + `（首块 ${firstChunkAtMs < 0 ? '—' : `${firstChunkAtMs}ms`}）`,
      );
      // 每 100 ms 看一眼有没有被取消：用户说完「算了」不该还要等这段音频"播完"
      const until = this.options.clock.now() + seconds * 1000 + this.options.playbackTailMs;
      while (this.options.clock.now() < until && !this.cannedCancelled) {
        await this.wait(PLAYBACK_POLL_MS);
      }
    };
    const next = this.speechChain.then(run, run);
    this.speechChain = next.catch(() => undefined);
    return next;
  }

  /** 用户改主意：旁白不必播完，后面排队的那一轮也不必等它 */
  cancelCanned(): void {
    this.cannedCancelled = true;
  }

  /**
   * 跑一轮。
   *
   * 返回时 `fsm` 已推进到下一状态；调用方据 `fsm.state` 决定是否挂断。
   */
  async run(text: string, image?: ImageAttachment, note?: string): Promise<TurnResult | null> {
    const { fsm, agent, downlink } = this.options;
    const ticket = fsm.beginTurn();
    if (!ticket) {
      return null;
    }

    let interrupted = false;
    let audioBytes = 0;
    let firstChunkAtMs = 0;
    let agentLatencyMs = 0;
    let speech = '';

    try {
      this.replyStarted = false;
      this.fillerCancelled = false;
      this.scheduleFiller();
      const agentStartedAt = this.options.clock.now();
      const reply = await agent.reply(text, image, note);
      agentLatencyMs = this.options.clock.now() - agentStartedAt;
      // 模型已经回来了：剩下的只是 TTS 首块，那点等待不值得再插一句
      this.cancelFiller();
      speech = reply.speech;
      this.log(
        `  agent   ${(agentLatencyMs / 1000).toFixed(2)} s  `
        + JSON.stringify(reply.text.slice(0, 120)),
      );

      // 旁白还没播完就先让路：否则「请按快门」和回答会叠在一起
      await this.speechChain;

      this.replyStarted = true;
      this.cancelFiller();
      const ttsStarted = this.options.clock.now();
      let firstAudioAtMs = -1;
      for await (const chunk of this.options.tts.synthesize(reply.speech, reply.emotion)) {
        if (fsm.isStale(ticket)) {
          interrupted = true;
          break;
        }
        if (firstChunkAtMs === 0) {
          firstChunkAtMs = this.options.clock.now() - ttsStarted;
          firstAudioAtMs = this.options.clock.now();
          fsm.audioStarted(ticket);
          this.log(`  TTS首块 ${(firstChunkAtMs / 1000).toFixed(2)} s`);
          this.options.onEvent?.('tts.first', { ms: firstChunkAtMs });
        }
        audioBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }

      interrupted = interrupted || fsm.isStale(ticket);
      const audioSeconds = pcm16DurationMs(audioBytes, this.options.tts.sampleRate) / 1000;
      this.log(
        `  回放    ${audioBytes} 字节  ${audioSeconds.toFixed(2)} s`
        + (interrupted ? '（被中断）' : ''),
      );

      this.log(
        `TURN n=${ticket.no} text_len=${text.length} dsh_ms=${agentLatencyMs}`
        + ` tts_first_ms=${firstChunkAtMs === 0 ? -1 : firstChunkAtMs}`
        + ` audio_s=${audioSeconds.toFixed(2)}`
        + (interrupted ? ' barge_in=1' : ''),
      );

      // 状态机在整个等待期间保持 speaking；插话会让票据作废从而提前结束等待。
      if (!interrupted) {
        const until = this.options.clock.now() + audioSeconds * 1000 + this.options.playbackTailMs;
        while (!fsm.isStale(ticket) && this.options.clock.now() < until) {
          await this.wait(PLAYBACK_POLL_MS);
        }
        interrupted = fsm.isStale(ticket);
      }

      // 用户听到的时长按「首块发出之后过了多久」算，不按字节算：
      // 回答是整段先合成完再等的，插话那会儿音频早就全发出去了。
      const heardSeconds = firstAudioAtMs < 0
        ? 0
        : Math.min(audioSeconds, (this.options.clock.now() - firstAudioAtMs) / 1000);

      this.options.onEvent?.('turn.end', {
        interrupted,
        audio_s: Number(audioSeconds.toFixed(2)),
        heard_s: Number(heardSeconds.toFixed(2)),
        dsh_ms: agentLatencyMs,
        tts_first_ms: firstChunkAtMs === 0 ? -1 : firstChunkAtMs,
      });

      return {
        interrupted,
        speech,
        audioBytes,
        audioSeconds,
        playedSeconds: heardSeconds,
        firstChunkLatencyMs: firstChunkAtMs === 0 ? -1 : firstChunkAtMs,
        agentLatencyMs,
      };
    } catch (error) {
      // 失败也留一条：否则报告里这一轮的 ④ 会显示"缺仪表"，与"没拿到音频"混在一起
      this.options.onEvent?.('turn.end', { failed: true, dsh_ms: agentLatencyMs });
      this.log(`  ✗ 本轮失败: ${(error as Error).message}`);
      return null;
    } finally {
      this.cancelFiller();
      fsm.audioDone(ticket);
      this.options.onTurnFinished();
    }
  }

  /**
   * 排下一次填充。
   *
   * 只在**回答还没开始出声**时才有意义：到点时若已经开口，什么也不做。
   * 填充走旁白通道（不改状态机），所以用户此时说话不会被当成插话 ——
   * 而是一开口就把这句掐掉（{@link cancelFiller}）。
   */
  private scheduleFiller(): void {
    const filler = this.options.filler;
    if (filler === undefined || filler.firstAfterMs <= 0 || filler.lines.length === 0) return;
    this.fillerIndex = 0;
    this.armFiller(filler.firstAfterMs);
  }

  private armFiller(delayMs: number): void {
    const filler = this.options.filler;
    if (filler === undefined) return;
    this.fillerTimer = this.options.clock.after(delayMs, () => {
      this.fillerTimer = null;
      if (this.fillerCancelled || this.replyStarted) return;
      const line = fillerLine(this.fillerIndex, filler.lines);
      this.fillerIndex += 1;
      // 说满了就彻底安静：一直唠比安静更烦人
      if (line === null) return;
      this.log(`  填补    ${(delayMs / 1000).toFixed(1)} s 还没出声 → 「${line}」`);
      this.fillerSpeaking = true;
      void this.speakCanned(line)
        .catch(() => undefined)
        .finally(() => { this.fillerSpeaking = false; });
      this.armFiller(filler.intervalMs);
    });
  }

  /** 收回填充：回答要开始了，或者用户已经开口 */
  cancelFiller(): void {
    this.fillerCancelled = true;
    if (this.fillerTimer !== null) {
      this.fillerTimer();
      this.fillerTimer = null;
    }
    // 正在念的那半句也得断：否则用户开口了「嗯…」还在耳朵边上响
    if (this.fillerSpeaking) this.cannedCancelled = true;
  }
}
