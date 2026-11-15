/**
 * 手机 ↔ 云端的分帧协议：`[type:u8][length:u32 LE][payload]`。
 *
 * 本模块**只做编解码**，不认识任何业务语义；I/O 由调用方负责
 * （{@link FrameWriter} 只依赖 `Writable`，不依赖 `net.Socket`）。
 */
import type { Writable } from 'node:stream';

/** 帧头长度：1 字节类型 + 4 字节长度 */
export const FRAME_HEADER_BYTES = 5;

/**
 * 单帧上限。超过就判定为长度字段错位，丢弃整个接收缓冲 ——
 * 否则会一直等一个永远不会凑齐的长度。
 */
export const FRAME_MAX_BYTES = 32 << 20;

/**
 * **鉴权前**允许的帧长上限。
 *
 * 未通过 `Hello` 的连接只该发 `Hello`（几百字节）。给 64 KB 余量已经足够宽松，
 * 但比 32 MB 少三个数量级 —— 未鉴权的对端没法先声明一个 32 MB 的帧再把服务端
 * 的内存慢慢灌满（`push()` 每来一块都要 `Buffer.concat`，灌 32 MB 是 O(n²) 拷贝）。
 *
 * 鉴权通过后由 {@link FrameDecoder.setMaxBytes} 放宽回 {@link FRAME_MAX_BYTES}。
 */
export const UNAUTH_FRAME_MAX_BYTES = 64 * 1024;

/** 上行帧类型（手机 → 云端） */
export const UpstreamFrameType = {
  /** mSBC 原始字节，未解码 */
  Audio: 1,
  /** JPEG */
  Image: 2,
  /** 唤醒上下文：`transactionId\nrequestId` */
  Wake: 3,
  /**
   * 心跳。payload 忽略，服务端回 {@link DownstreamFrameType.Pong}。
   *
   * 可选：服务端不要求心跳也能工作，只是 NAT 会在几分钟后把静默连接掐掉。
   */
  Ping: 4,
  /**
   * 状态事件。payload 是 UTF-8 JSON：`{"ev":"hq_armed","fresh":"false"}`。
   *
   * 高清照流程靠它说话 —— 没有这条通道时，手机早已放弃，云端还得自己干等到
   * 超时才有人知道「用户没按快门」。
   *
   * - `hq_armed`：P2P 与相册都通了，`fresh` 表示相机里是否**已经有**新图
   * - `hq_image`：紧接一个 {@link Image} 帧，说明它是高清原图（不是 SPP 低清）
   * - `hq_failed`：`reason` 见 `photo-inbox.ts` 的 `PhotoFailReason`
   */
  Status: 5,
  /**
   * 首帧身份。payload 是 UTF-8 JSON：
   * `{"proto":1,"deviceId":"...","token":"..."}`
   *
   * v2 设备再带 `"proto":2` 与 `"capabilities":{...}`（见 `src/devices/primitives.ts`
   * 的 `parseCapabilities`），服务端认了会回 {@link DownstreamFrameType.Welcome}。
   *
   * **只有服务端配了 `authenticate` 时才必须**；没配时 v1 手机可以不发。
   * 这样"只想跑起来看看"的人不用先造一套凭据。
   */
  Hello: 6,
  /** v2：一条原语事件，UTF-8 JSON `DeviceEvent`（`{"kind":"presence","wearing":true}`） */
  Event: 7,
  /**
   * v2：拍照请求的回图，`[idLen:u8][id:UTF-8][JPEG]`。
   *
   * 用户自己拍的图（不属于任何请求）仍走 {@link Image}。
   */
  CaptureImage: 8,
} as const;

/** 下行帧类型（云端 → 手机） */
export const DownstreamFrameType = {
  /** PCM16 24 kHz */
  Audio: 1,
  /** UTF-8 控制串：`take_photo` / `take_photo_hq` / `stop_capture` / `hq_cancel` / `stop` */
  Control: 2,
  /** v2：一个原语操作，UTF-8 JSON `DeviceCall`（`{"op":"audio.stop"}`） */
  Call: 3,
  /**
   * v2：接受 v2 的回执，UTF-8 JSON `{"proto":2}`。
   *
   * 老服务端不会发它 —— 设备据此退回 v1，这就是向下兼容的握手。
   */
  Welcome: 4,
  /** 心跳应答，payload 为空 */
  Pong: 5,
} as const;

export interface DecodedFrame {
  readonly type: number;
  readonly payload: Buffer;
}

/**
 * 增量解帧。
 *
 * `push` 可以喂任意切分的字节流（TCP 会任意切），返回本次凑齐的完整帧；
 * 未凑齐的留在内部缓冲里。**半包必须处理** —— 假设一次 `read` 拿到完整帧
 * 是这类协议最常见的错。
 */
export class FrameDecoder {
  private readonly onProtocolError: (message: string) => void;
  private buffer: Buffer = Buffer.alloc(0);
  /**
   * 当前允许的最大帧长。
   *
   * 刻意做成**可变**：未鉴权的连接只配拿 `Hello`，上限收紧到
   * {@link UNAUTH_FRAME_MAX_BYTES}；鉴权通过后由 {@link setMaxBytes} 放宽。
   */
  private maxBytes: number;

  constructor(onProtocolError: (message: string) => void, maxBytes: number = FRAME_MAX_BYTES) {
    this.onProtocolError = onProtocolError;
    this.maxBytes = maxBytes;
  }

  /**
   * 调整帧长上限（鉴权通过后调用）。
   *
   * 只放宽不放宽到超过 {@link FRAME_MAX_BYTES}；同时把已经攒着但已超限的缓冲丢掉 ——
   * 那些字节属于未鉴权阶段的越权尝试，没有保留的意义。
   */
  setMaxBytes(maxBytes: number): void {
    this.maxBytes = Math.min(Math.max(1, maxBytes), FRAME_MAX_BYTES);
    if (this.buffer.length > this.maxBytes) {
      this.onProtocolError(`未鉴权期间攒了 ${this.buffer.length} B，超过上限，丢弃`);
      this.buffer = Buffer.alloc(0);
    }
  }

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const frames: DecodedFrame[] = [];
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const type = this.buffer[0] ?? 0;
      const length = this.buffer.readUInt32LE(1);
      if (length > this.maxBytes) {
        this.onProtocolError(`帧长异常 ${length}（上限 ${this.maxBytes}），丢弃整个缓冲`);
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < FRAME_HEADER_BYTES + length) {
        break;
      }
      const start = FRAME_HEADER_BYTES;
      const end = FRAME_HEADER_BYTES + length;
      frames.push({ type, payload: this.buffer.subarray(start, end) });
      this.buffer = this.buffer.subarray(end);
    }
    return frames;
  }
}

/** 下行帧写出。头与载荷分两次写，避免大 JPEG 多拷一份。 */
export class FrameWriter {
  private readonly sink: Writable;

  constructor(sink: Writable) {
    this.sink = sink;
  }

  write(type: number, payload: Buffer): void {
    if (this.sink.destroyed) {
      return;
    }
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header[0] = type;
    header.writeUInt32LE(payload.length, 1);
    this.sink.write(header);
    this.sink.write(payload);
  }

  writeText(type: number, text: string): void {
    this.write(type, Buffer.from(text, 'utf8'));
  }
}
