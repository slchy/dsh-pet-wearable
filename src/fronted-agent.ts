/**
 * 快车道装饰器：**短句纯闲聊**直接答，其余交给内层 agent（dsh）。
 *
 * <h2>三条路径</h2>
 *
 * ```text
 *   isFastCandidate 为假 ──────────────▶ dsh（完全不启动快模型，0 ms 开销）
 *
 *   投机（默认开）：
 *     快模型与 dsh **同时发**；
 *     - 快模型先给出实质文本 → 用它的，dsh 的增量丢掉（请求照常跑完，见「已知代价」）
 *     - 快模型说 [[DELEGATE]] / 超时 → 把 dsh 已到的增量补放出去，转用 dsh
 *
 *   串行（FAST_LANE_SPECULATE=0）：
 *     先等快模型定下来，命中才答，否则再叫 dsh（委派轮白等一次判定）
 * ```
 *
 * **为什么投机能白赚**：dsh 的 TTFT 真机中位 690 ms，而快模型约 500 ms 就能判定
 * 自己答不答得了 —— 判定通常早于 dsh 吐出第一个 token，所以把 dsh 的增量先扣在
 * 缓冲里，正常轮次压根没有东西可扣。实测串行版的「委派代价」p50 是 570 ms，
 * 投机把它压到 0（`bench/fast_lane` 可复现）。
 *
 * <h2>流式传输</h2>
 *
 * 快模型一旦吐出**确定不是暗号**的第一个字，就逐字推给 TTS 的流式通道，
 * 不再等整句说完 —— 短答能省 150–200 ms。判定暗号只需要看开头两个字符：
 * 情绪标签是单 `[`（`[开心]`），暗号是 `[[`，不会误伤。
 *
 * **一旦开闸就不能再退回 dsh**（已经播出去的声音收不回来），所以中途报错时
 * 按「已播出的那部分」收下，而不是重播一遍。
 *
 * <h2>已知代价（投机）</h2>
 *
 * 命中快车道的那一轮，dsh 也在后台把话答完了，但用户没听到：
 * - 白花一次 dsh 调用（token 成本）
 * - dsh 的会话历史里留着一条「用户没听过的回答」
 *
 * 换掉它的是委派轮不再白等判定。要退回串行：`FAST_LANE_SPECULATE=0`。
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
 *
 * 但**不收「什么」**：它会把「你叫什么名字」一起挡掉，而那句在系统提示词里
 * 明确属于闲聊（`bench/fast_lane` 的用例集就是这么抓到的）。「几点 / 天气」
 * 这类要事实的问题交给快模型自己判委派 —— 它在这一层比词表准。
 */
const TASK_WORDS: readonly string[] = [
  '查', '搜', '拍', '看', '打开', '帮我', '帮我看', '哪', '怎么', '多少', '为什么',
  '这个', '那个', '刚才', '记住', '记一下', '订单', '地址', '电话', '文件', '日志',
  '导航', '提醒', '设置', '翻译', '总结', '念', '读', '找',
];

const SYSTEM_PROMPT = [
  '你是中文语音助手的「快车道」。用户戴着智能眼镜跟你闲聊。',
  '回答这些，**不要委派**：',
  '- 招呼、寒暄、夸奖、撒娇、道别、问你是谁/叫什么名字；',
  '- **表达感受**：累、饿、冷、疼、难过、开心、烦躁 —— 只要他没要求你做事，',
  '  就顺着他的话回应（例如「我好累啊」→「那歇会儿吧，我陪着你」）。',
  '其余一律**只输出** [[DELEGATE]]（六个字符，不要解释、不要加标点）：',
  '- 要查资料、看东西、拍照、调工具、记住或回忆信息、改设置、导航、下单；',
  '- 涉及具体事实、数字、人名、时间、地点；',
  '- 你不确定的。',
  '要求：一句话，不超过 20 个字，口语，不要表情符号，不要 markdown，不要加语气标签。',
].join('\n');

