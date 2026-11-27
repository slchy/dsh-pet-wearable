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
import { generateToken } from '../src/voice/tokens.ts';

async function withTokensEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env['MIAI_TOKENS'];
  if (value === undefined) delete process.env['MIAI_TOKENS'];
  else process.env['MIAI_TOKENS'] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env['MIAI_TOKENS'];
    else process.env['MIAI_TOKENS'] = prev;
  }
}

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

test('非本机且无 TLS / 无 MIAI_TOKENS：复用 checkBindSafety，拒绝启动', async () => {
  await withTokensEnv(undefined, async () => {
    await assert.rejects(
      () => startWebBridge({
        port: 0,
        host: '0.0.0.0',
        voicePort: 1,
        log: () => {},
      }),
      /拒绝监听.*缺 token 和 tls/s,
    );
  });
});

test('非本机仅有 TLS 但未配 MIAI_TOKENS：强制要求真实 token，拒绝启动', async () => {
  await withTokensEnv(undefined, async () => {
    await assert.rejects(
      () => startWebBridge({
        port: 0,
        host: '0.0.0.0',
        voicePort: 1,
        tls: { key: Buffer.alloc(0), cert: Buffer.alloc(0) },
        log: () => {},
      }),
      /拒绝监听.*缺 token/s,
    );
  });
});

test('非本机配有 TLS 但 MIAI_TOKENS 指向空文件：fail-closed 拒绝启动', async () => {
  const dir = tempDir();
  const emptyTokens = join(dir, 'tokens.txt');
  writeFileSync(emptyTokens, '# empty\n', 'utf8');
  await withTokensEnv(emptyTokens, async () => {
    await assert.rejects(
      () => startWebBridge({
        port: 0,
        host: '0.0.0.0',
        voicePort: 1,
        tls: { key: Buffer.alloc(0), cert: Buffer.alloc(0) },
        log: () => {},
      }),
      /没有任何可用的 token/,
    );
  });
});

test('非本机配有合法 MIAI_TOKENS 但缺 TLS：真实探测到 token，只报缺 tls', async () => {
  const dir = tempDir();
  const validTokens = join(dir, 'tokens.txt');
  writeFileSync(validTokens, `${generateToken()}:browser-1\n`, 'utf8');
  await withTokensEnv(validTokens, async () => {
    await assert.rejects(
      () => startWebBridge({
        port: 0,
        host: '0.0.0.0',
        voicePort: 1,
        log: () => {},
      }),
      /拒绝监听.*缺 tls/s,
    );
  });
});
