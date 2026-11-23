/**
 * omni 影子旁路：**只量，不发声**。
 *
 * <h2>它要回答什么</h2>
 *
 * 一道只有它能答的问题：把「封段 → 首块音频」交给 omni 一体模型，
 * 比我们自己的 `①b 定稿 + ② 开轮 + ③ TTS 首块` 快多少、稳多少。
 *
 * 挂载点必须是**封段**（`asr.commit` 那一刻），不是定稿。实测（9 个样本，
 * `tmp/omni-probe/late-create.cjs`）：`response.create` 每推迟 1 ms，首块就晚 1 ms
 * —— 推迟 241 ms（判停出结论那一刻）首块从 664 掉到 887，而我们级联是 835。
 * 也就是说 **create 的决策预算只有 ~171 ms**，等判停就已经输了。
 *
 * <h2>为什么它不能直接长成「答题的那条腿」</h2>
 *
 * 上面那条决定了 `commit` 与 `response.create` 必须**连发**（pipe 形态），
 * 而 create 一发出去就收不回来：并段轮必然先答了前半句，只能 cancel。
 * 脏历史是 pipe 的固有价格，不是这里的实现缺陷。
 *
 * <h2>三条硬约束（都是踩出来的）</h2>
 *
 * 1. **封段之后要闭嘴**。能量门 `holdMs`（默认 2000 ms）比 `commitMs`（默认 20 ms）
 *    长得多，`onSpeech` 在封段后还会继续收到 ~1980 ms 的**静音**。无条件转发等于
 *    每轮都往服务端灌两秒静音：既计费（Manual 模式的静音不免费），又会让下一轮
 *    `restart()` 把这段残留 commit 成一条空白用户消息。所以只认 `voiced` 的块。
 * 2. **忙的时候不能发 `response.create`**。服务端回
 *    `invalid_request_error: Conversation already has an active response`，
 *    而且那一次 create **永久丢失**。所以 `seal()` 撞上 busy 时要先 cancel、等 done。
 * 3. **不自动重连**。影子挂了就等于这次实验结束 —— 少一个半夜自己重连、
 *    把账单和口径都搅乱的东西。`broken` 会落一条事件，人看见了再决定。
 */
import WebSocket from 'ws';

import { OMNI_SHORT_INSTRUCTIONS } from './persona.ts';
import type { RealtimeSocket, RealtimeSocketFactory } from './qwen-realtime-asr.ts';
import type { AgentAudioAnswer, DelegateReason, FastLaneAudioLane, InjectKind } from './providers.ts';

/** 上行格式：与 `UplinkPipeline` 一致（16 kHz / 单声道 / s16le） */
const UPSTREAM_RATE = 16_000;
const BYTES_PER_MILLISECOND = (UPSTREAM_RATE * 2) / 1000;
/** omni 输出固定按 24 kHz 声明（见 `session.update` 的 `audio.output.format`） */
const DOWNSTREAM_RATE = 24_000;

const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DEFAULT_MODEL = 'qwen3.8-omni-flash-realtime';
/**
 * 输出必须短，而且**必须是助手人格**。
 *
 * 实测：写成「你是一个语音助手的**旁路探针**」时，挂着 tools 的模型会连着 3/3
 * 把闲聊判成工具调用（零音频）—— 措辞里的「探针」比工具描述更能决定它怎么选。
 * 所以这里就是线上助手该说的话，不做调试人格。
 */
const DEFAULT_INSTRUCTIONS =
  // **模糊，不要精确**。原来是「只回一句话，不超过 20 个字，不要解释、不要列举、不要反问」——
  // 全是形式约束、一句都没提事实。真机 20261122-235949 里 7 轮事实题全部编造
  // （「黄仁勋」被答成「他作品多元，常探讨人性与科技」），而且 0/7 次委派：
  // 在「必须简短」的压力下，编一句 14 个字的话是成本最低的解。
  // 换成不设数字、只给态度的说法，把「拿不准就别硬猜」留成它自己的判断。
  // 后半句是 2026-11-23 05:14 加的：第 9 轮它先把「《骑猪之神》讲个普通人带猪冒险」
  // 编了 4.96 s 播出去，**然后**才调用工具转交 dsh，用户听到的是两段互不相干的回答。
  // 原来的「拿不准就交给能查的人」没挡住这种「先猜一句再转交」。
  //
  // 「回执要短、别先讲答案」**不写在这里**：§10.1 的探针结论是"写哪儿比写什么重要" ——
  // 同一句话写进 `instructions` 照样 0 ms 应声，写进工具描述才 4/4 生效。
  // 那条纪律在 `DELEGATE_TOOL.description` 里。
  // 正文**只有一份**：`persona.ts` 的 `OMNI_SHORT_INSTRUCTIONS`（快车道用同一个身份）。
  // 这里的注释是它为什么长成这样，改正文去 `persona.ts`。
  OMNI_SHORT_INSTRUCTIONS;

/** `seal()` 之后、下一次有声之前，最多留多少音频（防软起音被吞） */
const DEFAULT_RING_MILLISECONDS = 150;

/** 回注进 omni 上下文的文本上限（字）。委派轮的答案动辄几百字，整段塞进去只是烧 token */
const MAX_INJECT_CHARS = 200;
/** 回注排队上限。委派轮本来就是低频事件，多了说明哪里不对 */
const MAX_PENDING_INJECTS = 4;
/** 「没人认领的回复」最多记几份再一次性清。多了说明上游一直没出整句 */
const MAX_ORPHANS = 8;
/** 生成期最多暂存多少音频（一份回答通常 2–4 s；8 s 是防挂死的上限） */
const MAX_HELD_BYTES = BYTES_PER_MILLISECOND * 8000;
/** 按**字符**截断（中文一个字一个 token 量级，`String.length` 对代理对也不至于切坏） */
function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 「先说一句、再调工具」这一句，挂在**工具描述**里而不是 `instructions` 里。
 *
 * 委派轮 dsh 要十几秒，中间必须有个人应一声；而那个声音**只能是 omni 自己**：
 * 换一条链路合成回执就是两句不同的嗓子接在一起。所以不去预录回执，
 * 直接让它在同一个 response 里先说一句、再发 `tool_call`。
 *
 * 实测（`tmp/omni-probe/tool-leadin*.mjs`，真服务 24 格）：
 * - 现状（描述里不提应声）→ `tool_call` + **0 ms 音频**，一整轮没有声音，必须靠回执补
 * - 这句写进 `instructions` → 照样 0 ms。**写哪儿比写什么重要**
 * - 这句写进工具描述 → 4/4 都先出声（1.36 / 1.84 / 1.92 / 2.32 s），再叠上面两轮 = 6/6
 * - 收得更紧（「六个字以内 + 不要说要查什么」）→ 掉到 2/4。**收紧会把应声整个压没**
 *
 * 顺序是 `function_call_arguments` 先到、`audio.delta` 后到，但两者都在同一个
 * `response.done` 里收尾 —— 所以 `claim()` 的读端照常把音频读完，读完再看
 * `delegateReason()`，两边都不缺（见 `TurnRunner` 的 `分支=omni` 那一段）。
 */
