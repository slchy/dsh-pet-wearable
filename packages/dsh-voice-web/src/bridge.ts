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
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { checkBindSafety, isLoopbackHost } from './voice/bind-policy.ts';
import { loadAuthenticator } from './voice/runtime/env-bootstrap.ts';

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
  /**
   * 同时把页面发出去。给了就处理 HTTP GET —— 页面从**同一个端口**加载，
   * 于是天然同源（不用配 `origins` 白名单），而且 `http://127.0.0.1` 本身就是
   * 安全上下文，`getUserMedia` 才可用。空/不给则只做 WS，GET 一律 404。
   */
  readonly webDir?: string;
  readonly log: (line: string) => void;
}

export interface WebBridge {
  /** 真正监听后的端口（`port: 0` 时用来取随机口） */
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 把请求路径映射到 `webDir` 里的文件，越界返回 `null`。
 *
 * `normalize` 之后必须重新校验前缀：`/../..` 这类路径在拼接后会指到目录外，
 * 只判 `startsWith` 而不看规范化结果就漏了。
 */
function resolveAsset(webDir: string, urlPath: string): { readonly file: string } | { readonly status: 400 | 404 } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch (error) {
    // `GET /%` 这种非法百分号编码。不接住的话 URIError 会打崩整个桥进程。
    if (error instanceof URIError) {
      return { status: 400 };
    }
    throw error;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = resolve(join(webDir, normalize(relative)));
  const root = resolve(webDir) + sep;
  if (full !== resolve(webDir) && !full.startsWith(root)) {
    return { status: 404 };
  }
  return existsSync(full) && statSync(full).isFile() ? { file: full } : { status: 404 };
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
  // 桥自己就是对外入口。只在 `driver.apply` 里闸一次的话，直接调这个函数
  // 仍能在 `0.0.0.0` 上开端口。不能把 `hasAuth` 写死成 `true`：未配 `MIAI_TOKENS`
  // 时非浏览器客户端可留空或伪造 `Origin`，而桥接的是能执行 shell 的语音 agent。
  // 非回环地址必须真实探测 `MIAI_TOKENS`（文件存在且含有效强 token）并通过 `checkBindSafety`。
  const hasAuth = isLoopbackHost(options.host)
    ? false
    : loadAuthenticator(options.log) !== undefined;
  const safety = checkBindSafety({
    host: options.host,
    hasTls: options.tls !== undefined,
    hasAuth,
  });
  if (!safety.ok) {
    throw new Error(safety.message);
  }

  const webDir = options.webDir === undefined || options.webDir === '' ? null : resolve(options.webDir);

  const serveAsset = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    if (webDir === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('只提供 WebSocket。配置 webDir 才会发页面。');
      return;
    }
    const asset = resolveAsset(webDir, req.url ?? '/');
    if ('status' in asset) {
      res.writeHead(asset.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(asset.status === 400 ? '路径编码无效' : '没有这个文件');
      return;
    }
    const file = asset.file;
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // 本地调试：改完刷新就要看到，不留缓存
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  };

  const httpServer: Server = options.tls === undefined
    ? createHttpServer(serveAsset)
    : createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, serveAsset);

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
      const scheme = options.tls === undefined ? 'ws' : 'wss';
      options.log(`WS 桥监听 ${scheme}://${options.host}:${port}`);
      if (webDir !== null) {
        const page = options.tls === undefined ? 'http' : 'https';
        options.log(`页面     ${page}://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${port}/`);
      }
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
