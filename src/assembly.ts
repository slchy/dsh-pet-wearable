/**
 * 三个可替换件（STT / TTS / agent）与两份启动凭据（TLS / 设备 token）的装配，
 * 外加 agent 起来之后必须接上的那几层（快车道 / 保活 / 记忆 / 活动跟踪）。
 *
 * 原先这些都长在 `main.ts` 里。抽出来的原因是**同一套装配有两个调用方**：
 * CLI（`main.ts`）和 dsh 插件（`packages/dsh-voice-web` 的 driver，真进程内起语音栈）。
 * 留在 `main.ts` 里就只能复制一份，然后两边慢慢漂 —— 实际已经漂过一次：
 * 插件第一版只接了 `buildAgent`，把整个快车道漏在了外面。
 *
 * 与 `main.ts` 的差异只有一处：启动期配置错误在这里**抛 {@link AssemblyError}**，
 * 不再直接 `process.exit`。插件跑在宿主进程里，把宿主一起带走是不行的。
 * CLI 接住之后仍然走原来的「打一行说明 + 退出码 2」。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VoiceAgent } from './agent.ts';
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './announce-store.ts';
import { aliyunStt } from './aliyun-asr.ts';
import { cosyVoiceTts } from './cosyvoice.ts';
import { EMOTIONS } from './emotion.ts';
import { FrontedAgent } from './fronted-agent.ts';
import { KEEPALIVE_PROMPT, newActivityState, startKeepalive, systemClock, trackActivity } from './keepalive.ts';
import { MemoryFile } from './memory-file.ts';
import { BASE_STYLE, DEFAULT_TTS_VOICE, mimoTts } from './mimo.ts';
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
import { expiryWarning } from './tls-cert.ts';
import { describeTokenProblem, readTokenFile, tokenFilePath, TokenGate } from './tokens.ts';

/** 环境变量取值，没给或不是数就用默认。两个调用方共用同一套解析。 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 读 `process.cwd()/.env`，**不覆盖已有的环境变量**。
 *
 * 从 `main.ts` 挪过来的：插件形态下进程是 dsh，没有 CLI 那一步，于是同一份 `.env`
 * 在插件里读不到 —— 表现为"明明配了密钥却说没配"。两边都调它才一致。
 *
 * 只认 `KEY=value` 与带引号的写法；`export KEY=...` 这种 shell 语法不认，
 * 因为这是给 Node 进程读的，不是给 shell 读的。
 */
export function loadDotEnv(): number {
  const path = join(process.cwd(), '.env');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;
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
  return count;
}

/** 启动期配置错误：调用方接住之后决定是退出进程还是拒绝加载插件。 */
export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssemblyError';
  }
}

/** STT 可用的内置实现名 */
export type SttSpec = 'aliyun' | 'noop' | 'canned' | (string & {});
/** TTS 可用的内置实现名 */
export type TtsSpec = 'cosyvoice' | 'mimo' | 'silent' | (string & {});
/** agent 可用的内置实现名 */
export type AgentSpec = 'dsh' | 'echo' | 'none' | '' | (string & {});

/**
 * 插件加载：`<path>` 指向一个模块，导出 `stt()` / `tts()` 工厂（或 default）。
 *
 * 这是 `cloud/` 唯一的扩展点 —— 换厂商不用改调用方，也不用 fork。
 */
async function loadProvider<T>(spec: string, exportName: string): Promise<T> {
  const isPath = /^[./]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec);
  const url = isPath ? pathToFileURL(resolve(spec)).href : spec;
  const mod = (await import(url)) as Record<string, unknown>;
  const factory = (mod.default ?? mod[exportName]) as (() => T) | undefined;
  if (typeof factory !== 'function') {
    throw new AssemblyError(`${spec} 必须导出 ${exportName}() 工厂（或 default 导出工厂）`);
  }
  return factory();
}

export interface SttCreds {
  readonly akId: string;
  readonly akSecret: string;
  readonly appkey: string;
  readonly region: string;
  readonly maxSentenceSilenceMs: number;
  readonly vocabularyId?: string;
}

/** `--stt aliyun|noop|canned|<path>` */
export async function buildStt(spec: SttSpec, creds: SttCreds): Promise<SttProvider> {
  if (spec === 'noop') return noopStt();
  if (spec === 'canned') return cannedStt();
  if (spec === 'aliyun') {
    return aliyunStt(creds, (line) => { console.log(`  [asr] ${line}`); });
  }
  return loadProvider<SttProvider>(spec, 'stt');
}

