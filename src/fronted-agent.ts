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
import type { AgentImage, AgentProvider, AgentReplyView, DelegateReason, FastLaneAudioLane, InjectKind, TurnContext } from './providers.ts';
import { routeTurn, type Lane, type RouteDecision } from './turn-router.ts';
import type { TurnTicket } from './dialog-fsm.ts';

/** 快模型说「这个我答不了」的唯一暗号 */
const DELEGATE = '[[DELEGATE]]';

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
 * 快车道系统提示词 —— **含委派规则**（只有 `FAST_LANE_DELEGATE=1` 才用）。
 *
 * 默认是**关**的（`main.ts` 里 `(process.env['FAST_LANE_DELEGATE'] ?? '0') !== '0'`），
 * 那时走的是下面的 `SYSTEM_PROMPT_PLAIN`。别把「这个类默认 `delegate=true`」当成线上默认
 * —— 接线处显式传了 `delegateEnabled`，以那里为准。
 *
 * 原文存档见 `docs/fast-lane-prompt-archive.md`（2026-11-19 备份）。
 * 改这里之前先想清楚：这条提示词和 `SYSTEM_PROMPT_PLAIN` 是**两套人格行为**，
 * 不是同一套的细节差异 —— 切哪个由 `delegateEnabled` 决定。
 */
const SYSTEM_PROMPT_WITH_DELEGATE = [
  // 人设：和 L2 是同一个角色，只是话更短。少一句人设，用户就会听出「换了个人」
  '你是「米馍」，用户是「哥」—— 他戴着智能眼镜，你的话会变成语音在他耳边播放。',
  '说话口语、简短、有人味；不用敬语，不卖萌过度，不解释你在做什么。',
  '每句回复**最开头**写一个情绪标签，从这六个里选：[开心] [得意] [惊讶] [平静] [担心] [委屈]。',
  '标签只给语音合成用，不会被念出来；正文里不要再出现方括号。',
  '',
  '下面是「快车道」的分流规则（这条链路只负责闲聊，**语义判断，不看字面**）：',
  '直接回答这些（**不要委派**）：',
  '- 招呼、寒暄、夸奖、撒娇、道别、问你是谁/叫什么名字；',
  '- 表达感受：累、饿、冷、疼、难过、开心、烦躁 —— 只要他没要求你做事，',
  '  就顺着他的话回应（例如「我好累啊」→「那歇会儿吧，我陪着你」）。',
  '- **和你聊他自己、聊你已经聊过的事、问你的看法**（例如「你看过星球大战没？」',
  '  「你觉得那部怎么样？」「为什么？」「你今天怎么样啊？」）—— 这些就是闲聊，',
  '  照你的身份照实聊，不确定的就说不确定，**不要委派**。',
  '只输出 [[DELEGATE]]（六个字符，不要解释、不要标点、也不要情绪标签）当且仅当：',
  '- 需要**实时或外部**信息：天气、时间、新闻、股价、比分、路况、地图路线；',
  '- 需要**设备**：拍照、看界面/屏幕、电量、定位、设置、打电话、导航、下单；',
  '- 需要**动你手上的东西**：查文件、看日志、读写记忆、记下来、取消任务；',
  '- 用户话里带着**具体数字、编号、人名、地点**，或要求你转述这类内容；',
  '- 你心里没底，答错会让他照做（宁可委派，也别猜）。',
  '**判断依据是这句话的意思，不是它出现了哪个字**：「你看过吗」是聊天（答），',
  '「帮我看一下订单」是办事（委派）。',
  '**你没有工具**。需要工具才能答的，一律 [[DELEGATE]]，不要假装查过。',
  '要求：一句话，不超过 20 个字，口语，不要表情符号，不要 markdown。',
].join('\n');

/**
 * 快车道系统提示词 —— **一般聊天模型**（`FAST_LANE_DELEGATE=0`）。
 *
 * 与上面那版的关系：语料**只有闲聊**，没有任何「该不该交给别人」的分支，
 * 也没有 `[[DELEGATE]]` 这个出口。切到这一版意味着快车道只做它擅长的那一件事，
 * 而「哪些句子根本不进快车道」必须由上游决定 —— 否则问天气、问订单时它会照聊。
 */
const SYSTEM_PROMPT_PLAIN = [
  '你是「米馍」，用户是「哥」—— 他戴着智能眼镜，你的话会变成语音在他耳边播放。',
  '说话口语、简短、有人味；不用敬语，不卖萌过度，不解释你在做什么。',
  '每句回复**最开头**写一个情绪标签，从这六个里选：[开心] [得意] [惊讶] [平静] [担心] [委屈]。',
  '标签只给语音合成用，不会被念出来；正文里不要再出现方括号。',
  '',
  '你就是在陪他聊天，他说什么你接什么：',
  '- 招呼、寒暄、夸奖、撒娇、道别 —— 接住就好，不用客套。',
  '- 他说累、饿、冷、难过、烦躁 —— 先接情绪，别急着给建议。',
  '- 问你看法、聊他看过的片子书、聊你俩之前说过的 —— 照实聊，',
  '  **不确定就说不知道**，别编细节、别假装查过。',
  '要求：一句话，不超过 20 个字，口语，不要表情符号，不要 markdown。',
].join('\n');

/**
 * 有后台任务时追加的规则。**必须给事实才追加** —— 没事实时提「后台任务」反而
 * 会诱导它编一个。
 */
const TASK_RULE = [
  '',
  '【这一轮额外给了你一条「后台任务」事实】',
  '- 用户问进度（好了吗/查到了吗/还在跑吗/怎么样了/还要多久），**不要委派**，',
  '  直接用那条事实说一句：在跑就说还在跑，别报结果；',
  '- 事实说没有在跑的，就别编「正在查」，也别编「刚查到」；',
  '- 不要复述整条事实，用口语说一句。',
].join('\n');

