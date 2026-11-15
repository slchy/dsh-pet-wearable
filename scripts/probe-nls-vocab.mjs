/**
 * 探测 SpeechTranscriber 是否真的在解码时使用 customization_id / vocabulary_id。
 *
 * 只看到 TranscriptionStarted 不够：词表往往到**解码时**才查。所以必须真推音频对比：
 *   - 都不带      -> 正常出 SentenceEnd
 *   - 带 ID       -> 看三组结果有无区别
 *
 * ⚠️ 判读限制（我踩过这个坑）：**传假 ID 得到三组相同结果，不能证明字段不被支持**。
 * 功能未开通 / ID 不存在时，服务端静默忽略是常见行为。要证明字段生效，必须：
 *   1. 先在控制台建一个**真词表**，拿到真 ID；
 *   2. 用同一段含目标词的音频，带 / 不带真 ID 各跑一遍；
 *   3. 只有"带词表时该词被纠对"才算闭环。
 * 本脚本适合做第 2 步的 A/B，不适合拿假 ID 得出结论。
 *
 *   ALIYUN_AK_ID=... ALIYUN_AK_SECRET=... ALIYUN_APPKEY=... \
 *     node scripts/probe-nls-vocab.mjs <pcm16> [起始秒] [时长秒] [倍速]
 */
import { createHmac, randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const AK_ID = process.env['ALIYUN_AK_ID'];
const AK_SECRET = process.env['ALIYUN_AK_SECRET'];
const APPKEY = process.env['ALIYUN_APPKEY'];
const REGION = process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai';
const SRC = process.argv[2];
const FROM = Number(process.argv[3] ?? 20);
const SECS = Number(process.argv[4] ?? 6);
/** 推送倍速：1 = 实时，4 = 四倍速。默认 4。 */
const SPEED = Number(process.argv[5] ?? 4);

const pct = (s) => encodeURIComponent(s)
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
const hex32 = () => randomUUID().replace(/-/g, '');

async function token() {
  const params = {
    AccessKeyId: AK_ID, Action: 'CreateToken', Format: 'JSON', RegionId: REGION,
    SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(),
    SignatureVersion: '1.0', Version: '2019-02-28',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const canonical = Object.keys(params).sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const sig = createHmac('sha1', `${AK_SECRET}&`)
    .update(`POST&${pct('/')}&${pct(canonical)}`).digest('base64');
  const res = await fetch(`https://nls-meta.${REGION}.aliyuncs.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${canonical}&Signature=${pct(sig)}`,
  });
  return JSON.parse(await res.text()).Token.Id;
}

function slice(path, fromSec, secs) {
  const size = statSync(path).size;
  const start = Math.min(Math.floor(fromSec * 16000) * 2, size);
  const len = Math.min(Math.floor(secs * 16000) * 2, size - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  readSync(fd, buf, 0, len, start);
  closeSync(fd);
  return buf;
}

const TK = await token();
const PCM = slice(SRC, FROM, SECS);
console.log(`音频 ${SRC} 取 ${FROM}s 起 ${(PCM.length / 32000).toFixed(1)}s\n`);

function run(extraPayload, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1?token=${encodeURIComponent(TK)}`);
    const sentences = [];
    let tid = hex32();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* 已关 */ }
      resolve({ sentences, label });
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        header: {
          appkey: APPKEY, message_id: hex32(), task_id: tid,
          namespace: 'SpeechTranscriber', name: 'StartTranscription',
        },
        payload: {
          format: 'pcm', sample_rate: 16000,
          enable_intermediate_result: true,
          enable_punctuation_prediction: true,
          ...extraPayload,
        },
        context: { sdk: { name: 'nls-nodejs-sdk', version: '0.0.1', language: 'nodejs' } },
      }));
    });

    ws.addEventListener('message', (ev) => {
      const t = typeof ev.data === 'string' ? ev.data : ev.data.toString();
      let m;
      try { m = JSON.parse(t); } catch { return; }
      const name = m.header?.name;
      if (name === 'TranscriptionStarted') {
        // 按 SPEED 倍速推送：每 100 ms 音频对应 100/SPEED ms 真实时间
        const chunk = 3200; // 100 ms
        let off = 0;
        const gap = Math.round(100 / SPEED);
        const tick = () => {
          if (ws.readyState !== 1) return finish();
          if (off >= PCM.length) {
            ws.send(JSON.stringify({
              header: {
                appkey: APPKEY, message_id: hex32(), task_id: tid,
                namespace: 'SpeechTranscriber', name: 'StopTranscription',
              },
            }));
            setTimeout(finish, 4000);
            return;
          }
          ws.send(PCM.subarray(off, Math.min(off + chunk, PCM.length)));
          off += chunk;
          setTimeout(tick, gap);
        };
        tick();
        return;
      }
      if (name === 'SentenceEnd') {
        if (m.payload?.result) sentences.push(m.payload.result);
        return;
      }
      if (name === 'TaskFailed') {
        sentences.push('<<TaskFailed>> ' + (m.header?.status_text ?? ''));
        finish();
      }
    });
    ws.addEventListener('error', () => finish());
    ws.addEventListener('close', () => finish());
    setTimeout(finish, 25000);
  });
}

const FAKE = 'bogus-id-for-field-probe-9f8e7d6c';
/** 第 6 个参数传 only 时只跑 baseline，用来单独比推送速度 */
const ONLY = process.argv[6] === 'only';
const cases = ONLY
  ? [['baseline', {}]]
  : [
    ['baseline', {}],
    ['customization_id=假值', { customization_id: FAKE }],
    ['vocabulary_id=假值', { vocabulary_id: FAKE }],
  ];
const runs = [];
for (const [label, p] of cases) {
  process.stdout.write(`[${label}] 识别中…`);
  const r = await run(p, label);
  console.log(` ${r.sentences.length} 句`);
  runs.push(r);
}

console.log('\n=== 结果对比 ===');
runs.forEach((r) => {
  console.log(`\n▼ ${r.label}`);
  r.sentences.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
});

const [a, b, c] = runs.map((r) => r.sentences.join('|'));
if (runs.length === 3) {
  console.log('\n>>> baseline vs customization_id：' + (a === b ? '完全相同 → 字段被忽略' : '不同 → 字段有效'));
  console.log('>>> baseline vs vocabulary_id   ：' + (a === c ? '完全相同 → 字段被忽略' : '不同 → 字段有效'));
}
