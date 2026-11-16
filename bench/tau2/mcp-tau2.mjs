#!/usr/bin/env node
/**
 * MCP server：把 tau2 那个域的**全部工具**挂进 dsh，工具名是 `mcp__tau2__<tool>`。
 *
 * 为什么不是在这里实现工具：判分看的是 tau2 `Environment` 里的数据库状态，工具必须
 * 在持有那个 Environment 的 bench 进程里执行。这里只做转发 —— 工具表从 bench 取，
 * 调用 POST 回 bench，结果原样交给模型。
 *
 * 协议：MCP stdio = 每行一条 JSON-RPC 2.0（与 mcp-session.mjs 一致）。
 * 地址：环境变量 `TAU2_BRIDGE_URL`，默认 `http://127.0.0.1:8799`。
 */
import process from 'node:process';

const BASE = (process.env.TAU2_BRIDGE_URL ?? 'http://127.0.0.1:8799').replace(/\/+$/, '');

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

let cachedTools = null;

async function fetchTools() {
  if (cachedTools !== null) return cachedTools;
  const res = await fetch(`${BASE}/tools`);
  if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  cachedTools = (body.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  return cachedTools;
}

async function callTool(id, name, args) {
  try {
    const res = await fetch(`${BASE}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args ?? {} }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: String(body.content ?? '') }],
        ...(body.isError ? { isError: true } : {}),
      },
    });
  } catch (e) {
    // 工具失败要让模型知道（它会改用别的办法或如实告知顾客），所以回 isError 而不是空结果
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `工具调用失败：${e.message}` }], isError: true },
    });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'tau2-bridge', version: '1.0.0' },
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
      try {
        const tools = await fetchTools();
        process.stderr.write(`tau2-bridge: tools/list → ${tools.length} 个\n`);
        send({ jsonrpc: '2.0', id, result: { tools } });
      } catch (e) {
        process.stderr.write(`tau2-bridge: 取工具表失败：${e.message}\n`);
        send({ jsonrpc: '2.0', id, result: { tools: [] } });
      }
      return;
    case 'tools/call':
      await callTool(id, params?.name, params?.arguments);
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
      void handle(JSON.parse(line));
    } catch {
      // 畸形行直接丢，别让工具进程退出
    }
  }
});
