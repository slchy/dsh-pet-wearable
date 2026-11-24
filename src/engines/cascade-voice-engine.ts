/**
 * Cascade 引擎：**LLM → TTS**（没有音频直出的那条路）。
 *
 * 两条出话路径都在这儿，内核看不出区别（`engine-contract.ts` 第 5 条契约）：
 *
 * - `tts.synthesizeStream` 在：`ask` 的增量一出来就送 TTS，首包与模型生成重叠
 *   （结构性省掉「等整段 → 再合成」那一整个相位）；流式失败或一个音频块都
 *   没有、但清洗后的 `speech` 非空时，退回整段 `synthesize`，不许静音收场；
 * - 没有：等 `ask` 回来拿 `speech` 走整段 `synthesize`。
 *
 * **为什么用端口注入而不是接 `FrontedAgent`**：这个引擎只需要四个动作
 * （问、合成、转发上行、报告放弃投机）。直接依赖具体 agent 会把「谁答的」
 * 「怎么记历史」一起拉进来，而那是内核与宿主的事。端口小到测试里能一眼写完。
 *
 * 事件合并是必须的：文本增量的斜率是「模型吐字」，音频的斜率是「TTS 出包」，
 * 串行等任何一边都会把另一边压在队里。所以两个生产者都往同一个队列里放，
 * `respond()` 只从队列里取 —— 顺序天然是**到达顺序**。
 */
