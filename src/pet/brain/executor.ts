/**
 * `PetExecutor`：按意图执行副作用，把结果作为输入报回去。**它不做任何判断**。
 *
 * 对应 ADR-0001 §4 与 §5.4。
 *
 * 纪律：这里只该出现"怎么做"，一旦出现"要不要做"，就该搬回 `PetBrain`。
 * - 进入阶段：起截止计时、占话筒、发一条具体动作
 * - 报结果：带 `step`，过期的由状态机丢弃
 * - 收尾：停计时、abort、停播、释放话筒
 */
import type {
  AgentPort,
  Cancel,
  Clock,
  DevicePort,
  PetInput,
  PetIntent,
  PetOutcomeRecord,
  PhaseId,
  Voice,
} from './types.ts';
import type { FloorArbiter } from './floor.ts';

/** 报结果用的输入（`now` / `localHour` 由执行器补）。 */
export type PhaseReport = Omit<Extract<PetInput, { kind: 'phaseResult' }>, 'now' | 'localHour'>;
export type FloorReport = Omit<Extract<PetInput, { kind: 'floor' }>, 'now' | 'localHour'>;

export interface PetExecutorDeps {
  readonly clock: Clock;
  readonly voice: Voice;
  readonly device: DevicePort;
  readonly agent: AgentPort;
  readonly floor: FloorArbiter;
  /** 把阶段结果送回状态机 */
  readonly report: (input: PhaseReport | FloorReport) => void;
  /** 一次主动开口结束时的钩子（档案 / 播报队列用） */
  readonly onOutcome?: (record: PetOutcomeRecord, dismiss: boolean) => void;
  /** 用户敲击要关掉正在播的后台汇报 */
  readonly dismissAnnounce?: () => void;
  /** 观测钩子（档案用）。不参与判定。 */
  readonly onEvent?: (name: string, fields: Record<string, unknown>) => void;
  readonly log?: (line: string) => void;
}

interface Running {
  readonly engagementId: string;
  readonly step: number;
  readonly phase: PhaseId;
  readonly holdsFloor: boolean;
  /** 本次阶段之前是否发过 `listen.start`（决定 `closeMic` 生不生效） */
  readonly micRequested: boolean;
  readonly cancelDeadline: Cancel | null;
  readonly controller: AbortController;
}

export class PetExecutor {
  private readonly deps: PetExecutorDeps;
  private running: Running | null = null;
  /**
   * 哪个 engagement 手里攥着话筒。
   *
   * 跨阶段保存：`listen` 与 `speak` 都占话筒，而阶段之间会 teardown；
   * 挂在阶段上就会在 listen→speak 之间放掉一下（ADR-0001 §6 要求整段占用）。
   */
  private floorHeldFor: string | null = null;
  /**
   * 哪个 engagement 发过 `listen.start` 还没关麦。
   *
   * 跨阶段保存：`listen` 阶段开的麦要留到 `speak` / `await` 结束，
   * 所以不能挂在阶段级的 {@link Running} 上。
   */
  private micOpenFor: string | null = null;

  constructor(deps: PetExecutorDeps) {
    this.deps = deps;
  }

  /** 执行一条意图。返回的 promise 表示这条意图的副作用已经落地。 */
  async run(intent: PetIntent): Promise<void> {
    switch (intent.kind) {
      case 'phase.enter':
        await this.enter(intent);
        return;
      case 'end':
        this.end(intent.record, intent.dismiss, intent.closeMic);
        return;
      case 'reflex':
        // 快反射要预合成的短音（「在呢」）；还没有素材，只记日志
        this.log(`敲击（${intent.cue}），没有短音素材，略过`);
        return;
      case 'announce.dismiss':
        // 敲击关播报：这不是一次主动开口，不能伪造一条 pet.outcome
        this.deps.onEvent?.('announce.dismissed', {});
        this.deps.dismissAnnounce?.();
        return;
      default: {
        // 新增意图时这里会编译报错
        const never: never = intent;
        throw new Error(`pet: 未知意图 ${JSON.stringify(never)}`);
      }
    }
  }

  /** 连接关闭时调用：丢掉在途的计时与朗读。 */
  dispose(): void {
    this.teardown();
    // 连接都没了，麦和话筒都不会留；清掉记录免得下一次 engagement 误判
    if (this.floorHeldFor !== null) {
      this.deps.floor.release('pet');
      this.floorHeldFor = null;
    }
    this.micOpenFor = null;
  }

