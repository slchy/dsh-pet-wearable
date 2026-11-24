/**
 * CLI、Web 插件、评测沙盒共用的语音运行时配置。
 *
 * 纯函数：只读传入的 `env`，不碰 `process.env`。三个入口的差异只走 `overrides`
 * （浏览器增益、沙盒档案上限），其余默认值在这里只有一份。
 *
 * 端点规则也只在这里：`qwen-realtime` 且没把 `QWEN_ASR_TURN_DETECTION` 设成 `vad`
 * 时，客户端才发 `commit()`。服务端 VAD 或别的 STT 把 `commitMs` / `sttCommitMs`
 * 收成 0，开轮静音门槛不传 —— 否则服务端已经在切句，客户端再 `commit()` 会把
 * 一句话切成两段。
 *
 * 调用必须发生在 `loadDotEnv()` 之后。下面的 `envNumber('NAME', fallback)`
 * 不能改成别的形状：`scripts/time-knobs.py` 靠这个字面量扫默认值。
 */
import { DEFAULT_CONFIRM_TIMEOUT_MS } from './photo-inbox.ts';

/** 识图冒烟和在线识图共用的那一句。 */
export const DEFAULT_IMAGE_QUESTION = '这张图里有什么？用一两句话口语化描述。';

/**
 * 播完后再等的余量（毫秒）。
 *
 * 不叫 `*_MS`：`scripts/time-knobs.py` 没登记这个名字，新的顶层 `*_MS` 会落到
 * 「缺时钟」。数值仍是原来写死在三处的 600。
 */
export const DEFAULT_PLAYBACK_TAIL = 600;

export type VoiceEnv = { readonly [key: string]: string | undefined };

/** 三端真正允许不一样的那几项。没写的字段走下面的统一默认。 */
export interface VoiceRuntimeOverrides {
  /** 浏览器 `getUserMedia` 已开 autoGainControl，插件传 1，盖掉眼镜的 4 */
  readonly micGain?: number;
  /** 里层没有固定端口偏移时传 0，让系统挑空闲口 */
  readonly controlPort?: number;
  readonly idleTimeoutMs?: number;
  readonly archiveMaxMb?: number;
  readonly archiveKeep?: number;
  readonly photoTimeoutMs?: number;
}

export interface VoiceRuntimeInput {
  readonly env: VoiceEnv;
  readonly sttSpec: string;
  readonly turnJudgeEnabled: boolean;
  readonly turnJudgePython: string;
  readonly turnJudgeScript: string;
  readonly semanticEnabled: boolean;
  readonly overrides?: VoiceRuntimeOverrides;
}

export interface VoiceGateConfig {
  readonly thresholdDbfs: number;
  readonly holdMs: number;
  readonly prerollMs: number;
  readonly pauseDetectMs: number;
  readonly speculateMs: number;
  readonly commitMs: number;
  readonly sttCommitMs: number;
  readonly openQuietMs?: number;
  readonly openQuietShortMs?: number;
}

export interface VoiceTurnJudgeConfig {
  readonly pythonPath: string;
  readonly scriptPath: string;
  readonly quietMs: number;
  readonly extendMs: number;
  readonly maxExtensions: number;
  readonly maxUnsureExtensions: number;
  readonly trailingTrimMs: number;
  readonly threshold: number;
  readonly thresholdCjk: number;
  readonly waitBudgetMs: number;
  readonly waitBudgetSequenceMs: number;
  readonly maxOpenSilenceMs: number;
}

export interface VoiceRuntimeConfig {
  readonly micGain: number;
  readonly peakDbfs: number;
  readonly gate: VoiceGateConfig;
  /** `turnJudgeEnabled` 为假时不给参数表，调用方也就不必建侧车 */
  readonly turnJudge: VoiceTurnJudgeConfig | undefined;
  readonly semanticBudgetMs: number;
  readonly semanticTimeoutMs: number;
  readonly confirmTimeoutMs: number;
  readonly photoTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly archiveMaxMb: number;
  readonly archiveKeep: number;
  readonly playbackTailMs: number;
  readonly imageQuestion: string;
  readonly controlPort: number;
  /**
   * 客户端自己封段。`qwen-realtime` 且不是服务端 VAD 时为真。
   * 为假时 `gate.commitMs` 与 `gate.sttCommitMs` 已是 0。
   */
  readonly manualEndpoint: boolean;
}

