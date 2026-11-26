/**
 * 这条连接的 ASR 前端：封段序号、帧静音、定稿时刻、插话闸。
 *
 * 车道的 `sealSeq` 和 ASR 的 `commitSeq` 不是同一个号。时钟接错只报一次，
 * 否则每一句都会刷一行，真故障反而看不见。
 */
import { voicingVerdict } from '../barge-voicing.ts';
import { EVENTS } from '../events.ts';
import type { CoreEffect, CoreEvent } from '../session-core.ts';

/** 识别回调要碰对话层的那几步。时刻只从连接注入的 `now` 取。 */
export interface AsrFrontPorts {
  now(): number;
  /** 装配器最近一次有声帧的时刻，必须和 {@link AsrFrontPorts.now} 同一把尺。 */
  lastVoicedAtMs(): number;
  isSpeaking(): boolean;
  generation(): number;
  dispatch(event: CoreEvent): readonly CoreEffect[];
  notePartial(text: string): void;
  userPartial(): void;
  emitAsr(text: string, final: boolean): void;
  archive(name: string, fields?: Record<string, unknown>): void;
  decodeSettled(commitSeq: number): void;
}

/**
 * 车道封段序号、前端静音、上一句定稿时刻。
 *
 * `noteFrame` 必须在 `assembler.addFrame` **之前**调用：封段是同步发生的，
 * 晚一步读到的是上一帧。
 */
export class AsrFront {
  private readonly ports: AsrFrontPorts;
  /**
   * 车道封段序号（omni 的 `seal`）。
   *
   * 和 ASR 的 `commitSeq` **不是同一个号**：车道 20 ms 就起跑，ASR 150 ms 才切段。
   * ASR 那个号不在这里：`commit` 何时真发出去只有 ASR 自己知道。
   */
  private laneSealSeq = 0;
  /**
   * 最近一帧的**前端**静音时长（`AudioFrame.silenceMs`，能量门算的）。
   *
   * 落进 `asr.commit.front_silence_ms`。封段回调的 `silence_ms` 读的是同一帧的
   * 同一个数，所以两列相等。
   */
  private frameSilenceMs = 0;
  /** 最近一次 ASR 定稿的时刻（插话闸用，见 `barge-voicing.ts`） */
  private lastSentenceAtMs = Number.NEGATIVE_INFINITY;
  /** 时钟接错只报一次，免得每句话刷一行 */
  private clockMismatchLogged = false;

  constructor(ports: AsrFrontPorts) {
    this.ports = ports;
  }

  get sealSeq(): number {
    return this.laneSealSeq;
  }

  get lastFrameSilenceMs(): number {
    return this.frameSilenceMs;
  }

  /** 记下这一帧的能量门静音。必须在 `addFrame` 之前。 */
  noteFrame(silenceMs: number): void {
    this.frameSilenceMs = silenceMs;
  }

  /** 车道封段占一个号。只在 `onCommit` 里加，空封段不经过这里。 */
  nextSealSeq(): number {
    this.laneSealSeq += 1;
    return this.laneSealSeq;
  }

  onPartial(text: string, commitSeq?: number): void {
    console.log(`  … ${text}`);
    this.ports.archive(EVENTS.asrPartial, { text });
    // 插话的**声学**闸：服务端会把同一截缓冲再解一遍，在尾静音上吐 `Thank you`，
    // 它一旦 ≥2 个字就把正在播的回答整条掐掉（真机两次各丢一整条答案）。
    // 判据不是语种、不是音量、也不是「距上次有声多久」，而是
    // **这一段定稿之后还有没有新的声音** —— 见 `barge-voicing.ts`。
    if (this.ports.isSpeaking() && this.gatedByVoicing()) {
      console.log(`  … ${text}（这段已出过定稿、之后没有新声音 → 重复解码，不算插话）`);
      return;
    }
    // **开轮前录的那一段**由内核挡（`SessionCore` → `kernel.ts::isPreTurnCommit`，
    // 全仓唯一的因果屏障）：产出它的 commit 早于开轮时刻，说明这些音频是在我们
    // 出声之前录的 —— 那不可能真是插话，是我们抢在用户说完之前开了口。
    const genBefore = this.ports.generation();
    const effects = this.ports.dispatch({
      type: 'partial',
      text,
      ...(commitSeq === undefined ? {} : { commitSeq }),
    });
    // 被内核丢掉时**什么都不许碰**：不进装配器（否则记成「用户还在说」）、
    // 不收宠物话筒、也不打断旁白 —— 它压根不是这一轮的话。
    if (effects.some((effect) => effect.type === 'drop' && effect.why === 'pre-turn')) {
      console.log(`  … ${text}（开轮前录的那段还在解 → 不算插话）`);
      return;
    }
    if (text.trim() !== '') {
      this.ports.emitAsr(text, false);
    }
    // 判停的**文本判据**：中间结果在出 = 用户还在说。只传信号不拼文本，
    // 中间结果会反复改写，拼起来是乱的。
    this.ports.notePartial(text);
    // 用户已经开口了，「嗯，我看看」这种回执就没必要了
    // 宠物要在**用户刚开口**就收手，不能等到这句话定稿
    this.ports.userPartial();
    // 代次变了 = 内核真的判了插话（`audio.stop` 由 `KernelPorts.stopDeviceAudio` 执行，
    // 这里不再另找那个效果 —— 两处各判一遍迟早漂）。
    if (this.ports.generation() !== genBefore) {
      console.log('  打断    听到识别结果 → 停止播放，已排队的轮次作废');
    }
  }

