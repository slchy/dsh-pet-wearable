/**
 * silero-vad v5 封装。
 *
 * **v5 的接口有两个坑，都是实测踩出来的，别按 v4 的文档写：**
 *
 * 1. 输入不是 `[1, 512]` 而是 `[1, 576]` —— 前面要拼 64 个采样点的上一帧 context。
 *    直接喂 512 时模型能跑、不报错，但输出恒定在 0.0005 左右，看起来像"模型坏了"。
 * 2. 输入值域是 `[-1, 1]`（int16 / 32768），不是 int16 原始值。
 *
 * 阈值 0.4 是标定出来的：同一段 37 秒录音在 0.9~0.02 之间判停点完全一致（10.08~10.18 s），
 * 说明判决稳定；0.01 会开始把噪声当语音。
 */
import type * as ort from 'onnxruntime-node';

/**
 * onnxruntime-node 的**惰性加载**。
 *
 * 神经 VAD 和旧的 MiMo 本地路径才用得上它，装完是 300 MB 量级。
 * 能量门路径（没模型、或 `VOICE_VAD=energy`）根本不 import。
 */
let ortPromise: Promise<typeof ort> | null = null;
const ortModule = (): Promise<typeof ort> => {
  ortPromise ??= import('onnxruntime-node');
  return ortPromise;
};

export const SAMPLE_RATE = 16_000;
/** 每帧采样点数（32 ms） */
export const WINDOW = 512;
/** v5 需要拼接的 context 长度 */
const CONTEXT = 64;

export class SileroVad {
  private readonly modelPath: string;
  private session: ort.InferenceSession | null = null;
  private state: ort.Tensor | null = null;
  private context = new Float32Array(CONTEXT);

  constructor(modelPath = 'models/silero_vad.onnx') {
    this.modelPath = modelPath;
  }

  async init(): Promise<void> {
    const o = await ortModule();
    this.session = await o.InferenceSession.create(this.modelPath);
    this.reset(await ortModule());
  }

  reset(o?: typeof ort): void {
    // LSTM 的 h/c 两个状态，[2, batch, 128]
    if (o) {
      this.state = new o.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    } else if (this.state) {
      // 无参且已经 init：清零复用这块 Tensor。设成 null 的话下一次 process 会抛「尚未 init」。
      const data = this.state.data;
      if (data instanceof Float32Array) {
        data.fill(0);
      }
    }
    this.context = new Float32Array(CONTEXT);
  }

  /** @param frame 恰好 WINDOW 个采样点，值域 [-1, 1] */
  async process(frame: Float32Array): Promise<number> {
    if (!this.session || !this.state) {
      throw new Error('SileroVad 尚未 init()');
    }
    if (frame.length !== WINDOW) {
      throw new Error(`帧长必须是 ${WINDOW}，收到 ${frame.length}`);
    }

    const x = new Float32Array(CONTEXT + WINDOW);
    x.set(this.context, 0);
    x.set(frame, CONTEXT);

    const o = await ortModule();
    const out = await this.session.run({
      input: new o.Tensor('float32', x, [1, CONTEXT + WINDOW]),
      state: this.state,
      sr: new o.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    });

    this.state = out.stateN as ort.Tensor;
    this.context = frame.slice(WINDOW - CONTEXT);

    const data = (out.output as ort.Tensor).data as Float32Array;
    return data[0] ?? 0;
  }
}

/**
 * 一条连接上的神经 VAD。`process` 的帧必须恰好是 {@link WINDOW} 个 `[-1, 1]` 采样。
 * 同一个流禁止并发调用 `process`：LSTM 状态只有一份。
 */
export interface SpeechVadStream {
  /** 传入恰好 WINDOW (512) 个 [-1, 1] float32 采样点（32 ms），返回人声概率 [0, 1] */
  process(frame: Float32Array): Promise<number>;
  reset(): void;
}

/** 进程内共享的一份模型会话。每条连接 {@link SharedSpeechVad.createStream} 自己的状态。 */
export interface SharedSpeechVad {
  readonly modelPath: string;
  createStream(): SpeechVadStream;
  dispose?(): Promise<void> | void;
}

