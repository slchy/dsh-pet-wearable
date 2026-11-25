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

test('时间旋钮按三层收敛，一级 .env 不再无节制膨胀', () => {
  assert.match(committed, /一级运行旋钮/);
  assert.match(committed, /二级热路径内部常量/);
  assert.match(committed, /三级看门狗/);
  const first = committed.split(/^## 二、/m)[0] ?? '';
  const rows = first.split('\n').filter((line) => line.startsWith('| `'));
  assert.ok(
    rows.length <= 16,
    `一级 .env 旋钮应不超过 16 项，实际 ${rows.length}`,
  );
});

/** Cascade 首声加速 / 改路径开关。标成「无关首声」或塞进 `NOT_ON_PATH` 都会把它们藏进三级。 */
const CASCADE_HOT_FLAGS = [
  'COSYVOICE_PREWARM',
  'FAST_LANE_SPECULATE',
  'FAST_LANE_PARTIAL_SPECULATE',
  'FAST_LANE_PREFETCH',
  'FAST_LANE_DELEGATE',
] as const;

/** 读扫描器模块里的 `NOT_ON_PATH` 与 `INVARIANTS`，不靠在源码字符串里碰运气。 */
function loadScannerFacts(): { notOnPath: Set<string>; invariants: string[] } {
  const out = execFileSync(
    'python',
    [
      '-c',
      [
        'import sys, importlib.util as u',
        'spec = u.spec_from_file_location("time_knobs", "scripts/time-knobs.py")',
        'm = u.module_from_spec(spec)',
        'sys.modules["time_knobs"] = m',
        'spec.loader.exec_module(m)',
        'print("NOT_ON_PATH")',
        'print("\\n".join(sorted(m.NOT_ON_PATH)))',
        'print("INVARIANTS")',
        'for left, op, right, _why in m.INVARIANTS:',
        '    print(f"{left}\\t{op}\\t{right}")',
      ].join('\n'),
    ],
    {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    },
  );
  const text = out.replace(/\r\n/g, '\n');
  const [pathPart, invPart] = text.split('INVARIANTS\n');
  assert.ok(pathPart !== undefined && invPart !== undefined, `扫描器事实输出缺分段：${text}`);
  const notOnPath = new Set(
    pathPart.replace(/^NOT_ON_PATH\n/, '').trim().split('\n').filter((name) => name !== ''),
  );
  const invariants = invPart.trim().split('\n').filter((line) => line !== '');
  return { notOnPath, invariants };
}

function tableRow(name: string): string {
  const row = committed.split('\n').find((l) => l.startsWith(`| \`${name}\``));
  assert.ok(row !== undefined, `总表里应该有 ${name} 这一行`);
  return row;
}

/** 表行按 `|` 切开。下标 0 是行首空段，1 起才是列。 */
function cell(row: string, index: number): string {
  return (row.split('|')[index] ?? '').trim();
}

test('首声投机与预热开关不得被误标为「无关首声」', { timeout: 30_000 }, () => {
  const { notOnPath } = loadScannerFacts();
  for (const name of CASCADE_HOT_FLAGS) {
    const row = tableRow(name);
    assert.equal(
      row.includes('无关首声'),
      false,
      `${name} 是 Cascade 首声开关，不能标成无关首声：${row}`,
    );
    assert.equal(
      notOnPath.has(name),
      false,
      `${name} 不能进 scripts/time-knobs.py 的 NOT_ON_PATH`,
    );
  }
});

test('关键热路径参数必须出现在总表里', () => {
  const required = [
    // .env
    'FAST_LANE_TIMEOUT_MS',
    'VOICE_COMMIT_MS',
    'VOICE_STT_COMMIT_MS',
    'VOICE_OPEN_QUIET_MS',
    'TURN_JUDGE_EXTEND_MS',
    'TURN_JUDGE_WAIT_BUDGET_MS',
    'TURN_JUDGE_SEQUENCE_BUDGET_MS',
    'TURN_JUDGE_MAX_OPEN_SILENCE_MS',
    'SEMANTIC_END_TAG_BUDGET_MS',
    // 开关
    'COSYVOICE_PREWARM',
    'FAST_LANE_DELEGATE',
    'FAST_LANE_PREFETCH',
    'FAST_LANE_PARTIAL_SPECULATE',
    'FAST_LANE_SPECULATE',
    // 二级热路径常量
    'PREWARM_TTL_MS',
    'DEFAULT_RING_MS',
    'DEFAULT_DECODE_WAIT_MS',
    'DEFAULT_SHORT_FRAGMENT_WAIT_MS',
    'DEFAULT_SHORT_FRAGMENT_WINDOW_MS',
    'SEMANTIC_MORE_MIN_WAIT_MS',
    'SEMANTIC_MORE_SEQUENCE_WAIT_MS',
    'DEFAULT_GATE_HOLD_MS',
    'DEFAULT_GATE_PREROLL_MS',
    'DEFAULT_MIN_SPEECH_MS',
    'DEFAULT_ASR_PREROLL_MS',
    'DEFAULT_PAUSE_DETECT_MS',
    'DEFAULT_SPECULATE_MS',
    'DEFAULT_TRAILING_TRIM_MS',
    'DEFAULT_GLASSES_STT_COMMIT_MS',
    'DEFAULT_BROWSER_STT_COMMIT_MS',
    'ASSEMBLER_FALLBACK_WINDOW_MS',
    'ASSEMBLER_PREDICT_LEAD_MS',
  ];
  for (const name of required) {
    tableRow(name);
  }
});

test('流式热路径开关指向 assembleStreamingAgent，而不是旧分支', { timeout: 30_000 }, () => {
  // 持有者按扫描器当场扫到的源码算。提交的 docs/TIME-KNOBS.md 要等
  // Wave 3 整表重生成，这一条不拿过期行号当结论。
  const generated = generate().replace(/\r\n/g, '\n');
  const assembly = readFileSync(join(root, 'src/runtime/pipeline-assembly.ts'), 'utf8').replace(/\r\n/g, '\n');
  const fnLine = assembly.split('\n').findIndex((line) => line.includes('function assembleStreamingAgent(')) + 1;
  assert.ok(fnLine > 0, 'assembleStreamingAgent 应在 src/runtime/pipeline-assembly.ts');
  const streaming = [
    'FAST_LANE_TIMEOUT_MS',
    'FAST_LANE_DELEGATE',
    'FAST_LANE_PREFETCH',
    'FAST_LANE_PARTIAL_SPECULATE',
  ];
  for (const name of streaming) {
    const row = generated.split('\n').find((line) => line.startsWith(`| \`${name}\``));
    assert.ok(row !== undefined, `生成表里应该有 ${name}`);
    const holder = cell(row, 4).replace(/`/g, '');
    const match = holder.match(/^src\/runtime\/pipeline-assembly\.ts:(\d+)$/);
    assert.ok(match !== null, `${name} 应指向 src/runtime/pipeline-assembly.ts：${holder}`);
    const line = Number(match[1]);
    assert.ok(
      line >= fnLine,
      `${name} 应落在 assembleStreamingAgent（src/runtime/pipeline-assembly.ts:${fnLine} 起），实际 ${line}`,
    );
  }
});

test('墙上静音与 frame.silenceMs 的时钟口径一致', () => {
  const wallOnly = [
    'VOICE_OPEN_QUIET_MS',
    'TURN_JUDGE_MAX_OPEN_SILENCE_MS',
    'ASSEMBLER_PREDICT_LEAD_MS',
  ];
  for (const name of wallOnly) {
    const clock = cell(tableRow(name), 3);
    assert.equal(clock, 'wall', `${name} 的时钟列应是 wall：${clock}`);
    assert.equal(clock.includes('audio'), false, `${name} 的时钟列不应含 audio：${clock}`);
  }

  const silenceFrame = [
    'VOICE_COMMIT_MS',
    'VOICE_STT_COMMIT_MS',
    'DEFAULT_GLASSES_STT_COMMIT_MS',
    'DEFAULT_BROWSER_STT_COMMIT_MS',
    'DEFAULT_PAUSE_DETECT_MS',
    'DEFAULT_SPECULATE_MS',
  ];
  const clocks = silenceFrame.map((name) => cell(tableRow(name), 3));
  const expected = 'wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms）';
  for (const [index, clock] of clocks.entries()) {
    assert.equal(
      clock,
      expected,
      `${silenceFrame[index]} 的时钟口径应与其余 frame.silenceMs 消费者相同：${clock}`,
    );
  }
});

test('L1 不变量覆盖单配置与跨模块默认值', { timeout: 30_000 }, () => {
  const { invariants } = loadScannerFacts();
  const expected = [
    'DEFAULT_SPECULATE_MS\t<=\tDEFAULT_PAUSE_DETECT_MS',
    'VOICE_STT_COMMIT_MS\t>=\tVOICE_COMMIT_MS',
    'DEFAULT_BROWSER_STT_COMMIT_MS\t>=\tVOICE_COMMIT_MS',
    'TURN_JUDGE_WAIT_BUDGET_MS\t>=\tTURN_JUDGE_EXTEND_MS',
    'TURN_JUDGE_SEQUENCE_BUDGET_MS\t>=\tTURN_JUDGE_WAIT_BUDGET_MS',
    'TURN_JUDGE_MAX_OPEN_SILENCE_MS\t>=\tVOICE_OPEN_QUIET_MS',
    'DEFAULT_ASR_PREROLL_MS\t<=\tDEFAULT_GATE_PREROLL_MS',
    'DEFAULT_MIN_SPEECH_MS\t<\tDEFAULT_GATE_HOLD_MS',
    'DEFAULT_GATE_HOLD_MS\t>\tVOICE_STT_COMMIT_MS',
    'DEFAULT_GATE_HOLD_MS\t>\tDEFAULT_BROWSER_STT_COMMIT_MS',
    'DEFAULT_GATE_HOLD_MS\t>\tVOICE_OPEN_QUIET_MS',
    'DEFAULT_GATE_HOLD_MS\t>\tTURN_JUDGE_MAX_OPEN_SILENCE_MS',
    'DEFAULT_GATE_HOLD_MS\t>\tTURN_JUDGE_SEQUENCE_BUDGET_MS',
    'PREWARM_TTL_MS\t>\tTURN_JUDGE_SEQUENCE_BUDGET_MS',
    'DEFAULT_KEEPALIVE_MS\t<\tSERVER_IDLE_TIMEOUT_MS',
    'TURN_JUDGE_MAX_OPEN_SILENCE_MS\t>=\tSEMANTIC_MORE_MIN_WAIT_MS',
    'TURN_JUDGE_SEQUENCE_BUDGET_MS\t>=\tSEMANTIC_MORE_SEQUENCE_WAIT_MS',
  ];
  assert.deepEqual(invariants, expected);
});
