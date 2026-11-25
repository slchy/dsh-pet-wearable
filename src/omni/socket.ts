/**
 * 一条 realtime WebSocket：建连、JSON 发送、解帧、协议错误计数。
 *
 * 非法 JSON 丢掉。`before response.created` 不计错。
 * 第二次其它协议错误把 `disposition` 转成 `broken`，调用方再停整条车道。
 */
import type { RealtimeSocket, ServerEvent } from './types.ts';

export type ProtocolVerdict = 'ignore' | 'counted' | 'broken';

export interface OmniSocketHooks {
  onOpen(): void;
  onEvent(ev: ServerEvent): void;
  onClose(): void;
}

export function decodeServerEvent(raw: Buffer): ServerEvent | null {
  try {
    return JSON.parse(raw.toString()) as ServerEvent;
  } catch {
    return null;
  }
}

export class OmniSocket {
  ws: RealtimeSocket | null = null;
  /** socket 已 open（可以发帧）。与会话 `ready` 不是一回事：后者还要等 `session.updated`。 */
  opened = false;
  /** 连续协议错误次数（忙时 create 被拒之类）。2 次就判连接语义已脏。 */
  protocolErrors = 0;
  /** 第二次协议错误之后为 `broken`。`before response.created` 不会把它推过去。 */
  disposition: 'ok' | 'broken' = 'ok';
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.opened;
  }

  connect(ws: RealtimeSocket, hooks: OmniSocketHooks): void {
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) {
        return;
      }
      this.opened = true;
      hooks.onOpen();
    });
    ws.on('message', (...args: never[]) => {
      if (this.ws !== ws) {
        return;
      }
      const ev = decodeServerEvent(args[0] as unknown as Buffer);
      if (ev === null) {
        return;
      }
      hooks.onEvent(ev);
    });
    ws.on('error', (...args: never[]) => {
      if (this.ws !== ws) {
        return;
      }
      // 不发事件：真正的后果是随后的 close，那里统一处理
      this.log(`[omni] socket error: ${String(args[0])}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) {
        return;
      }
      hooks.onClose();
    });
  }

  send(payload: object): void {
    if (this.ws === null) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.log(`[omni] 发送失败：${(error as Error).message}`);
    }
  }

  /**
   * 记一次服务端 `error`。
   * 「在 created 之前 cancel」是我们自己的时序，不计入协议错误，也不把车道判死。
   */
  observeProtocolError(message: string): ProtocolVerdict {
    this.log(`[omni] 服务端错误：${message.slice(0, 160)}`);
    if (message.includes('before response.created')) {
      return 'ignore';
    }
    this.protocolErrors += 1;
    if (this.protocolErrors >= 2) {
      this.disposition = 'broken';
      return 'broken';
    }
    return 'counted';
  }

  /** 摘掉当前 socket。调用方负责 `close()`。迟到的事件对不上这一只，直接丢掉。 */
  detach(): RealtimeSocket | null {
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    return ws;
  }
}
