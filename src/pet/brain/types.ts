/**
 * 宠物层的端口、状态与意图类型。**纯类型文件，不含判断**。
 *
 * 对应 `docs/adr/0001-app-layer-and-pet.md` §3（端口）与 §5.1（状态）。
 *
 * <h2>分层纪律</h2>
 *
 * - 这一层**不读时钟**：`now` 与 `localHour` 由输入带进来（`Clock` 只给执行器用）。
 * - 这一层**不做 I/O**：副作用只能通过 {@link PetIntent} 表达，由执行器落地。
 * - 端口只有四个：`Clock` / `Voice` / `Device` / `Agent`。多一个就说明状态机在偷偷做别的事。
 */
import type { DeviceCall, DeviceCapabilities } from '../../devices/primitives.ts';
import type { Emotion } from '../../emotion.ts';
import type { Cancel, Clock } from '../../app/clock.ts';

export type { Cancel, Clock };

// ---------------------------------------------------------------- 端口

/** 一次朗读的结束方式：正常说完 / 被 {@link Voice.stop} 打断。 */
export type SpeakResult = 'done' | 'cut';

/**
 * 语音端口：**只说一句话**，不负责编排。
 *
 * 「播没播完」由这个端口的实现决定：生产先按时长估算，以后换设备回执；
 * 模拟按字数推进虚拟时钟。上层只认 `done` / `cut`。
 */
export interface Voice {
  /**
   * @param signal 被打断时 abort；实现必须尽快停下并 resolve 成 `'cut'`
   */
  speak(text: string, emotion: Emotion | null, signal: AbortSignal): Promise<SpeakResult>;
  /** 立刻停止当前朗读（`speak` 随之以 `'cut'` 结束） */
  stop(): void;
}

/** 设备端口：只下发操作，不看返回值（结果走输入回来）。 */
export interface DevicePort {
  call(call: DeviceCall): void;
}

/** 给 agent 的图片。与 `providers.ts` 的 `AgentImage` 同构。 */
export interface PetImage {
  readonly mimeType: string;
  readonly data: string;
}

/** 这一轮是谁发起的。**不能**冒充 `user`：档案里要能分开统计主动开口。 */
export interface PetSource {
  readonly kind: 'pet';
  readonly reason: Reason;
}

/** agent 的回复。`text` 为空 = 模型选择不说（`declined`）。 */
export interface PetReply {
  readonly text: string;
  readonly emotion?: Emotion;
}

/** Agent 端口：给一段结构化上下文，要一句话。 */
export interface AgentPort {
  /**
   * @param context 结构化上下文（不是提示词！措辞归适配器）
   * @param image 先看一眼拍到的画面；`null` = 这次没有画面
   * @param source 发起方标记
   */
  ask(context: PetContext, image: PetImage | null, source: PetSource): Promise<PetReply>;
}

// ---------------------------------------------------------------- 状态机词汇

/** 主动开口的理由。加新触发器时**只**在这里加一项。 */
export type Reason = 'greet' | 'chatter';

/** 一次主动开口计划的阶段。加新阶段时在这里、`PHASES` 与执行器各加一处。 */
export type PhaseId = 'look' | 'compose' | 'listen' | 'speak' | 'await';

/** 打断来源。加新来源时 `PhaseSpec.onInterrupt` 会编译报错，逼你补格子。 */
export type Interrupt = 'userActivity' | 'tap' | 'presenceLost' | 'floorTaken';

/** 一次主动开口的结局。 */
export type Outcome = 'engaged' | 'ignored' | 'dismissed' | 'declined' | 'abandoned' | 'failed' | 'aborted';

/** 闸门名。加新闸门时在这里与 `GATES` 各加一处。 */
export type GateId = 'worn' | 'floorFree' | 'notQuietHours' | 'batteryOk' | 'minGap';

/**
 * 一个阶段收到结果后的决断。
 *
 * `next` 表示进入计划的下一阶段（计划末阶段不允许出现，`validatePlan` 会拦）。
 */
export type Verdict =
  | { readonly kind: 'next' }
  | {
    readonly kind: 'end';
    readonly outcome: Outcome;
    readonly dismiss?: boolean;
    /** 发 `listen.stop`（只在本次 engagement 发过 `listen.start` 时生效） */
    readonly closeMic?: boolean;
  };

/** 阶段报回的结果名。`timeout` 是每个阶段隐含的一项，不用列在 `results` 里。 */
export type PhaseResultName<T extends string = string> = T | 'timeout';

// ---------------------------------------------------------------- 世界（由输入归约出的事实）

/** 话筒占用者。仲裁在应用层，宠物只读结果。 */
export type FloorOwner = 'user' | 'reply' | 'announce' | 'pet' | 'reflex';