/**
 * 有后台任务时追加的规则。**必须给事实才追加** —— 没事实时提「后台任务」反而
 * 会诱导它编一个。
 */
const TASK_RULE = [
  '',
  '【这一轮额外给了你一条「后台任务」事实】',
  '- 用户问进度（好了吗/查到了吗/还在跑吗/怎么样了/还要多久），**不要委派**，',
  '  直接用那条事实说一句：在跑就说还在跑，别报结果；',
  '- 事实说没有在跑的，就别编「正在查」，也别编「刚查到」；',
  '- 不要复述整条事实，用口语说一句。',
].join('\n');

/**
 * 问「进度」而不是「干活」的句子。
 *
 * 这类句子里的字（查/找/看）会命中 `TASK_WORDS` 被挡去 dsh，但它们问的是**已经在跑
 * 的那件事**，有事实就能照实答 —— 那正是慢车道最不该拦的一类。
 *
 * 只在**有事实来源时**才放行（`FrontedAgent` 里判断），且要求句子里没有「请/帮/给我」
 * 这类**发起任务**的词：「帮我查一下」是下指令，不是问进度。
 */
const STATUS_HINTS: readonly string[] = [
  '好了吗', '好了没', '好了没有', '好没好', '弄好了吗', '搞定了吗',
  '查到了吗', '查到没', '查到没有', '找到了吗', '找到没',
  '还在跑', '在跑吗', '跑完了吗', '完事了吗', '完成了吗', '结束了吗',
  '怎么样了', '进展', '到哪了', '还没好', '还要多久', '好了嘛',
];

const STATUS_BLOCKERS: readonly string[] = ['请', '帮', '给我', '替我', '一下'];

export function isStatusQuestion(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (STATUS_BLOCKERS.some((w) => t.includes(w))) return false;
  return STATUS_HINTS.some((w) => t.includes(w));
}

/** 快车道自己记住几轮（再多就该让 dsh 知道了，靠 `pending` 同步） */
const RECENT_TURNS = 2;

/** 短回话的形状：dsh 在等确认时，这类句子必须交给它，不能当闲聊答掉 */
const CONFIRM_WORDS: readonly string[] = [
  '好的', '好呀', '好啊', '好', '行', '可以', '对', '是', '嗯', '要', '不',
  '确认', '取消', '继续', '没错', '算了', '不用', '不要', '谢谢',
];

/** 这句像不像在回应上一句问话 */
export function looksLikeAnswer(text: string): boolean {
  const t = text.trim().replace(/[。！!，,、？?…\s]/g, '');
  if (t === '' || t.length > 8) return false;
  return CONFIRM_WORDS.some((w) => t.includes(w));
}

/**
 * dsh 末尾这句是不是在**等用户回话**。
 *
 * 只看句尾不够 —— 真实的一句是「你要删哪条，说个大概内容，我找出来对一下再动手。」
 * （句号结尾）。所以句中扫疑问词：只要出现就按「在等回话」处理，下一句短回话
 * 一律交给 dsh。误判的代价只是那一句慢 700 ms，漏判的代价是业务断链。
 */
const ASK_MARKERS: readonly string[] = [
  '？', '?', '吗', '呢', '嘛', '哪', '什么', '怎么', '为什么', '多少', '是否',
  '要不要', '能不能', '可不可以', '说一下', '告诉我',
];

export function awaitsReply(speech: string): boolean {
  const t = speech.trim();
  if (t === '') return false;
  return ASK_MARKERS.some((w) => t.includes(w));
}

