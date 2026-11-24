/**
 * 浏览器帧常量与 `src/voice/frame.ts`（sync 自仓根 `src/frame.ts`）锁定。
 * 超长帧必须停掉解码，不能把后续字节当成新帧。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DownstreamFrameType as ServerDown,
  FRAME_HEADER_BYTES as ServerHeader,
  FRAME_MAX_BYTES,
  UpstreamFrameType as ServerUp,
} from '../src/voice/frame.ts';
import {
  DownstreamFrameType as BrowserDown,
  FRAME_HEADER_BYTES as BrowserHeader,
  FRAME_MAX_BYTES as BrowserMax,
  FrameDecoder,
  UpstreamFrameType as BrowserUp,
} from '../src/browser/frames.ts';

function frameHeader(type: number, length: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, length, true);
  return out;
}

test('浏览器帧常量与 src/frame.ts 锁定，超长帧停止解码', () => {
  assert.equal(BrowserHeader, ServerHeader);
  assert.equal(BrowserHeader, 5);
  assert.equal(BrowserMax, FRAME_MAX_BYTES);
  assert.equal(FRAME_MAX_BYTES, 32 << 20);
  assert.deepEqual(BrowserUp, ServerUp);
  assert.deepEqual(BrowserDown, ServerDown);

  const reasons: string[] = [];
  const within = new FrameDecoder((reason) => { reasons.push(reason); });
  assert.deepEqual(within.push(frameHeader(1, FRAME_MAX_BYTES)), []);
  assert.equal(reasons.length, 0, '刚好等于上限还不算错位，只是载荷没到齐');

  const bad = new FrameDecoder((reason) => { reasons.push(reason); });
  assert.deepEqual(bad.push(frameHeader(1, FRAME_MAX_BYTES + 1)), []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? '', /帧长异常/);

  const follow = new Uint8Array(6);
  follow[0] = 2;
  new DataView(follow.buffer).setUint32(1, 1, true);
  follow[5] = 9;
  assert.deepEqual(bad.push(follow), [], '停掉之后不能把后续字节当成新帧');
  assert.equal(reasons.length, 1);
});
