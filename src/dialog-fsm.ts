/**
 * 一次语音会话的对话状态机。
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
 * <h2>状态</h2>
 *
 * ```text
 *           句子定稿               首块音频下发
 *  listening ────────▶ thinking ────────────────▶ speaking
 *      ▲                   │                        │
 *      │                   │ 模型要求结束            │ 音频播完
 *      │                   ▼                        ▼
 *      │                ending ◀──────────────── (audioDone)
 *      │                   │
 *      └── 插话（仅 speaking 允许）   closed
 * ```
 *
 * 关键约束（都是真机日志换来的）：
 *
 * 1. **只有 `speaking` 能被打断**。`thinking` 期间用户说话不算插话 ——
 *    否则 TTS 首块到达前那 ~1 s 里的一句正常话会打断掉还没出声的回复
 *    （实测：回放 0 字节被中断）。
 * 2. **`speaking` 覆盖整段播放**，直到音频真的播完才回 `listening`。
 *    不是「TTS 生成结束」就结束（实测：13 轮只成功打断 1 次）。
 * 3. **插话即作废排队轮次**。一轮 = dsh 2–5 s + 播放 5–20 s，用户在此期间
 *    说的每句都会排队；实测积压到 40 s，用户已经问到「退出」，
 *    agent 还在回答 36 秒前的「拖一下」。
 *
 * 约束 3 靠**代次（generation）**实现，它同时替代了原来的 `bargeIn` 与
 * `queueGen`：插话 = 代次 +1，所有持旧代次票据的任务自动过时。
 */

export type DialogState = 'listening' | 'thinking' | 'speaking' | 'ending' | 'closed';

/** 一轮的票据。轮次号用于日志/落盘，代次用于判断是否已被插话作废。 */
export interface TurnTicket {
  readonly no: number;
  readonly gen: number;
}

export class DialogFsm {
  private _state: DialogState = 'listening';
  private _turn = 0;
  private _gen = 0;
  /** 模型已经要求结束：等这段音频播完再走 `ending` */
  private _endAfterSpeech = false;
  /**
   * 日志出口。
   *
   * 注意：**不能**写成构造函数参数属性 `constructor(private readonly log: ...)`。
   * Node 22 的类型擦除（strip-types）不支持参数属性，会抛
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` —— 编译期 tsc 发现不了，
   * 只有真正跑起来才炸。
   */
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  get state(): DialogState {
    return this._state;
  }

  /** 本轮编号，从 1 开始 */
  get turn(): number {
    return this._turn;
  }

  get gen(): number {
    return this._gen;
  }

  /** 当前代次的票据。入队任务应当持有它，出队时用 {@link isStale} 校验。 */
  ticket(): TurnTicket {
    return { no: this._turn, gen: this._gen };
  }

  /** 票据是否已过时（用户插话过） */
  isStale(t: TurnTicket): boolean {
    return t.gen !== this._gen;
  }

  /**
   * 开一轮：`listening → thinking`。
   *
   * @returns 该轮票据；已在收尾/已关闭时返回 `null`，调用方应直接放弃这一轮
   */
  beginTurn(): TurnTicket | null {
    if (this._state === 'ending' || this._state === 'closed') {
      this.log(`  状态    ✗ 拒绝开新一轮（当前 ${this._state}）`);
      return null;
    }
    if (this._state !== 'listening') {
      // 串行队列保证不会到这里；真到了就是调度 bug，必须看见
      this.log(`  状态    ⚠ 在 ${this._state} 时开新一轮，按 thinking 处理`);
    }
    this._turn += 1;
    this.transition('thinking', `第 ${this._turn} 轮`);
    return this.ticket();
  }

  /** 首块 TTS 真正写出：`thinking → speaking` */
  audioStarted(t: TurnTicket): void {
    if (this.isStale(t)) return;
    if (this._state === 'thinking') {
      this.transition('speaking', '首块音频已下发');
    }
  }

  /**
   * 用户插话。**只有 `speaking` 成立**。
   *
   * 成立时代次 +1，从而作废所有还在排队的轮次。
   *
   * @returns 是否真的构成插话
   */
  bargeIn(why: string): boolean {
    if (this._state !== 'speaking') {
      return false;
    }
    this._gen += 1;
    this._endAfterSpeech = false;
    this.transition('listening', `插话「${why}」→ 代次 ${this._gen}`);
    return true;
  }

  /** 本段音频结束（自然播完，或已被插话）。`speaking → listening | ending` */
  audioDone(t: TurnTicket): void {
    if (this.isStale(t)) {
      // 已经被插话推进过状态了，不能重复推进
      return;
    }
    this.transition(this._endAfterSpeech ? 'ending' : 'listening', '音频播完');
  }

  /** 模型要求结束。正在播则等播完再走 `ending`。 */
  requestEnd(): void {
    this._endAfterSpeech = true;
    if (this._state !== 'speaking') {
      this.transition('ending', '模型要求结束');
    } else {
      this.log('  状态    speaking（播完这段再结束）');
    }
  }

  /** 连接收尾 */
  close(): void {
    this.transition('closed', '连接结束');
  }

  private transition(to: DialogState, why: string): void {
    if (this._state === to) {
      return;
    }
    this.log(`  状态    ${this._state} → ${to}   (${why})`);
    this._state = to;
  }
}
