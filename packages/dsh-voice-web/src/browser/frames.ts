/**
 * 浏览器侧的帧编解码。
 *
 * 与仓根 `src/frame.ts` 是**同一套字节格式**，但这里不碰 `Buffer` —— 浏览器没有。
 * 两份能同时存在是因为协议本身只要求 `[type:u8][len:u32 LE][payload]` 这么点信息，
 * 各写各的实现比把 `Buffer` 与 `Uint8Array` 统一成一层抽象要短。
 *
 * 桥是透传的，浏览器收到的 WS 消息可能是半个帧，也可能是三个帧 —— `FrameDecoder`
 * 必须能吃任意切分。
 */

/** 帧头长度：1 字节类型 + 4 字节长度 */
export const FRAME_HEADER_BYTES = 5;

/**
 * 单帧上限，与 `src/frame.ts` 的 `FRAME_MAX_BYTES` 同一数字。
 * 超过就判定长度字段错位，停止解码 —— 继续吃后面的字节会把半截载荷当帧头。
 */
export const FRAME_MAX_BYTES = 32 << 20;

/** 上行帧类型（浏览器 → 云端），与 `src/frame.ts` 的 `UpstreamFrameType` 对齐 */
export const UpstreamFrameType = {
  Audio: 1,
  Image: 2,
  Wake: 3,
  Ping: 4,
  Status: 5,
  Hello: 6,
  Event: 7,
  CaptureImage: 8,
} as const;

/** 下行帧类型（云端 → 浏览器），与 `src/frame.ts` 的 `DownstreamFrameType` 对齐 */
export const DownstreamFrameType = {
  /** PCM16 24 kHz */
  Audio: 1,
  Control: 2,
  Call: 3,
  Welcome: 4,
  Pong: 5,
} as const;

export interface DecodedFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  out[0] = type;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(1, payload.length, true);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export function encodeTextFrame(type: number, text: string): Uint8Array {
  return encodeFrame(type, new TextEncoder().encode(text));
}

const utf8 = new TextDecoder();

export function decodeText(payload: Uint8Array): string {
  return utf8.decode(payload);
}

/**
 * 增量解帧。喂任意切分的字节流，吐出凑齐的帧。
 *
 * 每次 `push` 都复制一次剩余字节。上行下行都只有几十 KB/s、帧也不大，
 * 这点拷贝比维护环形缓冲的复杂度便宜。
 */
export class FrameDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  /** 长度错位之后字节流没有边界，后面的 `push` 必须直接丢掉。 */
  private stopped = false;
  private readonly onProtocolError: ((reason: string) => void) | undefined;
  private readonly maxBytes: number;

  constructor(onProtocolError?: (reason: string) => void, maxBytes = FRAME_MAX_BYTES) {
    this.onProtocolError = onProtocolError;
    this.maxBytes = maxBytes;
  }

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.stopped) {
      return [];
    }
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    const frames: DecodedFrame[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= FRAME_HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, this.buffer.byteLength - offset);
      const type = this.buffer[offset] ?? 0;
      const length = view.getUint32(1, true);
      if (length > this.maxBytes) {
        // 长度已经错位，后面的字节没法再对齐。先停掉，再通知：
        // 回调里若再 `push`，必须看见 `stopped`，不能递归解帧。
        this.buffer = new Uint8Array(0);
        this.stopped = true;
        this.onProtocolError?.(`帧长异常 ${length}（上限 ${this.maxBytes}），丢弃整个缓冲`);
        return frames;
      }
      if (this.buffer.length - offset - FRAME_HEADER_BYTES < length) {
        break;
      }
      const start = offset + FRAME_HEADER_BYTES;
      frames.push({ type, payload: this.buffer.subarray(start, start + length) });
      offset = start + length;
    }

    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset);
    return frames;
  }
}
