/**
 * 把语音页挂进宿主 WebServer，不依赖 `@deepseek-ai/dsh-host-webserver` 的运行时。
 *
 * 桌面壳的 index 不经过 `tapIndex`。结构化注入若用 `script-src`，脚本 404 会拒绝整个
 * 启动；这里改推内联 `script`，由我们自己插入 `<script src>` 并吞掉 onerror。
 * 网页形态仍用 `tapIndex` 在 `</body>` 前插同一支脚本。两条通道各自去重。
 *
 * `/dsh-voice/ws` 上二进制帧原样进出语音栈 TCP。文本帧只用于界面事件，不写进 TCP。
 */
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type { HostSecurityGuard } from './host-security.ts';
import type { FetchModelsOutcome } from './model-catalog.ts';
import {
  sanitizeFetchModelsRequest,
  sanitizeVoiceConfigUpdate,
  type FetchModelsRequest,
  type HostVoiceConfigSnapshot,
  type VoiceConfigUpdateRequest,
} from './voice-overrides.ts';

export const WIDGET_SCRIPT_PATH = '/dsh-voice/widget.js';
export const WS_UPGRADE_PATH = '/dsh-voice/ws';
export const ASSETS_PREFIX = '/dsh-voice/assets';
export const STATE_PATH = '/dsh-voice/state';
export const SESSION_PATH = '/dsh-voice/session';
export const CONFIG_PATH = '/dsh-voice/config';
export const MODELS_PATH = '/dsh-voice/models';

export const PET_SPRITE_NAMES = [
  'calm',
  'speaking',
  'listening',
  'happy',
  'proud',
  'surprised',
  'worried',
  'sulk',
  'angry',
  'disgust',
] as const;

const PET_SPRITE_NAME_SET: ReadonlySet<string> = new Set(PET_SPRITE_NAMES);

/**
 * 桌面端内联引导。不要改成 `script-src`：插件关掉后路由 404 会把桌面壳的启动打失败。
 */
export const DESKTOP_WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__DSH_VOICE_PET_BOOTED__)return;window.__DSH_VOICE_PET_BOOTED__=1;' +
  'var s=document.createElement("script");s.src="/dsh-voice/widget.js";' +
  's.onerror=function(){window.__DSH_VOICE_PET_BOOTED__=0};d.appendChild(s)}catch(e){}})()';

const WIDGET_TAG = `<script defer src="${WIDGET_SCRIPT_PATH}"></script>`;
const WIDGET_MISSING_JS = 'console.error("dsh-voice widget unavailable");\n';
const MAX_SESSION_BODY_BYTES = 16 * 1024;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/** 与 `src/browser/client.ts` 的 `PetUiEvent` 同形。不从那边 import，避免把 DOM 带进 Node 编译。 */
export type PetUiPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export type PetUiEvent =
  | { readonly type: 'phase'; readonly phase: PetUiPhase }
  | { readonly type: 'asr'; readonly text: string; readonly final: boolean }
  | { readonly type: 'asr.replace'; readonly text: string; readonly previous?: string }
  | { readonly type: 'reply.delta'; readonly delta: string; readonly path?: 'omni' | 'fast' | 'dsh' }
  | { readonly type: 'reply.final'; readonly text: string; readonly emotion: string; readonly path?: 'omni' | 'fast' | 'dsh' }
  | { readonly type: 'delegated'; readonly query: string; readonly reason?: string }
  | { readonly type: 'announce'; readonly text: string; readonly emotion: string };

export type HostWebRouteKind = 'exact' | 'prefix';

