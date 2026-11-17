/**
 * 阿里云 CosyVoice 流式语音合成（DashScope WebSocket）。
 *
 * 为什么换：MiMo 走 `/v1/chat/completions`（不是专用 TTS 端点），首包 ~700 ms
 * 且抖动极差 470 ms。CosyVoice 复用同一条 WebSocket 后实测 **~350 ms、极差 < 80 ms**。
 *
 * 几条实测结论决定了这里的写法，别凭直觉改（数字都可用 `scripts/probe-cosyvoice-warm.mjs` 复算）：
 *
 * 1. **必须复用连接**。新连接 ~590 ms 里 ~170 ms 是 TCP+TLS+Upgrade，~60 ms 是
 *    run-task 分配会话，只有剩下那部分是合成。复用同一条 WS 串行跑下一个 task
 *    时前两段几乎归零。
 * 2. **系统音色比复刻音色快，而且方差小**。同一账号、同一区域、同一时刻测：
 *      v3-flash + 系统音色     350–390 ms（单调分布）
 *      v3-flash + 复刻音色     500 ms（305–832，双峰）
 *    → 系统音色是唯一「又快又稳」的选项，所以默认用它。
 * 3. **v3.5-flash 在本账号上并不更快**，尽管官方宣传「tokenizer 帧率减半、首包降低 35%」。
 *    为了排除「音色落在慢池」的干扰，专门在同一时刻创建了一对只差模型的复刻音色：
 *      v3-flash 复刻 500 ms / v3.5 复刻 664 ms（短句，各 8 轮）
 *      v3-flash 复刻 491 ms / v3.5 复刻 711 ms（90 字长句）
 *    两档都慢约 165–220 ms，长句也没逆转。所以选 v3-flash。
 * 4. **音色挑对了才有 `instruction`**。同为 v3-flash 档：
 *      `longanhuan`    ✅ 吃 `你说话的情感是happy。`
 *      `longanhuan_v3` ❌ 428；它只认方言写法（`请用山东话表达。`）
 *    文档里「角色/场景/身份」那几种写法在这两个音色上都是 428，别混用。
 * 5. **`instruction` 和 `rate`/`pitch` 能叠加，且不增加首包**
 *    （happy 基准 351 ms；+rate 1.15 → 377 ms；+pitch 1.1 → 352 ms）。
 *    所以情绪用 instruction 表达语义，rate/pitch 只做细微区分。
 * 6. **一个 task 报错后这条连接上后续 task 全部静默挂死**，必须弃连接重连
 *    （见 `Connection` 的失败处理）。探针里不重连会把「连接废了」误判成「模型慢」。
 * 7. **句尾自带几百毫秒数字静音**（「嗯。」1040 ms 里有约 600 ms 是 −113…−93 dBFS
 *    的底噪）。这些块直接丢，但要留住句间停顿 —— 见 {@link isSilentChunk}。
 *
 * `enable_ssml` 不能开：一旦为 true 只允许一次 continue-task，和「边生成边送文本」
 * 互斥，而流式送文本是首包延迟的下一个优化点。
 */

import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { asEmotion, type Emotion } from './emotion.ts';
import { cleanForSpeech } from './agent.ts';
import type { TtsProvider } from './providers.ts';

const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const DEFAULT_MODEL = 'cosyvoice-v3-flash';
/**
 * 龙安欢：欢脱元气女，20~30 岁 —— 最贴人设的「明亮清甜」。
 *
 * **别写成 `longanhuan_v3`**：那个是同一档下的另一个音色，只认方言指令，
 * 传情感指令会 428（见文件头第 4 条）。
 */
const DEFAULT_VOICE = 'longanhuan';

/** CosyVoice 输出的 PCM16 单声道采样率（与 MiMo 相同，宿主不用改） */
export const COSYVOICE_SAMPLE_RATE = 24_000;

/**
 * 情绪 →（语速, 音调）。**叠加在 instruction 之上的细微区分**。
 *
 * 实测 rate 严格按比例缩放音频字节数（1.15 → −13%，0.9 → +6.4%），所以这些
 * 数值是可预期的，不是玄学调参。纯 rate/pitch 模式（音色不支持 instruction 时）
 * 也用它。
 */
