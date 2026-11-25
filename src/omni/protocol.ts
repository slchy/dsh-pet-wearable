/**
 * 跟服务端说话的纯定义：采样率、截断、人设拼装、唯一工具。
 * 这里没有连接，也没有在途回复。
 */
import { OMNI_SHORT_INSTRUCTIONS } from '../persona.ts';

import type { ServerEvent } from './types.ts';

/** 上行格式：与 `UplinkPipeline` 一致（16 kHz / 单声道 / s16le） */
export const UPSTREAM_RATE = 16_000;
export const BYTES_PER_MILLISECOND = (UPSTREAM_RATE * 2) / 1000;
/** omni 输出固定按 24 kHz 声明（见 `session.update` 的 `audio.output.format`） */
export const DOWNSTREAM_RATE = 24_000;

export const DEFAULT_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_MODEL = 'qwen3.8-omni-flash-realtime';

/**
 * 输出必须短，而且**必须是助手人格**。
 *
 * 实测：写成「你是一个语音助手的**旁路探针**」时，挂着 tools 的模型会连着 3/3
 * 把闲聊判成工具调用（零音频）—— 措辞里的「探针」比工具描述更能决定它怎么选。
 * 所以这里就是线上助手该说的话，不做调试人格。
 */
export const DEFAULT_INSTRUCTIONS =
  // **模糊，不要精确**。原来是「只回一句话，不超过 20 个字，不要解释、不要列举、不要反问」——
  // 全是形式约束、一句都没提事实。真机 20261122-235949 里 7 轮事实题全部编造
  // （「黄仁勋」被答成「他作品多元，常探讨人性与科技」），而且 0/7 次委派：
  // 在「必须简短」的压力下，编一句 14 个字的话是成本最低的解。
  // 换成不设数字、只给态度的说法，把「拿不准就别硬猜」留成它自己的判断。
  // 后半句是 2026-11-23 05:14 加的：第 9 轮它先把「《骑猪之神》讲个普通人带猪冒险」
  // 编了 4.96 s 播出去，**然后**才调用工具转交 dsh，用户听到的是两段互不相干的回答。
  // 原来的「拿不准就交给能查的人」没挡住这种「先猜一句再转交」。
  //
  // 「回执要短、别先讲答案」**不写在这里**：§10.1 的探针结论是"写哪儿比写什么重要" ——
  // 同一句话写进 `instructions` 照样 0 ms 应声，写进工具描述才 4/4 生效。
  // 那条纪律在 `DELEGATE_TOOL.description` 里。
  // 正文**只有一份**：`persona.ts` 的 `OMNI_SHORT_INSTRUCTIONS`（快车道用同一个身份）。
  // 这里的注释是它为什么长成这样，改正文去 `persona.ts`。
  OMNI_SHORT_INSTRUCTIONS;

/** `seal()` 之后、下一次有声之前，最多留多少音频（防软起音被吞） */
export const DEFAULT_RING_MS = 150;

/** 回注进 omni 上下文的文本上限（字）。委派轮的答案动辄几百字，整段塞进去只是烧 token */
export const MAX_INJECT_CHARS = 200;
/**
 * 建连时写进 `instructions` 的长期记忆上限（字）。
 *
 * 只截这一次：热路径不再读盘。上限就是 600，截断不加省略号，
 * 否则会多出一个字。
 */
export const MAX_STATIC_MEMORY_CHARS = 600;

/** 按**字符**截断（中文一个字一个 token 量级，`String.length` 对代理对也不至于切坏） */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 静态事实：空白当没有。超长按字符截断，**不加省略号**（上限不能再多一个字）。
 */
export function boundedFact(text: string | undefined, maxChars: number): string {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') {
    return '';
  }
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

/**
 * 「先说一句、再调工具」这一句，挂在**工具描述**里而不是 `instructions` 里。
 *
 * 委派轮 dsh 要十几秒，中间必须有个人应一声；而那个声音**只能是 omni 自己**：
 * 换一条链路合成回执就是两句不同的嗓子接在一起。所以不去预录回执，
 * 直接让它在同一个 response 里先说一句、再发 `tool_call`。
 *
 * 实测（`tmp/omni-probe/tool-leadin*.mjs`，真服务 24 格）：
 * - 现状（描述里不提应声）→ `tool_call` + **0 ms 音频**，一整轮没有声音，必须靠回执补
 * - 这句写进 `instructions` → 照样 0 ms。**写哪儿比写什么重要**
 * - 这句写进工具描述 → 4/4 都先出声（1.36 / 1.84 / 1.92 / 2.32 s），再叠上面两轮 = 6/6
 * - 收得更紧（「六个字以内 + 不要说要查什么」）→ 掉到 2/4。**收紧会把应声整个压没**
 *
 * 顺序是 `function_call_arguments` 先到、`audio.delta` 后到，但两者都在同一个
 * `response.done` 里收尾 —— 所以 `claim()` 的读端照常把音频读完，读完再看
 * `delegateReason()`，两边都不缺。
 */
