/**
 * 插话的**声学**判据：这段转写底下有没有「刚发出的有声帧」。
 *
 * <h2>为什么需要</h2>
 *
 * 服务端在**我们喂进去的静音**上会解出短句（`Thank` / `Thank you` / `Yeah` / `Okay`），
 * 而 `partial` 只要 ≥2 个字就算插话 —— 于是它把正在播的回答整条掐掉。
 * 真机 2026-11-23 08:24 那场两次：
 *
 * ```text
 * 91351  "Thank"   上行 RMS −75.6 dBFS（静音）  垫话播到 0.64/1.28 s 被掐，dsh 答案没合成
 * 260134  "Thank"   上行 RMS −71.8 dBFS         答案首块刚发出 30 ms，6.72 s 音频被清空
 * ```
 *
 * <h2>为什么不用「语种」判</h2>
 *
 * 试过「无汉字即丢」，被数据否掉，两个方向都不成立：
 *
 * - **会误杀**：英文短句、纯数字、设备名都是合法输入；
 * - **会漏放**：同样是 `Thank`，251456 那次底下是 **−24.4 dBFS 的真实语音**
 *   （用户真在说话，ASR 把第一版认成了英文），`ж` / `die` / `These` / `Oh`
 *   也都出现在 −27…−30 dBFS。静音幻觉与「真实语音被认错」是两件事，
 *   语种分不开它们，**有声/无声**才分得开。
 *
 * <h2>为什么是「距上次有声多久」而不是音量</h2>
 *
 * 音量阈值要重新标定，而 `UtteranceAssembler` 已经在按能量门算「有没有声音」
 * （`silenceDb`，与设备标定同源），`lastVoicedAt` 就是停嘴时刻。实测两侧差得很开：
 *
 * | 场景 | 距上次有声帧 |
 * |:---|:---|
 * | 真插话（`你看过` / `飞向` / `哈喽`） | 0–120 ms |
 * | 静音幻觉（91351 / 260134） | 885 ms / 2.7 s |
 *
 * 取 500 ms：真插话够不着，幻觉够得着。
 *
 * <h2>为什么不拿它管定稿</h2>
 *
 * 定稿的 gap 分不开：真实句 240–400 ms（p50 ~300），幻觉句 325/352/386 ms，
 * 完全重叠。拿它拦定稿会误杀正常句子，所以这条只管**插话**。
 */

/** 距上次有声帧超过这么久，这段转写就不算插话（实测两侧 0–120 / 885–2700） */
export const BARGE_VOICED_GAP_MS = 500;

/**
 * 这段转写底下有没有刚发出的声音。
 *
 * @param now 当前时刻（与 `lastVoicedAt` 同一把尺，毫秒）
 * @param lastVoicedAt 最近一次有声帧的时刻；`-Infinity` = 这条连接还没见过音频
 * @param maxGapMs 允许的最大间隔
 * @returns `false` = 底下一片静音，别让它打断播放
 */
export function hasVoicedEvidence(
  now: number,
  lastVoicedAt: number,
  maxGapMs: number = BARGE_VOICED_GAP_MS,
): boolean {
  // 没有音频证据就不拦：模拟器/未接上行的装配里 `lastVoicedAt` 永远是 -Infinity，
  // 按「静音」处理等于把插话功能整个关掉。保守方向是放行（错了只是插一次话）。
  if (!Number.isFinite(lastVoicedAt)) {
    return true;
  }
  return now - lastVoicedAt <= maxGapMs;
}
