/**
 * 快车道装饰器：**短句纯闲聊**直接答，其余原样交给内层 agent（dsh）。
 *
 * <h2>为什么是「先本地判、再调快模型」，不是「两条路同时发」</h2>
 *
 * 慢车道（dsh）的 token 是**直接流进 TTS** 的（`attachLiveSink`）。并行竞速只有
 * 两种写法，都不划算：
 *
 * - 把慢车道的增量先扣住，等快车道几百毫秒 —— 每一轮 dsh 都白加这段延迟，
 *   正好抵消收益；
 * - 不扣，让慢车道先出声 —— 那时快车道赢了也已经播出去了，撤不回来。
 *
 * 所以只在**本地规则判定为闲聊候选**时先调快模型，其余轮次零开销直达 dsh。
 *
 * <h2>能赚多少（实测，别高估）</h2>
 *
 * - 慢车道 TTFT 中位 `690 ms`（14 轮真机 568–1129 ms）
 * - 快模型（`deepseek-chat` → 实际路由到 flash）流式首字 `231–731 ms`
 *
 * 所以这里能赚的是**几百毫秒**，赚不到秒。工具轮那 6.5 秒不归这里管
 * —— 那条路要么把搜索下沉后台 Job，要么继续同步等。
 *
 * <h2>被拦下来的轮次怎么进 dsh 历史</h2>
 *
 * 快车道答的轮次没经过 dsh，会话历史里是空的。用满 {@link FastLaneOptions.keepTurns}
 * 轮就强制委派一次，借正常请求把这段缓冲无损刷进去（走 `note` 通道，不改用户原话）。
 */
import { cleanForSpeech } from './agent.ts';
import { parseEmotion } from './emotion.ts';
import type { AgentImage, AgentProvider, AgentReplyView } from './providers.ts';

/** 快模型说「这个我答不了」的唯一暗号 */
const DELEGATE = '[[DELEGATE]]';

/**
 * 命中这些词就不走快车道 —— 它们全都要 dsh 的工具、记忆或视觉。
 *
 * 刻意用**子串**匹配而不是分词：宁可误判成「需要 dsh」（多花 690 ms），
 * 也不要把「帮我查一下订单」当闲聊答了。
 */
const TASK_WORDS: readonly string[] = [
  '查', '搜', '拍', '看', '打开', '帮我', '帮我看', '什么', '哪', '怎么', '多少', '为什么',
  '这个', '那个', '刚才', '记住', '记一下', '订单', '地址', '电话', '文件', '日志',
  '导航', '提醒', '设置', '翻译', '总结', '念', '读', '找',
];

const SYSTEM_PROMPT = [
  '你是中文语音助手的「快车道」。用户戴着智能眼镜跟你闲聊。',
  '只回答纯闲聊：招呼、寒暄、夸奖、撒娇、道别、问你是谁、情绪回应。',
  '其余一律**只输出** [[DELEGATE]]（六个字，不要解释、不要加标点）：',
  '- 要查资料、看东西、拍照、调工具、记住或回忆信息、改设置、导航、下单；',
  '- 涉及具体事实、数字、人名、时间、地点；',
  '- 你不确定的。',
  '要求：一句话，不超过 20 个字，口语，不要表情符号，不要 markdown，不要加语气标签。',
].join('\n');

export interface FastLaneOptions {
  readonly inner: AgentProvider;
  /** DeepSeek key；空串 = 关闭快车道 */
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** 硬超时：超过就当委派（默认 700 ms） */
  readonly timeoutMs?: number;
  /** 超过这么多字不当闲聊（默认 14） */
  readonly maxChars?: number;
  /** 最多攒几轮快车道对话就强制刷进 dsh（默认 4） */
  readonly keepTurns?: number;
  /** 测试注入用 */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/**
 * 这句话值不值得先问快模型。
 *
 * 纯机械判据（与 `backchannel.ts`、`wake-word.ts` 同一条原则）：不做语义推断，
 * 只按字数和已知任务词排除。排除掉的轮次**零开销**，一个字都不多等。
 */
export function isFastCandidate(text: string, maxChars = 14): boolean {
  const core = text.replace(/[\s。.,，!！?？、~～…\-—]/g, '');
  if (core.length === 0 || core.length > maxChars) {
    return false;
  }
  if (/[0-9０-９]/.test(core)) {
    return false;
  }
  return !TASK_WORDS.some((word) => core.includes(word));
}

interface FastAnswer {
  readonly text: string;
  readonly firstTokenMs: number;
  readonly delegated: boolean;
}

/** 读 SSE 流，按需在发现 `[[` 时提前放弃。 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  now: () => number,
): Promise<FastAnswer> {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let firstTokenMs = 0;

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        return { text, firstTokenMs, delegated: text.trim().startsWith(DELEGATE) };
      }
      let parsed: { choices?: Array<{ delta?: { content?: string } }> };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        continue;
      }
      const piece = parsed.choices?.[0]?.delta?.content;
      if (typeof piece !== 'string' || piece === '') {
        continue;
      }
      if (firstTokenMs === 0) {
        firstTokenMs = now() - startedAt;
      }
      text += piece;
      // 暗号以 `[[` 开头，而情绪标签是单 `[`（`[开心]`），所以不会误伤。
      // 早退省掉的是「等快模型把整句说完」，实测首字符 120–160 ms 就到。
      if (text.trimStart().startsWith('[[')) {
        return { text, firstTokenMs, delegated: true };
      }
    }
  }
  return { text, firstTokenMs, delegated: text.trim().startsWith(DELEGATE) };
}

export class FrontedAgent implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  private readonly keepTurns: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** 快车道答过、还没进 dsh 会话的轮次（"用户: …" / "你: …" 两行一组） */
  private readonly pending: string[] = [];
  private sink: ((text: string) => void) | null = null;

