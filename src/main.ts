/**
 * 云端 harness：设备音频流 → 解码 → 判停 → 一轮 → TTS → 下发。
 *
 * STT / TTS / agent 都是**注入的**（见 `providers.ts`），这里只做装配：
 * 按 `--stt` / `--tts` / `--agent` 选实现，其余全是编排。
 *
 *   node src/main.ts --listen 8766                                  # 真供应商
 *   node src/main.ts --listen 8766 --stt canned --tts silent --agent echo   # 零密钥
 *
 * 旧路径（`--replay`、本地 silero-vad、MiMo ASR）见 `legacy-pipeline.ts`。
 * 它**按需加载**：`--stt` 流式启动的依赖图里没有 VAD/ONNX（见文件末尾的说明）。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VoiceAgent } from './agent.ts';
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './announce-store.ts';
import { DEFAULT_CONFIRM_TIMEOUT_MS } from './photo-inbox.ts';
import { aliyunStt } from './aliyun-asr.ts';
import { qwenRealtimeStt } from './qwen-realtime-asr.ts';
import { cosyVoiceTts, DEFAULT_COSYVOICE_EMOTION_MODE } from './cosyvoice.ts';
import { omniTts } from './omni-tts.ts';
import { mimoTts } from './mimo.ts';
import { EMOTIONS } from './emotion.ts';
import { EVENTS } from './events.ts';
import { sampleSocket } from './socket-stats.ts';
import { BASE_STYLE, DEFAULT_TTS_VOICE } from './mimo.ts';
import {
  cannedStt,
  echoAgent,
  noopStt,
  silentTts,
  type AgentProvider,
  type BackgroundTaskReport,
  type SttProvider,
  type TtsProvider,
} from './providers.ts';
import { DshSession } from './session.ts';
import { KEEPALIVE_PROMPT, newActivityState, startKeepalive, systemClock, trackActivity } from './keepalive.ts';
import type { EngineEvent, FastVoiceEngine } from './engine-contract.ts';
import { FrontedAgent } from './fronted-agent.ts';
import { MemoryFile } from './memory-file.ts';
import { resolveVoicePipelineFromEnv, type PipelinePlan } from './pipeline-mode.ts';
import { CascadeAgent, LiveOrchestrator } from './pipelines/index.ts';
import { expiryWarning } from './tls-cert.ts';
import { runVoiceServer, UPSTREAM_SAMPLE_RATE } from './voice-session.ts';
import { TurnJudge } from './turn-judge.ts';
 import { semanticEndpoint } from './semantic-endpoint.ts';
import { DEVICE_MODELS, describeCapabilities, resolveV1Device } from './devices/index.ts';
import { DEFAULT_PET_TIMING } from './pet/pet-timing.ts';
import { DEFAULT_PROACTIVE } from './pet/proactive.ts';
import { DEFAULT_KEEPALIVE_MS, installHttpAgent } from './http-agent.ts';
// **只借类型，不加载模块**：`legacy-pipeline.ts` 会一路拉进 `silero-vad` 与
// `onnxruntime-node`（几十 MB、启动多几百毫秒），而生产走的是 `--stt` 流式路径，
// 一行都用不到。真正的 `Pipeline` 在末尾的回放/旧监听分支里按需 `await import()`。
import type { Pipeline, ReplyMode } from './legacy-pipeline.ts';
import {
  describeTokenProblem,
  readTokenFile,
  tokenFilePath,
  TokenGate,
} from './tokens.ts';
import { envNumber, envString, sleep } from './util.ts';
/**
 * 插件加载：`<path>` 指向一个模块，导出 `stt()` / `tts()` 工厂（或 default）。
 *
 * 这是 `cloud/` 唯一的扩展点 —— 换厂商不用改本文件，也不用 fork。将来开源时
 * 别人照这个签名写自己的模块即可（见 `docs/BACKLOG.md` B-004）。
 */
async function loadProvider<T>(spec: string, exportName: string): Promise<T> {
  const isPath = /^[./]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec);
  const url = isPath ? pathToFileURL(resolve(spec)).href : spec;
  const mod = (await import(url)) as Record<string, unknown>;
  const factory = (mod.default ?? mod[exportName]) as (() => T) | undefined;
  if (typeof factory !== 'function') {
    throw new Error(`${spec} 必须导出 ${exportName}() 工厂（或 default 导出工厂）`);
  }
  return factory();
}

/** `--stt aliyun|qwen-realtime|noop|canned|<path>` */
async function buildStt(
  spec: string,
  creds: {
    akId: string; akSecret: string; appkey: string; region: string;
    maxSentenceSilenceMs: number; vocabularyId?: string;
  },
): Promise<SttProvider> {
  if (spec === 'noop') return noopStt();
  if (spec === 'canned') return cannedStt();
  if (spec === 'aliyun') {
    return aliyunStt(creds, (line) => { console.log(`  [asr] ${line}`); });
  }
  if (spec === 'qwen-realtime') {
    const apiKey = process.env['DASHSCOPE_API_KEY'] ?? '';
    if (!apiKey) {
      throw new Error('STT=qwen-realtime 需要 DASHSCOPE_API_KEY（和 CosyVoice 用的是同一个 key）');
    }
    // 端点由谁判：默认我们控（`turn_detection: null`，静音窗见 `VOICE_COMMIT_MS`）；
    // `QWEN_ASR_TURN_DETECTION=vad` 交给服务端（`speech_stopped → 定稿` 139–204 ms，
    // 比手动 commit 的 261 ms 快，但拿走了封段权，`VOICE_COMMIT_MS` 等旋钮全部失效）
    const turnDetection = process.env['QWEN_ASR_TURN_DETECTION'] === 'vad' ? 'vad' : 'manual';
    return qwenRealtimeStt(
      {
        apiKey,
        ...(process.env['QWEN_ASR_URL'] ? { url: process.env['QWEN_ASR_URL'] } : {}),
        ...(process.env['QWEN_ASR_MODEL'] ? { model: process.env['QWEN_ASR_MODEL'] } : {}),
        turnDetection,
        vadSilenceMs: envNumber('QWEN_ASR_VAD_SILENCE_MS', 200),
      },
      (line) => { console.log(`  [asr] ${line}`); },
    );
  }
  return loadProvider<SttProvider>(spec, 'stt');
}

/** `--tts cosyvoice|omni|mimo|silent|<path>` */
async function buildTts(spec: string): Promise<TtsProvider> {
  if (spec === 'silent') return silentTts(24_000);
  if (spec === 'cosyvoice') {
    if (!process.env['DASHSCOPE_API_KEY']) {
      throw new Error('DASHSCOPE_API_KEY 未设置（CosyVoice 用的是 DashScope API key，不是阿里云 AK/SK）');
    }
    // 情绪表达有两档，见 `cosyvoice.ts` 顶部；模式由 COSYVOICE_EMOTION_MODE 选：
    //   prosody（默认）：rate/pitch 缩放，系统音色可用，最省延迟
    //   instruction：自由指令，只有复刻/设计音色吃，首包多 ~90 ms
    // 系统音色配 instruction 会被服务端拒（428）。
    // **默认值只有一处**：`cosyvoice.ts` 的 `DEFAULT_COSYVOICE_EMOTION_MODE`。
    // （以前这里写死 `=== 'instruction'`，等于默认值在两处「碰巧一致」，
    // 那边一改就漂成「main 说关、provider 说开」。）
    return cosyVoiceTts({
      apiKey: process.env['DASHSCOPE_API_KEY'],
      url: process.env['COSYVOICE_URL'],
      model: process.env['COSYVOICE_MODEL'],
      voice: process.env['COSYVOICE_VOICE'],
      useInstruction:
        (process.env['COSYVOICE_EMOTION_MODE'] ?? DEFAULT_COSYVOICE_EMOTION_MODE) === 'instruction',
      // 每个 task 的「建立 / 首包」两段，常开落到当前档案（见 `tts.task`）
      onTask: (info) => { auditSlot.emit(EVENTS.ttsTask, { ...info }); },
      // 流式 task 的分批送达明细，收尾时落一次（见 `tts.done`）
      onDone: (info) => { auditSlot.emit(EVENTS.ttsDone, { ...info }); },
      // 首块 600 ms 还没回来：**当场**采这一条 socket（`unacked`/`rto` 只在那一瞬有意义）
      onStall: (info) => {
        void sampleSocket(info.local_port).then((socket) => {
          auditSlot.emit(EVENTS.ttsStall, { ...info, socket });
        });
      },
    });
  }
  if (spec === 'omni') {
    if (!process.env['DASHSCOPE_API_KEY']) {
      throw new Error('DASHSCOPE_API_KEY 未设置（omni 朗读机用的是 DashScope API key）');
    }
    // 用 omni 念 dsh 的答案 —— 全链路单一音色（S5）。
    // 代价与门槛见 `omni-tts.ts` 文件头：语速 ~4.0–4.4 字/秒（CosyVoice 5.45–5.66）、
    // 首块 629–781 ms（CosyVoice 350–390）。
    return omniTts({
      apiKey: process.env['DASHSCOPE_API_KEY'],
      model: process.env['OMNI_SHADOW_MODEL'],
      log: (line) => { console.log(line); },
    });
  }
  if (spec === 'mimo') {
    if (!process.env['MIMO_API_KEY']) {
      throw new Error('MIMO_API_KEY 未设置（用 --tts silent 可跳过 TTS）');
    }
    // 风格提示词：MiMo 的 TTS 是「聊天式」的 —— 风格放进 user 消息，要念的文本放进
    // assistant 消息。基础音色 + 五种情绪的变体都由 `emotion.ts` 提供，可用环境变量覆盖。
    return mimoTts({
      voice: process.env['MIMO_TTS_VOICE'] ?? DEFAULT_TTS_VOICE,
      baseStyle: process.env['MIMO_TTS_STYLE'] ?? BASE_STYLE,
      // 每个情绪一个可选覆盖；key 从单一事实来源来，加情绪不用改这里
      overrides: Object.fromEntries(
        Object.keys(EMOTIONS).map((key) => [
          key,
          process.env[`MIMO_TTS_STYLE_${key.toUpperCase()}`],
        ]),
      ),
    });
  }
  return loadProvider<TtsProvider>(spec, 'tts');
}

