/**
 * 三个可替换件的契约：**STT / TTS / Agent**。
 *
 * 为什么单独一个文件：别人得能换掉其中任意一个而不动编排代码。这里只放**接口**，
 * 不 import 任何具体实现的 SDK —— 具体实现在 `aliyun-asr.ts` / `mimo.ts` / `agent.ts` 里。
 *
 * 三者的边界：
 * - STT：PCM16 **16 kHz 单声道** → 文本（流式，边喂边出中间结果）
 * - TTS：文本 → PCM16 **采样率由 provider 自己声明**（上行 16k / 下行 24k 不相等，
 *   这个坑踩过：混用会 1.5 倍速升调）
 * - Agent：文本（+ 可选图片）→ 一句话回复
 */
import type { TurnTicket } from './dialog-fsm.ts';

/** 一轮的上下文：现在只有票据，将来要加东西就放这里，别再加位置参数。 */
export interface TurnContext {
  readonly ticket: TurnTicket;
}

/**
 * 为什么这一轮没让快车道答。
 *
 * 只用于挑回执话术（`task` 是「我看看」、`timeout` 是「嗯，我想想」这类），
 * 不参与任何决策。
 */
/**
 * 交给慢车道的原因。
 *
 * 前四个是**本地闸**（一个模型调用都没发，0 ms），后四个是快车道真跑了却没成。
 * 必须分开记：`task`（含任务词）和 `answer`（在回应 dsh 的问话）都由「本地挡住」
 * 这一步产生，但排障时的含义完全不同 —— 前者是分流判据，后者是业务状态机，
 * 混成一个值就等于没记。
 */
export type DelegateReason =
  /** 含任务词 / 数字 / 太长：`isFastCandidate` 挡掉 */
  | 'task'
  /** 上一轮 dsh 在等回话，用户这句是**回应**（抢答会把业务状态机打断） */
  | 'answer'
  /** 像长期事实，必须让 dsh 亲耳听到它才会写记忆 */
  | 'memory'
  /** 快车道自己的上下文攒满上限，强制交给 dsh 刷一次 */
  | 'overcap'
  /** 快模型自己回的 `[[DELEGATE]]` */
  | 'delegate'
  | 'timeout'
  | 'empty'
  | 'error';

/** 给 Agent 的图片附件（与 `session.ts` 的 `ImageAttachment` 同构）。 */
export interface AgentImage {
  readonly mimeType: string;
  readonly data: string;
}

/** Agent 回复。只保留编排层真正需要的字段。 */
export interface AgentReplyView {
  /** 原始文本（日志/调试用） */
  readonly text: string;
  /** 首个输出 token 的耗时（ms）。没有流式钩子时缺席 */
  readonly firstTokenMs?: number;
  /** 清洗后、准备送 TTS 的文本 */
  readonly speech: string;
  /**
   * 情绪（`happy` / `proud` / `calm` / `worried` / `sulk`）。
   *
   * agent 在回复开头写 `[开心]` 这类标签，这里给出规范化后的 key；TTS provider
   * 据此换语调。缺省按 `calm` 处理。
   */
  readonly emotion?: string;
  /**
   * 这条回复是谁给的：`fast`（快车道小模型）还是 `dsh`（慢车道 agent）。
   *
   * 必须由 agent 自己报，编排层猜不出来 —— 快车道预跑被认领的轮次 `dsh_ms` ≈ 0，
   * 而 qwen 现场回的轮次是 200–660，`dsh` 是 885–1342，**三段有重叠**
   * （真机：`还在吗？` 343 ms 是快车道，`我怎么说？` 662 ms 是 dsh）。
   */
  readonly path?: 'fast' | 'dsh';
  /**
   * 交给慢车道的原因（只有 `path === 'dsh'` 时有意义）。
   *
   * `task` = 本地判据直接挡（含任务词/数字/太长，**没有调快模型**）；
   * `delegate` = 快模型自己回的 `[[DELEGATE]]`；`timeout` / `empty` / `error` = 快车道没成。
   * 没有它，「这一轮为什么走 dsh」在日志里和「本地闸挡住」长得一模一样。
   */
  readonly delegate?: DelegateReason;
}

