/**
 * 设备 token 的生命周期 —— 生成、强度校验、文件读写、以及在连接上比对。
 *
 * 设计立场：**谁负责初始化，谁生成**。部署方不该"自己想一串字符串"，
 * 也不用从别处搬一个值过来：`node src/pair.ts new` 现场产一个 32 字节随机量，
 * 追加进文件，同时打印一条能直接贴进手机的配对串。
 *
 * 三条硬规矩：
 * 1. **追加，不覆盖**。重新生成不能把已有设备锁在门外 —— 那是运维事故的经典形状。
 * 2. **强度不达标就拒**。`123` 和 `abc` 也是"配了 token"，但等于没配。
 * 3. **绝不打日志**。token 只出现在生成时那一次 stdout 里。
 *
 * 与**眼镜的 token 是两回事**：那是小米服务端 `bindKeys` 下发的 16 字节绑定凭据
 * （见老仓 `TOKEN-LIFECYCLE.md`），形态是 32 位 hex。这里刻意把 `^[0-9a-f]{32}$`
 * 判成"你贴错了"，而不是当成一个弱口令放过去。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';import { dirname, resolve } from 'node:path';

/** 生成的长度：32 字节 → 64 位 hex。 */
export const TOKEN_BYTES = 32;

/** 一对绑定关系：`token:deviceId`。没绑设备就是 `null`。 */
export interface TokenEntry {
  readonly token: string;
  readonly deviceId: string | null;
}

export type TokenProblem = 'too-short' | 'looks-like-glasses-token' | 'has-colon' | 'has-space';

/** 判断一个 token 值能不能用。`null` = 合格。 */
export function classifyToken(token: string): TokenProblem | null {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return 'has-space';
  }
  // 文件格式用冒号分隔 deviceId，token 里带冒号会把行解析歪
  if (token.includes(':')) {
    return 'has-colon';
  }
  // 眼镜 token 的形态：16 字节 UUID 去连字符 = 32 位 hex。贴错的地方就在这儿。
  if (/^[0-9a-f]{32}$/i.test(token)) {
    return 'looks-like-glasses-token';
  }
  // 纯 hex 按字节算，其它按字符算 —— 目的只有一个：别让人拿 16 字节当 32 字节用
  const enough = /^[0-9a-f]+$/i.test(token) ? token.length >= TOKEN_BYTES * 2 : token.length >= TOKEN_BYTES;
  return enough ? null : 'too-short';
}

export function describeTokenProblem(token: string, problem: TokenProblem): string {
  switch (problem) {
    case 'looks-like-glasses-token':
      return '这看起来是**眼镜的** token（16 字节 UUID）。云端 token 要另外生成一个，'
        + '两者不能共用：眼镜 token 是账号↔设备的绑定凭据，泄露它等于泄露 SPP 会话密钥的根。'
        + '用 `node src/pair.ts new` 生成。';
    case 'too-short':
      return `强度不够：至少 ${TOKEN_BYTES} 字节（hex 形式 ${TOKEN_BYTES * 2} 个字符）。用 \`node src/pair.ts new\` 生成。`;
    case 'has-colon':
      return 'token 里不能有冒号：文件格式用冒号分隔 deviceId，带了会把这一行解析歪。';
    case 'has-space':
      return 'token 只能是可打印的非空白 ASCII（一行一个，空格会把这一行截断）。';
    default:
      return `token 不合格（${String(token.length)} 字符）。`;
  }
}

/** 现场生成一个新 token。 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function tokenFilePath(explicit?: string): string {
  const raw = (explicit ?? '').trim() || (process.env['MIAI_TOKENS'] ?? '').trim() || 'tokens.txt';
  return resolve(raw);
}

/** 解析文件内容。空行与 `#` 开头的行忽略。 */
export function parseTokenFile(text: string): { entries: TokenEntry[]; bad: Array<{ line: number; problem: TokenProblem; raw: string }> } {
  const entries: TokenEntry[] = [];
  const bad: Array<{ line: number; problem: TokenProblem; raw: string }> = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      return;
    }
    const colon = line.indexOf(':');
    const token = colon === -1 ? line : line.slice(0, colon).trim();
    const deviceId = colon === -1 ? null : (line.slice(colon + 1).trim() || null);

    const problem = classifyToken(token);
    if (problem !== null) {
      bad.push({ line: index + 1, problem, raw });
      return;
    }
    entries.push({ token, deviceId });
  });

  return { entries, bad };
}

export function readTokenFile(path: string): { entries: TokenEntry[]; bad: ReturnType<typeof parseTokenFile>['bad'] } {
  const text = readFileSync(path, 'utf8');
  return parseTokenFile(text);
}

