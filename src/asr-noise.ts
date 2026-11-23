/**
 * ASR「幽灵文本」：**一个汉字都没有**的转写，一律当噪声丢掉。
 *
 * <h2>为什么需要</h2>
 *
 * 这台设备的实名场景是中文对话，ASR 只可能吐中文。可它在**静音/尾音/底噪**上
 * 会稳定幻觉出英文短句。2026-11-23 那场（14 轮）里，`Thank` 一个中间结果就
 * 触发了两次插话：
 *
 * ```text
 * 91351  asr.partial "Thank" → 插话「Thank」→ 代次 2
 *        这一轮 omni 的垫话只念了 0.64 s（共 1.28 s）就被 audio.stop 掐掉，
 *        随后 dsh 的答案一个字都没合成
 * 260134  asr.partial "Thank" → 插话「Thank」→ 代次 5
 *        答案首块刚发出 30 ms，6.72 s 音频被 audio.stop 全清掉
 *        用户听感 = 「说一半就没了」
 * ```
 *
 * 八份真机档案里，**不含汉字的转写 100% 是幽灵**（`Thank you` / `Yeah` /
 * `Okay` / `Oh` / `These` / 日文 `エピ` / 西里尔 `ж` / `die`），没有一条是
 * 用户真的说了外语；其中三条还作为**定稿**开了轮（「Okay。」白烧一次 agent）。
 *
 * <h2>为什么不是黑名单</h2>
 *
 * 黑名单只能挡住见过的词，而幻觉词表是随机的。判据换成**语种**就一次挡住整类：
 * 中文场景下「无汉字」本身就是异常信号。代价是用户真用外语说话时不响应 ——
 * 但这台设备上从未发生过（8/8 档案），而每次误触发的代价是丢一整条回答。
 *
 * <h2>什么样的「无汉字」仍要放行</h2>
 *
 * 纯数字（电话号码、年份、门牌号）。用户说完「记一下我的号码」接着只报一串数字
 * 是真实输入，不是幻觉。判据取 ≥4 位数字，`2024` 这种年份也在内。
 */
const CJK_IDEOGRAPH = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const DIGIT = /\d/g;
/** 纯数字串至少这么多位才算真实输入（年份 4 位起） */
const MIN_DIGITS = 4;

/**
 * 这段转写是不是 ASR 噪声。
 *
 * 只做语种判断，不看内容 —— 不做任何语义推断，与 `backchannel.ts` 同类。
 */
export function isAsrNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') {
    return true;
  }
  if (CJK_IDEOGRAPH.test(trimmed)) {
    return false;
  }
  return (trimmed.match(DIGIT)?.length ?? 0) < MIN_DIGITS;
}
