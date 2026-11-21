import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSsOutput } from '../src/socket-stats.ts';

/** `ss -tin` 的真实形状：表头一行，然后每条连接一块（首行地址，缩进行是计数）。 */
const SS = [
  'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'ESTAB 0      0      10.0.0.8:41234     203.0.113.24:443',
  '\t cubic wscale:9,7 rto:246 rtt:45.458/4.283 ato:40 mss:1460 unacked:3 retrans:0/2',
  'ESTAB 0      0      10.0.0.8:41236     203.0.113.24:443',
  '\t cubic wscale:9,7 rto:270 rtt:52.1/6.4 ato:40 mss:1460 unacked:0 retrans:1/14',
  'ESTAB 0      1460   10.0.0.8:63993     198.51.100.82:51122',
  '\t cubic wscale:7,7 rto:204 rtt:12.3/1.1 ato:40 mss:1448 unacked:1460 retrans:4/388',
].join('\n');

/**
 * 带 `state established` 过滤时的真实形状：**没有状态列**。
 *
 * 2026-11-21 服务器实测抓的：`ss -tin state established '( dport = :443 )'`
 * 第一行直接是 `0 0 10.0.0.8:32986 203.0.113.49:443`。按状态列判块会把
 * 所有连接静默丢掉（表现为「采到 0 条」）。
 */
const SS_FILTERED = [
  'Recv-Q Send-Q Local Address:Port   Peer Address:PortProcess',
  '0      0      10.0.0.8:32986   203.0.113.49:443',
  '\t cubic rto:256 rtt:55.963/6.892 ato:40 mss:1460 unacked:0 retrans:0/0',
  '0      0      10.0.0.8:33002   203.0.113.49:443',
  '\t cubic rto:259 rtt:58.1/5.2 ato:40 mss:1460 unacked:1460 retrans:0/1',
].join('\n');

test('带 state 过滤的输出（无状态列）也要解析出来 —— 这条是实测踩过的坑', () => {
  const out = parseSsOutput(SS_FILTERED);
  assert.equal(out.length, 2, '过滤模式下没有 ESTAB 列，不能拿状态列当判据');
  assert.deepEqual(out[0], {
    local: '10.0.0.8:32986', peer: '203.0.113.49:443', retrans: 0, rto: 256, rtt: 56, unacked: 0,
  });
  assert.equal(out[1]?.retrans, 1);
  assert.equal(out[1]?.unacked, 1460);
});

test('按块解析：对端地址、retrans（取斜杠后面那个总数）、rto、rtt、unacked', () => {
  const out = parseSsOutput(SS);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    local: '10.0.0.8:41234', peer: '203.0.113.24:443', retrans: 2, rto: 246, rtt: 45, unacked: 3,
  });
  assert.equal(out[1]?.retrans, 14, '`retrans:1/14` 的 14 是这条连接累计重传次数');
  assert.deepEqual(out[2], {
    local: '10.0.0.8:63993', peer: '198.51.100.82:51122', retrans: 388, rto: 204, rtt: 12, unacked: 1460,
  }, '手机那条：388 次重传 + 1460 字节没被确认 —— 这才是「整机 388」可能的真身');
});

test('没有 retrans 字段的连接记 0（不是 null）—— 「没重传」和「没读到」要分开', () => {
  const out = parseSsOutput([
    'ESTAB 0 0 10.0.0.8:1 1.2.3.4:443',
    '\t cubic rto:200 rtt:1.0/0.1',
  ].join('\n'));
  assert.equal(out[0]?.retrans, 0);
  assert.equal(out[0]?.rto, 200);
});

test('空输入 / 只有表头 → 空数组，不抛', () => {
  assert.deepEqual(parseSsOutput(''), []);
  assert.deepEqual(parseSsOutput('State Recv-Q Send-Q Local Peer'), []);
});