export const LEAD_IN_CLAUSE = '调用之前先用一句话应一声（八个字以内）。';

/**
 * 应声之后**不许先讲答案**。
 *
 * 2026-11-23 15:2x 真机第 8/9 轮：它先念了 2.2 s / 3.4 s 的正文（讲这本书、讲机器配置），
 * **然后**才调工具，于是同一条内容被 dsh 又说了一遍 —— 用户听两遍。
 *
 * 为什么把话说在这里而不是 `instructions`：§10.1 的探针结论是「写哪儿比写什么重要」，
 * 同一句写进 `instructions` 拿到 0 ms 应声（等于没说）。所以纪律跟着
 * {@link LEAD_IN_CLAUSE} 一起活在工具描述里。
 *
 * 只补**内容**约束（讲不讲正文），不收紧**长度**约束 —— 实测「六个字以内」那种收紧会让
 * 应声整个消失（2/4→0）。
 */
export const NO_PREVIEW_CLAUSE = '应声之后不要先讲答案，答案由接手的人回来说。';

/**
 * 从 `function_call_arguments.done` 里取 `request`。
 *
 * 容错到底：参数可能是 JSON 字符串、对象，也可能是半截；取不到就返回 `null`，
 * 调用方退回 ASR 原话。**绝不让一个解析错误把整轮委派搞砸**。
 */
export function parseDelegateRequest(args: unknown): string | null {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const request = (parsed as { request?: unknown }).request;
  if (typeof request !== 'string') {
    return null;
  }
  const trimmed = request.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 唯一的工具：把这一轮转给 dsh。
 *
 * 边界按问题领域划，不完全靠小模型自己判断「我听没听清」。
 * 动作、读设备、长期记忆，以及用户明确下令的备忘/提醒（「记一下」「提醒我」）走这里。
 * 只是随口提到开会、时间或心情，没有让你记下或提醒，不要调。
 *
 * 专名也必须走这里：用户专门追问某部具体书籍、电影、作品、论文或专有名词是什么、
 * 讲了什么、由谁创作；听不清或不确定的冷门专名；用户指出你说错、需要核实。
 * 真机把《其主之声》听岔后硬编成另一部作品，既不委派也不承认不认识。
 *
 * 普通闲聊、情绪安慰、讲笑话、问你的看法（「你看过星球大战没」）和常见生活常识
 * （水的沸点、日常聊天）是 omni 自己的活。绝不要把听岔的音节脑补成另一部书名来硬答。
 *
 * **仍然不能写成宽泛的「查询实时信息」**：实测那几个字会把
 * 「他还写过哪些作品？」判成检索 → 直接调工具、零音频、整轮报废。
 *
 * 最后两句是委派轮回执的来源。见 {@link LEAD_IN_CLAUSE}、{@link NO_PREVIEW_CLAUSE}。
 */
export const DELEGATE_TOOL = {
  type: 'function',
  name: 'delegate_to_assistant',
  description:
    '在以下情况调用：需要实际动手或读取设备数据（开关设备/拍照/发消息/查电脑文件或跑命令/读电量、位置或已有日程），'
    + '或者用户明确要你记住、写下备忘、写入日程、设定提醒（「记一下」「记下来」「提醒我」「定个提醒」这种下令）。'
    + '需要翻查提示词里没有的更早长期记忆；'
    + '用户明确发问追查某部具体书籍、电影、作品、论文或专有名词是什么、讲了什么、由谁创作，'
    + '以及听不清/不确定的冷门书名、影名、人名、专有名词，或用户指出你说错、需要核实查证时，必须调用。'
    + '普通闲聊、情绪安慰、讲笑话、问你的看法（例如「你看过星球大战没」）、常见生活常识（例如水的沸点、日常聊天），'
    + '以及提示词已有记忆能直接答出的问题（例如用户姓什么/养什么猫），不要调用，自己回答；'
    + '用户只是陈述分享买到的书、聊剧情，或随口提到开会、时间或心情，没有让你去查、记下或提醒，也不要调用。'
    + '绝不要把听岔的音节脑补成另一部书名、电影或概念来硬答。'
    + LEAD_IN_CLAUSE
    + NO_PREVIEW_CLAUSE,
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description:
          '把用户要你做的事**写清楚**（一句话，用他的口吻）：做什么、对象是谁。'
          + '数字、名字、书名、路径、设备名**原样照抄**，不要概括、不要改写、不要补全。'
          + '如果用户是在质疑或纠正刚才的话，如实写清要核实什么，不要擅自换话题。',
      },
      reason: { type: 'string', description: '为什么转交（一句话）' },
    },
    required: ['request', 'reason'],
  },
} as const;

