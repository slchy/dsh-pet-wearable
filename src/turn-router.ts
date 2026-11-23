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
 */
import { looksLikeAnswer, looksLikeFollowUp, looksMemorable } from './fronted-agent.ts';

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
  if (ACTION_CUES.test(text)) {
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