  constructor(options: FastLaneOptions) {
    this.inner = options.inner;
    this.apiKey = options.apiKey ?? '';
    this.model = options.model ?? 'deepseek-chat';
    this.baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    this.timeoutMs = options.timeoutMs ?? 700;
    this.maxChars = options.maxChars ?? 14;
    this.keepTurns = options.keepTurns ?? 4;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  get name(): string {
    return this.inner.name;
  }

  get sessionId(): string | null | undefined {
    return this.inner.sessionId;
  }

  /**
   * 快车道的回答也要走这条通道 —— 否则流式那条路一个字都收不到，
   * `turn-runner` 会先付一次「服务端拒空任务」再退回整段合成。
   */
  attachLiveSink(sink: ((text: string) => void) | null): void {
    this.sink = sink;
    this.inner.attachLiveSink?.(sink);
  }

  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.inner.setAnnouncer?.(cb);
  }

  async reply(userText: string, image?: AgentImage, note?: string): Promise<AgentReplyView> {
    if (this.apiKey === '' || image !== undefined || !isFastCandidate(userText, this.maxChars)) {
      return await this.delegate(userText, image, note);
    }
    if (this.pending.length / 2 >= this.keepTurns) {
      this.log('  快车道    攒满上限，这一轮强制交给 dsh（顺便刷上下文）');
      return await this.delegate(userText, image, note);
    }

    let answer: FastAnswer;
    const startedAt = this.now();
    try {
      answer = await this.ask(userText, startedAt);
    } catch (error) {
      this.log(`  快车道    ✗ ${(error as Error).message} → 交给 dsh`);
      return await this.delegate(userText, image, note);
    }
    if (answer.delegated) {
      this.log(`  快车道    判为需要 dsh（${answer.firstTokenMs} ms 早退）`);
      return await this.delegate(userText, image, note);
    }

    const speech = cleanForSpeech(parseEmotion(answer.text).rest);
    if (speech === '') {
      return await this.delegate(userText, image, note);
    }
    const elapsed = this.now() - startedAt;
    this.log(`  快车道    ${answer.firstTokenMs} ms 首字 / ${elapsed} ms 整句：${JSON.stringify(speech)}`);
    this.pending.push(`用户: ${userText.trim()}`, `你: ${speech}`);
    this.sink?.(answer.text);
    return {
      text: answer.text,
      speech,
      firstTokenMs: answer.firstTokenMs,
      emotion: parseEmotion(answer.text).emotion,
    };
  }

  private async delegate(
    userText: string,
    image?: AgentImage,
    note?: string,
  ): Promise<AgentReplyView> {
    if (this.pending.length === 0) {
      return await this.inner.reply(userText, image, note);
    }
    const sync = [
      '（下面几轮是刚才由快车道直接答给用户的，没有经过你的会话；当作已知上下文即可）',
      ...this.pending,
    ].join('\n');
    this.pending.length = 0;
    this.log('  快车道    把缓冲的闲聊轮次补进 dsh 上下文');
    return await this.inner.reply(userText, image, note === undefined ? sync : `${note}\n\n${sync}`);
  }

  private async ask(userText: string, startedAt: number): Promise<FastAnswer> {
    const doFetch = this.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    timer.unref?.();
    try {
      const response = await doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          temperature: 0.8,
          max_tokens: 64,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userText },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await readStream(response.body, startedAt, this.now);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
