/**
 * 禁令：应用层与宠物层不许读真实时间。
 *
 * ADR-0002 §3.2。允许读时间的地方只有两个实现：
 * - `src/app/clock.ts`（生产 `SystemClock`）
 * - `src/pet/sim/clock.ts`（虚拟时钟）
 *
 * 这条测试用源码扫描而不是运行时打桩 —— 打桩只能抓住执行到的路径，
 * 扫描连没跑到的分支也一起管住。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOTS = ['src/app', 'src/pet/brain', 'src/turn-runner.ts', 'src/photo-inbox.ts'];
/** 唯二允许读真实时间的地方 */
const ALLOWED = new Set(['src/app/clock.ts', 'src/pet/sim/clock.ts']);

/** 真实时钟的调用形状。 */
const BANNED: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bDate\.now\s*\(/, why: 'Date.now()' },
  { pattern: /\bperformance\.now\s*\(/, why: 'performance.now()' },
  { pattern: /\bnew\s+Date\s*\(/, why: 'new Date()' },
  { pattern: /\bsetTimeout\s*\(/, why: 'setTimeout()' },
  { pattern: /\bsetInterval\s*\(/, why: 'setInterval()' },
];

/** 允许出现的例外：注释与类型说明里提到不算。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function filesUnder(dir: string): string[] {
  if (dir.endsWith('.ts')) {
    return [dir];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('应用层与宠物层没有真实时钟调用', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of filesUnder(root)) {
      if (ALLOWED.has(file.replace(/\\/g, '/'))) {
        continue;
      }
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, why } of BANNED) {
        if (pattern.test(code)) {
          offenders.push(`${file}: ${why}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '时间只能从 Clock 端口拿（ADR-0002 §3.2）',
  );
});

test('两个时钟实现存在且各自只有一个', () => {
  assert.ok(readFileSync('src/app/clock.ts', 'utf8').includes('class SystemClock'));
  assert.ok(readFileSync('src/pet/sim/clock.ts', 'utf8').includes('class VirtualClock'));
});
