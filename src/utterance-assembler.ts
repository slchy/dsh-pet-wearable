/**
 * 句子 → 一轮话语（utterance）的合并与判停。
 *
 * <h2>职责</h2>
 *
 * ASR 的 `SentenceEnd` 是**句子**边界，不是**轮次**边界：
 * 「小爱同学。」和「我眼前的是什么？」会各发一次，照单全收就是两轮问答
 * （白烧一次 agent 调用）。本模块负责把若干句子合并成一轮，并决定
 * 「这一轮是不是真的说完了」。
 *
 * <h2>判停策略</h2>
 *
 * **不用**「问号结尾就直接收下」。ASR 的 `？` 是按语调加的，不代表语义完整 ——
 * 实测它把「你在运行什么？」（句中停顿）判成句尾，一句话被拆成三轮
 * （「你在运行什么？」→「平台上。」）。
 *
 * 所以一律先等 {@link UtteranceAssemblerOptions.quietMs}，再交给
 * {@link UtteranceAssemblerOptions.predict}（TurnJudge）看**音频本身**。
 * 它说没说完就再等一段：`p < threshold` 这一类最多
 * {@link UtteranceAssemblerOptions.maxUnsureExtensions} 次，其余三种文本判据合计
 * 最多 {@link UtteranceAssemblerOptions.maxExtensions} 次，然后强制收下，
 * 避免模型不确定时永远不定稿。
 *
 * <h2>与静候窗重叠</h2>
 *
 * 判停器的往返实测约 70 ms，全部压在这一轮的「用户说完 → 开一轮」里。设
 * {@link UtteranceAssemblerOptions.predictAtMs} 可以让它**提前出发**，与静候窗
 * 重叠：窗口关掉时概率已经在手上。代价是模型少看几十毫秒的句尾静音（那是它判断
 * 「说完了」的主要证据），所以提前量有个上限，不是越早越好。
 *
 * 提前算的那份结果带两个有效性条件，缺一不可：
 * - **同一句**（`seq` 没变）—— 用户接着说，上一句的判定不能拿来定稿；
 * - **算完之后没有再收到中间结果** —— 那份音频里没有他后半句。
 * 任一不成立就现算一次（等于回到旧行为），不猜。
 *
 * 本模块**不做 I/O**：判停器、日志、时钟全部注入。
 */
import { pcm16DurationMs, pcm16PeakDbfs, pcm16TrimTrailingSilence } from './pcm.ts';

