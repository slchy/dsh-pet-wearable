/**
 * 三个可替换件（STT / TTS / agent）与两份启动凭据（TLS / 设备 token）的装配。
 *
 * 原先这些都长在 `main.ts` 里。抽出来的原因是**同一套装配有两个调用方**：
 * CLI（`main.ts`）和 dsh 插件（`packages/dsh-voice-web` 的 driver，真进程内起语音栈）。
 * 留在 `main.ts` 里就只能复制一份，然后两边慢慢漂。
 *
 * 与 `main.ts` 的差异只有一处：启动期配置错误在这里**抛 {@link AssemblyError}**，
 * 不再直接 `process.exit`。插件跑在宿主进程里，把宿主一起带走是不行的。
 * CLI 接住之后仍然走原来的「打一行说明 + 退出码 2」。
 *
 * 剩下的旋钮（前缀保活、快车道、宠物环）不在这里 —— 它们要把 agent、MemoryFile、
 * AnnounceStore 串起来，属于编排，仍旧留在各自的调用方。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VoiceAgent } from './agent.ts';
import type { AnnounceStore } from './announce-store.ts';
import { aliyunStt } from './aliyun-asr.ts';
import { cosyVoiceTts } from './cosyvoice.ts';
import { EMOTIONS } from './emotion.ts';
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
