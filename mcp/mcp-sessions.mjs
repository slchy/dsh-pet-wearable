#!/usr/bin/env node
/**
 * MCP server：把「以前说过什么」暴露成工具 `mcp__sessions__search_sessions`。
 *
 * 为什么自己扫文件而不是用 dsh 的 `sessionQuery`：那个是**服务**不是工具，模型
 * 够不到；而会话日志本身就是多帧 zstd 的 JSONL，读起来没有任何门槛。
 * 自己扫还有一个好处 —— 输出怎么截断完全由我们定，不会一次把几万字拖进上下文。
 *
 * 扫的范围：`~/.dsh/sessions/**` 下最近的若干份会话，**按时间倒序**返回。
 * 「上次说的那个」这种问法要的几乎总是最近的那条，所以先给最新的。
 *
 * 硬约束：
 * - 只取 `user/message` 和带正文的 `assistant/message`，工具结果一概不看
 *   （里面几万字，搜出来也没法念）；
 * - 每次最多 10 条、每条 90 字，避免把上下文塞满；
 * - 文件按大小设上限，遇到超大日志直接跳过而不是把内存吃光。
 *
 * 协议：MCP stdio = 每行一条 JSON-RPC 2.0（stdout 只能出协议帧）。
 */
import process from 'node:process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';

const ROOT = process.env.SESSION_SEARCH_ROOT ?? join(homedir(), '.dsh', 'sessions');
const MAX_FILES = Number(process.env.SESSION_SEARCH_FILES ?? 40);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXCERPT = 90;
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

const TOOL = {
  name: 'search_sessions',
  description:
    '在**过去的对话**里搜一句话。用户问「上次说的那个」「我之前跟你讲过」「你记得我说过什么吗」'
    + '这类问题时调用。'
    + 'query 用几个关键词就够（会自动找同时包含这些词的句子），别写成整句话。'
    + '只搜得到聊天内容，搜不到天气、股价这种实时信息。'
    + '搜不到就直说没找到，**不要根据印象编**。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，空格分隔，例如「眼镜 电量」' },
      limit: { type: 'number', description: '最多几条，默认 5，上限 10' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

/** 多帧 zstd：按 magic 逐帧解，只解第一帧会漏掉后面所有内容。 */
function decompressAllFrames(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const next = buf.indexOf(ZSTD_MAGIC, at + 1);
    const end = next === -1 ? buf.length : next;
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(at, end)));
    } catch {
      // 坏帧跳过，别让整次搜索失败
    }
    at = end;
  }
  return Buffer.concat(out);
}

function findSessionFiles(dir, depth = 0, acc = []) {
  if (depth > 3) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findSessionFiles(full, depth + 1, acc);
    else if (entry.name === 'session.v4.jsonl.zstd') acc.push(full);
  }
  return acc;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把命中的词周围截出来，前后各留一点上下文。 */
function excerpt(text, terms) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT) return flat;
  const at = Math.max(0, flat.toLowerCase().indexOf(terms[0]));
  const start = Math.max(0, Math.min(at - Math.floor(EXCERPT / 3), flat.length - EXCERPT));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + EXCERPT)}${start + EXCERPT < flat.length ? '…' : ''}`;
}

function search(rawQuery, rawLimit) {
  const terms = String(rawQuery ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new Error('query 是空的');
  const limit = Math.max(1, Math.min(10, Number(rawLimit) || 5));

  const files = findSessionFiles(ROOT)
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs, size: statSync(path).size };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null && entry.size <= MAX_FILE_BYTES)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES);

  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = decompressAllFrames(readFileSync(file.path)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== 'user/message' && record.type !== 'assistant/message') continue;
      const body = textOf(record.data?.message);
      if (body === '') continue;
      const lower = body.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      hits.push({
        time: typeof record.time === 'number' ? record.time : 0,
        who: record.type === 'user/message' ? '你说' : '我说',
        text: excerpt(body, terms),
      });
      if (hits.length > 400) break;
    }
    if (hits.length > 400) break;
  }

  if (hits.length === 0) return `没搜到包含「${terms.join(' ')}」的对话。直说没找到，别猜。`;

  hits.sort((a, b) => b.time - a.time);
  const shown = hits.slice(0, limit);
  const lines = shown.map((hit) => `${stamp(hit.time)} ${hit.who}：${hit.text}`);
  return `${hits.length} 条命中，最近 ${shown.length} 条：\n${lines.join('\n')}`;
}

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

function callTool(id, name, args) {
  if (name !== TOOL.name) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true },
    });
    return;
  }
  try {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: search(args?.query, args?.limit) }] } });
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `搜不了：${e.message}` }], isError: true },
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
          serverInfo: { name: 'miai-sessions', version: '1.0.0' },
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
      send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
      return;
    case 'tools/call':
      callTool(id, params?.name, params?.arguments);
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
      // 畸形行直接丢
    }
  }
});