export interface UtteranceAssemblerOptions {
  /** 句子结束后先静候这么久再判定 */
  readonly quietMs: number;
  /** 判为「没说完」时再多等这么久 */
  readonly extendMs: number;
  /**
   * 语义判停：给**当前这边的整段文字**，回 `'end'`（说完了）/ `'more'`（还有下文）
   * / `null`（拿不准或失败）。
   *
   * 声学判停（`TurnJudge`）看的是音频，它能判断「这像不像句尾」，判断不了「这句话
   * 说完了没有」—— 真机上 `p=0.985` 判对句尾、判错语义的场景一抓一把。文本这一层
   * 只补这一个洞：`'more'` 就再等一拍（吃既有的拍数/预算，不开后门），`'end'` 或
   * 超时都照常开轮。
   *
   * 判定在 `addSentence` 时就发出去，与静候窗重叠，所以正常情况下**不额外加延迟**。
   */
  readonly semanticEndpoint?: (text: string) => Promise<'end' | 'more' | null>;
  /** 等语义判停回话的上限（ms）。等不到就按「说完了」走。默认 300 */
  readonly semanticBudgetMs?: number;
  /** 一轮最多延长几次（**总预算**，四种原因共用） */
  readonly maxExtensions: number;
  /**
   * 其中**「判停说没说完」**这一类最多延长几次（ms 由 `extendMs` 定）。
   *
   * 为什么要单列一个上限：`p < threshold` 那条分支**不参考任何文本信号**
   * （用户在不在出字、结尾像不像没说完），只按 p 再等一拍。而侧车给的 p
   * 是噪声 —— 同一段音频两次回放，同一句从 `0.549` 变成 `0.189`，
   * 后者连等 5 拍 2.4 s。真机实测 4 次延长（1600 ms）才收下是常态。
   *
   * 静音闸门和短片段判据是**防抢话和并句的安全闸**，不该被这个病理拖着一起收紧
   * —— 所以它们仍走 `maxExtensions`。
   *
   * 缺省与 `maxExtensions` 相同（= 不改变旧行为）。
   */
  readonly maxUnsureExtensions?: number;
  /** 没有判停器时的固定合并窗口（旧行为） */
  readonly fallbackWindowMs: number;
  /** 概率门限 */
  readonly threshold: number;
  /**
   * 文本里含汉字时用的门限；不设就一律用 {@link threshold}。
   *
   * 为什么中文单独一档：模型官方 benchmark 里中文是最差的一档（85.8%，漏报 9.26%
   * / 误报 4.95%），方向是**偏向说「没说完」**。我们自己的真机上也是同一件事：
   * 完整的短句「嗯，对。」给 0.22–0.41，而真正没说完的「对吗？那句。」给
   * 0.007–0.11 —— 用 0.5 会把前者全判成没说完，各白等 400–800 ms。
   */
  readonly thresholdCjk?: number;
  /** 送给判停器的最近音频上限（字节） */
  readonly recentMaxBytes: number;
  /**
   * 送给判停器的快照**尾部最多留多少静音**（ms）。
   *
   * 官方约定是「音频顶到输入向量的末尾、零补在开头」。尾巴留静音等于把语音
   * 从窗口末尾推开：同一句留 0 ms 时 p=0.95、留 800 ms 时 0.04。留多少在噪声里
   * （21 轮离线扫描 0–20 ms 好于 100 ms，真机回放复现不出来），取小值只为方向正确。
   */
  readonly trailingTrimMs?: number;
  /**
   * 「这里算不算静音」的门限（dBFS），缺省比 {@link silenceDb} 低 20 dB。
   *
   * **不能直接用 {@link silenceDb}**：那个门限是「有没有人说话」的开门门槛
   * （`VOICE_PEAK_DBFS`，默认 −40），而这台设备的语音峰值本身就只有 −32…−40 ——
   * 拿它当「静音」判据会把**最后几个音节当静音裁掉**，判停看到的是半句话。
   * （真机回放里正是这个：同一句 trim 门限用 −40 时 p 掉到 0.28，用 −60 时 0.89。）
   */
  readonly silenceFloorOffsetDb?: number;
  /** 判停器。返回 <0 表示不可用 */
  readonly predict?: (pcm: Buffer) => Promise<number>;
  /**
   * 提前发起判停请求的时刻（相对句子到达，毫秒）。
   *
   * 不设 = 到 `quietMs` 到点才发（旧行为）。设了就与静候窗**重叠**：窗口关掉时
   * 概率已经在手上，判停器那一趟往返（实测约 70 ms）不再落在关键路径上。
   * 中位 `asrToTurn` 从 224 ms 降到静候窗本身（150 ms）。
   *
   * 为什么不设 0：判停器的输入是「**到此刻为止**的音频」，提前多少毫秒，模型就
   * 少看多少毫秒的句尾静音（静音是「说完了」的主要证据）。65 ms 是「推理跑得完」
   * 与「别把静音砍太多」的折中，见 `voice-session.ts` 里的常量。
   */
  readonly predictAtMs?: number;
  /**
   * 「太短」的门槛（去标点后的字数）。默认 3。
   *
   * 见 {@link UtteranceAssembler} 里 `shouldWaitForMore` 的说明。
   */
  readonly shortFragmentChars?: number;
  /** 上一轮收下之后多久内出现的短碎片算「同一句话被切开」。默认 1200 ms */
  readonly shortFragmentWindowMs?: number;
  /**
   * 碎片最多再等多久。默认 400 ms。
   *
   * 不能直接用 {@link extendMs}：生产上那是 700 ms，而「碎片」
   * 多半只是用户正常的一句短回答（「好。」「行。」），每句多等 700 ms
   * 是把判停的收益赔进去。ASR 断句间隔通常远小于 400 ms，够用了。
   */
  readonly shortFragmentWaitMs?: number;
  /**
   * 本地静音判据：上行峰值低于这个 dBFS 就算「没在说话」。不设就不启用预判停。
   *
   * 传**能量门那个门槛**（同一路放大后的波形、同一套设备标定），别另设一个。
   */
  readonly silenceDb?: number;
  /**
   * 静音持续多久就把判停请求**提前**发出去（默认 200 ms）。
   *
   * 动机：ASR 要靠 200 ms 静音才发 `SentenceEnd`，而那 200 ms 里音频已经全在手里了 ——
   * 判停器完全可以这时候就跑。等 `SentenceEnd` 到了，概率早算好了，`出句→开轮`
   * 那 118 ms 直接归零。见 {@link UtteranceAssembler.addAudio}。
   */
  readonly silencePauseMs?: number;
  /**
   * 静音持续多久就**先投机一次**（默认 100 ms，比 {@link silencePauseMs} 早）。
   *
   * 为什么要比判停更早：判停那 200 ms 是留给"判停器算概率"的，投机不需要等它 ——
   * 投机只是拿中间结果先问出去，问早了顶多作废（有定稿闸门兜着），问晚了就白等。
   *
   * 提前这 100 ms 本身**不省端到端**（模型的 290 ms 早就跑得完 731 ms 的跑道），
   * 它的用途是把「首字 → 认领」这个窗口从 241 ms 撑到 341 ms ——
   * 只有撑到 TTS 首块（330–375 ms）之上，「提前合成音频」才有地方放。
   * 设 0 关闭投机触发（`FAST_LANE_PARTIAL_SPECULATE=0` 也能关，那条在接收方）。
   */
  readonly speculateMs?: number;
  /**
   * 静音持续多久就把「到目前为止的音频」**封成一段**交给客户端控端点的 ASR
   * （见 `SttSession.commit`）。不设 = 不触发（服务端自己判句的 provider）。
   *
   * 这个值和 {@link silencePauseMs} 是两件事：那个是「让判停器先算」，
   * 这个是「让 ASR 开始解码」。后者在关键路径上，前者只是把等待重叠掉。
   *
   * 切早了会把字切成两半（下一段的文本拼回去，但边界那个字可能丢），
   * 所以这个值要靠真机标定，不要一次压到底。
   */
  readonly commitAfterMs?: number;
  /**
   * 静音到 {@link commitAfterMs} 时调一次，宿主拿去 `stt.commit()`。
   *
   * `silenceMs` = **距最后一个有声帧多久**。它一定 ≥ `commitAfterMs`，多出来的那截
   * 是「静音开始到真有音频帧到达」的等待 —— 所有按静音计时的动作（封段 / 投机 /
   * 判停预跑）都跑在 `trackSilence` 里，而它只在 `addAudio` 时调，所以这段等待
   * 直接变成每一轮的固定开销。落档才知道它有多大（`asr.commit`）。
   */
  readonly onCommit?: (silenceMs: number) => void;
  /**
   * 开轮的**静音门槛**：定稿到达时，「截至此刻」的连续静音必须够这么久才开轮。
   *
   * 为什么必须和 {@link commitAfterMs} 分开：提交只管切段，越早越好（解码 260 ms
   * 是整条链路里最长的一段）；开轮是**不可逆**的动作，要保守。以前两者是同一个
   * 事件（定稿到达就开轮），所以切早了就会把换气当成句尾 —— 实测「对吗？」(80 ms
   * 换气后) 被判停给 0.661 当场收下，接着后半句「那句。」到达，只好打断重答。
   *
   * 定稿到达时本地已经多听了 `commit→定稿` 那 260 ms，所以这个门槛在多数轮次上
   * **不花时间**，只在「用户确实又开口了」时才拦住 —— 那本来也不该开轮。
   *
   * 不设 = 关闭（NLS 那种服务端判句的 provider 用不上：它吐句子时静音早已够）。
   */
  readonly openQuietMs?: number;
  /**
   * 判停概率高时用的短门槛（见 {@link openQuietMs}）。
   *
   * p 高说明「听起来完整」，可以少等一点；p 一般就等到长门槛，把换气挡在门外。
   * 不设 = 两档一样。
   */
  readonly openQuietShortMs?: number;
  /** 进入短门槛的 p（默认 0.8） */
  readonly openQuietHighP?: number;
  /**
   * **QoS：② 段（定稿→开轮）的总等待预算**，毫秒。0 = 不设（默认）。
   *
   * 不管是因为 p 低、静音门槛不够、还是这片语太短 —— 累计等满这么多就收下。
   * 目的是让 `②` 有一个**可预测的上限**，而不是「maxExtensions × extendMs」那样
   * 随分支数量漂移（真机 2026-11-18：7/29 轮把额度吃干净，单轮白等 1.4 s）。
   */
  readonly waitBudgetMs?: number;
  /**
   * **QoS：句尾像未完成的序列**（数字、字母、「第」「然后」…）时的预算，毫秒。
   * 0 = 不启用（默认）。
   *
   * 动机是反着的：这类句尾 `p` 判「没说完」**是对的**（念手机号时每停顿一次都
   * 真没说完），可总预算会把这份正确判断提前掐掉 —— 真机 2026-11-18 一句手机号被
   * 拆成 3–4 轮。所以序列形态要给一份**更大的豁免**，让它等到数字念完。
   * 判据复用 {@link looksUnfinished}（纯机械，不做语义推断）。
   */
  readonly waitBudgetSequenceMs?: number;
  /**
   * **统一上限**：开轮时的连续静音不得超过这个值（ms）。0 / 未设 = 不设上限。
   *
   * 为什么要它：`waitBudget` 系列只封住「收下」那条判定，静音闸门和文本判据各自
   * 还有自己的额度，实测能绕过去 —— 真机一场 29 轮里有 15 轮 ② 超 1200 ms，
   * 最大 2264 ms。这条是**唯一一条不许任何分支绕过的上限**：静音到顶就放行。
   *
   * 取 650 的依据（真机 54 轮，见 `docs/EOT-SUPPLEMENT.md` §8）：开轮静音
   * 500–1200 ms 那 7 轮**一次都没有**被用户接着说，而 <300 ms 的 6 轮**全部**被接着说。
   * 650 落在"免费窗口"里。
   */
  readonly maxOpenSilenceMs?: number;
  /**
   * 一句定稿（文本已定、还没判定停）时通知一次。   *
   * 判停器随后只决定「要不要并下一段」，**不影响这段文本** —— 所以快车道可以
   * 先在这上面起跑，省掉判停那 140 ms 纯等待；真并了下一段就换一句重问。
   * 只在**文本允许**的前提下才起跑，判据在接收方（`FrontedAgent.prefetch`）。
   */
  readonly onSentence?: (text: string) => void;
  /**
   * ASR 静音那一刻通知一次，`text` = 这一轮到目前为止的全文（已定稿部分 + 最新一版 partial）。
   *
   * 给快车道**投机**用：比定稿早 p50 731 ms（真机 47 轮），先拿它问出去，定稿确认
   * 是前缀才认。文本是**猜的**（中间结果在句末会大改），所以这里只传文本、不做判断 ——
   * 闸门在接收方（`FrontedAgent.speculatePartial` / `acceptsSpeculation`）。
   *
   * **返回值 = 这一次到底有没有投出去**。必须回传，因为长度门槛、候选判据、
   * 配额全在接收方：以前这里无条件记 `specFiredAt`，一句「嗯」被门槛挡掉，却把
   * 整段语音的投机机会用完了 —— 真机 `20261119-071340` 轮 2/3/11 三轮全栽在这
   * （那三条 partial 是**上一段语音**残留的「嗯」，`+100 ms` 时真实覆盖 0%）。
   */
  readonly onPartial?: (text: string) => boolean;
  /** 一轮定稿 */
  readonly onUtterance: (text: string) => void;
  /**
   * 判停器每做一次决定就报一条（落进档案的 `judge.decide`）。
   *
   * 为什么必须落档：`② 定稿→开轮` 这个数字在档案里一直是黑盒。它可能 1 ms
   * （当场收下），也可能 2400 ms（连说六次「没说完」，每拍 400 ms）。
   * 不看 `p` 就分不清是「判停不敢收」还是「排队」—— 修法完全相反。
   */
  readonly onJudge?: (fact: JudgeFact) => void;
  readonly log: (line: string) => void;
  /** 可注入时钟，测试用 */
  readonly now?: () => number;
}

