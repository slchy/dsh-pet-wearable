/**
 * **omni 当朗读机**：文本 → PCM16，走一条**专用**的 DashScope realtime 连接。
 *
 * <h2>为什么不复用聊天那条</h2>
 *
 * 朗读靠的是「念这段：<文本>」这一条 user 消息。塞进聊天连接的话，那一句会永久躺在
 * omni 的对话历史里 —— 下一轮它以为用户刚让它念过东西。所以这里自带一条连接，
 * 而且每次合成完把用掉的两条 item 删掉（`conversation.item.delete`，实测语义级生效），
 * 免得朗读历史越滚越长、把后面的输入 token 拖起来。
 *
 * <h2>逐字忠实度（2026-11-22 实测，`tmp/omni-probe/s5-fidelity.cjs`）</h2>
 *
 * 4 段素材（真机 dsh 长答 / 含年份 / 数字与百分号 / 英文缩写）：**全部 100%**，
 * 0 漏字 0 多字，也没有「好的，以下是」这类前缀。连生产那套「只回 20 字 + 挂 tools」
 * 的 instructions 都压不住它 —— 「念这段：」这个明确框架赢了。
 * 所以 `instructions` 用朗读器版本，`emotion` 直接忽略（omni 没有韵律参数）。
 *
 * <h2>已知代价（都是实测值，别当 bug 去修）</h2>
 *
 * - 语速 ~4.0–4.4 字/秒，CosyVoice 5.45–5.66 —— 同一段话要念得久
 * - 首块 629–781 ms，CosyVoice 系统音色 350–390 ms
 * - 输出音频按 token 计费（`out_s × 12.5`），比按字计费贵
 *
 * <h2>为什么 `synthesizeStream` 是「攒完再念」而不是逐句</h2>
 *
 * 逐句念的话，每句之间要等一次 `item.create → response.create → 首块`（~630 ms），
 * 151 字的答案（4 句）就有 ~1.9 s 死空气。攒完整段发一次，中间是连续的。
 * 代价是首块要等文本生成完 —— 对委派轮来说本来就是「等 dsh 想完」，
 * 多出来的只有那 630 ms。
 */
import WebSocket from 'ws';

import type { TtsProvider } from './providers.ts';

const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DEFAULT_MODEL = 'qwen3.8-omni-flash-realtime';
/** omni 的输出采样率（`session.update` 的 `audio.output.format` 里声明的） */
export const OMNI_TTS_SAMPLE_RATE = 24_000;

/**
 * 朗读器人格。
 *
 * **不能写「只回一句话」「不超过 N 个字」这类约束**：那是聊天用的，会把长文本截短。
 * 也不能提「如果决定调用工具…」—— 这条连接根本不挂 tools。
 */
const READER_INSTRUCTIONS = '你是一台朗读器。用户给你一段文本，你逐字念出来：'
  + '不许改字、不许漏字、不许解释、不许加任何前缀或结尾语、不许把数字读成汉字。';

/** 念这段的包装。带冒号是为了让「朗读」意图无歧义 —— 实测它比任何提示词都管用。 */
const readPrompt = (text: string): string => `念这段：${text}`;

export interface OmniTtsOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  readonly log?: (line: string) => void;
  /** 测试注入 */
  readonly socketFactory?: (url: string, apiKey: string) => RealtimeLike;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
}

/** 只用到这么点成员，抽出来是为了单测能塞假 socket（与 `qwen-realtime-asr` 同构）。 */
export interface RealtimeLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: never[]) => void): void;
}

interface ServerEvent {
  type?: string;
  delta?: string;
  item?: { id?: string; role?: string };
  error?: { message?: string };
  response?: { status?: string; output?: Array<{ id?: string; role?: string }> };
}

const CLOSED = 3;

