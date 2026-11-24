/**
 * Pure Live 的扁平编排。`VOICE_PIPELINE=live` 时只用这一条。
 *
 * 前台只有 omni 一副嗓子。dsh 在后台执行工具、识图、记忆写入，以及它自己的
 * `run_in_background` / 子代理；完成品经 {@link BackgroundTaskBus} 回到同一条
 * 会话里说出来。
 *
 * 不走文本快车道，不做投机预跑，也不把后台任务退回另一副嗓子。
 * 整段会话只有在 omni 接不上（没车道，`willServe()` 为假，且
 * `answerFromText()` 也拿不到答案）时才同步问 dsh，
 * 再用本层的 TTS 把那句说出来 —— 那是断线兜底，不是第二条人格。
 */
import { BackgroundTaskBus } from '../background-task-bus.ts';
import { ConversationLedger, type LedgerTurn } from '../conversation-ledger.ts';
import type { AudioFrame, EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import { LiveVoiceEngine, streamLiveAnswer, type LiveAudioLane } from '../engines/live-voice-engine.ts';
import type { TurnTicket } from '../kernel.ts';
import { LIVE_BACKEND_TASK_DIRECTIVE, buildLiveReportPrompt } from '../persona.ts';
import type {
  AgentAudioAnswer,
  AgentImage,
  AgentProvider,
  AgentReplyView,
  BackgroundTaskReport,
  FastLaneAudioLane,
  TtsProvider,
  TurnContext,
} from '../providers.ts';
import {
  isActionRequest,
  isCancelRequest,
  isClockTimeRequest,
  isRealtimeFactRequest,
  looksMemorable,
} from '../turn-router.ts';

/** 用户明说取消时的短确认。只在真有要汇报的后台任务时说。 */
const CANCEL_LINE = '好，不查了。';
/** 识图轮的短回执。图是 dsh 看的，omni 没看见，所以先把在途音频丢掉。 */
const PHOTO_LINE = '我看看。';
/** omni 决定转交但一个采样都没吐时的垫话，避免用户对着静音干等。 */
const DELEGATE_LINE = '我查查。';

export interface LiveOrchestratorOptions {
  /** 后台执行器（dsh） */
  readonly inner: AgentProvider;
  /** 仅用于短回执（omni 0 字节委派 / 识图应声 / 取消确认）与断线兜底 */
  readonly tts: TtsProvider;
  /** 建连时可读一次的长期记忆摘要，用于拼入后台注记或观测 */
  readonly memory?: (text: string) => string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** 可选：自定义 dsh 后台任务指令（默认 {@link LIVE_BACKEND_TASK_DIRECTIVE}） */
  readonly backendDirective?: string;
}

interface SpokenItem {
  readonly speech: string;
  readonly emotion?: string;
  readonly taskId?: string;
  readonly query?: string;
  readonly verbatim?: boolean;
  readonly needsConfirm?: string;
}

interface FallbackItem {
  readonly speech: string;
  readonly taskId?: string;
  readonly query?: string;
}

type MetaEvent = Extract<EngineEvent, { type: 'meta' }>;

/**
 * `TurnInput` 的图是原始字节，dsh 要的是 base64。两边都不是对方的类型，
 * 漏转换会在 `tsc` 被拦住，所以只在这一处做。
 */
function toAgentImage(turn: TurnInput): AgentImage | undefined {
  const image = turn.image;
  if (image === undefined) return undefined;
  return { mimeType: image.mime, data: image.bytes.toString('base64') };
}

function turnContext(turn: TurnInput): TurnContext | undefined {
  if (turn.ticket === undefined) return undefined;
  return { ticket: turn.ticket };
}

function asBuffer(pcm: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
}

/** 已中止立刻兑现。调用方在 `finally` 里摘掉监听，避免一轮挂一个永久回调。 */
function whenAborted(signal: AbortSignal): { readonly done: Promise<void>; cancel(): void } {
  if (signal.aborted) {
    return { done: Promise.resolve(), cancel() {} };
  }
  let onAbort: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    onAbort = () => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    done,
    cancel() {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 这一轮前台怎么走。纯函数：不派单、不碰车道。
 *
 * `live_with_bg_guard` 是「Omni 还能开口，但这句要查外部或要动手」。
 * 调用方必须等 Omni 的 `delegate`：有改写查询就按 `tool_call` 派，
 * 整段结束仍没有 `delegate` 才用原话补 `early_rule`。
 * 不能在进 Omni 之前同步派单 —— 总线工人晚一个微任务就开跑，
 * 改写查询赶不上，dsh 会拿着 ASR 原话跑完。
 */
export type LiveTurnDecision =
  | 'photo_delegate'
  | 'cancel_bg'
  | 'clock_override'
  | 'fallback_dsh'
  | 'live_with_bg_guard'
  | 'live_direct';

export interface LiveTurnFacts {
  readonly text: string;
  /** 本轮带了图，并且字节在场 */
  readonly hasImage: boolean;
  /** 这句话是取消，且总线上还有要汇报的任务 */
  readonly cancelActive: boolean;
  /** 识图可以丢给后台（车道还能开口，或至少还能播汇报） */
  readonly photoHandOff: boolean;
  /** 封段健康，或 `canAnswerText()` 为真。钟点覆盖只认这个，不认「方法在不在」 */
  readonly laneCanAnswer: boolean;
  /** `willServe()`：走封段认领 */
  readonly willServe: boolean;
  /** 没封段时 `answerFromText` 在场。返回 null 由调用方再降级 */
  readonly canTryText: boolean;
}

export function decideLiveTurn(facts: LiveTurnFacts): LiveTurnDecision {
  if (facts.cancelActive) return 'cancel_bg';
  if (facts.hasImage) return facts.photoHandOff ? 'photo_delegate' : 'fallback_dsh';
  if (isClockTimeRequest(facts.text)) {
    return facts.laneCanAnswer ? 'clock_override' : 'fallback_dsh';
  }
  const guard = isActionRequest(facts.text) || isRealtimeFactRequest(facts.text);
  if (facts.willServe || facts.canTryText) {
    return guard ? 'live_with_bg_guard' : 'live_direct';
  }
  return 'fallback_dsh';
}

/** 显式原因，以及内核包过一层的 `内核中止(barge_in)` 这种字符串。 */
function dropReason(why: string): 'barge_in' | 'delegated' | 'superseded' | null {
  if (why === 'barge_in' || why.endsWith('barge_in)')) return 'barge_in';
  if (why === 'delegated' || why.endsWith('delegated)')) return 'delegated';
  if (why === 'superseded' || why.endsWith('superseded)')) return 'superseded';
  return null;
}

/**
 * `VOICE_PIPELINE=live` 的唯一前台。
 *
 * 热路径是 {@link LiveOrchestrator.toEngine}。`reply()` 留给保活和无音频调用方，
 * 语音轮次不走它。
 */
export class LiveOrchestrator implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly tts: TtsProvider;
  private readonly memory: ((text: string) => string) | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly backendDirective: string;
  private readonly bus: BackgroundTaskBus;
  private readonly ledger = new ConversationLedger();
  private readonly pendingReports = new Map<string, BackgroundTaskReport>();
  private readonly injectedTaskIds = new Set<string>();

  private audioLane: LiveAudioLane | null = null;
  private taskReporter: ((report: BackgroundTaskReport) => void) | null = null;
  private announcer: ((speech: string, emotion?: string) => void) | null = null;
  /** 同步兜底那一次 `inner.reply` 还在等。插话只取消这一次，不取消后台总线。 */
  private foregroundActive = false;
  /** 正在等的那一次兜底的票据。对不上的 `cancelTurn` 直接丢掉。 */
  private activeForegroundTicket: TurnTicket | null = null;
  /** `dispose()` 之后所有异步恢复点都停在这里，不再派单、不再开口。 */
  private disposed = false;

  constructor(options: LiveOrchestratorOptions) {
    this.inner = options.inner;
    this.tts = options.tts;
    this.memory = options.memory;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.backendDirective = options.backendDirective ?? LIVE_BACKEND_TASK_DIRECTIVE;
    this.bus = new BackgroundTaskBus({
      now: this.now,
      log: this.log,
      runner: {
        execute: async (req) => {
          const reply = await this.inner.reply(
            req.query,
            req.image,
            this.composeBackendNote(this.backendDirective, req.note, req.query),
          );
          return { text: reply.text, speech: reply.speech, emotion: reply.emotion };
        },
        cancelRunning: () => {
          this.inner.cancelTurn?.();
        },
      },
      onReport: (report) => {
        this.pendingReports.set(report.taskId, report);
        this.deliverReport(report);
      },
    });
    // dsh 自己的后台作业不另开嗓子：收进同一条总线，再由空窗交给 omni。
    this.inner.setAnnouncer?.((speech, emotion) => {
      this.bus.ingestExternalAnnouncement(speech, emotion);
    });
  }

  get name(): string {
    return this.inner.name;
  }

  get sessionId(): string | null {
    return this.inner.sessionId ?? null;
  }

  /**
   * 文本入口（保活、无音频调用）。出声的轮次走 {@link toEngine}，不走这里。
   *
   * 「别查了」两条入口共用一个取消：语音轮在 `respond` 里说确认，这里只停任务。
   */
  async reply(
    userText: string,
    image?: AgentImage,
    note?: string,
    turn?: TurnContext,
  ): Promise<AgentReplyView> {
    if (isCancelRequest(userText) && this.bus.hasActiveReportable()) {
      this.bus.cancelAll('user_cancel');
      return { text: CANCEL_LINE, speech: CANCEL_LINE, path: 'omni' };
    }
    return this.inner.reply(userText, image, note, turn);
  }

  /**
   * 按连接挂车道。`expected` 是调用方以为还挂着的那条：对不上就什么都不做，
   * 旧连接迟到的 `onClose` 不能把新连接的车道摘掉。
   *
   * 换上另一条非空车道时清掉上一条连接的后台去重。设备重连后轮次从 1 重新
   * 编号，旧的 `turn=1,2,3` 若还留在总线上，新连接的委派会被当成重复任务吞掉。
   */
  attachAudioLane(lane: FastLaneAudioLane | null, expected?: FastLaneAudioLane | null): void {
    if (expected !== undefined && this.audioLane !== expected) return;
    const next = lane as LiveAudioLane | null;
    const replaced = next !== null && next !== this.audioLane;
    this.audioLane = next;
    if (!replaced) return;
    this.bus.resetSession();
    this.pendingReports.clear();
    this.injectedTaskIds.clear();
  }

  /** 纯健康事实，不做路由。宿主用来决定要不要预开一条用不上的合成。 */
  willServeAudio(_text: string): boolean {
    return this.audioLane?.willServe() === true;
  }

  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.announcer = cb;
  }

  setTaskReporter(cb: ((report: BackgroundTaskReport) => void) | null): void {
    this.taskReporter = cb;
  }

  /** 显式「别查了」。插话不走这里。 */
  cancelBackgroundTasks(): boolean {
    return this.bus.cancelAll('user_cancel');
  }

  /**
   * 插话作废的是前台这一轮。后台总线已经答应的任务继续跑。
   * 只有同步兜底（omni 不在，正在等 dsh 的那一句）才把取消转进去，
   * 而且票据必须对上正在等的那一次。
   */
  cancelTurn(ticket?: TurnTicket): void {
    if (this.disposed || !this.foregroundActive) return;
    const active = this.activeForegroundTicket;
    if (ticket !== undefined && (active === null || active.no !== ticket.no || active.gen !== ticket.gen)) {
      return;
    }
    this.inner.cancelTurn?.(ticket);
  }

  /**
   * 本管道没有预跑。内核的 `abortEngine` 目前只打到这个方法上，
   * 所以按原因掐 omni，效果与 {@link FastVoiceEngine.abortSpeculation} 相同，
   * 并且同样不取消后台任务。
   *
   * 显式 `'barge_in' | 'delegated' | 'superseded'` 与包了一层的
   * `内核中止(barge_in)` 都认。其它字符串不动车道。
   */
  dropPrefetch(why: 'barge_in' | 'delegated' | 'superseded' | string): void {
    if (this.disposed) return;
    const reason = dropReason(why);
    if (reason === null) return;
    this.abortLane(reason);
  }

  /**
   * 上一轮谁答的，原样来自账本。
   * 同步兜底记的是 `'dsh'`，omni 记的是 `'live'`。还没答过、或只有 `pet`，是 `null`。
   */
  lastLedgerLane(): 'live' | 'cascade' | 'dsh' | null {
    const last = this.ledger.lastAnswered();
    if (last === null || last.lane === 'pet') return null;
    return last.lane;
  }

  reconcileTurnOutcome(info: {
    readonly ticket: { readonly no: number; readonly gen: number };
    readonly truncated: boolean;
    readonly endedAtMs: number;
  }): void {
    this.ledger.reconcileOutcome(info.ticket, info.truncated, info.endedAtMs);
  }

  /** 唯一出话泵。内核只认 {@link FastVoiceEngine}，不知道后面是不是 omni。 */
  toEngine(): FastVoiceEngine {
    const host = this;
    return {
      mode: 'live',
      isHealthy(): boolean {
        return host.audioLane?.willServe() === true;
      },
      onAudioFrame(frame: AudioFrame): void {
        host.audioLane?.feed?.(frame.pcm, frame.voiced);
      },
      abortSpeculation(reason: 'delegated' | 'superseded' | 'barge_in'): void {
        host.abortLane(reason);
      },
      respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
        return host.respond(turn, signal);
      },
    };
  }

  /**
   * 空窗里让 omni 把后台结论说出来。
   *
   * - `verbatim`：精确数字走 TTS / 朗读连接，这里不念。
   * - 车道不能说：`'defer'`，调用方排回队首，等下一个安静窗。
   * - 开口前就没了声音、也不是被打断：`'fallback'`，交给 TTS，别让结论丢了。
   *
   * `markInjected` 只在 `playAudio` 确认已经说出有效音频（返回 `'spoken'`）之后。
   * 提前标记会让 `'fallback'` 的 `noteFallbackAnnounceSpoken` 以为注过了，
   * `injectAnswer(..., 'spoken')` 被吞掉。
   */
  async speakBackgroundReport(
    item: SpokenItem,
    playAudio: (answer: AgentAudioAnswer) => Promise<{
      readonly spokenBytes: number;
      readonly interrupted: boolean;
      readonly transcript: string;
    }>,
  ): Promise<'spoken' | 'defer' | 'fallback'> {
    if (this.disposed) return 'defer';
    if (item.verbatim === true) return 'fallback';
    const lane = this.audioLane;
    if (lane === null || typeof lane.speakFromText !== 'function') return 'fallback';
    if (lane.canSpeakBackground?.() !== true) return 'defer';
    const prompt = buildLiveReportPrompt({
      query: item.query ?? '',
      summary: item.speech,
      needsConfirm: item.needsConfirm,
    });
    const answer = lane.speakFromText(prompt, { taskId: item.taskId, query: item.query });
    if (answer === null) return 'defer';
    const res = await playAudio(answer);
    if (res.spokenBytes === 0 && !res.interrupted) {
      return this.disposed ? 'defer' : 'fallback';
    }
    this.markInjected(item.taskId);
    return 'spoken';
  }

  /**
   * TTS 把后台结论念完了（或被打断）。没被打断、而且 omni 还不知道这句话时，
   * 按「已经念给用户听了」回注。已经注入过的不再注第二遍。
   */
  noteFallbackAnnounceSpoken(item: FallbackItem, interrupted: boolean): void {
    if (item.taskId !== undefined) this.pendingReports.delete(item.taskId);
    if (interrupted) return;
    if (item.taskId !== undefined && this.injectedTaskIds.has(item.taskId)) return;
    if (item.taskId !== undefined) this.injectedTaskIds.add(item.taskId);
    this.audioLane?.injectAnswer?.(item.query ?? '后台任务', item.speech, 'spoken');
  }

  cancelBackgroundSpeech(): void {
    this.audioLane?.cancelBackgroundSpeech?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.foregroundActive = false;
    this.activeForegroundTicket = null;
    this.bus.dispose();
    this.pendingReports.clear();
  }

  /**
   * 插话只停前台正在说的这句。`'delegated'` / `'superseded'` 是这句还没播，
   * 从服务端历史里丢掉。两条都不碰后台总线：用户没说「别查了」，答应的结果还要说。
   */
  private abortLane(reason: 'delegated' | 'superseded' | 'barge_in'): void {
    if (reason === 'barge_in') {
      this.audioLane?.interrupt?.();
      return;
    }
    this.audioLane?.discard?.();
  }

  private deliverReport(report: BackgroundTaskReport): void {
    const reporter = this.taskReporter;
    if (reporter !== null) {
      reporter(report);
      return;
    }
    this.announcer?.(report.summary, report.emotion);
  }

  private markInjected(taskId: string | undefined): void {
    if (taskId === undefined) return;
    this.injectedTaskIds.add(taskId);
    this.pendingReports.delete(taskId);
  }

  /** 用户先开口、安静窗还没到：每个任务只回注一次，免得 omni 被问「跑完没」时编。 */
  private flushUnspoken(): void {
    const lane = this.audioLane;
    if (lane === null || this.pendingReports.size === 0) return;
    if (typeof lane.injectAnswer !== 'function') return;
    for (const [taskId, report] of this.pendingReports) {
      if (this.injectedTaskIds.has(taskId)) continue;
      this.injectedTaskIds.add(taskId);
      lane.injectAnswer(report.query, report.summary, 'unspoken');
    }
  }

  private composeBackendNote(directive: string, note: string | undefined, query: string): string {
    const parts: string[] = [directive];
    const memory = this.readMemory(query);
    if (memory !== '') parts.push(memory);
    // 前台 0 ms：账本已在这一进程里，拼进后台注记只为让 dsh 看懂「它」。
    const recent = this.recentDialogNote();
    if (recent !== '') parts.push(recent);
    if (note !== undefined && note.trim() !== '') parts.push(note);
    return parts.join('\n\n');
  }

  /** 最近四轮有内容的前台对话。空轮跳过；被打断的那句在米馍行末尾标明。 */
  private recentDialogNote(): string {
    const lines: string[] = [];
    for (const turn of this.ledger.recent(4)) {
      this.appendDialogTurn(lines, turn);
    }
    if (lines.length === 0) return '';
    return `【最近前台对话（仅供理解代词与指代，不要重复回答）】\n${lines.join('\n')}`;
  }

  private appendDialogTurn(lines: string[], turn: LedgerTurn): void {
    const user = turn.userText.trim();
    const assistant = turn.assistantText.trim();
    if (user === '' && assistant === '') return;
    if (user !== '') lines.push(`用户：${user}`);
    if (assistant !== '' || turn.truncated) {
      lines.push(`米馍：${assistant}${turn.truncated ? '（被打断）' : ''}`);
    }
  }

  private readMemory(query: string): string {
    if (this.memory === undefined) return '';
    try {
      return this.memory(query).trim();
    } catch (err) {
      this.writeLog(`  直播    记忆摘要读失败：${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  private remember(turn: TurnInput, speech: string, lane: 'live' | 'dsh'): void {
    const ticket = turn.ticket;
    this.ledger.record({
      userText: turn.text,
      assistantText: speech,
      lane,
      truncated: false,
      endedAtMs: this.now(),
      ...(ticket === undefined ? {} : { ticket: { no: ticket.no, gen: ticket.gen } }),
    });
  }

  private async askForeground(
    text: string,
    image: AgentImage | undefined,
    note: string | undefined,
    turn: TurnContext | undefined,
  ): Promise<AgentReplyView> {
    if (this.disposed) return { text: '', speech: '' };
    this.foregroundActive = true;
    this.activeForegroundTicket = turn?.ticket ?? null;
    try {
      const reply = await this.inner.reply(text, image, note, turn);
      if (this.disposed) return { text: '', speech: '' };
      return reply;
    } finally {
      this.foregroundActive = false;
      this.activeForegroundTicket = null;
    }
  }

  private async *synth(text: string, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    if (signal.aborted || this.disposed || text.trim() === '') return;
    const iter = this.tts.synthesize(text)[Symbol.asyncIterator]();
    const gate = whenAborted(signal);
    try {
      for (;;) {
        if (signal.aborted) return;
        const next = iter.next();
        const winner = await Promise.race([
          next.then(
            (step) => ({ kind: 'step' as const, step }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          ),
          gate.done.then(() => ({ kind: 'aborted' as const })),
        ]);
        if (winner.kind === 'aborted' || signal.aborted || this.disposed) {
          void Promise.resolve(next).catch(() => {});
          return;
        }
        if (winner.kind === 'error') throw winner.error;
        if (winner.step.done === true) return;
        yield {
          type: 'audio',
          pcm: asBuffer(winner.step.value),
          sampleRate: this.tts.sampleRate,
        };
      }
    } finally {
      gate.cancel();
      if (signal.aborted) void Promise.resolve(iter.return?.()).catch(() => {});
    }
  }

  private async *speakFixed(
    turn: TurnInput,
    signal: AbortSignal,
    text: string,
    meta: MetaEvent,
  ): AsyncGenerator<EngineEvent> {
    yield meta;
    if (!signal.aborted && !this.disposed) yield* this.synth(text, signal);
    if (signal.aborted || this.disposed) return;
    this.remember(turn, text, 'live');
    yield { type: 'done', fullText: text, speech: text };
  }

  private async *fallbackDsh(
    turn: TurnInput,
    signal: AbortSignal,
    meta: MetaEvent,
  ): AsyncGenerator<EngineEvent> {
    if (signal.aborted || this.disposed) return;
    const reply = await this.askForeground(
      turn.text,
      toAgentImage(turn),
      turn.note,
      turnContext(turn),
    );
    if (signal.aborted || this.disposed) return;
    yield meta;
    yield* this.synth(reply.speech, signal);
    if (signal.aborted || this.disposed) return;
    this.remember(turn, reply.speech, 'dsh');
    yield { type: 'done', fullText: reply.text, speech: reply.speech };
  }

  private async *playLive(
    turn: TurnInput,
    signal: AbortSignal,
    guardBackground = false,
  ): AsyncGenerator<EngineEvent> {
    const lane = this.audioLane;
    if (lane === null) return;
    const live = new LiveVoiceEngine(lane);
    yield* this.finishLive(turn, signal, live.respond(turn, signal), guardBackground);
  }

  /** `answerFromText()` 已经拿到活流：事件与 `tool_call` 处理和封段认领同一条。 */
  private async *playTextAnswer(
    turn: TurnInput,
    signal: AbortSignal,
    answer: AgentAudioAnswer,
    guardBackground = false,
  ): AsyncGenerator<EngineEvent> {
    yield* this.finishLive(turn, signal, streamLiveAnswer(answer, signal), guardBackground);
  }

  private async *finishLive(
    turn: TurnInput,
    signal: AbortSignal,
    source: AsyncIterable<EngineEvent>,
    guardBackground = false,
  ): AsyncGenerator<EngineEvent> {
    let audioBytes = 0;
    let spokeReceipt = false;
    let sawDelegate = false;
    let supplemented = false;
    for await (const ev of source) {
      if (signal.aborted || this.disposed) break;
      if (ev.type === 'audio') {
        audioBytes += ev.pcm.byteLength;
        yield ev;
        continue;
      }
      if (ev.type === 'delegate') {
        sawDelegate = true;
        const query = ev.rewrittenQuery
          ? `${ev.rewrittenQuery}\n用户原话：「${turn.text}」`
          : turn.text;
        this.bus.dispatch({
          turnNo: turn.no,
          source: 'tool_call',
          query,
          note: turn.note,
        });
        yield ev;
        yield { type: 'meta', path: 'omni', delegate: ev.reason, nonBlocking: true };
        if (audioBytes === 0 && !signal.aborted) {
          spokeReceipt = true;
          this.writeLog('  直播    omni 转交但没有音频，补一句短回执');
          yield* this.synth(DELEGATE_LINE, signal);
        }
        continue;
      }
      if (ev.type === 'done') {
        // 补派必须赶在 remember 之前让工人读到账本：注记只带更早的前台对话，
        // 正在派的这一轮还不是前文。queueMicrotask 比这次 await 更早入队。
        if (guardBackground && !sawDelegate && !signal.aborted && !this.disposed) {
          this.dispatchEarly(turn);
          supplemented = true;
          await Promise.resolve();
          if (signal.aborted || this.disposed) break;
        }
        const said = ev.speech ?? ev.fullText;
        this.remember(turn, said !== '' ? said : (spokeReceipt ? DELEGATE_LINE : ''), 'live');
        yield ev;
        continue;
      }
      yield ev;
    }
    // 守卫轮：Omni 自己发了 delegate 就只用那条改写查询。
    // 整段结束仍没有，才用原话补一笔 early_rule。中止或已释放不再派。
    if (guardBackground && !sawDelegate && !supplemented && !signal.aborted && !this.disposed) {
      this.dispatchEarly(turn);
    }
  }

  /** 车道现在还能让 omni 开口：封段可认领，或者健康到能按文本答。 */
  private laneCanAnswer(): boolean {
    const lane = this.audioLane;
    if (lane === null) return false;
    return lane.willServe() || lane.canAnswerText?.() === true;
  }

  private dispatchEarly(turn: TurnInput): void {
    this.bus.dispatch({
      turnNo: turn.no,
      source: 'early_rule',
      query: turn.text,
      note: turn.note,
    });
  }

  private async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    if (this.disposed || signal.aborted) return;
    this.flushUnspoken();
    if (this.disposed || signal.aborted) return;

    const lane = this.audioLane;
    const decision = decideLiveTurn({
      text: turn.text,
      hasImage: turn.hasImage && turn.image !== undefined,
      cancelActive: isCancelRequest(turn.text) && this.bus.hasActiveReportable(),
      photoHandOff: this.photoCanHandOff(),
      laneCanAnswer: this.laneCanAnswer(),
      willServe: lane?.willServe() === true,
      canTryText: typeof lane?.answerFromText === 'function',
    });

    if (decision !== 'cancel_bg' && decision !== 'photo_delegate' && looksMemorable(turn.text)) {
      this.bus.dispatch({ source: 'memory_silent', silent: true, query: turn.text });
    }

    switch (decision) {
      case 'cancel_bg':
        this.bus.cancelAll('user_cancel');
        this.audioLane?.discard?.();
        this.writeLog('  直播    用户取消后台任务');
        yield* this.speakFixed(turn, signal, CANCEL_LINE, { type: 'meta', path: 'omni' });
        return;
      case 'photo_delegate':
        this.audioLane?.discard?.();
        this.bus.dispatch({
          turnNo: turn.no,
          source: 'image',
          query: turn.text,
          image: toAgentImage(turn),
          note: turn.note,
        });
        yield* this.speakFixed(turn, signal, PHOTO_LINE, {
          type: 'meta',
          path: 'omni',
          delegate: 'task',
          nonBlocking: true,
        });
        return;
      case 'clock_override':
        // 钟点 Omni 会直接编。立刻丢掉在途音频，当场派后台，前台只应一声。
        this.audioLane?.discard?.();
        this.dispatchEarly(turn);
        this.writeLog('  直播    钟点问题交给后台，前台只应一声');
        yield* this.speakFixed(turn, signal, DELEGATE_LINE, {
          type: 'meta',
          path: 'omni',
          delegate: 'task',
          nonBlocking: true,
        });
        return;
      case 'fallback_dsh':
        if (turn.hasImage && turn.image !== undefined) {
          this.audioLane?.discard?.();
          this.writeLog('  直播    识图时 omni 不可用，同步交给 dsh');
          yield* this.fallbackDsh(turn, signal, { type: 'meta', path: 'dsh', delegate: 'task' });
          return;
        }
        if (isClockTimeRequest(turn.text)) {
          this.writeLog('  直播    问时间时 omni 不可用，同步交给 dsh');
        }
        yield* this.fallbackDsh(turn, signal, { type: 'meta', path: 'dsh' });
        return;
      case 'live_with_bg_guard':
      case 'live_direct':
        yield* this.playOmni(turn, signal, decision === 'live_with_bg_guard');
        return;
      default: {
        const unreachable: never = decision;
        return unreachable;
      }
    }
  }

  /**
   * Omni 还能服务。`guardBackground` 时不在这里派单：
   * `tool_call` 在 {@link finishLive} 里当场派改写查询，
   * 结束仍没有 `delegate` 才补原话。
   */
  private async *playOmni(
    turn: TurnInput,
    signal: AbortSignal,
    guardBackground: boolean,
  ): AsyncGenerator<EngineEvent> {
    const lane = this.audioLane;
    if (lane !== null && lane.willServe()) {
      yield* this.playLive(turn, signal, guardBackground);
      return;
    }
    if (lane === null || signal.aborted || this.disposed) {
      if (!signal.aborted && !this.disposed) {
        yield* this.fallbackDsh(turn, signal, { type: 'meta', path: 'dsh' });
      }
      return;
    }
    const answered = lane.answerFromText?.(turn.text) ?? null;
    if (signal.aborted || this.disposed) return;
    if (answered !== null) {
      this.writeLog('  直播    没有封段，改按文本让 omni 答');
      yield* this.playTextAnswer(turn, signal, answered, guardBackground);
      return;
    }
    yield* this.fallbackDsh(turn, signal, { type: 'meta', path: 'dsh' });
  }

  private photoCanHandOff(): boolean {
    const lane = this.audioLane;
    if (lane === null) return false;
    return lane.willServe() || lane.canSpeakBackground?.() === true;
  }

  private writeLog(line: string): void {
    try {
      this.log(`${this.now()} ${line}`);
    } catch {
      // 日志自己抛错不能把这一轮带走。
    }
  }
}
