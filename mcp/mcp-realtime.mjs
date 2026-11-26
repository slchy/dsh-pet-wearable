#!/usr/bin/env node
/**
 * MCP server：把「现在几点」「天气」「股价」暴露成 dsh 的工具。
 *
 * 为什么单独做这一个 server，而不是让主对话用 bash + curl：
 * 主对话已经不挂 bash 了（命令、文件、编排全部下发子代理），而这三件事是
 * **开口就要答案**的——派子代理去查等于让用户多等几秒。它们是回答本身，
 * 不是「能力」。所以做成毫秒级的专用工具，schema 也比 bash 那 2280 字符小得多。
 *
 * 为什么自己解析而不是把上游原文丢给模型：
 * 上游返回的是 JSON / GBK 行情串，模型要再花一轮把它转成口语，还可能念出
 * 花括号。这里直接给一句能念的中文，模型照念即可。
 *
 * 协议：MCP stdio = 每行一条 JSON-RPC 2.0（stdout 只能出协议帧）。
 */
import process from 'node:process';

const WEATHER_BASE = process.env.REALTIME_WEATHER_URL ?? 'https://wttr.in';
const MARKET_BASE = process.env.REALTIME_MARKET_URL ?? 'https://qt.gtimg.cn';
const TZ = process.env.REALTIME_TZ ?? 'Asia/Shanghai';
/** 可选：钉死一个默认城市。**默认不设** —— 城市应该来自哥说的话，猜出来的会是机房所在地。 */
const CITY = process.env.REALTIME_CITY ?? '';
const TIMEOUT_MS = 6000;

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: 'get_time',
    description:
      '现在几点、今天几号、今天星期几。毫秒级返回，问时间一律用它，不要推算。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'get_weather',
    description:
      '查天气：现在多少度、今天最高最低、要不要带伞。'
      + '用户问「今天天气怎么样」「外面冷不冷」「要带伞吗」时调用。'
      + 'city 填哥说过的城市；他没说过又没听出是哪儿，就先问一句，别猜。',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，例如「杭州」。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_market',
    description:
      '查股票或指数的**实时**价格和涨跌幅。symbol 用行情代码：'
      + '港股 hk01810、沪市 sh600519、深市 sz000001、上证指数 sh000001。'
      + '用户问股价、涨了多少、今天涨没涨时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '行情代码，例如 hk01810' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
];

/** 带超时的 fetch：上游挂住时不能把主对话一起拖住。 */
async function getText(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 腾讯行情是 GBK；Node 没有内置 gbk 时退化成 utf8，名字可能是乱码但数字仍然对。 */
function decodeGbk(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function timeText() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('weekday')} `
    + `${pick('hour')}:${pick('minute')}（东八区）`;
}

function numberOr(text) {
  const value = Number.parseFloat(String(text ?? ''));
  return Number.isFinite(value) ? value : undefined;
}

function weatherText(json) {
  const current = json?.current_condition?.[0];
  if (!current) throw new Error('上游没有返回当前天气');
  const today = json?.weather?.[0];
  const area = json?.nearest_area?.[0]?.areaName?.[0]?.value ?? '';
  const desc = current.lang_zh?.[0]?.value ?? current.weatherDesc?.[0]?.value ?? '';
  const temp = numberOr(current.temp_C);
  const high = numberOr(today?.maxtempC);
  const low = numberOr(today?.mintempC);

  const bits = [];
  bits.push(`现在 ${temp ?? '?'} 度`);
  if (desc) bits.push(desc);
  if (high !== undefined && low !== undefined) bits.push(`今天 ${low}~${high} 度`);
  const rain = today?.hourly?.some((hour) => Number.parseFloat(hour.chanceofrain ?? '0') >= 50);
  if (rain) bits.push('有较大概率下雨，带把伞');
  const humidity = numberOr(current.humidity);
  if (humidity !== undefined && humidity >= 85) bits.push(`湿度 ${humidity}%`);

  return `${area ? `${area}：` : ''}${bits.join('，')}。`;
}

/** `v_hk01810="100~小米集团-W~01810~19.520~19.400~...";` → 一句话。 */
function marketText(raw, symbol) {
  const match = /="([^"]*)"/.exec(raw);
  if (!match) throw new Error('上游没有返回行情');
  const fields = match[1].split('~');
  const name = fields[1] || symbol;
  const code = fields[2] || symbol;
  const price = numberOr(fields[3]);
  const prevClose = numberOr(fields[4]);
  if (price === undefined) throw new Error('行情里没有价格');
  const currency = symbol.startsWith('hk') ? '港元' : '元';

  const change = prevClose !== undefined ? price - prevClose : undefined;
  const pct = prevClose ? ((price - prevClose) / prevClose) * 100 : undefined;
  const direction = change === undefined || Math.abs(change) < 1e-9
    ? '平盘'
    : change > 0
      ? `涨 ${change.toFixed(2)}，+${pct?.toFixed(2)}%`
      : `跌 ${Math.abs(change).toFixed(2)}，${pct?.toFixed(2)}%`;

  return `${name}（${code}）：${price.toFixed(2)} ${currency}，${direction}。`;
}

async function callTime() {
  return timeText();
}

async function callWeather(args) {
  const rawCity = args?.city;
  if (rawCity !== undefined && rawCity !== null && typeof rawCity !== 'string') {
    throw new Error('city 必须是字符串');
  }
  const city = String(rawCity ?? CITY).trim();
  // 不猜城市：按服务器 IP 猜出来的是机房所在地，念给哥听是**确定性的错**。
  // 没城市就把话递回去让模型问一句，比答错一个城市的天气强。
  if (!city) return '还不知道哥在哪个城市 —— 先问一句他在哪个城市，拿到城市再查。';
  const url = `${WEATHER_BASE}/${encodeURIComponent(city)}?format=j1&lang=zh`;
  const text = (await getText(url)).toString('utf8');
  return weatherText(JSON.parse(text));
}

async function callMarket(args) {
  const rawSymbol = args?.symbol;
  if (rawSymbol !== undefined && rawSymbol !== null && typeof rawSymbol !== 'string') {
    throw new Error('symbol 必须是字符串');
  }
  const symbol = String(rawSymbol ?? '').trim().toLowerCase();
  if (!symbol) throw new Error('缺少 symbol');
  const text = decodeGbk(await getText(`${MARKET_BASE}/q=${encodeURIComponent(symbol)}`));
  return marketText(text, symbol);
}

const HANDLERS = {
  get_time: callTime,
  get_weather: callWeather,
  get_market: callMarket,
};

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

async function callTool(id, name, args) {
  const handler = HANDLERS[name];
  if (!handler) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true },
    });
    return;
  }
  try {
    const text = await handler(args);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `查不到：${e.message}。直接跟哥说没查到，别猜。` }],
        isError: true,
      },
    });
  }
}

function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'miai-realtime', version: '1.0.0' },
        },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call':
      void callTool(id, params?.name, params?.arguments);
      return;
    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } });
      }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // 畸形行直接丢，别让整个工具进程退出
    }
  }
});
