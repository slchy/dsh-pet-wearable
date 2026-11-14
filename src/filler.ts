/**
 * 长任务期间的两件事，依据 ADR-004 §5.3（两段式响应）与 §7（并发策略）：
 *
 * ```text
 * 用户：「帮我查下明天天气」
 *   ↓ 300 ms
 * 眼镜：「好的，我查一下。」        ← 立即确认
 *   ↓ 任务完成
 * 眼镜：「明天晴，-2 到 11 度。」
 * ```
 * > **没有立即确认，用户会以为没听到而重复说。**
 *
 * 正常情况下**第一段由模型自己说**（提示词要求它派后台后立刻回一句确认，
 * 见 `agent.ts` 的【工具调用：一律派到后台】）。这里的实现是**兜底**：
 * 模型迟迟不开口时补一句，避免耳朵里一片死寂。
 *
 * 另外 {@link isStatusQuery} + {@link STATUS_REPLY} 是 §7 的「本地应答，不占 CLI」：
 * 用户在它干活时问「好了吗」，不该排队等这一轮跑完（那正是他重复问的起点）。
 */

/**
 * 状态查询的措辞。
 *
 * 保守：**整句都很短**且命中这些说法才算。宁可漏（那句话进队列，晚点答），
 * 也不要把「那件事好了吗」这种带内容的问题当成状态查询 —— 后者需要模型带上下文回答。
 *
 * 真机教训（05:40:45）：用户问的是「你**查**好了吗」——比「好了吗」多一个动词，
 * 按字面前缀匹配就漏了，于是那句话被排到这一轮之后，几分钟后才有人答。
 * 所以动词位要通配：查/搜/看/找/跑/做…
 */
const STATUS_QUERY = new RegExp(
  '^(?:你|那个|这个)?(?:'
  // 查好了吗 / 搜到了吗 / 看完了吗 / 好了吗
  + '(?:查|搜|看|找|跑|做|弄|搞|办|处理)*(?:好|完|成|到)了?吗'
  + '|好没好|还没好吗?|还没完|完了没'
  // 到哪了 / 到哪一步了
  + '|到哪(?:了|一步了)'
  + '|在忙(?:什么|啥|嘛)|在干(?:什么|啥|嘛)|你在做什么'
  + '|还要多久|要多久|得多久|多久(?:能)?好'
  + '|快了吗|怎么样了|进度'
  + ')',
);

/** 超过这个长度就不当状态查询（带内容的问句要模型答）。 */
const MAX_STATUS_QUERY_CHARS = 10;

/**
 * 是不是在问「你好了没」。
 *
 * 只在 `thinking` 期间用：那时用户问这句，想知道的是"还要多久"，不是要新任务。
 */
export function isStatusQuery(text: string): boolean {
  const compact = text.replace(/[\s。，,.!！?？~～、…]/g, '');
  if (compact.length === 0 || [...compact].length > MAX_STATUS_QUERY_CHARS) return false;
  return STATUS_QUERY.test(compact);
}

/**
 * 本地应答。
 *
 * 不说具体秒数：CLI 里跑到哪一步我们看不见，编一个"还有 20 秒"比不说更糟。
 * 只承诺「好了会说」—— 后台任务结算时 dsh 会自己开新一轮汇报（EXPERIMENTS §40.3），
 * 这个承诺是有兑现路径的。
 */
export const STATUS_REPLY = '还在跑，好了我马上说。';

/**
 * 兜底确认语，按顺序轮换。
 *
 * 第一句是「我查一下。」而不是「嗯…」：§5.3 要的是**确认收到**（告诉用户"这话我接住了"），
 * 不是填充音。之后的两句只在模型真的迟迟不开口时才用。
 * **最多说这么几句**（见 {@link fillerLine}）—— 一直唠比安静更烦人。
 */
export const FILLER_LINES: readonly string[] = [
  '我查一下。',
  '还在跑，稍等。',
];

/**
 * 第 `index` 次兜底该说什么（从 0 开始）。
 *
 * @returns 用完就返回 `null`：说满 {@link FILLER_LINES} 句就彻底安静，别再插。
 */
export function fillerLine(index: number, lines: readonly string[] = FILLER_LINES): string | null {
  if (index < 0 || index >= lines.length) return null;
  const line = lines[index];
  return line === undefined || line.trim() === '' ? null : line;
}
