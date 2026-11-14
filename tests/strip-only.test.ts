/**
 * 守卫：`src/` 与 `tests/` 里每个 `.ts` 都必须能被 Node 的 strip-only 模式吃掉。
 *
 * 为什么需要这条：`tsc --noEmit` **不报**「参数属性 / enum / namespace」这类语法，
 * 但 Node 直接跑 `.ts` 时只擦类型、不做代码生成，遇到它们会
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 当场崩 —— 而且是在**运行时**第一次 import 才崩。
 *
 * 2026-11-14 真的踩过一次：`class TokenGate { constructor(private readonly path: string) {} }`
 * 通过了 typecheck 和全部单测（单测没 import 到那一行），直到跑 CLI 才炸。
 *
 * 用 `module.stripTypeScriptTypes` 做：它只解析+擦除，**不执行**模块，
 * 所以入口文件（`main.ts` 会自己 `main()`）也是安全的。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }
      out.push(...collect(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('每个 .ts 都能被 strip-only 模式处理（Node 直接跑得起来）', () => {
  const files = [...collect(join(ROOT, 'src')), ...collect(join(ROOT, 'tests'))];
  assert.ok(files.length > 30, `扫到的文件太少（${files.length}），路径解析可能错了：${ROOT}`);

  const broken: string[] = [];
  for (const file of files) {
    try {
      stripTypeScriptTypes(readFileSync(file, 'utf8'));
    } catch (error) {
      broken.push(`${file.slice(ROOT.length)}: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  assert.deepEqual(broken, [], `这些文件 Node 跑不起来（tsc 不报）：\n${broken.join('\n')}`);
});
