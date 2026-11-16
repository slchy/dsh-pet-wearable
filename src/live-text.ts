/**
 * 流式文本：dsh 内部的 token 流经**侧通道**送到这里，再按「20 token 内不流式」放出去。
 *
 * <h2>为什么要门槛</h2>
 *
 * SDK 只给整段 `assistant/message`，长回答（后台任务汇报）要等全文到齐才能合成，
 * 那几秒完全是白等。但我们不希望每句「嗯。」都走流式：短答好处为零，却要多付出
 * 分段合成、分段下发、可能的接缝。所以攒够 {@link LiveGate} 的阈值再释放。
 *
 * <h2>三段式</h2>
 *
 * ```
 *   token 1..20   只进缓冲，对外一个字都不说
 *   token 21      一次性交出前 20 个（start），之后逐个直通（delta）
 *   结束          end
 *
 *   整段不到 20 个 token：finish 时一次交出（start + end），走原来的整段路径
 * ```
 *
 * 这样短答的行为和没有流式完全一样，长答的第一句能提前几百毫秒进 TTS。
 */
import { createServer, type Server, type Socket } from 'node:net';

export type LiveEvent =
  /** 攒够阈值，一次性交出前 N 个 token */
  | { readonly type: 'start'; readonly text: string }
  /** 之后每个 token 直通 */
  | { readonly type: 'delta'; readonly text: string }
  /** 这条流结束了（不管有没有释放过） */
  | { readonly type: 'end'; readonly streaming: boolean; readonly tokens: number };

/** 门槛：默认 20 个 token 之内不流式。 */
export const LIVE_TOKEN_THRESHOLD = 20;

export class LiveGate {
  private readonly threshold: number;
  private tokens = 0;
  private buffered = '';
  private released = false;
  private finished = false;

  constructor(threshold: number = LIVE_TOKEN_THRESHOLD) {
    this.threshold = threshold;
  }

  /** 喂一个 token（一次 `text-delta`），返回要放出去的事件。 */
  push(token: string): LiveEvent[] {
    if (this.finished || token === '') {
      return [];
    }
    this.tokens += 1;
    if (this.released) {
      return [{ type: 'delta', text: token }];
    }
    if (this.tokens <= this.threshold) {
      this.buffered += token;
      return [];
    }
    // 第 threshold+1 个 token：先释放缓冲里的前 N 个，这一个走直通
    this.released = true;
    const text = this.buffered;
    this.buffered = '';
    return [{ type: 'start', text }, { type: 'delta', text: token }];
  }

  /** 流结束。没到阈值就整段交出去（调用方按"非流式"处理）。 */
  finish(): LiveEvent[] {
    if (this.finished) {
      return [];
    }
    this.finished = true;
    if (this.released) {
      return [{ type: 'end', streaming: true, tokens: this.tokens }];
    }
    const text = this.buffered;
    this.buffered = '';
    const end: LiveEvent = { type: 'end', streaming: false, tokens: this.tokens };
    return text === '' ? [end] : [{ type: 'start', text }, end];
  }

  /** 见过多少 token（诊断用） */
  get tokensSeen(): number {
    return this.tokens;
  }

  /** 有没有真的走流式（超过阈值） */
  get streaming(): boolean {
    return this.released;
  }
}

/** 侧通道里的一行。 */
export interface LiveMessage {
  readonly t: 'delta' | 'end';
  readonly s: string;
  readonly text?: string;
  readonly tokens?: number;
}

/**
 * 侧通道接收端：插件（`mcp/voice-live`）主动连进来的本地 TCP，一行一个 JSON。
 *
 * 为什么是 TCP 而不是文件/pipe：插件的 tick 和 harness 的事件循环不同频，
 * 文件要轮询、pipe 要走 shell，TCP 直接推、连不上还能重连（插件侧会重试）。
 */
export class LiveTextRelay {
  private server: Server | null = null;
  private handle: Socket | null = null;
  private _port = 0;
  private handler: ((msg: LiveMessage) => void) | null = null;
  private buffer = '';
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  onMessage(handler: (msg: LiveMessage) => void): void {
    this.handler = handler;
  }

  /** 起监听（幂等），返回端口。失败返回 0（插件侧就不启用）。 */
  start(): number {
    if (this.server !== null) {
      return this._port;
    }
    try {
      const server = createServer((socket) => {
        this.handle = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => { this.consume(chunk); });
        socket.on('error', () => { this.handle = null; });
        socket.on('close', () => { this.handle = null; });
      });
      server.on('error', (e: Error) => {
        this.log(`  流式    ✗ 侧通道监听失败：${e.message}`);
        this.server = null;
      });
      // 同步拿不到端口，所以用 0 让系统分配后**同步读回**——
      // `listen` 是异步的，这里用 `address()` 在 listen 回调里补，调用方拿到的
      // 是 0。为了不让调用方等异步，改成先 listen(0) 再用 `server.address()`
      // 轮询到就绪（Node 里 listen 之后立刻 address() 通常还没绑定）。
      server.listen(0, '127.0.0.1');
      this.server = server;
      const addr = server.address();
      if (addr !== null && typeof addr === 'object') {
        this._port = addr.port;
      } else {
        // 还没绑定完：等 listening 事件
        server.once('listening', () => {
          const a = server.address();
          if (a !== null && typeof a === 'object') {
            this._port = a.port;
          }
        });
      }
      return this._port;
    } catch (e) {
      this.log(`  流式    ✗ 侧通道没起来：${(e as Error).message}`);
      return 0;
    }
  }

  /** 等端口就绪（`listen` 是异步的，spawn 子进程前要拿到真端口）。 */
  async ready(): Promise<number> {
    const port = this.start();
    if (port > 0 || this.server === null) {
      return port;
    }
    const server = this.server;
    return await new Promise<number>((resolve) => {
      const done = (): void => {
        const a = server.address();
        this._port = a !== null && typeof a === 'object' ? a.port : 0;
        resolve(this._port);
      };
      if (server.listening) {
        done();
        return;
      }
      server.once('listening', done);
      setTimeout(done, 1000).unref?.();
    });
  }

  get port(): number {
    return this._port;
  }

  close(): void {
    this.handle?.destroy();
    this.handle = null;
    this.server?.close();
    this.server = null;
    this._port = 0;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let at = this.buffer.indexOf('\n');
    while (at >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line !== '') {
        try {
          this.handler?.(JSON.parse(line) as LiveMessage);
        } catch {
          // 半行/坏行直接丢：这条通道是加速用的，不是数据源
        }
      }
      at = this.buffer.indexOf('\n');
    }
  }
}
