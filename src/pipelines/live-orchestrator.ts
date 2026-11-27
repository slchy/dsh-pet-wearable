/**
 * Pure Live 的扁平编排。`VOICE_PIPELINE=live` 时只用这一条。
 *
 * 前台只有 omni 一副嗓子。dsh 在后台执行工具、识图、记忆写入，以及它自己的
 * `run_in_background` / 子代理；完成品经 {@link BackgroundTaskBus} 回到同一条
 * 会话里说出来。
 *
 * 前台轮次、后台任务和 Omni 单槽快照只活在 {@link LiveSessionState}。
 * 这里是解释器：收事件、执行意图，不再自己留第二份账。
 *
 * 不走文本快车道，不做投机预跑，也不把后台任务退回另一副嗓子。
 * 整段会话只有在 omni 接不上（没车道，`willServe()` 为假，且
 * `answerFromText()` 也拿不到答案）时才同步问 dsh，
 * 再用本层让 omni 把那句说出来 —— 那是断线兜底，不是第二条人格。
 */
import {
  BackgroundTaskBus,
  type BackgroundTaskLifecycleEvent,
  type BackgroundTaskRequest,
} from '../background-task-bus.ts';
import type { AudioFrame, EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import { streamLiveAnswer, type LiveAudioLane } from '../engines/live-voice-engine.ts';
import { createAbortGate } from '../engines/stream-utils.ts';
import type { TurnTicket } from '../kernel.ts';
import {
  LIVE_BACKEND_TASK_DIRECTIVE,
  buildLiveAckPrompt,
  buildLiveReportPrompt,
  type LiveAckKind,
} from '../persona.ts';
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
import type { AsrRefiner } from '../runtime/asr-refine.ts';
import {
  hasVerifiedContextFor,
  initialLiveSessionState,
  listUnspokenReports,
  projectDshRecentDialog,
  projectLastAnsweredLane,
  reduceLiveSession,
  type LiveSessionEffect,
  type LiveSessionEvent,
  type LiveSessionState,
} from './live-session-store.ts';
import { extractQuestionSubject, hasEntityQuery } from './entity-divergence.ts';
import {
  isActionRequest,
  isCancelRequest,
  isClockTimeRequest,
  isRealtimeFactRequest,
  looksMemorable,
  needsBackendVerification,
} from '../turn-router.ts';

/** 文本入口（无音频 `reply()`）用户取消时的返回值。语音轮一律由 omni 自己开口。 */
const CANCEL_LINE = '好，不查了。';

export interface LiveOrchestratorOptions {
  /** 后台执行器（dsh） */
  readonly inner: AgentProvider;
  /** 保留向后兼容签名；Pure Live 路径绝不调用任何外部 TTS。 */
  readonly tts?: TtsProvider;
  /** 建连时可读一次的长期记忆摘要，用于拼入后台注记或观测 */
  readonly memory?: (text: string) => string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** 可选：自定义 dsh 后台任务指令（默认 {@link LIVE_BACKEND_TASK_DIRECTIVE}） */
  readonly backendDirective?: string;
  /**
   * 可选：委派前整句高精度重转（见 `runtime/asr-refine.ts`）。
   * `null` / 不传 = 关闭；只做加法，失败一律回落到流式初转。
   */
  readonly refineAsr?: AsrRefiner | null;
  /** 精转结果替换了流式初转时回调（用于更新浮层字幕）。 */
  readonly onAsrRefined?: (refinedText: string, previousText: string) => void;
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

interface RecordedExtra {
  readonly omniUserItemId?: string | null;
  readonly omniAssistantItemIds?: readonly string[];
  readonly toolCallId?: string | null;
  readonly taskId?: string;
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

/**
 * 这一轮前台怎么走。纯函数：不派单、不碰车道。
 *
 * `live_with_bg_guard` 是「Omni 还能开口，但这句要查外部或要动手」。
 * 首块音频出去之前若 `delegateReason()` 仍是空的，未核实音频一字节都不外放：
 * 当场 `discard`，用原话补 `early_rule`，再排队一句短应声。
 * 已经标了 `delegate` 的，按 `tool_call` 派：主查询是用户原话，
 * 前台 `rewrittenQuery` 只在和原话不一致时写进注记当参考。
 * 整段 0 音频且仍没有 `delegate` 时，同样补原话并应一声。
 * 进 Omni 之前不能同步派单：总线工人晚一个微任务就开跑，
 * 会和随后的 `tool_call` 各跑一遍。
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
  /**
   * 单槽快照里已经有覆盖这个专名的已核实结论（见 `hasVerifiedContextFor`）。
   * 为真时专名守卫放行，让 Omni 直接读上下文回答，不再重复派 dsh。
   */
  readonly entityAlreadyVerified?: boolean;
}

export function decideLiveTurn(facts: LiveTurnFacts): LiveTurnDecision {
  if (facts.cancelActive) return 'cancel_bg';
  if (facts.hasImage) return facts.photoHandOff ? 'photo_delegate' : 'fallback_dsh';
  if (isClockTimeRequest(facts.text)) {
    return facts.laneCanAnswer ? 'clock_override' : 'fallback_dsh';
  }
  const entityGuard = hasEntityQuery(facts.text) && facts.entityAlreadyVerified !== true;
  const guard = isActionRequest(facts.text)
    || isRealtimeFactRequest(facts.text)
    || needsBackendVerification(facts.text)
    || entityGuard;
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
 * 委派给 dsh 的主查询。用户原话非空就用原话；转写是空的才回落前台改写。
 * Omni 的 `rewrittenQuery` 会听岔，也会顺着自己刚编的内容跑偏。
 */
function primaryDelegateQuery(rawUserText: string, rewrittenQuery: string | null): string {
  if (rawUserText.trim() !== '') return rawUserText;
  return rewrittenQuery ?? '';
}

/**
 * 前台改写只作低权重参考。空的、或和用户原话（去首尾空白后）相同的，不另附。
 */
function composeDelegateHint(rewrittenQuery: string, rawUserText: string): string | undefined {
  const guess = rewrittenQuery.trim();
  if (guess === '' || guess === rawUserText.trim()) return undefined;
  return [
    '【前台对用户意图的猜测（仅供参考，可能听岔或跑偏；若与用户原话或最近前台对话冲突，例如用户在纠正或质疑编造，一律以用户原话和上文为准）】',
    rewrittenQuery,
  ].join('\n');
}

/**
 * 精转替换了主查询时，把流式初转留在注记末尾，便于 dsh 对照专名与中英混读。
 * 流式结果是空串就不添这一行。
 */
function appendStreamingReference(note: string | undefined, streamingText: string): string | undefined {
  if (streamingText.trim() === '') return note;
  const line = `【流式初转参考】${streamingText}`;
  if (note === undefined || note.trim() === '') return line;
  return `${note}\n${line}`;
}

/**
 * `VOICE_PIPELINE=live` 的唯一前台。
 *
 * 热路径是 {@link LiveOrchestrator.toEngine}。`reply()` 留给保活和无音频调用方，
 * 语音轮次不走它。
 */
export class LiveOrchestrator implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly memory: ((text: string) => string) | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly backendDirective: string;
  private readonly refineAsr: AsrRefiner | null;
  private readonly onAsrRefined: ((refinedText: string, previousText: string) => void) | undefined;
  private readonly bus: BackgroundTaskBus;
  private state: LiveSessionState = initialLiveSessionState();
  /**
   * 不支持 `updateDynamicContext` 的旧假车道，仍然靠 `injectAnswer` 把结论补进下一轮。
   * 这两个集合只记「已经补过 / 已经由本层直接播过」，不保存汇报正文。
   */
  private readonly legacyInjectedIds = new Set<string>();
  private readonly directSpokenTaskIds = new Set<string>();

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
    void options.tts;
    this.memory = options.memory;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.backendDirective = options.backendDirective ?? LIVE_BACKEND_TASK_DIRECTIVE;
    this.refineAsr = options.refineAsr ?? null;
    this.onAsrRefined = options.onAsrRefined;
    this.bus = new BackgroundTaskBus({
      now: this.now,
      log: this.log,
      runner: {
        execute: async (req) => {
          let query = req.query;
          let note = req.note;
          // 精转跑在总线工人里：不占前台 Omni 的应声，dsh 拿到的却是整句高精度转写。
          if (!req.silent) {
            const refined = await this.refineForBackend(req.query, req.utterancePcm, req.note, req.signal);
            query = refined.query;
            note = refined.note;
          }
          const reply = await this.inner.reply(query, req.image, note);
          return { text: reply.text, speech: reply.speech, emotion: reply.emotion };
        },
        cancelRunning: () => {
          this.inner.cancelTurn?.();
        },
      },
      onLifecycle: (ev) => {
        this.onBusLifecycle(ev);
      },
      onReport: (report) => {
        // 总线内任务的终态已经由 onLifecycle 写过；这里再来一次 `task.completed`
        // 会被状态机当成重复事件丢掉，不会第二次 deliverReport。
        // dsh 自己的外部公告只走这条，没有生命周期事件。
        this.apply({
          type: 'task.completed',
          report,
          ...(report.turnNo !== undefined ? { turnNo: report.turnNo } : {}),
          ...(report.canonicalUser !== undefined ? { canonicalUser: report.canonicalUser } : {}),
          silent: false,
        });
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
      this.cancelReportable();
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
    this.legacyInjectedIds.clear();
    this.directSpokenTaskIds.clear();
    this.apply({ type: 'lane.replaced' });
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
    return this.cancelReportable();
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
   * 上一轮谁答的。同步兜底记的是 `'dsh'`，omni 记的是 `'live'`。还没答过是 `null`。
   */
  lastLedgerLane(): 'live' | 'cascade' | 'dsh' | null {
    return projectLastAnsweredLane(this.state);
  }

  reconcileTurnOutcome(info: {
    readonly ticket: { readonly no: number; readonly gen: number };
    readonly truncated: boolean;
    readonly endedAtMs: number;
  }): void {
    this.apply({
      type: 'turn.reconciled',
      ticket: info.ticket,
      truncated: info.truncated,
      endedAtMs: info.endedAtMs,
    });
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
   * 后台播报队列出队前检查：若任务已经由前台代播、已播报或已取消，直接跳过不再二次发声。
   *
   * 现场 20261126-073558：Omni 已经读完单槽里的完整结论，回到 `listening` 后
   * `announceQueue` 又把同一条完整重播一遍（双讲）。`delivered` 是唯一判据 ——
   * 前台代播已经在 `turn.recorded` 里写成 `spoken`，播报结算也会写，
   * 取消/断线写 `dropped` / `interrupted`，它们都不该再开口。
   */
  shouldSkipBackgroundReport(item: { readonly taskId?: string }): boolean {
    if (item.taskId === undefined) return false;
    const task = this.state.tasks[item.taskId];
    return task !== undefined && task.delivered !== 'pending';
  }

  /**
   * 空窗里让 omni 把后台结论说出来。
   *
   * Pure Live 路径禁止切去外部 TTS：哪怕 `verbatim: true`（含精确数字、端口、
   * 路径或长报告）也交给 omni 自己用同一副嗓子说出来（提示里要求把关键数字念准）。
   * - 车道正忙或有未提交用户音频：`'defer'`，排回队首，等下一个安静窗。
   * - 车道已断/未挂：`'fallback'`（调用方在 Pure Live 下只做静默文字提示，不调外部 TTS）。
   *
   * 播报成功（返回 `'spoken'`）之后才记进单槽：已说出或被打断。
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
    // 纵深防御：`DialogRuntime` 出队前也会查一次，但别的调用方（bench、宠物环）
    // 可能直接把同一条汇报递进来。命中就 0 字节、不入队、不走 TTS。
    const taskId = item.taskId;
    if (taskId !== undefined && this.shouldSkipBackgroundReport(item)) {
      this.writeLog(
        `  播报    跳过 ${taskId}（状态已为 ${this.state.tasks[taskId]?.delivered}，不再重复播报）`,
      );
      return 'spoken';
    }
    const lane = this.audioLane;
    if (
      lane === null
      || (typeof lane.enqueueSpeech !== 'function' && typeof lane.speakFromText !== 'function')
    ) {
      return 'fallback';
    }
    if (lane.canSpeakBackground?.() !== true) return 'defer';
    const prompt = buildLiveReportPrompt({
      query: item.query ?? '',
      summary: item.speech,
      needsConfirm: item.needsConfirm,
      verbatim: item.verbatim,
    });
    const answer = typeof lane.enqueueSpeech === 'function'
      ? lane.enqueueSpeech(prompt, { kind: 'announce', taskId: item.taskId, query: item.query })
      : lane.speakFromText?.(prompt, { taskId: item.taskId, query: item.query }) ?? null;
    if (answer === null) return 'defer';
    const res = await playAudio(answer);
    if (res.spokenBytes === 0 && !res.interrupted) {
      return this.disposed ? 'defer' : 'fallback';
    }
    if (item.taskId !== undefined) this.directSpokenTaskIds.add(item.taskId);
    this.apply({
      type: 'announce.settled',
      taskId: item.taskId,
      outcome: res.interrupted ? 'interrupted' : 'spoken',
      ...(item.query === undefined ? {} : { query: item.query }),
      summary: item.speech,
    });
    return 'spoken';
  }

  /**
   * 后台结论已经由某一侧念完（或被打断）。
   * 真车道靠单槽快照，不再 `injectAnswer`。
   * 旧假车道没有 `updateDynamicContext` 时，没被打断且还没补过，才按 spoken 回注一次。
   */
  noteFallbackAnnounceSpoken(item: FallbackItem, interrupted: boolean): void {
    this.apply({
      type: 'announce.settled',
      taskId: item.taskId,
      outcome: interrupted ? 'interrupted' : 'spoken',
      ...(item.query === undefined ? {} : { query: item.query }),
      summary: item.speech,
    });
    if (this.laneUsesSnapshot()) return;
    if (interrupted) return;
    if (item.taskId !== undefined) {
      if (this.directSpokenTaskIds.has(item.taskId) || this.legacyInjectedIds.has(item.taskId)) return;
      this.legacyInjectedIds.add(item.taskId);
    }
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
    this.legacyInjectedIds.clear();
    this.directSpokenTaskIds.clear();
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

  private apply(event: LiveSessionEvent): void {
    const reduced = reduceLiveSession(this.state, event);
    this.state = reduced.state;
    for (const effect of reduced.effects) this.runEffect(effect);
  }

  private runEffect(effect: LiveSessionEffect): void {
    switch (effect.type) {
      case 'send_tool_output':
        this.audioLane?.sendFunctionCallOutput?.(effect.callId, effect.output);
        return;
      case 'delete_omni_items':
        if (effect.itemIds.length > 0) this.audioLane?.deleteItems?.(effect.itemIds);
        return;
      case 'sync_omni_snapshot':
        this.audioLane?.updateDynamicContext?.(effect.snapshot);
        return;
      case 'emit_ui_asr_replace':
        // 纠偏字幕已经附在 deliver_report 上，交给 taskReporter，这里不再单发。
        return;
      case 'deliver_report':
        this.deliverReport(this.reportForDelivery(effect));
        return;
      default: {
        const neverEffect: never = effect;
        return neverEffect;
      }
    }
  }

  private reportForDelivery(
    effect: Extract<LiveSessionEffect, { type: 'deliver_report' }>,
  ): BackgroundTaskReport {
    const patch: {
      turnNo?: number;
      canonicalUser?: string;
      previousUserText?: string;
    } = {};
    if (effect.turnNo !== undefined) patch.turnNo = effect.turnNo;
    if (effect.canonicalUser !== undefined) patch.canonicalUser = effect.canonicalUser;
    if (effect.previousUserText !== undefined) patch.previousUserText = effect.previousUserText;
    if (
      patch.turnNo === undefined
      && patch.canonicalUser === undefined
      && patch.previousUserText === undefined
    ) {
      return effect.report;
    }
    return { ...effect.report, ...patch };
  }

  private onBusLifecycle(ev: BackgroundTaskLifecycleEvent): void {
    switch (ev.type) {
      case 'queued':
      case 'upgraded':
      case 'running':
      case 'cancelled':
        this.apply({
          type: 'task.lifecycle',
          taskId: ev.taskId,
          status: ev.type,
          ...(ev.turnNo !== undefined ? { turnNo: ev.turnNo } : {}),
          source: ev.source,
          query: ev.query,
          silent: ev.silent,
        });
        return;
      case 'completed':
        if (ev.report !== undefined) {
          this.apply({
            type: 'task.completed',
            report: ev.report,
            ...(ev.turnNo !== undefined ? { turnNo: ev.turnNo } : {}),
            ...(ev.report.canonicalUser !== undefined ? { canonicalUser: ev.report.canonicalUser } : {}),
            silent: ev.silent,
          });
          return;
        }
        this.apply({
          type: 'task.completed',
          report: {
            taskId: ev.taskId,
            source: ev.source,
            query: ev.query,
            summary: '',
          },
          ...(ev.turnNo !== undefined ? { turnNo: ev.turnNo } : {}),
          silent: true,
        });
        return;
      case 'failed':
        if (ev.report !== undefined) {
          this.apply({
            type: 'task.failed',
            report: ev.report,
            ...(ev.turnNo !== undefined ? { turnNo: ev.turnNo } : {}),
          });
          return;
        }
        this.apply({
          type: 'task.failed',
          report: {
            taskId: ev.taskId,
            source: ev.source,
            query: ev.query,
            summary: '',
          },
          ...(ev.turnNo !== undefined ? { turnNo: ev.turnNo } : {}),
        });
        return;
      default: {
        const neverEv: never = ev;
        return neverEv;
      }
    }
  }

  private deliverReport(report: BackgroundTaskReport): void {
    const reporter = this.taskReporter;
    if (reporter !== null) {
      reporter(report);
      return;
    }
    this.announcer?.(report.summary, report.emotion);
  }

  private laneUsesSnapshot(): boolean {
    return typeof this.audioLane?.updateDynamicContext === 'function';
  }

  private cancelReportable(): boolean {
    const cancelled = this.bus.cancelAll('user_cancel');
    if (cancelled) this.apply({ type: 'task.cancelled_all' });
    return cancelled;
  }

  /** 用户先开口。真车道的未播结论已在单槽里；旧假车道才把每条补进下一轮一次。 */
  private flushUnspoken(): void {
    const lane = this.audioLane;
    if (lane === null || this.laneUsesSnapshot()) return;
    if (typeof lane.injectAnswer !== 'function') return;
    for (const task of listUnspokenReports(this.state)) {
      if (this.legacyInjectedIds.has(task.taskId)) continue;
      this.legacyInjectedIds.add(task.taskId);
      lane.injectAnswer(task.query, task.summary ?? '', 'unspoken');
    }
  }

  /**
   * 在 `dispatch` 里就把后台注记拼好。工人要晚一个微任务才开跑，
   * 而这一轮的 `turn.delegated` / `turn.early_guarded` 会在返回后立刻写进状态。
   * 注记若拖到执行时再读，正在派的这一轮会被当成前文。
   */
  private dispatchTracked(
    req: BackgroundTaskRequest,
    delegateHint?: string,
  ): ReturnType<BackgroundTaskBus['dispatch']> {
    return this.bus.dispatch({
      ...req,
      note: this.composeBackendNote(this.backendDirective, req.note, req.query, delegateHint),
    });
  }

  private composeBackendNote(
    directive: string,
    note: string | undefined,
    query: string,
    delegateHint?: string,
  ): string {
    const parts: string[] = [directive];
    const memory = this.readMemory(query);
    if (memory !== '') parts.push(memory);
    const recent = this.recentDialogNote();
    if (recent !== '') parts.push(recent);
    if (delegateHint !== undefined && delegateHint.trim() !== '') parts.push(delegateHint);
    if (note !== undefined && note.trim() !== '') parts.push(note);
    return parts.join('\n\n');
  }

  /** 最近四轮有内容的前台对话。空轮跳过；被打断的那句在米馍行末尾标明。 */
  private recentDialogNote(): string {
    return projectDshRecentDialog(this.state, 4);
  }

  /**
   * 委派前的整句高精度重转。只做加法：没有 PCM、精转关、空串、与流式一致
   * 都原样返回；失败由 `AsrRefiner` 自己收成 `null`，绝不阻断委派。
   */
  private async refineForBackend(
    query: string,
    pcm: Buffer | undefined,
    note: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly query: string; readonly note: string | undefined; readonly refined: boolean }> {
    const refiner = this.refineAsr;
    if (pcm === undefined || refiner === null) {
      return { query, note, refined: false };
    }
    const text = await refiner({
      pcm,
      streamingText: query,
      context: this.recentDialogNote(),
      ...(signal === undefined ? {} : { signal }),
    });
    if (text === null) {
      return { query, note, refined: false };
    }
    const refinedText = text.trim();
    if (refinedText === '' || refinedText === query.trim()) {
      return { query, note, refined: false };
    }
    this.writeLog(`  精转    ${JSON.stringify(query)} → ${JSON.stringify(refinedText)}`);
    try {
      this.onAsrRefined?.(refinedText, query);
    } catch {
      // 浮层回调异常不能阻断后台委派
    }
    return { query: refinedText, note: appendStreamingReference(note, query), refined: true };
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

  private remember(
    turn: TurnInput,
    speech: string,
    lane: 'live' | 'dsh',
    extra?: RecordedExtra,
  ): void {
    const ticket = turn.ticket;
    this.apply({
      type: 'turn.recorded',
      turnNo: turn.no,
      rawAsr: turn.text,
      lane,
      assistantSpoken: speech,
      endedAtMs: this.now(),
      ...(ticket === undefined ? {} : { ticket: { no: ticket.no, gen: ticket.gen } }),
      ...(extra?.omniUserItemId !== undefined ? { omniUserItemId: extra.omniUserItemId } : {}),
      ...(extra?.omniAssistantItemIds !== undefined ? { omniAssistantItemIds: extra.omniAssistantItemIds } : {}),
      ...(extra?.toolCallId !== undefined ? { toolCallId: extra.toolCallId } : {}),
      ...(extra?.taskId !== undefined ? { taskId: extra.taskId } : {}),
    });
  }

  /** 轮末再读一次 Omni 项。空的 `callId` 不写，免得把委派时已经记下的盖掉。 */
  private recordedExtra(answer: AgentAudioAnswer | null, taskId: string | undefined): RecordedExtra | undefined {
    const callId = answer?.delegateCallId?.() ?? null;
    const hasCall = typeof callId === 'string' && callId !== '';
    if (answer === null && taskId === undefined && !hasCall) return undefined;
    const userItemId = answer === null ? undefined : (answer.userItemId?.() ?? null);
    const assistantItemIds = answer === null ? undefined : (answer.assistantItemIds?.() ?? []);
    return {
      ...(userItemId !== undefined ? { omniUserItemId: userItemId } : {}),
      ...(assistantItemIds !== undefined ? { omniAssistantItemIds: assistantItemIds } : {}),
      ...(hasCall ? { toolCallId: callId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    };
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

  /**
   * 用提示词排队让 omni 自己说一句（绝不调外部 TTS）。
   *
   * 优先走 `lane.enqueueSpeech`（在 `discard()` 刚发 cancel 还在等 `response.done`
   * 时自动排进 FIFO 队列）；测试假车道只实现 `speakFromText` 时兼容走它。
   */
  private async *speakViaOmni(
    prompt: string,
    signal: AbortSignal,
    kind: 'ack' | 'announce',
    query?: string,
  ): AsyncGenerator<EngineEvent, { readonly spokenBytes: number; readonly spokenText: string }> {
    if (signal.aborted || this.disposed || prompt.trim() === '') {
      return { spokenBytes: 0, spokenText: '' };
    }
    const lane = this.audioLane;
    if (lane === null) {
      return { spokenBytes: 0, spokenText: '' };
    }
    const answer: (AgentAudioAnswer & { interrupt?(): void }) | null = typeof lane.enqueueSpeech === 'function'
      ? lane.enqueueSpeech(prompt, { kind, ...(query === undefined ? {} : { query }) })
      : (lane.canSpeakBackground?.() !== false
        ? lane.speakFromText?.(prompt, query === undefined ? undefined : { query }) ?? null
        : null);
    if (answer === null) {
      return { spokenBytes: 0, spokenText: '' };
    }

    const gate = createAbortGate(signal);
    const iter = answer.chunks[Symbol.asyncIterator]();
    let spokenBytes = 0;
    let said = 0;
    try {
      for (;;) {
        if (signal.aborted || this.disposed) {
          answer.interrupt?.();
          return { spokenBytes, spokenText: answer.transcript() };
        }
        const step = iter.next();
        const winner = await Promise.race([step, gate.done]);
        if (winner === undefined || signal.aborted || this.disposed) {
          answer.interrupt?.();
          void Promise.resolve(step).catch(() => {});
          void Promise.resolve(iter.return?.()).catch(() => {});
          return { spokenBytes, spokenText: answer.transcript() };
        }
        if (winner.done === true) {
          break;
        }
        spokenBytes += winner.value.byteLength;
        yield {
          type: 'audio',
          pcm: winner.value,
          sampleRate: answer.sampleRate,
        };
        const text = answer.transcript();
        if (text.length > said) {
          const delta = text.slice(said);
          said = text.length;
          yield { type: 'text', delta };
        }
      }
    } finally {
      gate.cancel();
    }
    const finalText = answer.transcript();
    if (finalText.length > said && !signal.aborted && !this.disposed) {
      yield { type: 'text', delta: finalText.slice(said) };
    }
    return { spokenBytes, spokenText: finalText };
  }

  private async *speakAck(
    turn: TurnInput,
    signal: AbortSignal,
    kind: LiveAckKind,
    meta: MetaEvent,
  ): AsyncGenerator<EngineEvent> {
    yield meta;
    const prompt = buildLiveAckPrompt(kind, turn.text);
    const res = yield* this.speakViaOmni(prompt, signal, 'ack', turn.text);
    if (signal.aborted || this.disposed) return;
    const said = res.spokenText.trim();
    this.remember(turn, said, 'live');
    yield { type: 'done', fullText: said, speech: said };
  }

  private async *fallbackDsh(
    turn: TurnInput,
    signal: AbortSignal,
    meta: MetaEvent,
  ): AsyncGenerator<EngineEvent> {
    if (signal.aborted || this.disposed) return;
    const refined = await this.refineForBackend(turn.text, turn.utterancePcm, turn.note, signal);
    if (signal.aborted || this.disposed) return;
    const reply = await this.askForeground(
      refined.query,
      toAgentImage(turn),
      refined.note,
      turnContext(turn),
    );
    if (signal.aborted || this.disposed) return;
    // dsh 也是文本 LLM：首 token 延迟是真的，照实透出（`llm.first` / `turn.report`）。
    // omni 直出那条没有这个相位，所以只在这一条兜底路径上补。
    yield reply.firstTokenMs === undefined ? meta : { ...meta, firstTokenMs: reply.firstTokenMs };
    // Pure Live 禁止调用外部 TTS：车道若已恢复则尝试让 omni 自己说，否则仅下发文本收尾。
    if (reply.speech.trim() !== '') {
      const prompt = buildLiveReportPrompt({ query: turn.text, summary: reply.speech });
      yield* this.speakViaOmni(prompt, signal, 'announce', turn.text);
    }
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
    const answer = lane.claim();
    if (answer === null) {
      yield { type: 'done', fullText: '' };
      return;
    }
    yield* this.finishLive(turn, signal, streamLiveAnswer(answer, signal), guardBackground, answer);
  }

  /** `answerFromText()` 已经拿到活流：事件与 `tool_call` 处理和封段认领同一条。 */
  private async *playTextAnswer(
    turn: TurnInput,
    signal: AbortSignal,
    answer: AgentAudioAnswer,
    guardBackground = false,
  ): AsyncGenerator<EngineEvent> {
    yield* this.finishLive(turn, signal, streamLiveAnswer(answer, signal), guardBackground, answer);
  }

  private async *finishLive(
    turn: TurnInput,
    signal: AbortSignal,
    source: AsyncIterable<EngineEvent>,
    guardBackground = false,
    answer: AgentAudioAnswer | null = null,
  ): AsyncGenerator<EngineEvent> {
    let audioBytes = 0;
    let ackText = '';
    let sawDelegate = false;
    let supplemented = false;
    let linkedTaskId: string | undefined;
    for await (const ev of source) {
      if (signal.aborted || this.disposed) break;
      if (ev.type === 'audio') {
        // 真服务上 function_call 比首块音频早约 150 ms。到这里还没标 delegate，
        // 就是准备把未核实的话播出去。一字节都不交出去。
        if (
          guardBackground
          && audioBytes === 0
          && !sawDelegate
          && (answer?.delegateReason?.() ?? null) === null
        ) {
          this.writeLog('  直播    守卫轮前台未调工具，拦截未核实音频并转交后台');
          this.audioLane?.discard?.();
          const taskId = this.dispatchEarly(turn, answer?.assistantItemIds?.() ?? []);
          await Promise.resolve();
          if (signal.aborted || this.disposed) return;
          yield { type: 'meta', path: 'omni', delegate: 'task', nonBlocking: true };
          const ack = yield* this.speakViaOmni(
            buildLiveAckPrompt('delegate', turn.text),
            signal,
            'ack',
            turn.text,
          );
          if (signal.aborted || this.disposed) return;
          const said = ack.spokenText.trim();
          this.remember(turn, said, 'live', this.recordedExtra(null, taskId));
          yield { type: 'done', fullText: said, speech: said };
          return;
        }
        audioBytes += ev.pcm.byteLength;
        yield ev;
        continue;
      }
      if (ev.type === 'delegate') {
        sawDelegate = true;
        // 主查询、播报提示、turn.delegated 共用这一份：用户原话。改写只进注记。
        const query = primaryDelegateQuery(turn.text, ev.rewrittenQuery);
        const handle = this.dispatchTracked({
          turnNo: turn.no,
          source: 'tool_call',
          query,
          note: turn.note,
          ...(turn.utterancePcm === undefined ? {} : { utterancePcm: turn.utterancePcm }),
        }, composeDelegateHint(ev.rewrittenQuery ?? '', turn.text));
        linkedTaskId = handle.taskId;
        this.apply({
          type: 'turn.delegated',
          turnNo: turn.no,
          rawAsr: turn.text,
          query,
          taskId: handle.taskId,
          toolCallId: ev.callId ?? answer?.delegateCallId?.() ?? null,
          omniUserItemId: answer?.userItemId?.() ?? null,
          omniAssistantItemIds: answer?.assistantItemIds?.() ?? [],
          nowMs: this.now(),
        });
        yield ev;
        yield { type: 'meta', path: 'omni', delegate: ev.reason, nonBlocking: true };
        if (audioBytes === 0 && !signal.aborted && !this.disposed) {
          this.writeLog('  直播    omni 转交但没有音频，排队用提示词让 omni 自己补一句');
          const ack = yield* this.speakViaOmni(
            buildLiveAckPrompt('delegate', query),
            signal,
            'ack',
            query,
          );
          audioBytes += ack.spokenBytes;
          ackText = ack.spokenText.trim();
        }
        continue;
      }
      if (ev.type === 'done') {
        const origSaid = (ev.speech ?? ev.fullText).trim();
        // 补派必须赶在 remember 之前入队：工人晚一个微任务开跑，注记在 dispatch 时已经封好。
        // 有音频却没 delegate 的，已经在首块之前 return 了。这里留下的是 0 音频边界。
        let preferAck = false;
        if (guardBackground && !sawDelegate && !signal.aborted && !this.disposed) {
          linkedTaskId = this.dispatchEarly(turn, answer?.assistantItemIds?.() ?? []);
          supplemented = true;
          await Promise.resolve();
          if (signal.aborted || this.disposed) break;
          yield { type: 'meta', path: 'omni', delegate: 'task', nonBlocking: true };
          if (audioBytes === 0 && !signal.aborted && !this.disposed) {
            const ack = yield* this.speakViaOmni(
              buildLiveAckPrompt('delegate', turn.text),
              signal,
              'ack',
              turn.text,
            );
            audioBytes += ack.spokenBytes;
            ackText = ack.spokenText.trim();
            preferAck = true;
            if (signal.aborted || this.disposed) break;
          }
        }
        // 同一轮严格互斥：要么在首块音频前走守卫轮丢弃前台直答并派后台，
        // 要么由前台直接回答；不再在直答放完后再事后补派 dsh 造成双答。
        if (signal.aborted || this.disposed) break;
        const said = preferAck ? (ackText || origSaid) : (origSaid !== '' ? origSaid : ackText);
        this.remember(turn, said, 'live', this.recordedExtra(answer, linkedTaskId));
        if ((preferAck && ackText !== '') || (origSaid === '' && ackText !== '')) {
          yield { type: 'done', fullText: ackText, speech: ackText };
        } else {
          yield ev;
        }
        continue;
      }
      yield ev;
    }
    // 守卫轮：Omni 自己发了 delegate 就走上面的 tool_call，主查询仍是用户原话。
    // 整段结束仍没有，才用原话补一笔 early_rule。中止或已释放不再派。
    if (guardBackground && !sawDelegate && !supplemented && !signal.aborted && !this.disposed) {
      this.dispatchEarly(turn, answer?.assistantItemIds?.() ?? []);
    }
  }

  /** 车道现在还能让 omni 开口：封段可认领，或者健康到能按文本答。 */
  private laneCanAnswer(): boolean {
    const lane = this.audioLane;
    if (lane === null) return false;
    return lane.willServe() || lane.canAnswerText?.() === true;
  }

  private dispatchEarly(
    turn: TurnInput,
    omniAssistantItemIds?: readonly string[],
    delegateHint?: string,
  ): string {
    const handle = this.dispatchTracked({
      turnNo: turn.no,
      source: 'early_rule',
      query: turn.text,
      note: turn.note,
      ...(turn.utterancePcm === undefined ? {} : { utterancePcm: turn.utterancePcm }),
    }, delegateHint);
    this.apply({
      type: 'turn.early_guarded',
      turnNo: turn.no,
      rawAsr: turn.text,
      query: turn.text,
      taskId: handle.taskId,
      ...(omniAssistantItemIds === undefined ? {} : { omniAssistantItemIds }),
    });
    return handle.taskId;
  }

  private async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    if (this.disposed || signal.aborted) return;
    this.flushUnspoken();
    if (this.disposed || signal.aborted) return;

    const lane = this.audioLane;
    const subject = extractQuestionSubject(turn.text);
    const entityAlreadyVerified = subject !== null && hasVerifiedContextFor(this.state, subject);
    const decision = decideLiveTurn({
      text: turn.text,
      hasImage: turn.hasImage && turn.image !== undefined,
      cancelActive: isCancelRequest(turn.text) && this.bus.hasActiveReportable(),
      photoHandOff: this.photoCanHandOff(),
      laneCanAnswer: this.laneCanAnswer(),
      willServe: lane?.willServe() === true,
      canTryText: typeof lane?.answerFromText === 'function',
      ...(entityAlreadyVerified ? { entityAlreadyVerified: true } : {}),
    });

    if (decision !== 'cancel_bg' && decision !== 'photo_delegate' && looksMemorable(turn.text)) {
      this.dispatchTracked({ source: 'memory_silent', silent: true, query: turn.text });
    }

    switch (decision) {
      case 'cancel_bg':
        this.cancelReportable();
        this.audioLane?.discard?.();
        this.writeLog('  直播    用户取消后台任务');
        yield* this.speakAck(turn, signal, 'cancel', { type: 'meta', path: 'omni' });
        return;
      case 'photo_delegate':
        this.audioLane?.discard?.();
        this.dispatchTracked({
          turnNo: turn.no,
          source: 'image',
          query: turn.text,
          image: toAgentImage(turn),
          note: turn.note,
          ...(turn.utterancePcm === undefined ? {} : { utterancePcm: turn.utterancePcm }),
        });
        yield* this.speakAck(turn, signal, 'photo', {
          type: 'meta',
          path: 'omni',
          delegate: 'task',
          nonBlocking: true,
        });
        return;
      case 'clock_override':
        // 钟点 Omni 会直接编。立刻丢掉在途音频，当场派后台，再排队让 omni 自己简短应一声。
        this.audioLane?.discard?.();
        this.dispatchEarly(turn);
        this.writeLog('  直播    钟点问题交给后台，排队让 omni 简短应一声');
        yield* this.speakAck(turn, signal, 'clock', {
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
   * 首块音频前没有 `delegate` 就在 {@link finishLive} 里截住并补 `early_rule`；
   * 已经 `delegate` 的按 `tool_call` 派，主查询是用户原话。
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
