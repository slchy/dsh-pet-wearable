#!/usr/bin/env node
/**
 * 服务端干净部署包：只打「运行需要的东西」，并且**不允许**任何一个禁区文件混进来。
 *
 * 为什么不用 `git archive`：部署目录里还有构建期产生、但不在 git 里的东西吗？
 * 没有。但 `git archive` 会把 `tests/`、`bench/`、`docs/` 全带上，而它们与运行无关；
 * 更关键的是，它**不检查** `.env` / `models/*.onnx` / `tokens.txt` 这类文件是否
 * 刚好在被打包的目录里。白名单 + 逐条禁区校验，才有「打包失败」而不是
 * 「悄悄把密钥发到服务器」。
 *
 * 禁区口径与 `scripts/secret-scan.mjs` 保持一致（`.env` 与变体、token 文件、
 * 证书私钥、ONNX 权重、运维记录），额外拒绝开发目录 —— 它们进包只会让服务器上
 * 多一份没人看的副本。
 *
 * 收集与打包分开：`collectServerBundleFiles` 是纯函数，测试可以直接对真仓跑；
 * `createServerBundle` 只负责调系统 `tar`（Linux/macOS/Windows 都自带）。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 运行清单：目录 + 单文件。加东西前先问「服务器真的需要它吗」。 */
export const SERVER_BUNDLE_ALLOWLIST = {
  dirs: ['src', 'mcp'],
  files: [
    'package.json',
    'package-lock.json',
    'LICENSE',
    'README.md',
    'models/README.md',
    'scripts/install-profile-patch.mjs',
  ],
};

const FORBIDDEN_EXTENSIONS = ['.pem', '.key', '.crt', '.p12', '.jks'];
const FORBIDDEN_DIRS = new Set(['.git', 'node_modules', 'tmp', 'tests', 'bench']);

function toPosix(relPath) {
  return String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 禁止进部署包的路径。返回原因；合法返回 `null`。
 *
 * 放行只认 `.pem.example`：它是模板，`cert.pem` 是证书。
 */
export function isForbiddenBundleEntry(relPath) {
  const path = toPosix(relPath);
  if (path === '') return null;
  const name = basename(path).toLowerCase();
  const segments = path.split('/').filter((part) => part !== '' && part !== '.');

  if (name === '.env') return '真实环境变量文件不进部署包（模板用 .env.example）';
  if (name.startsWith('.env.') && name !== '.env.example') {
    return '环境变量变体不进部署包（只有 .env.example 是模板）';
  }
  if (name === 'tokens.txt') return '设备/服务 Token 文件不进部署包';
  if (path.toLowerCase() === 'docs/ops-record.md') return '运维记录含真实主机与设备信息，不进部署包';
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (name.endsWith(ext) && !name.endsWith('.pem.example')) {
      return `${ext} 证书/私钥不进部署包`;
    }
  }
  if (name.endsWith('.onnx')) return 'ONNX 模型权重不进部署包（服务器上自备）';
  for (const segment of segments) {
    if (FORBIDDEN_DIRS.has(segment)) {
      return `${segment}/ 不进部署包`;
    }
  }
  return null;
}

function walk(dir, base, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, base, out);
    } else {
      out.push(toPosix(relative(base, abs)));
    }
  }
}

/**
 * 收集允许清单下的全部相对 POSIX 路径（已排序）。
 *
 * 任何一条命中禁区都直接抛错 —— 宁可打包失败，也不要生成一份「看着正常」的包。
 */
export function collectServerBundleFiles(repoDir) {
  const root = resolve(repoDir);
  const files = [];
  for (const dir of SERVER_BUNDLE_ALLOWLIST.dirs) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    walk(abs, root, files);
  }
  for (const file of SERVER_BUNDLE_ALLOWLIST.files) {
    const abs = join(root, ...file.split('/'));
    if (existsSync(abs) && statSync(abs).isFile()) files.push(file);
  }

  const unique = [...new Set(files)].sort();
  const violations = [];
  for (const file of unique) {
    const reason = isForbiddenBundleEntry(file);
    if (reason !== null) violations.push(`${file}（${reason}）`);
  }
  if (violations.length > 0) {
    throw new Error(`部署包含有禁区文件，拒绝打包：\n  ${violations.join('\n  ')}`);
  }
  if (unique.length === 0) {
    throw new Error(`允许清单没有收集到任何文件：${root}`);
  }
  return unique;
}

/**
 * 生成 `<outFile>.tar.gz`。返回文件清单、字节数与 SHA-256。
 *
 * 用 `tar -C <repoDir> -T <manifest>` 而不是在 Node 里流式压：系统 tar 在
 * Linux/macOS/Windows 上都有，且 `-T` 接受 UTF-8 路径列表，中文文件名不用转义。
 */
export function createServerBundle(repoDir, outFile) {
  const root = resolve(repoDir);
  const files = collectServerBundleFiles(root);
  const absOut = resolve(outFile);
  mkdirSync(dirname(absOut), { recursive: true });

  const manifestDir = mkdtempSync(join(tmpdir(), 'dsh-server-bundle-'));
  const manifest = join(manifestDir, 'files.txt');
  writeFileSync(manifest, `${files.join('\n')}\n`);
  try {
    execFileSync('tar', ['-czf', absOut, '-C', root, '-T', manifest], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
  }

  const buffer = readFileSync(absOut);
  return {
    outFile: absOut,
    files,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** CLI 参数：`--out <file.tar.gz>`。 */
function parseArgs(argv) {
  const args = [...argv];
  const index = args.indexOf('--out');
  const out = index === -1 ? undefined : args[index + 1];
  return { out, help: args.includes('--help') || args.includes('-h') };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  try {
    const { out, help } = parseArgs(process.argv.slice(2));
    if (help || !out) {
      process.stdout.write('用法：node scripts/pack-server-bundle.mjs --out <file.tar.gz>\n');
      process.exitCode = out ? 0 : 1;
    } else {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const result = createServerBundle(repoRoot, out);
      process.stdout.write(
        `服务端部署包：${result.outFile}\n` +
          `  文件 ${result.files.length} 个，${result.bytes} 字节\n` +
          `  sha256 ${result.sha256}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `pack-server-bundle: error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
