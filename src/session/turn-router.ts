/**
 * 主会话轮次机。16 个轮次槽都在这里。
 *
 * 命令进来，效果出去。不持有 `DshSession`，不碰进程，不调用播报回调。
 *
 * INV-8（这一层守得住的部分）：
 * 1. 子会话事件过不了 `openSessionId`（{@link isMainSession}）。
 * 2. `finally` 只回到 `idle` 或 `detached_running`（{@link TurnRouter.finishForeground}）。
 * 3. 过期票据的 `detachTurn` / `cancelTurn` 是空操作。
 * 4. `tailSwallow` 吃掉旧自发轮迟到的 `turn/start` 和残余消息。
 *
 * 旧 `procGen` 不碰新进程是传输层的事，不在这台机器里。
 */
import type { TurnTicket } from '../dialog-fsm.ts';
import { SpontaneousTurn } from '../spontaneous.ts';
import type { CancelDecision, DshTurnPhase, TurnEffect } from './types.ts';
import { foldStepUsage, type TokenUsage } from './usage.ts';

export interface DetachedLease {
  readonly turnNo: number | null;
  readonly userText: string;
  text: string;
}

export interface TailSwallow {
  readonly phase: 'awaiting_old_turn_start' | 'awaiting_old_idle';
  readonly turnNo: number | null;
}

export interface TurnView {
  readonly turnPhase: DshTurnPhase;
  readonly detachedLease: DetachedLease | null;
  readonly tailSwallow: TailSwallow | null;
  readonly assistantText: string;
  readonly activeUserText: string;
  readonly activeTicket: TurnTicket | null;
  readonly spontaneous: SpontaneousTurn;
  readonly firstTokenMs: number | null;
  readonly usage: TokenUsage | null;
}

/**
 * 这条事件是不是当前打开的主会话。
 *
 * 空 id、还没打开、对不上 `openSessionId`，都不是。子会话只能进任务板。
 */
export function isMainSession(sessionId: unknown, openSessionId: string | null): boolean {
  return typeof sessionId === 'string'
    && sessionId !== ''
    && sessionId === openSessionId;
}

export class TurnRouter {
  private assistantText = '';
  private turnStartedAt = 0;
  private firstTokenMs: number | null = null;
  private turnUsage: TokenUsage | null = null;
  private onIdle: (() => void) | null = null;
  private activeTicket: TurnTicket | null = null;
  private turnPhase: DshTurnPhase = 'idle';
  private cancelRequested = false;
  private foregroundActive = false;
  private foregroundTurn: number | null = null;
  private foregroundDetached = false;
  private detachedLease: DetachedLease | null = null;
  private activeUserText = '';
  private currentTurn: number | null = null;
  private tailSwallow: TailSwallow | null = null;
  private readonly spontaneous = new SpontaneousTurn();

  /** 测试与门面读槽。热路径用下面的窄读取，不经过这份快照。 */
  view(): TurnView {
    return {
      turnPhase: this.turnPhase,
      detachedLease: this.detachedLease,
      tailSwallow: this.tailSwallow,
      assistantText: this.assistantText,
      activeUserText: this.activeUserText,
      activeTicket: this.activeTicket,
      spontaneous: this.spontaneous,
      firstTokenMs: this.firstTokenMs,
      usage: this.turnUsage,
    };
  }

  readPhase(): DshTurnPhase {
    return this.turnPhase;
  }

  readTicket(): TurnTicket | null {
    return this.activeTicket;
  }

  readAssistantText(): string {
    return this.assistantText;
  }

  readFirstToken(): number | null {
    return this.firstTokenMs;
  }

  readUsage(): TokenUsage | null {
    return this.turnUsage;
  }

  /** `askSdk` 发 prompt 之前清本轮文本、用量和首 token 时刻。 */
  beginAsk(startedAt: number): void {
    this.assistantText = '';
    this.turnUsage = null;
    this.turnStartedAt = startedAt;
    this.firstTokenMs = null;
  }

