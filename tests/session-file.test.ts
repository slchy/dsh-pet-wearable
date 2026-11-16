/**
 * 会话指针放哪：同一台机器上跑两个实例时，这是唯一把它们隔开的东西。
 *
 * 踩过的坑：bench 和生产都用默认的 `~/.voice-agent/session.json`，bench 把生产的
 * 会话 id 盖掉了 —— 不报错，只是生产下一轮悄悄开了新会话。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DshSession } from '../src/session.ts';

function withEnv(value: string | undefined, body: () => void): void {
  const before = process.env['VOICE_AGENT_SESSION'];
  if (value === undefined) delete process.env['VOICE_AGENT_SESSION'];
  else process.env['VOICE_AGENT_SESSION'] = value;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env['VOICE_AGENT_SESSION'];
    else process.env['VOICE_AGENT_SESSION'] = before;
  }
}

test('VOICE_AGENT_SESSION 指到哪就读哪；显式传的 sessionFile 优先', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-file-'));
  try {
    const fromEnv = join(dir, 'env.json');
    const explicit = join(dir, 'explicit.json');
    writeFileSync(fromEnv, JSON.stringify({ id: 'session-env' }));
    writeFileSync(explicit, JSON.stringify({ id: 'session-explicit' }));
    const workDir = join(dir, 'work');

    withEnv(fromEnv, () => {
      assert.equal(new DshSession({ workDir }).currentSessionId, 'session-env');
      assert.equal(
        new DshSession({ workDir, sessionFile: explicit }).currentSessionId,
        'session-explicit',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset 只动自己那份指针', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-file-'));
  try {
    const mine = join(dir, 'bench.json');
    const theirs = join(dir, 'prod.json');
    writeFileSync(mine, JSON.stringify({ id: 'session-bench' }));
    writeFileSync(theirs, JSON.stringify({ id: 'session-prod' }));

    withEnv(mine, () => {
      const bench = new DshSession({ workDir: join(dir, 'work') });
      bench.reset();
      assert.equal(bench.currentSessionId, null);
    });
    assert.equal(
      new DshSession({ workDir: join(dir, 'work'), sessionFile: theirs }).currentSessionId,
      'session-prod',
      '另一个实例的指针不该被碰',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
