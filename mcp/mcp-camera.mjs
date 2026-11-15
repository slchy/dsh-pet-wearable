#!/usr/bin/env node
/**
 * MCP server：把「拍照」暴露成 dsh 的工具。
 *
 * 这个进程**不认识任何具体设备**。暴露哪些工具、要不要提示「需要用户动手」，
 * 全部在运行时从 harness 的能力口（`GET /capabilities`）读。设备实现细节
 * ——走什么通道、多少像素、高清为什么慢——留在 `src/devices/` 里，不进这里。
 * 模型看到的是能力，不是厂商。
 *
 * 能力驱动带来的直接好处：设备没报 `capture.detail` 就**没有**高清工具，
 * 模型压根不会去调；报了就自动出现，不需要改代码。
 *
 * 协议：MCP stdio = 每行一条 JSON-RPC 2.0（stdout 只能出协议帧，日志走 stderr）。
 */
import process from 'node:process';

const CTL = process.env.PHOTO_CTL_URL ?? 'http://127.0.0.1:8767/take_photo';
const CTL_HQ = process.env.PHOTO_CTL_HQ_URL ?? 'http://127.0.0.1:8767/take_photo_hq';
const CAPS = process.env.PHOTO_CAPS_URL ?? 'http://127.0.0.1:8767/capabilities';

/** 工具名 → 控制口。名字按**意图**取，不按设备取。 */
const URL_BY_NAME = { take_photo: CTL, take_photo_hq: CTL_HQ };

const SCHEMA_EMPTY = { type: 'object', properties: {}, additionalProperties: false };

/**
 * 「看一眼」这一档。
 *
 * `hasDetail` 决定要不要提「看不清就换高清」——没有高清档的设备提了等于误导，
 * 模型会去调一个不存在的工具。
 */
function glanceTool(hasDetail) {
  return {
    name: 'take_photo',
    description:
      '拍一张照片并返回图像本身（约 1 秒，分辨率有限，小字可能看不清）。'
      + '当用户问「这是什么」「看看这个」「帮我认一下」「前面是什么」这类'
      + '需要看现场画面的问题时调用。不要凭猜测回答图像内容。'
      + (hasDetail
        ? '如果用户明确要求看清细节（「拍高清」「仔细看看」「上面写的什么」「放大看」），'
          + '或者这张图不足以回答，改用 take_photo_hq。'
        : ''),
    inputSchema: SCHEMA_EMPTY,
  };
}

/**
 * 「看清细节」这一档。
 *
 * `needsUser` 是**能力属性**：有的设备这一档要用户亲手配合（按快门），
 * 有的直接拍。要用户动手就必须先提醒，否则模型会默默等几十秒。
 */
function detailTool(needsUser) {
  return {
    name: 'take_photo_hq',
    description:
      '拍一张高清照片并返回（约 10–30 秒，体积比 take_photo 大得多）。'
      + '用于必须看清细节的场合：远处文字、菜单、标签、说明书、型号、屏幕内容，'
      + '或者 take_photo 的图看不清时。'
      + (needsUser
        ? '这一档需要用户亲手配合（通常是按一下快门），调用前要先说一句让用户准备，'
          + '不要默默等待。'
        : '')
      + '普通「这是什么」不要用它——慢且费流量。',
    inputSchema: SCHEMA_EMPTY,
  };
}

/** 能力 JSON → 工具表。缺哪个意图就没有哪个工具。 */
function toolsFor(caps) {
  const capture = caps?.capture ?? {};
  const glance = capture.glance;
  const detail = capture.detail;
  const tools = [];
  if (glance) tools.push(glanceTool(detail !== undefined));
  if (detail) tools.push(detailTool(detail.needsUser === true));
  return tools;
}

/** 查当前设备能力；设备没连上（503）或查不通都当作「没有能力」。 */
async function readCapabilities() {
  try {
    const res = await fetch(CAPS, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const log = (line) => {
  process.stderr.write(`[mcp-camera] ${line}\n`);
};

async function callTool(id, name) {
  const url = URL_BY_NAME[name];
  if (url === undefined) {
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
      // 失败原因**原样透传** harness 给的文本：那边知道设备是什么，
      // 也知道「相册里没有新照片，请按一下快门」这种该怎么说。这里翻译一遍
      // 只会把设备细节又搬回来，而且两边说法迟早不一致。
      throw new Error((await res.text()).slice(0, 300));
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

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'miai-camera', version: '2.0.0' },
        },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list': {
      // 每次现查：宿主重查工具表时必须是**当前**设备的能力，不能用启动时的快照。
      const tools = toolsFor(await readCapabilities());
      lastSignature = signatureOf(tools);
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    case 'tools/call':
      void callTool(id, params?.name);
      return;
    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } });
      }
  }
}

const signatureOf = (tools) => tools.map((tool) => tool.name).join(',');

/**
 * 上次告诉宿主的工具集合。宿主要知道自己缓存的那份过期了，只有靠
 * `notifications/tools/list_changed` —— 设备换了一台、或者干脆没连上，
 * 工具表都会变，而宿主不会主动来问。
 */
let lastSignature = '';

async function watchCapabilities() {
  const signature = signatureOf(toolsFor(await readCapabilities()));
  if (signature === lastSignature) return;
  lastSignature = signature;
  log(`能力变化 → ${signature === '' ? '（无拍照能力）' : signature}`);
  send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

// 本地 HTTP，一次几百字节，3 秒一次的代价可以忽略；比设备换机后工具表一直
// 停在旧状态要便宜得多。
setInterval(() => { void watchCapabilities(); }, 3000).unref();

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
      // 畸形行直接丢，别让整个工具进程退出
    }
  }
});