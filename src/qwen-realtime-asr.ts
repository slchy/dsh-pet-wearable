/**
 * DashScope 实时语音识别（`/api-ws/v1/realtime`）—— **端点由我们控**。
 *
 * 和 `aliyun-asr.ts`（NLS）最大的区别不在协议，而在**谁决定一句话什么时候结束**：
 *
 *   NLS：服务端 VAD 到 `max_sentence_silence` 就发 SentenceEnd，我们只能等；
 *        那个值官方范围 [200, 6000]，200 是地板。
 *   realtime：`turn_detection: null` 之后服务端**完全不判句**，等我们发
 *        `input_audio_buffer.commit` 才解码这一段。
 *
 * 所以静音窗从「服务端常量」变成「宿主的旋钮」，代价是 `commit` 一发出音频就被
 * 切走 —— 切早了会把字切两半。切点由 `UtteranceAssembler` 的静音计时决定。
 *
 * 实测（真机 `uplink.pcm` 122.8 s / 13 句，见 `bench/latency/probe-realtime-asr-turn.mjs`）：
 *   - `commit` → `.completed` 中位 **261 ms**（VAD 模式下 `speech_stopped` → 定稿 139–204 ms）
 *   - `silence_duration_ms` 填 150/100/50/0，回执会**原样回**，但实际判停时刻和 200
 *     完全重合（±13 ms）—— **回执是回声，不是承诺**
 *   - 一条连接挂 90 s 不发音频不会被关（NLS 会 `IDLE_TIMEOUT`）
 *   - `input_audio_buffer.clear` **不存在**（回 `invalid_value`），打断只能 commit 后扔结果
 *   - 空缓冲 `commit` 回 `maybe no invalid audio stream`，所以必须有 `dirty` 闸
 *
 * 事件字段（实测原样，别照文档猜）：
 *   `.text`      → `{ text: "", stash: "嗯。", language, emotion }` ← 增量在 **stash**
 *   `.completed` → `{ transcript: "嗯，见面了。", language, emotion, usage }`
 */
import WebSocket from 'ws';

import type { SttProvider } from './providers.ts';

const SAMPLE_RATE = 16_000;
const OPEN = 1;
const CLOSED = 3;
const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DEFAULT_MODEL = 'qwen3-asr-flash-realtime';
/** 解码窗口内最多暂存多少音频（正常解码 ~261 ms；2 s 是防挂死的上限） */
const MAX_HELD_BYTES = 32 * 2000;
/** 解码窗口内「还没开口」时保留的最近音频（150 ms，与 omni-shadow 一致） */
const RING_BYTES = 32 * 150;

/** 只用到这么点成员，抽出来是为了单测能塞假 socket。 */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: never[]) => void): void;
}

export type RealtimeSocketFactory = (url: string, apiKey: string) => RealtimeSocket;