export const EMOTION_PROSODY: Record<Emotion, { readonly rate: number; readonly pitch: number }> = {
  happy: { rate: 1.00, pitch: 1.00 },
  proud: { rate: 1.12, pitch: 1.10 },
  surprised: { rate: 1.05, pitch: 1.18 },
  calm: { rate: 1.00, pitch: 1.00 },
  worried: { rate: 0.95, pitch: 0.97 },
  sulk: { rate: 0.88, pitch: 0.90 },
  angry: { rate: 1.15, pitch: 1.12 },
  disgust: { rate: 0.95, pitch: 0.88 },
};

/**
 * 情绪 → 阿里云 Instruct 文本。
 *
 * **必须是这个固定句式，结尾句号不能省**。实测（`cosyvoice-v3-flash` + `longanhuan`）：
 * - `你说话的情感是<值>。` —— 7 个值全部有效：
 *   neutral / happy / surprised / angry / sad / fearful / disgusted
 *   本项目 8 个情绪映射到这 7 个值（`得意` 借 `happy`，靠 rate/pitch 区分）
 * - `你正在进行<场景>，你说话的情感是<值>。` → 428
 * - `你说话的角色是<角色>，你说话的情感是<值>。` → 428
 *
 * 所以不要照抄文档里那几种"更花"的写法；在这两个音色上只有单一情感句式可用。
 * 得意/委屈这类细分靠 {@link EMOTION_PROSODY} 叠加 rate/pitch 区分。
 */
export const EMOTION_INSTRUCTIONS: Record<Emotion, string> = {
  happy: '你说话的情感是happy。',
  proud: '你说话的情感是happy。',
  surprised: '你说话的情感是surprised。',
  calm: '你说话的情感是neutral。',
  worried: '你说话的情感是fearful。',
  sulk: '你说话的情感是sad。',
  angry: '你说话的情感是angry。',
  disgust: '你说话的情感是disgusted。',
};

export class CosyVoiceError extends Error {}

export interface CosyVoiceOptions {
  /** DashScope 的 API key（`sk-` 开头），不是阿里云 AK/SK */
  readonly apiKey?: string;
  readonly url?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly sampleRate?: number;
  /**
   * 情绪是否用 `instruction` 表达。默认 `true` —— 默认音色 `longanhuan` 支持它，
   * 且实测不增加首包。
   *
   * 换成不支持 `instruction` 的音色（比如 `longanhuan_v3`，只认方言指令）时必须
   * 关掉，否则每句话都会 `Engine return error code: 428`。
   */
  readonly useInstruction?: boolean;
  /** 空闲多久后主动关连接（默认 5 分钟，避免长连接被服务端静默掐掉后下一句话付握手钱） */
  readonly idleCloseMs?: number;
}

/** 阿里云的 task_id 必须 32 位无横线；`randomUUID()` 默认带横线会被拒。 */
const hex32 = (): string => randomUUID().replace(/-/g, '');

/**
 * 一块音频是不是**数字静音**。
 *
 * CosyVoice 会在句尾吐好几百毫秒的静音（实测「嗯。」总共 1040 ms，其中
 * 最后 4 块约 600 ms 是 −113…−93 dBFS 的底噪）。这些数据对听感没有任何贡献，
 * 却会让设备多播一段无声、让状态机晚 ~600 ms 才回到 listening。
 *
 * 阈值取 −80 dBFS：16 bit 满量程是 0 dBFS，−80 dBFS 已经接近 1 LSB，
 * 正常说话（哪怕很轻）不会掉到这里。
 */
export function isSilentChunk(chunk: Buffer, thresholdDb = -80): boolean {
  if (chunk.length < 2) {
    return true;
  }
  let sum = 0;
  const samples = chunk.length >> 1;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const s = chunk.readInt16LE(i);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples);
  if (rms === 0) {
    return true;
  }
  return 20 * Math.log10(rms / 32_768) < thresholdDb;
}

interface RunTaskArgs {
  readonly text: string;
  readonly emotion: Emotion;
}

/**
 * 句首裁切：把第一块里开头的低电平样本削掉。
 *
 * 为什么不能只靠 {@link isSilentChunk}：那个判据是**按整块**算 RMS，而服务端吐的
 * 第一块经常是「120 ms 数字静音 + 起始音」混在一起 —— 整块 RMS 被语音拉高，
 * 静音就跟着推出去了。实测下行开头 146 ms 里前 120 ms 是 −90 dBFS、之后跳到
 * −15 dBFS，用户听到的第一个字被整体推后。
 *
 * 按 5 ms 窗口找第一个超过门槛的位置，再往前留 10 ms 保护起音。整块都低于门槛
 * 时**不动** —— 宁可多播一点，也别把轻声的开头削掉。
 */
