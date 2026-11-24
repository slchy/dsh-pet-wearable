/**
 * 在服务器上用线上同一套 CosyVoice TTS 合成并固化评测语料（`eval-v1`）。
 *
 * 产物：`<outDir>/<caseId>.pcm`（16 kHz / mono / s16le）+ `<outDir>/corpus-meta.json`。
 *
 * 声学处理：
 * - CosyVoice 24 kHz 合成 → 裁掉句首尾数字静音（留 30 ms 保护边）
 * - `ffmpeg` 统一重采样到 16 kHz mono s16le
 * - 语音峰值归一化到 −22 dBFS（经服务端 `micGain=2.0` 后落在 −16 dBFS，贴近真机工作区）
 * - 句首（300 ms）、S4 句中停顿（精确 `pauseMs`）、句尾（1200 ms）垫确定性 −68 dBFS
 *   极低底噪（放 2× 后 −62 dBFS，低于 −46 dBFS 门限 16 dB，且避免全零让 log-mel 出 −∞）
 *
 * 用法：
 *   node bench/eval/synth-corpus.ts --env-file <部署路径>/.env --out-dir ~/miai-vectors-synth/eval-v1
 *   node bench/eval/synth-corpus.ts --offline --out-dir /tmp/eval-mock-corpus
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cosyVoiceTts } from '../../src/cosyvoice.ts';
import { isMainModule } from '../../src/main.ts';
import { pcm16PeakDbfs } from '../../src/pcm.ts';
import type { TtsProvider } from '../../src/providers.ts';
import type { CorpusItemMeta, CorpusMeta, EvalCase, EvalManifest } from './types.ts';

const TARGET_RATE = 16_000;
const BYTES_PER_MS = (TARGET_RATE * 2) / 1000;
const LEAD_NOISE_MS = 300;
const TAIL_NOISE_MS = 1200;
/** 放大前目标峰值（经 micGain=2.0 后落到 −16 dBFS） */
const TARGET_PEAK_DBFS = -22;
/** 确定性底噪幅值（≈ −68 dBFS，经 2× 增益仍低于 −46 dBFS 能量门 16 dB） */
const NOISE_AMPLITUDE = 13;

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? fallback) : fallback;
}

function loadEnvFile(path: string): void {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/** 确定性伪随机极低底噪（按 seed 复现，不依赖 Math.random） */
export function makeFloorNoise(ms: number, seedText: string): Buffer {
  const samples = Math.max(0, Math.round((ms * TARGET_RATE) / 1000));
  const out = Buffer.alloc(samples * 2);
  let s = 2166136261;
  for (let i = 0; i < seedText.length; i += 1) {
    s ^= seedText.charCodeAt(i);
    s = Math.imul(s, 16777619) >>> 0;
  }
  for (let i = 0; i < samples; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const unit = ((s >>> 16) / 32768) - 1;
    out.writeInt16LE(Math.round(unit * NOISE_AMPLITUDE), i * 2);
  }
  return out;
}

/** 离线冒烟用：生成可触发能量门的短正弦语音包（不调云端 API） */
function makeOfflineSpeech(text: string, voice: 'female' | 'male'): Buffer {
  const ms = Math.max(600, Math.min(3200, [...text].length * 140));
  const samples = Math.round((ms * TARGET_RATE) / 1000);
  const freq = voice === 'female' ? 320 : 180;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const env = Math.min(1, i / 160, (samples - i) / 160);
    const val = Math.sin((2 * Math.PI * freq * i) / TARGET_RATE) * 0.1 * 32767 * env;
    out.writeInt16LE(Math.round(val), i * 2);
  }
  return out;
}

