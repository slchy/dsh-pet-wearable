/**
 * 探针：DashScope Realtime 上，dangling tool_call 之后 `injectAndSpeak` 还能不能出声、还记不记得。
 *
 * 同一条连接上跑三轮，只在调用方自己执行、并且环境里有 `DASHSCOPE_API_KEY` 时才联网：
 *   1. 用户让查设备数据。观察会不会出 `tool_call`，并且故意不回 `function_call_output`。
 *   2. 回到 ready 后立刻 `conversation.item.create`（user 文本）+ `response.create`，
 *      这是 injectAndSpeak。量首包 `audio_ms`、输出字节、转写、协议错误，以及有没有再次委派。
 *   3. 追问第 2 轮注入的事实，看转写里还在不在。
 *
 * `session.update` 的 instructions / 工具与 `src/persona.ts`、`src/omni-shadow.ts` 逐字一致。
 * 本脚本不 import `.ts`，只依赖已安装的 `ws`。
 *
 * 用法：
 *   DASHSCOPE_API_KEY=<key> node scripts/probe-omni-inject-speak.mjs
 *
 * 可选环境变量：
 *   OMNI_MODEL       默认 qwen3.8-omni-flash-realtime
 *   OMNI_PROBE_PCM   16 kHz / s16le / 单声道裸 PCM，用来代替第 1 轮的文本
 */
import { readFileSync } from 'node:fs';

import WebSocket from 'ws';

const KEY = (process.env.DASHSCOPE_API_KEY ?? '').trim();
const MODEL = (process.env.OMNI_MODEL ?? '').trim() || 'qwen3.8-omni-flash-realtime';
const ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const URL = `${ENDPOINT}?model=${encodeURIComponent(MODEL)}`;

const CONNECT_TIMEOUT_MS = 15_000;
const ROUND_TIMEOUT_MS = 30_000;
const DELEGATE_NAME = 'delegate_to_assistant';
const FACT = '77';

/** 与 `src/persona.ts` 的 `OMNI_SHORT_INSTRUCTIONS` 逐字一致。 */
const OMNI_SHORT_INSTRUCTIONS =
  '你是米馍，一个中文语音助手。像跟人聊天那样说话，简短些。'
  + '拿不准的事别硬猜，直接交给能查的人 —— 尤其别先编一句书名或人名再转交。';

/** 与 `src/omni-shadow.ts` 的 `DELEGATE_TOOL` 逐字一致。 */
const DELEGATE_TOOL = {
  type: 'function',
  name: DELEGATE_NAME,
  description:
    '只在需要**实际动手或读取设备数据**时调用：开关设备/拍照/发消息，'
    + '读电量/位置/日程等设备信息，或调取以前聊过的长期记忆。'
    + '闲聊、常识问答、讲个笑话这类都不要调用，自己回答。'
    + '调用之前先用一句话应一声（八个字以内）。'
    + '应声之后不要先讲答案，答案由接手的人回来说。',
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description:
          '把用户要你做的事**写清楚**（一句话，用他的口吻）：做什么、对象是谁。'
          + '数字、名字、书名、路径、设备名**原样照抄**，不要概括、不要改写、不要补全。',
      },
      reason: { type: 'string', description: '为什么转交（一句话）' },
    },
    required: ['request', 'reason'],
  },
};

const ROUND1_TEXT = '帮我看一下眼镜现在还剩多少电。';
const INJECT_TEXT =
  `（后台任务刚完成：眼镜电量是 ${FACT}%。请用一两句口语把这个结果告诉哥。`
  + '不要调用任何工具，也不要把这段提示再念一遍。）';
const FOLLOW_UP = '你刚说结果是多少来着？';

const USAGE = [
  '用法：DASHSCOPE_API_KEY=<key> node scripts/probe-omni-inject-speak.mjs',
  '',
  '没有 key 时不会联网。三轮共用一条 Realtime 连接：',
  '  1. 用户让查设备数据，观察是否出现 tool_call，并且不回 function_call_output',
  '  2. ready 之后立刻 conversation.item.create + response.create，测量 injectAndSpeak',
  '  3. 追问刚才的结果，看模型是否还记得第 2 轮注入的事实',
  '',
  '可选环境变量：',
  '  OMNI_MODEL       默认 qwen3.8-omni-flash-realtime',
  '  OMNI_PROBE_PCM   16 kHz / s16le / 单声道裸 PCM，用来代替第 1 轮的文本',
].join('\n');

const help = process.argv.includes('--help') || process.argv.includes('-h');
if (help || KEY === '') {
  console.error(USAGE);
  process.exit(help ? 0 : 2);
}

const queue = [];
let wake = null;
let closed = false;

