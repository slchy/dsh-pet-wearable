/**
 * 路由：这一轮**先由谁答**。四层架构里的 `Router`（第 4 层），纯函数。
 *
 * 为什么必须收成一个函数：重构前有三处判据各自决定「谁答」——
 * `FrontedAgent.willServeAudio`（omni 能不能答）、`takePrefetch`（快车道认不认领）、
 * `TurnRunner` 里的 `reply.audio.delegateReason()`（模型自述要转交）。三处不同源，
 * 真机上的表现是：omni 该答的被拒、不该答的进去编了 10.4 s、qwen-flash 白跑两份。
 *
 * **最要命的一条**：omni 的准入原来是拿 qwen-flash 的判据算的
 * （`isFastCandidate` 的 14 字上限 + `apiKey !== ''` + 快车道历史深度）。
 * 后果是「把 qwen-flash 的 key 删掉，omni 也跟着不答了」，而 14 字上限本来是
 * qwen-flash 文本窗的限制——omni 吃的是整段音频，这个上限对它没有物理依据。
 *
 * 所以这里的分工是：
 * - **内核**（本文件）只判「这一轮属于哪条车道」，判据全部与引擎实现无关；
 * - **引擎**自己判「我答不答得了」（`isHealthy()` + 模型自己的 `tool_call`）。
 *   引擎说答不了 → 回来转 dsh，那是引擎的事，不是路由的事。
 *
 * <h2>依赖方向</h2>
 *
 * 这一层是**内核**，不许 import 任何引擎（`fronted-agent.ts` 曾反过来 import 本文件、
 * 本文件又 import 它 —— 循环依赖在 ESM 下能跑，但谁先初始化谁就踩 TDZ）。
 * 三个「这句话是什么形态」的判据因此住在这里（路由要用它们），由引擎原样转出。
 */

/** 先由谁答。`dsh` 不是「另一个引擎」，它是慢车道，路由可以直接指定它 */
export type Lane = 'live' | 'cascade' | 'dsh';

/**
 * 「这一轮只能交给 dsh」的动词。
 *
 * 判据刻意**只看动作，不看引擎**：这些话说出去就要有副作用（建提醒、删文件、
 * 发消息、查真实数据），而快车道两条都只是"会说"，没有工具。路由把它们直接
 * 交给 dsh，省掉的不是延迟，是**静默失败**——模型自信地答"好的，记下了"，
 * 而提醒根本没建。
 *
 * 曾经有一个等价的 `TASK_WORDS` 列表在 `isFastCandidate` 里，后来只留下字数与
 * 阿拉伯数字。字数那条对 omni 没有物理依据（它吃整段音频），阿拉伯数字那条
 * 也不该当判据（"3 点"omni 听得很清楚）；真正该留下的是这份动词表。
 */
const ACTION_CUES =
  /(记一下|记下来|提醒我|定个|订一下|预约|开个|打开|关掉|关闭|删除|删掉|清掉|发个|发一条|查一下|搜一下|查查|搜搜|读一下|念一下)/u;

/**
 * 叙述/评论里也会出现「关掉」「打开」。
 * 真机「电影里主角把门关掉那段真紧张」被 `关掉` 错派 dsh。
 * 这些记号在、且没有对助手的请求前缀时，动作表让开。
 */
const NARRATIVE_CONTEXT =
  /(电影里|小说里|书里|故事里|剧情|主角|那段|那一幕|演的)/u;

/** 对着助手下令。有它，句子里夹着「电影里 / 那段」仍是真请求 */
const ASSISTANT_REQUEST =
  /(帮我|给我|请|替我|把我|把刚才)/u;

/** 这句是不是「有副作用」的动作请求。路由与早规则竞速共用这一份动词表 */
export function isActionRequest(text: string): boolean {
  if (NARRATIVE_CONTEXT.test(text) && !ASSISTANT_REQUEST.test(text)) {
    return false;
  }
  return ACTION_CUES.test(text);
}

/**
 * 问的是此刻钟点，或今天的日期/星期。
 *
 * 不进 `routeTurn`（车道规则不变）。Omni 实测「现在几点了」编成「晚上八点半」、
 * 「今天是几月几号星期几」编成「2026年7月25日」——调用方据此在开口前派出去。
 * 「是」可有可无。陈述（「三点开会」「今天心情不错」「现在停下来想想」）不认。
 */
const CLOCK_TIME_CUES =
  /(?:现在(?:是)?几点|几点了|几点钟|现在(?:是)?什么时间|今天(?:是)?几月几号|今天(?:是)?几号|今天(?:是)?星期几|今天(?:是)?周几|今天(?:是)?礼拜几|现在(?:是)?几号)/u;

/** 这句是不是在问当前钟点，或今天的日期/星期 */
export function isClockTimeRequest(text: string): boolean {
  return CLOCK_TIME_CUES.test(text);
}

/**
 * 没有动作动词、但答案会过期、只能查外部的问句：钟点/日期、天气、行情、路况。
 * 同样不进 `routeTurn`。常识（沸点）和闲聊（心情、加班、作品）不进这里。
 */
