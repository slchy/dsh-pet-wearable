import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffNetCounters, netFields, readNetCounters } from '../src/net-counters.ts';

/** `/proc/net/snmp` 的真实形状：表头一行、数值一行，两行都以 `Tcp:` 开头。 */
const SNMP = [
  'Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors',
  'Tcp: 1 200 120000 -1 12345 678 9 10 11 2222222 333333 4444 5 6 0',
  '',
].join('\n');

/** `/proc/net/netstat` 的真实形状：`TcpExt:` 表头 + 数值行，字段很多。 */
const NETSTAT = [
  'TcpExt: SyncookiesSent SyncookiesRecv TCPLostRetransmit TCPTimeouts TCPFastRetrans TCPOFOQueue TCPDSACKRecv TCPDSACKOfoRecv',
  'TcpExt: 0 0 7 8 9 10 11 12',
  '',
  'IpExt: InNoRoutes InTruncatedPkts',
  'IpExt: 0 0',
  '',
].join('\n');

const read = (path: string): string => {
  if (path === '/proc/net/snmp') return SNMP;
  if (path === '/proc/net/netstat') return NETSTAT;
  throw new Error(`没有这个文件: ${path}`);
};

test('按表头名字取数，不按列序猜 —— 字段顺序变了也不会读错', () => {
  const c = readNetCounters(read);
  assert.equal(c.retrans, 4444, '出向重传取 RetransSegs');
  assert.equal(c.timeouts, 8, 'RTO 触发次数');
  assert.equal(c.fastRetrans, 9);
  assert.equal(c.lostRetrans, 7, '重传又丢 —— 这是「同一个包连丢多次」的直接证据');
  assert.equal(c.ofoQueue, 10, '入向乱序：厂商回给我们的包丢了的代理');
  assert.equal(c.dsack, 11);
});

test('读不到就给 null，不拿 0 冒充', () => {
  const c = readNetCounters(() => {
    throw new Error('ENOENT');
  });
  assert.equal(c.retrans, null);
  assert.equal(c.ofoQueue, null);
  assert.deepEqual(netFields(c), {}, '全 null 时一个字段都不落，档案里看不见它');
});

test('默认读取路径在 Linux 上真的读到数（否则仪表是死的还不知道）', () => {
  // 这条是给「默认读取器」本身的：写成运行期 `require` 之类会在这条上炸出来
  // —— ESM 里 `require` 未定义，异常被 try/catch 吞掉，读数会永远是 null。
  const c = readNetCounters();
  if (process.platform === 'linux') {
    assert.equal(typeof c.retrans, 'number', '/proc/net/snmp 在 Linux 上必须读得到');
    assert.equal(typeof c.timeouts, 'number', '/proc/net/netstat 在 Linux 上必须读得到');
  } else {
    assert.equal(c.retrans, null, '没有 /proc 的平台记 null，不抛');
  }
});

test('增量逐项相减；任一侧读不到就 null（不能把「没读成」当没发生）', () => {
  const before = readNetCounters(read);
  const after = { ...before, retrans: (before.retrans ?? 0) + 5, ofoQueue: null };
  const d = diffNetCounters(before, after);
  assert.equal(d.retrans, 5);
  assert.equal(d.timeouts, 0, '两次都读到、没涨 → 0 是有意义的「没重传」');
  assert.equal(d.ofoQueue, null, '一侧没读成 → null');
  assert.deepEqual(netFields(d), {
    net_retrans: 5,
    net_timeouts: 0,
    net_fast_retrans: 0,
    net_lost_retrans: 0,
    net_dsack: 0,
  }, 'null 的项不落盘，0 的项要落 —— 「没重传」和「没读成」在档案里必须分得开');
});
