/**
 * `/proc` 里的 TCP 重传 / 乱序计数器 —— 用来把「多出来的 270 ms」分成
 * 「链路丢包」和「服务端内部慢」两类。
 *
 * ## 为什么要一次读两个文件
 *
 * `Tcp: RetransSegs`（`/proc/net/snmp`）只数**我们发出去、又重传了**的段。
 * 如果丢的是**厂商回给我们的**包（`task-started`、首块音频），退避发生在**厂商
 * 内核**里，我们这个计数器**一动不动** —— 只看它就会把厂商侧重传误判成
 * 「厂商应用层慢」。
 *
 * 入向丢包只能从**后果**上看：
 * - `TcpExt: TCPOFOQueue` —— 收到乱序段（前面的丢了/来晚了），入向丢包的代理指标
 * - `TcpExt: TCPDSACKRecv` —— 对端把我们「已经收过的数据」又发了一遍，即它认为
 *   自己丢了包（我们这边表现为收到重复）
 * - `TcpExt: TCPDSACKOfoRecv` —— 同上，乱序场景
 *
 * 出向丢包除了 `RetransSegs` 还有：
 * - `TCPTimeouts` —— RTO 真的触发了几次（比 `RetransSegs` 更贴「退避」）
 * - `TCPFastRetrans` —— 快重传（重复 ACK 触发，不经过 RTO）
 * - `TCPLostRetransmit` —— **重传包又丢了**，这是「一个包连丢多次」的直接证据
 *
 * ## 口径
 *
 * 全是**整机**计数，不区分连接。所以：
 * - 增量 > 0 只说明「这台机器这段时间里有过重传」，**不能**直接指认是哪条连接；
 * - 增量 = 0 才能当排除用（这台机器整机都没重传）。
 *
 * 读不到（非 Linux / 权限）一律记 `null` —— 不拿 0 冒充，否则「0 次重传」和
 * 「没读成」在档案里长得一样。
 */

/** 一组整机 TCP 计数器。读不到的项是 `null`。 */
export interface NetCounters {
  /** 出向：重传段数（`/proc/net/snmp` `Tcp: RetransSegs`） */
  readonly retrans: number | null;
  /** 出向：RTO 触发次数（`TcpExt: TCPTimeouts`） */
  readonly timeouts: number | null;
  /** 出向：快重传次数（`TcpExt: TCPFastRetrans`） */
  readonly fastRetrans: number | null;
  /** 出向：重传的包又丢了（`TcpExt: TCPLostRetransmit`） */
  readonly lostRetrans: number | null;
  /** 入向：收到的乱序段（`TcpExt: TCPOFOQueue`） */
  readonly ofoQueue: number | null;
  /** 入向：对端重传了我们已收的数据（`TcpExt: TCPDSACKRecv`） */
  readonly dsack: number | null;
}

/** `/proc/net/netstat` 里的 `TcpExt` 表：名字 → 本机字段序。读失败给空表。 */
function readTcpExt(read: (path: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = read('/proc/net/netstat');
  } catch {
    return out;
  }
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const head = lines[i] ?? '';
    if (!head.startsWith('TcpExt:')) continue;
    const values = (lines[i + 1] ?? '').split(' ');
    // 第一列也是 `TcpExt:`，值是数值；两行按位置对齐
    const names = head.trim().split(/\s+/).slice(1);
    const nums = values.slice(1).map((v) => Number.parseInt(v, 10));
    for (let k = 0; k < names.length && k < nums.length; k += 1) {
      const name = names[k];
      const num = nums[k];
      if (name !== undefined && num !== undefined && Number.isFinite(num)) {
        out.set(name, num);
      }
    }
    break;
  }
  return out;
}

/** `/proc/net/snmp` 里的 `Tcp:` 表（同名两行：先表头后数值）。 */
function readSnmpTcp(read: (path: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = read('/proc/net/snmp');
  } catch {
    return out;
  }
  const lines = text.split('\n');
  let names: string[] | null = null;
  for (const line of lines) {
    if (!line.startsWith('Tcp:')) continue;
    const fields = line.trim().split(/\s+/).slice(1);
    if (names === null) {
      names = fields;
      continue;
    }
    for (let k = 0; k < names.length && k < fields.length; k += 1) {
      const name = names[k];
      const num = Number.parseInt(fields[k] ?? '', 10);
      if (name !== undefined && Number.isFinite(num)) out.set(name, num);
    }
    break;
  }
  return out;
}

/** 读一次整机计数器。**永不抛** —— 读不到就 `null`。 */
export function readNetCounters(read: (path: string) => string = defaultRead): NetCounters {
  const snmp = readSnmpTcp(read);
  const ext = readTcpExt(read);
  return {
    retrans: snmp.get('RetransSegs') ?? null,
    timeouts: ext.get('TCPTimeouts') ?? null,
    fastRetrans: ext.get('TCPFastRetrans') ?? null,
    lostRetrans: ext.get('TCPLostRetransmit') ?? null,
    ofoQueue: ext.get('TCPOFOQueue') ?? null,
    dsack: ext.get('TCPDSACKRecv') ?? null,
  };
}

function defaultRead(path: string): string {
  // 运行期才 require：这个模块在测试里被当成纯函数用，不该为了读一个文件把 fs 拉进来
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  return fs.readFileSync(path, 'utf8');
}

/**
 * `after − before`。任一侧是 `null` 就给 `null`（**不**当成 0）。
 *
 * @param before - 本轮开始时的快照
 * @param after - 本轮结束时的快照
 * @returns 本轮增量；同一项两次都读到才算得出来
 */
export function diffNetCounters(before: NetCounters, after: NetCounters): NetCounters {
  const sub = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : b - a;
  return {
    retrans: sub(before.retrans, after.retrans),
    timeouts: sub(before.timeouts, after.timeouts),
    fastRetrans: sub(before.fastRetrans, after.fastRetrans),
    lostRetrans: sub(before.lostRetrans, after.lostRetrans),
    ofoQueue: sub(before.ofoQueue, after.ofoQueue),
    dsack: sub(before.dsack, after.dsack),
  };
}

/** 落进档案用的扁平字段：`net_retrans` / `net_timeouts` / …；`null` 不放进去。 */
export function netFields(delta: NetCounters): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, value: number | null): void => {
    if (value !== null) out[key] = value;
  };
  put('net_retrans', delta.retrans);
  put('net_timeouts', delta.timeouts);
  put('net_fast_retrans', delta.fastRetrans);
  put('net_lost_retrans', delta.lostRetrans);
  put('net_ofo_queue', delta.ofoQueue);
  put('net_dsack', delta.dsack);
  return out;
}
