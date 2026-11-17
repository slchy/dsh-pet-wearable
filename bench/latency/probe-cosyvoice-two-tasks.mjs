/**
 * 探针：同一条连接上「连着跑两个 task」到底什么时候能开第二个。
 *
 * 背景：生产每 7 天约 2 次 `流式 ✗ 合成失败: Please ensure input text is valid.`
 * 本地必现，且失败**只用了 48 ms**、日志里一条 `TTS 送批` 都没有 ——
 * 说明不是 continue-task 的文本被拒，而是**第二个 run-task 本身被拒**。
 * 场景正是「回执刚合成完，正文立刻开新 task」。
 *
 * 本探针把「第一个 task 结束后等多久再开第二个」做成变量，看哪个等待时长能过。
 *
 * 跑法：node bench/latency/probe-cosyvoice-two-tasks.mjs
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

/** 收到的 JSON 回执，按 task 归类 */
const receipts = [];
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  let json;
  try { json = JSON.parse(String(data)); } catch { return; }
  receipts.push({ at: Date.now(), event: json.header?.event, taskId: json.header?.task_id, error: json.header?.error_message });
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 跑一个完整 task，返回 { ok, audioFrames, receipts } */
async function runTask(text, waitBeforeMs) {
  await sleep(waitBeforeMs);
  const taskId = 't' + Math.random().toString(16).slice(2, 10);
  const from = receipts.length;
  let audio = 0;
  const onMsg = (data, isBinary) => { if (isBinary) audio += 1; };
  ws.on('message', onMsg);

  const startedAt = Date.now();
  ws.send(JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
      parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: 24000, volume: 50 },
      input: {},
    },
  }));
  // 等 task-started 再送文本（与 src 里同一纪律）
  const waitStart = async () => {
    for (let i = 0; i < 60; i += 1) {
      if (receipts.slice(from).some((r) => r.taskId === taskId && r.event === 'task-started')) return true;
      await sleep(25);
    }
    return false;
  };
  const started = await waitStart();
  if (!started) {
    ws.off('message', onMsg);
    return { ok: false, why: '没有 task-started', audio, receipts: receipts.slice(from) };
  }
  ws.send(JSON.stringify({
    header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: { text } },
  }));
  ws.send(JSON.stringify({
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  }));

  // 等 task-finished / task-failed
  let outcome = null;
  for (let i = 0; i < 200; i += 1) {
    const hit = receipts.slice(from).find((r) => r.taskId === taskId && (r.event === 'task-finished' || r.event === 'task-failed'));
    if (hit !== undefined) { outcome = hit; break; }
    await sleep(25);
  }
  ws.off('message', onMsg);
  return {
    ok: outcome?.event === 'task-finished',
    why: outcome?.error ?? outcome?.event ?? '超时',
    audio,
    ms: Date.now() - startedAt,
    receipts: receipts.slice(from),
  };
}

console.log(`model=${model} voice=${voice}\n`);

for (const gap of [0, 100, 300, 600, 1000]) {
  const a = await runTask('我看看。', 0);
  const b = await runTask('哥，这个真拿不到，命令全被权限卡住了，你手机上瞄一眼吧。', gap);
  console.log(
    `间隔 ${String(gap).padStart(4)} ms → `
    + `第一个 ${a.ok ? 'ok' : `失败(${a.why})`} ${String(a.ms).padStart(4)}ms/${a.audio}帧  |  `
    + `第二个 ${b.ok ? 'ok' : `失败(${b.why})`} ${String(b.ms).padStart(4)}ms/${b.audio}帧`,
  );
  if (!b.ok) {
    console.log(`    第二个 task 的回执：${b.receipts.map((r) => r.event).join(' → ')}`);
  }
  await sleep(1500);
}

ws.close();
process.exit(0);