export function trimLeadingSilence(chunk: Buffer, sampleRate: number, floorDb = -45): Buffer {
  const winBytes = Math.max(2, Math.round(sampleRate * 0.005)) * 2;
  const maxScan = Math.min(chunk.length, Math.round(sampleRate * 2 * 0.4));
  for (let off = 0; off + 1 < maxScan; off += winBytes) {
    const end = Math.min(off + winBytes, chunk.length);
    let sum = 0;
    let n = 0;
    for (let i = off; i + 1 < end; i += 2) {
      const s = chunk.readInt16LE(i);
      sum += s * s;
      n += 1;
    }
    const rms = Math.sqrt(sum / Math.max(1, n));
    if (20 * Math.log10(Math.max(rms, 1e-9) / 32768) > floorDb) {
      const keepFrom = Math.max(0, off - Math.round(sampleRate * 2 * 0.01));
      return chunk.subarray(keepFrom);
    }
  }
  return chunk;
}

/**
 * 一条可复用连接：串行跑 task，音频边收边吐。
 *
 * 一个 task 的完整生命周期是 run-task → continue-task → finish-task →
 * （二进制音频帧…）→ task-finished。收到 task-finished 后**同一条连接还能接着
 * 跑下一个 task**，这正是 247 ms 的来源。
 */
class Connection {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private closed = false;
  /**
   * 当前 task 的音频接收回调；空闲时为 null。
   *
   * 二进制音频帧**不带 task_id**（服务端只在 JSON 回执里带），而连接同时又只跑
   * 一个 task，所以这一路仍然是单槽。
   */
  private sink: ((chunk: Buffer) => void) | null = null;
  /** `task-started` 的等待者，按 task_id 分槽 */
  private readonly startedWaiters = new Map<string, () => void>();
  /** 等 `task-finished` / `task-failed` 的等待者，按 task_id 分槽 */
  private readonly settleWaiters = new Map<string, (error: Error | null) => void>();
  private failure: Error | null = null;
  /** 探针时刻（`COSYVOICE_TRACE=1` 时才有意义） */
  private traceSentAt = 0;
  private traceStartedAt = 0;
  private traceFirstAt: number | null = null;

