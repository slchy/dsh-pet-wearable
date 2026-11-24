/**
 * 会话档案（`events.jsonl`）里的事件名，**唯一定义处**。
 *
 * <h2>为什么要有这一份</h2>
 *
 * 这些名字在两侧各出现一次：
 * - **写**：`archive.event(...)` / `onEvent?.(...)`
 * - **读**：`latency-report.ts` 的分段计算、`scripts/dsh-timeline.ts` 的对齐
 *
 * 以前两侧各写一遍字面量，靠人肉保持一致。拼错**不会报错** —— 写入侧多打一个
 * 字母，报告那边只会显示「缺仪表」，看起来像"这条连接确实没判停"，而不是
 * "代码写错了"。这类静默失败比崩溃难查得多。
 *
 * 值本身就是档案格式的一部分（旧档案里是这些字符串），**不要改**，只加。
 */

/** 档案事件名。键是代码里的可读名，值落进 `events.jsonl`。 */
export const EVENTS = {
  // ---- 连接生命周期（`archive.ts` 自己写） ----
  open: 'open',
  close: 'close',

  // ---- 上行音频门 ----
  /** 能量门打开：开始往 STT 推 */
  gateOpen: 'gate.open',
  /** 能量门关闭。带 `gapMs`（距最后一个有声块多久）—— 真实「停嘴」时刻是 `t - gapMs` */
  gateClose: 'gate.close',
  /** 话筒打开 */
  micOpened: 'mic.opened',
  /** 唤醒词命中 */
  wake: 'wake',

  // ---- ASR ----
  asrPartial: 'asr.partial',
  /** 一句定稿。**不是**轮次边界，见 `utterance-assembler.ts` */
  asrSentence: 'asr.sentence',
  /**
   * 请求 ASR **封段**（`commit()`）—— 端点由我们控时才走这条。
   *
   * `silence_ms` = 距最后一个有声帧多久，`want_ms` = 配置的 `commitAfterMs`。
   * 两数之差就是「静音开始 → 真有音频帧到达」的等待：所有按静音计时的动作
   * （封段 20 / 投机 100 / 判停预跑 200）都跑在 `trackSilence` 里，而它只在
   * `addAudio` 时调 —— 上行包多大、设备静音时推不推帧，直接变成每轮的固定开销。
   * 不记这一条，「停嘴→封段」永远只能靠猜。
   */
  asrCommit: 'asr.commit',
  asrError: 'asr.error',

  // ---- 一轮对话 ----
  turnStart: 'turn.start',
  /** TTS 首块耗时（`ms`）。延迟复算的关键仪表之一 */
  ttsFirst: 'tts.first',
  /**
   * 单个 TTS task 的两段耗时，**常开**（不是调试探针）。
   *
   * `setup_ms` = run-task → task-started（还没轮到我们 / 进程被卡）；
   * `first_ms` = 首批文本送出 → 首块音频（合成）。
   * 这两段慢起来长得一模一样，治法完全不同 —— 见 `docs/OPS-RECORD.md` §12.8.1。
   */
  ttsTask: 'tts.task',
  /**
   * 一个**流式** task 的分批送达明细，任务收尾时落一次。
   *
   * `tts.task` 答不了的问题是：首包慢的时候，后面那几批文本到底什么时候才送上去。
   * 首批只送一两个字，流式合成通常要攒到一段才出声 —— 如果模型在首字之后卡住，
   * 慢的就是我们这侧，可 `first_ms` 看起来和厂商慢一模一样。
   *
   * `head` / `tail` 每项是 `[累积字数, 相对 run-task 毫秒, 这批是否以标点结尾]`；
   * 第三个用 0/1 而不是布尔，跟别的数值字段一样能直接求和。
   * 只记前几批和最后一批：首包只和开头有关，逐批全记会把档案撑大。
   */
  ttsDone: 'tts.done',
  /** 首个输出 token 耗时（`ms`）。与 ttsFirst 之间夹着"整段生成"那一段 */
  llmFirst: 'llm.first',
  /** 一轮结束。带 `dsh_session` 时可与 dsh 自己的会话档案对齐 */
  turnEnd: 'turn.end',
  /**
   * 每条 TCP 连接自己的重传 / RTO（`ss -tin` 读出来的每 socket 累计值）。
   *
   * **为什么不能只用 `turn.end.net_*`**：那是**整机**计数 —— 分不出是谁在重传。
   * 2026-11-21 第一场带 `net_*` 的真机里，一轮冒出 `retrans 388 / lost_retrans 149`，
   * 而那一轮的 TTS 首包完全正常；几百字节的 JSON 不可能重传 388 次。所以那个数字
   * 里混着服务器→手机的音频下行（或别的连接），**不能拿来给 TTS/ASR 归因**。
   *
   * 在 `turn.end` **之后异步**采一次（不占关键路径），按对端地址落盘。
   */
  netSockets: 'net.sockets',
  /**
   * **首块迟迟不到时**在 600 ms 看门狗里采的那一条连接的现场（`tts.stall`）。
   *
   * 为什么不复用 `net.sockets`：那是在 `turn.end` **之后**采的。等首块回来、
   * 甚至等这一轮结束，内核早就把 `unacked` 清零、`rto` 退回 ~250 ms 了 ——
   * 2026-11-22 那场 4291 ms 就是因为只在事后采，分不出是链路丢包还是厂商不出音频。
   *
   * 字段：`elapsed_ms`（请求送出去多久了）、`local_port`（用来精确采这一条）、
   * `socket`（`SocketStat`，取不到是 `null`）。
   *
   * `socket.retrans` 是**累计值**（`retrans:x/Y` 的 Y，不随恢复归零），所以
   * 「本轮到底有没有往外重传」= 本条 `socket.retrans` − 上一轮 `net.sockets` 里
   * **同一个 `local`** 的 `retrans`。这就是 `local` 字段的用途。
   */
  ttsStall: 'tts.stall',

  // ---- 模型的输入/输出（审计用，全量不截断）----
  //
  // 为什么单独一组而不是塞进 `turn.end`：**预跑和投机不一定会变成一轮**。
  // 判停并了段、换了一句、插话作废 —— 这些请求已经发出去、模型也已经答了，
  // 但永远不会走到 `turn.end`。不在这里留痕，就只剩 console 里截断的那 120 字。
  /** 请求**发出去**的那一刻：`{kind, model, hedge, text, msgs}`（`msgs` 是全量 messages） */
  agentAsk: 'agent.ask',
  /** 请求**落定**：`{kind, ok, ms, first_token_ms, raw, opened, delegated}` 或 `{ok:false, err}` */
  agentDone: 'agent.done',
  /** 请求被主动作废（换一句 / 判停并段 / 不走快车道 / 文本对不上） */
  agentDrop: 'agent.drop',
  /** 预跑被认领与否 —— 「抢话时它答得快不快」和「这份答案有没有被用上」是两件事 */
  agentClaim: 'agent.claim',
  /**
   * 投机被定稿确认时，**投机文本与定稿差在哪几个字**。
   *
   * 认领只要求「去尾标点的投机是定稿前缀 + 覆盖 ≥60%」，所以被认下来的那一版
   * 常常缺着句尾 —— 真机 `20261119-080409` 轮 4 缺「蓝母吗」、轮 5 缺「佛拉尼斯」，
   * 而缺的正好是**宾语**，模型只能反问。这种轮次看 `tts.first` 完全正常，
   * 只有把 `spec` / `missing` 并排落档，事后才知道「答非所问」是不是投机认下来的。
   */
  agentSpec: 'agent.spec',
  /**
   * 一条**复用失败**的 HTTP 连接（`ECONNRESET` / `EPIPE` / `UND_ERR_SOCKET`）。
   *
   * 这类错误和「模型超时」「429」是两件事：它说明客户端的保活时长
   * （`MIAI_HTTP_KEEPALIVE_MS`，见 `http-agent.ts`）压过了服务端的空闲超时。
   * 2026-11-19 实测 DashScope 在空闲 60 秒后仍复用成功，所以线上取 50 秒；
   * 这条事件是那个数的唯一依据，一旦出现就该往下调。
   */
  agentConn: 'agent.conn',
  /**
   * `pending` 触到硬上限、丢掉最老的几轮。
   *
   * 这是**静默丢上下文**：那几轮 dsh 以后永远看不到。`keepTurns=0`（永不因计数
   * 强制委派）时 `pending` 只在真正需要 dsh 的轮次才清空，长时间纯聊天就会触顶。
   * 落档是为了以后能回答「dsh 知不知道刚才聊了什么」。
   */
  agentTrim: 'agent.trim',
  /** 委派轮先说的那句「嗯，我想想」（`text` + `chars`），它不在 `turn.end.said` 里 */
  receipt: 'receipt',
  /**
   * 状态机的一次转移（`from` → `to`）。
   *
   * 轮次的四段时序（停嘴 → ASR → 开轮 → 首块）只能说明「快不快」，
   * 「状态轮转对不对」得看这条：`tts.first` 有没有落在 `speaking` 里、
   * 一轮结束后有没有回到 `listening`、`closed` 之后有没有人把状态拉回去。
   *
   * **`why` 是必须的**：同一个 `thinking → speaking` 既可能是「首块音频下发」，
   * 也可能是「委派轮的回执出声」（见 `DialogFsm.receiptStarted`）。没有 `why`
   * 就分不出来，而这两件事对着延迟/打断的含义完全相反 —— 前者表示答案开始了，
   * 后者只是填补安静，真答案还在路上。
   */
  dialogState: 'dialog.state',

  /**
   * 判停器的一次决定（`UtteranceAssembler` 写）。
   *
   * `② 定稿→开轮` 这个数字在档案里一直是个黑盒：它可能只有 1 ms（判停当场收下），
   * 也可能 2400 ms（判停连说六次「没说完」，每拍等 400 ms）。不看 `p` 就分不清
   * 是「在等设备静音窗」还是「排队」，而这两种原因的修法完全相反。
   */
  judge: 'judge.decide',

  /**
   * omni 影子旁路：一份 seal 的「封段 → 首块音频」。
   *
   * 为什么要它：omni 一体模型能省掉 `①b 定稿 + ② 开轮`，但**必须从封段起跑**
   * （实测 `response.create` 每推迟 1 ms 首块就晚 1 ms，晚 241 ms 就输给我们）。
   * 代价是并段/委派轮要 cancel，进而留下脏历史 —— 要不要接管整条快车道，
   * 只能靠这份数据判。
   *
   * `seq` 与 `asr.commit` 同源，两份事件一一对应；`audio_ms` 与 `turn.end` 的
   * `①b+②+③` **同起点**（都在 `onCommit` 那一行），可以直接相减。
   */
  omniShadow: 'omni.shadow',

  /**
   * 「这一轮会不会走 omni 直出」的判据快照（`{has_lane, lane_ok, text_ok, ok}`）。
   *
   * 为什么要它：`path=omni` 没出现时，光看档案分不出是「车道没挂上」「还没起跑」
   * 「被取消了」「并段轮被 clip 档挡掉」还是「文本判据挡掉」—— 五种原因修法完全不同。
   * 和 `omni.shadow` 配着看：那个说「测到了」，这个说「为什么没用」。
   */
  agentLane: 'agent.lane',

  // ---- 设备与下行 ----
  /** v2 设备自报能力 */
  deviceLink: 'device.link',
  /** 设备回执「播完了」 */
  devicePlayed: 'device.played',
  /** 设备发来的 v2 事件 */
  eventRecv: 'event.recv',
  /** 下行 v2 原语调用 */
  callSend: 'call.send',
  /** 下行控制串（`take_photo` / `stop` / `end_session` …） */
  ctlSend: 'ctl.send',
  /** 控制串被跳过（没有连接、正在关等） */
  ctlSkip: 'ctl.skip',
  /** v1 状态帧 */
  statusRecv: 'status.recv',

  // ---- 后台汇报 ----
  announce: 'announce',
  /** 补播：连上时把离线期间攒下的汇报一次性放出来 */
  announceReplay: 'announce.replay',
  /** 敲击撤掉了正在排队的后台汇报（不是一次主动开口） */
  announceDismissed: 'announce.dismissed',

  // ---- 宠物 ----
  petIn: 'pet.in',
  /** 状态机产出的意图（`phase.enter` / `end` / …） */
  petOut: 'pet.out',
  /** 一次主动开口的结局 */
  petOutcome: 'pet.outcome',
  /** 宠物开始朗读（还没出声；失败与打断都不会另造一条） */
  petSpeak: 'pet.speak',
} as const;

/** 任一事件名（值是上面那些字符串之一）。 */
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * 延迟报告里可能**缺席**的时刻。缺了记 `null`，不拿 0 冒充 ——
 * 否则历史基线会被伪造成「很快」。
 */
export const CRITICAL_MARKS = {
  gateClose: EVENTS.gateClose,
  asrSentence: EVENTS.asrSentence,
  ttsFirst: EVENTS.ttsFirst,
  turnEnd: EVENTS.turnEnd,
  turnStart: EVENTS.turnStart,
} as const;
