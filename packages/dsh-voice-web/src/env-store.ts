/**
 * `~/.dsh/.env` 的安全读写模块。
 *
 * 保留用户已有的注释、空行与无关环境变量，仅原地更新或追加指定的键，
 * 并在写入前严格校验键名与无换行/控制字符，防止 `.env` 注入。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VALID_ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/u;
const FORBIDDEN_VALUE_RE = /[\r\n\u0000]/u;
const NEEDS_QUOTES_RE = /[\s#'"$`\\=]/u;

/** 解析 `.env` 文本为键值表（兼容可选 `export ` 前缀与单/双引号）。 */
export function parseDotEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!VALID_ENV_KEY_RE.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(["\\])/gu, '$1');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** 读取 `.env` 文件；文件不存在时返回空对象。 */
export function readDotEnvFile(filePath: string): Record<string, string> {
  try {
    return parseDotEnvText(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function formatDotEnvValue(value: string): string {
  if (FORBIDDEN_VALUE_RE.test(value)) {
    throw new Error('环境变量值包含非法换行或控制字符');
  }
  if (value === '' || NEEDS_QUOTES_RE.test(value)) {
    const escaped = value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

function extractLineKey(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eq = body.indexOf('=');
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  return VALID_ENV_KEY_RE.test(key) ? key : null;
}

/**
 * 纯函数式更新 `.env` 文本：
 * - `updates[key] === string`（非空）：原地替换或末尾追加
 * - `updates[key] === null | ''`：删除对应行
 * - `updates[key] === undefined`：保持不动
 */
export function applyDotEnvUpdates(
  existingText: string,
  updates: Readonly<Record<string, string | null | undefined>>,
): string {
  const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
  const normalized = new Map<string, string | null>();
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (!VALID_ENV_KEY_RE.test(key)) {
      throw new Error(`非法环境变量名：${key}`);
    }
    if (value === null || value === '') {
      normalized.set(key, null);
    } else {
      normalized.set(key, formatDotEnvValue(value));
    }
  }
  if (normalized.size === 0) return existingText;

  const rawLines = existingText === '' ? [] : existingText.split(/\r?\n/u);
  // 去掉末尾切分出的单个尾空行，重新拼接时再补尾换行
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  const handled = new Set<string>();
  const outLines: string[] = [];
  for (const line of rawLines) {
    const key = extractLineKey(line);
    if (key === null || !normalized.has(key)) {
      outLines.push(line);
      continue;
    }
    const nextValue = normalized.get(key);
    if (nextValue === null || nextValue === undefined) {
      // 删除该键（重复定义也一并清掉）
      handled.add(key);
      continue;
    }
    if (handled.has(key)) {
      // 同一键在旧文件里出现多次时，去重只留第一处更新后的值
      continue;
    }
    outLines.push(`${key}=${nextValue}`);
    handled.add(key);
  }

  for (const [key, formatted] of normalized) {
    if (handled.has(key) || formatted === null) continue;
    outLines.push(`${key}=${formatted}`);
  }

  return outLines.length === 0 ? '' : `${outLines.join(eol)}${eol}`;
}

/** 原子写入更新后的 `.env`（POSIX 下设置 `0o600` 保护密钥）。 */
export function upsertDotEnvFile(
  filePath: string,
  updates: Readonly<Record<string, string | null | undefined>>,
): void {
  let existing = '';
  try {
    existing = readFileSync(filePath, 'utf8');
  } catch {
    existing = '';
  }
  const nextText = applyDotEnvUpdates(existing, updates);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, nextText, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch {
    writeFileSync(filePath, nextText, { encoding: 'utf8', mode: 0o600 });
  }
}
