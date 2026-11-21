#!/usr/bin/env python3
"""
要多少遍回放才有统计显著性。

## 为什么需要这个

`docs/QOS.md` §1.2 的目标表里有一列「样本量够不够判」，但那个判断不能靠感觉。
而且回放的噪声**必须先量**：同一份代码、同一个向量跑 5 遍，「每次回放的 p50」
自己就会跳 —— 跳多少决定了任何前后对比能分辨的最小差别。

## 口径

- **单位是「一次回放」**，不是「一轮」。一次回放 = 一个 17 轮的样本。
- **统计量是每次回放的 p50**，不是逐轮值。实测逐轮配对差值 SD（③=255 ms）
  比「每次回放 p50」的跨遍 SD（③=27 ms）大一个量级 —— 逐轮配对是**负收益**。
- α = 0.05 双侧、power = 80%：要分辨 Δ 时，两侧各需
  `n = 2 × (2.8 × SD / Δ)²` 遍。

## 用法

    python scripts/sample-size.py                     # 用最近 5 次回放
    python scripts/sample-size.py --last 8
    python scripts/sample-size.py --files a.jsonl b.jsonl ...

前提：这些回放必须是**同一份代码 + 同一个向量**，否则量到的是「改动」不是「噪声」。
脚本会核对轮数与向量来源，不一致时只警告（可能是同一个向量的多次回放）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "bench" / "replay" / "out"
RUN_PY = ROOT / "bench" / "replay" / "run.py"

#: α=0.05 双侧 + power 80%（1.96 + 0.84）
Z_SUM = 1.959964 + 0.8416212


def load_parse():
    """借用 `run.py` 的 `parse()`：口径只有一份实现，这里不重写。"""
    spec = importlib.util.spec_from_file_location("rr", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    sys.modules["rr"] = module
    spec.loader.exec_module(module)
    return module.parse


def pct(values, p):
    kept = sorted(v for v in values if v is not None)
    if not kept:
        return None
    k = (len(kept) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(kept) - 1)
    return kept[lo] + (kept[hi] - kept[lo]) * (k - lo)


FIELDS = (
    ("a2", "② 定稿→开轮"),
    ("a3", "③ 开轮→首块"),
    ("a1", "① 停嘴→定稿"),
    ("first_text", "首批文本时刻"),
    ("last_text", "末批文本时刻"),
)


def n_runs(sd: float, delta: float) -> int:
    return math.ceil(2 * (Z_SUM * sd / delta) ** 2)


def n_proportion(p1: float, p2: float) -> int:
    """两比例比较所需样本量（轮）。"""
    pb = (p1 + p2) / 2
    num = (
        1.959964 * math.sqrt(2 * pb * (1 - pb))
        + 0.8416212 * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    ) ** 2
    return math.ceil(num / (p1 - p2) ** 2)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="回放显著性所需样本量")
    ap.add_argument("--last", type=int, default=5, help="用最近几次回放（默认 5）")
    ap.add_argument("--files", nargs="*", default=None, help="显式指定回放档案")
    args = ap.parse_args(argv)

    parse = load_parse()
    if args.files:
        files = [Path(f) for f in args.files]
    else:
        all_runs = sorted(OUT.glob("replay-*.jsonl"), key=lambda p: p.stat().st_mtime)
        files = all_runs[-args.last :]
    if len(files) < 3:
        print(f"至少需要 3 次回放才量得出噪声，现在只有 {len(files)} 次", file=sys.stderr)
        return 2

    runs = [parse(f) for f in files]
    turns = [len(r) for r in runs]
    # 轮数异常的回放（比如那次只跑出 4 轮的假打断）会把噪声算大，先剔掉。
    # 同一个向量的每遍轮数应当一致；不一致本身就说明那一遍不可信。
    mode = max(set(turns), key=turns.count)
    kept_pairs = [(f, r) for f, r in zip(files, runs) if len(r) == mode]
    dropped = [f.name for f, r in zip(files, runs) if len(r) != mode]
    if dropped:
        print(f"⚠ 剔除 {len(dropped)} 次轮数异常的回放（{mode} 轮为准）：{dropped}", file=sys.stderr)
    files = [f for f, _ in kept_pairs]
    runs = [r for _, r in kept_pairs]
    if len(runs) < 3:
        print(f"剔掉异常后只剩 {len(runs)} 次，不够量噪声", file=sys.stderr)
        return 2

    print(f"用 {len(runs)} 次回放（每次 {mode} 轮）：")
    for f in files:
        print(f"  {f.name}")

    # ---- 噪声底 ----
    stats: dict[str, tuple[float, float, list[int]]] = {}
    print(f"\n=== 每次回放的 p50 与跨遍 SD ===")
    print(f"{'指标':<14}{'5 遍 p50':>34}{'均值':>8}{'SD':>7}")
    for key, label in FIELDS:
        ps = [pct([row.get(key) for row in r], 0.5) for r in runs]
        kept = [x for x in ps if x is not None]
        if len(kept) < 3:
            continue
        sd = statistics_pstdev(kept)
        stats[label] = (sum(kept) / len(kept), sd, [round(x) for x in kept])
        series = ", ".join(str(round(x)) for x in kept)
        print(f"{label:<14}{series:>34}{sum(kept) / len(kept):>8.0f}{sd:>7.0f}")

    # ---- 可分辨的最小差别 ----
    print("\n=== n 遍/侧时能分辨的最小差别（ms，α=.05 双侧，power 80%）===")
    levels = (1, 2, 3, 5, 10)
    print(f"{'指标':<14}" + "".join(f"{f'{n} 遍':>9}" for n in levels))
    for label, (_mu, sd, _ps) in stats.items():
        cells = "".join(f"{Z_SUM * math.sqrt(2 / n) * sd:>9.0f}" for n in levels)
        print(f"{label:<14}{cells}")

    # ---- 要检出 Δ 需要几遍 ----
    print("\n=== 要检出 Δ，两侧各需几遍 ===")
    deltas = (100, 50, 30, 20)
    print(f"{'指标':<14}" + "".join(f"{f'Δ={d}':>9}" for d in deltas))
    for label, (_mu, sd, _ps) in stats.items():
        cells = "".join(f"{n_runs(sd, d):>9}" for d in deltas)
        print(f"{label:<14}{cells}")

    # ---- 占比类 ----
    print("\n=== 占比类：检出「减半」需要多少轮/侧 ===")
    for key, label, thr in (("a3", "TTS 长尾 >900", 900), ("a3", "慢轮 >1500", 1500)):
        counts = [sum(1 for row in r if (row.get(key) or 0) > thr) for r in runs]
        per_run = mode
        rate = sum(counts) / (per_run * len(counts))
        if rate <= 0:
            print(f"  {label:<16} 5 遍里一次都没出现，量不出需要多少轮")
            continue
        need = n_proportion(rate, rate / 2)
        print(
            f"  {label:<16} 计数 {counts} → {rate:.1%}；减半需 {need} 轮/侧 "
            f"≈ {math.ceil(need / per_run)} 遍/侧"
        )

    print(
        "\n注：这是「同一天、连着跑」的噪声。前后对比若跨天，服务端负载会漂，"
        "实际噪声更大 —— 留 1.5–2 倍余量。"
    )
    return 0


def statistics_pstdev(values: list[float]) -> float:
    """总体标准差（这几个样本就是我们要描述的全体，不是抽样估计）。"""
    mu = sum(values) / len(values)
    return math.sqrt(sum((v - mu) ** 2 for v in values) / len(values))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