export interface FastLaneOptions {
  readonly inner: AgentProvider;
  /** DeepSeek key；空串 = 关闭快车道 */
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /**
   * 首字超时。700 → 1200：`bench/fast_lane` 扫出来的 —— 首字 p90 是 598–723 ms，
   * 700 ms 会掐掉正常答案（13 条闲聊里漏 1 条），1200 才 13/13。
   * 放宽**不增加委派代价**：真委派是首字符 `[[` 早退，付的是 TTFT（实测 469–658 ms）；
   * 这个超时只兜「模型一个字节都不出」的病态情况。
   */
  readonly timeoutMs?: number;
  /** 首字到了之后，整句最多再等这么久（默认 2800 ms） */
  readonly totalMs?: number;
  /** 超过这么多字不当闲聊（默认 14） */
  readonly maxChars?: number;
  /** 最多攒几轮快车道对话就强制刷进 dsh（默认 4） */
  readonly keepTurns?: number;
  /** 投机双轨：与 dsh 同时发（默认 true） */
  readonly speculate?: boolean;
  /**
   * 快车道胜出后怎么处置在途的慢车道那一轮。
   *
   * - `rpc`（默认）：发 `session/cancel`。当前 dsh 的 **SDK 运行时没放行**这个方法
   *   （实测 `unknown ... runtime method`），所以实际效果是「让它跑完」，
   *   但换成支持它的运行时就能白赚。
   * - `interrupt`：SIGINT 杀进程。**会退出**，下一轮重启 + resume 实测多花 ~2 s，
   *   比省下的那次调用更贵 —— 只在确定不会再问时才值得。
   * - `off`：什么都不做。
   */
  readonly cancelMode?: 'rpc' | 'interrupt' | 'off';
  /**
   * 后台任务状态的一句话事实（`session.taskStatus()`）。
   *
   * 只在**调用时**取，所以拿到的是本轮那一刻的真实状态。空串 = 不给（不追加规则）。
   */
  readonly taskStatus?: () => string;
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
  /** 有没有已经推给 TTS（推过就不能再退回 dsh，否则重播） */
  readonly opened: boolean;
}

interface StreamHooks {
  readonly onFirstToken: () => void;
  readonly emit: (text: string) => void;
}

/** 读 SSE 流：判定暗号、按需早退、过了判定就逐字推给 TTS。 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  now: () => number,
  hooks: StreamHooks,
): Promise<FastAnswer> {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  /** 开闸之前攒着的那点字（要看够两个字符才敢判断是不是暗号） */
  let held = '';
  let opened = false;
  let firstTokenMs = 0;

  const finish = (delegated: boolean): FastAnswer => ({ text, firstTokenMs, delegated, opened });

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
        return finish(text.trim().startsWith(DELEGATE));
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
        hooks.onFirstToken();
      }
      text += piece;
      if (opened) {
        hooks.emit(piece);
        continue;
      }
      held += piece;
      const head = held.trimStart();
      if (head.startsWith('[[')) {
        return finish(true);
      }
      // 只有一个 `[` 时还看不出是不是暗号，再等一个字
      if (head.startsWith('[') && head.length < 2) {
        continue;
      }
      opened = true;
      hooks.emit(held);
      held = '';
    }
  }
  return finish(text.trim().startsWith(DELEGATE));
}

/** dsh 增量此刻该去哪：正常直通、进缓冲（等判定）、还是丢掉（快车道已胜出） */
type InnerMode = 'pass' | 'buffer' | 'drop';

export class FrontedAgent implements AgentProvider {
  private readonly inner: AgentProvider;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly totalMs: number;
  private readonly maxChars: number;
  private readonly keepTurns: number;
  private readonly speculate: boolean;
  private readonly cancelMode: 'rpc' | 'interrupt' | 'off';
  private readonly statusFacts: (() => string) | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** 快车道答过、还没进 dsh 会话的轮次（"用户: …" / "你: …" 两行一组） */
  private readonly pending: string[] = [];
  /** 快车道自己答过的最近几轮（快模型默认只看得到当前一句，接不上「我叫什么」） */
  private readonly said: Array<{ user: string; you: string }> = [];
  /** 上一轮 dsh 说了什么、是不是在问话 */
  private lastDsh: { speech: string; asked: boolean } | null = null;
  private sink: ((text: string) => void) | null = null;
  private innerMode: InnerMode = 'pass';
  private readonly buffered: string[] = [];
  /** 本轮投机起的 dsh 是否已经被掐掉（只掐一次） */
  private innerCancelled = false;
  /** 投机那一轮是不是已经有结果了 —— 有结果就绝不能再发取消（否则杀的是下一轮） */
  private innerDone = false;

