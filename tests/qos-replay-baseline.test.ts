/**
 * L3：回放基线的**比对器**必须真的会红。
 *
 * 基线本身要跑服务器才能量（`run.py --baseline`，约 3 分钟），进不了 CI。
 * 但「比对逻辑会不会漏判」可以进 —— 而它恰恰是最容易写出假绿的地方：
 * 容差写成 1e9、字段名拼错、`None` 全被跳过，都会让基线永远通过。
 *
 * 所以这里做四件事：
 * 1. 基线文件自身完整（有向量、有配置、轮数与汇总对得上）；
 * 2. 拿基线跟**自己**比 → 必须通过；
 * 3. 注入四种漂移 → 必须逐条点名；
 * 4. ③（a3）变了 → **必须不报**（它含厂商合成长尾，判它等于抛硬币）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'bench', 'replay', 'baseline');

const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
const baselinePath = join(dir, files[0] ?? '');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as {
  vector: string;
  turns: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
};

/** 在 Python 里加载 run.py，拿它的比对函数跑一遍（避免在 TS 里重写一套口径） */
function compare(mutate: string): string[] {
  const out = execFileSync(
    'python',
    [
      '-c',
      [
        'import importlib.util as u, json, sys',
        'spec = u.spec_from_file_location("rr", "bench/replay/run.py")',
        'm = u.module_from_spec(spec)',
        'sys.modules["rr"] = m',
        'spec.loader.exec_module(m)',
        `base = json.load(open(${JSON.stringify(baselinePath)}, encoding="utf-8"))`,
        'now = json.loads(json.dumps(base))  # 深拷贝，改动不影响基线',
        mutate,
        'for p in m.compare_baseline(base, now):',
        '    print(p)',
      ].join('\n'),
    ],
    { cwd: root, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  );
  return out.split('\n').filter((l) => l.trim() !== '');
}

test('基线文件自带「哪个工作点」和配置快照', () => {
  assert.ok(files.length > 0, '仓库里至少要有一份基线');
  assert.match(baseline.vector, /^\d{8}-\d{6}$/, '文件名/字段只用时间戳，不含设备地址');
  assert.ok(Array.isArray(baseline.turns) && baseline.turns.length > 0);
  assert.equal(baseline.turns.length, baseline.summary.turns, '轮数要与汇总对得上');
  assert.ok('config' in baseline, '基线必须带配置快照 —— 否则换个配置比对全红也说明不了问题');
});

test('基线跟自己比：必须通过', { timeout: 60_000 }, () => {
  assert.deepEqual(compare('pass'), []);
});

test('① 漂移超容差 → 点名到轮次和差值', { timeout: 60_000 }, () => {
  const problems = compare('now["turns"][0]["a1"] = base["turns"][0]["a1"] + 200');
  assert.equal(problems.length, 1, `应该只报一处：${problems.join(' / ')}`);
  assert.match(problems[0] ?? '', /轮1/);
  assert.match(problems[0] ?? '', /①/);
  assert.match(problems[0] ?? '', /\+200/);
});

test('① 漂移在容差内 → 不报（否则每次都会红）', { timeout: 60_000 }, () => {
  const problems = compare('now["turns"][0]["a1"] = base["turns"][0]["a1"] + 40');
  assert.deepEqual(problems, []);
});

test('ASR 文本变了 → 必须报（同一份音频文本不该变）', { timeout: 60_000 }, () => {
  const problems = compare('now["turns"][0]["asr"] = "完全不同的句子。"');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /ASR 文本变了/);
});

test('车道变了 → 必须报', { timeout: 60_000 }, () => {
  const problems = compare('now["turns"][0]["path"] = "dsh"');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /车道变了/);
});

test('多出一轮（比如半句被切开）→ 必须报', { timeout: 60_000 }, () => {
  const problems = compare(
    'now["turns"].append({**base["turns"][0], "turn": 99})',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /轮99/);
  assert.match(problems[0] ?? '', /被切开的半句/);
});

test('③ 变了 → 不报（含厂商合成长尾，判它等于抛硬币）', { timeout: 60_000 }, () => {
  const problems = compare(
    'now["turns"][0]["a3"] = base["turns"][0]["a3"] + 3000\n'
    + 'now["summary"]["a3_p50"] = "9999"',
  );
  assert.deepEqual(problems, [], '③ 只记录不判定');
});

test('送批次数变了 → 必须报（纯逻辑，不该漂）', { timeout: 60_000 }, () => {
  const problems = compare('now["turns"][0]["batches"] = (base["turns"][0]["batches"] or 2) + 3');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /送批次数变了/);
});
