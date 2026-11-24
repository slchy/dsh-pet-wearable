/**
 * 能量门：静音累计的唯一来源，以及预卷块的 voiced 标签。
 *
 * `voiceDebounceFrames` 缺省 1，一块过门限就算有声（老行为）。
 * 生产传 2：单帧尖峰不把 `silenceMs` 打回 0，连续两帧才推进「最近有声」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnergyGate } from '../src/energy-gate.ts';

function pcmAt(sample: number, bytes = 640): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) {
    pcm.writeInt16LE(sample, i);
  }
  return pcm;
}

const LOUD = pcmAt(8_000);
const QUIET = pcmAt(0);

function gate(extra: { readonly voiceDebounceFrames?: number; readonly now?: () => number } = {}) {
  return new EnergyGate({
    thresholdDbfs: -40,
    holdMs: 2_000,
    prerollBytes: 8_000,
    sampleRate: 16_000,
    ...extra,
  });
}

test('缺省去抖为 1：一块过门限就开门，静音按注入时钟累计', () => {
  let now = 100;
  const energy = gate({ now: () => now });
  assert.equal(energy.process(QUIET).forward, false);

  now = 120;
  const opened = energy.process(LOUD);
  assert.equal(opened.voiced, true);
  assert.equal(opened.silenceMs, 0);
  assert.equal(opened.forward, true);
  assert.ok(opened.opened);
  assert.equal(opened.opened.prerollFrames.length, 1);
  assert.equal(opened.opened.prerollFrames[0]!.voiced, false);
  assert.equal(opened.opened.preroll[0], opened.opened.prerollFrames[0]!.pcm);

  now = 140;
  const held = energy.process(QUIET);
  assert.equal(held.voiced, false);
  assert.equal(held.silenceMs, 20);
  assert.equal(held.closed, false);

  now = 120 + 2_001;
  const closed = energy.process(QUIET);
  assert.equal(closed.closed, true);
  assert.equal(closed.silenceMs, 2_001);
});

test('process 用传入的时刻，不再自己读时钟', () => {
  const energy = gate({
    now: () => { throw new Error('now'); },
  });
  const opened = energy.process(LOUD, 1_000);
  assert.equal(opened.voiced, true);
  assert.equal(opened.silenceMs, 0);
  const held = energy.process(QUIET, 1_050);
  assert.equal(held.silenceMs, 50);
  assert.equal(held.voiced, false);
});

test('voiceDebounceFrames:2 单帧尖峰不归零 silenceMs，连续两帧才推进', () => {
  const energy = gate({ voiceDebounceFrames: 2 });

  assert.equal(energy.process(QUIET, 1_000).forward, false);

  const spikeClosed = energy.process(LOUD, 2_000);
  assert.equal(spikeClosed.forward, false, '门关着的单帧尖峰不开门');
  assert.equal(spikeClosed.voiced, false);
  assert.equal(spikeClosed.opened, undefined);
  assert.equal(energy.isOpen, false);

  energy.process(QUIET, 2_020);

  const first = energy.process(LOUD, 3_000);
  assert.equal(first.forward, false, '连续有声的第一帧还只是预卷');
  const second = energy.process(LOUD, 3_020);
  assert.equal(second.forward, true);
  assert.equal(second.voiced, true, '开门帧本身已有声');
  assert.equal(second.silenceMs, 0);
  assert.ok(second.opened);
  const preroll = second.opened.prerollFrames;
  assert.equal(preroll.at(-1)?.voiced, true, '开门前那块有声预卷在门内标好');
  assert.equal(preroll[0]?.voiced, false, '静音预卷标成无声');
  assert.equal(second.opened.preroll.at(-1), preroll.at(-1)?.pcm);

  const quiet = energy.process(QUIET, 3_100);
  assert.equal(quiet.voiced, false);
  assert.equal(quiet.silenceMs, 80);

  const blip = energy.process(LOUD, 3_200);
  assert.equal(blip.voiced, false);
  assert.equal(blip.forward, true);
  assert.equal(blip.closed, false);
  assert.equal(blip.silenceMs, 180, '单帧尖峰不把 silenceMs 打回 0');

  const after = energy.process(QUIET, 3_220);
  assert.equal(after.silenceMs, 200, '尖峰之后仍从上次确认的有声时刻累计');

  const lead = energy.process(LOUD, 3_300);
  assert.equal(lead.voiced, false);
  assert.equal(lead.silenceMs, 280);
  const follow = energy.process(LOUD, 3_320);
  assert.equal(follow.voiced, true);
  assert.equal(follow.silenceMs, 0, '连续第二帧才推进');
  const tail = energy.process(QUIET, 3_340);
  assert.equal(tail.silenceMs, 20, '最近有声停在第二帧，不停在第一帧');
});