export interface QwenRealtimeAsrOptions {
  apiKey: string;
  url?: string;
  model?: string;
  /**
   * 端点（句尾）归谁判：
   *
   * - `manual`（默认）：`turn_detection: null`，我们发 `input_audio_buffer.commit`
   *   才解码这一段。实测 `commit → 定稿` 中位 **261 ms**。
   * - `vad`：开服务端 VAD（`server_vad`），它自己判句尾，`speech_stopped → 定稿`
   *   实测 **139–204 ms**，比手动 commit 快。
   *
   * 为什么默认还是 `manual`：端点在谁手里决定了一堆旋钮的语义
   * （`VOICE_COMMIT_MS`、`VOICE_PAUSE_DETECT_MS`、组装器的封段逻辑）。
   * 走 `vad` 时那些旋钮**全都不生效**，静音窗变成服务端的下限 200 ms ——
   * 换之前先按 `docs/QWEN-REALTIME-ASR-PROBED.md` 的口径量一遍。
   */
  readonly turnDetection?: 'manual' | 'vad';
  /** `vad` 模式下的静音窗（服务端下限 200，填更小不生效 —— 见探针） */
  readonly vadSilenceMs?: number;
  /**
   * 一句封段后的定稿。
   *
   * @param commitSeq 产出这句的那一发 commit 的**因果出生证**（见 `causal.ts`）。
   *   宿主判「这段是不是开轮之前录的」只认它 —— 比到达时刻干净。
   */
  onSentence: (text: string, index: number, commitSeq?: number) => void;
  /**
   * 段内增量（`.text` 的 `stash`），会反复改写，不能拼。
   *
   * @param commitSeq 这段增量属于哪一发：解码窗口内是**正在解的那一发**
   *   （`decodingCommitSeq`，可能是旧段）；空闲时是用户新开口、尚未封段，
   *   其出生证是下一发（`commitSeq() + 1`）。
   */
  onPartial?: (text: string, commitSeq?: number) => void;
  onError?: (e: Error) => void;
  log?: (line: string) => void;
  /** 测试注入 */
  socketFactory?: RealtimeSocketFactory;
}

export class QwenRealtimeAsrError extends Error {}

interface ServerEvent {
  type?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  error?: { code?: string; message?: string };
}

