/**
 * 侧通道：错 sessionId 只计数，end 之后换一只新的 LiveGate。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LiveSideband } from '../src/session/live-sideband.ts';

test('错 sessionId 计入 liveDropCount，不放出事件', () => {
  const band = new LiveSideband({ log: () => {}, threshold: 20, onMessage: () => {} });
  const dropped = band.ingest({ t: 'delta', s: 'other', text: '嗨' }, 'mine', false);
  assert.equal(band.liveDropCount, 1);
  assert.equal(band.liveMsgCount, 1);
  assert.deepEqual(dropped.events, []);

  const missing = band.ingest({ t: 'delta', s: 'mine', text: '嗨' }, null, false);
  assert.equal(band.liveDropCount, 2);
  assert.deepEqual(missing.events, []);

  // 错会话的 end 不能把已经攒下的字收走。
  band.ingest({ t: 'delta', s: 'mine', text: '甲' }, 'mine', false);
  band.ingest({ t: 'end', s: 'other' }, 'mine', false);
  assert.equal(band.liveDropCount, 3);
  const flushed = band.ingest({ t: 'end', s: 'mine' }, 'mine', false);
  assert.equal(flushed.events[0]?.type, 'start');
  assert.equal(flushed.events[0]?.type === 'start' ? flushed.events[0].text : '', '甲');
});

test('end 重建 LiveGate，下一轮重新攒字', () => {
  const band = new LiveSideband({ log: () => {}, threshold: 1, onMessage: () => {} });
  const session = 'mine';
  assert.equal(band.ingest({ t: 'delta', s: session, text: '甲' }, session, false).events.length, 0);
  const released = band.ingest({ t: 'delta', s: session, text: '乙' }, session, false);
  assert.equal(released.events[0]?.type, 'start');

  const ended = band.ingest({ t: 'end', s: session }, session, false);
  const tail = ended.events.at(-1);
  assert.equal(tail?.type, 'end');
  if (tail?.type === 'end') assert.equal(tail.streaming, true);

  // 旧门已经 finish，再喂会被丢掉。新门会把第一个字重新攒住。
  const again = band.ingest({ t: 'delta', s: session, text: '丙' }, session, false);
  assert.equal(again.events.length, 0, '新门重新攒字');
  const second = band.ingest({ t: 'delta', s: session, text: '丁' }, session, false);
  assert.equal(second.events[0]?.type, 'start');
  assert.equal(second.events[0]?.type === 'start' ? second.events[0].text : '', '丙');
  assert.equal(band.liveDropCount, 0);
});