/** 判停器的一次决定 */
export interface JudgeFact {
  /** 「说完了」的概率；负数 = 判停器不可用（故障） */
  readonly p: number;
  /** 这次决定还要再等多久（ms）；收下 / 故障时为 0 */
  readonly waitMs: number;
  readonly action: 'accept' | 'extend' | 'error';
  /** 为什么还要等（只有 `extend` 有） */
  readonly why?: 'short' | 'unsure' | 'silence' | 'meaning';
  /** 为什么放行（只有 `accept` 可能带）。`cap` = 静音到了统一上限 */
  readonly whyAccept?: 'cap';
  /** 这次决定用的阈值（中文和默认可能不同，落档才分得清） */
  readonly threshold?: number;
  /** 截至这次决定，已连续静音多久（ms）。门槛判据的直接证据 */
  readonly silenceMs?: number;
  /** 这一轮为了等判停已经花掉多少（ms）。② 的预算用得怎么样，看它 */
  readonly waitedMs?: number;
  /** 这次决定时这一轮的等待预算（ms）；0 = 没设预算 */
  readonly budgetMs?: number;
}

/** 判定一次的结果，便于日志与测试断言 */
export type EndpointDecision = 'accept' | 'extend' | 'predictor-unavailable';

/**
 * 结尾「必须还有下文」的记号。纯机械，不做语义推断
 * （和 `backchannel.ts`、`shouldWaitForMore` 同一条原则）。
 *
 * 只收「单独出现在句尾就不成立」的记号：
 * - 数字 / 中文数字：`#W866`、`第`
 * - 字母：`井号W`（订单号、型号被拦腰截断）
 * - 连词与引子：`和` `就是` `因为` `的话`…
 *
 * **宁漏不误**：误判的代价是这一轮多给一份序列预算（见
 * {@link UtteranceAssemblerOptions.waitBudgetSequenceMs}），漏判只是维持现状。
 */
