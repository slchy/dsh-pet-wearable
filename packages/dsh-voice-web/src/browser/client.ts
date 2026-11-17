/**
 * 浏览器侧的语音客户端：一条 WS 连到桥，上行走麦克风，下行走扬声器。
 *
 * 只做「接线 + 帧分发」，不带任何业务判断 —— 判停、打断、快车道都在服务端。
 * 打断是**靠上行音频**完成的：全双工下用户一开口，服务端的能量门就会把正在播的
 * 那一轮掐掉，浏览器这边不需要额外发信号，只需要在收到 `Control: stop` 时
 * 把本地已排队的音频丢掉。
 */
import { startCapture, type CaptureHandle } from './capture.ts';
import {
  DownstreamFrameType,
  FrameDecoder,
  UpstreamFrameType,
  decodeText,
  encodeFrame,
  encodeTextFrame,
} from './frames.ts';
import { createPlayback, type PlaybackHandle } from './playback.ts';

export type VoiceClientEvent =
  | { readonly type: 'open' }
  | { readonly type: 'ready' }
  | { readonly type: 'control'; readonly text: string }
  | { readonly type: 'call'; readonly json: unknown }
  /** 下行有没有声音在放：页面靠它显示「它在说话」 */
  | { readonly type: 'speaking'; readonly active: boolean }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'close'; readonly code: number; readonly reason: string };

export interface VoiceClientOptions {
  /** 桥地址，如 `wss://<服务器地址>:8767`。本地演示可用 `ws://127.0.0.1:8767` */
  readonly url: string;
  /** 服务端配了 `tokens.txt` 时必填；放在 `Hello` 帧里，不进 URL */
  readonly token?: string;
  /** 在服务端日志与档案里用什么名字标识这个浏览器 */
  readonly deviceId?: string;
  readonly onEvent?: (event: VoiceClientEvent) => void;
  /**
   * 每个上行块（PCM16 16 kHz）原样给一份，用来画电平表。
   *
   * 放这里而不是让页面再开一路麦克风：同一份数据只该被采集一次。
   */
  readonly onChunk?: (pcm: Uint8Array) => void;
}

export interface VoiceClient {
  /** 打开麦克风并建立连接。**必须在用户手势的调用栈里调用**（自动播放策略） */
  start(): Promise<void>;
  /** 立刻掐掉本地播放（服务端那边靠上行音频自己发现被打断） */
  interrupt(): void;
  close(): void;
  /** 音轨与播放是否都在跑 */
  readonly active: boolean;
  /**
   * 采集与播放共用的那个 `AudioContext`。
   *
   * 暴露出来是为了让调用方从**同一个** context 放测试信号：浏览器的回声消除
   * 拿同一 context 的输出当参考，另开一个 context 放出来的声音对 AEC 是"外人"，
   * 测出来的回波电平会偏高，没有意义。
   */
  readonly context: AudioContext | null;
}

/**
 * 能力声明。`audioIn: 'pcm16'` 是关键：服务端据此跳过 mSBC 解码
 * （`uplink-pipeline.ts` 的 `codec` 分支）。其余全报「没有」——
 * 浏览器没有拍照、佩戴、电量这些设备能力。
 */
function capabilities(): Record<string, unknown> {
  return {
    audioIn: 'pcm16',
    capture: {},
    presence: false,
    power: false,
    summon: false,
    listenStart: false,
    played: false,
    ignorePhrases: [],
  };
}

/** 下行原语是不是指定的那个 `op`。非对象、非字符串一律不算。 */
function isOp(json: unknown, op: string): boolean {
  return typeof json === 'object' && json !== null && (json as { op?: unknown }).op === op;
}

export function createVoiceClient(options: VoiceClientOptions): VoiceClient {
  let socket: WebSocket | null = null;
  let context: AudioContext | null = null;
  let capture: CaptureHandle | null = null;
  let playback: PlaybackHandle | null = null;
  const decoder = new FrameDecoder();
  let closed = false;

  const emit = (event: VoiceClientEvent): void => {
    options.onEvent?.(event);
  };

  const send = (frame: Uint8Array): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
    }
  };

  const handleFrame = (type: number, payload: Uint8Array): void => {
    if (type === DownstreamFrameType.Audio) {
      playback?.push(payload);
      return;
    }
    if (type === DownstreamFrameType.Control) {
      const text = decodeText(payload);
      // `stop` 是打断 / 一轮结束：已经排进去的音频不该再响
      if (text === 'stop' || text === 'end_session') {
        playback?.stop();
      }
      emit({ type: 'control', text });
      return;
    }
    if (type === DownstreamFrameType.Welcome) {
      emit({ type: 'ready' });
      return;
    }
    if (type === DownstreamFrameType.Call) {
      let json: unknown = null;
      try {
        json = JSON.parse(decodeText(payload));
      } catch {
        // 不是 JSON 就当空原语，别把整条连接搞崩
      }
      // v2 的打断信号是 `Call {"op":"audio.stop"}`（v1 时代才是 `Control: stop`，
      // 见 wire-v1.ts 的映射）。这里必须自己认：浏览器是 v2 设备，服务端不会再
      // 为它发 `Control: stop`，漏掉这一步就会在用户插话后继续把已排队的回答播完。
      if (isOp(json, 'audio.stop')) {
        playback?.stop();
      }
      emit({ type: 'call', json });
    }
  };

  return {
    get active(): boolean {
      return capture !== null && socket !== null && socket.readyState === WebSocket.OPEN;
    },

    get context(): AudioContext | null {
      return context;
    },

    async start(): Promise<void> {
      if (closed) {
        throw new Error('客户端已关闭，重新创建一个实例');
      }
      if (socket !== null) {
        return;
      }

      context = new AudioContext();
      // 用户手势里调 `resume` —— Safari 不加这句 context 会一直 suspended
      await context.resume();
      playback = createPlayback({
        context,
        onActivity: (busy) => { emit({ type: 'speaking', active: busy }); },
      });

      capture = await startCapture({
        context,
        onChunk: (pcm) => {
          options.onChunk?.(pcm);
          send(encodeFrame(UpstreamFrameType.Audio, pcm));
        },
        onError: (message) => { emit({ type: 'error', message }); },
      });

      socket = new WebSocket(options.url);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        emit({ type: 'open' });
        send(encodeTextFrame(UpstreamFrameType.Hello, JSON.stringify({
          proto: 2,
          deviceId: options.deviceId ?? 'web',
          ...(options.token === undefined || options.token === '' ? {} : { token: options.token }),
          capabilities: capabilities(),
        })));
      };

      socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        for (const frame of decoder.push(new Uint8Array(event.data))) {
          handleFrame(frame.type, frame.payload);
        }
      };

      socket.onerror = () => {
        emit({ type: 'error', message: 'WS 连接出错' });
      };

      socket.onclose = (event: CloseEvent) => {
        emit({ type: 'close', code: event.code, reason: event.reason });
      };
    },

    interrupt(): void {
      playback?.stop();
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      capture?.stop();
      capture = null;
      playback?.close();
      playback = null;
      if (socket !== null) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      void context?.close();
      context = null;
    },
  };
}