export interface HostWebRoute {
  kind: HostWebRouteKind;
  /** 绝对路径，无末尾斜杠。 */
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface HostWebUpgradeRoute {
  /** 绝对路径，无末尾斜杠。 */
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

export interface HostWebServer {
  register(route: HostWebRoute): () => void;
  registerUpgrade(route: HostWebUpgradeRoute): () => void;
  tapIndex(transform: (html: string) => string): () => void;
}

export type HostIndexInjectionPlacement = 'head' | 'body';

/** 与宿主 `IndexInjection` 同形的结构化注入行。 */
export type HostIndexInjection =
  | { kind: 'global'; name: string; value: unknown }
  | { kind: 'script'; placement: HostIndexInjectionPlacement; text: string }
  | { kind: 'script-src'; placement: HostIndexInjectionPlacement; src: string }
  | { kind: 'script-preload'; src: string }
  | { kind: 'style'; text: string }
  | { kind: 'html'; placement: HostIndexInjectionPlacement; html: string };

export interface HostPetState {
  readonly ok: true;
  readonly pipelineMode: string;
  readonly boundSessionId: string | null;
  readonly sessions: readonly unknown[];
  readonly wsPath: typeof WS_UPGRADE_PATH;
  readonly assetsPrefix: typeof ASSETS_PREFIX;
  /** 语音后端是否已就绪；为 false 时浮窗立绘与会话选择仍可用，点击开麦会给出 voiceError 提示。 */
  readonly voiceReady?: boolean;
  readonly voiceError?: string | null;
  /** 前端可调的语音管线 / STT / TTS 配置快照（缺省值、覆盖值与当前运行态，绝不含密钥）。 */
  readonly voiceConfig?: HostVoiceConfigSnapshot;
}

export interface HostSessionSelection {
  readonly sessionId: string | null;
}

export interface HostMountOptions {
  readonly webServer: HostWebServer;
  /**
   * 语音栈内环端口，支持惰性读取函数。
   * 宿主挂载必须同步抢在首屏 HTML 渲染前完成，此时语音栈可能仍在异步预热或缺少凭据；
   * 返回 `null` 时立绘/气泡/会话切换照常提供，WS 升级则以 4503 礼貌回报原因。
   */
  readonly voicePort: number | (() => number | null);
  /** 语音后端尚未就绪或凭据缺失时的可读原因（随 4503 关闭帧透给前端气泡）。 */
  readonly getVoiceError?: () => string | null;
  /** 语音栈地址。省略时连 `127.0.0.1`。 */
  readonly voiceHost?: string;
  /** 编译产物 `lib/widget.js`。按 `mtimeMs` 缓存，文件变了再读；缺失则 404。 */
  readonly widgetJsPath: string;
  /** `assets/pet/` 目录。只按精灵名白名单取文件。 */
  readonly assetsDir: string;
  readonly security: HostSecurityGuard;
  readonly getState: () => Promise<HostPetState> | HostPetState;
  /**
   * `POST /dsh-voice/session`。
   * `{ sessionId }` 原样传入；`{ action: 'create' }` 传入 `null`，由宿主决定新建还是解绑。
   */
  readonly onSelectSession?: (
    sessionId: string | null,
  ) => Promise<HostSessionSelection> | HostSessionSelection;
  /**
   * `POST /dsh-voice/config`。
   * 写入 `~/.dsh/.env` 并热重载语音栈后返回最新状态（返回体仅含脱敏后的 API Key 预览）。
   */
  readonly onUpdateConfig?: (
    req: { readonly reset: true } | { readonly reset: false; readonly value: VoiceConfigUpdateRequest },
  ) => Promise<HostPetState> | HostPetState;
  /**
   * `POST /dsh-voice/models`。
   * 由宿主代发 `GET {baseUrl}/models` 拉取可用模型表，避免浏览器 CORS 或暴露已存密钥。
   */
  readonly onFetchModels?: (
    req: FetchModelsRequest,
  ) => Promise<FetchModelsOutcome> | FetchModelsOutcome;
  readonly log: (line: string) => void;
}

export interface HostMountHandle {
  /** 向当前所有 OPEN 的 `/dsh-voice/ws` 客户端发一条文本帧。 */
  broadcastUi(event: PetUiEvent): void;
  /** 摘掉路由、升级和 tapIndex，拆掉 WS 与 TCP。 */
  close(): Promise<void>;
}

interface WidgetCacheEntry {
  readonly mtimeMs: number;
  readonly text: string;
}

interface SpriteFile {
  readonly name: string;
  readonly ext: 'webp' | 'png';
}

interface LivePipe {
  readonly id: number;
  readonly ws: WebSocket;
  readonly tcp: Socket;
  done: boolean;
}

type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly status: 400 | 413 };

const widgetCache = new Map<string, WidgetCacheEntry>();

/**
 * 往宿主的注入表追加桌面引导行。已有指向本组件的 `script` / `script-src` 时不重复推。
 * 表不是数组、或某行取值抛错时直接返回，不打断宿主收集。
 */
export function appendDesktopWidgetInjection(table: unknown): void {
  try {
    if (!Array.isArray(table)) return;
    const rows = table as unknown[];
    for (const row of rows) {
      if (rowReferencesWidget(row)) return;
    }
    rows.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT });
  } catch {
    // 注入表被别人改坏时，不把宿主的 index 收集打崩。
  }
}

