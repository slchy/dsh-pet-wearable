/**
 * 纯级联管线的 agent：`VOICE_PIPELINE=cascade` 时只用这一条。
 *
 * 短闲聊走 `FastLlmClient`，其余交给内层 dsh。路由里 `live` 恒为 `'off'`
 * —— 本文件不接音频直出，也不实现那条车道的可选方法。
 *
 * 出话热路径是 {@link CascadeAgent.toEngine}：`reply()` 的文本增量直接送
 * `tts.synthesizeStream`，流式失败再退回整段 `synthesize`。
 */
import { cleanForSpeech } from '../agent.ts';
import { ConversationLedger, type LedgerLane, type LedgerTurn } from '../conversation-ledger.ts';
import type { TurnTicket } from '../dialog-fsm.ts';
import { parseEmotion } from '../emotion.ts';
import type { EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import { EVENTS } from '../events.ts';
import { FastLlmClient, type FastAnswer } from '../fast-llm-client.ts';
import { FAST_LANE_PERSONA_HEADER } from '../persona.ts';
import { normalizeForCompare, PrefetchSlot, SPEC_MIN_CHARS } from '../prefetch-slot.ts';
import type {
  AgentImage,
  AgentProvider,
  AgentReplyView,
  DelegateReason,
  TtsProvider,
  TurnContext,
} from '../providers.ts';
import { SentencePump } from '../sentence-pump.ts';
import { TokenQueue } from '../token-queue.ts';
import {
  isCancelRequest,
  looksLikeAnswer,
  looksMemorable,
  routeTurn,
  type RouteDecision,
} from '../turn-router.ts';

const SYSTEM_PROMPT_WITH_DELEGATE = [
  ...FAST_LANE_PERSONA_HEADER,
  '',
  '下面是「快车道」的分流规则（这条链路只负责闲聊，**语义判断，不看字面**）：',
  '直接回答这些（**不要委派**）：',
  '- 招呼、寒暄、夸奖、撒娇、道别、问你是谁/叫什么名字；',
  '- 表达感受：累、饿、冷、疼、难过、开心、烦躁 —— 只要他没要求你做事，',
  '  就顺着他的话回应（例如「我好累啊」→「那歇会儿吧，我陪着你」）。',
  '- **和你聊他自己、聊你已经聊过的事、问你的看法**（例如「你看过星球大战没？」',
  '  「你觉得那部怎么样？」「为什么？」「你今天怎么样啊？」）—— 这些就是闲聊，',
  '  照你的身份照实聊，不确定的就说不确定，**不要委派**。',
  '只输出 [[DELEGATE]]（六个字符，不要解释、不要标点、也不要情绪标签）当且仅当：',
  '- 需要**实时或外部**信息：天气、时间、新闻、股价、比分、路况、地图路线；',
  '- 需要**设备**：拍照、看界面/屏幕、电量、定位、设置、打电话、导航、下单；',
  '- 需要**动你手上的东西**：查文件、看日志、读写记忆、记下来、取消任务；',
  '- 用户话里带着**具体数字、编号、人名、地点**，或要求你转述这类内容；',
  '- 你心里没底，答错会让他照做（宁可委派，也别猜）。',
  '**判断依据是这句话的意思，不是它出现了哪个字**：「你看过吗」是聊天（答），',
  '「帮我看一下订单」是办事（委派）。',
  '**你没有工具**。需要工具才能答的，一律 [[DELEGATE]]，不要假装查过。',
  '要求：一句话，不超过 20 个字，口语，不要表情符号，不要 markdown。',
].join('\n');

const SYSTEM_PROMPT_PLAIN = [
  ...FAST_LANE_PERSONA_HEADER,
  '',
  '你就是在陪他聊天，他说什么你接什么：',
  '- 招呼、寒暄、夸奖、撒娇、道别 —— 接住就好，不用客套。',
  '- 他说累、饿、冷、难过、烦躁 —— 先接情绪，别急着给建议。',
  '- 问你看法、聊他看过的片子书、聊你俩之前说过的 —— 照实聊，',
  '  **不确定就说不知道**，别编细节、别假装查过。',
  '要求：一句话，不超过 20 个字，口语，不要表情符号，不要 markdown。',
].join('\n');

const TASK_RULE = [
  '',
  '【这一轮额外给了你一条「后台任务」事实】',
  '- 用户问进度（好了吗/查到了吗/还在跑吗/怎么样了/还要多久），**不要委派**，',
  '  直接用那条事实说一句：在跑就说还在跑，别报结果；',
  '- 事实说没有在跑的，就别编「正在查」，也别编「刚查到」；',
  '- 不要复述整条事实，用口语说一句。',
].join('\n');

const TASK_RULE_PLAIN = [
  '',
  '【这一轮额外给了你一条「后台任务」事实】',
  '- 用户问进度（好了吗/查到了吗/还在跑吗/怎么样了/还要多久），**直接照那条事实说一句**：',
  '  在跑就说还在跑，别报结果；',
  '- 事实说没有在跑的，就别编「正在查」，也别编「刚查到」；',
  '- 不要复述整条事实，用口语说一句。',
].join('\n');

const STATUS_HINTS: readonly string[] = [
  '好了吗', '好了没', '好了没有', '好没好', '弄好了吗', '搞定了吗',
  '查到了吗', '查到没', '查到没有', '找到了吗', '找到没',
  '还在跑', '在跑吗', '跑完了吗', '完事了吗', '完成了吗', '结束了吗',
  '怎么样了', '进展', '到哪了', '还没好', '还要多久', '好了嘛',
];

const STATUS_BLOCKERS: readonly string[] = ['请', '帮', '给我', '替我', '一下'];

function isStatusQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (STATUS_BLOCKERS.some((word) => trimmed.includes(word))) return false;
  return STATUS_HINTS.some((word) => trimmed.includes(word));
}