const LEAD_IN_CLAUSE = '调用之前先用一句话应一声（八个字以内）。';

/**
 * 应声之后**不许先讲答案**。
 *
 * 2026-11-23 15:2x 真机第 8/9 轮：它先念了 2.2 s / 3.4 s 的正文（讲这本书、讲机器配置），
 * **然后**才调工具，于是同一条内容被 dsh 又说了一遍 —— 用户听两遍。
 *
 * 为什么把话说在这里而不是 `instructions`：§10.1 的探针结论是「写哪儿比写什么重要」，
 * 同一句写进 `instructions` 拿到 0 ms 应声（等于没说）。所以纪律跟着
 * {@link LEAD_IN_CLAUSE} 一起活在工具描述里。
 *
 * 只补**内容**约束（讲不讲正文），不收紧**长度**约束 —— 实测「六个字以内」那种收紧会让
 * 应声整个消失（2/4→0）。
 */
const NO_PREVIEW_CLAUSE = '应声之后不要先讲答案，答案由接手的人回来说。';

/**
 * 从 `function_call_arguments.done` 里取 `request`。
 *
 * 容错到底：参数可能是 JSON 字符串、对象，也可能是半截；取不到就返回 `null`，
 * 调用方退回 ASR 原话。**绝不让一个解析错误把整轮委派搞砸**。
 */
function parseDelegateRequest(args: unknown): string | null {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const request = (parsed as { request?: unknown }).request;
  if (typeof request !== 'string') {
    return null;
  }
  const trimmed = request.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 唯一的工具：把这一轮转给 dsh。
 *
 * 描述必须收窄到「**真的要去操作**」—— 只写「操作设备 / 读设备数据 / 长期记忆」，
 * **绝不能写「查询信息」**：实测写「查询实时信息」之后，一句
 * 「他还写过哪些作品？」被模型判成「实时信息检索」→ 直接调工具、零音频、整轮报废。
 * 常识问答是 omni 自己的活，不该转给 dsh。
 *
 * 最后那句「先说一句再调用」是**委派轮回执的来源**。见 {@link LEAD_IN_CLAUSE}。
 */
const DELEGATE_TOOL = {
  type: 'function',
  name: 'delegate_to_assistant',
  description:
    '只在需要**实际动手或读取设备数据**时调用：开关设备/拍照/发消息，'
    + '读电量/位置/日程等设备信息，或调取以前聊过的长期记忆。'
    + '闲聊、常识问答、讲个笑话这类都不要调用，自己回答。'
    + LEAD_IN_CLAUSE
    + NO_PREVIEW_CLAUSE,
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description:
          '把用户要你做的事**写清楚**（一句话，用他的口吻）：做什么、对象是谁。'
          + '数字、名字、书名、路径、设备名**原样照抄**，不要概括、不要改写、不要补全。',
      },
      reason: { type: 'string', description: '为什么转交（一句话）' },
    },
    required: ['request', 'reason'],
  },
} as const;

export type OmniShadowState = 'idle' | 'connecting' | 'ready' | 'busy' | 'broken';

export interface OmniShadowOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  readonly instructions?: string;
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
interface SealMeta {
  readonly seq: number;
  readonly silenceMs: number;
  /** 调用 `seal()` 的时刻 —— `audio_ms` 从这里算，**包含等 cancel 的那段** */
  readonly anchor: number;
  /** 这一段推了多少音频（字节） */
  readonly bytes: number;
  /** `restart()` 时顺手 flush 掉的残留（ms），0 = 没有 */
  readonly flushedMs: number;
}

interface PendingResponse {
  readonly meta: SealMeta;
  /** commit+create 真正发出去的时刻（撞 busy 时晚于 anchor） */
  readonly sentAt: number;
  ackAt: number | null;
  finalAt: number | null;
  firstTextAt: number | null;
  firstAudioAt: number | null;
  outBytes: number;
  cancelled: boolean;
  /**
   * 音频**从封段就开始攒**，不是认领才开始。
   *
   * 为什么必须这样：认领发生在定稿（~220 ms），但判停延拍时能到 700–870 ms，
   * 那时首块（600–670 ms）已经发过来了 —— 不做缓冲就会吞掉句首一两个字。
   */
  readonly audio: Buffer[];
  audioWaiters: Array<() => void>;
  /** 这一份已经不会再产出了（`response.done` 或被取消） */
  closed: boolean;
  /** 已收到的转写（活的，用于 `text`/`speech` 的 getter 与审计） */
  text: string;
  /** omni 自己决定转 dsh（`tool_call`）；`null` = 它会自己答 */
  delegate: DelegateReason | null;
  /** tool_call 里那句「用户要什么」（omni 自己听出来的）；没解析到就是 `null` */
  delegateRequest: string | null;
  /**
   * 服务端回过 `response.created` 了吗。
   *
   * **`response.cancel` 在它之前发会被拒**（实测文案
   * `Cannot cancel response before response.created`），而委派轮恰恰是在
   * `seal()` 之后几百毫秒就 discard —— 那时 created 通常还没到。
   */
  created: boolean;
  /** 还没 created 就被要求取消：等 created 到了立刻补发 */
  cancelPending: boolean;
  /**
   * 这一份是被**同一轮的下一段**顶掉的（`seal()` 撞 busy），不是新一轮。
   *
   * 区别要命：并段轮里一句话会被 ASR 切成好几片，每片一次封段 —— 认领绑上的第一份
   * 会被后面那片取消。若把这种取消当成「这一轮结束了」，这一轮就 0 音频，而真正
   * 那份（可能是 6 s 的完整回答）没人认领、被当幽灵删掉。真机 `20261122-2243`
   * 第 13、16 轮就是这么丢的（`audio_s=0`，同期 `omni.shadow out_s 2.16 / 6.16`）。
   */
  superseded: boolean;
  /** 顶掉它的那一份（同一轮的下一段）；
   * null = 还没有（在 pending 里排队） */
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
   * 来源两处：`response.output_item.added`（早，但可能没到）和
   * `response.done.response.output`（终态，一定有）。
   */
  itemIds: string[];
  /** 这一份对应的 user 项 id（幽灵清理要连它一起删） */
  userItemId: string | null;
  /** 有没有人认领过（一份只给一个消费者） */
  claimed: boolean;
}

interface ServerEvent {
  type?: string;
  delta?: string;
  item?: { id?: string; role?: string };
  error?: { code?: string; message?: string; type?: string };
  response?: {
    status?: string;
    /** `response.done` 的终态产物 —— item id 从这里拿最稳（`output_item.added` 可能没到） */
    output?: Array<{ id?: string; role?: string; status?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { audio_tokens?: number; text_tokens?: number };
      output_tokens_details?: { audio_tokens?: number; text_tokens?: number };
    };
  };
}

