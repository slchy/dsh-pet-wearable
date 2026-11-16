/**
 * `DialogRuntime`：对话层的一条完整回路，**生产和模拟器共用这一个实现**。
 *
 * ```text
 * 定稿一句话 ──► SessionCore ──effects──► 串行队列 ──► TurnRunner ──► 下行
 *                  ▲                        │
 *    拍到的图 / 设备事件 ────────────────────┘
 * ```
 *
 * <h2>为什么要有这个类</h2>
 *
 * ADR-0002 §3.1 要求被模拟的是应用层本身，而不是它的抄本。这些接线 ——
 * 状态机、拍照收件箱、一轮的串行队列、后台播报的排队 —— 原先各自写在
 * `voice-session.ts` 和 `pet/sim/dialog.ts` 两处，两份一定会漂移。现在只有这一份。
 *
 * 所有**判定**仍在 `session-core.ts`（纯函数），所有**环境**都从这里注入：
 * 下发设备操作、攒句子、结束连接、播报时怎么开麦。
 *
 * <h2>不在这里的东西</h2>
 *
 * ASR、上行音频、TLS、协议帧都留在适配层。本类只吃"一句话定稿了"这种已经抽象过的
 * 事件，所以虚拟时间里跑它不需要设备、不需要网络、不需要 ffmpeg。
 */
import { closeAnnounceMic, speakAnnouncement } from './announce.ts';
import { isBackchannelOnly } from '../backchannel.ts';
import type { Cancel, Clock } from './clock.ts';
import type { DeviceCall, DeviceCapabilities } from '../devices/primitives.ts';
import type { TurnTicket } from '../dialog-fsm.ts';
import { PhotoInbox, type CaptureRequest } from '../photo-inbox.ts';
import { announceInterruptionNote, interruptionNote, remainingSpeech } from '../interrupted-tail.ts';
import type { AgentProvider, TtsProvider } from '../providers.ts';
import { SessionCore, type CoreEffect, type CoreEvent } from '../session-core.ts';
import type { ImageAttachment } from '../session.ts';
import type { DownlinkSink } from '../transport.ts';
import { TurnRunner, type TurnResult } from '../turn-runner.ts';

/** 被打断的那半句最多留这么久：再久就是另一段对话了。 */
const TAIL_TTL_MS = 120_000;

/**
 * 用户最后一次开口之后，要安静这么久才敢播报。
 *
 * 状态机只在**一句话定稿之后**才 `listening → thinking`，所以「用户正说到一半」
 * 和「用户不说话」在 `core.phase` 里是同一个 `listening`。光看 phase 就会在用户
 * 换气的地方插进来 —— 实测最难受的不是慢两秒，是「它抢在我说完之前开口」。
 */
const ANNOUNCE_QUIET_MS = 800;

/** 播报时怎么开麦。设备没有 `listen.start` 就不给这个。 */
export interface AnnounceMic {
  readonly listenStart: boolean;
  /** 开麦到首帧上行音频的截止 */
  readonly micOpenTimeoutMs: number;
  /** 说完之后再听多久 */
  readonly listenMs: number;
  readonly call: (call: DeviceCall) => void;
  /** 等首帧上行，最多 `timeoutMs`；`true` = 麦开了 */
  readonly awaitMicOpen: (timeoutMs: number) => Promise<boolean>;
}

/** 对话层要往外做的事。生产接到连接上，模拟器接到计数器和数组上。 */
export interface DialogEnv {
  /** 下发一次设备操作；`false` = 设备或协议表达不了 */
  readonly call: (call: DeviceCall) => boolean;
  /** 攒一句进这一轮（ASR 的分句） */
  readonly assemble: (text: string) => void;
  /** 这一轮该结束了 */
  readonly end: () => void;
  /** 拍照请求作罢之后的清账（v1 的 id 映射表） */
  readonly forget?: (id: string) => void;
  /** 播报时怎么开麦；不给就是不支持开麦 */
  readonly announceMic?: AnnounceMic;
  /** 播报排队状态（`pending` = 还有话等着说，`spoken` = 刚播完一条） */
  readonly onAnnounce?: (pending: boolean, spoken: boolean) => void;
  /** 有没有一轮在跑（对话层占着话筒） */
  readonly onTurnStart?: (text: string, hasImage: boolean) => void;
  readonly onTurnEnd?: () => void;
  /**
   * 这一轮要附带给模型的**设备现状**（电量、佩戴…）。
   *
   * 模型看不见上行事件，不给它这行就会瞎答：真机问「眼镜还剩多少电」，
   * agent 回「读不到，我手上没有拿电量的接口」——可设备每 30 s 就在报
   * `{"kind":"power","percent":77}`，只是那数据只喂给了宠物环。
   */
  readonly deviceNote?: () => string | undefined;
  /** 每个效果执行前过一眼（档案、断言用） */
  readonly onEffect?: (effect: CoreEffect) => void;
}

