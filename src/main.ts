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
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { VoiceAgent } from './agent.ts';
import { AliyunAsr } from './aliyun-asr.ts';
import { DialogFsm } from './dialog-fsm.ts';
import { asr, pcmToWav, ttsStream, TTS_SAMPLE_RATE } from './mimo.ts';
import { DshSession, type ImageAttachment } from './session.ts';
import { SmartTurn } from './smart-turn.ts';
import { SileroVad, sliceFrames, SAMPLE_RATE, WINDOW } from './vad.ts';

/**
 * 判停之后拿识别文本做什么。
 * - `none`  只识别，不回复（冒烟用）
 * - `echo`  原样念回去（验证下行通路）
 * - `agent` 交给 dsh，念它给的回复
 */
type ReplyMode = 'none' | 'echo' | 'agent';

/**
 * 下行音频的出口。
 *
 * - 本机调试：先收完再用 adb push 给手机播（adb 没有流式播放）
 * - 上手机：直接写回同一条 TCP，手机边收边播
 */
interface AudioSink {
  write(chunk: Buffer): void | Promise<void>;
  end?(): void | Promise<void>;
}

/**
 * 双阈值判停。
 *
 * 单一阈值解决不了「正常提问该快」和「思考停顿不该被切断」的矛盾：
 * 4 秒太慢（业界对话助手普遍 0.5–1 s），1 秒又会切断实测到的 3.6 s 停顿。
 *
 * - 短阈值 1.0 s（32 ms/帧 × 31）：先做一次「预判 ASR」，文本完整就进入确认窗口
 * - 长阈值 2.5 s（× 78）：文本不完整时的兼底，届时重新识别完整音频
 * - 确认窗口 0.5 s（× 16）：预判出「说完了」后再静听 0.5 s，
 *   这期间又出声就把预判作废。句号不等于说完了 —— 实测用户会在
 *   「音乐场景。」后面接着说「下一个是谁」，没有这个窗口就只拿到前半句。
 *
 * 短阈值取 1.0 s：0.6 s 实测会把「嗯，你觉得呢？」这种句子中间的短停顿
 * 当成说完，直接切断。1.0 s 接近业界对话助手的上限，仍然比原来的 4 s 快。
 *
 * 预判是异步的，不阻塞 VAD 主循环；期间继续累积音频，用户又开口就作废重来。
 */
const SHORT_SILENCE_FRAMES = 31;
const LONG_SILENCE_FRAMES = 78;
/** 预判命中后的确认窗口：再安静这么久才算真的说完 */
const CONFIRM_SILENCE_FRAMES = 16;
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

/** 句末标点。MiMo ASR 会带标点，所以优先看标点。 */
const SENTENCE_END = /[。！？!?…]$/;
/** 没有标点时退化为语气词判断 */
const MODAL_END = /[吗呢吧啊呀嘛哦哈嘛]$/;

/**
 * 这句看起来说完了吗。
 *
 * 宁可偏向「没说完」：漏判的代价是多等 1.5 秒，误判的代价是把话切断。
 * 所以短到「嗯」「啊」这种一律不算，必须有实质内容。
 */
