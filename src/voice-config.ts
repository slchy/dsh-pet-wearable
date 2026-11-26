/**
 * CLI、Web 插件、评测沙盒共用的语音运行时配置。
 *
 * 纯函数：只读传入的 `env`，不碰 `process.env`。三端差异只走 `overrides`；
 * 设备差异走 `profile`（缺省 `glasses`）。优先级是
 * `overrides` > 显式 env > 档案默认值。
 *
 * 时间旋钮分两层：
 * - 一级仍是 `envNumber('NAME', fallback)`。`scripts/time-knobs.py` 靠这个
 *   字面量扫默认值，所以调用必须发生在 `loadDotEnv()` 之后，形状也不能改。
 * - 二级热路径（保持、预卷、判停预跑、投机、尾部裁剪、播完余量）是本文件
 *   顶部的常量。这些数的调整幅度小于外部 API 抖动，不再进 `.env`。
 *
 * 端点规则也只在这里：`qwen-realtime` 且没把 `QWEN_ASR_TURN_DETECTION` 设成 `vad`
 * 时，客户端才发 `commit()`。服务端 VAD 或别的 STT 把 `commitMs` / `sttCommitMs`
 * 收成 0，开轮静音门槛不传 —— 否则服务端已经在切句，客户端再 `commit()` 会把
 * 一句话切成两段。
 *
 * 返回前 {@link validateVoiceTiming} 校验时序不变量。非法组合直接抛 `RangeError`，
 * 免得能量门、封段和开轮静音各读各的数，线上才发现门槛互相够不着。
 */
import { DEFAULT_CONFIRM_TIMEOUT_MS } from './photo-inbox.ts';

/** 识图冒烟和在线识图共用的那一句。 */
export const DEFAULT_IMAGE_QUESTION = '这张图里有什么？用一两句话口语化描述。';

/**
 * 二级热路径常量。源码是唯一真相源，`voice-session.ts` 与
 * `scripts/time-knobs.py` 都引用这些导出名。
 *
 * `DEFAULT_PLAYBACK_TAIL` 是旧导出名，数值跟 `DEFAULT_PLAYBACK_TAIL_MS`。
 * `DEFAULT_TRAILING_TRIM_MS` 同时取代 `voice-session.ts` 里重复的
 * `ASSEMBLER_TRAILING_TRIM_MS`。
 */
export const DEFAULT_PLAYBACK_TAIL_MS = 600;
export const DEFAULT_PLAYBACK_TAIL = DEFAULT_PLAYBACK_TAIL_MS;
/** 原 `VOICE_HOLD_MS`。停嘴后能量门还要开着，给封段和开轮静音留窗口。 */
export const DEFAULT_GATE_HOLD_MS = 2_000;
/** 原 `VOICE_PREROLL_MS`。开门前保留的音频，是滑窗长度，不加延迟。TurnJudge 用完整这一段。 */
export const DEFAULT_GATE_PREROLL_MS = 800;
/**
 * 单段有效有声累计不足这么久，不触发 `omni.seal` / `stt.commit` / 投机 / 预跑。
 * 短噪声尖峰停在这里；够了才进入静音门槛，本身不加等待。
 */
export const DEFAULT_MIN_SPEECH_MS = 120;
/**
 * 开门时喂给 ASR 与 Omni 的预卷只留尾部这么久。
 * {@link DEFAULT_GATE_PREROLL_MS} 仍完整交给 TurnJudge。
 */
export const DEFAULT_ASR_PREROLL_MS = 320;
/** 原 `VOICE_PAUSE_DETECT_MS`。静音多久就提前跑判停。 */
export const DEFAULT_PAUSE_DETECT_MS = 200;
/**
 * 原 `VOICE_SPECULATE_MS`。投机要比判停早，给「提前合成」腾窗口。
 * `pipelineMode === 'live'` 时装配收成 0：Pure Live 没有级联中间结果。
 */
