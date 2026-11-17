/**
 * 浏览器 ↔ 语音栈的 WebSocket 桥。
 *
 * 一条 WS 连接对一条到语音栈的内网 TCP 连接，桥**不解析协议**：上行把 WS 消息
 * 原样写进 TCP，下行把每个 TCP chunk 原样当成一条 WS 消息发回去。两端的解码器
 * （`frame.ts` 的 `FrameDecoder`）本来就按 `[type:u8][len:u32 LE][payload]` 从
 * 字节流里重新切帧，所以 WS 的消息边界是谁都无所谓的 —— 桥里不用再做一次分帧。
 *
 * 为什么用桥而不是让浏览器直连：浏览器没有 raw TCP，而把 `Connection` 从
 * `net.Socket` 上松绑要动语音栈的核心类型。桥多一跳回环（<1 ms）和一次拷贝
 * （上行 32 KB/s、下行 48 KB/s），换语音栈一行不改。
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface WebBridgeOptions {
  /** 浏览器连的端口 */
  readonly port: number;
  /** 浏览器连的地址。非本机地址必须同时给 `tls` 与 `origins` */
  readonly host: string;
  /** 语音栈的内网端口（`runVoiceServer` 的 `port`） */
  readonly voicePort: number;
  /** 语音栈的内网地址，默认 `127.0.0.1` */
  readonly voiceHost?: string;
  /** 允许的页面来源。留空 = 只接受同源连接与不带 Origin 的非浏览器客户端 */
  readonly origins?: readonly string[];
  readonly tls?: { readonly key: Buffer; readonly cert: Buffer };
  readonly log: (line: string) => void;
}

export interface WebBridge {
  /** 真正监听后的端口（`port: 0` 时用来取随机口） */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * 来源判定。
 *
 * 不配白名单时只放同源：`wss://` 下浏览器不替服务端拦跨站页面，
 * 一个任意网页就能推流进来听着玩，那不是能用默认值兜住的事。
 */
function originAllowed(origin: string, allowed: readonly string[] | undefined, host: string): boolean {
  if (origin === '') {
    return true; // 非浏览器客户端（curl / 脚本）不带 Origin
  }
  if (allowed !== undefined && allowed.length > 0) {
    return allowed.includes(origin);
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function startWebBridge(options: WebBridgeOptions): Promise<WebBridge> {
  const httpServer: Server = options.tls === undefined
    ? createHttpServer()
    : createHttpsServer({ key: options.tls.key, cert: options.tls.cert });

  const wss = new WebSocketServer({
    server: httpServer,
    // 语音流压缩不划算：多一次 CPU 搬运，还多一截缓冲延迟
    perMessageDeflate: false,
    // 上行是几十 KB 的音频块；给 1 MB 足够宽松，又不至于让对端先声明一个大包灌内存
    maxPayload: 1 << 20,
  });

  let nextId = 1;

  wss.on('connection', (ws: WebSocket, req) => {
    const id = nextId++;
    const origin = req.headers.origin ?? '';
    if (!originAllowed(origin, options.origins, req.headers.host ?? '')) {
      options.log(`[ws#${id}] 来源被拒：${origin || '(无 Origin)'}`);
      ws.close(1008, 'origin not allowed');
      return;
    }

    const remote = req.socket.remoteAddress ?? '?';
    const voiceHost = options.voiceHost ?? '127.0.0.1';

    // 连接建立前的 `write` 由 `net.Socket` 自己排队，桥里不用另做缓冲
    const tcp = connect({ host: voiceHost, port: options.voicePort });
    let upBytes = 0;
    let downBytes = 0;
    let finished = false;

    const finish = (reason: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      options.log(`[ws#${id}] ${reason}（上行 ${upBytes} B / 下行 ${downBytes} B）`);
      tcp.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
    };

    ws.on('message', (data, isBinary) => {
      // 协议是二进制的，文本帧一律不听
      if (!isBinary) {
        return;
      }
      const chunk = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      upBytes += chunk.length;
      tcp.write(chunk);
    });

    tcp.on('data', (chunk: Buffer) => {
      downBytes += chunk.length;
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk, { binary: true });
      }
    });

    tcp.on('error', (error: Error) => { finish(`语音栈连接出错: ${error.message}`); });
    tcp.on('close', () => { finish('语音栈关闭'); });
    ws.on('close', () => { finish('浏览器关闭'); });
    ws.on('error', (error: Error) => { finish(`WS 出错: ${error.message}`); });

    options.log(`[ws#${id}] ${remote} 接入 → 语音栈 ${voiceHost}:${options.voicePort}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error); };
    httpServer.once('error', onError);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', onError);
      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      options.log(`WS 桥监听 ${options.tls === undefined ? 'ws' : 'wss'}://${options.host}:${port}`);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port: boundPort,
    close: async (): Promise<void> => {
      // 先断开客户端，`wss.close` 才会在所有连接结束后回调
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => { wss.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { httpServer.close(() => { resolve(); }); });
    },
  };
}