const REALTIME_WEATHER =
  /(?:今天|明天|后天|现在|外面).{0,6}(?:天气|下雨|下雪|气温|温度|空气质量)|天气怎么样|下不下雨|会下雨吗/u;

const REALTIME_MARKET =
  /(?:股价|股票|汇率|比分|金价|油价).{0,4}(?:多少|怎么样|涨|跌)|今天.{0,6}(?:股价|汇率|比分)/u;

const REALTIME_TRAFFIC =
  /堵不堵|堵车吗|路况|开过去要多久|开车去.{1,10}(?:堵|多久)/u;

/** 这句是不是必须查实时外部信息（含钟点/日期） */
export function isRealtimeFactRequest(text: string): boolean {
  return isClockTimeRequest(text)
    || REALTIME_WEATHER.test(text)
    || REALTIME_MARKET.test(text)
    || REALTIME_TRAFFIC.test(text);
}

/**
 * 「不要了」——用户**显式下令取消**在跑的委派任务。
 *
 * 与「插话」严格分开：插话是"我先说别的"，dsh 那一轮**不取消**（活儿取消不了，
 * 取消只作废下游输出，丢的是用户唯一能听到的答案），跑完的答案回注记忆；
 * 只有这一句才是真的"别查了"。
 *
 * 判据要求整句就是那几个说法：`算了算了他算得对` 这种是正常说话，不能当中断指令。
 */
const CANCEL_CUES: ReadonlySet<string> = new Set([
  '算了', '不要了', '不用了', '别查了', '不查了', '不用查了',
  '取消', '停下', '停', '停一下', '别弄了', '不用弄了',
]);

/** 这句是不是"取消在跑的任务"。调用方还要自己确认真有活儿在跑 */
export function isCancelRequest(text: string): boolean {
  const t = text.replace(/[\s，。、！？；：,.!?;:"'“”‘’]/gu, '');
  if ([...t].length > 8) {
    return false;
  }
  const bare = t.replace(/(吧|啊|呀|嘛|呗|哈)$/u, '');
  return CANCEL_CUES.has(bare) || CANCEL_CUES.has(t);
}

// ---------------------------------------------------------------- 句子的形态
//
// 下面三条原来住在 `fronted-agent.ts`，但 `routeTurn()` 要用它们，于是两个模块
// 互相 import。搬到这里之后依赖只有一个方向：**引擎 → 内核**。
// 外部（含 `tests/fronted-agent.test.ts`）仍从 `fronted-agent.ts` 导入 —— 那边原样转出。

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
export const QUESTION_SHAPE = /[?？]|什么|哪|吗|呢|来着|多少|怎么|谁/;

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

export interface RouteContext {
  /** 音频直出车道（Live）现在能不能接活。**只报事实**：off=没开、down=断了 */
  readonly live: 'ready' | 'down' | 'off';
  /** 级联快车道能不能接活（有 key、没超历史窗口） */
  readonly cascade: boolean;
  /** dsh 上一轮末尾在等用户回话（「你要删哪条？」这种） */
  readonly dshAwaiting: boolean;
  /** 上一轮是谁答的（`null` = 还没有过一轮） */
  readonly lastLane: Lane | null;
}

export interface RouteDecision {
  readonly lane: Lane;
  /** 为什么这么判。落进 `agent.lane.why` —— 路由错了要能一眼看出是哪条规则 */
  readonly why: string;
}

/**
 * 判这一轮先由谁答。
 *
 * 顺序即优先级。前三条是**硬规则**，它们不省钱、也不图快，是为了不出错：
 *
 * 1. `dsh-awaiting`——dsh 在等一句确认/参数，短回话（「好的」「不用」）交给快车道
 *    会被当成闲聊答掉，业务链直接断。
 * 2. `memorable`——「我叫什么」「记住这个」必须由带记忆的那条路处理。
 * 3. `stick-to-dsh`——上一轮 dsh 答的、这一轮是无主语短追问（「你讲讲梗概」）。
 *    omni 只听过用户的声音，不知道 dsh 答了什么，交给它只能编
 *    （真机 `20261123-053719` 第 5 轮：10.40 s 胡话）。
 *
 * 之后才是「谁有空谁上」，而且 **Live 只看健康度**：
 * 它听得见整段音频、能自己决定要不要转交，实现上没有任何字数/形态前提。
 */
export function routeTurn(text: string, ctx: RouteContext): RouteDecision {
  if (ctx.dshAwaiting && looksLikeAnswer(text)) {
    return { lane: 'dsh', why: 'dsh-awaiting' };
  }
  if (looksMemorable(text)) {
    return { lane: 'dsh', why: 'memorable' };
  }
  if (isActionRequest(text)) {
    return { lane: 'dsh', why: 'action' };
  }
  if (ctx.lastLane === 'dsh' && looksLikeFollowUp(text)) {
    return { lane: 'dsh', why: 'stick-to-dsh' };
  }
  if (ctx.live === 'ready') {
    return { lane: 'live', why: 'live-ready' };
  }
  if (ctx.cascade) {
    return { lane: 'cascade', why: ctx.live === 'off' ? 'cascade-only' : 'live-down' };
  }
  return { lane: 'dsh', why: 'no-fast-lane' };
}
