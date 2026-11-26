/**
 * 记忆写入工具的边界。
 *
 * 这个工具会**改文件**，而且改的是每次请求都要进系统提示词的那份 —— 所以错的
 * 代价不是"多存了一条"，而是"下一轮缓存全凉"或者"记忆被流水账挤掉"。钉三类：
 *  1. 重复的东西不再写第二遍；
 *  2. 超过上限时丢最旧的、留最新的；
 *  3. 空内容要拒绝，别往文件里写一条空弹。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../mcp/mcp-memory.mjs', import.meta.url));

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

class Server {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly pending = new Map<number, (value: unknown) => void>();
  private nextId = 1;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value as Record<string, unknown>); });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return await answer;
  }

  async tools(): Promise<Array<{ name: string; description: string }>> {
    await this.request('initialize', { protocolVersion: '2025-06-18' });
    const result = await this.request('tools/list');
    return (result['result'] as { tools: Array<{ name: string; description: string }> }).tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    await this.request('initialize', { protocolVersion: '2025-06-18' });
    const result = await this.request('tools/call', { name, arguments: args });
    return result['result'] as CallResult;
  }

  /** 直接写一行原始帧（测非对象 JSON 不打崩进程） */
  raw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  stop(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function withServer<T>(env: Record<string, string>, fn: (server: Server) => Promise<T>): Promise<T> {
  const server = new Server(env);
  return fn(server).finally(() => { server.stop(); });
}

function tempMemory(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'miai-mem-'));
  const file = join(dir, 'MEMORY.md');
  return { dir, file, env: { MEMORY_FILE: file, ...extra } };
}

test('只有一个写入口，且描述里写清了什么不该记', async () => {
  const ctx = tempMemory();
  try {
    const tools = await withServer(ctx.env, (server) => server.tools());
    assert.deepEqual(tools.map((tool) => tool.name), ['remember']);
    const text = tools[0]?.description ?? '';
    assert.ok(text.includes('不要记'), '必须明确写「不要记什么」，否则会记成流水账');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('记一条就写一行', async () => {
  const ctx = tempMemory();
  try {
    const result = await withServer(ctx.env, (server) => server.call('remember', { text: '哥住在杭州' }));
    assert.equal(result.isError, undefined);
    const body = readFileSync(ctx.file, 'utf8');
    assert.ok(body.includes('哥住在杭州'));
    assert.match(body, /- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 哥住在杭州/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('同样的内容不会写第二遍', async () => {
  const ctx = tempMemory();
  try {
    await withServer(ctx.env, async (server) => {
      await server.call('remember', { text: '哥不喜欢吃香菜' });
      const again = await server.call('remember', { text: '哥不喜欢吃香菜' });
      assert.ok((again.content[0]?.text ?? '').includes('已经记过'));
    });
    const body = readFileSync(ctx.file, 'utf8');
    assert.equal(body.split('哥不喜欢吃香菜').length - 1, 1);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('超过上限时丢最旧的、留最新的', async () => {
  const ctx = tempMemory({ MEMORY_MAX_BYTES: '260' });
  try {
    await withServer(ctx.env, async (server) => {
      for (let i = 0; i < 12; i += 1) {
        await server.call('remember', { text: `第 ${i} 条长期记忆内容` });
      }
    });
    const body = readFileSync(ctx.file, 'utf8');
    assert.ok(Buffer.byteLength(body, 'utf8') <= 260 + 60, `文件超了：${Buffer.byteLength(body, 'utf8')} B`);
    assert.ok(body.includes('第 11 条'), '最新的必须在');
    assert.ok(!body.includes('第 0 条'), '最旧的该被丢掉');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('空内容不写', async () => {
  const ctx = tempMemory();
  try {
    const result = await withServer(ctx.env, (server) => server.call('remember', { text: '   ' }));
    assert.equal(result.isError, true);
    assert.equal(existsSync(ctx.file), false, '没内容就别建空文件');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('非对象 JSON 帧不会打崩进程', async () => {
  const ctx = tempMemory();
  try {
    await withServer(ctx.env, async (server) => {
      server.raw('123');
      server.raw('"hello"');
      server.raw('[1,2]');
      const pong = await server.request('ping');
      assert.deepEqual(pong['result'], {}, '坏帧之后进程仍要活着');
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('remember 的非字符串内容明确报错，不静默写成 [object Object]', async () => {
  const ctx = tempMemory();
  try {
    const result = await withServer(
      ctx.env,
      (server) => server.call('remember', { text: { bad: 1 } }),
    );
    assert.equal(result.isError, true);
    assert.ok((result.content[0]?.text ?? '').includes('字符串'));
    assert.equal(existsSync(ctx.file), false, '非法入参不该建文件');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