/**
 * 把「设备现状」和「续话尾巴」拼成这一轮的系统注记。
 *
 * 两段都是**可选**的，而且都只在当下有效（电量会变、尾巴只活一轮），
 * 所以拼在用户消息前面而不是塞进系统提示词 —— 后者会被前缀缓存锁住。
 *
 * 导出是为了能单测：这里的顺序错了模型就会把「接着刚才」理解成「设备状态」。
 */
export function composeTurnNote(deviceNote?: string, tailNote?: string): string | undefined {
  const parts = [deviceNote, tailNote].filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? undefined : parts.join('；');
}

export interface DialogOptions {
  /** 时钟端口：超时与等待全走它 */
  readonly clock: Clock;
  readonly caps: DeviceCapabilities;
  readonly agent: AgentProvider;
  readonly tts: TtsProvider;
  readonly downlink: DownlinkSink;
  /** 识图那一轮问 agent 的话 */
  readonly imageQuestion: string;
  /** 拍照落盘目录；空串不落盘 */
  readonly photoDir: string;
  readonly photoTimeoutMs: number;
  readonly confirmTimeoutMs: number;
  /** 预估播放时长之外再等的余量 */
  readonly playbackTailMs: number;
  readonly ttsGain?: number;
  /** 每块下行音频（AEC 分析落盘用） */
  readonly onDownlinkChunk?: (chunk: Buffer) => void;
  /** 时间线事件（进会话档案） */
  readonly onEvent?: (name: string, fields?: Record<string, unknown>) => void;
  /**
   * 挂/摘「流式增量」的钩子（逐句合成用）。
   * 宿主把它接到 dsh 的流式侧通道；不接就退回整段合成。
   */
  readonly onLiveAvailable?: (sink: ((text: string) => void) | null) => void;
  /**
   * 长思考回执：一句话在 `afterMs` 内还没开始出声，就先用旁白说 `text`。
   * 不给就不回执。
   */
  readonly env: DialogEnv;
  readonly log: (line: string) => void;
}

export class DialogRuntime {
  readonly core: SessionCore;
  readonly photos: PhotoInbox;
  readonly runner: TurnRunner;

  private readonly options: DialogOptions;
  /** 一轮、一次拍照都排在这条链上，不并发 */
  private serialChain: Promise<void> = Promise.resolve();
  /** 串行队列里还没跑完的任务数 */
  private queued = 0;

  private readonly announceQueue: Array<{ speech: string; emotion?: string }> = [];
  private announcing = false;
  private disposed = false;
  /** 用户最后一次开口（中间结果也算）的时刻，用来判断「他是不是还在说」。 */
  private lastUserSpeechAt = Number.NEGATIVE_INFINITY;
  /** 因为用户还在说话而推迟的那次播报检查。同一时刻只排一个。 */
  private announceRetry: Cancel | null = null;
  /**
   * 上一轮被打断、**没念出口**的那一段（一次性）。
   *
   * 只活到下一轮：用户接着问「你刚才想说什么」时，模型得知道自己断在哪。
   * 顺序反过来（用户没再问）就丢掉 —— 隔了几句话还翻旧账更烦人。
   */
  private tail: { readonly text: string; readonly at: number } | null = null;
  /**
   * 被打断的**后台汇报**剩下的那半句。
   *
   * 和 {@link tail} 分开存：一条是「自回答被打断」，一条是「我派出去的活只念了
   * 一半」，给模型的措辞完全不同（后者要它自己判断该不该补）。两条可能同时存在。
   */
  private announceTail: { readonly text: string; readonly at: number } | null = null;

