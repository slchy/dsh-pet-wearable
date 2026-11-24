/**
 * 快车道装饰器：**短句纯闲聊**直接答，其余交给内层 agent（dsh）。
 *
 * <h2>三条路径</h2>
 *
 * ```text
 *   isFastCandidate 为假 ──────────────▶ dsh（完全不启动快模型，0 ms 开销）
 *
 *   投机（默认开）：
 *     快模型与 dsh **同时发**；
 *     - 快模型先给出实质文本 → 用它的，dsh 的增量丢掉（请求照常跑完，见「已知代价」）
 *     - 快模型说 [[DELEGATE]] / 超时 → 把 dsh 已到的增量补放出去，转用 dsh
 *
 *   串行（FAST_LANE_SPECULATE=0）：
 *     先等快模型定下来，命中才答，否则再叫 dsh（委派轮白等一次判定）
 * ```
 *
 * **为什么投机能白赚**：dsh 的 TTFT 真机中位 690 ms，而快模型约 500 ms 就能判定
 * 自己答不答得了 —— 判定通常早于 dsh 吐出第一个 token，所以把 dsh 的增量先扣在
 * 缓冲里，正常轮次压根没有东西可扣。实测串行版的「委派代价」p50 是 570 ms，
 * 投机把它压到 0（`bench/fast_lane` 可复现）。
 *
 * <h2>流式传输</h2>
 *
 * 快模型一旦吐出**确定不是暗号**的第一个字，就逐字推给 TTS 的流式通道，
 * 不再等整句说完 —— 短答能省 150–200 ms。判定暗号只需要看开头两个字符：
 * 情绪标签是单 `[`（`[开心]`），暗号是 `[[`，不会误伤。
 *
 * **一旦开闸就不能再退回 dsh**（已经播出去的声音收不回来），所以中途报错时
 * 按「已播出的那部分」收下，而不是重播一遍。
 *
 * <h2>已知代价（投机）</h2>
 *
 * 命中快车道的那一轮，dsh 也在后台把话答完了，但用户没听到：
 * - 白花一次 dsh 调用（token 成本）
 * - dsh 的会话历史里留着一条「用户没听过的回答」
 *
 * 换掉它的是委派轮不再白等判定。要退回串行：`FAST_LANE_SPECULATE=0`。
 */
import { cleanForSpeech } from './agent.ts';
import { EVENTS } from './events.ts';
import { parseEmotion } from './emotion.ts';
import type { FastVoiceEngine } from './engine-contract.ts';
import { CascadeVoiceEngine, LiveVoiceEngine } from './engines/index.ts';
import { FastLlmClient, type FastAnswer } from './fast-llm-client.ts';
import {
  SYSTEM_PROMPT_PLAIN,
  SYSTEM_PROMPT_WITH_DELEGATE,
  TASK_RULE,
  TASK_RULE_PLAIN,
} from './persona.ts';
import { normalizeForCompare, PrefetchSlot, SPEC_MIN_CHARS } from './prefetch-slot.ts';
import type { AgentImage, AgentProvider, AgentReplyView, DelegateReason, FastLaneAudioLane, InjectKind, TtsProvider, TurnContext } from './providers.ts';
import {
  isCancelRequest,
  looksLikeAnswer,
  looksMemorable,
  routeTurn,
  type Lane,
  type RouteDecision,
} from './turn-router.ts';
import { ConversationLedger, type LedgerLane, type LedgerTurn } from './conversation-ledger.ts';
import type { TurnTicket } from './dialog-fsm.ts';

// 这三条判据搬进了内核（`routeTurn()` 要用它们，放这里就是循环依赖），
// 这里**原样转出**：外部（含单测）从本文件导入的行为一个字都没变。
export { looksLikeAnswer, looksLikeFollowUp, looksMemorable } from './turn-router.ts';
// 投机的认领闸门同理，挪到 `prefetch-slot.ts` 与起跑/作废放在一处。
export { acceptsSpeculation } from './prefetch-slot.ts';

/**
 * 命中这些词就不走快车道 —— 它们全都要 dsh 的工具、记忆或视觉。
 *
 * 刻意用**子串**匹配而不是分词：宁可误判成「需要 dsh」（多花 690 ms），
 * 也不要把「帮我查一下订单」当闲聊答了。
 *
 * 但**不收「什么」**：它会把「你叫什么名字」一起挡掉，而那句在系统提示词里
 * 明确属于闲聊（`bench/fast_lane` 的用例集就是这么抓到的）。
 *
 * **实时事实类必须在这里挡**（2026-11-17 换 `qwen-flash` 时抓到）：天气、时间、新闻
 * 这些「设备不可能知道、模型只可能编」的问题，交给模型自律不可靠 —— `deepseek-chat`
 * 会老实委派，`qwen-flash` 张口就编（「外面下雨了，哥你带伞没？」/「眼镜上显示是三点十五。」）。
 * 这一层的代价是多花 690 ms，编造的代价是用户带伞出门。所以它们进词表，不再靠模型判断。
 */
/**
 * 快车道只做**形态**判断：空、太长、含阿拉伯数字。
 *
 * **不再按关键词分流**（2026-11-19）。原来那张表里有 `看 / 怎么 / 为什么 / 哪`，
 * 真机 92 轮里 25 轮被判成「任务」，其中大半个是闲聊：
 *   「你看过星球大战没？」「你今天怎么样啊？」「为什么？」
 * 每挡一次就走 dsh，前面再垫一句回执 —— 用户听到的就是「张口就是我看看」。
 *
 * 「该不该委派」是语义问题，交给模型自己判（`SYSTEM_PROMPT` 里写清了正反例，
 * 模型答不了就输出 `[[DELEGATE]]`）。这里只挡两种**形态**问题：
 * - 太长：快车道人设是一句话，超了就该 dsh 慢慢说；
 * - 含阿拉伯数字：数字必须精确，不能让模型转述（`W8665881` 念错一次就够呛）。
 */


/**
 * 问「进度」而不是「干活」的句子。
 * 这类句子里的字（查/找/看）会命中 `TASK_WORDS` 被挡去 dsh，但它们问的是**已经在跑
 * 的那件事**，有事实就能照实答 —— 那正是慢车道最不该拦的一类。
 *
 * 只在**有事实来源时**才放行（`FrontedAgent` 里判断），且要求句子里没有「请/帮/给我」
 * 这类**发起任务**的词：「帮我查一下」是下指令，不是问进度。
 */
const STATUS_HINTS: readonly string[] = [
  '好了吗', '好了没', '好了没有', '好没好', '弄好了吗', '搞定了吗',
  '查到了吗', '查到没', '查到没有', '找到了吗', '找到没',
  '还在跑', '在跑吗', '跑完了吗', '完事了吗', '完成了吗', '结束了吗',
  '怎么样了', '进展', '到哪了', '还没好', '还要多久', '好了嘛',
];

const STATUS_BLOCKERS: readonly string[] = ['请', '帮', '给我', '替我', '一下'];

export function isStatusQuestion(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (STATUS_BLOCKERS.some((w) => t.includes(w))) return false;
  return STATUS_HINTS.some((w) => t.includes(w));
}

/** 快车道自己记住几轮（再多就该让 dsh 知道了，靠 `pending` 同步） */
const RECENT_TURNS = 2;

/**
 * 对话窗口的预算（字符）。中文约 1 token/字，800 字 ≈ 800 token。
 *
 * 窗口按**整对**丢弃（用户+回答一起走），不然会出现「有回答没提问」的孤儿开头，
 * 模型会把它当成自己上一句接着编。丢掉的轮次不是消失 —— 它们在 dsh 的会话里，
 * 快车道不知道就该委派（提示词里写死了）。
 */
const WINDOW_CHARS = 800;
const WINDOW_MESSAGES = 8;

/**
 * dsh 末尾这句是不是在**等用户回话**。
 *
 * 只看句尾不够 —— 真实的一句是「你要删哪条，说个大概内容，我找出来对一下再动手。」
 * （句号结尾）。所以句中扫疑问词：只要出现就按「在等回话」处理，下一句短回话
 * 一律交给 dsh。误判的代价只是那一句慢 700 ms，漏判的代价是业务断链。
 */
const ASK_MARKERS: readonly string[] = [
  '？', '?', '吗', '呢', '嘛', '哪', '什么', '怎么', '为什么', '多少', '是否',
  '要不要', '能不能', '可不可以', '说一下', '告诉我',
];

export function awaitsReply(speech: string): boolean {
  const t = speech.trim();
  if (t === '') return false;
  return ASK_MARKERS.some((w) => t.includes(w));
}

