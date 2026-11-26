/**
 * omni 影子旁路的共享类型。协调器、账本、控制面、socket 都从这里取，
 * 避免把同一份字段形状再抄一份。
 */
import type { DelegateReason, InjectKind } from '../providers.ts';
import type { RealtimeSocket, RealtimeSocketFactory } from '../qwen-realtime-asr.ts';
import type { RealtimeDialect } from '../realtime-dialect.ts';

export type { DelegateReason, InjectKind, RealtimeDialect, RealtimeSocket, RealtimeSocketFactory };

export type OmniShadowState = 'idle' | 'connecting' | 'ready' | 'busy' | 'broken';

export interface OmniShadowOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  /** Realtime 协议方言（`dashscope` | `openai-beta` | `openai-ga`）；缺省按 URL 推断，默认 `dashscope`。 */
  readonly dialect?: RealtimeDialect;
  /** 输出音色；空白不传。 */
  readonly voice?: string;
  /** 输入音频转写模型名；缺省按方言默认。 */
  readonly asrModel?: string;
  /** 附加握手请求头。 */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly instructions?: string;
  /**
   * `MEMORY.md` 里挑出来的事实。建连时追加一次；空白当没传；超过 600 字截断。
   *
   * 只是事实，不是「要不要调工具」的暗示。不传时 `instructions` 与原来逐字一致。
   */
  readonly memoryContext?: string;
  /**
   * 建连时调用**一次**，返回当前日期事实，例如
   * `当前日期：2026年11月24日 星期二（北京时间）`。空白当没传。
   */
  readonly clockContext?: () => string;
  /**
   * ASR 热词。非空时放进 `input_audio_transcription.corpus.text`。
   * 不传或空串时该字段不出现。
   */
  readonly asrCorpusText?: string;
  /**
   * ASR 语言。非空时放进 `input_audio_transcription.language`。
   * 不传或空串时该字段不出现。
   */
  readonly asrLanguage?: string;
  /** 一份 seal 的结果 → 会话档案（`omni.shadow`） */
  readonly emit: (data: Record<string, unknown>) => void;
  readonly log?: (line: string) => void;
  /** 可注入时钟（ms），测试用 */
  readonly now?: () => number;
  /** 测试注入；生产用 `ws` */
  readonly socketFactory?: RealtimeSocketFactory;
  /** 握手多久没就绪算废 */
  readonly connectTimeoutMs?: number;
  /** 一份 response 多久没 done 算废（不是性能判据，只是防挂死） */
  readonly responseTimeoutMs?: number;
  readonly ringMs?: number;
  /**
   * 认领模式。
   *
   * - `off`（默认）：只测不发声 —— 音频仍会攒着（S0 也要用它算 `out_s`），
   *   但没人认领，`willServe()` 恒 false
   * - `full`：与文本快车道同口径，并段轮也答
   *
   * 曾经有一个 `clip`（只答单段轮）的中间档。真机两场之后砍掉了：
   * 它拒掉的并段轮实测回答质量与全量无差别，而真正需要担心的「掐半句」
   * 22 轮里只出现 3 次、且全是**用户自己插话**（`interrupted=True`）。
   * 留着中间态只会让「线上到底是哪一档」变成一个要记的事。
   */
  readonly serve?: 'off' | 'full';
}

/** 一份 seal 的身份与起点 */
export interface SealMeta {
  readonly seq: number;
  readonly silenceMs: number;
  /** 调用 `seal()` 的时刻 —— `audio_ms` 从这里算，**包含等 cancel 的那段** */
  readonly anchor: number;
  /** 这一段推了多少音频（字节） */
  readonly bytes: number;
  /** `restart()` 时顺手 flush 掉的残留（ms），0 = 没有 */
  readonly flushedMs: number;
}

/** 这份回复是谁开的。用户封段和后台汇报绝不能混成同一条读端。 */
export type ResponseOrigin = 'user' | 'announce';

/**
 * 一份 `response.create` 的生命周期。四个布尔（created / cancelPending /
 * cancelled / closed）叠出来的 16 种组合里大部分到不了，相位只留合法的几步：
 *
 * - `starting`：create 已发，`response.created` 还没到
 * - `live`：服务端已经 created，正在生成
 * - `cancel_when_created`：created 之前就被要求取消（这时发 cancel 会被拒）
 * - `cancelling`：`response.cancel` 已经补发出去，等 `response.done`
 * - `done`：`response.done` 到了，或本地直接收口（断线、排队项作废）
 */
export type ResponsePhase = 'starting' | 'live' | 'cancel_when_created' | 'cancelling' | 'done';

/** 一份读端在 `audio` 上的游标。不 `shift()`，所以两个读端不会把同一块拆走。 */
export interface AudioCursor {
  index: number;
  epoch: number;
}

