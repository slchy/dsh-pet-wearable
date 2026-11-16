"""从 τ² 驱动的会话档案里算每轮延迟，出 p50/p90/p95。

事件顺序（每轮）：`gate.close`（用户说完）→ `asr.sentence` → `userFinal` →
`turn.start` → `tts.first` → `turn.end`。所以：

  ① 说完→ASR 出句        = asr.sentence.t - 前面的 gate.close.t
  ② 出句→开跑（判停+分句） = turn.start.t   - asr.sentence.t
  ③ 说完→首字下行         = tts.first.t    - 前面的 gate.close.t
  ④ 开跑→首字（dsh 侧）   = tts.first.ms（dsh 自己量的，与 ③ 同口径的一部分）

真机向量回放那边量的是 ①②③，这里的 ③ 可以直接并排比。
"""
from __future__ import annotations

import json
import pathlib
import statistics
import sys

ROOT = pathlib.Path.home() / "miai-archive"


def load(path: pathlib.Path) -> list[dict]:
    out = []
    for line in (path / "events.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return sorted(out, key=lambda ev: ev.get("t") or 0)


def is_bench(path: pathlib.Path) -> bool:
    """bench 那几场是 `deviceId=tau2-bench` 从回环连进来的；真机档案没有这个标记。"""
    try:
        head = (path / "events.jsonl").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return '"label":"tau2-bench"' in head or "tau2-bench" in head


def turns(path: pathlib.Path) -> list[dict]:
    rows: list[dict] = []
    last_partial = None
    for ev in load(path):
        kind = ev.get("ev")
        t = ev.get("t")
        if kind == "asr.partial":
            last_partial = t
        elif kind == "asr.sentence" and last_partial is not None:
            # "说完"取最后一个中间结果：gate.close 要等 gateHoldMs(2s) 静音才触发，
            # 那时 ASR 早就出句了，用它当基准会把 ① 算成十几秒。
            rows.append({"a1": t - last_partial, "ref": last_partial, "sentence": t})
        elif kind == "turn.start" and rows and "a2" not in rows[-1]:
            rows[-1]["a2"] = t - rows[-1]["sentence"]
        elif kind == "tts.first" and rows and "a3" not in rows[-1]:
            rows[-1]["a3"] = t - rows[-1]["ref"]
            rows[-1]["a4"] = ev.get("ms")
        elif kind == "turn.end" and rows and "interrupted" not in rows[-1]:
            rows[-1]["interrupted"] = bool(ev.get("interrupted"))
    return [r for r in rows if "a3" in r]


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, int(round((p / 100) * (len(ordered) - 1)))))
    return ordered[k]


def main() -> int:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    archives = [d for d in ROOT.iterdir() if d.is_dir() and (d / "events.jsonl").exists()]
    bench = [d for d in archives if is_bench(d)]
    bench.sort(key=lambda d: d.stat().st_mtime)
    bench = bench[-limit:]

    rows: list[dict] = []
    for path in bench:
        got = turns(path)
        if got:
            print(f"{path.name}: {len(got)} 轮")
            for row in got:
                print(
                    f"   ①{row['a1']:>6.0f} ②{row.get('a2', 0):>5.0f} "
                    f"③{row['a3']:>6.0f} ④{row.get('a4') or 0:>6.0f}"
                    f"{'  被打断' if row.get('interrupted') else ''}"
                )
        rows.extend(got)

    if not rows:
        print("没有找到 tau2-bench 的档案（meta.json 里应含 tau2）")
        return 1

    n = len(rows)
    print(f"\n=== τ² 驱动，{len(bench)} 场 / {n} 轮 ===")
    for key, name in (("a1", "① 说完→ASR"), ("a2", "② 出句→开跑"), ("a3", "③ 说完→首字下行"), ("a4", "④ dsh 自身首字")):
        values = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        if not values:
            continue
        print(
            f"{name:14s} p50={pct(values,50):>6.0f}  p90={pct(values,90):>6.0f}  "
            f"p95={pct(values,95):>6.0f}  mean={statistics.mean(values):>6.0f}  max={max(values):>6.0f}  n={len(values)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
