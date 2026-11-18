"""尾部静音对照实验：同一批 span，只改「喂进去的尾部静音有多长」，看 p 怎么变。

回答两个问题（此前只有 0.2 s → 删静音 这一次对照，量错了对象）：

1. 同一段音频，尾部静音 0.2 / 0.3 / 0.5 / 0.8 / 1.0 / 1.2 s 时，p 各是多少？
2. 如果线上改成「长尾巴截回 0.3 s 再喂」，eot-bench 的 5%/10% 等待还成立吗？

产物（都可复算）：
- `<out>/tail_curve.parquet`：逐 span 逐 tail 的分数
- `<out>/tail_curve_summary.json`：每个 tail 上的中位数与 AUC
- `<out>/predictions_capped.parquet`：把每个网格点的分数换成 `min(silence_dur, cap)` 处的分数，
  再交给 `eot_harness compute-metrics` 算工作点

用法：
    python tail_silence_probe.py --span-set <span_set.parquet> --predictions <predictions.parquet> \
        --out-dir <dir> --models ours,wavekat,scicom --cap 0.3
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_THIS = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_THIS, "..", ".."))

TAILS = (0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.2)
SR = 16_000
BATCH = 8


def build_models(names: str) -> dict:
    sys.path.insert(0, os.environ.get("EOT_BENCH_PATH", os.path.join(_REPO, "tmp", "eot-bench")))
    from eot_harness.our_judge_adapter import OurJudgeAdapter
    from eot_harness.cand_adapter import ScicomTinyAdapter, WavekatZhAdapter

    factory = {"ours": OurJudgeAdapter, "wavekat": WavekatZhAdapter, "scicom": ScicomTinyAdapter}
    return {n: factory[n]() for n in names.split(",") if n in factory}


def load_audio(path: str, lang: str) -> dict:
    """id -> (float32 mono @16k)"""
    import datasets
    import soundfile as sf

    ds = datasets.load_dataset("livekit/eot-bench-data", name=lang, split="validation").cast_column(
        "audio", datasets.Audio(decode=False)
    )
    out = {}
    for r in ds:
        data, sr = sf.read(io.BytesIO(r["audio"]["bytes"]))
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != SR:
            n = int(round(data.size * SR / sr))
            data = np.interp(np.linspace(0, 1, n, endpoint=False), np.linspace(0, 1, data.size, endpoint=False), data)
        out[r["id"]] = data.astype(np.float32)
    return out


def score_windows(model, windows: list[np.ndarray]) -> list[float]:
    scores: list[float] = []
    for i in range(0, len(windows), BATCH):
        chunk = windows[i : i + BATCH]
        scores.extend(model.predict_batch([{"audio": {"array": w, "sampling_rate": SR}} for w in chunk]))
        print(f"    {min(i + BATCH, len(windows))}/{len(windows)}", end="\r", flush=True)
    print(" " * 30, end="\r")
    return scores


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--span-set", required=True)
    ap.add_argument("--predictions", required=True, help="harness 原 predictions.parquet，用来对齐网格")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--models", default="ours,wavekat,scicom")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--cap", type=float, default=0.3, help="「截回」方案保留的尾部静音")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    spans = pd.read_parquet(args.span_set)
    preds = pd.read_parquet(args.predictions)
    audio = load_audio(args.span_set, args.lang)
    models = build_models(args.models)

    # 逐 span 取窗口；tail 超过 span 实际静音长度时按 span 长度截断（hold 的停顿时长短，不能凭空造更长）
    tasks = []  # (id, span_index, label, tail, window)
    for r in spans.itertuples(index=False):
        sig = audio.get(r.id)
        if sig is None:
            continue
        for tail in TAILS:
            eff = float(min(tail, r.duration))
            end = int(round((r.start + eff) * SR))
            end = max(end, int(round(0.4 * SR)))  # 太短的窗没法判，给个下限
            tasks.append((r.id, r.span_index, r.label, tail, eff, sig[:end]))

    curve = []
    for name, model in models.items():
        print(f"[{name}] {len(tasks)} 次推理…")
        scores = score_windows(model, [t[5] for t in tasks])
        for (sid, si, label, tail, eff, _), p in zip(tasks, scores):
            curve.append({"model": name, "id": sid, "span_index": si, "label": label, "tail_s": tail, "effective_tail_s": eff, "p": p})

    df = pd.DataFrame(curve)
    df.to_parquet(os.path.join(args.out_dir, "tail_curve.parquet"), index=False)

    from sklearn.metrics import roc_auc_score

    summary = {"lang": args.lang, "n_spans": int(len(spans)), "tails": list(TAILS), "models": {}}
    for name in models:
        sub = df[df.model == name]
        rows = []
        for tail in TAILS:
            g = sub[np.isclose(sub.tail_s, tail)]
            y = (g.label == "eot").to_numpy()
            row = {
                "tail_s": tail,
                "n": int(len(g)),
                "n_effective_lt_tail": int((g.effective_tail_s < tail - 1e-6).sum()),
                "hold_p50": float(g.loc[g.label == "hold", "p"].median()),
                "eot_p50": float(g.loc[g.label == "eot", "p"].median()),
                "hold_p95": float(g.loc[g.label == "hold", "p"].quantile(0.95)),
                "auc": float(roc_auc_score(y, g.p)) if len(set(y.tolist())) > 1 else None,
            }
            rows.append(row)
        summary["models"][name] = rows
    with open(os.path.join(args.out_dir, "tail_curve_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    # 「截回 cap」方案：网格点 d 的分数取 min(d, cap) 处的分数
    for name in models:
        sub = df[df.model == name]
        lookup = {}
        for tail in TAILS:
            if tail <= args.cap + 1e-6:
                for r in sub[np.isclose(sub.tail_s, tail)].itertuples(index=False):
                    lookup[(r.id, r.span_index, round(tail, 2))] = r.p
        capped_tails = sorted({k[2] for k in lookup})
        if not capped_tails:
            continue
        new = preds.copy()
        new_p = []
        for r in new.itertuples(index=False):
            want = min(r.silence_dur, args.cap)
            pick = min(capped_tails, key=lambda t: abs(t - want))
            new_p.append(lookup.get((r.id, r.span_index, pick), np.nan))
        new["p_eot"] = new_p
        missing = int(np.isnan(new["p_eot"]).sum())
        new = new.dropna(subset=["p_eot"])
        path = os.path.join(args.out_dir, f"predictions_{name}_cap{args.cap}.parquet")
        new.to_parquet(path, index=False)
        print(f"[{name}] capped={args.cap} → {path}  (缺失 {missing} 行)")

    print(json.dumps({k: v for k, v in summary.items() if k != "models"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
