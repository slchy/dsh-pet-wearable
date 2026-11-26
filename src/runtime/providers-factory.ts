/**
 * STT / TTS / agent 工厂。按名字选内置实现，或加载一个模块路径。
 *
 * 不持有 CLI 的审计槽：`buildTts` 的 `audit` 缺省是空操作，调用方把自己的出口传进来。
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VoiceAgent } from '../agent.ts';
import { aliyunStt } from '../aliyun-asr.ts';
import type { AnnounceStore } from '../announce-store.ts';
import { cosyVoiceTts, DEFAULT_COSYVOICE_EMOTION_MODE } from '../cosyvoice.ts';
import { EMOTIONS } from '../emotion.ts';
import { EVENTS } from '../events.ts';
import { BASE_STYLE, DEFAULT_TTS_VOICE, mimoTts } from '../mimo.ts';
import { omniTts } from '../omni-tts.ts';
import { openAiTts } from '../openai-tts.ts';
import {
  cannedStt,
  echoAgent,
  noopStt,
  silentTts,
  type AgentProvider,
  type SttProvider,
  type TtsProvider,
} from '../providers.ts';
import { openaiRealtimeStt, qwenRealtimeStt } from '../qwen-realtime-asr.ts';
import { resolveRealtimeDialect } from '../realtime-dialect.ts';
import { DshSession } from '../session.ts';
import { sampleSocket } from '../socket-stats.ts';
import { resolveLiveApiKey } from '../voice-config.ts';
import type { AuditSink } from './audit-slot.ts';

/**
 * 插件加载：`<path>` 指向一个模块，导出 `stt()` / `tts()` / `agent()` 工厂（或 default）。
 *
 * 这是 `cloud/` 唯一的扩展点 —— 换厂商不用改本文件，也不用 fork。将来开源时
 * 别人照这个签名写自己的模块即可（见 `docs/BACKLOG.md` B-004）。
 *
 * **工厂返回后必须过形状校验**：裸 cast 会把「少了 open / name」这种错误留到
 * 第一通电话里才炸，现场表现是「连上了但永远不出字」，从日志上看不出是插件写错。
 * 校验只发生在启动期 / 换 provider 时，不在热路径上。
 */
async function loadProvider<T>(
  spec: string,
  exportName: string,
  validate: (value: unknown, spec: string) => T,
): Promise<T> {
  const isPath = /^[./]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec);
  const url = isPath ? pathToFileURL(resolve(spec)).href : spec;
  const mod = (await import(url)) as Record<string, unknown>;
  const factory = (mod.default ?? mod[exportName]) as (() => unknown) | undefined;
  if (typeof factory !== 'function') {
    throw new Error(`${spec} 必须导出 ${exportName}() 工厂（或 default 导出工厂）`);
  }
  return validate(factory(), spec);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeError(spec: string, kind: string, detail: string): Error {
  return new Error(`${spec} 的 ${kind} provider 形状不合法：${detail}`);
}

function requireName(value: Record<string, unknown>, spec: string, kind: string): string {
  const name = value['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw shapeError(spec, kind, '缺少非空字符串 name');
  }
  return name;
}

/** STT 插件的最小形状：`name` + `open(handlers)`；可选 `supportsManualEndpoint` 须为布尔值。 */
export function validateSttProvider(value: unknown, spec: string): SttProvider {
  if (!isRecord(value)) {
    throw shapeError(spec, 'STT', `工厂必须返回对象（得到 ${value === null ? 'null' : typeof value}）`);
  }
  requireName(value, spec, 'STT');
  if (typeof value['open'] !== 'function') {
    throw shapeError(spec, 'STT', '缺少 open() 函数');
  }
  const manual = value['supportsManualEndpoint'];
  if (manual !== undefined && typeof manual !== 'boolean') {
    throw shapeError(spec, 'STT', `supportsManualEndpoint 必须是布尔值（得到 ${typeof manual}）`);
  }
  return value as unknown as SttProvider;
}

const OPTIONAL_TTS_MEMBERS = ['synthesizeStream', 'warm', 'prewarm', 'close'] as const;

