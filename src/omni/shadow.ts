/**
 * omni 影子旁路：**只量，不发声**（`serve=full` 时才把音频交出去）。
 *
 * <h2>它要回答什么</h2>
 *
 * 一道只有它能答的问题：把「封段 → 首块音频」交给 omni 一体模型，
 * 比我们自己的 `①b 定稿 + ② 开轮 + ③ TTS 首块` 快多少、稳多少。
 *
 * 挂载点必须是**封段**（`asr.commit` 那一刻），不是定稿。实测（9 个样本，
 * `tmp/omni-probe/late-create.cjs`）：`response.create` 每推迟 1 ms，首块就晚 1 ms
 * —— 推迟 241 ms（判停出结论那一刻）首块从 664 掉到 887，而我们级联是 835。
 * 也就是说 **create 的决策预算只有 ~171 ms**，等判停就已经输了。
 *
 * <h2>为什么它不能直接长成「答题的那条腿」</h2>
 *
 * 上面那条决定了 `commit` 与 `response.create` 必须**连发**（pipe 形态），
 * 而 create 一发出去就收不回来：并段轮必然先答了前半句，只能 cancel。
 * 脏历史是 pipe 的固有价格，不是这里的实现缺陷。
 *
 * <h2>三条硬约束（都是踩出来的）</h2>
 *
 * 1. **封段之后要闭嘴**。能量门 `holdMs`（默认 2000 ms）比 `commitMs`（默认 20 ms）
 *    长得多，`onSpeech` 在封段后还会继续收到 ~1980 ms 的**静音**。无条件转发等于
 *    每轮都往服务端灌两秒静音：既计费（Manual 模式的静音不免费），又会让下一轮
 *    `restart()` 把这段残留 commit 成一条空白用户消息。所以只认 `voiced` 的块。
 * 2. **忙的时候不能发 `response.create`**。服务端回
 *    `invalid_request_error: Conversation already has an active response`，
 *    而且那一次 create **永久丢失**。所以 `seal()` 撞上 busy 时要先 cancel、等 done。
 * 3. **不自动重连**。影子挂了就等于这次实验结束 —— 少一个半夜自己重连、
 *    把账单和口径都搅乱的东西。`broken` 会落一条事件，人看见了再决定。
 *
 * 上行缓冲在 {@link UplinkLedger}，控制帧在 {@link ControlPlane}，
 * 连接与协议错误在 {@link OmniSocket}，回复相位在 `response.ts`。
 * 这里只排它们的先后。
 */
import WebSocket from 'ws';

import type { AgentAudioAnswer, InjectKind } from '../providers.ts';
import { ControlPlane } from './control-plane.ts';
import {
  assistantItemIds,
  base64Bytes,
  buildSessionUpdate,
  BYTES_PER_MILLISECOND,
  clipText,
  composeInstructions,
  DEFAULT_MODEL,
  DEFAULT_URL,
  DOWNSTREAM_RATE,
  MAX_INJECT_CHARS,
  parseDelegateRequest,
} from './protocol.ts';
import {
  blankPending,
  isCancelled,
  isClosed,
  isSettled,
  iterateSolo,
  liveControls,
  markPhaseDone,
  openExclusiveReader,
  takeChunk,
  wakeAudio,
} from './response.ts';
import { OmniSocket } from './socket.ts';
import type {
  OmniShadowOptions,
  OmniShadowState,
  PendingResponse,
  QueuedSpeech,
  RealtimeSocket,
  RealtimeSocketFactory,
  ResponsePhase,
  SealMeta,
  ServerEvent,
} from './types.ts';
import { UplinkLedger } from './uplink-ledger.ts';

export class OmniShadow {
  private readonly opts: OmniShadowOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly uplink: UplinkLedger;
  private readonly socket: OmniSocket;
  private readonly control: ControlPlane;

  private state: OmniShadowState = 'idle';
  /** 最近一份回复的相位。`resp` 在 `response.done` 后会被清掉，档案和测试还要能看到 `done`。 */
  private observedPhase: ResponsePhase | null = null;
  private pending: SealMeta | null = null;
  private resp: PendingResponse | null = null;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;

  /** 这一轮里已经封过几段（并段 > 1）。`restart()` 归零 */
  private turnSeqs: number[] = [];
  /**
   * `claim()` 认领了「还没建出来的那一份」时置位。
   *
   * 语义是**预留**：`sendSeal()` 一建好就把新那份标成 `claimed`，别的消费者再也拿不走。
   * 一轮只会 claim 一次，所以单槽够；`discard()` / `restart()` 会把它清掉。
   */
  private claimReserved = false;
  /**
   * 轮次纪元：restart() 每次 +1。claim() 记下当时的纪元，并段轮被顶掉时
   * 只肯跟到**同一个纪元**里新封出来的那份 —— 否则就会把下一轮的答案当成自己的。
   */
  private turnEpoch = 0;
  /** 刚被本轮的下一段顶掉、但下一份还没建出来的那一份（sendSeal 里接链） */
  private supersededPrev: PendingResponse | null = null;
  private claimEpoch = -1;
  /**
   * 认领落在哪一份上。
   *
   * **不能事后去 `this.resp` 里找**：`response.done` 一到 `finish()` 就把 `this.resp`
   * 置 null。没人认领的用户回复改停在 {@link readyResp}，认领过的引用留在这里。
   * 消费者这时还没开始读（异步 generator 的第一个 `next()` 是微任务）也够得着，
   * 不会静默等 5 s、零音频。
   */
  private claimedResp: PendingResponse | null = null;
  /**
   * 已经 `response.done`、但还没人 `claim()` 的用户回复。
   *
   * Silero 提速后 TurnJudge 可能比 Omni 晚几十毫秒。done 一到就塞进 orphans
   * 会把合法回复删掉，编排器只能退回 `answerFromText`。停在这里，
   * `willServe()` / `claim()` 仍看得见；同句再封段只删助手项，新一轮开口才连用户项一起删。
   */
  private readyResp: PendingResponse | null = null;
  /** 在等「下一份建出来」的读端（`claim()` 的流会挂在这里） */
  private liveWaiters: Array<() => void> = [];
  /** 还没跑过任何一份 seal —— 第一条标 `warmup`，分析时排除 */
  private sharedSeals = 0;

  constructor(options: OmniShadowOptions) {
    this.opts = options;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.uplink = new UplinkLedger(options.ringMs, (line) => {
      this.log(line);
    });
    this.socket = new OmniSocket((line) => {
      this.log(line);
    });
    this.control = new ControlPlane({
      send: (payload) => {
        this.send(payload);
      },
      log: (line) => {
        this.log(line);
      },
      sessionUpdate: (dynamicContext) => buildSessionUpdate({
        instructions: composeInstructions({
          instructions: this.opts.instructions,
          clock: this.opts.clockContext?.(),
          memoryContext: this.opts.memoryContext,
          dynamicContext,
        }),
        asrLanguage: this.opts.asrLanguage,
        asrCorpusText: this.opts.asrCorpusText,
        serve: (this.opts.serve ?? 'off') !== 'off',
      }),
      gate: () => ({
        state: this.state,
        hasResp: this.resp !== null,
        socketOpen: this.socket.isOpen,
      }),
      onAbortQueued: (entry) => {
        this.abortQueuedEntry(entry);
      },
    });
  }