/** 一条 `response.done` 里所有助手项的 id（`conversation.item.delete` 要它） */
function assistantItemIds(ev: ServerEvent): string[] {
  const output = ev.response?.output ?? [];
  const ids = output
    .filter((it) => it.role === 'assistant' && typeof it.id === 'string' && it.id !== '')
    .map((it) => it.id as string);
  return [...new Set(ids)];
}

export class OmniShadow {
  private readonly opts: OmniShadowOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly ringMaxBytes: number;

  private ws: RealtimeSocket | null = null;
  private state: OmniShadowState = 'idle';
  /** socket 已 open（可以发帧）。与 `state === 'ready'` 不是一回事：后者还要等 `session.updated` */
  private opened = false;

  /**
   * 已推给服务端、尚未 commit 的字节。
   *
   * 它同时是「这一段有多长」的度量：`seal()` 时按它算 `seal_s`，然后清零。
   */
  private dirtyBytes = 0;
  /**
   * 闭嘴状态：`seal()` 之后置位，下一次**有声**块解除。
   *
   * 这是本模块最容易被写错的一处 —— 见文件头「三条硬约束」第 1 条。
   */
  private muted = true;
  /** `muted` 期间攒的最近音频（软起音不该被切掉） */
  private ring: Buffer[] = [];
  private ringBytes = 0;

  private pending: SealMeta | null = null;
  private resp: PendingResponse | null = null;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;

  /** 连续协议错误次数（忙时 create 被拒之类）。2 次就判连接语义已脏 */
  private protocolErrors = 0;
  /** 一份 seal 结果里要带的「顺带 flush 掉的残留」 */
  private lastFlushedMs = 0;
  private droppedBytes = 0;
  /** 这一轮里已经封过几段（并段 > 1）。`restart()` 归零 */
  private turnSeqs: number[] = [];
  /** 等 `ready` 再发的回注文本（见 `injectAnswer()`） */
  private injects: string[] = [];
  /**
   * 一共回注过几笔。
   *
   * 为什么要计数：回注成功一直是**静默**的，档案里查不到，只能从 `in_text_tok`
   * 的跳变反推（真机 `20261123-053719` 是 1195 → 1296）。有了这个数，
   * 回放就能直接对账「第 N 段之前注过几笔」。落进 `omni.shadow` 那条记录。
   */
  private injectsSent = 0;
  /**
   * 生成期攒下的音频（见 `append()`）。
   *
   * 与 ASR 那边同一个协议怪癖：commit 在飞时 append 上去的会被服务端丢掉。
   * 并段轮里用户接着说的 B 段开头正好落在这个窗口里。
   */
  private held: Buffer[] = [];
  private heldBytes = 0;
  /**
   * `claim()` 认领了「还没建出来的那一份」时置位。
   *
   * 语义是**预留**：`sendSeal()` 一建好就把新那份标成 `claimed`，别的消费者再也拿不走。
   * 一轮只会 claim 一次，所以单槽够；`discard()` / `restart()` 会把它清掉。
   */
  private claimReserved = false;
  /**
   * 轮次纪元：restart() 每次 +1。claim() 记下当时的纪元，并段轮被顶掉时
   * 只肯跟到**同一个纪元**里新封出来的那份 —— 否则就会把下一轮的答案当成自己的。
   */
  private turnEpoch = 0;
  /** 刚被本轮的下一段顶掉、但下一份还没建出来的那一份（sendSeal 里接链） */
  private supersededPrev: PendingResponse | null = null;
  private claimEpoch = -1;
  /**
   * 认领落在哪一份上。
   *
   * **不能事后去 `this.resp` 里找**：`response.done` 一到 `finish()` 就把 `this.resp`
   * 置 null，如果消费者这时还没开始读（异步 generator 的第一个 `next()` 是微任务），
   * 那一份就再也够不着了 —— 表现是这一轮静默等 5 s、零音频。所以引用要留在这里。
   */
  private claimedResp: PendingResponse | null = null;
  /** 在等「下一份建出来」的读端（`claim()` 的流会挂在这里） */
  private liveWaiters: Array<() => void> = [];
  /**
   * **没人认领**就 completed 的那些回复（幽灵）。
   *
   * 场景：omni 已经答完了，但 ASR 从没给出整句（只有 partial，或干脆是噪声）——
   * 那一轮根本不会开，`claim()` / `discard()` 都没人调。钱在 pipe 形态下省不掉，
   * 但**历史能清**：下一轮 `restart()` 时把这些轮次的 item 删掉，别让
   * 「用户没听过的一句话」永久躺在 omni 的记忆里。
   *
   * 存 id 而不是 `PendingResponse`：那一份对象已经 `closed`，留着只是占内存。
   */
  private orphans: Array<{ assistant: string[]; user: string | null }> = [];
  /** 还没跑过任何一份 seal —— 第一条标 `warmup`，分析时排除 */
  private sharedSeals = 0;

  constructor(options: OmniShadowOptions) {
    this.opts = options;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.ringMaxBytes = Math.round(BYTES_PER_MILLISECOND * (options.ringMs ?? DEFAULT_RING_MILLISECONDS));
  }

  get currentState(): OmniShadowState {
    return this.state;
  }

