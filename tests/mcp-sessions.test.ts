/**
 * 历史检索的边界。
 *
 * 这个工具的输出**直接进上下文**，所以错的代价是双份的：搜不到就编（说胡话），
 * 或者一次拖回几万字（把一轮预算吃光）。钉四件事：
 *  1. 多帧 zstd 也能搜到（只解第一帧是很容易犯、且很安静的错）；
 *  2. 多个词是 AND，不是 OR；
 *  3. 工具结果里的字**不算**聊天内容，不该被搜出来；
 *  4. 搜索结果有时间、有谁说的、有截断。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT = fileURLToPath(new URL('../mcp/mcp-sessions.mjs', import.meta.url));

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

  stop(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function withServer<T>(root: string, fn: (server: Server) => Promise<T>): Promise<T> {
  const server = new Server({ SESSION_SEARCH_ROOT: root });
  return fn(server).finally(() => { server.stop(); });
}

const line = (type: string, time: number, text: string): string => JSON.stringify({
  type,
  time,
  data: { message: { role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }] } },
});

/** 写一份会话：`frames` 个 zstd 帧拼在一起，模拟 dsh 的多帧日志。 */
function writeSession(root: string, name: string, lines: string[], frames = 1): void {
  const dir = join(root, '--ws--', name);
  mkdirSync(dir, { recursive: true });
  const per = Math.ceil(lines.length / frames);
  const body = Buffer.concat(
    Array.from({ length: frames }, (_, i) => zlib.zstdCompressSync(Buffer.from(`${lines.slice(i * per, (i + 1) * per).join('\n')}\n`))),
  );
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), body);
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'miai-sessions-'));
}

test('只有一个检索工具', async () => {
  const root = tempRoot();
  try {
    writeSession(root, 'session-a', [line('user/message', 1_700_000_000_000, '眼镜电量还有多少')]);
    const tools = await withServer(root, (server) => server.tools());
    assert.deepEqual(tools.map((tool) => tool.name), ['search_sessions']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('搜得到，并且带时间和说话人', async () => {
  const root = tempRoot();
  try {
    writeSession(root, 'session-a', [
      line('user/message', 1_700_000_000_000, '我昨天说要给眼镜换个充电盒'),
      line('assistant/message', 1_700_000_060_000, '[平静]记下了。'),
    ]);
    const result = await withServer(root, (server) => server.call('search_sessions', { query: '充电盒' }));
    const text = result.content[0]?.text ?? '';
    assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 你说：.*充电盒/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('多帧 zstd 也要搜得到', async () => {
  const root = tempRoot();
  try {
    // 命中词放在第二帧里 —— 只解第一帧的实现会漏掉它，且不会报错
    writeSession(root, 'session-a', [
      line('user/message', 1_700_000_000_000, '早上好'),
      line('user/message', 1_700_000_060_000, '帮我记一下车牌是浙A12345'),
    ], 2);
    const result = await withServer(root, (server) => server.call('search_sessions', { query: '浙A12345' }));
    assert.ok((result.content[0]?.text ?? '').includes('浙A12345'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('多个词是 AND', async () => {
  const root = tempRoot();
  try {
    writeSession(root, 'session-a', [
      line('user/message', 1_700_000_000_000, '眼镜的充电盒是黑色的'),
      line('user/message', 1_700_000_060_000, '眼镜的镜片有点脏'),
    ]);
    const result = await withServer(root, (server) => server.call('search_sessions', { query: '眼镜 充电盒' }));
    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('黑色'));
    assert.ok(!text.includes('镜片'), '两个词都要命中，不是任一命中');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('工具结果里的字不算聊天内容', async () => {
  const root = tempRoot();
  try {
    writeSession(root, 'session-a', [
      JSON.stringify({ type: 'tool/result', time: 1_700_000_000_000, data: { message: { role: 'tool', content: [{ type: 'text', text: '浙A12345 是隐藏车位' }] } } }),
      line('user/message', 1_700_000_060_000, '今天天气不错'),
    ]);
    const result = await withServer(root, (server) => server.call('search_sessions', { query: '浙A12345' }));
    assert.ok((result.content[0]?.text ?? '').includes('没搜到'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('搜不到就明说没搜到', async () => {
  const root = tempRoot();
  try {
    writeSession(root, 'session-a', [line('user/message', 1_700_000_000_000, '早上好')]);
    const result = await withServer(root, (server) => server.call('search_sessions', { query: '量子纠缠' }));
    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('没搜到'));
    assert.ok(text.includes('别猜'), '要明确禁止根据印象编造');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('limit 生效且最新的在前', async () => {
  const root = tempRoot();
  try {
    const lines = Array.from({ length: 8 }, (_, i) =>
      line('user/message', 1_700_000_000_000 + i * 60_000, `第 ${i} 次提到充电盒`));
    writeSession(root, 'session-a', lines);
    const result = await withServer(root, (server) => server.call('search_sessions', { query: '充电盒', limit: 3 }));
    const shown = (result.content[0]?.text ?? '').split('\n').filter((row) => row.includes('充电盒'));
    assert.equal(shown.length, 3, '只回 limit 条');
    assert.ok(shown[0]?.includes('第 7 次'), '最新的在前');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