/** 网页 index 的幂等变换：已经引用过 widget 就原样返回。 */
export function injectWidgetIntoHtml(html: string): string {
  if (html.includes(WIDGET_SCRIPT_PATH)) return html;
  const at = html.indexOf('</body>');
  if (at === -1) return html + WIDGET_TAG;
  return html.slice(0, at) + WIDGET_TAG + html.slice(at);
}

export function mountVoiceHost(options: HostMountOptions): HostMountHandle {
  const security = options.security;
  const voiceHost = options.voiceHost ?? '127.0.0.1';
  const resolveVoicePort = (): number | null => {
    const port = typeof options.voicePort === 'function' ? options.voicePort() : options.voicePort;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null;
  };
  const widgetJsPath = resolve(options.widgetJsPath);
  const assetsDir = resolve(options.assetsDir);
  const webServer = options.webServer;

  const log = (line: string): void => {
    try {
      options.log(line);
    } catch {
      // 日志回调出错不影响请求。
    }
  };

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1 << 20,
  });
  wss.on('error', (error: Error) => {
    log(`[dsh-voice] WS 服务出错: ${error.message}`);
  });

  const pipes = new Set<LivePipe>();
  const disposers: Array<() => void> = [];
  let nextId = 1;
  let closing: Promise<void> | null = null;

  const endPipe = (pipe: LivePipe, reason: string): void => {
    if (pipe.done) return;
    pipe.done = true;
    pipes.delete(pipe);
    try {
      pipe.tcp.destroy();
    } catch {
      // 套接字可能已经结束。
    }
    try {
      if (pipe.ws.readyState === pipe.ws.OPEN || pipe.ws.readyState === pipe.ws.CONNECTING) {
        pipe.ws.close();
      }
    } catch {
      // 关闭握手失败时，close() 仍会 terminate。
    }
    log(`[dsh-voice] ws#${pipe.id} ${reason}`);
  };

  const attachPipe = (ws: WebSocket): void => {
    const port = resolveVoicePort();
    if (port === null) {
      const reason = truncateUtf8(options.getVoiceError?.() || '语音后端未就绪，请检查 STT/TTS 凭据配置', 118);
      log(`[dsh-voice] 拒绝接入（语音后端未就绪）: ${reason}`);
      try {
        ws.close(4503, reason);
      } catch {
        ws.terminate();
      }
      return;
    }
    const id = nextId;
    nextId += 1;
    const tcp = connect({ host: voiceHost, port });
    const pipe: LivePipe = { id, ws, tcp, done: false };
    pipes.add(pipe);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // 语音栈只吃二进制帧。文本帧是界面通道，写进去会把 TCP 字节流打脏。
      if (!isBinary || pipe.done) return;
      try {
        tcp.write(toBuffer(data));
      } catch {
        endPipe(pipe, '上行写入失败');
      }
    });

    tcp.on('data', (chunk: Buffer) => {
      if (pipe.done || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(chunk, { binary: true });
      } catch {
        endPipe(pipe, '下行发送失败');
      }
    });

    tcp.on('error', (error: Error) => {
      endPipe(pipe, `语音栈连接出错: ${error.message}`);
    });
    tcp.on('close', () => {
      endPipe(pipe, '语音栈关闭');
    });
    ws.on('close', () => {
      endPipe(pipe, '浏览器关闭');
    });
    ws.on('error', (error: Error) => {
      endPipe(pipe, `WS 出错: ${error.message}`);
    });

    log(`[dsh-voice] ws#${id} 接入 → ${voiceHost}:${port}`);
  };

  const broadcastUi = (event: PetUiEvent): void => {
    let payload: string;
    try {
      payload = JSON.stringify(event);
    } catch {
      return;
    }
    for (const client of [...wss.clients]) {
      if (client.readyState !== client.OPEN) continue;
      try {
        client.send(payload, { binary: false });
      } catch {
        // 单个客户端失败不影响其余连接。
      }
    }
  };

  const guard = (
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    return async (req, res) => {
      if (security.rejectIfNeeded(req, res)) return;
      try {
        await handler(req, res);
      } catch (error) {
        if (res.headersSent || res.writableEnded) return;
        log(`[dsh-voice] 路由失败: ${errorMessage(error)}`);
        writeJson(res, 500, { ok: false, error: 'internal error' });
      }
    };
  };

  const serveWidget = (): void => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: WIDGET_SCRIPT_PATH,
      handler: guard((req, res) => {
        if (methodOf(req) !== 'GET') {
          writeMethodNotAllowed(res, 'GET');
          return;
        }
        const text = readWidgetJs(widgetJsPath);
        if (text === null) {
          writeBytes(res, 404, Buffer.from(WIDGET_MISSING_JS), {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return;
        }
        writeBytes(res, 200, Buffer.from(text), {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
      }),
    }));
  };

  const serveAssets = (): void => {
    disposers.push(webServer.register({
      kind: 'prefix',
      path: ASSETS_PREFIX,
      handler: guard((req, res) => {
        if (methodOf(req) !== 'GET') {
          writeMethodNotAllowed(res, 'GET');
          return;
        }
        const sprite = resolveSprite(req.url);
        if (sprite === null) {
          writeNotFound(res);
          return;
        }
        const file = spritePath(assetsDir, sprite);
        if (file === null) {
          writeNotFound(res);
          return;
        }
        let bytes: Buffer;
        try {
          const st = statSync(file);
          if (!st.isFile()) {
            writeNotFound(res);
            return;
          }
          bytes = readFileSync(file);
        } catch {
          writeNotFound(res);
          return;
        }
        writeBytes(res, 200, bytes, {
          'Content-Type': sprite.ext === 'webp' ? 'image/webp' : 'image/png',
          'Cache-Control': 'public, max-age=3600',
        });
      }),
    }));
  };

  const serveState = (): void => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: guard(async (_req, res) => {
        if (methodOf(_req) !== 'GET') {
          writeMethodNotAllowed(res, 'GET');
          return;
        }
        const state = await options.getState();
        writeJson(res, 200, state);
      }),
    }));
  };

  const serveSession = (): void => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: SESSION_PATH,
      handler: guard(async (req, res) => {
        if (methodOf(req) !== 'POST') {
          writeMethodNotAllowed(res, 'POST');
          drain(req);
          return;
        }
        const body = await readLimitedBody(req, MAX_SESSION_BODY_BYTES);
        if (!body.ok) {
          const error = body.status === 413 ? 'body too large' : 'invalid body';
          writeJson(res, body.status, { ok: false, error });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid json' });
          return;
        }
        const command = readSessionCommand(parsed);
        if (command === null) {
          writeJson(res, 400, { ok: false, error: 'invalid session payload' });
          return;
        }
        const select = options.onSelectSession;
        if (select === undefined) {
          writeJson(res, 400, { ok: false, error: 'session selection unavailable' });
          return;
        }
        const selected = await select(command.sessionId);
        if (selected.sessionId !== null && typeof selected.sessionId !== 'string') {
          writeJson(res, 500, { ok: false, error: 'invalid session result' });
          return;
        }
        writeJson(res, 200, { ok: true, sessionId: selected.sessionId });
      }),
    }));
  };

  const serveConfig = (): void => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: guard(async (req, res) => {
        if (methodOf(req) !== 'POST') {
          writeMethodNotAllowed(res, 'POST');
          drain(req);
          return;
        }
        const body = await readLimitedBody(req, MAX_SESSION_BODY_BYTES);
        if (!body.ok) {
          const error = body.status === 413 ? 'body too large' : 'invalid body';
          writeJson(res, body.status, { ok: false, error });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid json' });
          return;
        }
        const checked = sanitizeVoiceConfigUpdate(parsed);
        if (!checked.ok) {
          writeJson(res, 400, { ok: false, error: checked.error });
          return;
        }
        const update = options.onUpdateConfig;
        if (update === undefined) {
          writeJson(res, 400, { ok: false, error: 'voice config update unavailable' });
          return;
        }
        const nextState = await update(
          checked.reset ? { reset: true } : { reset: false, value: checked.value },
        );
        writeJson(res, 200, { ok: true, state: nextState });
      }),
    }));
  };

  const serveModels = (): void => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: MODELS_PATH,
      handler: guard(async (req, res) => {
        if (methodOf(req) !== 'POST') {
          writeMethodNotAllowed(res, 'POST');
          drain(req);
          return;
        }
        const body = await readLimitedBody(req, MAX_SESSION_BODY_BYTES);
        if (!body.ok) {
          const error = body.status === 413 ? 'body too large' : 'invalid body';
          writeJson(res, body.status, { ok: false, error });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid json' });
          return;
        }
        const checked = sanitizeFetchModelsRequest(parsed);
        if (!checked.ok) {
          writeJson(res, 400, { ok: false, error: checked.error });
          return;
        }
        const fetcher = options.onFetchModels;
        if (fetcher === undefined) {
          writeJson(res, 400, { ok: false, error: 'model catalog unavailable' });
          return;
        }
        const outcome = await fetcher(checked.value);
        if (!outcome.ok) {
          writeJson(res, outcome.status, { ok: false, error: outcome.error });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          endpoint: outcome.endpoint,
          models: outcome.models,
        });
      }),
    }));
  };

  try {
    serveWidget();
    serveAssets();
    serveState();
    serveSession();
    serveConfig();
    serveModels();
    disposers.push(webServer.registerUpgrade({
      path: WS_UPGRADE_PATH,
      handler: (req, socket, head) => {
        socket.on('error', () => {
          // 拒绝升级时会拆套接字；没人听 error 的话进程会被打崩。
        });
        if (security.rejectUpgradeIfNeeded(req, socket)) return;
        try {
          wss.handleUpgrade(req, socket, head, (ws) => {
            attachPipe(ws);
          });
        } catch (error) {
          log(`[dsh-voice] 升级失败: ${errorMessage(error)}`);
          try {
            socket.destroy();
          } catch {
            // 套接字可能已经结束。
          }
        }
      },
    }));
    disposers.push(webServer.tapIndex(injectWidgetIntoHtml));
  } catch (error) {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 注册回滚失败不掩盖原来的错误。
      }
    }
    wss.close();
    throw error;
  }

  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 单个路由摘除失败不挡住其余清理。
        }
      }
      for (const pipe of [...pipes]) {
        endPipe(pipe, '宿主卸载');
      }
      for (const client of [...wss.clients]) {
        try {
          client.terminate();
        } catch {
          // 已经结束。
        }
      }
      await new Promise<void>((resolveClose) => {
        wss.close(() => {
          resolveClose();
        });
      });
    })();
    return closing;
  };

  return { broadcastUi, close };
}

