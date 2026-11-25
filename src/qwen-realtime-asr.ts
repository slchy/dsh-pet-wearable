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

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DEFAULT_MODEL = 'qwen3-asr-flash-realtime';
/**
 * `commit` 之后等 `.completed` / `.failed` 的上限。
 * 服务端漏回定稿时，看门狗到点就解除 `awaitingDecode`，避免整条会话卡死。
 * `decodeTimeoutMs <= 0` 关闭。
 */
const DEFAULT_DECODE_TIMEOUT_MS = 8_000;
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
   * 静态热词，写入 `input_audio_transcription.corpus.text`。
   *
   * 缺省、或 trim 之后为空，则不增加这个字段（两个提示都空时连
   * `input_audio_transcription` 都不出现）——旧的 `session.update` 必须保持原样。
   * 实测这条偏置能把「显克微奇《奇主之声》」拉回「莱姆《其主之声》」，热路径不再多一次往返。
   */
  readonly corpusText?: string;
  /**
   * 识别语言，写入 `input_audio_transcription.language`。
   * 同样：缺省或 trim 后为空就不写。
   */
  readonly language?: string;
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
   * 等这一发 `commit` 的定稿最多多久（毫秒）。缺省 {@link DEFAULT_DECODE_TIMEOUT_MS}。
   * `<= 0` 关闭看门狗。到点只解除等待并按解码结束冲刷，不另造一句转写。
   */
  readonly decodeTimeoutMs?: number;
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
  /**
   * 连接相位。`isReady` 只认 `live`，不再用 ready / connecting / dropping 三处布尔。
   *
   * - `down`：没有连接，`feed()` 可以重建
   * - `connecting`：WebSocket 还在握手
   * - `handshaking`：套接字已开，已发 `session.update`，等 `session.updated`
   * - `live`：可以推音频、可以 commit
   * - `closed`：`close()` 之后的吸收态，不再重连
   */
  private linkPhase: 'down' | 'connecting' | 'handshaking' | 'live' | 'closed' = 'down';
  /** 每次 `connect()` 加一。旧 socket 的回调看见代次不对就直接返回。 */
  private wsGen = 0;
  /**
   * 建连的 `await` 还挂着时，`close()` / `drop()` 用它解开。
   * 回调首行发现代次失效会直接 return，不解开的话这次 `connect()` 永远等不到头。
   */
  private settleConnect: (() => void) | null = null;
  /** 未就绪时先攒着，别丢音频。`voiced` 要原样留到 `session.updated` 补推。 */
  private backlog: Array<{ pcm: Buffer; voiced: boolean }> = [];
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
   * 清空点有三个，缺一个就会永久卡住：
   * - `.completed` → 解码结束，之后来的音频才算新的一段
   * - `.failed` / `.error` → 这一发废了，得重新武装，并吃掉对应的 `discardLeft`
   * - 看门狗超时 → 服务端漏回定稿时也不能一直挂着
   */
  private awaitingDecode = false;
  /** `awaitingDecode` 的一次性看门狗。`.completed` / 失败 / `drop` / `close` 都要清掉。 */
  private decodeTimer: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * 唯一就绪判定：相位是 `live`，而且当前套接字确实还开着。
   * `CLOSING` / `CLOSED` 不算就绪，避免把音频推进死连接。
   */
  get isReady(): boolean {
    return this.linkPhase === 'live' && this.ws !== null && this.ws.readyState === OPEN;
  }

  /** `closed` 是吸收态：一旦 `close()`，后面任何迁移都不再改相位。 */
  private setLink(next: 'down' | 'connecting' | 'handshaking' | 'live' | 'closed'): void {
    if (this.linkPhase === 'closed') return;
    this.linkPhase = next;
  }

  /**
   * 重新读相位。直接写 `this.linkPhase === …` 时，函数开头的收窄会跨过 `await`
   * 一直生效，把后面 `close()` / `drop()` 改过的相位判成不可能。
   */
  private linkIs(phase: 'down' | 'connecting' | 'handshaking' | 'live' | 'closed'): boolean {
    return this.linkPhase === phase;
  }

  async connect(): Promise<void> {
    if (!this.linkIs('down') || this.ws !== null) return;
    this.setLink('connecting');
    const myGen = ++this.wsGen;
    try {
      // 不清 backlog：`drop()` 留下的未发送音频要在这条新连接上补发。
      const factory: RealtimeSocketFactory = this.opts.socketFactory
        ?? ((url, apiKey) => new WebSocket(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          maxPayload: 16 << 20,
        }) as unknown as RealtimeSocket);
      const url = `${this.opts.url ?? DEFAULT_URL}?model=${encodeURIComponent(this.opts.model ?? DEFAULT_MODEL)}`;
      const ws = factory(url, this.opts.apiKey);
      if (myGen !== this.wsGen || this.linkIs('closed')) {
        try { ws.close(); } catch { /* 已断 */ }
        return;
      }
      this.ws = ws;

      let settle: (() => void) | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          settle = resolve;
          this.settleConnect = resolve;
          ws.on('open', () => {
            if (myGen !== this.wsGen || this.linkPhase === 'closed') return;
            resolve();
          });
          ws.on('error', (...args: never[]) => {
            if (myGen !== this.wsGen || this.linkPhase === 'closed') return;
            reject(new QwenRealtimeAsrError(`WebSocket 连接失败: ${String(args[0])}`));
          });
          ws.on('close', () => {
            if (myGen !== this.wsGen || this.linkPhase === 'closed') return;
            reject(new QwenRealtimeAsrError('连接在就绪前关闭'));
          });
        });
      } catch (e) {
        const error = e instanceof Error ? e : new QwenRealtimeAsrError(String(e));
        if (this.ws === ws) this.drop(ws);
        try { ws.close(); } catch { /* 已断 */ }
        throw error;
      } finally {
        // 只摘自己的 settle。`feed()` 可能已经 drop 掉这条并建了下一条，
        // 无条件清空会把新连接的 await 一起拆掉。
        if (settle !== null && this.settleConnect === settle) this.settleConnect = null;
      }
      if (myGen !== this.wsGen || this.linkIs('closed')) {
        if (this.ws === ws) this.drop(ws);
        return;
      }

      this.setLink('handshaking');
      ws.on('message', (...args: never[]) => {
        if (myGen !== this.wsGen || this.linkPhase === 'closed') return;
        if (this.ws === ws) this.onMessage(args[0]);
      });
      ws.on('error', (...args: never[]) => {
        if (myGen !== this.wsGen || this.linkPhase === 'closed') return;
        if (this.ws !== ws) return;
        this.opts.onError?.(new QwenRealtimeAsrError(`WebSocket error: ${String(args[0])}`));
      });
      ws.on('close', () => {
        if (myGen !== this.wsGen || this.linkPhase === 'closed') return;
        this.log('[asr] 连接关闭');
        // 只有这条就是当前连接时才清状态：迟到的 close 不能影响后来者
        this.drop(ws);
      });

      this.startSession();
    } finally {
      // 代次已经不是这一次时，相位归后来的 connect / close 管，这里不能改回 down。
      if (myGen === this.wsGen && this.linkIs('connecting')) this.setLink('down');
    }
  }

  /**
   * 摘掉**指定**这条连接的状态（迟到的 close 不能影响新连接）。
   *
   * 主动断旧链是为了重连：还没发出去的 `backlog` 留给下一条。
   * 只有已经 `close()` 的吸收态才把 backlog 一起清掉。
   */
  private drop(ws: RealtimeSocket | null): boolean {
    if (ws === null || this.ws !== ws) return false;
    const terminal = this.linkPhase === 'closed';
    this.ws = null;
    this.wsGen += 1;
    this.abandonConnectAttempt();
    this.resetSessionState(terminal);
    this.setLink('down');
    return true;
  }

  /** 解开还挂在 `connect()` 里的那次 await。代次失效的回调会直接 return，不能让它把建连挂死。 */
  private abandonConnectAttempt(): void {
    const settle = this.settleConnect;
    this.settleConnect = null;
    settle?.();
  }

  /**
   * `drop()` 与 `close()` 共用的会话复位。
   *
   * 连接没了之后，静音门、丢弃计数和「等解码」的人都必须回到初值，
   * 否则下一条连接会把上一句的尾巴或一张作废票带过去，
   * `whenDecoded()` 也会一直挂着。
   *
   * `clearBacklog` 只在 `close()` 彻底结束会话时为真。
   * `drop()` 重连时要留下还没发出去的音频，否则 `CLOSING` / `CLOSED`
   * 期间攒下的帧会在摘链时被整表丢掉。
   */
  private resetSessionState(clearBacklog: boolean): void {
    if (clearBacklog) this.backlog = [];
    this.dirty = false;
    this.awaitingDecode = false;
    this.clearDecodeWatchdog();
    this.pendingVoice = false;
    this.holdActive = false;
    this.commitDeferred = false;
    this.commitWhenReady = false;
    this.discardLeft = 0;
    this.heldDuringDecode = [];
    this.heldBytes = 0;
    this.ringDuringDecode = [];
    this.ringBytes = 0;
    this.resolveDecode();
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
    const corpus = this.opts.corpusText?.trim() ?? '';
    const lang = this.opts.language?.trim() ?? '';
    // 两个都空就别加键。多写一个空的 input_audio_transcription 也会让旧报文对不上。
    const transcription = (corpus !== '' || lang !== '')
      ? {
          model: this.opts.model ?? DEFAULT_MODEL,
          ...(lang !== '' ? { language: lang } : {}),
          ...(corpus !== '' ? { corpus: { text: corpus } } : {}),
        }
      : undefined;
    this.sendRaw({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        turn_detection: vad
          ? { type: 'server_vad', silence_duration_ms: this.opts.vadSilenceMs ?? 200 }
          : null,
        ...(transcription ? { input_audio_transcription: transcription } : {}),
      },
    });
  }

  feed(pcm: Buffer, voiced?: boolean): void {
    if (this.linkPhase === 'closed') return;
    // `CLOSING` / `CLOSED` 都已经不是 live。先摘掉这条死链，未发送的 backlog
    // 留给重连，不要推进这个 socket。
    // `CONNECTING` / `OPEN` 不能摘 —— 早期版本这里写的是 `readyState !== OPEN`，
    // 结果第一个音频块就在建连期间把 `this.ws` 摘空，会话从此再也建不起来
    // （表现为连接超时）。
    if (this.ws !== null && (this.ws.readyState === CLOSING || this.ws.readyState === CLOSED)) {
      const dead = this.ws;
      if (this.drop(dead)) this.log('[asr] 套接字已结束，未发送音频留给重连');
    }
    // 懒连接：服务端没有 IDLE 超时，但空连接纯属浪费，有音频再建
    if (this.ws === null && this.linkPhase === 'down') {
      void this.connect().catch((e: Error) => { this.opts.onError?.(e); });
    }
    if (!this.isReady) {
      this.backlog.push({ pcm, voiced: voiced !== false });
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
    if (this.linkPhase === 'closed') return;
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
    this.armDecodeWatchdog();
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

  /** 唤醒所有等解码的调用方（`.completed` / `.failed` / `.error` / 超时都要调，否则会挂着） */
  private resolveDecode(): void {
    for (const wake of this.decodeWaiters.splice(0)) {
      wake();
    }
  }

  private armDecodeWatchdog(): void {
    this.clearDecodeWatchdog();
    const ms = this.opts.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    if (!(ms > 0)) return;
    const timer = setTimeout(() => {
      if (this.decodeTimer !== timer) return;
      this.decodeTimer = null;
      if (this.linkPhase === 'closed' || !this.awaitingDecode) return;
      this.releaseInFlightDecode('解码超时，未收到定稿，解除等待');
    }, ms);
    timer.unref?.();
    this.decodeTimer = timer;
  }

  private clearDecodeWatchdog(): void {
    const timer = this.decodeTimer;
    if (timer === null) return;
    clearTimeout(timer);
    this.decodeTimer = null;
  }

  /**
   * 这一发等不到正常定稿了（失败、服务端错误、看门狗）。
   *
   * 只有真的结束了一次 `awaitingDecode` 才吃 `discardLeft`：被挂断丢掉的那一发
   * 若没出 `.completed`，计数留着会把下一句真定稿吞掉。
   * 冲刷放在清计时器之后 —— `flushHeld()` 可能立刻补发下一发并重新 arm。
   */
  private releaseInFlightDecode(reason: string): void {
    const ending = this.awaitingDecode;
    this.awaitingDecode = false;
    this.clearDecodeWatchdog();
    if (ending && this.discardLeft > 0) {
      this.discardLeft -= 1;
      this.log(`[asr] ${reason}，消耗一次丢弃（剩余 ${this.discardLeft}）`);
    } else if (ending) {
      this.log(`[asr] ${reason}`);
    }
    this.flushHeld();
    this.resolveDecode();
  }

  /**
   * 把未就绪时攒下的音频按到达顺序补发出去。
   * 套接字中途不再是 `OPEN` 就把剩下的放回队头，绝不推进死连接后再整表丢掉。
   */
  private flushBacklog(): void {
    if (!this.isReady) return;
    const pending = this.backlog.splice(0);
    const kept: Array<{ pcm: Buffer; voiced: boolean }> = [];
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      if (item === undefined) continue;
      if (!this.isReady) {
        for (let j = i; j < pending.length; j += 1) {
          const rest = pending[j];
          if (rest !== undefined) kept.push(rest);
        }
        break;
      }
      this.sendAudio(item.pcm, item.voiced);
    }
    if (kept.length > 0) this.backlog = kept.concat(this.backlog);
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
    this.setLink('closed');
    this.wsGen += 1;
    const ws = this.ws;
    this.ws = null;
    this.abandonConnectAttempt();
    this.resetSessionState(true);
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
      if (this.linkPhase !== 'handshaking' && this.linkPhase !== 'live') return;
      if (this.ws === null || this.ws.readyState !== OPEN) {
        this.log('[asr] session.updated 时连接已不可用，backlog 保留给重连');
        if (this.ws !== null) this.drop(this.ws);
        return;
      }
      this.setLink('live');
      this.log(this.opts.turnDetection === 'vad'
        ? '[asr] 已就绪（服务端 VAD 开，端点归服务端）'
        : '[asr] 已就绪（服务端 VAD 关闭）');
      this.flushBacklog();
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
        if (this.opts.corpusText && isCorpusEcho(t, this.opts.corpusText)) {
          this.log(`[asr] 丢弃热词回声增量（${t.length} 字）`);
          return;
        }
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
      //    看门狗也要在补发之前清掉，否则会拆掉下一发刚 arm 的那只。
      const completedSeq = this.decodingCommitSeq;
      this.awaitingDecode = false;
      this.clearDecodeWatchdog();
      const t = (ev.transcript ?? '').trim();
      const index = this.seq;
      this.seq += 1;
      // 2. 交付定稿时 `awaitingDecode` 已经是 false、序号也还没被下一发改写。
      if (this.discardLeft > 0) {
        this.discardLeft -= 1;
        this.log(`[asr] 丢弃第 ${index} 段（迟到 ${t.length} 字）`);
      } else if (t !== '' && this.opts.corpusText && isCorpusEcho(t, this.opts.corpusText)) {
        this.log(`[asr] 丢弃第 ${index} 段热词回声幻觉（${t.length} 字）`);
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
    if (
      ev.type === 'error'
      || ev.type === 'conversation.item.input_audio_transcription.failed'
    ) {
      // 这一发废了：重新武装，否则 `awaitingDecode` 永远挂着，后面再也 commit 不出去。
      // `.failed` 同样要吃掉 `discardLeft` —— 挂断丢掉的那一发常常没有 `.completed`。
      const failed = ev.type === 'conversation.item.input_audio_transcription.failed';
      this.releaseInFlightDecode(failed ? '转写失败' : '服务端错误，本段解码作废');
      const msg = ev.error?.message ?? text.slice(0, 200);
      this.opts.onError?.(new QwenRealtimeAsrError(failed ? `转写失败: ${msg}` : `服务端错误: ${msg}`));
    }
  }
}

/**
 * 多段热词文本收成一条给 `corpus.text` 的静态串。
 *
 * 先按行丢掉空行和 `#` 开头的注释，再按空白切词、去重，按第一次出现的顺序用单个空格拼上。
 * 拼完超过 `maxChars` 就按字符截到这个上限（不加省略号，多一个字就超了）；
 * 截断点正好落在分隔空格上时去掉末尾空格，不把半个分隔符送出去。
 * 纯函数，不做文件 I/O。
 */
export function mergeCorpusText(parts: readonly string[], maxChars = 800): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    for (const rawLine of part.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      for (const token of line.split(/\s+/)) {
        if (token === '' || seen.has(token)) continue;
        seen.add(token);
        tokens.push(token);
      }
    }
  }
  const joined = tokens.join(' ');
  if (maxChars <= 0 || joined === '') return '';
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars).trimEnd();
}