  constructor(options: DialogOptions) {
    this.options = options;

    this.core = new SessionCore({
      imageQuestion: options.imageQuestion,
      log: options.log,
      capabilities: options.caps,
    });

    this.photos = new PhotoInbox({
      clock: options.clock,
      dir: options.photoDir,
      timeoutMs: options.photoTimeoutMs,
      confirmTimeoutMs: options.confirmTimeoutMs,
      log: options.log,
      send: (call) => options.env.call(call),
    });

    this.runner = new TurnRunner({
      clock: options.clock,
      agent: options.agent,
      tts: options.tts,
      downlink: options.downlink,
      fsm: this.core.fsm,
      playbackTailMs: options.playbackTailMs,
      ...(options.ttsGain === undefined ? {} : { ttsGain: options.ttsGain }),
      ...(options.onDownlinkChunk === undefined ? {} : { onDownlinkChunk: options.onDownlinkChunk }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.onLiveAvailable === undefined ? {} : { onLiveAvailable: options.onLiveAvailable }),
      onTurnFinished: () => {
        this.execute(this.core.dispatch({ type: 'turnFinished' }));
        // 本轮结束，后台任务的播报可以接着放
        void this.flushAnnounce();
      },
      log: options.log,
    });
  }

  // ---------------------------------------------------------------- 输入面

  /**
   * 状态机吃一个事件，并执行它给出的效果。
   *
   * @returns 这一批效果（调用方偶尔要先看一眼，比如"是不是要求停播"）
   */
  dispatch(event: CoreEvent): readonly CoreEffect[] {
    // 用户只要开口（中间结果 / 定稿 / 成句），任何正在念的「回执」和「播报」都要停。
    // 只在 `onPartial` 上收回执是不够的：短促的插话常常只出定稿（真机 05:17:24）。
    //
    // 这里原来调的是 `cancelAck()`，那个方法在 39cbcd1 里被删掉之后调用没跟过来，
    // 只剩下一个空壳 `if` —— 表现是「用户插话，旁白照念」。别再把这段改成空的：
    // 旁白（后台汇报 / 回执）不占轮次票据，状态机也停在 `listening`，
    // 所以 `bargeIn` 那条路对它不成立，**它是唯一能掐断播报的地方**。
    if (event.type === 'sentence' || event.type === 'partial' || event.type === 'utterance') {
      this.lastUserSpeechAt = this.options.clock.now();
      // 只是「嗯」一声、或者 ASR 把一个语气词当成中间结果 —— 这不算打断。
      // 误判的代价不对称：打断错的代价是丢掉一整条后台汇报，不打断只是晚几百毫秒安静。
      if (!isBackchannelOnly(event.text)) {
        this.interruptCanned();
      }
    }
    const effects = this.core.dispatch(event);
    this.execute(effects);
    return effects;
  }

  /**
   * 掐断正在念的旁白，把**没念完的部分**记下来交给下一轮的模型。
   *
   * 不自动补播：系统不知道哥刚才问的是什么，硬补会在人家已经聊到别处时插一句
   * 无关的旧结论。模型手里有上下文，让它判断该不该接着说（见
   * `announceInterruptionNote`）—— 这和「一轮回答被打断」是同一套处理。
   */
  private interruptCanned(): void {
    this.runner.cancelCanned();
    const residue = this.runner.takeCannedResidue();
    if (residue === null) {
      return;
    }
    this.announceTail = { text: residue.text, at: this.options.clock.now() };
    this.options.log(`  播报    被打断，剩 ${[...residue.text].length} 字没念完 → 交给下一轮`);
  }

  /**
   * 用户还在说话：稍后再看一次播报队列。
   *
   * 只排一个 —— `flushAnnounce` 会在每次入队、每轮结束时被反复调用，
   * 每次都排一个定时器的话，用户说半分钟就能攒下几十个待触发的回调。
   */
  private scheduleAnnounceRetry(ms: number): void {
    if (this.announceRetry !== null || this.disposed) {
      return;
    }
    this.announceRetry = this.options.clock.after(Math.max(1, ms), () => {
      this.announceRetry = null;
      void this.flushAnnounce();
    });
  }

  /** 队列空且没有在途任务。 */
  get idle(): boolean {
    return this.queued === 0 && !this.announcing;
  }

  // ---------------------------------------------------------------- 效果