/**
 * `FAST_LANE_DELEGATE=0` 时的同义规则：**不提委派**。
 *
 * 那版提示词里根本没有「交给别人」这个选项，还提一句「不要委派」等于把不存在的
 * 分支重新摆到模型面前 —— 它会开始琢磨要不要委派，然后写出 `[[DELEGATE]]` 被判成正文念出来。
 */
const TASK_RULE_PLAIN = [
  '',
  '【这一轮额外给了你一条「后台任务」事实】',
  '- 用户问进度（好了吗/查到了吗/还在跑吗/怎么样了/还要多久），**直接照那条事实说一句**：',
  '  在跑就说还在跑，别报结果；',
  '- 事实说没有在跑的，就别编「正在查」，也别编「刚查到」；',
  '- 不要复述整条事实，用口语说一句。',
].join('\n');

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
 * 「这句值得长期记住」的本地判据 —— 只用来**提议**，不写。
 *
 * 记忆是 L2 的单一职责（`MEMORY.md` 只有 `remember` 工具能追加）。L1 在这里只做
 * 「这句话像长期事实」的粗筛，把**用户原话**原样带去给 L2，由它决定写不写。
 * 这样提议不可能被模型改写成一句错误的事实，也不需要多一次模型调用。
 */
const MEMORY_PROPOSALS: readonly RegExp[] = [
  /^我(叫|姓|住|在|是)/,
  /记住/,
  /别忘了/,
  /我(最)?(喜欢|讨厌|不吃|爱吃)/,
  /我的.{0,8}是/,
];

/** 问句不是事实，绝不能拿去提议（实测「我姓什么来着」被 `^我姓` 误抓过） */
const QUESTION_SHAPE = /[?？]|什么|哪|吗|呢|来着|多少|怎么|谁/;

/** 像不像值得提议长期记住的一句话（太长的不算：那是叙述，不是事实） */
export function looksMemorable(text: string): boolean {
  const t = text.trim();
  if (t === '' || t.length > 30) {
    return false;
  }
  if (QUESTION_SHAPE.test(t)) {
    return false;
  }
  return MEMORY_PROPOSALS.some((re) => re.test(t));
}

/** 短回话的形状：dsh 在等确认时，这类句子必须交给它，不能当闲聊答掉 */
const CONFIRM_WORDS: readonly string[] = [
  '好的', '好呀', '好啊', '好', '行', '可以', '对', '是', '嗯', '要', '不',
  '确认', '取消', '继续', '没错', '算了', '不用', '不要', '谢谢',
];

/** 这句像不像在回应上一句问话 */
export function looksLikeAnswer(text: string): boolean {
  const t = text.trim().replace(/[。！!，,、？?…\s]/g, '');
  if (t === '' || t.length > 8) return false;
  return CONFIRM_WORDS.some((w) => t.includes(w));
}

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

/**
 * 承接句的记号：只说「怎么讲」，不说讲什么。
 *
 * 纯机械，不做语义推断（和 `looksLikeAnswer` / `looksUnfinished` 同一条原则）。
 */
const FOLLOW_UP_CUES: readonly string[] = [
  '讲讲', '说说', '讲一下', '说一下', '展开', '详细', '具体', '梗概', '大概',
  '然后呢', '后来呢', '接着', '还有呢', '为什么', '怎么说',
];

/**
 * 这句像不像在**接着上一轮追问**（没有主语，全靠上文）。
 *
 * 为什么要它：上一轮由 dsh 答完、用户紧接着说「你讲讲梗概。」——只有 6 个字，
 * 过得了快车道的字数闸，于是被送去 omni 直出。而 omni 那边只听过音频、
 * 不知道 dsh 答了什么，只能**编**（真机 `20261123-053719` 第 5 轮：10.40 s
 * 「人类在宇宙里发现一本神秘的书」）。这类句子必须留在**知道上文的那条路**上。
 *
 * 只认「短 + 有承接记号 + 没带专名」：带了《》「」或者超过 12 个字就是新问题，
 * 不敢拦 —— 拦错了是把能用 omni 的轮次白白扔给 dsh。
 */
