/**
 * 静音驱动的四路提前触发 —— 从 `UtteranceAssembler` 里拆出来的那一段。
 *
 * <h2>为什么是四路，而不是一个「静音事件」</h2>
 *
 * 同一次静音要喂四个**期限差一个数量级**的消费者：
 *
 * | 路 | 默认门槛 | 干什么 | 早了/晚了的代价 |
 * |:--|--:|:--|:--|
 * | 投机 | 100 ms | 拿中间结果先问出去 | 早了作废，晚了白等 |
 * | 判停预跑 | 200 ms | 与 ASR 的静音窗并行算概率 | 要等够音频才敢判「说完了」 |
 * | 车道封段 | 20 ms | omni 的 `seal` | 封早了多一段碎片（并段照拼） |
 * | ASR 封段 | 150 ms | `stt.commit()` | 切早了把同一个字切成两半 |
 *
 * 所以四者各有自己的 `firedAt` 与前提，不是一个布尔「静音了没有」。
 *
 * <h2>「一段」的边界是 `lastVoicedAt`，不是布尔量</h2>
 *
 * 又来声音就自然重新武装：所有闸比较的都是**时刻**（`lastVoicedAt <= firedAt`
 * 说明这一段已经动过手），不是状态。静音期内反复进来只会触发一次。
 *
 * <h2>本模块不碰 I/O</h2>
 *
 * 不看时钟（`atMs` 由宿主用**声学前端那同一把尺**喂进来）、不持有文本（要文本
 * 时向宿主读）、不发请求（预跑交给宿主的 `startUpcomingPrediction`）。
 */

/** 还没见过 / 还没发生过。用 `-Infinity` 是为了让「比时刻」的比较天然成立 */
const NEVER = Number.NEGATIVE_INFINITY;

/** 本模块用到的那几个选项（`UtteranceAssemblerOptions` 结构上兼容它） */
export interface SilenceTriggerOptions {
  /** 静音满这么久就让**车道起跑**（omni 的 `seal`），不设 = 不触发 */
  readonly commitAfterMs?: number;
  /** 静音满这么久才请 ASR 封段解码，不设 = 不触发 */
  readonly sttCommitAfterMs?: number;
  /** 静音满这么久就把手上这版中间结果投机出去，不设 = 默认 100 ms，≤0 关闭 */
  readonly speculateMs?: number;
  /** 静音满这么久就把判停**提前**跑掉，不设 = 默认 200 ms，≤0 关闭 */
  readonly silencePauseMs?: number;
  /** 车道起跑：宿主拿去 `omni.seal` */
  readonly onCommit?: (silenceMs: number) => void;
  /** ASR 封段：宿主拿去 `stt.commit()` */
  readonly onSttCommit?: (silenceMs: number) => void;
  /** 投机：返回值 = 接收方**到底有没有真的发出去** */
  readonly onPartial?: (text: string) => boolean;
  readonly log: (line: string) => void;
}

/**
 * 组装器那一侧的事实与动作。
 *
 * 全是函数而不是值：读的时刻必须是**判定的那一刻**，不能在构造时快照下来
 * （`pendingText` / `lastPartialText` 每句都在改）。
 */
export interface SilenceTriggerHost {
  /** 这一轮累积的已定稿文本（投机时把最新 partial 接在它后面） */
  pendingText(): string;
  /** 上一次真正收下一轮的时刻 */
  lastUtteranceAt(): number;
  /** 最近一次 ASR 中间结果的时刻 / 文本（投机素材） */
  lastPartialAt(): number;
  lastPartialText(): string;
  /** 有判停器吗 —— 没有就没什么可预跑的 */
  hasPredictor(): boolean;
  /** 手上已经有一份在跑的判停吗（预跑每段只跑一次） */
  predictionPending(): boolean;
  /** 静音到点：为「下一句」预跑判停（`seq + 1` 由宿主负责） */
  startUpcomingPrediction(): void;
  /** 又来声音了（去抖后的真实语音帧）：作废在跑的预跑，并通知状态机迁入 speaking_more */
  onVoiced(atMs: number): void;
  /** 静音帧到达（携带距上次有声帧的连续静音时长）：供 speaking_more 在静音恢复后重新武装 */
  onSilence?(atMs: number, silenceMs: number): void;
}

