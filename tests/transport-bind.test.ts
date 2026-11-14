/**
 * 闸真的在 bind 之前 —— 不是「绑上了再打一行提示」。
 *
 * 断言方式是**看端口有没有被占**：拒绝的路径必须一根 socket 都不开。
 * 最后一条是反向断言：闸不能误伤本机联调。
 */
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';

import { runTransport, type TransportOptions } from '../src/transport.ts';

/** 挑一个当前没人用的端口，然后放掉。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

/** 这个端口现在能不能绑上 —— 能绑说明上一轮确实没监听。 */
async function isFree(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.on('error', () => { resolve(false); });
    probe.listen(port, host, () => { probe.close(() => { resolve(true); }); });
  });
}

function collect(): { logs: string[]; log: TransportOptions['log'] } {
  const logs: string[] = [];
  return { logs, log: (line) => { logs.push(line); } };
}

test('非本机地址 + 无 token + 无 TLS：拒绝，且不占用端口', async () => {
  const port = await freePort();
  const { logs, log } = collect();
  const code = await runTransport({
    port,
    host: '0.0.0.0',
    log,
    onConnection: () => { assert.fail('不该有连接进来'); },
  });

  assert.equal(code, 2, '应当以退出码 2 拒绝');
  assert.match(logs.join('\n'), /拒绝监听/);
  assert.match(logs.join('\n'), /token/);
  assert.match(logs.join('\n'), /TLS/);
  assert.equal(await isFree(port, '0.0.0.0'), true, '端口不该被占：说明根本没 bind');
});

test('非本机地址 + 只有 TLS：仍然拒绝（token 缺）', async () => {
  const port = await freePort();
  const { logs, log } = collect();
  const code = await runTransport({
    port,
    host: '0.0.0.0',
    tls: { key: Buffer.alloc(0), cert: Buffer.alloc(0) },
    log,
    onConnection: () => {},
  });
  assert.equal(code, 2);
  assert.match(logs.join('\n'), /缺 token/);
  assert.equal(await isFree(port, '0.0.0.0'), true);
});

test('非本机地址 + 只有 token：仍然拒绝（TLS 缺）', async () => {
  const port = await freePort();
  const { logs, log } = collect();
  const code = await runTransport({
    port,
    host: '0.0.0.0',
    authenticate: () => true,
    log,
    onConnection: () => {},
  });
  assert.equal(code, 2);
  assert.match(logs.join('\n'), /缺 tls/);
  assert.equal(await isFree(port, '0.0.0.0'), true);
});

test('闸不误伤：本机地址无 token 无 TLS 照常监听', async () => {
  const port = await freePort();
  const { logs, log } = collect();
  let accepted = 0;

  const done = runTransport({
    port,
    host: '127.0.0.1',
    log,
    // 单设备模式：连接结束就收监听、返回 0
    onConnection: (conn) => { accepted += 1; conn.end(); },
  });

  const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const client = connect(port, '127.0.0.1', () => { resolve(client); });
    client.on('error', reject);
  });

  const code = await done;
  socket.destroy();

  assert.equal(code, 0, '本机地址应当正常起监听并正常收尾');
  assert.equal(accepted, 1, '应当接受了一条连接');
  assert.match(logs.join('\n'), /监听 tcp:\/\/127\.0\.0\.1/);
  assert.match(logs.join('\n'), /不鉴权/);
});