/** 原子写 + 0600（POSIX 上才有意义，Windows 会忽略）。 */
export function writeTokenFile(path: string, entries: readonly TokenEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = entries
    .map((e) => (e.deviceId === null ? e.token : `${e.token}:${e.deviceId}`))
    .join('\n');
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${body}${body === '' ? '' : '\n'}`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，不该因此失败
  }
}

/** 文件不存在才算「空表」。权限、目录、锁都不是 ENOENT，不能当成可以新建。 */
function isEnoent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: unknown }).code === 'ENOENT';
}

/**
 * 追加一个新 token。**绝不覆盖已有条目** —— 重新生成只影响新设备，
 * 不会把所有已配对设备一起踢下线。
 *
 * 只有 `ENOENT`（文件还没有）按空文件处理。其它读失败原样抛出，
 * **不调用** `writeTokenFile`：当成空表再原子替换，会把已经配对的凭据整份换掉。
 */
export function appendToken(path: string, deviceId: string | null): { token: string; entries: TokenEntry[] } {
  let entries: TokenEntry[] = [];
  try {
    entries = readTokenFile(path).entries;
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    entries = [];
  }
  if (deviceId !== null) {
    const dup = entries.find((e) => e.deviceId === deviceId);
    if (dup !== undefined) {
      throw new Error(
        `deviceId \`${deviceId}\` 已经有 token 了。要换新的先吊销：`
        + `\n  node src/pair.ts revoke --device ${deviceId}`,
      );
    }
  }
  const token = generateToken();
  const next = [...entries, { token, deviceId }];
  writeTokenFile(path, next);
  return { token, entries: next };
}

export function revokeTokens(
  path: string,
  which: { deviceId: string } | { token: string },
): { removed: TokenEntry[]; entries: TokenEntry[] } {
  const entries = readTokenFile(path).entries;
  const removed = entries.filter((e) => ('deviceId' in which
    ? e.deviceId === which.deviceId
    : sameToken(e.token, which.token)));
  const kept = entries.filter((e) => !removed.includes(e));
  if (removed.length === 0) {
    throw new Error('没找到匹配的 token，什么也没改');
  }
  writeTokenFile(path, kept);
  return { removed, entries: kept };
}

/** 定长摘要后比 —— 长度不同也不会泄露时间差。 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function sameToken(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export interface AuthenticatedDevice {
  readonly deviceId: string | null;
  /** 命中的是第几条（`token:deviceId` 绑定过就填上绑定的那个） */
  readonly boundDeviceId: string | null;
}

/**
 * 连接上的比对器。**每次比对都重读文件**。
 *
 * 试过按 `mtime` 缓存，在 Linux 上翻车：吊销（写空）后紧接着发新 token，
 * 两次写在同一个时间戳刻度内，`mtimeMs` 一样 → 缓存不刷新 → 新 token 不生效。
 * 这个文件只有几行、鉴权一次连接才做一次，省这点 IO 不值得换一类陈旧缓存 bug。
 *
 * 文件读不了时**拒绝一切**（fail closed），只抱怨一次。
 */
export class TokenGate {
  private readonly path: string;
  private readonly log: (line: string) => void;
  private entries: TokenEntry[] = [];
  private warnedMissing = false;
  /** 上一次打过的「已加载」/「坏行」签名，用来避免每条连接都刷屏 */
  private lastSignature = '';

  constructor(path: string, log: (line: string) => void) {
    this.path = path;
    this.log = log;
  }

  private refresh(): void {
    try {
      const { entries, bad } = readTokenFile(this.path);
      this.entries = entries;
      this.warnedMissing = false;

      const signature = `${entries.map((e) => `${e.token}:${e.deviceId ?? ''}`).join('|')}#${bad
        .map((b) => `${b.line}:${b.problem}`)
        .join(',')}`;
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        for (const item of bad) {
          this.log(`  鉴权    tokens 文件第 ${item.line} 行被忽略：${describeTokenProblem(item.raw, item.problem)}`);
        }
        this.log(`  鉴权    已加载 ${entries.length} 个设备 token（${this.path}）`);
      }
    } catch (error) {
      this.entries = [];
      this.lastSignature = '';
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        this.log(`  鉴权    读不到 ${this.path}（${(error as Error).message}）→ 拒绝所有连接`);
      }
    }
  }

  /** 匹配成功就返回命中的条目，否则 `null`。 */
  match(token: string, deviceId: string | undefined): AuthenticatedDevice | null {
    this.refresh();
    let hit: TokenEntry | null = null;
    // 逐条比完再判断，不在命中时提前返回
    for (const entry of this.entries) {
      if (sameToken(entry.token, token)) {
        hit = entry;
      }
    }
    if (hit === null) {
      return null;
    }
    // `token:deviceId` 写了绑定就真的绑定 —— 否则这一列只是注释
    if (hit.deviceId !== null && hit.deviceId !== deviceId) {
      this.log(`  鉴权    token 正确但 deviceId 不匹配（期望 ${hit.deviceId}，收到 ${deviceId ?? '?'}）`);
      return null;
    }
    return { deviceId: deviceId ?? null, boundDeviceId: hit.deviceId };
  }

  get size(): number {
    this.refresh();
    return this.entries.length;
  }
}