  /** 执行状态机给出的动作。**所有副作用只在这里发生。** */
  private execute(effects: readonly CoreEffect[]): void {
    const { env } = this.options;
    for (const effect of effects) {
      env.onEffect?.(effect);
      switch (effect.type) {
        case 'assemble':
          env.assemble(effect.text);
          break;
        case 'turn':
          void this.enqueueTurn(effect.text, effect.image, effect.ticket);
          break;
        case 'capture':
          this.enqueueCapture(effect.request, effect.ticket);
          break;
        case 'call':
          if (effect.call.op === 'capture.cancel') {
            this.runner.cancelCanned();
            this.photos.cancel('用户改主意或收尾');
          } else {
            env.call(effect.call);
          }
          break;
        case 'end':
          env.end();
          break;
        case 'drop':
          break;
      }
    }
  }

  private enqueueTurn(
    text: string,
    image: ImageAttachment | undefined,
    ticket: TurnTicket,
  ): Promise<void> {
    this.queued += 1;
    this.serialChain = this.serialChain.then(async () => {
      if (this.core.fsm.isStale(ticket)) {
        this.options.log('  （丢弃：用户已插话，这一轮过时了）');
        return;
      }
      // 图由 `capture` 那一步拿好并挂在 text/image 里，这里不再自己拍
      this.options.env.onTurnStart?.(text, image !== undefined);
      // 续话（上一轮被打断的尾巴）和设备现状一起作为系统注记，模型才答得上
      // 「眼镜还剩多少电」「我刚才说到哪」这类只能靠上下文的问题。
      const note = composeTurnNote(this.options.env.deviceNote?.(), this.takeTailNote());
      try {
        const result = await this.runner.run(text, image, note);
        if (result !== null && result.interrupted) {
          this.rememberTail(result);
        }
      } finally {
        this.options.env.onTurnEnd?.();
      }
    }).catch((error: Error) => {
      console.error(`  ✗ 队列任务失败（不影响后续）: ${error.message}`);
    }).finally(() => {
      this.queued -= 1;
    });
    return this.serialChain;
  }

  /** 取走「被打断的那两段」并拼成给模型的注记（一次性）。 */
  private takeTailNote(): string | undefined {
    const notes: string[] = [];
    const now = this.options.clock.now();

    const replyTail = this.tail;
    this.tail = null;
    if (replyTail !== null && now - replyTail.at <= TAIL_TTL_MS) {
      this.options.log(`  续话    上一轮被打断，剩 ${[...replyTail.text].length} 字没说完 → 交给这一轮`);
      notes.push(interruptionNote(replyTail.text));
    }

    const announceTail = this.announceTail;
    this.announceTail = null;
    if (announceTail !== null && now - announceTail.at <= TAIL_TTL_MS) {
      this.options.log(`  续话    后台汇报只念了一半，剩 ${[...announceTail.text].length} 字 → 交给这一轮判断`);
      notes.push(announceInterruptionNote(announceTail.text));
    }

    return notes.length === 0 ? undefined : notes.join('\n');
  }

  /** 记下这一轮被打断后**没念出口**的部分。 */
  private rememberTail(result: TurnResult): void {
    const rest = remainingSpeech(result.speech, result.playedSeconds);
    if (rest === '') {
      this.tail = null;
      return;
    }
    this.tail = { text: rest, at: this.options.clock.now() };
    this.options.log(`  续话    被打断，剩 ${[...rest].length} 字没说完`);
  }

  /**
   * 执行一次 `capture`，拿到结果再交给状态机。
   *
   * 走串行队列：等图的这几十秒里不能开别的一轮（用户改主意时会先下发
   * `capture.cancel` 让这里立刻返回，所以不会把后面的句子卡住）。
   */
  private enqueueCapture(request: CaptureRequest, ticket: TurnTicket): void {
    this.queued += 1;
    this.serialChain = this.serialChain.then(async () => {
      if (this.core.fsm.isStale(ticket)) {
        this.options.log('  （丢弃：拍照请求已过时）');
        return;
      }
      const outcome = await this.photos.request(request);
      this.options.env.forget?.(request.id);
      this.execute(this.core.dispatch(
        outcome.ok
          ? { type: 'shotResult', ok: true, jpeg: outcome.jpeg }
          : { type: 'shotResult', ok: false, failure: outcome.failure },
      ));
    }).catch((error: Error) => {
      console.error(`  ✗ 拍照任务失败（不影响后续）: ${error.message}`);
    }).finally(() => {
      this.queued -= 1;
    });
  }