/** TTS 插件的最小形状：`name` + 正有限 `sampleRate` + `synthesize`；可选方法若存在必须是函数。 */
export function validateTtsProvider(value: unknown, spec: string): TtsProvider {
  if (!isRecord(value)) {
    throw shapeError(spec, 'TTS', `工厂必须返回对象（得到 ${value === null ? 'null' : typeof value}）`);
  }
  requireName(value, spec, 'TTS');
  const sampleRate = value['sampleRate'];
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw shapeError(
      spec,
      'TTS',
      `sampleRate 必须是正有限数（得到 ${String(sampleRate)}）`,
    );
  }
  if (typeof value['synthesize'] !== 'function') {
    throw shapeError(spec, 'TTS', '缺少 synthesize() 函数');
  }
  for (const key of OPTIONAL_TTS_MEMBERS) {
    const member = value[key];
    if (member !== undefined && typeof member !== 'function') {
      throw shapeError(spec, 'TTS', `${key} 必须是函数（得到 ${typeof member}）`);
    }
  }
  return value as unknown as TtsProvider;
}

/** Agent 插件的最小形状：`name` + `reply()`。 */
export function validateAgentProvider(value: unknown, spec: string): AgentProvider {
  if (!isRecord(value)) {
    throw shapeError(spec, 'Agent', `工厂必须返回对象（得到 ${value === null ? 'null' : typeof value}）`);
  }
  requireName(value, spec, 'Agent');
  if (typeof value['reply'] !== 'function') {
    throw shapeError(spec, 'Agent', '缺少 reply() 函数');
  }
  return value as unknown as AgentProvider;
}

