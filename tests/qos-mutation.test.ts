/**
 * 元层守卫：**变异清单还准不准。**
 *
 * 为什么要它：`scripts/mutation-check.py` 会**改写 `src/` 再跑测试** —— 这和
 * `npm test` 的并行执行直接冲突（第一次接进来就撞了：变异体正在改
 * `src/latency-report.ts`，另一个测试文件同时在 import 它，3 秒就红）。
 * 所以真正的变异跑必须是独立命令：
 *
 * ```
 * npm run mutate
 * ```
 *
 * 但那样一来，改判据之后**没人会想起去重跑**，清单就静默过期（匹配点消失 →
 * 变异体被跳过 → 覆盖率虚高）。所以这里留一条**不碰源码**的轻量守卫：
 * 每个变异体的匹配点必须还在，且恰好一处；对照组不能是空操作。
 *
 * 它跑得很快（一次 python 调用），留在 `npm test` 里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('变异清单与源码对得上（不跑变异，只查匹配点）', { timeout: 60_000 }, () => {
  const out = execFileSync('python', [join(root, 'scripts', 'mutation-check.py'), '--verify'], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.match(out, /个变异体的匹配点都在/, `清单过期了：\n${out}`);
});
