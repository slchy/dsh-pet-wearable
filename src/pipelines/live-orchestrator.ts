/**
 * Pure Live 的扁平编排。`VOICE_PIPELINE=live` 时只用这一条。
 *
 * 前台只有 omni 一副嗓子。dsh 在后台执行工具、识图、记忆写入，以及它自己的
 * `run_in_background` / 子代理；完成品经 {@link BackgroundTaskBus} 回到同一条
 * 会话里说出来。
 *
 * 不走文本快车道，不做投机预跑，也不把后台任务退回另一副嗓子。
 * 整段会话只有在 omni 接不上（没车道，或 `willServe()` 为假）时才同步问 dsh，
 * 再用本层的 TTS 把那句说出来 —— 那是断线兜底，不是第二条人格。
 */
import { BackgroundTaskBus } from '../background-task-bus.ts';
import { ConversationLedger } from '../conversation-ledger.ts';
import type { AudioFrame, EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import { LiveVoiceEngine, type LiveAudioLane } from '../engines/live-voice-engine.ts';
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
import { isActionRequest, isCancelRequest, looksMemorable } from '../turn-router.ts';

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
   */
  attachAudioLane(lane: FastLaneAudioLane | null, expected?: FastLaneAudioLane | null): void {
    if (expected !== undefined && this.audioLane !== expected) return;
    this.audioLane = lane as LiveAudioLane | null;
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
   * 只有同步兜底（omni 不在，正在等 dsh 的那一句）才把取消转进去。
   */
  cancelTurn(ticket?: TurnTicket): void {
    if (!this.foregroundActive) return;
    this.inner.cancelTurn?.(ticket);
  }

  /**
   * 本管道没有预跑。内核的 `abortEngine` 目前只打到这个方法上，
   * 所以按原因掐 omni，效果与 {@link FastVoiceEngine.abortSpeculation} 相同，
   * 并且同样不取消后台任务。
   */
  dropPrefetch(why: string): void {
    if (why.endsWith('barge_in)') || why === 'barge_in') {
      this.abortLane('barge_in');
      return;
    }
    if (why.endsWith('delegated)') || why === 'delegated') {
      this.abortLane('delegated');
      return;
    }
    if (why.endsWith('superseded)') || why === 'superseded') {
      this.abortLane('superseded');
    }
  }

  /** 上一轮是 omni 答的才回报 `live`。兜底 dsh、还没答过，都是 `null`。 */
  lastLedgerLane(): 'live' | null {
    return this.ledger.lastAnsweredLane() === 'live' ? 'live' : null;
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
   */
  async speakBackgroundReport(
    item: SpokenItem,
    playAudio: (answer: AgentAudioAnswer) => Promise<{
      readonly spokenBytes: number;
      readonly interrupted: boolean;
      readonly transcript: string;
    }>,
  ): Promise<'spoken' | 'defer' | 'fallback'> {
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
    this.markInjected(item.taskId);
    const res = await playAudio(answer);
    if (res.spokenBytes === 0 && !res.interrupted) return 'fallback';
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
    if (note !== undefined && note.trim() !== '') parts.push(note);
    return parts.join('\n\n');
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
    this.foregroundActive = true;
    try {
      return await this.inner.reply(text, image, note, turn);
    } finally {
      this.foregroundActive = false;
    }
  }

  private async *synth(text: string, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    if (signal.aborted || text.trim() === '') return;
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
        if (winner.kind === 'aborted' || signal.aborted) {
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
    if (!signal.aborted) yield* this.synth(text, signal);
    if (signal.aborted) return;
    this.remember(turn, text, 'live');
    yield { type: 'done', fullText: text, speech: text };
  }

  private async *fallbackDsh(
    turn: TurnInput,
    signal: AbortSignal,
    meta: MetaEvent,
  ): AsyncGenerator<EngineEvent> {
    if (signal.aborted) return;
    const reply = await this.askForeground(
      turn.text,
      toAgentImage(turn),
      turn.note,
      turnContext(turn),
    );
    if (signal.aborted) return;
    yield meta;
    yield* this.synth(reply.speech, signal);
    if (signal.aborted) return;
    this.remember(turn, reply.speech, 'dsh');
    yield { type: 'done', fullText: reply.text, speech: reply.speech };
  }

  private async *playLive(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    const lane = this.audioLane;
    if (lane === null) return;
    const live = new LiveVoiceEngine(lane);
    let audioBytes = 0;
    let spokeReceipt = false;
    for await (const ev of live.respond(turn, signal)) {
      if (ev.type === 'audio') {
        audioBytes += ev.pcm.byteLength;
        yield ev;
        continue;
      }
      if (ev.type === 'delegate') {
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
        const said = ev.speech ?? ev.fullText;
        this.remember(turn, said !== '' ? said : (spokeReceipt ? DELEGATE_LINE : ''), 'live');
        yield ev;
        continue;
      }
      yield ev;
    }
  }

  private async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    this.flushUnspoken();

    if (isCancelRequest(turn.text) && this.bus.hasActiveReportable()) {
      this.bus.cancelAll('user_cancel');
      this.audioLane?.discard?.();
      this.writeLog('  直播    用户取消后台任务');
      yield* this.speakFixed(turn, signal, CANCEL_LINE, { type: 'meta', path: 'omni' });
      return;
    }

    if (turn.hasImage && turn.image !== undefined) {
      this.audioLane?.discard?.();
      if (this.photoCanHandOff()) {
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
      }
      this.writeLog('  直播    识图时 omni 不可用，同步交给 dsh');
      yield* this.fallbackDsh(turn, signal, { type: 'meta', path: 'dsh', delegate: 'task' });
      return;
    }

    if (looksMemorable(turn.text)) {
      this.bus.dispatch({ source: 'memory_silent', silent: true, query: turn.text });
    }

    if (isActionRequest(turn.text) && this.audioLane?.willServe() === true) {
      this.bus.dispatch({
        turnNo: turn.no,
        source: 'early_rule',
        query: turn.text,
        note: turn.note,
      });
    }

    if (this.audioLane !== null && this.audioLane.willServe()) {
      yield* this.playLive(turn, signal);
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
