#!/usr/bin/env node
/** 探三个客户端事件在这个协议里到底收不收：clear / commit 空缓冲 / finish。 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const key = (() => {
  const t = readFileSync(resolve(ROOT, '.env'), 'utf8');
  const hit = t.split(/\r?\n/).find((l) => l.trim().startsWith('DASHSCOPE_API_KEY='));
  return hit.slice(hit.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
})();

const URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime';
const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${key}` } });
const t0 = Date.now();
let step = 0;

const send = (obj, label) => {
  console.log(`→ ${label}`);
  ws.send(JSON.stringify(obj));
};

ws.on('open', () => {
  send({ type: 'session.update', session: { modalities: ['text'], turn_detection: null } }, 'session.update(turn_detection=null)');
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  const ms = Date.now() - t0;
  if (ev.type === 'session.updated') {
    console.log(`← ${ms}ms session.updated`);
    const idle = process.argv.indexOf('--idle');
    if (idle > 0) {
      const secs = Number(process.argv[idle + 1] ?? 75);
      console.log(`… 什么都不发，挂 ${secs}s 看连接会不会被服务端关掉`);
      ws.on('close', (code, why) => {
        console.log(`← 服务端关闭 code=${code} why=${why}  存活=${((Date.now() - t0) / 1000).toFixed(1)}s`);
        process.exit(0);
      });
      setTimeout(() => {
        console.log(`存活 ${secs}s 没被关（结论：无 IDLE 超时，或 > ${secs}s）`);
        process.exit(0);
      }, secs * 1000);
      return;
    }
    step = 1;
    send({ type: 'input_audio_buffer.clear' }, 'input_audio_buffer.clear（空缓冲）');
    setTimeout(() => {
      if (step !== 1) return;
      step = 2;
      send({ type: 'input_audio_buffer.commit' }, 'input_audio_buffer.commit（空缓冲）');
    }, 1200);
    setTimeout(() => {
      if (step !== 2) return;
      step = 3;
      send({ type: 'session.finish' }, 'session.finish');
    }, 2400);
    setTimeout(() => process.exit(step === 3 ? 9 : 0), 4000);
    return;
  }
  if (ev.type === 'error') {
    const e = ev.error ?? ev;
    console.log(`← ${ms}ms error  code=${e.code} msg=${e.message}`);
    if (e.code !== 'invalid_value') step = 99;
    return;
  }
  console.log(`← ${ms}ms ${ev.type} ${JSON.stringify(ev).slice(0, 140)}`);
});
ws.on('error', (e) => {
  console.error(`连接错误 ${e.message}`);
  process.exit(3);
});