export interface PendingResponse {
  readonly meta: SealMeta;
  /**
   * `user`：`seal()` 或 `answerFromText()` 开出来的。`announce`：`speakFromText` 开出来的。
   *
   * 用户 `claim()` 不许把 announce 交出去；announce 的读端也不许顺着 `next`
   * 去拿用户下一段的音频。文本直答虽然也是 `user`，但一建出来就是 `claimed`，
   * 读端只绑自己那一份，不会把下一次封段的音频抢走。
   */
  readonly origin: ResponseOrigin;
  /** commit+create 真正发出去的时刻（撞 busy 时晚于 anchor） */
  readonly sentAt: number;
  ackAt: number | null;
  finalAt: number | null;
  firstTextAt: number | null;
  firstAudioAt: number | null;
  outBytes: number;
  /** 见 {@link ResponsePhase}。取消有没有发生，收尾后看 {@link PendingResponse.endedByCancel}。 */
  phase: ResponsePhase;
  /**
   * 只在 `phase === 'done'` 时有意义：这次收尾是不是取消。
   * 进 `done` 时写一次，不再跟别的标志互相改。
   */
  endedByCancel: boolean;
  /**
   * 音频**从封段就开始攒**，不是认领才开始。
   *
   * 为什么必须这样：认领发生在定稿（~220 ms），但判停延拍时能到 700–870 ms，
   * 那时首块（600–670 ms）已经发过来了 —— 不做缓冲就会吞掉句首一两个字。
   *
   * 读端用游标，不 `shift()`。`readerEpoch` 把旧读端作废，避免两份
   * `claim()` 同时抽走同一块。
   */
  readonly audio: Buffer[];
  /** 独占读端代号。新的 `claim()` 绑上这份时 +1，旧游标发现不符就停。 */
  readerEpoch: number;
  audioWaiters: Array<() => void>;
  /** 已收到的转写（活的，用于 `text`/`speech` 的 getter 与审计） */
  text: string;
  /** omni 自己决定转 dsh（`tool_call`）；`null` = 它会自己答 */
  delegate: DelegateReason | null;
  /** tool_call 里那句「用户要什么」（omni 自己听出来的）；没解析到就是 `null` */
  delegateRequest: string | null;
  /**
   * 这一份是被**同一轮的下一段**顶掉的（`seal()` 撞 busy），不是新一轮。
   *
   * 区别要命：并段轮里一句话会被 ASR 切成好几片，每片一次封段 —— 认领绑上的第一份
   * 会被后面那片取消。若把这种取消当成「这一轮结束了」，这一轮就 0 音频，而真正
   * 那份（可能是 6 s 的完整回答）没人认领、被当幽灵删掉。真机 `20261122-2243`
   * 第 13、16 轮就是这么丢的（`audio_s=0`，同期 `omni.shadow out_s 2.16 / 6.16`）。
   */
  superseded: boolean;
  /** 顶掉它的那一份（同一轮的下一段）；null = 还没有（在 pending 里排队） */
  next: PendingResponse | null;
  /**
   * 这一份的助手回复不要留在服务端历史里（`discard()` 时标上）。
   *
   * **必须延迟到 `response.done` 才删**：`conversation.item.delete` 要 item id，
   * 而 id 是从 `response.output` 里拿的 —— discard 当场那会儿通常还没 created，
   * 更没有 id。所以这里只记意图，实际删除在 `finish()` 里做。
   */
  deleteOnDone: boolean;
  /**
   * 这一份的助手项 id（`conversation.item.delete` 要它）。
   *
   * 助手消息和 `function_call` 项都算：`discard()` / 孤儿清理要能删掉工具调用项。
   * 来源两处：`response.output_item.added`（早，但可能没到）和
   * `response.done.response.output`（终态，一定有）。
   */
  itemIds: string[];
  /** 这一份对应的 user 项 id（幽灵清理要连它一起删） */
  userItemId: string | null;
  /** `function_call` 的 `call_id`；还没见到就是 `null` */
  delegateCallId: string | null;
  /**
   * 这条 user 项是临时 meta-prompt（`speakFromText` / `enqueueSpeech`），
   * `response.done` 时删掉。`answerFromText` 与用户封段绝不能设。
   */
  deletePromptUserOnDone: boolean;
  /** 有没有人认领过（一份只给一个消费者） */
  claimed: boolean;
}

/** 排队等 omni 空闲后按文本提示开口的一条请求（委派补句 / 回执 / 后台汇报）。 */
export interface QueuedSpeech {
  readonly promptText: string;
  readonly kind: 'ack' | 'announce';
  readonly taskId?: string;
  readonly resp: PendingResponse;
  cancelled: boolean;
}

/**
 * 服务端事件的**判别联合**（唯一一份，见 `../realtime-events.ts`）。
 *
 * 旧导入 `import type { ServerEvent } from './types.ts'` 一个字都不用改；
 * `response.done` / `error` 的窄类型另外导出，函数签名别再拿宽联合去访问字段。
 */
export type {
  DashScopeRealtimeEvent as ServerEvent,
  RealtimeErrorEvent,
  RealtimeResponseDoneEvent,
} from '../realtime-events.ts';

/** 没人认领就 completed 的一份回复。下一轮开口时连 user 项一起删。 */
export interface OrphanRecord {
  assistant: string[];
  user: string | null;
}

export interface PendingToolOutput {
  readonly callId: string;
  readonly output: string;
}
