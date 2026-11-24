/**
 * 「被打断的那半句」。
 *
 * <h2>为什么需要</h2>
 *
 * 插话会把正在念的那一轮作废（`dialog-fsm.ts` 的代次 +1），音频立刻停 —— 这是对的。
 * 但停下来之后，**没念出口的那部分就没了**：真机上紧接着的一句是「你刚刚想说什么？」，
 * 而模型手上只有一条"被中断的回复"，它并不知道自己被打断在哪。
 *
 * 这里只做一件机械的事：**按已播时长把文本切出剩下没念的那段**，交给下一轮当上下文。
 *
 * <h2>为什么要按秒数估算</h2>
 *
 * TTS 是流式的，`synthesize()` 只吐 PCM，不告诉我们"念到第几个字"。
 * 所以只能用一个标定的速率反推。实测本部署（MiMo 冰糖，正常语速）：
 * 「现在凌晨一点十六分。」10 字 / 2.08 s ≈ 4.8 字每秒；
 * 「三条依次跑完……每条四十五秒。」26 字 / 5.12 s ≈ 5.1 字每秒。
 * 取 4.8，并**故意往回退几个字**：宁可从半个词重来，也不要从半句中间切开。
 */

/** 标定值：正常语速下每秒念几个字（见文件头实测）。 */
export const TTS_CHARS_PER_SEC = 4.8;

/** 回退量：避免从半个词中间开始。 */
const REWIND_CHARS = 3;

/** 往回找标点的最大距离：能从上一小句接上更好。 */
const CLAUSE_LOOKBACK_CHARS = 14;

/** 可以当作「这一小句说完了」的断点。 */
const CLAUSE_BREAK = /[。！？；，、：]/u;

/** 交给模型时最多带这么多字（防止把整篇长回答塞进下一轮 prompt）。 */
const MAX_NOTE_CHARS = 150;

/** 去掉首尾标点后是否还剩「有内容的东西」。 */
function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * 一段话念到 `playedSeconds` 时，**还没念出口**的部分。
 *
 * @returns 空串表示已经念完了（或者本来就没内容）
 */
export function remainingSpeech(
  text: string,
  playedSeconds: number,
  charsPerSec: number = TTS_CHARS_PER_SEC,
): string {
  const chars = [...text];
  if (chars.length === 0) return '';

  const played = Math.min(
    chars.length,
    Math.max(0, Math.round(playedSeconds * charsPerSec)),
  );
  if (played >= chars.length) return '';

  // 优先从最近的标点之后开始：宁可从上一小句重来，也别从「三点来说」的
  // 第三个字接着念 —— 速率是标定值，正好切在字中间是常态。
  let start = Math.max(0, played - REWIND_CHARS);
  const lookBack = Math.max(0, played - CLAUSE_LOOKBACK_CHARS);
  for (let i = played - 1; i >= lookBack; i -= 1) {
    if (CLAUSE_BREAK.test(chars[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  const rest = chars.slice(start).join('').trim();
  return hasContent(rest) ? rest : '';
}

/**
 * 给下一轮模型看的一句注记。
 *
 * 措辞要点（真机 05:40:51 的教训）：
 *
 * 用户问「你说好了吗？」，模型回**「说完了，就这些。」** —— 它其实还剩 54 字没念，
 * 却答"说完了"。原因是这段话把出口写得太窄：只认「你刚才想说什么」，
 * 别的一律"当没这回事"。
 *
 * 所以这里要写死三件事：
 * 1. **事实**：你确实被打断了，这些话用户没听到（不是"你说完了"）；
 * 2. **别自相矛盾**：上下文里你已经有一条「你: <全文>」（`pending` 记的是**生成**
 *    出来的全文，见 `fronted-agent.ts` 的 `live()` 注释），而这里说"没说完"。
 *    两句都在，模型就会在两套说法之间乱猜 —— 所以把"写完了但只念了一半"讲明。
 * 3. **别撒谎**：问你说完没有，要如实说没说完，并接着把这段讲掉。
 */
export function interruptionNote(remaining: string): string {
  const rest = [...remaining].slice(0, MAX_NOTE_CHARS).join('');
  return '上一轮你被打断：**全文你已经写出来了，但只念到中途，下面这一段他真的没听到**'
    + `：「${rest}」。`
    + '所以：如果他问你"说完了吗""好了吗"，如实说没说完，然后把这段接着讲掉；'
    + '如果他要你继续说，就接着说；如果他换了话题，就正常回答新话题，别主动翻旧账。';
}

/**
 * 后台汇报被打断时的注记。
 *
 * 和 {@link interruptionNote} 是两回事：那段话**不是模型自己说的**，是它派出去
 * 的活结算回来的结论。所以不能写成「你被打断了」，而要写清「你只念了一半、
 * 哥没听到」，并把「要不要补」交给它判断 —— 它知道哥刚才问的是什么，
 * 系统不知道。系统硬补播会在哥已经聊到别处时插一句无关的旧结论。
 */
export function announceInterruptionNote(remaining: string): string {
  const rest = [...remaining].slice(0, MAX_NOTE_CHARS).join('');
  return `刚才那条后台汇报你只念了一半就被哥打断，**剩下这段他真的没听到**：「${rest}」。`
    + '要不要接着补你自己判断：他问「刚才说什么」「结果呢」就接着说；'
    + '他已经在问别的事，就别翻旧账；你觉得这结论重要、一句话能说完，就直接补上。';
}