interface AgentBundle {
  readonly agent: AgentProvider | null;
  /** dsh 专用：进程句柄要留着，退出时 stop() */
  readonly dsh: DshSession | null;
}

/** `--agent dsh|echo|none|<path>` */
async function buildAgent(
  spec: string,
  dsh: { workDir: string; useSdk: boolean; provider: string; model: string; log: (line: string) => void },
  announceStore: AnnounceStore | null,
): Promise<AgentBundle> {
  if (spec === 'none' || spec === '') {
    return { agent: null, dsh: null };
  }
  if (spec === 'echo') {
    return { agent: echoAgent(), dsh: null };
  }
  if (spec === 'dsh') {
    const session = new DshSession({
      workDir: dsh.workDir,
      program: process.env['DSH_BIN'],
      mode: dsh.useSdk ? 'sdk' : 'headless',
      patch: process.env['DSH_PATCH'],
      provider: dsh.provider,
      model: dsh.model,
      log: (l: string) => { console.log(`  [session] ${l}`); },
    });

    /**
     * 流式文本：只在**真的超过门槛**时才出声。
     *
     * 现在只打日志 —— 把"插件 → 侧通道 → 门槛"这条链先验证到位，再接 TTS。
     * 这条日志本身就是仪表：`释放前 N 字` 出现说明这一轮是长回答，没出现说明
     * 整段不到 20 token（走原来的整段路径）。
     */
    session.onLive = (event) => {
      if (event.type === 'start') {
        const chars = [...event.text].length;
        console.log(
          `  流式    释放前 ${chars} 字：${JSON.stringify(event.text.slice(0, 40))}`,
        );
      } else if (event.type === 'end') {
        console.log(
          `  流式    ${event.streaming ? '流式' : '整段'}交付 ${event.tokens} token`,
        );
      }
    };

    return { agent: new VoiceAgent(session, dsh.log, announceStore), dsh: session };
  }
  return { agent: await loadProvider<AgentProvider>(spec, 'agent'), dsh: null };
}

/** 证书从文件读，路径只走环境变量 —— 部署细节不进源码。 */
function loadTls(): { key: Buffer; cert: Buffer } | undefined {
  const keyPath = process.env['MIAI_TLS_KEY'] ?? '';
  const certPath = process.env['MIAI_TLS_CERT'] ?? '';
  if (!keyPath || !certPath) {
    // 只给一半是配错了，不是「没配」—— 静默降级成明文会让人以为已经加密了
    if (keyPath || certPath) {
      const given = keyPath ? 'MIAI_TLS_KEY' : 'MIAI_TLS_CERT';
      const absent = keyPath ? 'MIAI_TLS_CERT' : 'MIAI_TLS_KEY';
      fail(`只给了 ${given}，缺 ${absent}：TLS 要么两个都给，要么都不给`);
    }
    return undefined;
  }
  try {
    const cert = readFileSync(certPath);
    // 到期检查：过期的证书服务端照常启动、照常监听，只是每一次握手都失败 ——
    // 客户端只看到「连不上」，日志里一个字都没有。所以在这里喊出来。
    for (const line of expiryWarning(cert) ?? []) {
      console.warn(`  ${line}`);
    }
    return { key: readFileSync(keyPath), cert };
  } catch (error) {
    fail(`TLS 证书读不到：${(error as Error).message}`);
  }
}

/** 启动期配置错误：说清楚是哪一项、该怎么改，然后退出。 */
function fail(message: string): never {
  console.error(`\n启动失败：${message}\n`);
  process.exit(2);
}

/**
 * 设备鉴权：`MIAI_TOKENS` 指向一个文件，每行 `token` 或 `token:deviceId`。
 *
 * - 不配就**不鉴权**（只可能用于本机地址 —— 由 `bind-policy.ts` 把关）
 * - 配了就必须首帧 `Hello`，且 token 要过强度校验（见 `tokens.ts`）
 * - 文件变了自动重读，**吊销不必重启进程**
 * - 写了 `token:deviceId` 就是真绑定：`Hello.deviceId` 对不上同样拒绝
 */
function loadAuthenticator(log: (line: string) => void): ((hello: { deviceId?: string; token?: string }) => boolean) | undefined {
  const path = process.env['MIAI_TOKENS'] ?? '';
  if (!path.trim()) return undefined;

  const resolved = tokenFilePath(path);
  // 启动时就报出弱/错 token，别等到设备连上来才发现「配了等于没配」
  const { entries, bad } = readTokenFile(resolved);
  for (const item of bad) {
    fail(
      `${resolved} 第 ${item.line} 行不合格：${describeTokenProblem(item.raw, item.problem)}\n`
      + '（要重新发一个：node src/pair.ts new --device <id>）',
    );
  }
  if (entries.length === 0) {
    fail(`${resolved} 里没有任何可用的 token`);
  }

  const gate = new TokenGate(resolved, log);
  console.log(`鉴权      ${entries.length} 个设备 token（来自 ${resolved}，改动会自动重读）`);
  return (hello) => typeof hello.token === 'string' && gate.match(hello.token, hello.deviceId) !== null;
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
 * 第二个才是真正的命令。TurnJudge 对「小爱同学。」给 0.957（它确实是完整的一句话），
 * 所以模型治不了这个，只能靠这条领域规则。
 */
/**
 * 服务端判句所需静音（`max_sentence_silence`）。
 *
 * 800 → 400 → 200：这一段是**纯等待**，用户说完要干等这么久才拿到 `SentenceEnd`。
 * 同机实测 400 与 200 差 294 ms（① 中位 640 → 346），比流式 TTS 的收益还大。
 *
 * 试过 120（2026-11-17，当日回放）：**反而更慢** —— ① 中位 400 → 960。切得太碎，
 * ASR 在用户换气处就断言句，判停器随后再等一截把后半句并回来，最后一句定稿反倒
 * 更晚。数字在 README 的回放对比表里，别再凭直觉往下砍。
 *
 * 敢砍到 200 是因为下游补了一层：`max_sentence_silence` 计的是**收到的音频里的静音**，
 * 说话人在数字组之间的换气（实测 200–400 ms）会被当成句尾，实测把
 * 「#W8665881」切成两句。切早了本身不致命 —— 句段由判停器合并
 * （`UtteranceAssembler` 把连续几句拼成一轮），`waitBudgetSequenceMs` 再单独给
 * 「结尾是数字/井号/连词」那一类一份更大的等待预算。
 *
 * 另有一条硬约束：上行能量门的 `holdMs`（默认 2000）必须远大于这个值，否则
 * 客户端停推之后服务端再也攒不到静音，句尾永远不来 —— 见
 * `docs/ALIYUN-ASR-PROBED.md` §5.1。
 */
const DEFAULT_SENTENCE_SILENCE_MS = 200;

/**
 * 读 `cloud/.env`（KEY=VALUE，忽略 # 注释与空行）。
 *
 * 不引依赖：格式就这么点。**已存在的环境变量优先**，所以命令行临时覆盖仍然有效。
 */
function loadDotEnv(): void {
  const path = join(process.cwd(), '.env');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count += 1;
    }
  }
  if (count > 0) {
    console.log(`凭据    ${path}（${count} 项）`);
  }
}

/**
 * `MIAI_LOG_TS=1`：给每一行日志加一个进程启动以来的毫秒时间戳。
 *
 * 只在排查时开 —— 平时日志的格式有人 grep，加前缀会连累所有既有脚本。
 * 有了它能一次把「本轮开始 → 首字 → 送批 → 首包 → 下行首块」对齐到毫秒，
 * 否则只能拿几个孤立的分段数互相猜（③ 里就有 300–400 ms 一直是这么猜没的）。
 */
function installLogClock(): void {
  if (process.env['MIAI_LOG_TS'] !== '1') {
    return;
  }
  const origin = performance.now();
  const raw = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    raw(`+${(performance.now() - origin).toFixed(0).padStart(6, '0')}ms`, ...args);
  };
}

/** 审计出口的形状：`agent.*` / `tts.*` 事件往哪儿写。 */
export type AuditSink = (name: string, data: Record<string, unknown>) => void;

/**
 * 审计出口的**槽位**：进程里所有共用件（`FrontedAgent`、TTS provider）都往这里写，
 * 而真正的接收方（档案）是**每连接一份**。
 */
export interface AuditSlot {
  /** 当前挂着的那个（`null` = 没人接）。排障/单测用，不参与装配。 */
  peek(): AuditSink | null;
  /**
   * 挂上 / 摘掉。
   *
   * 传 `expected` 时是**所有权守卫**：只有「槽里现在挂的正是我当初挂的那个」才摘，
   * 否则什么也不做 —— 旧连接断开时不能把后来那条连接的档案摘掉。
   * 不传 `expected`（`undefined` / `null`）保持老语义：直接覆盖。
   */
  set(sink: AuditSink | null, expected?: AuditSink | null): void;
  /** 转发一条事件；没有持有者、或持有者抛错，都只当没发生。 */
  emit(name: string, data: Record<string, unknown>): void;
  /** 挂上并返回**只摘自己那一份**的卸载函数。 */
  register(sink: AuditSink): () => void;
}

