/**
 * 执行一轮完整对话：agent → TTS → 下发 → 等播放结束。
 *
 * <h2>职责边界</h2>
 *
 * 只管「一轮怎么跑完」，不关心：
 * - 音频从哪来（见 {@link EnergyGate}）
 * - 文本怎么攒出来（见 {@link UtteranceAssembler}）
 * - 现在能不能开新一轮（见 {@link DialogFsm}）
 *
 * 依赖全部注入，自身不 import 任何具体供应商实现
 * （`synthesize` 是函数，不是 TTS 客户端）。
 */
import { DialogFsm } from './dialog-fsm.ts';
import type { Clock } from './app/clock.ts';
import { EVENTS } from './events.ts';
import type { DownlinkSink } from './transport.ts';
import { pcm16DurationMs, pcm16Gain } from './pcm.ts';
import { remainingSpeech } from './interrupted-tail.ts';
import { SentencePump } from './sentence-pump.ts';
import { TokenQueue } from './token-queue.ts';
import { cleanForSpeech } from './agent.ts';
import { parseEmotion } from './emotion.ts';
import type { AgentProvider, TtsProvider } from './providers.ts';
import type { ImageAttachment } from './session.ts';

/**
 * 等播放结束时的轮询间隔。
 *
 * 播放进度只能靠时间估（PCM 时长 + 余量），所以要隔一会儿看一眼「是不是被打断了」。
 * 100 ms 是「用户感觉不到延迟」和「不空转 CPU」的折中。
 */
const PLAYBACK_POLL_MS = 100;

export interface TurnRunnerOptions {
  /** 时钟端口：一轮里的所有等待与计时都走它（模拟器要用虚拟时间） */
  readonly clock: Clock;
  readonly agent: AgentProvider;
  /** TTS provider：采样率与合成都在里面，宿主不再各配一份 */
  readonly tts: TtsProvider;
  readonly downlink: DownlinkSink;
  readonly fsm: DialogFsm;
  /** 预估播放时长之外再多等的余量 */
  readonly playbackTailMs: number;
  /**
   * 下行语音增益（线性倍数，默认 1）。MiMo 输出偏小，实机听感要开到接近满格，
   * 所以默认放大一档；压峰用软限幅（见 `pcm.ts` 的 `pcm16Gain`）。
   */
  readonly ttsGain?: number;
  /** 每块下行音频（AEC 分析落盘用） */
  readonly onDownlinkChunk?: (chunk: Buffer) => void;
  /**
   * 时间线事件（进会话档案）。
   *
   * `tts.first` 与 `turn.end` 是延迟复算必需的仪表：缺了它们，「用户说完 → 听到第一个字」
   * 只散在 console 里，改动之后没法比快慢（见 `latency-report.ts`）。
   */
  readonly onEvent?: (name: string, fields?: Record<string, unknown>) => void;
  /** 一轮结束（落盘用），无论成功失败都会调用 */
  readonly onTurnFinished: () => void;
  /**
   * 挂/摘「流式增量」的钩子。
   *
   * 传进来一个回调就表示这一轮开始收 token（`null` 表示这一轮结束、摘掉）。
   * 有它才能「首句一生成就开腔」，没有就退回整段合成。
   */
  readonly onLiveAvailable?: (sink: ((text: string) => void) | null) => void;
  readonly log: (line: string) => void;
}

/** 一轮的执行结果，供调用方决定是否收尾 */
export interface TurnResult {
  /** 是否被用户插话中断 */
  readonly interrupted: boolean;
  /**
   * **实际送去念的全文**，从这一轮第一个字算起（被打断时用来算"还剩哪段没说完"）。
   *
   * 不一定等于 `reply.speech`：模型多步（先说一句、调工具、再说一句）时，流式这条路
   * 每一步的话都会念，而 `reply.speech` 只是最后一步。拿最后一步去对已播时长，
   * 切出来的"没说完"会是错的段落。
   */
  readonly speech: string;
  /** 下发的字节数 */
  readonly audioBytes: number;
  /** 整段音频时长（秒） */
  readonly audioSeconds: number;
  /**
   * **用户实际听到的**时长（秒）。
   *
   * 不等于 `audioSeconds`：回答是先整段合成再等的，用户插话那会儿音频早就
   * 全发出去了 —— 所以只能按"首块发出去之后过了多久"算。
   */
  readonly playedSeconds: number;
  /** TTS 首块耗时（毫秒），-1 表示没拿到音频 */
  readonly firstChunkLatencyMs: number;
  /** agent 耗时（毫秒） */
  readonly agentLatencyMs: number;
}

