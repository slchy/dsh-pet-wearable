/**
 * 单轮延迟复盘：起一个生产形态的服务端，喂一句合成语音，读档案里的时间线。
 *
 * 分段口径（与 `bench/tau2/segment_split.py` 一致）：
 *   ① gate.close → asr.sentence   （说完→ASR 定稿）
 *   ② asr.sentence → turn.start   （定稿→开轮）
 *   ③ turn.start → tts.first      （开轮→TTS 首块；其中 llm.first 是模型首字）
 *
 * 为什么要自己起：本地没有 turn_judge 侧车，判停会退回固定窗口（600 ms），
 * 所以 ② 只作参考；① 和 ③ 的口径与服务端一致，可用于定位。
 *
 * 跑法：node bench/latency/probe-single-turn.mjs [--repeats 3] [--pipeline cascade|live]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 仓根：脚本在 bench/latency/ 下 */
const REPO = resolve(import.meta.dirname, '..', '..');

for (const line of readFileSync(join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m !== null && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const REPEATS = Number(process.argv[process.argv.indexOf('--repeats') + 1] ?? 3) || 3;

function argvValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

const pipelineSpecified = process.argv.includes('--pipeline');
const pipelineArg = argvValue('--pipeline');
const pipeline = pipelineSpecified ? pipelineArg : 'cascade';
if (pipeline !== 'cascade' && pipeline !== 'live') {
  console.error(`--pipeline 只允许 cascade 或 live（收到 ${pipeline === undefined ? '(缺值)' : pipeline}）`);
  process.exit(1);
}
/** live 必须走 qwen-realtime；cascade 保持原来的阿里云 NLS */
const stt = pipeline === 'live' ? 'qwen-realtime' : 'aliyun';

const PORT = 8771;
const ARCHIVE = join(REPO, '.probe-archive');

// ---- 合成一句"用户说话"（用 TTS 造上行，与真机无关，只为可复算）
const { cosyVoiceTts } = await import(pathToFileURL(join(REPO, 'src', 'cosyvoice.ts')).href);
const tts = cosyVoiceTts({});
const SAY = '帮我看一下现在几点了。';

async function speech16k() {
  const chunks = [];
  for await (const c of tts.synthesize(SAY)) chunks.push(c);
  const src = Buffer.concat(chunks);
  const from = tts.sampleRate;
  const to = 16_000;
  const n = Math.floor((src.length / 2) * (to / from));
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const pos = i * (from / to);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length / 2 - 1);
    const f = pos - i0;
    const s0 = src.readInt16LE(i0 * 2);
    const s1 = src.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * f), i * 2);
  }
  return out;
}

// ---- 起服务端
if (existsSync(ARCHIVE)) rmSync(ARCHIVE, { recursive: true, force: true });
mkdirSync(ARCHIVE, { recursive: true });

const server = spawn(process.execPath, [
  'src/main.ts', '--listen', String(PORT), '--host', '127.0.0.1',
  '--stt', stt, '--tts', 'cosyvoice', '--agent', 'dsh', '--dsh-sdk',
  '--work-dir', REPO,
], {
  env: {
    ...process.env,
    MIAI_LOG_TS: '1',
    MIAI_ARCHIVE_DIR: ARCHIVE,
    MIAI_ARCHIVE_KEEP: '50',
    COSYVOICE_TRACE: '1',
    VOICE_PIPELINE: pipeline,
    // .env 若配成 Pure Live，显式 cascade 仍可能被 OMNI_SHADOW / OMNI_ANSWER 带偏
    ...(pipeline === 'cascade' ? { OMNI_SHADOW: '', OMNI_ANSWER: 'off' } : {}),

    // Windows 上 npm 的 .ps1/.cmd 垫片不是可执行映像，必须指到 .cmd。
    // 路径因人而异，不写死：没设 DSH_BIN 就按 PATH 找（npm 全局 bin 通常在 PATH 里）。
    DSH_BIN: process.env['DSH_BIN'] ?? 'dsh.cmd',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d.toString(); });
server.stderr.on('data', (d) => { serverOut += d.toString(); });

const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return false;
};

if (!await waitFor(() => serverOut.includes(`监听 tcp://127.0.0.1:${PORT}`), 30_000)) {
  console.error('服务端没起来：\n' + serverOut.slice(-2000));
  server.kill();
  process.exit(1);
}
console.log(`服务端就绪（pid ${server.pid}）\n`);

// ---- 上游：Hello + 一句语音
const H = 5;
const frame = (t, p) => { const o = Buffer.alloc(H + p.length); o[0] = t; o.writeUInt32LE(p.length, 1); p.copy(o, H); return o; };

const pcm = await speech16k();
// 尾部补静音：ASR 靠「静音」断句，只发语音不发尾巴它永远不出 SentenceEnd
const TAIL_MS = 1200;
const tail = Buffer.alloc(16_000 * 2 * TAIL_MS / 1000);
const uplink = Buffer.concat([pcm, tail]);
console.log(`上行 ${SAY}（${(pcm.length / 32).toFixed(0)} ms）+ 尾静音 ${TAIL_MS} ms\n`);

