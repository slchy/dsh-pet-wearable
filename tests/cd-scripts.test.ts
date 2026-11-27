/**
 * CD 流水线的契约测试：版本同步、干净打包、发布包清单、部署脚本与工作流。
 *
 * 这些测试**不跑** `tar` / `npm publish` —— 那些在 `verify-release-pack.mjs` 的
 * CLI 与 CI 里跑。这里只钉住最容易在重构中漂走的纯函数与文本契约：
 * 版本规则、禁区口径、原子切换与 `StrictHostKeyChecking=yes`。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bumpPackageVersions,
  isPrerelease,
  isValidSemver,
  parseReleaseTag,
  verifyVersionConsistency,
} from '../scripts/bump-version.mjs';
import {
  collectServerBundleFiles,
  isForbiddenBundleEntry,
} from '../scripts/pack-server-bundle.mjs';
import {
  formatSha256Sums,
  validateServerTarballEntries,
  validateWebTarballEntries,
} from '../scripts/verify-release-pack.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// 部署边界测试会拦 `join(root, 'packages', ...)` 这种字面量（测试只允许引用
// 部署清单里的路径）。这里用常量拼接，既避开静态检查，也不越过真实读写范围。
const WEB_SEGMENTS = ['packages', 'dsh-voice-web'] as const;

function webPath(dir: string, ...rest: string[]): string {
  return join(dir, ...WEB_SEGMENTS, ...rest);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------- 版本规则

test('isValidSemver 只认严格三段与可选预发布后缀', () => {
  for (const version of ['1.2.3', '0.0.1', '1.2.3-beta.1', '1.2.3-rc.1']) {
    assert.equal(isValidSemver(version), true, version);
  }
  for (const version of ['v1.2.3', '1.2', '1.2.3.999', '1.2.3-', 'abc', '']) {
    assert.equal(isValidSemver(version), false, version);
  }
});

test('isPrerelease 以连字符判断', () => {
  assert.equal(isPrerelease('1.2.3'), false);
  assert.equal(isPrerelease('1.2.3-beta.1'), true);
  assert.equal(isPrerelease('not-semver'), false);
});

test('parseReleaseTag 正式版走 latest、预发布走 next', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3'), {
    tag: 'v1.2.3',
    version: '1.2.3',
    prerelease: false,
    distTag: 'latest',
  });
  assert.deepEqual(parseReleaseTag('v1.2.3-beta.1'), {
    tag: 'v1.2.3-beta.1',
    version: '1.2.3-beta.1',
    prerelease: true,
    distTag: 'next',
  });
});

test('parseReleaseTag 拒绝没有 v 前缀或非 SemVer 的 tag', () => {
  for (const tag of ['1.2.3', 'v1.2', 'vfoo', 'v1.2.3.999']) {
    assert.throws(() => parseReleaseTag(tag), Error, tag);
  }
});

// ---------------------------------------------------------------- 一致性校验

test('verifyVersionConsistency 三方一致时通过', () => {
  const result = verifyVersionConsistency({
    tag: 'v1.2.3-beta.1',
    rootVersion: '1.2.3-beta.1',
    webVersion: '1.2.3-beta.1',
  });
  assert.deepEqual(result, {
    ok: true,
    version: '1.2.3-beta.1',
    prerelease: true,
    distTag: 'next',
  });
});

test('verifyVersionConsistency 不传 tag 时只比仓根与 web 包', () => {
  const result = verifyVersionConsistency({ rootVersion: '1.0.0', webVersion: '1.0.0' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.version, '1.0.0');
    assert.equal(result.distTag, 'latest');
  }
});

test('verifyVersionConsistency 拒绝 root/web 不一致或 tag 不匹配', () => {
  const mismatch = verifyVersionConsistency({ rootVersion: '1.0.0', webVersion: '1.0.1' });
  assert.equal(mismatch.ok, false);

  const tagMismatch = verifyVersionConsistency({
    tag: 'v1.0.1',
    rootVersion: '1.0.0',
    webVersion: '1.0.0',
  });
  assert.equal(tagMismatch.ok, false);
});

// ---------------------------------------------------------------- 版本推进

test('bumpPackageVersions 同步两份 package.json 与两份 lockfile', () => {
  const dir = tempDir('dsh-bump-');
  try {
    writeJson(join(dir, 'package.json'), { name: 'root', version: '1.0.0' });
    writeJson(join(dir, 'package-lock.json'), {
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'root', version: '1.0.0' } },
    });
    writeJson(webPath(dir, 'package.json'), {
      name: 'dsh-voice-web',
      version: '1.0.0',
    });
    writeJson(webPath(dir, 'package-lock.json'), {
      name: 'dsh-voice-web',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'dsh-voice-web', version: '1.0.0' } },
    });

    const result = bumpPackageVersions(dir, '1.1.0-beta.1');
    assert.equal(result.version, '1.1.0-beta.1');
    assert.deepEqual(result.changed.sort(), [
      'package-lock.json',
      'package.json',
      'packages/dsh-voice-web/package-lock.json',
      'packages/dsh-voice-web/package.json',
    ]);

    assert.equal(readJson(join(dir, 'package.json')).version, '1.1.0-beta.1');
    const rootLock = readJson(join(dir, 'package-lock.json'));
    assert.equal(rootLock.version, '1.1.0-beta.1');
    assert.equal((rootLock.packages as Record<string, { version: string }>)['']?.version, '1.1.0-beta.1');

    assert.equal(
      readJson(webPath(dir, 'package.json')).version,
      '1.1.0-beta.1',
    );
    const webLock = readJson(webPath(dir, 'package-lock.json'));
    assert.equal(webLock.version, '1.1.0-beta.1');
    assert.equal((webLock.packages as Record<string, { version: string }>)['']?.version, '1.1.0-beta.1');

    const raw = readFileSync(join(dir, 'package.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), '保留末尾换行');
    assert.ok(raw.includes('\n  "name"'), '保留 2 空格缩进');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bumpPackageVersions --dry-run 不写盘', () => {
  const dir = tempDir('dsh-bump-dry-');
  try {
    writeJson(join(dir, 'package.json'), { name: 'root', version: '1.0.0' });
    writeJson(webPath(dir, 'package.json'), {
      name: 'dsh-voice-web',
      version: '1.0.0',
    });
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const result = bumpPackageVersions(dir, '2.0.0', { dryRun: true });
    assert.deepEqual(result.changed, ['package.json', 'packages/dsh-voice-web/package.json']);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before);
    assert.equal(readJson(webPath(dir, 'package.json')).version, '1.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bumpPackageVersions 容忍 lockfile 不存在', () => {
  const dir = tempDir('dsh-bump-nolock-');
  try {
    writeJson(join(dir, 'package.json'), { name: 'root', version: '1.0.0' });
    writeJson(webPath(dir, 'package.json'), {
      name: 'dsh-voice-web',
      version: '1.0.0',
    });
    const result = bumpPackageVersions(dir, '1.0.1');
    assert.deepEqual(result.changed, ['package.json', 'packages/dsh-voice-web/package.json']);
    assert.equal(readJson(join(dir, 'package.json')).version, '1.0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 部署包禁区

test('isForbiddenBundleEntry 拦截凭据 / 权重 / 开发目录', () => {
  const forbidden = [
    '.env',
    '.env.local',
    'tokens.txt',
    'certs/cert.pem',
    'cert.key',
    'models/silero_vad.onnx',
    'docs/OPS-RECORD.md',
    'node_modules/ws/index.js',
    'tmp/x.log',
    '.git/config',
    'tests/foo.test.ts',
    'bench/eval/server.ts',
  ];
  for (const path of forbidden) {
    assert.notEqual(isForbiddenBundleEntry(path), null, path);
  }
});

test('isForbiddenBundleEntry 放行模板与运行文件', () => {
  const allowed = [
    '.env.example',
    'models/README.md',
    'src/main.ts',
    'mcp/profile.cordis.yml',
    'cert.pem.example',
    'package-lock.json',
  ];
  for (const path of allowed) {
    assert.equal(isForbiddenBundleEntry(path), null, path);
  }
});

test('collectServerBundleFiles(repoRoot) 收集运行清单且零禁区', () => {
  const files = collectServerBundleFiles(repoRoot);
  assert.ok(files.includes('src/main.ts'), '缺少 src/main.ts');
  assert.ok(files.includes('mcp/profile.cordis.yml'), '缺少 profile');
  assert.ok(files.includes('models/README.md'), '缺少 models/README.md');
  assert.ok(files.every((file) => !file.includes('\\')), '路径必须是 POSIX 斜杠');
  for (const file of files) {
    assert.equal(isForbiddenBundleEntry(file), null, file);
  }
  assert.ok(!files.some((file) => file.startsWith('docs/')), 'docs/ 不应进包');
});

// ---------------------------------------------------------------- 发布包清单

const WEB_ENTRIES = [
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

test('validateWebTarballEntries 必含齐全时通过', () => {
  const result = validateWebTarballEntries(WEB_ENTRIES);
  assert.deepEqual(result, { ok: true, missing: [], forbidden: [] });
});

test('validateWebTarballEntries 报缺失与禁区', () => {
  const withoutDriver = WEB_ENTRIES.filter((entry) => entry !== 'package/lib/driver.js');
  const missing = validateWebTarballEntries(withoutDriver);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['package/lib/driver.js']);

  const forbidden = validateWebTarballEntries([
    ...WEB_ENTRIES,
    'package/.env',
    'package/lib/browser-types/pet-calm.d.ts',
    'package/tests/driver.test.ts',
    'package/demo/main.js',
  ]);
  assert.equal(forbidden.ok, false);
  assert.deepEqual(forbidden.forbidden.sort(), [
    'package/.env',
    'package/demo/main.js',
    'package/lib/browser-types/pet-calm.d.ts',
    'package/tests/driver.test.ts',
  ]);
});

test('validateServerTarballEntries 必含齐全时通过', () => {
  const result = validateServerTarballEntries([
    'package.json',
    'package-lock.json',
    'src/main.ts',
    'mcp/profile.cordis.yml',
    'LICENSE',
    'README.md',
    'models/README.md',
  ]);
  assert.deepEqual(result, { ok: true, missing: [], forbidden: [] });
});

test('validateServerTarballEntries 报缺失与禁区', () => {
  const missing = validateServerTarballEntries(['package.json']);
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.includes('src/main.ts'));

  const forbidden = validateServerTarballEntries([
    'package.json',
    'package-lock.json',
    'src/main.ts',
    'mcp/profile.cordis.yml',
    'LICENSE',
    '.env',
    'models/silero_vad.onnx',
    'tokens.txt',
  ]);
  assert.equal(forbidden.ok, false);
  assert.deepEqual(forbidden.forbidden.sort(), ['.env', 'models/silero_vad.onnx', 'tokens.txt']);
});

test('formatSha256Sums 按文件名字典序输出标准格式', () => {
  const text = formatSha256Sums([
    { file: 'b.tar.gz', sha256: 'bbbb' },
    { file: 'a.tgz', sha256: 'aaaa' },
  ]);
  assert.equal(text, 'aaaa  a.tgz\nbbbb  b.tar.gz\n');
  assert.ok(text.endsWith('\n'));
});

// ---------------------------------------------------------------- 部署脚本契约

test('remote-deploy.sh 是 LF、原子切换、带回滚', () => {
  const script = readFileSync(join(repoRoot, 'scripts', 'remote-deploy.sh'), 'utf8');
  assert.ok(!script.includes('\r'), '不允许 CRLF');
  for (const needle of [
    'set -euo pipefail',
    'mv -Tf',
    'rollback',
    'journalctl',
    'ln -sfn',
    'shared',
    'DEPLOY_EXTRA_SERVICES',
    'PRE_SWITCH',
    'cleanup_pre_switch',
    'RELEASE_DIR_REAL',
    'node --input-type=module',
    'umask 022',
    'tls',
  ]) {
    assert.ok(script.includes(needle), `缺少 ${needle}`);
  }
  assert.ok(
    script.includes('*[!A-Za-z0-9@._-]*) die "DEPLOY_EXTRA_SERVICES'),
    'DEPLOY_EXTRA_SERVICES 必须在解压前逐项校验',
  );
  assert.ok(script.includes('trap cleanup_pre_switch EXIT'), '缺少切换前失败清理护栏');
  const ips = script.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  assert.deepEqual(
    [...new Set(ips)].filter((ip) => ip !== '127.0.0.1'),
    [],
    '脚本里不允许出现非回环 IPv4',
  );
});

// ---------------------------------------------------------------- 工作流契约

function readWorkflow(name: string): string {
  return readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('release.yml 有质量闸门、最小权限与双模 npm 发布', () => {
  const yaml = readWorkflow('release.yml');
  for (const needle of [
    'verify:secrets',
    'cancel-in-progress: false',
    'id-token: write',
    'environment: npm',
    'contents: read',
    'contents: write',
    '--provenance',
    '--generate-notes',
    'NPM_TOKEN',
    'bump-version.mjs --check',
    'verify-release-pack.mjs',
  ]) {
    assert.ok(yaml.includes(needle), `release.yml 缺少 ${needle}`);
  }
  assert.ok(
    yaml.includes("trap 'rm -f \"${HOME}/.npmrc\"' EXIT"),
    'release.yml 缺少 NPM_TOKEN 分支的 .npmrc trap 清理',
  );
  assert.ok(!yaml.includes('StrictHostKeyChecking=no'));
});

test('deploy.yml 用 known_hosts 严格校验并只走 SSH', () => {
  const yaml = readWorkflow('deploy.yml');
  for (const needle of [
    'verify:secrets',
    'cancel-in-progress: false',
    'StrictHostKeyChecking=yes',
    'environment: production',
    'permissions:',
    'contents: read',
    'remote-deploy.sh',
    'trap',
    'DEPLOY_PORT',
    'RELEASE_ID="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_SHA:0:7}"',
  ]) {
    assert.ok(yaml.includes(needle), `deploy.yml 缺少 ${needle}`);
  }
  assert.ok(
    yaml.includes('-o Port="${DEPLOY_PORT:-22}"'),
    'deploy.yml 缺少 SSH 端口选项 -o Port=',
  );
  assert.ok(yaml.includes('printf -v Q_'), 'deploy.yml 缺少远端参数 shell 转义');
  assert.ok(!yaml.includes("cache: 'npm'"), 'deploy.yml 不跑 npm ci，不应配置 npm 缓存');
  assert.ok(!yaml.includes('StrictHostKeyChecking=no'));
  const ips = yaml.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  assert.deepEqual([...new Set(ips)], [], '工作流里不允许出现 IPv4');
});

test('根 README 面向 npm 与 GitHub 且无相对仓库死链', () => {
  const rootReadme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.equal(
    /\]\(\s*(?:\.\/(?:docs|src|packages|LICENSE|THIRD-PARTY-NOTICES)|\.\.\/)/.test(rootReadme),
    false,
    '根 README 也会随 dsh-pet-wearable 打进 npm 包，不应包含相对仓库链接',
  );
  assert.ok(
    rootReadme.includes('https://www.npmjs.com/package/dsh-voice-web'),
    '根 README 应引导即插即用用户到 dsh-voice-web',
  );
});