export class SilenceTriggers {
  private readonly options: SilenceTriggerOptions;
  private readonly host: SilenceTriggerHost;
  /**
   * 最近一次「上行有声音」的时刻（毫秒，和声学前端同一把尺）。
   *
   * `-Infinity` = 这条连接还没见过音频（`barge-voicing.ts` 靠它判「无证据」）。
   */
  private lastVoicedAt = NEVER;
  /**
   * 连续有声帧计数（去抖）。
   *
   * 单帧不算数：这段录音里 20 ms 的「有声」有 14 处，多是塞音闭塞段或门限抖动。
   * 从第二帧起才更新 `lastVoicedAt`，之后每帧都推进 —— 它仍然等于真实停嘴时刻。
   */
  private voicedRun = 0;
  /** 这一段语音是否已经预跑过判停（每段只跑一次，别每块静音都跑） */
  private preFiredAt = NEVER;
  /**
   * 这一段语音是否已经请求过**车道起跑**（omni 的 `seal`，每段只一次）。
   *
   * 「一段」的边界是 `lastVoicedAt`：又来声音就自然重新武装（比较的是时刻，
   * 不是布尔），静音期内反复进 `noteFrame` 只封一次。
   */
  private sealFiredAt = NEVER;
  /** 这一段语音是否已经请 ASR 封段解码（和 `sealFiredAt` 分开，见 `sttCommitAfterMs`） */
  private sttCommitFiredAt = NEVER;
  /** 上一次问过、但接收方没发出去的那一版（同一版不重复问，免得每个静音帧刷一次） */
  private specTriedText = '';
  /** 上一次投机的时刻 / 这一句已经投机几次（一句最多 2 次） */
  private specFiredAt = NEVER;
  private specCount = 0;

  constructor(options: SilenceTriggerOptions, host: SilenceTriggerHost) {
    this.options = options;
    this.host = host;
  }

  /** 最近一帧被算作「有声」的时刻；给插话判据（`barge-voicing.ts`）用 */
  get lastVoicedAtMs(): number {
    return this.lastVoicedAt;
  }

  /**
   * 喂一帧。
   *
   * `voiced` 与 `atMs` 都来自声学前端（`AudioFrame`）：**不在这里按能量重算**，
   * 也不在这里读时钟 —— 那样「有没有人说话」和「静音多久」又会变成两套算法。
   */
  noteFrame(voiced: boolean, atMs: number): void {
    if (voiced) {
      // **去抖**：这段录音里 20 ms 的「有声」帧有 14 处，很多是塞音的闭塞段
      // 或门限抖动，不是真的重新开口。单帧就把 `lastVoicedAt` 推平会让
      // 「截至此刻的静音」被反复归零（开轮条件永远不成立），预跑也被无谓作废。
      // 所以第一帧只计数，从**第二帧**起才更新 —— 之后每帧都推进，`lastVoicedAt`
      // 仍然等于「真实停嘴」那一刻（不能停在首帧，否则一句话说两秒就被算成两秒静音）。
      this.voicedRun += 1;
      if (this.voicedRun < 2) {
        return;
      }
      this.lastVoicedAt = atMs;
      // 音频比快照长了：通知宿主作废在跑预跑、并在已有缓冲句时迁入 speaking_more
      this.host.onVoiced(atMs);
      return;
    }
    this.voicedRun = 0;
    // 两条线拆开跑，阈值不同：
    //   投机 100 ms —— 拿中间结果先问出去，等久了纯属白等
    //   判停 200 ms —— 判停器看的是音频，跟 ASR 的静音窗对齐
    this.maybeSpeculate(atMs);
    this.maybePrefirePrediction(atMs);
    this.maybeCommit(atMs);
    this.maybeSttCommit(atMs);
    if (this.lastVoicedAt !== NEVER) {
      this.host.onSilence?.(atMs, atMs - this.lastVoicedAt);
    }
  }