async function oneTurn(n) {
  const before = existsSync(ARCHIVE) ? readdirSync(ARCHIVE).length : 0;
  await new Promise((resolve) => {
    // CLI 的 --listen 是裸 TCP；WS 只有包② 的桥才有
    const sock = netConnect({ host: '127.0.0.1', port: PORT });
    let got = 0;
    let stop = false;
    let lastAudioAt = 0;
    let buffered = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(frame(6, Buffer.from(JSON.stringify({
        proto: 2, deviceId: 'probe-turn',
        capabilities: { audioIn: 'pcm16', capture: {}, presence: false, power: false, summon: false, listenStart: false, played: false, ignorePhrases: [] },
      }))));
      let off = 0;
      const timer = setInterval(() => {
        if (stop || off >= uplink.length) { clearInterval(timer); return; }
        sock.write(frame(1, uplink.subarray(off, off + 640)));
        off += 640;
      }, 20);
    });
    sock.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= H) {
        const t = buffered[0];
        const len = buffered.readUInt32LE(1);
        if (buffered.length < H + len) break;
        buffered = buffered.subarray(H + len);
        if (t === 1) {
          got += len;
          lastAudioAt = Date.now();
        }
      }
      // 等它真的说完：连续 3 s 没有新的下行音频才收摊（回执之后还有正文）
      if (got > 0 && !stop) {
        const sinceLast = Date.now() - lastAudioAt;
        if (sinceLast > 3000) {
          stop = true;
          try { sock.destroy(); } catch { /* */ }
          resolve();
        }
      }
    });
    sock.on('error', () => resolve());
    // 静默判定要定时检查：没有新数据时不会触发 'data'
    const idle = setInterval(() => {
      if (stop) { clearInterval(idle); return; }
      if (got > 0 && Date.now() - lastAudioAt > 3000) {
        stop = true;
        clearInterval(idle);
        try { sock.destroy(); } catch { /* */ }
        resolve();
      }
    }, 250);
    setTimeout(() => {
      stop = true;
      clearInterval(idle);
      try { sock.destroy(); } catch { /* */ }
      resolve();
    }, 40_000);
  });
  // 等档案落盘
  await new Promise((r) => { setTimeout(r, 800); });
  return before;
}

const results = [];
for (let i = 1; i <= REPEATS; i += 1) {
  const before = await oneTurn(i);
  const dirs = readdirSync(ARCHIVE).sort();
  const dir = dirs[dirs.length - 1];
  if (dir === undefined) { console.log(`第 ${i} 轮：没有档案`); continue; }
  const evPath = join(ARCHIVE, dir, 'events.jsonl');
  if (!existsSync(evPath)) { console.log(`第 ${i} 轮：没有 events.jsonl`); continue; }
  const events = readFileSync(evPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // 档案的事件名在 `ev` 字段（`{t, ev, at, ...}`）。这里原来找的是
  // `event`/`type`/`e`，一个都命中不了，于是每一项都印成「—」—— 看着像"没仪表"，
  // 其实仪表齐全。别按名字猜，照 `events.ts` 的写法读。
  const at = (name) => {
    const e = events.find((x) => x.ev === name);
    return e?.t ?? null;
  };
  const gate = at('gate.close');
  const asr = at('asr.sentence');
  const turn = at('turn.start');
  const llm = at('llm.first');
  const ttsFirst = at('tts.first');
  // 停嘴时刻要用 `gate.close - gapMs` 还原：`gate.close` 是在静音窗口走满之后才写的，
  // 它减掉 `holdMs` 也不等于停嘴（真机实测窗口能被拉长到 2 s 以上）。
  const gateEvent = events.find((x) => x.ev === 'gate.close');
  const stoppedAt = gate === null ? null : gate - Number(gateEvent?.gapMs ?? 0);
  const f = (v) => (v === null ? '  —' : String(Math.round(v)).padStart(4));
  console.log(
    `第 ${i} 轮  ${dir}\n`
    + `  ① 说完→定稿 ${f(asr !== null && stoppedAt !== null ? asr - stoppedAt : null)} ms   `
    + `② 定稿→开轮 ${f(turn !== null && asr !== null ? turn - asr : null)} ms   `
    + `③ 开轮→首块 ${f(ttsFirst !== null && turn !== null ? ttsFirst - turn : null)} ms`
    + `  （模型首字 ${f(llm !== null && turn !== null ? llm - turn : null)} ms）`,
  );
  results.push({
    a1: asr - stoppedAt,
    a2: turn - asr,
    a3: ttsFirst - turn,
    llm: llm - turn,
  });
  if (before + 1 > 4 && i < REPEATS) {
    // 会话已建立，下一轮直接复用；这里只留在同一连接外，简化处理
  }
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
if (results.length > 0) {
  console.log(
    `\n中位  ① ${med(results.map((r) => r.a1))} ms   ② ${med(results.map((r) => r.a2))} ms   `
    + `③ ${med(results.map((r) => r.a3))} ms   其中模型首字 ${med(results.map((r) => r.llm))} ms`,
  );
}

console.log('--- 服务端日志尾部 ---');
console.log(serverOut.split('\n').slice(-30).join('\n'));
server.kill();
await new Promise((r) => { setTimeout(r, 500); });
process.exit(0);