/** `--tts cosyvoice|mimo|silent|<path>` */
export async function buildTts(spec: TtsSpec): Promise<TtsProvider> {
  if (spec === 'silent') return silentTts(24_000);
  if (spec === 'cosyvoice') {
    if (!process.env['DASHSCOPE_API_KEY']) {
      throw new AssemblyError('DASHSCOPE_API_KEY 未设置（CosyVoice 用的是 DashScope API key，不是阿里云 AK/SK）');
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
      throw new AssemblyError('MIMO_API_KEY 未设置（用 --tts silent 可跳过 TTS）');
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

export interface AgentBundle {
  readonly agent: AgentProvider | null;
  /** dsh 专用：进程句柄要留着，退出时 stop() */
  readonly dsh: DshSession | null;
}

export interface AgentAssemblyOptions {
  readonly workDir: string;
  readonly useSdk: boolean;
  readonly provider: string;
  readonly model: string;
  readonly log: (line: string) => void;
}

/** `--agent dsh|echo|none|<path>` */
export async function buildAgent(
  spec: AgentSpec,
  dsh: AgentAssemblyOptions,
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

/**
 * 离线时的后台汇报队列。放 `~/.voice-agent/` 旁边（和会话 id 一个目录），
 * 路径可用 `MIAI_ANNOUNCE_FILE` 覆盖；空串 = 不持久化。
 */
export function openAnnounceStore(log: (line: string) => void): AnnounceStore | null {
  return AnnounceStore.open({
    file: process.env['MIAI_ANNOUNCE_FILE'] ?? join(homedir(), '.voice-agent', 'announce.jsonl'),
    maxItems: envNumber('MIAI_ANNOUNCE_MAX', DEFAULT_ANNOUNCE_MAX),
    log,
  });
}

/** 接好之后拿到的 agent，外加收摊函数（保活定时器）。 */
export interface WiredAgent {
  readonly agent: AgentProvider;
  stop(): void;
}

/**
 * agent 起来之后必须接上的那几层，顺序有讲究：
 *
 * 1. `FrontedAgent`（快车道）包在**里面**，`trackActivity` 包在外面 ——
 *    这样快车道答的那几轮也算「有活动」，用户一直闲聊时不会被判空闲。
 * 2. 保活用包好的 agent 发请求，否则它绕过快车道、也绕过活动跟踪。
 *
 * 少了这一整段，语音栈照样能跑，但端到端会退化到「每句都等完整 dsh」：
 * 中间结果投机、静音 100 ms 起跑、TTS 提前合成的窗口、对冲、短句直答全都没了。
 */
export async function wireAgent(options: {
  readonly agent: AgentProvider;
  readonly dsh: DshSession | null;
  readonly workDir: string;
  readonly announceStore: AnnounceStore | null;
  readonly log: (line: string) => void;
}): Promise<WiredAgent> {
  let agent = options.agent;
  let stopKeepalive: () => void = () => {};
  const { dsh, log } = options;

  if (dsh !== null) {
    // 快车道：短句纯闲聊直接答，其余零开销交给 dsh。
    const fastKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim();
    const fastOff = process.env['FAST_LANE'] === '0';
    const memoryPath = process.env['MEMORY_FILE'] ?? join(options.workDir, 'MEMORY.md');
    const memoryFile = new MemoryFile(memoryPath);

    // **投机的前置条件**：宿主得能取消在途那一轮。
    // 没有 `session/cancel` 时，快车道命中会在 dsh 那边留下一轮「用户没听过的回答」
    // （白花钱 + 幽灵历史），所以探测失败就退回串行 —— 串行压根不提前发 dsh。
    const wantSpeculate = process.env['FAST_LANE_SPECULATE'] !== '0';
    let canCancel = false;
    if (wantSpeculate) {
      canCancel = await dsh.probeCancelSupport(20_000);
      log(canCancel
        ? '快车道    投机=开（宿主支持 session/cancel，命中时可作废在途那一轮）'
        : '快车道    投机=关 → 退回串行（宿主没有 session/cancel，作废不了在途那一轮）');
    }
    const speculate = wantSpeculate && canCancel;

    if (fastOff || fastKey === '') {
      log(`快车道    ${fastOff ? '关（FAST_LANE=0）' : '关（没有 FAST_LANE_API_KEY / DEEPSEEK_API_KEY）'}`);
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
        taskStatus: () => dsh.taskStatus(),
        // 长期记忆：只读同一个 MEMORY.md（写权限在 dsh 的 remember 工具手里），
        // 按这句话挑几条进提示词，不全塞（4 KB ≈ 1.5k token）
        memory: (text: string) => memoryFile.relevant(text),
        log,
      });
      log(
        `快车道    开（短句闲聊直答，其余交给 dsh；FAST_LANE=0 关闭）  `
        + `model=${process.env['FAST_LANE_MODEL'] ?? 'deepseek-chat'}`,
      );
      // 记忆条数打出来：mock 记忆混进生产最常见的原因就是探针脚本写进了真文件
      // （探针一律用 `MEMORY_FILE=/tmp/...`，见 docs/OPS-RECORD.md §9.3）
      log(`记忆      ${memoryPath}（${memoryFile.entries().length} 条，快车道只读）`);
    }

    const keepaliveMinutes = envNumber('KEEPALIVE_MINUTES', 180);
    const activity = newActivityState(Date.now());
    const trackedAgent = trackActivity(agent, activity);
    agent = trackedAgent;
    log(keepaliveMinutes > 0
      ? `保活      空闲 ${keepaliveMinutes} 分钟发一次前缀保活（KEEPALIVE_MINUTES=0 关闭）`
      : '保活      关（KEEPALIVE_MINUTES=0）');
    stopKeepalive = startKeepalive({
      clock: systemClock,
      intervalMs: keepaliveMinutes * 60_000,
      idleFor: () => Date.now() - activity.last,
      isBusy: () => activity.inflight > 0,
      ping: async () => {
        const started = Date.now();
        await trackedAgent.reply(KEEPALIVE_PROMPT);
        log(`  [keepalive] 完成 ${Date.now() - started} ms`);
      },
      log,
    });
  }

  return { agent, stop: () => { stopKeepalive(); } };
}

/** 证书从文件读，路径只走环境变量 —— 部署细节不进源码。 */
export function loadTls(
  log: (line: string) => void = (line) => { console.warn(`  ${line}`); },
): { key: Buffer; cert: Buffer } | undefined {
  const keyPath = process.env['MIAI_TLS_KEY'] ?? '';
  const certPath = process.env['MIAI_TLS_CERT'] ?? '';
  if (!keyPath || !certPath) {
    // 只给一半是配错了，不是「没配」—— 静默降级成明文会让人以为已经加密了
    if (keyPath || certPath) {
      const given = keyPath ? 'MIAI_TLS_KEY' : 'MIAI_TLS_CERT';
      const absent = keyPath ? 'MIAI_TLS_CERT' : 'MIAI_TLS_KEY';
      throw new AssemblyError(`只给了 ${given}，缺 ${absent}：TLS 要么两个都给，要么都不给`);
    }
    return undefined;
  }
  try {
    const cert = readFileSync(certPath);
    // 到期检查：过期的证书服务端照常启动、照常监听，只是每一次握手都失败 ——
    // 客户端只看到「连不上」，日志里一个字都没有。所以在这里喊出来。
    for (const line of expiryWarning(cert) ?? []) {
      log(line);
    }
    return { key: readFileSync(keyPath), cert };
  } catch (error) {
    throw new AssemblyError(`TLS 证书读不到：${(error as Error).message}`);
  }
}

/**
 * 设备鉴权：`MIAI_TOKENS` 指向一个文件，每行 `token` 或 `token:deviceId`。
 *
 * - 不配就**不鉴权**（只可能用于本机地址 —— 由 `bind-policy.ts` 把关）
 * - 配了就必须首帧 `Hello`，且 token 要过强度校验（见 `tokens.ts`）
 * - 文件变了自动重读，**吊销不必重启进程**
 * - 写了 `token:deviceId` 就是真绑定：`Hello.deviceId` 对不上同样拒绝
 */
export function loadAuthenticator(
  log: (line: string) => void,
): ((hello: { deviceId?: string; token?: string }) => boolean) | undefined {
  const path = process.env['MIAI_TOKENS'] ?? '';
  if (!path.trim()) return undefined;

  const resolved = tokenFilePath(path);
  // 启动时就报出弱/错 token，别等到设备连上来才发现「配了等于没配」
  const { entries, bad } = readTokenFile(resolved);
  for (const item of bad) {
    throw new AssemblyError(
      `${resolved} 第 ${item.line} 行不合格：${describeTokenProblem(item.raw, item.problem)}\n`
      + '（要重新发一个：node src/pair.ts new --device <id>）',
    );
  }
  if (entries.length === 0) {
    throw new AssemblyError(`${resolved} 里没有任何可用的 token`);
  }

  const gate = new TokenGate(resolved, log);
  log(`鉴权      ${entries.length} 个设备 token（来自 ${resolved}，改动会自动重读）`);
  return (hello) => typeof hello.token === 'string' && gate.match(hello.token, hello.deviceId) !== null;
}
