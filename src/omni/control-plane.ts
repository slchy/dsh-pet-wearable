/**
 * 回到 ready 之前积压的控制帧。唯一顺序器是 `flushReady`：
 * orphans → deletes → toolOutputs → dynamicContext（整份 session.update）→ injects。
 *
 * 只在 `state === 'ready' && resp === null && socketOpen` 时冲刷。
 * 发声队列另走 `takeSpeech`：announce 见脏音频退回队头并停，ack 不看脏音频，
 * 占到一条就返回，不连发第二条 `response.create`。
 */
import { isSettled } from './response.ts';
import type {
  OmniShadowState,
  OrphanRecord,
  PendingToolOutput,
  QueuedSpeech,
} from './types.ts';

/** 回注排队上限。委派轮本来就是低频事件，多了说明哪里不对 */
const MAX_PENDING_INJECTS = 4;
/** 忙时积压的工具回执上限。再多说明闭环没人收，丢掉最早的 */
const MAX_PENDING_TOOL_OUTPUTS = 8;
/** 忙时积压的 `conversation.item.delete` 上限（去重后）。再多丢掉最早的 */
const MAX_PENDING_DELETES = 32;
/** 文本提示发声队列上限（防异常堆积，超出丢最早一条并唤醒其读端） */
const MAX_SPEECH_QUEUE = 8;
/** 「没人认领的回复」最多记几份再一次性清。多了说明上游一直没出整句 */
const MAX_ORPHANS = 8;

export interface ControlGate {
  readonly state: OmniShadowState;
  readonly hasResp: boolean;
  readonly socketOpen: boolean;
}

export interface ControlPlaneDeps {
  readonly send: (payload: object) => void;
  readonly log: (line: string) => void;
  /** 用当前动态事实拼整份 `session.update`（含 `turn_detection: null` 与 tools）。 */
  readonly sessionUpdate: (dynamicContext: string) => Record<string, unknown>;
  readonly gate: () => ControlGate;
  readonly onAbortQueued: (entry: QueuedSpeech) => void;
}

export class ControlPlane {
  speechQueue: QueuedSpeech[] = [];
  injects: string[] = [];
  injectsSent = 0;
  readonly pendingToolOutputs: PendingToolOutput[] = [];
  readonly pendingDeletes: string[] = [];
  orphans: OrphanRecord[] = [];
  dynamicContext = '';
  sentDynamicContext = '';
  dynamicContextDirty = false;
  private readonly deps: ControlPlaneDeps;

  constructor(deps: ControlPlaneDeps) {
    this.deps = deps;
  }

  /**
   * 回到 ready、且没有在途回复、socket 已开时，按固定顺序把积压发出去。
   * 顺序不能换：先清没人听过的历史，再补工具回执和动态事实，最后才是回注。
   */
  flushReady(): void {
    if (!this.canSendControl()) {
      return;
    }
    this.flushOrphans();
    this.flushDeletes();
    this.flushToolOutputs();
    this.flushDynamicContext();
    this.flushInjects();
  }

  /** 删掉「答了但没人听过」的那些回复。`restart()` 也会直接调，不看 ready。 */
  flushOrphans(): void {
    const list = this.orphans.splice(0);
    if (list.length === 0) {
      return;
    }
    for (const one of list) {
      for (const id of one.assistant) {
        this.deps.send({ type: 'conversation.item.delete', item_id: id });
      }
      if (one.user !== null) {
        this.deps.send({ type: 'conversation.item.delete', item_id: one.user });
      }
    }
    this.deps.log(`[omni] 清掉 ${list.length} 份没人认领的回复（用户没听过）`);
  }

  flushDeletes(): void {
    if (!this.canSendControl()) {
      return;
    }
    for (const id of this.pendingDeletes.splice(0)) {
      this.deps.send({ type: 'conversation.item.delete', item_id: id });
    }
  }

