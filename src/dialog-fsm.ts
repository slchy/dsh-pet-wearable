/**
 * 一次语音会话的对话状态机 —— 现在是**确定性内核的薄门面**。
 *
 * <h2>为什么要有它</h2>
 *
 * 早先这里是五个互相牵制的布尔量：`speaking` / `playing` / `bargeIn` /
 * `queueGen` / `endRequested`。它们的合法组合从来没被写下来过，于是每修一个
 * bug 就多一个特判，又引出下一个 bug：
 *
 * - `playing` 只在 TTS 生成的那 1 s 内为真，播放期 20 s 里插话不触发打断
 *   → 加一个「播放等待也要置 playing」的特判
 * - 打断只停声音不清队列，用户问到第三句时 agent 还在答第一句
 *   → 再加一个 `queueGen`
 * - `bargeIn` 需要在每轮开头手工复位，漏一次就整轮被当成已打断
 *
 * 这些都不是独立缺陷，是**没有状态定义**的症状。
 *
 * <h2>相位定义在哪</h2>
 *
 * **不在这个文件里。** 相位的定义、拒绝条件、副作用（`stopDeviceAudio` /
 * `invalidateTurn` / `abortEngine` / `settleTurn`）全部在
 * [`kernel.ts`](./kernel.ts) 的 `dialog` 区域：这个类只做三件事 ——
 *
 * 1. 把方法调用翻译成一条 {@link KernelEvent} 派发给 {@link KernelRuntime}
 *    （走 `dispatchAndApply`：装配层绑了端口就执行内核声明的意图，没绑就只推状态）；
 * 2. 所有 getter 直接读 `runtime.state.dialog`（**不再有第二份** `_turn` / `_gen` /
 *    `_endAfterSpeech` / `_receiptOnly` / `_lastWhy`）；
 * 3. 订阅 `runtime` 的转移，把「相位变了」翻译成 `onState`、内核声明的
 *    `invalidateTurn` 意图翻译成 `onInvalidate`（日志也在这里打）。
 *
 * 这样相位只有一份：`TurnRunner` / `DialogRuntime` / `VoiceConnection` 看到的是
 * 同一个 `KernelRuntime` 的快照，不会出现「状态机说 speaking、内核说 thinking」。
 *
 * <h2>状态与转移</h2>
 *
 * ```text
 *   listening ──句子定稿──▶ thinking ──首块音频写出──▶ speaking
 *        ▲                    │                          │
 *        │                    │ audioDone(t)             │ audioDone(t)
 *        │                    │ （无音频 / 出错）         │ endAfterSpeech=false
 *        └────────────────────┴──────────────────────────┘
 *
 *   speaking  ──audioDone(t) 且 endAfterSpeech=true──▶ ending ──收尾完成──▶ closed
 *   listening ──requestEnd()（不在播，没有告别语要等）──▶ ending
 *   speaking  ──bargeIn()────────────────────────────▶ listening（代次 +1）
 *   任意状态  ──断连 / 致命错误─────────────────────▶ closed
 *
 *   thinking  ──receiptStarted()（回执出声）──▶ speaking ──receiptEnded()──▶ thinking
 *
 *   listening ──说「看清细节」──▶ awaiting_shot ──拿到高清图──▶ thinking
 *                                     │  ▲
 *                                     │  └── 手机回报「相册就绪」（顺带播提示语，状态不变）
 *                                     └───── 用户改主意 / 收尾 ──▶ listening / ending
 * ```
 *
 * `audioDone` 是**事件**不是状态：它在 `thinking` 或 `speaking` 内部完成判定，
 * 落点只取决于「本轮请求过结束没有」。
 *
 * 关键约束（都是真机日志换来的）：
 *
 * 1. **只有 `speaking` 能被打断**。`thinking` 期间用户说话不算插话 ——
 *    否则 TTS 首块到达前那 ~1 s 里的一句正常话会打断掉还没出声的回复
 *    （实测：回放 0 字节被中断）。
 *    判据是**有没有声音**，不是「有没有在等模型」：委派轮那句「我看看」
 *    （见 `TurnRunner.speakReceipt`）在 `thinking` 期间就已经出声，用户听完
 *    然后说「不用了」是明确的插话。所以回执要把状态推进 `speaking`
 *    （{@link DialogFsm.receiptStarted}），播完再退回 `thinking`
 *    （{@link DialogFsm.receiptEnded}，靠 `receiptOnly` 跟真回答区分）。
 * 2. **`speaking` 覆盖整段播放**，直到音频真的播完才离开。不是「TTS 生成结束」
 *    就结束（实测：13 轮只成功打断 1 次）。
 * 3. **插话即作废排队轮次**。一轮 = dsh 2–5 s + 播放 5–20 s，用户在此期间说的
 *    每句都会排队；实测积压到 40 s，用户已经问到「退出」，agent 还在回答
 *    36 秒前的「拖一下」。
 *
 * <h2>票据（ticket）</h2>
 *
 * 票据是 `{no, gen}` 两段，各解决一个独立问题：
 *
 * - `gen`（代次）：**插话**时 +1，用来作废排队中还没开跑的轮次。
 * - `no`（轮次号）：每开一轮 +1，用来**丢弃上一轮迟到的回调**。
 *
 * 为何不能只用一个：相邻两轮之间若没发生插话，代次相同，那么上一轮迟到的
 * `audioDone` 就会把新一轮从 `speaking` 提前切回 `listening`。所以
 * `audioStarted` / `audioDone` 都要求 `no` 等于当前轮次。
 *
 * 票据由内核在 `beginTurn` 时铸造，并在那一刻锁存**因果水位线**
 * （`baseCommitSeq` / `startedAtMs`，见 {@link DialogFsmContext}）。此后这张票上的
 * 值不再变 —— 迟到的转写拿**它自己那一轮**的基线去比，才不会「自己打断自己」。
 *
 * <h2>明确定义的行为（以前没写下来，容易各读一套）</h2>
 *
 * - **`thinking` 期间用户说话**：不算插话。这句话走正常的句子合并，成为
 *   **排在当前轮之后的新一轮**。此时回复还没出声，打断它等于丢掉一个已经
 *   算好的回答；而直接丢掉用户刚说的话更糟。
 * - **告别语可被打断**：`requestEnd()` 只置标志，状态保持 `speaking` 直到播完，
 *   所以告别语期间插话仍然生效（取消结束、回 `listening`）。
 * - **`audioDone` 是服务端估算**（下发字节数 ÷ 采样率 + 余量），不是客户端回执。
 *   所以 `speaking` 结束得比真实出声略晚，插话窗口也略宽 —— 偏保守方向。
 * - **插话不取消上游 dsh 请求**（无法中断），只是停止消费其输出；
 *   对话历史里那条助手回复仍是完整文本，不截断。已知限制。
 *
 * <h2>`awaiting_shot`：等用户按快门</h2>
 *
 * 高清照必须由**人按下快门**才会落盘（程序化快门不写相册，见
 * `EXPERIMENTS.md §38.5`），所以「等一张照片」是一段真实存在的、几十秒的对话时间。
 * 把它塞进 `thinking` 会得到三个后果，都实测发生过：用户在等的时候说话被排队、
 * 收尾命令取消不了它、指示灯一直停在「思考」。
 *
 * 规矩（和第 1 条约束一致：**能不能打断由状态定，不由特判定**）：
 *
 * - 它属于 **listening 一族**：用户说话天经地义，所以不参与 `bargeIn`
 * - 用户在 `awaiting_shot` 里说话 = **改主意**：取消拍照，新句子重新判意图
 * - 取消**不靠票据**：这期间代次不会变，`isStale` 永远是 false。取消只走
 *   `utterance` / `requestEnd` / `closed` 三条边 —— 别在这里加 stale 判定
 * - 提示语（"请按一下快门"）不改状态：它是 `awaiting_shot` 内部的旁白
 */
