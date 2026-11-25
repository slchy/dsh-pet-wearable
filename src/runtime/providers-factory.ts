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
import {
  cannedStt,
  echoAgent,
  noopStt,
  silentTts,
  type AgentProvider,
  type SttProvider,
  type TtsProvider,
} from '../providers.ts';
import { qwenRealtimeStt } from '../qwen-realtime-asr.ts';
import { DshSession } from '../session.ts';
import { sampleSocket } from '../socket-stats.ts';
import type { AuditSink } from './audit-slot.ts';

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
    // `QWEN_ASR_TURN_DETECTION=vad` 交给服务端（`speech_stopped → 定稿` 139–204 ms，
    // 比手动 commit 的 261 ms 快，但拿走了封段权，`VOICE_COMMIT_MS` 等旋钮全部失效）
    const turnDetection = process.env['QWEN_ASR_TURN_DETECTION'] === 'vad' ? 'vad' : 'manual';
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
  return loadProvider<SttProvider>(spec, 'stt');
}

/**
 * `--tts cosyvoice|omni|mimo|silent|<path>`
 *
 * `audit` 是 `tts.*` 事件的出口。不传就是空操作：这里不碰 CLI 的进程级槽。
 * `main()` 把自己的出口传进来；插件宿主传自己 `createAuditSlot()` 的那一份。
 * 同一个进程里可能有多份宿主，不能共用一个全局槽（谁先挂上谁就写走了别人的档案）。
 */
export async function buildTts(spec: string, audit?: AuditSink): Promise<TtsProvider> {
  const emit: AuditSink = audit ?? (() => {});
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
  return { agent: await loadProvider<AgentProvider>(spec, 'agent'), dsh: null };
}
