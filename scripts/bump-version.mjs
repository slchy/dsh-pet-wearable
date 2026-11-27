#!/usr/bin/env node
/**
 * 版本推进与一致性校验：仓根 `package.json`、`packages/dsh-voice-web/package.json`
 * 与两份 lockfile 的版本必须一起动。
 *
 * 为什么收在一个零依赖脚本里：发布工作流的 `gate` 要先**校验** tag 与仓内版本一致，
 * 人本地又要能一条命令**推进**版本。两份逻辑分家时，tag 打错一个数字只会在
 * `npm publish` 那一步才炸 —— 那时 Release 附件和部署包可能已经发出去了。
 *
 * 约定：
 *
 * - 版本只认严格 SemVer（`1.2.3` / `1.2.3-beta.1`），不认 `v` 前缀；
 * - tag 只认 `v` 前缀的 SemVer，非法直接抛错，不做「猜一个最接近的」；
 * - 预发布走 `next` dist-tag，正式版走 `latest` —— 两者混用会把 beta 推成
 *   `npm install dsh-voice-web` 的默认版本；
 * - lockfile 只改顶层 `version` 与 `packages[""].version`，不动依赖树。
 *
 * 导入本模块不会产生副作用；CLI 只在主模块直接执行时运行。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ROOT_PACKAGE = 'package.json';
const WEB_PACKAGE = 'packages/dsh-voice-web/package.json';
const ROOT_LOCK = 'package-lock.json';
const WEB_LOCK = 'packages/dsh-voice-web/package-lock.json';

/** 严格 SemVer：三段数字 + 可选预发布后缀。 */
export function isValidSemver(version) {
  return typeof version === 'string' && SEMVER_RE.test(version);
}

/** 含 `-` 即预发布。`isValidSemver` 已排除其它形态。 */
export function isPrerelease(version) {
  return isValidSemver(version) && version.includes('-');
}

/**
 * `v1.2.3-beta.1` → `{ tag, version, prerelease, distTag }`。非法抛错。
 *
 * `distTag` 是发布目标：预发布只能进 `next`，否则 `npm install` 默认版本
 * 会被一个 beta 顶掉。
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`发布 tag 必须以 v 开头（收到 "${String(tag)}"）`);
  }
  const version = tag.slice(1);
  if (!isValidSemver(version)) {
    throw new Error(`发布 tag 不是合法 SemVer："${tag}"（示例 v1.2.3 / v1.2.3-beta.1）`);
  }
  const prerelease = isPrerelease(version);
  return { tag, version, prerelease, distTag: prerelease ? 'next' : 'latest' };
}

/**
 * 校验 tag（可选）与仓根 / web 包版本三方一致。
 *
 * 不传 tag 时只校验两份 `package.json` 彼此一致（`npm run verify:release`
 * 这类本地检查用）。
 */
