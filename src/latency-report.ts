/**
 * 把一份会话档案（`events.jsonl`）折算成**逐轮延迟分解**。
 *
 * <h2>为什么需要它</h2>
 *
 * 语音形态的硬指标只有一个：**用户说完 → 听到第一个字**。以前这个数字只散在
 * console 日志里（`TURN n=… dsh_ms=… tts_first_ms=…`），人肉对得上但**没法复算**，
 * 于是任何改动之后都无法回答「变快了还是变慢了」。
 *
 * 档案里的每条事件都带相对时间 `t`（ms），所以这件事是纯函数：喂一批事件，
 * 产出每一轮的分段耗时。不碰 socket、不读时钟、不落盘。
 *
 * <h2>分段口径</h2>
 *
 * ```text
 * gate.close ──①──▶ asr.sentence ──②──▶ turn.start ──③──▶ tts.first ──④──▶ turn.end
 * ```
 *
 * - ① 判停 + ASR 定稿一句
 * - ② 定稿 → 开跑一轮（同一进程内的排队）
 * - ③ agent + TTS 首块（**宠物形态里最大的一块**）
 * - ④ 首块出声 → 本轮结束（播放，不属于延迟）
 *
 * **首字总延迟 = ① + ② + ③**，也就是 ③ 结束时相对 ① 起点的距离。
 *
 * <h2>p50 / p90 指什么（项目级约定）</h2>
 *
 * **本项目说「p50 / p90」不加限定，一律指「闭嘴 → 出声」**，也就是这里的
 * `firstWordMs`。它是用户唯一感觉得到的那一段，其余都不许裸叫 p50：
 *
 * - 单段要说全名（「③ p50」「① p90」），或者干脆说「③ 该段中位」
 * - 模型层（`bench/fast_lane` 的「首字」）不是这个口径 —— 它少了 ASR、判停、
 *   TTS 三段，只能说「模型首字 p50」
 * - 换路径（真机 mSBC ↔ bench PCM16）也不可比，同一条路径的改前/改后才可比
 *
 * <h2>缺仪表怎么表示</h2>
 *
 * `tts.first` / `turn.end` 是后加的。更早的档案里没有它们，那些轮次对应字段为
 * `null`，报告里单独计数 —— **不拿 0 冒充缺失值**，否则历史基线会被伪造成「很快」。
 */

import { EVENTS } from './events.ts';

/** 档案里的一行事件；只声明报告用得到的字段，其余原样忽略。 */
export interface ArchiveEvent {  /** 相对会话开始的毫秒数 */
  readonly t: number;
  /** 事件名 */
  readonly ev: string;
  readonly text?: unknown;
  readonly ms?: unknown;
  readonly dsh_ms?: unknown;
  readonly audio_s?: unknown;
  readonly interrupted?: unknown;
  /** `gate.close` 专有：距最后一个有声块多久（ms）。有它才能还原「用户停嘴」的时刻 */
  readonly gapMs?: unknown;
  /**
   * `turn.end` 专有：这一轮走的哪条（`fast` / `dsh`）。
   *
   * 分路径看延迟必须有它 —— 快车道和 dsh 的 `firstWordMs` 是两个量，
   * 混在一起求 p50 得到的是两者混合分布，回答不了「快车道多快」。
   */
  readonly path?: unknown;
  /**
   * `turn.end` 专有：这一轮**实际念出去的**文本（已剥情绪标签）。
   *
   * 审计「抢话之后模型有没有接上」靠它：`path=dsh` 还能去 dsh 的 session log 翻
   * `assistant/message`，快车道（qwen-flash）**没有那份东西**。
   */
  readonly said?: unknown;
  /** `turn.end` 专有：这一轮事件循环被占住的最大时长（ms） */
  readonly loop_max_ms?: unknown;
  /** `tts.task` 专有：「建立」段（run-task → task-started，ms） */
  readonly setup_ms?: unknown;
  /** `tts.task` 专有：「供给」段（task-started → 首批文本送出，我们这侧的空档，ms） */
  readonly feed_ms?: unknown;
  /** `tts.task` 专有：「首包」段（首批文本送出 → 首块音频，ms） */
  readonly first_ms?: unknown;
  /**
   * `asr.sentence` 专有：产出这条定稿的 ASR commit 序号（出生证）。
   *
   * 有它才能把 `①b 封段→定稿` 精确配到**那一条** `asr.commit`；旧档案没有，
   * 只能退回「窗口里恰好一条 commit」的假设。
   */
  readonly commit_seq?: unknown;
  /** `asr.commit` 专有：这一发封段的序号（与 `asr.sentence.commit_seq` 配对） */
  readonly seq?: unknown;
  /** `judge.decide` 专有：这次决定的动作（`accept` / `extend` / `error`） */
  readonly action?: unknown;
  /** `judge.decide` 专有：截至这次决定，这一轮累计等了多少（ms） */
  readonly waitedMs?: unknown;
  /** `turn.report` 专有：模型首 token 延迟（ms）。`llm.first` 缺仪表时的退路 */
  readonly llm_first_ms?: unknown;
}

/** 一轮里可能缺席的时刻名。 */
export type MissingMark = typeof EVENTS.gateClose | typeof EVENTS.asrSentence | typeof EVENTS.ttsFirst | typeof EVENTS.turnEnd;