  constructor(options: FastLaneOptions) {
    this.inner = options.inner;
    this.apiKey = options.apiKey ?? '';
    this.model = options.model ?? 'deepseek-chat';
    this.baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    this.timeoutMs = options.timeoutMs ?? 1_200;
    this.totalMs = options.totalMs ?? 2_800;
    this.maxChars = options.maxChars ?? 14;
    this.keepTurns = options.keepTurns ?? 4;
    this.speculate = options.speculate ?? true;
    this.cancelMode = options.cancelMode ?? 'rpc';
    this.statusFacts = options.taskStatus;
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
   * 快车道的回答也走这条通道（不再等整句），dsh 的增量则按当前模式过闸。
   *
   * 闸门放在这里而不是 `reply()` 里：`attachLiveSink` 是**每轮**调一次，
   * 而投机要挡的正是「dsh 早于快模型判定就开口」那一段。
   */
  attachLiveSink(sink: ((text: string) => void) | null): void {
    this.sink = sink;
    if (sink === null) {
      this.innerMode = 'pass';
      this.buffered.length = 0;
      this.inner.attachLiveSink?.(null);
      return;
    }
    this.inner.attachLiveSink?.((text) => {
      if (this.innerMode === 'drop') {
        return;
      }
      if (this.innerMode === 'buffer') {
        this.buffered.push(text);
        return;
      }
      sink(text);
    });
  }

  setAnnouncer(cb: ((speech: string, emotion?: string) => void) | null): void {
    this.inner.setAnnouncer?.(cb);
  }

  async reply(userText: string, image?: AgentImage, note?: string): Promise<AgentReplyView> {
    // dsh 上一条在问话，用户这句是短回话（好的/对/不用）—— 那是**对话里的回应**，
    // 不是闲聊。放给快模型就是「确认指令被抢答」，业务状态机直接断链。
    if (this.lastDsh?.asked === true && looksLikeAnswer(userText)) {
      this.log('  快车道    上一轮 dsh 在等回话，这句直接交给 dsh');
      return await this.delegate(userText, image, note);
    }
    const hasFacts = this.statusFacts !== undefined;
    // 问进度的句子即使含任务字也放进来 —— 事实能照实答，比让 dsh 重跑一轮快得多
    const candidate = this.apiKey !== ''
      && image === undefined
      && (isFastCandidate(userText, this.maxChars)
        || (hasFacts && isStatusQuestion(userText)));
    if (!candidate) {
      return await this.delegate(userText, image, note);
    }
    if (this.pending.length / 2 >= this.keepTurns) {
      this.log('  快车道    攒满上限，这一轮强制交给 dsh（顺便刷上下文）');
      return await this.delegate(userText, image, note);
    }

    const startedAt = this.now();
    let dsh: Promise<AgentReplyView> | null = null;
    if (this.speculate) {
      // 先上闸再起跑：`inner.reply` 在第一个 await 之前是同步执行的，
      // 顺序反了的话 dsh 抢先推的增量会绕过缓冲直接进 TTS。
      this.innerMode = 'buffer';
      this.innerCancelled = false;
      this.innerDone = false;
      dsh = this.startInner(userText, image, note);
      dsh.then(
        () => { this.innerDone = true; },
        () => { this.innerDone = true; },
      );
    }

    let emitted = '';
    let answer: FastAnswer;
    try {
      answer = await this.ask(userText, startedAt, (text) => {
        emitted += text;
        // 推出去的第一个字就是「这一轮归快车道」的判决书 —— 退回 dsh 会播两遍，
        // 所以这一刻就把在途的 dsh 那一轮掐掉，别等它把整段答完再取消。
        // 只有真开了投机才动手：不投机时 dsh 里在跑的是**别的**轮次（比如后台任务
        // 的旁白），取消它等于把旁白吞了。
        if (dsh !== null) this.cancelInner();
        this.sink?.(text);
      });
    } catch (error) {
      const why = (error as Error).message;
      // 已经开闸 = 有字推给了 TTS，这时候再退回 dsh 会把同一句话播两遍
      if (emitted !== '') {
        this.log(`  快车道    ✗ ${why}（已播出一部分，按现有文本收下）`);
        dsh?.catch(() => undefined);
        return this.commit(userText, emitted, 0, dsh);
      }
      return await this.abandon(dsh, userText, image, note, `✗ ${why}`);
    }

    if (answer.delegated) {
      return await this.abandon(dsh, userText, image, note, `判为需要 dsh（${answer.firstTokenMs} ms 早退）`);
    }
    if (cleanForSpeech(parseEmotion(answer.text).rest) === '') {
      return await this.abandon(dsh, userText, image, note, '空答复');
    }
    return this.commit(userText, answer.text, answer.firstTokenMs, dsh);
  }

  /** 快车道胜出：**取消**在途的 dsh 那一轮，别白花钱、也别留幽灵历史 */
  private commit(
    userText: string,
    raw: string,
    firstTokenMs: number,
    dsh: Promise<AgentReplyView> | null,
  ): AgentReplyView {
    this.innerMode = 'drop';
    this.buffered.length = 0;
    if (dsh !== null) {
      this.cancelInner();
      dsh.then(
        () => { this.log('  快车道    慢车道那一轮已作废'); },
        () => undefined,
      );
    }
    const { emotion, rest } = parseEmotion(raw);
    const speech = cleanForSpeech(rest);
    this.pending.push(`用户: ${userText.trim()}`, `你: ${speech}`);
    this.remember(userText, speech);
    this.log(`  快车道    ${firstTokenMs} ms 首字（流式） ：${JSON.stringify(speech)}`);
    return { text: raw, speech, firstTokenMs, emotion };
  }

  /**
   * 记下这一轮（快车道自己的记忆 + dsh 最后说的话）。
   *
   * 快模型默认**只看到当前一句话**，所以「我姓袁」→「我叫什么」这种追问它接不上；
   * 更危险的是 dsh 刚问过「确认要删除吗」，用户答「好的」会被当成闲聊答掉。
   * 两处记忆都塞进系统消息，成本是每轮多几十个 token。
   */
  private remember(userText: string, said: string): void {
    this.said.push({ user: userText.trim().slice(0, 40), you: said.slice(0, 40) });
    if (this.said.length > RECENT_TURNS) this.said.shift();
  }

  /**
   * 掐掉投机起的 dsh 那一轮。只掐一次 —— 首字时掐过，`commit` 再调就是空转。
   *
   * 宿主层 `session/cancel` 实测 **5 ms 收敛**、进程不死、会话不丢、也不影响下一轮
   * （`turn/end` reason = `{kind:'aborted',reason:{kind:'user'}}`）。取消失败不算错：
   * 已经推给 TTS 的字收不回来，最坏也只是白跑一次生成。
   */
  private cancelInner(): void {
    if (this.innerCancelled || this.innerDone) {
      return;
    }
    this.innerCancelled = true;
    try {
      if (this.cancelMode === 'interrupt') {
        this.inner.interruptTurn?.();
      } else if (this.cancelMode === 'rpc') {
        this.inner.cancelTurn?.();
      }
    } catch (error) {
      this.log(`  快车道    ✗ 取消失败：${(error as Error).message}`);
    }
  }

  /** 快车道让位：把 dsh 已经推进来的增量补放出去，然后等 dsh */
  private async abandon(
    dsh: Promise<AgentReplyView> | null,
    userText: string,
    image: AgentImage | undefined,
    note: string | undefined,
    why: string,
  ): Promise<AgentReplyView> {
    this.log(`  快车道    ${why} → 交给 dsh`);
    const promise = dsh ?? this.startInner(userText, image, note);
    this.innerMode = 'pass';
    const held = this.buffered.splice(0);
    for (const text of held) {
      this.sink?.(text);
    }
    const answer = await promise;
    this.rememberDsh(answer.speech);
    return answer;
  }

  private async delegate(
    userText: string,
    image?: AgentImage,
    note?: string,
  ): Promise<AgentReplyView> {
    this.innerMode = 'pass';
    const answer = await this.startInner(userText, image, note);
    this.rememberDsh(answer.speech);
    return answer;
  }

  /** 记下 dsh 最后说的话（快模型下一轮要看：它在问什么、答案是什么） */
  private rememberDsh(speech: string): void {
    this.lastDsh = { speech: speech.slice(0, 60), asked: awaitsReply(speech) };
  }

  /**
   * 调 dsh，顺便把攒着的快车道轮次经 `note` 补进上下文。
   *
   * 用 `note` 而不是改用户原话：那一栏本来就是「系统注记」，dsh 会把两者分开。
   */
  private startInner(
    userText: string,
    image: AgentImage | undefined,
    note: string | undefined,
  ): Promise<AgentReplyView> {
    if (this.pending.length === 0) {
      return this.inner.reply(userText, image, note);
    }
    const sync = [
      '（下面几轮是刚才由快车道直接答给用户的，没有经过你的会话；当作已知上下文即可）',
      ...this.pending,
    ].join('\n');
    this.pending.length = 0;
    this.log('  快车道    把缓冲的闲聊轮次补进 dsh 上下文');
    return this.inner.reply(userText, image, note === undefined ? sync : `${note}\n\n${sync}`);
  }

  /**
   * 系统提示词 + 本轮的事实。
   *
   * 事实放在**系统消息**里而不是用户消息里：它不该被当成用户说的话，也不该进
   * 待同步的对话缓冲（那几行是要原样补进 dsh 的）。
   *
   * 三样东西按代价从低到高拼：后台任务事实（进度问答用）、快车道自己最近两轮
   * （不然「我叫什么」接不上）、dsh 最后一句（不然「好的」会在 dsh 问话之后被抢答）。
   */
  private systemPrompt(): string {
    const parts: string[] = [SYSTEM_PROMPT];

    if (this.lastDsh !== null) {
      parts.push(`【上一轮 dsh 说】${this.lastDsh.speech}`);
    }
    if (this.said.length > 0) {
      parts.push(`【你自己最近说的】${this.said.map((t) => `用户「${t.user}」→ 你「${t.you}」`).join('；')}`);
    }
    if (this.lastDsh !== null || this.said.length > 0) {
      parts.push('只用上面这些已发生过的话回答；问到别的事就 [[DELEGATE]]。');
    }

    let facts = '';
    try {
      facts = this.statusFacts?.() ?? '';
    } catch {
      facts = '';
    }
    if (facts !== '') {
      parts.push(TASK_RULE.trim(), facts);
    }
    return parts.join('\n');
  }

  private async ask(
    userText: string,
    startedAt: number,
    emit: (text: string) => void,
  ): Promise<FastAnswer> {
    const doFetch = this.fetchImpl ?? fetch;
    const controller = new AbortController();
    // **两段超时**：首字之前卡住 = 模型不干活，早点让给 dsh；
    // 首字之后还在出字 = 正常，给足时间 —— 用一个固定总超时会把
    // 「五百多毫秒才说完」的正常答案一起掐掉（实测 10 条闲聊里 6 条被掐）。
    let timer: NodeJS.Timeout = setTimeout(() => {
      controller.abort(new Error(`首字超时 ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    timer.unref?.();
    const rearm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort(new Error(`整句超时 ${this.totalMs} ms`));
      }, this.totalMs);
      timer.unref?.();
    };
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
            { role: 'system', content: this.systemPrompt() },
            { role: 'user', content: userText },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await readStream(response.body, startedAt, this.now, { onFirstToken: rearm, emit });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
