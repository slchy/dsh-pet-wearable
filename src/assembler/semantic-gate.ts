/**
 * 语义判停：文字这一层只补声学判停补不了的洞 ——「这句话说完了没有」。
 *
 * 声学看的是「像不像句尾」。真机上 `p=0.985` 判对句尾、判错语义的半句一抓一把
 * （「实在不甘心的话。」「如果明天下午不下雨的话。」）。`'more'` 就再等一拍。
 *
 * 本类**不持有**开轮定时器，也**不改**组装器的相位。{@link SemanticGate.allowsFlush}
 * 只返回「放行 / 让位 / 再等这么久」；`extensions`、`waitedMs`、`pendingTimer`
 * 仍由 `UtteranceAssembler` 记账。等语义回话的那一个预算定时器是局部的，
 * 到点按「说完了」放行，不能把话吞掉。
 */
/**
 * 结尾「必须还有下文」的记号。纯机械，不做语义推断
 * （和 `backchannel.ts`、`shouldWaitForMore` 同一条原则）。
 *
 * 只收「单独出现在句尾就不成立」的记号：
 * - 数字 / 中文数字：`#W866`、`第`
 * - 字母：`井号W`（订单号、型号被拦腰截断）
 * - 连词与引子：`和` `就是` `因为` `的话`…
 *
 * **宁漏不误**：误判的代价是这一轮多给一份序列预算，漏判只是维持现状。
 */
