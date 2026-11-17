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
  asrError: 'asr.error',

  // ---- 一轮对话 ----
  turnStart: 'turn.start',
  /** TTS 首块耗时（`ms`）。延迟复算的关键仪表之一 */
  ttsFirst: 'tts.first',
  /** 首个输出 token 耗时（`ms`）。与 ttsFirst 之间夹着"整段生成"那一段 */
  llmFirst: 'llm.first',
  /** 一轮结束。带 `dsh_session` 时可与 dsh 自己的会话档案对齐 */
  turnEnd: 'turn.end',
  /**
   * 状态机的一次转移（`from` → `to`）。
   *
   * 轮次的四段时序（停嘴 → ASR → 开轮 → 首块）只能说明「快不快」，
   * 「状态轮转对不对」得看这条：`tts.first` 有没有落在 `speaking` 里、
   * 一轮结束后有没有回到 `listening`、`closed` 之后有没有人把状态拉回去。
   */
  dialogState: 'dialog.state',

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
  announceReplay: 'announce.replay',

  // ---- 宠物 ----
  petIn: 'pet.in',
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