  /** 一句新定稿：投机的次数配额与去重按句重置（下一段语音可以再投机两次） */
  resetForSentence(): void {
    this.specCount = 0;
    this.specTriedText = '';
  }

  /**
   * 一轮被收下：四路闸重新武装。
   *
   * 武装的判据始终是 `lastVoicedAt > lastUtteranceAt`（见各 `maybe*`），这里清掉
   * 「这一段已经动过手」的记号，让下一段语音从零开始记账 —— 免得某一路的旧时刻
   * 恰好落进新一段的静音里，被当成「这次已经发过了」。
   */
  onUtterance(): void {
    this.preFiredAt = NEVER;
    this.sealFiredAt = NEVER;
    this.sttCommitFiredAt = NEVER;
    this.specFiredAt = NEVER;
    this.resetForSentence();
  }

  /** 两条封段闸共用的前提：这一段说过话、且还没为它动过手 */
  private canCommit(t: number, after: number | undefined, firedAt: number): boolean {
    if (after === undefined || after <= 0) {
      return false;
    }
    if (this.lastVoicedAt === NEVER || this.lastVoicedAt <= this.host.lastUtteranceAt()) {
      return false;
    }
    if (this.lastVoicedAt <= firedAt) {
      return false;
    }
    return t - this.lastVoicedAt >= after;
  }

  /**
   * 静音满 `commitAfterMs` 就让**车道起跑**（omni 的 `seal`）。
   *
   * 为什么不等判停：判停要 200 ms 静音才有把握，而封段只要「这句停下来了」——
   * 封早了顶多多一段碎片（并段逻辑照拼），封晚了整段延迟都是白等。
   *
   * 一段语音只封一次（`sealFiredAt`），长时间静音不会反复 commit。
   */
  private maybeCommit(t: number): void {
    if (this.options.onCommit === undefined) {
      return;
    }
    if (!this.canCommit(t, this.options.commitAfterMs, this.sealFiredAt)) {
      return;
    }
    this.sealFiredAt = t;
    // `after` 是**配置值**，实际静音是 `t - lastVoicedAt` —— 两者之差就是「静音开始
    // 到真有音频帧到达」的等待。日志和档案都要记实际值，否则永远看不见那截开销。
    const silenceMs = t - this.lastVoicedAt;
    this.options.log(
      `  封段    静音 ${this.options.commitAfterMs} ms（实际 ${silenceMs.toFixed(0)} ms）→ 车道起跑`,
    );
    this.options.onCommit(silenceMs);
  }

  /**
   * 静音满 `sttCommitAfterMs` 才请 ASR 封段解码（见 {@link SilenceTriggerOptions.sttCommitAfterMs}）。
   *
   * 为什么要晚于车道起跑：ASR 一收到 `commit` 就把这一段切走，切在 20 ms 静音上
   * 等于把「换气」当句尾。真机 `20261123-053719` 两轮都断在书名中间，第二个碎片
   * 被解成德语。判停本来要等 200–300 ms，所以晚到 150 ms **不花延迟**。
   */
  private maybeSttCommit(t: number): void {
    if (this.options.onSttCommit === undefined) {
      return;
    }
    if (!this.canCommit(t, this.options.sttCommitAfterMs, this.sttCommitFiredAt)) {
      return;
    }
    this.sttCommitFiredAt = t;
    const silenceMs = t - this.lastVoicedAt;
    this.options.log(
      `  封段    ASR 静音 ${this.options.sttCommitAfterMs} ms`
        + `（实际 ${silenceMs.toFixed(0)} ms）→ 开始解码`,
    );
    this.options.onSttCommit(silenceMs);
  }

