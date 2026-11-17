/**
 * 句子 → 一轮话语（utterance）的合并与判停。
 *
 * <h2>职责</h2>
 *
 * ASR 的 `SentenceEnd` 是**句子**边界，不是**轮次**边界：
 * 「小爱同学。」和「我眼前的是什么？」会各发一次，照单全收就是两轮问答
 * （白烧一次 agent 调用）。本模块负责把若干句子合并成一轮，并决定
 * 「这一轮是不是真的说完了」。
 *
 * <h2>判停策略</h2>
 *
 * **不用**「问号结尾就直接收下」。ASR 的 `？` 是按语调加的，不代表语义完整 ——
 * 实测它把「你在运行什么？」（句中停顿）判成句尾，一句话被拆成三轮
 * （「你在运行什么？」→「平台上。」）。
 *
 * 所以一律先等 {@link UtteranceAssemblerOptions.quietMs}，再交给
 * {@link UtteranceAssemblerOptions.predict}（Smart Turn）看**音频本身**。
 * 它说没说完就再等一段，最多 {@link UtteranceAssemblerOptions.maxExtensions} 次，
 * 之后强制收下，避免模型不确定时永远不定稿。
 *
 * <h2>与静候窗重叠</h2>
 *
 * 判停器的往返实测约 70 ms，全部压在这一轮的「用户说完 → 开一轮」里。设
 * {@link UtteranceAssemblerOptions.predictAtMs} 可以让它**提前出发**，与静候窗
 * 重叠：窗口关掉时概率已经在手上。代价是模型少看几十毫秒的句尾静音（那是它判断
 * 「说完了」的主要证据），所以提前量有个上限，不是越早越好。
 *
 * 提前算的那份结果带两个有效性条件，缺一不可：
 * - **同一句**（`seq` 没变）—— 用户接着说，上一句的判定不能拿来定稿；
 * - **算完之后没有再收到中间结果** —— 那份音频里没有他后半句。
 * 任一不成立就现算一次（等于回到旧行为），不猜。
 *
 * 本模块**不做 I/O**：判停器、日志、时钟全部注入。
 */
import { pcm16DurationMs, pcm16PeakDbfs } from './pcm.ts';

