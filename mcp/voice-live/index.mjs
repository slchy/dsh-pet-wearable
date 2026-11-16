/**
 * voice-live：把 dsh 内部的**流式文本**转成侧通道发给 harness。
 *
 * <h2>为什么需要它</h2>
 *
 * SDK 的 JSON-RPC 只推 `session.event`，而 `assistant/message` 是**整段交付**的
 * （里面虽然带 token 级时间戳，但那是事后回放用的，不是实时的）。宿主这边支持
 * 流式和取消，SDK 这层不支持 —— 要让长回答（后台任务完成汇报）早点出声，就得
 * 在 dsh 进程内把 token 捞出来。
 *
 * `llm/stream` 是 cordis 的 waterfall 拦截点：
 *
 * ```
 *   ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>)
 * ```
 *
 * 我们**只旁听不改写**：`yield` 原样转发每个 chunk，顺手把 `text-delta` 抄一份
 * 写进本地 TCP 连接。任何异常都吞掉 —— 这个插件出问题不能影响正常对话。
 *
 * <h2>通道</h2>
 *
 * `VOICE_LIVE_PORT` 是 harness 起监听后传给 dsh 子进程的环境变量（dsh 继承
 * `process.env`）。没配就整个插件不启用。发的是一行一个 JSON：
 *
 * ```json
 *   {"t":"delta","s":"session-xxx","text":"你"}
 *   {"t":"end","s":"session-xxx","tokens":37}
 * ```
 *
 * **20 token 内不流式**的门槛不在这里：插件只负责把 token 原样吐出去，
 * "攒够 20 个再释放"是 harness 侧的 `LiveGate` 决定的（那是可以单测的纯逻辑，
 * 放在这里就只能靠肉眼验）。
 */
import { connect } from 'node:net';

export const name = 'voice-live';

export function apply(ctx) {
  const port = Number(process.env['VOICE_LIVE_PORT'] ?? 0);
  if (!Number.isInteger(port) || port <= 0) {
    return;
  }

  let socket = null;
  /** 连接还没建好时先攒着 —— 丢几个 token 比阻塞上游更糟 */
  const pending = [];

  const write = (obj) => {
    const line = `${JSON.stringify(obj)}\n`;
    if (socket !== null && socket.writable) {
      socket.write(line);
      return;
    }
    pending.push(line);
    if (pending.length > 512) {
      pending.shift();
    }
  };

  const connectOnce = () => {
    console.error('[voice-live] connect 127.0.0.1:' + port);
    try {
      const sock = connect({ host: '127.0.0.1', port }, () => {
        socket = sock;
        while (pending.length > 0) {
          sock.write(pending.shift());
        }
      });
      sock.on('error', () => {
        // harness 那边没起来 / 已经退出：静默放弃，下次调用再试
        socket = null;
      });
      sock.on('close', () => {
        socket = null;
      });
      sock.unref?.();
    } catch {
      socket = null;
    }
  };
  connectOnce();

  ctx.on('llm/stream', (options, next) => {
    const sessionId = options?.sessionId;
    // 没有 sessionId 的是旁路调用（压缩、会话标题这类），不往语音链路上送
    if (typeof sessionId !== 'string' || sessionId === '') {
      return next();
    }

    const inner = next();
    return (async function* tapped() {
      let tokens = 0;
      for await (const chunk of inner) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          tokens += 1;
          write({ t: 'delta', s: sessionId, text: chunk.text });
        }
        yield chunk;
      }
      write({ t: 'end', s: sessionId, tokens });
    })();
  }, { global: true });
}
