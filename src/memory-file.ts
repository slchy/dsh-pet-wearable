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
   * 一个 2-gram 都不重叠就返回**最近两条** —— 「我有点困了」这种句子跟记忆没有词面
   * 交集，但最近的记忆往往正好是「哥每天十一点睡」。宁可多给两条，也不要让模型
   * 因为没看到而说「我不知道」。
   */
  relevant(query: string, k = 3): string[] {
    const all = this.entries();
    if (all.length === 0) {
      return [];
    }
    const q = bigrams(query);
    const scored = all
      .map((line, index) => {
        const grams = bigrams(line);
        let hit = 0;
        for (const g of grams) {
          if (q.has(g)) hit += 1;
        }
        return { line, index, hit };
      })
      .filter((s) => s.hit > 0)
      .sort((a, b) => b.hit - a.hit || b.index - a.index)
      .slice(0, k)
      .map((s) => s.line);
    if (scored.length > 0) {
      return scored;
    }
    return all.slice(-2);
  }
}