export interface FastLaneOptions {
  readonly inner: AgentProvider;
  /** DeepSeek key；空串 = 关闭快车道 */
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /**
   * 首字超时。700 → 1200：`bench/fast_lane` 扫出来的 —— 首字 p90 是 598–723 ms，
   * 700 ms 会掐掉正常答案（13 条闲聊里漏 1 条），1200 才 13/13。
   * 放宽**不增加委派代价**：真委派是首字符 `[[` 早退，付的是 TTFT（实测 469–658 ms）；
   * 这个超时只兜「模型一个字节都不出」的病态情况。
   */
  readonly timeoutMs?: number;
  /** 首字到了之后，整句最多再等这么久（默认 2800 ms） */
  readonly totalMs?: number;
  /** 超过这么多字不当闲聊（默认 14） */
  readonly maxChars?: number;
  /** 最多攒几轮快车道对话就强制刷进 dsh（默认 4）。
   *
   * **设 0 = 永不因计数强制委派**：`pending` 会在下一次真正需要 dsh 的轮次
   * （判据命中 / 记忆提议 / dsh 在等回话）一并注入，用户永远不用为「刷上下文」等。
   * 纯聊天模式（`delegate=OFF`）建议设 0 —— 那时 dsh 根本不参与，强制转交只是让
   * 用户白等一次完整 agent 往返（真机实测 1.2 秒到 7.6 秒不等，见 `docs/LATENCY-CLOSURE.md`）。
   * 对应环境变量 `FAST_LANE_KEEP_TURNS`。
   */
  readonly keepTurns?: number;
  /** 投机双轨：与 dsh 同时发（默认 true） */
  readonly speculate?: boolean;
  /**
   * 快车道有没有**委派能力**（模型输出 `[[DELEGATE]]` 就转 dsh）。
   *
   * **线上默认关**：`main.ts` 按 `FAST_LANE_DELEGATE` 算出来显式传进来，默认
   * `(undefined ?? '0') !== '0'` → `false`。这个类自己的默认值是 `true`，别拿它当线上口径。
   *
   * 关掉（`FAST_LANE_DELEGATE=0`）时做两件事：
   * 1. 提示词换成 `SYSTEM_PROMPT_PLAIN` —— 纯聊天，没有分流规则也没有暗号出口；
   * 2. `delegated` 恒为 false，即使模型自己写出那六个字符也按普通文本处理。
   *
   * **代价必须清楚**：快车道不再有「我不知道该不该交给 dsh」这个出口。问天气、
   * 问订单这类问题它会按聊天模型的方式答（可能编），所以关掉之后**上游必须自己
   * 决定哪些句子根本不进快车道**，不能指望它自己让路。
   */
  readonly delegateEnabled?: boolean;
  /**
   * 快车道请求的对冲份数（默认 1 = 不对冲）。
   *
   * 实测 `qwen-flash` 的首字 130–430 ms 全是**等响应头**那一段的服务端排队噪声，
   * 提示词长度、历史、前缀缓存、连接冷热都排除了（见 `FAST_LANE_TRACE` 的分解）。
   * 并发发 N 份取最先回来的，能把 p90 拉向 p50；代价是 token  roughly ×N ——
   * 快车道回复只有 20 来字，落败的那些在拿到响应头前就被掐掉，成本可忽略。
   */
  readonly hedge?: number;
  /**
   * 判停前起跑：ASR 一句定稿就把这一句问出去（默认 true）。
   *
   * 留这个开关是为了**能 A/B**：这条路的收益只有一百多毫秒，混在「模型首字」
   * 的自然抖动里根本看不出来，没有对照组就只能靠猜。
   */
  readonly prefetch?: boolean;
  /**
   * 中间结果投机：拿 ASR 的 partial 先把这一句问出去（默认 true）。
   *
   * 比「定稿前起跑」再往前提 500–1200 ms，但**文本是猜的** —— partial 在句末会大改，
   * 只有定稿确认它是前缀时才认领（见 `acceptsSpeculation`）。所以这条路**不改正确性**，
   * 只多花一点请求钱：确认不了就作废，退回定稿后再问。
   */
  readonly partialSpeculate?: boolean;
  /**
   * 快车道胜出后怎么处置在途的慢车道那一轮。
   *
   * - `rpc`（默认）：发 `session/cancel`。当前 dsh 的 **SDK 运行时没放行**这个方法
   *   （实测 `unknown ... runtime method`），所以实际效果是「让它跑完」，
   *   但换成支持它的运行时就能白赚。
   * - `interrupt`：SIGINT 杀进程。**会退出**，下一轮重启 + resume 实测多花 ~2 s，
   *   比省下的那次调用更贵 —— 只在确定不会再问时才值得。
   * - `off`：什么都不做。
   */
  readonly cancelMode?: 'rpc' | 'interrupt' | 'off';
  /**
   * 后台任务状态的一句话事实（`session.taskStatus()`）。
   *
   * 只在**调用时**取，所以拿到的是本轮那一刻的真实状态。空串 = 不给（不追加规则）。
   */
  readonly taskStatus?: () => string;
  /**
   * 长期记忆的**只读**切面：给一句话，返回和它相关的几条记忆。
   *
   * 记忆由 L2（dsh）独占写入（`MEMORY.md`），这里只读；L1 想记什么只能提议，
   * 由 L2 决定落不落盘。
   */
  readonly memory?: (userText: string) => readonly string[];
  /** 测试注入用 */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /**
   * 快车道对话窗口的**字符**预算（默认 {@link WINDOW_CHARS}，800）。
   *
   * 窗口越大首字越慢：每多一轮，system+history 就多几十上百 token。快车道只答短句、
   * 只记 `RECENT_TURNS` 轮，所以这个值可以调小换首字 —— 环境变量 `FAST_LANE_WINDOW_CHARS`。
   */
  readonly windowChars?: number;
  /**
   * 中间结果至少几个字才起跑投机，默认 {@link SPEC_MIN_CHARS}（6）。
   *
   * 只控制「发不发请求」，不控制认不认（认领永远要过三条闸）。调大 = 省钱少猜，
   * 调小 = 多发请求赌命中。对应环境变量 `FAST_LANE_SPEC_MIN_CHARS`。
   */
  readonly specMinChars?: number;
  /**
   * 审计出口：把「问出去什么、答回来什么、为什么丢掉」**全量**交给档案。
   *
   * 只观察、不参与决策，抛错也会被吞掉（审计不该影响通话）。为什么要它：
   * 快车道（qwen-flash）**没有 session log**，而 `isFastCandidate()` 只挡 ASCII
   * 数字 —— 中文数字、短碎片、闲聊全走这条路。不落档，「抢话之后模型有没有接上
   * 前半句」就无从审计。dsh 那侧另有 `session.v4.jsonl.zstd`，不用走这里。
   */
  readonly audit?: (name: string, data: Record<string, unknown>) => void;
}

/**
 * 这句话值不值得先问快模型。
 *
 * **只挡形态，不判语义**：空串、超出字数、含阿拉伯数字这三条是机械的，放行之后
 * 由模型自己按意思决定答还是输出 `[[DELEGATE]]`。
 *
 * 2026-11-19 之前这里挂着 `TASK_WORDS`/`LIVE_FACT`/`TOOL_REQUEST` 三张词表，
 * 「你看过星球大战没？」「为什么？」这类闲聊因为含「看」「为什么」被一票判成任务，
 * 真机 92 轮里 25 轮白走 dsh（还垫一句回执，用户以为快模型罢工）。词表删干净了。
 */
export function isFastCandidate(text: string, maxChars = 14): boolean {
  const core = text.replace(/[\s。.,，!！?？、~～…\-—]/g, '');
  if (core.length === 0 || core.length > maxChars) {
    return false;
  }
  return !/[0-9０-９]/.test(core);
}

/** dsh 增量此刻该去哪：正常直通、进缓冲（等判定）、还是丢掉（快车道已胜出） */
type InnerMode = 'pass' | 'buffer' | 'drop';

