/**
 * 本机控制口：给 dsh 的 MCP 工具回来调用的 HTTP 入口。
 *
 * 工具进程（`mcp/mcp-camera.mjs`、`mcp/mcp-session.mjs`）是 dsh spawn 的
 * 独立进程，只能通过一个 URL 与 harness 通信。本模块只负责 HTTP 层：
 * 路由、并发保护、超时、响应码；真正的硬件动作由调用方注入。
 *
 * - `GET /capabilities`  → 当前连接设备的能力（JSON）。**给 MCP 工具进程用**：
 *   工具该不该存在、要不要提示「需要用户动手」，都由它决定，不写死在工具描述里。
 * - `POST /take_photo`  → 调 {@link ToolControlHandlers.takePhoto} 取 JPEG（低清，快）
 * - `POST /take_photo_hq` → 高清版，见 {@link ToolControlHandlers.takePhotoHq}
 * - `POST /end_session` → 调 {@link ToolControlHandlers.endSession}
 * - `POST /say`         → 当作「用户说了这句话」，起一轮（**调试/联调用**，
 *   没有麦克风也能验证 agent→TTS→下发整条链）
 * - `POST /control`     → 原样下发一条控制串（**只给调试用**：`stop_capture` /
 *   `start_capture` 这类"要让设备配合做动作"的实验，没法从对话里自然触发）
 *
 * <h2>进程/服务级常驻，不是每条连接一个</h2>
 *
 * 端口是固定的，所以**一个进程只开一个控制口**；设备重连不要关掉再开：
 * 旧 server 可能还握着端口（keep-alive 长连接要等 `closeAllConnections()` 才真放），
 * 新连接立刻 bind 就 `EADDRINUSE`，而且那个还活着的旧 server 会把 `/say`、
 * `take_photo` 路由给**上一条已经关闭的连接** —— 现场表现是「手机重连一次之后，
 * MCP 拍照就全都没反应了」。
 *
 * 连接上来时 {@link ToolControl.setHandlers} 热切换，断开时传
 * `setHandlers(null, 自己)`：所有权令牌保证旧连接的迟到断开不会把已经接管的新连接清掉。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { DeviceCapabilities } from './devices/primitives.ts';
import type { PhotoOutcome } from './photo-inbox.ts';

export interface ToolControlHandlers {
  /**
   * 当前连接设备的能力；没有连接时返回 `null`。
   *
   * MCP 工具进程靠它决定暴露哪些工具：设备只报 `glance` 就只有一个拍照工具，
   * 报了 `detail` 才有高清那个。`needsUser` 也从这里读，不在描述里写死
   * 「必须按快门」——小米要按，别的设备直接拍。
   */
  readonly capabilities?: () => DeviceCapabilities | null;
  /** 取一张照片；`ok:false` 表示超时/失败，`reason` 会原样写回模型 */
  readonly takePhoto: () => Promise<PhotoOutcome>;
  /** 取一张**高清**照片（手机侧开一次 P2P 拉原图再缩，需要用户按快门），无此能力时回落到 [takePhoto] */
  readonly takePhotoHq?: () => Promise<PhotoOutcome>;
  /** 模型判定应当结束会话 */
  readonly endSession: () => void;
  /** 注入一句话，按正常轮次处理（调试/联调） */
  readonly say?: (text: string) => void;
  /** 原样下发一条控制串（调试用；`stop_capture` / `start_capture` 这类实验） */
  readonly control?: (text: string) => void;
  readonly log?: (line: string) => void;
}

/** 跟着设备走的等图预算：v1 手机与 v2 眼镜的 `hq` 时长并不相同 */
export interface ToolControlTimeouts {
  /** `spp` 等图的硬上限（收件箱自己也会超时，这里只是兜底） */
  readonly photoTimeoutMs?: number;
  /** `hq` 等图的硬上限：要覆盖「建 P2P 15 s + 等用户按快门 25 s」 */
  readonly hqTimeoutMs?: number;
}

export interface ToolControlOptions {
  readonly port: number;
  /** `spp` 等图的硬上限（收件箱自己也会超时，这里只是兜底） */
  readonly photoTimeoutMs: number;
  /** `hq` 等图的硬上限：要覆盖「建 P2P 15 s + 等用户按快门 25 s」 */
  readonly hqTimeoutMs?: number;
  /** 初始绑定的连接；进程级常驻时通常先传 `null`，等第一条连接上来再 {@link ToolControl.setHandlers} */
  readonly handlers: ToolControlHandlers | null;
}

export interface ToolControl {
  /** 实际监听端口。传 `0` 时由系统分配，读这里拿真实值（测试要用）。 */
  readonly port: number;
  /**
   * 切换活跃连接（热切换，**不重开端口**）。
   *
   * @param handlers 新连接；`null` = 主动断开 / 没有设备
   * @param expected 所有权令牌。**只在 `handlers === null` 时生效**：仅当当前绑定的
   *   就是 `expected` 才清空。旧连接断开时一定要带上自己，否则它会把已经接管的新连接
   *   清掉（弱网重连时「旧连接晚于新连接断开」是常态）。
   * @param timeouts 随设备更新的等图预算；不传的字段保持原值
   */
  readonly setHandlers: (
    handlers: ToolControlHandlers | null,
    expected?: ToolControlHandlers | null,
    timeouts?: ToolControlTimeouts,
  ) => void;
  /** 停止监听。**进程退出时**调用；设备重连不要调（改用 {@link ToolControl.setHandlers}） */
  readonly close: () => void;
}

