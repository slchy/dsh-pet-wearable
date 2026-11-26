/**
 * 根 `tests/*.test.ts` 只能引用 deploy_cloud.py ITEMS 里的路径。
 * `bench/` 与 `packages/` 不在清单里，服务器自检会模块找不到。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** 从 `tests/` 解析 `../…`。越出仓库根返回 null。 */
function repoPath(spec: string): string | null {
  const parts = ['tests'];
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

function allowedSpec(spec: string): boolean {
  const rel = repoPath(spec);
  if (rel === null || rel === '') return false;
  if (ALLOWED_FILES.has(rel)) return true;
  const top = rel.split('/')[0];
  return top !== undefined && ALLOWED_DIRS.has(top);
}

export function findBoundaryViolations(source: string, fileName: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  const specRes = [
    /\b(?:from|import)\s*\(?\s*['"](\.\.[\\/][^'"]+)['"]/g,
    /new\s+URL\(\s*['"](\.\.[\\/][^'"]+)['"]/g,
  ];
  for (const re of specRes) {
    for (const match of code.matchAll(re)) {
      const spec = match[1];
      if (spec !== undefined && !allowedSpec(spec)) violations.push(`${fileName}: ${spec}`);
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

test('tests/*.test.ts 不越出部署清单', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const violations: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.ts') || name === 'deploy-boundary.test.ts') continue;
    violations.push(...findBoundaryViolations(readFileSync(join(dir, name), 'utf8'), name));
  }
  assert.deepEqual(violations, []);
});