/** 一轮的分段耗时；`null` = 该段缺仪表。 */
export interface TurnLatency {
  /** 第几轮，从 1 开始，按 `turn.start` 出现顺序 */
  readonly turn: number;
  /** ① 静音判停 → ASR 定稿一句（ms）= `stopToCommitMs` + `commitToFinalMs` */
  readonly silenceToAsr: number | null;
  /**
   * **①a** 用户停嘴 → 封段（`asr.commit`，我们这侧决定「这句说完了」，ms）。
   *
   * 这一段由**上行包长**决定：门槛 `VOICE_COMMIT_MS` 比的是墙上时间、包内尾部静音
   * 不参与计时，所以真正的粒度是一整个上行包（75 ms 包实测中位 66，20 ms 包 20）。
   */
  readonly stopToCommitMs: number | null;
  /**
   * **①b** 封段 → 定稿（`asr.commit` → `asr.sentence`，ms）。
   *
   * 这是 ASR 那侧的时间。**回放里它会膨胀 2 倍以上**（回放 446 / 真机 222），
   * 且与同一轮 TTS 的 `setup_ms` 同向 —— 见 `docs/QOS.md` §2.5。
   */
  /** **①b** 封段 → 定稿（`asr.commit` → `asr.sentence`，ms）。
   *
   * 本句有多条 `asr.commit` 时为 `null`（说不清该从哪条算，见 `commitCount`）。
   */
  readonly commitToFinalMs: number | null;
  /** 本句窗口里有几条 `asr.commit`。>1 表示「封段之后又来了有声帧、又封了一次」*/
  readonly commitCount: number;
  /** ② ASR 定稿 → 开跑一轮（ms） */
  readonly asrToTurn: number | null;
  /** ③ 开跑 → 首块音频（agent + TTS 首块，ms） */
  readonly turnToAudio: number | null;
  /** **闭嘴 → 出声**：用户说完 → 第一个字出声（ms）。**本项目的 p50/p90 只指它** */
  readonly firstWordMs: number | null;
  /** ④ 首块音频 → 本轮结束（播放，ms） */
  readonly playbackMs: number | null;
  /** agent 自报耗时（ms） */
  readonly agentMs: number | null;
  /**
   * 这一轮里**事件循环被占住的最大时长**（ms，`turn.end.loop_max_ms`）。
   *
   * 用来判「TTS 变慢是别人慢还是我们自己卡了」：`loopMaxMs` 与 TTS 尖峰同步出现
   * → 是我们自己的进程被卡住，跟厂商无关（见 `docs/OPS-RECORD.md` §12.8.1）。
   */
  readonly loopMaxMs: number | null;
  /** TTS task 的「建立」段（run-task → task-started，ms） */
  readonly ttsSetupMs: number | null;
  /** TTS task 的「供给」段（task-started → 首批文本送出，我们这侧的空档，ms） */
  readonly ttsFeedMs: number | null;
  /** TTS task 的「首包」段（首批文本送出 → 首块音频，ms） */
  readonly ttsSynthMs: number | null;
  /** 是否被用户插话中断 */
  readonly interrupted: boolean;
  /** 这一轮对应的 ASR 文本（截断，便于人肉对上） */
  readonly text: string;
  /**
   * 这一轮谁答的：`fast` / `dsh` / `null`（旧档案没有 `path`）。
   *
   * **必须和延迟一起报**：两条车道的预算完全不同，混在一起的 p50 没有意义。
   */
  readonly path: string | null;
  /**
   * ② 是不是「等了一下」。
   *
   * 判停的实际分布是两头：七成接近 0，三成等 400–500。混在一起看，中位会掩盖
   * 那三成的成本 —— 所以分组表必须按这一列拆。门槛取 100 ms：低于它的差异
   * 落在测量噪声里，不值得当一档。
   */
  readonly waitedInJudge: boolean;
  /**
   * 台词的类别，用来回答「多出来的轮次是不是被切开的半句」。
   *
   * - `filler`：开头语（「你说」「你觉得」「我想问你」这类，字数少、判停容易判错）
   * - `noise`：疑似误识别（纯英文短词、单字）
   * - `normal`：其余
   *
   * 这是**启发式**，不是结论 —— 报告里出现可疑样本要回看录音确认。
   */
  readonly category: 'normal' | 'filler' | 'noise';
  /**
   * 模型首 token 延迟（ms）：本轮窗口内的 `llm.first.ms`；缺了退回
   * `turn.report.llm_first_ms`；再缺为 `null`（旧档案 / Omni 直出）。
   */
  readonly llmFirstMs: number | null;
  /**
   * 本轮判停真的等掉多少（ms）：窗口内 `judge.decide.waitedMs` 的**最大/末次**值。
   * 没有 `judge.decide`（旧档案）时为 `null`。
   */
  readonly judgeWaitedMs: number | null;
  /**
   * 这一轮是不是**坏样本**（`① < 0`，见 `computeTurns` 里的说明）。
   *
   * 它的 `firstWordMs` 已经被降成 `null`，所以不会污染中位；这一列只是让报告
   * 能写出「剔除了几轮」—— 悄悄变小分母和剔错了样本，都看不出来。
   */
  readonly badSample: boolean;
  /**
   * 这一轮缺哪些时刻。
   *
   * 必须逐个记：`firstWordMs` 为 `null` 可能是"旧档案没有 tts.first"，也可能是
   * "这一轮根本没有 gate.close"（主动播报、或用户中途插话），两者的处置完全不同。
   */
  readonly missing: readonly MissingMark[];
}

/** 报告里文本预览的最大字数。 */
const TEXT_PREVIEW = 40;

/**
 * ② 超过多久算「等了一下」。
 *
 * 取 100 ms：判停的实际分布是两头（七成接近 0、三成 400–500），100 落在两峰之间
 * 的空谷里，不会把测量噪声切成两档。
 */
const WAITED_THRESHOLD_MS = 100;

/**
 * 会诱导判停「再等一拍」的开头语。
 *
 * 这些词本身是完整的句子，但语义上像是还有后半句 —— 判停给的分往往不高，
 * 于是要么等到上限（白白多等），要么提前放行（被切成两轮）。两场实测里
 * 被切开的句子几乎都以此开头。
 */