import { KernelRuntime } from './kernel-runtime.ts';
import type { DialogState, Effect, KernelEvent, TurnTicket } from './kernel.ts';

/**
 * `DialogState` / `TurnTicket` 的**定义在内核**（`kernel.ts` 的 `dialog` 区域是相位的
 * 唯一真相源）。这里只转出：既让全仓 `from './dialog-fsm.ts'` 的导入保持可用，
 * 也断掉 `kernel.ts ↔ dialog-fsm.ts` 的模块环。
 */
export type { DialogState, TurnTicket };

/**
 * 票据上那两个**随时间变化**的字段从哪来：装配层注入，FSM 自己不认识 ASR。
 *
 * 为什么不能放进构造参数属性：Node 的类型擦除不支持参数属性（见下面的说明）。
 */
export interface DialogFsmContext {
  /** 已经发出几发 ASR commit（单调） */
  readonly baseCommitSeq?: () => number;
  readonly now?: () => number;
}

export class DialogFsm {
  /**
   * 唯一的内核运行时。
   *
   * 默认自己新建一个（单测/离线场景够用）；装配层可以传进来共享 —— 一个会话只该
   * 有一份 `KernelState`（`SessionCore.runtime` 会把它透出去）。
   */
  readonly runtime: KernelRuntime;
  /**
   * 日志出口。
   *
   * 注意：**不能**写成构造函数参数属性 `constructor(private readonly log: ...)`。
   * Node 22 的类型擦除（strip-types）不支持参数属性，会抛
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` —— 编译期 tsc 发现不了，
   * 只有真正跑起来才炸。
   */
  private readonly log: (line: string) => void;
  /** 「本轮被作废」的订阅者（见 {@link onInvalidate}） */
  private readonly invalidateListeners: Array<(reason: 'bargeIn' | 'closed') => void> = [];
  /** 状态转移的观察者（只读，不参与决策） */
  private readonly stateListeners: Array<(state: DialogState, why: string) => void> = [];
  /** 票据上那两个随时间变化的字段的来源（见 {@link DialogFsmContext}） */
  private readonly context: DialogFsmContext;

