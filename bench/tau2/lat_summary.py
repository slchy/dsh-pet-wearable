"""把 /tmp/tau2-lat-*.json 里的打点合并出 p50/p90/p95，并折算成真机体感。

## 经验参数：`BENCH_OVERHEAD_MS`

bench 相对真机的固定开销。**现在取 5 ms** —— 逐轮拆解后 ⑤（TTS 首块 → 客户端首帧）
的 p50 就是 3 ms，下行不是瓶颈。

调法（只有这一条，别用别的）：

1. 跑 ≥10 轮，取 `segment_split.py` 里 **⑤ 的 p50**；
2. 把它写进 `BENCH_OVERHEAD_MS`；
3. 改了 tick 粒度 / 下行写法 / TTS 供应商，**必须重跑重取**。

> 教训：曾用「bench p50 2010 减真机 p50 1400」反推出 500 ms，是错的 —— 那 600 ms
> 来自 τ² 任务答复更长（模型开口更晚），不是 bench 的开销。**两个不同口径的中位数
> 相减只能得到"差别"，得不到"开销"。**
>
> 另外：真机与 bench 剩下的差异主要在**内容**（答复长度、说话人声学），不该折进
> 系数，应该用同一批任务在真机上跑一次来校验。
"""
from __future__ import annotations

import glob
import json
import pathlib
import statistics
import sys

#: 见表头说明；单位 ms
BENCH_OVERHEAD_MS = 5

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
