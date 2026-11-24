/**
 * 连接层：accept、帧编解码、首帧鉴权、心跳/空闲看门狗。
 *
 * **这一层不认识任何业务。** 它只做两件事：
 * - 把字节变成 `onFrame(type, payload)` 事件
 * - 把 `sendAudio / sendControl / close` 变成字节
 *
 * 音频、判停、对话、拍照全在它之上（见 `voice-session.ts`）。抽出来的意义：
 * 以前这些和 socket 回调混在一个 600 行的类里，改心跳要动对话代码。
 */
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';

import { checkBindSafety } from './bind-policy.ts';
import {
  DownstreamFrameType,
  FRAME_MAX_BYTES,
  FrameDecoder,
  FrameWriter,
  UNAUTH_FRAME_MAX_BYTES,
  UpstreamFrameType,
} from './frame.ts';

/** `Hello` 帧的内容。字段都可选，方便别人只报自己想报的。 */
export interface HelloInfo {
  readonly proto?: number;
  readonly deviceId?: string;
  readonly token?: string;
  /** v2 自报的能力，**原样**交给设备层解析（这一层不认识它） */
  readonly capabilities?: unknown;
  /**
   * 这是**自动重连**，不是用户主动开的通道。
   *
   * 手机端的 supervisor 在网络抖动、云端重启、心跳超时（30 s 收不到字节）时会自己
   * 重连。这种重连不该被当成"用户想说话"—— 否则每次抖一下都会把眼镜的语音会话
   * 重新拉起来（亮灯、耗电、可能还有提示音）。
   *
   * 缺省当作 `false`：老 App 不带这个字段，保持"连接就绪就开麦"的老行为，
   * 免得它变成"点开了却没声音"。
   */
  readonly resumed?: boolean;
}

