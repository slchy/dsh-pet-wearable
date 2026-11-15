/**
 * 探针：阿里云 **CosyVoice**（DashScope 流式语音合成）的首包延迟。
 *
 * 和 `probe-aliyun-tts.mjs` 的区别：那个走 NLS 的 `SpeechSynthesizer`
 * （`wss://nls-gateway-*`，用 AK/SK 换 token）；这个走 Model Studio 的
 * `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，
 * **认证是 DashScope 的 API key（`sk-...`），不是 AK/SK**。
 * 两套是独立开通的，控制台里「流式文本语音合成（CosyVoice）」属于后者。
 *
 * 依赖 `ws`：Node 内置的 WebSocket 不支持自定义 header，而这里必须带
 * `Authorization: Bearer <key>`。跑之前先 `npm i ws`（临时装也行）。
 *
 * 用法：
 *   set -a; . .env; set +a
 *   DASHSCOPE_API_KEY=sk-xxx MIAI_REPO=$PWD node scripts/probe-cosyvoice.mjs
 */
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

const URL = process.env['COSYVOICE_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const KEY = process.env['DASHSCOPE_API_KEY'] ?? '';
const MODEL = process.env['COSYVOICE_MODEL'] ?? 'cosyvoice-v2';
const VOICE = process.env['COSYVOICE_VOICE'] ?? 'longxiaochun_v2';
const SAMPLE_RATE = Number(process.env['COSYVOICE_SAMPLE_RATE'] ?? 24_000);
const TEXT = process.env['COSYVOICE_TEXT'] ?? '哥，这件事我查了一下，大概是这样。';
const ROUNDS = Number(process.env['COSYVOICE_ROUNDS'] ?? 5);

/** 阿里云的 task_id 要 32 位无横线；randomUUID() 默认带横线。 */
const hex32 = () => randomUUID().replace(/-/g, '');

if (KEY === '') {
  console.error('缺 DASHSCOPE_API_KEY：CosyVoice 用的是 Model Studio 的 API key（sk-...），不是阿里云 AK/SK。');
  process.exit(2);
}

/** 一轮：run-task → 立刻 continue-task + finish-task → 等第一个二进制音频帧。 */
async function once() {
  return await new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const taskId = hex32();
    const started = Date.now();
    let firstAudioMs = -1;
    let bytes = 0;
    let note = '';
    let settled = false;

    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经关了 */ }
      resolve({ firstAudioMs, bytes, note: note || why });
    };
    const timer = setTimeout(() => finish('timeout'), 20_000);

    ws.on('open', () => {
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
          },
          input: {},
        },
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.from(data);
        if (chunk.length === 0) return;
        if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
        bytes += chunk.length;
        return;
      }
      const message = JSON.parse(String(data));
      const event = message?.header?.event;
      const action = message?.header?.action;
      if (event === 'task-started' || action === 'run-task') {
        // 会话就绪：把文本一次说完
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

const results = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const result = await once();
  results.push(result);
  console.log(`第 ${i} 次: firstAudio=${result.firstAudioMs} ms  bytes=${result.bytes}  ${result.note}`);
  await new Promise((r) => { setTimeout(r, 600); });
}

const ok = results.filter((r) => r.firstAudioMs >= 0).map((r) => r.firstAudioMs).sort((a, b) => a - b);
if (ok.length === 0) {
  console.log('\n全部失败，没有可比数字。看 note 里的 error_message。');
} else {
  const median = ok[Math.floor(ok.length / 2)];
  console.log(`\n首包：${ok.join(' / ')} ms   中位 ${median} ms`);
}
process.exit(0);
