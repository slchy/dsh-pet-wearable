/**
 * L1：跨参数不变量 —— 这是唯一能进 CI 的延迟保护。
 *
 * 每个模块的单测只守自己（「`VOICE_COMMIT_MS` 读到 20 了吗」），这一份守的是
 * **两个模块之间**的关系：改了一个数，另一个会静默失效的那类。
 *
 * 典型例子：把 `VOICE_COMMIT_MS` 调大到超过 `VOICE_SPECULATE_MS`，投机就会
 * 拿还没定稿的中间结果去认领 —— 没有任何单测会红，因为两个模块各自都对。
 *
 * 检查逻辑在 `scripts/time-knobs.py --check`（和参数总表共用同一个扫描器，
 * 所以测的是**源码里真正会上线的值**，不是文档里抄的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 跑 `--check`，返回 stdout/stderr/退出码 */
function check(): { code: number; out: string } {
  try {
    const out = execFileSync('python', [join(root, 'scripts', 'time-knobs.py'), '--check'], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('跨参数不变量全部成立', { timeout: 30_000 }, () => {
  const { code, out } = check();
  assert.equal(code, 0, `不变量被破坏了：\n${out}`);
  assert.match(out, /条不变量全部成立/);
});

test('不变量检查真的会失败（不是永远绿的摆设）', { timeout: 30_000 }, () => {
  // 这条是元测试：注入一个必然违反的关系，确认检查器能红。
  // 没有它，上面那条「全部成立」有可能只是检查器根本什么都没查。
  const violated = execFileSync(
    'python',
    [
      '-c',
      [
        'import sys, importlib.util as u',
        'spec = u.spec_from_file_location("time_knobs", "scripts/time-knobs.py")',
        'm = u.module_from_spec(spec)',
        // 必须先注册再 exec：`@dataclass` 会去 sys.modules 里找自己的模块
        'sys.modules["time_knobs"] = m',
        'spec.loader.exec_module(m)',
        'knobs = m.scan()',
        'hit = False',
        'for k in knobs:',
        '    if k.name == "VOICE_SPECULATE_MS":',
        '        k.default = "5000"  # 投机调到判停预跑之后：提前量白丢',
        '        hit = True',
        'assert hit, "没扫到 VOICE_SPECULATE_MS，扫描器坏了"',
        'fails, _ = m.check_invariants(knobs)',
        'print(len(fails))',
        'print(fails[0] if fails else "")',
      ].join('\n'),
    ],
    { cwd: root, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  );
  const [count, first] = violated.trim().split('\n');
  assert.ok(Number(count) >= 1, `注入违反后应该有失败项，实际：${violated}`);
  assert.match(String(first), /VOICE_SPECULATE_MS/, '应该点名是哪个参数');
  assert.match(String(first), /提前量/, '应该说明后果，而不只是「不成立」');
});