export function omniTts(options: OmniTtsOptions): TtsProvider {
  const log = options.log ?? (() => {});
  let ws: RealtimeLike | null = null;
  let ready = false;
  let connecting: Promise<void> | null = null;
  /** 待处理事件队列（一次只有一个合成在跑，所以单队列够） */
  let queue: ServerEvent[] = [];
  let wake: (() => void) | null = null;
  /** 上一次合成留下的 item id，下次合成前删掉 */
  let garbage: string[] = [];

  const take = (ms: number): Promise<ServerEvent | null> => {
    const head = queue.shift();
    if (head !== undefined) {
      return Promise.resolve(head);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer !== null) clearTimeout(timer);
        if (wake === done) wake = null;
        resolve(null);
      };
      timer = setTimeout(done, ms);
      wake = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        resolve(queue.shift() ?? null);
      };
    });
  };
  const push = (ev: ServerEvent): void => {
    if (wake !== null) {
      const w = wake;
      wake = null;
      queue.push(ev);
      w();
      return;
    }
    queue.push(ev);
  };

  const send = (payload: unknown): void => {
    try {
      ws?.send(JSON.stringify(payload));
    } catch (error) {
      log(`[omni-tts] 发送失败: ${(error as Error).message}`);
    }
  };

  const ensure = async (): Promise<void> => {
    if (ready && ws !== null && ws.readyState !== CLOSED) {
      return;
    }
    if (connecting !== null) {
      await connecting;
      return;
    }
    connecting = (async () => {
      const factory = options.socketFactory
        ?? ((url, apiKey) => new WebSocket(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          maxPayload: 16 << 20,
        }) as unknown as RealtimeLike);
      const url = `${options.url ?? DEFAULT_URL}?model=${encodeURIComponent(options.model ?? DEFAULT_MODEL)}`;
      const socket = factory(url, options.apiKey);
      ws = socket;
      ready = false;
      queue = [];
      wake = null;
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => { resolve(); });
        socket.on('error', (...args: never[]) => {
          reject(new Error(`连接失败: ${String(args[0])}`));
        });
      });
      socket.on('message', (...args: never[]) => {
        let ev: ServerEvent;
        try {
          ev = JSON.parse(String(args[0])) as ServerEvent;
        } catch {
          return;
        }
        if (ev.type === 'session.updated') {
          ready = true;
        }
        push(ev);
      });
      socket.on('close', () => {
        if (ws !== socket) return;
        log('[omni-tts] 连接关闭');
        ws = null;
        ready = false;
      });
      send({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: READER_INSTRUCTIONS,
          // 朗读不需要服务端判停；保持与聊天那条一致的「手动」语义
          turn_detection: null,
          audio: {
            input: {
              format: {
                type: 'pcm',
                sample_rate: 16_000,
                sample_format: 's16le',
                channels: 1,
                packing: 'interleaved',
                channel_layout: 'mono',
              },
            },
            output: { format: { type: 'pcm', sample_rate: OMNI_TTS_SAMPLE_RATE } },
          },
        },
      });
      const deadline = Date.now() + (options.connectTimeoutMs ?? 15_000);
      while (!ready) {
        if (Date.now() > deadline) {
          throw new Error('握手超时');
        }
        const ev = await take(500);
        if (ev === null) continue;
        if (ev.type === 'error') {
          throw new Error(`握手被拒: ${String(ev.error?.message ?? '').slice(0, 100)}`);
        }
      }
      log('[omni-tts] 已就绪');
    })();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  };

  /** 把上一次用过的 item 删掉，别让朗读历史滚起来 */
  const cleanGarbage = (): void => {
    if (garbage.length === 0) {
      return;
    }
    for (const id of garbage.splice(0)) {
      send({ type: 'conversation.item.delete', item_id: id });
    }
  };

  async function* readOne(text: string): AsyncIterable<Buffer> {
    if (text.trim() === '') {
      return;
    }
    await ensure();
    cleanGarbage();

    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: readPrompt(text) }] },
    });
    send({ type: 'response.create' });

    const deadline = Date.now() + (options.responseTimeoutMs ?? 30_000);
    let userItemId: string | null = null;
    let assistantId: string | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        log('[omni-tts] 合成超时，弃连接');
        close();
        return;
      }
      const ev = await take(1_000);
      if (ev === null) {
        continue;
      }
      if (ev.type === 'conversation.item.created' && ev.item?.role === 'user' && typeof ev.item.id === 'string') {
        userItemId = ev.item.id;
        continue;
      }
      if (ev.type === 'response.output_item.added' && ev.item?.role === 'assistant' && typeof ev.item.id === 'string') {
        assistantId = ev.item.id;
        continue;
      }
      if (ev.type === 'response.audio.delta') {
        if ((ev.delta ?? '') !== '') {
          yield Buffer.from(ev.delta as string, 'base64');
        }
        continue;
      }
      if (ev.type === 'response.done') {
        for (const it of ev.response?.output ?? []) {
          if (it.role === 'assistant' && typeof it.id === 'string') {
            assistantId = it.id;
          }
        }
        break;
      }
      if (ev.type === 'error') {
        log(`[omni-tts] 服务端错误: ${String(ev.error?.message ?? '').slice(0, 120)}`);
        // 一次报错之后这条连接上后续合成会静默挂死（与 CosyVoice 同款毛病），弃掉重建
        close();
        return;
      }
    }
    // 这一句用过的两条 item 下次合成前删
    garbage = [userItemId, assistantId].filter((id): id is string => id !== null);
  }

  function close(): void {
    const socket = ws;
    ws = null;
    ready = false;
    queue = [];
    wake = null;
    garbage = [];
    try {
      socket?.close();
    } catch {
      // 已断
    }
  }

  return {
    name: 'omni',
    sampleRate: OMNI_TTS_SAMPLE_RATE,
    warm(): void {
      void ensure().catch((error: Error) => { log(`[omni-tts] 预热失败（忽略）: ${error.message}`); });
    },
    synthesize(text: string): AsyncIterable<Buffer> {
      return readOne(text);
    },
    /**
     * 攒完再念（见文件头）。首块要等文本生成完 + ~630 ms；换来的是句间没有死空气。
     */
    async* synthesizeStream(chunks: AsyncIterable<string>): AsyncIterable<Buffer> {
      let all = '';
      for await (const part of chunks) {
        all += part;
      }
      yield* readOne(all);
    },
  };
}
