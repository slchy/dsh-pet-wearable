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
import { loopLagSnapshot } from './loop-lag.ts';
import { diffNetCounters, netFields, readNetCounters } from './net-counters.ts';
import { sampleSockets } from './socket-stats.ts';
import type { DownlinkSink } from './transport.ts';
import type { TurnTicket } from './dialog-fsm.ts';
import type { DeviceCall } from './devices/primitives.ts';
import { pcm16DurationMs, pcm16Gain } from './pcm.ts';
import { remainingSpeech } from './interrupted-tail.ts';
import { SentencePump } from './sentence-pump.ts';
import { TokenQueue } from './token-queue.ts';
import { cleanForSpeech } from './agent.ts';
import { parseEmotion } from './emotion.ts';
import type { AgentProvider, DelegateReason, TtsProvider } from './providers.ts';
import type { ImageAttachment } from './session.ts';

/**
 * 等播放结束时的轮询间隔。
 *
 * 播放进度只能靠时间估（PCM 时长 + 余量），所以要隔一会儿看一眼「是不是被打断了」。
 * 100 ms 是「用户感觉不到延迟」和「不空转 CPU」的折中。
 */
const PLAYBACK_POLL_MS = 100;

/**
 * 有 `played` 能力的设备，估算时长之后最多再等这么久。
 *
 * 真机的 `played` 只当**下限**用（见 `run()` 里的注释），所以需要一个「事件永远不来」
 * 的上限；3 s 足够覆盖设备缓冲，也不会把一轮挂太久。
 */
const PLAYED_GRACE_MS = 3_000;

/**
 * omni 已经念出去这么久的**正文**才发 `tool_call`：不再把 dsh 的答案拼在后面。
 *
 * 垫话（「我看看」「行，我这就给你细说」）都在 1–2 s 内，远小于这个值；
 * 真机 2026-11-23 05:14 第 9 轮是 4.96 s 的瞎编正文后面又接了 7.44 s 的 dsh 答案 ——
 * 用户听到的是两段互不相干的回答。
 */