/**
 * 建连提示词。基础人设保持原样；日期和长期记忆只在非空时各追加一块事实。
 * 单槽动态事实非空时再追加在最后。它为空时，结果与原来逐字相同。
 *
 * 这里**不放任何「要不要调工具」的暗示**。决定权在 {@link DELEGATE_TOOL}，不在提示词。
 */
export function composeInstructions(input: {
  readonly instructions?: string;
  readonly clock?: string;
  readonly memoryContext?: string;
  readonly dynamicContext?: string;
}): string {
  const base = input.instructions ?? DEFAULT_INSTRUCTIONS;
  const clock = input.clock?.trim() ?? '';
  const memory = boundedFact(input.memoryContext, MAX_STATIC_MEMORY_CHARS);
  let instructions = base;
  if (clock !== '') {
    instructions += `\n\n【当前日期参考】\n${clock}`;
  }
  if (memory !== '') {
    instructions += `\n\n【关于哥的已知长期记忆（仅供如实回答，不要主动复述）】\n${memory}`;
  }
  const dynamic = input.dynamicContext?.trim() ?? '';
  if (dynamic !== '') {
    instructions += `\n\n${dynamic}`;
  }
  return instructions;
}

export interface SessionUpdateInput {
  readonly instructions: string;
  readonly asrLanguage?: string;
  readonly asrCorpusText?: string;
  readonly serve: boolean;
}

/**
 * 整份 `session.update`。DashScope 的局部 update 会把 `turn_detection` 或 `tools`
 * 重置掉，所以动态事实刷新也发这一份，不能只补 instructions。
 */
export function buildSessionUpdate(input: SessionUpdateInput): Record<string, unknown> {
  const lang = input.asrLanguage;
  const corpus = input.asrCorpusText;
  const transcription: Record<string, unknown> = {
    model: 'qwen3-asr-flash-realtime',
  };
  if (lang) {
    transcription['language'] = lang;
  }
  if (corpus) {
    transcription['corpus'] = { text: corpus };
  }
  const session: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    // **不要**在 instructions 里加任何「要不要调工具」的暗示。实测：多加一句
    // 「如果决定调用工具，直接调用，不要先说任何过渡语」之后，闲聊会 3/3
    // 被判成工具调用（零音频）。决定权在工具描述，不在提示词。
    instructions: input.instructions,
    turn_detection: null,
    audio: {
      input: {
        format: {
          type: 'pcm',
          sample_rate: UPSTREAM_RATE,
          sample_format: 's16le',
          channels: 1,
          packing: 'interleaved',
          channel_layout: 'mono',
        },
      },
      output: { format: { type: 'pcm', sample_rate: DOWNSTREAM_RATE } },
    },
    input_audio_transcription: transcription,
  };
  if (input.serve) {
    session['tools'] = [DELEGATE_TOOL];
    session['tool_choice'] = 'auto';
  }
  return { type: 'session.update', session };
}

/** 一条 `response.done` 里所有助手项和 `function_call` 项的 id（`conversation.item.delete` 要它） */
export function assistantItemIds(ev: ServerEvent): string[] {
  const output = ev.response?.output ?? [];
  const ids = output
    .filter((it) =>
      (it.role === 'assistant' || it.type === 'function_call')
      && typeof it.id === 'string'
      && it.id !== '')
    .map((it) => it.id as string);
  return [...new Set(ids)];
}

/** base64 长度 → 字节数（不解码，省一次分配） */
export function base64Bytes(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - pad;
}
