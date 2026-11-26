#!/usr/bin/env node
/**
 * MCP server：把「记住这件事」暴露成工具 `mcp__memory__remember`。
 *
 * 记忆**不放在这里**，放在工作区的 `MEMORY.md` 里 —— dsh 的 `agent-instructions`
 * 每个请求都会把它当指令读进系统提示词。所以：
 *
 * - 读：不用工具，模型天然就能看到（零往返）；
 * - 写：只有这一个工具，追加一行。
 *
 * 为什么不用 `recall` 工具：语音链路里多一次工具调用就多一轮 LLM 往返（实测
 * +1.2 秒）。记忆是**每轮都可能用到**的东西，让它常驻前缀比按需查划算 —— 前缀
 * 有缓存，一次调用才是真的贵。
 *
 * 代价：改这个文件会让下一轮的前缀缓存失效一次（实测 prompt 一改就全凉，
 * 1–3 秒）。所以工具描述里明确要求「少记、只记长期有用的」。
 *
 * 文件上限 4 KB：超了从最旧的条目开始丢 —— 记忆条数没有上限的话，最后会变成
 * 一份每次请求都要重读的流水账。
 *
 * 协议：MCP stdio = 每行一条 JSON-RPC 2.0（stdout 只能出协议帧）。
 */
import process from 'node:process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const FILE = process.env.MEMORY_FILE ?? join(homedir(), 'voice-workspace', 'MEMORY.md');
const MAX_BYTES = Number(process.env.MEMORY_MAX_BYTES ?? 4096);
const HEADER = '# 长期记忆\n\n这一行之下每行一条，越新越靠下。\n';

const TOOL = {
  name: 'remember',
  description:
    '记一条**长期**用得上的事，写进长期记忆文件。'
    + '只记这些：哥的称呼与身份、稳定的偏好和习惯（喝什么、几点睡）、'
    + '长期有效的事实（住哪个城市、家里有谁、在做什么项目）、'
    + '他明确说「记住」的事。'
    + '**不要记**：寒暄、这一轮聊了什么、天气预报这种会过期的信息、'
    + '你自己猜的东西。'
    + '一次只记一条，写成一句陈述句，例如「哥住在杭州」。'
    + '记完不用重复给哥听，他不需要知道你在写笔记。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '一句话，陈述句，例如「哥住在杭州」' },
    },
    required: ['text'],
    additionalProperties: false,
  },
};

function readMemory() {
  if (!existsSync(FILE)) return HEADER;
  return readFileSync(FILE, 'utf8');
}

/** 只留最旧的以外全部丢掉，直到回到上限之内。 */
function trim(content) {
  if (Buffer.byteLength(content, 'utf8') <= MAX_BYTES) return content;
  const lines = content.split('\n');
  const head = lines.slice(0, 3);
  const entries = lines.slice(3).filter((line) => line.trim() !== '');
  while (entries.length > 0 && Buffer.byteLength([...head, ...entries].join('\n'), 'utf8') > MAX_BYTES) {
    entries.shift();
  }
  return [...head, ...entries].join('\n');
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function remember(rawText) {
  if (rawText !== undefined && rawText !== null && typeof rawText !== 'string') {
    throw new Error('要记的内容必须是字符串');
  }
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') throw new Error('要记的内容是空的');

  const content = readMemory();
  if (content.includes(text)) return `已经记过了：${text}`;

  mkdirSync(dirname(FILE), { recursive: true });
  const base = content.endsWith('\n') ? content : `${content}\n`;
  const next = trim(`${base}- ${stamp()} · ${text}\n`);
  writeFileSync(FILE, next, 'utf8');
  return `记下了：${text}`;
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
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: remember(args?.text) }] } });
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `没记下来：${e.message}` }], isError: true },
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
          serverInfo: { name: 'miai-memory', version: '1.0.0' },
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
      // 畸形行直接丢，别让整个工具进程退出
    }
  }
});
