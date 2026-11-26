#!/usr/bin/env node
/**
 * 公开仓防泄漏扫描器：只看「已入库的路径」与「已入库文件的内容」。
 *
 * 两类检查分开，因为失败方式不同：
 *
 * - **路径**（`isForbiddenTrackedPath`）：凭据、证书、二进制权重根本不该进 git。
 *   一旦进来，删文件还要改历史 —— 所以这里在 CI 上先拦住。
 * - **内容**（`scanFileContent`）：高置信度密钥形态与真实公网 IPv4。
 *
 * 两条纪律：
 *
 * 1. **绝不回显命中的原文**。返回值只有 `{ file, line, rule }`，stdout 也只打
 *    位置和规则名。否则扫描器自己就把密钥/IP 写进了 CI 日志 —— 二次泄漏。
 * 2. **规则收窄，不做熵判**。`sk-` 要求 20 位以上纯字母数字，就是为了不误杀
 *    `sk-leaked-from-process` 这种占位串；IPv4 校验每段 0..255 并放行私网、
 *    回环、CGNAT 与 RFC 5737 文档段，就是为了不误杀版本号和示例地址。
 *
 * CLI 只扫 `git ls-files`（已跟踪文件），不存在于磁盘的已删除文件跳过；
 * 含 NUL 字节的二进制跳过内容检查。0 违规退出码 0，有违规退出码 1。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const OPENAI_KEY_RE = /\bsk-(?:proj-|ant-)?[A-Za-z0-9]{20,}\b/;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{30,}\b/;
const GITHUB_TOKEN_RE =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/;
const ALIYUN_KEY_RE = /\bLTAI[A-Za-z0-9]{16,}\b/;

const CONTENT_RULES = [
  { rule: 'private-key', re: PRIVATE_KEY_RE },
  { rule: 'openai-or-dashscope-key', re: OPENAI_KEY_RE },
  { rule: 'google-api-key', re: GOOGLE_KEY_RE },
  { rule: 'github-token', re: GITHUB_TOKEN_RE },
  { rule: 'aliyun-access-key', re: ALIYUN_KEY_RE },
];

const FORBIDDEN_EXTENSIONS = ['.pem', '.key', '.crt', '.p12', '.jks'];

/** 统一分隔符：Windows 上 git 仍输出 `/`，但手工调用时可能带 `\`。 */
function toPosix(relPath) {
  return String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 禁止入库的路径。返回违规原因；合法返回 `null`。
 *
 * 放行规则只认 `.example` 后缀：`cert.pem.example` 是模板，`cert.pem` 是证书。
 */
export function isForbiddenTrackedPath(relPath) {
  const path = toPosix(relPath);
  if (path === '') return null;
  const name = basename(path).toLowerCase();

  if (name === '.env') return '真实环境变量文件不入库（模板用 .env.example）';
  if (name.startsWith('.env.') && name !== '.env.example') {
    return '环境变量变体不入库（只有 .env.example 是模板）';
  }
  if (name === 'tokens.txt') return '设备/服务 Token 文件不入库';
  if (path.toLowerCase() === 'docs/ops-record.md') {
    return '运维记录含真实主机与设备信息，不入库';
  }
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (name.endsWith(ext)) return `${ext} 证书/私钥不入库（示例请加 .example 后缀）`;
  }
  if (/^(?:.*\/)?models\/(?:.*\/)?[^/]+\.onnx$/i.test(path)) {
    return 'models/*.onnx 二进制权重不入库';
  }
  return null;
}

/** 四段 IPv4 候选。前后不能接数字或点，避免把 `1.2.3.4.5` 切出前半段。 */
const IPV4_CANDIDATE_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d)(?!\.\d)/g;

/** 非真实公网：不可路由、私网、链路本地、CGNAT、文档保留段。 */
function isNonPublicIpv4(a, b, c, d) {
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  if (a === 127) return true; // 回环 127.0.0.0/8
  if (a === 10) return true; // 私网 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 私网 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 链路本地 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 2) return true; // RFC 5737 TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // RFC 5737 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // RFC 5737 TEST-NET-3
  return false;
}

/** 这一行是否含真实公网 IPv4。 */
function hasPublicIpv4(line) {
  IPV4_CANDIDATE_RE.lastIndex = 0;
  for (const match of line.matchAll(IPV4_CANDIDATE_RE)) {
    const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
    if (octets.some((part) => part > 255)) continue;
    const [a, b, c, d] = octets;
    if (!isNonPublicIpv4(a, b, c, d)) return true;
  }
  return false;
}

/**
 * 扫描一个文件的内容。**只返回位置与规则名，不含命中原文**。
 *
 * `package-lock.json` 跳过 IPv4 规则：lockfile 里的四段数字是包版本，不是地址。
 * 密钥规则仍照常扫。
 */
export function scanFileContent(relPath, content) {
  const file = toPosix(relPath);
  const scanIps = basename(file).toLowerCase() !== 'package-lock.json';
  const lines = String(content).split(/\r?\n/);
  const findings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { rule, re } of CONTENT_RULES) {
      re.lastIndex = 0;
      if (re.test(line)) findings.push({ file, line: index + 1, rule });
    }
    if (scanIps && hasPublicIpv4(line)) {
      findings.push({ file, line: index + 1, rule: 'public-ipv4' });
    }
  }
  return findings;
}

/** `git ls-files -z` → 已跟踪路径数组。 */
function trackedFiles() {
  const raw = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  return raw
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '');
}

function isBinary(buffer) {
  return buffer.includes(0);
}

/** CLI 主流程。返回进程退出码。 */
export function runCli({ root = process.cwd() } = {}) {
  process.chdir(root);
  const files = trackedFiles();
  const violations = [];
  let scanned = 0;

  for (const relPath of files) {
    const forbidden = isForbiddenTrackedPath(relPath);
    if (forbidden !== null) {
      violations.push({ file: toPosix(relPath), line: 0, rule: 'forbidden-path', reason: forbidden });
      continue;
    }
    let buffer;
    try {
      buffer = readFileSync(relPath);
    } catch {
      continue; // 已跟踪但磁盘上已删除：git status 会报，这里不重复
    }
    scanned += 1;
    if (isBinary(buffer)) continue;
    violations.push(...scanFileContent(relPath, buffer.toString('utf8')));
  }

  if (violations.length === 0) {
    process.stdout.write(`secret-scan: OK (${scanned} files scanned)\n`);
    return 0;
  }

  for (const item of violations) {
    const where = item.line > 0 ? `${item.file}:${item.line}` : item.file;
    process.stdout.write(`FAIL ${where} [${item.rule}]\n`);
    if (item.reason) process.stdout.write(`     ${item.reason}\n`);
  }
  process.stdout.write(`secret-scan: ${violations.length} violation(s) in ${scanned} file(s) scanned\n`);
  return 1;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`secret-scan: error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