import type { EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import type { TtsProvider } from '../providers.ts';
import { TokenQueue } from '../token-queue.ts';
import { createAbortGate, EventQueue, spokenFromStream } from './stream-utils.ts';

/** `ask` 交回来的东西：编排层真正需要的字段，不多不少 */
export interface CascadeAnswer {
  /** 原始文本（记账 / 日志） */
  readonly text: string;
  /** 清洗后送 TTS 的文本 */
  readonly speech: string;
  /** 情绪 key（见 `emotion.ts`）；整段合成时用，流式那条路拿不到 */
  readonly emotion?: string;
  /** 这一轮要不要转交 dsh */
  readonly delegated?: boolean;
  /** 转交原因（`delegated` 为真时给内核记账） */
  readonly delegateReason?: string;
  /** 这一轮由谁答的（`'fast'` 快车道 / `'dsh'` 慢车道） */
  readonly path?: 'fast' | 'dsh';
  /** 模型首 token 延迟（ms），进 `meta.firstTokenMs` */
  readonly firstTokenMs?: number;
}

/** 注入给引擎的端口。全部由宿主实现，引擎不 import 任何具体 provider */
export interface CascadeEnginePorts {
  /** 快车道现在能不能答（纯读，不改账） */
  readonly isReady: () => boolean;
  /**
   * 问一次模型。
   *
   * `emit` 是**逐字增量**：接进 `synthesizeStream` 就能边生成边合成；
   * 同时这些增量也会原样进 `EngineEvent`（记账 / 逐字对齐用）。
   */
  readonly ask: (
    turn: TurnInput,
    emit: (delta: string) => void,
    signal: AbortSignal,
  ) => Promise<CascadeAnswer>;
  readonly tts: TtsProvider;
  readonly onPartial?: (text: string) => void;
  readonly onFinal?: (text: string) => void;
  readonly onAbort?: (reason: 'delegated' | 'superseded' | 'barge_in') => void;
  /** 墙钟。不传就用 `Date.now`。`firstSynthAtMs` 只认它 */
  readonly clock?: () => number;
  /**
   * 旁白还在念时，本轮 TTS 要等它播完再开口。
   *
   * 返回的是**当前**那条链（宿主每开一条旁白就换一条新 Promise），所以是取值函数
   * 而不是一根固定的 Promise。
   */
  readonly speechChain?: () => Promise<void>;
  readonly log?: (line: string) => void;
}

async function waitGate(
  chain: (() => Promise<void>) | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (chain === undefined || signal.aborted) {
    return;
  }
  let chained: Promise<void>;
  try {
    chained = chain();
  } catch {
    return;
  }
  const gate = createAbortGate(signal);
  try {
    await Promise.race([chained.catch(() => undefined), gate.done]);
  } finally {
    gate.cancel();
  }
}

export class CascadeVoiceEngine implements FastVoiceEngine {
  readonly mode = 'cascade' as const;

  private readonly ports: CascadeEnginePorts;

  constructor(ports: CascadeEnginePorts) {
    this.ports = ports;
  }

  isHealthy(): boolean {
    return this.ports.isReady();
  }

  onAsrPartial(text: string, commitSeq: number): void {
    // 因果序号归内核：引擎只关心「这一刻听到了什么」
    void commitSeq;
    this.ports.onPartial?.(text);
  }

  onAsrFinal(text: string, commitSeq: number): void {
    void commitSeq;
    this.ports.onFinal?.(text);
  }

  abortSpeculation(reason: 'delegated' | 'superseded' | 'barge_in'): void {
    this.ports.onAbort?.(reason);
  }

  private now(): number {
    return (this.ports.clock ?? Date.now)();
  }

  async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    if (signal.aborted) {
      return;
    }
    const queue = new EventQueue<EngineEvent>();
    /** 送进流式 TTS 的文本。没有 `synthesizeStream` 时它只是空跑 */
    const textIn = new TokenQueue();
    const tts = this.ports.tts;
    const useStream = tts.synthesizeStream !== undefined;
    let answer: CascadeAnswer | null = null;
    /**
     * TS 不追踪「在别的闭包里赋值」的变量：直接读 `answer` 会把它窄化成 `null`
     * （于是下面的判空写出 `never`）。加一层显式返回类型把它还原。
     */
    const settled = (): CascadeAnswer | null => answer;
    /** 流式增量原文。多步时比 `answer.speech`（最后一步）长 */
    let streamedRaw = '';
    /** 送给 TTS 的起始墙钟。0 = 还没送过。回落整段时改写成新的起点 */
    let firstSynthAtMs = 0;
    /** 流式真的吐出过音频，且没有退回整段。只有这时 `done.speech` 才用全文增量 */
    let streamOk = false;

    const onAbort = (): void => {
      // 关掉两个队列：`respond()` 立刻能退出，TTS 那边也不会再等文本
      textIn.close();
      queue.close();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const askRun = (async (): Promise<void> => {
      try {
        answer = await this.ports.ask(turn, (delta) => {
          if (delta === '') {
            return;
          }
          queue.push({ type: 'text', delta });
          if (useStream) {
            streamedRaw += delta;
            // 起点是「有文本可送」，不是合成任务开跑：任务在本轮一开始就发了，
            // 从那儿算会把模型生成整段记到 TTS 头上。
            if (firstSynthAtMs === 0) {
              firstSynthAtMs = this.now();
            }
          }
          textIn.push(delta);
        }, signal);
      } catch {
        // 引擎没有错误事件：这一轮按「零文本」收尾，内核照常结算
      } finally {
        textIn.close();
      }
    })();

    const pushAudio = (pcm: Buffer): void => {
      queue.push({ type: 'audio', pcm, sampleRate: tts.sampleRate });
    };

    const fallbackWhole = async (reason: string): Promise<void> => {
      if (signal.aborted) {
        return;
      }
      await askRun;
      if (signal.aborted) {
        return;
      }
      const done = settled();
      const text = done?.speech ?? '';
      if (text.trim() === '') {
        return;
      }
      this.ports.log?.(`  流式    ✗ ${reason}，退回整段合成`);
      // 兜底这次才是真正的「送文本」时刻，口径同整段合成
      firstSynthAtMs = this.now();
      streamOk = false;
      for await (const pcm of tts.synthesize(text, done?.emotion)) {
        if (signal.aborted) {
          return;
        }
        pushAudio(pcm);
      }
    };

    const audioRun = (async (): Promise<void> => {
      try {
        const stream = tts.synthesizeStream?.bind(tts);
        if (stream !== undefined) {
          await waitGate(this.ports.speechChain, signal);
          if (signal.aborted) {
            return;
          }
          let audioChunks = 0;
          try {
            // 边生成边合成：情绪标签要等 `ask` 返回才知道，这条路拿不到，按默认语气
            for await (const pcm of stream(textIn)) {
              if (signal.aborted) {
                return;
              }
              audioChunks += 1;
              pushAudio(pcm);
            }
          } catch (error) {
            if (signal.aborted) {
              return;
            }
            // 最常见：一个字都没收到，服务端拒空文本。退回整段，宁可慢也不能哑。
            await fallbackWhole((error as Error).message);
            return;
          }
          if (signal.aborted) {
            return;
          }
          // 流正常结束但一块音频都没有，而清洗后的正文非空：同样不许静音收场
          await askRun;
          if (signal.aborted) {
            return;
          }
          const done = settled();
          if (audioChunks === 0 && (done?.speech.trim() ?? '') !== '') {
            await fallbackWhole('没有音频到达');
            return;
          }
          streamOk = true;
          return;
        }
        // 回落：等整段回来再合成（首包晚一个生成周期，但实现简单）
        await askRun;
        const done = settled();
        if (done === null || signal.aborted) {
          return;
        }
        const text = done.speech !== '' ? done.speech : done.text;
        if (text.trim() === '') {
          return;
        }
        await waitGate(this.ports.speechChain, signal);
        if (signal.aborted) {
          return;
        }
        firstSynthAtMs = this.now();
        for await (const pcm of tts.synthesize(text, done.emotion)) {
          if (signal.aborted) {
            return;
          }
          pushAudio(pcm);
        }
      } catch {
        // 合成失败不能让内核永远等：收尾时按已有文本交出 done
      }
    })();

    const finish = (async (): Promise<void> => {
      await Promise.all([askRun, audioRun]);
      if (signal.aborted) {
        queue.close();
        return;
      }
      const done = settled();
      let speech = done?.speech ?? '';
      if (!useStream && done !== null && done.speech === '') {
        speech = done.text;
      }
      if (useStream && streamOk && streamedRaw !== '') {
        const spoken = spokenFromStream(streamedRaw);
        if (spoken !== '') {
          speech = spoken;
        }
      }
      if (done !== null && done.delegated === true) {
        queue.push({
          type: 'delegate',
          reason: done.delegateReason ?? 'delegate',
          rewrittenQuery: null,
        });
      }
      queue.push({
        type: 'meta',
        ...(done?.path === undefined ? {} : { path: done.path }),
        ...(done?.firstTokenMs === undefined ? {} : { firstTokenMs: done.firstTokenMs }),
        ...(firstSynthAtMs === 0 ? {} : { firstSynthAtMs }),
        ...(done?.delegateReason !== undefined
          ? { delegate: done.delegateReason }
          : done?.delegated === true
            ? { delegate: 'delegate' }
            : {}),
      });
      queue.push({ type: 'done', fullText: done?.text ?? '', speech });
      queue.close();
    })();
    // 没人 await 它：不接住拒绝会变成未处理的 rejection
    void finish.catch(() => {});

    try {
      for await (const event of queue) {
        if (signal.aborted) {
          break;
        }
        yield event;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