  /**
   * 发 `session/prompt` 之前：自发轮的尾巴重新武装；对不上轮号的旧尾巴作废。
   * 放手租约留着（还没 `turn/end`），但自发轮不能跟它叠在一起。
   */
  prepareIncomingPrompt(): void {
    if (this.spontaneous.isActive) {
      this.tailSwallow = {
        phase: this.currentTurn === null ? 'awaiting_old_turn_start' : 'awaiting_old_idle',
        turnNo: this.currentTurn,
      };
    } else if (this.tailSwallowIsStale()) {
      this.tailSwallow = null;
    }
    this.spontaneous.reset();
    this.syncSpontaneous();
  }

  /** 从写票据开始，这一轮进入 `prompting_rpc`。返回的 promise 在 idle 或放手时 resolve。 */
  armForeground(ticket: TurnTicket | null, text: string): Promise<void> {
    this.foregroundActive = true;
    this.foregroundTurn = null;
    this.foregroundDetached = false;
    this.turnPhase = 'prompting_rpc';
    this.activeTicket = ticket;
    this.activeUserText = text;
    this.cancelRequested = false;
    return new Promise<void>((resolve) => { this.onIdle = resolve; });
  }

  markAwaitingIdle(): void {
    this.turnPhase = 'awaiting_idle';
  }

  /**
   * `askSdk` 的 `finally`。只回到 `idle` 或 `detached_running`。
   * 返回值只表示**这一次** ask 被放手了，不表示旧租约已经没了。
   */
  finishForeground(): boolean {
    const detachedThisAsk = this.foregroundDetached;
    this.onIdle = null;
    this.activeTicket = null;
    this.foregroundActive = false;
    this.foregroundTurn = null;
    this.foregroundDetached = false;
    this.turnPhase = this.detachedLease !== null ? 'detached_running' : 'idle';
    return detachedThisAsk;
  }

  takeCancelled(): boolean {
    const cancelled = this.cancelRequested;
    this.cancelRequested = false;
    return cancelled;
  }

  noteFirstToken(now: number): void {
    if (this.firstTokenMs === null && this.turnStartedAt > 0) {
      this.firstTokenMs = now - this.turnStartedAt;
    }
  }

  recordUsage(step: TokenUsage): void {
    this.turnUsage = foldStepUsage(this.turnUsage, step);
  }

  /**
   * 停进程、换会话、进程退出、握手换代共用这一处。
   * 只清一轮对话的在途态，不动 `onIdle`（调用方还要用它把等待者叫醒）。
   */
  clearTurnState(): void {
    this.detachedLease = null;
    this.tailSwallow = null;
    this.assistantText = '';
    this.activeTicket = null;
    this.activeUserText = '';
    this.foregroundActive = false;
    this.foregroundTurn = null;
    this.foregroundDetached = false;
    this.currentTurn = null;
    this.turnPhase = 'idle';
    this.spontaneous.suppress(false);
    this.spontaneous.reset();
  }

  /**
   * 放手：**不取消** dsh 那一轮，只把「有人在等它」摘掉。
   *
   * 带了票据而 `activeTicket === null`，或 `{no, gen}` 对不上，直接丢掉。
   * `hasProc === false` 同样是空操作（进程不在，没有可放手的一轮）。
   */
  detachTurn(ticket: TurnTicket | undefined, hasProc: boolean): TurnEffect[] {
    if (!hasProc) return [];
    if (ticket !== undefined && !this.ticketMatches(ticket)) {
      return [{ type: 'log', line: `  放手    票据过期（#${ticket.no}/${ticket.gen}）→ 丢弃` }];
    }
    const turnNo = this.foregroundTurn ?? this.currentTurn;
    this.detachedLease = {
      turnNo,
      userText: this.activeUserText,
      text: this.assistantText.trim(),
    };
    this.foregroundDetached = true;
    // 相位跟着走：只改布尔、不改相位的话，下一轮 ask 进来时 isBusy / 自发轮都会误判
    this.turnPhase = 'detached_running';
    this.syncSpontaneous();
    const effects: TurnEffect[] = [];
    if (turnNo === null) {
      // 还没收到 turn/start：下一次 turn/end 就是它的（dsh 串行，不会有别人的）
      effects.push({ type: 'log', line: '  放手    放手的时刻还没开轮 → 认下一次 turn/end' });
    }
    const fire = this.onIdle;
    this.onIdle = null;
    fire?.();
    return effects;
  }

