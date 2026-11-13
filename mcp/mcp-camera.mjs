#!/usr/bin/env node
/**
 * MCP server：把「让眼镜拍一张照片」暴露成 dsh 的工具 `mcp__camera__take_photo`。
 *
 * 为什么走 MCP：拍照必须由 dsh 的语义判断来驱动（"这是什么" → 看图），
 * 而不是用户手动按快门。dsh 自带 `dsh-mcp-client`，这里只需要提供一个标准
 * stdio MCP 服务，工具就会出现在模型的工具表里。
 *
 * 真正的硬件动作在 harness 里：本进程 POST 一下本机控制口，harness 会
 * 通过那条常驻 TCP 向手机下发拍照指令、等设备回图，再把 JPEG 原样返回。
 *
 * 协议：MCP stdio = 每行一条 JSON-RPC 2.0。
 */
import process from 'node:process';

const CTL = process.env.PHOTO_CTL_URL ?? 'http://127.0.0.1:8767/take_photo';
const CTL_HQ = process.env.PHOTO_CTL_HQ_URL ?? 'http://127.0.0.1:8767/take_photo_hq';

/**
 * 两个拍照工具，区别只有画质：
 *
 * - `take_photo`    走 SPP，576×432、约 25 KB，**1 秒内**回来 —— 看场景够用
 * - `take_photo_hq` 走 P2P 拉原图、手机侧缩到长边 2048 再传，约 500–800 KB，
 *                   需要 3–8 秒 —— 只在**需要看清细节**时用
 *
 * 让模型自己选，而不是每次都上高清：绝大部分问题低清就够，高清慢且费流量。
 */
const TOOL = {
  name: 'take_photo',
  description:
    '用用户佩戴的智能眼镜拍一张照片，返回图像本身（576×432，约 1 秒）。'
    + '当用户问「这是什么」「看看这个」「帮我认一下」「前面是什么」这类'
    + '需要看现场画面的问题时调用。不要凭猜测回答图像内容。'
    + '如果用户明确要求看清细节（「拍高清」「仔细看看」「上面写的什么」「放大看」），'
    + '或者这张低清图不足以回答，改用 take_photo_hq。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const TOOL_HQ = {
  name: 'take_photo_hq',
  description:
    '拍一张**高清**照片并返回（长边 3072 的 JPEG，约 1 MB，需要 3–8 秒）。'
    + '用于必须看清细节的场合：远处文字、菜单、标签、说明书、型号、屏幕内容、'
    + '或者 take_photo 的低清图看不清时。'
    + '普通「这是什么」不要用它——慢且费流量。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

async function callTool(id, name) {
  const url = name === TOOL.name ? CTL : name === TOOL_HQ.name ? CTL_HQ : null;
  if (url === null) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true },
    });
    return;
  }
  try {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    }
    const jpeg = Buffer.from(await res.arrayBuffer());
    if (jpeg.length === 0) throw new Error('收到的图片是空的');
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{
          type: 'image',
          data: jpeg.toString('base64'),
          mimeType: 'image/jpeg',
        }],
      },
    });
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `拍照失败：${e.message}` }], isError: true },
    });
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'miai-camera', version: '1.0.0' },
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
      send({ jsonrpc: '2.0', id, result: { tools: [TOOL, TOOL_HQ] } });
      return;
    case 'tools/call':
      void callTool(id, params?.name);
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