export const DEFAULT_SPECULATE_MS = 100;
/** 原 `TURN_JUDGE_TRIM_MS`。快照尾部留太多静音会把语音从窗口末尾推开，p 被拉低。 */
export const DEFAULT_TRAILING_TRIM_MS = 20;
/** 眼镜上行电平低，ASR 静音封段窗取短。 */
export const DEFAULT_GLASSES_STT_COMMIT_MS = 150;
/** 浏览器开了 AGC，封段窗放宽，避免词中切断。 */
export const DEFAULT_BROWSER_STT_COMMIT_MS = 320;

/**
 * 设备时序档案。同一套管道，眼镜和浏览器的上行电平、封段窗不同。
 * 没写 `profile` 时按眼镜，和 CLI 的历史默认一致。
 */
export type VoiceDeviceProfile = 'glasses' | 'browser';

export interface VoiceDeviceProfileDefaults {
  readonly micGain: number;
  readonly peakDbfs: number;
  readonly sttCommitMs: number;
  readonly controlPort: number;
}

export const DEVICE_TIMING_PROFILES: Readonly<Record<VoiceDeviceProfile, VoiceDeviceProfileDefaults>> = {
  glasses: {
    micGain: 4,
    peakDbfs: -30,
    sttCommitMs: DEFAULT_GLASSES_STT_COMMIT_MS,
    controlPort: 0,
  },
  browser: {
    micGain: 1,
    peakDbfs: -34,
    sttCommitMs: DEFAULT_BROWSER_STT_COMMIT_MS,
    controlPort: 0,
  },
};

export type VoiceEnv = { readonly [key: string]: string | undefined };

/** 三端真正允许不一样的那几项。没写的字段走档案默认，再往下才是常量。 */
export interface VoiceRuntimeOverrides {
  /** 浏览器 `getUserMedia` 已开 autoGainControl，插件传 1，盖掉眼镜的 4 */
  readonly micGain?: number;
  /** 浏览器 `micGain: 1` 比眼镜 4× 低 12 dB，未显式配 `VOICE_PEAK_DBFS` 时可覆盖能量门 */
  readonly peakDbfs?: number;
  /** 浏览器未显式配 `VOICE_STT_COMMIT_MS` 时可覆盖 ASR 静音封段窗（非 manual 仍收 0） */
  readonly sttCommitMs?: number;
  /** 里层没有固定端口偏移时传 0，让系统挑空闲口 */
  readonly controlPort?: number;
  readonly idleTimeoutMs?: number;
  readonly archiveMaxMb?: number;
  readonly archiveKeep?: number;
  readonly photoTimeoutMs?: number;
}

export interface VoiceRuntimeInput {
  readonly env: VoiceEnv;
  /** 缺省 `'glasses'`。 */
  readonly profile?: VoiceDeviceProfile;
  /**
   * 缺省 `undefined`，投机窗用 {@link DEFAULT_SPECULATE_MS}。
   * `'live'` 把 `gate.speculateMs` 收成 0。
   */
  readonly pipelineMode?: 'live' | 'cascade';
  readonly sttSpec: string;
  readonly turnJudgeEnabled: boolean;
  /** 声学判停（Smart Turn v3.2）模型路径；缺省由 `resolveTurnJudgeModelPath` 找。 */
  readonly turnJudgeModelPath?: string;
  readonly semanticEnabled: boolean;
  readonly overrides?: VoiceRuntimeOverrides;
}

export interface VoiceGateConfig {
  readonly thresholdDbfs: number;
  readonly holdMs: number;
  readonly prerollMs: number;
  /**
   * 单段有效有声累计不足这么久不封段、不投机、不预跑。
   * 缺省由 {@link DEFAULT_MIN_SPEECH_MS} 填入。直接构造装配器时不传则视为 0。
   */
  readonly minSpeechMs?: number;
  /**
   * 喂给 ASR / Omni 的预卷尾窗。必须落在 `[0, prerollMs]`。
   * 缺省 {@link DEFAULT_ASR_PREROLL_MS}。大于等于 `prerollMs` 时不裁。
   */
  readonly asrPrerollMs?: number;
  readonly pauseDetectMs: number;
  readonly speculateMs: number;
  readonly commitMs: number;
  readonly sttCommitMs: number;
  readonly openQuietMs?: number;
  readonly openQuietShortMs?: number;
  /**
   * 开轮静音的统一上限。手动端点时总会带上，即使没开声学判停。
   * `0` 表示不设上限。非手动端点不传。
   */
  readonly maxOpenSilenceMs?: number;
}

