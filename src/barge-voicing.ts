/**
 * 插话的**声学**判据：这段转写底下有没有「上一次句子之后新发出的声音」。
 *
 * <h2>为什么需要</h2>
 *
 * 服务端把**同一截缓冲**再解一遍时，会在尾静音上吐短句（`Thank` / `Thank you`），
 * 而 `partial` 只要 ≥2 个字就算插话 —— 于是它把正在播的回答整条掐掉。
 * 真机 2026-11-23 08:24 那场两次：
 *
 * ```text
 * 90787  asr.sentence "你帮我讲讲罗马的历史。"     ← 这一段的定稿已经出了
 * 91351  asr.partial  "Thank"   ← 同一截缓冲的重复解码，却算插话
 *        垫话 1.28 s 只播到 0.64 s，随后 dsh 的答案一个字都没合成
 * 259672 asr.sentence "哲学思辨。"
 * 260134 asr.partial  "Thank"   ← 答案首块刚发出 30 ms，6.72 s 音频被清空
 * ```
 *
 * <h2>判据：这一段是不是已经出过句子、之后没有新声音</h2>
 *
 * `asr.sentence` 是「这截缓冲的结论」。结论出来之后还从它身上解出字，
 * 只可能是**重复解码**；真插话一定伴随新的有声帧（用户正在说）。
 *
 * 8 份真机档案、17 次 `partial` 触发的插话，逐条压在录音上算（帧长 20 ms、
 * 门限取 meta 里那一套）：
 *
 * | | 句后有新有声 | 数量 | 例子 |
 * |:---|:---|:---|:---|
 * | 真插话 | 有 | 13/13 | `你看过` `飞向` `哈喽` `Oh` `These` `没印象`… |
 * | 尾静音幻觉 | 无 | 3/3 | `Thank`（835 / 1395 / 2725 ms） |
 *
 * 零误杀零漏放。**不要换成「距上次有声多久」**（试过：500 ms 会误杀真话 ——
 * `没印象` 是真人说的，第一版解码只是慢了 795 ms；定稿晚不等于没人说话）。
 *
 * <h2>为什么不拿它管定稿</h2>
 *
 * 定稿里有一批**合法的极短应答**（`对。` / `好。`）同样「句后无新有声」——
 * 台账里 94 条真实定稿中这类有 5 条，拦掉就等于听不见用户的确认。
 * 所以这条只管插话；幽灵定稿（`Okay.` 白开一轮）仍未处理，见
 * `QWEN-REALTIME-ASR-PROBED.md` §7.3。
 */

/**
 * 上一次句子之后有没有新的有声帧。
 *
 * @param lastVoicedAt 最近一次有声帧的时刻（`UtteranceAssembler.lastVoicedAtMs`，
 *   与句子时刻同一把 `clock`）
 * @param lastSentenceAt 最近一次 ASR 定稿的时刻
 * @returns `false` = 这段已经出过结论、之后没人说话 —— 重复解码，别让它打断播放
 */
export function voicedSinceLastSentence(lastVoicedAt: number, lastSentenceAt: number): boolean {
  // 没有音频证据（`-Infinity`，模拟器 / 还没接过上行）就别拦：按「没声音」处理
  // 等于把插话功能整个关掉。保守方向是放行（错了只是插一次话）。
  if (!Number.isFinite(lastVoicedAt) || !Number.isFinite(lastSentenceAt)) {
    return true;
  }
  return lastVoicedAt > lastSentenceAt;
}
