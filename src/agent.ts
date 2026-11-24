/**
 * 语音 agent 策略层：把 ASR 文本变成「可以直接朗读」的回复。
 *
 * 两层解耦：
 * - `session.ts` 只管怎么调 dsh、怎么续会话（机制）
 * - 这里管输出清洗（策略）。`cleanForSpeech` 的实现在 `emotion.ts`，
 *   合成器和本文件都从那里取；本文件继续转出同名。
 *
 * **人设与行为规则不在这里**：全文存放在 `mcp/profile.cordis.yml` 的
 * `personaPrefix`，由 dsh 作为系统提示词注入（部署时装成
 * `~/.dsh/profiles/sdk/cordis.patch.yml`）。提示词是「设定」，放系统层比每轮
 * 拼进用户消息服从度更高，也能稳定命中前缀缓存。这里只负责把模型吐出来的
 * 东西清洗成能念的一行字。
 *
 * 为什么必须清洗：TTS 会把 markdown 原样读出来——
 * `**加粗**` 念成「星号星号加粗星号星号」，列表念成「短横线」。
 * 模型的默认输出是给人看的，不是给嘴念的。
 */
import type { AskResult, ImageAttachment } from './session.ts';
import { DshSession } from './session.ts';
import type { AnnounceStore } from './announce-store.ts';
import type { DelegateReason } from './providers.ts';
import { cleanForSpeech, parseEmotion } from './emotion.ts';
import type { TurnTicket } from './dialog-fsm.ts';

export { cleanForSpeech } from './emotion.ts';

/**
 * dsh 的压缩阈值（token）—— 来自 profile 里的 `compaction-basic.thresholdRatio: 0.125`。
 *
 * 默认是 0.8（80 万 token 才动手），真机 212 轮的会话直接抛
 * `retainTokens >= thresholdTokens`，所以这里已经调成 0.125 ≈ 12.5 万。
 * **改 profile 时这个常量也要跟着改**，否则日志里的「接近压缩阈值」会报错地方。
 */
const COMPACTION_THRESHOLD = 125_000;

/**
 * 上下文规模的两个「该说话」的时刻。
 *
 * 压缩是**看不见的代价**：撞上它的那一轮会突然慢几秒，而 `ctx` 曲线本身看不出
 * 原因。所以只在两个点出声 —— 快到阈值了、刚被压过 —— 其余轮次一个字都不加。
 */
export function compactionNote(current: number | undefined, previous: number | undefined): string {
  if (current === undefined) {
    return '';
  }
  if (current >= COMPACTION_THRESHOLD * 0.8) {
    return `  ← 接近压缩阈值（${COMPACTION_THRESHOLD}）`;
  }
  if (previous !== undefined && previous > 0 && current < previous * 0.7) {
    return `  ← 刚压缩过（上一轮 ${previous}）：这一轮变慢可能是它`;
  }
  return '';
}

export interface AgentReply extends AskResult {
  /** 清洗后、准备送 TTS 的文本 */
  speech: string;
  /** 情绪 key（`happy` / `proud` / `calm` / `worried` / `sulk`） */
  emotion: string;
  /** 这条回复是谁给的（见 `AgentReplyView.path`）。`VoiceAgent` 永远是 `dsh` */
  path?: 'fast' | 'dsh';
  /** 交给慢车道的原因（`VoiceAgent` 自己不会产生，由 `FrontedAgent` 覆盖） */
  delegate?: DelegateReason;
}

export class VoiceAgent {
  /** 供日志/诊断显示 */
  readonly name = 'dsh';

  private readonly session: DshSession;
  private readonly log: (line: string) => void;
  /** 播报出口。第二个参数是情绪 key，没有就按平静处理 */
  private announcer: ((speech: string, emotion?: string) => void) | null = null;
  /** 上一轮的上下文规模，用来识别「刚压缩过」（见 `compactionHint`） */
  private lastContextTokens: number | undefined;
  /** 没有连接时把汇报存下来，等下次连上补播（null = 不持久化） */
  private readonly announceStore: AnnounceStore | null;

  constructor(
    session: DshSession,
    log: (line: string) => void = () => {},
    announceStore: AnnounceStore | null = null,
  ) {
    this.session = session;
    this.log = log;
    // ⚠️ 不能写成构造函数参数属性：Node 22 的类型擦除不支持，tsc 通过、跑起来
    // 直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（`dialog-fsm.ts` 里也记过这条）。
    this.announceStore = announceStore;

    // 后台作业结算后 dsh 会自己开一轮；把那轮文本清洗成可朗读的句子交出去
    this.session.onAnnounce = (text: string) => {
      // 后台汇报也可能带情绪标签，同样处理
      const { emotion, rest } = parseEmotion(text);
      const speech = cleanForSpeech(rest);
      if (!speech) {
        return;
      }
      if (this.announcer === null) {
        const pending = this.announceStore?.push(speech, emotion) ?? 0;
        this.log(`  后台    没有连接，存入待补播（积压 ${pending} 条）`);
        return;
      }
      this.log(`  后台    任务完成 → 播报 ${JSON.stringify(speech.slice(0, 60))}`);
      this.announcer(speech, emotion);
    };
  }