const FILLER_HEADS = ['你说', '你觉得', '我想问你', '那个', '说真的', '我觉得吧', '对了', '我跟你说'];

/** 纯英文短词 / 单字：疑似 ASR 把噪声识别成了文字（`Yeah.` / `Thank you.` / `明。`）。 */
const NOISE_RE = /^[A-Za-z\s.?!,'"]{1,20}$|^[\u4e00-\u9fff]。?$/u;

/**
 * 给这一轮的台词分类。
 *
 * 用途是回答「多出来的轮次是不是被切开的半句」—— 按类别拆开看 p90 和轮次数，
 * 比看总体数字有用。这是**启发式**，报告里出现可疑样本要回看录音确认，别拿它当结论。
 */
function categorize(text: unknown): 'normal' | 'filler' | 'noise' {
  if (typeof text !== 'string' || text.trim() === '') {
    return 'normal';
  }
  const bare = text.trim();
  if (NOISE_RE.test(bare)) {
    return 'noise';
  }
  // 开头语只在「很短」时才算 —— 「你觉得哪首音乐好听？」是完整问句，不是半句
  if ([...bare].length <= 6 && FILLER_HEADS.some((head) => bare.startsWith(head))) {
    return 'filler';
  }
  return 'normal';
}

/** 取一个可能是任意 JSON 值的数字；不是有限数就给 `undefined`。 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 读 `loop_max_ms` / `setup_ms` / `first_ms` / `feed_ms`。
 *
 * 缺字段沿用 `previous`（一轮里上一条 task 可能写过）。
 * `< 0` 是「这段不存在」的哨兵（非流式 `feed_ms = -1`）：收成 `null`，
 * 既不能进分位数，也不能退回上一条 task 的正数冒充这一条。
 */
function durationMs(value: unknown, previous: number | null): number | null {
  const parsed = num(value);
  if (parsed === undefined) {
    return previous;
  }
  return parsed < 0 ? null : parsed;
}

/** 文本预览：超长的截断加省略号。 */
function preview(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    return '';
  }
  return value.length <= TEXT_PREVIEW ? value : `${value.slice(0, TEXT_PREVIEW)}…`;
}

/**
 * 解析 `events.jsonl` 的全文。
 *
 * 坏行直接跳过：一行坏数据不该让整份报告失效 —— 档案是"事后能查清"用的，
 * 而它自己坏掉的时候更要能读出来。
 *
 * @param jsonl - 文件全文，可含空行
 * @returns 事件数组，保持文件顺序
 */
export function parseEvents(jsonl: string): ArchiveEvent[] {
  const out: ArchiveEvent[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const t = num(obj['t']);
    const ev = obj['ev'];
    if (t === undefined || typeof ev !== 'string' || ev === '') {
      continue;
    }
    out.push({
      t,
      ev,
      text: obj['text'],
      ms: obj['ms'],
      dsh_ms: obj['dsh_ms'],
      audio_s: obj['audio_s'],
      interrupted: obj['interrupted'],
      gapMs: obj['gapMs'],
      path: obj['path'],
      said: obj['said'],
      loop_max_ms: obj['loop_max_ms'],
      setup_ms: obj['setup_ms'],
      feed_ms: obj['feed_ms'],
      first_ms: obj['first_ms'],
      commit_seq: obj['commit_seq'],
      seq: obj['seq'],
      action: obj['action'],
      waitedMs: obj['waitedMs'],
      llm_first_ms: obj['llm_first_ms'],
    });
  }
  return out;
}

/** 从 `from`（含）向前找第一个指定事件，找不到返回 -1。 */
function findBackward(events: readonly ArchiveEvent[], from: number, ev: string): number {
  for (let i = from; i >= 0; i -= 1) {
    if (events[i]?.ev === ev) {
      return i;
    }
  }
  return -1;
}

/** 从 `from`（含）向后找第一个指定事件，找不到返回 -1。 */
function findForward(events: readonly ArchiveEvent[], from: number, ev: string): number {
  for (let i = from; i < events.length; i += 1) {
    if (events[i]?.ev === ev) {
      return i;
    }
  }
  return -1;
}

/** 两个事件之间的时间差；任一缺失时给 `null`。 */
function delta(
  events: readonly ArchiveEvent[],
  laterAt: number,
  earlierAt: number,
): number | null {
  if (laterAt < 0 || earlierAt < 0) {
    return null;
  }
  const later = events[laterAt];
  const earlier = events[earlierAt];
  if (!later || !earlier) {
    return null;
  }
  return later.t - earlier.t;
}

/**
 * 「用户停嘴」的绝对时刻：`gate.close` 的 `t` 减去 `gapMs`。
 *
 * 能量门要等 `holdMs`（默认 2 s）才关门，所以 `t` 本身比真实停嘴晚一大截；
 * `gapMs` 就是那段等待。旧档案没有 `gapMs`，退回 `t`。
 */
function speechStopAt(events: readonly ArchiveEvent[], at: number): number | null {
  const ev = events[at];
  if (!ev) {
    return null;
  }
  const gap = num(ev.gapMs);
  return gap === undefined ? ev.t : ev.t - gap;
}

/**
 * 把事件序列折算成逐轮延迟。
 *
 * 配对规则（每条都限定了搜索边界，避免跨轮串味）：
 * - `asr.sentence` 只在本轮 `turn.start` **与上一轮 `turn.start` 之间**找
 * - `tts.first` / `turn.end` 只在本轮 `turn.start` **与下一轮 `turn.start` 之间**找
 * - `gate.close` 从本轮 `asr.sentence` **往后**找（它必然晚于 asr，见
 *   {@link speechStopAt}），且**一个只给一轮用**。找不到就记缺失 ——
 *   宁可少一个数，也不能拿上一轮的停嘴时刻冒充这一轮（会把静音等待算进延迟）。
 *
 * 主动播报（`announce`）没有 `asr.sentence`，所以它的 ①② 为 `null`；
 * 若它触发了 `turn.start`，仍会算进 ③④。
 *
 * @param events - 已解析的事件序列
 * @returns 每轮一段，按出现顺序
 */
