/**
 * `onListening`：多设备模式（`singleConnection: false`）下唯一的外部停机入口。
 *
 * 这两条断言对应两个真实的失效方式，都是**静默**的：
 * - `port: 0` 时没人知道绑到哪个口 → 外面的桥接不上，表现是「页面打不开」；
 * - 没有 `stop()` 时没有任何事件会结束 `runTransport` → 宿主卸载插件后监听还开着，
 *   进程里留一条 TCP 监听（以及它背后的控制口、侧车）。表现是「插件卸了还在占端口」。
 */
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';

import { runTransport } from '../src/transport.ts';

/** 这个端口现在能不能绑上 —— 能绑说明没人在听。 */
async function isFree(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.on('error', () => { resolve(false); });
    probe.listen(port, host, () => { probe.close(() => { resolve(true); }); });
  });
}

test('port 0：onListening 交出真实端口，且与日志里的那个一致', async () => {
  const logs: string[] = [];
  const listening = new Promise<{ port: number; stop: () => void }>((resolve) => {
    void runTransport({
      port: 0,
      host: '127.0.0.1',
      singleConnection: false,
      log: (line) => { logs.push(line); },
      onListening: resolve,
      onConnection: () => {},
    });
  });

  const info = await listening;
  try {
    assert.ok(info.port > 0, 'port: 0 之后必须回报真实端口');
    assert.match(logs.join('\n'), new RegExp(`127\\.0\\.0\\.1:${info.port}\\b`), '日志里的端口要和回报的一致');
    assert.equal(await isFree(info.port, '127.0.0.1'), false, '回报的端口应当真的在监听');

    // 报出来的端口要真能连上（不是「地址对象里的那个」就够了）
    const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      const client = connect(info.port, '127.0.0.1', () => { resolve(client); });
      client.on('error', reject);
    });
    socket.destroy();
  } finally {
    info.stop();
  }
});

test('多设备模式：stop() 关监听、断开活着的连接，并让 runTransport 返回 0', async () => {
  const opened: string[] = [];
  let info: { port: number; stop: () => void } | null = null;
  const done = new Promise<number>((resolve) => {
    void runTransport({
      port: 0,
      host: '127.0.0.1',
      // 关键：正是这个模式让「连接结束」不再能收尾
      singleConnection: false,
      log: () => {},
      onListening: (value) => { info = value; },
      onConnection: (conn) => { opened.push(conn.remote); },
    }).then(resolve);
  });

  const deadline = Date.now() + 5_000;
  while (info === null && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  assert.ok(info !== null, 'onListening 应当在 5 s 内回调');
  const listening = info as unknown as { port: number; stop: () => void };

  // 一条活着的连接：不 stop 的话它会一直占着
  const client = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect(listening.port, '127.0.0.1', () => { resolve(socket); });
    socket.on('error', reject);
  });
  const closed = new Promise<void>((resolve) => { client.once('close', () => { resolve(); }); });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(opened.length, 1, '连接应当被交给业务层');

  listening.stop();

  assert.equal(await done, 0, 'stop() 之后 runTransport 应当返回 0');
  await closed;
  assert.equal(await isFree(listening.port, '127.0.0.1'), true, '监听必须关掉，否则卸载插件会泄漏');
  client.destroy();
});