export class QwenRealtimeAsr {
  private readonly opts: QwenRealtimeAsrOptions;
  private readonly log: (line: string) => void;
  private ws: RealtimeSocket | null = null;
  private ready = false;
  private connecting = false;
  private dropping = false;
  /** 未就绪时先攒着，别丢音频 */
  private backlog: Buffer[] = [];
  /**
   * 上次 `commit` 之后有没有**真正属于下一段**的新音频。
   *
   * 必须有这道闸：空缓冲 commit 会被服务端回 `maybe no invalid audio stream`。
   *
   * 但它只在**解码结束之后**才允许置位 —— 见 {@link awaitingDecode}。
   */
  private dirty = false;
  /**
   * 上一发 `commit` 发出去了、`.completed` 还没回来。
   *
   * **这期间 append 的音频属于上一条缓冲**，不属于下一段。实测 5 场 5 次
   * `maybe no invalid audio stream` 全部是这个原因：客户端把「解码窗口内推上去的
   * 音频」记成了新音频，于是第二次 commit 提交了一个服务端认为空的缓冲。
   * 反证在同一批档案里：那 5 次的定稿文本**全部完整**——多出来的那 200–300 ms
   * 早就被上一发解掉了。
   *
   * 清空点有两个，缺一个就会永久卡住：
   * - `.completed` → 解码结束，之后来的音频才算新的一段
   * - `.error` → 这一发废了，得重新武装，否则后面再也 commit 不出去
   */
  private awaitingDecode = false;
  /**
   * **解码窗口内的 PCM 先存本地**，定稿之后再推上去。
   *
   * 为什么必须存：实测（`tmp/omni-probe/asr-3cell.cjs`）在解码窗口里 append 的音频
   * **服务端直接丢掉** —— 既不进正在解的那一条（第一段定稿不含它），也不进下一条
   * （第二段定稿是空的）。两组都是 500 ms 真人语音，凭空消失。
   * 反过来（`asr-hold-fix.cjs`）只把同一段音频攒到定稿之后再推，两段定稿都齐。
   *
   * 上限按 2 s 兜：正常解码 ~261 ms，真卡住时宁可丢尾巴也不能无限涨内存。
   */
  private heldDuringDecode: Buffer[] = [];
  private heldBytes = 0;
  /**
   * 窗口内「还没开口」时留的最近几帧（防软起音被切掉）。
   *
   * 与 `omni-shadow` 的 mute+ring 同一套规则：没见过有声帧之前不攒，[`RING_BYTES`]
   * 一满就丢最老的。
   */
  private ringDuringDecode: Buffer[] = [];
  private ringBytes = 0;
  /** 窗口内已经见过有声帧（只用来记账，不再决定后面所有帧的去向） */
  private holdActive = false;
  /**
   * 上一次 `commit` 之后有没有人真的说过话。
   *
   * 与 {@link dirty} 的区别：`dirty` 说「缓冲里有音频」，这个说「**缓冲里有人声**」。
   * 能量门 `holdMs` 2 s 关得比封段晚得多，尾静音会一直灌进来 —— 只要还没人开口，
   * 它们就只进 {@link ringDuringDecode}，既不 append 也不点亮 `dirty`。
   * 没有这道闸，`gate.close` 的 `hangup()` 会拿纯静音封段，换来一句幻觉定稿。
   */
  private pendingVoice = false;
  /**
   * 解码窗口里有人来要过 commit。
   *
   * **不能直接丢**：窗口里的真语音在 `flushHeld()` 之后才算「新的一段」，
   * 那时若没人再封段，它就悬在缓冲里，直到下一句话开口才被粘到句头
   * （用户会听到/看到前一句的尾巴跑到后一句前面）。
   * 所以这里记意图，`flushHeld()` 之后立刻补发 —— 那一发只有在真攒到语音时才
   * 会发（静音窗口 `flushHeld` 什么都不置，`commit()` 自然跳过）。
   */
  private commitDeferred = false;
  /**
   * 在等这一段解码结束的宿主动作（见 {@link whenDecoded}）。
   *
   * 只用来回答一个问题：「判停要开轮了，可这段还没解完 —— 还值得等吗？」
   */
  private decodeWaiters: Array<() => void> = [];
  private seq = 0;
  /**
   * 已**真正发出去**的 commit 序号（从 0 起，单调）。
   *
   * 只在一处 `+1`：{@link commit} 里 `input_audio_buffer.commit` 真的写进
   * WebSocket 那一刻。跳过（`!dirty`）、延后（`commitDeferred`）、以及
   * 「还没就绪先记着」都不占号 —— 宿主以前自己数，跳过时虚增、`hangup()`
   * 时漏增，转写戴的出生证就指错了段（`causal.ts` 里那条水位线全靠它）。
   *
   * 断线重连**不清零**：清零会让新会话的 1 号与旧水印撞车，旧段被判成
   * 「不是旧段」，反而更容易自己打断自己。
   */
  private _commitSeq = 0;
  /**
   * 当前正在解码的那一发 commit 的序号。
   *
   * 只在真发出 commit 的那一刻改写。定稿（`.completed`）必须**先**把它取走
   * 再去 `flushHeld()` —— 那个调用可能立刻补发延后的下一发，把这里改成新号。
   */
  private decodingCommitSeq = 0;
  /** 还有几条 `commit` 的结果要扔掉（打断用，`clear` 不存在） */
  private discardLeft = 0;
  /** 还没就绪就到了 commit：等 `session.updated` 补发一次 */
  private commitWhenReady = false;

  constructor(opts: QwenRealtimeAsrOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === OPEN;
  }