  constructor(url: string, apiKey: string) {
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => { resolve(); });
      this.ws.once('error', (error: Error) => { reject(new CosyVoiceError(`连接失败: ${error.message}`)); });
    });
    // 连接级 error 在 open 之后还要继续接住，否则会变成未处理异常
    this.ws.on('error', (error: Error) => {
      this.failure = new CosyVoiceError(`连接异常: ${error.message}`);
      this.failAll(this.failure);
    });
    this.ws.on('close', () => {
      this.closed = true;
      this.failAll(this.failure ?? new CosyVoiceError('连接已关闭'));
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.from(data as Buffer);
        if (chunk.length > 0) {
          this.sink?.(chunk);
        }
        return;
      }
      const message = JSON.parse(String(data)) as {
        header?: { event?: string; task_id?: string; error_message?: string; error_code?: string };
      };
      const event = message.header?.event;
      // 回执都带 task_id（实测 task-started / result-generated / task-finished 全带）。
      // 万一带不上就退回「settle 掉所有等待者」—— 连接同时又只有一个 task，不会错配。
      const taskId = message.header?.task_id;
      if (event === 'task-started') {
        this.traceStartedAt = performance.now();
        this.wakeStarted(taskId);
      }
      if (event === 'task-finished') {
        this.sink = null;
        this.settleTask(taskId, null);
        return;
      }
      if (event === 'task-failed') {
        const detail = message.header?.error_message ?? message.header?.error_code ?? '未知错误';
        this.failure = new CosyVoiceError(`合成失败: ${detail}`);
        this.sink = null;
        this.settleTask(taskId, this.failure);
      }
    });
  }

  /** 叫醒某个 task 的 `task-started` 等待者；没有 task_id 时叫醒所有（只可能有一个） */
  private wakeStarted(taskId: string | undefined): void {
    if (taskId !== undefined) {
      const waiter = this.startedWaiters.get(taskId);
      if (waiter !== undefined) {
        this.startedWaiters.delete(taskId);
        waiter();
      }
      return;
    }
    for (const [id, waiter] of this.startedWaiters) {
      this.startedWaiters.delete(id);
      waiter();
    }
  }

  /** 结束某个 task 的 `settle` 等待者；没有 task_id 时结束所有 */
  private settleTask(taskId: string | undefined, error: Error | null): void {
    if (taskId !== undefined) {
      const waiter = this.settleWaiters.get(taskId);
      if (waiter !== undefined) {
        this.settleWaiters.delete(taskId);
        waiter(error);
      }
      return;
    }
    for (const [id, waiter] of this.settleWaiters) {
      this.settleWaiters.delete(id);
      waiter(error);
    }
  }

  /** 连接断了：所有等待者一起失败，别留下永远等不到的 promise */
  private failAll(error: Error): void {
    for (const [id] of this.startedWaiters) {
      this.startedWaiters.delete(id);
    }
    for (const [id, waiter] of this.settleWaiters) {
      this.settleWaiters.delete(id);
      waiter(error);
    }
  }

  get isUsable(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  get isIdle(): boolean {
    return this.isUsable && this.sink === null && this.settleWaiters.size === 0;
  }

  async open(): Promise<void> {
    await this.ready;
  }

  /**
   * 跑一个 task，把音频块推给 `onChunk`。
   *
   * 被调用方提前 `break` 时，这里仍然会把 `finish-task` 发完并等 `task-finished`，
   * 否则连接上会残留一个半截 task，下一个 task 直接报错。
   */
  async run(
    args: RunTaskArgs,
    onChunk: (chunk: Buffer) => void,
    sampleRate: number,
    model: string,
    voice: string,
    useInstruction: boolean,
  ): Promise<void> {
    if (!this.isIdle) {
      throw new CosyVoiceError('连接正忙');
    }
    const taskId = hex32();
    // 探针（`COSYVOICE_TRACE=1`）：把 346 ms 拆成「task 建立」与「首包合成」。
    // 连接已复用（见类注释），所以这段全是服务端时间，只能靠提前 run-task 或
    // 流式 continue-task 重叠掉。
    const tracing = process.env['COSYVOICE_TRACE'] === '1';
    if (tracing) {
      this.traceSentAt = performance.now();
      this.traceStartedAt = 0;
      this.traceFirstAt = null;
    }
    const probed = (chunk: Buffer): void => {
      if (tracing && this.traceFirstAt === null) {
        this.traceFirstAt = performance.now();
        const setup = this.traceStartedAt === 0 ? Number.NaN : this.traceStartedAt - this.traceSentAt;
        const first = this.traceFirstAt - (this.traceStartedAt === 0 ? this.traceSentAt : this.traceStartedAt);
        console.log(
          `  TTS task  建立 ${setup.toFixed(0)} ms  首包 ${first.toFixed(0)} ms  `
          + `合计 ${(this.traceFirstAt - this.traceSentAt).toFixed(0)} ms`,
        );
      }
      onChunk(chunk);
    };
    const prosody = EMOTION_PROSODY[args.emotion];
    this.sink = probed;
    const done = new Promise<Error | null>((resolve) => { this.settleWaiters.set(taskId, resolve); });

    this.ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model,
        parameters: {
          text_type: 'PlainText',
          voice,
          format: 'pcm',
          sample_rate: sampleRate,
          volume: 50,
          rate: prosody.rate,
          pitch: prosody.pitch,
          ...(useInstruction ? { instruction: EMOTION_INSTRUCTIONS[args.emotion] } : {}),
        },
        input: {},
      },
    }));
    this.ws.send(JSON.stringify({
      header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: { text: args.text } },
    }));
    this.ws.send(JSON.stringify({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} },
    }));

    const error = await done;
    this.sink = null;
    if (error) {
      // 428 = 这个音色不接受这条 instruction。上面那句报错本身不会告诉人怎么改，
      // 这里补上唯一两条出路 —— 否则下次还得再查一遍文档。
      if (useInstruction && error.message.includes('428')) {
        throw new CosyVoiceError(
          `${error.message} —— 当前音色不吃 instruction：`
          + '改用 COSYVOICE_EMOTION_MODE=prosody，或把 COSYVOICE_VOICE 换成 longanhuan',
        );
      }
      throw error;
    }
  }

  /**
   * 边生成边合成的 task：`batches` 每来一段文本就 `continue-task` 一次，
   * 取完之后自动 `finish-task`。
   *
   * 为什么值得这么麻烦：实测 task 建立只要 62 ms，**首包合成要 281 ms**。
   * 那 281 ms 只能靠把文本提前送上去、和模型生成重叠，而不是靠连接复用（早就复用了）。
   *
   * **必须先拿到第一段文本再 run-task**：服务端对一个「开了却没有任何正文」的 task
   * 会回 `task-failed: Please ensure input text is valid.`。以前这里是先 run-task
   * 再喂文本，于是只要文本来得稍慢（或这条流一个字都没放出来），就会白跑一个 task、
   * 报错、再退回整段合成 —— 生产 7 天约 2 次，本地必现，单轮多花 300–600 ms。
   * 调用方（`synthesizeStream`）也把「取不到文本」当正常收尾，不再抛。
   */
  async runFeed(
    emotion: Emotion,
    sampleRate: number,
    model: string,
    voice: string,
    useInstruction: boolean,
    batches: AsyncIterable<string>,
    onChunk: (chunk: Buffer) => void,
  ): Promise<void> {
    if (!this.isIdle) {
      throw new CosyVoiceError('连接正忙');
    }
    const iterator = batches[Symbol.asyncIterator]();
    // 先取第一段文本：取不到就**根本不开 task**（见方法注释里的空 task 问题）。
    // 但要抛出来让调用方走兜底 —— 否则这一轮正文就是哑的。
    const first = await iterator.next();
    if (first.done === true) {
      throw new CosyVoiceError('流式无正文（侧通道一个字都没放出来）');
    }
    const taskId = hex32();
    const prosody = EMOTION_PROSODY[emotion];
    // 探针（`COSYVOICE_TRACE=1`），和 `run` 打同一行、同样两段，两条路才比得了：
    //   建立 = run-task → task-started
    //   首包 = **首批文本送出** → 首块音频
    // 首包不能从 run-task 算：流式的 run-task 在本轮一开始就发了，中间夹着等模型开口。
    // 所以这里也没有「合计」—— 那个数在流式下量的是模型，不是 TTS。
    const tracing = process.env['COSYVOICE_TRACE'] === '1';
    const sentAt = performance.now();
    this.traceStartedAt = 0;
    let firstTextAt = 0;
    let traced = false;
    this.sink = (chunk: Buffer): void => {
      if (tracing && !traced) {
        traced = true;
        // 缺哪个时刻就打 NaN，不拿 0 冒充
        const setup = this.traceStartedAt === 0 ? Number.NaN : this.traceStartedAt - sentAt;
        const first = firstTextAt === 0 ? Number.NaN : performance.now() - firstTextAt;
        console.log(
          `  TTS task  建立 ${setup.toFixed(0)} ms  首包 ${first.toFixed(0)} ms  `
          + '（流式：首包自首批文本送出起算）',
        );
      }
      onChunk(chunk);
    };
    const done = new Promise<Error | null>((resolve) => { this.settleWaiters.set(taskId, resolve); });

    this.ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model,
        parameters: {
          text_type: 'PlainText',
          voice,
          format: 'pcm',
          sample_rate: sampleRate,
          volume: 50,
          rate: prosody.rate,
          pitch: prosody.pitch,
          ...(useInstruction ? { instruction: EMOTION_INSTRUCTIONS[emotion] } : {}),
        },
        input: {},
      },
    }));

    const send = (text: string): void => {
      if (firstTextAt === 0) firstTextAt = performance.now();
      this.ws.send(JSON.stringify({
        header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: { text } },
      }));
    };

    let feedError: Error | null = null;
    try {
      // 必须等 task-started 再送文本：服务端在分配完成前收到 continue-task 会报
      // `Please ensure input text is valid.`（实测踩过，看起来像文本有问题，其实是时序）
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        // 按 task_id 注册：回执与正文在同一条连接上先后跑，共用一个槽位会让
        // 前一个 task 的 task-started 落到后一个头上，于是后者在自己的 task
        // 尚未 started 时就送文本，服务端报上面那个错（生产 7 天 2 次）。
        this.startedWaiters.set(taskId, () => { clearTimeout(timer); resolve(); });
      });
      this.startedWaiters.delete(taskId);
      send(first.value);
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        send(next.value);
      }
    } catch (error) {
      feedError = error instanceof Error ? error : new CosyVoiceError(String(error));
    }
    this.ws.send(JSON.stringify({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} },
    }));

    const error = await done;
    this.sink = null;
    if (feedError) throw feedError;
    if (error) throw error;
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch { /* 已经关了 */ }
  }
}