const WINDOW_CHARS = 800;
const WINDOW_MESSAGES = 8;

const ASK_MARKERS: readonly string[] = [
  '？', '?', '吗', '呢', '嘛', '哪', '什么', '怎么', '为什么', '多少', '是否',
  '要不要', '能不能', '可不可以', '说一下', '告诉我',
];

function awaitsReply(speech: string): boolean {
  const trimmed = speech.trim();
  if (trimmed === '') return false;
  return ASK_MARKERS.some((word) => trimmed.includes(word));
}

/** 只挡形态：空、超长、阿拉伯数字。语义委派交给模型的 `[[DELEGATE]]`。 */
export function isFastCandidate(text: string, maxChars = 14): boolean {
  const core = text.replace(/[\s。.,，!！?？、~～…\-—]/g, '');
  if (core.length === 0 || core.length > maxChars) return false;
  return !/[0-9０-９]/.test(core);
}

type InnerMode = 'pass' | 'buffer' | 'drop';

export interface CascadeAgentOptions {
  readonly inner: AgentProvider;
  /** 空串 = 快车道关着，短句也进 dsh */
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly totalMs?: number;
  readonly maxChars?: number;
  /** 攒满这么多轮快车道回答就强制交给 dsh。`0` = 不因计数强制转交 */
  readonly keepTurns?: number;
  readonly speculate?: boolean;
  readonly delegateEnabled?: boolean;
  readonly hedge?: number;
  readonly prefetch?: boolean;
  readonly partialSpeculate?: boolean;
  readonly cancelMode?: 'rpc' | 'interrupt' | 'off';
  readonly taskStatus?: () => string;
  readonly memory?: (userText: string) => readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly windowChars?: number;
  readonly specMinChars?: number;
  readonly audit?: (name: string, data: Record<string, unknown>) => void;
}

export interface CascadeEngineOptions {
  /** `firstSynthAtMs` 用的时钟。缺省跟 agent 的 `now` 同一把 */
  readonly now?: () => number;
}

/**
 * 纯级联 agent。实现 {@link AgentProvider} 里级联用得到的可选方法；
 * 音频直出那一组不在这个类上。
 */