export interface UtteranceAssemblerOptions {
  /** 句子结束后先静候这么久再判定 */
  readonly quietMs: number;
  /** 判为「没说完」时再多等这么久 */
  readonly extendMs: number;
  /** 最多延长几次 */
  readonly maxExtensions: number;
  /** 没有判停器时的固定合并窗口（旧行为） */
  readonly fallbackWindowMs: number;
  /** 概率门限 */
  readonly threshold: number;
  /** 送给判停器的最近音频上限（字节） */
  readonly recentMaxBytes: number;
  /** 判停器。返回 <0 表示不可用 */
  readonly predict?: (pcm: Buffer) => Promise<number>;
  /**
   * 提前发起判停请求的时刻（相对句子到达，毫秒）。
   *
   * 不设 = 到 `quietMs` 到点才发（旧行为）。设了就与静候窗**重叠**：窗口关掉时
   * 概率已经在手上，判停器那一趟往返（实测约 70 ms）不再落在关键路径上。
   * 中位 `asrToTurn` 从 224 ms 降到静候窗本身（150 ms）。
   *
   * 为什么不设 0：判停器的输入是「**到此刻为止**的音频」，提前多少毫秒，模型就
   * 少看多少毫秒的句尾静音（静音是「说完了」的主要证据）。65 ms 是「推理跑得完」
   * 与「别把静音砍太多」的折中，见 `voice-session.ts` 里的常量。
   */
  readonly predictAtMs?: number;
  /**
   * 「太短」的门槛（去标点后的字数）。默认 3。
   *
   * 见 {@link UtteranceAssembler} 里 `shouldWaitForMore` 的说明。
   */
  readonly shortFragmentChars?: number;
  /**
   * 结尾「像没说完」时再多等一拍多久。默认 0（关闭）。
   *
   * 动机：`max_sentence_silence` 从 400 压到 200 之后，说话人**数字组之间的换气**
   * 也会被当成句尾 —— 实测「#W8665881」被切成「订单号是井号W866。」+「5881。」，
   * 后半截单独成轮，模型只好瞎猜。句子本身没变短，只是断在了数字中间。
   *
   * 所以判据不是「短」，而是「结尾必须还有下文」：数字、井号、序数词、连词、
   * 单个字母。见 {@link looksUnfinished}。
   *
   * 只影响这一类结尾的句子，**每句最多多等一次** —— 不许无限拖。
   */
  readonly unfinishedWaitMs?: number;
  /** 上一轮收下之后多久内出现的短碎片算「同一句话被切开」。默认 1200 ms */
  readonly shortFragmentWindowMs?: number;
  /**
   * 碎片最多再等多久。默认 400 ms。
   *
   * 不能直接用 {@link extendMs}：生产上那是 700 ms，而「碎片」
   * 多半只是用户正常的一句短回答（「好。」「行。」），每句多等 700 ms
   * 是把判停的收益赔进去。ASR 断句间隔通常远小于 400 ms，够用了。
   */
  readonly shortFragmentWaitMs?: number;
  /**
   * ASR 中间结果刚到多久之内，音频判停「说完了」也不算数。默认 400 ms。
   *
   * 音频判据（Smart Turn）只看波形：句子之间那点停顿，它分不清是「说完了」
   * 还是「换气」。而 ASR 的中间结果是**用户还在出字**的直接证据 ——
   * 定稿之后 partial 还在增长，说明下一句已经在路上，这时候收下就是抢话。
   *
   * 设 0 关闭这条判据（只信音频，回到旧行为）。
   */
  readonly partialGraceMs?: number;
  /**
   * 本地静音判据：上行峰值低于这个 dBFS 就算「没在说话」。不设就不启用预判停。
   *
   * 传**能量门那个门槛**（同一路放大后的波形、同一套设备标定），别另设一个。
   */
  readonly silenceDb?: number;
  /**
   * 静音持续多久就把判停请求**提前**发出去（默认 200 ms）。
   *
   * 动机：ASR 要靠 200 ms 静音才发 `SentenceEnd`，而那 200 ms 里音频已经全在手里了 ——
   * 判停器完全可以这时候就跑。等 `SentenceEnd` 到了，概率早算好了，`出句→开轮`
   * 那 118 ms 直接归零。见 {@link UtteranceAssembler.addAudio}。
   */
  readonly silencePauseMs?: number;
  /**
   * 一句定稿（文本已定、还没判定停）时通知一次。   *
   * 判停器随后只决定「要不要并下一段」，**不影响这段文本** —— 所以快车道可以
   * 先在这上面起跑，省掉判停那 140 ms 纯等待；真并了下一段就换一句重问。
   * 只在**文本允许**的前提下才起跑，判据在接收方（`FrontedAgent.prefetch`）。
   */
  readonly onSentence?: (text: string) => void;
  /** 一轮定稿 */
  readonly onUtterance: (text: string) => void;
  readonly log: (line: string) => void;
  /** 可注入时钟，测试用 */
  readonly now?: () => number;
}

/** 判定一次的结果，便于日志与测试断言 */
export type EndpointDecision = 'accept' | 'extend' | 'predictor-unavailable';

/**
 * 结尾「必须还有下文」的记号。纯机械，不做语义推断
 * （和 `backchannel.ts`、`shouldWaitForMore` 同一条原则）。
 *
 * 只收「单独出现在句尾就不成立」的记号：
 * - 数字 / 中文数字：`#W866`、`第`
 * - 字母：`井号W`（订单号、型号被拦腰截断）
 * - 连词与引子：`和` `就是` `因为` `的话`…
 *
 * **宁漏不误**：误判的代价是这一轮白等 {@link UtteranceAssemblerOptions.unfinishedWaitMs}，
 * 漏判只是维持现状。
 */
