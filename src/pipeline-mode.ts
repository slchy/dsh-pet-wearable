/**
 * 语音主管道的启动期选择：`live`（omni 直出）与 `cascade`（文本快车道 → TTS）二选一。
 *
 * 纯函数：不读 `process.env`、不做 IO。装配层把环境收成 {@link ResolvePipelineInput}
 * 再进来；{@link resolveVoicePipelineFromEnv} 只看调用方传入的 `env`。
 *
 * 会话内两条管道严格互斥，绝不混跑。`VOICE_PIPELINE` 没写时，才用旧的
 * `OMNI_SHADOW` / `OMNI_ANSWER` 推断；显式开关优先。
 */

/** 语音主管道形态：启动期显式二选一，会话内严格互斥，绝不混跑。 */
export type VoicePipelineMode = 'live' | 'cascade';

export interface ResolvePipelineInput {
  /** 显式开关 `VOICE_PIPELINE`（'live' | 'cascade'，未设时按兼容规则推断） */
  readonly explicit?: string;
  /** 是否开启 omni 影子旁路（兼容旧 `OMNI_SHADOW=1`） */
  readonly omniShadow?: boolean;
  /** 兼容旧 `OMNI_ANSWER`（'off' | 'clip' | 'full'） */
  readonly omniAnswer?: string;
  /** 是否关闭文本级联快车道（`FAST_LANE=0`） */
  readonly fastOff?: boolean;
  /** 文本级联快车道 API key（已 trim） */
  readonly fastKey?: string;
  /** 音频直出模型 API key（`OMNI_API_KEY ?? DASHSCOPE_API_KEY`，已 trim） */
  readonly omniKey?: string;
  /** 当前选择的 STT provider 名称（如 `'qwen-realtime'` / `'aliyun'` / `'canned'`） */
  readonly sttName?: string;
  /** 是否跳过外部 key/STT 强校验（仅 offline/echo 测试场景需要时传 false；默认 true） */
  readonly strict?: boolean;
}

export interface PipelinePlan {
  readonly mode: VoicePipelineMode;
  /** 是否由 Omni 接管对话发声与背景汇报（仅 `mode === 'live'` 为 true） */
  readonly useOmniPlayback: boolean;
  /** 是否在 cascade 模式下挂载只读测速影子探针（不接管路由、不发声） */
  readonly useOmniProbeOnly: boolean;
  /** 是否在 cascade 模式下启用文本快车道 `FastLlmClient`（仅 `mode === 'cascade'` 可能为 true） */
  readonly useCascadeFastLane: boolean;
  /** 纯级联快车道实际使用的 key（`mode === 'live'` 时恒为空串） */
  readonly cascadeKey: string;
  /** 是否由显式 `VOICE_PIPELINE` 指定 */
  readonly explicit: boolean;
  /** 启动期供日志打印的说明/警告 */
  readonly notes: readonly string[];
}

const LIVE_FAST_LANE_NOTE = '纯 live 模式：不加载文本级联快车道（FastLlmClient / PrefetchSlot 已禁用）';
const CASCADE_IGNORE_ANSWER_NOTE = '显式 VOICE_PIPELINE=cascade：忽略 OMNI_ANSWER，不接管发声';

function answerMode(omniAnswer: string | undefined): string {
  return (omniAnswer ?? 'off').trim().toLowerCase();
}

/**
 * 把启动参数收成一份互斥的管道计划。
 *
 * `strict !== false`（默认）时，`live` 缺 key 或 STT 不是 `qwen-realtime` 直接抛错，
 * 避免装成「开了 live、其实没声音」的静默降级。
 */
export function resolveVoicePipeline(input: ResolvePipelineInput): PipelinePlan {
  const requested = input.explicit?.trim().toLowerCase() ?? '';
  const notes: string[] = [];

  let mode: VoicePipelineMode;
  let explicit: boolean;
  if (requested === 'live' || requested === 'cascade') {
    mode = requested;
    explicit = true;
  } else if (requested !== '') {
    throw new Error(`VOICE_PIPELINE 无效值 "${input.explicit}"：只允许 "live" 或 "cascade"`);
  } else {
    explicit = false;
    const answer = answerMode(input.omniAnswer);
    mode = input.omniShadow === true && answer !== 'off' ? 'live' : 'cascade';
  }

  if (mode === 'live') {
    if (input.strict !== false) {
      if ((input.omniKey ?? '').trim() === '') {
        throw new Error('VOICE_PIPELINE=live 需要 OMNI_API_KEY 或 DASHSCOPE_API_KEY');
      }
      if (input.sttName !== undefined && input.sttName !== 'qwen-realtime') {
        throw new Error(`VOICE_PIPELINE=live 需要 --stt qwen-realtime（当前是 ${input.sttName}）`);
      }
    }
    if ((input.fastKey ?? '').trim() !== '' && input.fastOff !== true) {
      notes.push(LIVE_FAST_LANE_NOTE);
    }
    return {
      mode,
      useOmniPlayback: true,
      useOmniProbeOnly: false,
      useCascadeFastLane: false,
      cascadeKey: '',
      explicit,
      notes,
    };
  }

  const answer = answerMode(input.omniAnswer);
  const useOmniProbeOnly = input.omniShadow === true
    && answer === 'off'
    && (input.omniKey ?? '').trim() !== ''
    && (input.sttName === undefined || input.sttName === 'qwen-realtime');
  if (explicit && input.omniShadow === true && answer !== 'off') {
    notes.push(CASCADE_IGNORE_ANSWER_NOTE);
  }
  const cleanFastKey = (input.fastKey ?? '').trim();
  const useCascadeFastLane = input.fastOff !== true && cleanFastKey !== '';
  return {
    mode,
    useOmniPlayback: false,
    useOmniProbeOnly,
    useCascadeFastLane,
    cascadeKey: useCascadeFastLane ? cleanFastKey : '',
    explicit,
    notes,
  };
}

/**
 * 从一份环境记录解析主管道。不读 `process.env`。
 *
 * - `VOICE_PIPELINE` → 显式模式
 * - `OMNI_SHADOW=1` → 影子旁路
 * - `OMNI_ANSWER` → 旧档位（`off` / `clip` / `full`）
 * - `FAST_LANE=0` → 关掉文本快车道
 * - `FAST_LANE_API_KEY ?? DEEPSEEK_API_KEY` → 级联 key
 * - `OMNI_API_KEY ?? DASHSCOPE_API_KEY` → 音频直出 key
 */
export function resolveVoicePipelineFromEnv(
  env: Record<string, string | undefined>,
  opts?: { readonly sttName?: string; readonly strict?: boolean },
): PipelinePlan {
  const fastKey = (env['FAST_LANE_API_KEY'] ?? env['DEEPSEEK_API_KEY'] ?? '').trim();
  const omniKey = (env['OMNI_API_KEY'] ?? env['DASHSCOPE_API_KEY'] ?? '').trim();
  return resolveVoicePipeline({
    explicit: env['VOICE_PIPELINE'],
    omniShadow: env['OMNI_SHADOW'] === '1',
    omniAnswer: env['OMNI_ANSWER'],
    fastOff: env['FAST_LANE'] === '0',
    fastKey,
    omniKey,
    ...(opts?.sttName === undefined ? {} : { sttName: opts.sttName }),
    ...(opts?.strict === undefined ? {} : { strict: opts.strict }),
  });
}