  /**
   * 取消决定。过期票据、没有进程、没有会话、既没等待者也没放手租约，都是空操作。
   * 真正发 `session/cancel` 和宽限定时的是门面。
   */
  cancelTurn(input: {
    readonly ticket?: TurnTicket;
    readonly hasProc: boolean;
    readonly sessionId: string | null;
  }): CancelDecision {
    const waiter = this.onIdle;
    if (!input.hasProc || input.sessionId === null || (waiter === null && this.detachedLease === null)) {
      return { type: 'noop' };
    }
    if (input.ticket !== undefined && !this.ticketMatches(input.ticket)) {
      return {
        type: 'stale',
        line: `  取消    票据过期（#${input.ticket.no}/${input.ticket.gen}）→ 丢弃`,
      };
    }
    this.cancelRequested = true;
    let droppedLease = false;
    if (this.detachedLease !== null) {
      this.detachedLease = null;
      this.syncSpontaneous();
      if (this.turnPhase === 'detached_running') {
        this.turnPhase = 'idle';
      }
      droppedLease = true;
    }
    return {
      type: 'cancel',
      sessionId: input.sessionId,
      graceWaiter: waiter,
      droppedLease,
    };
  }

  /** 取消宽限到期：等待者还是当初那个才叫醒。 */
  releaseGrace(waiter: (() => void) | null): void {
    if (waiter !== null && this.onIdle === waiter) {
      this.onIdle = null;
      waiter();
    }
  }

  /** 当前代进程退出：把还在等 idle 的那一轮放开。`clearTurnState` 不清这个槽。 */
  wakeIdle(): void {
    if (this.onIdle === null) return;
    const fire = this.onIdle;
    this.onIdle = null;
    fire();
  }

  /**
   * 认轮次边界。子会话（对不上 `openSessionId`）直接丢掉。
   */
  observeTurnBoundary(
    event: Record<string, unknown>,
    eventSessionId: unknown,
    openSessionId: string | null,
    hasAnnounce: boolean,
  ): TurnEffect[] {
    const type = typeof event['type'] === 'string' ? event['type'] : '';
    if (type !== 'turn/start' && type !== 'turn/end') return [];
    if (!isMainSession(eventSessionId, openSessionId)) return [];
    const data = event['data'] as Record<string, unknown> | undefined;
    const turn = typeof data?.['turn'] === 'number' ? data['turn'] : null;
    if (type === 'turn/start') {
      this.noteTurnStart(turn);
      return [];
    }
    return this.noteTurnEnd(turn, data, hasAnnounce);
  }

  /** `turn/start`：把轮号安到前台、放手租约或吞尾上，三处不会抢同一个号。 */
  noteTurnStart(turn: number | null): void {
    const oldSpontaneousStart = this.tailSwallow?.phase === 'awaiting_old_turn_start';
    if (!oldSpontaneousStart) {
      this.bindUnscopedLease(turn);
      const leaseTurn = this.detachedLease?.turnNo ?? null;
      const thisIsLease = leaseTurn !== null && turn === leaseTurn;
      // 旧委派轮自己的 start 不能算成新前台轮，否则新轮的 idle 会被当成它的尾巴
      if (this.foregroundActive && !this.foregroundDetached && !thisIsLease) {
        this.foregroundTurn = turn;
      }
    }
    this.currentTurn = turn;
    if (oldSpontaneousStart && this.tailSwallow !== null) {
      // 这是被顶掉的旧自发轮自己的 turn/start，它的 idle 还在后面，不能现在解除保护
      this.tailSwallow = {
        phase: 'awaiting_old_idle',
        turnNo: this.tailSwallow.turnNo ?? turn,
      };
      return;
    }
    if (this.tailSwallow?.phase === 'awaiting_old_idle') {
      // 新一轮开起来了：上一轮那条 idle 要么已经来过、要么不会来了
      this.tailSwallow = null;
    }
  }