/**
 * 宠物能看到的世界。**全部是事实，不含判断**。
 *
 * `wearing` 的三态：`true` / `false` / `null`（读不到）。设备不报佩戴时恒为 `null`，
 * 而 `worn` 闸门要求 `=== true` —— 读不到就不主动开口。
 */
export interface PetWorld {
  /** 单调时钟；由最近一条输入带来 */
  readonly now: number;
  /** 本地墙钟小时 */
  readonly localHour: number;
  readonly wearing: boolean | null;
  /** 上一次「开始戴着」的时刻；也是打招呼的去重键 */
  readonly donnedAt: number | null;
  /** 上一次离场时长；`null` = 没有一次已知的离场 */
  readonly lastAwayMs: number | null;
  /** 电量百分比；`null` = 读不到 */
  readonly battery: number | null;
  /** 用户最近一次说话（含中间结果） */
  readonly lastUserAt: number | null;
  /** 宠物或播报最近一次**出声**的时刻 */
  readonly lastVoiceAt: number | null;
  readonly floorBusy: boolean;
  readonly floorOwner: FloorOwner | null;
  /** 有一条后台汇报排队等着播 */
  readonly announcePending: boolean;
  readonly caps: DeviceCapabilities;
  /** 内部记账：已知离场的起点，用来算 `lastAwayMs`。不属于对外事实。 */
  readonly awaySince: number | null;
}

// ---------------------------------------------------------------- 主动开口的上下文与状态

/** 交给 agent 的结构化上下文。措辞由 agent 适配器决定。 */
export interface PetContext {
  readonly reason: Reason;
  /** 用来开口的那段时间（离开多久 / 安静多久），毫秒 */
  readonly elapsedMs: number;
  /** 设备能否不用人动手地看一眼（决定要不要先拍） */
  readonly hasImage: boolean;
  /** 触发时补充的事实，例如电量 */
  readonly notes?: Readonly<Record<string, string | number | boolean>>;
}

/** 阶段之间传递的数据。 */
export interface EngagementBag {
  /** `look` 拿到的图；`null` = 没拿到 */
  readonly image: PetImage | null;
  /** 这次拍照的关联 id；`null` = 没有在拍 */
  readonly captureId: string | null;
  /** `compose` 拿到的回复 */
  readonly text: string | null;
  readonly emotion: Emotion | null;
}

/** 一次主动开口的生命周期。`null` ⇔ idle。 */
export interface Engagement {
  /** 稳定的编号，结局记录按它关联 */
  readonly id: string;
  readonly reason: Reason;
  /** 候选去重键（`greet:<donnedAt>` / `chatter:<anchor>`） */
  readonly key: string;
  readonly plan: readonly PhaseId[];
  /** 当前阶段在 `plan` 里的下标 */
  readonly at: number;
  /** 每进一个阶段 +1；执行器报结果时带上，晚到的结果直接丢弃 */
  readonly step: number;
  readonly startedAt: number;
  readonly bag: EngagementBag;
  /** 触发时的上下文，`compose` 用它 */
  readonly context: PetContext;
  /** 进入 `speak` 的时刻；用来判断 `aborted` 算不算"已经出过声" */
  readonly spokeAt: number | null;
  /**
   * 麦到底开没开。
   *
   * `null` = 还没结论（计划里没有 `listen`，或 `listen` 还在等首帧）。
   * 以**首帧上行音频**为准，不用手机回执：`Queued` / SAR ACK 只证明命令进了队列，
   * 不证明设备在采集（ADR-0001 §5.4）。
   */
  readonly micOpened: boolean | null;
  /** 各阶段耗时累计（ms），进结局记录 */
  readonly durations: Readonly<Partial<Record<PhaseId, number>>>;
  /** 进入当前阶段的时刻 */
  readonly phaseEnteredAt: number;
}

/** 状态机状态。除了 `fired` 与 `seq` 全是事实或生命周期。 */
export interface PetState {
  readonly world: PetWorld;
  readonly engagement: Engagement | null;
  /** 已触发过的候选键（去重）；`abandoned` 会把它删掉 */
  readonly fired: ReadonlySet<string>;
  /** engagement 编号自增 */
  readonly seq: number;
}

// ---------------------------------------------------------------- 输入

/** 设备事件里宠物关心的部分，已经由适配层归一成输入。 */
export type PetDeviceInput =
  | { readonly kind: 'presence'; readonly wearing: boolean | null }
  | { readonly kind: 'power'; readonly percent: number | null }
  | { readonly kind: 'summon'; readonly opensSession: boolean };

/** 每条输入都带的时刻。状态机自己不读时钟。 */
export interface PetInputStamp {
  /** 单调毫秒 */
  readonly now: number;
  /** 本地墙钟小时 0–23 */
  readonly localHour: number;
}