/**
 * 造一个审计槽位。
 *
 * 为什么要有所有权守卫：`FrontedAgent` 和 TTS provider 是**进程级共用**的，它们的
 * 回调只能写「当前这条连接」的档案。多设备并发（或快速重连）时，旧连接的生命周期
 * 收拾得比新连接晚，它那句 `setAudit(null)` 会把新连接的档案出口一起摘掉 ——
 * 之后所有 `agent.*` / `tts.*` 事件静默丢失，日志里一个字都没有。
 *
 * 现在 `voice-session` 传不传令牌由它自己决定：不传（1 参调用）就仍是
 * 「最后挂上的赢、`null` 直接清」；传了（2 参）就走所有权守卫。装配层两参都转发，
 * 所以那一侧改签名时这里不用再动。
 */
export function createAuditSlot(): AuditSlot {
  let current: AuditSink | null = null;

  const set = (sink: AuditSink | null, expected?: AuditSink | null): void => {
    if (sink === null && expected != null) {
      // 只摘自己挂上去的那一个：别人后来居上时保持原样
      if (current === expected) {
        current = null;
      }
      return;
    }
    current = sink;
  };

  return {
    peek: () => current,
    set,
    emit: (name, data) => {
      const sink = current;
      if (sink === null) {
        return;
      }
      // 审计抛错不能把一轮通话带下水（档案可能刚好在关）
      try {
        sink(name, data);
      } catch {
        // 忽略
      }
    },
    register: (sink) => {
      set(sink);
      return () => { set(null, sink); };
    },
  };
}

/**
 * 审计出口的**当前持有者**：哪条连接在写档案。
 *
 * 承载两类事件：`agent.*`（快车道问了什么/答了什么）和 `tts.task`（建立/首包两段）。
 * 同时只有一个设备在用时归属精确；多设备并发会写到最后连上的那条（见
 * {@link createAuditSlot} 的所有权守卫）。
 */
const auditSlot = createAuditSlot();

/** `FrontedAgent` 的装配结论，见 {@link shouldCreateFrontedAgent}。 */
export interface FrontedPlan {
  /** 要不要造这个装饰器。`false` 时 agent 保持原样（纯 `VoiceAgent`）。 */
  readonly create: boolean;
  /** 传给 `FrontedAgent` 的 `apiKey`：`''` = 级联文本模型关，只留 omni + dsh。 */
  readonly cascadeKey: string;
  /** 为什么是这个结论（`cascade` / `omni-only` / `off` / `no-key`），只用于日志与单测。 */
  readonly why: 'cascade' | 'omni-only' | 'off' | 'no-key';
}

/**
 * 造不造 `FrontedAgent` —— 纯判据，装配层照它执行。
 *
 * 这里错一次的代价是**静默**的：`FrontedAgent` 同时拿着级联文本快车道和 omni 音频
 * 车道的挂载点（`attachAudioLane` / `willServeAudio` / `noteServedTurn`）。以前它只在
 * 「有 `FAST_LANE_API_KEY`」时才造，于是删掉 qwen-flash 的 key 就顺手把 omni 也删了：
 * `VoiceAgent` 没有那些可选方法，`trackActivity` 转发的也是 `undefined`，宿主一路
 * 静默降级，日志里只有一句「快车道 关」。
 *
 * 所以现在的判据是**两件事任一成立**：
 * - 有 key 且没被 `FAST_LANE=0` 关掉 → 级联照旧；
 * - omni 车道会启用（`omniWillEnable`）→ 也必须造，但 `apiKey: ''`
 *   （`routeTurn()` 见 `cascade: false` 就直接跳过级联，只留 `live` + `dsh`）。
 *
 * **别把 `fastOff` 当成「omni 也关」**：那个开关只管文本快车道。
 */
export function shouldCreateFrontedAgent(input: {
  readonly fastOff: boolean;
  readonly fastKey: string;
  readonly omniEnabled: boolean;
}): FrontedPlan {
  if (!input.fastOff && input.fastKey !== '') {
    return { create: true, cascadeKey: input.fastKey, why: 'cascade' };
  }
  if (input.omniEnabled) {
    return { create: true, cascadeKey: '', why: 'omni-only' };
  }
  return { create: false, cascadeKey: '', why: input.fastOff ? 'off' : 'no-key' };
}

/**
 * 启动期管道计划。纯函数：只看传入的 `env`，不读 `process.env`。
 *
 * `main()` 在 `--agent dsh` 的流式装配上调用它；非法值、live 缺 key、
 * live 的 STT 不是 `qwen-realtime` 都从这里抛出去，由调用方打印后退出。
 */
export function assemblePipelinePlan(
  env: Record<string, string | undefined>,
  opts?: { readonly sttName?: string; readonly strict?: boolean },
): PipelinePlan {
  return resolveVoicePipelineFromEnv(env, opts);
}

/**
 * 热路径引擎的 `respond()` 不经过 `trackActivity` 包过的 `reply()`
 * （`toEngine()` 拿的是装饰器自己的 `this`）。
 *
 * 不在这里记账的话，空闲时钟停在进程启动那一刻：用户一直在说话，
 * 保活仍会在 180 分钟后往 dsh 打一枪。
 */
function watchEngineActivity(
  engine: FastVoiceEngine,
  state: { inflight: number; last: number },
): FastVoiceEngine {
  const respond: FastVoiceEngine['respond'] = (turn, signal) => {
    state.inflight += 1;
    let gen: AsyncIterable<EngineEvent>;
    try {
      gen = engine.respond(turn, signal);
    } catch (error) {
      state.inflight -= 1;
      state.last = Date.now();
      throw error;
    }
    return (async function* () {
      try {
        yield* gen;
      } finally {
        state.inflight -= 1;
        state.last = Date.now();
      }
    })();
  };
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'respond') return respond;
      if (prop === 'constructor') return Reflect.get(target, prop, target);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * 纯 live 的离线兜底。
 *
 * `VoiceAgent` 自己会在播报出口为空时写入 `announceStore`。`LiveOrchestrator`
 * 构造时把那条出口换成了任务总线，断线后再 `setTaskReporter(null)` 结论就丢了。
 * 这里在「还没有连接」和「连接把出口摘成 null」两种情况下都写回同一份队列。
 */