/**
 * 把 CosyVoice 包成 {@link TtsProvider}。
 *
 * 内部保持**一条长连接**并串行复用（语音 agent 一轮只说一句，并发没有收益，
 * 串行才能吃到「握手成本归零」）。断线或报错后下一次 synthesize 自动重连 ——
 * 一个 task 失败后同一条连接上后续 task 会静默挂死，必须弃掉。
 */
/** 流式合成时每次 `continue-task` 送的字符数。太小会让服务端攒着不合成，太大等于没重叠 */
const STREAM_BATCH_CHARS = 10;

/**
 * 第一批的最小长度。
 *
 * 快车道的回答常常不到 10 个字（人设要求二十字以内），按 10 字门槛要等到
 * `queue.close()` —— 也就是整段生成结束之后才开始合成，「边生成边合成」退化成
 * 「等整段再合成」，短答反而比长答更慢。剥掉开头情绪标签之后只要有正文就先送一批。
 */
const FIRST_BATCH_CHARS = 2;

/** 这一批够不够送：第一批只看有没有正文，之后按 {@link STREAM_BATCH_CHARS} 攒。 */
export function streamBatchReady(batch: string, first: boolean): boolean {
  return batch.length >= (first ? FIRST_BATCH_CHARS : STREAM_BATCH_CHARS);
}