/**
 * 一份共享的 Silero v5 会话，多条连接各拿一个轻量流。
 *
 * 会话只创建一次。每条流自己持有 `state`、64 点 context，以及复用的 `sr` 张量和
 * 输入缓冲，避免每帧重新分配，也避免两条连接把 LSTM 状态写串。
 */
export class SileroVadModel implements SharedSpeechVad {
  readonly modelPath: string;
  private session: ort.InferenceSession | null;
  private readonly ortApi: typeof ort;
  private released = false;

  private constructor(modelPath: string, session: ort.InferenceSession, ortApi: typeof ort) {
    this.modelPath = modelPath;
    this.session = session;
    this.ortApi = ortApi;
  }

  static async load(modelPath: string): Promise<SileroVadModel> {
    const ortApi = await ortModule();
    const session = await ortApi.InferenceSession.create(modelPath);
    return new SileroVadModel(modelPath, session, ortApi);
  }

  createStream(): SpeechVadStream {
    if (this.session === null) {
      throw new Error('SileroVadModel 已释放');
    }
    return new SileroVadStream(this.session, this.ortApi);
  }

  /** 释放共享会话。重复调用是空操作。 */
  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const session = this.session;
    this.session = null;
    if (session === null) return;
    const release = (session as unknown as { release?: () => Promise<void> | void }).release;
    if (typeof release === 'function') {
      await release.call(session);
    }
  }
}

/** 每条连接一份：状态张量与 context 不与其它流共享。 */
class SileroVadStream implements SpeechVadStream {
  private readonly session: ort.InferenceSession;
  private readonly ortApi: typeof ort;
  private state: ort.Tensor;
  private context: Float32Array;
  /** 复用的输入缓冲：`[context | frame]`，长度 {@link CONTEXT} + {@link WINDOW} */
  private readonly x: Float32Array;
  /** 复用的采样率张量。每条流一份，避免和别的流抢同一块只读输入。 */
  private readonly sr: ort.Tensor;

  constructor(session: ort.InferenceSession, ortApi: typeof ort) {
    this.session = session;
    this.ortApi = ortApi;
    this.context = new Float32Array(CONTEXT);
    this.x = new Float32Array(CONTEXT + WINDOW);
    this.state = new ortApi.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.sr = new ortApi.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  }

  reset(): void {
    const data = this.state.data;
    if (data instanceof Float32Array) {
      data.fill(0);
    }
    this.context.fill(0);
  }

  async process(frame: Float32Array): Promise<number> {
    if (frame.length !== WINDOW) {
      throw new Error(`帧长必须是 ${WINDOW}，收到 ${frame.length}`);
    }
    this.x.set(this.context, 0);
    this.x.set(frame, CONTEXT);
    const out = await this.session.run({
      input: new this.ortApi.Tensor('float32', this.x, [1, CONTEXT + WINDOW]),
      state: this.state,
      sr: this.sr,
    });
    this.state = out['stateN'] as ort.Tensor;
    this.context.set(frame.subarray(WINDOW - CONTEXT));
    const data = (out['output'] as ort.Tensor).data as Float32Array;
    return data[0] ?? 0;
  }
}

/**
 * 把 int16 PCM 缓冲转成 [-1, 1] 的 float 帧。
 *
 * @returns 完整的帧数组，剩余不足一帧的字节由调用方保留
 */
export function sliceFrames(pcm: Buffer): { frames: Float32Array[]; rest: Buffer } {
  const FRAME_BYTES = WINDOW * 2;
  const count = Math.floor(pcm.length / FRAME_BYTES);
  const frames: Float32Array[] = [];

  for (let i = 0; i < count; i += 1) {
    const f = new Float32Array(WINDOW);
    const base = i * FRAME_BYTES;
    for (let j = 0; j < WINDOW; j += 1) {
      f[j] = pcm.readInt16LE(base + j * 2) / 32768;
    }
    frames.push(f);
  }

  return { frames, rest: pcm.subarray(count * FRAME_BYTES) };
}
