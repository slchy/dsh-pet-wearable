/**
 * `pair.ts new` 的监听警告只走 checkBindSafety。
 * localhost / ::1 / 127.* 是本机，不因为「不是字面量 127.0.0.1」就误报缺 TLS。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function runNew(host: string): Promise<{ code: number | null; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'pair-bind-'));
  const file = join(dir, 'tokens.txt');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(root, 'src', 'pair.ts'),
      'new',
      '--host', host,
      '--port', '9',
      '--file', file,
    ], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, stderr });
    });
  });
}

test('localhost / ::1 / 127.0.0.2 无 TLS 不误报非本机', async () => {
  for (const host of ['localhost', '::1', '127.0.0.2', '127.0.0.1']) {
    const result = await runNew(host);
    assert.equal(result.code, 0, `${host} 生成失败：${result.stderr}`);
    assert.equal(result.stderr.includes('没带 --tls'), false, `${host} 不该再走手写警告`);
    assert.equal(result.stderr.includes('拒绝监听'), false, `${host} 是本机，checkBindSafety 不该拒绝`);
  }
});

test('非本机且无 TLS：只由 checkBindSafety 警告，不再另写一条', async () => {
  const result = await runNew('203.0.113.10');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr.includes('拒绝监听'), true, result.stderr);
  assert.equal(result.stderr.includes('没带 --tls'), false, result.stderr);
});