  /** `turn/end`：轮号对得上才结算租约。新前台轮已经开始时，不再武装会吞掉它 idle 的尾巴。 */
  noteTurnEnd(
    turn: number | null,
    data: Record<string, unknown> | undefined,
    hasAnnounce: boolean,
  ): TurnEffect[] {
    const newerForeground = this.foregroundActive
      && !this.foregroundDetached
      && this.foregroundTurn !== null
      && turn !== null
      && this.foregroundTurn !== turn;
    if (!newerForeground && (turn === null || this.currentTurn === null || this.currentTurn === turn)) {
      this.currentTurn = null;
    }
    const lease = this.detachedLease;
    const settles = lease !== null && (lease.turnNo === null || lease.turnNo === turn);
    if (!settles || lease === null) return [];

    const userText = lease.userText;
    const text = lease.text.trim();
    this.detachedLease = null;
    this.syncSpontaneous();
    // 新一轮如果已经臂上（`prompting_rpc` / `awaiting_idle`），别把它的相位打回 idle。
    if (this.turnPhase === 'detached_running') {
      this.turnPhase = 'idle';
    }
    if (newerForeground) {
      // 新前台轮的 turn/start 已经来过：下一条 idle 是它的，旧尾巴不能再武装
      if (this.tailSwallow !== null && this.tailSwallow.turnNo !== this.foregroundTurn) {
        this.tailSwallow = null;
      }
    } else {
      // 同一轮的 idle 紧跟着就来，它属于这一轮（不是新一轮的）
      this.tailSwallow = { phase: 'awaiting_old_idle', turnNo: turn };
    }
    if (text === '') return [];
    // 回注记忆先于「要不要补播」：答案是真的，用户听没听到是另一回事。
    // `onIdle === null` 表示没有新一轮在等 → 下面会走播报，用户能听到。
    const willSpeak = this.onIdle === null && hasAnnounce;
    const effects: TurnEffect[] = [
      { type: 'detached-answer', userText, answer: text, spoken: willSpeak },
    ];
    if (this.onIdle !== null) {
      effects.push({ type: 'log', line: '  放手    答案回来时用户已经问了新问题 → 不补播（已回注记忆）' });
      return effects;
    }
    if (hasAnnounce) {
      const reason = data?.['reason'] as Record<string, unknown> | undefined;
      const kind = typeof reason?.['kind'] === 'string' ? reason['kind'] : '';
      effects.push({
        type: 'log',
        line: `  放手    委派轮跑完了${kind === '' ? '' : `（${kind}）`} → 答案转成播报`,
      });
      effects.push({ type: 'announce', text });
    }
    return effects;
  }

  /**
   * 这条 `assistant/message` 归放手租约（写 `detachedLease.text`）还是前台轮。
   *
   * @returns `true` = 写进了前台 `assistantText`，调用方可以累加 usage / 首 token
   */
  acceptAssistantText(data: Record<string, unknown> | undefined, text: string): boolean {
    const explicit = typeof data?.['turn'] === 'number' ? data['turn'] : null;
    const turn = explicit ?? this.currentTurn;
    if (this.leaseOwns(explicit, turn)) {
      const lease = this.detachedLease;
      if (lease !== null) lease.text = text;
      return false;
    }
    if (this.tailSwallow !== null) {
      // 被顶掉的旧自发轮（或刚结算放手轮）残余消息：绝不污染新一轮的 assistantText 与用量
      return false;
    }
    this.assistantText = text;
    return true;
  }