/** 解析 `Hello`；坏 JSON 返回 null（由调用方决定拒绝还是忽略）。 */
export function parseHello(payload: Buffer): HelloInfo | null {
  try {
    const parsed: unknown = JSON.parse(payload.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    const o = parsed as Record<string, unknown>;
    return {
      proto: typeof o.proto === 'number' ? o.proto : undefined,
      deviceId: typeof o.deviceId === 'string' ? o.deviceId : undefined,
      token: typeof o.token === 'string' ? o.token : undefined,
      capabilities: o.capabilities,
      // 只认真正的布尔 true：字符串 "true" / 数字 1 都不算，见 `hello-resumed.test.ts`
      resumed: o.resumed === true ? true : undefined,
    };
  } catch {
    return null;
  }
}

/** 业务层实现的回调。 */
export interface ConnectionHandlers {
  /**
   * 收到（并通过鉴权的）`Hello`，每条连接至多一次。
   *
   * 没配鉴权时 `Hello` 不是必需的，但发了照样交上来 —— v2 的能力自报在里面。
   */
  onHello?(hello: HelloInfo): void;
  onFrame(type: number, payload: Buffer): void;
  onClose(reason: string): void;
}

/** 业务层往设备发东西只需要这两个动作；`Connection` 天然满足它。 */
export interface DownlinkSink {
  sendAudio(pcm: Buffer): void;
  sendControl(text: string): void;
}

/** 一条已建立的连接。业务层只碰这个接口，不碰 socket。 */
export class Connection {
  readonly remote: string;

  private authDeviceId?: string;
  private readonly socket: Socket;
  private readonly frames: FrameWriter;
  private readonly decoder: FrameDecoder;
  private readonly log: (line: string) => void;
  private readonly authenticate?: (hello: HelloInfo) => boolean;
  private readonly idleTimeoutMs: number;

  private handlers: ConnectionHandlers | null = null;
  private readonly onClosed?: () => void;
  private authed: boolean;
  /** 已经处理过一次 `Hello`（重复的忽略） */
  private helloSeen = false;
  private lastRxAt = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  /** `end()` 已调用但 'close' 还没来 —— 这期间必须停止收发。 */
  private closing = false;
  private closed = false;
  /**
   * `end()` 半关之后的强拆。必须记在连接上：`finish()` 到来时清掉，
   * 连调两次 `end()` 也不能再挂第二只。
   */
  private forceCloseTimer: NodeJS.Timeout | null = null;

  constructor(
    socket: Socket,
    log: (line: string) => void,
    authenticate: ((hello: HelloInfo) => boolean) | undefined,
    idleTimeoutMs: number,
    onClosed?: () => void,
  ) {
    this.socket = socket;
    this.log = log;
    this.authenticate = authenticate;
    this.idleTimeoutMs = idleTimeoutMs;
    this.onClosed = onClosed;
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.frames = new FrameWriter(socket);
    this.decoder = new FrameDecoder(
      (message) => {
        log(`  ✗ ${message}`);
        // 帧长异常之后字节流已经失去边界 —— 缓冲被整块丢掉，后面的字节无法重新对齐，
        // 接着读下去只会把半截载荷当帧头。所以直接断开，不留一条"永远凑不齐帧"的
        // 连接：未鉴权的对端可以声明一个超限帧然后无限拖着，靠每几秒一个字节保活。
        this.closeWith('frame_too_large');
      },
      // 需要鉴权时先收着：未鉴权的对端没资格声明大帧
      authenticate === undefined ? FRAME_MAX_BYTES : UNAUTH_FRAME_MAX_BYTES,
    );
    this.authed = authenticate === undefined;
    this.authDeviceId = undefined;

    socket.setNoDelay(true); // 小帧 + 实时语音：别让 Nagle 攒包
    socket.on('data', (chunk: Buffer) => { this.onData(chunk); });
    socket.on('error', (error: Error) => { log(`socket 错误: ${error.message}`); });
    socket.on('close', () => { this.finish('socket closed'); });

    this.idleTimer = setInterval(() => { this.checkIdle(); }, 5_000);
  }

  /**
   * 注册业务回调，**同一 tick 内注册**。
   *
   * 帧在注册之前到达会被丢弃 —— 连接刚建立时不会有帧，所以实践上安全；
   * 真要更严谨可以在未注册时缓冲，但那是没人会用到的复杂度。
   */
  bind(handlers: ConnectionHandlers): void {
    this.handlers = handlers;
  }

  /** 鉴权得到的设备 ID（没配鉴权时为 undefined）。 */
  get deviceId(): string | undefined {
    return this.authDeviceId;
  }

  get isAuthed(): boolean {
    return this.authed;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 下行音频（PCM16）。 */
  sendAudio(pcm: Buffer): void {
    if (!this.closed && !this.closing) {
      this.frames.write(DownstreamFrameType.Audio, pcm);
    }
  }

  /** 下行控制串：`take_photo` / `stop` / `end_session` / `auth_*`。 */
  sendControl(text: string): void {
    if (!this.closed && !this.closing) {
      this.frames.writeText(DownstreamFrameType.Control, text);
    }
  }

  /** v2：下行一个原语操作（UTF-8 JSON）。只该在发过 `Welcome` 之后用。 */
  sendCall(json: string): void {
    if (!this.closed && !this.closing) {
      this.frames.writeText(DownstreamFrameType.Call, json);
    }
  }

  /** v2：接受 v2 的回执。 */
  sendWelcome(json: string): void {
    if (!this.closed && !this.closing) {
      this.frames.writeText(DownstreamFrameType.Welcome, json);
    }
  }

  /** 回一条控制串再关（鉴权失败等）。 */
  closeWith(reason: string): void {
    this.sendControl(reason);
    this.end();
  }

  end(): void {
    // 半关之后再 end 一次只会再挂一只 5 秒强拆，对端真正关掉时谁也清不掉。
    if (this.closing || this.closed) {
      return;
    }
    this.closing = true;
    // 立刻停掉空闲看门狗：半关之后 `finish()` 要等对端真的关，
    // 那段时间里定时器还会继续判「无数据」，日志和 `socket.end()` 都会重复。
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.socket.destroyed) {
      return;
    }
    // 先挂上强拆再 half-close。对端若在 `socket.end()` 里同步关掉，
    // `finish()` 看得到这只定时器并清掉，不会等 5 秒再 destroy 一次。
    // `end()` 只是半关，真正的 `close` 要等对端也发 FIN。看门狗已经停了，
    // 所以碰到不配合的对端（尤其被我们主动踢掉的）这条连接会一直挂着占 fd。
    this.forceCloseTimer = setTimeout(() => {
      this.forceCloseTimer = null;
      this.destroy();
    }, 5_000);
    this.forceCloseTimer.unref();
    this.socket.end();
  }

  destroy(): void {
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  // ------------------------------------------------------------------ 内部

  private onData(chunk: Buffer): void {
    this.lastRxAt = Date.now();
    for (const frame of this.decoder.push(chunk)) {
      this.handle(frame.type, frame.payload);
    }
  }

  private handle(type: number, payload: Buffer): void {
    if (this.closed || this.closing) {
      return; // 已决定关闭：同一次读里剩下的帧不再处理
    }
    if (type === UpstreamFrameType.Hello) {
      this.onHello(payload);
      return;
    }
    /**
     * **鉴权前什么都不放行** —— 包括 `Ping`。
     *
     * 以前 `Ping` 在这一段之前就回了 `Pong`，理由是"它不携带信息、不触发业务"。
     * 但 `onData` 里**任何字节**都刷新 `lastRxAt`，于是未鉴权的连接每 5 秒发一个
     * 空 Ping 就能永久占着一条连接（`checkIdle` 永不触发）。
     *
     * 正常客户端的心跳是在 `Hello` 之后才开始的（`VoiceLink` 连接后立刻发 Hello，
     * 心跳 10 s 一次），所以这里收紧不影响任何合法路径。
     */
    if (!this.authed) {
      this.log(`  鉴权    未收到 Hello 就发帧（type=${type}），断开`);
      this.closeWith('auth_required');
      return;
    }
    if (type === UpstreamFrameType.Ping) {
      // 已鉴权：心跳照常回，它确实不携带信息
      if (!this.closed) {
        this.frames.write(DownstreamFrameType.Pong, Buffer.alloc(0));
      }
      return;
    }
    this.handlers?.onFrame(type, payload);
  }

  private onHello(payload: Buffer): void {
    if (this.helloSeen) {
      return; // 重复 Hello 忽略
    }
    this.helloSeen = true;
    const hello = parseHello(payload);

    if (this.authenticate === undefined) {
      // 没配鉴权：Hello 只是自我介绍，坏 JSON 也不断开（v1 时代发了也忽略）
      if (hello !== null) {
        this.handlers?.onHello?.(hello);
      }
      return;
    }

    if (this.authed) {
      return;
    }
    if (!hello || !this.authenticate(hello)) {
      this.log(`  鉴权    拒绝（deviceId=${hello?.deviceId ?? '?'}）`);
      this.closeWith('auth_failed');
      return;
    }
    this.authed = true;
    this.authDeviceId = hello.deviceId;
    // 身份确认了，才允许大帧（图片、整段音频）
    this.decoder.setMaxBytes(FRAME_MAX_BYTES);
    this.log(`  鉴权    通过（deviceId=${hello.deviceId ?? '?'} proto=${hello.proto ?? '?'}）`);
    this.handlers?.onHello?.(hello);
  }

  private checkIdle(): void {
    // `closing` 也要挡：`end()` 只是半关，等对端真的关掉才走 `finish()`。
    // 不挡的话定时器每 5 s 继续触发，日志会从「45 s 无数据」一路刷到「70 s 无数据」。
    if (this.closed || this.closing) {
      return;
    }
    const quietMs = Date.now() - this.lastRxAt;
    if (quietMs > this.idleTimeoutMs) {
      this.log(`  连接    ${Math.round(quietMs / 1000)} s 无数据，主动断开`);
      this.end();
    }
  }

  private finish(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.forceCloseTimer) {
      clearTimeout(this.forceCloseTimer);
      this.forceCloseTimer = null;
    }
    this.handlers?.onClose(reason);
    this.onClosed?.();
  }
}

export interface TransportOptions {
  readonly port: number;
  /**
   * 缺省 `127.0.0.1`：本地开发默认不暴露。
   *
   * 非本机地址由 {@link checkBindSafety} 把关 —— 必须同时有 token 和 TLS，
   * 否则**不监听**并返回退出码 2。这条判据不在这里重复。
   */
  readonly host?: string;
  readonly tls?: { readonly key: Buffer; readonly cert: Buffer };
  readonly authenticate?: (hello: HelloInfo) => boolean;
  /** 这么久没收到任何字节就断开（默认 45 s）。 */
  readonly idleTimeoutMs?: number;
  /**
   * 单设备模式（默认 true）：只接一条连接，连接结束就关监听、返回退出码。
   *
   * 多设备时改 false 并把连接表交给业务层 —— 这正是把这层独立出来的原因之一。
   */
  readonly singleConnection?: boolean;
  /**
   * 监听成功：交出**真实端口**（`port: 0` 时）和**外部停机入口**。
   *
   * 两件事都是给「进程内起栈」的宿主（dsh 插件）准备的：
   * - `port: 0` 时没人知道绑到了哪个口，外面的桥接不上去；
   * - `singleConnection: false` 时**没有任何事件会结束本函数** —— 没有这个 `stop()`，
   *   宿主卸载插件时监听关不掉，进程里会一直留着一条 TCP 监听（以及它背后的
   *   控制口、侧车等一切）。这是泄漏，不是便利问题。
   *
   * CLI 不用它：单设备模式靠连接结束收尾，进程退出即释放。
   */
  readonly onListening?: (info: { readonly port: number; readonly stop: () => void }) => void;
  readonly log: (line: string) => void;
  /** 连接建立：在这里 `conn.bind(...)` 登记业务回调。 */
  onConnection(conn: Connection): void;
}

/** 起监听，返回进程退出码。 */
export async function runTransport(options: TransportOptions): Promise<number> {
  const host = options.host ?? '127.0.0.1';
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  const single = options.singleConnection !== false;

  // 闸在 bind 之前：非本机地址缺 token 或 TLS 就**不监听**，而不是绑上去再打一行提示。
  const safety = checkBindSafety({
    host,
    hasTls: options.tls !== undefined,
    hasAuth: options.authenticate !== undefined,
  });
  if (!safety.ok) {
    options.log(safety.message);
    return 2;
  }

  return await new Promise<number>((resolve) => {
    let server: Server;
    let finished = false;
    /**
     * 已建立的连接。`server.close()` 只是停止收新连接，活着的还得自己断 ——
     * 否则 `stop()` 之后监听虽然关了，连接和它们的业务对象（ASR/TTS/侧车）
     * 仍挂在进程里。
     */
    const sockets = new Set<Socket>();

    const finish = (code: number): void => {
      if (finished) {
        return;
      }
      finished = true;
      server.close();
      const live = [...sockets];
      sockets.clear();
      for (const socket of live) {
        socket.destroy();
      }
      // 等一 tick 再 resolve：`Connection` 的 `onClose`（档案收尾、ASR/TTS 关闭）挂在
      // socket 的 `'close'` 事件上，先让它跑完，调用方再去拆控制口 / 卸载插件。
      setImmediate(() => { resolve(code); });
    };

    const onConnection = (socket: Socket): void => {
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); });
      const conn = new Connection(
        socket,
        options.log,
        options.authenticate,
        idleTimeoutMs,
        single ? () => { finish(0); } : undefined,
      );
      options.onConnection(conn);
      if (single) {
        server.close(); // 不再收第二条
      }
    };

    // TLS 只在部署方显式给了证书时才启用 —— 两条路径是同一份代码的两种配置
    server = options.tls
      ? createTlsServer(
        { key: options.tls.key, cert: options.tls.cert, minVersion: 'TLSv1.2' },
        (socket) => { onConnection(socket as unknown as Socket); },
      )
      : createServer((socket) => { onConnection(socket); });

    server.on('error', (error: Error) => {
      options.log(`监听失败: ${error.message}`);
      finish(1);
    });

    server.listen(options.port, host, () => {
      // `port: 0` 时真实端口只在这里看得到 —— 日志和宿主都要用它，不是 `options.port`
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      const scheme = options.tls ? 'tls' : 'tcp';
      const auth = options.authenticate ? '需要 Hello 鉴权' : '不鉴权';
      options.log(`监听 ${scheme}://${host}:${port}（${auth}）`);
      if (host === '127.0.0.1') {
        options.log(`手机侧先执行： adb reverse tcp:${port} tcp:${port}`);
      }
      options.onListening?.({ port, stop: () => { finish(0); } });
    });
  });
}