  /**
   * 设置播报出口。连接建立时设、断开时清 —— 后台任务属于**会话**，
   * 但播报要落到当时在线的那个连接上。
   */
  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.announcer = cb;
  }

  /** 放手那一轮跑完之后把答案交出去（回注记忆，见 `DshSession.onDetachedAnswer`）。 */
  setDetachedAnswerSink(
    cb: ((userText: string, answer: string, spoken: boolean) => void) | null,
  ): void {
    this.session.onDetachedAnswer = cb;
  }

  /** 当前会话 id（新会话时为 null，第一次 ask 之后才有值）。 */
  get sessionId(): string | null {
    return this.session.currentSessionId;
  }

  /** 主动开新会话。语音里对应「重新开始」这类指令。 */
  reset(): void {
    this.session.reset();
  }

  /** 逐句合成：把原始 token 增量接到调用方（`null` 摘掉）。 */
  attachLiveSink(sink: ((text: string) => void) | null): void {
    this.session.onLiveSink = sink;
  }

  /** 取消在途一轮（快车道胜出后，慢车道那一轮已经没人要了）。 */
  cancelTurn(ticket?: TurnTicket): void {
    this.session.cancelTurn(ticket);
  }

  /**
   * 放手：不取消 dsh 那一轮，只把「有人在等它」摘掉（见 `DshSession.detachTurn`）。
   *
   * **曾经漏了这个方法**：`FrontedAgent` 里是 `this.inner.detachTurn?.(ticket)`，
   * 可选调用遇到 undefined 就静默空转 —— 于是"插话后委派轮跑完还能听到答案 /
   * 答案会回注记忆"从来没发生过，日志里连一行都不出。
   */
  detachTurn(ticket?: TurnTicket): void {
    this.session.detachTurn(ticket);
  }

  /** dsh 手上有没有活儿（含放手的委派轮）。 */
  dshBusy(): boolean {
    return this.session.isBusy();
  }

  /** 硬中断：SIGINT 给 dsh 子进程（会退出，下一轮重启）。 */
  interruptTurn(): void {
    this.session.interruptTurn();
  }

  /**
   * 撤回上一轮：慢车道那一轮**已经答完**（取消来不及）、但用户听到的是快车道的答案 ——
   * 把那一轮从 dsh 的会话历史里切掉（`session/fork`），下次续上一段前缀。
   */
  rollbackTurn(ticket?: TurnTicket): void {
    this.session.rollbackTurn(ticket);
  }

  /** 上一次撤回的结果（给「补上下文」决定措辞用，取一次就清）。 */
  takeRollbackOutcome(): 'ok' | 'failed' | 'none' {
    return this.session.takeRollbackOutcome();
  }

  /** 后台任务状态的一句话事实（来自 dsh 自己的事件，不发请求）。 */
  taskStatus(): string {
    return this.session.taskStatus();
  }

  async reply(
    asrText: string,
    image?: ImageAttachment,
    note?: string,
    turn?: { readonly ticket: TurnTicket },
  ): Promise<AgentReply> {
    // 人设与规则由 dsh 作为系统提示词注入（见 mcp/profile.cordis.yml），这里只发
    // 本轮真正变化的东西：可选的系统注记 + 哥说的话。
    const context = note === undefined ? '' : `（系统注记：${note}）\n`;
    const prompt = `${context}哥刚才说：\n${asrText}`;
    const r = await this.session.ask(prompt, image, turn);
    // 情绪标签在最开头；剥掉它，剩下的才是要念的话
    const { emotion, rest } = parseEmotion(r.text);
    const speech = cleanForSpeech(rest);
    if (!speech) {
      // 放手的那一轮：这一轮已经作废，空答复不是失败 —— 真正的答案之后从播报口出来
      if (r.detached === true) {
        this.log('  dsh     已放手（用户走了），答案之后从播报口出');
        return { ...r, speech: '', emotion, path: 'dsh' };
      }
      throw new Error('清洗后没有可朗读的内容');
    }
    const usage = r.usage;
    this.log(
      `  dsh     ${(r.durationMs / 1000).toFixed(2)} s  `
      + `${r.resumed ? '续会话' : '新会话'}  `
      + `情绪=${emotion}  `
      + `tokens=${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}`
      + ` cache=${usage?.cacheReadTokens ?? 0}`
      // 上下文规模：压缩阈值（12.5 万）看的是这条，累加的 input 看不出问题
      + ` ctx=${usage?.contextTokens ?? '?'}`
      + this.compactionHint(usage?.contextTokens),
    );
    return { ...r, speech, emotion, path: 'dsh' };
  }

  /**
   * 压缩提示：`ctx` 本身只会一路涨，看不出「刚才那轮为什么慢了三秒」。
   *
   * dsh 的 `compaction-basic` 在 `thresholdRatio 0.125`（≈12.5 万）触发，压缩本身
   * 要一次模型调用、还可能「先压缩再重试」，那一轮会明显变慢。这里只在
   * **接近阈值**和**刚压完（ctx 骤降）**两个时刻各打一句，平时不出声。
   */
  private compactionHint(contextTokens: number | undefined): string {
    const note = compactionNote(contextTokens, this.lastContextTokens);
    if (contextTokens !== undefined) {
      this.lastContextTokens = contextTokens;
    }
    return note;
  }
}