/** 裁掉句首尾静音块（20 ms 窗口，低于 −52 dBFS 视为静音），两端保留 30 ms 保护边 */
export function trimSilence(pcm: Buffer, sampleRate: number): Buffer {
  const winBytes = Math.round((sampleRate * 2 * 20) / 1000);
  if (pcm.length <= winBytes * 4) return pcm;
  let first = -1;
  let last = -1;
  for (let off = 0; off + winBytes <= pcm.length; off += winBytes) {
    const db = pcm16PeakDbfs(pcm.subarray(off, off + winBytes));
    if (db > -52) {
      if (first < 0) first = off;
      last = off + winBytes;
    }
  }
  if (first < 0 || last <= first) return pcm;
  const pad = Math.round((sampleRate * 2 * 30) / 1000);
  const start = Math.max(0, first - pad) & ~1;
  const end = Math.min(pcm.length, last + pad) & ~1;
  return pcm.subarray(start, end);
}

/** 峰值归一化到目标 dBFS，并在低幅处混入确定性底噪避免数字全零 */
export function normalizeSpeech(pcm16k: Buffer, seedText: string): Buffer {
  const peakDb = pcm16PeakDbfs(pcm16k);
  const scale = Number.isFinite(peakDb) && peakDb > -70
    ? Math.pow(10, (TARGET_PEAK_DBFS - peakDb) / 20)
    : 1;
  const noise = makeFloorNoise(Math.ceil(pcm16k.length / BYTES_PER_MS), `${seedText}:bed`);
  const out = Buffer.alloc(pcm16k.length);
  for (let off = 0; off + 1 < pcm16k.length; off += 2) {
    const s = Math.round(pcm16k.readInt16LE(off) * scale) + (off + 1 < noise.length ? noise.readInt16LE(off) : 0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), off);
  }
  return out;
}

function resampleTo16k(pcm: Buffer, fromRate: number, ffmpegPath: string): Buffer {
  if (fromRate === TARGET_RATE) return pcm;
  return execFileSync(
    ffmpegPath,
    [
      '-loglevel', 'error',
      '-f', 's16le', '-ar', String(fromRate), '-ac', '1', '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(TARGET_RATE), '-ac', '1', 'pipe:1',
    ],
    { input: pcm, maxBuffer: 64 << 20 },
  );
}

async function synthClip(tts: TtsProvider, text: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tts.synthesize(text, 'calm')) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function probeVoice(apiKey: string, voice: string): Promise<TtsProvider | null> {
  const tts = cosyVoiceTts({ apiKey, voice, useInstruction: false });
  try {
    const buf = await synthClip(tts, '测试。');
    if (buf.length > 0) return tts;
  } catch (err) {
    console.warn(`[synth] 音色 ${voice} 探测失败（${(err as Error).message}），将回落默认音色`);
  }
  return null;
}

async function buildCasePcm(
  item: EvalCase,
  opts: {
    offline: boolean;
    ttsByVoice: { female: TtsProvider | null; male: TtsProvider | null };
    ffmpegPath: string;
  },
): Promise<Buffer> {
  const segments = item.parts !== undefined && item.parts.length > 0 ? item.parts : [item.text];
  const rendered: Buffer[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const text = segments[i] ?? '';
    let pcm16k: Buffer;
    if (opts.offline) {
      pcm16k = makeOfflineSpeech(text, item.voice);
    } else {
      const tts = opts.ttsByVoice[item.voice] ?? opts.ttsByVoice.female;
      if (tts === null) throw new Error('没有可用的 CosyVoice TTS 实例');
      const raw = await synthClip(tts, text);
      const trimmed = trimSilence(raw, tts.sampleRate);
      pcm16k = resampleTo16k(trimmed, tts.sampleRate, opts.ffmpegPath);
    }
    rendered.push(normalizeSpeech(pcm16k, `${item.id}:p${i}`));
    if (i + 1 < segments.length) {
      const gap = item.pauseMs ?? 500;
      rendered.push(makeFloorNoise(gap, `${item.id}:gap${i}`));
    }
  }

  return Buffer.concat([
    makeFloorNoise(LEAD_NOISE_MS, `${item.id}:lead`),
    ...rendered,
    makeFloorNoise(TAIL_NOISE_MS, `${item.id}:tail`),
  ]);
}