/**
 * 批尾是不是一个没闭合的标签（`[平静`）。
 *
 * 第一批门槛降到两个字之后，增量可能在标签中间断批（`[` / `平静` / `]`），
 * 这时送出去会被当成正文念出来。等闭合括号到了再送。
 */
function hasUnclosedTag(batch: string): boolean {
  const open = Math.max(batch.lastIndexOf('['), batch.lastIndexOf('【'));
  const close = Math.max(batch.lastIndexOf(']'), batch.lastIndexOf('】'));
  return open > close;
}

/**
 * 「数字 / 编号」里会出现的字符。
 *
 * 中文数字必须算进来：人设要求数字写成念法，实际送进 TTS 的是「六四一四室」，
 * 只认 `\d` 一个都拦不住。字母也算（订单号是 `W 八六六五八八一`）。
 */
const NUMBERISH = '0-9A-Za-z零〇一二三四五六七八九十百千万亿两';
/**
 * 批尾的一串数字。中间允许空格，也允许**紧跟在数字后面**的量词 —— 金额是
 * 「三千四百九十四块九毛六」这种数字和量词交替的写法（实测切成过「…九毛」「六」）。
 * 量词前面必须是数字，所以「说具体点。」里的「点」不算。
 *
 * 写成「单字符、互斥分支」是故意的：`(?:数字+量词?)+` 那种嵌套量词在一长串
 * 字母数字后面跟个标点时会指数级回溯。
 */
const TRAILING_NUMBER = new RegExp(
  `[${NUMBERISH}](?:[${NUMBERISH} ]|(?<=[${NUMBERISH}])[块毛元角分点])*$`,
  'u',
);
/** 整批都是数字时最多再多攒这么多字；超了照送 —— 长编号里没有更好的切点 */
const STREAM_NUMBER_SLACK = 6;

/**
 * 决定一批文本送多少、留多少：**批次边界不落在数字中间**。
 *
 * 按字数硬切会把「六四一四室」切成「…是六」「四一室了」，两半各自合成，数字的
 * 语调就断了。做法不是加大批次（那会把重叠的收益吃回去），而是把批尾那串数字
 * **留到下一批**：数字前面的字照常立刻送，不多等；数字和它后面的量词（「室」）
 * 自然落进同一批。
 *
 * @returns `send` 为空串表示这批先不送（整批都是数字，再等等）
 */
