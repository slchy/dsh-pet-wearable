/**
 * 根 `tests/` 下（含 `tests/contracts/`）的测试只能引用 deploy_cloud.py ITEMS 里的路径。
 * `bench/` 与 `packages/` 不在清单里，服务器自检会模块找不到。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ALLOWED_DIRS = new Set(['src', 'mcp', 'tools', 'tests', 'scripts']);
const ALLOWED_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'README.md',
  'docs/TIME-KNOBS.md',
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 把 `'tests'` / `'tests/contracts'` / `['tests', 'contracts']` 统一成片段数组。 */
function normalizeBaseDir(baseDir: readonly string[] | string): string[] {
  const parts = typeof baseDir === 'string' ? baseDir.split('/') : [...baseDir];
  return parts.filter((part) => part !== '' && part !== '.');
}

/** 从 `fromParts`（如 `['tests', 'contracts']`）解析 `../…`。越出仓库根返回 null。 */
function repoPath(spec: string, fromParts: readonly string[] = ['tests']): string | null {
  const parts = [...fromParts];
  let above = false;
  for (const part of spec.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) above = true;
      else parts.pop();
      continue;
    }
    if (above) return null;
    parts.push(part);
  }
  if (above) return null;
  return parts.join('/');
}

function allowedSpec(spec: string, fromParts: readonly string[]): boolean {
  const rel = repoPath(spec, fromParts);
  if (rel === null || rel === '') return false;
  if (ALLOWED_FILES.has(rel)) return true;
  const top = rel.split('/')[0];
  return top !== undefined && ALLOWED_DIRS.has(top);
}

/**
 * 找出一个测试文件里越过部署清单的引用。
 *
 * `baseDir` 是测试文件所在目录（相对仓库根，默认 `['tests']`）。
 * `tests/contracts/foo.test.ts` 传 `['tests', 'contracts']`，这样 `../../src/x.ts`
 * 才能解析到 `src/x.ts`，而 `../../bench/x.ts` 会被拦下。
 */
export function findBoundaryViolations(
  source: string,
  fileName: string,
  baseDir: readonly string[] | string = 'tests',
): string[] {
  const fromParts = normalizeBaseDir(baseDir);
  const code = stripComments(source);
  const violations: string[] = [];
  const specRes = [
    /\b(?:from|import)\s*\(?\s*['"](\.\.[\\/][^'"]+)['"]/g,
    /new\s+URL\(\s*['"](\.\.[\\/][^'"]+)['"]/g,
  ];
  for (const re of specRes) {
    for (const match of code.matchAll(re)) {
      const spec = match[1];
      if (spec !== undefined && !allowedSpec(spec, fromParts)) {
        violations.push(`${fileName}: ${spec}`);
      }
    }
  }
  const callRe = /\b(?:join|resolve)\s*\([^)]*['"](bench|packages)['"][^)]*\)/g;
  for (const match of code.matchAll(callRe)) {
    const index = match.index ?? 0;
    const dot = index > 0 && code[index - 1] === '.';
    const pathDot = index >= 5 && code.slice(index - 5, index) === 'path.';
    if (dot && !pathDot) continue;
    violations.push(`${fileName}: ${match[0]}`);
  }
  return violations;
}

/** 递归收集目录下所有 `.ts`（含非 `.test.ts` 的辅助文件）。 */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const bad = [
  `import { x } from '../bench/eval/score.ts';`,
  `import { y } from '../packages/dsh-voice-web/src/bridge.ts';`,
  `readFileSync(new URL('../packages/dsh-voice-web/src/driver.ts', import.meta.url))`,
  `readFileSync(new URL('../docs/OPS-RECORD.md', import.meta.url))`,
  `const dir = join(root, 'bench', 'replay', 'baseline');`,
];

const good = [
  `import { a } from '../src/frame.ts';`,
  `readFileSync(new URL('../docs/TIME-KNOBS.md', import.meta.url))`,
  `import { b } from '../scripts/latency-attribution.ts';`,
  `// comment mentioning ../bench/eval/score.ts`,
  `/* import { x } from '../bench/eval/score.ts'; */`,
];

test('findBoundaryViolations 拒绝清单外路径', () => {
  for (const source of bad) {
    assert.ok(findBoundaryViolations(source, 'fixture.test.ts').length > 0, source);
  }
});

test('findBoundaryViolations 放行清单内路径和注释', () => {
  for (const source of good) {
    assert.deepEqual(findBoundaryViolations(source, 'fixture.test.ts'), [], source);
  }
});

test('findBoundaryViolations 按 tests/contracts 解析相对路径', () => {
  const fromContracts = ['tests', 'contracts'];
  const contractBad = [
    `import { x } from '../../bench/eval/score.ts';`,
    `import { y } from '../../packages/dsh-voice-web/src/bridge.ts';`,
    `readFileSync(new URL('../../packages/dsh-voice-web/src/driver.ts', import.meta.url))`,
  ];
  for (const source of contractBad) {
    assert.ok(
      findBoundaryViolations(source, 'contracts/foo.test.ts', fromContracts).length > 0,
      source,
    );
  }
  assert.deepEqual(
    findBoundaryViolations(
      `import { p } from '../../src/providers.ts';`,
      'contracts/foo.test.ts',
      fromContracts,
    ),
    [],
  );
  assert.deepEqual(
    findBoundaryViolations(
      `import { p } from '../../src/providers.ts';`,
      'contracts/foo.test.ts',
      'tests/contracts',
    ),
    [],
  );
});

test('tests/ 下所有 .ts（含 contracts）不越出部署清单', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const violations: string[] = [];
  for (const full of collectTsFiles(dir)) {
    const rel = relative(dir, full).replace(/\\/g, '/');
    if (rel === 'deploy-boundary.test.ts') continue;
    const base = ['tests', ...rel.split('/').slice(0, -1)];
    violations.push(...findBoundaryViolations(readFileSync(full, 'utf8'), `tests/${rel}`, base));
  }
  assert.deepEqual(violations, []);
});