  /**
   * 主会话的 `session.status`。子会话在这里再挡一次。
   * 吞尾、放手租约、自发轮、叫醒前台等待者，都只看这 16 个槽。
   */
  consumeStatus(
    status: string,
    eventSessionId: unknown,
    openSessionId: string | null,
  ): TurnEffect[] {
    if (!isMainSession(eventSessionId, openSessionId)) return [];
    if (status === 'idle' && this.tailSwallow !== null) {
      const bound = this.tailSwallow.turnNo;
      const superseded = this.foregroundActive
        && this.foregroundTurn !== null
        && bound !== this.foregroundTurn;
      this.tailSwallow = null;
      if (!superseded) return [];
    }
    if (this.detachedLease !== null) {
      this.syncSpontaneous();
      if (status === 'idle' && this.onIdle !== null) {
        const fire = this.onIdle;
        this.onIdle = null;
        fire();
      }
      return [];
    }
    const waiting = this.onIdle !== null;
    const verdict = this.spontaneous.onStatus(status, waiting);
    if (verdict === 'begin') {
      // 自发轮次开始：清掉上一轮的残留文本，否则会把旧回复当成本次结果播出去
      this.assistantText = '';
      return [{ type: 'log', line: '[sdk] 后台任务结算 → agent 自发开了一轮（不是我们催的）' }];
    }
    if (verdict === 'settle') {
      const text = this.assistantText.trim();
      this.assistantText = '';
      return text === '' ? [] : [{ type: 'announce', text }];
    }
    if (status === 'idle' && this.onIdle !== null) {
      const fire = this.onIdle;
      this.onIdle = null;
      fire();
    }
    return [];
  }

  /**
   * 传入的票据是不是「当前正在臂上的那一轮」。
   *
   * `activeTicket === null` 时一律不是：轮次已经收尾（或还没写上票据），
   * 过期票据不能靠这个空窗放行。
   */
  private ticketMatches(ticket: TurnTicket): boolean {
    const active = this.activeTicket;
    return active !== null && ticket.no === active.no && ticket.gen === active.gen;
  }

  /**
   * 放手时还没有轮号：下一条不是「已经绑上的前台轮」的 `turn/start` 就是它。
   * 前台已经有自己的轮号时不再改租约，避免把新轮认成旧轮。
   */
  private bindUnscopedLease(turn: number | null): void {
    const lease = this.detachedLease;
    if (lease === null || lease.turnNo !== null || turn === null) return;
    const foregroundBound = this.foregroundActive
      && !this.foregroundDetached
      && this.foregroundTurn !== null;
    if (foregroundBound) return;
    this.detachedLease = { turnNo: turn, userText: lease.userText, text: lease.text };
  }

  /** `data.turn`（没有就用当前 `turn/start`）是不是放手租约那一轮，且不是正在跑的另一条前台轮。 */
  private leaseOwns(explicit: number | null, turn: number | null): boolean {
    const lease = this.detachedLease;
    if (lease === null) return false;
    if (this.foregroundOwns(turn)) return false;
    if (lease.turnNo !== null) {
      return (explicit ?? turn) === lease.turnNo;
    }
    // 还没绑上轮号。前台 ask 已经在跑时，未分轮的文本一律不进旧租约。
    if (this.foregroundActive && !this.foregroundDetached) return false;
    if (this.tailSwallow !== null) return false;
    return true;
  }

  /** 当前前台轮正在跑，且这条文本的轮号就是它（不是刚放手的那一轮）。 */
  private foregroundOwns(turn: number | null): boolean {
    if (!this.foregroundActive || this.foregroundDetached) return false;
    if (this.foregroundTurn === null || turn === null) return false;
    return turn === this.foregroundTurn;
  }

  /** 这条吞尾如果还留着，会把即将开始的前台轮的 `idle` 吃掉。 */
  private tailSwallowIsStale(): boolean {
    const swallow = this.tailSwallow;
    if (swallow === null) return false;
    const bound = swallow.turnNo;
    if (bound === null) return true;
    if (this.currentTurn !== null && this.currentTurn !== bound) return true;
    const leaseTurn = this.detachedLease?.turnNo ?? null;
    if (leaseTurn !== null && leaseTurn !== bound) return true;
    return false;
  }

  /** 有放手租约时按住自发轮，没有时放开。 */
  private syncSpontaneous(): void {
    this.spontaneous.suppress(this.detachedLease !== null);
  }
}