export class CascadeAgent implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly apiKey: string;
  private readonly llm: FastLlmClient;
  private readonly slots: PrefetchSlot;
  private readonly maxChars: number;
  private readonly keepTurns: number;
  private readonly pendingCap: number;
  private droppedTurns = 0;
  private reportedDropped = 0;
  private readonly windowChars: number;
  private readonly specMinChars: number;
  private readonly speculate: boolean;
  private readonly delegateEnabled: boolean;
  private readonly prefetchEnabled: boolean;
  private readonly partialSpeculate: boolean;
  private speculateStarts = 0;
  private readonly cancelMode: 'rpc' | 'interrupt' | 'off';
  private readonly statusFacts: (() => string) | undefined;
  private readonly memory: ((userText: string) => readonly string[]) | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly auditSink: (name: string, data: Record<string, unknown>) => void;
  private sentPending: string[] = [];
  private readonly pending: string[] = [];
  private readonly history: Array<{ who: 'user' | 'you' | 'dsh'; text: string }> = [];
  private readonly ledger = new ConversationLedger();
  private sink: ((text: string) => void) | null = null;
  private delegateHook: ((reason: DelegateReason) => void) | null = null;
  private innerMode: InnerMode = 'pass';
  private readonly buffered: string[] = [];
  /** 这一轮已经对用户出过声、正在等 dsh。插话时放手而不是取消 */
  private delegating = false;
  private currentGen = -1;
  private currentTicket: TurnTicket | null = null;
  private localGen = 0;
  private cancelledKey: string | null = null;
  private turnStartedAt = 0;

  constructor(options: CascadeAgentOptions) {
    this.inner = options.inner;
    this.apiKey = options.apiKey ?? '';
    this.maxChars = options.maxChars ?? 14;
    this.keepTurns = options.keepTurns ?? 4;
    this.pendingCap = Math.max(8, this.keepTurns > 0 ? this.keepTurns * 4 : 16);
    this.windowChars = Math.max(200, options.windowChars ?? WINDOW_CHARS);
    this.specMinChars = Math.max(1, options.specMinChars ?? SPEC_MIN_CHARS);
    this.speculate = options.speculate ?? true;
    this.delegateEnabled = options.delegateEnabled ?? true;
    this.prefetchEnabled = options.prefetch ?? true;
    this.partialSpeculate = options.partialSpeculate ?? true;
    this.cancelMode = options.cancelMode ?? 'rpc';
    this.statusFacts = options.taskStatus;
    this.memory = options.memory;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.auditSink = (name, data) => {
      try {
        options.audit?.(name, data);
      } catch {
        // 审计失败不能把这一轮带下水
      }
    };
    this.llm = new FastLlmClient({
      apiKey: this.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      totalMs: options.totalMs,
      hedge: options.hedge,
      delegateEnabled: this.delegateEnabled,
      fetchImpl: options.fetchImpl,
      now: this.now,
      log: this.log,
      audit: this.auditSink,
    });
    this.slots = new PrefetchSlot({
      now: this.now,
      log: this.log,
      audit: this.auditSink,
      ask: (text, startedAt, emit, kind) => this.llm.ask({
        userText: text,
        startedAt,
        emit,
        kind,
        messages: this.messages(text),
      }),
      abortOf: () => this.llm.abortHandle,
    });
    this.inner.setDetachedAnswerSink?.((userText, answer, spoken) => {
      this.onDetachedAnswer(userText, answer, spoken);
    });
  }

  get name(): string {
    return this.inner.name;
  }

  get sessionId(): string | null | undefined {
    return this.inner.sessionId;
  }

  /** 已结束的轮次（只读）。结算与路由都读同一本 {@link ConversationLedger} */
  get ledgerTurns(): readonly LedgerTurn[] {
    return this.ledger.recent(this.ledger.size);
  }

  attachLiveSink(sink: ((text: string) => void) | null): void {
    this.sink = sink;
    if (sink === null) {
      this.innerMode = 'pass';
      this.buffered.length = 0;
      this.inner.attachLiveSink?.(null);
      return;
    }
    this.inner.attachLiveSink?.((text) => {
      if (this.innerMode === 'drop') return;
      if (this.innerMode === 'buffer') {
        this.buffered.push(text);
        return;
      }
      sink(text);
    });
  }

  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.inner.setAnnouncer?.(cb);
  }

  setDetachedAnswerSink(
    cb: ((userText: string, answer: string, spoken: boolean) => void) | null,
  ): void {
    this.inner.setDetachedAnswerSink?.(cb);
  }

  setDelegateHook(cb: ((reason: DelegateReason) => void) | null): void {
    this.delegateHook = cb;
  }

  reconcileTurnOutcome(info: {
    readonly ticket: { readonly no: number; readonly gen: number };
    readonly truncated: boolean;
    readonly endedAtMs: number;
  }): void {
    this.ledger.reconcileOutcome(info.ticket, info.truncated, info.endedAtMs);
  }

  /** `pet` 不是「谁答了用户」，按没有上文处理 */
  lastLedgerLane(): 'live' | 'cascade' | 'dsh' | null {
    const answered = this.ledger.lastAnsweredLane();
    if (answered === null || answered === 'pet') return null;
    return answered;
  }

  prefetch(text: string): boolean {
    if (!this.prefetchEnabled) return this.slots.has;
    if (this.slots.text === text) return true;
    if (this.slots.confirmSpeculation(text, this.specMinChars)) {
      this.speculateStarts = 0;
      return true;
    }
    this.speculateStarts = 0;
    if (!this.isPrefetchable(text)) return false;
    this.slots.start(text, false);
    return true;
  }

  speculatePartial(text: string): boolean {
    if (!this.prefetchEnabled || !this.partialSpeculate) return false;
    const trace = process.env['FAST_LANE_TRACE'] === '1';
    if (normalizeForCompare(text).length < this.specMinChars) {
      if (trace) this.log(`  快车道    投机跳过：中间结果太短 ${JSON.stringify(text)}`);
      return false;
    }
    if (this.slots.has) {
      if (!this.slots.speculative) return true;
      if (this.slots.text === text) return true;
      const running = this.slots.text ?? '';
      if (!text.startsWith(running) || text.length <= running.length) {
        this.slots.drop(`中间结果被改写（${JSON.stringify(running)} → ${JSON.stringify(text)}）`);
        this.speculateStarts = 0;
        return false;
      }
      if (this.speculateStarts >= 2) return true;
    }
    if (this.speculateStarts >= 2) return this.slots.has && this.slots.speculative;
    if (!this.isPrefetchable(text)) {
      if (trace) this.log(`  快车道    投机跳过：不是快车道候选 ${JSON.stringify(text)}`);
      return false;
    }
    this.speculateStarts += 1;
    this.slots.start(text, true);
    return true;
  }

  dropPrefetch(why: string): void {
    this.llm.abortCurrent(new Error(why));
    this.slots.drop(why);
    this.speculateStarts = 0;
  }

  cancelTurn(ticket?: TurnTicket): void {
    const current = this.currentTicket;
    if (ticket !== undefined
      && (current === null || current.no !== ticket.no || current.gen !== ticket.gen)) {
      return;
    }
    this.llm.abortCurrent(new Error('插话取消'));
    try {
      if (this.delegating) this.inner.detachTurn?.(ticket);
      else this.inner.cancelTurn?.(ticket);
    } catch (error) {
      this.log(`  快车道    ✗ 取消失败：${(error as Error).message}`);
    }
  }

  async reply(
    userText: string,
    image?: AgentImage,
    note?: string,
    turn?: TurnContext,
  ): Promise<AgentReplyView> {
    const ticket: TurnTicket = turn?.ticket ?? { no: 0, gen: (this.localGen += 1) };
    // 任何 await 之前先钉上票据，插话取消才能对上这一轮（委派轮也一样）
    this.speculateStarts = 0;
    this.turnStartedAt = this.now();
    this.currentGen = ticket.gen;
    this.currentTicket = ticket;
    this.innerMode = 'pass';
    if (turn?.forceDelegate !== undefined) {
      this.log(`  快车道    宿主指定转交（${turn.forceDelegate}）`);
      return await this.delegate(userText, image, note, ticket, turn.forceDelegate, {
        silent: turn.receiptSpoken === true,
      });
    }
    if (isCancelRequest(userText) && this.cancelRunningTask()) {
      return { text: '好，不查了。', speech: '好，不查了。', path: 'fast' };
    }
    const route = this.decisionFor(userText);
    const hasFacts = this.statusFacts !== undefined;
    const candidate = this.apiKey !== ''
      && image === undefined
      && (isFastCandidate(userText, this.maxChars) || (hasFacts && isStatusQuestion(userText)));
    const overCap = this.keepTurns > 0 && this.pending.length / 2 >= this.keepTurns;
    const pre = this.slots.take(
      userText,
      route.lane === 'cascade' && image === undefined && candidate && !overCap,
    );
    if (image !== undefined) {
      return await this.delegate(userText, image, note, ticket, 'task');
    }
    if (route.lane === 'dsh') {
      const why: DelegateReason = route.why === 'dsh-awaiting'
        ? 'answer'
        : route.why === 'memorable'
          ? 'memory'
          : 'task';
      if (route.why === 'dsh-awaiting') {
        this.log('  快车道    上一轮 dsh 在等回话，这句直接交给 dsh');
      } else if (route.why === 'memorable') {
        this.log('  快车道    像长期事实，交给 dsh 自己判断要不要记');
      } else if (route.why === 'stick-to-dsh') {
        this.log('  快车道    接着上一轮 dsh 的追问，继续交给 dsh');
      } else if (route.why === 'action') {
        this.log('  快车道    这一轮要动手（有副作用），只有 dsh 能做');
      }
      return await this.delegate(userText, image, note, ticket, why);
    }
    if (!candidate) {
      return await this.delegate(userText, image, note, ticket, 'task');
    }
    if (overCap) {
      this.log('  快车道    攒满上限，这一轮强制交给 dsh（顺便刷上下文）');
      return await this.delegate(userText, image, note, ticket, 'overcap');
    }

    const startedAt = this.now();
    let emitted = '';
    let dsh: Promise<AgentReplyView> | null = null;
    const push = (text: string): void => {
      emitted += text;
      // 已经出口的字收不回来，这一刻就掐掉在途的 dsh
      if (dsh !== null) this.cancelInner(ticket);
      this.sink?.(text);
    };
    if (this.speculate) {
      this.innerMode = 'buffer';
      dsh = this.startInner(userText, image, note, ticket);
      dsh.catch(() => undefined);
    }

    let answer: FastAnswer;
    try {
      if (pre !== null) {
        pre.attach(push);
        answer = await pre.answer;
      } else {
        answer = await this.llm.ask({
          userText,
          startedAt,
          emit: push,
          kind: 'live',
          messages: this.messages(userText),
        });
      }
    } catch (error) {
      const why = (error as Error).message;
      if (emitted !== '') {
        this.log(`  快车道    ✗ ${why}（已播出一部分，按现有文本收下）`);
        dsh?.catch(() => undefined);
        return this.commit(userText, emitted, 0, dsh, ticket);
      }
      const reason: DelegateReason = why.includes('超时') ? 'timeout' : 'error';
      const spent = (this.now() - startedAt).toFixed(0);
      return await this.abandon(
        dsh, userText, image, note, `✗ ${why}（快车道已耗 ${spent} ms）`, ticket, reason,
      );
    }

    if (answer.delegated) {
      return await this.abandon(
        dsh, userText, image, note, `判为需要 dsh（${answer.firstTokenMs} ms 早退）`, ticket, 'delegate',
      );
    }
    if (cleanForSpeech(parseEmotion(answer.text).rest) === '') {
      return await this.abandon(dsh, userText, image, note, '空答复', ticket, 'empty');
    }
    return this.commit(userText, answer.text, answer.firstTokenMs, dsh, ticket);
  }

  /**
   * 热路径引擎：`reply()` 增量边到边合成。
   *
   * `synthesizeStream` 抛错时退回 `synthesize(reply.speech, reply.emotion)`，
   * 这一轮仍然以 `done` 结束。`AbortSignal` 会立刻停流并
   * `cancelTurn` + `dropPrefetch('barge_in')`。
   */
  toEngine(tts: TtsProvider, opts?: CascadeEngineOptions): FastVoiceEngine {
    return new CascadeTurnEngine({
      agent: this,
      tts,
      now: opts?.now ?? this.now,
      ready: this.apiKey !== '',
      log: this.log,
    });
  }

  /** `live` 恒为 `'off'`。上一轮谁答的只问账本（`pet` 折成没有上文） */
  private decisionFor(text: string): RouteDecision {
    return routeTurn(text, {
      live: 'off',
      cascade: this.apiKey !== '',
      dshAwaiting: this.lastDsh?.asked === true,
      lastLane: this.lastLedgerLane(),
    });
  }

  private get lastDsh(): { speech: string; asked: boolean } | null {
    const last = this.ledger.lastAnswered();
    if (last === null || last.lane !== 'dsh') return null;
    return { speech: last.assistantText, asked: awaitsReply(last.assistantText) };
  }

  /** 预跑与投机共用这一道闸，文本形态不够就不发请求 */
  private isPrefetchable(text: string): boolean {
    return this.textEligible(text);
  }

  private textEligible(text: string): boolean {
    if (this.apiKey === '') return false;
    if (this.lastDsh?.asked === true && looksLikeAnswer(text)) return false;
    if (looksMemorable(text)) return false;
    if (!isFastCandidate(text, this.maxChars)) return false;
    if (this.keepTurns > 0 && this.pending.length / 2 >= this.keepTurns) return false;
    return true;
  }

  private reportDelegate(reason: DelegateReason): void {
    if (this.delegateHook === null) return;
    try {
      this.delegateHook(reason);
    } catch (error) {
      this.log(`  快车道    ✗ 回执钩子失败：${(error as Error).message}`);
    }
  }

  private commit(
    userText: string,
    raw: string,
    firstTokenMs: number,
    dsh: Promise<AgentReplyView> | null,
    ticket: TurnTicket,
  ): AgentReplyView {
    this.innerMode = 'drop';
    this.buffered.length = 0;
    if (dsh !== null) {
      this.cancelInner(ticket);
      dsh.then(
        () => {
          this.log('  快车道    慢车道那一轮已作废');
          this.inner.rollbackTurn?.(ticket);
        },
        () => undefined,
      );
    }
    const { emotion, rest } = parseEmotion(raw);
    const speech = cleanForSpeech(rest);
    this.recordSaid(userText, speech, 'cascade', false, ticket);
    this.log(`  快车道    ${firstTokenMs} ms 首字（流式） ：${JSON.stringify(speech)}`);
    return { text: raw, speech, firstTokenMs, emotion, path: 'fast' };
  }

  private remember(userText: string, said: string): void {
    this.pushHistory('user', userText);
    this.pushHistory('you', said);
    this.trim();
  }

  private recordSaid(
    userText: string,
    speech: string,
    lane: LedgerLane,
    truncated: boolean,
    ticket?: TurnTicket,
  ): void {
    this.pending.push(`用户: ${userText.trim()}`, `你: ${speech}`);
    while (this.pending.length / 2 > this.pendingCap) {
      this.pending.splice(0, 2);
      this.droppedTurns += 1;
    }
    if (this.droppedTurns > 0 && this.droppedTurns !== this.reportedDropped) {
      this.auditSink(EVENTS.agentTrim, {
        dropped_turns: this.droppedTurns,
        cap_turns: this.pendingCap,
      });
      this.reportedDropped = this.droppedTurns;
    }
    this.remember(userText, speech);
    this.ledger.record({
      userText,
      assistantText: speech,
      lane,
      truncated,
      endedAtMs: this.now(),
      ...(ticket === undefined ? {} : { ticket: { no: ticket.no, gen: ticket.gen } }),
    });
  }

  private pushHistory(who: 'user' | 'you' | 'dsh', text: string): void {
    const clean = text.trim();
    if (clean === '') return;
    this.history.push({ who, text: clean });
  }

  private trim(): void {
    const chars = (): number => this.history.reduce((sum, turn) => sum + turn.text.length, 0);
    while (
      this.history.length >= 2
      && (this.history.length > WINDOW_MESSAGES || chars() > this.windowChars)
    ) {
      this.history.splice(0, 2);
    }
  }

  private cancelInner(ticket: TurnTicket): void {
    const key = `${ticket.no}:${ticket.gen}`;
    if (ticket.gen !== this.currentGen || this.cancelledKey === key) return;
    this.cancelledKey = key;
    if (this.sentPending.length > 0) {
      this.pending.unshift(...this.sentPending);
      this.log(`  快车道    这一轮掐掉了 dsh → ${this.sentPending.length / 2} 轮闲聊留到下次同步`);
      this.sentPending = [];
    }
    try {
      if (this.cancelMode === 'interrupt') this.inner.interruptTurn?.();
      else if (this.cancelMode === 'rpc') this.inner.cancelTurn?.(ticket);
    } catch (error) {
      this.log(`  快车道    ✗ 取消失败：${(error as Error).message}`);
    }
  }

  private async abandon(
    dsh: Promise<AgentReplyView> | null,
    userText: string,
    image: AgentImage | undefined,
    note: string | undefined,
    why: string,
    ticket: TurnTicket,
    reason: DelegateReason,
  ): Promise<AgentReplyView> {
    this.log(`  快车道    ${why} → 交给 dsh`);
    this.reportDelegate(reason);
    if (dsh !== null) this.log('  dsh 沿用开轮时就起跑的那一趟（不另起）');
    const promise = dsh ?? this.startInner(userText, image, note, ticket);
    this.innerMode = 'pass';
    const held = this.buffered.splice(0);
    for (const text of held) this.sink?.(text);
    const answer = await promise;
    this.rememberDsh(answer.speech, userText, ticket);
    return { ...answer, path: 'dsh', delegate: reason };
  }

  private async delegate(
    userText: string,
    image: AgentImage | undefined,
    note: string | undefined,
    ticket: TurnTicket,
    reason: DelegateReason,
    opts?: { silent?: boolean },
  ): Promise<AgentReplyView> {
    this.innerMode = 'pass';
    if (opts?.silent !== true) this.reportDelegate(reason);
    this.delegating = opts?.silent === true;
    try {
      const answer = await this.startInner(userText, image, note, ticket);
      if (answer.speech !== '') this.rememberDsh(answer.speech, userText, ticket);
      return { ...answer, path: 'dsh', delegate: reason };
    } finally {
      this.delegating = false;
    }
  }

  private cancelRunningTask(): boolean {
    if (this.inner.dshBusy?.() !== true) return false;
    this.log('  委派    用户显式下令取消 → 取消 dsh 手上那一轮');
    try {
      this.inner.cancelTurn?.();
    } catch (error) {
      this.log(`  委派    ✗ 取消失败：${(error as Error).message}`);
    }
    return true;
  }

  private onDetachedAnswer(userText: string, answer: string, spoken: boolean): void {
    const speech = cleanForSpeech(parseEmotion(answer).rest);
    if (speech === '') return;
    const question = userText.trim() === '' ? '（上一轮被打断的问题）' : userText.trim();
    this.log(
      `  委派    放手的答案回来了（${[...speech].length} 字，${spoken ? '会补播' : '不补播'}） → 回注记忆`,
    );
    this.rememberDsh(speech, question);
  }

  private rememberDsh(speech: string, userText: string, ticket?: TurnTicket): void {
    this.sentPending.length = 0;
    const last = this.history.at(-1);
    if (last?.who !== 'user' || last.text !== userText.trim()) {
      this.pushHistory('user', userText);
    }
    this.pushHistory('dsh', speech);
    this.trim();
    this.ledger.record({
      userText,
      assistantText: speech,
      lane: 'dsh',
      truncated: false,
      endedAtMs: this.now(),
      ...(ticket === undefined ? {} : { ticket: { no: ticket.no, gen: ticket.gen } }),
    });
  }

  private startInner(
    userText: string,
    image: AgentImage | undefined,
    note: string | undefined,
    ticket: TurnTicket,
  ): Promise<AgentReplyView> {
    this.log(`  dsh 起跑（距开轮 ${Math.max(0, Math.round(this.now() - this.turnStartedAt))} ms）`);
    const blocks: string[] = [];
    if (note !== undefined) blocks.push(note);
    if (this.sentPending.length > 0) {
      this.pending.unshift(...this.sentPending);
      this.sentPending = [];
    }
    if (this.pending.length > 0) {
      const lost = this.inner.takeRollbackOutcome?.() === 'failed';
      blocks.push([
        lost
          ? '（下面几轮是刚才的对话。有几轮**你已经答完了，但用户没听到你的回答** ——'
            + '用户实际听到的是每一对里「你」那一行；当作已知上下文即可）'
          : '（下面几轮是刚才由快车道直接答给用户的，没有经过你的会话；当作已知上下文即可）',
        ...this.pending,
      ].join('\n'));
      this.sentPending = this.pending.slice();
      this.pending.length = 0;
      this.log(
        `  快车道    ${this.sentPending.length / 2} 轮闲聊随这一轮送进 dsh`
        + `${lost ? '（含「你那轮没被听到」的说明）' : ''}`,
      );
    }
    if (blocks.length === 0) {
      return this.inner.reply(userText, image, note, { ticket });
    }
    return this.inner.reply(userText, image, blocks.join('\n\n'), { ticket });
  }

  private systemPrompt(userText: string): string {
    const parts: string[] = [
      this.delegateEnabled ? SYSTEM_PROMPT_WITH_DELEGATE : SYSTEM_PROMPT_PLAIN,
    ];
    let memories: readonly string[] = [];
    try {
      memories = this.memory?.(userText) ?? [];
    } catch {
      memories = [];
    }
    if (memories.length > 0) {
      parts.push(`【长期记忆（由 dsh 维护，你只能读）】${memories.join('；')}`);
      parts.push(this.delegateEnabled
        ? '【长期记忆】里已经写明的事（称呼、住处、偏好这类），直接用记忆照实回答，**不要委派**；记忆里没有的才 [[DELEGATE]]。'
        : '【长期记忆】里已经写明的事（称呼、住处、偏好这类），直接用记忆照实回答；记忆里没有的就说没印象，别编。');
    } else {
      parts.push(this.delegateEnabled
        ? '只依据上面的对话和长期记忆回答；问到更早的事就 [[DELEGATE]]。'
        : '只依据上面的对话和长期记忆回答；问到更早的事就说没印象，别编。');
    }
    let facts = '';
    try {
      facts = this.statusFacts?.() ?? '';
    } catch {
      facts = '';
    }
    if (facts !== '') {
      parts.push((this.delegateEnabled ? TASK_RULE : TASK_RULE_PLAIN).trim(), facts);
    }
    return parts.join('\n');
  }

  private messages(userText: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: this.systemPrompt(userText) },
    ];
    for (const turn of this.history) {
      out.push({ role: turn.who === 'user' ? 'user' : 'assistant', content: turn.text });
    }
    out.push({ role: 'user', content: userText });
    return out;
  }
}

