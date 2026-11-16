/**
 * 探针：在**同一条 WebSocket 上连跑 N 个 task**，逐个打印首包，看稳态。
 *
 * 严格按官方协议顺序（这是第一版的错误，别改回去）：
 *   open → run-task → 【等 task-started】→ continue-task → finish-task
 * 一次性把三条全发出去虽然也能出音频，但那是未定义行为，不能当基线。
 *
 * 默认**每轮换一句话**（`VARY=0` 可关掉）。如果服务端对
 * `(voice, text, instruction)` 有结果缓存，反复发同一句会把首包压得偏低 ——
 * 真实场景每句话都不同，那才是要测的数字。
 *
 * 两条保护，都是踩过坑才加的：
 * - **每轮看门狗**（`TURN_TIMEOUT_MS`，默认 20 s）：服务端若既不发 task-started
 *   也不发 task-failed，不能一直挂着等。
 * - **失败后重连**：一个 task 报错（比如 428 指令格式不对）后，这条连接上后续
 *   task 全部静默挂死，不重连会浪费 N 个看门狗周期，还会被误读成「模型很慢」。
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/probe-cosyvoice-warm.mjs
 *   COSYVOICE_MODEL=cosyvoice-v3-flash COSYVOICE_VOICE=longanhuan \
 *   COSYVOICE_INSTRUCTION='你说话的情感是happy。' TASKS=6 node scripts/probe-cosyvoice-warm.mjs
 */
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

const URL = process.env['COSYVOICE_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const KEY = process.env['DASHSCOPE_API_KEY'] ?? '';
const MODEL = process.env['COSYVOICE_MODEL'] ?? 'cosyvoice-v3-flash';
const VOICE = process.env['COSYVOICE_VOICE'] ?? 'longanhuan_v3';
const INSTRUCTION = process.env['COSYVOICE_INSTRUCTION'] ?? '';
const TASKS = Number(process.env['TASKS'] ?? 10);
const VARY = process.env['VARY'] !== '0';
const TURN_TIMEOUT_MS = Number(process.env['TURN_TIMEOUT_MS'] ?? 20_000);
const SAMPLE_RATE = 24_000;
const RATE = Number(process.env['COSYVOICE_RATE'] ?? 1);
const PITCH = Number(process.env['COSYVOICE_PITCH'] ?? 1);

/** 12 句等长（15–18 字）的口语短句，轮换取用 */
const TEXTS = [
  '哥，这件事我查了一下，大概是这样。',
  '外面现在下着小雨，出门记得带伞。',
  '你昨天问的那个问题，我想到办法了。',
  '电量还剩百分之六十，够用一整天的。',
  '刚才那首歌我找到了，要现在放吗。',
  '这个价格比上周便宜了大概两百块。',
  '明天下午三点有个会，别忘了定闹钟。',
  '我把文件放在桌面上了，你打开看看。',
  '路上有点堵，大概还要二十分钟到。',
  '你说的那家店我查了，今天休息。',
  '天气预报说明天要降温，多穿一点。',
  '这个功能我觉得还可以再简化一点。',
];

/** `COSYVOICE_TEXTS=a|b|c` 可覆盖内置句子（测长文本用） */
const CUSTOM = (process.env['COSYVOICE_TEXTS'] ?? '').split('|').filter((s) => s !== '');
const POOL = CUSTOM.length > 0 ? CUSTOM : TEXTS;

const hex32 = () => randomUUID().replace(/-/g, '');

if (KEY === '') {
  console.error('缺 DASHSCOPE_API_KEY');
  process.exit(2);
}

const timings = [];
let failures = 0;
let round = 0;
let sentAt = 0;
let firstMs = -1;
let turnBytes = 0;
let awaitingStart = '';
let turnTimer = null;
let startedAt = 0;
let ws = null;
let done = false;

const clearTurnTimer = () => {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
};

const report = () => {
  const ok = timings.filter((t) => t >= 0);
  const sorted = [...ok].sort((a, b) => a - b);
  const median = sorted.length === 0 ? -1 : sorted[Math.floor(sorted.length / 2)];
  const steady = timings.slice(2).filter((t) => t >= 0);
  const steadySorted = [...steady].sort((a, b) => a - b);
  const steadyMedian = steadySorted.length === 0 ? -1 : steadySorted[Math.floor(steadySorted.length / 2)];
  const min = sorted.length === 0 ? -1 : sorted[0];
  const max = sorted.length === 0 ? -1 : sorted[sorted.length - 1];
  console.log('');
  console.log(`逐次: ${timings.map((t) => (t < 0 ? 'x' : String(t))).join(' / ')} ms`);
  console.log(`中位 ${median} ms   稳态（丢前 2）${steadyMedian} ms   极值 ${min}/${max}   失败 ${failures}`);
  console.log(`model=${MODEL}  voice=${VOICE}  vary=${VARY ? '每轮换句' : '同一句'}  rate=${RATE} pitch=${PITCH}  instruction=${INSTRUCTION === '' ? '(无)' : INSTRUCTION}`);
};

const finishAll = () => {
  if (done) return;
  done = true;
  clearTurnTimer();
  clearTimeout(globalTimer);
  report();
  try { if (ws) ws.close(); } catch { /* ignore */ }
  setTimeout(() => { process.exit(0); }, 200);
};

const bumpRound = () => {
  round += 1;
  if (round >= TASKS) {
    finishAll();
    return;
  }
  setTimeout(sendRunTask, 300);
};

const sendRunTask = () => {
  if (done) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  const taskId = hex32();
  awaitingStart = taskId;
  sentAt = Date.now();
  startedAt = sentAt;
  firstMs = -1;
  turnBytes = 0;
  clearTurnTimer();
  turnTimer = setTimeout(() => { failTurn('watchdog', true); }, TURN_TIMEOUT_MS);
  ws.send(JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: MODEL,
      parameters: {
        text_type: 'PlainText',
        voice: VOICE,
        format: 'pcm',
        sample_rate: SAMPLE_RATE,
        volume: 50,
        rate: RATE,
        pitch: PITCH,
        ...(INSTRUCTION === '' ? {} : { instruction: INSTRUCTION }),
      },
      input: {},
    },
  }));
};

