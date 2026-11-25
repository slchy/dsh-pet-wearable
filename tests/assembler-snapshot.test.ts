/**
 * `AudioSnapshotBuffer` 自己管滚动窗口：推入、超限丢最老的块、裁尾、重置。
 * 不经过 `UtteranceAssembler`，所以这里没有定时器，也没有 `seq`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSnapshotBuffer } from '../src/assembler/audio-snapshot.ts';

function tone(ms: number, sample: number): Buffer {
  const bytes = 16_000 * 2 * ms / 1000;
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) pcm.writeInt16LE(sample, i);
  return pcm;
}

test('snapshot 裁掉尾部静音，只留 trailingTrimMs', () => {
  const buffer = new AudioSnapshotBuffer({
    recentMaxBytes: 16_000 * 8,
    sampleRate: 16_000,
    silenceDb: -40,
    silenceFloorOffsetDb: 20,
    trailingTrimMs: 100,
  });
  buffer.push(tone(200, 3_000));
  buffer.push(Buffer.alloc(16_000 * 2 * 600 / 1000));
  const ms = buffer.snapshot().length / 32;
  assert.ok(ms >= 280 && ms <= 320, `应剩约 200 ms 语音 + 100 ms 余量，实际 ${ms} ms`);
  assert.ok(buffer.byteLength > buffer.snapshot().length);
  assert.equal(buffer.durationMs, buffer.byteLength / 32);
});

test('reset 换成这一句的窗口，clear 清空', () => {
  const buffer = new AudioSnapshotBuffer({
    recentMaxBytes: 16_000,
    sampleRate: 16_000,
  });
  buffer.push(tone(100, 3_000));
  const next = tone(20, 1_000);
  buffer.reset([next]);
  assert.equal(buffer.byteLength, next.length);
  assert.equal(buffer.snapshot().length, next.length);
  assert.equal(buffer.durationMs, 20);
  buffer.clear();
  assert.equal(buffer.byteLength, 0);
  assert.equal(buffer.snapshot().length, 0);
  assert.equal(buffer.durationMs, 0);
});

test('超过 recentMaxBytes 丢掉最老的块，单块再大也留着', () => {
  const buffer = new AudioSnapshotBuffer({
    recentMaxBytes: 1_000,
    sampleRate: 16_000,
  });
  buffer.push(Buffer.alloc(800));
  buffer.push(Buffer.alloc(800));
  buffer.push(Buffer.alloc(800));
  assert.equal(buffer.byteLength, 800);
  assert.equal(buffer.durationMs, 25);
});
