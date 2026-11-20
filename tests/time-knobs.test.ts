/**
 * `docs/TIME-KNOBS.md` 是**生成物**，这份测试守两件事：
 *
 * 1. 提交的那份与源码一致 —— 改了 `envNumber(...)` 忘了重新生成会红灯。
 *    没有这条，「总表」第一个月就过期，而「配置写 20 ms、实际 75 ms」这类错误
 *    恰恰是过期表的产物。
 * 2. 每一项都标注了「时钟」和「被谁遮住」—— 空着的会被当成待办、写错的会被
 *    当成结论，两者都比它显眼。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const committed = readFileSync(join(root, 'docs', 'TIME-KNOBS.md'), 'utf-8');

/** 跑一次生成器（不写盘），拿到当前源码应有的内容 */
function generate(): string {
  return execFileSync('python', [join(root, 'scripts', 'time-knobs.py')], {
    cwd: root,
    encoding: 'utf-8',
    // Windows 上 python 默认 cp936，中文会乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

test('时间参数总表与源码一致（改了旋钮要重新生成）', { timeout: 30_000 }, () => {
  const expected = generate();
  assert.equal(
    committed.replace(/\r\n/g, '\n').trim(),
    expected.replace(/\r\n/g, '\n').trim(),
    'docs/TIME-KNOBS.md 过期了：跑 `python scripts/time-knobs.py --write`',
  );
});

test('每一项都标了时钟，没有「未标注」', () => {
  // 「缺「时钟」：（无）」是生成器自己写的收尾行，出现具体名字才说明有遗漏
  const line = committed.split('\n').find((l) => l.startsWith('- 缺「时钟」：'));
  assert.ok(line !== undefined, '生成器应该输出「缺时钟」一行');
  assert.ok(!line.includes('`'), `还有没标时钟的项：${line}`);
});

test('每一项都标了「被谁遮住」或明确判为无关首声', () => {
  const line = committed.split('\n').find((l) => l.startsWith('- 缺「被谁遮住」：'));
  assert.ok(line !== undefined, '生成器应该输出「缺被谁遮住」一行');
  assert.ok(!line.includes('`'), `还有没标遮盖关系的项：${line}`);
});

test('封段那一条必须写着「配置值被包长盖住」', () => {
  // 这是这张表存在的理由之一：不写出来的话，下一个人会以为 20 就是 20。
  // 按「行首是参数名」匹配 —— 别的行会在说明里提到 VOICE_COMMIT_MS。
  const row = committed.split('\n').find((l) => l.startsWith('| `VOICE_COMMIT_MS`'));
  assert.ok(row !== undefined, '总表里应该有 VOICE_COMMIT_MS 这一行');
  assert.match(row, /一整个上行包/, `VOICE_COMMIT_MS 那一行要说明真实门槛：${row}`);
});