  /**
   * 这段转写是不是「同一截缓冲的重复解码」。
   *
   * 判据见 `barge-voicing.ts`。时钟接错时**报一次** —— 那一版闸会静默失效
   * （`20261123-051448` 第 4 轮被 `Okay` 打断就是这么漏的），不报等于没有仪表。
   */
  gatedByVoicing(): boolean {
    const verdict = voicingVerdict(this.ports.lastVoicedAtMs(), this.lastSentenceAtMs);
    if (verdict === 'clock-mismatch' && !this.clockMismatchLogged) {
      this.clockMismatchLogged = true;
      console.error(
        '  ✗ 插话闸   两把时钟不同源'
        + `（有声 ${this.ports.lastVoicedAtMs()} / 定稿 ${this.lastSentenceAtMs}）`
        + ' → 闸失效，检查 UtteranceAssembler 的 now',
      );
    }
    return verdict === 'silent';
  }

  onSentence(text: string, index: number, commitSeq?: number): void {
    console.log(`  句 ${index}  ${JSON.stringify(text)}`);
    // `commit_seq` 是这条定稿的出生证：档案里 `asr.sentence` 与 `asr.commit` 的配对
    // 一直靠「窗口里只有一条 commit」这个假设，一句封了两次段时 ①b 只能记 null。
    // 带上它，`latency-report.ts` 能精确配对（老档案没有这个字段，退回原判据）。
    const stamp = commitSeq === undefined ? {} : { commit_seq: commitSeq };
    this.ports.archive(EVENTS.asrSentence, { text, index, ...stamp });
    // 解码窗口结束（`.completed` 回来了）—— 这是**事实**，与「这段文本用不用」
    // 无关，所以放在所有丢弃判据之前。共享内核据此放掉 `awaitingDecode`；
    // 迟到的 `.completed` 由内核按 `commitSeq` 比较挡掉，不会抹掉更新的那一发。
    if (commitSeq !== undefined) {
      this.ports.decodeSettled(commitSeq);
    }
    // 上面那句已经出过结论、之后一直没人说话 → 这一条是同一截缓冲的重复解码。
    if (this.gatedByVoicing()) {
      console.log(`  句 ${index}  ↳ 定稿之后没有新声音 → 重复解码，丢弃`);
      return;
    }
    // **开轮前录的那一段**的判据只在内核里有一份。这里连开轮都不开 ——
    // 用户下一句会重新说到它。
    const genBefore = this.ports.generation();
    const effects = this.ports.dispatch({
      type: 'sentence',
      text,
      ...(commitSeq === undefined ? {} : { commitSeq }),
    });
    if (effects.some((effect) => effect.type === 'drop' && effect.why === 'pre-turn')) {
      console.log(`  句 ${index}  ↳ 开轮前录的那段定稿 → 不当插话，也不开轮`);
      this.ports.archive(EVENTS.asrSentence, { text, index, ...stamp, dropped: 'pre-turn' });
      return;
    }
    if (text.trim() !== '') {
      this.ports.emitAsr(text, true);
    }
    // 后面的 partial 拿它当「上一句」：这之后还有没有新的有声帧，决定那些 partial
    // 是真插话还是重复解码（见 `barge-voicing.ts`）
    this.lastSentenceAtMs = this.ports.now();
    // 打断有两处入口（中间结果 / 定稿），日志必须都打 —— 否则统计打断率会漏掉
    // 「短促插话只出定稿」那一半，真机上就是 4 次里少记 1 次。
    if (this.ports.generation() !== genBefore) {
      console.log('  打断    听到定稿 → 停止播放，已排队的轮次作废');
    }
  }
}