export function computeTurns(events: readonly ArchiveEvent[]): TurnLatency[] {
  const starts: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.ev === EVENTS.turnStart) {
      starts.push(i);
    }
  }

  const out: TurnLatency[] = [];
  /** 已被某一轮用掉的 `gate.close` 下标：一个能量门只对应一次「用户停嘴」 */
  const usedGates = new Set<number>();
  for (let n = 0; n < starts.length; n += 1) {
    const at = starts[n];
    if (at === undefined) {
      continue;
    }
    const prevAt = n === 0 ? -1 : (starts[n - 1] ?? -1);
    const nextAt = starts[n + 1] ?? events.length;

    // ② 的中间点：本轮范围内的最后一个 asr.sentence
    // （先算它：① 要拿它当下界，见下面 gate.close 的搜索）
    let asrAt = -1;
    for (let i = at - 1; i > prevAt; i -= 1) {
      if (events[i]?.ev === EVENTS.asrSentence) {
        asrAt = i;
        break;
      }
    }

    // ① 的起点 = **用户停嘴**的时刻。
    //
    // 不能直接用 `gate.close` 的 `t`：能量门要 `holdMs`（默认 2 s）才关门，而 ASR
    // 静音只有 0.8 s，所以属于**这段语音**的 `gate.close` 必然晚于本轮的
    // `asr.sentence`（甚至晚于 `turn.start`）。
    //
    // 从 `asr.sentence` 往后找，找不到就记缺失。**绝不回退去抢上一轮的**：
    // 真机上出现过「上一轮说完、用户静音 6 s 才开口」，回退抓到的那个
    // `gate.close` 属于上一轮，于是 ① 被算成 7.6 s（真实约 1.3 s）。
    // 一个能量门只对应一次停嘴，所以 `usedGates` 保证不复用。
    let gateAt = -1;
    const gateFrom = asrAt >= 0 ? asrAt : at;
    for (let i = gateFrom; i < nextAt; i += 1) {
      if (events[i]?.ev === EVENTS.gateClose && !usedGates.has(i)) {
        gateAt = i;
        break;
      }
    }
    // 旧档案里 `gate.close` 也可能记在 `turn.start` 之前，此时才回退一次
    if (gateAt < 0) {
      for (let i = at - 1; i > prevAt; i -= 1) {
        if (events[i]?.ev === EVENTS.gateClose && !usedGates.has(i)) {
          gateAt = i;
          break;
        }
      }
    }
    if (gateAt >= 0) {
      usedGates.add(gateAt);
    }

    // ① 再拆一段：`asr.commit` = 我们这侧「这句说完了」的时刻（判停 → 要定稿）。
    //
    // 往前找、到上一条 `asr.sentence` 为止：`asr.commit` 必然在它自己的定稿之前，
    // 而上一句的 commit 在上一句的定稿之前，越过 `asr.sentence` 就会抢到别人的。
    // `commitAt` 取**最近的**一条 —— 它就是最可能触发这次定稿的那条。
    //
    // **可能找到不止一条**：`UtteranceAssembler.maybeCommit` 的守卫是「同一段语音只封
    // 一次」（`lastVoicedAt <= commitFiredAt` 就不封），所以**封段之后又有新的有声帧**
    // 就会再封一次。真机实测一句 2 条的比例：0/14（11:10）、2/18（03:15）、6/30（11:34）。
    // 这时 `①b` 该从哪条算**说不清**：
    // - 从最近一条算 → 43–261 ms（把二次封段前的等待抹掉了，明显偏小）
    // - 从最早一条算 → ①a 会变成 −800…−4980（那条 commit 属于更早的碎片）
    // 按 QOS 口径规则「缺数据记 null，不拿猜的冒充」→ 多条时 **①b 记 null**，只留条数。
    let commitCount = 0;
    let commitAt = -1;
    for (let i = asrAt - 1; i > prevAt; i -= 1) {
      const ev = events[i];
      if (ev === undefined) {
        continue;
      }
      if (ev.ev === EVENTS.asrSentence) {
        break;
      }
      if (ev.ev === EVENTS.asrCommit) {
        commitCount += 1;
        if (commitAt < 0) {
          commitAt = i;
        }
      }
    }

    // `asr.sentence` 的**出生证**：按序号精确配对产出它的那一条 `asr.commit`。
    // 老档案没有 `commit_seq`（`matchedCommitAt` 留 -1），下面退回原判据。
    const sentenceCommitSeq = asrAt < 0 ? undefined : num(events[asrAt]?.commit_seq);
    let matchedCommitAt = -1;
    if (sentenceCommitSeq !== undefined) {
      for (let i = asrAt - 1; i > prevAt; i -= 1) {
        const ev = events[i];
        if (ev?.ev === EVENTS.asrCommit && num(ev.seq) === sentenceCommitSeq) {
          matchedCommitAt = i;
          break;
        }
      }
    }

    // 判停的**实际动作**：`judge.decide` 落在本轮 `asr.sentence` 之后、开轮之前。
    // 有它就按 `action === 'extend'` 判「等没等」——`asrToTurn >= 100` 那个代理
    // 有 37% 误报、14% 漏报。没有它（旧档案 / 合成黄金测试）才退回代理判据。
    //
    // 上界按**时刻**比 `turn.start`：决定与开轮常常落在同一毫秒，按文件下标会
    // 把「同一毫秒但写在 turn.start 之后」的那条漏掉（归档顺序不保证）。
    const turnStartT = events[at]?.t ?? 0;
    let judgeCount = 0;
    let judgeExtended = false;
    let judgeWaited: number | null = null;
    for (let i = prevAt < 0 ? 0 : prevAt + 1; i < nextAt; i += 1) {
      const ev = events[i];
      if (ev?.ev !== EVENTS.judge || ev.t > turnStartT) {
        continue;
      }
      judgeCount += 1;
      if (ev.action === 'extend') {
        judgeExtended = true;
      }
      const waited = num(ev.waitedMs);
      if (waited !== undefined) {
        judgeWaited = judgeWaited === null ? waited : Math.max(judgeWaited, waited);
      }
    }

    // ③④ 的终点：本轮范围内
    let firstAt = -1;
    for (let i = at; i < nextAt; i += 1) {
      if (events[i]?.ev === EVENTS.ttsFirst) {
        firstAt = i;
        break;
      }
    }
    let endAt = -1;
    for (let i = at; i < nextAt; i += 1) {
      if (events[i]?.ev === EVENTS.turnEnd) {
        endAt = i;
        break;
      }
    }

    // ① 和「首字总延迟」都以**停嘴时刻**为起点（不是 gate.close 的记录时刻）
    const stopAt = speechStopAt(events, gateAt);
    const asrEv = asrAt < 0 ? undefined : events[asrAt];
    const firstEv = firstAt < 0 ? undefined : events[firstAt];
    const silenceToAsr = stopAt === null || asrEv === undefined ? null : asrEv.t - stopAt;
    // ① 的两段。缺 `asr.commit`（旧档案 / 主动播报）就都是 `null` —— 不拿 0 冒充。
    const commitEv = commitAt < 0 ? undefined : events[commitAt];
    const stopToCommitMs = stopAt === null || commitEv === undefined ? null : commitEv.t - stopAt;
    // ①b 的配对：
    // - `asr.sentence` 带 `commit_seq` 且窗口里找到同号 `asr.commit` → 精确算，
    //   即使 `commitCount > 1` 也不用丢成 null；
    // - 否则（老档案）保持原判据：多条 commit 说不清从哪条算（见上面的注释）。
    const matchedCommit = matchedCommitAt < 0 ? undefined : events[matchedCommitAt];
    const commitToFinalMs = matchedCommit !== undefined && asrEv !== undefined
      ? asrEv.t - matchedCommit.t
      : commitEv === undefined || asrEv === undefined || commitCount !== 1
        ? null
        : asrEv.t - commitEv.t;
    const asrToTurn = delta(events, at, asrAt);
    const turnToAudio = delta(events, firstAt, at);
    const playbackMs = delta(events, endAt, firstAt);
    // 首字延迟必须以「用户停嘴」为起点：缺任何一环都不猜
    const rawFirstWord = stopAt === null || firstEv === undefined ? null : firstEv.t - stopAt;
    /**
     * `① < 0` = `gate.close` 配到了**上一段语音**（能量门要 `holdMs` 才关，所以属于
     * 本段的门常常晚于 `asr.sentence`，配对时容易抓到上一轮的）。
     *
     * 这种样本不能进统计：它不是「延迟很小」，是**算错了**。按 `QOS.md` 口径规则 3
     * 「坏样本自动剔除，不靠人眼」—— 这里直接把它降成 `null`，让下游分组表自动
     * 把它从分母里摘掉，同时 `badSample` 留痕，报告能显示「有几轮被剔除」。
     *
     * 第二条判据：**① 不可能大于 `gapMs`。** ① = `gapMs` − (`gate.t` − `asr.t`)，
     * 而属于本句的门必然**晚于**定稿（门要 `holdMs` 才关，ASR 静音只要 0.8 s），
     * 所以 `gate.t ≥ asr.t` ⇒ ① ≤ `gapMs`。超过它只有一个解释：配对抓到了
     * **本句之前**的门（旧档案回退那条路）。
     *
     * 实测样本：回放 `20261121-101318` 轮 10，门比定稿早 658 ms → ① 算成 2658，
     * 而该轮 `gapMs` 只有 2000。这种样本此前被当成真值，把整份回放的 p50 从
     * 1189 抬到 1328。
     */
    const gateGap = gateAt < 0 ? null : (num(events[gateAt]?.gapMs) ?? null);
    const impossibleA1 = silenceToAsr !== null && gateGap !== null && silenceToAsr > gateGap;
    const badSample = (silenceToAsr !== null && silenceToAsr < 0) || impossibleA1;
    const firstWordMs = badSample ? null : rawFirstWord;

    const missing: MissingMark[] = [];
    if (gateAt < 0) {
      missing.push(EVENTS.gateClose);
    }
    if (asrAt < 0) {
      missing.push(EVENTS.asrSentence);
    }
    if (firstAt < 0) {
      missing.push(EVENTS.ttsFirst);
    }
    if (endAt < 0) {
      missing.push(EVENTS.turnEnd);
    }

    const end = endAt < 0 ? undefined : events[endAt];
    // TTS 那一段再拆成「建立」和「首包」：`tts.task` 是常开的（见 `cosyvoice.ts` 的 onTask）。
    // 一轮里可能有一条以上（回执 + 回答），**取本轮最后一条** —— 回答那条在最后。
    let ttsSetup: number | null = null;
    let ttsFeed: number | null = null;
    let ttsSynth: number | null = null;
    for (let i = at; i < nextAt; i += 1) {
      const ev = events[i];
      if (ev?.ev !== EVENTS.ttsTask) continue;
      ttsSetup = durationMs(ev.setup_ms, ttsSetup);
      ttsFeed = durationMs(ev.feed_ms, ttsFeed);
      ttsSynth = durationMs(ev.first_ms, ttsSynth);
    }

    // 模型首 token：优先 `llm.first`（引擎一拿到就发），缺了退回 `turn.report`
    // 里结算时锁存的那一份。两者都没有（Omni 直出 / 旧档案）记 `null`。
    let llmFirst: number | null = null;
    for (let i = at; i < nextAt; i += 1) {
      const ev = events[i];
      if (ev?.ev !== EVENTS.llmFirst) continue;
      const parsed = durationMs(ev.ms, null);
      if (parsed !== null) {
        llmFirst = parsed;
      }
    }
    if (llmFirst === null) {
      for (let i = at; i < nextAt; i += 1) {
        const ev = events[i];
        if (ev?.ev !== EVENTS.turnReport) continue;
        const parsed = durationMs(ev.llm_first_ms, null);
        if (parsed !== null) {
          llmFirst = parsed;
          break;
        }
      }
    }
    out.push({
      turn: n + 1,
      silenceToAsr,
      stopToCommitMs,
      commitToFinalMs,
      commitCount,
      asrToTurn,
      turnToAudio,
      firstWordMs,
      playbackMs,
      agentMs: num(end?.dsh_ms) ?? null,
      loopMaxMs: durationMs(end?.loop_max_ms, null),
      ttsSetupMs: ttsSetup,
      ttsFeedMs: ttsFeed,
      ttsSynthMs: ttsSynth,
      interrupted: end?.interrupted === true,
      text: preview(asrAt < 0 ? undefined : events[asrAt]?.text),
      path: typeof end?.path === 'string' ? end.path : null,
      // 有真实判停决定就按 `action` 判；没有才退回 `②` 这个代理（老档案 / 黄金测试）
      waitedInJudge: judgeCount > 0
        ? judgeExtended
        : asrToTurn !== null && asrToTurn >= WAITED_THRESHOLD_MS,
      judgeWaitedMs: judgeWaited,
      llmFirstMs: llmFirst,
      category: categorize(asrAt < 0 ? undefined : events[asrAt]?.text),
      badSample,
      missing,
    });
  }
  return out;
}