/**
 * 启动控制口。
 *
 * 端口固定，一个进程只开一个；不监听 `error` 的话，端口被占时未处理的 `error`
 * 事件会让整个进程退出。
 */
export function startToolControl(options: ToolControlOptions): ToolControl {
  /** 当前接管控制口的连接；`null` = 没有设备（进程刚起 / 全部断开） */
  let active = options.handlers;
  let photoTimeoutMs = options.photoTimeoutMs;
  let hqTimeoutMs = options.hqTimeoutMs;
  /**
   * 在途拍照的身份令牌。
   *
   * 用对象而不是布尔：切换连接时，旧请求的 `.then` / 超时回调**照样会跑**，
   * 它们若无脑写 `photoInFlight = false`，就会把新连接刚发起的拍照标记清掉
   * （409 并发保护失效，两张图混在一个响应上）。结算时只认自己的令牌。
   */
  let inFlight: object | null = null;

  const noDevice = (res: ServerResponse): void => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      .end('no device connected');
  };

  const server: Server = createServer((req, res) => {
    // 能力查询是 GET：MCP 工具进程用它决定暴露哪些工具，不做任何硬件动作。
    // 没有连接时回 503，工具进程据此认为「此刻没有可用的拍照能力」。
    if (req.method === 'GET' && req.url === '/capabilities') {
      const caps = active?.capabilities?.() ?? null;
      if (caps === null) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          .end('{"error":"no-device"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(caps));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    // 一条请求全程只认开始时的那个连接：中途被热切换时，不要把半条请求发给新设备
    const handlers = active;
    if (handlers === null) {
      noDevice(res);
      return;
    }

    if (req.url === '/say') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text || !handlers.say) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('need text');
          return;
        }
        handlers.log?.(`  注入    ${JSON.stringify(text)}（调试口）`);
        handlers.say(text);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      });
      return;
    }

    if (req.url === '/end_session') {
      handlers.log?.('  退出    模型判定该结束了（说完这句就挂断）');
      handlers.endSession();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }

    if (req.url === '/control') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text || !handlers.control) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('need text');
          return;
        }
        handlers.log?.(`  控制    下发 ${JSON.stringify(text)}（调试口）`);
        handlers.control(text);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      });
      return;
    }

    if (req.url !== '/take_photo' && req.url !== '/take_photo_hq') {
      res.writeHead(404).end();
      return;
    }

    const wantHq = req.url === '/take_photo_hq';
    const shooter = wantHq && handlers.takePhotoHq !== undefined ? handlers.takePhotoHq : handlers.takePhoto;

    if (inFlight !== null) {
      res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
        .end('已有拍照请求在途');
      return;
    }

    const token: object = {};
    inFlight = token;
    /** 只清掉**自己那一次**的在途标记（切换连接后可能已经属于别人） */
    const settle = (): void => {
      if (inFlight === token) {
        inFlight = null;
      }
    };

    const timer = setTimeout(() => {
      settle();
      if (!res.writableEnded) {
        res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
          .end('等图超时');
      }
    }, wantHq ? (hqTimeoutMs ?? photoTimeoutMs) : photoTimeoutMs);

    void shooter().then((outcome) => {
      clearTimeout(timer);
      settle();
      if (res.writableEnded) {
        return;
      }
      if (!outcome.ok) {
        const label = outcome.failure.say ?? outcome.failure.code;
        handlers.log?.(`  拍照    ✗ 失败（${label}）`);
        res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
          .end(`拍照失败：${label}`);
        return;
      }
      const jpeg = outcome.jpeg;
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(jpeg.length),
      });
      res.end(jpeg);
    }).catch((error: Error) => {
      clearTimeout(timer);
      settle();
      if (!res.writableEnded) {
        res.writeHead(500).end(`拍照失败：${error.message}`);
      }
    });
  });

  server.on('error', (error: Error) => {
    const line = `  ✗ 控制口 ${options.port}: ${error.message}`;
    // 还没有设备（进程刚起 / 全部断开）时 `active?.log?.()` 是空操作，
    // `PHOTO_CTL_PORT` 被占的 EADDRINUSE 会被吞掉，看起来像服务没起来。
    if (active === null) {
      console.error(line);
      return;
    }
    active.log?.(line);
  });
  server.listen(options.port, '127.0.0.1');

  return {
    get port() {
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : options.port;
    },
    setHandlers: (handlers, expected, timeouts) => {
      const previous = active;
      if (handlers === null) {
        // 所有权令牌：旧连接迟到的断开不许清掉已经接管的新连接
        if (expected !== undefined && previous !== expected) {
          return;
        }
        active = null;
      } else {
        // 新连接总是接管（重连时新连接可能先于旧连接建立）
        active = handlers;
      }
      if (timeouts?.photoTimeoutMs !== undefined) {
        photoTimeoutMs = timeouts.photoTimeoutMs;
      }
      if (timeouts?.hqTimeoutMs !== undefined) {
        hqTimeoutMs = timeouts.hqTimeoutMs;
      }
      if (active !== previous) {
        // 旧连接卡死的拍照不能把新连接永久锁在 409 里；它迟到的结算按令牌认领，
        // 不会碰到新连接刚发起的这一张
        inFlight = null;
      }
    },
    close: () => {
      server.close();
      // `close()` 只是停止**接受**新连接；已经建立的长连接（工具进程、keep-alive）会
      // 一直占着端口，于是下一个 server 绑定同一个端口就 EADDRINUSE —— 那个旧 server
      // 还活着，并且把 `/say`、`take_photo` 路由给它自己那份已经死掉的 handlers。
      server.closeAllConnections();
    },
  };
}
