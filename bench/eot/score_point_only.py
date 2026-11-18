"""只算 `score_point` 那一刀，把候选模型的评测从 15 分钟压到 1–2 分钟。

## 为什么这是精确的，不是近似

`eot_harness.metrics.official_score_table` 的文档字符串写得很明确：

> The official score is the first prediction exactly at `score_point_s`. Missing
> scores are allowed only for hold spans that end before the score point.

也就是说 `compute-metrics --score-point 0.2` 下，**每个 span 只用一个分数** ——
静音恰好 0.2 s 处那个。默认 100 ms 网格上其余 8489 个点（9441 − 952）**不参与
任何官方指标**：AUC、AP、2%/5%/10% 工作点、frontier 全部由这 952 个分数算出。

所以本脚本产出的 `predictions.parquet` 只含 `silence_dur == 0.2` 的行，
交给同一个 `compute-metrics --score-point 0.2`，结果是同一个数。

**不适用**：`--score-mode max` 那套（每个 span 取网格最大值）、以及任何需要
完整网格的分析。要那些还得跑全量 `eot_harness predict`。

## 用法

```bash
# 换模型只需换 adapter
python bench/eot/score_point_only.py --adapter eot_harness.turnsense_adapter:TurnsenseV11Adapter \
    --span-set tmp/eot-out-wavekat/**/span_set.parquet --out tmp/eot-out-ts10

# 自检：用现役模型重算 20 个 span，和已有 predictions.parquet 对账
python bench/eot/score_point_only.py --adapter eot_harness.our_judge_adapter:OurJudgeAdapter \
    --verify 20 --reference tmp/eot-out/**/predictions.parquet
```
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import sys
import time

import numpy as np
import pandas as pd

SR = 16_000
SCORE_POINT = 0.2


def load_spans(path_glob: str) -> pd.DataFrame:
    hits = glob.glob(path_glob, recursive=True)
    if not hits:
        raise SystemExit(f"找不到 span_set：{path_glob}")
    spans = pd.read_parquet(hits[0])
    need = {"id", "language", "span_index", "label", "start", "end", "duration"}
    if not need <= set(spans.columns):
        raise SystemExit(f"span_set 缺列：{need - set(spans.columns)}")
    return spans


def load_audio_by_id(name: str, split: str) -> dict[str, np.ndarray]:
    import datasets
    import soundfile as sf

    ds = datasets.load_dataset("livekit/eot-bench-data", name=name, split=split)
    ds = ds.cast_column("audio", datasets.Audio(decode=False))
    out: dict[str, np.ndarray] = {}
    for r in ds:
        data, sr = sf.read(io.BytesIO(r["audio"]["bytes"]))
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != SR:
            n = int(round(data.size * SR / sr))
            data = np.interp(
                np.linspace(0, 1, n, endpoint=False),
                np.linspace(0, 1, data.size, endpoint=False),
                data,
            )
        out[r["id"]] = np.ascontiguousarray(data, dtype=np.float32)
    return out


def build_adapter(spec: str):
    module_name, _, cls_name = spec.partition(":")
    if not cls_name:
        raise SystemExit(f"--adapter 要写成 module:Class，收到 {spec}")
    __import__(module_name)
    module = sys.modules[module_name]
    return getattr(module, cls_name)()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True, help="eot_harness 风格的 module:Class")
    ap.add_argument("--span-set", required=True, help="span_set.parquet 的 glob")
    ap.add_argument("--out", default="", help="输出目录（写 predictions.parquet）")
    ap.add_argument("--name", default="zh")
    ap.add_argument("--split", default="validation")
    ap.add_argument("--limit", type=int, default=0, help="只算前 N 个 span（0 = 全部）")
    ap.add_argument("--verify", type=int, default=0, help="只算 N 个并与 --reference 对账")
    ap.add_argument("--reference", default="", help="已有的 predictions.parquet，用于对账")
    args = ap.parse_args()

    spans = load_spans(args.span_set)
    audio = load_audio_by_id(args.name, args.split)
    adapter = build_adapter(args.adapter)

    # 只有时长 ≥ score_point 的 span 在 0.2 s 处有分数；更短的 hold 按规范允许缺分
    usable = spans[spans["duration"] >= SCORE_POINT - 1e-9].reset_index(drop=True)
    if args.verify:
        usable = usable.sample(n=min(args.verify, len(usable)), random_state=7).reset_index(drop=True)
    elif args.limit:
        usable = usable.head(args.limit)

    rows = []
    t0 = time.perf_counter()
    for i, r in enumerate(usable.itertuples(index=False)):
        sig = audio.get(r.id)
        if sig is None:
            continue
        end = int(round((r.start + SCORE_POINT) * SR))
        if end <= 0:
            continue
        window = sig[:end]
        p = adapter.predict_batch([{"audio": {"array": window, "sampling_rate": SR}}])[0]
        rows.append({
            "id": r.id,
            "language": r.language,
            "span_index": int(r.span_index),
            "timestamp": float(r.start + SCORE_POINT),
            "silence_dur": SCORE_POINT,
            "p_eot": float(p),
            "label": r.label,
        })
        if (i + 1) % 100 == 0:
            el = time.perf_counter() - t0
            print(f"  {i+1}/{len(usable)}  {el:.0f}s  ({el/(i+1)*1000:.0f} ms/点)", flush=True)

    # `span_table_from_predictions` 用 **max(silence_dur)** 当 span 时长。
    # 只写 0.2 那一行的话，所有 span 都会被当成「时长正好 0.2 s」，于是
    # `hold_dur > action_delay` 永不成立 → 误切率恒为 0、工作点全变成 0.200。
    # 所以每个 span 再补一行真实时长（分数给 0，`score_point` 模式不会用到它）。
    extra = []
    for r in spans.itertuples(index=False):
        if r.duration > SCORE_POINT + 1e-9:
            extra.append({
                "id": r.id,
                "language": r.language,
                "span_index": int(r.span_index),
                "timestamp": float(r.start + r.duration),
                "silence_dur": float(r.duration),
                "p_eot": 0.0,
                "label": r.label,
            })
        elif r.duration < SCORE_POINT - 1e-9:
            # 短于打分点的 hold 没有 0.2 分数；给一行真实时长让 harness 按规范把它筛掉
            extra.append({
                "id": r.id,
                "language": r.language,
                "span_index": int(r.span_index),
                "timestamp": float(r.start + r.duration),
                "silence_dur": float(r.duration),
                "p_eot": 0.0,
                "label": r.label,
            })

    df = pd.DataFrame(rows + extra)
    elapsed = time.perf_counter() - t0
    print(f"算了 {len(rows)} 个点（另补 {len(extra)} 行真实时长），用时 {elapsed:.0f}s")

    if args.verify:
        ref = pd.read_parquet(glob.glob(args.reference, recursive=True)[0])
        ref = ref[np.isclose(ref["silence_dur"], SCORE_POINT)][["id", "span_index", "p_eot"]]
        m = df.merge(ref, on=["id", "span_index"], suffixes=("_new", "_ref"))
        d = (m["p_eot_new"] - m["p_eot_ref"]).abs()
        print(f"对账 n={len(m)}  |Δ| 均值 {d.mean():.4f}  p95 {d.quantile(0.95):.4f}  max {d.max():.4f}")
        print(json.dumps({"n": len(m), "mean_abs": float(d.mean()), "max_abs": float(d.max())}, ensure_ascii=False))
        return 0

    if not args.out:
        raise SystemExit("没给 --out")
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "predictions.parquet")
    df.to_parquet(path, index=False)
    print(f"写入 {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