/**
 * 取分位数（线性插值，与 `numpy.percentile` 默认一致）。
 *
 * 不用最近秩法：偶数样本时它会取偏小的那个，**让延迟数字系统性偏乐观** ——
 * 一份"看起来很快"的基线比没有基线更糟。
 *
 * @param values - 样本；`null` 会被剔除
 * @param p - 0..1 之间的分位
 * @returns 分位值；样本为空时 `null`
 */
export function percentile(values: readonly (number | null)[], p: number): number | null {
  const kept = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (kept.length === 0) {
    return null;
  }
  const clamped = Math.min(1, Math.max(0, p));
  const pos = (kept.length - 1) * clamped;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lo = kept[lower];
  const hi = kept[upper];
  if (lo === undefined || hi === undefined) {
    return null;
  }
  return lower === upper ? lo : lo + (hi - lo) * (pos - lower);
}

/** 一组样本的「中位 / p90 / 最大」摘要。 */
export interface Sample {
  readonly count: number;
  readonly median: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}

/** 把一列（可能含 `null`）折成摘要。 */
export function summarize(values: readonly (number | null)[]): Sample {
  const kept = values.filter((v): v is number => v !== null);
  return {
    count: kept.length,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: kept.length === 0 ? null : Math.max(...kept),
  };
}

