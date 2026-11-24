/**
 * 桥的两道失败路径：坏百分号编码不能打崩进程，非本机明文不能绕过绑定闸。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { startWebBridge } from '../src/bridge.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshpet-bridge-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1] ?? '0');
      resolve({ status, body: raw.split('\r\n\r\n')[1] ?? '' });
    });
  });
}

test('GET /% 返回 400，不把桥进程打崩；正常文件和越界路径不受影响', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.html'), '<p>ok</p>', 'utf8');
  const bridge = await startWebBridge({
    port: 0,
    host: '127.0.0.1',
    voicePort: 1,
    webDir: dir,
    log: () => {},
  });
  try {
    const bad = await rawGet(bridge.port, '/%');
    assert.equal(bad.status, 400);
    assert.match(bad.body, /路径编码无效/);

    const page = await rawGet(bridge.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /ok/);

    const outside = await rawGet(bridge.port, '/%2e%2e/%2e%2e/package.json');
    assert.equal(outside.status, 404);
  } finally {
    await bridge.close();
  }
});

test('非本机且无 TLS：复用 checkBindSafety，拒绝启动', async () => {
  await assert.rejects(
    () => startWebBridge({
      port: 0,
      host: '0.0.0.0',
      voicePort: 1,
      log: () => {},
    }),
    /拒绝监听/,
  );
});
