/**
 * 上行管道：mSBC → PCM（ffmpeg）→ 能量门 → 交给 STT 的「有声段」。
 *
 * 抽出来的理由：这段逻辑原本埋在 `aliyun-session.ts` 的 `bindUpstream()` 里，
 * 和 socket 回调混在一起，改一次判停就要动编排代码。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { EnergyGate } from './energy-gate.ts';

export interface UplinkGateConfig {
  readonly thresholdDbfs: number;
  readonly holdMs: number;
  readonly prerollMs: number;
}

export interface UplinkPipelineOptions {
  readonly ffmpegPath: string;
  /** 解码后的采样率（mSBC 固定 16 kHz） */
  readonly sampleRate: number;
  readonly gate: UplinkGateConfig;
  readonly log: (line: string) => void;
  readonly onError: (line: string) => void;
  /** 每块解码后的 PCM：判停器、落盘都要它 */
  readonly onPcm: (pcm: Buffer) => void;
  /** 有声开始：先把 preroll 喂进 STT，再继续喂后续 */
  readonly onSpeechOpen: (peakDbfs: number, preroll: readonly Buffer[], prerollMs: number) => void;
  readonly onSpeech: (pcm: Buffer) => void;
  /** 持续静音：请 STT 出定稿并挂断这一路 */
  readonly onSpeechClose: () => void;
}

export class UplinkPipeline {
  private readonly options: UplinkPipelineOptions;
  private readonly gate: EnergyGate;
  private readonly ffmpeg: ChildProcessWithoutNullStreams;

  constructor(options: UplinkPipelineOptions) {
    this.options = options;

    this.gate = new EnergyGate({
      thresholdDbfs: options.gate.thresholdDbfs,
      holdMs: options.gate.holdMs,
      prerollBytes: Math.round((options.gate.prerollMs / 1000) * options.sampleRate * 2),
      sampleRate: options.sampleRate,
    });

    this.ffmpeg = spawn(options.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'sbc', '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(options.sampleRate), '-ac', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;

    this.ffmpeg.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        options.onError(text);
      }
    });

    this.ffmpeg.stdout.on('data', (pcm: Buffer) => { this.onPcm(pcm); });
  }

  /** 送一段 mSBC 压缩帧。 */
  push(sbc: Buffer): void {
    if (!this.ffmpeg.stdin.destroyed) {
      this.ffmpeg.stdin.write(sbc);
    }
  }

  /** 关管道。ffmpeg 偶尔不肯立刻退，兜底一秒后 kill。 */
  end(): void {
    if (!this.ffmpeg.stdin.destroyed) {
      this.ffmpeg.stdin.end();
    }
    setTimeout(() => {
      try {
        this.ffmpeg.kill();
      } catch {
        // 已退出
      }
    }, 1000).unref?.();
  }

  private onPcm(pcm: Buffer): void {
    const { onPcm, onSpeechOpen, onSpeech, onSpeechClose, log } = this.options;

    onPcm(pcm);

    const decision = this.gate.process(pcm);
    if (decision.opened) {
      log(
        `  上行    有声 ${decision.opened.peakDbfs.toFixed(1)} dBFS → 开始推送`
        + `（补 ${decision.opened.preroll.length} 块 / ${decision.opened.prerollMs} ms）`,
      );
      onSpeechOpen(decision.opened.peakDbfs, decision.opened.preroll, decision.opened.prerollMs);
    }
    if (decision.forward) {
      onSpeech(pcm);
    }
    if (decision.closed) {
      log('  上行    持续静音 → 停推并挂断（避免 IDLE_TIMEOUT）');
      onSpeechClose();
    }
  }
}