  async connect(): Promise<void> {
    if (this.ws !== null || this.connecting) return;
    this.connecting = true;
    try {
      this.backlog = [];
      const factory: RealtimeSocketFactory = this.opts.socketFactory
        ?? ((url, apiKey) => new WebSocket(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          maxPayload: 16 << 20,
        }) as unknown as RealtimeSocket);
      const url = `${this.opts.url ?? DEFAULT_URL}?model=${encodeURIComponent(this.opts.model ?? DEFAULT_MODEL)}`;
      const ws = factory(url, this.opts.apiKey);
      this.ws = ws;
      this.ready = false;

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => { resolve(); });
        ws.on('error', (...args: never[]) => {
          reject(new QwenRealtimeAsrError(`WebSocket 连接失败: ${String(args[0])}`));
        });
      }).catch((e: Error) => {
        this.drop(ws);
        try {
          ws.close();
        } catch {
          // 已断
        }
        throw e;
      });

      ws.on('message', (...args: never[]) => {
        if (this.ws === ws) this.onMessage(args[0]);
      });
      ws.on('error', (...args: never[]) => {
        if (this.ws !== ws) return;
        this.opts.onError?.(new QwenRealtimeAsrError(`WebSocket error: ${String(args[0])}`));
      });
      ws.on('close', () => {
        this.log('[asr] 连接关闭');
        // 只有这条就是当前连接时才清状态：迟到的 close 不能影响后来者
        this.drop(ws);
      });

      this.startSession();
    } finally {
      this.connecting = false;
    }
  }

  /** 摘掉**指定**这条连接的状态（迟到的 close 不能影响新连接）。 */
  private drop(ws: RealtimeSocket | null): boolean {
    if (ws === null || this.ws !== ws) return false;
    this.ws = null;
    this.ready = false;
    this.backlog = [];
    this.dirty = false;
    this.awaitingDecode = false;
    this.heldDuringDecode = [];
    this.heldBytes = 0;
    this.ringDuringDecode = [];
    this.ringBytes = 0;
    this.holdActive = false;
    this.commitDeferred = false;
    // 连接没了：等解码的那几个不能再挂下去（判停那边有预算，但挂住的 promise 会漏）
    this.awaitingDecode = false;
    this.resolveDecode();
    return true;
  }

  /**
   * 建会话。
   *
   * 默认 `turn_detection: null`：**关掉服务端 VAD，端点归我们**——
   * `silence_duration_ms` 的下限是 200（文档 + 实测），传 null 才拿得到「更快的封段」。
   * `turnDetection: 'vad'` 时反过来：交给服务端判，换它 139–204 ms 的 `speech_stopped`。
   */
  private startSession(): void {
    const vad = this.opts.turnDetection === 'vad';
    this.sendRaw({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        turn_detection: vad
          ? { type: 'server_vad', silence_duration_ms: this.opts.vadSilenceMs ?? 200 }
          : null,
      },
    });
  }

  feed(pcm: Buffer, voiced?: boolean): void {
    if (this.dropping) return;
    // 只摘**已经关掉**的连接。CONNECTING / OPEN 都不是「死了」——
    // 早期版本这里写的是 `readyState !== OPEN`，结果第一个音频块就在建连
    // 期间把 `this.ws` 摘空，会话从此再也建不起来（表现为连接超时）。
    if (this.ws !== null && this.ws.readyState === CLOSED) this.drop(this.ws);
    // 懒连接：服务端没有 IDLE 超时，但空连接纯属浪费，有音频再建
    if (this.ws === null && !this.connecting) {
      void this.connect().catch((e: Error) => { this.opts.onError?.(e); });
    }
    if (!this.isReady) {
      this.backlog.push(pcm);
      if (this.backlog.length > 200) this.backlog.shift();
      return;
    }
    this.sendAudio(pcm, voiced);
  }

  /**
   * 推一块音频。
   *
   * 解码窗口（`awaitingDecode`）里的音频服务端会丢，所以要暂存 —— 但**只暂存
   * 说得出话的那部分**。尾静音一样会被 `onSpeech` 灌进来（能量门 `holdMs` 2 s
   * 关得比 `commitMs` 20 ms 晚得多），攒下来补推上去会让服务端稳定吐一个幻觉定稿：
   * 实测 150 ms 纯静音 → 「嗯。」。所以窗口内先按 omni-shadow 那套「闭嘴 + 环形
   * 缓冲」处理：没见过有声帧之前只留最近 150 ms，一旦有声全部转正。
   */
  private sendAudio(pcm: Buffer, voiced?: boolean): void {
    if (this.awaitingDecode) {
      if (voiced !== false) {
        // 开口了：软起音那几帧在 ring 里，一起转正
        this.holdActive = true;
        for (const part of this.ringDuringDecode.splice(0)) {
          this.pushHeld(part);
        }
        this.ringBytes = 0;
        this.pushHeld(pcm);
        return;
      }
      // 静音：**不进 `heldDuringDecode`**，只留最近一小截（可能是下一个音的软起音）。
      //
      // 曾经是「一旦说过话，之后所有帧都攒」—— 于是封段后那 300–500 ms 尾静音
      // 被一起补推上去，服务端稳定吐幻觉定稿（真机 2026-11-23 05:14 那场：
      // 第 4 轮补推 16 帧后吐 `Okay.`、第 6 轮 16 帧后 `Thank you.`、
      // 第 7 轮 14 帧后 `嗯。`）。
      this.pushRing(pcm);
      return;
    }
    // `voiced === undefined`（老调用点 / backlog 补推）= 不知道，按有声处理
    if (voiced === false && !this.pendingVoice) {
      // 这段还没人说过话：静音**不进缓冲、不置 `dirty`**。
      //
      // 不这么做的话，能量门那 2 s 的 hold 会把尾静音一路 append 上来、把 `dirty`
      // 重新点亮 —— `gate.close` 的 `hangup()` 于是再 commit 一次，纯静音封出一句
      // 幻觉定稿（`20261123-051448` 第 5 轮就是这么凭空开出来的 `Okay.` 轮）。
      this.pushRing(pcm);
      return;
    }
    if (voiced !== false) {
      this.pendingVoice = true;
    }
    // 软起音那几帧在 ring 里：开口那一刻一起带上，别把起音切掉
    for (const part of this.ringDuringDecode.splice(0)) {
      this.sendRaw({ type: 'input_audio_buffer.append', audio: part.toString('base64') });
    }
    this.ringBytes = 0;
    this.sendRaw({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    this.dirty = true;
  }

  /** 静音或软起音先进这个小环；开口那一刻再转正 */
  private pushRing(pcm: Buffer): void {
    this.ringDuringDecode.push(pcm);
    this.ringBytes += pcm.length;
    while (this.ringBytes > RING_BYTES && this.ringDuringDecode.length > 0) {
      this.ringBytes -= this.ringDuringDecode.shift()?.length ?? 0;
    }
  }

  private pushHeld(pcm: Buffer): void {
    this.heldDuringDecode.push(pcm);
    this.heldBytes += pcm.length;
    while (this.heldBytes > MAX_HELD_BYTES && this.heldDuringDecode.length > 0) {
      const dropped = this.heldDuringDecode.shift();
      this.heldBytes -= dropped?.length ?? 0;
      this.log('[asr] 暂存溢出，丢掉最早一帧');
    }
  }

  /** 把解码窗口里攒下的音频推上去 —— 它们到这一刻才真正属于下一段 */
  private flushHeld(): void {
    // 窗口内一直是静音：一个字都没说，推上去只会换来一句「嗯。」
    this.ringDuringDecode = [];
    this.ringBytes = 0;
    const hadVoice = this.holdActive;
    this.holdActive = false;
    const deferred = this.commitDeferred;
    this.commitDeferred = false;
    if (this.heldDuringDecode.length === 0) {
      // 没攒到语音 —— 延后的那发也没内容可封，直接落空
      if (deferred) {
        this.log('[asr] 延后的 commit 落空：窗口里没有语音');
      }
      return;
    }
    const held = this.heldDuringDecode.splice(0);
    this.heldBytes = 0;
    for (const pcm of held) {
      this.sendRaw({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    }
    this.dirty = true;
    // 补推的是「说过话的那部分」，所以这时才算缓冲里有人声
    this.pendingVoice = hadVoice;
    this.log(`[asr] 补推解码期暂存的 ${held.length} 帧`);
    if (deferred) {
      // 有人要过 commit：现在缓冲里才有东西，补发它（否则这段语音会一直悬着，
      // 直到下一句话开口被粘到句头）
      this.commit();
    }
  }

  /**
   * 把「到目前为止的音频」封成一段交给服务端解码。
   *
   * 调用点：宿主静音计时到点（`UtteranceAssembler.onCommit`）。
   * 没有新音频就**什么都不发** —— 空 commit 会报错，而且只会白挨一发。
   */
  commit(): void {
    if (this.dropping) return;
    if (!this.isReady) {
      this.commitWhenReady = true;
      return;
    }
    if (this.awaitingDecode) {
      // 窗口里的音频还没推上去（`heldDuringDecode`），这一发现在发也是空缓冲。
      // 记下意图，`flushHeld()` 之后补发 —— 真攒到语音才有得发，纯静音窗口自动
      // 落空（那正是 1b 格里「150 ms 纯静音 → 嗯。」的形状）。
      this.commitDeferred = true;
      this.log('[asr] commit 延后：上一段还在解码');
      return;
    }
    if (!this.dirty) {
      this.log('[asr] commit 跳过：这段没有新音频');
      return;
    }
    this.sendRaw({ type: 'input_audio_buffer.commit' });
    // **真正发出去了**才占号。这是全文件唯一的 +1 点：跳过、延后、
    // 「未就绪先记着」都走不到这里，`hangup()` 也复用本方法，所以不会漏。
    this._commitSeq += 1;
    this.decodingCommitSeq = this._commitSeq;
    this.dirty = false;
    // 这段人声已经交出去了：之后灌进来的尾静音不再算「新的一段」
    this.pendingVoice = false;
    this.awaitingDecode = true;
    this.log('[asr] commit');
  }

  /** 下一次 `.completed` 作废（打断时用；`clear` 这个协议里没有）。 */
  discard(): void {
    this.discardLeft += 1;
    this.log(`[asr] 标记丢弃下一段结果（待丢 ${this.discardLeft}）`);
  }

  /** 手上还有一段没解完吗（见 `SttSession.decoding`）。 */
  decoding(): boolean {
    return this.awaitingDecode;
  }

  /**
   * 已经**真正发出去**的 commit 序号（见 `SttSession.commitSeq`）。
   *
   * 与转写事件里带出来的 `commitSeq` 同源 —— 宿主判「旧段」不该再自己数一份。
   */
  commitSeq(): number {
    return this._commitSeq;
  }

  /**
   * 等手上那段解完（见 `SttSession.whenDecoded`）。
   *
   * 没有在解的返回 `null` —— 调用方据此走「不用等」的同步路径。
   */
  whenDecoded(): Promise<void> | null {
    if (!this.awaitingDecode) {
      return null;
    }
    return new Promise<void>((resolve) => { this.decodeWaiters.push(resolve); });
  }

  /** 唤醒所有等解码的调用方（`.completed` / `.error` 都要调，否则会挂着） */
  private resolveDecode(): void {
    for (const wake of this.decodeWaiters.splice(0)) {
      wake();
    }
  }

  /**
   * 「这段说完了」。
   *
   * NLS 这里要发 StopTranscription 并掐连接重建；这边**不能关连接**（一关，
   * 缓冲里的音频就没了），封段即可。网关不判空闲，留着复用。
   */
  hangup(): void {
    this.commit();
  }

  close(): void {
    this.dropping = true;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.backlog = [];
    try {
      ws?.close();
    } catch {
      // 已断
    }
  }

  private sendRaw(payload: unknown): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (e) {
      this.log(`[asr] 发送失败: ${(e as Error).message}`);
    }
  }

  private onMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : String(raw);
    if (text === '') return;
    let ev: ServerEvent;
    try {
      ev = JSON.parse(text) as ServerEvent;
    } catch {
      return;
    }

    if (ev.type === 'session.updated') {
      this.ready = true;
      this.log(this.opts.turnDetection === 'vad'
        ? '[asr] 已就绪（服务端 VAD 开，端点归服务端）'
        : '[asr] 已就绪（服务端 VAD 关闭）');
      for (const b of this.backlog) this.sendAudio(b);
      this.backlog = [];
      if (this.commitWhenReady) {
        this.commitWhenReady = false;
        this.commit();
      }
      return;
    }
    if (ev.type === 'conversation.item.input_audio_transcription.text') {
      // 增量在 stash（`text` 恒为空串），见文件头
      const t = ev.stash ?? ev.text;
      if (typeof t === 'string' && t) {
        // 出生证：正在解码 → 属于**正在解的那一发**（可能是旧段）；
        // 空闲 → 用户新开口还没封段，属于**下一发**。
        // 取 `+1` 是安全的：开轮时锁存的水位线 `baseCommitSeq <= _commitSeq`，
        // 而这里严格大于它，所以不会把真插话误判成旧段。
        const stamp = this.awaitingDecode ? this.decodingCommitSeq : this._commitSeq + 1;
        this.opts.onPartial?.(t, stamp);
      }
      return;
    }
    if (ev.type === 'conversation.item.input_audio_transcription.completed') {
      // **顺序全部是有意的**，三处挨着改会静默出错：
      //
      // 1. 出生证先取走。`flushHeld()` 若补发延后的 commit，会立刻把
      //    `decodingCommitSeq` 改写成**下一段**的号 —— 那之后再取就指错了。
      const completedSeq = this.decodingCommitSeq;
      this.awaitingDecode = false;
      const t = (ev.transcript ?? '').trim();
      const index = this.seq;
      this.seq += 1;
      // 2. 交付定稿时 `awaitingDecode` 已经是 false、序号也还没被下一发改写。
      if (this.discardLeft > 0) {
        this.discardLeft -= 1;
        this.log(`[asr] 丢弃第 ${index} 段（迟到 ${t.length} 字）`);
      } else if (t !== '') {
        this.opts.onSentence(t, index, completedSeq);
      }
      // 3. 解码结束 —— 窗口期攒下的音频现在推上去，才算下一段的开始。
      //    它可能立刻补发延后的 commit（`_commitSeq + 1`、`awaitingDecode = true`）。
      this.flushHeld();
      // 4. **在定稿之后**才真正唤醒（微任务），顺序不能挪到前面：
      //    等的人要以「新定稿已经进过组装器」为前提决定要不要抢跑。
      this.resolveDecode();
      return;
    }
    if (ev.type === 'error') {
      // 这一发废了：重新武装，否则 `awaitingDecode` 永远挂着，后面再也 commit 不出去
      this.awaitingDecode = false;
      this.flushHeld();
      this.resolveDecode();
      const msg = ev.error?.message ?? text.slice(0, 200);
      this.opts.onError?.(new QwenRealtimeAsrError(`服务端错误: ${msg}`));
    }
  }
}

/** 把 DashScope realtime 包成 {@link SttProvider}。 */
export function qwenRealtimeStt(
  opts: Omit<QwenRealtimeAsrOptions, 'onSentence' | 'onPartial' | 'onError' | 'log'>,
  log?: (line: string) => void,
): SttProvider {
  return {
    name: `qwen-realtime:${opts.model ?? DEFAULT_MODEL}`,
    open: (handlers) => {
      const asr = new QwenRealtimeAsr({
        ...opts,
        onSentence: handlers.onSentence,
        onPartial: handlers.onPartial,
        onError: handlers.onError,
        log,
      });
      return {
        feed: (pcm, voiced) => { asr.feed(pcm, voiced); },
        hangup: () => { asr.hangup(); },
        close: () => { asr.close(); },
        commit: () => { asr.commit(); },
        commitSeq: () => asr.commitSeq(),
        discard: () => { asr.discard(); },
        decoding: () => asr.decoding(),
        whenDecoded: () => asr.whenDecoded(),
      };
    },
  };
}
