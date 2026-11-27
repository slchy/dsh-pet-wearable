#!/usr/bin/env node
/**
 * 发布包深度校验：对着**打出来的压缩包**逐条核对，而不是对着源码目录想象。
 *
 * 三件事必须由同一份证据回答：
 *
 * 1. **该有的在不在** —— `dsh-voice-web` 的 `lib/driver.js`、浏览器 bundle、
 *    `cordis.patch.yml`、美术素材；服务端的 `src/main.ts`、`mcp/profile.cordis.yml`。
 *    任何一项缺失，装上之后才会以「模块找不到」的形式炸。
 * 2. **不该有的在不在** —— `.env`、证书、ONNX 权重、开发目录、`browser-types`
 *    里已经删掉的 `pet-*.d.ts` 残留。
 * 3. **真包能不能被加载** —— 在临时目录里从 tarball 安装一次，`import` 出
 *    `apply` / `name`，而不是只看 `npm pack --dry-run` 的清单。
 *
 * 最后写 `SHA256SUMS.txt`，Release 附件与服务器校验都认这一份。
 *
 * 导入本模块不会产生副作用；CLI 只在主模块直接执行时运行。
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServerBundle, isForbiddenBundleEntry } from './pack-server-bundle.mjs';

/** web tarball 里必须出现的条目（`package/` 前缀是 npm 的打包根）。 */
const WEB_REQUIRED = [
  'package/package.json',
  'package/lib/driver.js',
  'package/lib/driver.d.ts',
  'package/lib/widget.js',
  'package/lib/browser.mjs',
  'package/lib/browser-types/client.d.ts',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/PROVENANCE.md',
  'package/LICENSE',
  'package/assets/pet/calm.webp',
];

/** 服务端 tarball 里必须出现的条目（无前缀，直接以仓根为根）。 */
const SERVER_REQUIRED = [
  'package.json',
  'package-lock.json',
  'src/main.ts',
  'mcp/profile.cordis.yml',
  'LICENSE',
];

