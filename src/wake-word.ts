/**
 * 唤醒词过滤。
 *
 * 唤醒词烧在设备固件里改不了，但它产生的**事件**我们能接住。
 * ASR 会把「小爱同学。」本身也识别成一个完整句子，Smart Turn 对它给 0.957
 * —— 那确实是一句完整的话，模型治不了，只能靠这条领域规则。
 *
 * 词表来自**设备能力**的 `ignorePhrases`（`src/devices/`）：v1 基线是空表，一条都不过滤。
 * 不属于「理解」范畴，所以留在本地做定量匹配，不交给 agent 判断。
 */

const PUNCTUATION = /[\s。.,，!！?？、~～]/g;

/**
 * 该句是否只是唤醒词（不算一轮对话）。
 *
 * @param text - ASR 出的一句
 * @param words - 该设备的固件唤醒词；空表表示不过滤
 */
export function isWakeWordOnly(text: string, words: readonly string[]): boolean {
  if (words.length === 0) {
    return false;
  }
  const bare = text.replace(PUNCTUATION, '');
  return words.some((word) => word.replace(PUNCTUATION, '') === bare);
}
