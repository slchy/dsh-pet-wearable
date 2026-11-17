/**
 * 探针：CosyVoice 服务端回执里到底有没有 `task_id`。
 *
 * 影响设计：`Connection` 的 `task-started` / `task-finished` / `task-failed` 三个
 * 槽位现在各只有一份，回执与正文在同一条连接上先后跑时会互相踩。要按 task_id
 * 分槽，前提是服务端把这些事件和 task_id 一起发回来。
 *
 * 跑法：node bench/latency/probe-cosyvoice-taskid.mjs
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

const REPO = resolve(import.meta.dirname, '..', '..');
for (const line of readFileSync(join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m !== null && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const url = process.env['COSYVOICE_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const apiKey = process.env['DASHSCOPE_API_KEY'] ?? '';
const model = process.env['COSYVOICE_MODEL'] ?? 'cosyvoice-v3-flash';
const voice = process.env['COSYVOICE_VOICE'] ?? 'longanhuan';

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
await new Promise((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
console.log('已连接\n');

const taskId = 'probe' + Date.now().toString(16);
let binaryFrames = 0;

ws.on('message', (data, isBinary) => {
  if (isBinary) { binaryFrames += 1; return; }
  const text = String(data);
  let json;
  try { json = JSON.parse(text); } catch { console.log('非 JSON:', text.slice(0, 120)); return; }
  const h = json.header ?? {};
  console.log(
    `← ${String(h.event ?? '(无 event)').padEnd(18)}`
    + ` task_id=${h.task_id ?? '(无)'}`
    + (binaryFrames > 0 ? `  [此前已收 ${binaryFrames} 个二进制帧]` : '')
    + (h.error_message ? `  error=${h.error_message}` : ''),
  );
  if (h.event === 'task-finished' || h.event === 'task-failed') {
    void finish();
  }
});

ws.send(JSON.stringify({
  header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
  payload: {
    task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
    parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: 24000, volume: 50 },
    input: {},
  },
}));
console.log(`→ run-task 我们发的 task_id=${taskId}`);

await new Promise((r) => { setTimeout(r, 500); });
ws.send(JSON.stringify({
  header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
  payload: { input: { text: '按任务分槽测试。' } },
}));
console.log('→ continue-task');
ws.send(JSON.stringify({
  header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
  payload: { input: {} },
}));
console.log('→ finish-task');

async function finish() {
  await new Promise((r) => { setTimeout(r, 300); });
  console.log(`\n二进制音频帧总数：${binaryFrames}`);
  ws.close();
  process.exit(0);
}
setTimeout(() => { console.log('\n超时'); ws.close(); process.exit(1); }, 20_000);