export function looksLikeFollowUp(text: string): boolean {
  const t = text.trim();
  if (t === '' || t.length > 12) return false;
  if (/[《》「」『』"]/.test(t)) return false;
  return FOLLOW_UP_CUES.some((w) => t.includes(w));
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

/**
 * 中间结果最少几个字才值得投机。**默认 6**。
 *
 * 2026-11-18 试过降到 2（`42ac09e`），想在「2–5 字短句」上把 agent 藏进 ① 里。
 * **真机向量 14 场回放测下来不成立**：`agent.ask(kind=spec)` 从 11 次涨到 27 次，
 * 端到端 p50 1047 → 1048（没动），同句配对的差还在噪声里 —— 花 2.5 倍请求买不到中位。
 * 账见 `docs/OPS-RECORD.md` §12.8。所以退回 6；要再试就改 `FAST_LANE_SPEC_MIN_CHARS`，
 * 不用改代码。
 */
const SPEC_MIN_CHARS = 6;

/**
 * 投机文本至少要覆盖定稿的多大比例。
 *
 * **只用于「越改越长时要不要沿用」**（`speculatePartial`），不再参与认领 ——
 * 认领已经收紧成「去标点后完全一致」，见 `acceptsSpeculation`。
 *
 * 0.6 这个值来自真机 47 轮：0.5 会认下「改成」→「改成641室。」（模型只会追问改成几号）。
 */
const SPEC_MIN_COVERAGE = 0.6;

/**
 * 中间结果尾部常挂着「，」「？」这种标点（ASR 边解码边补），比对前去掉。
 *
 * **`？` 和 `！` 必须一起去掉**（2026-11-19 抓到）：真机档案里那句
 * `'台词的经典是台词是什么？'`，定稿是 `'台词的经典是台词是什么来着？'` ——
 * ASR 在定稿时把「来着」补进去了，于是带问号的投机**不是前缀**、被白白作废；
 * 去掉尾标点后它覆盖 79%、完全该认。真机 6 场里这一句 6/6 都栽在这上面。
 *
 * 去标点不会引入误认：认领仍要求「去标点后的投机是定稿的前缀 + 覆盖 ≥60% +
 * 数字尾没被截断」，而认领时喂给模型的是**定稿文本**（见 `prefetch`）。
 */
function stripPartialTail(text: string): string {
  return text.replace(/[\s，,。.、；;：:？?！!…～~]+$/u, '');
}

/**
 * **比对专用**的归一化：去掉全部标点和空白。
 *
 * 只用 `stripPartialTail` 不够（2026-11-19 核对出来）：ASR 的流式 partial 通常
 * **不带句中逗号**，而定稿带 —— `对呀那你知道蓝母吗` 对 `对呀，那你知道蓝母吗？`
 * 文字完全相同，却因为一个逗号认不了。脚本 `scripts/partial-timeline.py` 一直是
 * 按「去全部标点」算的，两边必须用同一把尺，否则线上的命中会比统计少。
 *
 * 去全部标点不引入误认：认领时喂给模型的是**定稿文本**（见 `prefetch`），
 * 标点差异只影响「认不认」，不影响「问了什么」。
 */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s，,。.、；;：:？?！!…～~“”"'‘’（）()《》〈〉【】\[\]{}—－·/\\|]+/gu, '');
}

/**
 * 定稿是否确认这份投机文本 —— **这条路唯一的闸门**，错了就会答非所问。
 *
 * **只认「去标点后完全一致」**（2026-11-19 收紧，原来是「前缀 + 覆盖 ≥60%」）。
 *
 * 为什么收：逐轮 dump 出来，被 60% 门槛放过的那一半，缺的正是**宾语** ——
 * `080409` 轮 4 认下「对呀，那你知道」（定稿「对呀，那你知道蓝母吗？」）、
 * 轮 5 认下「你给我详细介绍一下」（定稿「…佛拉尼斯。」）。模型只能反问，
 * 用户听到的是「答非所问」，而档案里 `tts.first` 一切正常 —— 只有 `agent.spec`
 * 的 `missing` 字段能查出来。
 *
 * 收益几乎不损失（`scripts/partial-timeline.py` 三场 52 轮）：
 *
 * | 门槛 | 达标 | 提前量中位 | p90 |
 * |---|---|---|---|
 * | 前缀 + 覆盖 ≥60% | 34/52 | 32 ms | 587–879 |
 * | 去标点后完全一致 | 52/52 | **16 ms** | 19–313 |
 *
 * 还有 8 轮（52 轮里）partial 在定稿前 **300–423 ms** 就已经完全一致，
 * 是 `asr.sentence` 在等静音确认 —— 那一档收益照拿，且零风险。
 */
export function acceptsSpeculation(spec: string, final: string, minChars = SPEC_MIN_CHARS): boolean {
  const s = normalizeForCompare(spec);
  const f = normalizeForCompare(final);
  if (s.length < minChars) return false;
  return s === f;
}

interface FastAnswer {
  readonly text: string;
  readonly firstTokenMs: number;
  readonly delegated: boolean;
  /** 有没有已经推给 TTS（推过就不能再退回 dsh，否则重播） */
  readonly opened: boolean;
}

interface StreamHooks {
  readonly onFirstToken: () => void;
  readonly emit: (text: string) => void;
}

/** 读 SSE 流：判定暗号、按需早退、过了判定就逐字推给 TTS。 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  now: () => number,
  hooks: StreamHooks,
  allowDelegate = true,
): Promise<FastAnswer> {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  /** 开闸之前攒着的那点字（要看够两个字符才敢判断是不是暗号） */
  let held = '';
  let opened = false;
  let firstTokenMs = 0;

  const finish = (delegated: boolean): FastAnswer => ({ text, firstTokenMs, delegated, opened });

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        return finish(allowDelegate && text.trim().startsWith(DELEGATE));
      }
      let parsed: { choices?: Array<{ delta?: { content?: string } }> };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        continue;
      }
      const piece = parsed.choices?.[0]?.delta?.content;
      if (typeof piece !== 'string' || piece === '') {
        continue;
      }
      if (firstTokenMs === 0) {
        firstTokenMs = now() - startedAt;
        hooks.onFirstToken();
      }
      text += piece;
      if (opened) {
        hooks.emit(piece);
        continue;
      }
      held += piece;
      const head = held.trimStart();
      if (allowDelegate && head.startsWith('[[')) {
        return finish(true);
      }
      // 模型偶尔会先写情绪标签再写暗号（`[平静][[DELEGATE]]`）—— 标签一出现闸门就开，
      // 暗号会被当正文念出去。去掉开头的标签再看一眼。
      const withoutTag = head.replace(/^\[[^[\]]{1,4}\]\s*/, '');
      if (withoutTag !== head) {
        if (allowDelegate && withoutTag.startsWith('[[')) {
          return finish(true);
        }
        if (withoutTag === '') {
          continue; // 只有标签，还不知道后面是什么，再等一个字
        }
        opened = true;
        hooks.emit(held);
        held = '';
        continue;
      }
      // 单个 `[` 还没闭合时看不出是标签还是暗号，再等几个字
      if (head.startsWith('[') && !head.includes(']') && head.length < 6) {
        continue;
      }
      opened = true;
      hooks.emit(held);
      held = '';
    }
  }
  return finish(text.trim().startsWith(DELEGATE));
}

