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
const MAX_NOTE_CHARS = 300;

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
 * 措辞要点：**说清"没说完"而不是"说到一半"** —— 剩下的这段是用户没听到的内容，
 * 不是已经听到的开头。同时给它"可以不理"的出口，免得用户只是不想听了它还在硬接。
 */
export function interruptionNote(remaining: string): string {
  const rest = [...remaining].slice(0, MAX_NOTE_CHARS).join('');
  return `上一轮你的话被哥打断，还有这一段没说出口：「${rest}」。`
    + '他若问「你刚才想说什么」或让你继续说，就接着把这段说完；否则就当没这回事。';
}
