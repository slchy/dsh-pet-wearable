/**
 * 流式侧通道：6 个槽（relay、端口、门、三条计数）。
 *
 * 只按门面传来的 sessionId 过滤。对不上的计入 `liveDropCount`，不进语音链路。
 * `end` 把当前 {@link LiveGate} 收完，换一只新的，下一轮重新攒字。
 */
import {
  LiveGate,
  LiveTextRelay,
  type LiveEvent,
  type LiveMessage,
} from '../live-text.ts';

export interface LiveIngest {
  readonly events: readonly LiveEvent[];
  readonly sinkText: string | null;
  readonly markFirstToken: boolean;
}

export class LiveSideband {
  private readonly log: (line: string) => void;
  private readonly threshold: number;
  private readonly deliver: (msg: LiveMessage) => void;

  private relay: LiveTextRelay | null = null;
  private relayPort: number | null = null;
  private gate: LiveGate;
  liveSinkCount = 0;
  liveMsgCount = 0;
  liveDropCount = 0;

  constructor(opts: {
    log: (line: string) => void;
    threshold: number;
    onMessage: (msg: LiveMessage) => void;
  }) {
    this.log = opts.log;
    this.threshold = opts.threshold;
    this.deliver = opts.onMessage;
    this.gate = new LiveGate(opts.threshold);
  }

  get port(): number | null {
    return this.relayPort;
  }

  /**
   * 已经绑上的接收端。没起来时是 null。
   * 门面把它露成 `liveRelay`：既有测试收尾时要 `close()`，否则监听端口挂住进程。
   */
  openedRelay(): LiveTextRelay | null {
    return this.relay;
  }

  /**
   * 起监听（幂等）。端口留给 spawn 时写进子进程环境，不写 `process.env`。
   * 没绑上就退回整段交付，下一轮还可以再试。
   */
  async ensure(): Promise<void> {
    if (this.relay !== null) return;
    const relay = new LiveTextRelay(this.log);
    const port = await relay.ready();
    this.log(`  流式    侧通道端口 ${port}`);
    if (port <= 0) {
      this.log('  流式    侧通道没起来，退回整段交付');
      return;
    }
    relay.onMessage((msg) => { this.deliver(msg); });
    this.relay = relay;
    this.relayPort = port;
  }

  /**
   * 吃一条侧通道消息。
   *
   * `currentSessionId` 是门面此刻的会话指针（文件里那个，不是传输层的 open id）。
   * `sinkArmed` 为真才增加逐句计数：没有订阅者时不把「首增量」记成发生过。
   */
  ingest(msg: LiveMessage, currentSessionId: string | null, sinkArmed: boolean): LiveIngest {
    this.liveMsgCount += 1;
    if (this.liveMsgCount <= 3) {
      const textLen = typeof msg.text === 'string' ? String(msg.text.length) : '无';
      this.log(
        `  流式    消息#${this.liveMsgCount} t=${msg.t} `
        + `s=${msg.s ?? '-'} 当前=${currentSessionId ?? '-'} `
        + `text=${textLen}`,
      );
    }
    if (currentSessionId === null || msg.s !== currentSessionId) {
      this.liveDropCount += 1;
      return { events: [], sinkText: null, markFirstToken: false };
    }
    if (msg.t === 'end') {
      const events = this.gate.finish();
      this.gate = new LiveGate(this.threshold);
      return { events, sinkText: null, markFirstToken: false };
    }
    if (typeof msg.text !== 'string') {
      return { events: [], sinkText: null, markFirstToken: false };
    }
    if (sinkArmed) {
      this.liveSinkCount += 1;
      if (this.liveSinkCount === 1) {
        this.log(`  流式    首增量 ${msg.text.length} 字`);
      }
    }
    return {
      events: this.gate.push(msg.text),
      sinkText: msg.text,
      markFirstToken: true,
    };
  }
}
