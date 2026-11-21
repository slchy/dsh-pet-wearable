#!/usr/bin/env python3
"""
定向变异测试：确认「口径」和「不变量」的测试**真的会咬**。

## 为什么需要它

`tests/latency-report-golden.test.ts` 断言了一组具体数字。但「数字对得上」不等于
「测试有效」—— 如果某个变异体（比如把 `①<0` 的判据从 `<` 改成 `<=`）也能让测试
通过，说明那条断言没覆盖到那行代码。

手写几个注入够不够？不够。手写只会覆盖你**想到的**那几个点；变异测试的价值在于
它会提出你没想到的 —— 比如把线性插值换成最近秩法（这个项目明确记过「会让延迟
数字系统性偏乐观」），如果 golden 测试放过了它，那份 golden 就是假的。

## 为什么不用 Stryker

只为两个模块装一套框架 + 配置 + 报告，维护成本超过收益（一人维护的项目）。
这里做的是**定向变异**：人工列出「改了会改变语义」的替换，逐个跑测试看红不红。
变异体少，但每一个都指着一句真实的口径规则。

## 用法

    python scripts/mutation-check.py            # 全部跑
    python scripts/mutation-check.py --list     # 只看有哪些变异体

退出码：有存活体时 1（存活 = 测试没咬住）。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "src" / "latency-report.ts"
KNOBS = ROOT / "scripts" / "time-knobs.py"

#: 跑哪些测试取决于变异在哪个文件 —— 拿错测试集会把「没跑到」误报成「存活」。
#: 第一次跑就踩了：不变量那条变异被报成存活，其实是我根本没跑它的测试。
REPORT_TESTS = [
    "tests/latency-report-golden.test.ts",
    "tests/latency-report-standard.test.ts",
]
KNOBS_TESTS = ["tests/qos-invariants.test.ts"]


@dataclass
class Mutation:
    """一个变异体：在哪个文件、把什么换成什么、对应哪条口径规则。"""

    path: Path
    find: str
    replace: str
    label: str
    rule: str
    #: 预期结果：`kill` = 测试必须红；`survive` = 对照组，必须绿
    expect: str = "kill"
    tests: list[str] = field(default_factory=list)

    def test_args(self) -> list[str]:
        return self.tests or (KNOBS_TESTS if self.path == KNOBS else REPORT_TESTS)


MUTATIONS: list[Mutation] = [
    Mutation(
        REPORT,
        "const badSample = (silenceToAsr !== null && silenceToAsr < 0) || impossibleA1;",
        "const badSample = (silenceToAsr !== null && silenceToAsr <= 0) || impossibleA1;",
        "坏样本判据 < 改 <=",
        "QOS 口径规则 3：①=0 是合法的（ASR 与停嘴同一毫秒），不能算坏样本",
    ),
    Mutation(
        REPORT,
        "const badSample = (silenceToAsr !== null && silenceToAsr < 0) || impossibleA1;",
        "const badSample = silenceToAsr !== null && silenceToAsr < 0;",
        "去掉「① > gapMs」这条判据",
        "门落在定稿之前时 ① 会算成 2658（实测把回放 p50 从 1189 抬到 1328）",
    ),
    Mutation(
        REPORT,
        "const firstWordMs = badSample ? null : rawFirstWord;",
        "const firstWordMs = rawFirstWord;",
        "坏样本不再降成 null",
        "QOS 口径规则 2：缺数据记 null，不拿负数冒充",
    ),
    Mutation(
        REPORT,
        "const commitToFinalMs = commitEv === undefined || asrEv === undefined || commitCount !== 1",
        "const commitToFinalMs = commitEv === undefined || asrEv === undefined",
        "多封段轮也照算 ①b（挑最近一条）",
        "QOS 口径规则 5：多条 asr.commit 时 ①b 记 null —— 挑一条会把 249 算成 43",
    ),
    Mutation(
        REPORT,
        "const usable = list.filter((t) => t.firstWordMs !== null);",
        "const usable = list.filter((t) => t.firstWordMs !== null && t.missing.length === 0);",
        "把「只缺 turn.end」的轮次也剔出分母",
        "QOS 口径规则 2：turn.end 不影响首字延迟，剔掉是白丢样本",
    ),
    Mutation(
        REPORT,
        "const WAITED_THRESHOLD_MS = 100;",
        "const WAITED_THRESHOLD_MS = 50;",
        "判停等待门槛 100 改 50",
        "QOS §1.1：「按是否等待」用两峰之间的空谷切分",
    ),
    Mutation(
        REPORT,
        "export const SLOW_TURN_MS = 1500;",
        "export const SLOW_TURN_MS = 3000;",
        "慢轮门槛 1500 改 3000",
        "QOS §1.1：慢轮次占比是「稳」的指标",
    ),
    Mutation(
        REPORT,
        """  const clamped = Math.min(1, Math.max(0, p));
  const pos = (kept.length - 1) * clamped;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);""",
        """  const clamped = Math.min(1, Math.max(0, p));
  const pos = Math.floor((kept.length - 1) * clamped);
  const lower = pos;
  const upper = pos;""",
        "分位数从线性插值改成最近秩法",
        "代码注释里写明：最近秩法会让延迟数字系统性偏乐观",
    ),
    Mutation(
        REPORT,
        "[...bare].length <= 6 && FILLER_HEADS.some",
        "[...bare].length <= 20 && FILLER_HEADS.some",
        "开头语长度门槛 6 改 20",
        "QOS §1.1 多余轮次：完整问句不该被算成半句",
    ),
    Mutation(
        REPORT,
        "  if (NOISE_RE.test(bare)) {\n    return 'noise';\n  }\n",
        "",
        "不再识别疑似误识别",
        "QOS §1.1 多余轮次：误识别必须能点名",
    ),
    Mutation(
        REPORT,
        "const ratio = g.bad === 0 ? `${g.count}/${g.total}` : `${g.count}/${g.total}（坏样本 ${g.bad}）`;",
        "const ratio = `${g.count}/${g.total}`;",
        "剔除坏样本后不留痕",
        "QOS 口径规则 3：悄悄变小分母看不出来",
    ),
    Mutation(
        REPORT,
        "export function groupBy(",
        "export function groupByUNUSED(",
        "分组函数被改名（编译期就红）",
        "—",
    ),
    Mutation(
        KNOBS,
        'ok = a <= b if op == "<=" else a >= b if op == ">=" else a < b if op == "<" else a > b',
        'ok = a == b if op == "<=" else a == b if op == ">=" else a == b if op == "<" else a == b',
        "不变量比较退化成「必须相等」",
        "L1：不变量必须真的比较大小",
    ),
    # ---- 对照组：必须**存活**，用来证明这个工具不会误报 ----
    Mutation(
        REPORT,
        "/** 报告里文本预览的最大字数。 */",
        "/** 预览上限。 */",
        "（对照）只改注释",
        "无行为变化 —— 必须绿，否则工具在误报",
        expect="survive",
    ),
]


def run_tests(extra: list[str]) -> tuple[bool, str]:
    """跑测试。返回 (是否通过, 首个失败用例名)。"""
    proc = subprocess.run(
        ["node", "--test", *extra],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode == 0:
        return True, ""
    # 抓第一行失败用例名，便于看出「谁咬住了」
    for line in (proc.stdout + proc.stderr).splitlines():
        stripped = line.strip()
        if stripped.startswith("✖ ") and "failing tests" not in stripped:
            return False, stripped[2:][:60]
        if stripped.startswith("not ok"):
            return False, stripped[:60]
        if "SyntaxError" in stripped or "error TS" in stripped:
            return False, "编译/语法错误（也算咬住）"
    return False, "退出码非 0"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="定向变异测试")
    ap.add_argument("--list", action="store_true", help="只列出变异体")
    ap.add_argument("--verify", action="store_true",
                    help="只校验每个变异体的匹配点还在（不跑测试、不改源码）。"
                         "给 `npm test` 用的轻量守卫，防止清单静默过期")
    args = ap.parse_args(argv)

    if args.list:
        for i, m in enumerate(MUTATIONS, 1):
            print(f"{i:>2}. {m.label}")
            print(f"    规则：{m.rule}")
        return 0

    if args.verify:
        stale = []
        for m in MUTATIONS:
            count = m.path.read_text(encoding="utf-8").count(m.find)
            if count != 1:
                stale.append(f"{m.label}（count={count}）")
        if stale:
            print("变异清单过期 —— 这些匹配点找不到了，说明源码改过而清单没跟着改：")
            for line in stale:
                print(f"  · {line}")
            return 1
        noop = [m.label for m in MUTATIONS if m.expect == "survive" and m.find == m.replace]
        if noop:
            print(f"对照组必须是「真改动但无行为变化」，不能是空操作：{noop}")
            return 1
        print(f"{len(MUTATIONS)} 个变异体的匹配点都在")
        return 0

    # 基线：未变异的代码必须全绿，否则后面全是噪声
    all_tests = sorted(set(REPORT_TESTS) | set(KNOBS_TESTS))
    ok, why = run_tests(all_tests)
    if not ok:
        print(f"基线测试就没过（{why}）—— 先修这个，变异测试没有意义", file=sys.stderr)
        return 2
    print(f"基线：{len(all_tests)} 个测试文件全绿\n")

    survived: list[Mutation] = []
    wrong: list[Mutation] = []
    print(f"{'#':>3} {'变异体':<30} {'预期':<6} {'结果':<8} 说明")
    print("-" * 104)

    for i, m in enumerate(MUTATIONS, 1):
        original = m.path.read_text(encoding="utf-8")
        count = original.count(m.find)
        if count != 1:
            print(f"{i:>3} {m.label:<30} {'—':<6} {'跳过':<8} 找不到唯一匹配点（count={count}）")
            wrong.append(m)
            continue
        try:
            m.path.write_text(original.replace(m.find, m.replace, 1), encoding="utf-8", newline="")
            passed, why = run_tests(m.test_args())
        finally:
            m.path.write_text(original, encoding="utf-8", newline="")

        killed = not passed
        want = m.expect
        good = (killed and want == "kill") or ((not killed) and want == "survive")
        result = ("咬住 ✓" if killed else "存活") if good else ("误杀 ✗" if killed else "漏杀 ✗")
        detail = why if killed else m.rule
        print(f"{i:>3} {m.label:<30} {want:<6} {result:<8} {detail}")
        if not good:
            (survived if want == "kill" else wrong).append(m)

    print("-" * 104)
    kills = [m for m in MUTATIONS if m.expect == "kill"]
    dead = len(kills) - len(survived)
    print(f"\n杀死 {dead}/{len(kills)}（{dead / len(kills) * 100:.0f}%）")
    if survived:
        print("\n漏杀的变异体 —— 每一处都是「测试通过但没测到」：")
        for m in survived:
            print(f"  · {m.label} —— 对应规则：{m.rule}")
    if wrong:
        print("\n对照组/匹配异常（工具自身的问题，不是测试的问题）：")
        for m in wrong:
            print(f"  · {m.label}")
    return 1 if (survived or wrong) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