const OMNI_DELEGATE_MAX_SPOKEN_MS = 1_500;

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
   * 设备会上报 `played`（`caps.played`）。
   *
   * 为真时**等设备说播完**再离开 `speaking`，但估算时长是**下限**、设备回执只能延后。
   * 实测某个 v2 设备在「最后一个字节收到」就报 `played`（4.58 s 的音频 1 s 就回执了），
   * 按它收尾会让尾音还在放就已经回到 `listening` —— 那段播放里的插话就不再算插话。
   * 为假时保持老行为：按下发字节数估时长。降级方向必须是「宁可多等一会儿」。
   */
  readonly deviceReportsPlayed?: boolean;
  /** 有 `played` 的设备在估算时长之后最多再等多久（默认 {@link PLAYED_GRACE_MS}） */
  readonly playedGraceMs?: number;
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
   * 状态机在本方法里发生转移之后叫一次（`beginTurn` / `audioStarted` / `audioDone`）。
   *
   * 三次转移都发生在 `TurnRunner.run` 内部，`DialogRuntime.dispatch` 看不到它们。
   * 没有这个钩子，`onDialogState` 只知道 `listening` 一个状态，话筒永远不会被释放。
   */
  readonly onState?: () => void;
  /**
   * 给设备发一条控制指令（目前只用来 `audio.stop`）。
   *
   * 回执被正式回答顶掉时必须先清掉设备播放队列，否则「我看看」和答案会叠在一起。
   */
  readonly sendCall?: (call: DeviceCall) => void;
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
   * 设备报告「下行音频播完了」。
   *
   * 只在 `deviceReportsPlayed` 为真时有意义；由适配层收到设备 `played` 事件时调。
   * 用轮询标志而不是 promise：等待循环本来就在轮询，多一条 promise 只会多一处
   * 需要清理的悬挂引用。
   *
   * **只在有在途轮次时才算数**：线协议的 `played` 没有轮次字段，绑定发生在这里 ——
   * 上一轮迟到的回执不能拿来结束这一轮。
   */
  devicePlayed(): void {
    if (this.playingTicket === null) {
      return;
    }
    this.playedSeen = true;
  }

  /** 本轮是否已经收到设备的 `played` */
  private playedSeen = false;
  /** 正在等的这一轮（`null` = 没有在途轮次；回执要绑在它上面） */
  private playingTicket: TurnTicket | null = null;
  /** 这一轮回执（「我看看。」）。回答一出第一个字节就掐掉 */
  private receipt: { text: string; sentBytes: number; firstChunkAt: number; cancelled: boolean; ephemeral: boolean } | null = null;
  private receiptPlaying = false;
  /**
   * 回执音频缓存：文案是固定的那几句，没有理由每轮都去服务端现合成。
   *
   * 真机实测（2026-11-17，v2 设备）：回执首块 321–342 ms 全是合成时间，而回执
   * 总共只有 0.65 s 音频 —— 首块那 300 ms 等于把「开轮 → 听见声音」白白拖长，
   * 还会在答案来得快时被硬切成半句（第 6 轮 agent 890 ms 就到，回执播到 569 ms
   * 被掐，「我看看」只剩「我看」）。缓存之后首块≈0，整句在答案到达前就能播完。
   */
  private readonly receiptCache = new Map<string, { readonly rate: number; readonly chunks: readonly Buffer[] }>();
  /** 本轮是否已经下发过真正的回答音频（回执只在这是 false 时有意义） */
  private firstAudioSeen = false;

  /**
   * 播一句**系统旁白**（不是模型的回答）。
   *
   * 高清照要等用户按下快门，这几十秒里没有「一轮」可挂 —— 但总得有人告诉他去按。
   * 所以旁白**不改状态机**，只借同一条 TTS 通道说话；它和本轮回答通过
   * {@link speechChain} 串行，两段音频不会撞在一起。
   */
  speakCanned(text: string, emotion?: string, ephemeral = false): Promise<void> {
    // 新的一条旁白：上一条的残留作废（它已经被这条取代了，再补播就是重复）
    this.cannedResidue = null;
    const current = { text, emotion, sentBytes: 0, firstChunkAt: -1, cancelled: false, ephemeral };
    this.canned = current;
    const run = async (): Promise<void> => {
      const startedAt = this.options.clock.now();
      let firstChunkAtMs = -1;
      for await (const chunk of this.options.tts.synthesize(text, emotion)) {
        if (current.cancelled) {
          this.log(ephemeral ? '  回执    被正式回答顶掉，停止下发' : '  旁白    被打断，停止下发');
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
        `  ${ephemeral ? '回执' : '旁白'}    ${JSON.stringify(text)} ${current.sentBytes} B / ${seconds.toFixed(2)} s`
        + `（首块 ${firstChunkAtMs < 0 ? '—' : `${Math.round(firstChunkAtMs)}ms`}）`,
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
   * 「这一轮交给慢车道了」的回执。
   *
   * 与旁白的区别只有三点，都为了**不拖慢真正的回答**：
   * - **不排 `speechChain`**：排进去的话本轮 TTS 要等它播完才开始（`run` 里的流式分支
   *   开头就 `await this.speechChain`），等于用回执换来更晚的答案
   * - 不在残句里留底：它本来就不是「用户没听完的内容」，留底会让下一轮收到
   *   「刚才那条汇报只念了一半」的假注记
   * - 回答一来就掐断，并且先给设备发 `audio.stop` 清掉缓冲，避免两句叠在一起
   *
   * @returns 有没有真的开始说（`false` = 这一轮已经出声/已被作废，没必要回执）
   */
  speakReceipt(text: string): boolean {
    if (this.receiptPlaying || this.canned !== null || this.firstAudioSeen) {
      return false;
    }
    // 回执是真出声：状态进 `speaking`，用户这时开口才算插话（见 DialogFsm.receiptStarted）。
    // 进不去说明这一轮已经不在等答案（被插话作废 / 已收尾）—— 那就别出声了。
    if (!this.options.fsm.receiptStarted()) {
      return false;
    }
    // 立刻通知：档案要记下这段 `speaking`，话筒归属也别等下一帧才对齐
    this.options.onState?.();
    // 回执是**用户听到的第一句**，但它不属于任何 `turn.end`（不排 `speechChain`、
    // 不留残句）—— 不单独记，审计「他到底听到了什么」就少一段。
    this.options.onEvent?.(EVENTS.receipt, { text, chars: [...text].length });
    const rate = this.options.tts.sampleRate;
    const cached = this.receiptCache.get(text);
    if (cached !== undefined && cached.rate === rate) {
      // 命中：立刻整句下发，不等服务端。首块 0 ms —— 这是缓存的意义所在。
      this.log(`  回执    ${JSON.stringify(text)}（缓存）`);
      this.receiptPlaying = true;
      const current = { text, sentBytes: 0, firstChunkAt: 0, cancelled: false, ephemeral: true };
      this.receipt = current;
      for (const chunk of cached.chunks) {
        current.sentBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }
      void this.holdReceipt(current);
      return true;
    }
    this.log(`  回执    ${JSON.stringify(text)}`);
    this.receiptPlaying = true;
    const current = { text, sentBytes: 0, firstChunkAt: -1, cancelled: false, ephemeral: true };
    this.receipt = current;
    void (async () => {
      const startedAt = this.options.clock.now();
      let firstChunkAtMs = -1;
      const collected: Buffer[] = [];
      for await (const chunk of this.options.tts.synthesize(text)) {
        if (current.cancelled) {
          this.log('  回执    被正式回答顶掉，停止下发');
          return;
        }
        if (firstChunkAtMs < 0) {
          firstChunkAtMs = this.options.clock.now() - startedAt;
          current.firstChunkAt = this.options.clock.now();
        }
        collected.push(chunk);
        current.sentBytes += chunk.length;
        this.options.onDownlinkChunk?.(chunk);
        this.options.downlink.sendAudio(pcm16Gain(chunk, this.options.ttsGain ?? 1));
      }
      // 合成成功才进缓存：中途被顶掉的那次是残缺的，不能存
      if (!current.cancelled && collected.length > 0) {
        this.receiptCache.set(text, { rate, chunks: collected });
      }
      const seconds = pcm16DurationMs(current.sentBytes, rate) / 1000;
      this.log(
        `  回执    ${JSON.stringify(text)} ${current.sentBytes} B / ${seconds.toFixed(2)} s`
        + `（首块 ${firstChunkAtMs < 0 ? '—' : `${Math.round(firstChunkAtMs)}ms`}）`,
      );
      await this.holdReceipt(current);
    })();
    return true;
  }

  /** 回执下发完之后，按音频时长占住「还在说」的状态，直到播完或被顶掉。 */
  private async holdReceipt(current: { sentBytes: number; cancelled: boolean }): Promise<void> {
    const seconds = pcm16DurationMs(current.sentBytes, this.options.tts.sampleRate) / 1000;
    const until = this.options.clock.now() + seconds * 1000 + this.options.playbackTailMs;
    while (this.options.clock.now() < until && !current.cancelled) {
      await this.wait(PLAYBACK_POLL_MS);
    }
    // 回执这一段结束了：状态回到 `thinking`（答案还在路上）。
    // 被顶掉时上面已经调过一次，这里再调也是幂等的。
    this.options.fsm.receiptEnded();
    this.options.onState?.();
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
    // **一个字都没发出去**：这不是「念了一半」，是全没念。记残句的后果是下一轮收到
    // 「刚才那条后台汇报你只念了一半」的注记，模型会把用户从没听过的整条汇报
    // 塞进回答里。合成首包那 ~300 ms 里被掐，只可能是这种情况。
    if (current.sentBytes === 0) {
      return;
    }
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
    // 整机 TCP 计数器在本轮开始/结束时各读一次，增量落 `turn.end`：
    // 把「多出来的 270 ms」分成「链路丢包」和「服务端内部慢」靠它（见 `net-counters.ts`）。
    const netBefore = readNetCounters();
    const ticket = fsm.beginTurn();
    if (!ticket) {
      return null;
    }
    // 回执标志按**轮次**清零：挪到这里而不是等待环入口，是因为合成期间
    // （最后一批字节发出之前）到达的回执也得算数 —— 在入口清会把已经到的那次擦掉，
    // 之后设备不再发第二次，就只能等满上限。
    this.playedSeen = false;
    this.playingTicket = ticket;
    this.receiptPlaying = false;
    this.receipt = null;
    this.firstAudioSeen = false;

    /**
     * 「本轮已作废」的信号，用来把**已经没必要等的 await** 提前放掉。
     *
     * 为什么需要：委派轮在等 dsh 的答案时被插话，`cancelTurn` 只是软取消，
     * dsh 那边要几秒才回（真机 2026-11-23 第 5 轮 2.5 s；`235949` 回放第 6 轮 3.2 s）。
     * 这段时间 `DialogRuntime` 的串行链还卡着，**下一轮开不了**（回放里
     * `出句→开轮` 从源 187 ms 涨到 1304 ms）。答案回来也没人要了。
     */
    const STALE = Symbol('stale');
    let markStale: (() => void) | null = null;
    const staleSignal = new Promise<typeof STALE>((resolve) => {
      markStale = () => { resolve(STALE); };
    });

    // **上游取消的唯一入口**：插话与连接结束都从 `DialogFsm.onInvalidate` 发出来。
    // 带着票据说清楚要取消哪一轮 —— 迟到的取消由 session 层按代次丢弃。
    const offInvalidate = fsm.onInvalidate((reason) => {
      this.log(`  取消    ${reason === 'bargeIn' ? '插话' : '连接结束'} → 取消在途请求（第 ${ticket.no} 轮）`);
      markStale?.();
      // 回执也要停：`audio.stop` 只是清掉设备已经收到的缓冲，合成循环还在往下发，
      // 不掐掉就会在用户说话时接着播（试过：用户一开口「我看看」又从头上响一遍）。
      if (this.receipt !== null && !this.receipt.cancelled) {
        this.receipt.cancelled = true;
        this.receiptPlaying = false;
        this.log('  回执    插话中止，停止下发');
      }
      try {
        agent.cancelTurn?.(ticket);
      } catch (error) {
        this.log(`  取消    ✗ ${(error as Error).message}`);
      }
    });
    // 这三次转移（beginTurn / audioStarted / audioDone）都在本方法里发生，
    // 走不到 `DialogRuntime.dispatch`。不在这里通知，话筒就永远只看到 `listening`
    // 一个状态 —— 结束时 `release('reply')` 不会执行，宠物的 `floorFree` 一直不成立。
    this.options.onState?.();

    let interrupted = false;
    let audioBytes = 0;
    let firstChunkAtMs = 0;
    let agentLatencyMs = 0;
    let speech = '';
    /** 这一轮是谁答的（`AgentReplyView.path`），档案里要落下来 */
    let replyPath: 'fast' | 'dsh' | 'omni' | undefined;
    /** 交给 dsh 的原因（只有 `path === 'dsh'` 时有） */
    let delegateReason: DelegateReason | undefined;

    try {
      const agentStartedAt = this.options.clock.now();
      let firstSynthAt = 0;
      let firstAudioAtMs = -1;
      /** 下行采样率：omni 24 kHz 与 CosyVoice 同值，但**不能假设**，按回答走 */
      let audioRate = this.options.tts.sampleRate;
      /**
       * 首块是不是已经处理过。
       *
       * **不能拿 `firstChunkAtMs === 0` 当哨兵**：omni 直出那条 `firstSynthAt` 一直是 0，
       * 于是 `firstChunkAtMs` 永远留在 0，下面整段（`tts.first` 事件、`audioStarted`、
       * 掐回执）会**每块重跑一次** —— 真机档案里一场 14 轮冒出 338 条 `tts.first`。
       */
      let firstChunkSeen = false;
      const emit = (chunk: Buffer): void => {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          firstChunkAtMs = firstSynthAt === 0 ? 0 : this.options.clock.now() - firstSynthAt;
          firstAudioAtMs = this.options.clock.now();
          this.firstAudioSeen = true;
          // 回执还在念：先清掉设备缓冲再发这一块，否则两句会叠在一起
          if (this.receipt !== null && !this.receipt.cancelled) {
            this.receipt.cancelled = true;
            this.log('  回执    被正式回答顶掉');
            this.options.sendCall?.({ op: 'audio.stop' });
            // 回执那段 `speaking` 到此为止；紧接着 `audioStarted` 会重新进入 speaking
            fsm.receiptEnded();
          }
          fsm.audioStarted(ticket);
          this.options.onState?.();
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
      /**
       * 这一轮会不会走 omni 直出。
       *
       * 必须在**起跑流式 TTS 之前**问：那一步会真的开一个合成 task，而 omni 轮
       * 没有任何文本可送 —— 服务端会拒空文本，整轮退化成兜底（比不走 omni 还慢）。
       */
      const omniTurn = agent.willServeAudio?.(text) === true;
      // 这条只在装配坏了时出声：`trackActivity()` 之类的包装层漏转发可选能力时，
      // 表现是「omni 一次都不接管」而不报错（2026-11-23 线上踩过一整晚）
      if (typeof agent.willServeAudio !== 'function') {
        this.log('  车道    ✗ agent 上没有 `willServeAudio`（装配层把可选能力吞了）');
      }
      const queue = omniTurn || streamTts === undefined || this.options.onLiveAvailable === undefined
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
      replyPath = reply.path;
      delegateReason = reply.delegate;
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
      if (reply.audio !== undefined) {
        // omni 直出：音频边到边播，**不走 TTS**。
        this.log('  流式    分支=omni（音频直出）');
        audioRate = reply.audio.sampleRate;
        for await (const chunk of reply.audio.chunks) {
          if (fsm.isStale(ticket)) {
            break;
          }
          emit(chunk);
        }
        // drain 之后 `speech` 才是完整的（它是活的 getter）
        speech = reply.speech;
        agent.noteServedTurn?.(text, speech);
        const why = reply.audio.delegateReason?.() ?? null;
        if (why !== null && fsm.isStale(ticket)) {
          // 已经作废了就别再叫 dsh：真机 2026-11-23 第 5 轮，插话与 omni 的
          // `response.done` 落在同一毫秒，这一轮还是去问了 dsh，白等 2.5 s 之后
          // 一个字都没合成 —— 期间状态机一直挂在 `thinking`，下一轮已经开跑了。
          this.log('  omni    想转交 dsh，但本轮已作废 → 不问了');
        } else if (why !== null && audioBytes > 0
          && pcm16DurationMs(audioBytes, audioRate) >= OMNI_DELEGATE_MAX_SPOKEN_MS) {
          // 已经念出去一大段**正文**才想起要转交：这时再问 dsh、再把它的答案拼在后面，
          // 用户听到的是两段互不相干的回答（真机 2026-11-23 05:14 第 9 轮：
          // omni 先播 4.96 s 瞎编，紧接着 dsh 的 7.44 s 接上，整轮 12.40 s）。
          // 两份答案拼在一起比只有一份更难听，而且 dsh 那一趟还要几秒。
          const spoken = pcm16DurationMs(audioBytes, audioRate) / 1000;
          this.log(
            `  omni    已经念了 ${spoken.toFixed(1)} s 正文才要转交 → 不再问 dsh`
            + `（两份答案拼起来更难听）`,
          );
        } else if (why !== null) {
          // omni 自己发了 tool_call：就地切给 dsh。
          // 已经出过声就不再叠回执（两份不同的声音接在一起很难听，而且收不回来）。
          this.log('  omni    决定转交 dsh');
          // 正文用 omni 的转述（它直接听音频，专名比 ASR 准），ASR 原话只作附注 ——
          // 数字、路径、设备名这些"照抄"的东西靠原话兜底。
          const omniText = reply.audio.delegateText?.() ?? null;
          const leadIn = speech;
          const bytesBeforeDelegate = audioBytes;
          const pending = agent.reply(
            omniText === null ? text : `${omniText}\n用户原话：「${text}」`,
            image, note, {
              ticket,
              forceDelegate: why,
              receiptSpoken: speech.trim() !== '',
            },
          );
          // 可能不等它了：留一个 catch，别让迟到的那次失败变成进程级错误
          pending.catch(() => undefined);
          const raced = await Promise.race([pending, staleSignal]);
          if (raced === STALE) {
            // 已经作废：不再等 dsh 的取消往返（真机 2.5–3.2 s），否则串行链卡着，
            // 用户下一句要排队。`cancelTurn` 在作废那一刻已经发出去了，答案回来也没人要。
            this.log('  omni    转交后本轮被作废 → 不再等 dsh 的答案');
          } else {
            reply = raced;
            replyPath = reply.path;
            delegateReason = reply.delegate;
            speech = reply.speech;
            await pump?.drain(reply.speech);
            if (fsm.isStale(ticket) && audioBytes === bytesBeforeDelegate) {
              // dsh 答了，但一个字都没合成出去（这条在到达前就被作废了）。
              // `said` 记的必须是**念出去的**文本，不能是这段没念的答案 ——
              // 否则档案里看着"它答了罗马史"，实际播出去的只有 omni 那半句垫话。
              this.log(`  omni    dsh 的答案没来得及合成 → said 仍是垫话`);
              speech = leadIn;
            }
          }
        }
      } else if (streaming !== null) {
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
      const audioSeconds = pcm16DurationMs(audioBytes, audioRate) / 1000;
      this.log(
        `  回放    ${audioBytes} 字节  ${audioSeconds.toFixed(2)} s`
        + (interrupted ? '（被中断）' : ''),
      );

      this.log(
        `TURN n=${ticket.no} text_len=${text.length} dsh_ms=${agentLatencyMs}`
        + ` tts_first_ms=${firstChunkAtMs === 0 ? -1 : firstChunkAtMs}`
        + ` audio_s=${audioSeconds.toFixed(2)}`
        + (replyPath === undefined ? '' : ` path=${replyPath}`)
        + (delegateReason === undefined ? '' : ` delegate=${delegateReason}`)
        + (interrupted ? ' barge_in=1' : ''),
      );

      // 状态机在整个等待期间保持 speaking；插话会让票据作废从而提前结束等待。
      if (!interrupted) {
        // 基准是**首块下发时刻**，不是「最后一块发完的时刻」：omni 流式吐 6 s 音频
        // 本身就要 ~1 s，设备在这 1 s 里已经在播了。用发完时刻当基准，播完之后还要
        // 白锁整整 1 s 的 `speaking`（真机 2026-11-23 05:14：6.16 s 那轮多锁 1.05 s，
        // 用户已经在说下一句，状态机还卡在 speaking）。
        const playbackStartAt = firstAudioAtMs >= 0 ? firstAudioAtMs : this.options.clock.now();
        const estimateAt = playbackStartAt + audioSeconds * 1000;
        // 设备回执只能**延后**，不能提前：真机上 `played` 有时在「最后一批字节收到」
        // 就报上来了（4.58 s 音频 1 s 回执），按它走等于把尾音那段插话窗口关掉。
        // 所以估算时长是下限，played 到了也要等到下限之后；上限只用来兜「事件永远不来」。
        const graceMs = this.options.deviceReportsPlayed === true
          ? Math.max(this.options.playbackTailMs, this.options.playedGraceMs ?? PLAYED_GRACE_MS)
          : this.options.playbackTailMs;
        const capAt = estimateAt + graceMs;
        // 断连时 `close()` 不推进代次（它不动 `gen`），只看 `isStale` 会一直空等到上限
        while (!fsm.isStale(ticket) && fsm.state !== 'closed' && this.options.clock.now() < capAt) {
          if (this.playedSeen && this.options.clock.now() >= estimateAt) {
            break;
          }
          await this.wait(PLAYBACK_POLL_MS);
        }
        interrupted = fsm.isStale(ticket);
      }

      // 用户听到的时长按「首块发出之后过了多久」算，不按字节算：
      // 回答是整段先合成完再等的，插话那会儿音频早就全发出去了。
      const heardSeconds = firstAudioAtMs < 0
        ? 0
        : Math.min(audioSeconds, (this.options.clock.now() - firstAudioAtMs) / 1000);

      // **用户到底少听了没有**，和上面的 `interrupted` 是两件事，别合成一个变量：
      //
      // - `interrupted` = 票据被作废（控制面）。它决定老轮还能不能动 FSM，
      //   不能改判 —— 真机 2026-11-23 第 3 轮，19.44 s 音频**正好播完**、
      //   用户 26 ms 后才开口，`heard_s` 因为 `Math.min` 封顶在 19.44，
      //   按 `heard == audio` 判「没打断」的话，那一轮就会以为还能去收尾。
      // - `truncated` = 内容面。只有它才该管记账与「要不要当成没听完」。
      const HEARD_EPSILON_S = 0.3;
      const truncated = audioSeconds > 0 && heardSeconds + HEARD_EPSILON_S < audioSeconds;

      // 委派轮：把 dsh 的答案回注给 omni 的上下文，否则它不知道自己那一轮被接走了。
      // 按 `truncated` 而不是 `interrupted`：插话落在最后一个字之后（上面第 3 轮那种）
      // 用户其实听全了，该注；少听了一段才不注。
      // 快车道答的轮次不注：它们走 `reply()`，omni 那边由 `noteServedTurn` 覆盖。
      if (replyPath === 'dsh' && !truncated && audioBytes > 0 && speech.trim() !== '') {
        agent.injectAnsweredTurn?.(text, speech);
      }

      this.options.onEvent?.(EVENTS.turnEnd, {
        interrupted,
        truncated,
        audio_s: Number(audioSeconds.toFixed(2)),
        heard_s: Number(heardSeconds.toFixed(2)),
        // 这一轮**念出去的**文本，审计模型行为用（尤其「抢话之后它有没有接上」）。
        // `path=dsh` 另有 `session.v4.jsonl.zstd` 里的 `assistant/message` 可对；
        // 快车道（qwen-flash）没有 session log，这是它唯一的口供。记实际播出的
        // 文本（多步时是全部增量，见上方 `speech` 注释），回执不在这条里。
        said: speech,
        said_chars: [...speech].length,
        dsh_ms: agentLatencyMs,
        tts_first_ms: firstChunkAtMs === 0 ? -1 : firstChunkAtMs,
        // 这一轮是谁答的。没有它，档案里分不出快车道和 dsh —— `dsh_ms` 两组重叠，
        // 只能靠 console 的 `快车道` 行反推（而且「模型自己让位」和「本地闸挡住」
        // 在日志里长得一模一样）。
        ...(replyPath === undefined ? {} : { path: replyPath }),
        ...(delegateReason === undefined ? {} : { delegate: delegateReason }),
        // 记下 dsh 的会话 id，事后才能把这一段和 dsh 自己的 step/tool 轨迹对齐
        ...(this.options.agent.sessionId ? { dsh_session: this.options.agent.sessionId } : {}),
        // **事件循环被占住的时长**，这一轮里最大的一次。
        // 为什么要它：TTS 偶发多出 ~250 ms，而「合成本身」和「服务端接单」都量过是平的
        // （见 `COSYVOICE_TRACE` 与 `docs/OPS-RECORD.md` §12.8.1）—— 那就只剩
        // 「进程被卡了一下」这一种解释，可这条从来没有仪表。有了 max/p99 就能直接判：
        // 尖峰轮的 `loop_max_ms` 也大 → 是我们自己卡的，跟厂商无关。
        ...loopLagSnapshot(),
        // 本轮整机 TCP 计数器增量。**出向**（`net_retrans` / `net_timeouts` /
        // `net_lost_retrans`）算我们发出去的重传；**入向**（`net_ofo_queue` /
        // `net_dsack`）是「厂商回我们的包丢了」的代理 —— 只看前者会把厂商侧重传
        // 误判成「厂商应用层慢」。读不到时这些字段根本不出现，不是 0。
        ...netFields(diffNetCounters(netBefore, readNetCounters())),
      });

      // **每 socket** 的重传/RTO 在 `turn.end` 之后异步采一次（不 await）：
      // 整机计数分不出是谁在重传，而 `ss` 的子进程开销不能进关键路径。
      // 只采 443（厂商那三条）—— 手机那条靠**排除法**：整机涨而三条都是 0，
      // 剩下的就只能是服务器→手机那条（本轮唯一的另一条大流量）。
      void sampleSockets(443).then((sockets) => {
        if (sockets.length === 0) return;
        this.options.onEvent?.(EVENTS.netSockets, { sockets });
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
      this.options.onEvent?.(EVENTS.turnEnd, {
        failed: true,
        dsh_ms: agentLatencyMs,
        ...netFields(diffNetCounters(netBefore, readNetCounters())),
      });
      this.log(`  ✗ 本轮失败: ${(error as Error).message}`);
      return null;
    } finally {
      offInvalidate();
      this.playingTicket = null;
      fsm.audioDone(ticket);
      this.options.onState?.();
      this.options.onTurnFinished();
    }
  }
}
