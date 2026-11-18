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
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VoiceAgent } from './agent.ts';
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './announce-store.ts';
import { DEFAULT_CONFIRM_TIMEOUT_MS } from './photo-inbox.ts';
import { aliyunStt } from './aliyun-asr.ts';
import { qwenRealtimeStt } from './qwen-realtime-asr.ts';
import { cosyVoiceTts } from './cosyvoice.ts';
import { mimoTts } from './mimo.ts';
import { EMOTIONS } from './emotion.ts';
import { BASE_STYLE, DEFAULT_TTS_VOICE } from './mimo.ts';
import {
  cannedStt,
  echoAgent,
  noopStt,
  silentTts,
  type AgentProvider,
  type SttProvider,
  type TtsProvider,
} from './providers.ts';
import { DshSession } from './session.ts';
import { KEEPALIVE_PROMPT, newActivityState, startKeepalive, systemClock, trackActivity } from './keepalive.ts';
import { FrontedAgent } from './fronted-agent.ts';
import { MemoryFile } from './memory-file.ts';
import { expiryWarning } from './tls-cert.ts';
import { runVoiceServer, UPSTREAM_SAMPLE_RATE } from './voice-session.ts';
import { TurnJudge } from './turn-judge.ts';
import { DEVICE_MODELS, describeCapabilities, resolveV1Device } from './devices/index.ts';
import { DEFAULT_PET_TIMING } from './pet/pet-timing.ts';
import { DEFAULT_PROACTIVE } from './pet/proactive.ts';
import { Pipeline, type ReplyMode } from './legacy-pipeline.ts';
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
    // 端点由我们控（`turn_detection: null`），静音窗见 `VOICE_COMMIT_MS`。
    return qwenRealtimeStt(
      {
        apiKey,
        ...(process.env['QWEN_ASR_URL'] ? { url: process.env['QWEN_ASR_URL'] } : {}),
        ...(process.env['QWEN_ASR_MODEL'] ? { model: process.env['QWEN_ASR_MODEL'] } : {}),
      },
      (line) => { console.log(`  [asr] ${line}`); },
    );
  }
  return loadProvider<SttProvider>(spec, 'stt');
}

