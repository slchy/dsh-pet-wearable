/**
 * 语音 agent 策略层：把 ASR 文本变成「可以直接朗读」的回复。
 *
 * 两层解耦：
 * - `session.ts` 只管怎么调 dsh、怎么续会话（机制）
 * - 这里管输出清洗（策略）
 *
 * **人设与行为规则不在这里**：全文存放在 `mcp/profile.cordis.yml` 的
 * `personaPrefix`，由 dsh 作为系统提示词注入（部署时装成
 * `~/.dsh/profiles/sdk/cordis.patch.yml`）。提示词是「设定」，放系统层比每轮
 * 拼进用户消息服从度更高，也能稳定命中前缀缓存。这里只负责把模型吐出来的
 * 东西清洗成能念的一行字。
 *
 * 为什么必须清洗：TTS 会把 markdown 原样读出来——
 * `**加粗**` 念成「星号星号加粗星号星号」，列表念成「短横线」。
 * 模型的默认输出是给人看的，不是给嘴念的。
 */
import type { AskResult, ImageAttachment } from './session.ts';
import { DshSession } from './session.ts';
import type { AnnounceStore } from './announce-store.ts';
import { parseEmotion, stripEmotionTags } from './emotion.ts';

/** 兜底：TTS 前再清洗一遍，挡住模型偶尔漏掉的格式。 */
export function cleanForSpeech(text: string): string {
  // 情绪标签只该出现在开头（`parseEmotion` 已经剥过一次）；模型有时会在句中
  // 再写一个，那些会被原样念出来（「方括号开心」）。标签表来自 `emotion.ts`，
  // 这里不重复抄写。
  return stripEmotionTags(text)
    // 模型偶尔用实体代替字符，最常漏的是零宽空格（`&#8203;`）—— 字面送进 TTS
    // 会被念成「ampersand hash…」，所以先在**文本层**把它们清掉，别指望合成器忽略
    .replace(/&#(?:8203|8204|8205|65279);/g, '')
    .replace(/&#x(?:200b|200c|200d|feff);/gi, '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    // 命名实体按最常见的几个还原：`&nbsp;` 先变空格，交给下面的中文空格规则处理
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&') // 最后做，避免 `&amp;lt;` 被解两次
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
    // 两个中日韩字符之间的空格没有语义，只会让合成器塞一个停顿 —— 而这种空格
    // 几乎都是「为了写 markdown 才加的」（`和 + 反引号代码`）。英文 / 数字 /
    // 代码段两侧的空格有语义（`看这个 npm run build 命令`），一律不动。
    .replace(
      /(?<=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])[ \t\u3000]+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g,
      '',
    )
    .trim();
}

export interface AgentReply extends AskResult {
  /** 清洗后、准备送 TTS 的文本 */
  speech: string;
  /** 情绪 key（`happy` / `proud` / `calm` / `worried` / `sulk`） */
  emotion: string;
}

export class VoiceAgent {
  /** 供日志/诊断显示 */
  readonly name = 'dsh';

  private readonly session: DshSession;
  private readonly log: (line: string) => void;
  /** 播报出口。第二个参数是情绪 key，没有就按平静处理 */
  private announcer: ((speech: string, emotion?: string) => void) | null = null;
  /** 没有连接时把汇报存下来，等下次连上补播（null = 不持久化） */
  private readonly announceStore: AnnounceStore | null;

  constructor(
    session: DshSession,
    log: (line: string) => void = () => {},
    announceStore: AnnounceStore | null = null,
  ) {
    this.session = session;
    this.log = log;
    // ⚠️ 不能写成构造函数参数属性：Node 22 的类型擦除不支持，tsc 通过、跑起来
    // 直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（`dialog-fsm.ts` 里也记过这条）。
    this.announceStore = announceStore;

    // 后台作业结算后 dsh 会自己开一轮；把那轮文本清洗成可朗读的句子交出去
    this.session.onAnnounce = (text: string) => {
      // 后台汇报也可能带情绪标签，同样处理
      const { emotion, rest } = parseEmotion(text);
      const speech = cleanForSpeech(rest);
      if (!speech) {
        return;
      }
      if (this.announcer === null) {
        const pending = this.announceStore?.push(speech) ?? 0;
        this.log(`  后台    没有连接，存入待补播（积压 ${pending} 条）`);
        return;
      }
      this.log(`  后台    任务完成 → 播报 ${JSON.stringify(speech.slice(0, 60))}`);
      this.announcer(speech, emotion);
    };
  }

  /**
   * 设置播报出口。连接建立时设、断开时清 —— 后台任务属于**会话**，
   * 但播报要落到当时在线的那个连接上。
   */
  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.announcer = cb;
  }

  /** 当前会话 id（新会话时为 null，第一次 ask 之后才有值）。 */
  get sessionId(): string | null {
    return this.session.currentSessionId;
  }

  /** 主动开新会话。语音里对应「重新开始」这类指令。 */
  reset(): void {
    this.session.reset();
  }

  async reply(asrText: string, image?: ImageAttachment, note?: string): Promise<AgentReply> {
    // 人设与规则由 dsh 作为系统提示词注入（见 mcp/profile.cordis.yml），这里只发
    // 本轮真正变化的东西：可选的系统注记 + 哥说的话。
    const context = note === undefined ? '' : `（系统注记：${note}）\n`;
    const prompt = `${context}哥刚才说：\n${asrText}`;
    const r = await this.session.ask(prompt, image);
    // 情绪标签在最开头；剥掉它，剩下的才是要念的话
    const { emotion, rest } = parseEmotion(r.text);
    const speech = cleanForSpeech(rest);
    if (!speech) {
      throw new Error('清洗后没有可朗读的内容');
    }
    const usage = r.usage;
    this.log(
      `  dsh     ${(r.durationMs / 1000).toFixed(2)} s  `
      + `${r.resumed ? '续会话' : '新会话'}  `
      + `情绪=${emotion}  `
      + `tokens=${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}`
      + ` cache=${usage?.cacheReadTokens ?? 0}`,
    );
    return { ...r, speech, emotion };
  }
}
