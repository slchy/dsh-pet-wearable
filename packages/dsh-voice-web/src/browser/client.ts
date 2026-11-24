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

/**
 * 一条客户端的生命周期。`closed` 是吸收态：再 `start()` 必须换一个实例。
 *
 * `starting` 覆盖两个 await（`resume`、`getUserMedia`）。代次对不上就拆掉
 * 刚拿到的麦和 context，不能等下一次 `close()` —— 那次调用会直接返回。
 */
export type ClientPhase = 'idle' | 'starting' | 'connecting' | 'open' | 'closed';

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
  let phase: ClientPhase = 'idle';
  /** 每次真正进入 `start()` 加一。`teardown` 再加一，作废还停在 await 上的那一次。 */
  let startGen = 0;
  let socket: WebSocket | null = null;
  let context: AudioContext | null = null;
  let capture: CaptureHandle | null = null;
  let playback: PlaybackHandle | null = null;
  let closeInfo: { code: number; reason: string } = { code: 1000, reason: '' };

  const emit = (event: VoiceClientEvent): void => {
    options.onEvent?.(event);
  };

  /**
   * 停麦、停播放、关 context、摘掉 socket 回调。`close` 事件最多一次。
   *
   * `close()` 传 `false`：页面自己的「结束」按钮已经改了 UI，再发一次会和
   * `onclose` 套娃。连接自己断、协议错、`onerror` 传 `true`。
   */
  const teardown = (emitClose: boolean): void => {
    if (phase === 'closed') {
      return;
    }
    phase = 'closed';
    startGen += 1;
    const info = closeInfo;
    const ws = socket;
    socket = null;
    if (ws !== null) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    capture?.stop();
    capture = null;
    // 先停播放再关 context：`source.stop()` 需要 context 还活着。
    playback?.close();
    playback = null;
    const ctx = context;
    context = null;
    if (ctx !== null && ctx.state !== 'closed') {
      void ctx.close();
    }
    if (emitClose) {
      emit({ type: 'close', code: info.code, reason: info.reason });
    }
  };

  const decoder = new FrameDecoder((reason) => {
    if (phase === 'closed') {
      return;
    }
    closeInfo = { code: 1002, reason };
    emit({ type: 'error', message: reason });
    teardown(true);
  });

  const send = (frame: Uint8Array): void => {
    if (phase === 'closed' || socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(frame);
  };

  const handleFrame = (type: number, payload: Uint8Array): void => {
    if (phase === 'closed') {
      return;
    }
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
      return phase === 'open' && capture !== null && socket !== null && socket.readyState === WebSocket.OPEN;
    },

    get context(): AudioContext | null {
      return context;
    },

    async start(): Promise<void> {
      if (phase === 'closed') {
        throw new Error('客户端已关闭，重新创建一个实例');
      }
      if (phase !== 'idle') {
        return;
      }
      phase = 'starting';
      const myGen = ++startGen;

      const stillStarting = (): boolean => phase === 'starting' && myGen === startGen;

      let ctx: AudioContext;
      try {
        ctx = new AudioContext();
      } catch (error) {
        teardown(false);
        throw error;
      }
      context = ctx;
      // teardown 已经关过共享 context 时不要再关一遍（close 尚未落定，state 可能还不是 closed）。
      // 麦如果是这次 await 才拿到的，teardown 看不见，必须在这里 stop。
      const abandon = (cap: CaptureHandle | null): void => {
        cap?.stop();
        if (phase !== 'closed') {
          teardown(false);
          return;
        }
        if (context === ctx) {
          context = null;
          playback?.close();
          playback = null;
          if (ctx.state !== 'closed') {
            void ctx.close();
          }
        }
      };
      // 用户手势里调 `resume` —— Safari 不加这句 context 会一直 suspended。
      // await 期间 `close()` 会把 phase 打成 closed 并加代次；回来必须先核对，
      // 再决定要不要去申请麦克风。
      try {
        await ctx.resume();
      } catch (error) {
        if (!stillStarting()) {
          abandon(null);
          return;
        }
        teardown(false);
        throw error;
      }
      if (!stillStarting()) {
        abandon(null);
        return;
      }

      playback = createPlayback({
        context: ctx,
        onActivity: (busy) => { emit({ type: 'speaking', active: busy }); },
      });

      let cap: CaptureHandle;
      try {
        cap = await startCapture({
          context: ctx,
          onChunk: (pcm) => {
            options.onChunk?.(pcm);
            send(encodeFrame(UpstreamFrameType.Audio, pcm));
          },
          onError: (message) => { emit({ type: 'error', message }); },
        });
      } catch (error) {
        if (!stillStarting()) {
          abandon(null);
          return;
        }
        teardown(false);
        throw error;
      }
      // 权限框可以停很久。这期间关掉的话，刚拿到的麦还没赋给 `capture`，
      // teardown 停不到它 —— 这里必须自己 stop，并且关掉还挂在手里的 context。
      if (!stillStarting()) {
        abandon(cap);
        return;
      }

      capture = cap;
      phase = 'connecting';
      let ws: WebSocket;
      try {
        ws = new WebSocket(options.url);
      } catch (error) {
        teardown(false);
        throw error;
      }
      socket = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (phase !== 'connecting' || myGen !== startGen || socket !== ws) {
          return;
        }
        phase = 'open';
        emit({ type: 'open' });
        send(encodeTextFrame(UpstreamFrameType.Hello, JSON.stringify({
          proto: 2,
          deviceId: options.deviceId ?? 'web',
          ...(options.token === undefined || options.token === '' ? {} : { token: options.token }),
          capabilities: capabilities(),
        })));
      };

      ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (phase === 'closed' || socket !== ws) {
          return;
        }
        for (const frame of decoder.push(new Uint8Array(event.data))) {
          handleFrame(frame.type, frame.payload);
        }
      };

      ws.onerror = () => {
        if (phase === 'closed') {
          return;
        }
        emit({ type: 'error', message: 'WS 连接出错' });
        closeInfo = { code: 1006, reason: 'WS 连接出错' };
        teardown(true);
      };

      ws.onclose = (event: CloseEvent) => {
        if (phase === 'closed') {
          return;
        }
        closeInfo = { code: event.code, reason: event.reason };
        teardown(true);
      };
    },

    interrupt(): void {
      playback?.stop();
    },

    close(): void {
      teardown(false);
    },
  };
}
