/**
 * omni 影子旁路：**只量，不发声**。
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
 */
import WebSocket from 'ws';

import type { RealtimeSocket, RealtimeSocketFactory } from './qwen-realtime-asr.ts';
import type { AgentAudioAnswer, DelegateReason, FastLaneAudioLane } from './providers.ts';

/** 上行格式：与 `UplinkPipeline` 一致（16 kHz / 单声道 / s16le） */
const UPSTREAM_RATE = 16_000;
const BYTES_PER_MILLISECOND = (UPSTREAM_RATE * 2) / 1000;
/** omni 输出固定按 24 kHz 声明（见 `session.update` 的 `audio.output.format`） */
const DOWNSTREAM_RATE = 24_000;

const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DEFAULT_MODEL = 'qwen3.8-omni-flash-realtime';
/**
 * 输出必须短，而且**必须是助手人格**。
 *
 * 实测：写成「你是一个语音助手的**旁路探针**」时，挂着 tools 的模型会连着 3/3
 * 把闲聊判成工具调用（零音频）—— 措辞里的「探针」比工具描述更能决定它怎么选。
 * 所以这里就是线上助手该说的话，不做调试人格。
 */
const DEFAULT_INSTRUCTIONS =
  '你是米馍，一个中文语音助手。只回一句话，不超过 20 个字，不要解释、不要列举、不要反问。';

/** `seal()` 之后、下一次有声之前，最多留多少音频（防软起音被吞） */
const DEFAULT_RING_MILLISECONDS = 150;

/**
 * 唯一的工具：把这一轮转给 dsh。
 *
 * 描述必须收窄到「**真的要去操作**」—— 只写「操作设备 / 读设备数据 / 长期记忆」，
 * **绝不能写「查询信息」**：实测写「查询实时信息」之后，一句
 * 「他还写过哪些作品？」被模型判成「实时信息检索」→ 直接调工具、零音频、整轮报废。
 * 常识问答是 omni 自己的活，不该转给 dsh。
 */
const DELEGATE_TOOL = {
  type: 'function',
  name: 'delegate_to_assistant',
  description:
    '只在需要**实际动手或读取设备数据**时调用：开关设备/拍照/发消息，'
    + '读电量/位置/日程等设备信息，或调取以前聊过的长期记忆。'
    + '闲聊、常识问答、讲个笑话这类都不要调用，自己回答。',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', description: '为什么转交（一句话）' } },
    required: ['reason'],
  },
} as const;

export type OmniShadowState = 'idle' | 'connecting' | 'ready' | 'busy' | 'broken';

export interface OmniShadowOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  readonly instructions?: string;
  /** 一份 seal 的结果 → 会话档案（`omni.shadow`） */
  readonly emit: (data: Record<string, unknown>) => void;
  readonly log?: (line: string) => void;
  /** 可注入时钟（ms），测试用 */
  readonly now?: () => number;
  /** 测试注入；生产用 `ws` */
  readonly socketFactory?: RealtimeSocketFactory;
  /** 握手多久没就绪算废 */
  readonly connectTimeoutMs?: number;
  /** 一份 response 多久没 done 算废（不是性能判据，只是防挂死） */
  readonly responseTimeoutMs?: number;
  readonly ringMs?: number;
  /**
   * 认领模式。
   *
   * - `off`（默认）：只测不发声 —— 音频仍会攒着（S0 也要用它算 `out_s`），
   *   但没人认领，`willServe()` 恒 false
   * - `clip`：只答**单段**轮（`turnSeqs.length === 1`）。开全量之前先用它验
   *   播放/音色/打断
   * - `full`：与文本快车道同口径
   */
  readonly serve?: 'off' | 'clip' | 'full';
}

/** 一份 seal 的身份与起点 */
interface SealMeta {
  readonly seq: number;
  readonly silenceMs: number;
  /** 调用 `seal()` 的时刻 —— `audio_ms` 从这里算，**包含等 cancel 的那段** */
  readonly anchor: number;
  /** 这一段推了多少音频（字节） */
  readonly bytes: number;
  /** `restart()` 时顺手 flush 掉的残留（ms），0 = 没有 */
  readonly flushedMs: number;
}

