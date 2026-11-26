/**
 * 语音管道装配。`live` 与 `cascade` 只装其中一条；不读 `process.env`。
 *
 * 热路径上那几行 `envNum` / `env['FAST_LANE_*']` 的字面量是
 * `scripts/time-knobs.py` 的扫描点，保持单行，不要改写成别的读法。
 */
import type { AnnounceStore } from '../announce-store.ts';
import type { EngineEvent, FastVoiceEngine } from '../engine-contract.ts';
import { trackActivity, type ActivityState } from '../keepalive.ts';
import {
  resolveVoicePipelineFromEnv,
  type PipelinePlan,
  type VoicePipelineMode,
} from '../pipeline-mode.ts';
import { CascadeAgent, LiveOrchestrator } from '../pipelines/index.ts';
import type { AgentProvider, BackgroundTaskReport, TtsProvider } from '../providers.ts';
import { realtimeLiveDefaults, resolveRealtimeDialect } from '../realtime-dialect.ts';
import { resolveLiveApiKey } from '../voice-config.ts';
import type { VoiceSessionOptions } from '../voice-session.ts';
import { formatCurrentDateContext } from './asr-context.ts';

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
  opts?: {
    readonly sttName?: string;
    readonly sttSupportsManualEndpoint?: boolean;
    readonly strict?: boolean;
  },
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
  log: (line: string) => void,
): LiveOrchestrator {
  const persist = (speech: string, emotion?: string): void => {
    const pending = store?.push(speech, emotion) ?? 0;
    log(`  后台    没有连接，存入待补播（积压 ${pending} 条）`);
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

function envNum(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cancelModeOf(env: Record<string, string | undefined>): 'rpc' | 'interrupt' | 'off' {
  const mode = env['FAST_LANE_CANCEL'];
  return mode === 'sigint' ? 'interrupt' : mode === 'off' ? 'off' : 'rpc';
}

/**
 * 级联要逐条记忆，直播编排要一整段注记。调用方统一传
 * `relevant().join('\n')`，这里再拆开。空串是「没有」，不能变成 `['']`。
 */
function memoryLines(memory: (text: string) => string): (text: string) => readonly string[] {
  return (text) => {
    const block = memory(text);
    if (block.trim() === '') return [];
    return block.split('\n');
  };
}

interface OmniStaticInput {
  readonly memorySummary?: () => string;
  readonly clockContext?: () => string;
  readonly asrCorpusText?: string;
  readonly asrLanguage?: string;
}

/** 影子上的静态上下文。记忆摘要留成函数，每条新连接再读一次。 */
function omniStaticContext(ctx: OmniStaticInput): {
  readonly memoryContext?: () => string;
  readonly clockContext: () => string;
  readonly asrCorpusText?: string;
  readonly asrLanguage?: string;
} {
  return {
    ...(ctx.memorySummary === undefined ? {} : { memoryContext: ctx.memorySummary }),
    clockContext: ctx.clockContext ?? (() => formatCurrentDateContext()),
    ...(ctx.asrCorpusText === undefined ? {} : { asrCorpusText: ctx.asrCorpusText }),
    ...(ctx.asrLanguage === undefined ? {} : { asrLanguage: ctx.asrLanguage }),
  };
}

function streamingOmniShadow(
  plan: PipelinePlan,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  ctx: OmniStaticInput = {},
): NonNullable<VoiceSessionOptions['omniShadow']> | undefined {
  const url = (env['LIVE_URL'] ?? env['OMNI_URL'])?.trim();
  const dialect = resolveRealtimeDialect(env['LIVE_DIALECT'] ?? env['OMNI_DIALECT'], url);
  const defaults = realtimeLiveDefaults(dialect);
  const model = (env['LIVE_MODEL'] ?? env['OMNI_SHADOW_MODEL'])?.trim();
  const voice = (env['LIVE_VOICE'] ?? env['OMNI_VOICE'])?.trim();
  const asrModel = (env['LIVE_ASR_MODEL'] ?? env['OMNI_ASR_MODEL'])?.trim();
  const extraOpts = {
    ...(url ? { url } : {}),
    ...(dialect === 'dashscope' ? {} : { dialect }),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(asrModel ? { asrModel } : {}),
  };
  const apiKey = resolveLiveApiKey(env);
  if (plan.mode === 'live') {
    const requested = (env['OMNI_ANSWER'] ?? '').trim().toLowerCase();
    if (requested !== '' && requested !== 'off' && requested !== 'full' && requested !== 'clip') {
      throw new Error(`OMNI_ANSWER=${requested} 不合法（off|full；clip 已并入 full）`);
    }
    if (requested === 'clip') {
      log('管道      OMNI_ANSWER=clip 已取消，纯 live 按 full 出声');
    }
    const omniShadow = { apiKey, serve: 'full' as const, ...extraOpts, ...omniStaticContext(ctx) };
    log(
      `影子    live 前台开（${dialect} / ${omniShadow.model ?? defaults.model}，`
      + `**会出声** serve=${omniShadow.serve}）\n`,
    );
    return omniShadow;
  }
  if (plan.useOmniProbeOnly) {
    const omniShadow = { apiKey, serve: 'off' as const, ...extraOpts, ...omniStaticContext(ctx) };
    log(
      `影子    live 只读探针（${dialect} / ${omniShadow.model ?? defaults.model}，只量不发声）\n`,
    );
    return omniShadow;
  }
  return undefined;
}

/** {@link assembleStreamingAgent} 的显式依赖。不读 `process.env`。 */
export interface AssembleStreamingAgentDeps {
  readonly plan: PipelinePlan;
  readonly env: Record<string, string | undefined>;
  readonly dshAgent: AgentProvider;
  readonly tts: TtsProvider;
  readonly activity: ActivityState;
  readonly memory: (text: string) => string;
  readonly taskStatus: () => string;
  readonly audit: (name: string, data: Record<string, unknown>) => void;
  readonly speculate: boolean;
  readonly announceStore?: AnnounceStore | null;
  readonly log?: (line: string) => void;
  readonly memorySummary?: () => string;
  readonly clockContext?: () => string;
  readonly asrCorpusText?: string;
  readonly asrLanguage?: string;
}

/** `VOICE_PIPELINE=live | cascade` 装配完、可以直接交给 `runVoiceServer` 的那一套。 */
export interface AssembledStreamingPipeline {
  readonly mode: VoicePipelineMode;
  readonly agent: AgentProvider;
  /** 已经用 `trackActivity` 的同一份 `activity` 包过 `respond()`。 */
  readonly engine?: FastVoiceEngine;
  readonly omniShadow?: VoiceSessionOptions['omniShadow'];
  readonly speakAnnounce?: VoiceSessionOptions['speakAnnounce'];
  readonly cancelAnnounce?: VoiceSessionOptions['cancelAnnounce'];
  readonly shouldSkipAnnounce?: VoiceSessionOptions['shouldSkipAnnounce'];
  readonly onFallbackAnnounceSpoken?: VoiceSessionOptions['onFallbackAnnounceSpoken'];
  readonly dispose: () => void;
}

/**
 * `--agent dsh` 的流式热路径。`live` 与 `cascade` 只装其中一条。
 *
 * 不读 `process.env`：密钥、档位、快车道旋钮都只看 `env`。
 * `main()` 在 TTS 就绪后调用，装配结果与原先写在 `main()` 里的那一段相同。
 */
export function assembleStreamingAgent(input: AssembleStreamingAgentDeps): AssembledStreamingPipeline {
  const {
    plan, env, dshAgent, tts, activity, memory, taskStatus, audit, speculate,
  } = input;
  const announceStore = input.announceStore ?? null;
  const log = input.log ?? ((line: string) => { console.log(line); });

  if (plan.mode === 'live') {
    // pure-live-assembly：只要直播编排。文本级联不装。
    // 非法 OMNI_ANSWER 在造编排器之前抛出，免得退出时留下一条没人 dispose 的总线。
    const omniShadow = streamingOmniShadow(plan, env, log, {
      memorySummary: input.memorySummary,
      clockContext: input.clockContext,
      asrCorpusText: input.asrCorpusText,
      asrLanguage: input.asrLanguage,
    });
    const orch = new LiveOrchestrator({
      inner: dshAgent,
      tts,
      // 编排器要的是一整段注记；记忆文件返回的是几条，调用方已经拼好。
      memory,
      log,
    });
    const surfaced = armLiveOfflineAnnounce(orch, announceStore, log);
    const agent = trackActivity(surfaced, activity);
    const engine = watchEngineActivity(orch.toEngine(), activity);
    return {
      mode: plan.mode,
      agent,
      engine,
      ...(omniShadow === undefined ? {} : { omniShadow }),
      speakAnnounce: (item, playAudio) => orch.speakBackgroundReport(item, playAudio),
      cancelAnnounce: () => { orch.cancelBackgroundSpeech(); },
      shouldSkipAnnounce: (item) => orch.shouldSkipBackgroundReport(item),
      onFallbackAnnounceSpoken: (item, interrupted) => {
        orch.noteFallbackAnnounceSpoken(item, interrupted);
      },
      dispose: () => { orch.dispose(); },
    };
  }

  // pure-cascade-assembly：只要级联，或关掉快车道后的直连 dsh。不接 omni 发声。
  const fastModel = env['FAST_LANE_MODEL'] ?? 'qwen-flash';
  const baseUrl = env['FAST_LANE_BASE_URL'];
  const fastBaseUrl = baseUrl === undefined ? {} : { baseUrl };
  // time-knobs 扫这一行。不要拆行，也不要改成 process.env。
  const delegateEnabled = (env['FAST_LANE_DELEGATE'] ?? '0') !== '0';
  let agent: AgentProvider;
  let engine: FastVoiceEngine | undefined;
  if (plan.useCascadeFastLane) {
    const cascadeAgent = new CascadeAgent({
      inner: dshAgent,
      apiKey: plan.cascadeKey,
      model: fastModel,
      ...fastBaseUrl,
      // time-knobs：TIMEOUT / PREFETCH / PARTIAL_SPECULATE 保持单行字面量。
      timeoutMs: envNum(env, 'FAST_LANE_TIMEOUT_MS', 1_200),
      speculate,
      cancelMode: cancelModeOf(env),
      maxChars: envNum(env, 'FAST_LANE_MAX_CHARS', 14),
      prefetch: env['FAST_LANE_PREFETCH'] !== '0',
      partialSpeculate: env['FAST_LANE_PARTIAL_SPECULATE'] !== '0',
      specMinChars: envNum(env, 'FAST_LANE_SPEC_MIN_CHARS', 6),
      windowChars: envNum(env, 'FAST_LANE_WINDOW_CHARS', 800),
      keepTurns: envNum(env, 'FAST_LANE_KEEP_TURNS', 0),
      hedge: envNum(env, 'FAST_LANE_HEDGE', 2),
      delegateEnabled,
      taskStatus,
      memory: memoryLines(memory),
      log,
      audit,
    });
    agent = trackActivity(cascadeAgent, activity);
    engine = watchEngineActivity(cascadeAgent.toEngine(tts), activity);
  } else {
    agent = trackActivity(dshAgent, activity);
    engine = undefined;
  }
  const omniShadow = streamingOmniShadow(plan, env, log, {
    memorySummary: input.memorySummary,
    clockContext: input.clockContext,
    asrCorpusText: input.asrCorpusText,
    asrLanguage: input.asrLanguage,
  });
  return {
    mode: plan.mode,
    agent,
    ...(engine === undefined ? {} : { engine }),
    ...(omniShadow === undefined ? {} : { omniShadow }),
    dispose: () => {},
  };
}
