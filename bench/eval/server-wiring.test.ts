/**
 * 评测沙盒与 CLI / Web 共用 `buildVoiceRuntimeConfig`，不再自抄一套默认值。
 *
 * 锁的是会静默漂掉的那些数：空闲 120 s、档案 200 MB / 保留 100 份、
 * 拍照确认 20 s。沙盒门限 −46 与上行增益 2 不得再出现。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('评测沙盒调用同一份配置，不再自抄默认值', () => {
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  assert.match(server, /buildVoiceRuntimeConfig\(/u);
  assert.match(server, /idleTimeoutMs:\s*120_000/u);
  assert.match(server, /archiveMaxMb:\s*200/u);
  assert.match(server, /archiveKeep:\s*100/u);
  assert.match(server, /photoTimeoutMs:\s*20_000/u);
  assert.equal(/-46/u.test(server), false);
  assert.equal(/MIC_GAIN',\s*2/u.test(server), false);
});
