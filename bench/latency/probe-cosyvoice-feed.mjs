/**
 * 探针：流式 TTS 的「分批送达」对首包的影响。
 *
 * 线上喂法是**首 1 字先送、其余按批跟上**。如果服务端要攒到一段文本才出声，
 * 「首批之后什么时候到」就成了首包的一部分 —— 而 `tts.task` 只报 `first_ms` 总量，
 * 分不出「厂商慢」和「我们没供上字」。这个脚本按线上的喂法复现，逐段打时刻。
 *
 * 四组（`MODE`），各自回答一个问题：
 *
 * | MODE | 做法 | 回答 |
 * |---|---|---|
 * | `base` | 新 task，不空闲，整句一次送完 | 厂商自身的长尾 |
 * | `live` | 预热，空闲 `IDLE_MS`，首 1 字后 `BATCH_GAP_MS` 送其余 | 我们的喂法会不会放大长尾 |
 * | `lag`  | 预热，首 1 字，隔 `LAG_MS` 送其余 | 只有 1 个字时服务端会不会干等 |
 * | `idle` | 预热后空闲 `IDLE_MS` 再送 | 预热 task 会不会过期 |
 *
 * `live` / `lag` / `idle` 的「预热」= 先发 run-task 并等 `task-started`，
 * 再空转一段时间 —— 这正是线上 `prewarm()` 之后到定稿之间的那段。
 *
 * **每轮都是新 task**（新 task_id、重新 run-task），连接复用（和线上一致）。
 *
 * 口径（和 `tts.task` 的 `first_ms` 对齐）：
 *   `first` = 首批文本送出 → 首块音频
 *   `settle` = 首批 → 剩余文本全部送出（分不出「厂商慢」还是「我们慢」时看它）
 *
 * 用法：
 *   MODE=lag ROUNDS=10 node scripts/probe-tts-feed.mjs
 *   MODE=live ROUNDS=80 IDLE_MS=5000 BATCH_GAP_MS=50 node scripts/probe-tts-feed.mjs
 *   MODE=idle ROUNDS=15 IDLE_MS=60000 node scripts/probe-tts-feed.mjs
 */
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