  private async enter(intent: Extract<PetIntent, { kind: 'phase.enter' }>): Promise<void> {
    // 上一阶段已经结束；这里只清理计时器与 abort（幂等）
    this.teardown();

    if (intent.holdsFloor && this.floorHeldFor !== intent.engagementId) {
      if (!this.deps.floor.acquire('pet')) {
        // 话筒被别人占着：按 floorTaken 处理，交给状态机决断
        this.deps.report({ kind: 'floor', busy: true, owner: this.deps.floor.owner });
        return;
      }
      this.floorHeldFor = intent.engagementId;
    }

    const controller = new AbortController();
    const cancelDeadline = intent.deadlineMs === null
      ? null
      : this.deps.clock.after(intent.deadlineMs, () => {
        this.deps.report({
          kind: 'phaseResult',
          engagementId: intent.engagementId,
          step: intent.step,
          phase: intent.phase,
          result: 'timeout',
        });
      });

    this.running = {
      engagementId: intent.engagementId,
      step: intent.step,
      phase: intent.phase,
      holdsFloor: intent.holdsFloor,
      micRequested: this.micOpenFor === intent.engagementId,
      cancelDeadline,
      controller,
    };

    switch (intent.phase) {
      case 'look': {
        const id = intent.captureId;
        if (id === null) {
          throw new Error('pet: look 阶段没有 captureId');
        }
        this.deps.device.call({
          op: 'capture',
          id,
          intent: 'glance',
          deadlineMs: intent.deadlineMs ?? 4_000,
        });
        return;
      }
      case 'compose': {
        try {
          const reply = await this.deps.agent.ask(
            intent.context,
            intent.image,
            { kind: 'pet', reason: intent.context.reason },
          );
          const text = reply.text.trim();
          if (text === '') {
            // 模型选择不说：这是合法结局，不是错误
            this.reportCurrent(intent, 'declined');
            return;
          }
          this.reportCurrent(intent, 'reply', {
            text,
            ...(reply.emotion === undefined ? {} : { emotion: reply.emotion }),
          });
        } catch (error) {
          // 端口抛错也要落地成结果，否则这次 engagement 会一直挂着等截止
          this.log(`agent 出错：${String(error)}`);
          this.reportCurrent(intent, 'error');
        }
        return;
      }
      case 'listen': {
        // 只开麦、等首帧：结果由 `micOpened` 输入或本阶段的截止报回，这里不 await
        this.deps.device.call({ op: 'listen.start', maxMs: intent.listenMs ?? 0 });
        this.micOpenFor = intent.engagementId;
        return;
      }
      case 'speak': {
        try {
          this.deps.onEvent?.('pet.speak', {
            engagementId: intent.engagementId,
            step: intent.step,
            text: intent.text ?? '',
          });
          const result = await this.deps.voice.speak(
            intent.text ?? '',
            intent.emotion,
            controller.signal,
          );
          this.reportCurrent(intent, result);
        } catch (error) {
          this.log(`朗读出错：${String(error)}`);
          this.reportCurrent(intent, 'cut');
        }
        return;
      }
      case 'await':
        // 只等截止；到点由计时器报 timeout，状态机映射成 ignored
        return;
      default: {
        const never: never = intent.phase;
        throw new Error(`pet: 未知阶段 ${String(never)}`);
      }
    }
  }

  /** 报一个结果，但只在它还属于当前阶段时（被打断后的迟到结果直接丢）。 */
  private reportCurrent(
    intent: Extract<PetIntent, { kind: 'phase.enter' }>,
    result: 'got' | 'none' | 'reply' | 'declined' | 'error' | 'done' | 'cut' | 'expired',
    payload?: Extract<PetInput, { kind: 'phaseResult' }>['payload'],
  ): void {
    const running = this.running;
    if (running === null
      || running.step !== intent.step
      || running.engagementId !== intent.engagementId) {
      return;
    }
    this.deps.report({
      kind: 'phaseResult',
      engagementId: intent.engagementId,
      step: intent.step,
      phase: intent.phase,
      result,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  private end(record: PetOutcomeRecord, dismiss: boolean, closeMic: boolean): void {
    if (dismiss) {
      // 停播必须听见就停
      this.deps.voice.stop();
    }
    // 关麦只在本次 engagement 真开过麦时做（ADR-0001 §5.5）
    if (closeMic && this.micOpenFor === record.id) {
      this.deps.device.call({ op: 'listen.stop' });
      this.micOpenFor = null;
    }
    this.teardown();
    this.releaseFloor(record.id);
    this.deps.onOutcome?.(record, dismiss);
  }

  /** 放掉整段 engagement 占着的话筒。 */
  private releaseFloor(engagementId: string): void {
    if (this.floorHeldFor !== engagementId) {
      return;
    }
    this.deps.floor.release('pet');
    this.floorHeldFor = null;
  }

  private teardown(): void {
    const running = this.running;
    if (running === null) {
      return;
    }
    running.cancelDeadline?.();
    running.controller.abort();
    // 话筒不在这里放：它属于整段 engagement（listen + speak），到 `end` 才交还
    this.running = null;
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}