const ECHO_SPLIT = /[\s，。、；：！？,.;:!?]+/u;

/**
 * 判别 `qwen3-asr-flash-realtime` 在弱音/静音封段时把 `corpus.text` 原样吐出来的回声幻觉。
 *
 * 线上实测：传入 50 词热词表后，轻微噪声封段会吐出整串空格分隔的热词原文，若不拦截会直接
 * 喂进前台对话与 dsh 会话记录。正常含 1–2 个热词的口语不会被误杀。
 */
export function isCorpusEcho(text: string, corpusText: string): boolean {
  const corpus = corpusText.trim();
  const sample = text.trim();
  if (corpus === '' || sample === '') return false;

  const corpusTokens = corpus.toLowerCase().split(ECHO_SPLIT).filter(Boolean);
  if (corpusTokens.length < 4) return false;

  const compactCorpus = corpusTokens.join('');
  const sampleTokens = sample.toLowerCase().split(ECHO_SPLIT).filter(Boolean);
  const compactSample = sampleTokens.join('');
  if (compactSample.length >= 12 && compactCorpus.includes(compactSample)) {
    return true;
  }

  if (sampleTokens.length < 4) return false;
  const corpusSet = new Set(corpusTokens);
  let hits = 0;
  for (const token of sampleTokens) {
    if (corpusSet.has(token)) hits += 1;
  }
  return hits >= 4 && hits / sampleTokens.length >= 0.6;
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
