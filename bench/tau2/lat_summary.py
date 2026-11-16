"""把 /tmp/tau2-lat-*.json 里的打点合并出 p50/p90/p95，并折算成真机体感。

## 经验参数：`BENCH_OVERHEAD_MS`

bench 比真机多出来的固定开销。**实测只有 ~50 ms**，因为逐轮拆解后发现
「TTS 首块就绪 → 客户端收到首帧」这一段 p50 只有 **5 ms**（下行不是瓶颈），
剩下的余量来自上下行按 tick 切片的抖动。

> 早先按「bench 2010 vs 真机 1400」反推出过 500 ms，那是**错的**：那 600 ms 的差
> 主要来自 τ² 任务本身答复更长（首句更晚），不是 bench 的开销。教训：先逐轮拆开
> 再定系数，别用两个不同口径的中位数相减。

**换 tick 粒度、改下行写法或换 TTS 后必须重标**，因为 ④ 那一段会变。
"""
from __future__ import annotations

import glob
import json
import pathlib
import statistics
import sys

#: 见表头说明；单位 ms
BENCH_OVERHEAD_MS = 50

rows: list[int] = []
for path in sorted(glob.glob("/tmp/tau2-lat-*.json")):
    try:
        data = json.loads(pathlib.Path(path).read_text())
    except Exception:  # noqa: BLE001
        continue
    if not isinstance(data, list):
        continue  # SimulationRun 之类的别混进来
    got = [r["ms"] for r in data if isinstance(r, dict) and "ms" in r]
    if got:
        print(f"{pathlib.Path(path).name}: {len(got)} 轮 {got}")
        rows += got

if not rows:
    raise SystemExit("没有有效打点")
rows.sort()


def p(q: float) -> int:
    k = max(0, min(len(rows) - 1, int(round(q / 100 * (len(rows) - 1)))))
    return rows[k]


overhead = int(sys.argv[1]) if len(sys.argv) > 1 else BENCH_OVERHEAD_MS
print(f"\n说完→首字节  n={len(rows)}")
print(f"  bench 原始   p50={p(50)}  p90={p(90)}  p95={p(95)}  均={statistics.mean(rows):.0f}  "
      f"最小={min(rows)}  最大={max(rows)}")
adjusted = [max(0, r - overhead) for r in rows]


def pa(q: float) -> int:
    k = max(0, min(len(adjusted) - 1, int(round(q / 100 * (len(adjusted) - 1)))))
    return adjusted[k]


print(f"  折算真机(-{overhead}) p50={pa(50)}  p90={pa(90)}  p95={pa(95)}  "
      f"均={statistics.mean(adjusted):.0f}")
print("  （折算只减固定开销，不减方差：场间 1515–2410 那种跳动是真机也会有的）")