  get currentState(): OmniShadowState {
    return this.state;
  }

  /** 本端端口：长尾时可以用 `ss -ti` 直接区分「厂商慢」和「公网丢包」 */
  get localPort(): number {
    const socket = (this.socket.ws as unknown as { _socket?: { localPort?: number } } | null)?._socket;
    return socket?.localPort ?? 0;
  }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    if (this.state !== 'idle') {
      return;
    }
    this.state = 'connecting';
    const factory: RealtimeSocketFactory = this.opts.socketFactory
      ?? ((url, apiKey) => new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        maxPayload: 16 << 20,
      }) as unknown as RealtimeSocket);

    const url = `${this.opts.url ?? DEFAULT_URL}?model=${encodeURIComponent(this.opts.model ?? DEFAULT_MODEL)}`;
    let ws: RealtimeSocket;
    try {
      ws = factory(url, this.opts.apiKey);
    } catch (error) {
      this.break(`建连失败：${(error as Error).message}`);
      return;
    }
    this.socket.connect(ws, {
      onOpen: () => {
        this.sendSessionUpdate();
        this.armConnectTimeout();
      },
      onEvent: (ev) => {
        this.onEvent(ev);
      },
      onClose: () => {
        this.break('连接关闭');
      },
    });
  }

  stop(): void {
    this.teardown('stop', false);
  }

  // ---------------------------------------------------------------- 音频与封段

  /**
   * 新一轮开口（能量门重新打开）。
   *
   * 做四件事，顺序有讲究：
   * 1. 上一轮还在生成 → **立刻 cancel**。用户说话有 2–3 s，够它干净收尾；
   *    等到 `seal()` 才 cancel 的话，那 79 ms 会压在关键路径上。
   * 2. 丢掉待发的那份 seal —— 句子还在继续，组装器会重新 `seal()`。
   * 3. 本地 `held` 直接丢（它从没进服务端）。服务端缓冲里**真有**未 commit
   *    字节才 `commit`（**不发 create**）。空缓冲 commit 会回
   *    `maybe no invalid audio stream`。
   * 4. 解除闭嘴，把预卷推上去。
   */
  restart(preroll: readonly Buffer[]): void {
    if (this.state === 'broken' || this.state === 'idle') {
      return;
    }
    if (this.resp !== null) {
      if (this.resp.origin === 'announce') {
        // 用户开口：后台汇报立刻停。一个字都没播过就删助手项；
        // 临时 prompt user 项在 done 时另行删掉（见 deletePromptUserOnDone）。
        this.cancelAnnounce(this.resp);
      } else {
        this.cancelCurrent();
      }
    }
    this.control.clearSpeech();
    this.pending = null;
    this.turnSeqs = [];
    // 新一轮开口：上一轮预留的那份不再属于任何人
    this.turnEpoch += 1;
    this.supersededPrev = null;
    this.claimReserved = false;
    this.claimedResp = null;
    // 新一轮开口：上一轮没人认领的已完成回复，助手项和用户项一起删。
    this.demoteReadyResp(true);
    // 上一轮那些「答了但没人听过」的回复，趁现在删掉
    this.control.flushOrphans();
    this.wakeLive();

    // 先读服务端缓冲快照，再清本地。空缓冲不 commit。
    const serverBytes = this.uplink.restartSnapshot();
    if (serverBytes > 0) {
      this.send({ type: 'input_audio_buffer.commit' });
    }

    for (const part of preroll) {
      this.append(part);
    }
  }

  /**
   * 一块上行音频。
   *
   * `voiced` 必须由能量门给（`EnergyGateDecision.voiced`），不能自己按能量重算 ——
   * 两处门限一漂移，这里就会开始丢字或灌静音，而且从数据上分不出来。
   */
  feed(pcm: Buffer, voiced: boolean): void {
    if (this.state === 'broken' || this.state === 'idle') {
      return;
    }
    for (const frame of this.uplink.accept(pcm, voiced)) {
      this.append(frame);
    }
  }

  /**
   * 封段：与 ASR 的 `commit` 同一行、同一纳秒发出。
   *
   * @param seq 与 `asr.commit` 共用的序号 —— 两份事件的 join key
   * @param silenceMs 距最后一个有声帧多久（与 `asr.commit` 的同一个数）
   */
  seal(seq: number, silenceMs: number): void {
    if (this.state === 'broken' || this.state === 'idle') {
      this.emitSkipped(seq, this.state === 'broken' ? 'broken' : 'idle');
      return;
    }
    // 无论这份能不能发出去，封段之后都要先闭嘴
    const bytes = this.uplink.muteForSeal();
    if (bytes <= 0) {
      this.emitSkipped(seq, 'empty');
      return;
    }
    // 会话格式还没确认：字节在 held（或已经在服务端缓冲）里，这次封段作废，
    // 但不能把账清零，否则 `session.updated` 之后这段音频就丢了。
    if (this.state === 'connecting') {
      this.emitSkipped(seq, 'connecting');
      return;
    }
    this.uplink.parkSegment();
    this.turnSeqs.push(seq);
    const meta: SealMeta = {
      seq,
      silenceMs,
      anchor: this.now(),
      bytes,
      flushedMs: this.uplink.consumeFlushedMs(),
    };
    // 用户新封段优先级高于所有还没发出的提示队列，先清掉队列再接新封段。
    this.control.clearSpeech();
    // 同句再封段、中间没有 restart：只删上一段助手项，用户音频留给这一段。
    this.demoteReadyResp(false);
    if (this.resp !== null) {
      // 忙时 create 会被服务端拒掉且永久丢失（实测），所以先 cancel 再排队。
      // 标 `superseded`：这是**同一轮的下一段**，不是新一轮 —— 认领要跟过去（见 `sendSeal`）。
      const current = this.resp;
      current.superseded = true;
      this.supersededPrev = current;
      if (current.origin === 'announce') {
        // 后台汇报被用户封段顶掉：掐掉它，排队的 seal 等它 done 再发。
        // 读端只绑自己那份，这里叫醒它，免得它挂到 done 才退出、中途去追 next。
        this.cancelAnnounce(current);
      } else {
        // 一个字节音频都没出过的那份没人听过，删掉；出过的留着（用户可能听到了）
        if (current.claimed && current.firstAudioAt === null) {
          current.deleteOnDone = true;
        }
        this.cancelCurrent();
      }
      this.pending = meta;
      return;
    }
    this.sendSeal(meta);
  }

  // ---------------------------------------------------------------- 车道接口

  /**
   * 这一轮能不能由 omni 自己答。纯读、不改账。
   *
   * **硬约束：omni 开着的时候，快车道的每一轮都必须由它答。** 一轮退回级联，
   * 用户就会在一段对话里听到两副嗓子。所以这里的判据要宽，宁可等也不能放：
   * 手里那份被顶掉了（`cancelled`）但还有一份在 `pending` 里排队时，**也算能答** ——
   * 新那一份马上就建出来（实测空窗 92 ms）。
   *
   * **并段轮不挡。** 曾经按 `turnSeqs.length > 1` 挡过（`clip` 档），实测两场之后砍掉。
   */
  willServe(): boolean {
    if (this.state !== 'ready' && this.state !== 'busy') return false;
    if ((this.opts.serve ?? 'off') === 'off') {
      return false;
    }
    if (this.liveResp() !== null) {
      return true;
    }
    // 手里没有可用的一份：只有「已经有一份在排队」才算能答
    return this.pending !== null;
  }

  /**
   * 认领本轮音频。
   *
   * 注意：**首块通常还没到**（认领在定稿 ~220 ms，首块 600–670 ms），而判停延拍时
   * 认领可以晚到 700–870 ms、那时首块已经发过来了 —— 两条路都靠 `resp.audio`
   * 从封段就开始攒。
   *
   * 手里那份被顶掉时，认领的是**排队中的下一份**：`claimReserved` 让 `sendSeal()`
   * 一建好就把它标成 `claimed`，流从这里开始等。
   */
  claim(): AgentAudioAnswer | null {
    if (!this.willServe()) {
      return null;
    }
    // 上一轮的认领随这一轮作废（一轮一个消费者）
    this.claimedResp = null;
    // 每次认领一个新纪元：并段轮被顶掉时，只允许跟到**这一次认领之后**新封出来的那份。
    //
    // 不能只靠 `restart()` 推进：连着说话时能量门不关，`restart()` 根本不跑
    // （真机 `20261122-2259` 的 `turn_seqs` 一路涨到 15 —— 那就是没 restart 的证据），
    // 于是「同一个 turnEpoch」会把**下一轮**的段也当成自己的。
    const me = (this.turnEpoch += 1);
    this.claimEpoch = me;
    const live = this.liveResp();
    if (live !== null) {
      if (live === this.readyResp) {
        this.readyResp = null;
      }
      live.claimed = true;
      this.claimedResp = live;
    } else {
      // 只能预留：真正那一份还没建出来。一轮只会 claim 一次，所以单槽够用。
      this.claimReserved = true;
    }
    const self = this;
    let bound = live;
    /** 这一轮真正对应的那一份：手里这份，或者预留到的那份 */
    const current = (): PendingResponse | null => {
      if (bound === null) {
        bound = self.claimedResp;
      }
      return bound;
    };
    return {
      sampleRate: DOWNSTREAM_RATE,
      transcript: () => current()?.text ?? '',
      delegateReason: () => current()?.delegate ?? null,
      delegateText: () => current()?.delegateRequest ?? null,
      ...liveControls(current),
      chunks: (async function* iterate() {
        // 还没绑上具体那一份时，后来的 `claim()` 已经把预留槽抢走了：
        // 立刻停，别再去 `current()` 里把别人的 `claimedResp` 闩进来。
        if (bound === null && self.claimEpoch !== me) {
          return;
        }
        let resp = current();
        // 等排队那份建出来。四条路都放弃，让这一轮以「零音频」结束
        // （宿主按 `audioBytes === 0` 记账，不会假装说过话）：
        // 1. 车道挂了 / 被停掉；
        // 2. 预留已经作废 —— `discard()` / `restart()` 清了 `claimReserved`，
        //    但 `state` 仍是 `ready` / `busy`。原来只看 state 的写法会在这里
        //    一圈圈空等（每圈 5 s）；
        // 3. 等了 5 s 那份还没建出来（`waitLive` 的超时）。
        // 4. 等待期间又一次 `claim()` 把这个预留顶掉了。
        if (resp === null) {
          if (self.state !== 'broken' && self.state !== 'idle'
            && self.claimReserved && self.claimEpoch === me) {
            await self.waitLive();
          }
          if (bound === null && self.claimEpoch !== me) {
            return;
          }
          resp = current();
          if (resp === null) {
            return;
          }
        }
        // 上面那一段保证非空；单独一个非空变量是为了在「换到下一段」时不丢类型
        let active: PendingResponse = resp;
        let cursor = openExclusiveReader(active);
        let yielded = 0;
        for (;;) {
          const chunk = takeChunk(active, cursor);
          if (chunk === 'stale') {
            return;
          }
          if (chunk !== 'wait') {
            yielded += chunk.length;
            yield chunk;
            continue;
          }
          if (isSettled(active)) {
            // 被**同一轮的下一段**顶掉、而且这段还一个字都没播出去 → 认领跟过去。
            // 播过就到此为止：两段回答接在一起比「少说一句」更难听。
            // 只认**同一个 turn epoch** 里新封出来的那一份：`restart()` 之后 `this.resp`
            // 属于下一轮，跟过去就把人家的答案抢了（`interrupt` 也就掐错人）。
            if (yielded === 0 && active.superseded
              && self.claimEpoch === me && self.turnEpoch === me) {
              let next = active.next;
              if (next === null && self.pending !== null) {
                // 排队那份还没建出来（finish() 先收尾上一份、再补发）：等它
                await self.waitLive();
                next = active.next;
              }
              if (self.claimEpoch !== me || self.turnEpoch !== me) {
                return;
              }
              if (next !== null && next !== active) {
                next.claimed = true;
                if (self.readyResp === next) {
                  self.readyResp = null;
                }
                self.claimedResp = next;
                self.log('[omni] 认领跟到下一段（并段轮）');
                active = next;
                cursor = openExclusiveReader(active);
                continue;
              }
            }
            return;
          }
          await new Promise<void>((resolve) => { active.audioWaiters.push(resolve); });
        }
      })(),
    };
  }

  /**
   * 这一轮不采纳（走 dsh / 太长 / 判据否决）：**立刻 `response.cancel`**，
   * 并把这条助手回复标记成「结束后删掉」。
   *
   * 不取消的话它会在后台把整段废音频生成完 —— 既烧输出 token，又让下一轮开口时
   * 它还挂着 `busy`（那时新的 `response.create` 会被服务端拒掉且永久丢失）。
   *
   * 删除走 `deleteOnDone`（见 `finish()`）：这里拿不到 item id。
   */
  discard(): void {
    // 丢弃本轮时把还没发出的本轮补句也一并清掉；调用方随后若立刻 enqueueSpeech，
    // 新的回执会排在刚取消的这份 response.done 之后发出。
    this.control.clearSpeech('ack');
    // 已完成但没人认领的那份：只删助手项，用户音频留下。槽位立刻让出。
    this.demoteReadyResp(false);
    const resp = this.resp;
    if (resp !== null) {
      resp.audio.length = 0;
      resp.deleteOnDone = true;
      // 先标取消再叫醒。反过来的话，读端被叫醒时相位还是 live，
      // 会重新挂上 waiter，一直等到 `response.done` 才退出。
      this.cancelCurrent();
      wakeAudio(resp);
    }
    this.pending = null;
    // 预留作废，并且把可能挂在 `waitLive()` 上的读端叫起来
    this.claimReserved = false;
    this.claimedResp = null;
    // 本地还没发出去的帧丢掉。已经在服务端缓冲里的字节留在账上，不发 commit。
    this.uplink.discard();
    this.wakeLive();
    // 在途回复要等 done 才有 item id。已经完成的待认领槽此刻就能把助手项删掉。
    if (this.resp === null && this.state === 'ready') {
      this.control.flushOrphans();
    }
  }

  /**
   * 播到一半被用户打断：取消生成，但**保留**那条助手回复。
   *
   * 与 `discard()` 的差别只有一点，但是要害：这一轮用户**已经听到了一部分**。
   * 删掉它会让 omni 以为自己没说过，而快车道那边的 `pending` 记的正是这半句
   * —— 两条上下文轨就分叉了。
   *
   * **只掐 `claimedResp`（这一轮真正吃掉的那一份），不是 `this.resp`。**
   * 插话的时刻常常晚于下一段的封段：那时 `this.resp` 已经是**新那句话**的回复了，
   * 盲掐 `this.resp` 会把还没开口的新答案一起杀掉。
   */
  interrupt(): void {
    const resp = this.claimedResp;
    this.claimedResp = null;
    if (resp === null) {
      // 这一轮本来就没用 omni（走的是文本快车道/ dsh）——没有该掐的东西
      return;
    }
    if (!isSettled(resp)) {
      resp.audio.length = 0;
      // 先标取消再叫醒。反过来的话，读端被叫醒时 `cancelled` 还是 false，
      // 会重新挂上 waiter，一直等到 `response.done` 才退出。
      this.cancelCurrent(resp);
      wakeAudio(resp);
    }
  }

  /**
   * 现在能不能安全地插一条后台汇报。纯读、不改账。
   *
   * 必须同时空闲：服务端没有在途 response（`ready` 且 `resp` / `pending` 都空），
   * 本地也没有还没 commit 的用户音频。差一条就会在忙时 `response.create`，
   * 服务端回 `Conversation already has an active response` 并且那一次 create 永久丢失。
   */
  canSpeakBackground(): boolean {
    if (this.state !== 'ready' && this.state !== 'busy') return false;
    if ((this.opts.serve ?? 'off') === 'off') {
      return false;
    }
    return this.state === 'ready'
      && this.resp === null
      && this.pending === null
      && this.control.speechQueue.length === 0
      && this.uplink.dirtyBytes === 0;
  }

  /**
   * 现在能不能用已经听写出来的文本，在这条健康连接上直接答。纯读、不改账。
   *
   * 跟 {@link canSpeakBackground} 的差别：不看 `dirtyBytes`。拆句没封段时
   * 缓冲里可能还有残留，但 ASR 文本已经在手里，不该因此退回另一副嗓子。
   * 未传 `serve` 与 `'off'` 一样，只测不发声。
   */
  canAnswerText(): boolean {
    if (this.state !== 'ready' && this.state !== 'busy') return false;
    if ((this.opts.serve ?? 'off') === 'off') {
      return false;
    }
    return this.state === 'ready'
      && this.resp === null
      && this.pending === null;
  }

  /**
   * 在空窗里把后台结论写进这条会话，并让 omni 用同一副嗓子说出来。
   *
   * 返回的音频流**只**绑 `target` 这一份：用户中途 `restart` / `seal` 会把
   * `target.next` 接成新的用户回复，这里读了就会把用户的话抢走。
   * 停在 `cancelled` / `closed` 上，不跟着走。
   *
   * 不能发的时候返回 null，**一个帧都不出**。调用方等下一个空窗再试。
   */
  speakFromText(
    promptText: string,
    meta?: { readonly taskId?: string; readonly query?: string },
  ): AgentAudioAnswer | null {
    if (!this.canSpeakBackground()) {
      return null;
    }
    // 还是 ready：先按统一顺序冲掉积压的控制帧，再占用这条会话。
    // 忙了再发 item.create，会插进别人正在生成的那一轮里。
    // 未认领的已完成音频在这里放弃，助手项和用户项一起删。
    this.demoteReadyResp(true);
    this.control.flushReady();
    const sentAt = this.now();
    const resp = blankPending({
      seq: 0,
      silenceMs: 0,
      anchor: sentAt,
      bytes: 0,
      flushedMs: 0,
    }, 'announce', sentAt);
    resp.claimed = true;
    resp.deletePromptUserOnDone = true;
    this.resp = resp;
    this.claimedResp = resp;
    this.state = 'busy';
    const taskId = meta?.taskId ?? '';
    if (taskId !== '') {
      this.log(`[omni] 后台汇报 ${taskId}`);
    }
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: promptText }],
      },
    });
    this.send({
      type: 'response.create',
      response: { modalities: ['audio', 'text'] },
    });
    this.armResponseTimeout();
    const target = resp;
    return {
      sampleRate: DOWNSTREAM_RATE,
      transcript: () => target.text,
      delegateReason: () => target.delegate,
      delegateText: () => target.delegateRequest,
      ...liveControls(() => target),
      chunks: iterateSolo(target),
    };
  }

  /**
   * 拆句没封段、但连接健康时，用听写文本在**这条**会话里直接答。
   *
   * 协议形状与 {@link speakFromText} 相同：先清孤儿和排队回注，再
   * `conversation.item.create`（`role: 'user'`）+ `response.create`。
   * 差别是 `origin` 必须是 `'user'` —— 这是用户这一轮，不是后台汇报。
   * 一发出去就标成已认领，`claim()` 拿不走，读端也不跟着下一段走。
   *
   * `canAnswerText()` 为假，或 `userText` 去掉空白后是空的，返回 null，一个帧都不发。
   */
  answerFromText(userText: string): AgentAudioAnswer | null {
    if (!this.canAnswerText() || userText.trim() === '') {
      return null;
    }
    // 还是 ready：先按统一顺序冲掉积压的控制帧，再占用这条会话。
    // 这是用户真话，`deletePromptUserOnDone` 保持 false，done 时不删这条 user 项。
    // 未认领的已完成音频在这里放弃，助手项和用户项一起删。
    this.demoteReadyResp(true);
    this.control.flushReady();
    const sentAt = this.now();
    const resp = blankPending({
      seq: 0,
      silenceMs: 0,
      anchor: sentAt,
      bytes: 0,
      flushedMs: 0,
    }, 'user', sentAt);
    resp.claimed = true;
    this.resp = resp;
    this.claimedResp = resp;
    this.state = 'busy';
    this.log('[omni] 文本直答');
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: userText }],
      },
    });
    this.send({
      type: 'response.create',
      response: { modalities: ['audio', 'text'] },
    });
    this.armResponseTimeout();
    const target = resp;
    const answer: AgentAudioAnswer & { interrupt(): void } = {
      sampleRate: DOWNSTREAM_RATE,
      transcript: () => target.text,
      delegateReason: () => target.delegate,
      delegateText: () => target.delegateRequest,
      ...liveControls(() => target),
      interrupt: () => {
        if (isSettled(target)) {
          if (this.claimedResp === target) {
            this.claimedResp = null;
          }
          return;
        }
        target.audio.length = 0;
        this.cancelCurrent(target);
        if (this.claimedResp === target) {
          this.claimedResp = null;
        }
        wakeAudio(target);
      },
      chunks: iterateSolo(target),
    };
    return answer;
  }

  /**
   * 排队让 omni 按文本提示开口（委派零音频补句 / 取消·看图·钟点回执 / 后台汇报）。
   *
   * 与 {@link speakFromText} 的核心差别：车道此刻正忙时**不会立刻失败返回 null**，
   * 而是入 FIFO 队列，等 `finish()` 回到 `ready` 且无用户封段时串行发送，
   * 杜绝并发 `Conversation already has an active response`。
   *
   * 仅在连接已断（`broken` / `idle`）、车道关闭（`serve=off`）或空提示时返回 null。
   */
  enqueueSpeech(
    promptText: string,
    meta?: {
      readonly kind?: 'ack' | 'announce';
      readonly taskId?: string;
      readonly query?: string;
    },
  ): (AgentAudioAnswer & { interrupt(): void }) | null {
    if (this.state === 'broken' || this.state === 'idle') {
      return null;
    }
    if ((this.opts.serve ?? 'off') === 'off' || promptText.trim() === '') {
      return null;
    }
    const sentAt = this.now();
    const resp = blankPending({
      seq: 0,
      silenceMs: 0,
      anchor: sentAt,
      bytes: 0,
      flushedMs: 0,
    }, 'announce', sentAt);
    resp.claimed = true;
    resp.deletePromptUserOnDone = true;
    const entry: QueuedSpeech = {
      promptText,
      kind: meta?.kind ?? 'announce',
      ...(meta?.taskId === undefined ? {} : { taskId: meta.taskId }),
      resp,
      cancelled: false,
    };
    this.control.enqueue(entry);
    this.drainSpeechQueue();

    const target = resp;
    return {
      sampleRate: DOWNSTREAM_RATE,
      transcript: () => target.text,
      delegateReason: () => target.delegate,
      delegateText: () => target.delegateRequest,
      ...liveControls(() => target),
      interrupt: () => {
        entry.cancelled = true;
        if (this.control.takeIfQueued(entry)) {
          this.abortQueuedEntry(entry);
          return;
        }
        if (isSettled(target)) {
          if (this.claimedResp === target) {
            this.claimedResp = null;
          }
          return;
        }
        if (this.resp === target || this.claimedResp === target) {
          this.cancelAnnounce(target);
          return;
        }
        markPhaseDone(target, true);
        wakeAudio(target);
      },
      chunks: iterateSolo(target),
    };
  }

  /**
   * 只掐正在播的后台汇报。用户自己的回复（`origin === 'user'`）碰都不碰。
   *
   * 一个字节都还没出去：标 `deleteOnDone`，done 时删助手项。
   * 临时 prompt user 项无论出没出声都会删（`deletePromptUserOnDone`）；
   * 已经出过声的助手项留着，跟 `interrupt()` 一样。
   * `response.created` 还没到就只记账，等它到了再补 `response.cancel`。
   */
  cancelBackgroundSpeech(): void {
    this.control.clearSpeech('announce');
    const claimed = this.claimedResp;
    if (claimed !== null && claimed.origin !== 'announce') {
      return;
    }
    const resp = claimed?.origin === 'announce'
      ? claimed
      : this.resp?.origin === 'announce'
        ? this.resp
        : null;
    if (resp === null) {
      return;
    }
    this.cancelAnnounce(resp);
  }

  /**
   * 把**别的车道答出来的**内容回注进 omni 的上下文（委派轮用）。
   *
   * 为什么必须是 `role:'user'`：实测服务端只允许伪造用户的输入，`role:'assistant'`
   * 三种 content type 全部回 `created` + item id 但**模型当没看见**。
   *
   * 忙的时候排队，回到 `ready` 再发 —— `conversation.item.create` 在 `busy` 态
   * 虽然不报错，但插在一条正在生成的回复中间会让它自己那轮的指代也乱。
   */
  injectAnswer(userText: string, said: string, kind: InjectKind = 'spoken'): void {
    const answer = clipText(said.trim(), MAX_INJECT_CHARS);
    if (answer === '') {
      return;
    }
    const question = clipText(userText.trim(), MAX_INJECT_CHARS);
    // `spoken` 用第一人称：这话是**同一副嗓子**念给用户的。
    // `unspoken` 明说用户还不知道 —— 否则它会讲「我刚才告诉过你」。
    const text = kind === 'unspoken'
      ? `（系统旁注：用户刚才问的「${question}」已经由另一位助手回答，`
        + `但那段回答没能说给用户听，用户并不知道内容。回答是：${answer}）`
      : `（系统旁注：用户刚才问的「${question}」，你已经用语音把下面这段念给他了：`
        + `${answer}）`;
    // 计数发生在「确实会进这条连接的队列」之后。broken 或 socket 还没 open
    // 时一个字都发不出去，提前 +1 会让档案里的 injects_sent 对不上实际旁注。
    // connecting 且已经 open 仍然排队：等首次 `session.updated` 把状态拧到 ready。
    if (this.state === 'broken' || !this.socket.isOpen) {
      if (this.state === 'broken') {
        this.log('[omni] 回注丢弃：车道已断');
      }
      return;
    }
    this.control.countInject();
    this.log(
      `[omni] 回注 ${[...answer].length} 字（${kind === 'unspoken' ? '没念出去' : '已播完'}）`
      + `：${answer.slice(0, 20)}${[...answer].length > 20 ? '…' : ''}`,
    );
    this.control.pushInject(text);
    this.control.flushInjects();
  }

  /**
   * 把工具结果写回这条会话。空 id / 空输出 / 断线直接忽略。
   * 忙的时候排队，回到 ready 且没有在途回复时立刻发。
   */
  sendFunctionCallOutput(callId: string, output: string): void {
    this.control.sendFunctionCallOutput(callId, output);
  }

  /**
   * 用唯一单槽刷新 instructions 里的动态事实。
   * 与当前值、已发送值都相同且没有脏标记时直接返回。
   * 忙时只保留最新一份，回到 ready 再发整份 session。
   */
  updateDynamicContext(snapshot: string): void {
    this.control.updateDynamicContext(snapshot);
  }

  /**
   * 从服务端历史里删掉指定 item。空串丢掉，重复 id 只留一份。
   * 断线忽略；忙时排队，回到 ready 立刻发。
   */
  deleteItems(itemIds: readonly string[]): void {
    this.control.deleteItems(itemIds);
  }

  /** 排障用：`willServe()` 为 false 时到底卡在哪一条（只进档案，不参与决策） */
  explain(): Record<string, unknown> {
    const resp = this.resp;
    return {
      serve: this.opts.serve ?? 'off',
      state: this.state,
      has_resp: resp !== null,
      cancelled: resp === null ? null : isCancelled(resp),
      /** 当前回复的相位；收口后 `resp` 被清掉，这里仍留着最后一次（测试要看到 `done`）。 */
      phase: resp?.phase ?? this.observedPhase,
      claimed: resp?.claimed ?? null,
      // 有一份在排队 —— `willServe()` 在「手里那份被顶掉」时靠它才敢说能答
      pending: this.pending !== null,
      // 本次 gate 窗口内封了几段（`restart()` 清零）。**不等于**这一轮并了几段：
      // 插话时门不关、`restart()` 不跑，计数会跨轮累积。
      turn_seqs: this.turnSeqs.length,
    };
  }

  private abortQueuedEntry(entry: QueuedSpeech): void {
    entry.cancelled = true;
    markPhaseDone(entry.resp, true);
    wakeAudio(entry.resp);
  }

  private drainSpeechQueue(): void {
    const next = this.control.takeSpeech(this.uplink.dirtyBytes, this.pending !== null);
    if (next === null) {
      return;
    }
    // 即将占用会话：放弃还没人认领的已完成音频，连用户项一起删。
    // `takeSpeech` 内部已经冲过一轮；这里先降级再冲一次，删项才赶在 response.create 之前。
    this.demoteReadyResp(true);
    this.control.flushReady();
    this.resp = next.resp;
    this.claimedResp = next.resp;
    this.state = 'busy';
    const label = next.taskId ? `${next.kind} ${next.taskId}` : next.kind;
    this.log(`[omni] 排队发声（${label}）`);
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: next.promptText }],
      },
    });
    this.send({
      type: 'response.create',
      response: { modalities: ['audio', 'text'] },
    });
    this.armResponseTimeout();
  }

  private wakeLive(): void {
    const waiters = this.liveWaiters.splice(0);
    for (const wake of waiters) {
      wake();
    }
  }

  /** 等「下一份建出来」；`wakeLive()` 或超时（防挂死）后返回 */
  private waitLive(ms = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        const at = this.liveWaiters.indexOf(done);
        if (at >= 0) {
          this.liveWaiters.splice(at, 1);
        }
        resolve();
      };
      timer = setTimeout(done, ms);
      this.liveWaiters.push(done);
    });
  }

  /** 手里那份可用吗（没被取消、没被认领走、也不是后台汇报）。已完成待认领的也算。 */
  private liveResp(): PendingResponse | null {
    const resp = this.resp;
    // announce 即使忘了标 claimed，也不能交给用户的 claim()。
    if (resp !== null && !isSettled(resp) && !resp.claimed && resp.origin !== 'announce') {
      return resp;
    }
    if (this.readyResp !== null && !this.readyResp.claimed) {
      return this.readyResp;
    }
    return null;
  }

  /**
   * 把已完成待认领的那份降成孤儿。
   *
   * `deleteUser` 为假：同句再封段或 discard，只删助手项，用户音频留下。
   * 为真：新一轮开口，或显式改走文本/播报，助手项和用户项一起删。
   * 已经认领过的不进孤儿（用户听过）。
   */
  private demoteReadyResp(deleteUser: boolean): void {
    const ready = this.readyResp;
    if (ready === null) {
      return;
    }
    this.readyResp = null;
    if (ready.claimed) {
      return;
    }
    const assistant = [...ready.itemIds];
    const user = deleteUser && !ready.deletePromptUserOnDone ? ready.userItemId : null;
    if (assistant.length > 0 || user !== null) {
      this.control.rememberOrphan({ assistant, user });
    }
  }

  // ---------------------------------------------------------------- 内部

  private sendSeal(meta: SealMeta): void {
    // 划给这份 seal 的本地帧必须先 append，再 commit。已经在服务端的字节
    // （`parkedServerBytes`）跟着同一次 commit 清掉。
    this.flushParkedAudio();
    this.uplink.forgetParkedServer();
    this.control.flushReady();
    const sentAt = this.now();
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
    this.resp = blankPending(meta, 'user', sentAt);
    // 接上「谁顶掉了谁」：读端要靠它跟到真正那份答案（见 claim() 的 chunks）
    if (this.supersededPrev !== null) {
      this.supersededPrev.next = this.resp;
      this.supersededPrev = null;
    }
    // `claim()` 可能已经把这一份预留了（它认领时手里那份已经被顶掉）：
    // 一建出来就标成已认领，别的消费者再也拿不走。
    if (this.claimReserved) {
      this.resp.claimed = true;
      this.claimReserved = false;
      this.claimedResp = this.resp;
    }
    this.state = 'busy';
    this.armResponseTimeout();
    // 读端可能正挂在 `waitLive()` 上等这一份
    this.wakeLive();
  }

  /**
   * 掐一条后台汇报，并叫醒它自己的读端。
   *
   * 不改 `state`：服务端的 response 要等到 `response.done` 才真的没了，
   * 提前回到 `ready` 会让下一次 create 撞上「already has an active response」。
   * 一个字节都没播过才标 `deleteOnDone`（只删助手项）；
   * 临时 prompt user 由 `deletePromptUserOnDone` 在 done 时删掉。
   * 播过的助手项留着，跟 `interrupt()` 一样。
   */
  private cancelAnnounce(resp: PendingResponse): void {
    if (resp.origin !== 'announce' || isClosed(resp)) {
      return;
    }
    if (resp.outBytes === 0) {
      resp.deleteOnDone = true;
    }
    resp.audio.length = 0;
    if (!isCancelled(resp)) {
      this.cancelCurrent(resp);
    }
    if (this.claimedResp === resp) {
      this.claimedResp = null;
    }
    wakeAudio(resp);
  }

  /**
   * 取消一份 response。
   *
   * @param resp 默认 `this.resp`。**`interrupt()` 必须传 `claimedResp`** ——
   *   插话时 `this.resp` 可能已经是下一句的回复了（见 `interrupt()`）。
   */
  private cancelCurrent(resp: PendingResponse | null = this.resp): void {
    if (resp === null || isCancelled(resp) || isClosed(resp)) {
      return;
    }
    // 没人认领过 = 没人听过 = 这条回复不该留在历史里。
    // 它覆盖的是「同一句里第二次封段」把上一份顶掉的情形（`seal()` 撞 busy、
    // `restart()` 换段）—— 那份答的是半句话，留着只会污染下一轮。
    // 认领过的**不动**：用户已经听到了一部分，见 `interrupt()`。
    if (!resp.claimed) {
      resp.deleteOnDone = true;
    }
    if (resp.phase === 'starting') {
      // `response.cancel` 在 `response.created` 之前发会被服务端拒
      // （`Cannot cancel response before response.created`），所以先停在
      // `cancel_when_created`，等 created 到了再补发 —— 见 `onEvent`。
      resp.phase = 'cancel_when_created';
      return;
    }
    if (resp.phase === 'live') {
      resp.phase = 'cancelling';
      this.send({ type: 'response.cancel' });
    }
  }

  private append(pcm: Buffer): void {
    if (!this.socket.opened) {
      this.uplink.noteDropped(pcm.length);
      return;
    }
    // 生成期 append 服务端会直接丢掉；connecting 时会话格式还没确认，
    // 同样先留在本地。`seal()` 用 `dirtyBytes`（服务端缓冲 + held）算 `seal_s`。
    if (this.resp !== null || this.state === 'connecting') {
      this.uplink.hold(pcm);
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    this.uplink.noteServerAppend(pcm.length);
  }

  /**
   * 把划进 seal 的本地帧 append 出去。调用方紧接着 commit。
   * 不改 `serverBufferedBytes`：这些字节马上会被 commit 清掉。
   */
  private flushParkedAudio(): void {
    const frames = this.uplink.takeParkedFrames();
    if (frames.length === 0) {
      return;
    }
    for (const pcm of frames) {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    }
    this.log(`[omni] 补推生成期暂存的 ${frames.length} 帧`);
  }

  /**
   * 生成已经结束、没有排队 seal：把还留在本地的帧推进服务端缓冲，等下一次 commit。
   * 字节从 `heldBytes` 挪到 `serverBufferedBytes`，`dirtyBytes` 不变。
   */
  private flushHeldToServer(): void {
    if (this.uplink.held.length === 0 || this.resp !== null || !this.socket.opened
      || this.state === 'connecting' || this.state === 'broken') {
      return;
    }
    const frames = this.uplink.releaseHeldToServer();
    for (const pcm of frames) {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    }
    this.log(`[omni] 补推生成期暂存的 ${frames.length} 帧`);
  }

  private noteDone(resp: PendingResponse, byCancel = false): void {
    markPhaseDone(resp, byCancel);
    this.observedPhase = resp.phase;
  }

  private sendSessionUpdate(): void {
    this.send(this.control.sessionPayload());
    this.control.markSessionSynced();
  }

  private send(payload: object): void {
    this.socket.send(payload);
  }

  private onEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case 'session.updated':
        this.clearConnectTimer();
        if (this.state === 'connecting') {
          this.state = 'ready';
          this.log('[omni] 影子就绪');
          // 先补推 connecting 期间暂存的音频，再冲控制帧。seal 没把这笔账清掉。
          this.flushHeldToServer();
          this.control.flushReady();
          this.drainSpeechQueue();
        }
        return;
      case 'conversation.item.created':
        // 这一段对应的 user 项 —— 幽灵清理时连它一起删，否则会留下「用户在说话、
        // 助手没答」的半条记录
        if (this.resp !== null && ev.item?.role === 'user' && typeof ev.item.id === 'string') {
          // 临时提示可能紧跟在刚冲刷的回注后面。回注的 user 项先回声，
          // 提示自己的 user 项后到 —— 后到的才是要删的那条。
          if (this.resp.deletePromptUserOnDone) {
            if (ev.item.id !== '') {
              this.resp.userItemId = ev.item.id;
            }
          } else {
            this.resp.userItemId ??= ev.item.id;
          }
        }
        return;
      case 'response.output_item.added':
        if (this.resp !== null && ev.item !== undefined) {
          const item = ev.item;
          const id = item.id;
          if (
            (item.role === 'assistant' || item.type === 'function_call')
            && typeof id === 'string'
            && id !== ''
            && !this.resp.itemIds.includes(id)
          ) {
            this.resp.itemIds.push(id);
          }
          if (item.type === 'function_call') {
            // 真服务线序：function_call 比首块音频早约 150 ms。这里就标委派，
            // 守卫轮才能在出声前拦住胡编。
            this.resp.delegate ??= 'delegate';
            if (typeof item.call_id === 'string' && item.call_id !== '') {
              this.resp.delegateCallId ??= item.call_id;
            }
          }
        }
        return;
      case 'response.created':
        if (this.resp !== null && !isClosed(this.resp)) {
          if (this.resp.phase === 'cancel_when_created') {
            this.resp.phase = 'cancelling';
            this.send({ type: 'response.cancel' });
          } else if (this.resp.phase === 'starting') {
            this.resp.phase = 'live';
          }
        }
        return;
      case 'input_audio_buffer.committed':
        if (this.resp !== null && this.resp.ackAt === null) {
          this.resp.ackAt = this.now();
        }
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (this.resp !== null && this.resp.finalAt === null) {
          this.resp.finalAt = this.now();
        }
        return;
      case 'response.text.delta':
      case 'response.audio_transcript.delta':
        if (this.resp !== null) {
          if (this.resp.firstTextAt === null) {
            this.resp.firstTextAt = this.now();
          }
          this.resp.text += ev.delta ?? '';
        }
        return;
      case 'response.function_call_arguments.delta':
        // omni 自己决定转 dsh。音频可能还没出（纯调用），也可能已经说了句垫音。
        if (this.resp !== null) {
          this.resp.delegate ??= 'delegate';
        }
        return;
      case 'response.function_call_arguments.done':
        // 完整参数在这一条里（delta 是分段，拼起来容易漏引号）。解析失败不算错：
        // 委派照旧进行，只是那一轮退回 ASR 原话。
        if (this.resp !== null) {
          this.resp.delegate ??= 'delegate';
          if (typeof ev.call_id === 'string' && ev.call_id !== '') {
            this.resp.delegateCallId = ev.call_id;
          }
          this.resp.delegateRequest = parseDelegateRequest(ev.arguments) ?? this.resp.delegateRequest;
        }
        return;
      case 'response.audio.delta':
        if (this.resp !== null) {
          if (this.resp.firstAudioAt === null) {
            this.resp.firstAudioAt = this.now();
          }
          const delta = ev.delta ?? '';
          // 字节数必须记（`out_s` / `out_audio_tok` 的交叉校验）；
          // 音频本体**从封段就攒着**，不等认领 —— 判停延拍时认领会晚到 700–870 ms
          this.resp.outBytes += base64Bytes(delta);
          this.resp.audio.push(Buffer.from(delta, 'base64'));
          wakeAudio(this.resp);
        }
        return;
      case 'response.done':
        this.finish(ev);
        return;
      case 'error':
        this.onError(ev);
        return;
      default:
        return;
    }
  }

  private onError(ev: ServerEvent): void {
    const message = ev.error?.message ?? '';
    const verdict = this.socket.observeProtocolError(message);
    // 「忙时 create」这类错误说明我们的状态机和服务端已经不同步了。
    // 不猜怎么修，直接停 —— 影子还留着的价值不如它污染数据的代价。
    if (verdict === 'broken') {
      this.break(`连续协议错误：${message.slice(0, 80)}`);
    }
  }

  private finish(ev: ServerEvent): void {
    const resp = this.resp;
    this.resp = null;
    this.clearResponseTimer();
    if (resp !== null) {
      // 先收到 done 再唤醒：读端要知道「再等也没有了」
      this.noteDone(resp);
      if (resp.origin === 'announce' && this.claimedResp === resp) {
        this.claimedResp = null;
      }
      wakeAudio(resp);
    }
    if (this.state !== 'broken') {
      this.state = 'ready';
    }

    // 被 `discard()` 标掉的这份：把助手项和 `function_call` 项从服务端历史里删掉。
    // **不删真实用户项**：用户那条是这一轮的内容，后面还要指代它。
    //
    // `speakFromText` / `enqueueSpeech` 写进去的是临时 meta-prompt，不是用户真话。
    // `deletePromptUserOnDone` 时即使助手项要留下（已经出过声），也删掉那条 user 项。
    // `answerFromText` 绝不设这个标记。
    //
    // 用户回复已完成、还没人认领、也没有同句下一段在排队：停进 `readyResp`，
    // 不进 orphans。TurnJudge 晚到几十毫秒时 `claim()` 仍能把音频读走。
    // 同句被后续封段顶掉的未认领回复只记助手项，用户音频留给下一段。
    // 其余没人认领的才是「幽灵」：记进 orphans。本段自己的孤儿要等这次冲刷之后再入队，
    // 避免回到 ready 的当下落删掉。
    let freshOrphan: { assistant: string[]; user: string | null } | null = null;
    if (resp !== null) {
      const ids = new Set([...resp.itemIds, ...assistantItemIds(ev)]);
      resp.itemIds = [...ids];
      if (resp.delegateCallId === null) {
        for (const it of ev.response?.output ?? []) {
          if (it.type === 'function_call' && typeof it.call_id === 'string' && it.call_id !== '') {
            resp.delegateCallId = it.call_id;
            break;
          }
        }
      }
      const parkReady = resp.origin === 'user'
        && !resp.claimed
        && !resp.deleteOnDone
        && !isCancelled(resp)
        && this.pending === null
        && this.state !== 'broken';
      if (parkReady) {
        if (this.readyResp !== null) {
          this.demoteReadyResp(false);
        }
        this.readyResp = resp;
      } else if (resp.deleteOnDone) {
        for (const id of ids) {
          this.send({ type: 'conversation.item.delete', item_id: id });
        }
        // discard 已经标了 deleteOnDone，编排器可能又 deleteItems 排了同一批 id。
        // 发两次会连着两条协议错误，把车道打成 broken。
        if (ids.size > 0) {
          const pending = this.control.pendingDeletes;
          const kept = pending.filter((id) => !ids.has(id));
          if (kept.length !== pending.length) {
            pending.length = 0;
            pending.push(...kept);
          }
        }
      } else if (!resp.claimed) {
        const sameSentence = this.pending !== null && resp.origin === 'user';
        freshOrphan = {
          assistant: [...ids],
          // 临时提示的 user 项下面马上删，不要再排进孤儿里删第二次。
          // 同句下一段顶掉这份时，用户音频项留下，下一段还听得见前半句。
          user: sameSentence || resp.deletePromptUserOnDone ? null : resp.userItemId,
        };
      }
      if (!parkReady && resp.deletePromptUserOnDone && resp.userItemId !== null && resp.userItemId !== '') {
        this.send({ type: 'conversation.item.delete', item_id: resp.userItemId });
      }
    }

    // 上一段积压的删项、工具回执、动态事实、回注。本段孤儿还没入队。
    // resp 已经置空、状态已经回到 ready，flushReady 的门才开得了。
    this.control.flushReady();
    if (freshOrphan !== null) {
      this.control.rememberOrphan(freshOrphan);
    }

    // 后台汇报没有用户封段序号。记进 `omni.shadow` 会被 latency-report / fsm-trace
    // 当成一次用户开口的 seal，口径就脏了。断线那种 `skipped` 另走 `break()`。
    if (resp !== null && resp.origin !== 'announce') {
      const { meta } = resp;
      const usage = ev.response?.usage;
      const inDetails = usage?.input_tokens_details ?? {};
      const outDetails = usage?.output_tokens_details ?? {};
      const audioMs = resp.firstAudioAt === null ? null : resp.firstAudioAt - meta.anchor;
      this.sharedSeals += 1;
      this.opts.emit({
        seq: meta.seq,
        warmup: this.sharedSeals === 1,
        seal_s: Number((meta.bytes / (BYTES_PER_MILLISECOND * 1000)).toFixed(2)),
        silence_ms: Math.round(meta.silenceMs),
        ack_ms: resp.ackAt === null ? null : Math.round(resp.ackAt - meta.anchor),
        final_ms: resp.finalAt === null ? null : Math.round(resp.finalAt - meta.anchor),
        text_ms: resp.firstTextAt === null ? null : Math.round(resp.firstTextAt - meta.anchor),
        // ★ 主指标：封段 → 首块音频。与我们 `①b+②+③` 同起点，直接可比
        audio_ms: audioMs === null ? null : Math.round(audioMs),
        injects_sent: this.control.injectsSent,
        cancel_wait_ms: Math.round(resp.sentAt - meta.anchor),
        out_s: Number((resp.outBytes / (DOWNSTREAM_RATE * 2)).toFixed(2)),
        status: ev.response?.status ?? null,
        cancelled: isCancelled(resp),
        flushed_ms: meta.flushedMs,
        in_audio_tok: inDetails.audio_tokens ?? null,
        in_text_tok: inDetails.text_tokens ?? null,
        out_audio_tok: outDetails.audio_tokens ?? null,
        local_port: this.localPort,
        ...(this.uplink.droppedBytes > 0
          ? { dropped_ms: Math.round(this.uplink.droppedBytes / BYTES_PER_MILLISECOND) }
          : {}),
      });
      this.uplink.droppedBytes = 0;
    }

    // 排队中的那一份 seal（撞 busy 时的）。
    // 注意用 `pending.bytes`：那段音频的长度在 `seal()` 时就已经记下来了，
    // 之后新到的音频属于**下一段**，不能算进这一份（所以不能重读 `dirtyBytes`）。
    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
      if (this.state === 'broken') {
        this.uplink.releaseAllBuffered();
        this.emitSkipped(pending.seq, 'broken');
      } else {
        // 划进这份 seal 的本地帧由 sendSeal 在 commit 前推上去。
        // 封段之后新到的 held 留下，属于下一段，不能混进这次 commit。
        this.sendSeal(pending);
      }
    } else {
      // 没有排队的段：攒下的音频留在服务端缓冲里等下一次 commit
      this.flushHeldToServer();
      if (this.state === 'ready') {
        this.drainSpeechQueue();
      }
    }
  }

  private emitSkipped(seq: number, why: string): void {
    this.opts.emit({ seq, skipped: why, local_port: this.localPort });
  }

  /**
   * `stop()` 与 `break()` 的唯一收口。
   *
   * `broken` 是吸收态：再进来直接返回，避免第二次 close 把已经换掉的状态又搅一遍。
   * `emitSkipped` 只属于故障路径（断线、超时、协议错误）。主动 `stop()` 不写档案。
   */
  private teardown(reason: string, emitSkipped: boolean): void {
    if (this.state === 'broken') {
      return;
    }
    this.clearTimers();
    const ws = this.socket.detach();
    this.state = 'broken';
    const resp = this.resp;
    this.resp = null;
    this.readyResp = null;
    this.pending = null;
    this.claimReserved = false;
    this.claimedResp = null;
    this.uplink.releaseAllBuffered();
    this.control.clearSpeech();
    this.control.clearTransient();
    if (resp !== null) {
      this.noteDone(resp);
    }
    wakeAudio(resp);
    this.wakeLive();
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已经断了
      }
    }
    if (!emitSkipped) {
      return;
    }
    this.log(`[omni] 影子停用：${reason}`);
    // 落一条可见记录：档案里能看出「从这里开始没有 omni 数据」
    this.opts.emit({ seq: null, skipped: 'broken', why: reason.slice(0, 120) });
  }

  private break(reason: string): void {
    this.teardown(reason, true);
  }

  private armConnectTimeout(): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.state === 'connecting') {
        this.break('握手超时');
      }
    }, this.opts.connectTimeoutMs ?? 15_000);
    this.connectTimer.unref?.();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private armResponseTimeout(): void {
    this.clearResponseTimer();
    this.responseTimer = setTimeout(() => {
      this.responseTimer = null;
      this.break('response 超时');
    }, this.opts.responseTimeoutMs ?? 30_000);
    this.responseTimer.unref?.();
  }

  private clearResponseTimer(): void {
    if (this.responseTimer !== null) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearResponseTimer();
  }
}
