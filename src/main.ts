/**
 * 云端 harness（TS 版）：mSBC 流 → ffmpeg 解码 → silero-vad 判停 → MiMo ASR。
 *
 *   node src/main.ts --replay ../../tmp/voice_1793905201973.sbc
 *   node src/main.ts --listen 8765
 *
 * 与 Python 版（scripts/cloud_harness.py + webrtcvad）的差异：
 * - VAD 从 webrtcvad 换成 silero-vad（ONNX），实测能正确忽略远场回声
 * - 其余链路不变，判停口径仍以"静音 4 秒"为准
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { asr, pcmToWav, tts, TTS_SAMPLE_RATE } from './mimo.ts';
import { SileroVad, sliceFrames, SAMPLE_RATE, WINDOW } from './vad.ts';

/** 静音判停：4 秒 / 32 ms = 125 帧 */
const SILENCE_FRAMES = 125;
/** 标定值，见 src/vad.ts 顶部注释 */
const VAD_THRESHOLD = 0.4;
/** 单轮上限，防止设备一直推时无限累积 */
const MAX_UTTERANCE_SEC = 60;
const FRAME_BYTES = WINDOW * 2;

/** adb 目标设备，可用 ADB_SERIAL 覆盖 */
const ADB_SERIAL = process.env.ADB_SERIAL ?? '192.168.1.100:5555';
const REMOTE_JAR = '/data/local/tmp/miai.jar';
const REMOTE_PCM = '/data/local/tmp/reply.pcm';
const LOCAL_TMP = join(process.cwd(), '..', 'tmp');

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * 把 PCM 推回手机并从眼镜播出。
 *
 * TTS 输出是 **24 kHz**，不是上行的 16 kHz —— 搞错会 1.5 倍速升调。
 * 这条路依赖 adb，所以只在 harness 与手机同机（开发期 adb reverse）时可用；
 * 将来 harness 上 VPS 后要换成手机主动拉流。
 */
async function speak(pcm: Buffer): Promise<void> {
  mkdirSync(LOCAL_TMP, { recursive: true });
  const local = join(LOCAL_TMP, `reply_${Date.now()}.pcm`);
  writeFileSync(local, pcm);

  execFileSync('adb', ['-s', ADB_SERIAL, 'push', local, REMOTE_PCM], { stdio: 'pipe' });

  const shell = `app_process -Djava.class.path=${REMOTE_JAR} /system/bin `
    + `com.miaiglasses.MainPlay ${REMOTE_PCM} ${TTS_SAMPLE_RATE}`;
  const out = execFileSync('adb', ['-s', ADB_SERIAL, 'shell', shell], {
    timeout: 120_000,
    encoding: 'utf8',
  });

  const passed = out.includes('MainPlay PASSED');
  const written = /written=\d+/.exec(out)?.[0] ?? 'written=?';
  console.log(`  播放    ${passed ? '✓' : '✗'} ${written}`);
}

class Pipeline {
  private ff: ChildProcessWithoutNullStreams;
  private vad = new SileroVad();
  private pending = Buffer.alloc(0);        // 尚未凑满一帧的 PCM
  private utterance = Buffer.alloc(0);      // 本轮累积的 PCM（判停后送 ASR）
  private queue: Float32Array[] = [];
  private processing = false;
  private silenceFrames = 0;
  private hasSpoken = false;
  private frames = 0;
  private speechFrames = 0;
  private finished = false;
  private finishedResolve: (() => void) | null = null;
  private readonly finishedPromise: Promise<void>;
  private readonly startedAt = Date.now();
  private readonly echo: boolean;

