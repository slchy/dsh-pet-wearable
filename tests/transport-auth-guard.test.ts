/**
 * 鉴权前的两道闸：**不许 ping 保活**、**不许声明大帧**。
 *
 * 这两条以前都是开的：
 * - `Ping` 分支在 `if (!this.authed)` 之前就回 `Pong`，而 `onData` 里任何字节都刷新
 *   `lastRxAt` —— 未鉴权的对端每 5 s 发个空 Ping 就能永久占一条连接。
 * - `FrameDecoder` 对所有连接都用 32 MB 上限，未鉴权的对端可以先声明 32 MB 再把
 *   内存慢慢灌满（`push()` 每块都 `Buffer.concat`，灌满是 O(n²) 拷贝）。
 *
 * 第三条是反向断言：闸不能误伤已鉴权的正常流量。
 */
import assert from 'node:assert/strict';
import { connect, createServer, type Socket } from 'node:net';
import { test } from 'node:test';

import { runTransport, type HelloInfo } from '../src/transport.ts';

const HEADER = 5;
const T_AUDIO = 1;
const T_PING = 4;
const T_HELLO = 6;

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

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER);
  header[0] = type;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function hello(token: string): Buffer {
  return frame(T_HELLO, Buffer.from(JSON.stringify({ deviceId: 'probe', token })));
}

/** 起一个需要鉴权的监听，返回端口 + 日志数组。 */
async function listen(): Promise<{ port: number; logs: string[] }> {
  const port = await freePort();
  const logs: string[] = [];
  void runTransport({
    port,
    host: '127.0.0.1',
    authenticate: (info: HelloInfo) => info.token === 'good',
    idleTimeoutMs: 30_000,
    log: (line) => { logs.push(line); },
    onConnection: () => {},
  });
  // 等监听真的起来（`runTransport` 是 async 但不等 listen 回调）
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  return { port, logs };
}

function open(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const client = connect(port, '127.0.0.1', () => { resolve(client); });
    client.on('error', reject);
    // 真实客户端一直在读 socket。paused 模式下 Node 不处理 FIN，
    // 'end' / 'close' 都不会来 —— 这里 resume 是在模拟"对端有在读"。
    client.resume();
  });
}

/** 等这条 socket 被对端关掉。 */
function closed(client: Socket, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('对端没有关闭连接')); }, timeoutMs);
    client.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('未鉴权发 Ping：直接断开，不留保活通道', async () => {
  const { port, logs } = await listen();
  const client = await open(port);
  const chunks: Buffer[] = [];
  client.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  const gone = closed(client);

  client.write(frame(T_PING, Buffer.alloc(0)));
  await gone;

  assert.match(logs.join('\n'), /未收到 Hello 就发帧（type=4）/);
  // 断开前要告诉对端原因，不是无声挂断
  const reply = Buffer.concat(chunks);
  assert.equal(reply[0], 2, '下行 Control 帧类型是 2');
  assert.equal(reply.subarray(HEADER).toString(), 'auth_required');
});

test('未鉴权声明 8 MB 帧：按 64 KB 上限拒收，并直接断开', async () => {
  const { port, logs } = await listen();
  const client = await open(port);
  const chunks: Buffer[] = [];
  client.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  const gone = closed(client);

  // 只发 header：声明 8 MB 正文，但一个字节正文都不给
  const header = Buffer.alloc(HEADER);
  header[0] = T_AUDIO;
  header.writeUInt32LE(8 << 20, 1);
  client.write(header);

  await gone;

  assert.match(logs.join('\n'), /帧长异常 8388608（上限 65536）/);
  // 帧长异常之后字节流已经失去边界（缓冲整块丢掉了），接着读只会把半截载荷当帧头。
  // 所以必须断开 —— 留着这条连接，对方只要每隔几秒发一个字节就能一直占着。
  const reply = Buffer.concat(chunks);
  assert.equal(reply[0], 2, '下行 Control 帧类型是 2');
  assert.equal(reply.subarray(HEADER).toString(), 'frame_too_large');
});

test('闸不误伤：鉴权后 200 KB 帧照常收下', async () => {
  const { port, logs } = await listen();
  const client = await open(port);

  client.write(hello('good'));
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  // 200 KB > 鉴权前的 64 KB，但 < 鉴权后的 32 MB
  client.write(frame(T_AUDIO, Buffer.alloc(200 * 1024)));
  await new Promise((resolve) => { setTimeout(resolve, 300); });

  assert.doesNotMatch(logs.join('\n'), /帧长异常/, '鉴权后不该再受 64 KB 限制');
  client.destroy();
});

test('闸不误伤：鉴权后的 Ping 照常回 Pong', async () => {
  const { port, logs } = await listen();
  const client = await open(port);

  client.write(hello('good'));
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  let pong: Buffer | null = null;
  client.on('data', (chunk: Buffer) => { pong = chunk; });

  client.write(frame(T_PING, Buffer.alloc(0)));
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  assert.ok(pong !== null, '已鉴权的 Ping 应当有回应');
  assert.equal((pong as Buffer)[0], 5, 'Pong 的帧类型是 5');
  assert.doesNotMatch(logs.join('\n'), /未收到 Hello 就发帧/);
  client.destroy();
});
