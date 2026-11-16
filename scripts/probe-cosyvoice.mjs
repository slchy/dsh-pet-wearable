/**
 * 探针：阿里云 **CosyVoice**（DashScope 流式语音合成）的首包延迟拆解。
 *
 * 和 `probe-aliyun-tts.mjs` 的区别：那个走 NLS 的 `SpeechSynthesizer`
 * （`wss://nls-gateway-*`，用 AK/SK 换 token）；这个走 Model Studio 的
 * `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，
 * **认证是 DashScope 的 API key（`sk-...`），不是 AK/SK**。
 * 两套是独立开通的，控制台里「流式文本语音合成（CosyVoice）」属于后者。
 *
 * 拆四个时刻，因为「首包 6xx ms」到底是建连成本还是合成成本，直接决定要不要换供应商：
 *   tOpen     WebSocket 握手完成（TCP+TLS+HTTP Upgrade）
 *   tReady    run-task 之后 task-started 到达（服务端分配会话）
 *   tFirst    第一帧音频
 * 另外单独测一次「同一条连接上串行跑第二个 task」，看服务端允不允许复用。
 *
 * 依赖 `ws`：Node 内置的 WebSocket 不支持自定义 header，而这里必须带
 * `Authorization: Bearer <key>`。
 *
 * 用法：
 *   npm i ws --no-save
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/probe-cosyvoice.mjs
 */
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

const URL = process.env['COSYVOICE_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const KEY = process.env['DASHSCOPE_API_KEY'] ?? '';
const MODEL = process.env['COSYVOICE_MODEL'] ?? 'cosyvoice-v2';
const VOICE = process.env['COSYVOICE_VOICE'] ?? 'longxiaochun_v2';
const SAMPLE_RATE = Number(process.env['COSYVOICE_SAMPLE_RATE'] ?? 24_000);
const TEXT = process.env['COSYVOICE_TEXT'] ?? '哥，这件事我查了一下，大概是这样。';
const RATE = Number(process.env['COSYVOICE_RATE'] ?? 1);
const PITCH = Number(process.env['COSYVOICE_PITCH'] ?? 1);
const VOLUME = Number(process.env['COSYVOICE_VOLUME'] ?? 50);
const INSTRUCTION = process.env['COSYVOICE_INSTRUCTION'] ?? '';
const ROUNDS = Number(process.env['COSYVOICE_ROUNDS'] ?? 4);

/**
 * v2/v3 的 parameters。预设音色没有 instruction/emotion（会报 428），
 * 只有复刻音色（v3.5-flash）吃 free-style 的 instruction；
 * enable_ssml 一旦为 true 就只允许一次 continue-task，和「边生成边送文本」互斥。
 */
const params = () => ({
  text_type: 'PlainText',
  voice: VOICE,
  format: 'pcm',
  sample_rate: SAMPLE_RATE,
  volume: VOLUME,
  rate: RATE,
  pitch: PITCH,
  ...(INSTRUCTION === '' ? {} : { instruction: INSTRUCTION }),
});

/** 阿里云的 task_id 要 32 位无横线；randomUUID() 默认带横线。 */
const hex32 = () => randomUUID().replace(/-/g, '');

if (KEY === '') {
  console.error('缺 DASHSCOPE_API_KEY：CosyVoice 用的是 Model Studio 的 API key（sk-...），不是阿里云 AK/SK。');
  process.exit(2);
}

/**
 * 在一条新连接上跑一个 task。
 * @returns {Promise<{tOpen: number, tReady: number, tFirst: number, bytes: number, note: string}>}
 */
async function once() {
  return await new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const taskId = hex32();
    const started = Date.now();
    const timings = { tOpen: -1, tReady: -1, tFirst: -1 };
    let bytes = 0;
    let note = '';
    let settled = false;

    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经关了 */ }
      resolve({ ...timings, bytes, note: note || why });
    };
    const timer = setTimeout(() => finish('timeout'), 30_000);

    ws.on('open', () => {
      timings.tOpen = Date.now() - started;
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: MODEL,
          parameters: params(),
          input: {},
        },
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.from(data);
        if (chunk.length === 0) return;
        if (timings.tFirst < 0) timings.tFirst = Date.now() - started;
        bytes += chunk.length;
        return;
      }
      const message = JSON.parse(String(data));
      const event = message?.header?.event;
      if (event === 'task-started') {
        timings.tReady = Date.now() - started;
        ws.send(JSON.stringify({
          header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: { text: TEXT } },
        }));
        ws.send(JSON.stringify({
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} },
        }));
        return;
      }
      if (event === 'task-finished') { finish('finished'); return; }
      if (event === 'task-failed') {
        note = String(message?.header?.error_message ?? message?.header?.error_code ?? '').slice(0, 160);
        finish('failed');
      }
    });

    ws.on('error', (error) => { note = `ws-error: ${error.message}`; finish('error'); });
    ws.on('close', () => finish('closed'));
  });
}

