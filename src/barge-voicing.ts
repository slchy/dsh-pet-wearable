/**
 * 插话 / 幽灵定稿的**声学**判据：这段转写底下有没有「上一次定稿之后新发出的声音」。
 *
 * <h2>为什么需要</h2>
 *
 * 服务端把**同一截缓冲**再解一遍时，会在尾静音上吐短句（`Thank` / `Okay` / `对。`），
 * 而 `partial` 只要 ≥2 个字就算插话 —— 于是它把正在播的回答整条掐掉。
 * 真机 2026-11-23 08:24 那场两次：
 *
 * ```text
 * 90787  asr.sentence "你帮我讲讲罗马的历史。"     ← 这一段的定稿已经出了
 * 91351  asr.partial  "Thank"   ← 同一截缓冲的重复解码，却算插话
 *        垫话 1.28 s 只播到 0.64 s，随后 dsh 的答案一个字都没合成
 * 259672 asr.sentence "哲学思辨。"
 * 260134  asr.partial "Thank"   ← 答案首块刚发出 30 ms，6.72 s 音频被清空
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
 * 零误杀零漏放。定稿也过同一条（8 份档案里 `对。/好。/嗯。/啊。` 共 10 条，
 * 底下一条有声帧都没有；真说「对。」必然带新有声帧）。
 *
 * **不要换成「距上次有声多久」**（试过：500 ms 会误杀真话 —— `没印象` 是真人说的，
 * 第一版解码只是慢了 795 ms；定稿晚不等于没人说话）。
 *
 * <h2>两把时钟（真机踩过）</h2>
 *
 * 这条判据比的是两个时刻，**必须同一把尺**。第一次上线时 `UtteranceAssembler`
 * 用 `Date.now()`（≈1.76e12），`voice-session` 用 `SystemClock.now()`（进程启动后的
 * 单调毫秒，≈2e4）—— 于是 `lastVoicedAt > lastSentenceAt` 恒真，闸**一次都没生效**，
 * 而且什么日志都不留（`20261123-051448` 第 4 轮仍被 `Okay` 打断）。
 * 现在两边都取 `VoiceConnection.clock`，并留 {@link voicingVerdict} 的
 * `clock-mismatch` 分支自曝。
 */

/**
 * 两把时钟的量级差超过这个就认为接错了（≈11.6 天）。
 *
 * 合法差值最多是「上一句在几小时前」，而接错时差的是整个 epoch（1.7e12 vs 1e4）。
 */
const CLOCK_MISMATCH_MS = 1e9;

export type VoicingVerdict = 'voiced' | 'silent' | 'no-evidence' | 'clock-mismatch';

/**
 * 上一次句子之后有没有新的有声帧。
 *
 * @param lastVoicedAt 最近一次有声帧的时刻（`UtteranceAssembler.lastVoicedAtMs`）
 * @param lastSentenceAt 最近一次 ASR 定稿的时刻（**必须与上一参数同一把时钟**）
 */
export function voicingVerdict(lastVoicedAt: number, lastSentenceAt: number): VoicingVerdict {
  if (!Number.isFinite(lastVoicedAt) || !Number.isFinite(lastSentenceAt)) {
    // 没有音频证据（模拟器 / 还没接过上行）：按「没声音」处理等于把插话功能整个关掉，
    // 保守方向是放行（错了只是插一次话）。
    return 'no-evidence';
  }
  if (Math.abs(lastVoicedAt - lastSentenceAt) > CLOCK_MISMATCH_MS) {
    return 'clock-mismatch';
  }
  return lastVoicedAt > lastSentenceAt ? 'voiced' : 'silent';
}

/** `true` = 放行（有声音 / 没证据 / 时钟接错时都偏向放行）。 */
export function voicedSinceLastSentence(lastVoicedAt: number, lastSentenceAt: number): boolean {
  return voicingVerdict(lastVoicedAt, lastSentenceAt) !== 'silent';
}