/**
 * omni 车道的 key。`OMNI_API_KEY` 优先，没有再落到 DashScope 那把。
 * 只含空白当成没配。
 */
export function resolveOmniApiKey(env: VoiceEnv): string {
  return (env['OMNI_API_KEY'] ?? env['DASHSCOPE_API_KEY'] ?? '').trim();
}

/**
 * 与 `util.envNumber` 同一套规则（空串退回默认、`TURN_JUDGE_*` 认旧名
 * `SMART_TURN_*`），但只读这次传入的 `env`。
 */
function envNumberFrom(env: VoiceEnv, name: string, fallback: number): number {
  const legacy = name.replace(/^TURN_JUDGE/, 'SMART_TURN');
  const raw = env[name] ?? env[legacy];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 要人动手的拍照只设一个兜底总时长。
 *
 * 显式给了 `MIAI_CONFIRM_TIMEOUT_MS`，或两段旧变量都没给，就用新名字
 * （默认 {@link DEFAULT_CONFIRM_TIMEOUT_MS}）。只留着旧的两段时把它们相加，
 * 免得改名当天把线上的 15 s + 25 s 收成 40 s 的另一套计时。
 */
function confirmTimeoutMs(
  env: VoiceEnv,
  envNumber: (name: string, fallback: number) => number,
): number {
  const explicit = env['MIAI_CONFIRM_TIMEOUT_MS'] !== undefined;
  const legacy = env['MIAI_HQ_ARM_TIMEOUT_MS'] !== undefined
    || env['MIAI_HQ_SHUTTER_TIMEOUT_MS'] !== undefined;
  if (explicit || !legacy) {
    return envNumber('MIAI_CONFIRM_TIMEOUT_MS', DEFAULT_CONFIRM_TIMEOUT_MS);
  }
  const arm = envNumber('MIAI_HQ_ARM_TIMEOUT_MS', 15_000);
  const shutter = envNumber('MIAI_HQ_SHUTTER_TIMEOUT_MS', 25_000);
  return arm + shutter;
}

export function buildVoiceRuntimeConfig(input: VoiceRuntimeInput): VoiceRuntimeConfig {
  const env = input.env;
  const sttSpec = input.sttSpec;
  const overrides = input.overrides ?? {};
  const envNumber = (name: string, fallback: number): number => envNumberFrom(env, name, fallback);

  // 眼镜 mic 电平低，4× 时小声说话才能推开能量门。浏览器另传 overrides.micGain。
  const micGain = overrides.micGain ?? envNumber('MIAI_MIC_GAIN', envNumber('MIC_GAIN', 4));
  /**
   * 能量门限（按**放大后**算）。
   *
   * 实测（增益 4×、安静房间）：底噪峰值大约 −60…−51 dBFS，说话在 −20…0。
   * −40 仍然太低：擦着门的电视/远处人声会被 ASR 幻觉成「嗯。」「对。」。
   * 开成轮的段在 −16…−6 dBFS，没开轮的在 −51…−43，中间空着，所以默认 −30。
   * 这是电平判据，不是段长判据。
   */
  const peakDbfs = envNumber('VOICE_PEAK_DBFS', -30);

  // 服务端 VAD 拿走了封段权。客户端再 commit 会和它抢同一句话。
  const manualEndpoint = sttSpec === 'qwen-realtime' && env['QWEN_ASR_TURN_DETECTION'] !== 'vad';
  const commitConfigured = envNumber('VOICE_COMMIT_MS', sttSpec === 'qwen-realtime' ? 20 : 0);
  const sttCommitConfigured = envNumber('VOICE_STT_COMMIT_MS', sttSpec === 'qwen-realtime' ? 150 : 0);
  const openQuietMs = envNumber('VOICE_OPEN_QUIET_MS', 300);
  const openQuietShortMs = envNumber('VOICE_OPEN_QUIET_SHORT_MS', 200);

  const gate: VoiceGateConfig = {
    thresholdDbfs: peakDbfs,
    holdMs: envNumber('VOICE_HOLD_MS', 2000),
    prerollMs: envNumber('VOICE_PREROLL_MS', 800),
    // 静音多久就提前跑判停（和 ASR 的 max_sentence_silence 对齐）；0 = 关闭
    pauseDetectMs: envNumber('VOICE_PAUSE_DETECT_MS', 200),
    // 投机要比判停早：它给「提前合成音频」腾窗口，不是省自己的时间
    speculateMs: envNumber('VOICE_SPECULATE_MS', 100),
    // `commitMs` 只让 omni 车道起跑；ASR 封段晚一拍，免得把书名切成两段。
    // 非 manual 时两项都是 0：NLS 自己判句，服务端 VAD 也自己判句。
    commitMs: manualEndpoint ? commitConfigured : 0,
    sttCommitMs: manualEndpoint ? sttCommitConfigured : 0,
    // 开轮门槛只对「端点由我们控」生效。定稿来得早，静音不够就再等。
    ...(manualEndpoint ? { openQuietMs, openQuietShortMs } : {}),
  };

  const turnJudge = input.turnJudgeEnabled
    ? {
      pythonPath: input.turnJudgePython,
      scriptPath: input.turnJudgeScript,
      // 有了静音预跑判停，定稿到达时概率已经算好，这段静候是白等。
      quietMs: envNumber('TURN_JUDGE_QUIET_MS', 0),
      // 真机上「再等」全部等到放行、没有人接着说。400 ms 没换到新信息。
      // 在函数调用时读：模块顶层早于 `loadDotEnv()`，`.env` 里的值会读不到。
      extendMs: envNumber('TURN_JUDGE_EXTEND_MS', 200),
      maxExtensions: envNumber('TURN_JUDGE_MAX_EXT', 2),
      // 「判停说没说完」不看文本，p 又是噪声。单独收到 1 拍，别的判据仍吃上面的额度。
      maxUnsureExtensions: envNumber('TURN_JUDGE_MAX_UNSURE', 1),
      // 快照尾部留静音会把语音从窗口末尾推开，p 被拉低。取小值只为方向正确。
      trailingTrimMs: envNumber('TURN_JUDGE_TRIM_MS', 20),
      threshold: envNumber('TURN_JUDGE_THRESHOLD', 0.5),
      // 中文完整短句常给 0.22–0.41，没说完的在 0.11 以下。0.5 会把前者判成没说完。
      thresholdCjk: envNumber('TURN_JUDGE_THRESHOLD_CJK', 0.35),
      // ② 的总等待预算。0 = 不设。让定稿→开轮有一个可预测的天花板。
      waitBudgetMs: envNumber('TURN_JUDGE_WAIT_BUDGET_MS', 200),
      // 数字/字母/「然后」这类句尾，判「没说完」是对的，别让总预算把它掐掉。
      waitBudgetSequenceMs: envNumber('TURN_JUDGE_SEQUENCE_BUDGET_MS', 1_200),
      // 开轮静音的统一上限，任何分支都不许绕过。超过它的等待换不来更低的误切。
      maxOpenSilenceMs: envNumber('TURN_JUDGE_MAX_OPEN_SILENCE_MS', 650),
    }
    : undefined;

  // `semanticEnabled` 只决定调用方建不建客户端；预算本身三端必须是同一对数。
  const semanticBudgetMs = envNumber('SEMANTIC_END_TAG_BUDGET_MS', 400);
  const semanticTimeoutMs = envNumber('SEMANTIC_END_TAG_TIMEOUT_MS', 400);
  void input.semanticEnabled;

  return {
    micGain,
    peakDbfs,
    gate,
    turnJudge,
    semanticBudgetMs,
    semanticTimeoutMs,
    confirmTimeoutMs: confirmTimeoutMs(env, envNumber),
    // 高清链路要等手机建 P2P + 设备写相册，20 s 不够（线上要 50 s+）。
    photoTimeoutMs: overrides.photoTimeoutMs ?? envNumber('MIAI_PHOTO_TIMEOUT_MS', 60_000),
    idleTimeoutMs: overrides.idleTimeoutMs ?? envNumber('MIAI_IDLE_TIMEOUT_MS', 45_000),
    archiveMaxMb: overrides.archiveMaxMb ?? envNumber('MIAI_ARCHIVE_MAX_MB', 80),
    archiveKeep: overrides.archiveKeep ?? envNumber('MIAI_ARCHIVE_KEEP', 20),
    playbackTailMs: DEFAULT_PLAYBACK_TAIL,
    imageQuestion: DEFAULT_IMAGE_QUESTION,
    controlPort: overrides.controlPort ?? envNumber('PHOTO_CTL_PORT', 0),
    manualEndpoint,
  };
}
