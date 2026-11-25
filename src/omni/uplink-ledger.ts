/**
 * 上行音频账本。只拥有这 10 个缓冲字段，不管连接、也不管回复相位。
 *
 * - `dirtyBytes = serverBufferedBytes + heldBytes`（parked 不进脏账）
 * - 静音期只进 `ring`
 * - `parkSegment()` 划走活账后 `dirtyBytes === 0`
 * - 溢出优先丢 `parkedHeld`
 * - `discard()` 把 `parkedServerBytes` 归还 `serverBufferedBytes`，不发 commit
 * - `clearLocal()` 不清服务端缓冲计数
 * - `restartSnapshot()` 先读服务端缓冲，再决定调用方要不要裸 commit
 */
import { BYTES_PER_MILLISECOND, DEFAULT_RING_MS } from './protocol.ts';

/** 生成期最多暂存多少音频（一份回答通常 2–4 s；8 s 是防挂死的上限） */
export const MAX_HELD_BYTES = BYTES_PER_MILLISECOND * 8000;

export class UplinkLedger {
  muted = true;
  ring: Buffer[] = [];
  ringBytes = 0;
  serverBufferedBytes = 0;
  parkedServerBytes = 0;
  parkedHeld: Buffer[] = [];
  parkedHeldBytes = 0;
  held: Buffer[] = [];
  heldBytes = 0;
  lastFlushedMs = 0;
  droppedBytes = 0;
  readonly ringMaxBytes: number;
  private readonly log: (line: string) => void;

  constructor(ringMs: number | undefined, log: (line: string) => void) {
    this.log = log;
    this.ringMaxBytes = Math.round(BYTES_PER_MILLISECOND * (ringMs ?? DEFAULT_RING_MS));
  }

  /** 还没划进 seal 的音频：服务端缓冲 + 本地暂存。 */
  get dirtyBytes(): number {
    return this.serverBufferedBytes + this.heldBytes;
  }

  /**
   * 一块上行。静音且无声：只进 ring，返回空，调用方什么都别 append。
   * 静音期又开口：解除静音，把软起音和这一块交回去 append。
   * 已经开着：原样交回这一块。
   */
  accept(pcm: Buffer, voiced: boolean): Buffer[] {
    if (this.muted) {
      if (!voiced) {
        this.pushRing(pcm);
        return [];
      }
      this.muted = false;
      const buffered = this.ring.length === 0 ? null : Buffer.concat(this.ring);
      this.ring = [];
      this.ringBytes = 0;
      const out: Buffer[] = [];
      if (buffered !== null && buffered.length > 0) {
        out.push(buffered);
      }
      out.push(pcm);
      return out;
    }
    return [pcm];
  }

  /** 封段开头：先闭嘴并清掉 ring，返回此刻的脏字节。空段也不许把账清零。 */
  muteForSeal(): number {
    this.muted = true;
    this.ring = [];
    this.ringBytes = 0;
    return this.dirtyBytes;
  }

  /**
   * 新一轮开口的账本半边。
   *
   * 先读 `serverBufferedBytes + parkedServerBytes`（held 不算，它从没进服务端），
   * 再清本地、把服务端计数归零。返回值 > 0 时调用方发一次**不带 create** 的 commit，
   * 并把 `lastFlushedMs` 留给下一份 seal。返回 0 时不动 `lastFlushedMs`。
   */
  restartSnapshot(): number {
    this.ring = [];
    this.ringBytes = 0;
    const serverBytes = this.serverBufferedBytes + this.parkedServerBytes;
    this.clearLocal();
    this.serverBufferedBytes = 0;
    this.parkedServerBytes = 0;
    if (serverBytes > 0) {
      this.lastFlushedMs = Math.round(serverBytes / BYTES_PER_MILLISECOND);
    }
    this.muted = false;
    return serverBytes;
  }

  noteDropped(byteLength: number): void {
    this.droppedBytes += byteLength;
  }

  noteServerAppend(byteLength: number): void {
    this.serverBufferedBytes += byteLength;
  }