/** 首字延迟的判据（ms）：超过它，宠物就变成"语音问答机"。 */
export const FIRST_WORD_BUDGET_MS = 1200;

/** 慢轮次的门槛（ms）：超过它用户会明显觉得「卡了一下」。 */
export const SLOW_TURN_MS = 1500;

/** 一组轮次的汇总。 */
export interface GroupSummary {
  readonly label: string;
  /** 这一组里「三段齐全」的轮次数（其余不进中位，但计入 `total`） */
  readonly count: number;
  /** 组内轮次总数，含缺仪表、坏样本 */
  readonly total: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly max: number | null;
  /** 首声 > {@link SLOW_TURN_MS} 的轮次数与占比 */
  readonly slow: number;
  /** 因 `① < 0` 被剔除的坏样本数（见 `TurnLatency.badSample`） */
  readonly bad: number;
  /** 各段中位（**只作参考，不许相加**） */
  readonly seg1: number | null;
  readonly seg2: number | null;
  readonly seg3: number | null;
  /** ① 的两段中位：停嘴→封段、封段→定稿（缺 `asr.commit` 的档案为 `null`） */
  readonly seg1a: number | null;
  readonly seg1b: number | null;
}

/**
 * 按一个键把轮次分组并汇总。
 *
 * **这是标准报告的核心**：同一份档案按车道 / 按是否等待 / 按台词类别各拆一次，
 * 三张表放在一起，才知道 p50 是被谁决定的。混在一起看的 p50 会同时被
 * 「dsh 的 6 秒」和「切开的半句」平均掉。
 *
 * 缺 `firstWordMs` 或有 `missing` 的轮次**不进中位**，但仍计入 `total` ——
 * 「跑了 24 轮、只有 21 轮能算」这件事必须看得见，不能悄悄变小分母。
 */
