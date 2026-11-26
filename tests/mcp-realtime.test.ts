/**
 * 实时信息工具（时间 / 天气 / 股价）的解析行为。
 *
 * 这三个工具替代的是原来主对话里 `bash + curl` 顺手干的活，所以它们错了不是
 * 「查得慢一点」而是**念错数**——语音里听不出小数点，18 度说成 81 度哥也会当真。
 * 上游给的是 wttr.in 的 j1 JSON 和腾讯行情的 GBK 串，这里按完整 JSON-RPC
 * 走一遍，钉住「解析 → 一句能念的中文」这段。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../mcp/mcp-realtime.mjs', import.meta.url));

const WEATHER_J1 = {
  current_condition: [{ temp_C: '18', humidity: '60', lang_zh: [{ value: '晴' }] }],
  nearest_area: [{ areaName: [{ value: 'Guiyang' }] }],
  weather: [{ maxtempC: '22', mintempC: '12', hourly: [{ chanceofrain: '10' }] }],
};
// 腾讯行情的形状：v_<code>="市场~名称~代码~现价~昨收~今开~...";
const MARKET_BODY = 'v_hk01810="100~XIAOMI~01810~400.000~390.000~395.000";';

interface Tool {
  name: string;
  description: string;
}

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** 假上游：/q= 走行情，其余走天气；`fail` 为 true 时一律 500。 */
async function withUpstream(
  fn: (urls: { weather: string; market: string }, seen: string[]) => Promise<void>,
  options: { fail?: boolean } = {},
): Promise<void> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    if (options.fail) {
      res.writeHead(500).end('boom');
      return;
    }
    if ((req.url ?? '').startsWith('/q=')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=gbk' }).end(MARKET_BODY);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(WEATHER_J1));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await fn({ weather: `http://127.0.0.1:${port}`, market: `http://127.0.0.1:${port}` }, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

class ServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly pending = new Map<number, (value: unknown) => void>();
  private nextId = 1;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
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
    return (result['result'] as { tools: Tool[] }).tools;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    await this.request('initialize', { protocolVersion: '2025-06-18' });
    const result = await this.request('tools/call', { name, arguments: args });
    return (result['result'] as CallResult);
  }

  stop(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function withServer<T>(
  env: Record<string, string>,
  fn: (server: ServerProcess) => Promise<T>,
): Promise<T> {
  const server = new ServerProcess({ REALTIME_TZ: 'Asia/Shanghai', ...env });
  try {
    return await fn(server);
  } finally {
    server.stop();
  }
}

test('三个工具都挂在这个 server 上', async () => {
  const tools = await withServer({}, async (server) => server.listTools());
  assert.deepEqual(tools.map((tool) => tool.name), ['get_time', 'get_weather', 'get_market']);
  const text = tools.map((tool) => tool.description).join('\n');
  for (const leak of ['j1', 'JSON', 'qt.gtimg', 'wttr']) {
    assert.ok(!text.includes(leak), `工具描述里不该出现上游细节「${leak}」`);
  }
});

test('get_time 给出来源时区的时间，不需要模型自己推算', async () => {
  const result = await withServer({}, async (server) => server.call('get_time'));
  const text = result.content[0]?.text ?? '';
  assert.match(text, /^\d{4}-\d{2}-\d{2} 星期. \d{2}:\d{2}（东八区）$/, `实际是「${text}」`);
  assert.equal(result.isError, undefined);
});

test('get_weather 把 j1 解析成能念的一句话', async () => {
  await withUpstream(async (urls) => {
    const result = await withServer(
      { REALTIME_WEATHER_URL: urls.weather, REALTIME_MARKET_URL: urls.market },
      async (server) => server.call('get_weather', { city: '杭州' }),
    );
    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('18 度'), `应当念出现场温度，实际「${text}」`);
    assert.ok(text.includes('晴'), `应当带上天气现象，实际「${text}」`);
    assert.ok(text.includes('12~22 度'), `应当带上今天的高低温，实际「${text}」`);
    assert.ok(!text.includes('{'), '不能把 JSON 原样丢给模型');
  });
});

test('带 city 时按城市查', async () => {
  await withUpstream(async (urls, seen) => {
    await withServer(
      { REALTIME_WEATHER_URL: urls.weather, REALTIME_MARKET_URL: urls.market },
      async (server) => server.call('get_weather', { city: '杭州' }),
    );
    assert.ok(
      seen.some((url) => url.includes(encodeURIComponent('杭州'))),
      `上游应当收到城市名，实际请求 ${seen.join(' ')}`,
    );
  });
});

test('不知道城市时先问一句，不要按服务器 IP 猜', async () => {
  // 按 IP 猜出来的是机房所在地。答错一个城市的天气，比多问一句糟得多。
  await withUpstream(async (urls, seen) => {
    const result = await withServer(
      { REALTIME_WEATHER_URL: urls.weather, REALTIME_MARKET_URL: urls.market },
      async (server) => server.call('get_weather'),
    );
    assert.equal(result.isError, undefined);
    assert.ok((result.content[0]?.text ?? '').includes('问一句'), '应当把话递回去让模型问城市');
    assert.deepEqual(seen, [], '不知道城市就不该去查上游');
  });
});

test('get_market 解析出价格和涨跌幅', async () => {
  await withUpstream(async (urls) => {
    const result = await withServer(
      { REALTIME_WEATHER_URL: urls.weather, REALTIME_MARKET_URL: urls.market },
      async (server) => server.call('get_market', { symbol: 'hk01810' }),
    );
    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('400.00'), `应当念出现价，实际「${text}」`);
    assert.ok(text.includes('港元'), '港股的单位要说港元');
    assert.ok(text.includes('涨 10.00'), `应当念出涨跌额，实际「${text}」`);
    assert.ok(text.includes('+2.56%'), `应当念出涨跌幅，实际「${text}」`);
  });
});

test('上游挂了就说没查到，不要编', async () => {
  await withUpstream(async (urls) => {
    const result = await withServer(
      { REALTIME_WEATHER_URL: urls.weather, REALTIME_MARKET_URL: urls.market },
      async (server) => server.call('get_market', { symbol: 'hk01810' }),
    );
    assert.equal(result.isError, true);
    assert.ok((result.content[0]?.text ?? '').includes('别猜'), '失败文本要明确禁止编造');
  }, { fail: true });
});

test('city / symbol 非字符串时明确报错，不拿 String() 静默转换', async () => {
  const badCity = await withServer({}, (server) => server.call('get_weather', { city: 123 }));
  assert.equal(badCity.isError, true);
  assert.ok((badCity.content[0]?.text ?? '').includes('city 必须是字符串'));

  const badSymbol = await withServer({}, (server) => server.call('get_market', { symbol: { x: 1 } }));
  assert.equal(badSymbol.isError, true);
  assert.ok((badSymbol.content[0]?.text ?? '').includes('symbol 必须是字符串'));
});