/** dsh 增量此刻该去哪：正常直通、进缓冲（等判定）、还是丢掉（快车道已胜出） */
type InnerMode = 'pass' | 'buffer' | 'drop';

export class FrontedAgent implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly totalMs: number;
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
  private readonly hedge: number;
  private readonly cancelMode: 'rpc' | 'interrupt' | 'off';
  private readonly statusFacts: (() => string) | undefined;
  private readonly memory: ((userText: string) => readonly string[]) | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
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
   * 判停之前先问出去的那一轮（见 {@link prefetch}）。
   *
   * `buffered` 是已经吐出来、还没人接的字：预跑时 TTS 的接收方还没建立
   * （这一轮还没开），字先攒着；`reply()` 认领时先补推再接着实时接。
   *
   * **必须是同一个对象**：`ask()` 的回调闭包捕获的是创建时的那个 slot，认领时如果
   * 换成一份拷贝（`{ ...slot }`），`listener` 就只装在拷贝上，闭包里的原对象永远是
   * `null` —— 于是认领之后的增量继续往 `buffered` 里堆，没人再取，TTS 拿到空文本，
   * 每一轮都退回整段合成（实测白付 300–500 ms）。
   */
  private prefetched: {
    /** 认领时拿来比对的文本：投机起跑时是**中间结果**，被定稿确认后改写成定稿 */
    text: string;
    /** 这一趟是用中间结果起的（还没被定稿确认） */
    speculative: boolean;
    readonly startedAt: number;
    readonly answer: Promise<FastAnswer>;
    readonly buffered: string[];
    /**
     * 这一趟的结局。`fail` 在认领时是**能读到的**：
     *
     * 预跑可能在轮次真正开跑之前就已经失败（先例：2026-11-22 17:30 那轮，
     * 「Hmm.」的预跑 1200 ms 首字超时死在 12.6 s，轮次 13.9 s 才开）。
     * 以前这时 `takePrefetch` 照样报 `ok: true` —— 仪表上说「命中」，实际认到的是
     * 一份死结果。**行为保持不变**（那条路径顺带救回了半截答案，见 `reply()` 的
     * `emitted !== ''` 分支），只把真相记下来。
     */
    state: 'pending' | 'ok' | 'fail';
    abort: { abort(why: Error): void } | null;
    listener: ((text: string) => void) | null;
  } | null = null;
  /**
   * 对话窗口：两条通道（快车道自己答的 + dsh 答的）都在这里，按时间顺序。
   *
   * 为什么自己攒而不是问 dsh：语音链路里多一次查询就是多一轮往返；而这些话
   * 本来就流经这里，顺手记下来是零成本。窗口是按角色发的真 messages，
   * 不是塞在系统提示词里的字符串 —— 这样前缀是「只往后长」的，缓存命中率高。
   */
  private readonly history: Array<{ who: 'user' | 'you' | 'dsh'; text: string }> = [];
  /** 上一轮 dsh 说了什么、是不是在问话（从窗口里取，不另存） */
  private get lastDsh(): { speech: string; asked: boolean } | null {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const turn = this.history[i];
      if (turn !== undefined && turn.who === 'dsh') {
        return { speech: turn.text, asked: awaitsReply(turn.text) };
      }
    }
    return null;
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
   * 一次快车道请求的取消句柄。**对冲时是一组**：`abort()` 掐掉全部候选。
   *
   * 不能只存「第 0 份」的 controller —— 对冲是谁先拿回响应头谁赢，实测第 1 份赢的
   * 概率约一半（10 轮 5:5）。存第 0 份的话，胜者是第 1 份时插话取消打在已经作废的
   * 那个上，胜者该吐还吐（探针实测又吐了 1921 字节），预跑「作废」同样掐不住。
   */
  private askAbort: { abort(why: Error): void } | null = null;

  /**
   * 此刻**在途**的快车道 HTTP 请求数（对冲的每一份单独算）。
   *
   * 为什么要有它：`ask()` 的 1200 ms 首字超时是从**进门**开始计时的，而请求真正
   * 发出去之前可能要在一张共享的连接池里排队（`installHttpAgent` 的 `connections: 16`，
   * 快车道/对冲/投机/dsh 全走同一条全局 dispatcher）。排队时间和厂商务时间算在同一段里，
   * 于是一条 200 ms 就该回来的请求也能被判成「首字超时」。
   *
   * 只有失败时把当时的在途数记进错误文本，才能区分「我们把自己堵住了」和「厂商慢」。
   * 这个数在失败那一刻正好是**别人**在途的数 —— 本组的已经全部落地了。
   */
  private inFlight = 0;

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
    this.model = options.model ?? 'deepseek-chat';
    this.baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    this.timeoutMs = options.timeoutMs ?? 1_200;
    this.totalMs = options.totalMs ?? 2_800;
    this.maxChars = options.maxChars ?? 14;
    this.keepTurns = options.keepTurns ?? 4;
    this.pendingCap = Math.max(8, this.keepTurns > 0 ? this.keepTurns * 4 : 16);
    this.windowChars = Math.max(200, options.windowChars ?? WINDOW_CHARS);
    this.specMinChars = Math.max(1, options.specMinChars ?? SPEC_MIN_CHARS);
    this.speculate = options.speculate ?? true;
    this.delegateEnabled = options.delegateEnabled ?? true;
    this.prefetchEnabled = options.prefetch ?? true;
    this.partialSpeculate = options.partialSpeculate ?? true;
    this.hedge = Math.max(1, options.hedge ?? 1);
    this.cancelMode = options.cancelMode ?? 'rpc';
    this.statusFacts = options.taskStatus;
    this.memory = options.memory;
    this.fetchImpl = options.fetchImpl;
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

  /** 挂/摘音频直出车道（omni）。见 `FastLaneAudioLane` */
  attachAudioLane(lane: FastLaneAudioLane | null): void {
    this.audioLane = lane;
    // 探针：连接建立时打一行 —— 有它才说明车道真的挂到了这个实例上
    this.log(`  车道    attachAudioLane(${lane === null ? 'null' : 'omni'})`);
  }

  /**
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
    const last = this.history[this.history.length - 1];
    const lastLane: Lane | null = last === undefined
      ? null
      : last.who === 'dsh'
        ? 'dsh'
        : last.who === 'you'
          ? 'live'
          : 'cascade';
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
   */
  noteServedTurn(userText: string, said: string): void {
    const speech = said.trim();
    // 一个字都没出声就不记：否则窗口里会出现「用户问了、你答了空」
    if (speech === '') {
      return;
    }
    this.recordSaid(userText, speech);
    this.auditSink(EVENTS.agentDone, {
      path: 'omni',
      len: [...speech].length,
      text: speech,
    });
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
    if (!this.prefetchEnabled) return this.prefetched !== null;
    if (this.laneWouldServe(text)) {
      // omni 会直出这一轮：快车道这趟结果**必然作废**（真机 `20261123-051448`
      // 第 6/7 轮在 serve=full 下还各发了 2 份 qwen-flash 对冲，跑完直接丢）。
      this.log('  快车道    预跑跳过：这一轮会由 omni 直出');
      return false;
    }
    if (this.prefetched?.text === text) return true;
    // 投机起跑的那一趟对上了定稿：**认它**。它已经跑了几百毫秒，从头再问等于
    // 把投机白送的时间还回去。文本改写成定稿，后面 `takePrefetch` 按一字不差认领。
    const prev = this.prefetched;
    if (prev !== null && prev.speculative && acceptsSpeculation(prev.text, text, this.specMinChars)) {
      this.speculateStarts = 0;
      // 投机缺掉的那截尾巴必须落档：认领门槛只要求前缀 + 覆盖 ≥60%，
      // 缺的常常是宾语（「那你知道」← 「那你知道蓝母吗？」）。不记下来，
      // 「模型为什么反问」就永远查不到（见 `EVENTS.agentSpec`）。
      const specCore = stripPartialTail(prev.text);
      this.auditSink(EVENTS.agentSpec, {
        ok: true,
        spec: prev.text,
        final: text,
        spec_chars: specCore.length,
        final_chars: text.length,
        coverage: Number(
          (normalizeForCompare(prev.text).length
            / Math.max(1, normalizeForCompare(text).length)).toFixed(3),
        ),
        missing: text.slice(specCore.length),
        ran_for_ms: Math.round(this.now() - prev.startedAt),
      });
      this.log(
        `  快车道    投机被定稿确认（${JSON.stringify(prev.text)} → ${JSON.stringify(text)}，`
        + `已跑 ${(this.now() - prev.startedAt).toFixed(0)} ms）`,
      );
      prev.text = text;
      // 定稿之后这一趟就是「预跑」了：再来更长的文本（判停并段）走原来的重问路径，
      // 不能再用这段确认逻辑把它当成「还是同一句」
      prev.speculative = false;
      return true;
    }
    this.speculateStarts = 0;
    if (!this.isPrefetchable(text)) return false;
    this.startPrefetch(text, false);
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
    const prev = this.prefetched;
    if (prev !== null) {
      // 定稿后才起的那一趟文本是确定的，别用猜测顶掉它（它已经比投机更准，不必再投）
      if (!prev.speculative) return true;
      if (prev.text === text) return true;
      // **已经在跑的那趟覆盖得够多 → 沿用，既不重发也不消耗配额。**
      // 真机 `20261119-080409` 轮 11：投机提前 **1370 ms** 发出，ASR 又补了一版等于定稿的
      // partial，被判成「判停并了段」重起 —— 开轮时站在起跑线上的那趟只跑了 **2 ms**。
      if (!text.startsWith(prev.text) || text.length <= prev.text.length) {
        // 被改写 / 变短：ASR 在纠错，早期那版大概率对不上定稿 —— 收掉，下一版可以重来
        this.dropPrefetch(
          `中间结果被改写（${JSON.stringify(prev.text)} → ${JSON.stringify(text)}）`,
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
    if (this.speculateStarts >= 2) return prev !== null && prev.speculative;
    if (!this.isPrefetchable(text)) {
      if (trace) this.log(`  快车道    投机跳过：不是快车道候选 ${JSON.stringify(text)}`);
      return false;
    }
    this.speculateStarts += 1;
    this.startPrefetch(text, true);
    return true;
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

  private startPrefetch(text: string, speculative: boolean): void {
    // 并段走的是**这一条**：新一句（更长的累积文本）到来时把旧的顶掉。
    // 所以日志要写清是哪种情况，别让「判停并了段」那句永远打不出来。
    const prev = this.prefetched;
    this.dropPrefetch(
      prev !== null && text.startsWith(prev.text)
        ? `判停并了段，改用 ${JSON.stringify(text)} 重新起跑`
        : '换一句',
    );
    const slot = {
      text,
      speculative,
      startedAt: this.now(),
      answer: null as unknown as Promise<FastAnswer>,
      buffered: [] as string[],
      state: 'pending' as 'pending' | 'ok' | 'fail',
      abort: null as { abort(why: Error): void } | null,
      listener: null as ((chunk: string) => void) | null,
    };
    slot.answer = this.ask(text, slot.startedAt, (chunk) => {
      if (slot.listener !== null) {
        slot.listener(chunk);
        return;
      }
      slot.buffered.push(chunk);
    }, speculative ? 'spec' : 'prefetch');
    // 预跑出来的 promise 可能永远没人认领（插话/并段）：接住，别让它变成进程级 rejection
    slot.answer.catch(() => undefined);
    // 同一份 promise 上再挂一个：只为记下结局，供认领时判断这是不是一份死结果
    slot.answer.then(
      () => { slot.state = 'ok'; },
      () => { slot.state = 'fail'; },
    );
    // `ask()` 在第一个 await 之前同步设好了控制器，这里取到的就是这一趟的
    const controller = this.askAbort;
    // **同一个对象**，不能 `{ ...slot }`：`ask()` 的闭包捕获的是 `slot`，
    // 换成拷贝会让后面的增量认不出 listener（见字段注释）
    slot.abort = controller;
    this.prefetched = slot;
    this.log(
      `${speculative ? '  快车道    中间结果先问出去' : '  快车道    判停前先问出去'} ${JSON.stringify(text)}`,
    );
  }

  /**
   * 认领预跑：文本一字不差、且这一轮确实会走快车道才给，其余一律作废。
   *
   * 第二条（`usable`）不是优化，是**止损**：宿主的判据与这里不同源时，
   * 预跑会在「根本不会走快车道」的轮次上白花一次调用。
   */
  private takePrefetch(
    userText: string,
    usable: boolean,
  ): { answer: Promise<FastAnswer>; attach: (sink: (text: string) => void) => void } | null {
    const slot = this.prefetched;
    if (slot === null) return null;
    this.prefetched = null;
    if (!usable) {
      this.abortPrefetch(slot.abort);
      this.log(`  快车道    这一轮不走快车道，预跑作废（${JSON.stringify(slot.text)}）`);
      this.auditSink(EVENTS.agentClaim, { ok: false, why: 'unusable', text: slot.text });
      return null;
    }
    if (slot.text !== userText) {
      this.abortPrefetch(slot.abort);
      this.log(
        `  快车道    文本对不上，预跑作废（${JSON.stringify(slot.text)} → ${JSON.stringify(userText)}）`,
      );
      this.auditSink(EVENTS.agentClaim, {
        ok: false, why: 'text-mismatch', text: slot.text, want: userText,
      });
      return null;
    }
    const ranFor = this.now() - slot.startedAt;
    const produced = slot.buffered.length;
    if (slot.state === 'fail') {
      if (produced === 0) {
        // 开轮时这份预跑早就死了，而且**一个字都没产出** —— 没东西可救。
        //
        // **别把它当命中交出去**：`await` 一个已经 reject 的 promise 会立刻抛，
        // 于是这一轮**跳过「现场重跑」**直接掉 dsh。2026-11-22 17:30 那轮就是这么来的：
        // 预跑 1201 ms 首字超时死在 12.6 s，轮次 13.9 s 才开，认领后一路交给 dsh，
        // 1.2 s 的偶发波动被放大成 18.5 s。
        this.log(
          `  快车道    预跑已失败且无产出（跑了 ${ranFor.toFixed(0)} ms）→ 现场重新问一次`,
        );
        this.auditSink(EVENTS.agentClaim, {
          ok: false, why: 'failed', taken: false, produced, text: slot.text,
          ran_for_ms: Math.round(ranFor),
        });
        return null;
      }
      // 已经产出过字：**保持原行为**。`attach` 会把那几段先补推出去，随后的 reject
      // 让 `reply()` 走「已播出一部分，按现有文本收下」—— 这半截答案是白捡的，
      // 重问一次反而把它丢掉。
      this.log(
        `  快车道    认领到一份**已经失败**的预跑（跑了 ${ranFor.toFixed(0)} ms，`
        + `已产出 ${produced} 段）→ 按现有文本收下`,
      );
      this.auditSink(EVENTS.agentClaim, {
        ok: false, why: 'failed-partial', taken: true, produced, text: slot.text,
        ran_for_ms: Math.round(ranFor),
      });
    } else {
      this.log(`  快车道    认领预跑（已经跑了 ${ranFor.toFixed(0)} ms）`);
      this.auditSink(EVENTS.agentClaim, { ok: true, text: slot.text, ran_for_ms: Math.round(ranFor) });
    }
    return {
      answer: slot.answer,
      attach: (sink) => {
        // 先把预跑期间攒下的字补推出去，再切成实时 —— 顺序反了会乱序
        for (const chunk of slot.buffered) sink(chunk);
        slot.buffered.length = 0;
        slot.listener = sink;
      },
    };
  }

  private dropPrefetch(why: string): void {
    const slot = this.prefetched;
    if (slot === null) return;
    this.prefetched = null;
    this.abortPrefetch(slot.abort);
    this.log(`  快车道    预跑作废（${why}）`);
    this.auditSink(EVENTS.agentDrop, { why, text: slot.text, speculative: slot.speculative });
  }

  private abortPrefetch(handle: { abort(why: Error): void } | null): void {
    // **无条件掐**：`handle` 是那一趟 `ask()` 自己的 `abortAll`（`startPrefetch` 在
    // `ask()` 之后同步取的），它只会 abort 那一组 controller，碰不到别的轮次。
    //
    // 原来这里有一道 `this.askAbort === handle` 的守卫，注释说「已经被别的 ask()
    // 顶替过就别动它，会掐掉正在服务的那一轮」—— **反了**：被顶替之后 `handle`
    // 恰恰是那份没人要的旧请求，正是该掐的对象；而正在服务的那一轮有自己的 handle，
    // 动不了。那道守卫的实际后果是：**任何被顶掉的预跑都再也取消不掉**，
    // 只能自己跑满（最长 `totalMs` 2.8 s），白占一条连接、白花 token。
    if (handle !== null) {
      handle.abort(new Error('预跑作废'));
    }
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
    // 新一轮：投机的次数配额按轮算（上一轮用完不能让下一轮一直没法投机）
    this.speculateStarts = 0;
    this.turnStartedAt = this.now();
    this.currentGen = ticket.gen;
    this.currentTicket = ticket;
    this.innerMode = 'pass';
    const hasFacts = this.statusFacts !== undefined;
    // 这几条判据原来各自 `return delegate(...)`，预跑就**留在原地没人管**：
    // 白花一次模型调用，还可能被后面同文本的一轮认领到陈旧结果。
    // 所以先把「这一轮会不会走快车道」算完，再一次性认领/作废。
    const askedAnswer = this.lastDsh?.asked === true && looksLikeAnswer(userText);
    const memorable = looksMemorable(userText);
    // 问进度的句子即使含任务字也放进来 —— 事实能照实答，比让 dsh 重跑一轮快得多
    const candidate = this.apiKey !== ''
      && image === undefined
      && (isFastCandidate(userText, this.maxChars)
        || (hasFacts && isStatusQuestion(userText)));
    const overCap = this.keepTurns > 0 && this.pending.length / 2 >= this.keepTurns;
    // 判停之前就已经问出去的那一轮：**文本一字不差**才认领，见 `prefetch()`
    const pre = this.takePrefetch(
      userText,
      !askedAnswer && !memorable && candidate && !overCap,
    );
    // dsh 上一条在问话，用户这句是短回话（好的/对/不用）—— 那是**对话里的回应**，
    // 不是闲聊。放给快模型就是「确认指令被抢答」，业务状态机直接断链。
    if (askedAnswer) {
      this.log('  快车道    上一轮 dsh 在等回话，这句直接交给 dsh');
      return await this.delegate(userText, image, note, ticket, 'answer');
    }
    // 像「长期事实」的一句话：**必须让 dsh 亲耳听到**。
    // 实测 dsh 只对「用户自己说的」话写记忆 —— 把它塞进系统注记里转述（试过 5 种措辞，
    // 包括在 profile 里明确授权），一次都不写。所以这里的「提议」就是**把话交过去**，
    // 让 L2 用自己的判断决定记不记；L1 不替它写、也不替它猜。
    if (memorable) {
      this.log('  快车道    像长期事实，交给 dsh 自己判断要不要记');
      return await this.delegate(userText, image, note, ticket, 'memory');
    }
    if (!candidate) {
      return await this.delegate(userText, image, note, ticket, 'task');
    }
    if (overCap) {
      this.log('  快车道    攒满上限，这一轮强制交给 dsh（顺便刷上下文）');
      return await this.delegate(userText, image, note, ticket, 'overcap');
    }
    // omni 直出：它**从封段就起跑了**，这里只是认领（首块通常还没到）。
    // 判据与 `isPrefetchable` 共用 `textEligible` —— 一处放松就会「文本路预跑过、
    // omni 也答了」，同一个问题付两次钱。
    if (this.audioLane !== null && image === undefined
      && this.audioLane.willServe() === true && this.textEligible(userText)) {
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
        answer = await this.ask(userText, startedAt, push, 'live');
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
    this.recordSaid(userText, speech);
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
   */
  private recordSaid(userText: string, speech: string): void {
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
    this.askAbort?.abort(new Error('插话取消'));
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
    this.rememberDsh(answer.speech, userText);
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
        this.rememberDsh(answer.speech, userText);
      }
      return { ...answer, path: 'dsh', delegate: reason };
    } finally {
      this.delegating = false;
    }
  }

  /** 记下 dsh 最后说的话（快模型下一轮要看：它在问什么、答案是什么） */
  private rememberDsh(speech: string, userText: string): void {
    // dsh 真的答完、而且这一轮被采用了 → 随它送进去的那批闲聊轮次**确认送达**。
    // 这是唯一清空 `sentPending` 的地方（被取消的轮次不算，见 `cancelInner`）。
    this.sentPending.length = 0;
    // dsh 那一轮的用户话术也进窗口 —— 否则窗口里会出现「没有提问的回答」
    if (this.history.at(-1)?.who !== 'user' || this.history.at(-1)?.text !== userText.trim()) {
      this.push('user', userText);
    }
    this.push('dsh', speech);
    this.trim();
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

  private async ask(
    userText: string,
    startedAt: number,
    emit: (text: string) => void,
    kind: 'prefetch' | 'spec' | 'live' = 'live',
  ): Promise<FastAnswer> {
    const doFetch = this.fetchImpl ?? fetch;
    // **对冲**：同一句并发发 N 份，谁先**把响应头拿回来**谁赢，其余立刻 abort。
    // 为什么按响应头判：实测「响应头 → 首 token」只差 ~1 ms，方差全在等响应头那一段
    // （130–430 ms，见 `FAST_LANE_TRACE`），所以抢响应头就等于抢首字。
    // 落败的请求在拿到响应头前就被掐掉，基本不产生生成费用。
    const controllers = Array.from({ length: Math.max(1, this.hedge) }, () => new AbortController());
    const abortAll = (why: Error): void => {
      for (const c of controllers) c.abort(why);
    };
    // 取消句柄是**整组**：插话时把还在跑的候选一起掐掉（见 `askAbort` 的注释）
    const handle = { abort: abortAll };
    this.askAbort = handle;
    // **两段超时**：首字之前卡住 = 模型不干活，早点让给 dsh；
    // 首字之后还在出字 = 正常，给足时间 —— 用一个固定总超时会把
    // 「五百多毫秒才说完」的正常答案一起掐掉（实测 10 条闲聊里 6 条被掐）。
    let timer: NodeJS.Timeout = setTimeout(() => {
      abortAll(new Error(`首字超时 ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    // 不 unref：`finally` 里一定会 clearTimeout，unref 省不了什么；
    // 反而让「等这个定时器」变成不保活的事件循环 —— Node 22 的 test runner 会判定
    // 「promise 永远悬着」（本地 Node 24 不复现，服务器上整片超时测试全挂）。
    const rearm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        abortAll(new Error(`整句超时 ${this.totalMs} ms`));
      }, this.totalMs);
    };
    const msgs = this.messages(userText);
    const payload = JSON.stringify({
      model: this.model,
      stream: true,
      temperature: 0.8,
      max_tokens: 64,
      messages: msgs,
    });
    // 全量落档：**发出去的那一刻**就记，而不是等到有答案 —— 预跑/投机被作废时，
    // 「问过什么」才是判断模型行为的起点。`msgs` 含 system + 历史窗 + 当前这句。
    this.auditSink(EVENTS.agentAsk, {
      kind, model: this.model, hedge: controllers.length, text: userText, msgs,
    });
    try {
      // 每一份的结局都要留痕：失败时 `Promise.any` 只给一个笼统的 reject，
      // 「两份都打满 1200 ms」和「一份 429 + 一份被掐」在日志里长得一样，
      // 但前者是厂商/网络、后者是我们自己的问题。结局最后拼进错误文本，
      // 由调用方的 `agent.done { ok:false, err }` 落进档案（不截断）。
      const outcomes: string[] = [];
      // 进门那一刻已经有多少份在跑 —— 这是「池子被我们自己堵住」的直接读数
      const inFlightBefore = this.inFlight;
      const racers = controllers.map((c, index) => {
        this.inFlight += 1;
        return doFetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: payload,
          signal: c.signal,
        }).then(
          (r) => {
            this.inFlight -= 1;
            outcomes[index] = `#${index} 头@${(this.now() - startedAt).toFixed(0)}ms`
              + (r.ok ? '' : ` HTTP ${r.status}`);
            if (!r.ok || r.body === null) throw new Error(`HTTP ${r.status}`);
            return { r, c };
          },
          (e) => {
            this.inFlight -= 1;
            outcomes[index] = `#${index} ✗${(e as Error).name === 'AbortError'
              ? `aborted@${(this.now() - startedAt).toFixed(0)}ms`
              : String((e as Error).message).slice(0, 60)}`;
            throw e;
          },
        );
      });
      // 落败/被打断的那些也要有人接：否则 abort 会变成进程级 rejection（线上挂过）
      for (const p of racers) p.catch(() => undefined);
      let winner: { r: Response; c: AbortController };
      try {
        // `any` 取的是第一个**成功**的（HTTP 错的那份算失败，会自动等另一份）
        winner = await Promise.any(racers);
      } catch {
        throw new Error(
          `HTTP 全部失败（${racers.length} 份）: ${outcomes.join(' | ') || '无结局'}`
          + `（进队前在途 ${inFlightBefore} 份，此刻 ${this.inFlight} 份）`,
        );
      }
      for (const c of controllers) {
        if (c !== winner.c) c.abort(new Error('对冲落败'));
      }
      // 探针（`FAST_LANE_TRACE=1`）：把首字拆成「收发头」与「收头→首 token」。
      // 生产里首字 314–588 而裸探针只要 185–260，差的那截到底是网络、还是我们自己的
      // 事件循环（ffmpeg/TTS/档案都在同一条线程上），只有这个分解能说清。
      if (process.env['FAST_LANE_TRACE'] === '1') {
        const chars = msgs.reduce((n, m) => n + m.content.length, 0);
        this.log(`  快车道    提示词 ${msgs.length} 条 / ${chars} 字`);
        this.log(`  快车道    响应头 ${(this.now() - startedAt).toFixed(0)} ms`
          + `（对冲 ${racers.length} 份，进队前在途 ${inFlightBefore}）`);
      }
      const answer = await readStream(
        winner.r.body!, startedAt, this.now, { onFirstToken: rearm, emit }, this.delegateEnabled,
      );
      // `raw` 是模型原文（可能带 `[平静]` 情绪标签、也可能被 [[DELEGATE]] 早退），
      // `opened` 表示有没有已经推给 TTS —— 两者决定这份答案「能撤回还是已经出口」。
      this.auditSink(EVENTS.agentDone, {
        kind, ok: true, ms: Math.round(this.now() - startedAt),
        first_token_ms: Math.round(answer.firstTokenMs),
        raw: answer.text, opened: answer.opened, delegated: answer.delegated,
      });
      return answer;
    } catch (error) {
      const message = (error as Error).message;
      this.auditSink(EVENTS.agentDone, {
        kind, ok: false, ms: Math.round(this.now() - startedAt),
        err: message,
      });
      // **复用一条已被对端关掉的连接**会以这些错误出现，和「模型超时/429」完全不同：
      // 它说明 `MIAI_HTTP_KEEPALIVE_MS` 设得比服务端的空闲超时还长（见 `http-agent.ts`）。
      // 不单列出来，这类失败会被当成普通网络抖动，调那个数就没有依据。
      if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed/i.test(message)) {
        this.auditSink(EVENTS.agentConn, { kind, err: message.slice(0, 100) });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      abortAll(new Error('请求结束'));
      // 只清自己那一个：两轮重叠时别把下一轮的那组从记录里抹掉
      if (this.askAbort === handle) {
        this.askAbort = null;
      }
    }
  }
}
