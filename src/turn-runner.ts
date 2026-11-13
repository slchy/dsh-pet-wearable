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
import type { DownlinkSink } from './transport.ts';
import { pcm16DurationMs, pcm16Gain } from './pcm.ts';
import { sleep } from './util.ts';
import type { AgentProvider, TtsProvider } from './providers.ts';
import type { ImageAttachment } from './session.ts';

export interface TurnRunnerOptions {
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
  /** 一轮结束（落盘用），无论成功失败都会调用 */
  readonly onTurnFinished: () => void;
  readonly log: (line: string) => void;
}

/** 一轮的执行结果，供调用方决定是否收尾 */
export interface TurnResult {
  /** 是否被用户插话中断 */
  readonly interrupted: boolean;
  /** 下发的字节数 */
  readonly audioBytes: number;
  /** 音频时长（秒） */
  readonly audioSeconds: number;
  /** TTS 首块耗时（毫秒），-1 表示没拿到音频 */
  readonly firstChunkLatencyMs: number;
  /** agent 耗时（毫秒） */
  readonly agentLatencyMs: number;
}

export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly log: (line: string) => void;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.log = options.log;
  }

  /**
   * 跑一轮。
   *
   * 返回时 `fsm` 已推进到下一状态；调用方据 `fsm.state` 决定是否挂断。
   */
  async run(text: string, image?: ImageAttachment): Promise<TurnResult | null> {
    const { fsm, agent, downlink } = this.options;
    const ticket = fsm.beginTurn();
    if (!ticket) {
      return null;
    }

    let interrupted = false;
    let audioBytes = 0;
    let firstChunkAtMs = 0;
    let agentLatencyMs = 0;

    try {
      const agentStartedAt = Date.now();
      const reply = await agent.reply(text, image);
      agentLatencyMs = Date.now() - agentStartedAt;
      this.log(
        `  agent   ${(agentLatencyMs / 1000).toFixed(2)} s  `
        + JSON.stringify(reply.text.slice(0, 120)),
      );

      const ttsStarted = Date.now();
      for await (const chunk of this.options.tts.synthesize(reply.speech, reply.emotion)) {
        if (fsm.isStale(ticket)) {
          interrupted = true;
          break;
        }
        if (firstChunkAtMs === 0) {
          firstChunkAtMs = Date.now() - ttsStarted;
          fsm.audioStarted(ticket);
          this.log(`  TTS首块 ${(firstChunkAtMs / 1000).toFixed(2)} s`);
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
        const until = Date.now() + audioSeconds * 1000 + this.options.playbackTailMs;
        while (!fsm.isStale(ticket) && Date.now() < until) {
          await sleep(100);
        }
        interrupted = fsm.isStale(ticket);
      }

      return {
        interrupted,
        audioBytes,
        audioSeconds,
        firstChunkLatencyMs: firstChunkAtMs === 0 ? -1 : firstChunkAtMs,
        agentLatencyMs,
      };
    } catch (error) {
      this.log(`  ✗ 本轮失败: ${(error as Error).message}`);
      return null;
    } finally {
      fsm.audioDone(ticket);
      this.options.onTurnFinished();
    }
  }
}