export class FrontedAgent implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly apiKey: string;
  /** 文本快车道的请求端：对冲 / 两段超时 / SSE 判暗号都在里面，见 `fast-llm-client.ts` */
  private readonly llm: FastLlmClient;
  /** 判停前预跑那一趟（同一时刻只有一趟），见 `prefetch-slot.ts` */
  private readonly slots: PrefetchSlot;
  private readonly maxChars: number;
  private readonly keepTurns: number;
  /**
   * `pending` 的硬上限（轮）。超过就丢最老的，见 `rememberFast`。
   *
   * 不设上限的话，`keepTurns=0`（永不因计数转交）时数组会一直长。
   * 取 `keepTurns` 的 4 倍，且至少 8 轮 —— 真正需要 dsh 的那一轮带上几轮上下文就够了。
   */
  private readonly pendingCap: number;
  /** 累计丢掉的轮次（落 `agent.trim` 用） */
  private droppedTurns = 0;
  private reportedDropped = 0;
  private readonly windowChars: number;
  /** 中间结果投机的最小字数（见 {@link FrontedOptions.specMinChars}） */
  private readonly specMinChars: number;
  private readonly speculate: boolean;
  private readonly delegateEnabled: boolean;
  private readonly prefetchEnabled: boolean;
  private readonly partialSpeculate: boolean;
  /** 投机已经起跑几次（同一条「越改越长」的链最多 2 次，别让 ASR 抖动变成请求风暴） */
  private speculateStarts = 0;
  private readonly cancelMode: 'rpc' | 'interrupt' | 'off';
  private readonly statusFacts: (() => string) | undefined;
  private readonly memory: ((userText: string) => readonly string[]) | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** 审计出口（只观察）：见 {@link FrontedOptions.audit} */
  private readonly auditSink: (name: string, data: Record<string, unknown>) => void;
  /**
   * 快车道答过、但 **dsh 还没真正确认收到** 的轮次（每轮两行：`用户:` / `你:`）。
   *
   * 区别于 `pending`：这些已经随某一轮的 `note` 发出去了，但那一轮可能被快车道掐掉
   * （`speculate` 默认双轨，快车道一开口就 `cancelInner`）。被掐的那一轮不会进 dsh 的
   * 会话，所以这批注记等于没送 —— 必须等 `rememberDsh`（dsh 真的答完并被采用）才算送达。
   *
   * 以前是「发出去就清空」，线上日志里能直接看到后果：
   * `把缓冲的闲聊轮次补进 dsh 上下文` 紧接着 `path=fast dsh_ms=0.6` —— 那一批轮次
   * 在两边都不存在了（快车道只记 2 轮、dsh 会话里没有），用户说「记忆断层」就是它。
   */
  private sentPending: string[] = [];
  private readonly pending: string[] = [];
  /**
   * 对话窗口：两条通道（快车道自己答的 + dsh 答的）都在这里，按时间顺序。
   *
   * 为什么自己攒而不是问 dsh：语音链路里多一次查询就是多一轮往返；而这些话
   * 本来就流经这里，顺手记下来是零成本。窗口是按角色发的真 messages，
   * 不是塞在系统提示词里的字符串 —— 这样前缀是「只往后长」的，缓存命中率高。
   */
  private readonly history: Array<{ who: 'user' | 'you' | 'dsh'; text: string }> = [];
  /**
   * 这一场发生过什么（四层的账本，见 `conversation-ledger.ts`）。
   *
   * `history` 是**给模型的 prompt 窗口**（顺序、角色、截断都由 prompt 需要决定），
   * 账本是**给内核判断用的**：上一轮谁答的、那一轮用户听到多少。
   * 两者在每轮结束时同时写入 —— 判断只看账本，prompt 只看窗口。
   */
  private readonly ledger = new ConversationLedger();
  /**
   * 上一轮 dsh 说了什么、是不是在问话。
   *
   * 从**账本**取，不再从 `history` 倒着扫：窗口里还有用户自己那句，从末尾取第一个
   * 会取到它 —— 回放里「上一轮是 dsh」就是这么凭空消失的。
   */
  private get lastDsh(): { speech: string; asked: boolean } | null {
    const last = this.ledger.lastAnswered();
    if (last === null || last.lane !== 'dsh') {
      return null;
    }
    return { speech: last.assistantText, asked: awaitsReply(last.assistantText) };
  }
  private sink: ((text: string) => void) | null = null;
  /**
   * 音频直出车道（omni）。**按连接挂**：`VoiceConnection` 建连时挂、断开时摘。
   *
   * 默认 `null` = 这条腿不存在，一切照旧走文本快车道。
   */
  private audioLane: FastLaneAudioLane | null = null;
  /** 交给慢车道时叫一次：编排层据此给用户一句回执 */
  private delegateHook: ((reason: DelegateReason) => void) | null = null;
  private innerMode: InnerMode = 'pass';
  private readonly buffered: string[] = [];
  /**
   * 这一轮是不是「已经对用户说过话、正在等 dsh」。
   *
   * 插话时据此改走「放手」而不是「取消」：omni 的垫话等于**承诺了答案**，
   * 而 `session/cancel` 只作废下游、上游的活儿照跑完（真机实测取消之后 2 s，
   * `bash` 才刚结束）—— 取消只省下最后那一步总结，丢掉的正是要兑现的那句话。
   */
  private delegating = false;
  /**
   * 投机起的 dsh 那一轮属于哪个代次。
   *
   * 取消**按代次**判定：只有「现在这一轮的票据」才允许取消上游。以前用一个
   * `innerDone` 布尔量挡「自己这一轮已经答完」，但那个布尔量和 dsh 的真实状态
   * 之间没有共同标尺 —— 快模型比 dsh 慢时，等它吐第一个字，自己那轮早答完、
   * 用户已经开了下一轮，取消落到下一轮头上（实测把 harness 打过一次）。
   */
  /** 当前这一轮（最近一次 reply）的代次。取消时用它丢弃迟到的票据 */
  private currentGen = -1;
  /** 当前这一轮的完整票据（`{no, gen}`）；迟到的取消靠它比对 */
  private currentTicket: TurnTicket | null = null;
  /** 没有真票据时用的本地代次（单测 / 保活） */
  private localGen = 0;
  /** 已经发过取消的票据（`no:gen`，同一张只发一次） */
  private cancelledKey: string | null = null;

  /**
   * 这一轮的开轮时刻（`reply()` 进门就记）。
   *
   * 只服务一件事：`startInner` 里报「dsh 距开轮多久才真的起跑」。
   * 2026-11-22 17:30 那轮 `agent 18.51 s` 减掉 `dsh 12.05 s` 还剩 ~6.5 秒，
   * 而日志里**没有任何一行能对上**——不知道那 6.5 秒是在等锁、等回执，还是
   * dsh 建连/鉴权重试。这一行就是为了把那个空洞切开。
   */
  private turnStartedAt = 0;

  constructor(options: FastLaneOptions) {
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
    // 审计抛错不能把一轮通话带下水：这里吞掉
    this.auditSink = (name, data) => {
      try {
        options.audit?.(name, data);
      } catch {
        // 忽略
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
      // `ask()` 在第一个 await 之前同步装好了句柄，这里取到的就是**这一趟**的
      abortOf: () => this.llm.abortHandle,
    });
    // 放手那一轮跑完之后：答案回注记忆（见 `onDetachedAnswer`）
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

  /**
   * 快车道的回答也走这条通道（不再等整句），dsh 的增量则按当前模式过闸。
   *
   * 闸门放在这里而不是 `reply()` 里：`attachLiveSink` 是**每轮**调一次，
   * 而投机要挡的正是「dsh 早于快模型判定就开口」那一段。
   */
  attachLiveSink(sink: ((text: string) => void) | null): void {
    if (process.env['FAST_LANE_TRACE'] === '1') {
      this.log(`  快车道    [trace] attachLiveSink ${sink === null ? 'null（摘掉）' : '装上'}`);
    }
    this.sink = sink;
    if (sink === null) {
      this.innerMode = 'pass';
      this.buffered.length = 0;
      this.inner.attachLiveSink?.(null);
      return;
    }
    this.inner.attachLiveSink?.((text) => {
      if (this.innerMode === 'drop') {
        return;
      }
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

  /**
   * 外层（`main.ts`）一般不用自己挂：`FrontedAgent` 在构造时就装好回注出口。
   * 这里转发给内层，是为了「套了 `KeepAlive` 之类装饰器」时还能一路传下去。
   */
  setDetachedAnswerSink(
    cb: ((userText: string, answer: string, spoken: boolean) => void) | null,
  ): void {
    this.inner.setDetachedAnswerSink?.(cb);
  }

  /** 挂/摘音频直出车道（omni）。见 `FastLaneAudioLane` */
  attachAudioLane(lane: FastLaneAudioLane | null): void {
    this.audioLane = lane;
    // 探针：连接建立时打一行 —— 有它才说明车道真的挂到了这个实例上
    this.log(`  车道    attachAudioLane(${lane === null ? 'null' : 'omni'})`);
  }

  /**
   * 把当前挂着的 omni 车道包成 {@link FastVoiceEngine}（Live 直出音频）。
   *
   * 没挂车道就是 `null`：这条腿**不存在**，不是「挂了但坏了」—— 内核据此选级联。
   * 每次调用给一个新实例：引擎只持有车道的引用，没有自己的状态，包一层是零成本的。
   *
   * **这是适配层，不是新实现**：它把既有的 live 车道（`FastLaneAudioLane`）接到
   * `FastVoiceEngine` 契约上，行为由 `tests/fast-voice-engine.test.ts` 验。
   *
   * **当前阶段边界**：尚未切入 `TurnRunner` 生产热路径（`TurnRunner` 目前仍走
   * `AgentProvider` 三分支以承载双轨投机、流式 TTS 回落与延迟埋点），留给下一阶段
   * 收口，**非漏接线**。
   */
  toLiveEngine(): FastVoiceEngine | null {
    const lane = this.audioLane;
    if (lane === null) {
      return null;
    }
    return new LiveVoiceEngine(lane);
  }

  /**
   * 把本类的快模型 + 提示词窗包成 {@link FastVoiceEngine}（LLM → TTS）。
   *
   * 端口全部复用现有实现，**不另造 HTTP**：
   * - `ask` → 本类的 `llm` 与 `messages()`（对冲 / 两段超时 / SSE 判暗号都在里面）；
   * - `onPartial` / `onFinal` → `speculatePartial()` / `prefetch()`（中间结果投机与
   *   判停前预跑，和文本快车道共用同一个槽位 —— 两套槽位会各发一次请求）；
   * - `onAbort` → `dropPrefetch()`（掐掉在途那一趟，别让它跑到超时）。
   *
   * `speech` 在这里就清洗好（`parseEmotion` + `cleanForSpeech`）：整段合成那条路
   * 直接拿它送 TTS，标签与 markdown 不能等到 provider 再处理。
   *
   * **这是适配层，不是新实现**：端口全部指向本类已有的实现，行为由
   * `tests/fast-voice-engine.test.ts` 验。
   *
   * **当前阶段边界**：尚未切入 `TurnRunner` 生产热路径（`TurnRunner` 目前仍走
   * `AgentProvider` 三分支以承载双轨投机、流式 TTS 回落与延迟埋点），留给下一阶段
   * 收口，**非漏接线**。
   */
  toCascadeEngine(tts: TtsProvider): FastVoiceEngine {
    return new CascadeVoiceEngine({
      isReady: () => this.apiKey !== '',
      tts,
      ask: async (turn, emit, signal) => {
        if (signal.aborted) {
          throw new Error('引擎中止');
        }
        // 引擎那条 `signal` 与 `llm.abortCurrent` 是两条路：前者是内核不要这一轮了，
        // 后者是真正掐掉 HTTP（`ask` 自己不认 `AbortSignal`）。
        const abort = (): void => {
          this.llm.abortCurrent(new Error('引擎中止'));
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const answer = await this.llm.ask({
            userText: turn.text,
            startedAt: this.now(),
            emit,
            kind: 'live',
            messages: this.messages(turn.text),
          });
          const { emotion, rest } = parseEmotion(answer.text);
          return {
            text: answer.text,
            speech: cleanForSpeech(rest),
            emotion,
            delegated: answer.delegated,
          };
        } finally {
          signal.removeEventListener('abort', abort);
        }
      },
      onPartial: (text) => {
        this.speculatePartial(text);
      },
      onFinal: (text) => {
        this.prefetch(text);
      },
      onAbort: () => {
        this.dropPrefetch('引擎中止');
      },
    });
  }

  /**
   * 这一轮会不会走音频直出。
   *
   * 宿主在**起跑流式 TTS 之前**问一次 —— 那一步会真的开一个合成 task，而 omni 轮
   * 没有任何文本可送（服务端会拒空文本、整轮退化成兜底）。判据必须与 `reply()`
   * 内部完全一致，所以两边都问 {@link decisionFor}。
   *
   * **走 `routeTurn()`（内核），不再拿级联的判据**：原来 `textEligible()` 里那几条
   * （14 字上限、`apiKey !== ''`、快车道历史深度）是 qwen-flash 的文本窗限制，
   * omni 吃整段音频，这些前提对它没有物理依据 —— 后果是「把 qwen-flash 的 key
   * 删掉，omni 也跟着不答了」。现在 Live 只看健康度，答不答得了由它自己决（`tool_call`）。
   */
  willServeAudio(text: string): boolean {
    const decision = this.decisionFor(text);
    const lane = this.audioLane;
    this.auditSink(EVENTS.agentLane, {
      has_lane: lane !== null,
      lane_ok: lane !== null && lane.willServe(),
      ok: decision.lane === 'live',
      lane: decision.lane,
      why: decision.why,
      ...(lane?.explain?.() ?? {}),
    });
    if (lane === null) {
      this.log('  车道    ✗ 没有挂上 omni 车道（`attachAudioLane` 没到这一层）');
    }
    if (decision.lane !== 'live' && decision.why !== 'live-ready') {
      this.log(`  车道    这一轮不走 omni：${decision.why}`);
    }
    return decision.lane === 'live';
  }

  /**
   * 路由决定 —— 内核的纯函数，见 `turn-router.ts`。
   *
   * 输入全部与引擎实现无关：Live 的健康度、级联可用性、dsh 是否在等回话、
   * 上一轮谁答的。**规则只写在 `routeTurn()` 里一次**。
   */
  private decisionFor(text: string): RouteDecision {
    // **只看「上一轮谁答的」**，而且只问账本：账本里只有**已经结束**的轮次，
    // 所以不会取到用户自己那一句 —— 回放里 `willServeAudio` 说 stick-to-dsh、
    // `reply()` 里却走了 omni，就是栽在「从 history 末尾取第一个」上。
    const lastLane = this.lastLedgerLane();
    return routeTurn(text, {
      live: this.audioLane === null ? 'off' : (this.audioLane.willServe() ? 'ready' : 'down'),
      cascade: this.apiKey !== '',
      dshAwaiting: this.lastDsh?.asked === true,
      lastLane,
    });
  }

  /**
   * 同一判据，但**不打审计事件** —— 给投机 / 预跑用。
   *
   * 那些调用每句话都要走一遍（`speculatePartial` 在中间结果上反复触发），
   * 打 `agent.lane` 会把档案刷满，也会让「这一轮到底谁答的」失真。
   */
  private laneWouldServe(text: string): boolean {
    return this.decisionFor(text).lane === 'live';
  }

  /**
   * 记一轮**不是自己答的**（omni 直出）—— 让上下文与 dsh 交接不断链。
   *
   * 不记的后果不是「少一条日志」：快车道历史里没有这一轮，下一轮委派给 dsh 时，
   * dsh 拿到的上下文是断的，而 omni 自己也以为没答过。
   *
   * @param truncated 用户**少听了一段**（被打断 / 只播了一半）。结算才知道，所以
   *   上游可以晚一步传；缺省 `false` 时行为与旧的两参调用完全一致。
   *   它进的是账本（`conversation-ledger.ts` 的 `truncated`），路由与回注都看那一栏。
   */
  noteServedTurn(userText: string, said: string, truncated = false): void {
    const speech = said.trim();
    // 一个字都没出声就不记：否则窗口里会出现「用户问了、你答了空」
    if (speech === '') {
      return;
    }
    // `recordSaid` 按 `cascade` 记的默认值在这里被改写成 **live** —— 这一轮实际是
    // omni 答的，账本用来判断「上一轮谁答的」，记错了路由就错。
    // 票据跟着记账走：结算（`reconcileTurnOutcome`）回来时靠它认领这一笔。
    this.recordSaid(userText, speech, 'live', truncated, this.currentTicket ?? undefined);
    this.auditSink(EVENTS.agentDone, {
      path: 'omni',
      len: [...speech].length,
      text: speech,
      truncated,
    });
  }

  /**
   * 账本快照（只读）：这一场已经结束的每一轮、谁答的、用户少听没少听。
   *
   * 账本是内核判断的唯一真值（见 `conversation-ledger.ts`），外面**只能看不能改** ——
   * 排障和单测需要看到「记进去的到底是什么」，尤其是 `truncated` 这种只在结算时
   * 才知道的字段。
   */
  get ledgerTurns(): readonly LedgerTurn[] {
    return this.ledger.recent(this.ledger.size);
  }

  /**
   * 结算后才知道的事实（`truncated` / `endedAtMs`）按票据对回账本。
   *
   * 内核的 `settleTurn` 端口调这里：账是 `reply()` 返回时记的，而「用户少听了一段」
   * 要等播完才算得出来。不回来改这一笔，`KernelState.ledger` 与 `ConversationLedger`
   * 就是两份会各自漂移的账 —— 内核说少听了、账本说听全了，路由与回注按哪一份都错。
   *
   * 认领**只认票据一字不差的那一笔**；对不上就什么都不做（迟到的结算不能改别的轮次）。
   */
  reconcileTurnOutcome(info: {
    readonly ticket: { readonly no: number; readonly gen: number };
    readonly truncated: boolean;
    readonly endedAtMs: number;
  }): void {
    this.ledger.reconcileOutcome(info.ticket, info.truncated, info.endedAtMs);
  }

  /**
   * 上一轮**是谁答的**（`null` = 还没有答过的轮次）。
   *
   * 给 `DialogRuntime` 播种 `initialKernelState` 的 `ledger.lastLane` 用：重连之后
   * 内核是新建的，不知道上一轮是 dsh，用户顺着它的追问回一句就会被当成闲聊抢答。
   *
   * `pet`（宠物主动开口）不是「谁答了用户这一轮」，按没有上文处理 —— 和
   * {@link decisionFor} 的口径必须是同一份，所以两边都走这里。
   */
  lastLedgerLane(): Lane | null {
    const answered = this.ledger.lastAnsweredLane();
    return answered === null || answered === 'pet' ? null : answered;
  }

  /**
   * 某个轮次**由别的车道答了**（委派），把答案回注给音频车道。
   *
   * 快车道自己的窗口不用管：委派轮走的是 `delegate()` → `rememberDsh()`，
   * 那边已经记过了。这里补的是**另一半** —— omni 的服务端历史里只有
   * 「用户问了什么」，不知道 dsh 答了什么，下一轮顺着追问就接不上。
   *
   * 只该在**这一轮真的播完了**时叫。被打断的正文不回注：用户没听到的东西
   * 不该变成 omni 的记忆。
   */
  injectAnsweredTurn(userText: string, said: string, kind: InjectKind = 'spoken'): void {
    const speech = said.trim();
    if (speech === '' || this.audioLane === null) {
      return;
    }
    this.audioLane.injectAnswer?.(userText, speech, kind);
  }

  /**
   * 编排层挂「这一轮交给慢车道了」的钩子。
   *
   * 只在快车道**真的让步**时叫（本地判据否决 / 暗号 / 超时 / 空答复），快车道胜出时不叫。
   * 回调里不要做耗时的事：它在 `reply()` 的同步段里被调用。
   */
  setDelegateHook(cb: ((reason: DelegateReason) => void) | null): void {
    this.delegateHook = cb;
  }

  private reportDelegate(reason: DelegateReason): void {
    if (this.delegateHook === null) {
      return;
    }
    try {
      this.delegateHook(reason);
    } catch (error) {
      this.log(`  快车道    ✗ 回执钩子失败：${(error as Error).message}`);
    }
  }

  /**
   * 判停之前先把这一句问出去（宿主在 ASR 定稿时调，见 `UtteranceAssembler.onSentence`）。
   *
   * 只做一件事：**把纯等待变成重叠**。文本此刻已经定了；判停器随后说「并下一段」
   * 的话，`reply()` 拿到的就是更长的另一句，这条预跑自然不被认领 ——
   * 所以这里的判断要和 `reply()` 里的门槛**同源**，否则会白花钱。
   *
   * 不抛错、不阻塞：所有失败都在 `reply()` 认领时才浮出来（那时才有人处理）。
   */
  prefetch(text: string): boolean {
    if (!this.prefetchEnabled) return this.slots.has;
    if (this.laneWouldServe(text)) {
      // omni 会直出这一轮：快车道这趟结果**必然作废**（真机 `20261123-051448`
      // 第 6/7 轮在 serve=full 下还各发了 2 份 qwen-flash 对冲，跑完直接丢）。
      this.log('  快车道    预跑跳过：这一轮会由 omni 直出');
      return false;
    }
    if (this.slots.text === text) return true;
    // 投机起跑的那一趟对上了定稿：**认它**。它已经跑了几百毫秒，从头再问等于
    // 把投机白送的时间还回去。文本改写成定稿，后面 `take` 按一字不差认领。
    if (this.slots.confirmSpeculation(text, this.specMinChars)) {
      this.speculateStarts = 0;
      return true;
    }
    this.speculateStarts = 0;
    if (!this.isPrefetchable(text)) return false;
    this.slots.start(text, false);
    return true;
  }

  /**
   * 投机：拿 ASR 的**中间结果**先把这一句问出去（宿主在 `notePartial` 时调）。
   *
   * 收益来自 `①停嘴→定稿` 那一段：真机 47 轮里它 p50 = 731 ms，而中间结果在停嘴
   * 那一刻有 47% 的概率已经是定稿的前缀（且覆盖 ≥60% 长度）。这段时间够模型答完。
   *
   * **不改正确性**：这份结果只在定稿确认「它确实是前缀」时才被认领
   * （`acceptsSpeculation`），确认之前一个字节都不会下行；认不了就作废，
   * 退回「定稿后再问」，和没做这件事完全一样。
   *
   * 为什么要限次：一句话 ASR 能给 5–14 版中间结果，每版都发就是十几倍请求。
   * 只在「越改越长」时重来，且同一条链最多 2 次；中间结果被改写（不是变长）
   * 就收掉 —— 那说明 ASR 在纠错，早期那版大概率跟定稿对不上。
   *
   * **返回值 = 这一次到底有没有投出去**，宿主据此决定「这段语音还算不算有投机机会」。
   * 不能无条件当成功：长度门槛、候选判据、配额全在这边，宿主记账早一步就会把
   * 一句被挡掉的「嗯」记成「已投过」，整段语音再没机会。
   */
  speculatePartial(text: string): boolean {
    if (!this.prefetchEnabled || !this.partialSpeculate) return false;
    if (this.laneWouldServe(text)) {
      // 同上：omni 会直出，投机必然作废。中间结果会反复触发，所以这条不打日志
      // （`willServeAudio` 那一发已经把 `agent.lane` 落档了）。
      return false;
    }
    const trace = process.env['FAST_LANE_TRACE'] === '1';
    // 短于这个长度的结果**认不了**（见 `acceptsSpeculation`），发了也是白花钱。
    // 和认领用同一把尺（`normalizeForCompare`），否则「发得出去、认不回来」。
    if (normalizeForCompare(text).length < this.specMinChars) {
      // tracer 上和「真的发出去了」区分开：「投机 静音…」那行是宿主打算投，这行才是结果
      if (trace) this.log(`  快车道    投机跳过：中间结果太短 ${JSON.stringify(text)}`);
      return false;
    }
    if (this.slots.has) {
      // 定稿后才起的那一趟文本是确定的，别用猜测顶掉它（它已经比投机更准，不必再投）
      if (!this.slots.speculative) return true;
      if (this.slots.text === text) return true;
      const running = this.slots.text ?? '';
      // **已经在跑的那趟覆盖得够多 → 沿用，既不重发也不消耗配额。**
      // 真机 `20261119-080409` 轮 11：投机提前 **1370 ms** 发出，ASR 又补了一版等于定稿的
      // partial，被判成「判停并了段」重起 —— 开轮时站在起跑线上的那趟只跑了 **2 ms**。
      if (!text.startsWith(running) || text.length <= running.length) {
        // 被改写 / 变短：ASR 在纠错，早期那版大概率对不上定稿 —— 收掉，下一版可以重来
        this.slots.drop(
          `中间结果被改写（${JSON.stringify(running)} → ${JSON.stringify(text)}）`,
        );
        this.speculateStarts = 0;
        return false;
      }
      // **变长**：认领要的是「去标点后完全一致」，而沿用的这一版是**前缀、不是全文**，
      // 所以留着它永远认不回来（2026-11-19 收紧认领后才发现，`830768d` 的沿用逻辑
      // 只在旧门槛「前缀 + 覆盖 ≥60%」下成立）。还有配额就重发更长的版本：
      // 第一版已经跑掉的时间是沉没成本，**认不回来才是真的亏**。
      if (this.speculateStarts >= 2) return true;   // 配额用满，只能沿用
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

  /**
   * 放弃在途的预跑 / 投机（引擎中止时叫：交给 dsh、被新轮顶掉、被插话）。
   *
   * 两件事一起做：
   * - 掐掉预跑槽那一趟（它有自己的 abort 句柄，见 `PrefetchSlot`）；
   * - 掐掉 `respond()` 里**正在跑**的 `ask` —— 引擎中止意味着内核已经不要这份答案了，
   *   不掐它会一直跑到首字 1200 ms / 整句 2800 ms 的超时，白占一条连接。
   *
   * 配额也归零：下一轮从头算，不然一次中止会把后面的投机机会一起用光。
   */
  dropPrefetch(why: string): void {
    this.llm.abortCurrent(new Error(why));
    this.slots.drop(why);
    this.speculateStarts = 0;
  }

  /**
   * 这一句「值不值得先问出去」——`prefetch` 与 `speculatePartial` 共用同一组门槛，
   * 分开写迟早两边不一致（一边预跑一边不认，白花钱）。
   */
  private isPrefetchable(text: string): boolean {
    // 这一轮由 omni 直出：它**从封段就起跑了**（见 `OmniShadow`），文本模型再问一遍
    // 就是纯白烧 —— 而且它的答案会被丢掉。所以先看车道再看文本。
    if (this.audioLane?.willServe() === true) return false;
    return this.textEligible(text);
  }

  /** 这一句是不是「快车道能答的那类话」。**不含** omni 车道的判断。 */
  private textEligible(text: string): boolean {
    if (this.apiKey === '') return false;
    if (this.lastDsh?.asked === true && looksLikeAnswer(text)) return false;
    if (looksMemorable(text)) return false;
    if (!isFastCandidate(text, this.maxChars)) return false;
    if (this.keepTurns > 0 && this.pending.length / 2 >= this.keepTurns) return false;
    return true;
  }

  async reply(
    userText: string,
    image?: AgentImage,
    note?: string,
    turn?: TurnContext,
  ): Promise<AgentReplyView> {
    // 本轮票据：取消上游时带回去，让 session 层按代次判断"这是不是还在跑的那一轮"。
    // 没有票据的调用（单测、保活 ping）自己发一个本地代次 —— 去重照样成立，
    // 只是 session 层没有真票据可比对，会直接照办。
    const ticket: TurnTicket = turn?.ticket ?? { no: 0, gen: (this.localGen += 1) };
    // 任何 await 之前先钉上票据，插话取消才能对上这一轮（委派轮也一样）。
    // 配额按轮算：上一轮用完不能让下一轮一直没法投机。
    this.speculateStarts = 0;
    this.turnStartedAt = this.now();
    this.currentGen = ticket.gen;
    this.currentTicket = ticket;
    this.innerMode = 'pass';
    // omni 自己发了 `tool_call`：宿主 drain 完音频才转到这儿，直接进慢车道。
    // **必须在任何路由判断之前** —— 再判一次会把它送回同一条车道，死循环。
    if (turn?.forceDelegate !== undefined) {
      this.log(`  快车道    omni 决定转交（${turn.forceDelegate}）`);
      // 正文可能已经是 omni 的转述 + 原话附注（`TurnRunner` 拼好的），原样交给 dsh：
      // 它听到的是「用户要什么」，而不是被 ASR 听错的那句。
      return await this.delegate(
        userText, image, note, ticket, turn.forceDelegate,
        { silent: turn.receiptSpoken === true },
      );
    }
    // 用户**显式下令取消**（"算了 / 别查了"）：替他把在跑或已放手的委派任务掐掉。
    // 与插话严格分开 —— 插话只是"我先说别的"，委派轮会放手跑完、答案回注记忆；
    // 只有这一句才是"不要了"。没有活儿在跑时它就是一句普通闲聊，照常往下走。
    if (isCancelRequest(userText) && this.cancelRunningTask()) {
      return { text: '好，不查了。', speech: '好，不查了。', path: 'fast' };
    }
    const hasFacts = this.statusFacts !== undefined;
    // **路由一次算完**（内核纯函数 `routeTurn`）。以前这里排着三条独立的早退
    // （在等回话 / 像长期事实 / 不是候选），`willServeAudio` 那边又各算一遍 ——
    // 回放里现形：宿主说「这一轮不走 omni：stick-to-dsh」，这里照样认领。
    const route = this.decisionFor(userText);
    // 问进度的句子即使含任务字也放进来 —— 事实能照实答，比让 dsh 重跑一轮快得多。
    // 这一条**只决定级联值不值得跑**，不参与路由。
    const candidate = this.apiKey !== ''
      && image === undefined
      && (isFastCandidate(userText, this.maxChars)
        || (hasFacts && isStatusQuestion(userText)));
    const overCap = this.keepTurns > 0 && this.pending.length / 2 >= this.keepTurns;
    // 判停之前就已经问出去的那一轮：**文本一字不差**才认领，见 `prefetch()`。
    // 只有「这一轮真会走级联」时 `usable` 才为真 —— live 会直出音频、带图 / 攒满
    // 一律走 dsh，那些轮次的预跑必然白花。这四个条件必须与下面的分支逐条对应：
    // 认领判据和路由判据不同源时，预跑就是在「根本不会用它的轮次」上白烧一次请求。
    const pre = this.slots.take(
      userText,
      route.lane === 'cascade' && image === undefined && candidate && !overCap,
    );
    // ① 带图必须交 dsh：omni 吃的是整段音频，没有视觉；快车道也没有读图的通道。
    if (image !== undefined) {
      return await this.delegate(userText, image, note, ticket, 'task');
    }
    // ② 内核指定的慢车道：在等回话 / 长期事实 / 有副作用的动作 / 接着 dsh 追问。
    if (route.lane === 'dsh') {
      // 四条硬规则的落地。理由要落进 `delegate=`，否则档案里分不出「为什么走了 dsh」。
      const why = route.why === 'dsh-awaiting'
        ? 'answer'
        : route.why === 'memorable'
          ? 'memory'
          : 'task';
      if (route.why === 'dsh-awaiting') {
        // 那是**对话里的回应**，不是闲聊。放给快模型就是「确认指令被抢答」，业务断链。
        this.log('  快车道    上一轮 dsh 在等回话，这句直接交给 dsh');
      } else if (route.why === 'memorable') {
        // **必须让 dsh 亲耳听到**：实测它只对「用户自己说的」话写记忆，
        // 转述过去（试过 5 种措辞）一次都不写。
        this.log('  快车道    像长期事实，交给 dsh 自己判断要不要记');
      } else if (route.why === 'stick-to-dsh') {
        this.log('  快车道    接着上一轮 dsh 的追问，继续交给 dsh');
      } else if (route.why === 'action') {
        this.log('  快车道    这一轮要动手（有副作用），只有 dsh 能做');
      }
      return await this.delegate(userText, image, note, ticket, why);
    }
    // ③ omni 直出：它**从封段就起跑了**，这里只是认领（首块通常还没到）。
    //
    // **必须排在级联判据之前**（P0-1）：`candidate` 那几条（14 字上限、阿拉伯数字、
    // `apiKey !== ''`）是 qwen-flash 文本窗的限制，omni 吃整段音频，对它没有物理
    // 依据。这三条原来写在 live 分支前面，后果是 —— 25 字的闲聊、「下午3点见」、
    // 甚至**没配 qwen-flash key** 的部署，`willServeAudio()` 说 live、宿主开了一条
    // 流式 TTS，`reply()` 却把它交给 dsh：TTS 收到空文本，整轮退化成兜底。
    //
    // 判据与 `willServeAudio()` 同源（都走 `decisionFor`），这里是同一份决定的落地。
    if (route.lane === 'live' && this.audioLane !== null && this.audioLane.willServe() === true) {
      const audio = this.audioLane.claim();
      if (audio !== null) {
        this.log('  快车道    走 omni 直出音频（不经过文本模型）');
        // `text` / `speech` 是**活的**：取的是 `response.audio_transcript` 的累积，
        // 跟着**生成**进度长、不跟播放进度。生成比播放快得多（3 s 音频 ~1 s 到齐），
        // 所以被打断时它通常是**全文**，不是「已播出去的那部分」。
        // 想知道听到了多少只能看 `playedSeconds`（`dialog.ts` 的续话尾巴就是这么算的）。
        const live = (): string => audio.transcript();
        return {
          get text(): string { return live(); },
          get speech(): string { return live(); },
          audio,
          path: 'omni',
        };
      }
      // 认领失败（连接没就绪 / 这一份已被取消）→ 照常走文本路，不额外报错
    }
    // ④ 级联专用：形态不合格（太长 / 阿拉伯数字 / 没 key）或攒满上限才让位。
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
    /** 推给 TTS 的唯一出口：预跑攒下的字和后来的实时字都从这里走，顺序才不会乱 */
    const push = (text: string): void => {
      if (process.env['FAST_LANE_TRACE'] === '1' && emitted === '') {
        this.log(`  快车道    [trace] 首个增量推出（sink ${this.sink === null ? '未装' : '已装'}）`);
      }
      emitted += text;
      // 推出去的第一个字就是「这一轮归快车道」的判决书 —— 退回 dsh 会播两遍，
      // 所以这一刻就把在途的 dsh 那一轮掐掉，别等它把整段答完再取消。
      // 只有真开了投机才动手：不投机时 dsh 里在跑的是**别的**轮次（比如后台任务
      // 的旁白），取消它等于把旁白吞了。
      if (dsh !== null) this.cancelInner(ticket);
      this.sink?.(text);
    };
    if (this.speculate) {
      // 先上闸再起跑：`inner.reply` 在第一个 await 之前是同步执行的，
      // 顺序反了的话 dsh 抢先推的增量会绕过缓冲直接进 TTS。
      this.innerMode = 'buffer';
      dsh = this.startInner(userText, image, note, ticket);
      // 先接住：快车道一开口就会掐掉这一轮，而它被掐时经常以 reject 收场（取消后没有
      // 可念的文本）。真正要用它的 `commit`/`abandon` 挂得比「掐」晚，中间这段窗口里
      // 的 rejection 是进程级的（线上真的这样挂过一次）。
      // `catch` 派生的是另一个 promise，`await dsh` 该抛的还是抛，分支行为不变。
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
      // 已经开闸 = 有字推给了 TTS，这时候再退回 dsh 会把同一句话播两遍
      if (emitted !== '') {
        this.log(`  快车道    ✗ ${why}（已播出一部分，按现有文本收下）`);
        dsh?.catch(() => undefined);
        return this.commit(userText, emitted, 0, dsh, ticket);
      }
      // 超时和真报错分开：回执话术不一样（「嗯，我想想」vs「我看看」）
      const reason: DelegateReason = why.includes('超时') ? 'timeout' : 'error';
      // 带上「在快车道上已经耗了多久」：和后面 `dsh 12.05 s` 那行一比，
      // 「交给 dsh」→「dsh 真的起跑」之间有没有空洞就现形了（2026-11-22 那轮有 ~6.5 s）。
      const spent = (this.now() - startedAt).toFixed(0);
      return await this.abandon(dsh, userText, image, note, `✗ ${why}（快车道已耗 ${spent} ms）`, ticket, reason);
    }

    if (answer.delegated) {
      return await this.abandon(dsh, userText, image, note, `判为需要 dsh（${answer.firstTokenMs} ms 早退）`, ticket, 'delegate');
    }
    if (cleanForSpeech(parseEmotion(answer.text).rest) === '') {
      return await this.abandon(dsh, userText, image, note, '空答复', ticket, 'empty');
    }
    return this.commit(userText, answer.text, answer.firstTokenMs, dsh, ticket);
  }

  /** 快车道胜出：**取消**在途的 dsh 那一轮，别白花钱、也别留幽灵历史 */
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
          // 取消来不及时它**已经答完**（0.6–0.9 s），`assistant/message` 就永久留在
          // dsh 的会话历史里，而用户听到的是快车道的答案。下一轮开轮前把那一轮切掉。
          this.inner.rollbackTurn?.(ticket);
        },
        () => undefined,
      );
    }
    const { emotion, rest } = parseEmotion(raw);
    const speech = cleanForSpeech(rest);
    this.recordSaid(userText, speech, 'cascade', false, ticket);
    this.log(`  快车道    ${firstTokenMs} ms 首字（流式） ：${JSON.stringify(speech)}`);
    // `path` 必须由这里报：编排层分不出「预跑被认领」和「qwen 现场回」——
    // 两者的 `dsh_ms` 都可能是几十毫秒。
    return { text: raw, speech, firstTokenMs, emotion, path: 'fast' };
  }

  /**
   * 记下这一轮（快车道自己的记忆 + dsh 最后说的话）。
   *
   * 快模型默认**只看到当前一句话**，所以「我姓袁」→「我叫什么」这种追问它接不上；
   * 更危险的是 dsh 刚问过「确认要删除吗」，用户答「好的」会被当成闲聊答掉。
   * 两处记忆都塞进系统消息，成本是每轮多几十个 token。
   */
  private remember(userText: string, said: string): void {
    this.push('user', userText);
    this.push('you', said);
    this.trim();
  }

  /**
   * 把一轮「实际播出去的话」记进上下文：快车道的 `pending`（带 `keepTurns`/`overcap`）
   * + 送进 prompt 的 `history`。
   *
   * 文本快车道与 omni 直出**共用这一处** —— 分开写就会一边记账一边不记，
   * 于是「omni 答过的轮次 dsh 从没见过」，跨车道失忆。
   *
   * @param truncated 用户少听了一段。**只有结算时才知道**，所以它是个带默认值的
   *   尾参 —— 文本快车道自己答的轮次在这里还不知道播了多少（`TurnRunner` 结算时
   *   才拿得到媒体游标），记 `false` 是「暂时按听全记」，不是终值。
   * @param ticket 本轮票据。有它就随这一笔写进账本 —— 结算时
   *   `reconcileTurnOutcome()` 靠 `{no, gen}` 找回**这一笔**（不靠「最后一笔」猜，
   *   迟到的结算落到别的轮次上就是把「听全了」改成「被打断」）。
   */
  private recordSaid(
    userText: string,
    speech: string,
    lane: LedgerLane = 'cascade',
    truncated = false,
    ticket?: TurnTicket,
  ): void {
    this.pending.push(`用户: ${userText.trim()}`, `你: ${speech}`);
    // **硬上限**：纯聊天模式下 `keepTurns=0`（永不因计数转交），`pending` 会一直长 ——
    // 快车道的 prompt 本来有 `windowChars` 截断，但数组本身不封顶就会吃内存。
    // 丢最老的几轮必须落档：这是**静默丢上下文**，dsh 以后永远看不到那几轮。
    while (this.pending.length / 2 > this.pendingCap) {
      this.pending.splice(0, 2);
      this.droppedTurns += 1;
    }
    if (this.droppedTurns > 0 && this.droppedTurns !== this.reportedDropped) {
      this.auditSink(EVENTS.agentTrim, {
        dropped_turns: this.droppedTurns, cap_turns: this.pendingCap,
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
      // 没票据就不写这一栏（`undefined` 与「有票据但 no=0」是两件事）
      ...(ticket === undefined ? {} : { ticket: { no: ticket.no, gen: ticket.gen } }),
    });
  }

  /** 把一轮记进窗口（dsh 答的也记，用户听得到的话 L1 就得知道） */
  private push(who: 'user' | 'you' | 'dsh', text: string): void {
    const clean = text.trim();
    if (clean === '') {
      return;
    }
    this.history.push({ who, text: clean });
  }

  /** 按**整对**裁窗口：宁可少记一轮，也不要留下没有提问的回答 */
  private trim(): void {
    const size = (): { chars: number } => ({
      chars: this.history.reduce((n, t) => n + t.text.length, 0),
    });
    while (this.history.length >= 2 && (this.history.length > WINDOW_MESSAGES || size().chars > this.windowChars)) {
      this.history.splice(0, 2);
    }
  }

  /**
   * 掐掉投机起的 dsh 那一轮。
   *
   * **按代次去重**：同一个代次只发一次取消；票据不存在（没有投机）就不动。
   * 迟到的取消由 session 层按代次丢弃（那里才知道"在途的是哪一轮"）。
   *
   * 宿主层 `session/cancel` 实测 **5 ms 收敛**、进程不死、会话不丢、也不影响下一轮
   * （`turn/end` reason = `{kind:'aborted',reason:{kind:'user'}}`）。取消失败不算错：
   * 已经推给 TTS 的字收不回来，最坏也只是白跑一次生成。
   */
  private cancelInner(ticket: TurnTicket): void {
    // 迟到的取消：这一轮已经过去（又有新的 reply 开始了）→ 丢弃。
    // 去重必须用**整张票据**：`gen` 只在插话时增加，连续两句闲聊的 `gen` 相同，
    // 按 gen 去重会把这一轮的胜出取消吃掉（那时 dsh 就会白跑完一整轮）。
    const key = `${ticket.no}:${ticket.gen}`;
    if (ticket.gen !== this.currentGen || this.cancelledKey === key) {
      return;
    }
    this.cancelledKey = key;
    // 这一轮掐掉 → 随它送进 dsh 的那批闲聊轮次**没进 dsh 会话**，放回队列等下次。
    // 不这么做就是线上那条「记忆断层」：补进上下文的那几轮在两边都不存在。
    if (this.sentPending.length > 0) {
      this.pending.unshift(...this.sentPending);
      this.log(`  快车道    这一轮掐掉了 dsh → ${this.sentPending.length / 2} 轮闲聊留到下次同步`);
      this.sentPending = [];
    }
    try {
      if (this.cancelMode === 'interrupt') {
        this.inner.interruptTurn?.();
      } else if (this.cancelMode === 'rpc') {
        this.inner.cancelTurn?.(ticket);
      }
    } catch (error) {
      this.log(`  快车道    ✗ 取消失败：${(error as Error).message}`);
    }
  }

  /**
   * 插话 / 断连：把这一轮的上游取消掉。
   *
   * `DialogFsm.onInvalidate` → `TurnRunner` → 这里。两层都要动：快模型的 HTTP 掐掉
   * （不然它还要跑到首字 1200 ms / 整句 2800 ms 的超时），dsh 那一轮交给内层按票据取消。
   *
   * 没有这个方法时，`trackActivity` 不会转发 `cancelTurn`（它只在方法存在时透传），
   * 结果就是「喇叭停了、dsh 还在说」。
   */
  cancelTurn(ticket?: TurnTicket): void {
    const current = this.currentTicket;
    if (ticket !== undefined
      && (current === null || current.no !== ticket.no || current.gen !== ticket.gen)) {
      return;
    }
    this.llm.abortCurrent(new Error('插话取消'));
    // omni 轮的上游不是 HTTP 请求，是一个还在出的 response：不取消的话它会一直生成到
    // 结束，既烧输出 token，又让下一轮开口时它还挂着 busy。
    // 用 `interrupt` 而不是 `discard`：这一轮用户**已经听到了一部分**，
    // 删掉那条回复会和快车道 `pending` 里记的半句对不上。
    // 两者内部都走 `cancelCurrent()`，与 `0caa415` 同一条安全路径
    // （`response.created` 未到就只挂 `cancelPending`，不裸发 cancel）。
    if (this.audioLane?.interrupt !== undefined) {
      this.audioLane.interrupt();
    } else {
      this.audioLane?.discard();
    }
    try {
      // 委派轮：dsh 的活儿（工具调用、bash）取消不了，`session/cancel` 只作废下游，
      // 结果就是「活儿干完了、答案没了」—— 真机两轮委派都是这么死的（第 9、10 轮）。
      // 放手让它说完，用户之后还能听到答案（`session.detachTurn` → `setAnnouncer`）。
      if (this.delegating) {
        this.inner.detachTurn?.(ticket);
      } else {
        this.inner.cancelTurn?.(ticket);
      }
    } catch (error) {
      this.log(`  快车道    ✗ 取消失败：${(error as Error).message}`);
    }
  }

  /** 快车道让位：把 dsh 已经推进来的增量补放出去，然后等 dsh */
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
    if (dsh !== null) {
      // 开轮时（投机）就已经起跑了：那 dsh 的那段耗时是从开轮算的，中间没有空洞
      this.log('  dsh 沿用开轮时就起跑的那一趟（不另起）');
    }
    const promise = dsh ?? this.startInner(userText, image, note, ticket);
    this.innerMode = 'pass';
    const held = this.buffered.splice(0);
    for (const text of held) {
      this.sink?.(text);
    }
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
    // 这一轮交给 dsh 了 → omni 那份立刻作废。不取消的话它会在后台把整段废音频
    // 生成完（烧输出 token），并且让下一轮开口时它还挂着 busy。
    this.audioLane?.discard();
    this.innerMode = 'pass';
    // `silent`：omni 已经替我们说过一句话（垫音），再叠一句回执就是两句
    if (opts?.silent !== true) {
      this.reportDelegate(reason);
    }
    // 只有「委派之前已经对用户说过话」的轮次才放手（见 `cancelTurn`）：
    // omni 那句垫话等于**承诺了答案**，插话之后答案还得兑现；
    // 没出过声的轮次，用户插话就是不要了，照旧取消（`delegating` 保持 false）。
    this.delegating = opts?.silent === true;
    try {
      const answer = await this.startInner(userText, image, note, ticket);
      // 放手那一轮拿回来的是空答复 —— 别把它写进窗口，真正的答案从播报口出
      if (answer.speech !== '') {
        this.rememberDsh(answer.speech, userText, ticket);
      }
      return { ...answer, path: 'dsh', delegate: reason };
    } finally {
      this.delegating = false;
    }
  }

  /**
   * 用户显式下令取消：把 dsh 手上（含已放手的）那一轮真的取消掉。
   *
   * 不带票据地调 `inner.cancelTurn()` —— 放手的委派轮已经没有等待者，票据比对在
   * 那里也不成立，唯一的目的就是把在跑的那一轮停掉。返回"确实取消了"，让调用方
   * 决定要不要回一句「好，不查了」。
   */
  private cancelRunningTask(): boolean {
    if (this.inner.dshBusy?.() !== true) {
      return false;
    }
    this.log('  委派    用户显式下令取消 → 取消 dsh 手上那一轮');
    try {
      this.inner.cancelTurn?.();
    } catch (error) {
      this.log(`  委派    ✗ 取消失败：${(error as Error).message}`);
    }
    return true;
  }

  /**
   * 放手那一轮的答案回来了 → **回注记忆**（不管用户有没有已经在问下一句）。
   *
   * 委派轮被打断时我们走的是**放手**而不是取消（`session.detachTurn`）：dsh 的活儿
   * 取消不了，`session/cancel` 只作废下游输出，结果就是「活儿干完了、答案没了」。
   * 跑完的答案走这里：记进快车道的窗口（下一轮 dsh 同步会带上），并回注 omni 的
   * 服务端历史 —— 这样用户之后提起这件事，两条车道都知道答案是什么。
   *
   * 与播报（`setAnnouncer`）分开：用户已经在问新问题时不该补播，但**必须记下来**。
   */
  private onDetachedAnswer(userText: string, answer: string, spoken: boolean): void {
    const speech = cleanForSpeech(parseEmotion(answer).rest);
    if (speech === '') {
      return;
    }
    const question = userText.trim() === '' ? '（上一轮被打断的问题）' : userText.trim();
    this.log(
      `  委派    放手的答案回来了（${[...speech].length} 字，${spoken ? '会补播' : '不补播'}）`
      + ' → 回注记忆',
    );
    this.rememberDsh(speech, question);
    this.injectAnsweredTurn(question, speech, spoken ? 'spoken' : 'unspoken');
  }

  /**
   * 记下 dsh 最后说的话（快模型下一轮要看：它在问什么、答案是什么）。
   *
   * @param ticket 这一轮的票据。账本里带上它，结算时 `reconcileTurnOutcome()` 才能
   *   按 `{no, gen}` 精确改到**这一笔**；放手那一轮（`onDetachedAnswer`）不给 ——
   *   它答完时那一轮早就结束了，不归任何票据。
   */
  private rememberDsh(speech: string, userText: string, ticket?: TurnTicket): void {
    // dsh 真的答完、而且这一轮被采用了 → 随它送进去的那批闲聊轮次**确认送达**。
    // 这是唯一清空 `sentPending` 的地方（被取消的轮次不算，见 `cancelInner`）。
    this.sentPending.length = 0;
    // dsh 那一轮的用户话术也进窗口 —— 否则窗口里会出现「没有提问的回答」
    if (this.history.at(-1)?.who !== 'user' || this.history.at(-1)?.text !== userText.trim()) {
      this.push('user', userText);
    }
    this.push('dsh', speech);
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

  /**
   * 调 dsh，顺便把攒着的东西经 `note` 带过去：快车道答过的轮次 + 记忆提议。
   *
   * 用 `note` 而不是改用户原话：那一栏本来就是「系统注记」，dsh 会把两者分开。
   * 提议只给用户原话，**不替 dsh 判断该不该记** —— 记忆的写权限在 L2 手里。
   */
  private startInner(
    userText: string,
    image: AgentImage | undefined,
    note: string | undefined,
    ticket: TurnTicket,
  ): Promise<AgentReplyView> {
    // 「交给 dsh」之后**到这里**之间可能夹着好几秒（2026-11-22 测到 ~6.5 s）。
    // 这一行把它切开：距开轮 0 ms = 开轮就起跑（投机那条路）；
    // 几百毫秒到几秒 = 中间有等待，得顺着 `abandon`/`delegate` 往上查。
    this.log(`  dsh 起跑（距开轮 ${Math.max(0, Math.round(this.now() - this.turnStartedAt))} ms）`);
    const blocks: string[] = [];
    if (note !== undefined) {
      blocks.push(note);
    }
    if (this.sentPending.length > 0) {
      // 上一批送进 dsh 的那一轮没被采用（快车道赢了）→ 这批轮次 dsh 从来没见过，合并回来
      this.pending.unshift(...this.sentPending);
      this.sentPending = [];
    }
    if (this.pending.length > 0) {
      // 撤回没做成 = dsh 那一轮**已经答完且还在历史里**，而用户听到的是快车道的话。
      // 这时候不能还说「没有经过你的会话」—— 得把「你那轮用户没听到」讲清楚，否则
      // 上下文里同一句话有两个答案，它下次接着聊就会错。
      const lost = this.inner.takeRollbackOutcome?.() === 'failed';
      blocks.push([
        lost
          ? '（下面几轮是刚才的对话。有几轮**你已经答完了，但用户没听到你的回答** ——'
            + '用户实际听到的是每一对里「你」那一行；当作已知上下文即可）'
          : '（下面几轮是刚才由快车道直接答给用户的，没有经过你的会话；当作已知上下文即可）',
        ...this.pending,
      ].join('\n'));
      // **先记着、别清**：这一轮可能被快车道掐掉（掐掉的轮次不会进 dsh 会话），
      // 只有在 `rememberDsh` 里才确认送达。
      this.sentPending = this.pending.slice();
      this.pending.length = 0;
      this.log(`  快车道    ${this.sentPending.length / 2} 轮闲聊随这一轮送进 dsh`
        + `${lost ? '（含「你那轮没被听到」的说明）' : ''}`);
    }
    if (blocks.length === 0) {
      return this.inner.reply(userText, image, note, { ticket });
    }
    return this.inner.reply(userText, image, blocks.join('\n\n'), { ticket });
  }

  /**
   * 系统提示词 + 本轮的事实。
   *
   * 事实放在**系统消息**里而不是用户消息里：它不该被当成用户说的话，也不该进
   * 待同步的对话缓冲（那几行是要原样补进 dsh 的）。
   *
   * 三样东西按代价从低到高拼：后台任务事实（进度问答用）、快车道自己最近两轮
   * （不然「我叫什么」接不上）、dsh 最后一句（不然「好的」会在 dsh 问话之后被抢答）。
   */
  private systemPrompt(userText: string): string {
    const parts: string[] = [this.delegateEnabled ? SYSTEM_PROMPT_WITH_DELEGATE : SYSTEM_PROMPT_PLAIN];

    let memories: readonly string[] = [];
    try {
      memories = this.memory?.(userText) ?? [];
    } catch {
      memories = [];
    }
    if (memories.length > 0) {
      parts.push(`【长期记忆（由 dsh 维护，你只能读）】${memories.join('；')}`);
      // 记忆里已经有的，交给 dsh 就是白等一轮（它读的是同一份文件）
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
      // 禁用委派时那段规则不能说「不要委派」—— 那版提示词里根本没有委派这回事，
      // 提它等于把不存在的选项重新塞回模型面前。
      parts.push(
        (this.delegateEnabled ? TASK_RULE : TASK_RULE_PLAIN).trim(),
        facts,
      );
    }
    return parts.join('\n');
  }

  /** 对话窗口 → OpenAI 格式的 messages（dsh 说的也算 assistant：用户听到的就是这个） */
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
