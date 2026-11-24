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
  /**
   * 这条连接累计重传了多少段（`retrans:当前/累计` 的累计值）。
   * 读不到 `retrans:` 时是 `null`，不拿 0 冒充「没重传」—— 与 `net-counters.ts` 同一口径。
   */
  readonly retrans: number | null;
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
      // `retrans:0/12` —— 斜杠后面是累计总次数。没有这个字段就是没读到，记 null。
      retrans: (() => {
        const m = /retrans:(\d+)\/(\d+)/.exec(metrics);
        return m?.[2] === undefined ? null : Number.parseInt(m[2], 10);
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

/**
 * 从一堆连接里挑出**本端端口正好等于 `localPort`** 的那一条。
 *
 * 不能用 `includes`：`:4123` 会匹配到 `:41234`。而厂商入口是共享的
 * （2026-11-22 实测 ASR 和 TTS 都连 `39.96.213.166:443`），只按 IP 挑会把
 * ASR 的 `retrans` 记到 TTS 头上。
 */
export function selectSocket(stats: readonly SocketStat[], localPort: number): SocketStat | null {
  if (!Number.isInteger(localPort) || localPort <= 0) return null;
  const suffix = `:${localPort}`;
  return stats.find((s) => s.local.endsWith(suffix)) ?? null;
}

/**
 * 只采**这一条**连接（按本端端口精确定位）—— 卡顿发生**当时**用的。
 *
 * 为什么不能等首块回来再采：那一刻重传包已经送达、对方 ACK 已经回来，内核会
 * 立刻把 `unacked` 清零、把退避上去的 `rto` 退回到 ~250 ms。事后采只能看到
 * 「恢复后」的样子，而真正要抓的是「还悬在半空」的那一瞬间。
 *
 * `localPort <= 0` 直接返回 `null`：`ss` 对 `sport = :`（空端口）**不报错**，
 * 而是退回「所有 established」—— 2026-11-22 实测过，会把整机连接当成目标那条。
 *
 * **永不 reject**：没装 `ss`、没权限、解析不了，都返回 `null`。
 */
export function sampleSocket(localPort: number): Promise<SocketStat | null> {
  if (!Number.isInteger(localPort) || localPort <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'ss',
      ['-tin', 'state', 'established', `( sport = :${localPort} )`],
      { timeout: 2_000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(selectSocket(parseSsOutput(stdout), localPort));
      },
    );
  });
}