const URL = process.env['COSYVOICE_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const KEY = process.env['DASHSCOPE_API_KEY'] ?? '';
const MODEL = process.env['COSYVOICE_MODEL'] ?? 'cosyvoice-v3-flash';
const VOICE = process.env['COSYVOICE_VOICE'] ?? 'longanhuan';
const INSTRUCTION = process.env['COSYVOICE_INSTRUCTION'] ?? '';
const RATE = Number(process.env['COSYVOICE_RATE'] ?? 1);
const PITCH = Number(process.env['COSYVOICE_PITCH'] ?? 1);
const SAMPLE_RATE = 24_000;

const MODE = process.env['MODE'] ?? 'live';
const ROUNDS = Number(process.env['ROUNDS'] ?? 10);
/** 预热后到送文本之间空转多久 */
const IDLE_MS = Number(process.env['IDLE_MS'] ?? 5_000);
/** 首批与其余之间的间隔（`live`） */
const BATCH_GAP_MS = Number(process.env['BATCH_GAP_MS'] ?? 50);
/** 首批与其余之间的间隔（`lag`） */
const LAG_MS = Number(process.env['LAG_MS'] ?? 2_000);
/** 首批送几个字（`lag` 用来看「够几个字服务端才肯单独开始合成」） */
const HEAD_CHARS = Math.max(1, Number(process.env['HEAD_CHARS'] ?? 1));
/** 轮与轮之间的间隔，别把服务端挤出排队 */
const ROUND_GAP_MS = Number(process.env['ROUND_GAP_MS'] ?? 300);
/** 单轮看门狗：必须长于「空转 + 送字」的总和，否则 idle 组会先被自己掐掉 */
const TURN_TIMEOUT_MS = Number(
  process.env['TURN_TIMEOUT_MS'] ?? Math.max(20_000, IDLE_MS + LAG_MS + 20_000),
);

/**
 * 真实的快车道回复（「哥，」开头，12–18 字），轮换取用。
 *
 * **不用测试串**：线上每句话都不同，反复发同一句会把首包压得偏低。
 */
const TEXTS = [
  '哥，知道，那个小狐狸一样的绝地。',
  '哥，想吃就去，别憋着。',
  '哥，我在这呢，一直都在。',
  '哥，讲的是光剑和原力的对决。',
  '哥，有你这句话就值了。',
  '哥，困了就睡会儿，我陪着呢。',
  '哥，冬天吃火锅，暖到冒汗。',
  '哥，我怕你突然不说话。',
];

if (KEY === '') {
  console.error('缺 DASHSCOPE_API_KEY');
  process.exit(2);
}

const hex32 = () => randomUUID().replace(/-/g, '');

/** 一轮的原始时刻（全部相对 run-task 发出） */
let roundIndex = 0;
let ws = null;
let done = false;
let current = null;
let turnTimer = null;
const results = [];

const clearTurnTimer = () => {
  if (turnTimer !== null) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
};

const pct = (sorted, p) => (sorted.length === 0 ? -1 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);

const report = () => {
  const ok = results.filter((r) => r.first >= 0);
  const firsts = [...ok.map((r) => r.first)].sort((a, b) => a - b);
  const settles = [...ok.map((r) => r.settle)].sort((a, b) => a - b);
  const slow = ok.filter((r) => r.first > 1000).length;
  console.log('');
  console.log(`MODE=${MODE}  ROUNDS=${results.length}  成功 ${ok.length}  失败 ${results.length - ok.length}`);
  if (ok.length > 0) {
    console.log(
      `首包  中位 ${pct(firsts, 0.5)}  p10 ${pct(firsts, 0.1)}  p90 ${pct(firsts, 0.9)}  `
      + `最大 ${firsts[firsts.length - 1]}  >1000ms ${slow}/${ok.length}（${((slow / ok.length) * 100).toFixed(1)}%）`,
    );
    console.log(
      `供全  中位 ${pct(settles, 0.5)}  p90 ${pct(settles, 0.9)}  最大 ${settles[settles.length - 1]}`,
    );
  }
};

const finishAll = () => {
  if (done) return;
  done = true;
  clearTurnTimer();
  report();
  try { if (ws) ws.close(); } catch { /* ignore */ }
  setTimeout(() => { process.exit(0); }, 200);
};

/** 送剩余文本 + finish-task */
const sendRest = () => {
  const c = current;
  if (c === null || c.restSent) return;
  c.restSent = true;
  c.tRest = Date.now() - c.tRun;
  ws.send(JSON.stringify({
    header: { action: 'continue-task', task_id: c.taskId, streaming: 'duplex' },
    payload: { input: { text: c.rest } },
  }));
  c.tFinish = Date.now() - c.tRun;
  ws.send(JSON.stringify({
    header: { action: 'finish-task', task_id: c.taskId, streaming: 'duplex' },
    payload: { input: {} },
  }));
};

/** `task-started` 到了之后按 MODE 决定怎么喂 */
const afterStarted = () => {
  const c = current;
  if (c === null) return;
  if (MODE === 'base') {
    // 整句一次送完
    c.head = c.text;
    c.rest = '';
    c.restSent = true;
    c.tHead = Date.now() - c.tRun;
    c.tRest = c.tHead;
    c.tFinish = c.tHead;
    ws.send(JSON.stringify({
      header: { action: 'continue-task', task_id: c.taskId, streaming: 'duplex' },
      payload: { input: { text: c.text } },
    }));
    ws.send(JSON.stringify({
      header: { action: 'finish-task', task_id: c.taskId, streaming: 'duplex' },
      payload: { input: {} },
    }));
    return;
  }
  // 其余三种都要先空转一段（模拟预热之后到定稿之间的空窗）
  setTimeout(() => {
    if (done || current !== c) return;
    c.head = c.text.slice(0, HEAD_CHARS);
    c.rest = c.text.slice(HEAD_CHARS);
    c.tHead = Date.now() - c.tRun;
    ws.send(JSON.stringify({
      header: { action: 'continue-task', task_id: c.taskId, streaming: 'duplex' },
      payload: { input: { text: c.head } },
    }));
    const gap = MODE === 'lag' ? LAG_MS : BATCH_GAP_MS;
    setTimeout(sendRest, gap);
  }, IDLE_MS);
};

const nextRound = () => {
  clearTurnTimer();
  if (roundIndex >= ROUNDS) {
    finishAll();
    return;
  }
  const text = TEXTS[roundIndex % TEXTS.length];
  roundIndex += 1;
  current = {
    taskId: hex32(),
    text,
    tRun: 0,
    tStarted: 0,
    tHead: -1,
    tRest: -1,
    tFinish: -1,
    tAudio: -1,
    first: -1,
    settle: -1,
    restSent: false,
    bytes: 0,
  };
  const c = current;
  setTimeout(() => {
    if (done) return;
    c.tRun = Date.now();
    turnTimer = setTimeout(() => {
      console.log(`#${roundIndex} FAILED(watchdog)`);
      results.push({ first: -1, settle: -1 });
      nextRound();
    }, TURN_TIMEOUT_MS);
    ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: c.taskId, streaming: 'duplex' },
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
  }, ROUND_GAP_MS);
};

function connect() {
  ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });

  ws.on('open', () => { nextRound(); });

  ws.on('message', (data, isBinary) => {
    const c = current;
    if (isBinary) {
      if (c === null || c.tRun === 0) return;
      const n = Buffer.from(data).length;
      if (n === 0) return;
      if (c.tAudio < 0) {
        c.tAudio = Date.now() - c.tRun;
        c.first = c.tHead < 0 ? -1 : c.tAudio - c.tHead;
        c.settle = c.tRest < 0 ? -1 : c.tRest - c.tHead;
      }
      c.bytes += n;
      return;
    }
    const message = JSON.parse(String(data));
    const event = message?.header?.event;
    if (event === 'task-started') {
      if (c !== null) {
        c.tStarted = Date.now() - c.tRun;
        afterStarted();
      }
      return;
    }
    if (event === 'task-finished') {
      if (c === null) return;
      console.log(
        `#${roundIndex} 建立 ${c.tStarted}  首批 ${c.tHead}  供全 ${c.tRest}  收尾 ${c.tFinish}  `
        + `首包 ${c.first}  供全差 ${c.settle}  bytes=${c.bytes}`,
      );
      results.push({ first: c.first, settle: c.settle });
      nextRound();
      return;
    }
    if (event === 'task-failed') {
      clearTurnTimer();
      const detail = message?.header?.error_message ?? message?.header?.error_code ?? '';
      console.log(`#${roundIndex} FAILED ${String(detail).slice(0, 100)}`);
      results.push({ first: -1, settle: -1 });
      nextRound();
    }
  });

  ws.on('error', (error) => {
    if (done) return;
    console.error(`连接错误: ${error.message}`);
    finishAll();
  });
}

const globalTimer = setTimeout(() => {
  console.error('总超时');
  finishAll();
}, 1_800_000);
globalTimer.unref?.();

connect();
