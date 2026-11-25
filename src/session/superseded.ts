/**
 * 透明化之后的旧会话：登记、按 7 天过期、只删 sessions 根下目录名正好是 id 的那一层。
 *
 * 路径全部由调用方注入。这个模块不读 `~/.dsh`，单测用临时目录即可。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 透明化之后「原会话」保留多久：过了这段时间连目录一起删 */
export const SUPERSEDED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** 一条「被透明化掉的会话」记录 */
export interface SupersededEntry {
  /** dsh 会话 id */
  readonly id: string;
  /** 透明化时刻（epoch ms） */
  readonly at: number;
  /** 会话目录的绝对路径（删之前会再校验一次它在 dsh 的 sessions 根下） */
  readonly dir: string;
}

/** 比较路径时把 Windows 的 `\` 收成 `/`，并去掉末尾斜杠。 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 分拣「该删的」和「该留的」。
 *
 * 纯函数，好测：IO 留给调用方（这里只做时间比较）。坏记录（缺字段、路径不像）一律丢掉 ——
 * 一条坏行不该让整份清单失效，更不能让它指向 `rm -rf` 一个奇怪路径。
 */
export function splitSuperseded(
  entries: readonly unknown[],
  now: number,
  sessionsRoot: string,
  ttl = SUPERSEDED_TTL_MS,
): { drop: SupersededEntry[]; keep: SupersededEntry[]; bad: number } {
  const drop: SupersededEntry[] = [];
  const keep: SupersededEntry[] = [];
  let bad = 0;
  // Windows 上 `join` 出来的是反斜杠。先收成 `/` 再比前缀和末段，
  // 否则每一条都会被当成坏记录，过期会话永远删不掉。
  const root = normalizeSlashes(sessionsRoot);
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') { bad += 1; continue; }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    const at = typeof entry['at'] === 'number' && Number.isFinite(entry['at']) ? entry['at'] : 0;
    const dir = typeof entry['dir'] === 'string' ? entry['dir'] : '';
    if (id === '' || at <= 0 || dir === '') { bad += 1; continue; }
    const dirNorm = normalizeSlashes(dir);
    // 只认 dsh sessions 根下、目录名正好是 id 的那一层。落盘仍用原路径。
    if (root === '' || !dirNorm.startsWith(`${root}/`) || dirNorm.split('/').pop() !== id) {
      bad += 1;
      continue;
    }
    if (now - at >= ttl) drop.push({ id, at, dir });
    else keep.push({ id, at, dir });
  }
  return { drop, keep, bad };
}

/**
 * 清单文件与 sessions 根都从外面传进来。
 * `retire` 找到目录就追加一行，然后跑一次 `collect`。
 */
export class SupersededStore {
  private readonly supersededFile: string;
  private readonly sessionsRoot: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(opts: {
    supersededFile: string;
    sessionsRoot: string;
    log?: (line: string) => void;
    now?: () => number;
  }) {
    this.supersededFile = opts.supersededFile;
    this.sessionsRoot = opts.sessionsRoot;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 把被替换掉的会话登记进清单，顺手做一次过期清理。
   *
   * 为什么要归档而不是立刻删：fork 之后旧会话**还在磁盘上**（我们只是不再引用它），
   * 万一切点或 fork 出了问题，它是唯一能回看的现场。留 7 天，然后连目录一起删。
   */
  retire(oldId: string, openSessionId: string | null): void {
    try {
      const dir = this.findSessionDir(oldId);
      if (dir === null) return;
      mkdirSync(dirname(this.supersededFile), { recursive: true });
      appendFileSync(
        this.supersededFile,
        `${JSON.stringify({ id: oldId, at: this.now(), dir } satisfies SupersededEntry)}\n`,
      );
      this.collect(openSessionId);
    } catch (error) {
      // 清理是后台卫生，坏了不该影响对话
      this.log(`  回溯    清理登记失败：${(error as Error).message}`);
    }
  }

  /** 在 `<sessionsRoot>/<workspace>/<id>` 里找那一层目录；找不到就算了 */
  findSessionDir(id: string): string | null {
    let spaces: string[];
    try {
      spaces = readdirSync(this.sessionsRoot);
    } catch {
      return null;
    }
    for (const space of spaces) {
      const dir = join(this.sessionsRoot, space, id);
      if (existsSync(dir)) return dir;
    }
    return null;
  }

  /**
   * 删掉超过 7 天的透明化会话。
   * `openSessionId` 命中的那条不 `rm`（正在用的双保险）。
   */
  collect(openSessionId: string | null): void {
    let raw: string;
    try {
      raw = readFileSync(this.supersededFile, 'utf8');
    } catch {
      return;
    }
    const entries = raw.split('\n').filter((line) => line.trim() !== '').map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return null; }
    });
    const { drop, keep, bad } = splitSuperseded(entries, this.now(), this.sessionsRoot);
    for (const entry of drop) {
      if (entry.id === openSessionId) {
        continue; // 双保险：正在用的绝不删
      }
      try {
        rmSync(entry.dir, { recursive: true, force: true });
        this.log(`  回溯    清理旧会话 ${entry.id}（透明化于 ${new Date(entry.at).toISOString()}）`);
      } catch (error) {
        keep.push(entry);
        this.log(`  回溯    ✗ 清理 ${entry.id} 失败：${(error as Error).message}`);
      }
    }
    try {
      writeFileSync(
        this.supersededFile,
        keep.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      );
    } catch {
      // 写不进去就下次再试
    }
    if (bad > 0) {
      this.log(`  回溯    清单里有 ${bad} 条坏记录，已丢弃`);
    }
  }
}