  /** 生成期 / connecting 的帧留在本地。溢出从最早的一帧丢，先丢 parked。 */
  hold(pcm: Buffer): void {
    this.held.push(pcm);
    this.heldBytes += pcm.length;
    this.trimLocalAudio();
  }

  /**
   * 把当前活账本划给即将 commit 的这一段。
   * 划走之后 `dirtyBytes` 归零，后面新到的音频另算下一段。
   */
  parkSegment(): void {
    this.parkedServerBytes += this.serverBufferedBytes;
    this.serverBufferedBytes = 0;
    if (this.held.length === 0) {
      return;
    }
    for (const frame of this.held) {
      this.parkedHeld.push(frame);
    }
    this.parkedHeldBytes += this.heldBytes;
    this.held = [];
    this.heldBytes = 0;
    this.trimLocalAudio();
  }

  /** 本地暂存（含已划进 seal、还没 append 的）全部丢掉。不动服务端账。 */
  clearLocal(): void {
    this.held = [];
    this.heldBytes = 0;
    this.parkedHeld = [];
    this.parkedHeldBytes = 0;
  }

  /**
   * `discard()` 的账本半边：本地帧丢掉。
   * 已经在服务端缓冲里的字节留在账上（`parkedServerBytes` 加回 `serverBufferedBytes`），
   * 下次 `restart()` 看见它再 commit。这里**不发 commit**。
   */
  discard(): void {
    this.clearLocal();
    this.serverBufferedBytes += this.parkedServerBytes;
    this.parkedServerBytes = 0;
  }

  /** teardown / 断线作废排队段：本地清掉，服务端计数归零。不动 ring / dropped / flushed。 */
  releaseAllBuffered(): void {
    this.clearLocal();
    this.serverBufferedBytes = 0;
    this.parkedServerBytes = 0;
  }

  /** 取走划进 seal、还没 append 的本地帧。不改 `serverBufferedBytes`。 */
  takeParkedFrames(): Buffer[] {
    if (this.parkedHeld.length === 0) {
      return [];
    }
    const frames = this.parkedHeld.splice(0);
    this.parkedHeldBytes = 0;
    return frames;
  }

  /** commit 发出去之前，把「已经在服务端、划进这份 seal」的计数清掉。 */
  forgetParkedServer(): void {
    this.parkedServerBytes = 0;
  }

  /**
   * 生成已经结束、没有排队 seal：把还留在本地的帧交回去 append。
   * 字节从 `heldBytes` 挪到 `serverBufferedBytes`，`dirtyBytes` 不变。
   * 调用方必须已经确认可以推。
   */
  releaseHeldToServer(): Buffer[] {
    const frames = this.held.splice(0);
    const bytes = this.heldBytes;
    this.heldBytes = 0;
    this.serverBufferedBytes += bytes;
    return frames;
  }

  /** 成功建出一份 seal 时取走「顺带 flush 的残留」，并清零。 */
  consumeFlushedMs(): number {
    const flushed = this.lastFlushedMs;
    this.lastFlushedMs = 0;
    return flushed;
  }

  private pushRing(pcm: Buffer): void {
    this.ring.push(Buffer.from(pcm));
    this.ringBytes += pcm.length;
    while (this.ringBytes > this.ringMaxBytes && this.ring.length > 1) {
      const dropped = this.ring.shift();
      this.ringBytes -= dropped?.length ?? 0;
    }
  }

  private trimLocalAudio(): void {
    while (
      this.heldBytes + this.parkedHeldBytes > MAX_HELD_BYTES
      && (this.parkedHeld.length > 0 || this.held.length > 0)
    ) {
      if (this.parkedHeld.length > 0) {
        this.parkedHeldBytes -= this.parkedHeld.shift()?.length ?? 0;
      } else {
        this.heldBytes -= this.held.shift()?.length ?? 0;
      }
      this.log('[omni] 暂存溢出，丢掉最早一帧');
    }
  }
}
