/**
 * 情绪标签：agent 在回复开头写一个 `[开心]` 之类的标签，TTS 据此换语调。
 *
 * 为什么要这一层：语音 TTS 通常支持「用一句话描述语气」，一个固定提示词只能给出
 * 一种语气。让**模型自己**给每句标情绪，再由具体 provider 翻成它自己的表达方式，
 * 语调就跟着内容走了 —— 而不是永远"平静"。
 *
 * 分工（**本模块不认识任何厂商**）：
 * - 这里只做**纯解析**：中文标签 ⇄ 情绪 key
 * - 「某个 key 该用什么语气」是 provider 的事，见 `mimo.ts` 的风格表
 *
 * 标签缺失 / 不认识时一律回落 `calm`：宁可语调普通，也不要因为模型漏写标签就报错。
 */

/** 八个情绪（key 是通用的，具体怎么用由 TTS provider 决定；见 `mimo.ts` / `cosyvoice.ts` 的风格表） */
export const EMOTIONS = {
  happy: true,
  proud: true,
  surprised: true,
  calm: true,
  worried: true,
  sulk: true,
  angry: true,
  disgust: true,
} as const;

export type Emotion = keyof typeof EMOTIONS;

/**
 * 情绪 key → 中文标签。
 *
 * **单一事实来源**：这份表同时被三处消费，别在别处再抄一遍
 * 1. 人设提示词里"从这八个里选一个"的枚举（`mcp/profile.cordis.yml`）
 * 2. 句中残留标签的清理正则（本文件的 `stripEmotionTags` / `cleanForSpeech`）
 * 3. 解析模型输出时的反查（`asEmotion` / `parseEmotion`）
 *
 * 以前这三处各写了一份中文标签，改一个名字就会有两处悄悄失效。
 */
export const EMOTION_LABELS: Record<Emotion, string> = {
  happy: '开心',
  proud: '得意',
  surprised: '惊讶',
  calm: '平静',
  worried: '担心',
  sulk: '委屈',
  angry: '生气',
  disgust: '厌恶',
};

/** 标签 → key（由 {@link EMOTION_LABELS} 反推，不单独维护） */
const LABELS: Record<string, Emotion> = Object.fromEntries(
  Object.entries(EMOTION_LABELS).map(([key, label]) => [label, key as Emotion]),
);

/** 提示词里用的枚举串：`[开心] [得意] [惊讶] [平静] [担心] [委屈] [生气] [厌恶]` */
export function emotionTagList(): string {
  return Object.values(EMOTION_LABELS).map((label) => `[${label}]`).join(' ');
}

/**
 * 清掉文本里**任何位置**的情绪标签。
 *
 * 只给"兜底"用：正常情况下 @{link parseEmotion} 已经剥掉开头那个；模型偶尔会在
 * 句中再写一个，那些会被原样念出来（「方括号开心」）。
 */
export function stripEmotionTags(text: string): string {
  const labels = Object.values(EMOTION_LABELS).join('|');
  return text.replace(new RegExp(`[\\[【]\\s*(?:${labels})\\s*[\\]】]`, 'g'), '');
}

export const DEFAULT_EMOTION: Emotion = 'calm';

/**
 * 「某个情绪该用什么语气」是 **provider 的表达方式**，值定义在各家 TTS 模块里
 * （`mimo.ts` / `cosyvoice.ts`），本模块**严格不认识任何厂商**。
 *
 * 早先这里有一行兼容再导出，把风格表从 provider 透出来 —— 而 provider 反过来又要用
 * 本模块的 `asEmotion()`，那正是**全仓最后一个模块环**。现在要用风格表就直接从
 * provider 模块取，这里不再透出任何厂商符号。
 */
/**
 * 把外部传来的情绪字符串规范成 key。
 *
 * provider 拿到的是 `AgentReplyView.emotion`（可能来自别的 agent 实现、可能是
 * 中文标签、也可能根本不传），所以这里必须容错：认不出就当 `calm`。
 */
export function asEmotion(value: unknown): Emotion {
  if (typeof value !== 'string') {
    return DEFAULT_EMOTION;
  }
  const key = value.trim();
  if (key in EMOTIONS) {
    return key as Emotion;
  }
  return LABELS[key] ?? DEFAULT_EMOTION;
}

const TAG = /^\s*[\[【]\s*([^\]】]{1,4})\s*[\]】]\s*/;

/**
 * 从回复开头取出情绪标签。
 *
 * 只认**开头**那一个：模型可能在正文里也写方括号，但那不该影响语调。
 * 解析不到就把原文原样返回、情绪用默认值 —— 绝不因为格式问题丢内容。
 */
export function parseEmotion(text: string): { emotion: Emotion; rest: string } {
  const m = TAG.exec(text);
  if (!m) {
    return { emotion: DEFAULT_EMOTION, rest: text };
  }
  const label = m[1] ?? '';
  const emotion = LABELS[label] ?? DEFAULT_EMOTION;
  return { emotion, rest: text.slice(m[0].length) };
}

/**
 * 兜底：TTS 前再清洗一遍，挡住模型偶尔漏掉的格式。
 *
 * 情绪标签只该出现在开头（{@link parseEmotion} 已经剥过一次）；模型有时会在
 * 句中再写一个，那些会被原样念出来（「方括号开心」）。标签表就是上面的
 * {@link EMOTION_LABELS}，这里不另抄一份。
 *
 * 实现放在本模块：`cosyvoice.ts` 与 `agent.ts` 都从这里取。
 * `agent.ts` 继续转出这个名字，旧的导入不用改。
 */
export function cleanForSpeech(text: string): string {
  return stripEmotionTags(text)
    // 标签表之外的自造语气标签（`[笑]` `[叹气]`）抓不到，同样会被念出来。
    // 只列「不可能是正常内容」的词：`[两]` 这类正常方括号必须保留（见 tests）。
    .replace(/(?:\[|【)\s*(?:轻?笑|笑声|苦笑|冷笑|叹气|轻叹|哭声?|哼|小声|低声)\s*(?:\]|】)/g, '')
    // 快车道判委派前可能已经推出半个标签（`[[`），和 dsh 的正文拼在一起就是 `[[[你好…`
    .replace(/^\s*(?:\[|【|\]|】){1,4}\s*/, '')
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