function rowReferencesWidget(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const kind = Reflect.get(row, 'kind');
  if (kind === 'script-src') {
    const src = Reflect.get(row, 'src');
    return typeof src === 'string' && src.includes(WIDGET_SCRIPT_PATH);
  }
  if (kind === 'script') {
    const text = Reflect.get(row, 'text');
    return typeof text === 'string' && text.includes(WIDGET_SCRIPT_PATH);
  }
  return false;
}

function readWidgetJs(widgetJsPath: string): string | null {
  let mtimeMs: number;
  try {
    const st = statSync(widgetJsPath);
    if (!st.isFile()) return null;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  const cached = widgetCache.get(widgetJsPath);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.text;
  try {
    const text = readFileSync(widgetJsPath, 'utf8');
    widgetCache.set(widgetJsPath, { mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

/**
 * 只接受 `/dsh-voice/assets/<精灵名>.webp|png`。
 * `..`、嵌套路径、未知名字、非法百分号编码一律当不存在。
 */
function resolveSprite(url: string | undefined): SpriteFile | null {
  const pathname = stripQueryAndHash(url ?? '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes('..')) return null;
  const prefix = `${ASSETS_PREFIX}/`;
  if (!decoded.startsWith(prefix)) return null;
  const rest = decoded.slice(ASSETS_PREFIX.length);
  const match = /^\/([a-z]+)\.(webp|png)$/.exec(rest);
  if (match === null) return null;
  const name = match[1];
  const ext = match[2];
  if (name === undefined || (ext !== 'webp' && ext !== 'png')) return null;
  if (!PET_SPRITE_NAME_SET.has(name)) return null;
  return { name, ext };
}

function spritePath(assetsDir: string, sprite: SpriteFile): string | null {
  const name = `${sprite.name}.${sprite.ext}`;
  const full = resolve(assetsDir, name);
  const root = assetsDir.endsWith(sep) ? assetsDir : assetsDir + sep;
  if (!full.startsWith(root)) return null;
  return full;
}

function stripQueryAndHash(url: string): string {
  const query = url.indexOf('?');
  const withoutQuery = query === -1 ? url : url.slice(0, query);
  const hash = withoutQuery.indexOf('#');
  return hash === -1 ? withoutQuery : withoutQuery.slice(0, hash);
}

function readSessionCommand(value: unknown): { readonly sessionId: string | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const action = Reflect.get(value, 'action');
  if (action !== undefined) {
    if (action !== 'create') return null;
    return { sessionId: null };
  }
  if (!Reflect.has(value, 'sessionId')) return null;
  const sessionId = Reflect.get(value, 'sessionId');
  if (sessionId === null || typeof sessionId === 'string') return { sessionId };
  return null;
}

function readLimitedBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const declared = contentLength(req);
  if (declared !== null && declared > maxBytes) {
    drain(req);
    return Promise.resolve({ ok: false, status: 413 });
  }
  if (req.readableEnded) {
    return Promise.resolve({ ok: true, text: '' });
  }
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolveBody(result);
    };
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      finish({ ok: false, status: 400 });
    });
  });
}

function contentLength(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function methodOf(req: IncomingMessage): string {
  return (req.method ?? 'GET').toUpperCase();
}

function drain(req: IncomingMessage): void {
  req.on('error', () => {
    // 丢掉多余的请求体时，错误不能冒泡成未处理异常。
  });
  req.resume();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function writeBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    ...headers,
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  writeBytes(res, status, Buffer.from(JSON.stringify(body)), JSON_HEADERS);
}

function writeNotFound(res: ServerResponse): void {
  writeBytes(res, 404, Buffer.from('not found'), {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function writeMethodNotAllowed(res: ServerResponse, allow: string): void {
  writeBytes(res, 405, Buffer.from('method not allowed'), {
    Allow: allow,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** RFC 6455 close reason 上限 123 UTF-8 字节，按码点边界安全截断。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(single, 'utf8') <= maxBytes) return single;
  let out = '';
  let bytes = 0;
  for (const ch of single) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (bytes + len > maxBytes - 1) break;
    out += ch;
    bytes += len;
  }
  return `${out}…`;
}