  // ---------------------------------------------------------------- 播报

  /**
   * 后台任务完成 → 播报。
   *
   * 这条**不属于任何一轮**（`speakCanned` 的旁白通道），所以不占轮次票据、不改状态机。
   * 用户正在说话或正在播报时排队，等回到 `listening` 再放出来 —— 抢话比晚两秒更烦人。
   */
  enqueueAnnounce(speech: string, emotion?: string): void {
    this.announceQueue.push({ speech, emotion });
    // 有货就要让宠物知道：它在「让位」闸门里等着这条
    this.options.env.onAnnounce?.(true, false);
    void this.flushAnnounce();
  }

  /** 清空播报队列并停掉正在播的那条（敲击关播报）。 */
  clearAnnounce(): void {
    this.announceQueue.length = 0;
    this.runner.cancelCanned();
    // 双击是明确的「别念了」：残句连"要不要补"都不该再问，直接作废
    this.runner.takeCannedResidue();
    this.announceTail = null;
  }

  async flushAnnounce(): Promise<void> {
    if (this.disposed || this.announcing || this.announceQueue.length === 0) {
      return;
    }
    if (this.core.phase !== 'listening') {
      // 等本轮结束（`onTurnFinished` 会再叫一次）
      return;
    }
    // 用户在说话时状态机也是 `listening`（要等一句话定稿才进 `thinking`），
    // 所以还得看他最近有没有出过声 —— 否则会在换气处插进来。
    const quietFor = this.options.clock.now() - this.lastUserSpeechAt;
    if (quietFor < ANNOUNCE_QUIET_MS) {
      this.scheduleAnnounceRetry(ANNOUNCE_QUIET_MS - quietFor);
      return;
    }
    const mic = this.options.env.announceMic;
    const { env } = this.options;
    this.announcing = true;
    // 播报占的是 `announce`，不是 `reply`：它是后台汇报，不是对话层的一轮
    env.onAnnounce?.(true, false);
    try {
      while (this.announceQueue.length > 0) {
        const item = this.announceQueue.shift();
        if (item === undefined) {
          break;
        }
        // 情绪随这条播报走：闭包捕获，`speakAnnouncement` 的签名不用动
        const speak = (text: string): Promise<void> => this.runner.speakCanned(text, item.emotion);
        if (mic === undefined) {
          await speak(item.speech);
        } else {
          // 设备能开麦就先开：播报一开口就能被插话（ADR-0001 §6）。超时照播。
          await speakAnnouncement(item.speech, {
            listenStart: mic.listenStart,
            micOpenTimeoutMs: mic.micOpenTimeoutMs,
            listenMs: mic.listenMs,
            call: mic.call,
            awaitMicOpen: mic.awaitMicOpen,
            speak,
          });
        }
        // 播报期间用户说话了：这条已经被 `cancelCanned` 掐断，剩下的留到下一轮结束
        if (
          this.core.phase !== 'listening'
          || this.options.clock.now() - this.lastUserSpeechAt < ANNOUNCE_QUIET_MS
        ) {
          break;
        }
      }
    } finally {
      this.announcing = false;
      if (mic !== undefined) {
        // 整批播完关麦（与 `pet/sim/world.ts` 同一个函数）
        closeAnnounceMic({ listenStart: mic.listenStart, call: mic.call });
      }
      // 整批播完（队列空了、用户也没在说话）就没什么要处理的；
      // 队列里还有货说明播报期间又来了新的 —— 得自己再排一次检查，
      // 否则那一条会一直躺着等下一轮。
      if (this.announceQueue.length > 0) {
        this.scheduleAnnounceRetry(ANNOUNCE_QUIET_MS);
      }
      // `spoken: true`：播报出声算"最近出过声"，由 minGap 推迟下一次搭话（ADR-0001 §6）
      env.onAnnounce?.(this.announceQueue.length > 0, true);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.announceQueue.length = 0;
    this.announceRetry?.();
    this.announceRetry = null;
    this.photos.dispose();
  }
}