interface PendingResponse {
  readonly meta: SealMeta;
  /** commit+create 真正发出去的时刻（撞 busy 时晚于 anchor） */
  readonly sentAt: number;
  ackAt: number | null;
  finalAt: number | null;
  firstTextAt: number | null;
  firstAudioAt: number | null;
  outBytes: number;
  cancelled: boolean;
  /**
   * 音频**从封段就开始攒**，不是认领才开始。
   *
   * 为什么必须这样：认领发生在定稿（~220 ms），但判停延拍时能到 700–870 ms，
   * 那时首块（600–670 ms）已经发过来了 —— 不做缓冲就会吞掉句首一两个字。
   */
  readonly audio: Buffer[];
  audioWaiters: Array<() => void>;
  /** 这一份已经不会再产出了（`response.done` 或被取消） */
  closed: boolean;
  /** 已收到的转写（活的，用于 `text`/`speech` 的 getter 与审计） */
  text: string;
  /** omni 自己决定转 dsh（`tool_call`）；`null` = 它会自己答 */
  delegate: DelegateReason | null;
  /**
   * 服务端回过 `response.created` 了吗。
   *
   * **`response.cancel` 在它之前发会被拒**（实测文案
   * `Cannot cancel response before response.created`），而委派轮恰恰是在
   * `seal()` 之后几百毫秒就 discard —— 那时 created 通常还没到。
   */
  created: boolean;
  /** 还没 created 就被要求取消：等 created 到了立刻补发 */
  cancelPending: boolean;
  /** 有没有人认领过（一份只给一个消费者） */
  claimed: boolean;
}

interface ServerEvent {
  type?: string;
  delta?: string;
  item?: { id?: string };
  error?: { code?: string; message?: string; type?: string };
  response?: {
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { audio_tokens?: number; text_tokens?: number };
      output_tokens_details?: { audio_tokens?: number; text_tokens?: number };
    };
  };
}

export class OmniShadow {
  private readonly opts: OmniShadowOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly ringMaxBytes: number;

  private ws: RealtimeSocket | null = null;
  private state: OmniShadowState = 'idle';
  /** socket 已 open（可以发帧）。与 `state === 'ready'` 不是一回事：后者还要等 `session.updated` */
  private opened = false;

  /**
   * 已推给服务端、尚未 commit 的字节。
   *
   * 它同时是「这一段有多长」的度量：`seal()` 时按它算 `seal_s`，然后清零。
   */
  private dirtyBytes = 0;
  /**
   * 闭嘴状态：`seal()` 之后置位，下一次**有声**块解除。
   *
   * 这是本模块最容易被写错的一处 —— 见文件头「三条硬约束」第 1 条。
   */
  private muted = true;
  /** `muted` 期间攒的最近音频（软起音不该被切掉） */
  private ring: Buffer[] = [];
  private ringBytes = 0;

  private pending: SealMeta | null = null;
  private resp: PendingResponse | null = null;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;

  /** 连续协议错误次数（忙时 create 被拒之类）。2 次就判连接语义已脏 */
  private protocolErrors = 0;
  /** 一份 seal 结果里要带的「顺带 flush 掉的残留」 */
  private lastFlushedMs = 0;
  private droppedBytes = 0;
  /** 这一轮里已经封过几段（并段 > 1）。`restart()` 归零 */
  private turnSeqs: number[] = [];
  /** 还没跑过任何一份 seal —— 第一条标 `warmup`，分析时排除 */
  private sharedSeals = 0;

  constructor(options: OmniShadowOptions) {
    this.opts = options;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.ringMaxBytes = Math.round(BYTES_PER_MILLISECOND * (options.ringMs ?? DEFAULT_RING_MILLISECONDS));
  }

  get currentState(): OmniShadowState {
    return this.state;
  }