async function main(): Promise<void> {
  const manifestPath = resolve(arg('manifest', 'bench/eval/manifest.json'));
  const outDir = resolve(arg('out-dir', 'bench/eval/out/corpus'));
  const envFile = arg('env-file', '');
  const ffmpegPath = arg('ffmpeg', process.env['MIAI_FFMPEG'] ?? 'ffmpeg');
  const offline = process.argv.includes('--offline');
  const force = process.argv.includes('--force');
  const femaleVoice = arg('female-voice', 'longanhuan');
  const maleVoice = arg('male-voice', 'longanyang');

  if (envFile) loadEnvFile(resolve(envFile));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvalManifest;
  mkdirSync(outDir, { recursive: true });

  const metaPath = join(outDir, 'corpus-meta.json');
  const existingMeta = existsSync(metaPath) && !force
    ? (JSON.parse(readFileSync(metaPath, 'utf8')) as CorpusMeta)
    : null;

  let actualMaleVoice = maleVoice;
  const ttsByVoice: { female: TtsProvider | null; male: TtsProvider | null } = {
    female: null,
    male: null,
  };

  if (!offline) {
    const apiKey = (process.env['DASHSCOPE_API_KEY'] ?? '').trim();
    if (!apiKey) {
      console.error('缺少 DASHSCOPE_API_KEY（传 --env-file <路径> 或 --offline）');
      process.exit(2);
    }
    ttsByVoice.female = await probeVoice(apiKey, femaleVoice);
    if (ttsByVoice.female === null) {
      throw new Error(`主音色 ${femaleVoice} 不可用`);
    }
    ttsByVoice.male = await probeVoice(apiKey, maleVoice);
    if (ttsByVoice.male === null) {
      ttsByVoice.male = ttsByVoice.female;
      actualMaleVoice = femaleVoice;
    }
    console.log(`[synth] 音色就绪：female=${femaleVoice}  male=${actualMaleVoice}`);
  } else {
    actualMaleVoice = 'offline-male';
  }

  const allCases = manifest.sessions.flatMap((s) => s.cases);
  const items: Record<string, CorpusItemMeta> = {};
  let built = 0;
  let reused = 0;

  for (const c of allCases) {
    const fileName = `${c.id}.pcm`;
    const filePath = join(outDir, fileName);
    const prev = existingMeta?.items[c.id];
    if (!force && prev !== undefined && prev.text === c.text && prev.pauseMs === (c.pauseMs ?? null) && existsSync(filePath)) {
      items[c.id] = prev;
      reused += 1;
      continue;
    }

    const pcm = await buildCasePcm(c, { offline, ttsByVoice, ffmpegPath });
    writeFileSync(filePath, pcm);
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    const peakDbfs = Number(pcm16PeakDbfs(pcm).toFixed(1));
    const sha256 = createHash('sha256').update(pcm).digest('hex').slice(0, 16);
    const voiceName = offline
      ? `offline-${c.voice}`
      : (c.voice === 'female' ? femaleVoice : actualMaleVoice);

    items[c.id] = {
      id: c.id,
      file: fileName,
      voice: c.voice,
      voiceName,
      sampleRate: TARGET_RATE,
      bytes: pcm.length,
      durationMs,
      peakDbfs,
      pauseMs: c.pauseMs ?? null,
      sha256,
      text: c.text,
    };
    built += 1;
    console.log(
      `[synth] ${c.id.padEnd(12)} ${String(durationMs).padStart(5)} ms  peak=${peakDbfs.toFixed(1)} dBFS  ${voiceName}  ${c.text}`,
    );
  }

  const meta: CorpusMeta = {
    version: manifest.version,
    corpusName: manifest.corpusName,
    createdAt: new Date().toISOString(),
    sampleRate: TARGET_RATE,
    voices: {
      female: offline ? 'offline-female' : femaleVoice,
      male: actualMaleVoice,
    },
    items,
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`\n[synth] 完成：新建 ${built} 条，复用 ${reused} 条，总计 ${allCases.length} 条 → ${outDir}`);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[synth] 失败: ${(err as Error).message}`);
    process.exit(1);
  });
}