/**
 * Agent（LLM）。**给定一句用户话术，返回一句话回复。**
 *
 * 内置实现：`VoiceAgent`（dsh 子进程）。替换示例：任意 HTTP LLM 客户端。
 * 注意 `speech` 要和 `text` 分开 —— 前者要能被 TTS 正确读出来（去 markdown、
 * 去表情），后者保留原样用于展示和日志。
 */
export interface AgentProvider {
  readonly name: string;
  /**
   * 当前 dsh 会话 id（`null` = 还没有会话 / 不用 dsh）。
   *
   * 只用于**观测**：写进 `turn.end`，好把这一轮和
   * `~/.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd` 里的 step/tool 轨迹
   * 对上。agent 内部那几秒到底花在哪（多步推理？工具调用？），只有那份日志说得清，
   * 我们自己插桩拿不到 reasoning 和工具参数。
   */
  readonly sessionId?: string | null;
  /**
   * 逐句合成用：订阅**原始** token 增量（`null` = 摘掉）。
   *
   * 可选能力：没有它就走「等整段回来再合成」的老路。注意与 `onLive` 的区别 ——
   * 那个带 20 token 门槛、只给日志判断用。
   */
  attachLiveSink?(sink: ((text: string) => void) | null): void;
  /**
   * 可选能力：**取消在途的一轮**（宿主侧能力，走 dsh 的 `session/cancel`）。
   *
   * 传 `ticket` 时按**轮次**取消：session 层会比对当前在途轮次的代次，
   * 票据过期的取消直接丢弃 —— 否则迟到的取消会杀掉下一轮（实测踩过）。
   */
  cancelTurn?(ticket?: TurnTicket): void;
  /**
   * 可选能力：**撤回上一轮**（把已经答完的那一轮从会话历史里切掉）。
   *
   * 双向投机里取消来不及时会走到这里：dsh 那一轮已经 `completed`、`assistant/message`
   * 已经落进历史，而用户听到的是快车道的答案。不撤回的话，下一次续会话 dsh 会以为
   * 「我答过这句」，而且我们补上下文时还会给出**另一个答案**。
   *
   * 实现方式应该是「事务式」的：dsh 的会话日志是 append-only，唯一能变短的原语是
   * `session/fork`（切一段前缀长出新会话）。实现必须**自己换指针**，调用方不感知。
   */
  rollbackTurn?(ticket?: TurnTicket): void;
  /** 上一次撤回的结果（`ok` / `failed` / `none`，取一次就清）。补上下文时按它措辞。 */
  takeRollbackOutcome?(): 'ok' | 'failed' | 'none';
  /**
   * 可选能力：**判停之前先问出去**。
   *
   * 一句 ASR 定稿时文本就定了，判停器随后只决定要不要并下一段 —— 这中间那一拍
   * 是纯等待。给了这个能力，宿主会在定稿那一刻调一次；`reply()` 拿到**一字不差**
   * 的同一句话时认领结果，文本变了就丢掉重问。
   *
   * 实现必须容忍「问了却没人来认领」（用户插话、判停并段、进程退出）。
   *
   * 返回 `true` 表示**这一趟已经在跑了**（新起跑、命中已有的、或投机被确认），
   * 宿主据此决定要不要顺手预开一条 TTS task —— 那一趟的结果马上就会来。
   */
  prefetch?(text: string): boolean;
  /**
   * 可选能力：**中间结果投机**。
   *
   * 宿主在 ASR 吐中间结果时调（比定稿早 p50 731 ms）。和 `prefetch` 的区别是
   * **文本是猜的**：实现必须自己决定「认不认」，认不了就作废，不能把猜的结果当定稿播。
   *
   * 实现必须容忍「问了却没人来认领」，也不能每版中间结果都发一次请求
   * （一句话能有 5–14 版）。
   *
   * **返回「这一次到底有没有投出去」**。长度门槛、候选判据、次数配额全在实现侧，
   * 宿主靠这个返回值判断「这段语音还算不算有投机机会」—— 无条件当成功的话，
   * 一句被门槛挡掉的「嗯」会把整段语音的机会用光（真机 `20261119-071340` 三轮）。
   */
  speculatePartial?(text: string): boolean;
  /**
   * 可选能力：**硬中断**（`SIGINT` 给 dsh 子进程，等同 TUI 里 Ctrl-C）。
   *
   * 会杀掉进程，下一轮要重启并 resume（实测多花 ~2 s）。只在「这一轮肯定不要了、
   * 且短时间内不会再问」时才划算，调用方自己判断。
   */
  interruptTurn?(): void;
  /**
   * 可选能力：**后台任务状态**的一句话事实（「在跑什么 / 刚跑完什么 / 什么都没有」）。
   *
   * 数据来自 dsh 自己发的事件（`job/registered`、`job/settled`、`subagent/catalog`），
   * 不用额外发请求。给快车道用来**照实回答**「好了吗 / 查到没」，而不是瞎编进度。
   */
  taskStatus?(): string;
  /**
   * @param note 可选的**上下文注记**（例如"上一轮被打断、还剩哪句没说"）。
   *   实现方应当把它和用户话术分开，别让模型以为这是用户说的。
   * @param turn 本轮票据（`{no, gen}`）。**轮次令牌的唯一来源是 `DialogFsm`**：
   *   上游取消要靠它判断"这是不是还在跑的那一轮"。
   */
  reply(
    userText: string,
    image?: AgentImage,
    note?: string,
    turn?: TurnContext,
  ): Promise<AgentReplyView>;
  /**
   * 可选：agent 在**没有任何一轮**的情况下主动要说的内容（后台任务完成汇报）。
   *
   * 传 `null` 表示当前没有连接可播报。实现方（`VoiceAgent`）负责把原始文本
   * 清洗成可朗读的句子；编排层只管什么时候播、能不能播。
   *
   * `emotion` 是模型写在回复开头的情绪标签。以前这条口只传 `speech`，后台
   * 汇报的语气标签在这里就被截掉了 —— 模型写 `[开心]跑完了`，播出来还是平静。
   */
  setAnnouncer?(cb: ((speech: string, emotion?: string) => void) | null): void;
  /**
   * 可选能力：**这一轮交给慢车道了**，编排层可以给用户一句回执（「我看看。」）。
   *
   * 快车道判定自己答不了（本地判据否决 / 暗号 / 超时 / 空答复）时叫一次。
   * 真机上这类轮次从停嘴到出声是 1.8–2.9 s，中间一片安静，用户会以为没听见。
   *
   * 只在**这一轮还没出声**时才有意义，编排层自己看票据与在途状态决定要不要说。
   */
  setDelegateHook?(cb: ((reason: DelegateReason) => void) | null): void;
}