  /** 本端端口：长尾时可以用 `ss -ti` 直接区分「厂商慢」和「公网丢包」 */
  get localPort(): number {
    const socket = (this.ws as unknown as { _socket?: { localPort?: number } } | null)?._socket;
    return socket?.localPort ?? 0;
  }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    if (this.state !== 'idle') {
      return;
    }
    this.state = 'connecting';
    const factory: RealtimeSocketFactory = this.opts.socketFactory
      ?? ((url, apiKey) => new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        maxPayload: 16 << 20,
      }) as unknown as RealtimeSocket);

    const url = `${this.opts.url ?? DEFAULT_URL}?model=${encodeURIComponent(this.opts.model ?? DEFAULT_MODEL)}`;
    let ws: RealtimeSocket;
    try {
      ws = factory(url, this.opts.apiKey);
    } catch (error) {
      this.break(`建连失败：${(error as Error).message}`);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) {
        return;
      }
      this.opened = true;
      this.sendSessionUpdate();
      this.armConnectTimeout();
    });
    ws.on('message', (...args: never[]) => {
      if (this.ws !== ws) {
        return;
      }
      this.onMessage(args[0] as unknown as Buffer);
    });
    ws.on('error', (...args: never[]) => {
      if (this.ws !== ws) {
        return;
      }
      // 不发事件：真正的后果是随后的 close，那里统一处理
      this.log(`[omni] socket error: ${String(args[0])}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) {
        return;
      }
      this.break('连接关闭');
    });
  }

  stop(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    this.state = 'broken';
    this.claimReserved = false;
    this.claimedResp = null;
    // 生成期攒的音频属于这条连接，别漏进下一场
    this.held = [];
    this.heldBytes = 0;
    this.wakeLive();
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已经断了
      }
    }
  }

  // ---------------------------------------------------------------- 音频与封段

  /**
   * 新一轮开口（能量门重新打开）。
   *
   * 做四件事，顺序有讲究：
   * 1. 上一轮还在生成 → **立刻 cancel**。用户说话有 2–3 s，够它干净收尾；
   *    等到 `seal()` 才 cancel 的话，那 79 ms 会压在关键路径上。
   * 2. 丢掉待发的那份 seal —— 句子还在继续，组装器会重新 `seal()`。
   * 3. 有残留就 `commit` 掉（**不发 create**，所以不会产生回复）。空缓冲 commit
   *    会回 `maybe no invalid audio stream`，所以必须先看 `dirtyBytes`。
   * 4. 解除闭嘴，把预卷推上去。
   */
  restart(preroll: readonly Buffer[]): void {
    if (this.state === 'broken' || this.state === 'idle') {
      return;
    }
    if (this.resp !== null) {
      this.cancelCurrent();
    }
    this.pending = null;
    this.ring = [];
    this.ringBytes = 0;
    this.turnSeqs = [];
    // 新一轮开口：上一轮预留的那份不再属于任何人
    this.turnEpoch += 1;
    this.supersededPrev = null;
    this.claimReserved = false;
    this.claimedResp = null;
    // 上一轮那些「答了但没人听过」的回复，趁现在删掉（见 `orphans`）
    this.flushOrphans();
    this.wakeLive();

    if (this.dirtyBytes > 0) {
      this.lastFlushedMs = Math.round(this.dirtyBytes / BYTES_PER_MILLISECOND);
      this.dirtyBytes = 0;
      this.send({ type: 'input_audio_buffer.commit' });
    }

    this.muted = false;
    for (const part of preroll) {
      this.append(part);
    }
  }

  /**
   * 一块上行音频。
   *
   * `voiced` 必须由能量门给（`EnergyGateDecision.voiced`），不能自己按能量重算 ——
   * 两处门限一漂移，这里就会开始丢字或灌静音，而且从数据上分不出来。
   */
  feed(pcm: Buffer, voiced: boolean): void {
    if (this.state === 'broken' || this.state === 'idle') {
      return;
    }
    if (this.muted) {
      if (!voiced) {
        this.pushRing(pcm);
        return;
      }
      // 又开口了：软起音那几帧在 ring 里，补回去
      this.muted = false;
      const buffered = this.ring.length === 0 ? null : Buffer.concat(this.ring);
      this.ring = [];
      this.ringBytes = 0;
      if (buffered !== null && buffered.length > 0) {
        this.append(buffered);
      }
      this.append(pcm);
      return;
    }
    this.append(pcm);
  }

  /**
   * 封段：与 ASR 的 `commit` 同一行、同一纳秒发出。
   *
   * @param seq 与 `asr.commit` 共用的序号 —— 两份事件的 join key
   * @param silenceMs 距最后一个有声帧多久（与 `asr.commit` 的同一个数）
   */
  seal(seq: number, silenceMs: number): void {
    if (this.state === 'broken' || this.state === 'idle') {
      this.emitSkipped(seq, this.state === 'broken' ? 'broken' : 'idle');
      return;
    }
    // 无论这份能不能发出去，封段之后都要先闭嘴
    this.muted = true;
    this.ring = [];
    this.ringBytes = 0;

    const bytes = this.dirtyBytes;
    if (bytes <= 0) {
      this.emitSkipped(seq, 'empty');
      return;
    }
    this.dirtyBytes = 0;
    this.turnSeqs.push(seq);
    const meta: SealMeta = {
      seq,
      silenceMs,
      anchor: this.now(),
      bytes,
      flushedMs: this.lastFlushedMs,
    };
    this.lastFlushedMs = 0;

    if (this.state === 'connecting') {
      this.emitSkipped(seq, 'connecting');
      return;
    }
    if (this.resp !== null) {
      // 忙时 create 会被服务端拒掉且永久丢失（实测），所以先 cancel 再排队。
      // 标 `superseded`：这是**同一轮的下一段**，不是新一轮 —— 认领要跟过去（见 `sendSeal`）。
      this.resp.superseded = true;
      this.supersededPrev = this.resp;
      // 一个字节音频都没出过的那份没人听过，删掉；出过的留着（用户可能听到了）
      if (this.resp.claimed && this.resp.firstAudioAt === null) {
        this.resp.deleteOnDone = true;
      }
      this.cancelCurrent();
      this.pending = meta;
      return;
    }
    this.sendSeal(meta);
  }

  // ---------------------------------------------------------------- 车道接口

  /**
   * 这一轮能不能由 omni 自己答。纯读、不改账。
   *
   * **硬约束：omni 开着的时候，快车道的每一轮都必须由它答。** 一轮退回级联，
   * 用户就会在一段对话里听到两副嗓子。所以这里的判据要宽，宁可等也不能放：
   * 手里那份被顶掉了（`cancelled`）但还有一份在 `pending` 里排队时，**也算能答** ——
   * 新那一份马上就建出来（实测空窗 92 ms）。
   *
   * 踩过的坑：只看 `this.resp` 的版本，会在「seal#2 排队 → done → 新建」这个
   * 空窗里判 false，然后整轮退回级联，而 omni 那份 1 s 的回答生成完没人要。
   *
   * **并段轮不挡。** 曾经按 `turnSeqs.length > 1` 挡过（`clip` 档），实测两场之后
   * 砍掉：并段轮的回答质量与单段轮 5/5 无差别（`tmp/omni-probe/barge-in.cjs`）。
   */
  willServe(): boolean {
    if ((this.opts.serve ?? 'off') === 'off') {
      return false;
    }
    if (this.liveResp() !== null) {
      return true;
    }
    // 手里没有可用的一份：只有「已经有一份在排队」才算能答
    return this.pending !== null;
  }

  /**
   * 认领本轮音频。
   *
   * 注意：**首块通常还没到**（认领在定稿 ~220 ms，首块 600–670 ms），而判停延拍时
   * 认领可以晚到 700–870 ms、那时首块已经发过来了 —— 两条路都靠 `resp.audio`
   * 从封段就开始攒（见 `PendingResponse.audio`）。
   *
   * 手里那份被顶掉时，认领的是**排队中的下一份**：`claimReserved` 让 `sendSeal()`
   * 一建好就把它标成 `claimed`，流从这里开始等（可能几十毫秒，也可能永远等不到 ——
   * 那说明车道挂了，见 `waitLive`）。
   */
  claim(): AgentAudioAnswer | null {
    if (!this.willServe()) {
      return null;
    }
    // 上一轮的认领随这一轮作废（一轮一个消费者）
    this.claimedResp = null;
    // 每次认领一个新纪元：并段轮被顶掉时，只允许跟到**这一次认领之后**新封出来的那份。
    //
    // 不能只靠 `restart()` 推进：连着说话时能量门不关，`restart()` 根本不跑
    // （真机 `20261122-2259` 的 `turn_seqs` 一路涨到 15 —— 那就是没 restart 的证据），
    // 于是「同一个 turnEpoch」会把**下一轮**的段也当成自己的。
    const me = (this.turnEpoch += 1);
    this.claimEpoch = me;
    const live = this.liveResp();
    if (live !== null) {
      live.claimed = true;
      this.claimedResp = live;
    } else {
      // 只能预留：真正那一份还没建出来。一轮只会 claim 一次，所以单槽够用。
      this.claimReserved = true;
    }
    const self = this;
    let bound = live;
    /** 这一轮真正对应的那一份：手里这份，或者预留到的那份 */
    const current = (): PendingResponse | null => {
      if (bound === null) {
        bound = self.claimedResp;
      }
      return bound;
    };
    return {
      sampleRate: DOWNSTREAM_RATE,
      transcript: () => current()?.text ?? '',
      delegateReason: () => current()?.delegate ?? null,
      delegateText: () => current()?.delegateRequest ?? null,
      chunks: (async function* iterate() {
        let resp = current();
        // 等排队那份建出来。三条路都放弃，让这一轮以「零音频」结束
        // （宿主按 `audioBytes === 0` 记账，不会假装说过话）：
        // 1. 车道挂了 / 被停掉；
        // 2. 预留已经作废 —— `discard()` / `restart()` 清了 `claimReserved`，
        //    但 `state` 仍是 `ready` / `busy`。原来只看 state 的写法会在这里
        //    一圈圈空等（每圈 5 s）；
        // 3. 等了 5 s 那份还没建出来（`waitLive` 的超时）。
        if (resp === null) {
          if (self.state !== 'broken' && self.state !== 'idle' && self.claimReserved) {
            await self.waitLive();
            resp = current();
          }
          if (resp === null) {
            return;
          }
        }
        // 上面那一段保证非空；单独一个非空变量是为了在「换到下一段」时不丢类型
        let active: PendingResponse = resp;
        let yielded = 0;
        for (;;) {
          if (active.audio.length > 0) {
            const next = active.audio.shift();
            if (next !== undefined) {
              yielded += next.length;
              yield next;
            }
            continue;
          }
          if (active.closed || active.cancelled) {
            // 被**同一轮的下一段**顶掉、而且这段还一个字都没播出去 → 认领跟过去。
            // 播过就到此为止：两段回答接在一起比「少说一句」更难听。
            // 只认**同一个 turn epoch** 里新封出来的那一份：`restart()` 之后 `this.resp`
            // 属于下一轮，跟过去就把人家的答案抢了（`interrupt` 也就掐错人）。
            if (yielded === 0 && active.superseded
              && self.claimEpoch === me && self.turnEpoch === me) {
              let next = active.next;
              if (next === null && self.pending !== null) {
                // 排队那份还没建出来（finish() 先收尾上一份、再补发）：等它
                await self.waitLive();
                next = active.next;
              }
              if (next !== null && next !== active) {
                next.claimed = true;
                self.claimedResp = next;
                self.log('[omni] 认领跟到下一段（并段轮）');
                active = next;
                continue;
              }
            }
            return;
          }
          await new Promise<void>((resolve) => { active.audioWaiters.push(resolve); });
        }
      })(),
    };
  }

  /**
   * 这一轮不采纳（走 dsh / 太长 / 判据否决）：**立刻 `response.cancel`**，
   * 并把这条助手回复标记成「结束后删掉」。
   *
   * 不取消的话它会在后台把整段废音频生成完 —— 既烧输出 token，又让下一轮开口时
   * 它还挂着 `busy`（那时新的 `response.create` 会被服务端拒掉且永久丢失）。
   *
   * 删除走 `deleteOnDone`（见 `finish()`）：这里拿不到 item id ——
   * `conversation.item.delete` 要 id，而 id 在 `response.done.response.output` 里，
   * 委派轮 discard 的时机通常连 `created` 都还没到。
   */
  discard(): void {
    const resp = this.resp;
    if (resp !== null) {
      resp.audio.length = 0;
      this.wakeAudio(resp);
      resp.deleteOnDone = true;
      this.cancelCurrent();
    }
    this.pending = null;
    // 预留作废，并且把可能挂在 `waitLive()` 上的读端叫起来（它会看到 broken/idle 退出，
    // 或者等不到东西直接结束这一轮）
    this.claimReserved = false;
    this.claimedResp = null;
    this.held = [];
    this.heldBytes = 0;
    this.wakeLive();
  }

  /**
   * 播到一半被用户打断：取消生成，但**保留**那条助手回复。
   *
   * 与 `discard()` 的差别只有一点，但是要害：这一轮用户**已经听到了一部分**。
   * 删掉它会让 omni 以为自己没说过，而快车道那边的 `pending` 记的正是这半句
   * （`noteServedTurn` 用的是活 getter 的当前值）—— 两条上下文轨就分叉了。
   *
   * **只掐 `claimedResp`（这一轮真正吃掉的那一份），不是 `this.resp`。**
   * 插话的时刻常常晚于下一段的封段：那时 `this.resp` 已经是**新那句话**的回复了，
   * 盲掐 `this.resp` 会把还没开口的新答案一起杀掉 —— 下一轮只能退回级联，
   * 用户听到换嗓子。真机实测每次插话都中招。
   */
  interrupt(): void {
    const resp = this.claimedResp;
    this.claimedResp = null;
    if (resp === null) {
      // 这一轮本来就没用 omni（走的是文本快车道/ dsh）——没有该掐的东西
      return;
    }
    if (!resp.cancelled && !resp.closed) {
      resp.audio.length = 0;
      this.wakeAudio(resp);
      this.cancelCurrent(resp);
    }
  }

  /**
   * 把**别的车道答出来的**内容回注进 omni 的上下文（委派轮用）。
   *
   * 为什么必须是 `role:'user'`：实测服务端只允许伪造用户的输入，`role:'assistant'`
   * 三种 content type 全部回 `created` + item id 但**模型当没看见**
   * （`in_tokens` 停在基线、追问答「我不知道」）。所以这里包一层用户侧的旁注。
   *
   * 带上原问题是有意的：委派轮动辄十几秒，期间用户可能又问了别的，
   * 只给答案会让后面几轮的指代全乱。
   *
   * 忙的时候排队，回到 `ready` 再发 —— `conversation.item.create` 在 `busy` 态
   * 虽然不报错，但插在一条正在生成的回复中间会让它自己那轮的指代也乱。
   */
  injectAnswer(userText: string, said: string, kind: InjectKind = 'spoken'): void {
    const answer = clipText(said.trim(), MAX_INJECT_CHARS);
    if (answer === '') {
      return;
    }
    const question = clipText(userText.trim(), MAX_INJECT_CHARS);
    // `spoken` 用第一人称：这话是**同一副嗓子**（`omni-tts` 朗读连接）念给用户的，
    // 所以对 omni 来说「我说过」是真的，后面引述不用克制。`unspoken` 反过来，
    // 明说用户还不知道 —— 否则它会讲「我刚才告诉过你」。
    const text = kind === 'unspoken'
      ? `（系统旁注：用户刚才问的「${question}」已经由另一位助手回答，`
        + `但那段回答没能说给用户听，用户并不知道内容。回答是：${answer}）`
      : `（系统旁注：用户刚才问的「${question}」，你已经用语音把下面这段念给他了：`
        + `${answer}）`;
    this.injectsSent += 1;
    this.log(
      `[omni] 回注 ${[...answer].length} 字（${kind === 'unspoken' ? '没念出去' : '已播完'}）`
      + `：${answer.slice(0, 20)}${[...answer].length > 20 ? '…' : ''}`,
    );
    if (this.state === 'broken' || this.state === 'idle') {
      // **不能扔**：`idle` 只是「还没封过段」，下一次 `finish()` 就会把队列刷出去。
      // 原来是直接丢，于是「连接刚建好、第一轮就被委派」这种情况下永远补不进记忆。
      if (this.state === 'broken') {
        this.log('[omni] 回注丢弃：车道已断');
        return;
      }
    }
    if (this.injects.length >= MAX_PENDING_INJECTS) {
      this.injects.shift();
      this.log('[omni] 回注队列满，丢掉最早的一条');
    }
    this.injects.push(text);
    this.flushInjects();
  }

  /** 只有 `ready` 才发：忙的时候让它在队列里等 */
  private flushInjects(): void {
    if (this.state !== 'ready' || this.injects.length === 0) {
      return;
    }
    for (const text of this.injects.splice(0)) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
    }
  }

  /**
   * 删掉「答了但没人听过」的那些回复。
   *
   * 为什么必须清：那份回复 `completed` 了，但 ASR 没给整句 → 没开轮 →
   * `claim()` / `discard()` 谁都没调过。于是 omni 的服务端历史里永久躺着
   * `[user: 一段音频] → [assistant: 一句用户根本没听见的回答]`。
   * 下一轮用户换个话题，模型还会拿它当自己说过的话。
   *
   * 连 **user 项一起删**：只删 assistant 会留下「用户说了话、助手没答」的半条记录，
   * 同样是假记忆。
   */
  private flushOrphans(): void {
    const list = this.orphans.splice(0);
    if (list.length === 0) {
      return;
    }
    for (const one of list) {
      for (const id of one.assistant) {
        this.send({ type: 'conversation.item.delete', item_id: id });
      }
      if (one.user !== null) {
        this.send({ type: 'conversation.item.delete', item_id: one.user });
      }
    }
    this.log(`[omni] 清掉 ${list.length} 份没人认领的回复（用户没听过）`);
  }

  /** 排障用：`willServe()` 为 false 时到底卡在哪一条（只进档案，不参与决策） */
  explain(): Record<string, unknown> {
    const resp = this.resp;
    return {
      serve: this.opts.serve ?? 'off',
      state: this.state,
      has_resp: resp !== null,
      cancelled: resp?.cancelled ?? null,
      claimed: resp?.claimed ?? null,
      // 有一份在排队 —— `willServe()` 在「手里那份被顶掉」时靠它才敢说能答
      pending: this.pending !== null,
      // 本次 gate 窗口内封了几段（`restart()` 清零）。**不等于**这一轮并了几段：
      // 插话时门不关、`restart()` 不跑，计数会跨轮累积。
      turn_seqs: this.turnSeqs.length,
    };
  }

  private wakeAudio(resp: PendingResponse | null = this.resp): void {
    if (resp === null) {
      return;
    }
    const waiters = resp.audioWaiters;
    resp.audioWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /** 手里那份可用吗（没被取消、没被认领走） */
  private liveResp(): PendingResponse | null {
    const resp = this.resp;
    if (resp === null || resp.cancelled || resp.claimed) {
      return null;
    }
    return resp;
  }

  private wakeLive(): void {
    const waiters = this.liveWaiters.splice(0);
    for (const wake of waiters) {
      wake();
    }
  }

  /** 等「下一份建出来」；`wakeLive()` 或超时（防挂死）后返回 */
  private waitLive(ms = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        const at = this.liveWaiters.indexOf(done);
        if (at >= 0) {
          this.liveWaiters.splice(at, 1);
        }
        resolve();
      };
      timer = setTimeout(done, ms);
      this.liveWaiters.push(done);
    });
  }

  // ---------------------------------------------------------------- 内部

  private sendSeal(meta: SealMeta): void {
    const sentAt = this.now();
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
    this.resp = {
      meta,
      sentAt,
      ackAt: null,
      finalAt: null,
      firstTextAt: null,
      firstAudioAt: null,
      outBytes: 0,
      cancelled: false,
      audio: [],
      audioWaiters: [],
      closed: false,
      text: '',
      delegate: null,
      delegateRequest: null,
      created: false,
      cancelPending: false,
      superseded: false,
      next: null,
      deleteOnDone: false,
      itemIds: [],
      userItemId: null,
      claimed: false,
    };
    // 接上「谁顶掉了谁」：读端要靠它跟到真正那份答案（见 claim() 的 chunks）
    if (this.supersededPrev !== null) {
      this.supersededPrev.next = this.resp;
      this.supersededPrev = null;
    }
    // `claim()` 可能已经把这一份预留了（它认领时手里那份已经被顶掉）：
    // 一建出来就标成已认领，别的消费者再也拿不走。
    if (this.claimReserved) {
      this.resp.claimed = true;
      this.claimReserved = false;
      this.claimedResp = this.resp;
    }
    this.state = 'busy';
    this.armResponseTimeout();
    // 读端可能正挂在 `waitLive()` 上等这一份
    this.wakeLive();
  }

  /**
   * 取消一份 response。
   *
   * @param resp 默认 `this.resp`。**`interrupt()` 必须传 `claimedResp`** ——
   *   插话时 `this.resp` 可能已经是下一句的回复了（见 `interrupt()`）。
   */
  private cancelCurrent(resp: PendingResponse | null = this.resp): void {
    if (resp === null || resp.cancelled) {
      return;
    }
    resp.cancelled = true;
    // 没人认领过 = 没人听过 = 这条回复不该留在历史里。
    // 它覆盖的是「同一句里第二次封段」把上一份顶掉的情形（`seal()` 撞 busy、
    // `restart()` 换段）—— 那份答的是半句话，留着只会污染下一轮。
    // 认领过的**不动**：用户已经听到了一部分，见 `interrupt()`。
    if (!resp.claimed) {
      resp.deleteOnDone = true;
    }
    if (!resp.created) {
      // `response.cancel` 在 `response.created` 之前发会被服务端拒
      // （`Cannot cancel response before response.created`），所以先记账，
      // 等 created 到了立刻补发 —— 见 `onMessage` 的 `response.created` 分支
      resp.cancelPending = true;
      return;
    }
    this.send({ type: 'response.cancel' });
  }

  private append(pcm: Buffer): void {
    if (!this.opened) {
      this.droppedBytes += pcm.length;
      return;
    }
    // 这一段永远算「下一段」的长度（`seal()` 用 dirtyBytes 算 seal_s）
    this.dirtyBytes += pcm.length;
    if (this.resp !== null) {
      // commit 在飞 / 正在生成：这期间 append 上来的音频**服务端会直接丢掉** ——
      // 实测同一个底座（`tmp/omni-probe/omni-drop-probe.cjs`）：同样的 500 ms 语音，
      // 生成完之后推能听写成「司机拍的。」，生成期推则只剩噪声。
      // 并段轮的真实形状正是后者（用户接着说的 B 段开头几百毫秒），所以必须暂存、
      // 等 `finish()` 里推上去、再发下一条 commit（见 `flushHeld`）。
      this.held.push(pcm);
      this.heldBytes += pcm.length;
      while (this.heldBytes > MAX_HELD_BYTES && this.held.length > 0) {
        this.heldBytes -= this.held.shift()?.length ?? 0;
        this.log('[omni] 暂存溢出，丢掉最早一帧');
      }
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  /**
   * 把生成期攒下的音频推上去。
   *
   * 必须在 `sendSeal()`（下一段的 commit）**之前**调用 —— 那之后它就不属于这段了。
   */
  private flushHeld(): void {
    if (this.held.length === 0) {
      return;
    }
    const held = this.held.splice(0);
    this.heldBytes = 0;
    for (const pcm of held) {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    }
    this.log(`[omni] 补推生成期暂存的 ${held.length} 帧`);
  }

  private pushRing(pcm: Buffer): void {
    this.ring.push(Buffer.from(pcm));
    this.ringBytes += pcm.length;
    while (this.ringBytes > this.ringMaxBytes && this.ring.length > 1) {
      const dropped = this.ring.shift();
      this.ringBytes -= dropped?.length ?? 0;
    }
  }

  private sendSessionUpdate(): void {
    const serve = (this.opts.serve ?? 'off') !== 'off';
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        // **不要**在这加任何「要不要调工具」的暗示。实测：多加一句
        // 「如果决定调用工具，直接调用，不要先说任何过渡语」之后，闲聊会 3/3
        // 被判成工具调用（零音频）；去掉它、只留 `DELEGATE_TOOL.description`，
        // 同一批闲聊 150 轮 `0/150` 误触发。决定权在工具描述，不在提示词。
        instructions: this.opts.instructions ?? DEFAULT_INSTRUCTIONS,
        // 手动端点：我们已经在封段那一刻决定「这句说完了」，服务端 VAD 既多余又更慢
        turn_detection: null,
        audio: {
          input: {
            format: {
              type: 'pcm',
              sample_rate: UPSTREAM_RATE,
              sample_format: 's16le',
              channels: 1,
              packing: 'interleaved',
              channel_layout: 'mono',
            },
          },
          output: { format: { type: 'pcm', sample_rate: DOWNSTREAM_RATE } },
        },
        // 没有它就没有 `input_audio_transcription.completed`，`final_ms` 整列缺失
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        // 只有真的要它答时才挂工具：挂在 `session.update` 里会抬高每轮 `in_text_tok`
        // 基线（实测 150 轮首块没变慢，但那是有 0 次调用的前提下）
        ...(serve ? { tools: [DELEGATE_TOOL], tool_choice: 'auto' } : {}),
      },
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws === null) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.log(`[omni] 发送失败：${(error as Error).message}`);
    }
  }

  private onMessage(raw: Buffer): void {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(raw.toString()) as ServerEvent;
    } catch {
      return;
    }
    switch (ev.type) {
      case 'session.updated':
        this.clearConnectTimer();
        if (this.state === 'connecting') {
          this.state = 'ready';
          this.log('[omni] 影子就绪');
        }
        return;
      case 'conversation.item.created':
        // 这一段对应的 user 项 —— 幽灵清理时连它一起删，否则会留下「用户在说话、
        // 助手没答」的半条记录
        if (this.resp !== null && ev.item?.role === 'user' && typeof ev.item.id === 'string') {
          this.resp.userItemId ??= ev.item.id;
        }
        return;
      case 'response.output_item.added':
        if (this.resp !== null && ev.item?.role === 'assistant' && typeof ev.item.id === 'string') {
          if (!this.resp.itemIds.includes(ev.item.id)) {
            this.resp.itemIds.push(ev.item.id);
          }
        }
        return;
      case 'response.created':
        if (this.resp !== null) {
          this.resp.created = true;
          if (this.resp.cancelPending) {
            this.resp.cancelPending = false;
            this.send({ type: 'response.cancel' });
          }
        }
        return;
      case 'input_audio_buffer.committed':
        if (this.resp !== null && this.resp.ackAt === null) {
          this.resp.ackAt = this.now();
        }
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (this.resp !== null && this.resp.finalAt === null) {
          this.resp.finalAt = this.now();
        }
        return;
      case 'response.text.delta':
      case 'response.audio_transcript.delta':
        if (this.resp !== null) {
          if (this.resp.firstTextAt === null) {
            this.resp.firstTextAt = this.now();
          }
          this.resp.text += ev.delta ?? '';
        }
        return;
      case 'response.function_call_arguments.delta':
        // omni 自己决定转 dsh。音频可能还没出（纯调用），也可能已经说了句垫音。
        if (this.resp !== null) {
          this.resp.delegate ??= 'delegate';
        }
        return;
      case 'response.function_call_arguments.done':
        // 完整参数在这一条里（delta 是分段，拼起来容易漏引号）。解析失败不算错：
        // 委派照旧进行，只是那一轮退回 ASR 原话。
        if (this.resp !== null) {
          this.resp.delegate ??= 'delegate';
          const args = (ev as { arguments?: unknown }).arguments;
          this.resp.delegateRequest = parseDelegateRequest(args) ?? this.resp.delegateRequest;
        }
        return;
      case 'response.audio.delta':
        if (this.resp !== null) {
          if (this.resp.firstAudioAt === null) {
            this.resp.firstAudioAt = this.now();
          }
          const delta = ev.delta ?? '';
          // 字节数必须记（`out_s` / `out_audio_tok` 的交叉校验）；
          // 音频本体**从封段就攒着**，不等认领 —— 判停延拍时认领会晚到 700–870 ms
          this.resp.outBytes += base64Bytes(delta);
          this.resp.audio.push(Buffer.from(delta, 'base64'));
          this.wakeAudio();
        }
        return;
      case 'response.done':
        this.finish(ev);
        return;
      case 'error':
        this.onError(ev);
        return;
      default:
        return;
    }
  }

  private onError(ev: ServerEvent): void {
    const message = ev.error?.message ?? '';
    this.log(`[omni] 服务端错误：${message.slice(0, 160)}`);
    // 「在 created 之前 cancel」是我们自己时序问题，已经按 `cancelPending` 修掉；
    // 万一旧路径漏过来一次，它不该把整条车道判死（不计入协议错误）
    if (message.includes('before response.created')) {
      return;
    }
    this.protocolErrors += 1;
    // 「忙时 create」这类错误说明我们的状态机和服务端已经不同步了。
    // 不猜怎么修，直接停 —— 影子还留着的价值不如它污染数据的代价。
    if (this.protocolErrors >= 2) {
      this.break(`连续协议错误：${message.slice(0, 80)}`);
    }
  }

  private finish(ev: ServerEvent): void {
    const resp = this.resp;
    this.resp = null;
    this.clearResponseTimer();
    if (resp !== null) {
      // 先标 closed 再唤醒：读端要知道「再等也没有了」
      resp.closed = true;
      this.wakeAudio(resp);
    }
    if (this.state !== 'broken') {
      this.state = 'ready';
    }

    // 被 `discard()` 标掉的这份：把助手那条回复从服务端历史里删掉。
    // 删了之后上下文只剩「用户说了什么」，跟级联那边看到的一样；
    // 不删的话下一轮的输入里会一直夹着一段它自己被打断的半句话。
    // **只删 assistant 项**：用户那条是这一轮的内容，后面还要指代它。
    //
    // 没被 `discard()` 标、也**没人认领**的那份是「幽灵」：omni 答完了，但那一轮
    // 根本没开起来（ASR 没给整句）。它的话用户一个字都没听过，留在历史里只会
    // 让下一轮的指代错乱 —— 记进 `orphans`，下一轮开口时删掉（见 `restart()`）。
    if (resp !== null) {
      const ids = new Set([...resp.itemIds, ...assistantItemIds(ev)]);
      resp.itemIds = [...ids];
      if (resp.deleteOnDone) {
        for (const id of ids) {
          this.send({ type: 'conversation.item.delete', item_id: id });
        }
      } else if (!resp.claimed) {
        this.orphans.push({ assistant: [...ids], user: resp.userItemId });
        if (this.orphans.length > MAX_ORPHANS) {
          this.orphans.shift();
        }
      }
    }

    // 排队中的回注：现在回到 `ready` 了，可以发
    this.flushInjects();

    if (resp !== null) {
      const { meta } = resp;
      const usage = ev.response?.usage;
      const inDetails = usage?.input_tokens_details ?? {};
      const outDetails = usage?.output_tokens_details ?? {};
      const audioMs = resp.firstAudioAt === null ? null : resp.firstAudioAt - meta.anchor;
      this.sharedSeals += 1;
      this.opts.emit({
        seq: meta.seq,
        warmup: this.sharedSeals === 1,
        seal_s: Number((meta.bytes / (BYTES_PER_MILLISECOND * 1000)).toFixed(2)),
        silence_ms: Math.round(meta.silenceMs),
        ack_ms: resp.ackAt === null ? null : Math.round(resp.ackAt - meta.anchor),
        final_ms: resp.finalAt === null ? null : Math.round(resp.finalAt - meta.anchor),
        text_ms: resp.firstTextAt === null ? null : Math.round(resp.firstTextAt - meta.anchor),
        // ★ 主指标：封段 → 首块音频。与我们 `①b+②+③` 同起点，直接可比
        audio_ms: audioMs === null ? null : Math.round(audioMs),
        injects_sent: this.injectsSent,
        cancel_wait_ms: Math.round(resp.sentAt - meta.anchor),
        out_s: Number((resp.outBytes / (DOWNSTREAM_RATE * 2)).toFixed(2)),
        status: ev.response?.status ?? null,
        cancelled: resp.cancelled,
        flushed_ms: meta.flushedMs,
        in_audio_tok: inDetails.audio_tokens ?? null,
        in_text_tok: inDetails.text_tokens ?? null,
        out_audio_tok: outDetails.audio_tokens ?? null,
        local_port: this.localPort,
        ...(this.droppedBytes > 0 ? { dropped_ms: Math.round(this.droppedBytes / BYTES_PER_MILLISECOND) } : {}),
      });
      this.droppedBytes = 0;
    }

    // 排队中的那一份 seal（撞 busy 时的）。
    // 注意用 `pending.bytes`：那段音频的长度在 `seal()` 时就已经记下来了，
    // 之后新到的音频属于**下一段**，不能算进这一份（所以不能重读 `dirtyBytes`）。
    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
      if (this.state === 'broken') {
        this.emitSkipped(pending.seq, 'broken');
      } else {
        // 生成期攒下的音频要先推上去，否则下一段的 commit 是空缓冲 ——
        // 那段正是用户接着说的开头（见 `append()`）
        this.flushHeld();
        this.sendSeal(pending);
      }
    } else {
      // 没有排队的段：攒下的音频留在服务端缓冲里等下一次 commit
      this.flushHeld();
    }
  }

  private emitSkipped(seq: number, why: string): void {
    this.opts.emit({ seq, skipped: why, local_port: this.localPort });
  }

  private break(reason: string): void {
    if (this.state === 'broken') {
      return;
    }
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    this.state = 'broken';
    // 读端不能挂在 await 上等一个永远不会来的块
    const resp = this.resp;
    this.resp = null;
    if (resp !== null) {
      resp.closed = true;
      this.wakeAudio(resp);
    }
    this.claimReserved = false;
    this.claimedResp = null;
    this.held = [];
    this.heldBytes = 0;
    this.wakeLive();
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已经断了
      }
    }
    this.log(`[omni] 影子停用：${reason}`);
    // 落一条可见记录：档案里能看出「从这里开始没有 omni 数据」
    this.opts.emit({ seq: null, skipped: 'broken', why: reason.slice(0, 120) });
  }

  private armConnectTimeout(): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.state === 'connecting') {
        this.break('握手超时');
      }
    }, this.opts.connectTimeoutMs ?? 15_000);
    this.connectTimer.unref?.();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private armResponseTimeout(): void {
    this.clearResponseTimer();
    this.responseTimer = setTimeout(() => {
      this.responseTimer = null;
      this.break('response 超时');
    }, this.opts.responseTimeoutMs ?? 30_000);
    this.responseTimer.unref?.();
  }

  private clearResponseTimer(): void {
    if (this.responseTimer !== null) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearResponseTimer();
  }
}

/** base64 长度 → 字节数（不解码，省一次分配） */
function base64Bytes(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - pad;
}



