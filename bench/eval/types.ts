/**
 * 离线准确率 + 性能护栏评测套件的共享类型。
 *
 * 清单（`manifest.json`）、合成脚本（`synth-corpus.ts`）、沙盒服务端（`server.ts`）、
 * 线协议跑手（`runner.ts`）与离线打分器（`score.ts`）共用同一份结构定义。
 */

export type EvalSuite = 'S1' | 'S2' | 'S3' | 'S4';

export type EvalGroup =
  | 'chitchat'
  | 'action_tool'
  | 'realtime_fact'
  | 'negative_trap'
  | 'asr_noun'
  | 'memory_static'
  | 'cross_lane'
  | 'report_followup'
  | 'verbatim'
  | 'eot_pause'
  | 'eot_complete';

export type ExpectDelegate = 'yes' | 'no' | 'silent_memory' | 'any';

export interface EvalCase {
  readonly id: string;
  readonly suite: EvalSuite;
  readonly group: EvalGroup;
  /** 完整朗读文本；有 `parts` 时为拼接后的完整参考文本 */
  readonly text: string;
  /** S4 合成停顿：分段合成后在段间插入精确毫秒底噪 */
  readonly parts?: readonly string[];
  /** 段间插入的底噪时长（ms），仅与 `parts` 同用 */
  readonly pauseMs?: number;
  readonly voice: 'female' | 'male';
  readonly expectDelegate: ExpectDelegate;
  /** 动作轮：检查是否出现「early_rule 派了后台、但 Omni 前台仍未调工具而长段瞎答」 */
  readonly checkDualAnswerConflict?: boolean;
  /** 边界陷阱：检查不该误触发 `memory_silent` 或误触发取消 */
  readonly forbidSilentMemory?: boolean;
  readonly forbidCancel?: boolean;
  /** S2 ASR：关键专名/数字必须全部命中 */
  readonly expectedTerms?: readonly string[];
  /** S3：回复/后台汇报中每个子数组至少命中一个同义写法 */
  readonly mustIncludeAny?: readonly (readonly string[])[];
  readonly mustNotInclude?: readonly string[];
  /** S3-M2：检查后台 `dsh` 收到的 `query + note` 是否带上前面几轮的指代词 */
  readonly expectDshContextTerms?: readonly string[];
  /** S3-M4：是否期望后台汇报走逐字朗读（`verbatim: true`） */
  readonly expectVerbatim?: boolean;
  /** S4：期望本条语料被切成几轮（停顿合并用例为 1） */
  readonly expectTurns?: number;
  /** S4 完整句：判停 `waitedMs` 不应超过这个值 */
  readonly maxExpectedWaitMs?: number;
  /** 记录型 stub `dsh` 返回的固定结论 */
  readonly stubReply?: string;
  readonly stubDelayMs?: number;
  /** 触发后台后等空窗播报的最长毫秒数（默认按 expectDelegate 推导） */
  readonly waitBgReportMs?: number;
  /** 故意不等空窗，直接紧接下一句以验证 `unspoken` 回注或 `defer` */
  readonly skipQuietWait?: boolean;
  readonly note?: string;
}

export interface EvalSessionSpec {
  readonly id: string;
  readonly suite: EvalSuite;
  readonly title: string;
  readonly cases: readonly EvalCase[];
}

export interface EvalManifest {
  readonly version: string;
  readonly corpusName: string;
  /** 写入隔离测试 `MEMORY.md` 的虚构长期记忆（确保预训练猜不到） */
  readonly memorySeed: readonly string[];
  readonly sessions: readonly EvalSessionSpec[];
}

export interface CorpusItemMeta {
  readonly id: string;
  readonly file: string;
  readonly voice: 'female' | 'male';
  readonly voiceName: string;
  readonly sampleRate: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly peakDbfs: number;
  readonly pauseMs: number | null;
  readonly sha256: string;
  readonly text: string;
}

export interface CorpusMeta {
  readonly version: string;
  readonly corpusName: string;
  readonly createdAt: string;
  readonly sampleRate: number;
  readonly voices: { readonly female: string; readonly male: string };
  readonly items: Record<string, CorpusItemMeta>;
}

/** 沙盒 `server.ts` 落盘的每一次 `dshAgent.reply(...)` 记录 */
export interface DshCallRecord {
  readonly seq: number;
  readonly ts: number;
  readonly userText: string;
  readonly note: string;
  readonly hasImage: boolean;
  readonly returnedSpeech: string;
  readonly matchedCaseId: string | null;
}

/** 沙盒 `server.ts` 落盘的每一次后台播报（Omni 空窗或 TTS fallback） */
export interface BgReportRecord {
  readonly ts: number;
  readonly kind: 'omni_attempt' | 'fallback_spoken';
  readonly taskId?: string;
  readonly query?: string;
  readonly speech: string;
  readonly verbatim?: boolean;
  readonly result?: 'spoken' | 'defer' | 'fallback';
  readonly spokenBytes?: number;
  readonly interrupted?: boolean;
  readonly transcript?: string;
}

/** 跑手 `runner.ts` 记录的单条用例客户端观测窗口 */
export interface CaseRunTrace {
  readonly caseId: string;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly audioDoneAtMs: number;
  readonly finishedAtMs: number;
  readonly sentBytes: number;
  readonly downlinkBytes: number;
  readonly downlinkFirstAtMs: number | null;
  readonly callsReceived: readonly string[];
  readonly controlsReceived: readonly string[];
}

export interface SessionRunTrace {
  readonly sessionId: string;
  readonly suite: EvalSuite;
  readonly archiveDir: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly cases: readonly CaseRunTrace[];
}

export interface EvalRunArtifact {
  readonly version: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly hourCst: number;
  readonly pipeline: 'live' | 'cascade';
  readonly backend: 'stub' | 'real-dsh';
  readonly corpusDir: string;
  readonly archiveRoot: string;
  readonly dshCallsFile: string;
  readonly bgReportsFile: string;
  readonly sessions: readonly SessionRunTrace[];
}
