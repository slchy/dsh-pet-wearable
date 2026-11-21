/**
 * 每条 TCP 连接**自己的**重传 / RTO —— 从 `ss -tin` 读（每 socket 累计值）。
 *
 * ## 为什么需要它（`turn.end.net_*` 不够）
 *
 * `/proc/net/snmp` 的 `TcpRetransSegs` / `netstat` 的 `TcpExt` 都是**整机**计数。
 * 2026-11-21 第一场带这些字段的真机里，轮 14 冒出 `retrans 388 / lost_retrans 149`，
 * 而那一轮的 TTS 首包 354 ms 完全正常 —— 一条只发几百字节 JSON 的连接不可能重传 388
 * 次。那个数字里必然混着别的连接（最可能是服务器→手机的音频下行），所以**不能**用它
 * 给 TTS / ASR 归因。
 *
 * `ss -tin` 给的是**每 socket** 的 `retrans:` / `rto:` / `rtt:`，这才分得清是谁。
 *
 * ## 口径
 *
 * - 只采**已建立**、且对端是 443（厂商）或本地端口是监听口的连接；
 * - 采不到 / 没装 `ss` → 返回空数组，**不抛**（不能因为一个诊断把一轮搞挂）；
 * - 调用点必须在 `turn.end` **之后**且**不 await** —— 子进程 fork+exec 峰值 10–15 ms，
 *   放进关键路径会直接吃进 `loop_max`。
 */

import { execFile } from 'node:child_process';

/** 一条连接的自述。地址不带端口时是空串。 */
export interface SocketStat {
  /**
   * 本端 `IP:端口`。**必须留着**：同一个对端会有多条连接（重连），只按对端汇总会在
   * 换代那一刻算出**负增量**（2026-11-21 实测踩过：`220.197.201.66 −3`）。
   * 按 `local` 识别 socket 才做得对。
   */
  readonly local: string;
  /** 对端 `IP:端口`（出向连接用；入向连接这是我们的客户端地址） */
  readonly peer: string;
  /** 这条连接累计重传了多少段 —— 关键字段，>0 才说明它丢过包 */
  readonly retrans: number;
  /** 当前 RTO（ms）。`ss` 不给时为 `null` */
  readonly rto: number | null;
  /** 平滑 RTT（ms） */
  readonly rtt: number | null;
  /** 发出去还没被确认的字节数（`unacked`） */
  readonly unacked: number | null;
}

/** `ss -tin` 的一行块 → 一条连接。块的第一行是地址，后面缩进的行是计数。 */
export function parseSsOutput(text: string): SocketStat[] {
  const out: SocketStat[] = [];
  /**
   * 地址 token：`1.2.3.4:443` / `[::1]:443` / `*:63993`。
   *
   * **不能靠状态列**：`ss -tin state established …` 的输出里**没有 `ESTAB` 列**
   * （只有不带过滤的默认列表才打状态），拿状态列当块首判据会把所有连接都丢掉 ——
   * 2026-11-21 实测踩过：探针给了 0 条，同一时刻 `ss` 原始输出里明明有连接。
   */
  const ADDR = /^(?:\[[0-9a-fA-F:.]+\]|[\d.a-fA-F:%]+|\*):(\d+)$/;
  for (const block of text.split(/\n(?=\S)/)) {
    const lines = block.trim().split('\n');
    const head = lines[0] ?? '';
    // 表头行：`Recv-Q Send-Q Local Address:Port Peer Address:Port Process`（或带 State 的老格式）
    if (/^(?:State|Recv-Q)\b/.test(head)) continue;
    const addrs = head.trim().split(/\s+/).filter((t) => ADDR.test(t));
    if (addrs.length < 2) continue;
    const local = addrs[0] ?? '';
    const peer = addrs[1] ?? '';
    const metrics = lines.slice(1).join(' ');
    const num = (re: RegExp): number | null => {
      const m = re.exec(metrics);
      return m?.[1] === undefined ? null : Number.parseInt(m[1], 10);
    };
    out.push({
      local,
      peer,
      // `retrans:0/12` —— 斜杠后面是「连当前这次在内的总重传次数」，取后者
      retrans: (() => {
        const m = /retrans:(\d+)\/(\d+)/.exec(metrics);
        if (m?.[2] !== undefined) return Number.parseInt(m[2], 10);
        if (m?.[1] !== undefined) return Number.parseInt(m[1], 10);
        return 0;
      })(),
      rto: num(/\brto:(\d+)/),
      rtt: (() => {
        const m = /\brtt:([\d.]+)/.exec(metrics);
        return m?.[1] === undefined ? null : Math.round(Number.parseFloat(m[1]));
      })(),
      unacked: num(/\bunacked:(\d+)/),
    });
  }
  return out;
}

/**
 * 采一次。**永不 reject** —— 没有 `ss`、没有权限、解析不了，都返回 `[]`。
 *
 * @param port - 厂商端口（默认 443）；监听口的入向连接（手机）也一并采
 * @param listenPort - 我们自己的监听端口（其 `sport = listenPort` 的是手机连接）
 * @returns 每条 established 连接的累计计数
 */
export function sampleSockets(port = 443, listenPort = 0): Promise<SocketStat[]> {
  const filter = listenPort > 0
    ? `( dport = :${port} or sport = :${listenPort} )`
    : `( dport = :${port} )`;
  return new Promise((resolve) => {
    execFile(
      'ss',
      ['-tin', 'state', 'established', filter],
      { timeout: 2_000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(parseSsOutput(stdout));
      },
    );
  });
}
