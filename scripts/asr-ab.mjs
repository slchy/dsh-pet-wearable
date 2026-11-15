/**
 * 同一段上行音频在 16 kHz / 8 kHz 两种采样率下的识别结果对比。
 *
 * 用途：判断降采样能不能让识别变好。2026-11-16 的结论是**不能**——
 * 8 kHz 会把一句切成两倍多的碎片，识别质量明显更差，因此发送端应保持 16 kHz。
 * （早期一版注释写过「有效带宽只剩约 2 kHz、>2 kHz 能量占 2.6%」，那是拿
 *  能量占比当带宽指标得出的错误结论；逐频段实测显示 7.8 kHz 才跌破 −40 dB。）
 *
 *   node scripts/asr-ab.mjs <pcm16> [--secs 60] [--rate 2] [--skip 0]
 *
 *   --secs 截取音频长度（秒），默认全量
 *   --skip 从第几秒开始截，默认 0
 *   --rate 推送倍速，默认 2（太快会让 VAD 判停失真）
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const AK_ID = process.env['ALIYUN_AK_ID'];
const AK_SECRET = process.env['ALIYUN_AK_SECRET'];
const APPKEY = process.env['ALIYUN_APPKEY'];
const REGION = process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai';
const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';

/** 档案里的 uplink.pcm 一律是 16 kHz */
const SOURCE_RATE = 16_000;

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const pct = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20')
  .replace(/\*/g, '%2A')
  .replace(/%7E/g, '~');
const msgId = () => randomUUID().replace(/-/g, '');

async function createToken() {
  const params = {
    AccessKeyId: AK_ID,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: REGION,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const canonical = Object.keys(params).sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const signature = createHmac('sha1', `${AK_SECRET}&`)
    .update(`POST&${pct('/')}&${pct(canonical)}`).digest('base64');
  const res = await fetch(`https://nls-meta.${REGION}.aliyuncs.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${canonical}&Signature=${pct(signature)}`,
  });
  const text = await res.text();
  if (!res.ok) die(`CreateToken 失败：${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  if (!json.Token?.Id) die(`响应里没有 Token.Id：${text.slice(0, 300)}`);
  return json.Token.Id;
}

function resample(pcm, to) {
  if (to === SOURCE_RATE) return pcm;
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(SOURCE_RATE), '-ac', '1', '-i', 'pipe:0',
    '-f', 's16le', '-ar', String(to), '-ac', '1', 'pipe:1',
  ], { input: pcm, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) die(`重采样失败：${r.stderr?.toString().slice(0, 300)}`);
  return r.stdout;
}

/** 跑一次完整识别，返回 {sentences, partials, ms} */
function transcribe(pcm, rate, speed, token) {
  return new Promise((resolve) => {
    const chunkBytes = (rate * 2 * 100) / 1000;
    const url = `wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const sentences = [];
    const partials = new Set();
    let taskId = null;
    let done = false;
    const t0 = Date.now();

    const finish = () => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* 已关 */ }
      resolve({ sentences, partials: [...partials], ms: Date.now() - t0 });
    };

    ws.addEventListener('open', () => {
      taskId = msgId();
      ws.send(JSON.stringify({
        header: {
          appkey: APPKEY, message_id: msgId(), task_id: taskId,
          namespace: 'SpeechTranscriber', name: 'StartTranscription',
        },
        payload: {
          format: 'pcm',
          sample_rate: rate,
          enable_intermediate_result: true,
          enable_punctuation_prediction: true,
          enable_inverse_text_normalization: true,
        },
        context: { sdk: { name: 'nls-nodejs-sdk', version: '0.0.1', language: 'nodejs' } },
      }));
    });

    ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : ev.data.toString();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      const name = msg.header?.name;
      if (name === 'TranscriptionStarted') {
        if (msg.header?.task_id) taskId = msg.header.task_id;
        void pump();
        return;
      }
      if (name === 'TranscriptionResultChanged') {
        const r = msg.payload?.result;
        if (r) partials.add(r);
        return;
      }
      if (name === 'SentenceEnd') {
        const r = msg.payload?.result;
        if (r) sentences.push(r);
        return;
      }
      if (name === 'TranscriptionCompleted') {
        setTimeout(finish, 200);
      }
    });

    ws.addEventListener('error', () => finish());
    ws.addEventListener('close', () => finish());

    async function pump() {
      const gap = (chunkBytes / (rate * 2) * 1000) / speed;
      for (let off = 0; off < pcm.length; off += chunkBytes) {
        if (ws.readyState !== 1) break;
        ws.send(pcm.subarray(off, Math.min(off + chunkBytes, pcm.length)));
        await new Promise((r) => setTimeout(r, gap));
      }
      if (ws.readyState !== 1) return finish();
      ws.send(JSON.stringify({
        header: {
          appkey: APPKEY, message_id: msgId(),
          ...(taskId ? { task_id: taskId } : {}),
          namespace: 'SpeechTranscriber', name: 'StopTranscription',
        },
      }));
      setTimeout(finish, 8000);
    }

    setTimeout(() => {
      console.error(`  [${rate}] 超时强制结束`);
      finish();
    }, (pcm.length / (rate * 2) / speed) * 1000 + 30_000);
  });
}

async function main() {
  const path = process.argv[2];
  if (!path || !existsSync(path)) die('用法: node scripts/asr-ab.mjs <pcm16> [--secs N] [--rate X] [--skip S]');
  if (!AK_ID || !AK_SECRET || !APPKEY) die('缺少 ALIYUN_AK_ID / ALIYUN_AK_SECRET / ALIYUN_APPKEY');

  const argOf = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? Number(process.argv[i + 1]) : dflt;
  };
  const speed = argOf('--rate', 2) || 2;
  const skip = argOf('--skip', 0) || 0;
  const secs = argOf('--secs', 0) || 0;

  const all = readFileSync(path);
  const total = all.length / (SOURCE_RATE * 2);
  const from = Math.min(skip, total) * SOURCE_RATE * 2;
  const to = secs > 0 ? Math.min(from + secs * SOURCE_RATE * 2, all.length) : all.length;
  const pcm = all.subarray(from, to);
  console.log(`音频 ${path}`);
  console.log(`  截取 ${skip}s 起 ${(pcm.length / (SOURCE_RATE * 2)).toFixed(1)}s（原 ${total.toFixed(1)}s），推送 ${speed}x\n`);

  const token = await createToken();

  const runs = [];
  for (const rate of [SOURCE_RATE, 8000]) {
    const resampled = resample(pcm, rate);
    process.stdout.write(`[${rate} Hz] 识别中…`);
    const r = await transcribe(resampled, rate, speed, token);
    console.log(` 完成 ${(r.ms / 1000).toFixed(1)}s，${r.sentences.length} 句`);
    runs.push({ rate, ...r });
  }

  console.log('\n============================================================');
  for (const r of runs) {
    console.log(`\n▼ ${r.rate} Hz   ${r.sentences.length} 句`);
    r.sentences.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s}`));
  }

  const outPath = path.replace(/\.pcm$/, '') + `.asr-ab-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(runs, null, 2));
  console.log(`\n明细已写入 ${outPath}`);
}

void main();