function looksComplete(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const bare = t.replace(/[\s，,、。.!?！？…]/g, '');
  if (bare.length < 2) return false;
  return SENTENCE_END.test(t) || MODAL_END.test(t);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** PCM16 小端单声道峰值电平（dBFS）。用来判「这段到底有没有人声」。 */
function peakDbfs(pcm: Buffer): number {
  let peak = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i += 1) {
    const v = pcm.readInt16LE(i << 1);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak === 0 ? -120 : 20 * Math.log10(peak / 32768);
}

/**
 * 把 PCM 推回手机并从眼镜播出。
 *
 * TTS 输出是 **24 kHz**，不是上行的 16 kHz —— 搞错会 1.5 倍速升调。
 * 这条路依赖 adb，所以只在 harness 与手机同机（开发期 adb reverse）时可用；
 * 将来 harness 上 VPS 后要换成手机主动拉流。
 */
/**
 * 本机调试用的 sink：攒齐整段 PCM，再 adb push 给手机播。
 * adb 没有流式播放能力，所以本机路径天然是「收完再播」。
 */
function adbSink(): AudioSink {
  const parts: Buffer[] = [];
  return {
    write: (chunk: Buffer) => { parts.push(chunk); },
    end: async () => { await speak(Buffer.concat(parts)); },
  };
}

async function speak(pcm: Buffer): Promise<void> {
  // 服务器上没有 adb，也不该从服务器扬声器出声。上 VPS 后这里会换成
  // 「把 PCM 写回同一条 TCP」；在那之前用 --no-play 只验到 TTS 产出为止。
  if (process.argv.includes('--no-play')) {
    console.log(`  播放    跳过（--no-play）`);
    return;
  }
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
  private pending: Buffer = Buffer.alloc(0);        // 尚未凑满一帧的 PCM
  private utterance: Buffer = Buffer.alloc(0);      // 本轮累积的 PCM（判停后送 ASR）
  private queue: Float32Array[] = [];
  private processing = false;
  private silenceFrames = 0;
  private hasSpoken = false;
  /** 本轮静音是否已发起过语义预判（重新出现语音就重置） */
  private prefetching = false;
  /** 预判还在飞行中。长阈值到时不能自己判停，否则预判结果白做。 */
  private prefetchPending = false;
  /** 预判说「完整」但还在确认窗口里，尚未判停 */
  private pendingTrigger: { text: string; pcm: Buffer } | null = null;
  /** 确认窗口已静听的帧数 */
  private confirmSilence = 0;
  private frames = 0;
  private speechFrames = 0;
  private finished = false;
  private finishedResolve: (() => void) | null = null;
  private finishedPromise: Promise<void>;
  /** 本轮 TTS 写出的字节数，用来估算播放时长 */
  private replyBytes = 0;
  private readonly startedAt = Date.now();
  private readonly mode: ReplyMode;
  private readonly agent: VoiceAgent | null;
  private sink: AudioSink;

  constructor(ffmpeg: string, mode: ReplyMode, agent: VoiceAgent | null = null, sink?: AudioSink) {
    this.mode = mode;
    this.agent = agent;
    this.sink = sink ?? adbSink();
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

  /** 切换下行音频出口。listen 模式在连接建立时指向 socket。 */
  setSink(sink: AudioSink): void {
    this.sink = sink;
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

  /** 本轮回复的音频时长（毫秒）。多轮时用来等播放结束再恢复收音。 */
  get replyDurationMs(): number {
    return (this.replyBytes / (TTS_SAMPLE_RATE * 2)) * 1000;
  }

  /**
   * 重置到「等待新一轮」的状态。
   *
   * ffmpeg 进程不复用也不重建：mSBC 是自包含帧，解码器可以一直跑，
   * 这里只重置**判停相关**的状态（VAD 的 LSTM 隐状态、累积音频、计数）。
   * VAD 必须 reset：上一轮的语音上下文留着会让新一轮开头就误判成语音。
   */
  reset(): void {
    this.vad.reset();
    this.pending = Buffer.alloc(0);
    this.utterance = Buffer.alloc(0);
    this.queue = [];
    this.silenceFrames = 0;
    this.hasSpoken = false;
    this.prefetching = false;
    this.prefetchPending = false;
    this.pendingTrigger = null;
    this.confirmSilence = 0;
    this.frames = 0;
    this.speechFrames = 0;
    this.replyBytes = 0;
    this.finished = false;
    this.finishedResolve = null;
    this.finishedPromise = new Promise<void>((r) => { this.finishedResolve = r; });
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
    // 整段累积，不裁前后静音：实测裁掉 1.15 s 静音后 ASR 结果一字未变，
    // 说明 MiMo 内部已在处理静音。裁剪只会多出「削掉开口弱音」
    // 和「切掉轻声结尾」两个风险，没有收益。
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
      this.prefetching = false;   // 又说话了，上一轮预判作废
      // 确认窗口里又出声：用户没说完，预判作废，继续听
      this.pendingTrigger = null;
      this.confirmSilence = 0;
    } else {
      this.silenceFrames += 1;
    }

    if (!this.hasSpoken) return;

    if (this.utterance.length >= MAX_UTTERANCE_SEC * SAMPLE_RATE * 2) {
      this.trigger('达到上限');
      return;
    }

    // 确认窗口：预判已说「完整」，再静听 0.5 s 才真判停
    if (this.pendingTrigger) {
      this.confirmSilence += 1;
      if (this.confirmSilence >= CONFIRM_SILENCE_FRAMES) {
        const p = this.pendingTrigger;
        this.pendingTrigger = null;
        this.trigger('语义判停', p.text, p.pcm);
        return;
      }
    }

    // 长阈值：预判还在跑就等它；已经有 pending 就直接用它，不重复识别
    if (this.silenceFrames >= LONG_SILENCE_FRAMES && !this.prefetchPending) {
      const p = this.pendingTrigger;
      this.pendingTrigger = null;
      this.trigger('静音 2.5 s', p?.text ?? null, p?.pcm ?? null);
      return;
    }

    // 短阈值：发起一次语义预判（已有 pending 就不用再猜）
    if (this.silenceFrames >= SHORT_SILENCE_FRAMES && !this.prefetching && !this.pendingTrigger) {
      this.prefetching = true;
      void this.prefetch();
    }
  }

  /**
   * 语义预判：静音刚满 1 秒时先识别一次，看这句是不是说完了。
   *
   * 异步执行，不堵塞 VAD。返回时如果用户又开口了（silenceFrames 被清零），
   * 这次预判直接作废——音频已经变了，结论不再成立。
   */
  private async prefetch(): Promise<void> {
    if (this.finished) return;
    const pcm = this.utterance;
    if (pcm.length === 0) return;

    this.prefetchPending = true;
    const t0 = Date.now();
    try {
      const { text } = await asr(pcmToWav(pcm));
      if (this.finished) return;

      const ms = ((Date.now() - t0) / 1000).toFixed(2);

      // 识别期间用户又开口了：这段音频已经不代表当前句子，作废
      if (this.silenceFrames < SHORT_SILENCE_FRAMES) {
        console.log(`  预判    ${ms} s  已被新语音打断，丢弃`);
        return;
      }

      if (looksComplete(text)) {
        // 不直接判停：先进确认窗口，防止「句号说完、但其实还在说」
        console.log(`\n  预判    ${ms} s  ${JSON.stringify(text)}  → 看起来说完了，再确认 0.5 s`);
        this.pendingTrigger = { text, pcm };
        this.confirmSilence = 0;
        return;
      }

      console.log(`\n  预判    ${ms} s  ${JSON.stringify(text)}  → 没说完，继续等`);
      // 已经过了长阈值：用完整音频重新识别一次（少了尾部会丢内容）
      if (this.silenceFrames >= LONG_SILENCE_FRAMES) {
        this.trigger('静音 2.5 s（预判不完整）');
      }
    } catch (e) {
      // 预判只是加速手段，失败就退化成纯长阈值，不影响本轮
      console.log(`  预判失败: ${(e as Error).message}`);
      if (this.silenceFrames >= LONG_SILENCE_FRAMES) this.trigger('静音 2.5 s');
    } finally {
      this.prefetchPending = false;
    }
  }

  private trigger(
    reason: string,
    presetText: string | null = null,
    presetPcm: Buffer | null = null,
  ): void {
    if (this.finished) return;
    this.finished = true;

    // 预判命中时音频必须用同一快照：否则日志里的时长和文本对不上，
    // 多出来的是预判之后的静音尾巴。
    const pcm = presetPcm ?? this.utterance;
    this.utterance = Buffer.alloc(0);
    const elapsed = (Date.now() - this.startedAt) / 1000;

    void this.recognize(pcm, reason, elapsed, presetText);
  }

  private async recognize(
    pcm: Buffer,
    reason: string,
    elapsed: number,
    presetText: string | null = null,
  ): Promise<void> {
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
      let text = presetText ?? '';
      if (presetText === null) {
        const r = await asr(pcmToWav(pcm));
        text = r.text;
        console.log(`  ASR     ${((Date.now() - t0) / 1000).toFixed(2)} s  chunks=${r.chunks}`);
      } else {
        // 语义预判已经识别过同一段音频，不再重复调用
        console.log(`  ASR     跳过（预判已识别）`);
      }
      console.log(`  文本    ${JSON.stringify(text)}`);
      console.log(`\nASR_TEXT=${text}`);

      if (this.mode !== 'none' && text) {
        let speech = text;

        if (this.mode === 'agent' && this.agent) {
          const t0a = Date.now();
          try {
            const r = await this.agent.reply(text);
            speech = r.speech;
            console.log(`  agent   ${((Date.now() - t0a) / 1000).toFixed(2)} s  `
              + `${r.resumed ? '续会话' : '新会话'}  ${JSON.stringify(r.text.slice(0, 160))}`);
          } catch (e) {
            // agent 挂了不该吞掉本轮：退回原样念回去，至少链路是通的
            console.log(`  ✗ agent 失败: ${(e as Error).message}（退回回声）`);
          }
        }

        if (speech) {
          const t1 = Date.now();
          let bytes = 0;
          let chunks = 0;
          let firstAt = 0;
          for await (const pcm of ttsStream(speech)) {
            if (firstAt === 0) {
              firstAt = Date.now();
              console.log(`  TTS首块 ${((firstAt - t1) / 1000).toFixed(2)} s  ${pcm.length} 字节`);
            }
            bytes += pcm.length;
            chunks += 1;
            await this.sink.write(pcm);
          }
          this.replyBytes = bytes;
          console.log(`  TTS     ${((Date.now() - t1) / 1000).toFixed(2)} s  chunks=${chunks}`);
          console.log(`  回放    ${bytes} 字节  ${(bytes / (TTS_SAMPLE_RATE * 2)).toFixed(2)} s`);
          await this.sink.end?.();
        }
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
      let turns = 0;

      // 下行音频直接写回同一条连接：手机边收边播。
      pipe.setSink({
        write: (chunk: Buffer) => {
          if (!sock.destroyed) sock.write(chunk);
        },
        // 多轮：一轮结束**不发 EOF**，连接保持，手机端到 listenMs 自己断。
        end: () => {},
      });

      sock.on('data', (d: Buffer) => {
        total += d.length;
        pipe.feed(d);
      });

      // 轮次循环：一轮结束 → 等回复播完 → 重置 → 继续听
      const loop = async (): Promise<void> => {
        for (;;) {
          await pipe.wait();
          turns += 1;
          if (sock.destroyed) break;

          // 必须等回复播完再恢复收音：否则眼镜扬声器的声音会被自己的
          // 麦克风收进去，下一轮开头就变成「听到自己说话」。
          // 云端拿不到 AudioTrack 的真实播放进度，用音频时长 + 固定余量估算。
          const waitMs = pipe.replyDurationMs + 600;
          console.log(`\n--- 第 ${turns} 轮结束，${(waitMs / 1000).toFixed(1)} s 后继续听 ---`);
          await sleep(waitMs);
          if (sock.destroyed) break;

          pipe.reset();
          console.log('--- 继续听 ---\n');
        }
      };
      void loop();

      sock.on('close', () => {
        console.log(`\n连接结束，共收 ${total} 字节，${turns} 轮`);
        pipe.closeInput();
        server.close();
        resolve(0);
      });

      sock.on('error', (e: Error) => {
        console.error('socket 错误: ' + e.message);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`监听 127.0.0.1:${port}（多轮）`);
      console.log(`手机侧先执行： adb reverse tcp:${port} tcp:${port}\n`);
    });
  });
}

/**
 * 唤醒词。单独成句时**不是一轮对话**，直接丢掉。
 *
 * 实测：「小爱同学。」和「我眼前的是什么？」会被服务端拆成两个 SentenceEnd，
 * 第二个才是真正的命令。Smart Turn 对「小爱同学。」给 0.957（它确实是完整的一句话），
 * 所以模型治不了这个，只能靠这条领域规则。
 */
const WAKE_WORDS = new Set(['小爱同学', '小爱', '小爱小爱']);

function isWakeWordOnly(text: string): boolean {
  const bare = text.replace(/[\s。.,，!！?？、~～]/g, '');
  return WAKE_WORDS.has(bare);
}

// ------------------------------------------------------------------ 阿里云流式识别
interface AliyunRunOptions {
  ffmpeg: string;
  agent: VoiceAgent;
  akId: string;
  akSecret: string;
  appkey: string;
  region: string;
  maxSentenceSilenceMs?: number;
}

/**
 * 阿里云流式识别模式。
 *
 * 跟 MiMo 分支的根本区别：**音频是边推边出字的**。服务端检测到句子结束就发
 * `SentenceEnd`，本地 silero VAD + 双阈值那套退役。
 *
 * 判停分两级：
 * 1. 服务端 `SentenceEnd` 给出「可能说完了」的候选点；
 * 2. 本地 Smart Turn 对候选点做语义确认（见 `evaluateTurn`），
 *    概率不足就延长窗口。服务端的静音阈值只是候选，不是最终判决。
 *
 * 半双工（暂）：TTS 播放期间不把上行送进 ASR。
 * 实测固件**自带回声消除**（ERL ≈ 75 dB，双讲期噪声底 -80 dBFS 以下），
 * 所以这一条不是技术限制，只是还没做打断控制 —— 见 TODO T-005。
 */
/**
 * 设了就把每轮的「下行 TTS」与「播放期间的麦克风」落盘，
 * 供 AEC 可行性分析（延迟 / 回声衰减 / 线性可预测性）。
 */
const DUMP_DIR = process.env['DUMP_DIR'] ?? '';
/** 眼镜拍到的图片落在哪里 */
const PHOTO_DIR = process.env['PHOTO_DIR'] ?? join(homedir(), 'miai-photos');
/**
 * 服务端断句静音阈值。
 *
 * 阿里云文档：取值范围 200～2000，**默认 800**。
 * 早先压到 500，比默认还激进 —— 中文一句话中间的停顿（尤其「退下吧」
 * 这种短命令）很容易被切成独立句子，后面就错上加错。回退到默认值。
 */
const DEFAULT_SENTENCE_SILENCE_MS = 800;

/** 给 MCP 工具 take_photo / end_session 用的本机控制口 */
const PHOTO_CTL_PORT = Number(process.env['PHOTO_CTL_PORT'] ?? 8767);
/** 等设备回图的超时 */
const PHOTO_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------- 判停（Smart Turn）
/** 置 0 退回旧的「固定 600 ms 合并窗口」行为 */
const SMART_TURN_ENABLED = process.env['SMART_TURN'] !== '0';
const SMART_TURN_PYTHON = process.env['SMART_TURN_PYTHON'] ?? '';
const SMART_TURN_SCRIPT = process.env['SMART_TURN_SCRIPT'] ?? '';
/** 句子结束后先静候这么久，给用户一个自然接话的间隙 */
const SMART_TURN_QUIET_MS = Number(process.env['SMART_TURN_QUIET_MS'] ?? 350);
/** 判为「没说完」时再多等这么久再判一次 */
const SMART_TURN_EXTEND_MS = Number(process.env['SMART_TURN_EXTEND_MS'] ?? 700);
/** 最多再等几轮，防止一直不认完 */
const SMART_TURN_MAX_EXT = Number(process.env['SMART_TURN_MAX_EXT'] ?? 3);
/** 概率阀值：≥ 此值就叫停 */
const SMART_TURN_THRESHOLD = Number(process.env['SMART_TURN_THRESHOLD'] ?? 0.5);
/** 送进模型的最近音频上限（16 kHz × 2 B × 8 s） */
const RECENT_MAX_BYTES = 16_000 * 2 * 8;

/** 下行帧类型：PCM（24 kHz） */
const FRAME_DOWN_AUDIO = 1;
/** 下行帧类型：控制指令 */
const FRAME_DOWN_CONTROL = 2;

async function runListenAliyun(port: number, o: AliyunRunOptions): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server = createServer((sock) => {
      console.log(`已连接 ${sock.remoteAddress}:${sock.remotePort}\n`);

      /** 下行帧：{@code [type:u8][len:u32 LE][payload]}，与手机侧一致 */
      const writeDown = (type: number, payload: Buffer): void => {
        if (sock.destroyed) return;
        const head = Buffer.allocUnsafe(5);
        head[0] = type;
        head.writeUInt32LE(payload.length, 1);
        sock.write(head);
        sock.write(payload);
      };

      /** 最近一次 WakeUpEvent 的上下文（手机侧已缓存，这里只做诊断展示） */
      let wakeRef: { transactionId: string; requestId: string } | null = null;
      /** 等照片的 resolver；同一时刻只允许一个在途请求 */
      let pendingPhoto: ((jpeg: Buffer | null) => void) | null = null;

      /**
       * 给 dsh 的 MCP 工具用的本机控制口。
       *
       * 工具是 dsh spawn 的独立进程，走 HTTP 回来；harness 在这里下发硬件指令
       * 或置会话状态，工具侧只需要知道一个 URL。
       *
       * - `POST /take_photo`  → 下发拍照指令，等设备回图，回应 JPEG
       * - `POST /end_session` → 挂「本轮说完就结束」的旗子
       */
      const toolCtl = createHttpServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        if (req.url === '/end_session') {
          console.log('  退出    模型判定该结束了（说完这句就挂断）');
          fsm.requestEnd();
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
          return;
        }
        if (req.url !== '/take_photo') {
          res.writeHead(404).end();
          return;
        }
        if (pendingPhoto) {
          res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
            .end('已有拍照请求在途');
          return;
        }
        const wait = new Promise<Buffer | null>((resolve) => { pendingPhoto = resolve; });
        writeDown(FRAME_DOWN_CONTROL, Buffer.from('take_photo', 'utf8'));
        console.log('  拍照    已下发指令，等设备回图…');
        const timer = setTimeout(() => {
          const r = pendingPhoto;
          pendingPhoto = null;
          r?.(null);
        }, PHOTO_TIMEOUT_MS);
        void wait.then((jpeg) => {
          clearTimeout(timer);
          if (!res.writableEnded) {
            if (!jpeg) {
              res.writeHead(504).end('等图超时');
            } else {
              res.writeHead(200, {
                'content-type': 'image/jpeg',
                'content-length': String(jpeg.length),
              });
              res.end(jpeg);
            }
          }
        });
      });
      // 每个连接都新建一个控制口。旧连接没关干净时端口会占着，
      // 没有 error 监听会让整个 harness 崩掉 —— 这里只记一笔，不退出。
      toolCtl.on('error', (e: Error) => {
        console.error(`  ✗ 控制口 ${PHOTO_CTL_PORT}: ${e.message}`);
      });
      toolCtl.listen(PHOTO_CTL_PORT, '127.0.0.1');

      /**
       * 对话状态机。所有「现在算不算在播」「这一轮该不该继续」的判断
       * 全部集中在它那里，不再散成一堆互斥布尔量。
       */
      const fsm = new DialogFsm((l) => { console.log(l); });

      /** 播放期间的上行 PCM，用于 AEC 分析 */
      let upDuringPlayback: Buffer[] = [];
      /** 本轮下行 TTS 参考，同样是 AEC 分析用 */
      let downChunks: Buffer[] = [];
      /** 已经落过盘的轮次，防止重复写 */
      let dumpedTurn = 0;
      /**
       * 落盘。正常在 sleep 之后调（那时才是完整播放期），
       * 但手机 listen 窗口到点会主动断开，进程随即退出 ——
       * 所以 sock close 时也要再兜一次，否则整轮白跑。
       */
      const flushDump = (): void => {
        const turns = fsm.turn;
        if (!DUMP_DIR || turns === 0 || dumpedTurn === turns) return;
        dumpedTurn = turns;
        try {
          mkdirSync(DUMP_DIR, { recursive: true });
          writeFileSync(join(DUMP_DIR, `down_${turns}.pcm`), Buffer.concat(downChunks));
          writeFileSync(join(DUMP_DIR, `up_${turns}.pcm`), Buffer.concat(upDuringPlayback));
          console.log(`  落盘    down_${turns}.pcm ${Buffer.concat(downChunks).length}B`
            + `  up_${turns}.pcm ${Buffer.concat(upDuringPlayback).length}B`);
        } catch (e) {
          console.error(`  ✗ 落盘失败: ${(e as Error).message}`);
        }
      };
      let chain: Promise<void> = Promise.resolve();
      /**
       * 串行队列。三条要求缺一不可：
       *   1. 严格串行 —— 上一轮 TTS 没发完时不能开下一轮
       *   2. 错误隔离 —— 某一轮抛错只能作废该轮，不能让 chain 变成
       *      rejected 状态，否则后续所有 `.then` 都会短路，整个连接哑掉
       *   3. 可作废 —— 出队时票据代次已变就跳过（用户已插话，这轮过时了）
       */
      const enqueue = (fn: () => Promise<void>): void => {
        const ticket = fsm.ticket();
        chain = chain.then(() => {
          if (fsm.isStale(ticket)) {
            console.log('  （丢弃：用户已插话，这一轮过时了）');
            return;
          }
          return fn();
        }).catch((e: Error) => {
          console.error(`  ✗ 队列任务失败（不影响后续）: ${e.message}`);
        });
      };

      const ff = spawn(o.ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'sbc', '-i', 'pipe:0',
        '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      ff.stderr.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s) console.error('[ffmpeg] ' + s);
      });

      /**
       * 用户插话：停播 + 作废排队轮次。
       *
       * 靠 ASR 中间结果触发，不靠能量 —— 纯能量判据在环境噪声下误触率太高。
       * 中间结果非空就说明服务端真的听出了字，不是“有点像人声”。
       * 「能不能插话」由状态机判定：只有 speaking 才算（thinking 期间
       * 回复还没出声，打断它等于白白丢掉一个刚准备好的回答）。
       */
      const tryBargeIn = (why: string): void => {
        if (!fsm.bargeIn(why)) return;
        console.log(`  打断    ${why} → 停止播放，已排队的轮次作废`);
        writeDown(FRAME_DOWN_CONTROL, Buffer.from('stop', 'utf8'));
      };

      const handleTurn = async (text: string, image?: ImageAttachment): Promise<void> => {
        const ticket = fsm.beginTurn();
        if (!ticket) return;
        // 全双工：**不挂断 ASR**。
        //
        // 以前播放期先 close + 预重连，因为“没有 AEC，不挡就会听到自己”。
        // 实测固件自带回声消除（播放期回波底噪 −80 dBFS，ERL ≥ 75 dB 估算），
        // 远低于能量门 −58 dBFS —— 回声根本进不了 ASR。
        upDuringPlayback = [];
        downChunks = [];
        try {
          const t0 = Date.now();
          const r = await o.agent.reply(text, image);
          console.log(`  agent   ${((Date.now() - t0) / 1000).toFixed(2)} s  `
            + `${JSON.stringify(r.text.slice(0, 120))}`);

          const t1 = Date.now();
          let bytes = 0;
          let firstAt = 0;
          for await (const pcm of ttsStream(r.speech)) {
            if (fsm.isStale(ticket)) break;
            if (firstAt === 0) {
              firstAt = Date.now();
              fsm.audioStarted(ticket);
              console.log(`  TTS首块 ${((firstAt - t1) / 1000).toFixed(2)} s`);
            }
            bytes += pcm.length;
            if (DUMP_DIR) downChunks.push(Buffer.from(pcm));
            writeDown(FRAME_DOWN_AUDIO, pcm);
          }
          const secs = bytes / (TTS_SAMPLE_RATE * 2);
          const cut = fsm.isStale(ticket);
          console.log(`  回放    ${bytes} 字节  ${secs.toFixed(2)} s${cut ? '（被中断）' : ''}`);

          // 一行结构化汇总，便于事后 grep 统计 P50/P95：
          //   grep '^TURN ' harness.log
          const ttsFirstMs = firstAt ? firstAt - t1 : -1;
          console.log(`TURN n=${ticket.no} text_len=${text.length} dsh_ms=${r.durationMs}`
            + ` tts_first_ms=${ttsFirstMs} audio_s=${secs.toFixed(2)}`
            + (cut ? ' barge_in=1' : ''));

          // 等手机把这段播完再恢复收音，否则下一轮会识别到自己。
          // 状态机在整个等待期间保持 `speaking`（不是「TTS 生成结束」就
          // 回 listening），否则真正响的那 10–20 s 里插话不算数。
          // 等待必须可被插话提前结束。
          if (!cut) {
            const until = Date.now() + secs * 1000 + 600;
            while (!fsm.isStale(ticket) && Date.now() < until) {
              await sleep(100);
            }
          }

          // 落盘必须在等待之后：那段时间才是真正的播放期，
          // 放在前面只能录到「agent 思考 + TTS 生成」，录不到回声。
          flushDump();
        } catch (e) {
          console.log(`  ✗ 本轮失败: ${(e as Error).message}`);
        } finally {
          fsm.audioDone(ticket);
          if (fsm.state === 'ending') {
            console.log('\n--- 会话结束（模型判定）---');
            if (!sock.destroyed) sock.end();
          }
        }
      };

      /**
       * 句子合并窗口。
       *
       * 服务端的 `SentenceEnd` 只是**句子**边界，不是**轮次**边界：
       * 「嗯。」「我问你在干什么？」会各发一次，直接照单全收就是两轮问答。
       * 所以收到后先攒着，窗口内再来一句就拼上一起处理。
       *
       * 例外：以问号结尾的句子立刻触发 —— 用户在提问，没有再等下去的道理。
       */
      let pendingText = '';
      let pendingTimer: NodeJS.Timeout | null = null;
      /** 旧行为（SMART_TURN=0 时）的固定合并窗口 */
      const MERGE_WINDOW_MS = 600;
      /** Smart Turn 已连续判了几次「没说完」 */
      let extensions = 0;

      const smartTurn = SMART_TURN_ENABLED && SMART_TURN_PYTHON && SMART_TURN_SCRIPT
        ? new SmartTurn({
            python: SMART_TURN_PYTHON,
            script: SMART_TURN_SCRIPT,
            log: (l) => { console.log(`  ${l}`); },
          })
        : null;

      /** 最近的音频（16 kHz PCM），给 Smart Turn 用 */
      let recentChunks: Buffer[] = [];
      let recentBytes = 0;
      const pushRecent = (c: Buffer): void => {
        recentChunks.push(Buffer.from(c));
        recentBytes += c.length;
        while (recentBytes > RECENT_MAX_BYTES && recentChunks.length > 1) {
          const drop = recentChunks.shift();
          recentBytes -= drop?.length ?? 0;
        }
      };

      const flushPending = (): void => {
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        extensions = 0;
        const text = pendingText.trim();
        pendingText = '';
        if (!text) return;
        console.log('\n--- 本轮 ---');
        console.log(`  文本    ${JSON.stringify(text)}`);
        enqueue(() => handleTurn(text));
      };

      /**
       * 句子结束后「要不要把这一轮定下来」。
       *
       * 服务端的 SentenceEnd 只是**句子**边界：实测「小爱同学。」和
       * 「我眼前的是什么？」会各发一次，照着收就是两轮问答（白烧一次 dsh）。
       * 固定 600 ms 窗口搞不定 —— 这个间隔实测 1.2 s。
       * 所以交给 Smart Turn 看**音频本身**说没说完；它说没说完就再等一段。
       */
      const evaluateTurn = async (): Promise<void> => {
        pendingTimer = null;
        if (!pendingText.trim()) return;

        if (!smartTurn) {
          flushPending();
          return;
        }

        const audio = Buffer.concat(recentChunks);
        const prob = await smartTurn.predict(audio);
        const shown = prob < 0 ? '故障' : prob.toFixed(3);
        if (prob < 0) {
          // 侧车出问题就退回保守策略，别把一轮吞掉
          console.log(`  判停    ${shown} → 侧车不可用，直接结束本轮`);
          flushPending();
          return;
        }
        if (prob >= SMART_TURN_THRESHOLD || extensions >= SMART_TURN_MAX_EXT) {
          console.log(`  判停    ${shown} → 收下这一轮`);
          flushPending();
          return;
        }
        extensions += 1;
        console.log(`  判停    ${shown} → 没说完，再等 ${SMART_TURN_EXTEND_MS} ms`);
        pendingTimer = setTimeout(() => { void evaluateTurn(); }, SMART_TURN_EXTEND_MS);
      };

      const asrClient = new AliyunAsr({
        akId: o.akId,
        akSecret: o.akSecret,
        appkey: o.appkey,
        region: o.region,
        maxSentenceSilenceMs: o.maxSentenceSilenceMs,
        log: (l) => { console.log(`  ${l}`); },
        onPartial: (t) => {
          console.log(`  … ${t}`);
          // 全双工打断：播放期只要服务端真的解出了字，就当用户在插话。
          // 用「非空中间结果」而不是能量阀值 —— 环境噪声能骗过峰值，骗不过识别器。
          const bare = t.replace(/[\s。.,，!！?？、~～]/g, '');
          if (bare.length >= 2) tryBargeIn(t);
        },
        onSentence: (t, idx) => {
          console.log(`  句 ${idx}  ${JSON.stringify(t)}`);

          // 唤醒词单独成句：不是一轮，丢掉继续听
          if (isWakeWordOnly(t)) {
            console.log('  → 唤醒词，丢弃（不算一轮）');
            return;
          }

          pendingText = pendingText ? pendingText + t : t;

          // 早先这里有一条「问号结尾直接收下这一轮」的快路径。
          // 实测它把一句话拆成了三轮：
          //   「你在运行什么？」（句中停顿被判成句尾）→「平台上。」
          // ASR 的 `？` 是按语调加的，不代表语义完整，所以取消了，
          // 统一交给 Smart Turn 看音频本身（代价只多 SMART_TURN_QUIET_MS）。
          if (pendingTimer) clearTimeout(pendingTimer);
          pendingTimer = setTimeout(
            () => { void evaluateTurn(); },
            smartTurn ? SMART_TURN_QUIET_MS : MERGE_WINDOW_MS,
          );
        },
        onError: (e) => {
          // 空闲挂断是预期行为（网关对「没听到有效语音」的连接 10 s 就踢），
          // 不是故障，不要用 ✗ 污染日志。
          if (e.message.includes('IDLE_TIMEOUT')) {
            console.log('  [asr] 空闲挂断（无有效语音，正常）');
          } else {
            console.error(`  ✗ ASR: ${e.message}`);
          }
        },
      });

      // 不在这里预建 ASR 连接：网关对「没听到有效语音」的连接 10 s 就判
      // IDLE_TIMEOUT，而眼镜唤醒前根本不推帧。建连现在完全由下面的能量门驱动。

      /**
       * 上行能量门。
       *
       * 阿里云网关对「没听到有效语音」的连接 10 s 就判 IDLE_TIMEOUT（推静音不算活动），
       * 而眼镜唤醒后会持续推帧、安静时是接近数字零的静音（实测峰值 −78 dBFS、RMS −91.6）。
       * 所以用能量做闸门：没声音就根本不建连，有声音再连并把预卷补推上去。
       */
      const VOICE_PEAK_DBFS = -58;
      /** 有声之后再多喂这么久：覆盖 max_sentence_silence=800 与服务端收尾 */
      const VOICE_HOLD_MS = 2000;
      /**
       * 开门前保留的音频（毫秒）。**必须按字节算，不能按块数。**
       *
       * 实测：ffmpeg 每次吐的块大小不固定 —— 同一次会话里既见过「8 块 = 105 ms」
       * 也见过「3 块 = 225 ms」。旧代码 PREROLL_CHUNKS=8 在第一种情况下
       * 只能盖 105 ms，连一个中文音节都不够，于是开头被削：
       * 「你在运行什么」被识别成「李运行在什么」（nǐ→lǐ）。
       */
      const PREROLL_MS = 800;
      /** 16 kHz × 2 B = 32 B/ms */
      const PREROLL_BYTES = PREROLL_MS * 32;
      let lastVoiceAt = 0;
      let uploading = false;
      let preroll: Buffer[] = [];
      let prerollBytes = 0;

      ff.stdout.on('data', (chunk: Buffer) => {
        // 播放期间的音频正常会因状态机处于 speaking 而只用于 AEC 分析
        if (fsm.state === 'speaking' && DUMP_DIR) upDuringPlayback.push(Buffer.from(chunk));

        const peak = peakDbfs(chunk);
        const now = Date.now();
        pushRecent(chunk);
        if (peak > VOICE_PEAK_DBFS) {
          lastVoiceAt = now;
          if (!uploading) {
            uploading = true;
            console.log(`  上行    有声 ${peak.toFixed(1)} dBFS → 开始推送`
              + `（补 ${preroll.length} 块 / ${Math.round(prerollBytes / 32)} ms）`);
            for (const p of preroll) asrClient.feed(p);
            preroll = [];
            prerollBytes = 0;
          }
        }
        if (uploading) {
          asrClient.feed(chunk);
          if (now - lastVoiceAt > VOICE_HOLD_MS) {
            uploading = false;
            console.log('  上行    持续静音 → 停推并挂断（避免 IDLE_TIMEOUT）');
            asrClient.hangup();
          }
        } else {
          preroll.push(chunk);
          prerollBytes += chunk.length;
          while (prerollBytes > PREROLL_BYTES && preroll.length > 1) {
            prerollBytes -= preroll.shift()!.length;
          }
        }
      });

      /** 把图片落盘（诊断用），返回路径 */
      const persistPhoto = (jpeg: Buffer): string => {
        mkdirSync(PHOTO_DIR, { recursive: true });
        const file = join(PHOTO_DIR, `photo_${Date.now()}.jpg`);
        writeFileSync(file, jpeg);
        console.log(`  图片    ${jpeg.length} B  ${file}`);
        return file;
      };

      /** 眼镜拍完一张图：落盘后交给 dsh 看，结果朗读出来 */
      const handleImage = (jpeg: Buffer): void => {
        persistPhoto(jpeg);
        enqueue(() => handleTurn('这张图里有什么？用一两句话口语化描述。', {
          mimeType: 'image/jpeg',
          data: jpeg.toString('base64'),
        }));
      };

      /**
       * 上行帧解复用：{@code [type:u8][len:u32 LE][payload]}。
       *
       * type 1 = mSBC 语音（喂给 ffmpeg），type 2 = JPEG（交给 dsh）。
       * 两者必须分开：整段图片要是被当成 SBC 解码，就是一片噪声。
       */
      let rxBuf: Buffer = Buffer.alloc(0);
      sock.on('data', (d: Buffer) => {
        rxBuf = rxBuf.length === 0 ? d : Buffer.concat([rxBuf, d]);
        while (rxBuf.length >= 5) {
          const type = rxBuf[0] ?? 0;
          const len = rxBuf.readUInt32LE(1);
          if (len > (32 << 20)) {
            console.error(`  ✗ 帧长异常 ${len}，丢弃整个缓冲`);
            rxBuf = Buffer.alloc(0);
            break;
          }
          if (rxBuf.length < 5 + len) break;
          const payload = rxBuf.subarray(5, 5 + len);
          rxBuf = rxBuf.subarray(5 + len);
          if (type === 1) {
            if (!ff.stdin.destroyed) ff.stdin.write(payload);
          } else if (type === 2) {
            // 图片：优先给在等的 take_photo 工具，没人等就当普通识图轮次
            if (pendingPhoto) {
              persistPhoto(payload);
              const r = pendingPhoto;
              pendingPhoto = null;
              r(payload);
            } else {
              handleImage(payload);
            }
          } else if (type === 3) {
            const [txn = '', rid = ''] = payload.toString('utf8').split('\n');
            wakeRef = { transactionId: txn, requestId: rid };
            console.log(`  唤醒    transactionId=${wakeRef.transactionId}`
              + `  requestId=${wakeRef.requestId.slice(0, 8)}…`);
          } else {
            console.error(`  ✗ 未知帧类型 ${type}（${len} B），已丢弃`);
          }
        }
      });

      sock.on('close', () => {
        console.log(`\n连接结束，${fsm.turn} 轮`);
        fsm.close();
        smartTurn?.stop();
        toolCtl.close();
        // 手机 listen 窗口到点会主动断，这里兜一次落盘
        flushDump();
        asrClient.close();
        if (!ff.stdin.destroyed) ff.stdin.end();
        setTimeout(() => {
          try {
            ff.kill();
          } catch {
            // 已退出
          }
        }, 1000).unref?.();
        server.close();
        resolve(0);
      });

      sock.on('error', (e: Error) => {
        console.error('socket 错误: ' + e.message);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`监听 127.0.0.1:${port}（阿里云流式识别）`);
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
  const workDir = opt('--work-dir', join(homedir(), 'voice-workspace'));
  /** 冒烟用：把一张本地图片交给 dsh，打印它的描述后退出 */
  const askImage = opt('--ask-image', '');

  const mode: ReplyMode = argv.includes('--agent')
    ? 'agent'
    : argv.includes('--echo') ? 'echo' : 'none';

  if (!replay && !listen && !askImage) {
    console.error('用法: node src/main.ts --replay <file.sbc> | --listen <port> | --ask-image <file>')
    console.error('      [--agent | --echo] [--work-dir <dir>] [--ffmpeg <path>] [--gap-ms 20]');
    process.exit(2);
  }
  if (!process.env.MIMO_API_KEY) {
    console.error('未设置 MIMO_API_KEY');
    process.exit(2);
  }

  let agent: VoiceAgent | null = null;
  let dshSession: DshSession | null = null;
  if (mode === 'agent') {
    // SDK 模式：一个常驻进程跑多轮，省掉每轮的进程启动与会话重加载。
    // 实测 headless 每轮 5–7 s，其中 2–3 s 是冷启动。
    const useSdk = argv.includes('--dsh-sdk');
    dshSession = new DshSession({
      workDir,
      program: process.env['DSH_BIN'],
      mode: useSdk ? 'sdk' : 'headless',
      patch: process.env['DSH_PATCH'],
      provider: opt('--provider', 'deepseek-official'),
      model: opt('--model', 'deepseek-flash'),
      log: (l: string) => { console.log(`  [session] ${l}`); },
    });
    agent = new VoiceAgent(dshSession, (l: string) => { console.log(l); });
    console.log(`agent 已就绪  workDir=${workDir}  dsh=${process.env['DSH_BIN'] ?? 'dsh'}  mode=${useSdk ? 'sdk' : 'headless'}`);
    console.log(`会话      ${dshSession.currentSessionId ?? '（新会话）'}\n`);
  }

  // ---------------------------------------------------------------- 图片 -> dsh 冒烟
  if (askImage) {
    if (!agent) {
      console.error('--ask-image 需要 --agent（图片只能交给 dsh 看）');
      process.exit(2);
    }
    const buf = readFileSync(askImage);
    const ext = askImage.toLowerCase().split('.').pop() ?? '';
    const mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
          : 'image/jpeg';
    console.log(`图片    ${askImage}  ${buf.length} B  ${mime}`);
    const t0 = Date.now();
    const r = await agent.reply('这张图里有什么？用一两句话口语化描述。', {
      mimeType: mime,
      data: buf.toString('base64'),
    });
    console.log(`dsh     ${((Date.now() - t0) / 1000).toFixed(2)} s`);
    console.log(`回答    ${JSON.stringify(r.text)}`);
    dshSession?.stop();
    process.exit(0);
  }

  // ---------------------------------------------------------------- 阿里云分支
  const asrBackend = opt('--asr', 'mimo');
  if (asrBackend === 'aliyun') {
    const akId = process.env['ALIYUN_AK_ID'] ?? '';
    const akSecret = process.env['ALIYUN_AK_SECRET'] ?? '';
    const appkey = process.env['ALIYUN_APPKEY'] ?? '';
    const region = process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai';
    if (!akId || !akSecret || !appkey) {
      console.error('阿里云模式需要 ALIYUN_AK_ID / ALIYUN_AK_SECRET / ALIYUN_APPKEY');
      process.exit(2);
    }
    if (!listen) {
      console.error('阿里云模式只支持 --listen（流式识别没有 --replay 语义）');
      process.exit(2);
    }
    if (!agent) {
      console.error('阿里云模式需要 --agent（收到 SentenceEnd 就要接一轮对话）');
      process.exit(2);
    }
    console.log(`ASR      阿里云实时识别  region=${region}  appkey=${appkey.slice(0, 4)}****  silence=${opt('--sentence-silence', String(DEFAULT_SENTENCE_SILENCE_MS))} ms\n`);
    const code = await runListenAliyun(listen, {
      ffmpeg,
      agent,
      akId,
      akSecret,
      appkey,
      region,
      maxSentenceSilenceMs: Number(opt('--sentence-silence', String(DEFAULT_SENTENCE_SILENCE_MS))),
    });
    dshSession?.stop();
    process.exit(code);
  }

  const pipe = new Pipeline(ffmpeg, mode, agent);
  await sleep(200);       // 等 VAD 初始化

  const code = replay
    ? await runReplay(replay, pipe, gapMs)
    : await runListen(listen, pipe);

  // 常驻进程要显式关，否则 node 会因为子进程 stdin 仍打开而不退出
  dshSession?.stop();
  process.exit(code);
}

void main();
