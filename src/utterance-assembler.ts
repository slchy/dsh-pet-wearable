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
 * 本模块**不做 I/O**：判停器、日志、时钟全部注入。
 */
import { pcm16DurationMs } from './pcm.ts';

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
   * 「太短」的门槛（去标点后的字数）。默认 3。
   *
   * 见 {@link UtteranceAssembler} 里 `shouldWaitForMore` 的说明。
   */
  readonly shortFragmentChars?: number;
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
  /** 一轮定稿 */
  readonly onUtterance: (text: string) => void;
  readonly log: (line: string) => void;
  /** 可注入时钟，测试用 */
  readonly now?: () => number;
}

/** 判定一次的结果，便于日志与测试断言 */
export type EndpointDecision = 'accept' | 'extend' | 'predictor-unavailable';

export class UtteranceAssembler {
  private readonly options: UtteranceAssemblerOptions;
  private readonly now: () => number;
  private readonly recentChunks: Buffer[] = [];
  private recentBytes = 0;
  private pendingText = '';
  private pendingTimer: NodeJS.Timeout | null = null;
  private extensions = 0;
  /** 上一次真正收下一轮的时刻，用来判断「短碎片是不是紧跟其后」 */
  private lastUtteranceAt = Number.NEGATIVE_INFINITY;
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
  }

  /** 一句定稿的识别结果。 */
  addSentence(text: string): void {
    if (this.disposed) {
      return;
    }
    this.pendingText = this.pendingText ? this.pendingText + text : text;
    this.cancelTimer();
    const delay = this.options.predict
      ? this.options.quietMs
      : this.options.fallbackWindowMs;
    this.pendingTimer = setTimeout(() => { void this.evaluate(); }, delay);
  }

  /** 立即定稿（连接结束时兜底，避免最后一句被丢弃）。 */
  flush(): void {
    if (this.disposed) {
      return;
    }
    this.cancelTimer();
    this.extensions = 0;
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
    this.pendingText = '';
    this.recentChunks.length = 0;
    this.recentBytes = 0;
  }

  /** 判定当前这一轮是否定稿。 */
  private async evaluate(): Promise<void> {
    this.pendingTimer = null;
    if (this.disposed || !this.pendingText.trim()) {
      return;
    }

    const predict = this.options.predict;
    if (!predict) {
      this.flush();
      return;
    }

    const probability = await predict(Buffer.concat(this.recentChunks));
    const shown = probability < 0 ? '故障' : probability.toFixed(3);

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
      if (this.shouldWaitForMore(this.pendingText)) {
        this.extensions += 1;
        const wait = Math.min(this.options.extendMs, this.options.shortFragmentWaitMs ?? 400);
        this.options.log(
          `  判停    ${shown} → 太短且紧跟前一轮，再等 ${wait} ms`,
        );
        this.pendingTimer = setTimeout(() => { void this.evaluate(); }, wait);
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
    this.pendingTimer = setTimeout(() => { void this.evaluate(); }, this.options.extendMs);
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

  /** 便于日志：最近音频的时长 */
  get recentDurationMs(): number {
    return pcm16DurationMs(this.recentBytes, 16_000);
  }

  /** 便于测试：当前时间戳 */
  get timestampMs(): number {
    return this.now();
  }
}