  /**
   * 静音满 `speculateMs` 就把手上这版中间结果先问出去（投机）。
   *
   * 和判停预跑分开是因为**两者的等待理由完全不同**：判停要等够音频才敢判「说完了」，
   * 投机只是猜，猜早了作废就是，猜晚了一无所得。
   *
   * 防呆（每一条都对应一次真机踩坑）：
   * - **这一版 partial 必须属于本段语音**（`lastPartialAt > lastUtteranceAt`）。
   *   `lastPartialText` 不会跟着语音结束自动清空，上一段最后那版「嗯」能一直留到
   *   下一段开口 —— 拿它去投机就是拿别人那句话猜这一句。
   * - **接收方说发出去了才算一次**（`onPartial` 的返回值）。门槛（`specMinChars`、
   *   候选判据）都在接收方，这边记账早一步就会把机会记成「已用」。
   * - 发出去了就不再问（`lastVoicedAt <= specFiredAt`）：静音之后 ASR 还会补一两版
   *   partial，让它们重投机等于把已经跑掉的时间作废重来（实测认领时只跑了 6 ms）。
   * - 一句最多 2 次（`specCount`，`resetForSentence` 归零）—— 覆盖「说-停-说」的多段。
   */
  private maybeSpeculate(t: number): void {
    const onPartial = this.options.onPartial;
    if (onPartial === undefined) {
      return;
    }
    // `undefined` 用默认 100。显式 ≤0 是关闭：0 落进下面的 `< pause` 会立刻触发。
    const pause = this.options.speculateMs ?? 100;
    if (pause <= 0) {
      return;
    }
    if (this.lastVoicedAt === NEVER || this.lastVoicedAt <= this.host.lastUtteranceAt()) {
      return;
    }
    if (t - this.lastVoicedAt < pause) {
      return;
    }
    // 这段语音已经投机过了：后来补的 partial 不再顶掉在跑的那一趟
    if (this.lastVoicedAt <= this.specFiredAt) {
      return;
    }
    if (this.specCount >= 2) {
      return;
    }
    // 本段语音还没吐过字：`lastPartialText` 是上一段的残留，不能用
    if (this.host.lastPartialAt() <= this.host.lastUtteranceAt()) {
      return;
    }
    const latest = this.host.lastPartialText();
    if (latest === '') {
      return;
    }
    const text = this.host.pendingText() + latest;
    // 同一版 partial 问过一次就够了：静音帧是每 20 ms 一个，不去重会刷成一片
    if (text === this.specTriedText) {
      return;
    }
    if (!onPartial(text)) {
      this.specTriedText = text;
      return;
    }
    this.specTriedText = '';
    this.specFiredAt = t;
    this.specCount += 1;
    this.options.log(
      `  投机    静音 ${pause} ms → 交出中间结果（第 ${this.specCount}/2 次，判停还等 `
        + `${this.options.silencePauseMs ?? 200} ms）`,
    );
  }

  /** 静音满 `silencePauseMs` 就先把判停算掉，定稿时直接取用。 */
  private maybePrefirePrediction(t: number): void {
    if (!this.host.hasPredictor() || this.host.predictionPending()) {
      return;
    }
    // `undefined` 用默认 200。显式 ≤0 是关闭：0 落进下面的 `< pause` 会立刻预跑。
    const pause = this.options.silencePauseMs ?? 200;
    if (pause <= 0) {
      return;
    }
    // 只在「这一轮说过话、且还没为这段语音预跑过」时动手
    if (this.lastVoicedAt <= this.preFiredAt || this.lastVoicedAt <= this.host.lastUtteranceAt()) {
      return;
    }
    if (t - this.lastVoicedAt < pause) {
      return;
    }
    this.preFiredAt = t;
    this.options.log(`  判停    静音 ${pause} ms → 先跑一遍（不等 ASR 定稿）`);
    // 下一句定稿时会拿到 `seq + 1`，见 `UtteranceAssembler.addSentence`
    this.host.startUpcomingPrediction();
  }
}
