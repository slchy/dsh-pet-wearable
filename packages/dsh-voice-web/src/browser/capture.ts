/**
 * 浏览器侧采集：麦克风 → 16 kHz 单声道 PCM16 小块。
 *
 * 采样率由 worklet 里做「低通抗混叠 + 分数相位线性插值」重采样：
 * 15 阶 Hamming 窗 sinc 低通滤掉奈奎斯特以上高频，再用分数步长插值输出，
 * 同时兼容 48 kHz（3:1）与 44.1 kHz（2.756:1），避免简单抽点在 44.1 kHz 下
 * 2/3 步长抖动与混叠损伤中文清辅音识别；16 kHz 输入直接透传。
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
    this.passthrough = Math.abs(this.ratio - 1) < 1e-6;
    this.useFilter = this.ratio > 1.001;
    this.tapCount = 15;
    this.taps = new Float32Array(this.tapCount);
    this.hist = new Float32Array(this.tapCount);
    this.histIdx = 0;
    if (this.useFilter) {
      const half = (this.tapCount - 1) / 2;
      const fc = 0.45 / this.ratio;
      let sum = 0;
      for (let k = 0; k < this.tapCount; k += 1) {
        const m = k - half;
        const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (this.tapCount - 1));
        this.taps[k] = sinc * win;
        sum += this.taps[k];
      }
      if (sum !== 0) {
        for (let k = 0; k < this.tapCount; k += 1) {
          this.taps[k] /= sum;
        }
      }
    }
    this.pos = 0;
    this.prevY = 0;
    this.currY = 0;
    this.started = false;
    this.alive = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') { this.alive = false; }
    };
  }
  pushSample(v) {
    this.out[this.n] = v < -1 ? -32768 : v > 1 ? 32767 : Math.round(v * 32767);
    this.n += 1;
    if (this.n >= this.out.length) {
      this.port.postMessage(this.out.buffer, [this.out.buffer]);
      this.out = new Int16Array(this.chunk);
      this.n = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel) {
      if (this.passthrough) {
        for (let i = 0; i < channel.length; i += 1) {
          this.pushSample(channel[i]);
        }
      } else {
        const taps = this.taps;
        const hist = this.hist;
        const nTaps = this.tapCount;
        for (let i = 0; i < channel.length; i += 1) {
          let y = channel[i];
          if (this.useFilter) {
            hist[this.histIdx] = y;
            this.histIdx += 1;
            if (this.histIdx >= nTaps) this.histIdx = 0;
            let acc = 0;
            let idx = this.histIdx;
            for (let k = 0; k < nTaps; k += 1) {
              acc += taps[k] * hist[idx];
              idx += 1;
              if (idx >= nTaps) idx = 0;
            }
            y = acc;
          }
          if (!this.started) {
            this.prevY = y;
            this.currY = y;
            this.started = true;
          } else {
            this.prevY = this.currY;
            this.currY = y;
            this.pos -= 1;
          }
          while (this.pos <= 0) {
            const alpha = 1 + this.pos;
            this.pushSample(this.prevY + (this.currY - this.prevY) * alpha);
            this.pos += this.ratio;
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
