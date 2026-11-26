/**
 * TurnJudge：进程内的**声学判停**，回答「这一轮说完了吗」。
 *
 * 模型是 pipecat 的 Smart Turn v3.2（`models/smart-turn-v3.2-cpu.onnx`）——
 * 文件名与模型名都保留上游原名；「TurnJudge」是本项目这一层封装的名字。
 * 输入是 Whisper 风格 log-mel（80×800），特征提取在 `whisper-features.ts`（纯 TS）。
 *
 * 用 `onnxruntime-node` 在**本进程内**推理：不需要 Python 运行时，也没有独立子进程。
 * `onnxruntime-node` 只在第一次 `predict()` 时动态 `import`，顶层不静态引入，
 * 纯逻辑单测因此不需要原生依赖。
 *
 * 故障安全：空 PCM、已停止、模型缺失、加载/推理异常一律返回 `-1`（调用方退回
 * 固定合并窗口），绝不把热路径打崩。
 */
import { existsSync } from 'node:fs';

import {
  computeWhisperLogMelFeatures,
  pcm16ToLast8Seconds,
  WHISPER_N_FRAMES,
  WHISPER_N_MELS,
} from './whisper-features.ts';

export interface TurnJudgeOptions {
  /** 模型文件路径（`smart-turn-v3.2-cpu.onnx`）。 */
  readonly modelPath: string;
  readonly log?: (line: string) => void;
}

type OrtModule = typeof import('onnxruntime-node');
type OrtSession = import('onnxruntime-node').InferenceSession;

/** 串行化推理：ONNX session 一次只跑一条，热路径也不该在它身上排队炸开。 */
export class TurnJudge {
  readonly modelPath: string;

  private readonly log: (line: string) => void;
  private ort: OrtModule | null = null;
  private session: OrtSession | null = null;
  private loading: Promise<OrtSession | null> | null = null;
  private stopped = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: TurnJudgeOptions) {
    this.modelPath = opts.modelPath;
    this.log = opts.log ?? (() => {});
  }

  private async ensureSession(): Promise<OrtSession | null> {
    if (this.stopped) return null;
    if (this.session !== null) return this.session;
    if (this.loading !== null) return await this.loading;

    this.loading = (async (): Promise<OrtSession | null> => {
      try {
        if (this.modelPath === '' || !existsSync(this.modelPath)) {
          this.log(`[turn-judge] 模型不存在：${this.modelPath || '(空路径)'}`);
          return null;
        }
        const ortModule = await import('onnxruntime-node');
        const session = await ortModule.InferenceSession.create(this.modelPath, {
          executionMode: 'sequential',
          interOpNumThreads: 1,
          intraOpNumThreads: 1,
          graphOptimizationLevel: 'all',
        });
        if (this.stopped) {
          void session.release?.();
          return null;
        }
        this.ort = ortModule;
        this.session = session;
        this.log(`[turn-judge] 声学判停模型已加载 ${this.modelPath}`);
        return session;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.log(`[turn-judge] 模型加载失败：${detail}`);
        return null;
      }
    })();

    return await this.loading;
  }

  /**
   * 判断这段音频之后「用户说完了吗」。
   *
   * @param pcm 16 kHz 单声道 PCM16；建议给整轮（内部截最近 8 秒、前补零）
   * @returns 概率 0..1；不可用时返回 -1（调用方应退回固定合并窗口）
   */
  async predict(pcm: Buffer): Promise<number> {
    const run = async (): Promise<number> => {
      if (this.stopped) {
        this.log('[turn-judge] 已停止，跳过推理');
        return -1;
      }
      if (pcm.length === 0) {
        this.log('[turn-judge] 空 PCM，跳过推理');
        return -1;
      }
      const session = await this.ensureSession();
      if (session === null || this.stopped) return -1;
      const ortModule = this.ort;
      if (ortModule === null) return -1;

      try {
        const features = computeWhisperLogMelFeatures(pcm16ToLast8Seconds(pcm), {
          doNormalize: true,
        });
        const input = new ortModule.Tensor('float32', features, [
          1,
          WHISPER_N_MELS,
          WHISPER_N_FRAMES,
        ]);
        const outputs = await session.run({ input_features: input });
        const first = outputs['logits'] ?? Object.values(outputs)[0];
        if (first === undefined) return -1;
        const data = first.data as Float32Array | number[];
        const value = data[0];
        return value === undefined ? -1 : Number(value);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.log(`[turn-judge] 推理失败：${detail}`);
        return -1;
      }
    };

    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return await next;
  }

  /** 幂等：标记停止并释放 ONNX session（进程退出 / 插件卸载时调用）。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const session = this.session;
    this.session = null;
    this.loading = null;
    void session?.release?.();
  }
}