const UNFINISHED_TAIL =
  /(?:[0-9０-９]|[零一二三四五六七八九十百千万亿两]|[A-Za-z#＃]|井号|第|和|跟|与|及|还有|就是|因为|所以|但是|然后|如果|的话|或者|还是)$/u;

/** 尾部标点 —— ASR 每个 `SentenceEnd` 都会补一个，作为句界记号而不是内容 */
const TRAILING_PUNCT = /[\s。．.，,、!！?？~～…\-—:：;；"'“”‘’]+$/u;

/**
 * 声学判据到了这个置信度，**完整句**就不等语义判停了。
 *
 * 语义判停的意义在「声学拿不准」（p 落在 0.3–0.80 那条带）。p 已经 0.83–0.98
 * 时再等 256–324 ms 纯属白搭。`looksUnfinished` 的半句不走这条捷径：
 * eval-v1 S4「实在不甘心的话。」p=0.977 仍要等已经在飞的那趟。
 */
const SEMANTIC_SKIP_P = 0.80;

/**
 * 语义判停两个缓存各留多少条。
 *
 * 它们是「最近几句」的窗口，不是历史账本。中间结果会连续改写，几小时前的判定
 * 既不会被同一个前缀命中，还会把旧结论借给新句。
 */
const SEMANTIC_CACHE_LIMIT = 8;

/**
 * 「定稿只是中间结果的收尾」允许差几个字。
 *
 * 超过这个长度就是另一句话了，前缀判定不再作数。
 */
const SEMANTIC_PREFIX_SLACK_CHARS = 6;

/**
 * 普通静音上限下，语义 `more` 的单拍下限（ms）。
 * `max(extendMs, 本值)` 之后还要被 `cap - quietNow` 和短碎片上限夹住。
 * 没配 `maxOpenSilenceMs` 时不用这道下限。
 */
const SEMANTIC_MORE_MIN_WAIT_MS = 350;

/**
 * 启用了更大的 `waitBudgetSequenceMs` 时，语义 `more` 的单拍等待（ms）。
 * `max(extendMs, 本值)` 之后只受 `cap - quietNow` 夹住。
 */
const SEMANTIC_MORE_SEQUENCE_WAIT_MS = 550;

/**
 * 等语义判停回话的模块兜底（ms）。等不到按「说完了」放行。
 * 生产运行时由 `SEMANTIC_END_TAG_BUDGET_MS` 传入覆写。
 */
const DEFAULT_SEMANTIC_BUDGET_MS = 300;

/** 丢掉尾部标点，只看最后那个字 */
export function stripTail(text: string): string {
  return text.replace(TRAILING_PUNCT, '');
}

/** 结尾看起来「还有下文」吗 —— 见 {@link UNFINISHED_TAIL} */
export function looksUnfinished(text: string): boolean {
  const core = stripTail(text);
  return core.length > 0 && UNFINISHED_TAIL.test(core);
}

/** 组装器交给语义门的预算快照。门不自己记账，只按这一拍的数做判断。 */
export interface SemanticBudgetContext {
  /** 这一轮已经延长过几次（四种原因合计） */
  readonly extensions: number;
  /** 其中「判停说没说完」占了几次 */
  readonly unsureExtensions: number;
  /** `maxExtensions` */
  readonly maxExtensions: number;
  /** unsure 每一拍加上去的毫秒，和 `extendMs` 是同一个数 */
  readonly extendMs: number;
  /** 当前这句话的等待预算（ms）。0 = 不设。序列句由组装器先选好。 */
  readonly waitBudget: number;
  /** `waitedMs` 是否已经盖住 {@link SemanticBudgetContext.waitBudget} */
  readonly overBudget: boolean;
}

export type SemanticFlushDecision =
  | { readonly action: 'flush' }
  | { readonly action: 'stale' }
  | { readonly action: 'extend'; readonly waitMs: number; readonly text: string };

/**
 * 一次**真的等了**的语义判停事实（只有 `awaitSemantics` 被走到时才产生）。
 *
 * 为什么要它：`judge.decide` 的 `waitedMs` 是**累计**等待，分不出「语义说 end
 * （0 成本）」和「语义超时（白等一整拍）」。`verdict` 把那次等待的结局说清楚：
 * - `end` / `more`：端点回话了；
 * - `timeout`：预算用完，按「说完了」放行；
 * - `unsure`：端点失败或回 `null`（拿不准）。
 */
export interface SemanticGateFact {
  /** 真的等了多久（ms，`now()` 之差） */
  readonly waitedMs: number;
  readonly verdict: 'end' | 'more' | 'timeout' | 'unsure';
  /** 这次等待的预算（ms） */
  readonly budgetMs: number;
}

export interface SemanticGateOptions {
  readonly semanticEndpoint?: (text: string) => Promise<'end' | 'more' | null>;
  readonly semanticBudgetMs?: number;
  readonly maxOpenSilenceMs?: number;
  readonly waitBudgetSequenceMs?: number;
  readonly extendMs: number;
  /** 短碎片单拍上限。组装器已用 `DEFAULT_SHORT_FRAGMENT_WAIT_MS` 填过缺省。 */
  readonly fragmentWaitMs: number;
  /** 没有判停器时结果没人读，{@link SemanticGate.ask} 直接回 `null`。 */
  readonly hasPredictor: boolean;
  /**
   * 真的 `await awaitSemantics(text)` 之后回调**一次**（档案 `semantic.gate`）。
   *
   * 只有走到「等语义回话」那一步才调：已落定 / 高把握 / 前缀判定都是 0 ms，
   * 不产生事件。Pure Live 默认不开 `SEMANTIC_END_TAG` 时这条路根本不存在。
   */
  readonly onSemanticWait?: (fact: SemanticGateFact) => void;
  readonly now: () => number;
  readonly lastVoicedAtMs: () => number;
  readonly log: (line: string) => void;
}

export class SemanticGate {
  private readonly options: SemanticGateOptions;
  /**
   * 语义判停的请求缓存：文字 → 判定。
   *
   * 判定在定稿时就发出去，真正要用的时刻是「即将开轮」。同一段文字问过一次
   * 就直接取。只留最近几条 —— 中间结果会连续改写，不是历史账本。
   */
  private readonly semanticAsks = new Map<string, Promise<'end' | 'more' | null>>();
  /**
   * 已经回来的判定（同步可读）。
   *
   * 与 {@link semanticAsks} 同生共死、同样只留最近 {@link SEMANTIC_CACHE_LIMIT} 条。
   * 它曾经只进不出，几分钟前的前缀判定会被借给新句。
   */
  private readonly semanticSettled = new Map<string, 'end' | 'more' | null>();
  /** 已经因为语义判停延长过的那段文字（同一段只延长一次） */
  private semanticExtended = '';

  constructor(options: SemanticGateOptions) {
    this.options = options;
  }

  /**
   * 把某段文字的判定请求发出去（同一段文字只问一次；失败一律回 `null`）。
   *
   * 无判停器、无端点、空文本：直接回 `null`，不进缓存。否则就是一次没人读的请求。
   */
  ask(text: string): Promise<'end' | 'more' | null> {
    const endpoint = this.options.semanticEndpoint;
    if (!this.options.hasPredictor || endpoint === undefined || text.trim() === '') {
      return Promise.resolve(null);
    }
    const cached = this.semanticAsks.get(text) ?? this.askedNear(text);
    if (cached !== undefined) {
      return cached;
    }
    const promise = endpoint(text).catch((): null => null).then((verdict) => {
      this.semanticSettled.set(text, verdict);
      this.evictCache();
      return verdict;
    });
    this.semanticAsks.set(text, promise);
    this.evictCache();
    return promise;
  }

  /**
   * 开轮静音上限。
   *
   * 四条**同步**谓词全部成立才返回 {@link silenceCapFor}`(true)`（序列预算，
   * 例如 1200 ms），否则原样返回 `maxOpenSilenceMs`（例如 650 ms）：
   *
   * 1. 配了语义端点；
   * 2. 这段文字（或 6 字以内的前缀）**已经落定** `'more'` —— 只读
   *    {@link semanticSettled}，绝不在这里 `await`。完整句和仍在途的请求
   *    因此是 0 ms 额外延迟；
   * 3. 这段文字还没因语义延长过。延长过一次之后，下一拍必须回到 650 ms，
   *    否则会在 650–1200 之间被静音门槛或短碎片再加一拍；
   * 4. {@link semanticMoreAllowed} 仍允许占这一拍（`maxExtensions`，以及
   *    unsure 吃光预算的那一次豁免）。
   */
  raisedCap(text: string, budget: SemanticBudgetContext): number {
    const base = this.options.maxOpenSilenceMs ?? 0;
    const settledMore = this.semanticSettled.get(text) === 'more' || this.hasPrefixMore(text);
    if (
      this.options.semanticEndpoint !== undefined
      && settledMore
      && this.semanticExtended !== text
      && this.semanticMoreAllowed(budget)
    ) {
      return this.silenceCapFor(true);
    }
    return base;
  }

  /**
   * 顶部静音上限（例如 650 ms）命中的瞬间，是否应当等完**已经在途**的语义判停。
   *
   * 仅当全部 7 条成立才返回 `true`（其余情形 0 ms 额外延迟）：
   * 1. 配了语义端点且文本非空；
   * 2. 配了更大的序列天花板，且此刻静音仍低于序列天花板（到 1200 ms 就不再等）；
   * 3. 这段文字还没因语义延长过；
   * 4. {@link semanticMoreAllowed} 仍允许占这一拍；
   * 5. 语义尚未落定（已落定 `'end'` 走 0 ms）；
   * 6. 声学并未高把握判完（`p >= SEMANTIC_SKIP_P && !looksUnfinished` 走 0 ms）；
   * 7. 该句或其近似前缀确有在途请求（不在 650 ms 现起冷请求）。
   */
  shouldAwaitInFlightBeforeCap(
    text: string,
    probability: number,
    budget: SemanticBudgetContext,
    quietNow: number,
  ): boolean {
    if (this.options.semanticEndpoint === undefined || text.trim() === '') {
      return false;
    }
    const base = this.options.maxOpenSilenceMs ?? 0;
    const raised = this.silenceCapFor(true);
    if (raised <= base || quietNow >= raised) {
      return false;
    }
    if (this.semanticExtended === text || !this.semanticMoreAllowed(budget)) {
      return false;
    }
    if (
      this.semanticSettled.get(text) !== undefined
      || this.hasPrefixMore(text)
      || this.hasPrefixEnd(text)
    ) {
      return false;
    }
    if (probability >= SEMANTIC_SKIP_P && !looksUnfinished(text)) {
      return false;
    }
    return this.semanticAsks.get(text) !== undefined || this.askedNear(text) !== undefined;
  }

  /**
   * 「要不要开轮」的最后一道文本闸。
   *
   * - `'flush'`：可以收下。`'end'` / `null` / 超时 / 静音到顶 / 拍数用完都走这里。
   * - `'stale'`：等待期间来了新句、用户重新开口，或代次过期。调用方必须放弃，
   *   不能把新缓冲句提前冲掉。
   * - `'extend'`：语义明确还有下文。调用方自己加 `extensions` / `waitedMs`、
   *   改相位，并挂带 `{seq, epoch}` 的定时器。本方法不碰那三件事。
   */
  async allowsFlush(
    text: string,
    probability: number,
    budget: SemanticBudgetContext,
    isStale: () => boolean,
  ): Promise<SemanticFlushDecision> {
    if (this.options.semanticEndpoint === undefined || text.trim() === '') {
      return { action: 'flush' };
    }
    // 说话期间/定稿时已经问过了就直接取。前缀判定要先看：定稿常常只是中间结果的
    // 延长，那份「还有下文」已经够用了 —— 再为延长后的文字问一趟，等回来时开轮
    // 早该发生了（实测 p50 250–310 ms）。
    const settled = this.semanticSettled.get(text);
    let verdict: 'end' | 'more' | null | 'timeout';
    if (settled !== undefined) {
      verdict = settled;
    } else if (this.hasPrefixMore(text)) {
      verdict = 'more';
    } else if (this.hasPrefixEnd(text)) {
      verdict = 'end';
    } else if (probability >= SEMANTIC_SKIP_P && !looksUnfinished(text)) {
      // 声学已经很有把握，不再等还没回来的语义。只挡住「等」；已经落定的判定
      // 仍走上面两条。半句（的话 / 因为 / 如果 …）不走这里。
      verdict = 'end';
    } else {
      // 真的等了一趟：从发起等待到判定回来（含超时）的墙钟时间。
      // 这是唯一会「白等」的分支，落一条档案才分得清 ② 的慢是排队还是等语义。
      const waitedFrom = this.options.now();
      verdict = await this.awaitSemantics(text);
      this.options.onSemanticWait?.({
        waitedMs: Math.max(0, this.options.now() - waitedFrom),
        verdict: verdict === null ? 'unsure' : verdict,
        budgetMs: this.options.semanticBudgetMs ?? DEFAULT_SEMANTIC_BUDGET_MS,
      });
    }
    if (isStale()) {
      return { action: 'stale' };
    }
    if (verdict !== 'more') {
      if (verdict === 'timeout') {
        const budgetMs = this.options.semanticBudgetMs ?? DEFAULT_SEMANTIC_BUDGET_MS;
        this.options.log(`  判停    语义判停 ${budgetMs} ms 没回话，按「说完了」放行`);
      }
      return { action: 'flush' };
    }
    if (this.semanticExtended === text) {
      return { action: 'flush' };
    }
    // 静音天花板：仅对明确 `more` 启用序列上限。等语义的那一程不在 evaluate
    // 开头那道闸的量程里，所以这里用此刻的静音再判一次。
    const openSilenceCap = this.silenceCapFor(true);
    const quietNow = openSilenceCap > 0 ? this.options.now() - this.options.lastVoicedAtMs() : 0;
    if (openSilenceCap > 0 && quietNow >= openSilenceCap) {
      this.options.log(
        `  判停    语义=还有下文，但静音 ${Math.round(quietNow)} ms ≥ 上限 ${openSilenceCap}，放行`,
      );
      return { action: 'flush' };
    }
    if (!this.semanticMoreAllowed(budget)) {
      this.options.log('  判停    语义=还有下文，但拍数/预算已经用完，放行');
      return { action: 'flush' };
    }
    const waitMs = this.semanticMoreWait(openSilenceCap, quietNow);
    this.semanticExtended = text;
    return { action: 'extend', waitMs, text };
  }

  /** 有没有哪份前缀判定说了「还有下文」（定稿往往只是中间结果的延长）。 */
  hasPrefixMore(text: string): boolean {
    for (const [asked, verdict] of this.semanticSettled) {
      if (verdict !== 'more' || asked === text || !text.startsWith(asked)) {
        continue;
      }
      if (text.length - asked.length <= SEMANTIC_PREFIX_SLACK_CHARS) {
        return true;
      }
    }
    return false;
  }

  /**
   * 这条定稿的前缀已经被判成「说完了」了吗。
   *
   * 只复用「延长 ≤ 6 字」的前缀。中间结果那一侧已不再逐字问语义。
   */
  hasPrefixEnd(text: string): boolean {
    for (const [asked, verdict] of this.semanticSettled) {
      if (verdict !== 'end' || asked === text || !text.startsWith(asked)) {
        continue;
      }
      if (text.length - asked.length <= SEMANTIC_PREFIX_SLACK_CHARS) {
        return true;
      }
    }
    return false;
  }

  /** 新的一截定稿：同一段文字的「已经延长过」标记作废，拍数由组装器另记。 */
  resetForUtterance(): void {
    this.semanticExtended = '';
  }

  /** 连接结束。两个缓存不准跟到下一条连接。 */
  clear(): void {
    this.semanticAsks.clear();
    this.semanticSettled.clear();
    this.semanticExtended = '';
  }

  /**
   * 淘汰最老的条目。两个 Map 必须一起收：只收请求侧的话，结果侧会把几小时前的
   * 前缀判定借给新句。结果侧的键也不一定还在请求侧（请求先被淘汰、之后才落地）。
   */
  private evictCache(): void {
    while (this.semanticAsks.size > SEMANTIC_CACHE_LIMIT) {
      const oldest = this.semanticAsks.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.semanticAsks.delete(oldest);
      this.semanticSettled.delete(oldest);
    }
    while (this.semanticSettled.size > SEMANTIC_CACHE_LIMIT) {
      const oldest = this.semanticSettled.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.semanticSettled.delete(oldest);
    }
  }

  /**
   * 已经问过「同一句话的另一个版本」吗。
   *
   * 两个版本互为前缀、长度差不超过 {@link SEMANTIC_PREFIX_SLACK_CHARS} 就算同一句。
   * 真机里「…《奇》书。」和「…《奇》书」各问一趟，结论都是 `end`，第二趟纯属白等。
   */
  private askedNear(text: string): Promise<'end' | 'more' | null> | undefined {
    for (const [asked, promise] of this.semanticAsks) {
      if (asked === text) {
        return promise;
      }
      const [shorter, longer] = asked.length <= text.length ? [asked, text] : [text, asked];
      if (longer.startsWith(shorter) && longer.length - shorter.length <= SEMANTIC_PREFIX_SLACK_CHARS) {
        return promise;
      }
    }
    return undefined;
  }

  /** 取这段文字的判定；没问过就现问，最多等 `semanticBudgetMs`。 */
  private async awaitSemantics(text: string): Promise<'end' | 'more' | null | 'timeout'> {
    const ask = this.semanticAsks.get(text) ?? this.ask(text);
    const budgetMs = this.options.semanticBudgetMs ?? DEFAULT_SEMANTIC_BUDGET_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budgetMs);
    });
    const verdict = await Promise.race([ask, timedOut]).finally(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
    return verdict;
  }

  /**
   * 明确的语义 MORE 还能不能占这一拍。
   *
   * 调用方已经确认判定是 `'more'`，而且这段文字还没因语义延长过。
   *
   * - `extensions > maxExtensions`：不许。
   * - `extensions < maxExtensions` 且预算还没用完：可以。
   * - 否则只有 unsure 自己的等待已经盖住当前预算，并且拍数还没越过上限，才放行。
   *   静音闸门 / 短碎片把预算吃光的，不豁免。`maxExtensions: 0` 时 unsure
   *   一拍都不会发生，因此仍然立刻放行。
   */
  private semanticMoreAllowed(budget: SemanticBudgetContext): boolean {
    if (budget.extensions > budget.maxExtensions) {
      return false;
    }
    if (budget.extensions < budget.maxExtensions && !budget.overBudget) {
      return true;
    }
    return budget.extensions <= budget.maxExtensions && this.unsureAteBudget(budget);
  }

  /**
   * unsure 分支累计的等待是否已经盖住当前预算。
   *
   * 不看 `waitedMs`：静音闸门和短碎片也往里加，那些不算「预算被 unsure 吃掉」。
   */
  private unsureAteBudget(budget: SemanticBudgetContext): boolean {
    if (budget.waitBudget <= 0 || budget.unsureExtensions <= 0) {
      return false;
    }
    return budget.unsureExtensions * budget.extendMs >= budget.waitBudget;
  }

  /**
   * 静音上限：普通句严格受 `maxOpenSilenceMs` 约束。
   * 仅当语义明确 `'more'` 且宿主配了更大的序列预算
   * （`waitBudgetSequenceMs > maxOpenSilenceMs`）时，用序列预算当天花板，
   * 避免 `commit + decode + semantic ≈ 680 ms` 把 `more` 压成死代码。
   */
  private silenceCapFor(semanticMore: boolean): number {
    const base = this.options.maxOpenSilenceMs ?? 0;
    if (base <= 0) {
      return 0;
    }
    if (semanticMore) {
      const sequenceBudget = this.options.waitBudgetSequenceMs ?? 0;
      if (sequenceBudget > base) {
        return sequenceBudget;
      }
    }
    return base;
  }

  /**
   * 语义 MORE 这一拍等多少。调用方保证 `quietNow < cap`（cap 启用时）。
   *
   * - 没给静音上限：`min(extendMs, fragmentWaitMs)`；
   * - 给了上限但没有更大的序列预算：
   *   `min(fragmentWaitMs, max(1, min(max(extendMs, 350), cap - quietNow)))`；
   * - 序列预算更大：`max(extendMs, 550)`，仍被 `cap - quietNow` 夹住。
   */
  private semanticMoreWait(openSilenceCap: number, quietNow: number): number {
    const fragmentCap = this.options.fragmentWaitMs;
    const baseCap = this.options.maxOpenSilenceMs ?? 0;
    const sequenceBudget = this.options.waitBudgetSequenceMs ?? 0;
    if (openSilenceCap > 0) {
      const room = openSilenceCap - quietNow;
      if (baseCap > 0 && sequenceBudget > baseCap) {
        const want = Math.max(this.options.extendMs, SEMANTIC_MORE_SEQUENCE_WAIT_MS);
        return Math.max(1, Math.min(want, room));
      }
      const want = Math.max(this.options.extendMs, SEMANTIC_MORE_MIN_WAIT_MS);
      return Math.min(fragmentCap, Math.max(1, Math.min(want, room)));
    }
    return Math.min(this.options.extendMs, fragmentCap);
  }
}