/** `--tts cosyvoice|mimo|silent|<path>` */
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
    return cosyVoiceTts({
      apiKey: process.env['DASHSCOPE_API_KEY'],
      url: process.env['COSYVOICE_URL'],
      model: process.env['COSYVOICE_MODEL'],
      voice: process.env['COSYVOICE_VOICE'],
      useInstruction: process.env['COSYVOICE_EMOTION_MODE'] === 'instruction',
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
 * （`UtteranceAssembler` 把连续几句拼成一轮），`unfinishedWaitMs` 再专门兜
 * 「结尾是数字/井号/连词」那一类。
 *
 * 另有一条硬约束：上行能量门的 `holdMs`（默认 2000）必须远大于这个值，否则
 * 客户端停推之后服务端再也攒不到静音，句尾永远不来 —— 见
 * `docs/ALIYUN-ASR-PROBED.md` §5.1。
 */
const DEFAULT_SENTENCE_SILENCE_MS = 200;

/**
 * TurnJudge 判为「没说完」时再多等多久。
 *
 * 700 → 400：日志里「没说完，再等 700 ms」出现得极密，一轮叠 2–3 次就是
 * 1.4–2.1 秒的纯等待。400 仍够覆盖正常换气，且 `maxExtensions` 会给上限。
 */
const TURN_JUDGE_EXTEND_MS = Number(envString('TURN_JUDGE_EXTEND_MS') ?? 400);

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

async function main(): Promise<void> {
  installLogClock();
  loadDotEnv();
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

  if (!replay && !listen && !askImage) {
    console.error('用法: node src/main.ts --replay <file.sbc> | --listen <port> | --ask-image <file>');
    console.error('  --host <addr>   监听地址（默认 127.0.0.1）。非本机地址必须同时配');
    console.error('                  MIAI_TOKENS 与 MIAI_TLS_KEY/MIAI_TLS_CERT，否则拒绝启动');
    console.error('  可替换件: --stt aliyun|noop|canned|<path>  --tts cosyvoice|mimo|silent|<path>');
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
    // 快车道：短句纯闲聊直接答，其余零开销交给 dsh。放在 `trackActivity` **里面**，
    // 这样快车道答的那几轮也算「有活动」，不会在用户一直闲聊时被判空闲。
    const fastKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim();
    const fastOff = process.env['FAST_LANE'] === '0';
    const memoryPath = process.env['MEMORY_FILE'] ?? join(workDir, 'MEMORY.md');
    const memoryFile = new MemoryFile(memoryPath);

    // **投机的前置条件**：宿主得能取消在途那一轮。
    // 没有 `session/cancel` 时，快车道命中会在 dsh 那边留下一轮「用户没听过的回答」
    // （白花钱 + 幽灵历史），所以探测失败就退回串行 —— 串行压根不提前发 dsh。
    const wantSpeculate = process.env['FAST_LANE_SPECULATE'] !== '0';
    let canCancel = false;
    if (wantSpeculate) {
      canCancel = await dshSession.probeCancelSupport(20_000);
      console.log(canCancel
        ? '快车道    投机=开（宿主支持 session/cancel，命中时可作废在途那一轮）'
        : '快车道    投机=关 → 退回串行（宿主没有 session/cancel，作废不了在途那一轮）');
    }
    const speculate = wantSpeculate && canCancel;

    if (fastOff || fastKey === '') {
      console.log(`快车道    ${fastOff ? '关（FAST_LANE=0）' : '关（没有 FAST_LANE_API_KEY / DEEPSEEK_API_KEY）'}`);
    } else {
      agent = new FrontedAgent({
        inner: agent,
        apiKey: fastKey,
        model: process.env['FAST_LANE_MODEL'] ?? 'deepseek-chat',
        ...(process.env['FAST_LANE_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['FAST_LANE_BASE_URL'] }),
        timeoutMs: envNumber('FAST_LANE_TIMEOUT_MS', 1_200),
        // 投机双轨：dsh 与快模型同时发。关掉就退回串行（委派轮要白等一次判定）。
        // 前置条件：宿主必须能取消在途那一轮（启动时探测，见上面的 `canCancel`）。
        speculate,
        // 胜出后怎么处置在途的慢车道那一轮：rpc（默认，当前 SDK 运行时未放行）/
        // interrupt（SIGINT，会重启，多花 ~2 s）/ off
        cancelMode: ((): 'rpc' | 'interrupt' | 'off' => {
          const mode = process.env['FAST_LANE_CANCEL'];
          return mode === 'sigint' ? 'interrupt' : mode === 'off' ? 'off' : 'rpc';
        })(),
        maxChars: envNumber('FAST_LANE_MAX_CHARS', 14),
        // 判停前起跑：A/B 用，`FAST_LANE_PREFETCH=0` 关掉就退回「开轮才发请求」
        prefetch: process.env['FAST_LANE_PREFETCH'] !== '0',
        // 中间结果投机：比定稿再往前提 p50 731 ms，但文本是猜的（定稿确认是前缀才认领）
        partialSpeculate: process.env['FAST_LANE_PARTIAL_SPECULATE'] !== '0',
        // 对冲份数：同一句并发发 N 份取最先回来的（首字方差全在服务端排队，
        // 见 `FAST_LANE_TRACE` 的分解）。落败的在拿到响应头前就被掐掉。
        hedge: envNumber('FAST_LANE_HEDGE', 2),
        // 后台任务事实来自 dsh 自己的事件，不发请求 —— 「好了吗」能照实答，不用等一轮 dsh
        taskStatus: () => dshSession.taskStatus(),
        // 长期记忆：只读同一个 MEMORY.md（写权限在 dsh 的 remember 工具手里），
        // 按这句话挑几条进提示词，不全塞（4 KB ≈ 1.5k token）
        memory: (text: string) => memoryFile.relevant(text),
        log: (line) => { console.log(line); },
      });
      console.log(
        `快车道    开（短句闲聊直答，其余交给 dsh；FAST_LANE=0 关闭）  `
        + `model=${process.env['FAST_LANE_MODEL'] ?? 'deepseek-chat'}`,
      );
      // 记忆条数打出来：mock 记忆混进生产最常见的原因就是探针脚本写进了真文件
      // （探针一律用 `MEMORY_FILE=/tmp/...`，见 docs/OPS-RECORD.md §9.3）
      console.log(`记忆      ${memoryPath}（${memoryFile.entries().length} 条，快车道只读）`);
    }
    const keepaliveMinutes = envNumber('KEEPALIVE_MINUTES', 180);
    const activity = newActivityState(Date.now());
    const trackedAgent = trackActivity(agent, activity);
    agent = trackedAgent;
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
        await trackedAgent.reply(KEEPALIVE_PROMPT);
        console.log(`  [keepalive] 完成 ${Date.now() - started} ms`);
      },
      log: (line) => { console.log(line); },
    });
    process.on('exit', () => { stopKeepalive(); });
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
  const asrBackend = opt('--asr', 'mimo');
  const resolvedStt = sttSpec === '' ? (asrBackend === 'aliyun' ? 'aliyun' : '') : sttSpec;
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
          + `  端点由我们控（commit=${envNumber('VOICE_COMMIT_MS', 40)} ms）`
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

    const turnJudgePython = envString('TURN_JUDGE_PYTHON') ?? '';
    const turnJudgeScript = envString('TURN_JUDGE_SCRIPT') ?? '';
    const turnJudgeEnabled = envString('TURN_JUDGE') !== '0'
      && turnJudgePython !== '' && turnJudgeScript !== '';

    /**
     * 判停器侧车：**进程级一份，跨连接常驻**。
     *
     * 以前每条连接建一个、断开就 `stop()`。侧车是 python + 8.7 MB ONNX，冷启动
     * 实测 ~300 ms —— 真机每次重连（网络抖动 / 服务重启 / 重开 App）第一句都要
     * 付这一刀，而它刚好落在「用户说完 → 开一轮」里。常驻之后只有进程启动付一次。
     *
     * 预热：先用 1 s 静音跑一次推理把模型加载进来，别让第一次真说话的那轮承担。
     */
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
    const micGain = envNumber('MIAI_MIC_GAIN', envNumber('MIC_GAIN', 1));
    /**
     * 能量门限（按**放大后**算）。
     *
     * 实测（M2004J7AC、增益 4×、家里安静房间，84 个 2 s 窗口）：
     * 底噪峰值集中在 −60…−51 dBFS（p10 −58.3、p50 −53.7），
     * 说话时在 −20…0 dBFS，中间几乎空着。
     *
     * 原来取 −58：**低于底噪**，门一直开着 → 噪声当语音推给 ASR →
     * 服务端判「无有效语音」踢连接 → 6 分钟里建连 45 次、同时存活 4 条。
     * 取 −40：比最响的底噪高 10 dB，比最轻的说话低 10 dB。
     */
    const peakDbfs = envNumber('VOICE_PEAK_DBFS', -40);
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
          + `${envNumber('PET_TICK_MS', 30_000)} ms，离场 ${envNumber('PET_GREET_AWAY_MS', DEFAULT_PET_TIMING.greetAfterAwayMs)} ms 后重戴会打招呼\n`
        : '宠物环   关（PET_PROACTIVE≠1）：只跑对话环，不会主动开口\n',
    );

    const code = await runVoiceServer({
      port: listen,
      host: opt('--host', '127.0.0.1'),
      device: deviceSpec,
      ffmpegPath: ffmpeg,
      agent,
      stt,
      tts,
      turnJudge: turnJudgeEnabled
        ? {
          pythonPath: turnJudgePython,
          scriptPath: turnJudgeScript,
          // 句子定稿后先静候这么久再问 TurnJudge。350 → 150 → 80 → 40 → 0：
          // 有了「静音一到就预跑判停」（`VOICE_PAUSE_DETECT_MS`），`SentenceEnd` 到达时
          // 概率早就算好了，这段静候只是白等 —— 回放实测 ② 从 113 → 41 ms，
          // 把这里归零后只剩取缓存的那一下。
          quietMs: envNumber('TURN_JUDGE_QUIET_MS', 0),
          extendMs: TURN_JUDGE_EXTEND_MS,
          // 延长次数上限。3 → 7：业界（LiveKit `max_delay` 2.5–3 s、Pipecat
          // TurnJudge `stop_secs` 3 s、Deepgram `eot_timeout_ms` 5 s）都留 2.5 秒以上
          // 的兜底，而我们原来只有 3×400=1.2 s —— 触发点比人家快、兜底却只有一半，
          // 用户说半句停下来想一下就会被强制收下。7×400 ≈ 2.8 s，对齐业界。
          maxExtensions: envNumber('TURN_JUDGE_MAX_EXT', 7),
          // 「判停说没说完」单独一个上限：那条分支不看任何文本信号，只按 p 再等
          // 一拍，而 p 是噪声（同一段音频两次回放，同一句 0.549 vs 0.189）。
          // 真机实测要 4 拍（1600 ms）才收下；这里收到 2 拍（800 ms），
          // 仍能覆盖正常换气 200–400 ms。另三类文本判据不受影响，照旧吃 7 的额度。
          maxUnsureExtensions: envNumber('TURN_JUDGE_MAX_UNSURE', 2),
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
          // 结尾像「还有下文」（数字串/井号/连词）时再多等一拍。见
          // `looksUnfinished`：`max_sentence_silence` 压到 200 之后，
          // 数字组之间的换气会被当句尾，订单号被切成两句。
          unfinishedWaitMs: envNumber('TURN_JUDGE_UNFINISHED_MS', 250),
          // 判停器说「说完了」之后，若这么久内还收到过中间结果，就再等一拍
          // （防「音频停了、ASR 还在出字」的抢话）。真机上这段**几乎每轮都触发**，
          // 一次 400 ms 直接进了首字延迟 —— 150 仍能挡住正常 partial 间隔，
          // 回放实测（同为 6 轮）2 段从 622–625 ms 降到 150–152 ms。
          partialGraceMs: envNumber('TURN_JUDGE_PARTIAL_GRACE_MS', 150),
        }
        : undefined,
      ...(turnJudgeClient === null ? {} : { turnJudgeClient }),
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
        commitMs: envNumber('VOICE_COMMIT_MS', resolvedStt === 'qwen-realtime' ? 40 : 0),
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
      photoDir: process.env['PHOTO_DIR'] ?? '',
      // 默认避开 `--listen` 自己，否则两条监听撞端口（EADDRINUSE）
      controlPort: envNumber('PHOTO_CTL_PORT', listen + 2),
      // 高清链路要等手机建 P2P + 设备写相册，20 s 可能不够（`MIAI_PHOTO_TIMEOUT_MS` 可调）
      photoTimeoutMs: envNumber('MIAI_PHOTO_TIMEOUT_MS', 20_000),
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
          tickMs: envNumber('PET_TICK_MS', 30_000),
        }
        : null,
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
