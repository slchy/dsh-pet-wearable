/**
 * 把现有 `AgentProvider` + `TtsProvider` 收成一条 {@link FastVoiceEngine} 事件流。
 *
 * `TurnRunner` 里 `omni` / `stream` / `pump` 三条分支挂着同一批必须保住的行为：
 * 带图不问 `willServeAudio`、omni 轮事先不开流式 TTS、流式失败退回整段合成、
 * 多步增量用 `spokenFromStream` 对账、omni 转交 dsh 时垫话要留住。那些行为以前
 * 写在编排层，换引擎就会静默丢掉。适配器把它们收进 `respond()`，内核只消费
 * `EngineEvent`，不再按引擎类型分支。
 *
 * `mode` 固定为 `cascade`：这一类是「问 agent 再出音频」的泵。某一轮实际走了
 * omni 直出时，路径写在 `meta.path` 上，不写在 `mode` 上 —— `mode` 是引擎的
 * 种类，不是这一轮的答案来源。
 */
import type { EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import type { TurnTicket } from '../dialog-fsm.ts';
import type {
  AgentAudioAnswer,
  AgentImage,
  AgentProvider,
  AgentReplyView,
  DelegateReason,
  TtsProvider,
  TurnContext,
} from '../providers.ts';
import { TokenQueue } from '../token-queue.ts';
import { SentencePump } from '../sentence-pump.ts';
import { cleanForSpeech } from '../agent.ts';
import { parseEmotion } from '../emotion.ts';

/**
 * 流式那条路实际念出去的全文。与 `turn-runner.ts` 的 `spokenFromStream` 同一份语义：
 * 多步时 `reply.speech` 只是最后一步，续话必须按全部增量切。
 */
function spokenFromStream(raw: string): string {
  return cleanForSpeech(parseEmotion(raw).rest);
}

const ABORTED = Symbol('aborted');

export interface AgentEngineAdapterOptions {
  readonly agent: AgentProvider;
  readonly tts: TtsProvider;
  /** 把这一轮的 token 增量接到 TTS。`null` 表示摘掉 */
  readonly onLiveAvailable?: (sink: ((text: string) => void) | null) => void;
  /**
   * 旁白还在念时，本轮 TTS 要等它播完。返回的是**当前**那条链。
   */
  readonly speechChain?: () => Promise<void>;
  /**
   * 墙钟。`firstSynthAtMs` 用 `0` 当「还没送过文本」的哨兵，时钟不要回 0。
   */
  readonly clock: () => number;
  readonly log?: (line: string) => void;
}

class EventQueue implements AsyncIterable<EngineEvent> {
  private readonly pending: EngineEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: EngineEvent): void {
    if (this.closed) {
      return;
    }
    this.pending.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  close(): void {
    this.closed = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

interface AbortGate {
  readonly when: Promise<null>;
  cancel(): void;
}

function abortGate(signal: AbortSignal): AbortGate {
  let fire: (() => void) | null = null;
  const when = new Promise<null>((resolve) => {
    fire = () => {
      resolve(null);
    };
    if (signal.aborted) {
      fire();
      return;
    }
    signal.addEventListener('abort', fire, { once: true });
  });
  return {
    when,
    cancel: () => {
      if (fire !== null) {
        signal.removeEventListener('abort', fire);
      }
    },
  };
}

/**
 * 工作跑完，或者信号先到。
 *
 * 调用方必须自己 `void work.catch(...)`：中止胜出时 `work` 之后的拒绝没人再等，
 * 不接住就是进程级 `unhandledRejection`。
 */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    return ABORTED;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function toAgentImage(turn: TurnInput): AgentImage | undefined {
  const image = turn.image;
  if (image === undefined) {
    return undefined;
  }
  return { mimeType: image.mime, data: image.bytes.toString('base64') };
}

function openingContext(turn: TurnInput): TurnContext | undefined {
  if (turn.ticket === undefined) {
    return undefined;
  }
  return { ticket: turn.ticket };
}

function ticketFrom(turn: TurnInput): TurnTicket {
  if (turn.ticket !== undefined) {
    return turn.ticket;
  }
  return {
    no: turn.no,
    gen: 0,
    baseCommitSeq: turn.baseCommitSeq,
    startedAtMs: turn.startedAtMs,
  };
}

function observe(input: {
  readonly path?: 'fast' | 'dsh' | 'omni';
  readonly firstTokenMs?: number;
  readonly firstSynthAtMs?: number;
  readonly delegate?: string;
}): EngineEvent {
  return {
    type: 'meta',
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.firstTokenMs === undefined ? {} : { firstTokenMs: input.firstTokenMs }),
    ...(input.firstSynthAtMs === undefined || input.firstSynthAtMs === 0
      ? {}
      : { firstSynthAtMs: input.firstSynthAtMs }),
    ...(input.delegate === undefined ? {} : { delegate: input.delegate }),
  };
}

interface ActiveStream {
  tokens: TokenQueue | null;
}

export class AgentEngineAdapter implements FastVoiceEngine {
  readonly mode = 'cascade' as const;

  private readonly options: AgentEngineAdapterOptions;

  constructor(options: AgentEngineAdapterOptions) {
    this.options = options;
  }

  isHealthy(): boolean {
    return true;
  }

  abortSpeculation(reason: 'delegated' | 'superseded' | 'barge_in'): void {
    this.options.agent.dropPrefetch?.(reason);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private now(): number {
    return this.options.clock();
  }

  /** 旁白链。失败或中止都放行：旁白出错不该把这一轮的答案卡住。 */
  private narrationGate(signal: AbortSignal): Promise<void> | undefined {
    const chain = this.options.speechChain;
    if (chain === undefined) {
      return undefined;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', finish);
        resolve();
      };
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
      try {
        chain().then(finish, finish);
      } catch {
        finish();
      }
    });
  }

  private async readStream(
    stream: (chunks: AsyncIterable<string>, emotion?: string) => AsyncIterable<Buffer>,
    chunks: AsyncIterable<string>,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<void> {
    const gate = this.narrationGate(signal);
    if (gate !== undefined) {
      await gate;
    }
    if (signal.aborted) {
      return;
    }
    for await (const pcm of stream(chunks)) {
      if (signal.aborted) {
        return;
      }
      onPcm(pcm);
    }
  }

  private async writeWhole(
    text: string,
    emotion: string | undefined,
    signal: AbortSignal,
    queue: EventQueue,
  ): Promise<number> {
    if (signal.aborted || text.trim() === '') {
      return 0;
    }
    let n = 0;
    for await (const pcm of this.options.tts.synthesize(text, emotion)) {
      if (signal.aborted) {
        return n;
      }
      n += 1;
      queue.push({ type: 'audio', pcm, sampleRate: this.options.tts.sampleRate });
    }
    return n;
  }

  private async drainClaimedAudio(
    audio: AgentAudioAnswer,
    signal: AbortSignal,
    queue: EventQueue,
  ): Promise<{ readonly aborted: boolean; readonly chunks: number }> {
    const chunks = audio.chunks[Symbol.asyncIterator]();
    const gate = abortGate(signal);
    let said = 0;
    let n = 0;
    try {
      for (;;) {
        const step = chunks.next();
        const winner = await Promise.race([step, gate.when]);
        if (winner === null || signal.aborted) {
          void Promise.resolve(step).catch(() => {});
          void Promise.resolve(chunks.return?.()).catch(() => {});
          return { aborted: true, chunks: n };
        }
        if (winner.done === true) {
          break;
        }
        n += 1;
        queue.push({ type: 'audio', pcm: winner.value, sampleRate: audio.sampleRate });
        const text = audio.transcript();
        if (text.length > said) {
          const delta = text.slice(said);
          said = text.length;
          queue.push({ type: 'text', delta });
        }
      }
    } finally {
      gate.cancel();
    }
    return { aborted: signal.aborted, chunks: n };
  }

  async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    if (signal.aborted) {
      return;
    }
    const queue = new EventQueue();
    const active: ActiveStream = { tokens: null };
    const onAbort = (): void => {
      // 文本队列关掉，流式 TTS 才能从 `for await` 里出来；不关事件队列，
      // 转交中止时还要补一条 `done`（垫话），关早了会被丢掉。
      active.tokens?.close();
      this.options.onLiveAvailable?.(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let failure: unknown = null;
    const task = (async (): Promise<void> => {
      try {
        await this.produce(turn, signal, queue, active);
      } catch (error) {
        failure = error;
      } finally {
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        // 中止之后不再把迟到的音频 / 增量交给调用方，但 `done` / `meta` 仍要交：
        // omni 转交被掐掉时，垫话记在那条 `done` 上。
        if (signal.aborted && (event.type === 'audio' || event.type === 'text')) {
          continue;
        }
        yield event;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    await task;
    if (failure !== null && !signal.aborted) {
      throw failure;
    }
  }

  private async produce(
    turn: TurnInput,
    signal: AbortSignal,
    queue: EventQueue,
    active: ActiveStream,
  ): Promise<void> {
    const agent = this.options.agent;
    const tts = this.options.tts;
    // 带图一定走文本路：omni 吃的是音频流，没有图片通道。问一次会得到
    // 「能答」（路由只看健康度），于是流式 TTS 被关掉、图的答案只能整段合成。
    const omniTurn = turn.hasImage
      ? false
      : agent.willServeAudio?.(turn.text) === true;
    if (!turn.hasImage && typeof agent.willServeAudio !== 'function') {
      this.log('  车道    ✗ agent 上没有 `willServeAudio`（装配层把可选能力吞了）');
    }

    const streamFn = tts.synthesizeStream?.bind(tts);
    const canStream = streamFn !== undefined && this.options.onLiveAvailable !== undefined;
    const image = toAgentImage(turn);
    const note = turn.note;

    let streamedRaw = '';
    let firstSynthAtMs = 0;
    const markSynth = (): void => {
      if (firstSynthAtMs === 0) {
        firstSynthAtMs = this.now();
      }
    };
    let streaming: Promise<void> | null = null;
    let pump: SentencePump | null = null;
    let tokens: TokenQueue | null = null;

    const detach = (): void => {
      this.options.onLiveAvailable?.(null);
      tokens?.close();
      if (active.tokens === tokens) {
        active.tokens = null;
      }
    };

    try {
      if (!omniTurn && canStream && streamFn !== undefined) {
        this.log('  流式    分支=stream（边生成边合成）');
        tokens = new TokenQueue();
        active.tokens = tokens;
        const textIn = tokens;
        this.options.onLiveAvailable?.((delta) => {
          if (delta === '') {
            return;
          }
          streamedRaw += delta;
          markSynth();
          textIn.push(delta);
          queue.push({ type: 'text', delta });
        });
        streaming = this.readStream(streamFn, textIn, signal, (pcm) => {
          queue.push({ type: 'audio', pcm, sampleRate: tts.sampleRate });
        });
        // 先挂一个空 catch：`reply` 抛错时下面的 `await streaming` 走不到，
        // 没人接的 rejection 在 Node 里是进程级错误。
        void streaming.catch(() => undefined);
      } else {
        // omni 轮也不开 `synthesizeStream`（空文本会被服务端拒），但泵先备着：
        // 这一轮要是没带回音频，还得按整段把 `reply.speech` 念出去。
        if (!omniTurn) {
          this.log('  流式    分支=pump（逐句/整段）');
        }
        pump = new SentencePump({
          synthesize: (sentence, emotion) => tts.synthesize(sentence, emotion),
          clean: cleanForSpeech,
          resolveEmotion: (raw) => parseEmotion(raw).emotion,
          gate: this.narrationGate(signal),
          isStale: () => signal.aborted,
          log: (line) => { this.log(line); },
          onFirstSentence: () => { markSynth(); },
          onChunk: (pcm) => {
            queue.push({ type: 'audio', pcm, sampleRate: tts.sampleRate });
          },
        });
        this.options.onLiveAvailable?.((delta) => {
          if (delta === '') {
            return;
          }
          streamedRaw += delta;
          queue.push({ type: 'text', delta });
          pump?.push(delta);
        });
      }

      const pending = agent.reply(turn.text, image, note, openingContext(turn));
      void pending.catch(() => undefined);
      let reply: AgentReplyView | undefined;
      try {
        const raced = await raceAbort(pending, signal);
        if (raced !== ABORTED && !signal.aborted) {
          reply = raced;
        }
      } finally {
        detach();
      }

      if (reply === undefined) {
        if (streaming !== null) {
          await streaming.catch(() => undefined);
        }
        return;
      }

      if (reply.audio !== undefined) {
        if (streaming !== null) {
          // 预测没走 omni、结果却带回了音频：先把已经开的流收掉，别和直出叠在一起
          await streaming.catch(() => undefined);
        }
        await this.produceOmni(
          turn, reply, signal, queue, active, image, note,
          (value) => { firstSynthAtMs = value; },
          () => firstSynthAtMs,
        );
        return;
      }

      let speech = reply.speech;
      if (streaming !== null) {
        let failed = false;
        try {
          await streaming;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          failed = true;
          this.log(`  流式    ✗ ${(error as Error).message}，退回整段合成`);
          firstSynthAtMs = this.now();
          await this.writeWhole(reply.speech, reply.emotion, signal, queue);
        }
        if (signal.aborted) {
          return;
        }
        if (!failed) {
          const spoken = spokenFromStream(streamedRaw);
          if (spoken !== '' && spoken !== speech) {
            this.log(
              `  流式    实际念了 ${[...spoken].length} 字`
              + `（最后一步只有 ${[...speech].length} 字）`,
            );
            speech = spoken;
          }
        }
      } else if (pump !== null) {
        await pump.drain(reply.speech);
        if (signal.aborted) {
          return;
        }
        if (streamedRaw !== '') {
          const spoken = spokenFromStream(streamedRaw);
          if (spoken !== '' && spoken !== speech) {
            speech = spoken;
          }
        }
      }

      if (signal.aborted) {
        return;
      }
      queue.push(observe({
        path: reply.path,
        firstTokenMs: reply.firstTokenMs,
        firstSynthAtMs,
        delegate: reply.delegate,
      }));
      queue.push({ type: 'done', fullText: reply.text, speech });
    } catch (error) {
      if (streaming !== null) {
        await streaming.catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * omni 直出，以及它自己 `tool_call` 之后把正文交给 dsh 的那一段。
   *
   * 垫话已经播出去了就留着：掐断重说会让同一段内容听两遍。转交被中止、
   * 且 dsh 一个字都还没合成时，`done.speech` 必须仍是垫话。
   */
  private async produceOmni(
    turn: TurnInput,
    reply: AgentReplyView,
    signal: AbortSignal,
    queue: EventQueue,
    active: ActiveStream,
    image: AgentImage | undefined,
    note: string | undefined,
    setSynthAt: (value: number) => void,
    synthAt: () => number,
  ): Promise<void> {
    const audio = reply.audio;
    if (audio === undefined) {
      return;
    }
    this.log('  流式    分支=omni（音频直出）');
    queue.push({ type: 'meta', path: 'omni' });
    const drained = await this.drainClaimedAudio(audio, signal, queue);
    if (drained.aborted || signal.aborted) {
      return;
    }

    const leadIn = audio.transcript();
    const why = audio.delegateReason?.() ?? null;
    if (why === null) {
      queue.push({ type: 'done', fullText: leadIn, speech: leadIn });
      return;
    }

    this.log(drained.chunks > 0
      ? '  omni    说了回执 → 转交 dsh，答案接在后面'
      : '  omni    决定转交 dsh（它没出声，回执由 dsh 那边说）');
    const rewrittenQuery = audio.delegateText?.() ?? null;
    queue.push({ type: 'delegate', reason: why, rewrittenQuery });
    const userText = rewrittenQuery === null
      ? turn.text
      : `${rewrittenQuery}\n用户原话：「${turn.text}」`;

    const streamFn = this.options.tts.synthesizeStream?.bind(this.options.tts);
    const canStream = streamFn !== undefined && this.options.onLiveAvailable !== undefined;
    let delegateRaw = '';
    let postAudio = 0;
    let delegateStreaming: Promise<void> | null = null;
    let delegatePump: SentencePump | null = null;
    let tokens: TokenQueue | null = null;

    const detach = (): void => {
      this.options.onLiveAvailable?.(null);
      tokens?.close();
      if (active.tokens === tokens) {
        active.tokens = null;
      }
    };

    try {
      if (canStream && streamFn !== undefined) {
        tokens = new TokenQueue();
        active.tokens = tokens;
        const textIn = tokens;
        this.options.onLiveAvailable?.((delta) => {
          if (delta === '') {
            return;
          }
          delegateRaw += delta;
          if (synthAt() === 0) {
            setSynthAt(this.now());
          }
          textIn.push(delta);
          queue.push({ type: 'text', delta });
        });
        delegateStreaming = this.readStream(streamFn, textIn, signal, (pcm) => {
          postAudio += 1;
          queue.push({ type: 'audio', pcm, sampleRate: this.options.tts.sampleRate });
        });
        void delegateStreaming.catch(() => undefined);
      } else {
        delegatePump = new SentencePump({
          synthesize: (sentence, emotion) => this.options.tts.synthesize(sentence, emotion),
          clean: cleanForSpeech,
          resolveEmotion: (raw) => parseEmotion(raw).emotion,
          gate: this.narrationGate(signal),
          isStale: () => signal.aborted,
          log: (line) => { this.log(line); },
          onFirstSentence: () => {
            if (synthAt() === 0) {
              setSynthAt(this.now());
            }
          },
          onChunk: (pcm) => {
            postAudio += 1;
            queue.push({ type: 'audio', pcm, sampleRate: this.options.tts.sampleRate });
          },
        });
      }

      const pending = this.options.agent.reply(userText, image, note, {
        ticket: ticketFrom(turn),
        forceDelegate: why,
        receiptSpoken: leadIn.trim() !== '',
      });
      void pending.catch(() => undefined);

      let reply2: AgentReplyView | undefined;
      try {
        const raced = await raceAbort(pending, signal);
        if (raced !== ABORTED && !signal.aborted) {
          reply2 = raced;
        }
      } finally {
        detach();
      }

      if (reply2 === undefined) {
        if (delegateStreaming !== null) {
          await delegateStreaming.catch(() => undefined);
        }
        this.log('  omni    转交后本轮被作废 → 不再等 dsh，答案回来会回注记忆');
        // 中止时 dsh 还没合成出声音：档案里的「说过的话」只能是垫话
        if (postAudio === 0) {
          queue.push({ type: 'done', fullText: leadIn, speech: leadIn });
        }
        return;
      }

      let speech = reply2.speech;
      let failed = false;
      if (delegateStreaming !== null) {
        try {
          await delegateStreaming;
        } catch (error) {
          failed = true;
          if (!signal.aborted) {
            this.log(`  流式    ✗ ${(error as Error).message}，退回整段合成`);
            setSynthAt(this.now());
            postAudio += await this.writeWhole(reply2.speech, reply2.emotion, signal, queue);
          }
        }
        if (!failed && postAudio === 0 && reply2.speech.trim() !== '' && !signal.aborted) {
          failed = true;
          this.log('  流式    ✗ 转交后没有增量到达，退回整段合成');
          setSynthAt(this.now());
          postAudio += await this.writeWhole(reply2.speech, reply2.emotion, signal, queue);
        }
        if (!failed && !signal.aborted && delegateRaw !== '') {
          const spoken = spokenFromStream(delegateRaw);
          if (spoken !== '' && spoken !== speech) {
            this.log(
              `  流式    转交后实际念了 ${[...spoken].length} 字`
              + `（最后一步只有 ${[...speech].length} 字）`,
            );
            speech = spoken;
          }
        }
      } else if (delegatePump !== null) {
        await delegatePump.drain(reply2.speech);
      }

      if (signal.aborted && postAudio === 0) {
        this.log('  omni    dsh 的答案没来得及合成 → said 仍是垫话');
        queue.push({ type: 'done', fullText: leadIn, speech: leadIn });
        return;
      }
      if (signal.aborted) {
        return;
      }
      queue.push(observe({
        path: reply2.path,
        firstTokenMs: reply2.firstTokenMs,
        firstSynthAtMs: synthAt(),
        delegate: reply2.delegate,
      }));
      queue.push({ type: 'done', fullText: reply2.text, speech });
    } catch (error) {
      if (delegateStreaming !== null) {
        await delegateStreaming.catch(() => undefined);
      }
      throw error;
    }
  }
}