/** STT 会话：一次连接一个，流式喂 PCM。 */
export interface SttSession {
  /** 喂一块 PCM16 16 kHz mono。 */
  feed(pcm: Buffer): void;
  /** 「这段说完了」：请求厂商出最终结果（不必关闭连接）。 */
  hangup(): void;
  close(): void;
  /**
   * 可选能力：**端点由我们说了算**。
   *
   * 服务端 VAD 的静音窗有硬下限（NLS `max_sentence_silence` 与 DashScope
   * `silence_duration_ms` 都是 200 ms，低于它填了也不生效 —— 实测回执会原样
   * 回 100/150，但判停时刻和 200 完全重合）。关掉服务端 VAD 之后，由宿主在
   * 静音到点时调 `commit()` 封段，静音窗从此是我们自己的旋钮。
   *
   * 只有实现了这个方法的 provider 才需要宿主喂 `commit` 触发。
   */
  commit?(): void;
  /**
   * 可选能力：**下一次识别结果作废**。
   *
   * 打断时用。DashScope realtime 协议没有 `input_audio_buffer.clear`
   * （实测回 `invalid_value`），缓冲里的音频丢不掉 —— 只能照常封段，
   * 再把回来的文本扔掉。不实现这个方法就表示「作废不了，别扔」。
   */
  discard?(): void;
}

export interface SttHandlers {
  /** 中间结果（边说边出字），可选。 */
  onPartial?: (text: string) => void;
  /** 一句说完。`index` 是本次连接内的句序。 */
  onSentence: (text: string, index: number) => void;
  onError?: (error: Error) => void;
}

/** STT provider：每次连接 `open()` 一个新会话。 */
export interface SttProvider {
  readonly name: string;
  /** 期望的输入采样率，固定 16 kHz（mSBC 解码后的速率）。 */
  open(handlers: SttHandlers): SttSession;
}

