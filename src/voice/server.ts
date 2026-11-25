/**
 * 进程级监听：控制口建一次，连接进来才握手。
 *
 * 监听、鉴权、心跳、TLS 全在 `transport.ts`；这里只决定「一条连接里谁来干活」。
 */
import { startToolControl } from '../tool-control.ts';
import { runTransport } from '../transport.ts';
import { VoiceConnection } from './connection.ts';
import { handshake } from './handshake.ts';
import type { VoiceService, VoiceSessionOptions } from './session-options.ts';

/**
 * 启动监听，按连接串行处理。返回进程退出码。
 *
 * 控制口**在这里建一次**，不是每条连接建一个：端口固定，连接级开关就是
 * `EADDRINUSE` 的来源（`tool-control.ts` 顶部记了现场表现）。
 * 连接上来时 `setHandlers` 热切换，断开时带令牌摘掉。
 */
export async function runVoiceServer(options: VoiceSessionOptions): Promise<number> {
  const control = startToolControl({
    port: options.controlPort,
    photoTimeoutMs: options.photoTimeoutMs,
    handlers: null,
  });
  const service: VoiceService = { control, activeSlot: { current: null } };
  try {
    return await runTransport({
      port: options.port,
      host: options.host,
      tls: options.tls,
      authenticate: options.authenticate,
      idleTimeoutMs: options.idleTimeoutMs,
      singleConnection: options.serve !== true,
      log: (line) => { console.log(line); },
      ...(options.onListening === undefined ? {} : { onListening: options.onListening }),
      onConnection: (conn) => {
        handshake(
          conn,
          options,
          service,
          (nextConn, nextOptions, link, nextService) => new VoiceConnection(
            nextConn,
            nextOptions,
            link,
            nextService,
          ),
        );
      },
    });
  } finally {
    // `close()` 会 `closeAllConnections()`：不关的话，keep-alive 的工具进程会一直
    // 占着端口，下一个进程绑定同一个端口就 EADDRINUSE。
    control.close();
  }
}
