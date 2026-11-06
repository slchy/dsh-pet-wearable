/**
 * 语音 agent 策略层：把 ASR 文本变成「可以直接朗读」的回复。
 *
 * 两层解耦：
 * - `session.ts` 只管怎么调 dsh、怎么续会话（机制）
 * - 这里管对话风格与输出清洗（策略）
 *
 * 为什么必须清洗：TTS 会把 markdown 原样读出来——
 * `**加粗**` 念成「星号星号加粗星号星号」，列表念成「短横线」。
 * 模型的默认输出是给人看的，不是给嘴念的。
 */
import type { AskResult, ImageAttachment } from './session.ts';
import { DshSession } from './session.ts';

/**
 * 系统提示。每轮都随用户文本一起下发。
 *
 * 不走 profile 的 agent-instructions 是刻意的：换场景（闲聊 / 助记 / 干活）
 * 只要换这段文本，不用改服务器上的配置。代价是每轮多几十 token，
 * 但这部分会被 provider 的 prompt cache 命中。
 */
const VOICE_SYSTEM = `你在跟一个戴着智能眼镜的人语音对话，你的回复会被直接朗读出来。

硬性要求：
- **默认只说 1–2 句、40 字以内**。对方明确要求展开时才开始详细说
- 先给结论，再看对方要不要追问；不要把背景、原因、例外一次讲完
- 纯口语，不要 markdown、不要列表符号、不要代码块、不要表情符号、不要括号注释
- 不要说「好的」「当然」这类开场白，直接给答案
- 对方用中文问就用中文答
- 听不清或没把握时直说，不要编

对方刚才说：
`;

/** 兜底：TTS 前再清洗一遍，挡住模型偶尔漏掉的格式。 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')          // 代码块整块丢掉
    .replace(/`([^`]+)`/g, '$1')             // 行内代码留内容
    .replace(/^#{1,6}\s+/gm, '')             // 标题
    .replace(/^\s*[-*+]\s+/gm, '')           // 列表符号
    .replace(/^\s*\d+\.\s+/gm, '')           // 有序列表
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // 粗体
    .replace(/__([^_]+)__/g, '$1')           // 粗体变体
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')  // emoji
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface AgentReply extends AskResult {
  /** 清洗后、准备送 TTS 的文本 */
  speech: string;
}

export class VoiceAgent {
  private readonly session: DshSession;
  private readonly log: (line: string) => void;

  constructor(session: DshSession, log: (line: string) => void = () => {}) {
    this.session = session;
    this.log = log;
  }

  /** 当前会话 id（新会话时为 null，第一次 ask 之后才有值）。 */
  get sessionId(): string | null {
    return this.session.currentSessionId;
  }

  /** 主动开新会话。语音里对应「重新开始」这类指令。 */
  reset(): void {
    this.session.reset();
  }

  async reply(asrText: string, image?: ImageAttachment): Promise<AgentReply> {
    const prompt = VOICE_SYSTEM + asrText;
    const r = await this.session.ask(prompt, image);
    const speech = cleanForSpeech(r.text);
    if (!speech) {
      throw new Error('清洗后没有可朗读的内容');
    }
    const usage = r.usage;
    this.log(
      `  dsh     ${(r.durationMs / 1000).toFixed(2)} s  `
      + `${r.resumed ? '续会话' : '新会话'}  `
      + `tokens=${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}`
      + ` cache=${usage?.cacheReadTokens ?? 0}`,
    );
    return { ...r, speech };
  }
}