/** task-started 之后才允许发文本 —— 官方示例的顺序。 */
const sendText = (taskId) => {
  const text = VARY ? POOL[round % POOL.length] : POOL[0];
  ws.send(JSON.stringify({
    header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: { text } },
  }));
  ws.send(JSON.stringify({
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  }));
};

/**
 * 一轮失败。`reconnect=true` 时丢掉连接重建 —— 一个 task 报错之后这条连接
 * 上后续 task 会静默挂死，不重连会把「连接废了」误判成「模型慢」。
 */
const failTurn = (why, reconnect) => {
  clearTurnTimer();
  awaitingStart = '';
  timings.push(-1);
  failures += 1;
  const ms = startedAt === 0 ? -1 : Date.now() - startedAt;
  process.stdout.write(`#${round + 1} FAILED(${why}) after ${ms}ms\n`);
  if (reconnect && ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  bumpRound();
};

function connect() {
  if (done) return;
  ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });

  ws.on('open', () => { sendRunTask(); });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const n = Buffer.from(data).length;
      if (n === 0) return;
      if (firstMs < 0) firstMs = Date.now() - sentAt;
      turnBytes += n;
      return;
    }
    const message = JSON.parse(String(data));
    const event = message?.header?.event;

    if (event === 'task-started') {
      if (awaitingStart !== '') {
        const taskId = awaitingStart;
        awaitingStart = '';
        sendText(taskId);
      }
      return;
    }

    if (event === 'task-finished') {
      clearTurnTimer();
      timings.push(firstMs);
      process.stdout.write(`#${round + 1} first=${firstMs}ms bytes=${turnBytes}\n`);
      bumpRound();
      return;
    }

    if (event === 'task-failed') {
      clearTurnTimer();
      const detail = message?.header?.error_message ?? message?.header?.error_code ?? '';
      failTurn(String(detail).slice(0, 100), true);
    }
  });

  ws.on('error', (error) => {
    if (done) return;
    failTurn(`ws-error:${error.message}`.slice(0, 100), true);
  });
}

const globalTimer = setTimeout(() => {
  console.error('总超时');
  finishAll();
}, 300_000);

connect();
