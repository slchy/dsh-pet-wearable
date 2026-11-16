/**
 * 逐句合成：把流式 token 攒成整句，一句一句送 TTS。
 *
 * <h2>为什么要有它</h2>
 *
 * `turn-runner` 原本是「等 `agent.reply()` 整段回来 → 一次 `tts.synthesize`」。
 * 于是用户等的时间 = **整段生成** + TTS 握手，而首句其实几百毫秒前就生成了。
 * 拆开量过（n=111）：模型侧 p50 1104 ms、TTS 握手 346 ms —— 前者占七成，
 * 而且随答复长度单调增长（<1.5 s 答 933 ms，>4 s 答 1388 ms），典型的逐 token 生成。
 *
 * <h2>三个必须做对的地方</h2>
 *
 * 1. **断句才送**：半句送进去，语调会被切断。
 * 2. **每句都要清洗**：流里带 `[开心]` 这类情绪标签，`cleanForSpeech` 原本按整段做，
 *    分段后必须逐句做，否则 TTS 会把标签念出来。
 * 3. **收尾要补齐**：`reply.speech` 才是权威文本。逐句念过的部分按顺序比对，
 *    只补没念的；对不上就记一条警告（宁可多念，不能漏念）。
 */
import type { Emotion } from './emotion.ts';

/** 断句符：中文为主，兼顾英文与换行 */
const SENTENCE_END = new Set(['。', '！', '？', '；', '!', '?', ';', '\n']);

/** 切出完整句子，剩下的不成句部分原样返回。 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (SENTENCE_END.has(buffer[i] ?? '')) {
      sentences.push(buffer.slice(start, i + 1));
      start = i + 1;
    }
  }
  return { sentences, rest: buffer.slice(start) };
}

export interface SentencePumpOptions {
  /** 合成一句（TTS provider 的 `synthesize`） */
  readonly synthesize: (text: string, emotion?: Emotion) => AsyncIterable<Buffer>;
  /** 拿到一块 PCM */
  readonly onChunk: (chunk: Buffer) => void;
  /** 送 TTS 前的清洗（`cleanForSpeech`） */
  readonly clean: (text: string) => string;
  /** 从原始流的前缀里认出情绪（`parseEmotion`） */
  readonly resolveEmotion: (raw: string) => Emotion | undefined;
  /**
   * 开始第一句合成之前的闸门（等旁白播完）。
   * 不设就立刻合成。
   */
  readonly gate?: Promise<void>;
  /** 真要开始合成第一句了（用来记 TTS 首块耗时） */
  readonly onFirstSentence?: () => void;
  /** 票据作废（用户插话）时立刻停手 */
  readonly isStale?: () => boolean;
  readonly log?: (line: string) => void;
}

export class SentencePump {
  private buffer = '';

  /** 已送出的句子（清洗后），收尾比对用 */
  private readonly spoken: string[] = [];

  private chain: Promise<void> = Promise.resolve();
  private emotion: Emotion | undefined;
  private gateDone = false;
  private started = false;
  private streamed = false;

  private readonly options: SentencePumpOptions;

  constructor(options: SentencePumpOptions) {
    this.options = options;
  }

  /** 追加一段流式增量。凑满一句就排队合成。 */
  push(text: string): void {
    if (text === '') return;
    this.streamed = true;
    this.buffer += text;
    if (this.emotion === undefined) {
      this.emotion = this.options.resolveEmotion(this.buffer);
    }
    const { sentences, rest } = takeSentences(this.buffer);
    if (sentences.length === 0) return;
    this.buffer = rest;
    for (const sentence of sentences) {
      this.enqueue(sentence);
    }
  }

  /**
   * 收尾：用权威文本 `finalSpeech` 补齐，并等所有合成落地。
   *
   * 没有流过式（短答、或没挂侧通道）时**整段一次合成** —— 别退化成"一句一次
   * TTS 握手"，那比原来还慢。
   */
  async drain(finalSpeech: string): Promise<void> {
    if (!this.streamed) {
      this.enqueue(finalSpeech, { whole: true });
      await this.chain;
      return;
    }
    const { sentences } = takeSentences(finalSpeech);
    let i = 0;
    while (i < this.spoken.length && i < sentences.length) {
      if (this.options.clean(sentences[i] ?? '') !== this.spoken[i]) break;
      i += 1;
    }
    for (const sentence of sentences.slice(i)) {
      this.enqueue(sentence);
    }
    if (i < this.spoken.length) {
      this.options.log?.(
        `  流式    ⚠ 已念的 ${this.spoken.length} 句与最终文本从第 ${i + 1} 句起对不上，按最终文本补`,
      );
    }
    await this.chain;
  }

  private enqueue(sentence: string, opts: { whole?: boolean } = {}): void {
    const text = opts.whole === true ? sentence : this.options.clean(sentence);
    if (text === '') return;
    if (opts.whole !== true) this.spoken.push(text);
    this.chain = this.chain
      .then(async () => {
        if (!this.gateDone) {
          await this.options.gate;
          this.gateDone = true;
        }
        if (this.options.isStale?.() === true) return;
        if (!this.started) {
          this.started = true;
          this.options.onFirstSentence?.();
        }
        for await (const chunk of this.options.synthesize(text, this.emotion)) {
          if (this.options.isStale?.() === true) return;
          this.options.onChunk(chunk);
        }
      })
      .catch((error: unknown) => {
        // 一句失败不该让整轮哑掉：记一条，后面的句子继续
        this.options.log?.(`  流式    ✗ 分段合成失败：${(error as Error).message}`);
      });
  }
}