  constructor(
    log: (line: string) => void,
    context: DialogFsmContext = {},
    runtime?: KernelRuntime,
  ) {
    this.log = log;
    this.context = context;
    this.runtime = runtime ?? new KernelRuntime();
    // 单点订阅：相位变化 → onState；内核声明的 `invalidateTurn` 意图 → onInvalidate。
    // 顺序与旧实现一致：**先**状态监听者，**后**作废监听者（取消上游时状态已经是新的）。
    this.runtime.subscribe((prev, next, _event, effects) => {
      const from = prev.dialog.phase;
      const to = next.dialog.phase;
      if (from !== to) {
        const why = next.dialog.lastWhy;
        this.log(`  状态    ${from} → ${to}   (${why})`);
        for (const cb of [...this.stateListeners]) {
          cb(to, why);
        }
      }
      // 作废通知唯一来源是内核声明的 `invalidateTurn` 意图（不再按事件名和相位重算一遍）。
      // 顺序保持不变：先 `onState`，后 `onInvalidate`。
      for (const effect of effects) {
        if (effect.type === 'invalidateTurn') {
          for (const cb of [...this.invalidateListeners]) {
            cb(effect.reason);
          }
        }
      }
    });
  }

  get state(): DialogState {
    return this.runtime.state.dialog.phase;
  }

  /** 最近一次转移的原因，给档案补 `why` 用 */
  get lastTransitionReason(): string {
    return this.runtime.state.dialog.lastWhy;
  }

  /** 本轮编号，从 1 开始 */
  get turn(): number {
    return this.runtime.state.dialog.turn;
  }

  get gen(): number {
    return this.runtime.state.dialog.gen;
  }

  /**
   * 本轮是否已被标记为「播完就结束」。
   *
   * 只读观测点，供形式化验证与诊断使用 —— 它不参与任何外部判定，
   * 暴露它是为了让验证脚本能识别「同状态但标志不同」的配置，
   * 否则会把两个行为不同的配置误当成同一个。
   */
  get endAfterSpeech(): boolean {
    return this.runtime.state.dialog.endAfterSpeech;
  }

  /**
   * 当前代次的票据。入队任务应当持有它，出队时用 {@link isStale} 校验。
   *
   * 还没有过一轮（或刚被插话清掉）时按当前 `{no, gen}` 现造一张：调用方拿它当
   * **身份**用，不是当因果水位线用（水位线由 `kernel.ts` 的 `isPreTurnCommit` 判）。
   */
  ticket(): TurnTicket {
    const dialog = this.runtime.state.dialog;
    if (dialog.ticket !== null) {
      return dialog.ticket;
    }
    return { no: dialog.turn, gen: dialog.gen };
  }