  flushToolOutputs(): void {
    if (!this.canSendControl()) {
      return;
    }
    for (const entry of this.pendingToolOutputs.splice(0)) {
      this.deps.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: entry.callId, output: entry.output },
      });
    }
  }

  /**
   * 单槽动态事实变了就重发**整份** `session.update`。
   * 局部 update 会把 `turn_detection` 或 `tools` 重置掉。
   */
  flushDynamicContext(): void {
    if (!this.canSendControl() || !this.dynamicContextDirty) {
      return;
    }
    this.deps.send(this.sessionPayload());
    this.markSessionSynced();
  }

  /** 只有 `ready` 才发。不看 `resp`：调用点要么还没占槽，要么本来就在 ready。 */
  flushInjects(): void {
    if (this.deps.gate().state !== 'ready' || this.injects.length === 0) {
      return;
    }
    for (const text of this.injects.splice(0)) {
      this.deps.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
    }
  }

  sessionPayload(): Record<string, unknown> {
    return this.deps.sessionUpdate(this.dynamicContext);
  }

  /** 握手或动态事实刷新把当前槽标成已发出。 */
  markSessionSynced(): void {
    this.sentDynamicContext = this.dynamicContext;
    this.dynamicContextDirty = false;
  }

  countInject(): void {
    this.injectsSent += 1;
  }

  pushInject(text: string): void {
    if (this.injects.length >= MAX_PENDING_INJECTS) {
      this.injects.shift();
      this.deps.log('[omni] 回注队列满，丢掉最早的一条');
    }
    this.injects.push(text);
  }

  /**
   * 用唯一单槽刷新动态事实。与当前值、已发送值都相同且没有脏标记时直接返回。
   * 忙时只保留最新一份；门开着就立刻发整份 session。
   */
  updateDynamicContext(snapshot: string): void {
    const normalized = snapshot.trim();
    if (normalized === this.dynamicContext && !this.dynamicContextDirty
      && normalized === this.sentDynamicContext) {
      return;
    }
    this.dynamicContext = normalized;
    this.dynamicContextDirty = normalized !== this.sentDynamicContext;
    this.flushDynamicContext();
  }

  sendFunctionCallOutput(callId: string, output: string): void {
    const gate = this.deps.gate();
    if (callId === '' || output === '' || gate.state === 'broken' || !gate.socketOpen) {
      return;
    }
    this.pendingToolOutputs.push({ callId, output });
    if (this.pendingToolOutputs.length > MAX_PENDING_TOOL_OUTPUTS) {
      this.pendingToolOutputs.shift();
    }
    if (gate.state === 'ready' && !gate.hasResp) {
      this.flushToolOutputs();
    }
  }

  deleteItems(itemIds: readonly string[]): void {
    const gate = this.deps.gate();
    if (gate.state === 'broken' || !gate.socketOpen) {
      return;
    }
    for (const id of itemIds) {
      if (id === '' || this.pendingDeletes.includes(id)) {
        continue;
      }
      this.pendingDeletes.push(id);
      if (this.pendingDeletes.length > MAX_PENDING_DELETES) {
        this.pendingDeletes.shift();
      }
    }
    if (gate.state === 'ready' && !gate.hasResp) {
      this.flushDeletes();
    }
  }

  rememberOrphan(one: OrphanRecord): void {
    this.orphans.push(one);
    if (this.orphans.length > MAX_ORPHANS) {
      this.orphans.shift();
    }
  }

  enqueue(entry: QueuedSpeech): void {
    while (this.speechQueue.length >= MAX_SPEECH_QUEUE) {
      const dropped = this.speechQueue.shift();
      if (dropped !== undefined) {
        this.deps.onAbortQueued(dropped);
        this.deps.log('[omni] 发声队列满，丢掉最早一条');
      }
    }
    this.speechQueue.push(entry);
  }

  /** 还在队列里就摘掉，不负责收口。调用方决定要不要作废这份回复。 */
  takeIfQueued(entry: QueuedSpeech): boolean {
    const idx = this.speechQueue.indexOf(entry);
    if (idx < 0) {
      return false;
    }
    this.speechQueue.splice(idx, 1);
    return true;
  }

  clearSpeech(kind?: 'ack' | 'announce'): void {
    if (this.speechQueue.length === 0) {
      return;
    }
    if (kind === undefined) {
      for (const entry of this.speechQueue.splice(0)) {
        this.deps.onAbortQueued(entry);
      }
      return;
    }
    const kept: QueuedSpeech[] = [];
    for (const entry of this.speechQueue.splice(0)) {
      if (entry.kind === kind) {
        this.deps.onAbortQueued(entry);
      } else {
        kept.push(entry);
      }
    }
    this.speechQueue = kept;
  }

  /**
   * 取出至多一条可以开口的排队发声。
   * announce 见 `dirtyBytes > 0` 退回队头并停止；ack 不看脏音频。
   * 决定发出去之前先 `flushReady`（此时仍是 ready、没有 resp），然后立刻返回，
   * 调用方占槽，不许再取下一条。
   */
  takeSpeech(dirtyBytes: number, hasPendingSeal: boolean): QueuedSpeech | null {
    const gate = this.deps.gate();
    if (gate.state !== 'ready' || gate.hasResp || hasPendingSeal) {
      return null;
    }
    while (this.speechQueue.length > 0) {
      const next = this.speechQueue.shift();
      if (next === undefined) {
        return null;
      }
      if (next.cancelled || isSettled(next.resp)) {
        continue;
      }
      if (next.kind === 'announce' && dirtyBytes > 0) {
        this.speechQueue.unshift(next);
        return null;
      }
      this.flushReady();
      return next;
    }
    return null;
  }

  /** 断线：工具回执和删项队列作废，动态事实的脏标记清掉。正文槽和回注计数留着。 */
  clearTransient(): void {
    this.pendingToolOutputs.length = 0;
    this.pendingDeletes.length = 0;
    this.dynamicContextDirty = false;
  }

  private canSendControl(): boolean {
    const gate = this.deps.gate();
    return gate.state === 'ready' && !gate.hasResp && gate.socketOpen;
  }
}