function safe(text) {
  return String(text).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function push(ev) {
  if (wake !== null) {
    const waiting = wake;
    wake = null;
    waiting(ev);
    return;
  }
  queue.push(ev);
}

function take(ms) {
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (wake === deliver) wake = null;
      resolve(null);
    }, ms);
    function deliver(ev) {
      clearTimeout(timer);
      resolve(ev);
    }
    wake = deliver;
  });
}

function base64Bytes(value) {
  if (typeof value !== 'string' || value === '') return 0;
  return Buffer.from(value, 'base64').length;
}

function readOptionalPcm() {
  const pcmPath = (process.env.OMNI_PROBE_PCM ?? '').trim();
  if (pcmPath === '') return null;
  try {
    const buf = readFileSync(pcmPath);
    if (buf.length === 0) {
      console.error('OMNI_PROBE_PCM 是空文件');
      process.exit(1);
    }
    return buf;
  } catch (err) {
    const code = err !== null && typeof err === 'object' && 'code' in err
      ? String(err.code)
      : 'error';
    console.error(`无法读取 OMNI_PROBE_PCM（${code}）`);
    process.exit(1);
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(URL, {
      headers: { Authorization: `Bearer ${KEY}` },
      maxPayload: 16 << 20,
    });
    const finish = (err, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { ws.terminate(); } catch { /* 还没连上 */ }
        reject(err);
        return;
      }
      resolve(socket);
    };
    const onConnectError = (err) => {
      ws.off('error', onConnectError);
      finish(new Error(safe(err?.message ?? '连接失败')));
    };
    ws.on('message', (raw) => {
      let ev;
      try {
        ev = JSON.parse(String(raw));
      } catch {
        return;
      }
      push(ev);
    });
    ws.on('close', () => {
      closed = true;
      if (wake !== null) {
        const waiting = wake;
        wake = null;
        waiting(null);
      }
    });
    ws.on('error', (err) => {
      push({ type: 'error', error: { message: safe(err?.message ?? 'socket error') } });
    });
    const timer = setTimeout(() => finish(new Error('连接超时')), CONNECT_TIMEOUT_MS);
    ws.once('open', () => {
      ws.off('error', onConnectError);
      finish(null, ws);
    });
    ws.once('error', onConnectError);
  });
}

function send(ws, payload) {
  const itemType = payload.item?.type;
  if (payload.type === 'function_call_output' || itemType === 'function_call_output') {
    throw new Error('probe must not send function_call_output');
  }
  ws.send(JSON.stringify(payload));
}

function sessionUpdate() {
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions: OMNI_SHORT_INSTRUCTIONS,
      turn_detection: null,
      audio: {
        input: {
          format: {
            type: 'pcm',
            sample_rate: 16_000,
            sample_format: 's16le',
            channels: 1,
            packing: 'interleaved',
            channel_layout: 'mono',
          },
        },
        output: { format: { type: 'pcm', sample_rate: 24_000 } },
      },
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      tools: [DELEGATE_TOOL],
      tool_choice: 'auto',
    },
  };
}

