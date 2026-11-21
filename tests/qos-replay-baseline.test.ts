/**
 * L3：回放基线的**比对器**必须真的会红 —— 但只红在它该红的地方。
 *
 * 基线本身要跑服务器才能量（`run.py --baseline`，约 5 分钟），进不了 CI。
 * 但「比对逻辑会不会漏判 / 误判」可以进 —— 而它最容易写出假绿：容差写成 1e9、
 * 字段名拼错、`None` 全被跳过，都会让基线永远通过。
 *
 * <h2>这套判据是实测出来的，不是设计的</h2>
 *
 * 第一版按「单次内 MAD 的 2–3 倍」定容差，真机回放一跑 **红 61 处**。改用量出来的
 * 跨次噪声底（同代码同调用 `--repeat 3`）之后，判据整个反过来了：
 *
 * | 字段 | 逐轮跨次极差 p50 | 结论 |
 * |---|---|---|
 * | ① 停嘴→定稿 | 280（p90 1022） | 判不了 |
 * | ② 定稿→开轮 | 2 | 最稳 |
 * | ③ 开轮→首块 | 115（汇总 p50 只差 46） | 汇总可判 |
 *
 * 所以下面每一条都在守**新的**判据：逐轮一律只打印，判定只看汇总。
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
  noise_floor?: Record<string, unknown>;
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

test('基线文件自带「哪个工作点」、配置快照与噪声底', () => {
  assert.ok(files.length > 0, '仓库里至少要有一份基线');
  assert.match(baseline.vector, /^\d{8}-\d{6}$/, '文件名/字段只用时间戳，不含设备地址');
  assert.ok(Array.isArray(baseline.turns) && baseline.turns.length > 0);
  assert.equal(baseline.turns.length, baseline.summary.turns, '轮数要与汇总对得上');
  assert.ok('config' in baseline, '基线必须带配置快照 —— 否则换个配置比对全红也说明不了问题');
  assert.ok('noise_floor' in baseline, '基线要记当时量到的噪声底，容差才有据可查');
});

test('基线跟自己比：必须通过', { timeout: 60_000 }, () => {
  assert.deepEqual(compare('pass'), []);
});

test('轮数差 1 以内不报（跨调用见过 16 与 17）', { timeout: 60_000 }, () => {
  assert.deepEqual(compare('now["summary"]["turns"] = base["summary"]["turns"] - 1'), []);
});

test('轮数塌了（17 → 4）→ 必须报，且点名「半句被切开」', { timeout: 60_000 }, () => {
  const problems = compare('now["summary"]["turns"] = 4');
  assert.equal(problems.length, 1, problems.join(' / '));
  assert.match(problems[0] ?? '', /轮数 17 → 4/);
  assert.match(problems[0] ?? '', /半句被切开/);
});

test('ASR 文本只差 1 轮 → 不报（含停顿那一轮本来就不稳）', { timeout: 60_000 }, () => {
  assert.deepEqual(compare('now["turns"][0]["asr"] = "完全不同。"'), []);
});

test('ASR 文本差 2 轮 → 必须报', { timeout: 60_000 }, () => {
  const problems = compare(
    'now["turns"][0]["asr"] = "甲。"\nnow["turns"][1]["asr"] = "乙。"',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /ASR 文本有 2 轮不一致/);
});

test('车道变了一轮 → 必须报（DELEGATE=0 时应当全是 fast）', { timeout: 60_000 }, () => {
  const problems = compare('now["turns"][0]["path"] = "dsh"');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /车道变了 1 轮/);
});

test('② p50 漂移超容差 → 必须报（它是最稳的字段，漂了就说明判停变了）', { timeout: 60_000 }, () => {
  const problems = compare(
    'now["summary"]["a2_p50"] = str(int(base["summary"]["a2_p50"]) + 60)',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /② p50/);
});

test('③ p50 在容差内 → 不报', { timeout: 60_000 }, () => {
  assert.deepEqual(
    compare('now["summary"]["a3_p50"] = str(int(base["summary"]["a3_p50"]) + 50)'),
    [],
  );
});

test('③ p50 漂移超容差 → 必须报', { timeout: 60_000 }, () => {
  const problems = compare(
    'now["summary"]["a3_p50"] = str(int(base["summary"]["a3_p50"]) + 400)',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /③ p50/);
});

test('① 逐轮漂移 200 ms → 不报（跨次噪声 280，判它等于抛硬币）', { timeout: 60_000 }, () => {
  assert.deepEqual(compare('now["turns"][0]["a1"] = base["turns"][0]["a1"] + 200'), []);
});

test('① 汇总 p50 也不判（跨次极差 223）', { timeout: 60_000 }, () => {
  assert.deepEqual(
    compare('now["summary"]["a1_p50"] = str(int(base["summary"]["a1_p50"]) + 300)'),
    [],
  );
});

test('③ p90 变了 → 不报（n≈17 时它是第 2 慢那一轮，一条长尾就抬高）', { timeout: 60_000 }, () => {
  assert.deepEqual(
    compare('now["summary"]["a3_p90"] = str(int(base["summary"]["a3_p90"]) + 400)'),
    [],
  );
});

test('送批次数变了 → 不报（逐轮量，噪声比信号大）', { timeout: 60_000 }, () => {
  assert.deepEqual(
    compare('now["turns"][0]["batches"] = (base["turns"][0]["batches"] or 2) + 3'),
    [],
  );
});

test('送批时刻的 p50 变了 → 必须报（这是回放里有效的那部分）', { timeout: 60_000 }, () => {
  const problems = compare(
    'now["summary"]["last_text_p50"] = str(int(base["summary"]["last_text_p50"]) + 400)',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /末批文本 p50/);
});