  /**
   * 订阅「状态变了」。
   *
   * 宿主用它记「这一轮是什么时候开的」—— 判断一条转写是开轮前录的还是开轮后的，
   * 只有它知道（见 `VoiceSession.turnStartedAt`）。回调里不要做耗时的事。
   *
   * @returns 退订函数
   */
  onState(cb: (state: DialogState, why: string) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const at = this.stateListeners.indexOf(cb);
      if (at >= 0) {
        this.stateListeners.splice(at, 1);
      }
    };
  }

  /**
   * 订阅「本轮被作废」：插话与连接结束。
   *
   * 这是**上游取消**的唯一触发点（`TurnRunner` 收到就调 `agent.cancelTurn(ticket)`）——
   * 别再在别处按状态猜：`bargeIn` 只在这里发生，`close` 也只在这里。
   *
   * @returns 退订函数
   */
  onInvalidate(cb: (reason: 'bargeIn' | 'closed') => void): () => void {
    this.invalidateListeners.push(cb);
    return () => {
      const at = this.invalidateListeners.indexOf(cb);
      if (at >= 0) {
        this.invalidateListeners.splice(at, 1);
      }
    };
  }

  /**
   * 该票据是不是**已经被顶掉**（只比代次）。
   *
   * 与 {@link isCurrent} 合起来才等于 `causal.ts` 的 `isStaleTicket`：本类刻意把
   * 两件事拆开，"哪一轮"和"被插话几次"是不同的因果量，别在一处比完。
   */
  isStale(t: TurnTicket): boolean {
    return t.gen !== this.runtime.state.dialog.gen;
  }

  /** 该票据是否仍属于当前这一轮（排除上一轮迟到的回调） */
  isCurrent(t: TurnTicket): boolean {
    return t.no === this.runtime.state.dialog.turn;
  }

  /**
   * 开一轮：`listening | awaiting_shot → thinking`。
   *
   * `awaiting_shot` 是合法前驱：高清照到手或明确失败之后，那一轮才真正开跑。
   *
   * @returns 该轮票据；已在收尾/已关闭时返回 `null`，调用方应直接放弃这一轮
   */
  beginTurn(): TurnTicket | null {
    const phase = this.runtime.state.dialog.phase;
    if (phase === 'ending' || phase === 'closed') {
      this.log(`  状态    ✗ 拒绝开新一轮（当前 ${phase}）`);
      return null;
    }
    if (phase !== 'listening' && phase !== 'awaiting_shot') {
      // **`thinking` 是合法前驱，不是调度 bug。** 用户在模型还在跑的时候又说了一句
      // （真机上一半的句中停顿都走这条路），轮次 +1 让旧票过期，旧轮的结果会被
      // `isStale` 丢弃 —— 这正是「出声前吸收窗口」的实现方式。
      // 把它记成异常会让人以为要修，而修掉它就等于取消吸收窗口。
      this.log(
        `  状态    ${phase} 期间又说了一句 → 第 ${this.turn + 1} 轮取代它（旧票作废）`,
      );
    }
    const base = this.context.baseCommitSeq?.();
    const at = this.context.now?.();
    this.send({
      type: 'beginTurn',
      atMs: at ?? 0,
      ...(base === undefined ? {} : { baseCommitSeq: base }),
      ...(at === undefined ? {} : { startedAtMs: at }),
    });
    return this.ticket();
  }

  /**
   * 进去等一张高清照：`listening → awaiting_shot`。
   *
   * @returns 票据；不在 `listening` 时返回 `null`（调用方按普通轮次处理）
   */
  beginAwaitShot(): TurnTicket | null {
    const phase = this.runtime.state.dialog.phase;
    if (phase !== 'listening') {
      this.log(`  状态    ⚠ 在 ${phase} 时想等高清照，忽略`);
      return null;
    }
    this.send({ type: 'beginAwaitShot' });
    return this.ticket();
  }

  /** 不拍了（用户改主意）：`awaiting_shot → listening`。代次不变。 */
  abortAwaitShot(why: string): void {
    this.send({ type: 'abortAwaitShot', why });
  }

  /** 首块音频真正写出：`thinking → speaking` */
  audioStarted(t: TurnTicket): void {
    this.send({ type: 'audioStarted', ticket: t });
  }

  /**
   * 回执开始出声：`thinking → speaking`。
   *
   * 为什么要进 `speaking` 而不是留在 `thinking`：本类的第 1 条规矩是
   * **「能不能打断由状态定」**（见顶部说明）。回执是用户真能听见的声音，
   * 留在 `thinking` 就等于告诉全系统「这段不可打断」—— 用户听完「我看看」
   * 开口说「不用了」，会被当成同一句的下文合并，而不是插话。
   *
   * 它和真正的回答音频共用 `speaking`，靠 `receiptOnly` 区分：
   * 回执自然播完回 `thinking`（答案还在路上），被音频接管则由 `audioStarted` 清标志。
   *
   * @returns 有没有真的进 `speaking`；`false` = 这一轮已经不在等答案（被插话作废 /
   *   已收尾），这时候不该出声
   */
  receiptStarted(): boolean {
    if (this.runtime.state.dialog.phase !== 'thinking') {
      return false;
    }
    this.send({ type: 'receiptStarted' });
    return true;
  }

  /** 回执这段 `speaking` 结束：回 `thinking` 继续等答案。不动代次。 */
  receiptEnded(): void {
    this.send({ type: 'receiptEnded' });
  }

  /** 这段 `speaking` 是不是只有回执（真音频还没开始） */
  get speakingIsReceiptOnly(): boolean {
    return this.runtime.state.dialog.receiptOnly;
  }

  /**
   * 用户插话。**只有 `speaking` 成立**。
   *
   * 成立时代次 +1，从而作废所有还在排队的轮次。
   *
   * @param commitSeq 产出这段转写的那一发 ASR commit。给了就先过因果屏障：
   *   开轮前录的那段迟到转写不算插话（`causal.ts`）
   * @returns 是否真的构成插话
   */
  bargeIn(why: string, commitSeq?: number): boolean {
    if (this.runtime.state.dialog.phase !== 'speaking') {
      return false;
    }
    const gen = this.runtime.state.dialog.gen;
    const at = this.context.now?.() ?? 0;
    this.send({
      type: 'bargeIn',
      why,
      atMs: at,
      ...(commitSeq === undefined ? {} : { commitSeq }),
    });
    // 以**代次真的推进了**为准：带 `commitSeq` 时可能被因果屏障挡下（开轮前录的那段
    // 迟到转写），那时相位不变、也不该告诉调用方"打断成立了"。
    return this.runtime.state.dialog.gen !== gen;
  }

  /**
   * 本轮音频结束（自然播完、无音频、或出错）。
   *
   * 这是**事件**：从 `thinking` 或 `speaking` 出发，落点由 `endAfterSpeech` 决定。
   * 上一轮迟到的调用会被 `no` 挡掉。
   */
  audioDone(t: TurnTicket): void {
    this.send({ type: 'audioDone', ticket: t });
  }

  /**
   * 模型要求结束。
   *
   * - 在 `speaking`：只置标志，等这段播完再进 `ending`（告别语不截断）
   * - 在 `thinking`：同样只置标志，等本轮音频结束（可能还有告别语）
   * - 在 `listening` / `awaiting_shot`：没有音频要等，直接进 `ending`
   *   （`awaiting_shot` 的拍照请求由调用方在收到 `ending` 时一并取消）
   */
  requestEnd(): void {
    const phase = this.runtime.state.dialog.phase;
    this.send({ type: 'requestEnd' });
    if (phase === 'thinking' || phase === 'speaking') {
      this.log(`  状态    ${phase}（本轮音频结束后再收尾）`);
    }
  }

  /** 连接收尾。任何状态都可以直接进 `closed`（吸收态）。 */
  close(): void {
    this.send({ type: 'closed' });
  }

  /**
   * 派发一条事件，并保留「已 closed 时迟到的回调被忽略」这条诊断。
   *
   * 走 {@link KernelRuntime.dispatchAndApply}：绑了端口（`DialogRuntime` 装配层）时，
   * 内核声明的意图**在这里执行，且只执行这一次** —— 门面不再另派一份 `audio.stop`。
   * 没绑端口（纯推演 / 单测 / 形式化验证）时它只推状态，与 `dispatch` 等价。
   *
   * 内核是纯函数、不写日志；这条日志只有门面知道（它知道调用方想干什么）。
   *
   * @returns 内核声明的意图（调用方只读，不要自己再执行一遍）
   */
  private send(event: KernelEvent): readonly Effect[] {
    const before = this.runtime.state.dialog.phase;
    const effects = this.runtime.dispatchAndApply(event);
    const after = this.runtime.state.dialog.phase;
    if (before === 'closed' && after === 'closed' && event.type !== 'closed') {
      this.log(`  状态    ⚠ 已 closed，忽略 ${event.type}`);
    }
    return effects;
  }
}