function armLiveOfflineAnnounce(
  orch: LiveOrchestrator,
  store: AnnounceStore | null,
): LiveOrchestrator {
  const persist = (speech: string, emotion?: string): void => {
    const pending = store?.push(speech, emotion) ?? 0;
    console.log(`  后台    没有连接，存入待补播（积压 ${pending} 条）`);
  };
  const fallbackAnnouncer = (speech: string, emotion?: string): void => {
    persist(speech, emotion);
  };
  const fallbackReport = (report: BackgroundTaskReport): void => {
    persist(report.verbatim ?? report.summary, report.emotion);
  };
  orch.setAnnouncer(fallbackAnnouncer);
  orch.setTaskReporter(fallbackReport);
  const setAnnouncer = (cb: ((speech: string, emotion?: string) => void) | null): void => {
    orch.setAnnouncer(cb ?? fallbackAnnouncer);
  };
  const setTaskReporter = (cb: ((report: BackgroundTaskReport) => void) | null): void => {
    orch.setTaskReporter(cb ?? fallbackReport);
  };
  return new Proxy(orch, {
    get(target, prop) {
      if (prop === 'setAnnouncer') return setAnnouncer;
      if (prop === 'setTaskReporter') return setTaskReporter;
      if (prop === 'constructor') return Reflect.get(target, prop, target);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LiveOrchestrator;
}

async function main(): Promise<void> {
  installLogClock();
  loadDotEnv();
  // 必须在这里（`loadDotEnv` 之后、任何 fetch 之前）：`fetch` 默认 4 秒就关连接，
  // 而真机两轮间隔 4–16 秒 —— 等于每轮重做一次 TCP+TLS，实测多花 130–190 ms。
  // 见 `http-agent.ts` 的实测账。
  const keepAliveMs = envNumber('MIAI_HTTP_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS);
  installHttpAgent(keepAliveMs);
  console.log(`HTTP     连接保活 ${keepAliveMs} ms（默认 4 秒会让每轮重新握手）\n`);
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
  /**
   * 设备型号。**入参激活**：给了才启用该设备的专属优化，空串走通用路径
   * （见 `src/devices/`）。`MIAI_DEVICE` 是旧名字，继续认。
   */
  const deviceSpec = opt('--device', process.env['PET_DEVICE'] ?? process.env['MIAI_DEVICE'] ?? '');

  // ---- 三个可替换件：都能按名字选内置实现，或给一个模块路径
  const sttSpec = opt('--stt', process.env['MIAI_STT'] ?? '');
  const ttsSpec = opt('--tts', process.env['MIAI_TTS'] ?? '');
  /**
   * Agent 选型：`--agent dsh|echo|none|<path>`。
   * 裸 `--agent`（后面不跟值）等价 `dsh`，`--echo` 是旧写法，继续支持。
   */
  const agentSpec = ((): string => {
    if (argv.includes('--echo')) return 'echo';
    const i = argv.indexOf('--agent');
    if (i < 0) return process.env['MIAI_AGENT'] ?? 'none';
    const next = argv[i + 1];
    return next !== undefined && !next.startsWith('--') ? next : 'dsh';
  })();

  const mode: ReplyMode = agentSpec === 'dsh'
    ? 'agent'
    : agentSpec === 'echo' ? 'echo' : 'none';

  /**
   * STT 选型必须在这里就定下来（不是等走到流式分支）。
   *
   * `--agent dsh` 的流式热路径由 {@link assemblePipelinePlan} 二选一，不再把
   * omni 和文本快车道装在同一个 `FrontedAgent` 上。`omniWillEnable` 只留给
   * **非流式**（回放 / 旧监听 / 识图冒烟）那条旧装配。
   *
   * omni 的硬前提仍是 `qwen-realtime`：车道的起跑线是 `onCommit`，NLS 的
   * `commitMs` 是 0。没有这个回调，车道会一条数据都不出却不报错，所以 live
   * 在 `strict` 下直接拒绝别的 STT。
   */
  const asrBackend = opt('--asr', 'mimo');
  const resolvedStt = sttSpec === '' ? (asrBackend === 'aliyun' ? 'aliyun' : '') : sttSpec;
  const omniWanted = envString('OMNI_SHADOW') === '1';
  const omniKey = process.env['DASHSCOPE_API_KEY'] ?? '';
  /** 非流式旧装配：omni 车道真的会挂上（三件事同时成立）才造 `FrontedAgent`。 */
  const omniWillEnable = omniWanted && omniKey !== '' && resolvedStt === 'qwen-realtime';

  let pipelinePlan: PipelinePlan | null = null;
  let liveOrch: LiveOrchestrator | null = null;
  /**
   * TTS 造出来之后才挂得上热路径引擎（live 的编排器要它，cascade 的 `toEngine` 也要）。
   * 返回值走直线赋值：闭包里写的 `let` 出了函数，类型收窄看不见。
   */
  let finishPipeline: ((tts: TtsProvider) => {
    readonly orchestrator: LiveOrchestrator | null;
    readonly engine: FastVoiceEngine | undefined;
  }) | null = null;

  // `--listen 0` 仍然点名了这条装配。非法 `VOICE_PIPELINE` 必须在用法横幅之前失败，
  // 否则 `node src/main.ts --agent dsh --stt qwen-realtime --listen 0` 只会打印用法。
  const enteringVoicePipeline = agentSpec === 'dsh'
    && resolvedStt !== ''
    && (listen > 0 || argv.includes('--listen') || argv.includes('--stt'));
  if (enteringVoicePipeline) {
    let resolvedPlan: PipelinePlan;
    try {
      resolvedPlan = assemblePipelinePlan(process.env, { sttName: resolvedStt, strict: true });
    } catch (error) {
      fail((error as Error).message);
    }
    pipelinePlan = resolvedPlan;
    console.log(
      `管道      ${pipelinePlan.mode === 'live' ? 'Pure Live（Omni 单前台 + dsh 纯异步后台）' : 'Pure Cascade（ASR + 级联快车道/dsh + TTS）'}${pipelinePlan.explicit ? ' [VOICE_PIPELINE]' : ' [兼容推断]'}`,
    );
    for (const note of pipelinePlan.notes) {
      console.log(`          ${note}`);
    }
  }

  if (!replay && !listen && !askImage) {
    console.error('用法: node src/main.ts --replay <file.sbc> | --listen <port> | --ask-image <file>');
    console.error('  --host <addr>   监听地址（默认 127.0.0.1）。非本机地址必须同时配');
    console.error('                  MIAI_TOKENS 与 MIAI_TLS_KEY/MIAI_TLS_CERT，否则拒绝启动');
    console.error('  可替换件: --stt aliyun|qwen-realtime|noop|canned|<path>  --tts cosyvoice|mimo|silent|<path>');
    console.error('            --agent dsh|echo|none|<path>（裸 --agent 等价 dsh）');
    console.error(`  设备:     --device ${DEVICE_MODELS.join('|')}（v1 手机的型号提示；不给 = v1 基线）`);
    console.error('  其他:     [--work-dir <dir>] [--ffmpeg <path>] [--gap-ms 20]');
    console.error('            [--vocab-id <id>] 业务专属热词表 ID（控制台项目热词无需配置）');
    process.exit(2);
  }

  let agent: AgentProvider | null = null;
  let dshSession: DshSession | null = null;
  /**
   * 离线时的后台汇报队列。放 `~/.voice-agent/` 旁边（和会话 id 一个目录），
   * 路径可用 `MIAI_ANNOUNCE_FILE` 覆盖；空串 = 不持久化。
   */
  const announceStore = AnnounceStore.open({
    file: process.env['MIAI_ANNOUNCE_FILE'] ?? join(homedir(), '.voice-agent', 'announce.jsonl'),
    maxItems: envNumber('MIAI_ANNOUNCE_MAX', DEFAULT_ANNOUNCE_MAX),
    log: (line) => { console.log(line); },
  });
  try {
    ({ agent, dsh: dshSession } = await buildAgent(agentSpec, {
      workDir,
      useSdk: argv.includes('--dsh-sdk'),
      provider: opt('--provider', 'deepseek-official'),
      model: opt('--model', 'deepseek-flash'),
      log: (line) => { console.log(line); },
    }, announceStore));
  } catch (error) {
    console.error(`agent 装配失败: ${(error as Error).message}`);
    process.exit(2);
  }
  if (dshSession) {
    console.log(`agent     dsh  workDir=${workDir}  dsh=${process.env['DSH_BIN'] ?? 'dsh'}  mode=${argv.includes('--dsh-sdk') ? 'sdk' : 'headless'}`);
    console.log(`会话      ${dshSession.currentSessionId ?? '（新会话）'}`);
  } else if (agent) {
    console.log(`agent     ${agent.name}`);
  }

  /**
   * 前缀保活。
   *
   * 空闲久了 DeepSeek 的前缀缓存会过期（实测：4.7 小时仍热，23 小时凉），凉了之后
   * **当天第一次开口**要多等 1–3 秒重算整段前缀。这里在空闲时发一条极短请求把前缀
   * 焐热，代价是一天几次几乎免费的调用。
   *
   * 只在真的用 dsh 时才有意义：别的 provider 没有「前缀缓存」这回事。
   * `KEEPALIVE_MINUTES=0` 关掉。
   */
  let stopKeepalive: () => void = () => {};
  if (dshSession && agent) {
    /**
     * 保活专线：内层纯 `VoiceAgent` 单独留着。
     *
     * 保活要焐热的是 **dsh 那一侧**的前缀缓存。走快车道或直播编排的 `reply()`
     * 都会先被短句认领 —— 「（保活信号，不需要回应）」进不了 dsh，前缀照样凉，
     * 还会往账本里塞一条用户从没说过的话。保活始终直连 `dshAgent`。
     */
    const dshAgent = agent;
    const session = dshSession;

    const fastKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim();
    const fastOff = process.env['FAST_LANE'] === '0';
    const memoryPath = process.env['MEMORY_FILE'] ?? join(workDir, 'MEMORY.md');
    const memoryFile = new MemoryFile(memoryPath);
    const activity = newActivityState(Date.now());
    const keepaliveMinutes = envNumber('KEEPALIVE_MINUTES', 180);
    /**
     * 委派默认**关**（跟随线上）。`FAST_LANE_DELEGATE=1` 才打开。
     *
     * 保留 `!== '0'` 那个写法会让「什么都没设」变成打开 —— 而线上一直是关的。
     */
    const delegateEnabled = (process.env['FAST_LANE_DELEGATE'] ?? '0') !== '0';
    const fastModel = process.env['FAST_LANE_MODEL'] ?? 'qwen-flash';
    const cancelMode = ((): 'rpc' | 'interrupt' | 'off' => {
      const mode = process.env['FAST_LANE_CANCEL'];
      return mode === 'sigint' ? 'interrupt' : mode === 'off' ? 'off' : 'rpc';
    })();
    const fastBaseUrl = process.env['FAST_LANE_BASE_URL'] === undefined
      ? {}
      : { baseUrl: process.env['FAST_LANE_BASE_URL'] };

    // **投机的前置条件**：宿主得能取消在途那一轮。
    // 没有 `session/cancel` 时，快车道命中会在 dsh 那边留下一轮「用户没听过的回答」
    // （白花钱 + 幽灵历史），所以探测失败就退回串行 —— 串行压根不提前发 dsh。
    const resolveSpeculate = async (): Promise<boolean> => {
      const wantSpeculate = process.env['FAST_LANE_SPECULATE'] !== '0';
      if (!wantSpeculate) return false;
      const canCancel = await session.probeCancelSupport(20_000);
      console.log(canCancel
        ? '快车道    投机=开（宿主支持 session/cancel，命中时可作废在途那一轮）'
        : '快车道    投机=关 → 退回串行（宿主没有 session/cancel，作废不了在途那一轮）');
      return canCancel;
    };

    const logFastLaneOn = (): void => {
      console.log(
        `快车道    开（${delegateEnabled ? '短句闲聊直答，其余交给 dsh' : '纯聊天模型，不委派'}；FAST_LANE=0 关闭）  `
        + `model=${fastModel}`
        // 这几个都是「改了没生效」的高发项（.env 没重启 / 名字打错），打出来一眼能对
        + ` hedge=${envNumber('FAST_LANE_HEDGE', 2)}`
        + ` specMinChars=${envNumber('FAST_LANE_SPEC_MIN_CHARS', 6)}`
        + ` window=${envNumber('FAST_LANE_WINDOW_CHARS', 800)}`
        + ` maxChars=${envNumber('FAST_LANE_MAX_CHARS', 14)}`
        + ` partialSpeculate=${process.env['FAST_LANE_PARTIAL_SPECULATE'] !== '0' ? 'on' : 'off'}`
        + ` delegate=${delegateEnabled ? 'on' : 'OFF（纯聊天）'}`,
      );
      // 记忆条数打出来：mock 记忆混进生产最常见的原因就是探针脚本写进了真文件
      // （探针一律用 `MEMORY_FILE=/tmp/...`，见 docs/OPS-RECORD.md §9.3）
      console.log(`记忆      ${memoryPath}（${memoryFile.entries().length} 条，快车道只读）`);
    };

    if (pipelinePlan !== null && pipelinePlan.mode === 'live') {
      // pure-live-assembly：只要直播编排。文本级联不装。
      console.log('快车道    关（纯 live：不加载文本级联快车道）');
      finishPipeline = (tts) => {
        const orch = new LiveOrchestrator({
          inner: dshAgent,
          tts,
          // 编排器要的是一整段注记；记忆文件返回的是几条。
          memory: (text) => memoryFile.relevant(text).join('\n'),
          log: (line) => { console.log(line); },
        });
        const surfaced = armLiveOfflineAnnounce(orch, announceStore);
        liveOrch = orch;
        agent = trackActivity(surfaced, activity);
        const rawEngine = orch.toEngine();
        return { orchestrator: orch, engine: watchEngineActivity(rawEngine, activity) };
      };
    } else if (pipelinePlan !== null && pipelinePlan.mode === 'cascade') {
      // pure-cascade-assembly：只要级联，或关掉快车道后的直连 dsh。不接 omni 发声。
      if (pipelinePlan.useCascadeFastLane) {
        const speculate = await resolveSpeculate();
        const cascadeAgent = new CascadeAgent({
          inner: dshAgent,
          apiKey: pipelinePlan.cascadeKey,
          model: fastModel,
          ...fastBaseUrl,
          timeoutMs: envNumber('FAST_LANE_TIMEOUT_MS', 1_200),
          speculate,
          cancelMode,
          maxChars: envNumber('FAST_LANE_MAX_CHARS', 14),
          prefetch: process.env['FAST_LANE_PREFETCH'] !== '0',
          partialSpeculate: process.env['FAST_LANE_PARTIAL_SPECULATE'] !== '0',
          specMinChars: envNumber('FAST_LANE_SPEC_MIN_CHARS', 6),
          windowChars: envNumber('FAST_LANE_WINDOW_CHARS', 800),
          keepTurns: envNumber('FAST_LANE_KEEP_TURNS', 0),
          hedge: envNumber('FAST_LANE_HEDGE', 2),
          delegateEnabled,
          taskStatus: () => session.taskStatus(),
          memory: (text) => memoryFile.relevant(text),
          log: (line) => { console.log(line); },
          audit: (name, data) => { auditSlot.emit(name, data); },
        });
        agent = trackActivity(cascadeAgent, activity);
        logFastLaneOn();
        finishPipeline = (tts) => {
          // `CascadeEngineOptions` 只有时钟。流式增量由引擎自己 `attachLiveSink`，
          // 这里再传 onLiveAvailable 对不上签名，也会和引擎内部那一次挂载叠在一起。
          const rawEngine = cascadeAgent.toEngine(tts);
          return { orchestrator: null, engine: watchEngineActivity(rawEngine, activity) };
        };
      } else {
        console.log(`快车道    ${fastOff ? '关（FAST_LANE=0）' : '关（没有 FAST_LANE_API_KEY / DEEPSEEK_API_KEY）'}`);
        agent = trackActivity(dshAgent, activity);
        // 不挂热路径引擎：TurnRunner 用 AgentEngineAdapter 包这份 dsh。
      }
    } else {
      // legacy-fronted-assembly：回放 / 旧监听 / 识图。流式热路径不进这里。
      const speculate = await resolveSpeculate();
      const fronted = shouldCreateFrontedAgent({ fastOff, fastKey, omniEnabled: omniWillEnable });
      if (!fronted.create) {
        console.log(`快车道    ${fastOff ? '关（FAST_LANE=0）' : '关（没有 FAST_LANE_API_KEY / DEEPSEEK_API_KEY）'}`);
      } else {
        agent = new FrontedAgent({
          inner: dshAgent,
          // `''` = 级联文本模型关（omni-only 装配）：`FrontedAgent` 内部按
          // `apiKey !== ''` 报 `cascade: false`，`routeTurn()` 于是只可能给 `live` 或 `dsh`
          apiKey: fronted.cascadeKey,
          model: fastModel,
          ...fastBaseUrl,
          timeoutMs: envNumber('FAST_LANE_TIMEOUT_MS', 1_200),
          // 投机双轨：dsh 与快模型同时发。关掉就退回串行（委派轮要白等一次判定）。
          // 前置条件：宿主必须能取消在途那一轮（启动时探测，见 `resolveSpeculate`）。
          speculate,
          // 胜出后怎么处置在途的慢车道那一轮：rpc（默认）/ interrupt / off
          cancelMode,
          maxChars: envNumber('FAST_LANE_MAX_CHARS', 14),
          // 判停前起跑：A/B 用，`FAST_LANE_PREFETCH=0` 关掉就退回「开轮才发请求」
          prefetch: process.env['FAST_LANE_PREFETCH'] !== '0',
          // 中间结果投机：比定稿再往前提，但文本是猜的（定稿确认是前缀才认领）
          partialSpeculate: process.env['FAST_LANE_PARTIAL_SPECULATE'] !== '0',
          // 投机的最小字数：默认 6。2026-11-18 试过降到 2，请求涨 2.5 倍、端到端 p50 没动
          // （14 场回放，见 OPS-RECORD §12.8），已退回。这里留旋钮不再改代码。
          specMinChars: envNumber('FAST_LANE_SPEC_MIN_CHARS', 6),
          // 窗口越小首字越快（快车道只答短句）
          windowChars: envNumber('FAST_LANE_WINDOW_CHARS', 800),
          // 攒几轮快车道对话就强制委派一次「顺便刷 dsh 上下文」。
          // **设 0 = 永不因计数转交**：那几轮会在下一次真正需要 dsh 的轮次一并注入。
          keepTurns: envNumber('FAST_LANE_KEEP_TURNS', 0),
          // 对冲份数：同一句并发发 N 份取最先回来的。落败的在拿到响应头前就被掐掉。
          hedge: envNumber('FAST_LANE_HEDGE', 2),
          delegateEnabled,
          // 后台任务事实来自 dsh 自己的事件，不发请求 —— 「好了吗」能照实答，不用等一轮 dsh
          taskStatus: () => session.taskStatus(),
          // 长期记忆：只读同一个 MEMORY.md（写权限在 dsh 的 remember 工具手里）
          memory: (text: string) => memoryFile.relevant(text),
          log: (line) => { console.log(line); },
          // 全量审计：每次请求的 messages、模型的原文、以及被作废的那几趟
          audit: (name, data) => { auditSlot.emit(name, data); },
        });
        if (fronted.why === 'omni-only') {
          // 这一行必须说清「为什么还有 FrontedAgent，但 qwen-flash 不会响」：
          // 否则日志上看到的是「快车道 关」，而装配自检里又冒出个 FrontedAgent。
          console.log(
            '快车道    仅启用 omni 音频车道（级联文本模型已关：'
            + `${fastOff ? 'FAST_LANE=0' : '没有 FAST_LANE_API_KEY / DEEPSEEK_API_KEY'}）`
            + '；闲聊/长句走 omni 或 dsh',
          );
        } else {
          logFastLaneOn();
        }
      }
      // 包在最外层：真对话走 `reply()` 记账。保活不走这里，它直连 `dshAgent`。
      agent = trackActivity(agent, activity);
    }
    console.log(keepaliveMinutes > 0
      ? `保活      空闲 ${keepaliveMinutes} 分钟发一次前缀保活（KEEPALIVE_MINUTES=0 关闭）\n`
      : '保活      关（KEEPALIVE_MINUTES=0）\n');
    stopKeepalive = startKeepalive({
      clock: systemClock,
      intervalMs: keepaliveMinutes * 60_000,
      idleFor: () => Date.now() - activity.last,
      isBusy: () => activity.inflight > 0,
      ping: async () => {
        const started = Date.now();
        // **直连 dsh 那一层**（见上面 `dshAgent`）：不经过快车道或直播编排，
        // 否则短句会被认领，dsh 根本没被叫到，前缀照样凉。
        // 活动账自己记：`inflight` 让「有人在飞」对下一次真对话、下一个保活周期
        // 都成立；`last` 要在这里刷新，否则 `idleFor()` 永远停在上一轮真对话的时刻。
        activity.inflight += 1;
        try {
          await dshAgent.reply(KEEPALIVE_PROMPT);
        } finally {
          activity.inflight -= 1;
          activity.last = Date.now();
        }
        console.log(`  [keepalive] 完成 ${Date.now() - started} ms`);
      },
      log: (line) => { console.log(line); },
    });
    process.on('exit', () => {
      stopKeepalive();
      liveOrch?.dispose();
    });
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

  // ---------------------------------------------------------------- 流式分支
  // `--stt` 显式给了就走流式路径；`--asr aliyun` 是旧写法，继续认。
  // `resolvedStt` 在参数解析后就算好了（omni 车道要不要挂取决于它，见上面）。
  if (resolvedStt !== '') {
    if (!listen) {
      console.error('流式识别只支持 --listen（没有 --replay 语义）');
      process.exit(2);
    }
    if (!agent) {
      console.error('流式识别需要一个 agent（收到 SentenceEnd 就要接一轮对话）');
      process.exit(2);
    }
    const akId = process.env['ALIYUN_AK_ID'] ?? '';
    const akSecret = process.env['ALIYUN_AK_SECRET'] ?? '';
    const appkey = process.env['ALIYUN_APPKEY'] ?? '';
    const region = process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai';
    if (resolvedStt === 'aliyun' && (!akId || !akSecret || !appkey)) {
      console.error('STT=aliyun 需要 ALIYUN_AK_ID / ALIYUN_AK_SECRET / ALIYUN_APPKEY');
      process.exit(2);
    }
    const sentenceSilenceMs = Number(
      opt('--sentence-silence', String(DEFAULT_SENTENCE_SILENCE_MS)),
    );
    // 热词表 ID 留空就不下发该字段（传不存在的 ID 会被服务端静默忽略，不报错）
    const vocabularyId = opt('--vocab-id', process.env['ALIYUN_VOCAB_ID'] ?? '');
    // 只有阿里云实现关心 region/appkey；换成别的实现时别把无关信息印出来
    const sttBanner = resolvedStt === 'aliyun'
      ? `region=${region}  appkey=${appkey.slice(0, 4)}****  silence=${sentenceSilenceMs} ms`
        + (vocabularyId ? `  vocab=${vocabularyId}` : '  vocab=(未配置)')
      : resolvedStt === 'qwen-realtime'
        ? `model=${process.env['QWEN_ASR_MODEL'] ?? 'qwen3-asr-flash-realtime'}`
          + `  端点由我们控（commit=${envNumber('VOICE_COMMIT_MS', 20)} ms）`
        : '(外部/内置实现，无需凭据)';
    console.log(`STT      ${resolvedStt}  ${sttBanner}\n`);

    const stt = await buildStt(resolvedStt, {
      akId,
      akSecret,
      appkey,
      region,
      maxSentenceSilenceMs: sentenceSilenceMs,
      ...(vocabularyId ? { vocabularyId } : {}),
    });
    const tts = await buildTts(ttsSpec === '' ? 'mimo' : ttsSpec);
    console.log(`可替换件 STT=${stt.name}  TTS=${tts.name}（${tts.sampleRate} Hz）\n`);
    // live 的编排器和 cascade 的热路径都要这份 TTS。非 dsh 流式这里是空装配。
    const pipelineHooks = finishPipeline?.(tts) ?? { orchestrator: null, engine: undefined };

    const turnJudgePython = envString('TURN_JUDGE_PYTHON') ?? '';
    const turnJudgeScript = envString('TURN_JUDGE_SCRIPT') ?? '';
    const turnJudgeEnabled = envString('TURN_JUDGE') !== '0'
      && turnJudgePython !== '' && turnJudgeScript !== '';

    /**
     * omni 怎么接。
     *
     * - `live`：前台发声，`serve` 恒为 `full`。`clip` 档已经删了，显式请求时仍按 full 出声。
     * - `cascade`：不发声。只有 `useOmniProbeOnly`（`OMNI_SHADOW=1` 且 `OMNI_ANSWER=off`）
     *   才挂一只只读探针。
     * - 没有管道计划（echo 等）：沿用旧的 `omniWillEnable` + `OMNI_ANSWER`。
     */
    const omniModel = envString('OMNI_SHADOW_MODEL');
    const modelOpt = omniModel === undefined ? {} : { model: omniModel };
    const pipelineOmniKey = (process.env['OMNI_API_KEY'] ?? process.env['DASHSCOPE_API_KEY'] ?? '').trim();
    let omniShadow: {
      readonly apiKey: string;
      readonly model?: string;
      readonly serve: 'off' | 'full';
    } | undefined;
    if (pipelinePlan !== null && pipelinePlan.mode === 'live') {
      const requested = (envString('OMNI_ANSWER') ?? '').trim().toLowerCase();
      if (requested !== '' && requested !== 'off' && requested !== 'full' && requested !== 'clip') {
        fail(`OMNI_ANSWER=${requested} 不合法（off|full；clip 已并入 full）`);
      }
      if (requested === 'clip') {
        console.log('管道      OMNI_ANSWER=clip 已取消，纯 live 按 full 出声');
      }
      omniShadow = { apiKey: pipelineOmniKey, serve: 'full', ...modelOpt };
      console.log(
        `影子    omni 前台开（${omniShadow.model ?? 'qwen3.8-omni-flash-realtime'}，`
        + `**会出声** serve=${omniShadow.serve}）\n`,
      );
    } else if (pipelinePlan !== null && pipelinePlan.mode === 'cascade') {
      if (pipelinePlan.useOmniProbeOnly) {
        omniShadow = { apiKey: pipelineOmniKey, serve: 'off', ...modelOpt };
        console.log(
          `影子    omni 只读探针（${omniShadow.model ?? 'qwen3.8-omni-flash-realtime'}，只量不发声）\n`,
        );
      } else if (omniWanted) {
        const why = pipelineOmniKey === ''
          ? 'OMNI_API_KEY / DASHSCOPE_API_KEY 为空'
          : resolvedStt !== 'qwen-realtime'
            ? `STT=${resolvedStt}（需要 qwen-realtime）`
            : 'OMNI_ANSWER 不是 off（只读探针要求 off，cascade 不接管发声）';
        console.log(`影子    OMNI_SHADOW=1 但没启用只读探针：${why}\n`);
      }
    } else {
      const omniAnswer = envString('OMNI_ANSWER') ?? 'off';
      if (!['off', 'full'].includes(omniAnswer)) {
        console.error(`OMNI_ANSWER=${omniAnswer} 不合法（off|full）`);
        process.exit(2);
      }
      omniShadow = omniWillEnable
        ? {
          apiKey: omniKey,
          serve: omniAnswer as 'off' | 'full',
          ...modelOpt,
        }
        : undefined;
      if (omniWanted && omniShadow === undefined) {
        console.log(
          '影子    OMNI_SHADOW=1 但没启用：'
          + (omniKey === '' ? 'DASHSCOPE_API_KEY 为空' : `STT=${resolvedStt}（需要 qwen-realtime）`)
          + '\n',
        );
      } else if (omniShadow !== undefined) {
        console.log(
          `影子    omni 旁路开（${omniShadow.model ?? 'qwen3.8-omni-flash-realtime'}，`
          + (omniShadow.serve === 'off' ? '只量不发声' : `**会出声** serve=${omniShadow.serve}`)
          + '）\n',
        );
      }
    }

    /**
     * 判停器侧车：**进程级一份，跨连接常驻**。
     *
     * 以前每条连接建一个、断开就 `stop()`。侧车是 python + 8.7 MB ONNX，冷启动
     * 实测 ~300 ms —— 真机每次重连（网络抖动 / 服务重启 / 重开 App）第一句都要
     * 付这一刀，而它刚好落在「用户说完 → 开一轮」里。常驻之后只有进程启动付一次。
     *
     * 预热：先用 1 s 静音跑一次推理把模型加载进来，别让第一次真说话的那轮承担。
     */
    /**
     * 语义判停（END 标签）：声学判停判不了「这句话说完了没有」，这一层只补这个洞。
     *
     * 和快车道共用一套凭据/端点（同一个 `qwen-flash`）—— 判停要的是快，不是聪明。
     * `SEMANTIC_END_TAG=0` 关掉，退回纯声学判停。
     */
    // 快车道的 key 只在它自己那个 if 块里可见，这里按同一优先级再取一次
    const semanticKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim();
    const semantic = envString('SEMANTIC_END_TAG') === '0' || semanticKey === ''
      ? null
      : semanticEndpoint({
        apiKey: semanticKey,
        ...(process.env['FAST_LANE_MODEL'] === undefined
          ? {}
          : { model: process.env['FAST_LANE_MODEL'] }),
        ...(process.env['FAST_LANE_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['FAST_LANE_BASE_URL'] }),
        timeoutMs: envNumber('SEMANTIC_END_TAG_TIMEOUT_MS', 400),
        log: (line) => { console.log(line); },
      });
    if (semantic !== null) {
      console.log('语义判停  开（END 标签，与静候窗重叠，超时按「说完了」）  SEMANTIC_END_TAG=0 关闭');
    }
    const turnJudgeClient = turnJudgeEnabled
      ? new TurnJudge({
        python: turnJudgePython,
        script: turnJudgeScript,
        log: (line) => { console.log(`  ${line}`); },
      })
      : null;
    if (turnJudgeClient !== null) {
      // 低幅正弦而不是全零：全零在 log-mel 里是 −∞ dB，不该拿它当"正常输入"试模型
      const warmup = Buffer.alloc(UPSTREAM_SAMPLE_RATE * 2);
      for (let i = 0; i < warmup.length / 2; i += 1) {
        warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2);
      }
      const startedAt = Date.now();
      const p = await turnJudgeClient.predict(warmup);
      console.log(
        `判停    侧车预热 ${Date.now() - startedAt} ms（p=${p.toFixed(3)}）`
        + '，之后所有连接共用这一份\n',
      );
      process.on('exit', () => { turnJudgeClient.stop(); });
    }

    // 增益先算好并打出来：调音时最想知道「现在到底是几倍、门限在哪」
    const ttsGain = envNumber('MIAI_TTS_GAIN', envNumber('TTS_GAIN', 1));
    const micGain = envNumber('MIAI_MIC_GAIN', envNumber('MIC_GAIN', 4));
    /**
     * 能量门限（按**放大后**算）。
     *
     * 实测（M2004J7AC、增益 4×、家里安静房间，84 个 2 s 窗口）：
     * 底噪峰值集中在 −60…−51 dBFS（p10 −58.3、p50 −53.7），
     * 说话时在 −20…0 dBFS，中间几乎空着。
     *
     * 原来取 −58：**低于底噪**，门一直开着 → 噪声当语音推给 ASR →
     * 服务端判「无有效语音」踢连接 → 6 分钟里建连 45 次、同时存活 4 条。
     * 后来取 −40：比最响的底噪高 10 dB，比最轻的说话低 10 dB。
     *
     * **−40 仍然太低**（线上 20261122-210720 实测）：那场有 6 段刚好擦过门
     * （放大后 −37…−39 dBFS，电视/远处人声），ASR 把它们幻觉成「嗯。」「Thank you.」
     * 「对。」—— omni 白答了 6 份（1.0–1.9 s 音频）又整份删掉，还顺手把「对。」做成了一轮。
     * 同一场按段峰值重算：**开成轮的 14 段全在 −16…−6 dBFS，没开轮的 6 段全在 −51…−43**，
     * 37 dB 的空档、零重叠。所以门抬到 −30（线上 `.env` 已设）：比垃圾段高 7 dB、
     * 比最轻的说话低 14 dB。**这是电平判据，不是段长判据** —— 段长两侧重叠得厉害。
     */
    const peakDbfs = envNumber('VOICE_PEAK_DBFS', -30);
    console.log(
      `增益    上行 ${micGain}×（能量门 ${peakDbfs} dBFS，按放大后算）  下行 ${ttsGain}×\n`,
    );

    // 横幅只能先打 v1 的默认能力：真正走哪个版本要等连接时的 `Hello` 自报
    const device = resolveV1Device(deviceSpec);
    console.log(`设备     ${device.label}（v1 默认，v2 设备在 Hello 里自报能力）：${describeCapabilities(device.capabilities)}\n`);

    // 宠物环开没开必须说出来。不说的话，「它一直不说话」分不清是
    // 「判断了但决定不说」还是「这一层根本没装」（见 archive/HANDOFF.md 的教训）
    const proactiveOn = process.env['PET_PROACTIVE'] === '1';
    console.log(
      proactiveOn
        ? '宠物环   开（主动开口）：心跳每 '
          + `${envNumber('PET_TICK_MS', 3_000)} ms，离场 ${envNumber('PET_GREET_AWAY_MS', DEFAULT_PET_TIMING.greetAfterAwayMs)} ms 后重戴会打招呼\n`
        : '宠物环   关（PET_PROACTIVE≠1）：只跑对话环，不会主动开口\n',
    );

    // 装配自检：交给服务器的是哪个类、有没有车道方法。
    // 这一行存在的理由：`trackActivity()` 会把 agent 包成一个普通对象，
    // 它漏转发可选能力时**不报错**，只表现为「omni 一次都不接管」。
    console.log(
      `  装配    agent=${agent?.constructor?.name ?? '?'}`
      + ` attach=${typeof agent?.attachAudioLane} will=${typeof agent?.willServeAudio}`,
    );
    const plan = pipelinePlan;
    const engine = pipelineHooks.engine;
    const orchestrator = pipelineHooks.orchestrator;
    const code = await runVoiceServer({
      port: listen,
      host: opt('--host', '127.0.0.1'),
      device: deviceSpec,
      ffmpegPath: ffmpeg,
      agent,
      stt,
      tts,
      ...(plan === null ? {} : { pipelineMode: plan.mode }),
      ...(engine === undefined ? {} : { engine }),
      ...(orchestrator === null
        ? {}
        : {
          speakAnnounce: (item, playAudio) => orchestrator.speakBackgroundReport(item, playAudio),
          cancelAnnounce: () => { orchestrator.cancelBackgroundSpeech(); },
          onFallbackAnnounceSpoken: (item, interrupted) => {
            orchestrator.noteFallbackAnnounceSpoken(item, interrupted);
          },
        }),
      // omni 影子旁路：默认不传 = 这条连接不会去连 DashScope，零成本
      ...(omniShadow === undefined ? {} : { omniShadow }),
      turnJudge: turnJudgeEnabled
        ? {
          pythonPath: turnJudgePython,
          scriptPath: turnJudgeScript,
          // 句子定稿后先静候这么久再问 TurnJudge。350 → 150 → 80 → 40 → 0：
          // 有了「静音一到就预跑判停」（`VOICE_PAUSE_DETECT_MS`），`SentenceEnd` 到达时
          // 概率早就算好了，这段静候只是白等 —— 回放实测 ② 从 113 → 41 ms，
          // 把这里归零后只剩取缓存的那一下。
          quietMs: envNumber('TURN_JUDGE_QUIET_MS', 0),
          // TurnJudge 判为「没说完」时再多等多久。700 → 400：日志里「没说完，再等 700 ms」
          // 出现得极密，一轮叠 2–3 次就是 1.4–2.1 秒纯等待。400 → 200：真机 17 次 extend
          // **全部等到放行、0 次用户接着说**，而且第二次评估的 p 与第一次几乎相同 ——
          // 那 400 ms 没换到任何信息（见 `docs/LATENCY-CLOSURE.md`）。
          //
          // ⚠️ 必须在这里读，不能在模块顶层：`loadDotEnv()` 是在 `main()` 里调的，
          // 模块顶层的 `envString()` 早于它执行，`.env` 里的值读不到 —— 2026-11-19
          // 线上设 200 后日志仍打「再等 400 ms」，就是这个顺序问题。
          extendMs: envNumber('TURN_JUDGE_EXTEND_MS', 200),
          // 延长次数上限。3 → 7：业界（LiveKit `max_delay` 2.5–3 s、Pipecat
          // TurnJudge `stop_secs` 3 s、Deepgram `eot_timeout_ms` 5 s）都留 2.5 秒以上
          // 的兜底，而我们原来只有 3×400=1.2 s —— 触发点比人家快、兜底却只有一半，
          // 用户说半句停下来想一下就会被强制收下。7×400 ≈ 2.8 s，对齐业界。
          maxExtensions: envNumber('TURN_JUDGE_MAX_EXT', 2),
          // 「判停说没说完」单独一个上限：那条分支不看任何文本信号，只按 p 再等
          // 一拍，而 p 是噪声（同一段音频两次回放，同一句 0.549 vs 0.189）。
          // 真机实测要 4 拍（1600 ms）才收下；这里收到 2 拍（800 ms），
          // 仍能覆盖正常换气 200–400 ms。另三类文本判据不受影响，照旧吃 7 的额度。
          maxUnsureExtensions: envNumber('TURN_JUDGE_MAX_UNSURE', 1),
          // 快照尾部最多留多少静音。官方约定是「音频顶到输入向量的末尾」——
          // 尾巴留静音等于把语音从窗口末尾推开，p 会被拉低（0 ms → 0.95，
          // 800 ms → 0.04）。留多少在噪声里，取小值只为方向正确。
          trailingTrimMs: envNumber('TURN_JUDGE_TRIM_MS', 20),
          threshold: envNumber('TURN_JUDGE_THRESHOLD', 0.5),
          // 中文单独一档：官方 benchmark 中文是最差的（85.8%，漏报 9.26% / 误报
          // 4.95%），方向是偏向说「没说完」。真机上完整短句「嗯，对。」给 0.22–0.41，
          // 真正没说完的「对吗？那句。」给 0.007–0.11 —— 用 0.5 会把前者判成没说完。
          // 0.35 落在这两簇中间，但样本只有 21 轮 —— 先按这个跑，用 `judge.decide`
          // 里的 `p` / `threshold` 复盘再定。
          thresholdCjk: envNumber('TURN_JUDGE_THRESHOLD_CJK', 0.35),
          // QoS：`②`（定稿→开轮）的总等待预算，兜底上限。0 = 不设。
          // 目的不是省时间，是让 `②` 有一个可预测的天花板 —— 真机 2026-11-18
          // 有 7/29 轮把分支额度吃干净，单轮白等 1.4 s。
          waitBudgetMs: envNumber('TURN_JUDGE_WAIT_BUDGET_MS', 200),
          // QoS：句尾像未完成的序列（数字/字母/「然后」…）时的豁免预算。
          // 这类句尾 p 判「没说完」是对的（念手机号每次停顿都真没说完），
          // 别让总预算把它掐掉。0 = 不启用。
          waitBudgetSequenceMs: envNumber('TURN_JUDGE_SEQUENCE_BUDGET_MS', 1_200),
          // **统一上限**：开轮静音的最大值，任何分支都不许绕过。
          // 取 650 的依据是真机 54 轮实测（`docs/EOT-SUPPLEMENT.md` §8）：
          // 开轮静音 500–1200 ms 的 7 轮**一次都没有**被用户接着说，而 <300 ms
          // 的 6 轮**全部**被接着说 —— 650 落在"免费窗口"里，超过它的等待
          // 换不来更低的误切。0 = 不设上限（回到旧行为）。
          maxOpenSilenceMs: envNumber('TURN_JUDGE_MAX_OPEN_SILENCE_MS', 650),
        }
        : undefined,
      ...(turnJudgeClient === null ? {} : { turnJudgeClient }),
      ...(semantic === null
        ? {}
        : { semantic, semanticBudgetMs: envNumber('SEMANTIC_END_TAG_BUDGET_MS', 300) }),
      gate: {
        thresholdDbfs: peakDbfs,
        holdMs: envNumber('VOICE_HOLD_MS', 2000),
        prerollMs: envNumber('VOICE_PREROLL_MS', 800),
        // 静音多久就提前跑判停（和 ASR 的 max_sentence_silence 对齐）；0 = 关闭
        pauseDetectMs: envNumber('VOICE_PAUSE_DETECT_MS', 200),
    // 投机要比判停早：它的用途是给「提前合成音频」腾窗口，不是省自己的时间
    speculateMs: envNumber('VOICE_SPECULATE_MS', 100),
        // 端点由我们控的 ASR（qwen realtime）要宿主封段：静音到点 `commit`。
        // 服务端自己判句的 provider（NLS）必须留 0 —— 否则会在句子中间插一刀，
        // 把一个整句切成两段。40 ms 是标定后的默认值（配合下面的开轮门槛
        // 300/200，有声拆句 0）；单独用 40 而不要门槛会把「换气」当句尾。
        commitMs: envNumber('VOICE_COMMIT_MS', resolvedStt === 'qwen-realtime' ? 20 : 0),
        // **ASR 封段**比车道起跑晚多少。`commitMs` 同时点着两件事：omni 车道起跑
        // （越早越好）和 ASR 切段（切早了把句子切成两半 —— 真机 2026-11-23 13:37
        // 两轮都断在书名中间，第二个碎片被解成德语）。判停本来就要等 200–300 ms
        // 静音，所以晚到 150 ms 不花延迟。
        sttCommitMs: envNumber('VOICE_STT_COMMIT_MS', resolvedStt === 'qwen-realtime' ? 150 : 0),
        // 开轮门槛：定稿到达时「截至此刻」的连续静音够不够。SOTA 那边按「40 ms 窗
        // + 261 ms 解码 ≈ 301 ms」推的起点，中位数上几乎不增加等待；p 高的轮次用
        // 短档（听起来完整就不必等那么久）。只对 commit 路径生效。
        ...(resolvedStt === 'qwen-realtime'
          ? {
            openQuietMs: envNumber('VOICE_OPEN_QUIET_MS', 300),
            openQuietShortMs: envNumber('VOICE_OPEN_QUIET_SHORT_MS', 200),
          }
          : {}),
      },
      playbackTailMs: 600,
      /**
       * 下行增益。**默认应当是 1.0**：MiMo 的输出已经是满刻度（实测峰值 −0.5 dBFS），
       * 任何 >1 的增益都会把元音峰值压进软限幅 —— ×3 时波峰因数从 14.7 dB 掉到
       * 7.3 dB，听感是"扁、闷、语调怪"。要更响请调手机媒体音量，不要加这里。
       */
      ttsGain,
      /**
       * 上行增益。眼镜 mic 电平低，4.0 时小声说话才能推开能量门
       * （门限 `VOICE_PEAK_DBFS` 按**放大后**的电平算，见 `uplink-pipeline.ts`）。
       */
      micGain,
      // 调音用：`MIAI_LEVEL_LOG=2000` 每 2 s 打一行上行峰值（0 = 关）
      levelLogMs: envNumber('MIAI_LEVEL_LOG', 0),
      /**
       * 原始档案目录（空 = 不存）。一条连接一个目录，存原始 mSBC、放大前的 PCM、
       * 下行 PCM 和事件时间线 —— 出问题后能完整重放，见 `archive.ts`。
       * 旧的 `DUMP_DIR`（按轮次存、只覆盖播放期）已被它取代。
       */
      archiveDir: process.env['MIAI_ARCHIVE_DIR'] ?? '',
      archiveMaxMb: envNumber('MIAI_ARCHIVE_MAX_MB', 80),
      archiveKeep: envNumber('MIAI_ARCHIVE_KEEP', 20),
      // 连接建立/断开时把审计（快车道 + TTS 两段）接到这条档案上（见 `auditSlot`）。
      // 两参都转发：`voice-session` 只传 `sink` 时保持「最后挂上的赢」，传了
      // `expected` 令牌时由槽位做所有权守卫（旧连接收尾摘不掉新连接的档案）。
      setAudit: (
        sink: ((name: string, data: Record<string, unknown>) => void) | null,
        expected?: ((name: string, data: Record<string, unknown>) => void) | null,
      ) => { auditSlot.set(sink, expected); },
      photoDir: process.env['PHOTO_DIR'] ?? '',
      // 默认避开 `--listen` 自己，否则两条监听撞端口（EADDRINUSE）
      controlPort: envNumber('PHOTO_CTL_PORT', listen + 2),
      // 高清链路要等手机建 P2P + 设备写相册，20 s 不够（线上实测要 50 s+，
      // 那个 25 s 的 `MIAI_HQ_SHUTTER_TIMEOUT_MS` 只是快门，不含回传）
      photoTimeoutMs: envNumber('MIAI_PHOTO_TIMEOUT_MS', 60_000),
      // 要人动手的拍照只设一个兜底总时长（分段计时归设备）。
      // 兼容旧的两段变量：给了就相加
      confirmTimeoutMs: process.env['MIAI_CONFIRM_TIMEOUT_MS'] !== undefined
        || (process.env['MIAI_HQ_ARM_TIMEOUT_MS'] === undefined
          && process.env['MIAI_HQ_SHUTTER_TIMEOUT_MS'] === undefined)
        ? envNumber('MIAI_CONFIRM_TIMEOUT_MS', DEFAULT_CONFIRM_TIMEOUT_MS)
        : envNumber('MIAI_HQ_ARM_TIMEOUT_MS', 15_000) + envNumber('MIAI_HQ_SHUTTER_TIMEOUT_MS', 25_000),
      imageQuestion: '这张图里有什么？用一两句话口语化描述。',
      announceStore,
      tls: loadTls(),
      authenticate: loadAuthenticator((line) => { console.log(line); }),
      idleTimeoutMs: envNumber('MIAI_IDLE_TIMEOUT_MS', 45_000),
      serve: argv.includes('--serve') || process.env['MIAI_SERVE'] === '1',
      // 主动开口默认关：开着它会自己说话，得人明确要
      proactive: proactiveOn
        ? {
          params: {
            greetAfterAwayMs: envNumber('PET_GREET_AWAY_MS', DEFAULT_PET_TIMING.greetAfterAwayMs),
            chatterAfterIdleMs: envNumber('PET_CHATTER_IDLE_MS', DEFAULT_PET_TIMING.chatterAfterIdleMs),
            // 开麦到首帧上行音频的截止。小米实测 0.62 s，给到 1.5 s
            micOpenTimeoutMs: envNumber('PET_MIC_OPEN_TIMEOUT_MS', 1500),
          },
          listenMs: envNumber('PET_LISTEN_MS', DEFAULT_PROACTIVE.listenMs),
          tickMs: envNumber('PET_TICK_MS', 3_000),
        }
        : null,
    });
    dshSession?.stop();
    process.exit(code);
  }

  /**
   * 旧路径（`--replay` / 无 `--stt` 的本地监听）：**到这里才**加载 `legacy-pipeline`。
   *
   * 它一路拉进 `silero-vad` 与 `onnxruntime-node`（几十 MB 的 native 包），而生产的
   * 流式路径（`--stt ... --listen`）在上面那个分支就 `process.exit()` 了，永远走不到这里。
   * 顶层 `import` 会让每次启动都付这份加载钱 —— 改成按需之后，`--stt` 启动的
   * 依赖图里不再有 VAD/ORT（`tests/main-wiring.test.ts` 卡着这条）。
   */
  const { Pipeline } = await import('./legacy-pipeline.ts');
  const pipe = new Pipeline(ffmpeg, mode, agent);
  await sleep(200);       // 等 VAD 初始化

  const code = replay
    ? await runReplay(replay, pipe, gapMs)
    : await runListen(listen, pipe);

  // 常驻进程要显式关，否则 node 会因为子进程 stdin 仍打开而不退出
  dshSession?.stop();
  process.exit(code);
}

/**
 * 本文件是「被当成入口跑」（`node src/main.ts`）还是只是被 import 进来？
 *
 * 为什么需要这道守卫：`tests/main-wiring.test.ts` 要 import 本文件取纯函数做单测，
 * 而顶层 `void main()` 会当场打印用法并 `process.exit(2)` —— 整个测试进程直接死。
 *
 * 判据按 **URL** 比，不按字符串：`process.argv[1]` 可能是相对路径、盘符大小写也可能
 * 与 `import.meta.url` 不一致（Windows），所以两边都 realpath 再转 URL。
 * 不能只判「`argv[1]` 存在」：`node --test` 下它是测试文件，不是本文件。
 */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (entry === undefined || entry === '') {
    return false;
  }
  let entryUrl: string;
  try {
    entryUrl = pathToFileURL(realpathSync(entry)).href;
  } catch {
    // 文件不存在（打错/已删）时退回 resolve：比较结果同样可信
    entryUrl = pathToFileURL(resolve(entry)).href;
  }
  return normalizeFileUrl(entryUrl) === normalizeFileUrl(moduleUrl);
}

/** 盘符大小写、URL 里中文/空格的转义形式都可能不同，只比「像不像同一个文件」。 */
function normalizeFileUrl(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // 非法转义：保持原样再比
  }
  return process.platform === 'win32' ? decoded.toLowerCase() : decoded;
}

// `node src/main.ts`（含 `npm start`）仍然原样进 `main()`：无参运行时打印用法并以
// 退出码 2 结束，那是 `docs/CLOUD-ARCHITECTURE.md` §8 的启动自检。
if (isMainModule()) {
  void main();
}