export function verifyVersionConsistency({ tag, rootVersion, webVersion }) {
  if (!isValidSemver(rootVersion)) {
    return { ok: false, error: `仓根版本不是合法 SemVer："${String(rootVersion)}"` };
  }
  if (!isValidSemver(webVersion)) {
    return { ok: false, error: `dsh-voice-web 版本不是合法 SemVer："${String(webVersion)}"` };
  }
  if (rootVersion !== webVersion) {
    return {
      ok: false,
      error: `仓根版本 ${rootVersion} 与 dsh-voice-web 版本 ${webVersion} 不一致`,
    };
  }
  let version = rootVersion;
  if (tag !== undefined && tag !== null && tag !== '') {
    let parsed;
    try {
      parsed = parseReleaseTag(tag);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (parsed.version !== rootVersion) {
      return {
        ok: false,
        error: `tag ${tag} 指向 ${parsed.version}，但仓内版本是 ${rootVersion}`,
      };
    }
    version = parsed.version;
  }
  const prerelease = isPrerelease(version);
  return {
    ok: true,
    version,
    prerelease,
    distTag: prerelease ? 'next' : 'latest',
  };
}

function readJson(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${absPath} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function toPosix(relPath) {
  return relPath.split('\\').join('/');
}

/**
 * 同步推进两份 `package.json` 与（存在的）两份 lockfile。
 *
 * 保留 2 空格缩进与末尾换行；内容没变的文件不重写，避免无意义的 git 噪声。
 * 返回实际发生变化（或 dry-run 下将会变化）的相对路径。
 */
export function bumpPackageVersions(repoDir, nextVersion, { dryRun = false } = {}) {
  if (!isValidSemver(nextVersion)) {
    throw new Error(`目标版本不是合法 SemVer："${String(nextVersion)}"`);
  }
  const targets = [
    {
      rel: ROOT_PACKAGE,
      apply(json) {
        json.version = nextVersion;
      },
    },
    {
      rel: WEB_PACKAGE,
      apply(json) {
        json.version = nextVersion;
      },
    },
    {
      rel: ROOT_LOCK,
      apply(json) {
        json.version = nextVersion;
        if (json.packages && typeof json.packages === 'object' && json.packages['']) {
          json.packages[''].version = nextVersion;
        }
      },
    },
    {
      rel: WEB_LOCK,
      apply(json) {
        json.version = nextVersion;
        if (json.packages && typeof json.packages === 'object' && json.packages['']) {
          json.packages[''].version = nextVersion;
        }
      },
    },
  ];

  const changed = [];
  for (const target of targets) {
    const abs = join(repoDir, ...target.rel.split('/'));
    if (!existsSync(abs)) continue;
    const original = readFileSync(abs, 'utf8');
    const json = readJson(abs);
    target.apply(json);
    const next = `${JSON.stringify(json, null, 2)}\n`;
    if (next === original) continue;
    changed.push(target.rel);
    if (!dryRun) writeFileSync(abs, next);
  }
  return { version: nextVersion, changed };
}

function repoRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function printGithubOutput(result) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(
    file,
    `version=${result.version}\nprerelease=${result.prerelease ? 'true' : 'false'}\ndist_tag=${result.distTag}\n`,
  );
}

function runCheck({ tag, json }) {
  const repoDir = repoRootFromScript();
  const rootVersion = readJson(join(repoDir, ROOT_PACKAGE)).version;
  const webVersion = readJson(join(repoDir, ...WEB_PACKAGE.split('/'))).version;
  const result = verifyVersionConsistency({ tag, rootVersion, webVersion });
  if (!result.ok) {
    process.stderr.write(`bump-version: ${result.error}\n`);
    return 1;
  }
  printGithubOutput(result);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        version: result.version,
        prerelease: result.prerelease,
        distTag: result.distTag,
      })}\n`,
    );
  } else {
    process.stdout.write(
      `版本一致：${result.version}（${result.prerelease ? '预发布' : '正式版'}，dist-tag=${result.distTag}）\n`,
    );
  }
  return 0;
}

function runBump({ nextVersion, dryRun }) {
  const repoDir = repoRootFromScript();
  if (!nextVersion) {
    process.stderr.write('用法：node scripts/bump-version.mjs <nextVersion> [--dry-run]\n');
    process.stderr.write('      node scripts/bump-version.mjs --check [vX.Y.Z] [--json]\n');
    return 1;
  }
  const result = bumpPackageVersions(repoDir, nextVersion, { dryRun });
  if (result.changed.length === 0) {
    process.stdout.write(`版本已经是 ${nextVersion}，无需改动\n`);
    return 0;
  }
  process.stdout.write(
    `${dryRun ? '（dry-run，未写盘）将更新' : '已更新'}：${result.changed.join(', ')}\n`,
  );
  if (dryRun) return 0;
  process.stdout.write(
    [
      '后续：',
      `  git add ${ROOT_PACKAGE} ${WEB_PACKAGE} ${ROOT_LOCK} ${WEB_LOCK}`,
      `  git commit -m "release: v${nextVersion}"`,
      `  git tag v${nextVersion}`,
      '  git push origin main --follow-tags',
      '',
    ].join('\n'),
  );
  return 0;
}

/** 极简参数解析：只有 `--check` / `--json` / `--dry-run` 与一个位置参数。 */
function parseArgs(argv) {
  const args = [...argv];
  if (args.includes('--check')) {
    const rest = args.filter((arg) => arg !== '--check');
    const json = rest.includes('--json');
    const tag = rest.find((arg) => !arg.startsWith('--'));
    return { mode: 'check', tag, json };
  }
  const dryRun = args.includes('--dry-run');
  const nextVersion = args.find((arg) => !arg.startsWith('--'));
  return { mode: 'bump', nextVersion, dryRun };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = options.mode === 'check' ? runCheck(options) : runBump(options);
  } catch (error) {
    process.stderr.write(
      `bump-version: error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
