/**
 * 长期记忆的**只读**视图。
 *
 * 记忆不是数据库，就是一个文本文件（`MEMORY.md`，≤4 KB，一行一条）：
 * dsh 那边由 `mcp/mcp-memory.mjs` 的 `remember` 工具**追加**，而 `agent-instructions`
 * 每个请求都会把整份文件读进系统提示词 —— 也就是说 L2 天然看得到全部记忆。
 *
 * 快车道（L1）要共享这份记忆，但**只读**：
 * - 不写：单写者能省掉一整套并发/合并/回滚问题；写错了也没人追得回来
 * - 不全塞：4 KB ≈ 1.5 k token，每轮都塞进快车道太贵，按这句话挑几条
 *
 * 按 `mtime` 缓存：文件没变就不重读（一轮一次 stat，比读 4 KB + 解析便宜）。
 */
import { statSync, readFileSync } from 'node:fs';

/** 一行记忆最多留多少字（喂给提示词，不是存盘格式） */
const LINE_MAX = 60;

/** 没传 `k` 时最多交出去几条（大记忆库） */
const DEFAULT_K = 3;

/**
 * 有效条目不超过这个规模时，默认窗口会把姓名/过敏这类核心事实裁掉。
 * 两条一起满足才算「小集合」：条数少，而且拼起来也不长。
 */
const SMALL_SET_MAX_ENTRIES = 8;
const SMALL_SET_MAX_CHARS = 400;

/** 词簇命中比偶然蹭到一个 2-gram 更值得排前，但压不过整句都对得上的条目 */
const CLUSTER_WEIGHT = 4;
const IDENTITY_WEIGHT = 2;
const ALLERGY_WEIGHT = 6;
const PREFERENCE_WEIGHT = 2;

/** 去掉行首的 `- ` 与 `2026-11-16 23:08 · ` 前缀，只留内容 */
function cleanEntry(line: string): string {
  return line
    .replace(/^[-*]\s*/, '')
    .replace(/^\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2})?\s*[·:：-]?\s*/, '')
    .trim();
}

/** 中文没有空格，用 2-gram 重叠当相似度；够用且不用引入分词 */
function bigrams(text: string): Set<string> {
  const t = text.replace(/[\s，。、！？；：""''（）()·,.:;!?]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i += 1) {
    out.add(t.slice(i, i + 2));
  }
  return out;
}

/**
 * 身份 / 居住 / 过敏这几类高频问法，词面常常对不上（「名字」对不上「叫陈默」）。
 * 问法沾到词簇、条目里又有对应事实时加一档分，大记忆库也能把那条抬进前几名。
 */
function clusterWeight(query: string, line: string): number {
  let weight = 0;
  if (/名字|叫什么|姓|谁/.test(query) && /叫|姓/.test(line)) {
    weight += CLUSTER_WEIGHT;
    // 「用户叫陈默」「哥姓袁」比「橘猫名字叫团子」更像在回答「我叫什么」
    if (/用户叫|我叫|本人叫|哥姓|姓[^\s，。、,.]{1,3}/.test(line)) weight += IDENTITY_WEIGHT;
  }
  if (/住|在哪|城市/.test(query) && /住|市|区/.test(line)) weight += CLUSTER_WEIGHT;
  if (/吃|点餐|点份|菜|过敏|忌口/.test(query)) {
    if (/过敏|不吃|忌口/.test(line)) weight += ALLERGY_WEIGHT;
    if (/喜欢|讨厌/.test(line)) weight += PREFERENCE_WEIGHT;
  }
  return weight;
}

function relevanceScore(query: string, line: string): number {
  const q = bigrams(query);
  let hit = 0;
  for (const g of bigrams(line)) {
    if (q.has(g)) hit += 1;
  }
  return hit + clusterWeight(query, line);
}

export class MemoryFile {
  private readonly file: string;
  private cache: { mtimeMs: number; size: number; lines: string[] } | null = null;

  constructor(file: string) {
    this.file = file;
  }

  /** 全部条目（文件没变就直接用上次的）。读不到就当没有记忆，绝不抛。 */
  entries(): string[] {
    // mtime 在某些文件系统上精度只到秒，同一秒内改写会看不出来 —— 再带上大小
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = statSync(this.file);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      this.cache = null;
      return [];
    }
    if (this.cache !== null && this.cache.mtimeMs === mtimeMs && this.cache.size === size) {
      return this.cache.lines;
    }
    let raw = '';
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*]\s/.test(l))
      .map(cleanEntry)
      .filter((l) => l !== '')
      .map((l) => (l.length <= LINE_MAX ? l : `${l.slice(0, LINE_MAX)}…`));
    this.cache = { mtimeMs, size, lines };
    return lines;
  }

  /**
   * 挑出和这句话相关的几条。
   *
   * 一个 2-gram 都不重叠、词簇也沾不上，就返回**最近两条** —— 「我有点困了」这种
   * 句子跟记忆没有词面交集，但最近的记忆往往正好是「哥每天十一点睡」。宁可多给
   * 两条，也不要让模型因为没看到而说「我不知道」。
   *
   * 小集合（≤8 条且总字数 ≤400）又比默认窗口多、调用方也没传 `k` 时，按相关度把
   * **整份**交出去：高相关的排前，姓名/过敏不会因为默认 `k=3` 被裁掉。显式传入的
   * `k`（例如 `relevant(q, 2)`）始终只取前 `k` 条。
   */
  relevant(query: string, k?: number): string[] {
    const all = this.entries();
    if (all.length === 0) {
      return [];
    }
    const explicitK = k !== undefined;
    const limit = k ?? DEFAULT_K;
    const totalChars = all.reduce((sum, line) => sum + line.length, 0);
    const small = all.length <= SMALL_SET_MAX_ENTRIES && totalChars <= SMALL_SET_MAX_CHARS;
    const ranked = all
      .map((line, index) => ({ line, index, score: relevanceScore(query, line) }))
      .sort((a, b) => b.score - a.score || b.index - a.index);
    // 条数不超过默认窗口时仍只交命中的那些，既有「只返回沾边的那条」断言不变。
    if (!explicitK && small && all.length > limit) {
      return ranked.map((row) => row.line);
    }
    const hits = ranked.filter((row) => row.score > 0).slice(0, limit).map((row) => row.line);
    if (hits.length > 0) {
      return hits;
    }
    const recent = all.slice(-2);
    return explicitK ? recent.slice(0, limit) : recent;
  }

  /**
   * 建连时一次性塞进 Omni 的紧凑摘要。逐行 `- <内容>`，超过 `maxChars` 就停。
   * 没有条目时返回空串。
   */
  summary(maxChars = 600): string {
    if (maxChars <= 0) return '';
    const rows: string[] = [];
    let used = 0;
    for (const line of this.entries()) {
      const row = `- ${line}`;
      const extra = rows.length > 0 ? 1 : 0;
      if (used + extra + row.length > maxChars) {
        if (rows.length === 0) return row.slice(0, maxChars);
        break;
      }
      rows.push(row);
      used += extra + row.length;
    }
    return rows.join('\n');
  }

  /**
   * ASR `corpus` 的静态偏置：条目已去掉时间戳和列表前缀，空格拼成一串。
   * 超过 `maxChars` 时在空格处收住，不留下半个词。没有条目时返回空串。
   */
  hotwordHints(maxChars = 400): string {
    if (maxChars <= 0) return '';
    const joined = this.entries().join(' ');
    if (joined.length <= maxChars) return joined;
    const cut = joined.slice(0, maxChars);
    const space = cut.lastIndexOf(' ');
    return space > 0 ? cut.slice(0, space) : cut;
  }
}