/**
 * 复用同一条连接：连上后串行跑两个 task，只测第二个的首包。
 * 服务端若不允许重复 run-task，会以 task-failed 结束——那也是结论。
 */
async function reuse() {
  return await new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    let round = 0;
    let sentAt = 0;
    let firstMs = -1;
    let settled = false;

    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经关了 */ }
      resolve({ firstMs, note: why });
    };
    const timer = setTimeout(() => finish('timeout'), 30_000);

    const sendTask = () => {
      const taskId = hex32();
      sentAt = Date.now();
      firstMs = -1;
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: MODEL,
          parameters: params(),
          input: {},
        },
      }));
      ws.send(JSON.stringify({
        header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: { text: TEXT } },
      }));
      ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      }));
    };

    ws.on('open', () => { sendTask(); });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (Buffer.from(data).length === 0) return;
        if (round === 1 && firstMs < 0) firstMs = Date.now() - sentAt;
        return;
      }
      const message = JSON.parse(String(data));
      const event = message?.header?.event;
      if (event === 'task-finished') {
        round += 1;
        if (round === 1) sendTask();
        else finish('reuse-ok');
        return;
      }
      if (event === 'task-failed') {
        const detail = String(message?.header?.error_message ?? '').slice(0, 160);
        finish(`reuse-failed:${detail}`);
      }
    });

    ws.on('error', (error) => finish(`ws-error:${error.message}`));
    ws.on('close', () => finish('closed'));
  });
}

const results = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const result = await once();
  results.push(result);
  console.log(
    `第 ${i} 次: open=${result.tOpen}  ready=${result.tReady}  first=${result.tFirst} ms` +
    `  bytes=${result.bytes}  ${result.note}`,
  );
  await new Promise((r) => { setTimeout(r, 600); });
}

const pick = (key) => results.filter((r) => r[key] >= 0).map((r) => r[key]).sort((a, b) => a - b);
const median = (list) => (list.length === 0 ? -1 : list[Math.floor(list.length / 2)]);

const opens = pick('tOpen');
const readys = pick('tReady');
const firsts = pick('tFirst');
console.log('');
console.log(`握手 open   : ${opens.join(' / ')} ms   中位 ${median(opens)}`);
console.log(`会话 ready  : ${readys.join(' / ')} ms   中位 ${median(readys)}`);
console.log(`首包 first  : ${firsts.join(' / ')} ms   中位 ${median(firsts)}`);
if (firsts.length > 0 && opens.length > 0) {
  console.log(`\n「握手」${median(opens)} ms + 「会话就绪」${median(readys) - median(opens)} ms + 「首帧合成」${median(firsts) - median(readys)} ms`);
}

const reused = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const result = await reuse();
  reused.push(result);
  console.log(`复用第 ${i} 次: first=${result.firstMs} ms  ${result.note}`);
  await new Promise((r) => { setTimeout(r, 600); });
}
const reuseMs = reused.filter((r) => r.firstMs >= 0).map((r) => r.firstMs).sort((a, b) => a - b);
if (reuseMs.length > 0) {
  console.log(`\n同连接复用首包: ${reuseMs.join(' / ')} ms   中位 ${median(reuseMs)}`);
  console.log(`（对比新连接首包中位 ${median(firsts)} ms，复用省下 ${median(firsts) - median(reuseMs)} ms）`);
}
process.exit(0);
