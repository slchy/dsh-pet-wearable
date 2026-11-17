/**
 * 浏览器侧采集：麦克风 → 16 kHz 单声道 PCM16 小块。
 *
 * 采样率由 worklet 里做「累加-抽点」降采样（integrate-and-dump）：
 * 每 `inputRate / 16000` 个输入样本取一次均值。48 kHz → 16 kHz 正好三点平均，
 * 这本身就带一点低通，比直接抽第一个样本干净得多，也比写个多相滤波短。
 * 44.1 kHz 这类非整数比会出现步长在 2 与 3 之间抖动，语音听感上无所谓。
 *
 * **必须和播放共用一个 `AudioContext`**：浏览器的回声消除拿同一 context 里
 * 正在播放的信号当参考，采集单独开一个 context 就等于没有参考，外放时自己
 * 的声音会被当成用户在说话。
 */

/** worklet 以字符串内联，省掉调用方去配静态资源路径 —— demo 直接双击就能跑 */
const WORKLET_SOURCE = `
class VoiceCapturer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const targetRate = o.targetRate || 16000;
    this.ratio = sampleRate / targetRate;
    this.chunk = Math.max(1, Math.round(targetRate * (o.chunkMs || 20) / 1000));
    this.out = new Int16Array(this.chunk);
    this.n = 0;
    this.acc = 0;
    this.count = 0;
    this.phase = 0;
    this.alive = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') { this.alive = false; }
    };
  }
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.acc += channel[i];
        this.count += 1;
        this.phase += 1;
        if (this.phase >= this.ratio) {
          this.phase -= this.ratio;
          const mean = this.acc / this.count;
          this.acc = 0;
          this.count = 0;
          this.out[this.n] = mean < -1 ? -32768 : mean > 1 ? 32767 : (mean * 32767) | 0;
          this.n += 1;
          if (this.n >= this.out.length) {
            this.port.postMessage(this.out.buffer, [this.out.buffer]);
            this.out = new Int16Array(this.chunk);
            this.n = 0;
          }
        }
      }
    }
    return this.alive;
  }
}
registerProcessor('voice-capturer', VoiceCapturer);
`;

export interface CaptureOptions {
  /** 与播放共用的 context —— 别为采集单开一个，回声消除会失效 */
  readonly context: AudioContext;
  /** 上行采样率。服务端按 16 kHz 解释（`voice-session.ts` 的 `UPSTREAM_SAMPLE_RATE`） */
  readonly targetRate?: number;
  /** 每块多少毫秒。默认 20 ms，与常见的 ASR 分片节奏一致 */
  readonly chunkMs?: number;
  /** 拿到一块 PCM16（小端、单声道）。直接塞进 `UpstreamFrameType.Audio` 帧 */
  readonly onChunk: (pcm: Uint8Array) => void;
  readonly onError?: (message: string) => void;
}

export interface CaptureHandle {
  /** 实际生效的上行采样率 */
  readonly targetRate: number;
  stop(): void;
}

export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  const targetRate = options.targetRate ?? 16_000;
  const { context } = options;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // 三个都开着：外放场景下不自激比"原始音色"重要得多
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = context.createMediaStreamSource(stream);
  // 有输出口才有人拉这条图；输出的是静音，接 destination 不会出声
  const node = new AudioWorkletNode(context, 'voice-capturer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    processorOptions: { targetRate, chunkMs: options.chunkMs ?? 20 },
  });

  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    options.onChunk(new Uint8Array(event.data));
  };
  node.onprocessorerror = () => {
    options.onError?.('采集 worklet 异常退出');
  };

  source.connect(node);
  node.connect(context.destination);

  let stopped = false;
  return {
    targetRate,
    stop: (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      node.port.postMessage('stop');
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        // 已经断开
      }
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}