  /** 本端端口：长尾时可以用 `ss -ti` 直接区分「厂商慢」和「公网丢包」 */
  get localPort(): number {
    const socket = (this.ws as unknown as { _socket?: { localPort?: number } } | null)?._socket;
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
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) {
        return;
      }
      this.opened = true;
      this.sendSessionUpdate();
      this.armConnectTimeout();
    });
    ws.on('message', (...args: never[]) => {
      if (this.ws !== ws) {
        return;
      }
      this.onMessage(args[0] as unknown as Buffer);
    });
    ws.on('error', (...args: never[]) => {
      if (this.ws !== ws) {
        return;
      }
      // 不发事件：真正的后果是随后的 close，那里统一处理
      this.log(`[omni] socket error: ${String(args[0])}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) {
        return;
      }
      this.break('连接关闭');
    });
  }

  stop(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    this.state = 'broken';
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已经断了
      }
    }
  }

  // ---------------------------------------------------------------- 音频与封段

  /**
   * 新一轮开口（能量门重新打开）。
   *
   * 做四件事，顺序有讲究：
   * 1. 上一轮还在生成 → **立刻 cancel**。用户说话有 2–3 s，够它干净收尾；
   *    等到 `seal()` 才 cancel 的话，那 79 ms 会压在关键路径上。
   * 2. 丢掉待发的那份 seal —— 句子还在继续，组装器会重新 `seal()`。
   * 3. 有残留就 `commit` 掉（**不发 create**，所以不会产生回复）。空缓冲 commit
   *    会回 `maybe no invalid audio stream`，所以必须先看 `dirtyBytes`。
   * 4. 解除闭嘴，把预卷推上去。
   */
  restart(preroll: readonly Buffer[]): void {
    if (this.state === 'broken' || this.state === 'idle') {
      return;
    }
    if (this.resp !== null) {
      this.cancelCurrent();
    }
    this.pending = null;
    this.ring = [];
    this.ringBytes = 0;
    this.turnSeqs = [];

    if (this.dirtyBytes > 0) {
      this.lastFlushedMs = Math.round(this.dirtyBytes / BYTES_PER_MILLISECOND);
      this.dirtyBytes = 0;
      this.send({ type: 'input_audio_buffer.commit' });
    }

    this.muted = false;
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
    if (this.muted) {
      if (!voiced) {
        this.pushRing(pcm);
        return;
      }
      // 又开口了：软起音那几帧在 ring 里，补回去
      this.muted = false;
      const buffered = this.ring.length === 0 ? null : Buffer.concat(this.ring);
      this.ring = [];
      this.ringBytes = 0;
      if (buffered !== null && buffered.length > 0) {
        this.append(buffered);
      }
      this.append(pcm);
      return;
    }
    this.append(pcm);
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
    this.muted = true;
    this.ring = [];
    this.ringBytes = 0;

    const bytes = this.dirtyBytes;
    if (bytes <= 0) {
      this.emitSkipped(seq, 'empty');
      return;
    }
    this.dirtyBytes = 0;
    this.turnSeqs.push(seq);
    const meta: SealMeta = {
      seq,
      silenceMs,
      anchor: this.now(),
      bytes,
      flushedMs: this.lastFlushedMs,
    };
    this.lastFlushedMs = 0;

    if (this.state === 'connecting') {
      this.emitSkipped(seq, 'connecting');
      return;
    }
    if (this.resp !== null) {
      // 忙时 create 会被服务端拒掉且永久丢失（实测），所以先 cancel 再排队
      this.cancelCurrent();
      this.pending = meta;
      return;
    }
    this.sendSeal(meta);
  }

  // ---------------------------------------------------------------- 车道接口

  /**
   * 这一轮能不能由 omni 自己答。纯读、不改账。
   *
   * 三重限制叠在一起，每一条都对应一次踩坑：
   * - `serve === 'off'`：没开的连接一个字节都不该被认领
   * - `cancelled` / `claimed`：一份只能给一个消费者，取消过的更不能再给（那是死答案）
   * - `clip` 档只认单段轮 —— 并段轮的脏历史还没洗法，先别放量
   */
  willServe(): boolean {
    if ((this.opts.serve ?? 'off') === 'off') {
      return false;
    }
    const resp = this.resp;
    if (resp === null || resp.cancelled || resp.claimed) {
      return false;
    }
    if (this.opts.serve === 'clip' && this.turnSeqs.length > 1) {
      return false;
    }
    return true;
  }

  /**
   * 认领本轮音频。
   *
   * 注意：**首块通常还没到**（认领在定稿 ~220 ms，首块 600–670 ms），而判停延拍时
   * 认领可以晚到 700–870 ms、那时首块已经发过来了 —— 两条路都靠 `resp.audio`
   * 从封段就开始攒（见 `PendingResponse.audio`）。
   */
  claim(): AgentAudioAnswer | null {
    if (!this.willServe()) {
      return null;
    }
    const resp = this.resp;
    if (resp === null) {
      return null;
    }
    resp.claimed = true;
    return {
      sampleRate: DOWNSTREAM_RATE,
      transcript: () => resp.text,
      delegateReason: () => resp.delegate,
      chunks: (async function* iterate() {
        for (;;) {
          if (resp.audio.length > 0) {
            const next = resp.audio.shift();
            if (next !== undefined) {
              yield next;
            }
            continue;
          }
          if (resp.closed) {
            return;
          }
          await new Promise<void>((resolve) => { resp.audioWaiters.push(resolve); });
        }
      })(),
    };
  }

  /**
   * 这一轮不采纳：**立刻 `response.cancel`**。
   *
   * 不取消的话它会在后台把整段废音频生成完 —— 既烧输出 token，又让下一轮开口时
   * 它还挂着 `busy`（那时新的 `response.create` 会被服务端拒掉且永久丢失）。
   */
  discard(): void {
    const resp = this.resp;
    if (resp !== null) {
      resp.audio.length = 0;
      this.wakeAudio(resp);
      this.cancelCurrent();
    }
    this.pending = null;
  }

  /** 排障用：`willServe()` 为 false 时到底卡在哪一条（只进档案，不参与决策） */
  explain(): Record<string, unknown> {
    const resp = this.resp;
    return {
      serve: this.opts.serve ?? 'off',
      state: this.state,
      has_resp: resp !== null,
      cancelled: resp?.cancelled ?? null,
      claimed: resp?.claimed ?? null,
      turn_seqs: this.turnSeqs.length,
    };
  }

  private wakeAudio(resp: PendingResponse | null = this.resp): void {
    if (resp === null) {
      return;
    }
    const waiters = resp.audioWaiters;
    resp.audioWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  // ---------------------------------------------------------------- 内部

  private sendSeal(meta: SealMeta): void {
    const sentAt = this.now();
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
    this.resp = {
      meta,
      sentAt,
      ackAt: null,
      finalAt: null,
      firstTextAt: null,
      firstAudioAt: null,
      outBytes: 0,
      cancelled: false,
      audio: [],
      audioWaiters: [],
      closed: false,
      text: '',
      delegate: null,
      created: false,
      cancelPending: false,
      claimed: false,
    };
    this.state = 'busy';
    this.armResponseTimeout();
  }

  private cancelCurrent(): void {
    if (this.resp === null || this.resp.cancelled) {
      return;
    }
    this.resp.cancelled = true;
    if (!this.resp.created) {
      // `response.cancel` 在 `response.created` 之前发会被服务端拒
      // （`Cannot cancel response before response.created`），所以先记账，
      // 等 created 到了立刻补发 —— 见 `onMessage` 的 `response.created` 分支
      this.resp.cancelPending = true;
      return;
    }
    this.send({ type: 'response.cancel' });
  }

  private append(pcm: Buffer): void {
    if (!this.opened) {
      this.droppedBytes += pcm.length;
      return;
    }
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    this.dirtyBytes += pcm.length;
  }

  private pushRing(pcm: Buffer): void {
    this.ring.push(Buffer.from(pcm));
    this.ringBytes += pcm.length;
    while (this.ringBytes > this.ringMaxBytes && this.ring.length > 1) {
      const dropped = this.ring.shift();
      this.ringBytes -= dropped?.length ?? 0;
    }
  }

  private sendSessionUpdate(): void {
    const serve = (this.opts.serve ?? 'off') !== 'off';
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        // **不要**在这加任何「要不要调工具」的暗示。实测：多加一句
        // 「如果决定调用工具，直接调用，不要先说任何过渡语」之后，闲聊会 3/3
        // 被判成工具调用（零音频）；去掉它、只留 `DELEGATE_TOOL.description`，
        // 同一批闲聊 150 轮 `0/150` 误触发。决定权在工具描述，不在提示词。
        instructions: this.opts.instructions ?? DEFAULT_INSTRUCTIONS,
        // 手动端点：我们已经在封段那一刻决定「这句说完了」，服务端 VAD 既多余又更慢
        turn_detection: null,
        audio: {
          input: {
            format: {
              type: 'pcm',
              sample_rate: UPSTREAM_RATE,
              sample_format: 's16le',
              channels: 1,
              packing: 'interleaved',
              channel_layout: 'mono',
            },
          },
          output: { format: { type: 'pcm', sample_rate: DOWNSTREAM_RATE } },
        },
        // 没有它就没有 `input_audio_transcription.completed`，`final_ms` 整列缺失
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        // 只有真的要它答时才挂工具：挂在 `session.update` 里会抬高每轮 `in_text_tok`
        // 基线（实测 150 轮首块没变慢，但那是有 0 次调用的前提下）
        ...(serve ? { tools: [DELEGATE_TOOL], tool_choice: 'auto' } : {}),
      },
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws === null) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.log(`[omni] 发送失败：${(error as Error).message}`);
    }
  }

  private onMessage(raw: Buffer): void {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(raw.toString()) as ServerEvent;
    } catch {
      return;
    }
    switch (ev.type) {
      case 'session.updated':
        this.clearConnectTimer();
        if (this.state === 'connecting') {
          this.state = 'ready';
          this.log('[omni] 影子就绪');
        }
        return;
      case 'response.created':
        if (this.resp !== null) {
          this.resp.created = true;
          if (this.resp.cancelPending) {
            this.resp.cancelPending = false;
            this.send({ type: 'response.cancel' });
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
          this.wakeAudio();
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
    this.log(`[omni] 服务端错误：${message.slice(0, 160)}`);
    // 「在 created 之前 cancel」是我们自己时序问题，已经按 `cancelPending` 修掉；
    // 万一旧路径漏过来一次，它不该把整条车道判死（不计入协议错误）
    if (message.includes('before response.created')) {
      return;
    }
    this.protocolErrors += 1;
    // 「忙时 create」这类错误说明我们的状态机和服务端已经不同步了。
    // 不猜怎么修，直接停 —— 影子还留着的价值不如它污染数据的代价。
    if (this.protocolErrors >= 2) {
      this.break(`连续协议错误：${message.slice(0, 80)}`);
    }
  }

  private finish(ev: ServerEvent): void {
    const resp = this.resp;
    this.resp = null;
    this.clearResponseTimer();
    if (resp !== null) {
      // 先标 closed 再唤醒：读端要知道「再等也没有了」
      resp.closed = true;
      this.wakeAudio(resp);
    }
    if (this.state !== 'broken') {
      this.state = 'ready';
    }

    if (resp !== null) {
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
        cancel_wait_ms: Math.round(resp.sentAt - meta.anchor),
        out_s: Number((resp.outBytes / (DOWNSTREAM_RATE * 2)).toFixed(2)),
        status: ev.response?.status ?? null,
        cancelled: resp.cancelled,
        flushed_ms: meta.flushedMs,
        in_audio_tok: inDetails.audio_tokens ?? null,
        in_text_tok: inDetails.text_tokens ?? null,
        out_audio_tok: outDetails.audio_tokens ?? null,
        local_port: this.localPort,
        ...(this.droppedBytes > 0 ? { dropped_ms: Math.round(this.droppedBytes / BYTES_PER_MILLISECOND) } : {}),
      });
      this.droppedBytes = 0;
    }

    // 排队中的那一份 seal（撞 busy 时的）。
    // 注意用 `pending.bytes`：那段音频的长度在 `seal()` 时就已经记下来了，
    // 之后新到的音频属于**下一段**，不能算进这一份（所以不能重读 `dirtyBytes`）。
    const pending = this.pending;
    if (pending !== null) {
      this.pending = null;
      if (this.state === 'broken') {
        this.emitSkipped(pending.seq, 'broken');
      } else {
        this.sendSeal(pending);
      }
    }
  }

  private emitSkipped(seq: number, why: string): void {
    this.opts.emit({ seq, skipped: why, local_port: this.localPort });
  }

  private break(reason: string): void {
    if (this.state === 'broken') {
      return;
    }
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    this.state = 'broken';
    // 读端不能挂在 await 上等一个永远不会来的块
    const resp = this.resp;
    this.resp = null;
    if (resp !== null) {
      resp.closed = true;
      this.wakeAudio(resp);
    }
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已经断了
      }
    }
    this.log(`[omni] 影子停用：${reason}`);
    // 落一条可见记录：档案里能看出「从这里开始没有 omni 数据」
    this.opts.emit({ seq: null, skipped: 'broken', why: reason.slice(0, 120) });
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

/** base64 长度 → 字节数（不解码，省一次分配） */
function base64Bytes(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - pad;
}