const UNFINISHED_TAIL =
  /(?:[0-9０-９]|[零一二三四五六七八九十百千万亿两]|[A-Za-z#＃]|井号|第|和|跟|与|及|还有|就是|因为|所以|但是|然后|如果|的话|或者|还是)$/u;

/** 尾部标点 —— ASR 每个 `SentenceEnd` 都会补一个，作为句界记号而不是内容 */
const TRAILING_PUNCT = /[\s。．.，,、!！?？~～…\-—:：;；"'“”‘’]+$/u;

/** 丢掉尾部标点，只看最后那个字 */
function stripTail(text: string): string {
  return text.replace(TRAILING_PUNCT, '');
}

/** 结尾看起来「还有下文」吗 —— 见 {@link UNFINISHED_TAIL} */
export function looksUnfinished(text: string): boolean {
  const core = stripTail(text);
  return core.length > 0 && UNFINISHED_TAIL.test(core);
}

export class UtteranceAssembler {
  private readonly options: UtteranceAssemblerOptions;
  private readonly now: () => number;
  private readonly recentChunks: Buffer[] = [];
  private recentBytes = 0;
  private pendingText = '';
  private pendingTimer: NodeJS.Timeout | null = null;
  /**
   * 当前这一句的代号。`addSentence` / `flush` / `dispose` 都 +1。
   *
   * 在飞的判停与排队中的 `evaluate` 都拿着它出生的那个号：用户又说了新的一句，
   * 旧号的判定就不能再用来定稿 —— 否则「上一句的概率」会把「这一句」提前收下，
   * 合并窗口就失效了。
   */
  private seq = 0;
  /**
   * 提前发起的判停。只对同一个 `seq` 有效。
   *
   * `startedAt` 是**取音频快照**的时刻：之后又收到中间结果说明用户还在说，
   * 那份音频里没有他后半句，结果作废（见 {@link takeProbability}）。
   */
  private prediction: {
    readonly seq: number;
    readonly startedAt: number;
    /**
     * 这一份是「静音一到就提前跑」的（见 `trackSilence`），不是给已经定稿的句子算的。
     *
     * 预跑的**新鲜度**由音频保证：之后只要又来声音，`trackSilence` 就把这份清掉。
     * 所以它不受 `startedAt >= lastPartialAt` 那条约束 —— ASR 的中间结果本来就比
     * 真实停嘴晚（实测晚 98–140 ms），拿它当「用户还在说」的证据会把预跑全废掉。
     */
    readonly pre: boolean;
    readonly probability: Promise<number>;
  } | null = null;
  /** `predictAtMs` 的定时器 */
  private predictTimer: NodeJS.Timeout | null = null;
  private extensions = 0;
  /** 这一句是否已经为「结尾像没说完」等过一拍（只等一次） */
  private unfinishedWaited = false;
  /** 上一次真正收下一轮的时刻，用来判断「短碎片是不是紧跟其后」 */
  private lastUtteranceAt = Number.NEGATIVE_INFINITY;
  /** 最近一次 ASR 中间结果的时刻：用户还在出字的直接证据 */
  private lastPartialAt = Number.NEGATIVE_INFINITY;
  /** 最近一次「上行有声音」的时刻（本地静音检测，见 `silenceDb`） */
  private lastVoicedAt = Number.NEGATIVE_INFINITY;
  /** 这一段语音是否已经预跑过判停（每段只跑一次，别每块静音都跑） */
  private preFiredAt = Number.NEGATIVE_INFINITY;
  /** 本次判停用的是不是预跑那份（是就不必再执行「刚收到中间结果」那条宽限） */
  private usedPrefired = false;
  private disposed = false;

  constructor(options: UtteranceAssemblerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get pending(): string {
    return this.pendingText;
  }

  /** 每块上行 PCM 都要喂进来，判停器需要「最近的音频」而不只是文本。 */
  addAudio(chunk: Buffer): void {
    this.recentChunks.push(Buffer.from(chunk));
    this.recentBytes += chunk.length;
    while (this.recentBytes > this.options.recentMaxBytes && this.recentChunks.length > 1) {
      const dropped = this.recentChunks.shift();
      this.recentBytes -= dropped?.length ?? 0;
    }
    this.trackSilence(chunk);
  }

  /**
   * 本地静音检测 → 把判停**提前**跑掉。
   *
   * ASR 要等 200 ms 静音才发 `SentenceEnd`，但判停器看的是音频 —— 那 200 ms 里
   * 音频早就够了。所以「有声之后静下来 `silencePauseMs`」就先跑一次，
   * `SentenceEnd` 到达时直接取用（`takeProbability` 的缓存）。
   *
   * 两条防呆：
   * - 又来声音就把这份预跑作废（音频变了，那份快照里没有后半句）；
   * - 一段语音只预跑一次，长时间静音不会反复烧判停器。
   */
  private trackSilence(chunk: Buffer): void {
    const floor = this.options.silenceDb;
    if (floor === undefined) {
      return;
    }
    const t = this.now();
    if (pcm16PeakDbfs(chunk) > floor) {
      this.lastVoicedAt = t;
      // 音频比快照长了：预跑的那份判停不再代表「用户说完没有」
      this.prediction = null;
      return;
    }
    if (this.options.predict === undefined || this.prediction !== null) {
      return;
    }
    const pause = this.options.silencePauseMs ?? 200;
    // 只在「这一轮说过话、且还没为这段语音预跑过」时动手
    if (this.lastVoicedAt <= this.preFiredAt || this.lastVoicedAt <= this.lastUtteranceAt) {
      return;
    }
    if (t - this.lastVoicedAt < pause) {
      return;
    }
    this.preFiredAt = t;
    this.options.log(`  判停    静音 ${pause} ms → 先跑一遍（不等 ASR 定稿）`);
    // 下一句定稿时会拿到 `seq + 1`，见 `addSentence`
    this.startPrediction(this.seq + 1, true);
  }

  /**
   * ASR 中间结果到了 —— 用户还在说话。
   *
   * 这**不是**用来拼文本的（中间结果会反复改写，拼起来是乱的），只当一个
   * 「还在出字」的信号。以前这个信号只用来打断播放，判停完全看不到它，
   * 于是「音频停顿 = 说完了」成了唯一判据。
   */
  notePartial(_text: string): void {
    this.lastPartialAt = this.now();
  }

  /** 一句定稿的识别结果。 */
  addSentence(text: string): void {
    if (this.disposed) {
      return;
    }
    // 上一截是「数字/井号结尾」时，那个句号是误判出来的句尾 —— 拼进去会把
    // 订单号拦腰切开（「W866。5881」），模型读起来就是两个 token。
    const joinedFromUnfinished = this.unfinishedWaited;
    if (joinedFromUnfinished) {
      const head = stripTail(this.pendingText);
      this.pendingText = head ? head + text : text;
    } else {
      this.pendingText = this.pendingText ? this.pendingText + text : text;
    }
    this.cancelTimer();
    // 新的一句：上一句的判定（不管算完没算完）都不能再用来定稿。
    // **例外**是预跑（`trackSilence`）：那份快照本来就是给这一句的（seq 已经对上），
    // 留着才能把「出句→开轮」那一段省掉。
    this.seq += 1;
    if (this.prediction !== null && this.prediction.seq !== this.seq) {
      this.prediction = null;
    }
    this.unfinishedWaited = false;
    const seq = this.seq;
    // 句子定稿 = 文本这一刻已经定了，判停只决定「要不要并下一段」。
    // 先把它交出去起跑，真并了下一段再换 —— 见 `VoiceSession` 的接线。
    this.options.onSentence?.(this.pendingText);
    const delay = this.options.predict
      ? this.options.quietMs
      : this.options.fallbackWindowMs;
    this.schedulePrediction(seq, delay);
    this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, delay);
  }

  /**
   * 提前把判停请求发出去（与静候窗重叠）。
   *
   * 只在 `predictAtMs` 设了的时候才有这一步；窗口比提前量还短时按窗口到点算，
   * 那就等于旧行为（不重叠），不发也是对的。
   */
  private schedulePrediction(seq: number, windowMs: number): void {
    const at = this.options.predictAtMs;
    if (at === undefined || this.options.predict === undefined) {
      return;
    }
    this.cancelPredictTimer();
    const lead = Math.max(0, Math.min(at, windowMs));
    this.predictTimer = setTimeout(() => {
      this.predictTimer = null;
      this.startPrediction(seq);
    }, lead);
  }

  /** 取一份音频快照送进判停器。结果只对 `seq` 这一句、且之后没有新 partial 时有效。 */
  private startPrediction(seq: number, upcoming = false): void {
    const predict = this.options.predict;
    if (this.disposed || predict === undefined || this.prediction !== null) {
      return;
    }
    // `upcoming`：这句还没定稿（ASR 的 `SentenceEnd` 还在路上），快照给的是下一句
    if (!upcoming && seq !== this.seq) {
      return;
    }
    const pcm = Buffer.concat(this.recentChunks);
    const startedAt = this.now();
    // 侧车可能抛（也可能同步抛）；两种都吞成「不可用」，否则这份提前发起的
    // promise 没人接，会变成 unhandledRejection
    const probability = Promise.resolve().then(() => predict(pcm)).catch(() => -1);
    this.prediction = { seq, startedAt, pre: upcoming, probability };
  }

  /**
   * 取这一句的判停概率。
   *
   * 优先用手上已经算好的那份；算好之后用户又开了口（`lastPartialAt` 晚于取快照的
   * 时刻）就作废、现算一次 —— 那份音频里还没有他后半句，拿它定稿就是抢话。
   * 现算的代价是那一趟往返，但只在「用户真的又说话了」时发生，和旧行为持平。
   */
  private async takeProbability(
    seq: number,
    predict: (pcm: Buffer) => Promise<number>,
  ): Promise<number> {
    const ready = this.prediction;
    this.prediction = null;
    const hit = ready !== null && ready.seq === seq
      && (ready.pre || ready.startedAt >= this.lastPartialAt);
    // 这一句的判停是「静音一到就提前跑」的：它看过音频静音，比 ASR 的 partial 更可信
    // （实测 partial 比真实停嘴晚 98–140 ms），所以「刚收到中间结果就再等一拍」不必再执行
    this.usedPrefired = hit && ready.pre;
    if (hit) {
      return await ready.probability;
    }
    try {
      return await predict(Buffer.concat(this.recentChunks));
    } catch {
      return -1;
    }
  }

  /** 立即定稿（连接结束时兜底，避免最后一句被丢弃）。 */
  flush(): void {
    if (this.disposed) {
      return;
    }
    this.cancelTimer();
    this.cancelPredictTimer();
    this.seq += 1;
    this.prediction = null;
    this.extensions = 0;
    this.unfinishedWaited = false;
    const text = this.pendingText.trim();
    this.pendingText = '';
    if (!text) {
      return;
    }
    this.lastUtteranceAt = this.now();
    this.options.onUtterance(text);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.cancelPredictTimer();
    this.seq += 1;
    this.prediction = null;
    this.pendingText = '';
    this.recentChunks.length = 0;
    this.recentBytes = 0;
    this.unfinishedWaited = false;
  }

  /** 判定当前这一轮是否定稿。 */
  private async evaluate(seq: number): Promise<void> {
    this.pendingTimer = null;
    if (this.disposed || seq !== this.seq || !this.pendingText.trim()) {
      return;
    }

    const predict = this.options.predict;
    if (!predict) {
      this.flush();
      return;
    }

    // 判停**发起**的时刻：下面那条 partial 宽限看的是「窗口关掉那一刻」，不是
    // 「推理跑完那一刻」。提前发起之后这两者会差一整个往返，取晚的那个等于
    // 把宽限白白吃掉一截（旧写法就是这样，这条判据基本没生效过）。
    const evaluatedAt = this.now();
    const probability = await this.takeProbability(seq, predict);
    const shown = probability < 0 ? '故障' : probability.toFixed(3);

    // 等待期间用户又说了新的一句：那一轮已经重新排好，这里什么都不做
    if (this.disposed || seq !== this.seq) {
      return;
    }

    if (probability < 0) {
      // 判停器出问题就退回保守策略：宁可多合成一轮，也别把用户的话吞掉
      this.options.log(`  判停    ${shown} → 判停器不可用，直接结束本轮`);
      this.flush();
      return;
    }

    if (
      probability >= this.options.threshold
      || this.extensions >= this.options.maxExtensions
    ) {
      // 文本判据：音频说完了，但用户还在出字 —— 这时候收下就是抢话。
      // 只在还有 extension 额度时生效，避免无限等。
      const grace = this.options.partialGraceMs ?? 400;
      const sincePartial = evaluatedAt - this.lastPartialAt;
      if (grace > 0 && !this.usedPrefired
        && sincePartial < grace && this.extensions < this.options.maxExtensions) {
        this.extensions += 1;
        this.options.log(
          `  判停    ${shown} → 刚收到中间结果（${sincePartial} ms 前），还有下文，再等 ${this.options.extendMs} ms`,
        );
        this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, this.options.extendMs);
        return;
      }

      if (this.shouldWaitForMore(this.pendingText)) {
        this.extensions += 1;
        const wait = Math.min(this.options.extendMs, this.options.shortFragmentWaitMs ?? 400);
        this.options.log(
          `  判停    ${shown} → 太短且紧跟前一轮，再等 ${wait} ms`,
        );
        this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, wait);
        return;
      }

      // 结尾像「还有下文」（数字串、井号、连词…）：再等一拍，让后半句并进来。
      // 每句只等一次 —— 等过之后仍然没下文，就认这是句尾。
      const unfinishedWait = this.options.unfinishedWaitMs ?? 0;
      if (
        unfinishedWait > 0
        && !this.unfinishedWaited
        && this.extensions < this.options.maxExtensions
        && looksUnfinished(this.pendingText)
      ) {
        this.unfinishedWaited = true;
        this.extensions += 1;
        this.options.log(
          `  判停    ${shown} → 结尾像没说完（…${JSON.stringify(this.pendingText.slice(-8))}），再等 ${unfinishedWait} ms`,
        );
        this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, unfinishedWait);
        return;
      }
      this.options.log(`  判停    ${shown} → 收下这一轮`);
      this.flush();
      return;
    }

    this.extensions += 1;
    this.options.log(
      `  判停    ${shown} → 没说完，再等 ${this.options.extendMs} ms`,
    );
    this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, this.options.extendMs);
  }

  /**
   * 这一小段是不是「一句话被切开的前半截」，值得再等一拍。
   *
   * 真机（2026-11-15）：用户问「…你是怎么答的？」，ASR 切成两句 ——
   * 「…你你是怎么点？」+「大的。」。SmartTurn 对「大的。」给了 0.985：
   * 它只看这两秒音频，「大的。」确实像个完整回答，判得不冤。于是碎片单独成轮，
   * agent 只能瞎猜，用户只好把整段话重说一遍。
   *
   * 判据刻意保持**纯机械**（和 `backchannel.ts` 同一条原则：不做语义推断）：
   * 去标点后不超过 {@link UtteranceAssemblerOptions.shortFragmentChars} 字，
   * 且距上一轮被收下不超过 {@link UtteranceAssemblerOptions.shortFragmentWindowMs}。
   * 两条件都成立才多等一次 —— 用户真的只是说了个「好。」而停顿更久时不会中招。
   */
  private shouldWaitForMore(text: string): boolean {
    // 已经为这一轮延过一次就不再拖：宁可早点收，也别让用户等出失聪
    if (this.extensions > 0) return false;
    const extendMs = this.options.extendMs;
    if (extendMs <= 0) return false;

    const core = text.replace(/[\s。.,，!！?？、~～…\-—]/g, '');
    const limit = this.options.shortFragmentChars ?? 3;
    if (core.length === 0 || core.length > limit) return false;

    const window = this.options.shortFragmentWindowMs ?? 1_200;
    return this.now() - this.lastUtteranceAt <= window;
  }

  private cancelTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private cancelPredictTimer(): void {
    if (this.predictTimer) {
      clearTimeout(this.predictTimer);
      this.predictTimer = null;
    }
  }

  /** 便于日志：最近音频的时长 */
  get recentDurationMs(): number {
    return pcm16DurationMs(this.recentBytes, 16_000);
  }

  /** 便于测试：当前时间戳 */
  get timestampMs(): number {
    return this.now();
  }
}