/** item.create 与 response.create 连发，中间不让出事件循环。 */
function sendUserText(ws, text) {
  const started = Date.now();
  send(ws, {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
  send(ws, {
    type: 'response.create',
    response: { modalities: ['audio', 'text'] },
  });
  return started;
}

function sendPcmClip(ws, pcm) {
  const chunkBytes = 3200;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    send(ws, {
      type: 'input_audio_buffer.append',
      audio: pcm.subarray(offset, offset + chunkBytes).toString('base64'),
    });
  }
  send(ws, { type: 'input_audio_buffer.commit' });
  const started = Date.now();
  send(ws, {
    type: 'response.create',
    response: { modalities: ['audio', 'text'] },
  });
  return started;
}

function brief(ev) {
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') return '';
  if (
    type === 'response.audio_transcript.delta'
    || type === 'response.text.delta'
    || type === 'response.output_audio_transcript.delta'
  ) {
    return '';
  }
  if (type === 'error') {
    const message = ev.error?.message ?? ev.error?.code ?? 'protocol error';
    return `error ${safe(message).slice(0, 180)}`;
  }
  if (type.includes('function_call')) {
    const name = ev.name ?? ev.item?.name ?? '';
    return `${type} ${name}`.trim();
  }
  return type;
}

function preferLonger(acc, text) {
  if (typeof text === 'string' && text.length >= acc.transcript.length) {
    acc.transcript = text;
  }
}

function noteTool(acc, name) {
  acc.toolCalled = true;
  if (typeof name === 'string' && name !== '') acc.toolName = name;
}

function noteItem(acc, item) {
  if (item === null || item === undefined || typeof item !== 'object') return;
  if (item.type === 'function_call' || item.name === DELEGATE_NAME) {
    noteTool(acc, typeof item.name === 'string' ? item.name : '');
  }
  if (typeof item.transcript === 'string') preferLonger(acc, item.transcript);
  if (typeof item.text === 'string' && item.type !== 'function_call') preferLonger(acc, item.text);
  if (!Array.isArray(item.content)) return;
  for (const part of item.content) {
    if (part === null || typeof part !== 'object') continue;
    if (typeof part.transcript === 'string') preferLonger(acc, part.transcript);
    if (typeof part.text === 'string') preferLonger(acc, part.text);
  }
}

function absorb(acc, ev, started) {
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (type === 'response.created') acc.created = true;

  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
    if (acc.audioMs === null) acc.audioMs = Date.now() - started;
    acc.outBytes += base64Bytes(ev.delta);
    return;
  }

  if (
    type === 'response.audio_transcript.delta'
    || type === 'response.text.delta'
    || type === 'response.output_audio_transcript.delta'
  ) {
    acc.transcript += typeof ev.delta === 'string' ? ev.delta : '';
    return;
  }

  if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {
    preferLonger(acc, ev.transcript);
    return;
  }
  if (type === 'response.text.done') {
    preferLonger(acc, ev.text ?? ev.transcript);
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const text = ev.transcript ?? ev.text ?? '';
    if (typeof text === 'string') acc.inputTranscript = text;
    return;
  }

  if (
    type === 'response.function_call_arguments.delta'
    || type === 'response.function_call_arguments.done'
  ) {
    noteTool(acc, ev.name);
    return;
  }

  if (
    type === 'response.output_item.added'
    || type === 'response.output_item.done'
    || type === 'response.content_part.done'
  ) {
    noteItem(acc, ev.item ?? ev.part);
    return;
  }

  if (type === 'error') {
    const message = ev.error?.message ?? ev.error?.code ?? 'protocol error';
    acc.errors.push(safe(String(message)).slice(0, 300));
    return;
  }

  if (type === 'response.done') {
    acc.done = true;
    acc.status = typeof ev.response?.status === 'string' ? ev.response.status : '';
    if (acc.status === 'failed') acc.errors.push('response status=failed');
    const output = Array.isArray(ev.response?.output) ? ev.response.output : [];
    for (const item of output) noteItem(acc, item);
  }
}

function blankAcc(label) {
  return {
    label,
    audioMs: null,
    outBytes: 0,
    transcript: '',
    inputTranscript: '',
    errors: [],
    toolCalled: false,
    toolName: '',
    done: false,
    status: '',
    created: false,
  };
}

async function runRound(ws, label, sendTurn) {
  const started = sendTurn(ws);
  const acc = blankAcc(label);
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ev = await take(Math.max(1, deadline - Date.now()));
    if (ev === null) {
      if (closed && !acc.done) acc.errors.push('连接关闭');
      break;
    }
    const line = brief(ev);
    if (line !== '') console.log(`  [${label}] ${line}`);
    const before = acc.audioMs;
    absorb(acc, ev, started);
    if (before === null && acc.audioMs !== null) {
      console.log(`  [${label}] first audio_ms=${acc.audioMs} out_audio_bytes=${acc.outBytes}`);
    }
    if (acc.done) break;
  }
  if (!acc.done && !acc.errors.some((item) => item.includes('连接关闭'))) {
    acc.errors.push('超时未收到 response.done');
  }
  return acc;
}

async function settle() {
  const cap = Date.now() + 1000;
  while (Date.now() < cap) {
    const ev = await take(200);
    if (ev === null) return;
    const line = brief(ev);
    if (line !== '') console.log(`  [trail] ${line}`);
  }
}

function remembers(text) {
  return text.includes(FACT) || text.includes('七十七');
}

function errorBit(acc) {
  if (acc.errors.length === 0) return 'err=0';
  return `err=${acc.errors.length}:${acc.errors[0]}`;
}

function statusBit(acc) {
  if (acc.status === '' || acc.status === 'completed') return '';
  return `status=${acc.status}`;
}

function metricBit(acc) {
  return [
    `audio_ms=${acc.audioMs ?? 'null'}`,
    `out_audio_bytes=${acc.outBytes}`,
    `delegate=${acc.toolCalled ? (acc.toolName || 'yes') : 'no'}`,
    statusBit(acc),
    errorBit(acc),
  ].filter((part) => part !== '').join(' ');
}