  constructor(ffmpeg: string, echo: boolean) {
    this.echo = echo;
    this.finishedPromise = new Promise((r) => { this.finishedResolve = r; });

    this.ff = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'sbc', '-i', 'pipe:0',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;

    this.ff.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.error('[ffmpeg] ' + s);
    });

    this.ff.stdout.on('data', (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      const { frames, rest } = sliceFrames(this.pending);
      this.pending = rest;
      if (frames.length > 0) {
        this.queue.push(...frames);
        void this.drain();
      }
    });

    void this.vad.init().catch((e: unknown) => {
      console.error('VAD 初始化失败:', (e as Error).message);
      process.exit(1);
    });
  }

  get isFinished(): boolean {
    return this.finished;
  }

  feed(msbc: Buffer): void {
    if (this.finished) return;
    if (!this.ff.stdin.destroyed) this.ff.stdin.write(msbc);
  }

  closeInput(): void {
    if (!this.ff.stdin.destroyed) this.ff.stdin.end();
  }

  wait(): Promise<void> {
    return this.finishedPromise;
  }

  // ---------------------------------------------------------------- 内部
  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !this.finished) {
        const f = this.queue.shift();
        if (!f) break;
        await this.onFrame(f);
      }
    } catch (e) {
      console.error('[drain] ' + (e as Error).message);
    } finally {
      this.processing = false;
    }
  }

  private async onFrame(frame: Float32Array): Promise<void> {
    // 累积原始 PCM：判停后要整段送 ASR
    const buf = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < WINDOW; i += 1) {
      const v = Math.max(-1, Math.min(1, frame[i] ?? 0));
      buf.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    this.utterance = Buffer.concat([this.utterance, buf]);

    const p = await this.vad.process(frame);
    this.frames += 1;

    if (p > VAD_THRESHOLD) {
      this.hasSpoken = true;
      this.speechFrames += 1;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
    }

    if (this.hasSpoken && this.silenceFrames >= SILENCE_FRAMES) {
      this.trigger('静音判停');
    } else if (this.utterance.length >= MAX_UTTERANCE_SEC * SAMPLE_RATE * 2) {
      this.trigger('达到上限');
    }
  }

  private trigger(reason: string): void {
    if (this.finished) return;
    this.finished = true;

    const pcm = this.utterance;
    this.utterance = Buffer.alloc(0);
    const elapsed = (Date.now() - this.startedAt) / 1000;

    void this.recognize(pcm, reason, elapsed);
  }

  private async recognize(pcm: Buffer, reason: string, elapsed: number): Promise<void> {
    const sec = pcm.length / (SAMPLE_RATE * 2);
    console.log(`\n--- 判停（${reason}）---`);
    console.log(`  音频    ${pcm.length} 字节  ${sec.toFixed(2)} s`);
    console.log(`  判停于  ${elapsed.toFixed(2)} s（流开始起算）`);
    console.log(`  帧统计  ${this.speechFrames}/${this.frames} 帧含语音`);

    if (pcm.length === 0) {
      console.log('  ✗ 无音频');
      this.finishedResolve?.();
      return;
    }

    const t0 = Date.now();
    try {
      const { text, chunks } = await asr(pcmToWav(pcm));
      console.log(`  ASR     ${((Date.now() - t0) / 1000).toFixed(2)} s  chunks=${chunks}`);
      console.log(`  文本    ${JSON.stringify(text)}`);
      console.log(`\nASR_TEXT=${text}`);

      if (this.echo && text) {
        const t1 = Date.now();
        const { pcm: reply, chunks: ttsChunks } = await tts(text);
        console.log(`  TTS     ${((Date.now() - t1) / 1000).toFixed(2)} s  chunks=${ttsChunks}`);
        console.log(`  回放    ${reply.length} 字节  ${(reply.length / (TTS_SAMPLE_RATE * 2)).toFixed(2)} s`);
        await speak(reply);
      }
    } catch (e) {
      console.log(`  ✗ ASR/TTS 失败: ${(e as Error).message}`);
    } finally {
      this.finishedResolve?.();
    }
  }
}

// ------------------------------------------------------------------ 入口
async function runReplay(path: string, pipe: Pipeline, gapMs: number): Promise<number> {
  const data = readFileSync(path);
  console.log(`回放 ${path}  ${data.length} 字节  ${((data.length / 57) * 7.5 / 1000).toFixed(2)} s`);
  console.log(`块 570 B，间隔 ${gapMs} ms\n`);

  const CHUNK = 570;
  for (let off = 0; off < data.length; off += CHUNK) {
    if (pipe.isFinished) {
      console.log(`（已判停，停止回放于 ${off} / ${data.length} 字节）`);
      break;
    }
    pipe.feed(data.subarray(off, off + CHUNK));
    if (gapMs > 0) await sleep(gapMs);
  }

  pipe.closeInput();
  await Promise.race([pipe.wait(), sleep(30_000)]);
  return 0;
}

async function runListen(port: number, pipe: Pipeline): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server = createServer((sock) => {
      console.log(`已连接 ${sock.remoteAddress}:${sock.remotePort}\n`);
      let total = 0;

      sock.on('data', (d: Buffer) => {
        total += d.length;
        pipe.feed(d);
        if (pipe.isFinished) sock.end();
      });

      sock.on('close', async () => {
        console.log(`\n连接结束，共收 ${total} 字节`);
        pipe.closeInput();
        await Promise.race([pipe.wait(), sleep(30_000)]);
        server.close();
        resolve(0);
      });

      sock.on('error', (e: Error) => {
        console.error('socket 错误: ' + e.message);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`监听 127.0.0.1:${port}`);
      console.log(`手机侧先执行： adb reverse tcp:${port} tcp:${port}\n`);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const opt = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? def) : def;
  };

  const replay = opt('--replay', '');
  const listen = Number(opt('--listen', '0'));
  const ffmpeg = opt('--ffmpeg', 'ffmpeg');
  const gapMs = Number(opt('--gap-ms', '20'));
  const echo = argv.includes('--echo');

  if (!replay && !listen) {
    console.error('用法: node src/main.ts --replay <file.sbc> | --listen <port>');
    console.error('      [--ffmpeg <path>] [--gap-ms 20]');
    process.exit(2);
  }
  if (!process.env.MIMO_API_KEY) {
    console.error('未设置 MIMO_API_KEY');
    process.exit(2);
  }

  const pipe = new Pipeline(ffmpeg, echo);
  await sleep(200);       // 等 VAD 初始化

  const code = replay
    ? await runReplay(replay, pipe, gapMs)
    : await runListen(listen, pipe);

  process.exit(code);
}

void main();
