#!/usr/bin/env node
/**
 * 用真机 `uplink.pcm` 按实时速度喂 qwen3-asr-flash-realtime，量「静音窗」的实际代价。
 *
 * 口径：**真停嘴 → 定稿**。真停嘴用能量门（−40 dBFS / 20 ms 帧）从 PCM 复算，
 * 不依赖服务端 `speech_stopped`（它本身就已经带着静音窗）。
 *
 *   node bench/latency/probe-realtime-asr-turn.mjs --pcm tmp/rt-archive/uplink.pcm \
 *        --from 2 --to 12 --silence 800,200,150,100
 *
 * `--dump` 只连一次，把 `session.created` 的完整字段打出来（看 schema）。
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

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const MODEL = arg('model', 'qwen3-asr-flash-realtime');
const HOST = arg('host', 'wss://dashscope.aliyuncs.com');
const PCM_PATH = arg('pcm', '');
const FROM_S = Number(arg('from', '0'));
const TO_S = Number(arg('to', '12'));
const SILENCES = arg('silence', '800,200,150,100').split(',').map(Number);
const THRESHOLD = arg('threshold', '');
// 档案是放大前的 PCM；真实上行是 micGain 放大后的。不补回这个增益，
// 服务端 VAD（按振幅算）会听不见轻声，测出来的「停嘴」对不上真机。
const GAIN = Number(arg('gain', '4'));
// 手动模式：不给 turn_detection，自己在「真停嘴 + offset」发 commit（文档里的 Manual 模式）
const MANUAL_OFFSET = arg('manual', '');
const SAMPLE_RATE = 16_000;
const CHUNK_MS = Number(arg('chunk', '100'));
const ENERGY_DBFS = -40; // 补偿增益后按生产门槛算
const MIN_SILENCE_MS = 300;

const KEY = envFromDotenv('DASHSCOPE_API_KEY');
if (!KEY) {
  console.error('需要 DASHSCOPE_API_KEY（环境变量或 .env）');
  process.exit(1);
}
const URL = `${HOST}/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;

// ---------- PCM 真停嘴 ----------
function speechEnds(buf) {
  const frame = (SAMPLE_RATE * 20) / 1000 * 2; // 640 B = 20 ms
  const frames = Math.floor(buf.length / frame);
  const loud = [];
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = 0; j < frame; j += 2) {
      const v = buf.readInt16LE(i * frame + j) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (frame / 2));
    loud.push(20 * Math.log10(Math.max(rms, 1e-9)) >= ENERGY_DBFS);
  }
  const ends = [];
  const need = Math.ceil(MIN_SILENCE_MS / 20);
  for (let i = 0; i < frames; i++) {
    if (!loud[i]) continue;
    let quiet = 0;
    while (i + 1 + quiet < frames && !loud[i + 1 + quiet]) quiet++;
    if (quiet >= need && (ends.length === 0 || (i + 1) * 20 > ends[ends.length - 1])) {
      ends.push((i + 1) * 20);
    }
    i += quiet;
  }
  return ends;
}

// ---------- 一条会话 ----------
function runSession(pcm, silenceMs) {
  return new Promise((done) => {
    const t0 = Date.now();
    const events = [];
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    let interval = null;
    let pos = 0;
    const stop = () => {
      if (interval) clearInterval(interval);
      interval = null;
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
        done(events);
      }, 2500); // 尾巴留 2.5 s：看它会不会晚到
    };

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            turn_detection: MANUAL_OFFSET === '' ? { type: 'server_vad', silence_duration_ms: silenceMs, ...(THRESHOLD ? { threshold: Number(THRESHOLD) } : {}) } : null,
          },
        }),
      );
    });

    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      const ms = Date.now() - t0;
      switch (ev.type) {
        case 'session.created':
        case 'session.updated':
          events.push({ ms, type: ev.type, td: ev.session?.turn_detection });
          // updated 可能不来（字段被拒时只有 error），created 后 600 ms 兜底开流
          if (ev.type === 'session.updated') startStream();
          else setTimeout(() => { if (interval === null) startStream(); }, 600);
          break;
        case 'input_audio_buffer.speech_started':
        case 'input_audio_buffer.speech_stopped':
          events.push({ ms, type: ev.type });
          break;
        case 'conversation.item.input_audio_transcription.delta':
        case 'conversation.item.input_audio_transcription.text':
        case 'conversation.item.input_audio_transcription.completed':
          events.push({ ms, type: ev.type, text: ev.transcript ?? ev.text ?? ev.delta });
          break;
        case 'error':
          events.push({ ms, type: 'error', text: ev.error?.message ?? JSON.stringify(ev).slice(0, 200) });
          console.error(`  [error @${ms}ms] ${ev.error?.message ?? JSON.stringify(ev).slice(0, 200)}`);
          if (interval === null) stop();
          break;
        default:
          break;
      }
    });

    ws.on('error', (e) => {
      events.push({ ms: Date.now() - t0, type: 'ws-error', text: e.message });
      stop();
    });

    function startStream() {
      const perChunk = (SAMPLE_RATE * CHUNK_MS) / 1000 * 2;
      const commitAt = MANUAL_OFFSET === '' ? [] : ends.map((e) => e + Number(MANUAL_OFFSET));
      interval = setInterval(() => {
        const audioMs = ((pos / 2) * 1000) / SAMPLE_RATE;
        while (commitAt.length > 0 && audioMs >= commitAt[0]) {
          commitAt.shift();
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          events.push({ ms: Date.now() - t0, type: 'client.commit', text: `audio=${Math.round(audioMs)}ms` });
        }
        if (pos >= pcm.length) return stop();
        const slice = pcm.subarray(pos, pos + perChunk);
        pos += perChunk;
        ws.send(
          JSON.stringify({ type: 'input_audio_buffer.append', audio: slice.toString('base64') }),
        );
      }, CHUNK_MS);
    }

    setTimeout(() => {
      if (interval) stop();
    }, (TO_S - FROM_S) * 1000 + 12_000);
  });
}

// ---------- main ----------
if (!PCM_PATH) {
  console.error('需要 --pcm <uplink.pcm>');
  process.exit(1);
}
const filePcm = readFileSync(PCM_PATH);
const slice = Buffer.from(filePcm.subarray(FROM_S * SAMPLE_RATE * 2, TO_S * SAMPLE_RATE * 2));
for (let i = 0; i + 1 < slice.length; i += 2) {
  const v = slice.readInt16LE(i) * GAIN;
  slice.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i);
}
const ends = speechEnds(slice);
console.log(`模型 ${MODEL}`);
console.log(`音频 ${FROM_S}s–${TO_S}s（${(slice.length / (SAMPLE_RATE * 2)).toFixed(1)} s），能量门复算真停嘴 ${ends.length} 处：${ends.join(' / ')} ms\n`);

if (hasFlag('dump')) {
  const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text'], input_audio_format: 'pcm16' } })));
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === 'session.created') {
      console.log('session.created 完整字段：');
      console.log(JSON.stringify(ev.session, null, 2));
      ws.close();
      process.exit(0);
    }
  });
} else {
  console.log('静音窗 | 生效 | 定稿(t) | 真停嘴→定稿 | VAD停 | 解码 | 文本');
  for (const ms of SILENCES) {
    const events = await runSession(slice, ms);
    if (hasFlag('verbose')) {
      console.log(`\n--- silence=${ms} 事件时间线 ---`);
      for (const e of events) {
        console.log(`  ${String(e.ms).padStart(6)}ms  ${e.type}${e.td ? `  silence=${e.td.silence_duration_ms}` : ''}${e.text ? `  ${e.text}` : ''}`);
      }
    }
    const effective = events.find((e) => e.type === 'session.updated')?.td?.silence_duration_ms;
    const dones = events.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed');
    if (dones.length === 0) {
      const err = events.find((e) => e.type === 'error');
      console.log(`${String(ms).padStart(6)} | ${String(effective ?? '?').padStart(4)} | 无定稿${err ? `（${err.text}）` : ''}`);
      continue;
    }
    for (const d of dones) {
      const speechStop = [...ends].reverse().find((e) => e < d.ms);
      const lag = speechStop === undefined ? '?' : `${d.ms - speechStop}`;
            const vad = events.filter((e) => e.type === 'input_audio_buffer.speech_stopped' && e.ms < d.ms).pop();
      const cm = events.filter((e) => e.type === 'client.commit' && e.ms < d.ms).pop();
            const decode = cm ? `cm+${d.ms - cm.ms}` : vad ? `${d.ms - vad.ms}` : '?';
            console.log(
              `${String(ms).padStart(6)} | ${String(effective ?? '?').padStart(4)} | ${String(d.ms).padStart(7)} | ${String(lag).padStart(11)} | ${String(vad?.ms ?? '-').padStart(7)} | ${String(decode).padStart(6)} | ${d.text}`,
            );
    }
  }
}
