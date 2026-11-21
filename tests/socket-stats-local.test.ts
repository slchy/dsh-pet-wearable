import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSsOutput } from '../src/socket-stats.ts';
const SS = [
  'Recv-Q Send-Q Local Address:Port   Peer Address:PortProcess',
  '0      0      10.0.0.8:41234      203.0.113.24:443',
  '\t cubic rto:246 rtt:45.458/4.283 unacked:3 retrans:0/2',
  '0      0      10.0.0.8:41236      203.0.113.24:443',
  '\t cubic rto:270 rtt:52.1/6.4 unacked:0 retrans:1/14',
].join('\n');
test('同对端两条连接：靠 local 区分（只按 peer 汇总会在换代时算成负增量）', () => {
  const out = parseSsOutput(SS);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.local, '10.0.0.8:41234');
  assert.equal(out[1]?.local, '10.0.0.8:41236');
  assert.equal(out[0]?.peer, out[1]?.peer, '对端相同');
  assert.notEqual(out[0]?.local, out[1]?.local, '本端不同 → 两条独立 socket');
});