/** TTS provider：文本 → PCM16 mono 流。 */
export interface TtsProvider {
  readonly name: string;
  /** 输出采样率。**必须由 provider 声明**，不要在宿主里另配一份。 */
  readonly sampleRate: number;
  /**
   * 可选能力：**预建连接**。
   *
   * TTS 是进程级单例，连接在第一次合成时才懒建（冷连接 ~590 ms vs 复用 ~350 ms，
   * 差的那 ~170 ms 是 TCP+TLS+Upgrade）。宿主在设备连上时调一次，把这笔钱挪到
   * 「用户还没开口」的空窗里。失败必须自己咽掉，下次合成会重建。
   */
  warm?(): void;
  /**
   * 可选能力：**预开一条合成 task**（`run-task` → `task-started`，先不送文本）。
   *
   * 为什么：`tts.task` 拆出来，`建立`（run-task → task-started）p50 **66 ms**，
   * 且它与合成**串行** —— `runFeed` 要等第一段文本才发 run-task，`continue-task`
   * 又要等 task-started。定稿时正文还没到，正好能把这 66 ms 吞掉。
   *
   * **和谁回答无关**：快车道和 dsh（`speculate` 双轨）都要经过同一个 TTS，所以宿主在
   * **定稿**那一刻就调一次，两条车道谁赢都由下一个 `synthesize*` 直接认领。
   * 幂等：在途、或已有一条等着被认领，再调直接返回。
   *
   * 探针实测：run-task 之后等 0.3 / 1 / 2 / 3 / 4.5 s 再送文本都正常，首包 296–318 持平。
   * **但空 task 不能 `finish-task`**（服务端回 `Please ensure input text is valid.`
   * 并让整条连接后续 task 静默挂死），所以没被认领的预开只能**弃连接**（TTL 3 s）。
   *
   * 调用方不用配对认领：下一个 `synthesize` / `synthesizeStream` 自动接管。
   */
  prewarm?(): void;
  /**
   * 边生成边合成（可选）：文本块一进来就送服务端，首包与模型生成重叠。
   * 没实现就退回 {@link synthesize} 整段合成。
   */
  synthesizeStream?(chunks: AsyncIterable<string>, emotion?: string): AsyncIterable<Buffer>;
  /**
   * @param emotion 情绪 key（见 `emotion.ts`）。provider 自己决定怎么用：MiMo 拿它
   *   拼风格提示词。不认识/不传就按默认语气合成。
   */
  synthesize(text: string, emotion?: string): AsyncIterable<Buffer>;
}

// ------------------------------------------------------------------ 调试用实现

/** 不识别任何语音：喂进来的东西直接丢掉。用于只测 TTS/播放的链路。 */
export function noopStt(): SttProvider {
  return {
    name: 'noop',
    open: () => ({ feed: () => {}, hangup: () => {}, close: () => {} }),
  };
}

/**
 * 不出声：synthesize 产出一段静音。用于只测 STT/Agent 的链路。
 *
 * `sampleRate` **必填**：默认值只能猜某个厂商的采样率，猜错了会让播放端按错的
 * 速率播放（1.5 倍速升调那个坑）。交给调用方显式声明。
 */
export function silentTts(sampleRate: number, seconds = 0.5): TtsProvider {
  return {
    name: 'silent',
    sampleRate,
    async* synthesize() {
      const bytes = Math.round(sampleRate * 2 * seconds);
      yield Buffer.alloc(bytes);
    },
  };
}

/**
 * 回显 Agent：把用户说的话原样念回去。
 *
 * 用途：不接任何 LLM 就能验「STT 出文本 → 一轮 → TTS → 下发」整条链路。
 */
export function echoAgent(): AgentProvider {
  return {
    name: 'echo',
    reply: async (userText) => ({ text: userText, speech: userText }),
  };
}

/**
 * 罐头 STT：不收真实音频，累计到 `afterBytes` 就吐一句固定话。
 *
 * 用途：不动嘴、不接厂商，也能把一轮对话跑完（配合 `silentTts` + `echoAgent`）。
 * **只用于开发/冒烟**，别拿它当默认值。
 */
export function cannedStt(
  sentence = '你好，这是一句测试。',
  afterBytes = 32 * 1024,
): SttProvider {
  return {
    name: 'canned',
    open: (handlers) => {
      let seen = 0;
      let fired = false;
      return {
        feed: (pcm) => {
          if (fired) {
            return;
          }
          seen += pcm.length;
          if (seen >= afterBytes) {
            fired = true;
            handlers.onSentence(sentence, 1);
          }
        },
        hangup: () => {},
        close: () => {},
      };
    },
  };
}