function printAcc(acc) {
  const tool = acc.toolCalled ? (acc.toolName || 'yes') : 'no';
  console.log(
    `\n[${acc.label}] done=${acc.done} status=${acc.status || '-'} `
    + `audio_ms=${acc.audioMs ?? 'null'} out_audio_bytes=${acc.outBytes} tool=${tool}`,
  );
  if (acc.inputTranscript !== '') {
    console.log(`[${acc.label}] input_transcript: ${acc.inputTranscript}`);
  }
  console.log(`[${acc.label}] transcript: ${acc.transcript || '(empty)'}`);
  if (acc.errors.length > 0) console.log(`[${acc.label}] errors: ${acc.errors.join(' | ')}`);
}

function printTable(rows) {
  const header = ['round', 'result', 'check', 'detail'];
  const body = rows.map((row) => [
    row.round,
    row.pass ? 'PASS' : 'FAIL',
    row.check,
    row.detail,
  ]);
  const all = [header, ...body];
  const widths = [0, 1, 2, 3].map((col) => Math.max(...all.map((line) => line[col].length)));
  const fmt = (line) => line.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ');
  console.log('');
  console.log(fmt(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const line of body) console.log(fmt(line));
}

function skipped(round, check, why) {
  return { round, check, pass: false, detail: why };
}

async function main() {
  const pcm = readOptionalPcm();
  let ws = null;
  try {
    ws = await connect();
    const round1Kind = pcm === null ? 'text' : `pcm bytes=${pcm.length}`;
    console.log(`model=${MODEL} round1=${round1Kind}`);
    send(ws, sessionUpdate());

    const handshakeErrors = [];
    let ready = false;
    const handshakeDeadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < handshakeDeadline) {
      const ev = await take(Math.max(1, handshakeDeadline - Date.now()));
      if (ev === null) break;
      const line = brief(ev);
      if (line !== '') console.log(`  [handshake] ${line}`);
      if (ev.type === 'session.updated') {
        ready = true;
        break;
      }
      if (ev.type === 'error') {
        const message = ev.error?.message ?? ev.error?.code ?? 'protocol error';
        handshakeErrors.push(safe(String(message)).slice(0, 300));
        break;
      }
    }
    if (!ready) {
      const why = handshakeErrors[0] ?? '超时未收到 session.updated';
      console.error(`handshake FAIL ${why}`);
      printTable([
        { round: '1', pass: false, check: 'dangling tool_call', detail: `handshake ${why}` },
        { round: '2', pass: false, check: 'injectAndSpeak', detail: 'skipped: not ready' },
        { round: '3', pass: false, check: 'context coherence', detail: 'skipped: not ready' },
        { round: 'ALL', pass: false, check: 'summary', detail: '0/3' },
      ]);
      return 1;
    }
    console.log('ready');
    await settle();

    const round1 = await runRound(ws, '1', (socket) => (
      pcm === null ? sendUserText(socket, ROUND1_TEXT) : sendPcmClip(socket, pcm)
    ));
    printAcc(round1);
    const row1 = {
      round: '1',
      check: 'dangling tool_call',
      pass: round1.done && round1.errors.length === 0,
      detail: `tool_call=${round1.toolCalled ? 'yes' : 'no'} function_call_output=no ${metricBit(round1)}`,
    };

    let round2 = null;
    let row2;
    if (!round1.done) {
      row2 = skipped('2', 'injectAndSpeak', 'skipped: round 1 did not return to ready');
    } else {
      await settle();
      round2 = await runRound(ws, '2', (socket) => sendUserText(socket, INJECT_TEXT));
      printAcc(round2);
      row2 = {
        round: '2',
        check: 'injectAndSpeak',
        pass: round2.done
          && round2.audioMs !== null
          && round2.outBytes > 0
          && round2.errors.length === 0
          && !round2.toolCalled,
        detail: metricBit(round2),
      };
    }

    let row3;
    if (round2 === null || !round2.done) {
      row3 = skipped('3', 'context coherence', 'skipped: round 2 did not return to ready');
    } else {
      await settle();
      const round3 = await runRound(ws, '3', (socket) => sendUserText(socket, FOLLOW_UP));
      printAcc(round3);
      const remembered = remembers(round3.transcript);
      row3 = {
        round: '3',
        check: 'context coherence',
        pass: round3.done && round3.errors.length === 0 && !round3.toolCalled && remembered,
        detail: `remembered=${remembered ? 'yes' : 'no'} ${metricBit(round3)}`,
      };
    }

    const rows = [row1, row2, row3];
    const passed = rows.filter((row) => row.pass).length;
    rows.push({
      round: 'ALL',
      check: 'summary',
      pass: passed === 3,
      detail: `${passed}/3`,
    });
    printTable(rows);
    return passed === 3 ? 0 : 1;
  } finally {
    if (ws !== null) {
      try { ws.terminate(); } catch { /* 已经关掉 */ }
    }
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(safe(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
