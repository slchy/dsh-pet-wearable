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
 * 2. 句中残留标签的清理正则（`cleanForSpeech`）
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