/**
 * 阶段结果的负载。结果名决定"接下来做什么"，负载只提供要用的数据。
 *
 * 不放进 bag 直接改：状态机是纯的，负载必须随输入进来。
 */
export interface PhasePayload {
  readonly text?: string;
  readonly emotion?: Emotion;
  readonly image?: PetImage | null;
}

/** 进队列的每一条输入。 */
export type PetInput =
  /** 心跳。`idle → engaging` 只在这条输入上发生 */
  | ({ readonly kind: 'tick' } & PetInputStamp)
  /** 用户开口了（中间结果）。只当作"有动静"，不当成说完 */
  | ({ readonly kind: 'userPartial' } & PetInputStamp)
  /** 一句话定稿 */
  | ({ readonly kind: 'userFinal'; readonly text: string } & PetInputStamp)
  /** 设备事件：佩戴 */
  | ({ readonly kind: 'presence'; readonly wearing: boolean | null } & PetInputStamp)
  /** 设备事件：电量 */
  | ({ readonly kind: 'power'; readonly percent: number | null } & PetInputStamp)
  /** 设备事件：「招呼」手势 */
  | ({ readonly kind: 'summon'; readonly opensSession: boolean } & PetInputStamp)
  /** 话筒占用变化（由 `FloorArbiter` 报进来） */
  | ({
    readonly kind: 'floor';
    readonly busy: boolean;
    readonly owner: FloorOwner | null;
  } & PetInputStamp)
  /** 后台汇报队列有没有货 */
  | { readonly kind: 'announce'; readonly pending: boolean; readonly spoken: boolean } & PetInputStamp
  /** 一张图到了（主动拍照的结果；`image === null` 表示这次没拍到） */
  | ({ readonly kind: 'image'; readonly id: string; readonly image: PetImage | null } & PetInputStamp)
  /** 执行器报回阶段结果（带 `engagementId` + `step`，不属于当前这次的一律丢弃） */
  | ({
    readonly kind: 'phaseResult';
    readonly engagementId: string;
    readonly step: number;
    readonly phase: PhaseId;
    readonly result: PhaseResultName;
    readonly payload?: PhasePayload;
  } & PetInputStamp)
  /** 连接关闭 */
  | ({ readonly kind: 'closed' } & PetInputStamp)
  /**
   * 麦开了：`listen.start` 之后收到的**首帧上行音频**。
   *
   * 只有适配层能产出它 —— 它是"设备真的在采集"的唯一证据（ADR-0001 §5.4）。
   */
  | ({ readonly kind: 'micOpened' } & PetInputStamp);

/** 一条结局记录。每次 engagement 结束**恰好**一条。 */
export interface PetOutcomeRecord {
  readonly id: string;
  readonly reason: Reason;
  readonly outcome: Outcome;
  /** 结束时所处的阶段 */
  readonly phase: PhaseId;
  readonly durations: Readonly<Partial<Record<PhaseId, number>>>;
  readonly startedAt: number;
  readonly endedAt: number;
  /** 计划含 `listen` 时才有：麦到底开没开 */
  readonly micOpened?: boolean;
}

/**
 * 状态机产出的意图。执行器只认这些，**不做判断**。
 *
 * 加新意图时执行器会编译报错，逼你补处理函数。
 */
export type PetIntent =
  /** 进入一个阶段。`deadlineMs` 由执行器计时，到点报 `timeout` */
  | {
    readonly kind: 'phase.enter';
    readonly engagementId: string;
    readonly phase: PhaseId;
    readonly step: number;
    readonly plan: readonly PhaseId[];
    readonly context: PetContext;
    readonly deadlineMs: number | null;
    /** `look` 用的拍照 id（同一阶段内稳定） */
    readonly captureId: string | null;
    /** `speak` 要念的文本 */
    readonly text: string | null;
    readonly emotion: Emotion | null;
    /** `compose` 交给 agent 的画面；`null` = 这次没有画面 */
    readonly image: PetImage | null;
    /** `listen` 阶段要开麦多久（`listen.start` 的 `maxMs`）；`null` = 不开麦 */
    readonly listenMs: number | null;
    /** 这一阶段要不要把话筒占成 `pet` */
    readonly holdsFloor: boolean;
  }
  /** 一次主动开口结束。执行器据此收尾（停止计时、释放话筒、按需关麦） */
  | {
    readonly kind: 'end';
    readonly record: PetOutcomeRecord;
    readonly dismiss: boolean;
    readonly closeMic: boolean;
  }
  /** 快反射：播一段预合成短音（`here` = 「在呢」） */
  | { readonly kind: 'reflex'; readonly cue: 'here' }
  /** 关掉正在播的后台汇报 */
  | { readonly kind: 'announce.dismiss' };

/** 一次 `step` 的结果。 */
export interface PetStepResult {
  readonly state: PetState;
  readonly intents: readonly PetIntent[];
}
