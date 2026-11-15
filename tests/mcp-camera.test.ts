/**
 * MCP 拍照工具的**能力驱动**行为。
 *
 * 这些断言防的是同一类问题：设备实现细节又漏回 agent 语义层。
 * 工具描述是**给模型看的**——里面出现 SPP、P2P、576×432、3072、「必须按快门」
 * 这类字样，模型就有可能对着用户说「走 P2P 传过来」，或者去调一个当前设备
 * 根本没有的工具。
 *
 * 做法是真的 spawn 一个 MCP server、配一个假的能力口，走完整的 JSON-RPC：
 * 只有这样才能同时验证「协议实现」和「工具表是按能力现算的」。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../mcp/mcp-camera.mjs', import.meta.url));

interface Tool {
  name: string;
  description: string;
}

/** 起一个假的能力口；`caps` 为 null 时模拟「设备没连上」（503）。 */
async function withCaps(caps: unknown, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url !== '/capabilities') {
      res.writeHead(404).end();
      return;
    }
    if (caps === null) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"no-device"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(caps));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}/capabilities`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** 一个最小 JSON-RPC 客户端：按行收发。 */
class ServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly pending = new Map<number, (value: unknown) => void>();
  private nextId = 1;

  constructor(capsUrl: string) {
    this.child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, PHOTO_CAPS_URL: capsUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf('\n');
        if (line === '') continue;
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === 'number') {
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
      }
    });
  }

  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${method} 超时`)); }, 5000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value as Record<string, unknown>);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return await answer;
  }

  async listTools(): Promise<Tool[]> {
    await this.request('initialize', { protocolVersion: '2025-06-18' });
    const result = await this.request('tools/list');
    const payload = result['result'] as { tools: Tool[] };
    return payload.tools;
  }

  stop(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function toolsFor(caps: unknown): Promise<Tool[]> {
  let tools: Tool[] = [];
  await withCaps(caps, async (url) => {
    const server = new ServerProcess(url);
    try {
      tools = await server.listTools();
    } finally {
      server.stop();
    }
  });
  return tools;
}

const GLANCE_ONLY = { capture: { glance: { needsUser: false } } };
const WITH_DETAIL_USER = {
  capture: { glance: { needsUser: false }, detail: { needsUser: true } },
};
const WITH_DETAIL_FREE = {
  capture: { glance: { needsUser: false }, detail: { needsUser: false } },
};

test('只报 glance 的设备只有拍照工具，且不提高清', async () => {
  const tools = await toolsFor(GLANCE_ONLY);
  assert.deepEqual(tools.map((tool) => tool.name), ['take_photo']);
  assert.ok(
    !tools[0]?.description.includes('take_photo_hq'),
    '没有高清能力却叫模型去调 take_photo_hq，它只会调到空',
  );
});

test('报了 detail 才出现高清工具', async () => {
  const tools = await toolsFor(WITH_DETAIL_USER);
  assert.deepEqual(tools.map((tool) => tool.name), ['take_photo', 'take_photo_hq']);
  assert.ok(tools[0]?.description.includes('take_photo_hq'), '有高清能力时要引导换工具');
});

test('needsUser 决定会不会提示「要用户动手」', async () => {
  const needsUser = await toolsFor(WITH_DETAIL_USER);
  const free = await toolsFor(WITH_DETAIL_FREE);
  const hqOf = (tools: Tool[]): string =>
    tools.find((tool) => tool.name === 'take_photo_hq')?.description ?? '';

  assert.ok(hqOf(needsUser).includes('亲手配合'), '要用户按快门的设备必须先提示');
  assert.ok(
    !hqOf(free).includes('亲手配合'),
    '不需要用户动手的设备不该让模型去催用户',
  );
});

test('设备没连上时没有任何拍照工具', async () => {
  const tools = await toolsFor(null);
  assert.deepEqual(tools, [], '没有设备就不该给模型拍照工具，否则它会对空气调用');
});

test('工具描述不泄露任何设备实现细节', async () => {
  const tools = await toolsFor(WITH_DETAIL_USER);
  const text = tools.map((tool) => `${tool.name} ${tool.description}`).join('\n');
  for (const leak of ['SPP', 'P2P', '576', '432', '3072', 'MB', 'KB']) {
    assert.ok(!text.includes(leak), `工具描述里不该出现实现细节「${leak}」`);
  }
});