export function splitStreamBatch(batch: string): { readonly send: string; readonly keep: string } {
  const at = batch.search(TRAILING_NUMBER);
  if (at < 0) {
    return { send: batch, keep: '' };
  }
  if (at > 0) {
    return { send: batch.slice(0, at), keep: batch.slice(at) };
  }
  return batch.length >= STREAM_BATCH_CHARS + STREAM_NUMBER_SLACK
    ? { send: batch, keep: '' }
    : { send: '', keep: batch };
}

export function cosyVoiceTts(options: CosyVoiceOptions = {}): TtsProvider {
  const apiKey = options.apiKey ?? process.env['DASHSCOPE_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new CosyVoiceError('未设置 DASHSCOPE_API_KEY');
  }
  const url = options.url ?? process.env['COSYVOICE_URL'] ?? DEFAULT_URL;
  const model = options.model ?? process.env['COSYVOICE_MODEL'] ?? DEFAULT_MODEL;
  const voice = options.voice ?? process.env['COSYVOICE_VOICE'] ?? DEFAULT_VOICE;
  const sampleRate = options.sampleRate ?? COSYVOICE_SAMPLE_RATE;
  /**
   * 情绪表达方式：`instruction`（默认，语义级）或 `prosody`（只调 rate/pitch，
   * 给不支持 instruction 的音色用）。
   *
   * 为什么不复用 `COSYVOICE_INSTRUCTION`：探针里那个变量是**指令文本**，
   * 同一个名字两种语义迟早出错，所以运行时单独一个变量。
   */
  const envMode = process.env['COSYVOICE_EMOTION_MODE'] ?? 'instruction';
  const useInstruction = options.useInstruction ?? envMode === 'instruction';
  const idleCloseMs = options.idleCloseMs ?? 5 * 60_000;

  let conn: Connection | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 串行闸门：上一个 task 收尾完才开下一个 */
  let chain: Promise<unknown> = Promise.resolve();

  const drop = (): void => {
    conn?.close();
    conn = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const acquire = async (): Promise<Connection> => {
    if (conn && conn.isUsable) {
      return conn;
    }
    drop();
    const fresh = new Connection(url, apiKey);
    await fresh.open();
    conn = fresh;
    return fresh;
  };

  const touchIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(drop, idleCloseMs);
    idleTimer.unref?.();
  };

  /**
   * 跑一个 task，把音频边收边吐。
   *
   * `synthesize` 和 `synthesizeStream` 只差「文本怎么送」（`start`），排队、收块、
   * 静音处理、失败与中途退出的收尾全在这里。以前两边各抄一份，「中途退出」那个
   * bug 就是只修了一边。
   */
  async function* pump(
    start: (connNow: Connection, onChunk: (chunk: Buffer) => void) => Promise<void>,
  ): AsyncGenerator<Buffer> {
    const previous = chain;
    let release!: () => void;
    chain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    /** 这个 task 占着的连接；`finished` 之前它都不空闲 */
    let live: Connection | null = null;
    let finished = false;
    try {
      const chunks: Buffer[] = [];
      let notify: (() => void) | null = null;
      let failure: Error | null = null;

      const connNow = await acquire();
      live = connNow;
      const run = start(connNow, (chunk) => {
        chunks.push(chunk);
        notify?.();
      }).then(() => { finished = true; notify?.(); })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new CosyVoiceError(String(error));
          finished = true;
          // 只弃**自己那条**：这个回调可能来得很晚（见下面 finally），那时 `conn`
          // 已经是下一轮新建的连接了，无条件 drop 会把人家正在跑的 task 掐掉
          if (conn === connNow) drop();
          notify?.();
        });

      // 边收边吐：等整段收完再播会把音频总时长整个加到端到端延迟上。
      //
      // 静音块单独处理：**先攒着**，等后面出现有声块才补发（句间停顿要保留），
      // 流结束时剩下的直接丢弃（句尾静音没人想听）。
      //
      // 但**句首的静音一个字节都不发**：CosyVoice 第一块就是 ~167 ms 底噪
      // （实测 24 kHz / 167 ms，见 `probe-cosyvoice`），原来照发，等于用户多等
      // 这么久才听到第一个字 —— 那段时间里设备在播数字静音。`voiced` 之前攒的
      // 静音直接丢，之后才按上面的规则保留。
      const heldSilence: Buffer[] = [];
      let voiced = false;
      for (;;) {
        if (chunks.length > 0) {
          const chunk = chunks.shift()!;
          if (isSilentChunk(chunk)) {
            if (voiced) heldSilence.push(chunk);
            continue;
          }
          if (heldSilence.length > 0) {
            yield Buffer.concat(heldSilence);
            heldSilence.length = 0;
          }
          voiced = true;
          // 第一块里常夹着开头的数字静音（服务端一块可能横跨静音与起音），块内裁掉
          yield trimLeadingSilence(chunk, sampleRate);
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => { notify = resolve; });
        notify = null;
      }
      heldSilence.length = 0;
      await run;
      if (failure) throw failure;
      touchIdle();
    } finally {
      // 调用方中途退出（插话 / 旁白被取消：for-await 里 return 或 break）时 task 还挂在
      // 连接上 —— 服务端还在出音频，流式的话文本也没送完。这时放开闸门，下一个 task
      // 一上来就 run-task，会撞上「连接正忙」（实测：上一轮被打断后 0.46 s 开下一轮）。
      // 弃掉这条连接等于取消 task；重连那 ~170 ms 落在下一轮等模型开口的时间里。
      if (live !== null && !finished && conn === live) drop();
      release();
    }
  }

  return {
    name: `cosyvoice:${voice}`,
    sampleRate,
    /**
     * 预建连接（TCP+TLS+Upgrade，实测 ~170 ms）。
     *
     * 由宿主在**设备连上那一刻**调：用户还没开口，这段时间白拿。`run-task` 不能提前
     * —— 那要绑定具体的 task（~60 ms，只能到这一轮开始时再发）。失败什么都不影响，
     * 下一次 `acquire()` 会重建。
     */
    warm() {
      void acquire().catch(() => { /* 预热失败按懒加载处理 */ });
    },
    synthesize(text: string, emotion?: string) {
      return pump((connNow, onChunk) => connNow.run(
        { text, emotion: asEmotion(emotion) },
        onChunk,
        sampleRate,
        model,
        voice,
        useInstruction,
      ));
    },

    /**
     * 边生成边合成：文本块一进来就 `continue-task` 喂给服务端。
     *
     * 收益来源是**重叠**而不是复用：连接早就复用了，task 建立也只占 62 ms，
     * 真正贵的是首包合成 281 ms —— 只有把文本提前送上去才能盖住它。
     */
    synthesizeStream(chunksIn: AsyncIterable<string>, emotion?: string) {
      const tracing = process.env['COSYVOICE_TRACE'] === '1';
      /**
       * 把模型吐的文本增量攒成「一批一批要送进 TTS 的正文」。
       *
       * 做成生成器而不是「回调里 send」，是为了让 `runFeed` 能**先拿到第一批
       * 再决定要不要开 task** —— 一个字都没有时开 task 会被服务端判为非法输入。
       */
      const batches = async function* (): AsyncGenerator<string> {
        let batch = '';
        let first = true;
        const clean = (raw: string, tail: boolean): string | null => {
          // 情绪标签 / markdown 不能进 TTS（会被念出来），逐批清洗；首批还要去掉开头的 [xxx]
          const text = cleanForSpeech(first ? raw.replace(/^\s*\[[^\]]{1,8}\]/, '') : raw);
          if (text === '') return null;
          // 标志只在**真的送出一批**之后才落下：整批都是标签时不能把它吃掉，
          // 否则下一批就会被当成「后续批次」，开头的标签会漏进 TTS
          first = false;
          // 尾批也要打：短答（不足一批）只有这一次送文本，不打的话
          // `grep -c 送批` 是 0，和「一个字都没送」分不开
          if (tracing) console.log(`  TTS 送批 ${JSON.stringify(text)}${tail ? '（尾）' : ''}`);
          return text;
        };
        for await (const text of chunksIn) {
          batch += text;
          if (!streamBatchReady(batch, first)) continue;
          if (first && hasUnclosedTag(batch)) continue;
          const cut = splitStreamBatch(batch);
          batch = cut.keep;
          if (cut.send !== '') {
            const ready = clean(cut.send, false);
            if (ready !== null) yield ready;
          }
        }
        if (batch !== '') {
          const ready = clean(batch, true);
          if (ready !== null) yield ready;
        }
      };
      return pump((connNow, onChunk) => connNow.runFeed(
        asEmotion(emotion),
        sampleRate,
        model,
        voice,
        useInstruction,
        batches(),
        onChunk,
      ));
    },
  };
}