export function groupBy(
  turns: readonly TurnLatency[],
  key: (turn: TurnLatency) => string,
  label = '',
): GroupSummary[] {
  const buckets = new Map<string, TurnLatency[]>();
  for (const turn of turns) {
    const k = key(turn);
    const list = buckets.get(k);
    if (list === undefined) {
      buckets.set(k, [turn]);
    } else {
      list.push(turn);
    }
  }
  const out: GroupSummary[] = [];
  for (const [name, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    /**
     * 只按「能不能算出首字」筛，**不按 `missing` 是否为空**。
     *
     * 变异测试发现的：原来写成 `firstWordMs !== null && missing.length === 0`，
     * 那会把「只缺 `turn.end`」的轮次也剔掉 —— 而 `turn.end` 只影响
     * 「有没有被打断」和「播了多久」，**不影响首字延迟**。剔掉它是白丢样本。
     */
    const usable = list.filter((t) => t.firstWordMs !== null);
    const sums = usable.map((t) => t.firstWordMs as number);
    const first = summarize(sums);
    out.push({
      label: label === '' ? name : `${label}=${name}`,
      count: first.count,
      total: list.length,
      p50: first.median,
      p90: first.p90,
      max: first.max,
      slow: sums.filter((v) => v > SLOW_TURN_MS).length,
      bad: list.filter((t) => t.badSample).length,
      seg1: summarize(usable.map((t) => t.silenceToAsr)).median,
      seg2: summarize(usable.map((t) => t.asrToTurn)).median,
      seg3: summarize(usable.map((t) => t.turnToAudio)).median,
      seg1a: summarize(usable.map((t) => t.stopToCommitMs)).median,
      seg1b: summarize(usable.map((t) => t.commitToFinalMs)).median,
    });
  }
  return out;
}

/** 把分组汇总排成一张固定的表。**三种分组共用这一个排版**，所以前后可比。 */
export function formatGroups(title: string, groups: readonly GroupSummary[]): string {
  if (groups.length === 0) {
    return `### ${title}\n\n（没有样本）`;
  }
  const lines = [
    `### ${title}`,
    '',
    '| 分组 | 可算 / 总轮 | p50 | p90 | 最大 | 慢轮(>1500) | ① | ①a 停嘴→封段 | ①b 封段→定稿 | ② | ③ |',
    '|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|',
  ];
  for (const g of groups) {
    const ratio = g.bad === 0 ? `${g.count}/${g.total}` : `${g.count}/${g.total}（坏样本 ${g.bad}）`;
    const slow = `${g.slow}${g.count === 0 ? '' : ` (${Math.round((g.slow / g.count) * 100)}%)`}`;
    lines.push(
      `| ${g.label} | ${ratio} | ${cell(g.p50)} | ${cell(g.p90)} | ${cell(g.max)} | ${slow} `
      + `| ${cell(g.seg1)} | ${cell(g.seg1a)} | ${cell(g.seg1b)} | ${cell(g.seg2)} | ${cell(g.seg3)} |`,
    );
  }
  lines.push('');
  lines.push('> ① ② ③ 是**各段自己的中位**，只用来对份额，**不许相加**（相加 ≠ p50）。');
  lines.push('> ①a / ①b 是 ① 的两段：① = ①a + ①b（逐轮成立，中位不成立）。');
  lines.push('> ①a 的粒度是**上行包长**，①b 是 ASR 那侧的时间；回放里 ①b 会膨胀（见 `QOS.md` §2.5）。');
  return lines.join('\n');
}

/** 标准报告：按车道 / 按是否等待 / 按台词类别 三张表 + 多余轮次。 */
export function formatStandard(turns: readonly TurnLatency[]): string {
  const byLane = groupBy(turns, (t) => t.path ?? '未知（无 path）');
  const byWait = groupBy(turns, (t) => (t.waitedInJudge ? '等了' : '没等'), '判停');
  const byText = groupBy(turns, (t) => t.category, '台词');

  const noise = turns.filter((t) => t.category === 'noise');
  const filler = turns.filter((t) => t.category === 'filler');
  const extra = [
    '### 多余轮次的嫌疑',
    '',
    `- 疑似误识别（纯英文 / 单字）**${noise.length} / ${turns.length}** 轮：`
      + (noise.length === 0 ? '（无）' : noise.map((t) => `轮${t.turn}「${t.text}」`).join('、')),
    `- 开头语（可能被切开的半句）**${filler.length} / ${turns.length}** 轮：`
      + (filler.length === 0 ? '（无）' : filler.map((t) => `轮${t.turn}「${t.text}」`).join('、')),
    '',
    '> 这两类是**启发式**。要确认「半句是不是被当整句回答」，得回看那一轮的',
    '> 前后两轮定稿：后半句是否单独成轮、前半句有没有出声。',
  ].join('\n');

  return [
    formatGroups('按车道', byLane),
    formatGroups('按判停是否等待', byWait),
    formatGroups('按台词类别', byText),
    extra,
    formatCommitCount(turns),
  ].join('\n\n');
}

/**
 * 一句被我们**封了不止一次段**的轮次有多少。
 *
 * `UtteranceAssembler.maybeCommit` 只在「封段之后又来了有声帧」时才二次封段，所以这
 * 不是 bug，是「说完了 → 又出了点声」。它的问题是**①b 该从哪条 commit 算说不清**，
 * 所以那些轮的 ①b 记 `null`（见 `computeTurns`）。这一行让它保持在视野里。
 */
function formatCommitCount(turns: readonly TurnLatency[]): string {
  const multi = turns.filter((t) => t.commitCount > 1);
  const none = turns.filter((t) => t.commitCount === 0);
  return [
    '### 封段次数',
    '',
    `- 一句封了 2 次及以上 **${multi.length} / ${turns.length}** 轮：`
      + (multi.length === 0 ? '（无）' : multi.map((t) => `轮${t.turn}(${t.commitCount})`).join('、')),
    `- 完全没有 \`asr.commit\` **${none.length} / ${turns.length}** 轮`
      + '（旧档案，或这轮不是由我们控时封的）',
    '',
    '> 多条 commit 的轮次 **①b 记 `null`** —— 从最近一条算会偏小（43–261 ms），',
    '> 从最早一条算 ①a 会变成负数（那条 commit 属于更早的碎片），两头的数都不可信。',
  ].join('\n');
}

/** 把一个数字列成表格单元；`null` 显示为 `-`。 */
function cell(value: number | null, unit = ''): string {
  return value === null ? '-' : `${Math.round(value)}${unit}`;
}

/**
 * 排版成人能读的报告。
 *
 * @param turns - {@link computeTurns} 的输出
 * @param header - 报告抬头（通常是档案目录名）
 * @returns 多行文本；末尾不带换行
 */
export function formatReport(turns: readonly TurnLatency[], header = ''): string {
  const lines: string[] = [];
  if (header !== '') {
    lines.push(`# ${header}`);
    lines.push('');
  }
  if (turns.length === 0) {
    lines.push('没有找到任何 turn.start —— 这份档案里没有可算的轮次。');
    return lines.join('\n');
  }

  lines.push('轮次  ①判停+ASR  ②排队  ③agent+TTS  闭嘴→出声  ④播放  agent自报  打断  文本');
  for (const t of turns) {
    lines.push(
      [
        String(t.turn).padEnd(4),
        cell(t.silenceToAsr).padEnd(10),
        cell(t.asrToTurn).padEnd(6),
        cell(t.turnToAudio).padEnd(11),
        cell(t.firstWordMs).padEnd(11),
        cell(t.playbackMs).padEnd(7),
        cell(t.agentMs).padEnd(9),
        (t.interrupted ? 'yes' : '').padEnd(4),
        t.text,
      ].join(' '),
    );
  }

  const first = summarize(turns.map((t) => t.firstWordMs));
  const parts = summarize(turns.map((t) => t.turnToAudio));

  lines.push('');
  lines.push('单位：毫秒。首字总延迟 = ① + ② + ③ = 闭嘴→出声（本项目的 p50/p90 只指它）');
  lines.push(
    `闭嘴→出声  p50 ${cell(first.median)} / p90 ${cell(first.p90)} / 最大 ${cell(first.max)}`
    + `（预算 ${FIRST_WORD_BUDGET_MS}）`,
  );
  lines.push(
    `其中③（开轮→首块）该段 中位 ${cell(parts.median)} / p90 ${cell(parts.p90)} / 最大 ${cell(parts.max)}`
    + '  ← 单段，不是项目 p50',
  );

  // TTS 那一段拆三截：三截慢起来长得一模一样，治法完全不同
  // （`建立` = 还没轮到我们/进程被卡；`供给` = 我们自己没供上字；`首包` = 服务端合成）。
  const setup = summarize(turns.map((t) => t.ttsSetupMs));
  const feed = summarize(turns.map((t) => t.ttsFeedMs));
  const synth = summarize(turns.map((t) => t.ttsSynthMs));
  const lag = summarize(turns.map((t) => t.loopMaxMs));
  if (setup.count > 0 || synth.count > 0) {
    lines.push(
      `TTS task  建立 中位 ${cell(setup.median)} / p90 ${cell(setup.p90)}`
      + `    供给 中位 ${cell(feed.median)} / p90 ${cell(feed.p90)}`
      + `    首包 中位 ${cell(synth.median)} / p90 ${cell(synth.p90)}`
      + `（n=${Math.max(setup.count, synth.count)}）`,
    );
  } else {
    lines.push('TTS task  缺仪表（档案里没有 tts.task —— 多半是这一版之前录的）');
  }
  if (lag.count > 0) {
    lines.push(
      `事件循环  本轮最大停顿 中位 ${cell(lag.median)} / p90 ${cell(lag.p90)} / 最大 ${cell(lag.max)}`
      + '  ← 它跟着 TTS 尖峰一起大，就是**我们自己被卡住**，不是厂商慢',
    );
  }

  const gaps = new Map<MissingMark, number>();
  for (const t of turns) {
    for (const m of t.missing) {
      gaps.set(m, (gaps.get(m) ?? 0) + 1);
    }
  }
  if (gaps.size > 0) {
    lines.push(
      `⚠ 缺失时刻：${[...gaps].map(([m, n]) => `${m}×${n}`).join('、')}`
      + `（共 ${turns.length} 轮；缺 tts.first 多半是旧档案，`
      + `缺 gate.close 多半是主动播报或这一轮没有静音判停）`,
    );
  }
  if (first.p90 !== null) {
    lines.push(
      first.p90 <= FIRST_WORD_BUDGET_MS
        ? `判定：闭嘴→出声 p90 ${Math.round(first.p90)} ms 在预算内，形态成立。`
        : `判定：闭嘴→出声 p90 ${Math.round(first.p90)} ms 超预算，宠物会显得"迟钝"——先治 ③，别做插件。`,
    );
  }
  // ① 为负 = ASR 定稿早于能量门关门。正常情况下不可能（门要等 holdMs 才关），
  // 说明这份档案是**旧格式**、`gate.close` 没带 `gapMs`，起点实际偏晚一大截，
  // 于是首字延迟被低估。这种数字不能当真，必须说出来。
  const unreliable = turns.filter((t) => t.silenceToAsr !== null && t.silenceToAsr < 0).length;
  if (unreliable > 0) {
    lines.push(
      `⚠ 起点不可靠：${unreliable}/${turns.length} 轮的 ① 为负 —— 这份档案的 `
      + '`gate.close` 没有 `gapMs`（旧格式），停嘴时刻只能取记录时刻（比真实停嘴晚'
      + ` holdMs），**首字延迟被低估**。重录一次即得准数，新档案带 \`gapMs\`。`,
    );
  }
  return lines.join('\n');
}