function normalizeEntries(entries) {
  return String(entries ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter((entry) => entry !== '' && !entry.endsWith('/'));
}

/** `tar -tzf` 当然也可以传字符串数组；这里统一接受两种形态。 */
function toEntryList(entries) {
  return Array.isArray(entries) ? normalizeEntries(entries.join('\n')) : normalizeEntries(entries);
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * 校验 web tarball 清单。
 *
 * `browser-types/pet-*.d.ts` 是历史构建残留：`tsconfig.browser-types.json` 已把
 * include 收窄到四个文件，但旧 `lib/` 没清干净时它们仍会被 `files: ["lib"]` 带上。
 */
export function validateWebTarballEntries(entries) {
  const list = toEntryList(entries);
  const set = new Set(list);
  const missing = WEB_REQUIRED.filter((entry) => !set.has(entry));
  const forbidden = [];
  for (const entry of list) {
    if (!entry.startsWith('package/')) {
      uniquePush(forbidden, entry);
      continue;
    }
    const rel = entry.slice('package/'.length);
    const reason = isForbiddenBundleEntry(rel);
    if (reason !== null) {
      uniquePush(forbidden, entry);
      continue;
    }
    if (/^lib\/browser-types\/pet-[^/]*\.d\.ts$/.test(rel)) {
      uniquePush(forbidden, entry);
      continue;
    }
    if (rel.startsWith('tests/') || rel.startsWith('demo/')) {
      uniquePush(forbidden, entry);
    }
  }
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

/** 校验服务端 tarball 清单。 */
export function validateServerTarballEntries(entries) {
  const list = toEntryList(entries);
  const set = new Set(list);
  const missing = SERVER_REQUIRED.filter((entry) => !set.has(entry));
  const forbidden = [];
  for (const entry of list) {
    if (isForbiddenBundleEntry(entry) !== null) uniquePush(forbidden, entry);
  }
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

/**
 * 标准 `sha256sum` 文本：`<sha256>  <filename>\n`，按文件名字典序。
 *
 * 两个空格是格式的一部分 —— `sha256sum -c` 认它，Release 里贴出来也好看。
 */
export function formatSha256Sums(items) {
  const rows = [...items]
    .map((item) => ({ file: String(item.file), sha256: String(item.sha256) }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return rows.map((item) => `${item.sha256}  ${item.file}\n`).join('');
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function listTarEntries(file) {
  return execFileSync('tar', ['-tzf', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split(/\r?\n/);
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function quoteWindowsArg(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 调 npm。Windows 上 `npm` 是 `.cmd`，`execFile` 不能直接执行它 ——
 * 必须经 shell；顺带把带空格的路径（临时目录、仓库路径）引起来。
 */
function runNpm(args, cwd) {
  if (process.platform !== 'win32') {
    run('npm', args, cwd);
    return;
  }
  const line = ['npm', ...args].map(quoteWindowsArg).join(' ');
  execSync(line, { cwd, stdio: 'inherit' });
}

/** 真包离线加载冒烟：装 tarball → `import` → 检查导出。 */
function installSmoke(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-web-smoke-'));
  try {
    runNpm(['init', '-y'], dir);
    runNpm(['install', '--no-audit', '--no-fund', '--omit=peer', tarball], dir);
    const code =
      "import * as m from 'dsh-voice-web';" +
      " if (typeof m.apply !== 'function' || m.name !== 'voice-web')" +
      " throw new Error('bad export');" +
      " console.log('dsh-voice-web 冒烟通过：apply=' + typeof m.apply + ', name=' + m.name);";
    run(process.execPath, ['--input-type=module', '-e', code], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const outIndex = args.indexOf('--out-dir');
  const versionIndex = args.indexOf('--version');
  return {
    outDir: outIndex === -1 ? undefined : args[outIndex + 1],
    version: versionIndex === -1 ? undefined : args[versionIndex + 1],
    skipInstallSmoke: args.includes('--skip-install-smoke'),
  };
}

function report(label, result) {
  if (result.missing.length > 0) {
    process.stderr.write(`${label} 缺少：\n  ${result.missing.join('\n  ')}\n`);
  }
  if (result.forbidden.length > 0) {
    process.stderr.write(`${label} 含禁区：\n  ${result.forbidden.join('\n  ')}\n`);
  }
}

function runCli({ outDir, version: expectedVersion, skipInstallSmoke }) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const webDir = join(repoRoot, 'packages', 'dsh-voice-web');
  const webPkg = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8'));
  const version = String(webPkg.version ?? '');
  if (!version) throw new Error('packages/dsh-voice-web/package.json 缺少 version');
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new Error(`--version ${expectedVersion} 与 web 包版本 ${version} 不一致`);
  }
  if (!outDir) throw new Error('缺少 --out-dir');

  const absOut = resolve(outDir);
  mkdirSync(absOut, { recursive: true });

  // 先清 lib：否则上一轮的产物会被 `files: ["lib"]` 原样带进 tarball。
  rmSync(join(webDir, 'lib'), { recursive: true, force: true });
  // 必须把 cwd 切到 webDir：npm 11 在 cwd=仓库根时 `--prefix` 对 `pack` 不生效，
  // 会把根包打成 dsh-pet-wearable-*.tgz。
  runNpm(['run', 'build'], webDir);
  runNpm(['pack', '--pack-destination', absOut], webDir);

  const webTarball = join(absOut, `dsh-voice-web-${version}.tgz`);
  if (!existsSync(webTarball)) {
    throw new Error(`npm pack 没有产出 ${webTarball}`);
  }
  const serverBundle = createServerBundle(
    repoRoot,
    join(absOut, `dsh-pet-wearable-server-${version}.tar.gz`),
  );

  const webResult = validateWebTarballEntries(listTarEntries(webTarball));
  const serverResult = validateServerTarballEntries(listTarEntries(serverBundle.outFile));
  report('dsh-voice-web', webResult);
  report('server bundle', serverResult);
  if (!webResult.ok || !serverResult.ok) {
    throw new Error('发布包清单校验失败');
  }

  if (!skipInstallSmoke) installSmoke(webTarball);

  const sums = formatSha256Sums([
    { file: basename(webTarball), sha256: sha256File(webTarball) },
    { file: basename(serverBundle.outFile), sha256: serverBundle.sha256 },
  ]);
  writeFileSync(join(absOut, 'SHA256SUMS.txt'), sums);

  process.stdout.write(
    `发布包就绪：${absOut}\n` +
      `  dsh-voice-web-${version}.tgz（${webResult.ok ? '清单 OK' : '清单失败'}）\n` +
      `  dsh-pet-wearable-server-${version}.tar.gz（${serverBundle.files.length} 个文件）\n` +
      '  SHA256SUMS.txt\n' +
      sums,
  );
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  try {
    runCli(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `verify-release-pack: error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
