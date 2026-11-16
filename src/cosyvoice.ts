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
 *
 * `enable_ssml` 不能开：一旦为 true 只允许一次 continue-task，和「边生成边送文本」
 * 互斥，而流式送文本是首包延迟的下一个优化点。
 */

import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { asEmotion, type Emotion } from './emotion.ts';
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
 *   （本项目用到 6 个：neutral / happy / fearful / sad / angry / disgusted；
 *    surprised 目前没有对应情绪，留着备查）
 * - `你正在进行<场景>，你说话的情感是<值>。` → 428
 * - `你说话的角色是<角色>，你说话的情感是<值>。` → 428
 *
 * 所以不要照抄文档里那几种"更花"的写法；在这两个音色上只有单一情感句式可用。
 * 得意/委屈这类细分靠 {@link EMOTION_PROSODY} 叠加 rate/pitch 区分。
 */
export const EMOTION_INSTRUCTIONS: Record<Emotion, string> = {
  happy: '你说话的情感是happy。',
  proud: '你说话的情感是happy。',
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

interface RunTaskArgs {
  readonly text: string;
  readonly emotion: Emotion;
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
  /** 当前 task 的音频接收回调；空闲时为 null */
  private sink: ((chunk: Buffer) => void) | null = null;
  private settle: ((error: Error | null) => void) | null = null;
  private failure: Error | null = null;

  constructor(url: string, apiKey: string) {
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => { resolve(); });
      this.ws.once('error', (error: Error) => { reject(new CosyVoiceError(`连接失败: ${error.message}`)); });
    });
    // 连接级 error 在 open 之后还要继续接住，否则会变成未处理异常
    this.ws.on('error', (error: Error) => {
      this.failure = new CosyVoiceError(`连接异常: ${error.message}`);
      this.settle?.(this.failure);
    });
    this.ws.on('close', () => {
      this.closed = true;
      this.settle?.(this.failure ?? new CosyVoiceError('连接已关闭'));
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
        header?: { event?: string; error_message?: string; error_code?: string };
      };
      const event = message.header?.event;
      if (event === 'task-finished') {
        this.sink = null;
        this.settle?.(null);
        this.settle = null;
        return;
      }
      if (event === 'task-failed') {
        const detail = message.header?.error_message ?? message.header?.error_code ?? '未知错误';
        this.failure = new CosyVoiceError(`合成失败: ${detail}`);
        this.sink = null;
        this.settle?.(this.failure);
        this.settle = null;
      }
    });
  }

  get isUsable(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  get isIdle(): boolean {
    return this.isUsable && this.sink === null && this.settle === null;
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
    const prosody = EMOTION_PROSODY[args.emotion];
    this.sink = onChunk;
    const done = new Promise<Error | null>((resolve) => { this.settle = resolve; });

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

  return {
    name: `cosyvoice:${voice}`,
    sampleRate,
    async *synthesize(text: string, emotion?: string) {
      const previous = chain;
      let release!: () => void;
      chain = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const chunks: Buffer[] = [];
        let notify: (() => void) | null = null;
        let finished = false;
        let failure: Error | null = null;

        const connNow = await acquire();
        const run = connNow.run(
          { text, emotion: asEmotion(emotion) },
          (chunk) => {
            chunks.push(chunk);
            notify?.();
          },
          sampleRate,
          model,
          voice,
          useInstruction,
        ).then(() => { finished = true; notify?.(); })
          .catch((error: unknown) => {
            failure = error instanceof Error ? error : new CosyVoiceError(String(error));
            finished = true;
            drop();
            notify?.();
          });

        // 边收边吐：等整段收完再播会把音频总时长整个加到端到端延迟上
        for (;;) {
          if (chunks.length > 0) {
            yield chunks.shift()!;
            continue;
          }
          if (finished) break;
          await new Promise<void>((resolve) => { notify = resolve; });
          notify = null;
        }
        await run;
        if (failure) throw failure;
        touchIdle();
      } finally {
        release();
      }
    },
  };
}