const UNFINISHED_TAIL =
  /(?:[0-9０-９]|[零一二三四五六七八九十百千万亿两]|[A-Za-z#＃]|井号|第|和|跟|与|及|还有|就是|因为|所以|但是|然后|如果|的话|或者|还是)$/u;

/** 尾部标点 —— ASR 每个 `SentenceEnd` 都会补一个，作为句界记号而不是内容 */
const TRAILING_PUNCT = /[\s。．.，,、!！?？~～…\-—:：;；"'“”‘’]+$/u;

/** 这句话里有中日韩汉字吗 —— 用来选判停阈值（见 `thresholdFor`） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 声学判据到了这个置信度就不等语义判停了。
 *
 * 语义判停的意义在「声学拿不准」（p 落在 0.3–0.85 那条带），p 已经 0.88–0.98
 * 时再等 256–324 ms 纯属白搭 —— 真机 `20261123-051448` 全场语义一次没拦住 MORE。
 */
const SEMANTIC_SKIP_P = 0.85;

/**
 * 「定稿只是中间结果的收尾」允许差几个字。
 *
 * 中间结果的最后一版和定稿通常差一两个标点/收尾字（`…《基础之森` → `…《基础之森》吗？`）。
 * 超过这个长度就是另一句话了，前缀判定不再作数。
 */
const SEMANTIC_PREFIX_SLACK_CHARS = 6;

/** 丢掉尾部标点，只看最后那个字 */
function stripTail(text: string): string {
  return text.replace(TRAILING_PUNCT, '');
}

/** 结尾看起来「还有下文」吗 —— 见 {@link UNFINISHED_TAIL} */
export function looksUnfinished(text: string): boolean {
  const core = stripTail(text);
  return core.length > 0 && UNFINISHED_TAIL.test(core);
}

export class UtteranceAssembler {
  private readonly options: UtteranceAssemblerOptions;
  private readonly now: () => number;
  private readonly recentChunks: Buffer[] = [];
  private recentBytes = 0;
  private pendingText = '';
  private pendingTimer: NodeJS.Timeout | null = null;
  /**
   * 当前这一句的代号。`addSentence` / `flush` / `dispose` 都 +1。
   *
   * 在飞的判停与排队中的 `evaluate` 都拿着它出生的那个号：用户又说了新的一句，
   * 旧号的判定就不能再用来定稿 —— 否则「上一句的概率」会把「这一句」提前收下，
   * 合并窗口就失效了。
   */
  private seq = 0;
  /**
   * 提前发起的判停。只对同一个 `seq` 有效。
   *
   * `startedAt` 是**取音频快照**的时刻：之后又收到中间结果说明用户还在说，
   * 那份音频里没有他后半句，结果作废（见 {@link takeProbability}）。
   */
  private prediction: {
    readonly seq: number;
    readonly startedAt: number;
    /**
     * 这一份是「静音一到就提前跑」的（见 `trackSilence`），不是给已经定稿的句子算的。
     *
     * 预跑的**新鲜度**由音频保证：之后只要又来声音，`trackSilence` 就把这份清掉。
     * 所以它不受 `startedAt >= lastPartialAt` 那条约束 —— ASR 的中间结果本来就比
     * 真实停嘴晚（实测晚 98–140 ms），拿它当「用户还在说」的证据会把预跑全废掉。
     */
    readonly pre: boolean;
    readonly probability: Promise<number>;
    /**
     * 这份判停用的音频快照有多少字节。
     *
     * 用来判「再等一拍有没有意义」：静音期间快照会被裁掉尾巴，所以**字节数不变
     * 就等于输入一模一样**（同一个模型、同一份特征 → 同一个 p）。真机上见过
     * `0.412 → 0.280 → 0.280`：最后一个 0.280 是拿同一段音频重算的，纯白等 400 ms。
     */
    readonly bytes: number;
  } | null = null;
  /** `predictAtMs` 的定时器 */
  private predictTimer: NodeJS.Timeout | null = null;
  private extensions = 0;
  /**
   * 语义判停的请求缓存：文字 → 判定。
   *
   * 为什么按**文字**存：判定在说话期间（中间结果）和定稿时就发出去了，而真正要用的
   * 时刻是「即将开轮」；同一段文字可能被问过一次，就该直接取。只留最近几条 ——
   * 中间结果会连续改写，不是历史账本。
   */
  private readonly semanticAsks = new Map<string, Promise<'end' | 'more' | null>>();
  /** 已经回来的判定（同步可读，见 hasPrefixMore） */
  private readonly semanticSettled = new Map<string, 'end' | 'more' | null>();
  /** 上一次因为中间结果发出去的文字（避免同一个中间结果反复问） */
  private semanticLastAsked = '';
  /** 已经因为语义判停延长过的那段文字（同一段只延长一次） */
  private semanticExtended = '';
  /** 上一段定稿的时刻 / 汉字数（去抖判据用，见 `isJunkAfterLongSentence`） */
  private lastSentenceAt = -1e9;
  private lastSentenceChars = 0;
  /**
   * 其中「判停说没说完」用掉了几次。
   *
   * 和 {@link extensions} 分开记：静音闸门和短片段判据是防抢话/并句的安全闸，
   * 不该被判停低分的病理拖着一起收紧（见 `maxUnsureExtensions`）。
   */
  private unsureExtensions = 0;
  /** 这一轮为等判停累计花掉的毫秒（QoS 预算用；`flush` 归零） */
  private waitedMs = 0;
  /** 上一次真正收下一轮的时刻，用来判断「短碎片是不是紧跟其后」 */
  private lastUtteranceAt = Number.NEGATIVE_INFINITY;
  /** 最近一次 ASR 中间结果的时刻：用户还在出字的直接证据 */
  private lastPartialAt = Number.NEGATIVE_INFINITY;
  /** 最近一次 ASR 中间结果的文本（原始，不含已定稿部分）—— 静音那一刻拿它投机 */
  private lastPartialText = '';
  /** 最近一次「上行有声音」的时刻（本地静音检测，见 `silenceDb`） */
  private lastVoicedAt = Number.NEGATIVE_INFINITY;
  /**
   * 连续有声帧计数（去抖，见 `trackSilence`）。
   *
   * 单帧不算数：这段录音里 20 ms 的「有声」有 14 处，多是塞音闭塞段或门限抖动。
   * 从第二帧起才更新 `lastVoicedAt`，之后每帧都推进 —— 它仍然等于真实停嘴时刻。
   */
  private voicedRun = 0;
  /**
   * 最近一次「上行有声音」的时刻（毫秒，和 `clock` 同一把尺）。
   *
   * 给插话判据用：服务端会把**我们喂进去的静音**解成短句（`Thank you`），
   * 这种转写底下没有任何有声帧。`Number.NEGATIVE_INFINITY` = 这条连接还没见过音频。
   * 见 `barge-voicing.ts`。
   */
  get lastVoicedAtMs(): number {
    return this.lastVoicedAt;
  }

  /** 这一段语音是否已经预跑过判停（每段只跑一次，别每块静音都跑） */
  private preFiredAt = Number.NEGATIVE_INFINITY;
  /**
   * 这一段语音是否已经请求过 ASR 封段（每段只封一次）。
   *
   * 「一段」的边界是 `lastVoicedAt`：又来声音就自然重新武装（比较的是时刻，
   * 不是布尔），静音期内反复进 `trackSilence` 只封一次。
   */
  private commitFiredAt = Number.NEGATIVE_INFINITY;
  /** 上一次问过、但接收方没发出去的那一版（同一版不重复问，免得每个静音帧刷一次） */
  private specTriedText = '';
  /** 上一次投机的时刻 / 这一句已经投机几次（`addSentence` 归零） */
  private specFiredAt = Number.NEGATIVE_INFINITY;
  private specCount = 0;
  /** 上一次判停用的快照字节数（判「再等一拍有没有意义」，见 `prediction.bytes`） */
  private lastSnapshotBytes = -1;
  /** 上一次判停决定的时刻 */
  private lastDecisionAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(options: UtteranceAssemblerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get pending(): string {
    return this.pendingText;
  }

  /** 每块上行 PCM 都要喂进来，判停器需要「最近的音频」而不只是文本。 */
  addAudio(chunk: Buffer): void {
    this.recentChunks.push(Buffer.from(chunk));
    this.recentBytes += chunk.length;
    this.trimRecent();
    this.trackSilence(chunk);
  }

  /**
   * 新一轮开口：把判停器的音频窗口**重置到这一句**。
   *
   * 为什么要重置：官方 `BaseSmartTurn` 喂的是「这一句」——
   * `speech_start - pre_speech_ms` 到缓冲区末尾（见 turn-judge README
   * "audio from previous turns does not need to be included"）。我们原来是
   * **连续 8 s 滚动**，短句子的窗口里可能有 7 秒是上一轮的回答和中间那段静音。
   * 实测（`bench/latency/probe-turnjudge-padding.py`，同一份 `uplink.pcm`）：
   * 同一句「我问你看最近看过哪些电影？」，滚动窗口 p=0.26、按句裁 p=0.95；而
   * 句内任意切一刀（30/50/70%）滚动窗口都给 0.9 以上 —— 等于判停什么都没在判。
   *
   * @param chunks 这一句已知的前置音频（能量门的预卷），通常是 800 ms
   */
  resetAudio(chunks: readonly Buffer[] = []): void {
    this.recentChunks.length = 0;
    for (const c of chunks) {
      this.recentChunks.push(Buffer.from(c));
    }
    this.recentBytes = this.recentChunks.reduce((n, c) => n + c.length, 0);
    this.trimRecent();
  }

  private trimRecent(): void {
    while (this.recentBytes > this.options.recentMaxBytes && this.recentChunks.length > 1) {
      const dropped = this.recentChunks.shift();
      this.recentBytes -= dropped?.length ?? 0;
    }
  }

  /**
   * 送给判停器的音频快照：拼接 + 裁掉尾巴上多余的静音。
   *
   * 两处判停（提前预跑、定稿现算）都必须走这里，否则同一句话会因为"从哪个入口问"
   * 拿到两个不同的 p。
   */
  private snapshot(): Buffer {
    const pcm = Buffer.concat(this.recentChunks);
    // 裁静音的门限要**比开门门槛低一截**：开门门槛（`silenceDb`，默认 −40）问的是
    // 「有没有人说话」，而这台设备的语音峰值本身就在 −32…−40；拿它当静音判据会把
    // 最后几个音节一起裁掉。−20 dB 的偏移对应噪声峰（实测 −69）与语音峰之间。
    const floor = this.options.silenceDb === undefined
      ? undefined
      : this.options.silenceDb - (this.options.silenceFloorOffsetDb ?? 20);
    return pcm16TrimTrailingSilence(pcm, floor, this.options.trailingTrimMs ?? 0);
  }

  /**
   * 现在的快照会有多少字节**（不真的拼出来）。
   *
   * 只用来判「和上次判定相比输入变了没有」—— 静音期间裁掉尾巴之后长度不变，
   * 说明这一段音频一个字都没多，重算必然得到同一个 p。
   */
  private snapshotBytes(): number {
    const pcm = Buffer.concat(this.recentChunks);
    const floor = this.options.silenceDb === undefined
      ? undefined
      : this.options.silenceDb - (this.options.silenceFloorOffsetDb ?? 20);
    return pcm16TrimTrailingSilence(pcm, floor, this.options.trailingTrimMs ?? 0).length;
  }

  /**
   * 这次决定用哪个阈值。
   *
   * 中文单独一档：官方 benchmark 上中文是最差的一档（85.8%，漏报 9.26% / 误报
   * 4.95%），也就是**它偏向说「没说完」**；同一份音频上实测完整短句给 0.22–0.41、
   * 真正没说完的给 0.007–0.11，所以中文这条线该比英文低。
   * 用文本里有没有 CJK 判，不用另做语言识别 —— 决定时手上就有这句话。
   */
  private thresholdFor(): number {
    const cjk = this.options.thresholdCjk;
    return cjk === undefined || !CJK.test(this.pendingText) ? this.options.threshold : cjk;
  }

  /**
   * 本地静音检测 → 把判停**提前**跑掉。
   *
   * ASR 要等 200 ms 静音才发 `SentenceEnd`，但判停器看的是音频 —— 那 200 ms 里
   * 音频早就够了。所以「有声之后静下来 `silencePauseMs`」就先跑一次，
   * `SentenceEnd` 到达时直接取用（`takeProbability` 的缓存）。
   *
   * 两条防呆：
   * - 又来声音就把这份预跑作废（音频变了，那份快照里没有后半句）；
   * - 一段语音只预跑一次，长时间静音不会反复烧判停器。
   */
  private trackSilence(chunk: Buffer): void {
    const floor = this.options.silenceDb;
    if (floor === undefined) {
      return;
    }
    const t = this.now();
    if (pcm16PeakDbfs(chunk) > floor) {
      // **去抖**：这段录音里 20 ms 的「有声」帧有 14 处，很多是塞音的闭塞段
      // 或门限抖动，不是真的重新开口。单帧就把 `lastVoicedAt` 推平会让
      // 「截至此刻的静音」被反复归零（开轮条件永远不成立），预跑也被无谓作废。
      // 所以第一帧只计数，从**第二帧**起才更新 —— 之后每帧都推进，`lastVoicedAt`
      // 仍然等于「真实停嘴」那一刻（不能停在首帧，否则一句话说两秒就被算成两秒静音）。
      this.voicedRun += 1;
      if (this.voicedRun < 2) {
        return;
      }
      this.lastVoicedAt = t;
      // 音频比快照长了：预跑的那份判停不再代表「用户说完没有」
      this.prediction = null;
      return;
    }
    this.voicedRun = 0;
    // 两条线拆开跑，阈值不同：
    //   投机 100 ms —— 拿中间结果先问出去，等久了纯属白等
    //   判停 200 ms —— 判停器看的是音频，跟 ASR 的静音窗对齐
    this.maybeSpeculate(t);
    this.maybePrefirePrediction(t);
    this.maybeCommit(t);
  }

  /**
   * 静音满 `commitAfterMs` 就让 ASR 封段（端点由我们控时才有这一步）。
   *
   * 为什么不等判停：判停要 200 ms 静音才有把握，而封段只要「这句停下来了」——
   * 封早了顶多多一段碎片（并段逻辑照拼），封晚了整段延迟都是白等。
   * 解码那 ~260 ms 与判停那一拍是**并行**的，谁慢谁说话。
   *
   * 一段语音只封一次（`commitFiredAt`），长时间静音不会反复 commit ——
   * 空缓冲的 commit 会被服务端回 `maybe no invalid audio stream`。
   */
  private maybeCommit(t: number): void {
    const after = this.options.commitAfterMs ?? 0;
    if (after <= 0 || this.options.onCommit === undefined) {
      return;
    }
    if (this.lastVoicedAt === Number.NEGATIVE_INFINITY || this.lastVoicedAt <= this.lastUtteranceAt) {
      return;
    }
    if (this.lastVoicedAt <= this.commitFiredAt) {
      return;
    }
    if (t - this.lastVoicedAt < after) {
      return;
    }
    this.commitFiredAt = t;
    // `after` 是**配置值**，实际静音是 `t - lastVoicedAt` —— 两者之差就是「静音开始
    // 到真有音频帧到达」的等待。日志和档案都要记实际值，否则永远看不见那截开销。
    const silenceMs = t - this.lastVoicedAt;
    this.options.log(
      `  封段    静音 ${after} ms（实际 ${silenceMs.toFixed(0)} ms）→ ASR 开始解码`,
    );
    this.options.onCommit(silenceMs);
  }

  /**
   * 静音满 `speculateMs` 就把手上这版中间结果先问出去（投机）。
   *
   * 和判停预跑分开是因为**两者的等待理由完全不同**：判停要等够音频才敢判「说完了」，
   * 投机只是猜，猜早了作废就是，猜晚了一无所得。
   *
   * 防呆（每一条都对应一次真机踩坑）：
   * - **这一版 partial 必须属于本段语音**（`lastPartialAt > lastUtteranceAt`）。
   *   `lastPartialText` 不会跟着语音结束自动清空，上一段最后那版「嗯」能一直留到
   *   下一段开口 —— 拿它去投机就是拿别人那句话猜这一句。
   * - **接收方说发出去了才算一次**（`onPartial` 的返回值）。门槛（`specMinChars`、
   *   候选判据）都在接收方，这边记账早一步就会把机会记成「已用」。
   * - 发出去了就不再问（`lastVoicedAt <= specFiredAt`）：静音之后 ASR 还会补一两版
   *   partial，让它们重投机等于把已经跑掉的时间作废重来（实测认领时只跑了 6 ms）。
   * - 一句最多 2 次（`specCount`，`addSentence` 归零）—— 覆盖「说-停-说」的多段。
   */
  private maybeSpeculate(t: number): void {
    if (this.options.onPartial === undefined) {
      return;
    }
    const pause = this.options.speculateMs ?? 100;
    if (pause <= 0) {
      return;
    }
    if (this.lastVoicedAt === Number.NEGATIVE_INFINITY || this.lastVoicedAt <= this.lastUtteranceAt) {
      return;
    }
    if (t - this.lastVoicedAt < pause) {
      return;
    }
    // 这段语音已经投机过了：后来补的 partial 不再顶掉在跑的那一趟
    if (this.lastVoicedAt <= this.specFiredAt) {
      return;
    }
    if (this.specCount >= 2) {
      return;
    }
    // 本段语音还没吐过字：`lastPartialText` 是上一段的残留，不能用
    if (this.lastPartialAt <= this.lastUtteranceAt) {
      return;
    }
    const latest = this.lastPartialText;
    if (latest === '') {
      return;
    }
    const text = this.pendingText + latest;
    // 同一版 partial 问过一次就够了：静音帧是每 20 ms 一个，不去重会刷成一片
    if (text === this.specTriedText) {
      return;
    }
    if (!this.options.onPartial(text)) {
      this.specTriedText = text;
      return;
    }
    this.specTriedText = '';
    this.specFiredAt = t;
    this.specCount += 1;
    this.options.log(
      `  投机    静音 ${pause} ms → 交出中间结果（第 ${this.specCount}/2 次，判停还等 `
        + `${this.options.silencePauseMs ?? 200} ms）`,
    );
  }

  /** 静音满 `silencePauseMs` 就先把判停算掉，定稿时直接取用。 */
  private maybePrefirePrediction(t: number): void {
    if (this.options.predict === undefined || this.prediction !== null) {
      return;
    }
    const pause = this.options.silencePauseMs ?? 200;
    // 只在「这一轮说过话、且还没为这段语音预跑过」时动手
    if (this.lastVoicedAt <= this.preFiredAt || this.lastVoicedAt <= this.lastUtteranceAt) {
      return;
    }
    if (t - this.lastVoicedAt < pause) {
      return;
    }
    this.preFiredAt = t;
    this.options.log(`  判停    静音 ${pause} ms → 先跑一遍（不等 ASR 定稿）`);
    // 下一句定稿时会拿到 `seq + 1`，见 `addSentence`
    this.startPrediction(this.seq + 1, true);
  }

  /**
   * ASR 中间结果到了 —— 用户还在说话。
   *
   * 这**不是**用来拼文本的（中间结果会反复改写，拼起来是乱的）。它有两个用途：
   * 「还在出字」的信号（打断播放），以及给快车道**投机**攒素材
   * （真正起跑在静音那一刻，见 `trackSilence`）。
   */
  notePartial(text: string): void {
    this.lastPartialAt = this.now();
    this.lastPartialText = text;
    // 语义判停要藏在静候窗里，就不能等到定稿才发请求：真服务实测 p50 250–310 ms
    // （qwen-flash，见 docs/EOT-SUPPLEMENT.md §11.5），而「定稿→开轮」只有
    // 200–300 ms。中间结果在**说话期间**就到了，从这一刻发才来得及。
    this.askSemanticsDuringSpeech(text);
  }

  /** 一句定稿的识别结果。 */
  addSentence(text: string): void {
    if (this.disposed) {
      return;
    }
    // **一次发声被提交两次**：真机 20261122-232814 的 66.8 s / 67.2 s 两条定稿有道区间同为
    // 2.70 s（「那你给我讲讲…剧情。」+「Okay.」），90.2 s / 90.8 s 同为 0.56 s（「你。」+「滚吧。」）。
    // 前一条是长句时，紧随的小残片是同一段音频的第二次识别 —— 留着会被并进真问题或自己开一轮。
    // 判据里必须有「两条之间没有新的有声帧」：否则「前半句 + 短后半句」的正常并段会被误杀。
    if (this.isJunkAfterLongSentence(text)) {
      this.options.log(`  定稿    ✗ 丢弃残片 ${JSON.stringify(text)}（上一段 ${this.lastSentenceChars} 字，同一段音频）`);
      return;
    }
    // 上一截的结尾像「还有下文」（数字/井号/连词）时，那个句号是 ASR 误切出来的
    // 句尾 —— 留着会把订单号拦腰切开（「W866。5881」），模型读起来是两个 token。
    // 判据是**纯文本**的，不依赖这一轮为什么合并（`unfinishedWaitMs` 已删）：
    // 静音闸门、「没说完」、短碎片三条合并路径都走这里。
    const tail = this.pendingText && looksUnfinished(this.pendingText)
      ? stripTail(this.pendingText)
      : this.pendingText;
    this.pendingText = tail ? tail + text : text;
    this.cancelTimer();
    // 新的一句：上一句的判定（不管算完没算完）都不能再用来定稿。
    // **例外**是预跑（`trackSilence`）：那份快照本来就是给这一句的（seq 已经对上），
    // 留着才能把「出句→开轮」那一段省掉。
    this.seq += 1;
    if (this.prediction !== null && this.prediction.seq !== this.seq) {
      this.prediction = null;
    }
    const seq = this.seq;
    // 新的一句：投机的次数配额按句重置（下一段语音可以再投机两次）
    this.specCount = 0;
    this.specTriedText = '';
    // 中间结果属于上一段语音，不能留给下一段当素材（见 `maybeSpeculate` 的 `lastPartialAt` 判据）
    this.lastPartialText = '';
    // 句子定稿 = 文本这一刻已经定了，判停只决定「要不要并下一段」。
    // 先把它交出去起跑，真并了下一段再换 —— 见 `VoiceSession` 的接线。
    this.lastSentenceAt = this.now();
    this.lastSentenceChars = [...this.pendingText].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
    this.options.onSentence?.(this.pendingText);
    // 语义判停**立刻**发出去：它是一次网络往返（150–300 ms），现在发就跟下面这个
    // 静候窗重叠；等判定那一刻再发就变成纯加延迟了。
    // 前缀已经判过就不用再问：
    // - MORE：延长后的文字问回来时，开轮早该发生了；
    // - END：定稿不过是那个前缀的收尾（多一两个标点/收尾字），再问一趟是纯成本
    //   （真机 `20261123-051448` 第 6/8/9 轮各对同一句话发了两趟）。
    if (!this.hasPrefixMore(this.pendingText) && !this.hasPrefixEnd(this.pendingText)) {
      void this.askSemantics(this.pendingText);
    }
    const delay = this.options.predict
      ? this.options.quietMs
      : this.options.fallbackWindowMs;
    this.schedulePrediction(seq, delay);
    this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, delay);
  }

  /**
   * 提前把判停请求发出去（与静候窗重叠）。
   *
   * 只在 `predictAtMs` 设了的时候才有这一步；窗口比提前量还短时按窗口到点算，
   * 那就等于旧行为（不重叠），不发也是对的。
   */
  private schedulePrediction(seq: number, windowMs: number): void {
    const at = this.options.predictAtMs;
    if (at === undefined || this.options.predict === undefined) {
      return;
    }
    this.cancelPredictTimer();
    const lead = Math.max(0, Math.min(at, windowMs));
    this.predictTimer = setTimeout(() => {
      this.predictTimer = null;
      this.startPrediction(seq);
    }, lead);
  }

  /** 取一份音频快照送进判停器。结果只对 `seq` 这一句、且之后没有新 partial 时有效。 */
  private startPrediction(seq: number, upcoming = false): void {
    const predict = this.options.predict;
    if (this.disposed || predict === undefined || this.prediction !== null) {
      return;
    }
    // `upcoming`：这句还没定稿（ASR 的 `SentenceEnd` 还在路上），快照给的是下一句
    if (!upcoming && seq !== this.seq) {
      return;
    }
    const pcm = this.snapshot();
    const startedAt = this.now();
    // 侧车可能抛（也可能同步抛）；两种都吞成「不可用」，否则这份提前发起的
    // promise 没人接，会变成 unhandledRejection
    const probability = Promise.resolve().then(() => predict(pcm)).catch(() => -1);
    this.prediction = { seq, startedAt, pre: upcoming, probability, bytes: pcm.length };
  }

  /**
   * 取这一句的判停概率。
   *
   * 优先用手上已经算好的那份；算好之后用户又开了口（`lastPartialAt` 晚于取快照的
   * 时刻）就作废、现算一次 —— 那份音频里还没有他后半句，拿它定稿就是抢话。
   * 现算的代价是那一趟往返，但只在「用户真的又说话了」时发生，和旧行为持平。
   */
  private async takeProbability(
    seq: number,
    predict: (pcm: Buffer) => Promise<number>,
  ): Promise<number> {
    const ready = this.prediction;
    this.prediction = null;
    const hit = ready !== null && ready.seq === seq
      && (ready.pre || ready.startedAt >= this.lastPartialAt);
    if (hit) {
      // 记下这份判停用的是哪一段音频 —— 下一拍拿它比「输入有没有变」（见 `snapshotBytes`）
      this.lastSnapshotBytes = ready.bytes;
      return await ready.probability;
    }
    const pcm = this.snapshot();
    this.lastSnapshotBytes = pcm.length;
    try {
      return await predict(pcm);
    } catch {
      return -1;
    }
  }

  /** 立即定稿（连接结束时兜底，避免最后一句被丢弃）。 */
  flush(): void {
    if (this.disposed) {
      return;
    }
    this.cancelTimer();
    this.cancelPredictTimer();
    this.seq += 1;
    this.prediction = null;
    this.extensions = 0;
    this.unsureExtensions = 0;
    this.waitedMs = 0;
    const text = this.pendingText.trim();
    this.pendingText = '';
    if (!text) {
      return;
    }
    this.lastUtteranceAt = this.now();
    this.options.onUtterance(text);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.cancelPredictTimer();
    this.seq += 1;
    this.prediction = null;
    this.pendingText = '';
    this.recentChunks.length = 0;
    this.recentBytes = 0;
  }

  /** 判定当前这一轮是否定稿。 */
  private async evaluate(seq: number): Promise<void> {
    this.pendingTimer = null;
    if (this.disposed || seq !== this.seq || !this.pendingText.trim()) {
      return;
    }

    const predict = this.options.predict;
    if (!predict) {
      this.flush();
      return;
    }

    // 判停**发起**的时刻（`lastDecisionAt` 用它判断「两次决定之间文本有没有变」）。
    // 取发起而不是推理跑完那一刻 —— 快车道预跑让两者差一整个往返。
    const evaluatedAt = this.now();
    const probability = await this.takeProbability(seq, predict);
    const shown = probability < 0 ? '故障' : probability.toFixed(3);

    // 等待期间用户又说了新的一句：那一轮已经重新排好，这里什么都不做
    if (this.disposed || seq !== this.seq) {
      return;
    }

    if (probability < 0) {
      // 判停器出问题就退回保守策略：宁可多合成一轮，也别把用户的话吞掉
      this.options.log(`  判停    ${shown} → 判停器不可用，直接结束本轮`);
      this.reportJudge({ p: probability, waitMs: 0, action: 'error' });
      if (await this.semanticAllowsFlush(seq, probability)) {
        this.flush();
      }
      return;
    }

    // 开轮的**静音门槛**：定稿到达时，「截至此刻」的连续静音够不够。
    //
    // 和 p 不重复：p 回答「这段听起来完整吗」——「对吗？」单看确实完整，0.661
    // 没判错；能区分「换气」和「句尾」的信息只有**后面又出声了**，也就是
    // 「截至此刻的连续静音」被重置。
    //
    // 定稿通常已经晚于停嘴 `commit→定稿`（实测中位 261 ms），所以这条在多数轮次
    // 上不花时间；只在用户确实又开口时才等 —— 那本来就不该开轮。
    // 必须放在下面那条「音频和文本都没变就不再等」**之前**，否则静音窗会被那条
    // 捷径绕过去（它只看 p 和快照字节数，不知道用户又说话了）。
    // `thresholdFor()` 只依赖 `pendingText`，提前算就能让下面那条统一上限先执行
    const threshold = this.thresholdFor();

    // **统一上限**：静音到顶就放行，任何分支都不许再加拍。
    // 放在所有分支之前 —— 它就是那条"谁都不能绕过"的闸。
    const openSilenceCap = this.options.maxOpenSilenceMs ?? 0;
    if (openSilenceCap > 0) {
      const quietNow = this.now() - this.lastVoicedAt;
      if (quietNow >= openSilenceCap) {
        this.options.log(
          `  判停    ${shown} → 静音 ${Math.round(quietNow)} ms ≥ 上限 ${openSilenceCap}，放行`,
        );
        this.reportJudge({
          p: probability, waitMs: 0, action: 'accept', whyAccept: 'cap',
          threshold, silenceMs: Math.round(quietNow),
        });
        this.flush();
        return;
      }
    }

    const openQuiet = this.openQuietFor(probability);
    // 静音闸门也要受统一预算约束 —— 它原来是唯一一条能绕过 `overBudget()` 的路径
    // （`return` 在预算判断之前），实测把 ② 顶到 2264 ms。
    if (openQuiet > 0 && this.extensions < this.maxExtensionsNow() && !this.overBudget()) {
      // 必须取**此刻**：`evaluatedAt` 是 `await takeProbability` 之前拍的，
      // 判停那趟往返（70–200 ms）里 `lastVoicedAt` 可能已经前移 —— 用旧值会算出
      // 负的静音（实测日志里出现过「静音才 −55 ms」），门槛等于失效。
      const quietAt = this.now();
      const quietNow = quietAt - this.lastVoicedAt;
      if (quietNow < openQuiet) {
        const wait = Math.max(1, Math.min(openQuiet - quietNow, this.options.extendMs));
        this.extensions += 1;
        this.waitedMs += wait;
        this.options.log(
          `  判停    ${shown} → 静音才 ${Math.round(quietNow)} ms（门槛 ${openQuiet}），`
            + `还有下文，再等 ${Math.round(wait)} ms`,
        );
        this.reportJudge({
          p: probability, waitMs: wait, action: 'extend', why: 'silence',
          silenceMs: Math.round(quietNow),
        });
        this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, wait);
        return;
      }
      this.options.log(
        `  判停    ${shown} → 静音 ${Math.round(quietNow)} ms ≥ 门槛 ${openQuiet}，放行`,
      );
    }

    // 「再等一拍」只有在**等到的东西变了**时才有意义。
    //
    // 静音期间快照会被裁掉尾巴，所以字节数不变 = 输入一模一样 = 同一个 p（同一个
    // 模型、同一份特征）。真机上见过 `0.412 → 0.280 → 0.280`：最后那个 0.280 是
    // 拿同一段音频重算的，白等 400 ms；连等两拍就是 800 ms 纯损失。
    // 文本变了（来了新 partial）也算新信息 —— 但新信息**不能**再重开一拍（grace 已删），
    // 只用来证明「这次输入确实不一样」，所以它出现在下面 `unchanged` 的条件里。
    // 没有音频（`lastSnapshotBytes <= 0`）时这个判据不成立：那时判停器本来就在
    // 报「不可用」，没有「输入没变」可言。
    const unchanged = this.lastSnapshotBytes > 0
      && this.snapshotBytes() === this.lastSnapshotBytes
      && this.lastPartialAt <= this.lastDecisionAt;
    this.lastDecisionAt = evaluatedAt;
    if (probability < threshold && unchanged && this.extensions > 0) {
      this.options.log(`  判停    ${shown} → 音频和文本都没变，不再等（阈值 ${threshold}）`);
      this.reportJudge({ p: probability, waitMs: 0, action: 'accept', threshold });
      if (await this.semanticAllowsFlush(seq, probability)) {
        this.flush();
      }
      return;
    }

    // **grace 已删除**（2026-11-18）。它原来的用意是「刚收到一条新 partial，说明还有
    // 下文」，但真机 2 场 87 次 extend 里它命中 **0/8**，白等 3200 ms —— 全部是白等。
    // 判停不确定时只做一次有上限的等待，不再为中间结果重开一拍。
    if (
      probability >= threshold
      || this.extensions >= this.maxExtensionsNow()
      // QoS：总预算用完了就收下，不管还剩多少分支额度
      || this.overBudget()
      // 「判停说没说完」有自己的上限：侧车给的 p 是噪声，不能让它把总预算
      // （2.8 s）吃干净，也不能让它拖累静音闸门和短碎片的额度
      || this.unsureExtensions >= this.maxUnsureNow()
    ) {
      // 短碎片这条**也受预算和拍数约束**：原来它在这个块里先 extend 再 return，
      // 而进入这个块的理由就可能是「预算用完了」或「拍数用满了」—— 等于自己
      // 给自己开后门（真机 short 那 1 次 extend 是白等 400 ms）。
      if (
        this.extensions < this.maxExtensionsNow()
        && !this.overBudget()
        && this.shouldWaitForMore(this.pendingText)
      ) {
        this.extensions += 1;
        const wait = Math.min(this.options.extendMs, this.options.shortFragmentWaitMs ?? 400);
        this.waitedMs += wait;
        this.options.log(
          `  判停    ${shown} → 太短且紧跟前一轮，再等 ${wait} ms`,
        );
        this.reportJudge({ p: probability, waitMs: wait, action: 'extend', why: 'short' });
        this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, wait);
        return;
      }

      // **unfinished 已删除**（2026-11-18）。它靠一条文本正则（数字串/井号/连词）
      // 再等一拍，真机 3 次命中 **0/3**、白等 750 ms；更要紧的是它给
      // `maxExtensionsNow()` 开了 12 倍豁免，一个正则压过所有数值限额
      // （实测一场里 `#13` 打 10 拍、`#16` 打 8 拍）。序列形态该多等，
      // 由 `waitBudgetSequenceMs` 给**更大的预算**，不再给更多拍数。
      this.options.log(`  判停    ${shown} → 收下这一轮（阈值 ${threshold}）`);
      this.reportJudge({ p: probability, waitMs: 0, action: 'accept', threshold });
      if (await this.semanticAllowsFlush(seq, probability)) {
        this.flush();
      }
      return;
    }

    this.extensions += 1;
    this.unsureExtensions += 1;
    this.waitedMs += this.options.extendMs;
    this.options.log(
      `  判停    ${shown} → 没说完，再等 ${this.options.extendMs} ms（阈值 ${threshold}）`,
    );
    this.reportJudge({
      p: probability, waitMs: this.options.extendMs, action: 'extend', why: 'unsure', threshold,
    });
    this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, this.options.extendMs);
  }

  /**
   * 说话期间就从中间结果发一次判定。
   *
   * 这是「零额外延迟」的全部秘密：真服务实测 p50 250–310 ms，而「定稿→开轮」只有
   * 200–300 ms —— 等定稿再问，答案永远晚一拍。中间结果在用户还说着的时候就到了。
   *
   * 只在**够长**且**变了够多**时才问（中间结果会连续改写，逐字问等于打服务）：
   * 至少 8 个字、比上一次多/少 4 个字以上。
   */
  private askSemanticsDuringSpeech(text: string): void {
    if (this.options.semanticEndpoint === undefined) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length < 8 || trimmed === this.semanticLastAsked) {
      return;
    }
    if (
      this.semanticLastAsked !== ''
      && Math.abs(trimmed.length - this.semanticLastAsked.length) < 4
    ) {
      return;
    }
    this.semanticLastAsked = trimmed;
    void this.askSemantics(trimmed);
  }

  /** 把某段文字的判定请求发出去（同一段文字只问一次；失败一律回 `null`）。 */
  private askSemantics(text: string): Promise<'end' | 'more' | null> {
    const endpoint = this.options.semanticEndpoint;
    if (endpoint === undefined || text.trim() === '') {
      return Promise.resolve(null);
    }
    const cached = this.semanticAsks.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const promise = endpoint(text).catch((): null => null).then((verdict) => {
      this.semanticSettled.set(text, verdict);
      return verdict;
    });
    this.semanticAsks.set(text, promise);
    // 只留最近 8 条：中间结果会连续改写，这里不是历史账本
    if (this.semanticAsks.size > 8) {
      const oldest = this.semanticAsks.keys().next().value;
      if (oldest !== undefined) {
        this.semanticAsks.delete(oldest);
      }
    }
    return promise;
  }

  /**
   * 「要不要开轮」的最后一道文本闸：语义判停说还有下文时再等一拍。
   *
   * 三条硬边界：
   * - **只延长一次**（同一段文字）。多次延长等于把判停交给另一层，收益全是延迟。
   * - 吃的是**既有的**拍数与总预算（`maxExtensionsNow()` / `overBudget()`），不新开账。
   * - 等判停本身有上限（`semanticBudgetMs`）；等不到按「说完了」放行 —— 判停这层
   *   出问题绝不能把用户的话吞掉。
   *
   * @returns 是否放行（`true` = 可以 `flush()`）
   */
  private async semanticAllowsFlush(seq: number, probability: number): Promise<boolean> {
    if (this.options.semanticEndpoint === undefined) {
      return true;
    }
    const text = this.pendingText;
    if (text.trim() === '') {
      return true;
    }
    // 说话期间/定稿时已经问过了就直接取。**前缀判定要先看**：定稿常常只是中间结果的
    // 延长，那份「还有下文」已经够用了 —— 再为延长后的文字问一趟，等回来时开轮早就
    // 该发生了（实测 p50 250–310 ms）。
    const settled = this.semanticSettled.get(text);
    let verdict: 'end' | 'more' | null | 'timeout';
    if (settled !== undefined) {
      verdict = settled;
    } else if (this.hasPrefixMore(text)) {
      verdict = 'more';
    } else if (this.hasPrefixEnd(text)) {
      // 定稿只是中间结果的收尾（多一两个标点）：前面那趟已经说「说完了」，别再问
      verdict = 'end';
    } else if (probability >= SEMANTIC_SKIP_P) {
      // 声学判据已经很有把握，**不再等**语义：真机 `20261123-051448` 里 p 到
      // 0.88–0.98 的几轮还各等了 256–324 ms，而全场语义一次没拦住 MORE —— 纯成本。
      // 只挡住「等」；说话期间已经发出去的那趟请求照旧（它与 ASR 并行，不要钱），
      // 所以上面那两条「已经回来的判定」仍然优先。
      verdict = 'end';
    } else {
      verdict = await this.awaitSemantics(text);
    }
    if (this.disposed || seq !== this.seq) {
      // 等待期间又来了新的一句：那一轮已经重新排好，放行交给它（`flush` 自带
      // 空文本保护，不会把新的一句误封出去）
      return true;
    }
    if (verdict !== 'more') {
      if (verdict === 'timeout') {
        const budget = this.options.semanticBudgetMs ?? 300;
        this.options.log(`  判停    语义判停 ${budget} ms 没回话，按「说完了」放行`);
      }
      return true;
    }
    if (this.semanticExtended === text) {
      return true;
    }
    if (this.extensions >= this.maxExtensionsNow() || this.overBudget()) {
      this.options.log('  判停    语义=还有下文，但拍数/预算已经用完，放行');
      return true;
    }
    const wait = Math.min(this.options.extendMs, this.options.shortFragmentWaitMs ?? 400);
    this.semanticExtended = text;
    this.extensions += 1;
    this.waitedMs += wait;
    this.options.log(
      `  判停    语义=还有下文（${JSON.stringify(text.slice(0, 24))}），再等 ${wait} ms`,
    );
    this.reportJudge({ p: probability, waitMs: wait, action: 'extend', why: 'meaning' });
    this.cancelTimer();
    this.pendingTimer = setTimeout(() => { void this.evaluate(seq); }, wait);
    return false;
  }

  /** 取这段文字的判定；没问过就现问，最多等 `semanticBudgetMs`。 */
  private async awaitSemantics(text: string): Promise<'end' | 'more' | null | 'timeout'> {
    const ask = this.semanticAsks.get(text) ?? this.askSemantics(text);
    const budget = this.options.semanticBudgetMs ?? 300;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
    });
    const verdict = await Promise.race([ask, timedOut]).finally(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
    return verdict;
  }

  /** 有没有哪份**前缀**判定说了「还有下文」（定稿往往只是中间结果的延长）。 */
  private hasPrefixMore(text: string): boolean {
    for (const [asked, verdict] of this.semanticSettled) {
      if (verdict !== 'more' || asked === text || !text.startsWith(asked)) {
        continue;
      }
      if (text.length - asked.length <= SEMANTIC_PREFIX_SLACK_CHARS) {
        return true;
      }
    }
    return false;
  }

  /**
   * 这条定稿的**前缀**已经被判成「说完了」了吗。
   *
   * 为什么需要：说话期间从中间结果问过的那一版（`askSemanticsDuringSpeech`），
   * 和定稿之间通常只差一两个标点/收尾字。没有这条复用，定稿时会对「同一句话」
   * 再发一次请求 —— 真机 `20261123-051448` 第 6/8/9 轮各发了两趟
   * （`…《基础之森` 319 ms 和 `…《基础之森》吗？` 398 ms），第二趟等回来的
   * 时候开轮早该发生了。只复用「延长 ≤ 6 字」的前缀，再长就是另一句话了。
   */
  private hasPrefixEnd(text: string): boolean {
    for (const [asked, verdict] of this.semanticSettled) {
      if (verdict !== 'end' || asked === text || !text.startsWith(asked)) {
        continue;
      }
      if (text.length - asked.length <= SEMANTIC_PREFIX_SLACK_CHARS) {
        return true;
      }
    }
    return false;
  }
  /** 判停决定落档（见 {@link UtteranceAssemblerOptions.onJudge}）。没有出口就算了 */
  /**
   * 这条定稿是不是「上一段长句的第二次识别」。
   *
   * 四条同时成立才丢：上一段是真句子（≥6 汉字）、上一段还在等（`pendingText` 非空）、
   * 时间挨着（<800 ms）、这一条是残片（≤2 汉字或纯 ASCII 词如「Okay.」）。
   *
   * 还有一条是「**两条之间没有新的有声帧**」（`lastVoicedAt <= lastSentenceAt`）——
   * 没有它，「前半句 + 短后半句」这种正常并段会被一起吃掉（判停那批用例就是）。
   */
  private isJunkAfterLongSentence(text: string): boolean {
    const t = text.trim();
    const cjk = [...t].filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
    const junk = cjk <= 2 || /^[A-Za-z][A-Za-z './-]*\.?$/.test(t);
    return junk
      && this.pendingText.trim() !== ''
      && this.lastSentenceChars >= 6
      && this.now() - this.lastSentenceAt < 800
      // lastVoicedAt > 0 = 这一轮真的见过有声帧。纯合成输入（没有音频证据）时不去抖：
      // 宁可多并一次，也不要把用户真的说出来的短句丢掉。
      && this.lastVoicedAt > 0
      && this.lastVoicedAt <= this.lastSentenceAt;
  }
  private reportJudge(fact: JudgeFact): void {
    // 落档时补上「这一轮花掉多少 / 预算是多少」：`②` 的成因只有 p 是看不出来的，
    // 有这两个数才能事后算「预算用超了没」「序列豁免生效没」。
    this.options.onJudge?.({ ...fact, waitedMs: this.waitedMs, budgetMs: this.waitBudget() });
  }

  /**
   * 这一小段是不是「一句话被切开的前半截」，值得再等一拍。
   *
   * 真机（2026-11-15）：用户问「…你是怎么答的？」，ASR 切成两句 ——
   * 「…你你是怎么点？」+「大的。」。TurnJudge 对「大的。」给了 0.985：
   * 它只看这两秒音频，「大的。」确实像个完整回答，判得不冤。于是碎片单独成轮，
   * agent 只能瞎猜，用户只好把整段话重说一遍。
   *
   * 判据刻意保持**纯机械**（和 `backchannel.ts` 同一条原则：不做语义推断）：
   * 去标点后不超过 {@link UtteranceAssemblerOptions.shortFragmentChars} 字，
   * 且距上一轮被收下不超过 {@link UtteranceAssemblerOptions.shortFragmentWindowMs}。
   * 两条件都成立才多等一次 —— 用户真的只是说了个「好。」而停顿更久时不会中招。
   */
  private openQuietFor(probability: number): number {
    const long = this.options.openQuietMs ?? 0;
    if (long <= 0) {
      return 0;
    }
    const short = this.options.openQuietShortMs;
    if (short === undefined || short <= 0) {
      return long;
    }
    return probability >= (this.options.openQuietHighP ?? 0.8) ? short : long;
  }

  /**
   * 这一轮当前的等待预算（ms）。0 = 不设预算。
   *
   * 两个旋钮分工不同：`waitBudgetSequenceMs` 是**多给**（序列没说完，p 判得对），
   * `waitBudgetMs` 是**兜底上限**（其余情况的 `②` 硬顶）。序列判据优先。
   */
  private waitBudget(): number {
    const sequence = this.options.waitBudgetSequenceMs ?? 0;
    if (sequence > 0 && looksUnfinished(this.pendingText)) {
      return sequence;
    }
    return this.options.waitBudgetMs ?? 0;
  }

  /**
   * 这一轮的扩展次数上限。
   *
   * **不再有「序列形态给 12 倍」的豁免**（2026-11-18 删除）：一条文本正则不该压过
   * 数值限额 —— 实测一场里它让 `#13` 打 10 拍、`#16` 打 8 拍。序列该多等，
   * 由 `waitBudgetSequenceMs` 给更大的**预算**，不再给更多拍数。
   */
  private maxExtensionsNow(): number {
    return this.options.maxExtensions;
  }

  /** 预算已经用完了吗（用完了就收下，不再等） */
  private overBudget(): boolean {
    const budget = this.waitBudget();
    return budget > 0 && this.waitedMs >= budget;
  }

  /** 「p 判没说完」这条分支的上限（序列形态不给额外豁免，理由见 `maxExtensionsNow`） */
  private maxUnsureNow(): number {
    return this.options.maxUnsureExtensions ?? this.options.maxExtensions;
  }

  private shouldWaitForMore(text: string): boolean {
    // 已经为这一轮延过一次就不再拖：宁可早点收，也别让用户等出失聪
    if (this.extensions > 0) return false;
    const extendMs = this.options.extendMs;
    if (extendMs <= 0) return false;

    const core = text.replace(/[\s。.,，!！?？、~～…\-—]/g, '');
    const limit = this.options.shortFragmentChars ?? 3;
    if (core.length === 0 || core.length > limit) return false;

    const window = this.options.shortFragmentWindowMs ?? 1_200;
    return this.now() - this.lastUtteranceAt <= window;
  }

  private cancelTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private cancelPredictTimer(): void {
    if (this.predictTimer) {
      clearTimeout(this.predictTimer);
      this.predictTimer = null;
    }
  }

  /** 便于日志：最近音频的时长 */
  get recentDurationMs(): number {
    return pcm16DurationMs(this.recentBytes, 16_000);
  }

  /** 便于测试：当前时间戳 */
  get timestampMs(): number {
    return this.now();
  }
}