export interface VoiceTurnJudgeConfig {
  /** 声学判停（Smart Turn v3.2）模型路径；缺省时连接层按环境变量再找一次。 */
  readonly modelPath?: string;
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
  /** `turnJudgeEnabled` 为假时不给参数表，调用方也就不必建判停器 */
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

function rejectTiming(message: string): never {
  throw new RangeError(message);
}

/**
 * 启动期时序不变量。非法组合抛中文 `RangeError`，带上实际数值和旋钮名。
 * 纯函数：只读 `config`。
 */
export function validateVoiceTiming(config: VoiceRuntimeConfig): void {
  const gate = config.gate;

  if (!(gate.holdMs > 0)) {
    rejectTiming(`能量门保持 gate.holdMs=${gate.holdMs} 必须大于 0（DEFAULT_GATE_HOLD_MS）`);
  }
  if (!(gate.prerollMs >= 0)) {
    rejectTiming(`能量门预卷 gate.prerollMs=${gate.prerollMs} 必须 >= 0（DEFAULT_GATE_PREROLL_MS）`);
  }
  if (gate.asrPrerollMs !== undefined) {
    const asrPrerollMs = gate.asrPrerollMs;
    if (!(asrPrerollMs >= 0) || asrPrerollMs > gate.prerollMs) {
      rejectTiming(
        `ASR 预卷 gate.asrPrerollMs=${asrPrerollMs} 必须在 [0, gate.prerollMs=${gate.prerollMs}] 内`
        + `（DEFAULT_ASR_PREROLL_MS / DEFAULT_GATE_PREROLL_MS）`,
      );
    }
  }
  if (gate.minSpeechMs !== undefined) {
    const minSpeechMs = gate.minSpeechMs;
    if (!(minSpeechMs >= 0) || !(minSpeechMs < gate.holdMs)) {
      rejectTiming(
        `最短有效人声 gate.minSpeechMs=${minSpeechMs} 必须在 [0, gate.holdMs=${gate.holdMs}) 内`
        + `（DEFAULT_MIN_SPEECH_MS / DEFAULT_GATE_HOLD_MS）`,
      );
    }
  }
  if (!(gate.pauseDetectMs >= 0)) {
    rejectTiming(`判停预跑 gate.pauseDetectMs=${gate.pauseDetectMs} 必须 >= 0（DEFAULT_PAUSE_DETECT_MS）`);
  }
  if (!(gate.speculateMs >= 0)) {
    rejectTiming(`投机窗 gate.speculateMs=${gate.speculateMs} 必须 >= 0（DEFAULT_SPECULATE_MS）`);
  }
  if (gate.pauseDetectMs > 0 && gate.speculateMs > 0 && gate.speculateMs > gate.pauseDetectMs) {
    rejectTiming(
      `投机窗 gate.speculateMs=${gate.speculateMs} 必须 <= 判停预跑 gate.pauseDetectMs=${gate.pauseDetectMs}`
      + `（DEFAULT_SPECULATE_MS / DEFAULT_PAUSE_DETECT_MS），否则判停预跑抢在投机前面起跑`,
    );
  }
  if (!(config.semanticBudgetMs > 0)) {
    rejectTiming(
      `语义预算 semanticBudgetMs=${config.semanticBudgetMs} 必须大于 0（SEMANTIC_END_TAG_BUDGET_MS）`,
    );
  }
  if (!(config.semanticTimeoutMs > 0)) {
    rejectTiming(
      `语义超时 semanticTimeoutMs=${config.semanticTimeoutMs} 必须大于 0（SEMANTIC_END_TAG_BUDGET_MS）`,
    );
  }
  if (!(config.confirmTimeoutMs > 0)) {
    rejectTiming(
      `确认超时 confirmTimeoutMs=${config.confirmTimeoutMs} 必须大于 0（MIAI_CONFIRM_TIMEOUT_MS）`,
    );
  }
  if (!(config.photoTimeoutMs > 0)) {
    rejectTiming(
      `拍照超时 photoTimeoutMs=${config.photoTimeoutMs} 必须大于 0（MIAI_PHOTO_TIMEOUT_MS）`,
    );
  }
  if (!(config.idleTimeoutMs > 0)) {
    rejectTiming(
      `空闲超时 idleTimeoutMs=${config.idleTimeoutMs} 必须大于 0（MIAI_IDLE_TIMEOUT_MS）`,
    );
  }
  if (!(config.playbackTailMs >= 0)) {
    rejectTiming(
      `播完余量 playbackTailMs=${config.playbackTailMs} 必须 >= 0（DEFAULT_PLAYBACK_TAIL_MS）`,
    );
  }

  if (config.manualEndpoint) {
    if (!(gate.commitMs >= 0)) {
      rejectTiming(`车道封段 gate.commitMs=${gate.commitMs} 必须 >= 0（VOICE_COMMIT_MS）`);
    }
    if (!(gate.sttCommitMs >= gate.commitMs)) {
      rejectTiming(
        `ASR 封段 gate.sttCommitMs=${gate.sttCommitMs} 必须 >= 车道起跑 gate.commitMs=${gate.commitMs}`
        + `（VOICE_STT_COMMIT_MS / VOICE_COMMIT_MS），否则 ASR 封段早于车道起跑`,
      );
    }
    const openQuietMs = gate.openQuietMs;
    if (openQuietMs === undefined || !(openQuietMs > 0)) {
      rejectTiming(
        `开轮静音 gate.openQuietMs=${String(openQuietMs)} 必须大于 0（VOICE_OPEN_QUIET_MS）`,
      );
    }
    const openQuietShortMs = gate.openQuietShortMs;
    if (openQuietShortMs === undefined || !(openQuietShortMs >= 0) || openQuietShortMs > openQuietMs) {
      rejectTiming(
        `开轮短静音 gate.openQuietShortMs=${String(openQuietShortMs)} 必须 >= 0 且 <= `
        + `gate.openQuietMs=${openQuietMs}（由 VOICE_OPEN_QUIET_MS 按 round(openQuiet*2/3) 派生）`,
      );
    }
    const maxOpenSilenceMs = gate.maxOpenSilenceMs;
    if (maxOpenSilenceMs !== undefined && maxOpenSilenceMs !== 0 && !(maxOpenSilenceMs >= openQuietMs)) {
      rejectTiming(
        `开轮静音上限 gate.maxOpenSilenceMs=${maxOpenSilenceMs} 必须为 0、缺省，或不小于 `
        + `gate.openQuietMs=${openQuietMs}（TURN_JUDGE_MAX_OPEN_SILENCE_MS / VOICE_OPEN_QUIET_MS）`,
      );
    }
    // 语义判停返回 `more` 且序列预算大于开轮静音上限时，`silenceCapFor(true)` 会把
    // 静音天花板抬到 `waitBudgetSequenceMs`。没开声学判停时这项是 0，不抬天花板。
    // 0 表示不设序列上限。
    const sequenceBudgetMs = config.turnJudge?.waitBudgetSequenceMs ?? 0;
    const ceiling = Math.max(
      gate.sttCommitMs,
      openQuietMs,
      maxOpenSilenceMs ?? 0,
      sequenceBudgetMs,
    );
    if (!(gate.holdMs > ceiling)) {
      rejectTiming(
        `能量门保持 gate.holdMs=${gate.holdMs} 必须大于封段/开轮静音/序列预算天花板 ${ceiling}`
        + `（max(gate.sttCommitMs=${gate.sttCommitMs}, gate.openQuietMs=${openQuietMs}, `
        + `gate.maxOpenSilenceMs=${maxOpenSilenceMs ?? 0}, `
        + `turnJudge.waitBudgetSequenceMs=${sequenceBudgetMs})；`
        + `DEFAULT_GATE_HOLD_MS / VOICE_STT_COMMIT_MS / VOICE_OPEN_QUIET_MS / `
        + `TURN_JUDGE_MAX_OPEN_SILENCE_MS / TURN_JUDGE_SEQUENCE_BUDGET_MS），`
        + `否则能量门在封段、开轮静音或序列续等到达前就已关闭`,
      );
    }
  }

  const turnJudge = config.turnJudge;
  if (turnJudge !== undefined) {
    if (!(turnJudge.extendMs > 0)) {
      rejectTiming(
        `判停延长 turnJudge.extendMs=${turnJudge.extendMs} 必须大于 0（TURN_JUDGE_EXTEND_MS）`,
      );
    }
    if (!(turnJudge.waitBudgetMs >= 0)
      || (turnJudge.waitBudgetMs !== 0 && turnJudge.waitBudgetMs < turnJudge.extendMs)) {
      rejectTiming(
        `判停等待预算 turnJudge.waitBudgetMs=${turnJudge.waitBudgetMs} 必须为 0 或不小于 `
        + `turnJudge.extendMs=${turnJudge.extendMs}（TURN_JUDGE_WAIT_BUDGET_MS / TURN_JUDGE_EXTEND_MS）`,
      );
    }
    if (!(turnJudge.waitBudgetSequenceMs >= 0)
      || (turnJudge.waitBudgetSequenceMs !== 0
        && turnJudge.waitBudgetSequenceMs < turnJudge.waitBudgetMs)) {
      rejectTiming(
        `序列预算 turnJudge.waitBudgetSequenceMs=${turnJudge.waitBudgetSequenceMs} 必须为 0 或不小于 `
        + `turnJudge.waitBudgetMs=${turnJudge.waitBudgetMs}`
        + `（TURN_JUDGE_SEQUENCE_BUDGET_MS / TURN_JUDGE_WAIT_BUDGET_MS）`,
      );
    }
    if (!(turnJudge.maxOpenSilenceMs >= 0)) {
      rejectTiming(
        `判停开轮静音上限 turnJudge.maxOpenSilenceMs=${turnJudge.maxOpenSilenceMs} 必须 >= 0`
        + `（TURN_JUDGE_MAX_OPEN_SILENCE_MS）`,
      );
    }
    // 服务端 VAD 等非手动端点没有上面的 gate 天花板。0 = 不设上限，不跟 holdMs 比。
    // 语义 `more` / 序列句续等会把静音等到序列预算，能量门必须盖过这段，不能先关门。
    if (turnJudge.maxOpenSilenceMs > 0 && !(gate.holdMs > turnJudge.maxOpenSilenceMs)) {
      rejectTiming(
        `能量门保持 gate.holdMs=${gate.holdMs} 必须大于判停开轮静音上限 `
        + `turnJudge.maxOpenSilenceMs=${turnJudge.maxOpenSilenceMs}`
        + `（DEFAULT_GATE_HOLD_MS / TURN_JUDGE_MAX_OPEN_SILENCE_MS），`
        + `否则能量门在开轮静音天花板到达前就已关闭`,
      );
    }
    if (turnJudge.waitBudgetSequenceMs > 0 && !(gate.holdMs > turnJudge.waitBudgetSequenceMs)) {
      rejectTiming(
        `能量门保持 gate.holdMs=${gate.holdMs} 必须大于序列预算 `
        + `turnJudge.waitBudgetSequenceMs=${turnJudge.waitBudgetSequenceMs}`
        + `（DEFAULT_GATE_HOLD_MS / TURN_JUDGE_SEQUENCE_BUDGET_MS）。`
        + `语义判停返回 more、序列句续等都会用到这份预算，能量门不能先关门`,
      );
    }
  }
}

export function buildVoiceRuntimeConfig(input: VoiceRuntimeInput): VoiceRuntimeConfig {
  const env = input.env;
  const sttSpec = input.sttSpec;
  const overrides = input.overrides ?? {};
  const envNumber = (name: string, fallback: number): number => envNumberFrom(env, name, fallback);
  const profile = DEVICE_TIMING_PROFILES[input.profile ?? 'glasses'];

  // 眼镜 mic 电平低，4× 时小声说话才能推开能量门。浏览器档案默认 1×，overrides 仍可再盖。
  const micGain = overrides.micGain ?? envNumber('MIAI_MIC_GAIN', envNumber('MIC_GAIN', profile.micGain));
  /**
   * 能量门限（按**放大后**算）。
   *
   * 实测（增益 4×、安静房间）：底噪峰值大约 −60…−51 dBFS，说话在 −20…0。
   * −40 仍然太低：擦着门的电视/远处人声会被 ASR 幻觉成「嗯。」「对。」。
   * 开成轮的段在 −16…−6 dBFS，没开轮的在 −51…−43，中间空着，所以眼镜默认 −30。
   * 浏览器 AGC 后默认 −34。这是电平判据，不是段长判据。
   */
  const peakDbfs = overrides.peakDbfs ?? envNumber('VOICE_PEAK_DBFS', profile.peakDbfs);

  // 服务端 VAD 拿走了封段权。客户端再 commit 会和它抢同一句话。
  const manualEndpoint = sttSpec === 'qwen-realtime' && env['QWEN_ASR_TURN_DETECTION'] !== 'vad';
  const commitConfigured = envNumber('VOICE_COMMIT_MS', sttSpec === 'qwen-realtime' ? 20 : 0);
  const sttCommitConfigured = overrides.sttCommitMs ?? envNumber('VOICE_STT_COMMIT_MS', profile.sttCommitMs);
  const openQuietMs = envNumber('VOICE_OPEN_QUIET_MS', 300);
  // 短门槛是长门槛的 2/3。300 → 200，并且天然 openQuietShortMs <= openQuietMs。
  const openQuietShortMs = Math.round((openQuietMs * 2) / 3);
  // 只读一次：gate 与 turnJudge 共用，手动端点在没开声学判停时也能拿到同一把尺子。
  const maxOpenSilenceMs = envNumber('TURN_JUDGE_MAX_OPEN_SILENCE_MS', 650);
  // Pure Live 没有级联中间结果，投机每帧空转。级联和缺省才用默认窗。
  const speculateMs = input.pipelineMode === 'live' ? 0 : DEFAULT_SPECULATE_MS;

  const gate: VoiceGateConfig = {
    thresholdDbfs: peakDbfs,
    holdMs: DEFAULT_GATE_HOLD_MS,
    prerollMs: DEFAULT_GATE_PREROLL_MS,
    minSpeechMs: DEFAULT_MIN_SPEECH_MS,
    asrPrerollMs: DEFAULT_ASR_PREROLL_MS,
    pauseDetectMs: DEFAULT_PAUSE_DETECT_MS,
    speculateMs,
    // `commitMs` 只让 omni 车道起跑；ASR 封段晚一拍，免得把书名切成两段。
    // 非 manual 时两项都是 0：NLS 自己判句，服务端 VAD 也自己判句。
    commitMs: manualEndpoint ? commitConfigured : 0,
    sttCommitMs: manualEndpoint ? sttCommitConfigured : 0,
    // 开轮门槛只对「端点由我们控」生效。定稿来得早，静音不够就再等。
    ...(manualEndpoint ? { openQuietMs, openQuietShortMs, maxOpenSilenceMs } : {}),
  };

  const turnJudge = input.turnJudgeEnabled
    ? {
      ...(input.turnJudgeModelPath === undefined ? {} : { modelPath: input.turnJudgeModelPath }),
      // 有了静音预跑判停，定稿到达时概率已经算好，这段静候是白等。
      quietMs: 0,
      // 真机上「再等」全部等到放行、没有人接着说。400 ms 没换到新信息。
      // 在函数调用时读：模块顶层早于 `loadDotEnv()`，`.env` 里的值会读不到。
      extendMs: envNumber('TURN_JUDGE_EXTEND_MS', 200),
      // 普通句上 `TURN_JUDGE_WAIT_BUDGET_MS`（200）=== `TURN_JUDGE_EXTEND_MS`（200）：
      // 一拍完整的声学延长就把普通预算吃完。`TURN_JUDGE_MAX_EXT=2` 仍留下，是为了
      // ① 第一拍静音闸门只等了 < 200 ms，预算还没满，才能再补一拍；
      // ② `unsure` 用满预算后，`semanticEndpoint` 明确回 `more`，走 `unsureAteBudget()` 再豁免一次；
      // ③ 序列句不走这 200，走下面的 `waitBudgetSequenceMs`（1200）。
      maxExtensions: envNumber('TURN_JUDGE_MAX_EXT', 2),
      // 「判停说没说完」不看文本，p 又是噪声。单独收到 1 拍，别的判据仍吃上面的额度。
      maxUnsureExtensions: envNumber('TURN_JUDGE_MAX_UNSURE', 1),
      // 快照尾部留静音会把语音从窗口末尾推开，p 被拉低。取小值只为方向正确。
      trailingTrimMs: DEFAULT_TRAILING_TRIM_MS,
      threshold: envNumber('TURN_JUDGE_THRESHOLD', 0.5),
      // 中文完整短句常给 0.22–0.41，没说完的在 0.11 以下。0.5 会把前者判成没说完。
      thresholdCjk: envNumber('TURN_JUDGE_THRESHOLD_CJK', 0.35),
      // ② 的总等待预算。0 = 不设。让定稿→开轮有一个可预测的天花板。
      // 默认与 `TURN_JUDGE_EXTEND_MS` 同为 200（见上面 `maxExtensions`）：
      // 一拍完整声学延长即耗尽普通预算。第二拍只出现在那三类场景里。
      waitBudgetMs: envNumber('TURN_JUDGE_WAIT_BUDGET_MS', 200),
      // 数字/字母/「然后」这类句尾，判「没说完」是对的，别让总预算把它掐掉。
      // 语义 `more` 且本值大于 maxOpenSilenceMs 时，静音天花板抬到这里，因此必须小于 holdMs。
      // 0 = 不设序列上限。
      waitBudgetSequenceMs: envNumber('TURN_JUDGE_SEQUENCE_BUDGET_MS', 1_200),
      maxOpenSilenceMs,
    }
    : undefined;

  // `semanticEnabled` 只决定调用方建不建客户端；预算本身三端必须是同一对数。
  // 超时与预算是同一次判定的两面，分开配只会让「等多久」和「放弃多早」各说各话。
  const semanticBudgetMs = envNumber('SEMANTIC_END_TAG_BUDGET_MS', 400);
  const semanticTimeoutMs = semanticBudgetMs;
  void input.semanticEnabled;

  // 要人动手的拍照只留一个兜底总时长。旧的两段别名不再相加。
  const confirmTimeoutMs = envNumber('MIAI_CONFIRM_TIMEOUT_MS', DEFAULT_CONFIRM_TIMEOUT_MS);

  const config: VoiceRuntimeConfig = {
    micGain,
    peakDbfs,
    gate,
    turnJudge,
    semanticBudgetMs,
    semanticTimeoutMs,
    confirmTimeoutMs,
    // 高清链路要等手机建 P2P + 设备写相册，20 s 不够（线上要 50 s+）。
    photoTimeoutMs: overrides.photoTimeoutMs ?? envNumber('MIAI_PHOTO_TIMEOUT_MS', 60_000),
    idleTimeoutMs: overrides.idleTimeoutMs ?? envNumber('MIAI_IDLE_TIMEOUT_MS', 45_000),
    archiveMaxMb: overrides.archiveMaxMb ?? envNumber('MIAI_ARCHIVE_MAX_MB', 80),
    archiveKeep: overrides.archiveKeep ?? envNumber('MIAI_ARCHIVE_KEEP', 20),
    playbackTailMs: DEFAULT_PLAYBACK_TAIL_MS,
    imageQuestion: DEFAULT_IMAGE_QUESTION,
    controlPort: overrides.controlPort ?? envNumber('PHOTO_CTL_PORT', profile.controlPort),
    manualEndpoint,
  };
  validateVoiceTiming(config);
  return config;
}