interface EngineDeps {
  readonly agent: CascadeAgent;
  readonly tts: TtsProvider;
  readonly now: () => number;
  readonly ready: boolean;
  readonly log: (line: string) => void;
}

function asBuffer(pcm: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function imageOf(turn: TurnInput): AgentImage | undefined {
  if (turn.image === undefined) return undefined;
  return { mimeType: turn.image.mime, data: turn.image.bytes.toString('base64') };
}

/** 文本与音频进同一条队列，消费端看到的就是到达顺序 */
class EventQueue implements AsyncIterable<EngineEvent> {
  private readonly pending: EngineEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: EngineEvent): void {
    if (this.closed) return;
    this.pending.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  close(): void {
    this.closed = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent, void> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * `CascadeAgent.toEngine` 的泵：内核只看见 {@link FastVoiceEngine}。
 * 问话仍走 agent 的 `reply()`（路由、投机、账本都在那里），这里只负责合成。
 */
class CascadeTurnEngine implements FastVoiceEngine {
  readonly mode = 'cascade' as const;

  private readonly agent: CascadeAgent;
  private readonly tts: TtsProvider;
  private readonly now: () => number;
  private readonly ready: boolean;
  private readonly log: (line: string) => void;

  constructor(deps: EngineDeps) {
    this.agent = deps.agent;
    this.tts = deps.tts;
    this.now = deps.now;
    this.ready = deps.ready;
    this.log = deps.log;
  }

  isHealthy(): boolean {
    return this.ready;
  }

  onAsrPartial(text: string, commitSeq: number): void {
    void commitSeq;
    this.agent.speculatePartial(text);
  }

  onAsrFinal(text: string, commitSeq: number): void {
    void commitSeq;
    this.agent.prefetch(text);
  }

  abortSpeculation(reason: 'delegated' | 'superseded' | 'barge_in'): void {
    this.agent.dropPrefetch(reason);
  }

  async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    const queue = new EventQueue();
    const running = this.drive(turn, signal, queue);
    running.catch(() => {
      queue.close();
    });
    for await (const event of queue) {
      if (signal.aborted) break;
      yield event;
    }
  }

  private async drive(turn: TurnInput, signal: AbortSignal, queue: EventQueue): Promise<void> {
    const tokens = new TokenQueue();
    let streamedRaw = '';
    let firstSynthAtMs: number | undefined;
    const markSynth = (): void => {
      if (firstSynthAtMs === undefined) firstSynthAtMs = this.now();
    };
    const onAbort = (): void => {
      tokens.close();
      this.agent.cancelTurn(turn.ticket);
      this.agent.dropPrefetch('barge_in');
      queue.close();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const stream = this.tts.synthesizeStream;
      const pump = stream === undefined
        ? new SentencePump({
          synthesize: (sentence, emotion) => this.tts.synthesize(sentence, emotion),
          onChunk: (pcm) => {
            queue.push({ type: 'audio', pcm: asBuffer(pcm), sampleRate: this.tts.sampleRate });
          },
          clean: cleanForSpeech,
          resolveEmotion: (raw) => parseEmotion(raw).emotion,
          onFirstSentence: markSynth,
          isStale: () => signal.aborted,
          log: this.log,
        })
        : null;

      this.agent.attachLiveSink((delta) => {
        if (signal.aborted || delta === '') return;
        streamedRaw += delta;
        markSynth();
        queue.push({ type: 'text', delta });
        if (pump !== null) pump.push(delta);
        else tokens.push(delta);
      });

      let streamFailed = false;
      const streaming = (async (): Promise<void> => {
        if (pump !== null || stream === undefined) return;
        try {
          await this.playIterable(stream.call(this.tts, tokens), signal, queue);
        } catch (error) {
          streamFailed = true;
          this.log(`  流式    ✗ ${(error as Error).message}，退回整段合成`);
        }
      })();

      let reply: AgentReplyView | null = null;
      try {
        reply = await this.agent.reply(
          turn.text,
          imageOf(turn),
          turn.note,
          turn.ticket === undefined ? undefined : { ticket: turn.ticket },
        );
      } catch (error) {
        this.log(`  级联    ✗ ${(error as Error).message}`);
        reply = null;
      } finally {
        this.agent.attachLiveSink(null);
        tokens.close();
      }

      if (pump !== null && reply !== null && !signal.aborted) {
        try {
          await pump.drain(reply.speech);
        } catch (error) {
          this.log(`  流式    ✗ 逐句合成失败：${(error as Error).message}`);
        }
      }
      await streaming;
      if (signal.aborted) return;

      if (streamFailed && reply !== null) {
        markSynth();
        try {
          await this.playIterable(this.tts.synthesize(reply.speech, reply.emotion), signal, queue);
        } catch (error) {
          this.log(`  流式    ✗ 整段合成失败：${(error as Error).message}`);
        }
      }
      if (signal.aborted) return;
      this.emitTail(queue, reply, streamedRaw, firstSynthAtMs);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private emitTail(
    queue: EventQueue,
    reply: AgentReplyView | null,
    streamedRaw: string,
    firstSynthAtMs: number | undefined,
  ): void {
    if (reply === null) {
      const speech = cleanForSpeech(parseEmotion(streamedRaw).rest);
      queue.push({ type: 'done', fullText: streamedRaw, speech });
      queue.close();
      return;
    }
    // 多步答复：流里是每一步拼起来的全文，`reply.speech` 往往只是最后一步
    const raw = streamedRaw !== '' ? streamedRaw : reply.text;
    const streamedSpeech = cleanForSpeech(parseEmotion(raw).rest);
    const speech = streamedSpeech !== '' ? streamedSpeech : reply.speech;
    queue.push({
      type: 'meta',
      ...(reply.path === undefined ? {} : { path: reply.path }),
      ...(reply.firstTokenMs === undefined ? {} : { firstTokenMs: reply.firstTokenMs }),
      ...(firstSynthAtMs === undefined ? {} : { firstSynthAtMs }),
      ...(reply.delegate === undefined ? {} : { delegate: reply.delegate }),
    });
    queue.push({ type: 'done', fullText: raw, speech });
    queue.close();
  }

  private async playIterable(
    iterable: AsyncIterable<Buffer>,
    signal: AbortSignal,
    queue: EventQueue,
  ): Promise<void> {
    const aborted = whenAborted(signal);
    const iter = iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (signal.aborted) return;
        const guarded = iter.next().then(
          (step) => ({ ok: true as const, step }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const winner = await Promise.race([
          guarded.then((value) => ({ kind: 'step' as const, value })),
          aborted.then(() => ({ kind: 'aborted' as const })),
        ]);
        if (winner.kind === 'aborted' || signal.aborted) return;
        if (!winner.value.ok) throw winner.value.error;
        if (winner.value.step.done === true) return;
        queue.push({
          type: 'audio',
          pcm: asBuffer(winner.value.step.value),
          sampleRate: this.tts.sampleRate,
        });
      }
    } finally {
      if (signal.aborted) void iter.return?.().catch(() => undefined);
    }
  }
}
