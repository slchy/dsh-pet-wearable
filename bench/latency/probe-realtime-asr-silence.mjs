#!/usr/bin/env node
/**
 * 探「realtime 协议」的静音窗到底能不能自己调。
 *
 * NLS（run-task）的 `max_sentence_silence` 官方范围 200–6000，200 就是地板；
 * 而 OpenAI 风格的 `/api-ws/v1/realtime` 把静音窗放在
 * `session.update.turn_detection.silence_duration_ms`，是客户端报的 VAD 参数。
 *
 * 这个探针只做一件事：把各种值发上去，读回 `session.updated` 里
 * **服务端实际生效**的值 —— 被夹到 200 就说明有地板，原样回来就说明是自由的。
 *
 * 注意：一个连接只能收一次 update（之后 session 已 start，会回
 * `session already started or finished or failed`），所以**每个值单开一条连接**。
 *
 *   node bench/latency/probe-realtime-asr-silence.mjs
 *   node bench/latency/probe-realtime-asr-silence.mjs --model qwen-audio-3.1-realtime-flash
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function envFromDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const text = readFileSync(resolve(ROOT, '.env'), 'utf8');
    const hit = text.split(/\r?\n/).find((l) => l.trim().startsWith(`${name}=`));
    return hit ? hit.slice(hit.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

const argModel = (() => {
  const i = process.argv.indexOf('--model');
  return i > 0 ? process.argv[i + 1] : 'qwen3-asr-flash-realtime';
})();

const HOST = process.env.REALTIME_HOST ?? 'wss://dashscope.aliyuncs.com';
const URL = `${HOST}/api-ws/v1/realtime?model=${encodeURIComponent(argModel)}`;
const KEY = envFromDotenv('DASHSCOPE_API_KEY');

const PROBE_VALUES = [800, 500, 200, 150, 100, 50, 0];

if (!KEY) {
  console.error('需要 DASHSCOPE_API_KEY（环境变量或 .env）');
  process.exit(1);
}

function describe(td) {
  if (td === null) return 'null';
  if (td === undefined) return '(缺字段)';
  return `type=${td.type} silence=${td.silence_duration_ms ?? '(缺)'} threshold=${td.threshold ?? '(缺)'}`;
}

/** 单开一条连接，发一次 update，把回执里生效的值打出来。 */
function probeOnce(patch, label) {
  return new Promise((done) => {
    const t0 = Date.now();
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const finish = (text) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      done(`${label.padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ${text}`);
    };
    const timer = setTimeout(() => finish('超时（10s 无回执）'), 10_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session: patch }));
    });
    ws.on('error', (e) => finish(`连接错误: ${e.message}`));
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === 'session.updated') return finish(`生效 → ${describe(ev.session?.turn_detection)}`);
      if (ev.type === 'session.created') return; // 默认值，参考用；继续等 update 回执
      if (ev.type === 'error') {
        const e = ev.error ?? ev;
        return finish(`拒收 → ${e.code ?? ''} ${e.message ?? JSON.stringify(ev).slice(0, 160)}`);
      }
    });
  });
}

console.log(`模型 ${argModel}`);
console.log(`端点 ${URL}\n`);

const rows = [];
for (const v of PROBE_VALUES) {
  rows.push(
    await probeOnce({ turn_detection: { type: 'server_vad', silence_duration_ms: v } }, `silence_duration_ms=${v}`),
  );
}
rows.push(
  await probeOnce(
    { turn_detection: { type: 'server_vad', silence_duration_ms: 150, threshold: 0.5 } },
    'silence=150 threshold=0.5',
  ),
);
rows.push(await probeOnce({ turn_detection: null }, 'turn_detection=null'));
rows.push(await probeOnce({ turn_detection: { type: 'semantic_vad' } }, 'type=semantic_vad'));

console.log(rows.join('\n'));
