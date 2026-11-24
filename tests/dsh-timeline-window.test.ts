/**
 * ③ 段按本轮时间窗配对 tts.first。
 *
 * 第一轮没有首块时，全局下标会把第二轮的 tts.first 错配给第一轮。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'dsh-timeline.ts');
const T0 = Date.parse('2026-11-15T10:00:00.000Z');

test('第一轮没有 tts.first 时，不占用下一轮的首块', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-timeline-window-'));
  const dir = join(root, 'session');
  const dshRoot = join(root, 'dsh');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      startedAt: new Date(T0).toISOString(),
      gateHoldMs: 2000,
    }));
    const our = [
      { t: 1000, ev: 'turn.start' },
      { t: 4000, ev: 'turn.end', dsh_session: 'sess-abc' },
      { t: 5000, ev: 'turn.start' },
      { t: 8000, ev: 'tts.first' },
      { t: 9000, ev: 'turn.end', dsh_session: 'sess-abc' },
    ];
    writeFileSync(join(dir, 'events.jsonl'), `${our.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const sid = 'sess-abc';
    const ws = join(dshRoot, '--home-me-workspace--', sid);
    mkdirSync(ws, { recursive: true });
    const dsh = [
      { type: 'session', version: 4, id: sid, createdAt: T0, time: T0 },
      { type: 'turn/start', time: T0 + 1100, data: { turn: 1 } },
      { type: 'turn/end', time: T0 + 3900, data: { reason: { kind: 'completed' } } },
      { type: 'turn/start', time: T0 + 5100, data: { turn: 2 } },
      { type: 'turn/end', time: T0 + 8900, data: { reason: { kind: 'completed' } } },
    ];
    writeFileSync(
      join(ws, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${dsh.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')),
    );

    const out = execFileSync(
      process.execPath,
      [SCRIPT, dir, '--dsh-root', dshRoot],
      { encoding: 'utf8' },
    );
    const rows = [...out.matchAll(/^\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/gm)];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.[1], '1');
    assert.equal(rows[0]?.[2], '0', '没有首块的轮次时长是 0');
    assert.equal(rows[1]?.[1], '2');
    assert.equal(rows[1]?.[2], '3000', '第二轮配对自己窗口里的 tts.first');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
