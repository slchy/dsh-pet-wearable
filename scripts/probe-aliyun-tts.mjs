/**
 * 探针：阿里云 NLS **流式合成**（SpeechSynthesizer）的首包延迟。
 *
 * 为什么单独测它：MiMo TTS 首包实测 570–1040 ms（走 chat/completions，是结构性的），
 * 业界流式 TTS 是 100–200 ms。要判断换供应商值不值，得先有自己测出来的数字。
 *
 * 前置：账号需已开通「智能语音交互 → 语音合成」。ASR 能跑**不代表** TTS 能用，
 * 它们是两个独立服务；没开通会拿到 `Gateway:FREE_TRIAL_EXPIRED`。
 *
 * 用法（仓库根目录）：
 *   set -a; . .env; set +a
 *   MIAI_REPO=$PWD node scripts/probe-aliyun-tts.mjs
 *
 * 协议要点（踩过的坑）：
 * - `message_id` / `task_id` 必须是 **32 位无横线** 的十六进制；`randomUUID()`
 *   默认带横线，直接送会被拒：`Gateway:MESSAGE_INVALID:Invalid message id '...'`
 * - 音频是 WebSocket **二进制**帧，`SynthesisCompleted` 是文本帧
 */
import { randomUUID } from 'node:crypto';

const REPO = process.env['MIAI_REPO'] ?? process.cwd();
const { createToken } = await import(`${REPO}/src/aliyun-asr.ts`);

const REGION = process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai';
const APPKEY = process.env['ALIYUN_APPKEY'] ?? '';
const VOICE = process.env['ALIYUN_TTS_VOICE'] ?? 'xiaoyun';
const TEXT = process.env['ALIYUN_TTS_TEXT'] ?? '哥，这件事我查了一下，大概是这样。';
const ROUNDS = Number(process.env['ALIYUN_TTS_ROUNDS'] ?? 5);

const hex32 = () => randomUUID().replace(/-/g, '');

interface ProbeResult {
  firstAudioMs: number;
  bytes: number;
  note: string;
}

async function once(token: string): Promise<ProbeResult> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(
      `wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1?token=${encodeURIComponent(token)}`,
    );
    const started = Date.now();
    let firstAudioMs = -1;
    let bytes = 0;
    let note = '';
    let settled = false;

    const finish = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经关了 */ }
      resolve({ firstAudioMs, bytes, note: note || why });
    };
    const timer = setTimeout(() => finish('timeout'), 15_000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        header: {
          message_id: hex32(),
          task_id: hex32(),
          namespace: 'SpeechSynthesizer',
          name: 'StartSynthesis',
          appkey: APPKEY,
        },
        payload: {
          format: 'pcm',
          sample_rate: 24_000,
          voice: VOICE,
          text: TEXT,
        },
      }));
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { header?: { name?: string; status_text?: string } };
        const name = message.header?.name;
        if (name === 'TaskFailed') {
          note = String(message.header?.status_text ?? '').slice(0, 160);
          finish('failed');
        } else if (name === 'SynthesisCompleted') {
          finish('completed');
        }
        return;
      }
      const chunk = Buffer.from(event.data as ArrayBuffer);
      if (chunk.length === 0) return;
      if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
      bytes += chunk.length;
    });

    ws.addEventListener('error', () => { note = 'ws-error'; finish('error'); });
  });
}

const token = await createToken(
  process.env['ALIYUN_AK_ID'] ?? '',
  process.env['ALIYUN_AK_SECRET'] ?? '',
  REGION,
);

const results: ProbeResult[] = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const result = await once(token.id);
  results.push(result);
  console.log(`第 ${i} 次: firstAudio=${result.firstAudioMs} ms  bytes=${result.bytes}  ${result.note}`);
  await new Promise((r) => { setTimeout(r, 600); });
}

const ok = results.filter((r) => r.firstAudioMs >= 0).map((r) => r.firstAudioMs).sort((a, b) => a - b);
if (ok.length === 0) {
  console.log('\n全部失败，没有可比数字。常见原因：TTS 服务未开通（FREE_TRIAL_EXPIRED）、appkey 不属于该项目。');
} else {
  const median = ok[Math.floor(ok.length / 2)];
  console.log(`\n首包：${ok.join(' / ')} ms   中位 ${median} ms`);
}
process.exit(0);