export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly log: (line: string) => void;
  /** 旁白与本轮回答共用一条下行音频，必须串行，否则两段 PCM 会交织在一起 */
  private speechChain: Promise<void> = Promise.resolve();
  /**
   * 正在念的那条旁白。
   *
   * 记 `sentBytes` 和 `firstChunkAt` 是为了**被打断之后还能接着说**：语音没法暂停
   * 再继续，只能按已播时长把剩下的文字重新合成一遍。不记的话，用户「嗯」一声就
   * 把整条信息弄丢了 —— 后台任务的结论、高清照的引导语都属于「只说一次就没了」。
   */
  private canned: {
    text: string;
    emotion?: string;
    sentBytes: number;
    /** 首块音频下发的时刻；`-1` = 还没出过声 */
    firstChunkAt: number;
    cancelled: boolean;
  } | null = null;
  /** 被打断的旁白还没念完的那一段，等下一轮结束再补播。一次性。 */
  private cannedResidue: { text: string; emotion?: string } | null = null;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.log = options.log;
  }

  /** 等 ms：走 Clock，虚拟时钟下就是推进虚拟时间。 */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.options.clock.after(ms, resolve);
    });
  }

  /**
   * 播一句**系统旁白**（不是模型的回答）。
   *
   * 高清照要等用户按下快门，这几十秒里没有「一轮」可挂 —— 但总得有人告诉他去按。
   * 所以旁白**不改状态机**，只借同一条 TTS 通道说话；它和本轮回答通过
   * {@link speechChain} 串行，两段音频不会撞在一起。
   */
  speakCanned(text: string, emotion?: string): Promise<void> {
    // 新的一条旁白：上一条的残留作废（它已经被这条取代了，再补播就是重复）
    this.cannedResidue = null;
    const current = { text, emotion, sentBytes: 0, firstChunkAt: -1, cancelled: false };
    this.canned = current;
    const run = async (): Promise<void> => {
      const startedAt = this.options.clock.now();
      let firstChunkAtMs = -1;
      for await (const chunk of this.options.tts.synthesize(text, emotion)) {
        if (current.cancelled) {
          this.log('  旁白    被打断，停止下发');
          return;
        }
        if (firstChunkAtMs < 0) {
          firstChunkAtMs = this.options.clock.now() - startedAt;
          current.firstChunkAt = this.options.clock.now();
        }
        current.sentBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }
      const seconds = pcm16DurationMs(current.sentBytes, this.options.tts.sampleRate) / 1000;
      this.log(
        `  旁白    ${JSON.stringify(text)} ${current.sentBytes} B / ${seconds.toFixed(2)} s`
        + `（首块 ${firstChunkAtMs < 0 ? '—' : `${firstChunkAtMs}ms`}）`,
      );
      // 每 100 ms 看一眼有没有被取消：用户说完「算了」不该还要等这段音频"播完"
      const until = this.options.clock.now() + seconds * 1000 + this.options.playbackTailMs;
      while (this.options.clock.now() < until && !current.cancelled) {
        await this.wait(PLAYBACK_POLL_MS);
      }
    };
    const next = this.speechChain.then(run, run);
    this.speechChain = next.catch(() => undefined);
    return next;
  }

  /**
   * 用户改主意：旁白不必播完，后面排队的那一轮也不必等它。
   *
   * **没念完的部分不丢**：按「用户实际可能听到的时长」切出剩下的文字放进
   * {@link cannedResidue}，由对话层决定补播还是作废（双击掐播就是作废）。
   *
   * 已播时长取两个估计的**较小值**：下发出去的音频长度（合成慢时它更小）
   * 和从首块到现在过了多久（播放快不起来，也就是它更小的情况）。只取前者会
   * 严重高估 —— TTS 一次性把整段吐出来时，字节数等于全长，剩余部分就成了空串。
   */
  cancelCanned(): void {
    const current = this.canned;
    if (current === null || current.cancelled) {
      return;
    }
    current.cancelled = true;
    const sentMs = pcm16DurationMs(current.sentBytes, this.options.tts.sampleRate);
    const elapsedMs = current.firstChunkAt < 0
      ? 0
      : this.options.clock.now() - current.firstChunkAt;
    const heardMs = Math.min(sentMs, elapsedMs);
    const rest = remainingSpeech(current.text, heardMs / 1000);
    if (rest !== '') {
      this.cannedResidue = {
        text: rest,
        ...(current.emotion === undefined ? {} : { emotion: current.emotion }),
      };
    }
  }

  /** 取走被打断旁白的剩余部分（一次性）。`null` = 没有剩余或已经念完。 */
  takeCannedResidue(): { readonly text: string; readonly emotion?: string } | null {
    const residue = this.cannedResidue;
    this.cannedResidue = null;
    return residue;
  }

  /**
   * 跑一轮。
   *
   * 返回时 `fsm` 已推进到下一状态；调用方据 `fsm.state` 决定是否挂断。
   */
  async run(text: string, image?: ImageAttachment, note?: string): Promise<TurnResult | null> {
    const { fsm, agent, downlink } = this.options;
    const ticket = fsm.beginTurn();
    if (!ticket) {
      return null;
    }

    // **上游取消的唯一入口**：插话与连接结束都从 `DialogFsm.onInvalidate` 发出来。
    // 带着票据说清楚要取消哪一轮 —— 迟到的取消由 session 层按代次丢弃。
    const offInvalidate = fsm.onInvalidate((reason) => {
      this.log(`  取消    ${reason === 'bargeIn' ? '插话' : '连接结束'} → 取消在途请求（第 ${ticket.no} 轮）`);
      try {
        agent.cancelTurn?.(ticket);
      } catch (error) {
        this.log(`  取消    ✗ ${(error as Error).message}`);
      }
    });

    let interrupted = false;
    let audioBytes = 0;
    let firstChunkAtMs = 0;
    let agentLatencyMs = 0;
    let speech = '';

    try {
      const agentStartedAt = this.options.clock.now();
      let firstSynthAt = 0;
      let firstAudioAtMs = -1;
      const emit = (chunk: Buffer): void => {
        if (firstChunkAtMs === 0) {
          firstChunkAtMs = firstSynthAt === 0 ? 0 : this.options.clock.now() - firstSynthAt;
          firstAudioAtMs = this.options.clock.now();
          fsm.audioStarted(ticket);
          this.log(`  TTS首块 ${(firstChunkAtMs / 1000).toFixed(2)} s`);
          this.options.onEvent?.(EVENTS.ttsFirst, { ms: firstChunkAtMs });
        }
        audioBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      };

      // 优先走「边生成边合成」：文本一到就 continue-task，首包与生成重叠。
      // 没有流式通道时才退回 SentencePump（按句切，等价于整段）。
      const streamTts = this.options.tts.synthesizeStream?.bind(this.options.tts);
      const queue = streamTts === undefined || this.options.onLiveAvailable === undefined
        ? null
        : new TokenQueue();
      const pump = queue === null
        ? new SentencePump({
            synthesize: (sentence, emotion) => this.options.tts.synthesize(sentence, emotion),
            clean: cleanForSpeech,
            resolveEmotion: (raw) => parseEmotion(raw).emotion,
            gate: this.speechChain,
            isStale: () => fsm.isStale(ticket),
            log: (line) => { this.log(line); },
            onFirstSentence: () => { firstSynthAt = this.options.clock.now(); },
            onChunk: emit,
          })
        : null;

      let streaming: Promise<void> | null = null;
      /** 流式这条路收到的全部增量（未清洗）。多步时包含每一步的话，见 `TurnResult.speech` */
      let streamedRaw = '';
      if (queue !== null && streamTts !== undefined) {
        this.log('  流式    分支=stream（边生成边合成）');
        this.options.onLiveAvailable?.((delta) => {
          streamedRaw += delta;
          // `tts_first_ms` 的起点是「有文本可送」，不是任务开跑：run-task 在本轮一开始
          // 就发了，从那儿算会把模型生成整段记到 TTS 头上（实测 3614 = dsh 2970 + 644），
          // 和整段合成那条路的口径（送文本 → 首块）就比不了了。
          if (firstSynthAt === 0) firstSynthAt = this.options.clock.now();
          queue.push(delta);
        });
        streaming = (async () => {
          await this.speechChain;
          // 情绪标签在开头，但流式任务开跑时 reply 还没回来 —— 这里只能先按默认语气；
          // 实测这一路是 calm（见 bench 日志 情绪=calm），暂不为了个别情绪牺牲首包。
          for await (const chunk of streamTts(queue, undefined)) {
            if (fsm.isStale(ticket)) return;
            emit(chunk);
          }
        })();
        // 先挂一个空的 catch：`agent.reply` 抛错时下面的 `await streaming` 走不到，
        // 而这条流多半也会跟着失败（没文本 → 服务端拒空任务）。没人接的 rejection
        // 在 Node 里是进程级错误，一轮失败会变成整个 harness 退出。
        // 这只是标记「有人管」，下面 `await streaming` 照样能拿到错误去走兜底。
        streaming.catch(() => undefined);
      } else {
        this.log('  流式    分支=pump（逐句/整段）');
        this.options.onLiveAvailable?.((delta) => { pump?.push(delta); });
      }

      let reply;
      try {
        reply = await agent.reply(text, image, note, { ticket });
      } finally {
        this.options.onLiveAvailable?.(null);
        queue?.close();
      }
      agentLatencyMs = this.options.clock.now() - agentStartedAt;
      if (reply.firstTokenMs !== undefined) {
        // 模型开口的时刻。和 TTS 首块分开记，才看得出"等生成"占了多少
        this.options.onEvent?.(EVENTS.llmFirst, { ms: reply.firstTokenMs });
      }
      speech = reply.speech;
      this.log(
        `  agent   ${(agentLatencyMs / 1000).toFixed(2)} s  `
        + JSON.stringify(reply.text.slice(0, 120)),
      );

      // 补齐没念的部分（没走流式时这一句就是整段合成），并等所有分片落地
      if (streaming !== null) {
        try {
          await streaming;
          // 流式成功：念出去的是**全部增量**，不只是最后一步。用它做 `speech`，
          // 打断续话才对得上已播时长。按全部增量算而不是按「已送批」算：被打断时
          // 没来得及送的那截也是"没说完"的一部分，漏了它续话会少一段。
          const spoken = cleanForSpeech(parseEmotion(streamedRaw).rest);
          if (spoken !== '' && spoken !== speech) {
            this.log(
              `  流式    实际念了 ${[...spoken].length} 字`
              + `（最后一步只有 ${[...speech].length} 字）`,
            );
            speech = spoken;
          }
        } catch (error) {
          // 流式这条路挂了（最常见：这条路一个字都没收到，服务端会拒空文本）。
          // 退回整段合成，宁可慢也不能哑。
          this.log(`  流式    ✗ ${(error as Error).message}，退回整段合成`);
          // 兜底这次才是真正的「送文本」时刻，口径同整段合成
          firstSynthAt = this.options.clock.now();
          for await (const chunk of this.options.tts.synthesize(reply.speech, reply.emotion)) {
            if (fsm.isStale(ticket)) break;
            emit(chunk);
          }
        }
      } else {
        await pump?.drain(reply.speech);
      }

      interrupted = interrupted || fsm.isStale(ticket);
      const audioSeconds = pcm16DurationMs(audioBytes, this.options.tts.sampleRate) / 1000;
      this.log(
        `  回放    ${audioBytes} 字节  ${audioSeconds.toFixed(2)} s`
        + (interrupted ? '（被中断）' : ''),
      );

      this.log(
        `TURN n=${ticket.no} text_len=${text.length} dsh_ms=${agentLatencyMs}`
        + ` tts_first_ms=${firstChunkAtMs === 0 ? -1 : firstChunkAtMs}`
        + ` audio_s=${audioSeconds.toFixed(2)}`
        + (interrupted ? ' barge_in=1' : ''),
      );

      // 状态机在整个等待期间保持 speaking；插话会让票据作废从而提前结束等待。
      if (!interrupted) {
        const until = this.options.clock.now() + audioSeconds * 1000 + this.options.playbackTailMs;
        while (!fsm.isStale(ticket) && this.options.clock.now() < until) {
          await this.wait(PLAYBACK_POLL_MS);
        }
        interrupted = fsm.isStale(ticket);
      }

      // 用户听到的时长按「首块发出之后过了多久」算，不按字节算：
      // 回答是整段先合成完再等的，插话那会儿音频早就全发出去了。
      const heardSeconds = firstAudioAtMs < 0
        ? 0
        : Math.min(audioSeconds, (this.options.clock.now() - firstAudioAtMs) / 1000);

      this.options.onEvent?.(EVENTS.turnEnd, {
        interrupted,
        audio_s: Number(audioSeconds.toFixed(2)),
        heard_s: Number(heardSeconds.toFixed(2)),
        dsh_ms: agentLatencyMs,
        tts_first_ms: firstChunkAtMs === 0 ? -1 : firstChunkAtMs,
        // 记下 dsh 的会话 id，事后才能把这一段和 dsh 自己的 step/tool 轨迹对齐
        ...(this.options.agent.sessionId ? { dsh_session: this.options.agent.sessionId } : {}),
      });

      return {
        interrupted,
        speech,
        audioBytes,
        audioSeconds,
        playedSeconds: heardSeconds,
        firstChunkLatencyMs: firstChunkAtMs === 0 ? -1 : firstChunkAtMs,
        agentLatencyMs,
      };
    } catch (error) {
      // 失败也留一条：否则报告里这一轮的 ④ 会显示"缺仪表"，与"没拿到音频"混在一起
      this.options.onEvent?.(EVENTS.turnEnd, { failed: true, dsh_ms: agentLatencyMs });
      this.log(`  ✗ 本轮失败: ${(error as Error).message}`);
      return null;
    } finally {
      offInvalidate();
      fsm.audioDone(ticket);
      this.options.onTurnFinished();
    }
  }
}
