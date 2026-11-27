/**
 * 云端 harness：设备音频流 → 解码 → 判停 → 一轮 → TTS → 下发。
 *
 * STT / TTS / agent 都是**注入的**（见 `providers.ts`），这里只做装配：
 * 按 `--stt` / `--tts` / `--agent` 选实现，其余全是编排。
 * 可复用的那一层在 `src/runtime/`；本文件是 CLI（参数、横幅、进程级审计槽）。
 *
 *   node src/main.ts --listen 8766                                  # 真供应商
 *   node src/main.ts --listen 8766 --stt canned --tts silent --agent echo   # 零密钥
 *
 * 旧路径（`--replay`、本地 silero-vad、MiMo ASR）见 `legacy-pipeline.ts`，仍按需加载。
 * 流式路径的神经 VAD 由 `runtime/vad-bootstrap.ts` 启动时加载；没模型或
 * `VOICE_VAD=energy` 时退回能量门。顶层不静态引入 `onnxruntime-node`。
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './announce-store.ts';
import { DEVICE_MODELS, describeCapabilities, resolveV1Device } from './devices/index.ts';
import { FrontedAgent } from './fronted-agent.ts';
import { DEFAULT_KEEPALIVE_MS, installHttpAgent } from './http-agent.ts';
import {
  KEEPALIVE_PROMPT,
  newActivityState,
  startKeepalive,
  systemClock,
  trackActivity,
  type ActivityState,
} from './keepalive.ts';
import type { Pipeline, ReplyMode } from './legacy-pipeline.ts';
import { MemoryFile } from './memory-file.ts';
import { DEFAULT_PET_PARAMS } from './pet/brain/registry.ts';
import { DEFAULT_PET_TIMING } from './pet/pet-timing.ts';
import type { PipelinePlan } from './pipeline-mode.ts';
import { silentTts, type AgentProvider, type TtsProvider } from './providers.ts';
import { realtimeLiveDefaults, resolveRealtimeDialect } from './realtime-dialect.ts';
import { loadStaticAsrCorpus, resolveAsrLanguage } from './runtime/asr-context.ts';
import { createAuditSlot } from './runtime/audit-slot.ts';
import { loadAuthenticator, loadDotEnv, loadTls } from './runtime/env-bootstrap.ts';
import { isMainModule } from './runtime/is-main.ts';
import {
  assemblePipelinePlan,
  assembleStreamingAgent,
  shouldCreateFrontedAgent,
  type AssembledStreamingPipeline,
} from './runtime/pipeline-assembly.ts';
import { buildAgent, buildStt, buildTts } from './runtime/providers-factory.ts';
import { loadSharedTurnJudge } from './runtime/turn-judge-bootstrap.ts';
import { loadSharedVad } from './runtime/vad-bootstrap.ts';
import { semanticEndpoint } from './semantic-endpoint.ts';
import type { DshSession } from './session.ts';
import { envNumber, envString, sleep } from './util.ts';
import {
  buildVoiceRuntimeConfig,
  DEFAULT_IMAGE_QUESTION,
  isManualEndpointStt,
  resolveLiveApiKey,
} from './voice-config.ts';
import { runVoiceServer } from './voice-session.ts';

export {
  assemblePipelinePlan,
  assembleStreamingAgent,
  buildAgent,
  buildStt,
  buildTts,
  createAuditSlot,
  isMainModule,
  loadAuthenticator,
  loadDotEnv,
  loadStaticAsrCorpus,
  loadTls,
  resolveAsrLanguage,
  shouldCreateFrontedAgent,
};
export type { AssembledStreamingPipeline };
export { formatCurrentDateContext } from './runtime/asr-context.ts';
export type { AuditSink, AuditSlot } from './runtime/audit-slot.ts';
export type {
  AssembleStreamingAgentDeps,
  FrontedPlan,
} from './runtime/pipeline-assembly.ts';

/** 启动期配置错误：说清楚是哪一项、该怎么改，然后退出。 */
function fail(message: string): never {
  console.error(`\n启动失败：${message}\n`);
  process.exit(2);
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

/** 宠物环心跳。不进 `.env`，源码是唯一默认值。 */
const DEFAULT_PET_TICK_MS = 3_000;
/** 开麦到首帧上行音频的截止。小米实测 0.62 s，给到 1.5 s。 */
const DEFAULT_PET_MIC_OPEN_TIMEOUT_MS = 1_500;

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

/**
 * 审计出口的**当前持有者**：哪条连接在写档案。
 *
 * 承载两类事件：`agent.*`（快车道问了什么/答了什么）和 `tts.task`（建立/首包两段）。
 * 同时只有一个设备在用时归属精确；多设备并发会写到最后连上的那条（见
 * {@link createAuditSlot} 的所有权守卫）。
 */
const auditSlot = createAuditSlot();

// 热路径字面量（envNum / env['FAST_LANE_*']）只留在 assembleStreamingAgent，
// time-knobs 记第一次出现的文件。旧装配走这几个函数，避免抢持有者。
function readLegacyNumber(name: string, fallback: number): number {
  return envNumber(name, fallback);
}

function readLegacyOn(name: string): boolean {
  return process.env[name] !== '0';
}

function readLegacyOptIn(name: string): boolean {
  return (process.env[name] ?? '0') !== '0';
}

async function main(): Promise<void> {
  installLogClock();
  loadDotEnv();
  // 必须在这里（`loadDotEnv` 之后、任何 fetch 之前）：`fetch` 默认 4 秒就关连接，
  // 而真机两轮间隔 4–16 秒 —— 等于每轮重做一次 TCP+TLS，实测多花 130–190 ms。
  // 见 `http-agent.ts` 的实测账。
  installHttpAgent(DEFAULT_KEEPALIVE_MS);
  console.log(`HTTP     连接保活 ${DEFAULT_KEEPALIVE_MS} ms（默认 4 秒会让每轮重新握手）\n`);
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
  const sttIsPluginPath = /^[./]/.test(resolvedStt) || /^[A-Za-z]:[\\/]/.test(resolvedStt);
  const omniWanted = envString('OMNI_SHADOW') === '1';
  const omniKey = resolveLiveApiKey(process.env);
  /** 非流式旧装配：omni 车道真的会挂上（三件事同时成立）才造 `FrontedAgent`。 */
  const omniWillEnable = omniWanted && omniKey !== '' && isManualEndpointStt(resolvedStt);

  let pipelinePlan: PipelinePlan | null = null;
  /**
   * 流式装配要等 TTS。这里只收依赖，对象在 {@link assembleStreamingAgent}。
   * 退出时 dispose 那一份编排器。
   */
  let pendingStreaming: {
    readonly plan: PipelinePlan;
    readonly dshAgent: AgentProvider;
    readonly activity: ActivityState;
    readonly memory: (text: string) => string;
    readonly refineHotwords: string;
    readonly taskStatus: () => string;
    readonly speculate: boolean; readonly memorySummary?: () => string; readonly asrCorpusText?: string; readonly asrLanguage?: string;
  } | null = null;
  let disposeStreaming: () => void = () => {}; let corpusText: string | undefined; let language: string | undefined;

  // `--listen 0` 仍然点名了这条装配。非法 `VOICE_PIPELINE` 必须在用法横幅之前失败，
  // 否则 `node src/main.ts --agent dsh --stt qwen-realtime --listen 0` 只会打印用法。
  // 自定义插件路径的 `supportsManualEndpoint` 需加载模块后才能确定，留到 `buildStt` 后复检。
  const enteringVoicePipeline = agentSpec === 'dsh'
    && resolvedStt !== ''
    && (listen > 0 || argv.includes('--listen') || argv.includes('--stt'));
  if (enteringVoicePipeline) {
    let resolvedPlan: PipelinePlan;
    try {
      resolvedPlan = assemblePipelinePlan(process.env, {
        ...(sttIsPluginPath ? {} : { sttName: resolvedStt }),
        strict: true,
      });
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
    console.error('  可替换件: --stt aliyun|qwen-realtime|openai-realtime|noop|canned|<path>  --tts cosyvoice|openai|omni|mimo|silent|<path>');
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
    const memoryFile = new MemoryFile(memoryPath); const memoryHints = memoryFile.hotwordHints(); corpusText = loadStaticAsrCorpus(memoryHints, process.env); language = resolveAsrLanguage(process.env);
    const activity = newActivityState(Date.now());
    const keepaliveMinutes = envNumber('KEEPALIVE_MINUTES', 180);
    /**
     * 委派默认**关**（跟随线上）。`FAST_LANE_DELEGATE=1` 才打开。
     *
     * 保留 `!== '0'` 那个写法会让「什么都没设」变成打开 —— 而线上一直是关的。
     */
    const delegateEnabled = readLegacyOptIn('FAST_LANE_DELEGATE');
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
        + ` partialSpeculate=${readLegacyOn('FAST_LANE_PARTIAL_SPECULATE') ? 'on' : 'off'}`
        + ` delegate=${delegateEnabled ? 'on' : 'OFF（纯聊天）'}`,
      );
      // 记忆条数打出来：mock 记忆混进生产最常见的原因就是探针脚本写进了真文件
      // （探针一律用 `MEMORY_FILE=/tmp/...`，见 docs/OPS-RECORD.md §9.3）
      console.log(`记忆      ${memoryPath}（${memoryFile.entries().length} 条，快车道只读）`);
    };

    // 赋值必须写在这个函数体里。写进闭包的话，控制流分析会一直把
    // `pendingStreaming` 看成初始的 `null`（后面 `?.plan` 会变成 `never`）。
    const streamingDeps = (plan: PipelinePlan, speculate: boolean): NonNullable<typeof pendingStreaming> => ({
      plan,
      dshAgent,
      activity,
      // 直播编排要一整段；级联在 assembleStreamingAgent 里再拆回逐条。
      memory: (text) => memoryFile.relevant(text).join('\n'),
      refineHotwords: memoryFile.hotwordHints(),
      taskStatus: () => session.taskStatus(),
      speculate, memorySummary: () => memoryFile.summary(), asrCorpusText: corpusText, asrLanguage: language,
    });
    if (pipelinePlan !== null && pipelinePlan.mode === 'live') {
      console.log('快车道    关（纯 live：不加载文本级联快车道）');
      pendingStreaming = streamingDeps(pipelinePlan, false);
    } else if (pipelinePlan !== null && pipelinePlan.mode === 'cascade') {
      let speculate = false;
      if (pipelinePlan.useCascadeFastLane) {
        speculate = await resolveSpeculate();
        logFastLaneOn();
      } else {
        console.log(`快车道    ${fastOff ? '关（FAST_LANE=0）' : '关（没有 FAST_LANE_API_KEY / DEEPSEEK_API_KEY）'}`);
      }
      pendingStreaming = streamingDeps(pipelinePlan, speculate);
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
          timeoutMs: readLegacyNumber('FAST_LANE_TIMEOUT_MS', 1_200),
          // 投机双轨：dsh 与快模型同时发。关掉就退回串行（委派轮要白等一次判定）。
          // 前置条件：宿主必须能取消在途那一轮（启动时探测，见 `resolveSpeculate`）。
          speculate,
          // 胜出后怎么处置在途的慢车道那一轮：rpc（默认）/ interrupt / off
          cancelMode,
          maxChars: envNumber('FAST_LANE_MAX_CHARS', 14),
          // 判停前起跑：A/B 用，`FAST_LANE_PREFETCH=0` 关掉就退回「开轮才发请求」
          prefetch: readLegacyOn('FAST_LANE_PREFETCH'),
          // 中间结果投机：比定稿再往前提，但文本是猜的（定稿确认是前缀才认领）
          partialSpeculate: readLegacyOn('FAST_LANE_PARTIAL_SPECULATE'),
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
      disposeStreaming();
    });
  }

  const assemblePending = (ttsForPipeline: TtsProvider, log: (line: string) => void): AssembledStreamingPipeline => {
    const pending = pendingStreaming;
    if (pending === null) {
      throw new Error('流式管道还没准备好');
    }
    return assembleStreamingAgent({
      plan: pending.plan,
      env: process.env,
      dshAgent: pending.dshAgent,
      tts: ttsForPipeline,
      activity: pending.activity,
      memory: pending.memory,
      refineHotwords: pending.refineHotwords,
      taskStatus: pending.taskStatus,
      audit: (name, data) => { auditSlot.emit(name, data); },
      speculate: pending.speculate,
      announceStore,
      log, memorySummary: pending.memorySummary, asrCorpusText: pending.asrCorpusText, asrLanguage: pending.asrLanguage,
    });
  };

  // ---------------------------------------------------------------- 图片 -> dsh 冒烟
  if (askImage) {
    // 识图在 TTS 之前就退出。cascade 原先这时已经包好了 agent；live 要等 TTS，
    // 所以识图仍走裸 dsh。这里不打影子横幅（那一行在流式分支、识图走不到）。
    const imagePipeline = pendingStreaming;
    if (imagePipeline !== null && imagePipeline.plan.mode === 'cascade') {
      try {
        const assembled = assemblePending(silentTts(24_000), () => {});
        agent = assembled.agent;
        disposeStreaming = assembled.dispose;
      } catch (error) {
        fail((error as Error).message);
      }
    }
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
    const r = await agent.reply(DEFAULT_IMAGE_QUESTION, {
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
    /**
     * 声学判停（Smart Turn v3.2）：**进程级一份，跨连接常驻**。
     *
     * 模型是 8.7 MB ONNX，冷启动实测 ~300 ms —— 真机每次重连（网络抖动 / 服务重启 /
     * 重开 App）第一句都要付这一刀，而它刚好落在「用户说完 → 开一轮」里。常驻之后
     * 只有进程启动付一次。`loadSharedTurnJudge` 内部用 1 s 低幅正弦预热一次推理。
     *
     * 必须在 {@link buildVoiceRuntimeConfig} 之前加载：参数表要带上实际模型路径，
     * 而配置要在这一步决定 `turnJudge` 是否存在（模型缺失 / `TURN_JUDGE=0` 时退回
     * 固定合并窗口）。
     */
    const turnJudgeClient = await loadSharedTurnJudge(process.env, (line) => { console.log(line); });
    const turnJudgeEnabled = turnJudgeClient !== null;
    if (turnJudgeClient !== null) {
      process.on('exit', () => { turnJudgeClient.stop(); });
    }
    const semanticKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim();
    // Pure Live 默认关语义判停，只有显式 SEMANTIC_END_TAG=1 才开。
    // Cascade / 非 live 仍默认开，SEMANTIC_END_TAG=0 退回纯声学判停。
    const semanticEnabled = (
      pipelinePlan?.mode === 'live'
        ? envString('SEMANTIC_END_TAG') === '1'
        : envString('SEMANTIC_END_TAG') !== '0'
    ) && semanticKey !== '';
    const stt = await buildStt(resolvedStt, {
      akId,
      akSecret,
      appkey,
      region,
      maxSentenceSilenceMs: sentenceSilenceMs,
      ...(vocabularyId ? { vocabularyId } : {}), corpusText, language,
    });
    if (sttIsPluginPath && pendingStreaming !== null) {
      try {
        const rechecked = assemblePipelinePlan(process.env, {
          sttName: resolvedStt,
          sttSupportsManualEndpoint: stt.supportsManualEndpoint,
          strict: true,
        });
        pipelinePlan = rechecked;
        pendingStreaming = { ...pendingStreaming, plan: rechecked };
      } catch (error) {
        fail((error as Error).message);
      }
    }
    // 增益、门限、判停、端点、超时：CLI / 插件 / 评测沙盒同一份（`voice-config.ts`）。
    // 时序不变量不过（validateVoiceTiming）就在这里退出，别把坏组合带进会话。
    let voice: ReturnType<typeof buildVoiceRuntimeConfig>;
    try {
      voice = buildVoiceRuntimeConfig({
        env: process.env,
        sttSpec: resolvedStt,
        ...(stt.supportsManualEndpoint === undefined
          ? {}
          : { sttSupportsManualEndpoint: stt.supportsManualEndpoint }),
        ...(pipelinePlan === null ? {} : { pipelineMode: pipelinePlan.mode }),
        turnJudgeEnabled,
        ...(turnJudgeClient === null ? {} : { turnJudgeModelPath: turnJudgeClient.modelPath }),
        semanticEnabled,
      });
    } catch (error) {
      fail((error as Error).message);
    }
    // 只有阿里云实现关心 region/appkey；换成别的实现时别把无关信息印出来
    const endpointBanner = voice.manualEndpoint
      ? `端点由我们控（commit=${voice.gate.commitMs} ms / VOICE_COMMIT_MS，ASR 封段 ${voice.gate.sttCommitMs} ms / VOICE_STT_COMMIT_MS）`
      : `端点由服务端 VAD（commit=${voice.gate.commitMs} ms，ASR 封段 ${voice.gate.sttCommitMs} ms；VOICE_COMMIT_MS 与 VOICE_STT_COMMIT_MS 不再生效）`;
    const sttBanner = resolvedStt === 'aliyun'
      ? `region=${region}  appkey=${appkey.slice(0, 4)}****  silence=${sentenceSilenceMs} ms`
        + (vocabularyId ? `  vocab=${vocabularyId}` : '  vocab=(未配置)')
      : resolvedStt === 'qwen-realtime'
        ? `model=${process.env['QWEN_ASR_MODEL'] ?? 'qwen3-asr-flash-realtime'}  ${endpointBanner}`
        : resolvedStt === 'openai-realtime'
          ? `model=${process.env['OPENAI_ASR_MODEL'] ?? 'gpt-4o-mini-transcribe'}  ${endpointBanner}`
          : stt.supportsManualEndpoint
            ? `插件手动端点  ${endpointBanner}`
            : '(外部/内置实现，无需凭据)';
    console.log(`STT      ${resolvedStt}  ${sttBanner}\n`);

    const tts = await buildTts(
      ttsSpec === '' ? 'mimo' : ttsSpec,
      (name, data) => { auditSlot.emit(name, data); },
    );
    console.log(`可替换件 STT=${stt.name}  TTS=${tts.name}（${tts.sampleRate} Hz）\n`);

    /**
     * omni 怎么接。
     *
     * - `live`：前台发声，`serve` 恒为 `full`。`clip` 档已经删了，显式请求时仍按 full 出声。
     * - `cascade`：不发声。只有 `useOmniProbeOnly`（`OMNI_SHADOW=1` 且 `OMNI_ANSWER=off`）
     *   才挂一只只读探针。
     * - 没有管道计划（echo 等）：沿用旧的 `omniWillEnable` + `OMNI_ANSWER`。
     *
     * 前两条在 {@link assembleStreamingAgent}。这里只补「想开探针但条件不够」的那句，
     * 因为它要带上当前的 STT 名字。
     */
    let streaming: AssembledStreamingPipeline | null = null;
    if (pendingStreaming !== null) {
      let assembled: AssembledStreamingPipeline;
      try {
        assembled = assemblePending(tts, (line) => { console.log(line); });
      } catch (error) {
        fail((error as Error).message);
      }
      streaming = assembled;
      agent = assembled.agent;
      disposeStreaming = assembled.dispose;
    }
    let omniShadow = streaming?.omniShadow;
    const manualSttCapable = isManualEndpointStt(resolvedStt, stt.supportsManualEndpoint);
    if (streaming !== null && streaming.mode === 'cascade' && omniShadow === undefined && omniWanted) {
      const pipelineOmniKey = resolveLiveApiKey(process.env);
      const why = pipelineOmniKey === ''
        ? 'LIVE_API_KEY / OMNI_API_KEY / DASHSCOPE_API_KEY 为空'
        : !manualSttCapable
          ? `STT=${resolvedStt}（需要支持手动封段的 STT，如 qwen-realtime / openai-realtime）`
          : 'OMNI_ANSWER 不是 off（只读探针要求 off，cascade 不接管发声）';
      console.log(`影子    OMNI_SHADOW=1 但没启用只读探针：${why}\n`);
    } else if (streaming === null) {
      const liveUrl = envString('LIVE_URL') ?? envString('OMNI_URL');
      const liveDialect = resolveRealtimeDialect(envString('LIVE_DIALECT') ?? envString('OMNI_DIALECT'), liveUrl);
      const liveDefaults = realtimeLiveDefaults(liveDialect);
      const omniModel = envString('LIVE_MODEL') ?? envString('OMNI_SHADOW_MODEL');
      const liveVoice = envString('LIVE_VOICE') ?? envString('OMNI_VOICE');
      const liveAsrModel = envString('LIVE_ASR_MODEL') ?? envString('OMNI_ASR_MODEL');
      const omniAnswer = envString('OMNI_ANSWER') ?? 'off';
      if (!['off', 'full'].includes(omniAnswer)) {
        console.error(`OMNI_ANSWER=${omniAnswer} 不合法（off|full）`);
        process.exit(2);
      }
      const fallbackLiveEnabled = omniWanted && omniKey !== '' && manualSttCapable;
      omniShadow = fallbackLiveEnabled
        ? {
          apiKey: omniKey,
          serve: omniAnswer as 'off' | 'full',
          ...(liveUrl ? { url: liveUrl } : {}),
          ...(liveDialect === 'dashscope' ? {} : { dialect: liveDialect }),
          ...(omniModel ? { model: omniModel } : {}),
          ...(liveVoice ? { voice: liveVoice } : {}),
          ...(liveAsrModel ? { asrModel: liveAsrModel } : {}),
        }
        : undefined;
      if (omniWanted && omniShadow === undefined) {
        console.log(
          '影子    OMNI_SHADOW=1 但没启用：'
          + (omniKey === ''
            ? 'LIVE_API_KEY / OMNI_API_KEY / DASHSCOPE_API_KEY 为空'
            : `STT=${resolvedStt}（需要支持手动封段的 STT，如 qwen-realtime / openai-realtime）`)
          + '\n',
        );
      } else if (omniShadow !== undefined) {
        console.log(
          `影子    live 旁路开（${liveDialect} / ${omniShadow.model ?? liveDefaults.model}，`
          + (omniShadow.serve === 'off' ? '只量不发声' : `**会出声** serve=${omniShadow.serve}`)
          + '）\n',
        );
      }
    }

    /**
     * 语义判停（END 标签，文本）：声学判停判不了「这句话说完了没有」，这一层只补这个洞。
     *
     * 和快车道共用一套凭据/端点（同一个 `qwen-flash`）—— 判停要的是快，不是聪明。
     * Cascade / 非 live 默认开，`SEMANTIC_END_TAG=0` 退回纯声学判停。
     * Pure Live 默认关，只有 `SEMANTIC_END_TAG=1` 才开。
     */
    const semantic = semanticEnabled
      ? semanticEndpoint({
        apiKey: semanticKey,
        ...(process.env['FAST_LANE_MODEL'] === undefined
          ? {}
          : { model: process.env['FAST_LANE_MODEL'] }),
        ...(process.env['FAST_LANE_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['FAST_LANE_BASE_URL'] }),
        timeoutMs: voice.semanticTimeoutMs,
        log: (line) => { console.log(line); },
      })
      : null;
    if (semantic !== null) {
      console.log('语义判停  开（END 标签，与静候窗重叠，超时按「说完了」）  SEMANTIC_END_TAG=0 关闭');
    }

    // 增益先算好并打出来：调音时最想知道「现在到底是几倍、门限在哪」。
    // 上行倍数和门限的默认值在 `voice-config.ts`，这里只打生效值。
    const ttsGain = envNumber('MIAI_TTS_GAIN', envNumber('TTS_GAIN', 1));
    console.log(
      `增益    上行 ${voice.micGain}×（能量门 ${voice.peakDbfs} dBFS，按放大后算）  下行 ${ttsGain}×\n`,
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
          + `${DEFAULT_PET_TICK_MS} ms，离场 ${DEFAULT_PET_TIMING.greetAfterAwayMs} ms 后重戴会打招呼\n`
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
    const engine = streaming?.engine;
    // 这两项配错要**在 CLI 里退出 2**。函数本身改成抛异常了（插件宿主不能退出），
    // 所以在这里接住、转成 `fail()` —— 退出码与提示语与改之前一字不差。
    let tls: { key: Buffer; cert: Buffer } | undefined;
    let authenticate: ((hello: { deviceId?: string; token?: string }) => boolean) | undefined;
    try {
      tls = loadTls();
      authenticate = loadAuthenticator((line) => { console.log(line); });
    } catch (error) {
      fail((error as Error).message);
    }
    const sharedVad = await loadSharedVad(process.env, (line) => { console.log(line); });
    let code = 1;
    try {
      code = await runVoiceServer({
      port: listen,
      ...(sharedVad === null ? {} : { vad: sharedVad }),
      host: opt('--host', '127.0.0.1'),
      device: deviceSpec,
      ffmpegPath: ffmpeg,
      agent,
      stt,
      tts,
      ...(plan === null ? {} : { pipelineMode: plan.mode }),
      ...(engine === undefined ? {} : { engine }),
      ...(streaming?.speakAnnounce === undefined
        ? {}
        : {
          speakAnnounce: streaming.speakAnnounce,
          cancelAnnounce: streaming.cancelAnnounce,
          onFallbackAnnounceSpoken: streaming.onFallbackAnnounceSpoken,
        }),
      ...(streaming?.shouldSkipAnnounce === undefined
        ? {}
        : { shouldSkipAnnounce: streaming.shouldSkipAnnounce }),
      // omni 影子旁路：默认不传 = 这条连接不会去连 DashScope，零成本
      ...(omniShadow === undefined ? {} : { omniShadow }),
      ...(voice.turnJudge === undefined ? {} : { turnJudge: voice.turnJudge }),
      ...(turnJudgeClient === null ? {} : { turnJudgeClient }),
      ...(semantic === null
        ? {}
        : { semantic, semanticBudgetMs: voice.semanticBudgetMs }),
      gate: voice.gate,
      playbackTailMs: voice.playbackTailMs,
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
      micGain: voice.micGain,
      // 调音用：`MIAI_LEVEL_LOG=2000` 每 2 s 打一行上行峰值（0 = 关）
      levelLogMs: envNumber('MIAI_LEVEL_LOG', 0),
      /**
       * 原始档案目录（空 = 不存）。一条连接一个目录，存原始 mSBC、放大前的 PCM、
       * 下行 PCM 和事件时间线 —— 出问题后能完整重放，见 `archive.ts`。
       * 旧的 `DUMP_DIR`（按轮次存、只覆盖播放期）已被它取代。
       */
      archiveDir: process.env['MIAI_ARCHIVE_DIR'] ?? '',
      archiveMaxMb: voice.archiveMaxMb,
      archiveKeep: voice.archiveKeep,
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
      // 拍照超时、确认超时、识图提问的默认值在 `voice-config.ts`。
      photoTimeoutMs: voice.photoTimeoutMs,
      confirmTimeoutMs: voice.confirmTimeoutMs,
      imageQuestion: voice.imageQuestion,
      announceStore,
      tls,
      authenticate,
      idleTimeoutMs: voice.idleTimeoutMs,
      serve: argv.includes('--serve') || process.env['MIAI_SERVE'] === '1',
      // 主动开口默认关：开着它会自己说话，得人明确要
      proactive: proactiveOn
        ? {
          params: {
            greetAfterAwayMs: DEFAULT_PET_TIMING.greetAfterAwayMs,
            chatterAfterIdleMs: DEFAULT_PET_TIMING.chatterAfterIdleMs,
            // 开麦到首帧上行音频的截止。小米实测 0.62 s，给到 1.5 s
            micOpenTimeoutMs: DEFAULT_PET_MIC_OPEN_TIMEOUT_MS,
          },
          listenMs: DEFAULT_PET_PARAMS.listenMs,
          tickMs: DEFAULT_PET_TICK_MS,
        }
        : null,
    });
    } finally {
      dshSession?.stop();
      await sharedVad?.dispose?.();
    }
    process.exit(code);
  }

  /**
   * 旧路径（`--replay` / 无 `--stt` 的本地监听）：**到这里才**加载 `legacy-pipeline`。
   *
   * 它一路拉进自己的 `SileroVad`。流式分支在上面 `process.exit()`，走不到这里。
   * 顶层仍然只允许 `import type`（`tests/main-wiring.test.ts` 卡着这条）；
   * 流式路径的神经 VAD 由 `loadSharedVad` 按需动态加载，失败退回能量门。
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

// `node src/main.ts`（含 `npm start`）仍然原样进 `main()`：无参运行时打印用法并以
// 退出码 2 结束，那是 `docs/CLOUD-ARCHITECTURE.md` §8 的启动自检。
// 第二个参数必须是本文件的 URL。默认值比的是 runtime/is-main.ts，无参调用进不了 main()。
if (isMainModule(process.argv[1], import.meta.url)) {
  void main();
}