/** `--stt aliyun|qwen-realtime|openai-realtime|noop|canned|<path>` */
export async function buildStt(
  spec: string,
  creds: {
    akId: string; akSecret: string; appkey: string; region: string;
    maxSentenceSilenceMs: number; vocabularyId?: string; corpusText?: string; language?: string;
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
    // `ASR_TURN_DETECTION=vad` 或 `QWEN_ASR_TURN_DETECTION=vad` 交给服务端
    const turnRaw = (process.env['ASR_TURN_DETECTION'] ?? process.env['QWEN_ASR_TURN_DETECTION'] ?? '').trim().toLowerCase();
    const turnDetection = turnRaw === 'vad' ? 'vad' : 'manual';
    const { corpusText, language } = creds;
    return qwenRealtimeStt(
      {
        apiKey,
        ...(process.env['QWEN_ASR_URL'] ? { url: process.env['QWEN_ASR_URL'] } : {}),
        ...(process.env['QWEN_ASR_MODEL'] ? { model: process.env['QWEN_ASR_MODEL'] } : {}),
        turnDetection,
        ...(corpusText ? { corpusText } : {}),
        ...(language ? { language } : {}),
      },
      (line) => { console.log(`  [asr] ${line}`); },
    );
  }
  if (spec === 'openai-realtime') {
    const apiKey = (process.env['OPENAI_ASR_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '').trim();
    if (!apiKey) {
      throw new Error('STT=openai-realtime 需要 OPENAI_ASR_API_KEY 或 OPENAI_API_KEY');
    }
    const url = process.env['OPENAI_ASR_URL']?.trim();
    const dialect = resolveRealtimeDialect(process.env['OPENAI_ASR_DIALECT'] ?? 'openai-ga', url);
    const turnRaw = (process.env['ASR_TURN_DETECTION'] ?? process.env['OPENAI_ASR_TURN_DETECTION'] ?? '').trim().toLowerCase();
    const turnDetection = turnRaw === 'vad' ? 'vad' : 'manual';
    const { corpusText, language } = creds;
    return openaiRealtimeStt(
      {
        apiKey,
        dialect,
        ...(url ? { url } : {}),
        ...(process.env['OPENAI_ASR_MODEL'] ? { model: process.env['OPENAI_ASR_MODEL'] } : {}),
        turnDetection,
        ...(corpusText ? { corpusText } : {}),
        ...(language ? { language } : {}),
      },
      (line) => { console.log(`  [asr] ${line}`); },
    );
  }
  return loadProvider<SttProvider>(spec, 'stt', validateSttProvider);
}

function optionalPositiveEnvNumber(raw: string | undefined, name: string): number | undefined {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}=${trimmed} 必须是正有限数`);
  }
  return parsed;
}

/**
 * `--tts cosyvoice|openai|omni|mimo|silent|<path>`
 *
 * `audit` 是 `tts.*` 事件的出口。不传就是空操作：这里不碰 CLI 的进程级槽。
 * `main()` 把自己的出口传进来；插件宿主传自己 `createAuditSlot()` 的那一份。
 * 同一个进程里可能有多份宿主，不能共用一个全局槽（谁先挂上谁就写走了别人的档案）。
 */
export async function buildTts(spec: string, audit?: AuditSink): Promise<TtsProvider> {
  const emit: AuditSink = audit ?? (() => {});
  if (spec === 'silent') return silentTts(24_000);
  if (spec === 'openai' || spec === 'openai-tts') {
    const apiKey = (process.env['OPENAI_TTS_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '').trim();
    if (!apiKey) {
      throw new Error('TTS=openai 需要 OPENAI_TTS_API_KEY 或 OPENAI_API_KEY');
    }
    const sampleRate = optionalPositiveEnvNumber(process.env['OPENAI_TTS_SAMPLE_RATE'], 'OPENAI_TTS_SAMPLE_RATE');
    const speed = optionalPositiveEnvNumber(process.env['OPENAI_TTS_SPEED'], 'OPENAI_TTS_SPEED');
    return openAiTts({
      apiKey,
      baseUrl: process.env['OPENAI_TTS_BASE_URL'] ?? process.env['OPENAI_BASE_URL'],
      model: process.env['OPENAI_TTS_MODEL'],
      voice: process.env['OPENAI_TTS_VOICE'],
      instructions: process.env['OPENAI_TTS_INSTRUCTIONS'],
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(speed === undefined ? {} : { speed }),
    });
  }
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
      onTask: (info) => { emit(EVENTS.ttsTask, { ...info }); },
      // 流式 task 的分批送达明细，收尾时落一次（见 `tts.done`）
      onDone: (info) => { emit(EVENTS.ttsDone, { ...info }); },
      // 首块 600 ms 还没回来：**当场**采这一条 socket（`unacked`/`rto` 只在那一瞬有意义）
      onStall: (info) => {
        void sampleSocket(info.local_port).then((socket) => {
          emit(EVENTS.ttsStall, { ...info, socket });
        });
      },
    });
  }
  if (spec === 'omni') {
    const apiKey = resolveLiveApiKey(process.env);
    if (!apiKey) {
      throw new Error('TTS=omni 需要 LIVE_API_KEY / OMNI_API_KEY / DASHSCOPE_API_KEY（OpenAI 方言下可用 OPENAI_API_KEY）');
    }
    const url = process.env['LIVE_URL'] ?? process.env['OMNI_URL'];
    const dialect = resolveRealtimeDialect(process.env['LIVE_DIALECT'] ?? process.env['OMNI_DIALECT'], url);
    // 用 omni / OpenAI Realtime 念 dsh 的答案 —— 全链路单一音色（S5）。
    return omniTts({
      apiKey,
      dialect,
      ...(url ? { url } : {}),
      model: process.env['LIVE_MODEL'] ?? process.env['OMNI_SHADOW_MODEL'],
      voice: process.env['LIVE_VOICE'] ?? process.env['OMNI_VOICE'],
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
  return loadProvider<TtsProvider>(spec, 'tts', validateTtsProvider);
}

interface AgentBundle {
  readonly agent: AgentProvider | null;
  /** dsh 专用：进程句柄要留着，退出时 stop() */
  readonly dsh: DshSession | null;
}

/** `--agent dsh|echo|none|<path>` */
export async function buildAgent(
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
  return { agent: await loadProvider<AgentProvider>(spec, 'agent', validateAgentProvider), dsh: null };
}
