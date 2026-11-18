"""把线上真实策略搬到 eot-bench 口径上，并给出同口径零模型基线与配对 bootstrap 区间。

回答补证清单前三项：

1. 线上策略（判停在 `p < threshold` 时加一次 `extendMs` 延后）在 bench 上的
   （平均等待, 误切率），以及同口径的零模型基线。
2. `max_hold_span_duration` 改成 1.0 / 1.5 时，五个模型的排序翻不翻。
3. 按 span 配对 bootstrap 重跑 sweep，给 5% 等待和 δ 曲线出区间。

口径与 `eot_harness/metrics.py::_policy_sweep_rows` 保持一致：
- score_point 模式：每个 span 只有静音 0.2 s 处的一个分数，fire_time 即该点；
- 误切（cutoff）= 该 hold 的停顿比 fire_time 更长（用户本来会接着说）；
- 等待（latency）= eot 的开轮时刻 = fire_time（eot 的静音会一直延续，不受 span 时长限制）。

线上策略映射（见 src/utterance-assembler.ts）：
- 定稿到达时静音 `commitMs + asrMs`（实测 40 + 261 ≈ 301 ms）；
- `openQuiet = p >= 0.8 ? 200 : 300`，因 301 ≥ 300 恒已满足 → **闸门不花时间**；
- `p >= threshold` → 收下；否则加一次 `extendMs`(200)，`maxUnsure=1` 后再评估时
  「音频没变」捷径生效 → 收下。故 fire_time = 301 ms（高 p）或 501 ms（低 p）。
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import numpy as np
import pandas as pd

ARRIVAL_MS = 301  # commit 40 + ASR 定稿 261（实测中位）
EXTEND_MS = 200
SCORE_POINT = 0.2


def load_spans(span_set: str, preds: str) -> pd.DataFrame:
    spans = pd.read_parquet(span_set)[["id", "span_index", "label", "duration"]]
    p = pd.read_parquet(preds)
    p = p[np.isclose(p["silence_dur"], SCORE_POINT)][["id", "span_index", "p_eot"]]
    m = spans.merge(p, on=["id", "span_index"], how="inner")
    if m["p_eot"].isna().any():
        raise SystemExit(f"{preds}: 有 span 缺 0.2s 分数")
    return m


def policy_online(spans: pd.DataFrame, threshold: float, arrival=ARRIVAL_MS, extend=EXTEND_MS):
    """线上策略：高 p 在定稿到达时开轮，低 p 再加一拍。返回 (latency_s, cutoff, detail)。"""
    fire = np.where(spans["p_eot"].to_numpy() >= threshold, arrival, arrival + extend)
    dur = spans["duration"].to_numpy() * 1000.0
    hold = spans["label"].to_numpy() == "hold"
    cutoff = bool(hold.any()) and float(((dur > fire + 1e-9) & hold).sum() / hold.sum())
    latency = float(fire[~hold].mean()) / 1000.0
    return latency, cutoff, {"n_low_p": int((spans["p_eot"].to_numpy() < threshold).sum())}


def policy_constant(spans: pd.DataFrame, delay_ms: float):
    """零模型：固定等到 delay_ms。latency = delay；cutoff = P(hold 停得比它久)。"""
    dur = spans["duration"].to_numpy() * 1000.0
    hold = spans["label"].to_numpy() == "hold"
    cutoff = float((dur[hold] > delay_ms + 1e-9).sum() / hold.sum())
    return delay_ms / 1000.0, cutoff


def zero_model_baseline(spans: pd.DataFrame, budget: float) -> dict:
    """零模型在给定误切预算下的最优固定等待。

    只能取**观测到的** hold 时长（固定等待是个常数，取观测值即最优），
    且要处理并列：同一时长有多个 hold 时，「严格大于它」的个数才是误切数。
    """
    dur = np.sort(spans.loc[spans["label"] == "hold", "duration"].to_numpy()) * 1000.0
    n = dur.size
    allowed = int(np.floor(budget * n + 1e-9))
    # 固定等待 d 越小越快，但误切越多；要的是**最小的**满足预算的 d。
    # 升序遍历，第一个 `#(>d) <= allowed` 就是答案。
    best = None
    for i in range(n):
        gt = int((dur > dur[i] + 1e-9).sum())
        if gt <= allowed:
            best = (float(dur[i]), gt / n)
            break
    if best is None:  # 连最长的 hold 都超预算
        best = (float(dur.max()), 1.0)
    return {
        "delay_ms": best[0],
        "cutoff": best[1],
        "n_allowed": allowed,
        "n_hold": n,
        "n_hold_gt_1000ms": int((dur > 1000).sum()),
        "hold_p95_ms": float(np.percentile(dur, 95)),
        "hold_max_ms": float(dur.max()),
        "top40_ms": [float(x) for x in dur[::-1][:40]],
    }


def sweep_delta(spans: pd.DataFrame, thresholds, deltas):
    """bench 原口径的 δ 曲线：5% 误切预算下每个 action_delay 的检出率。"""
    hold = spans[spans["label"] == "hold"]
    eot = spans[spans["label"] == "eot"]
    hd = hold["duration"].to_numpy()  # 秒，与 deltas 同单位
    hp = hold["p_eot"].to_numpy()
    ep = eot["p_eot"].to_numpy()
    out = {}
    for delta in deltas:
        best = (0.0, None)
        for thr in thresholds:
            cut = ((hp > thr) & (hd > delta + 1e-9)).mean()
            if cut > 0.05 + 1e-9:
                continue
            det = float((ep > thr).mean())
            if det > best[0]:
                best = (det, float(thr))
        out[float(delta)] = {"detect": best[0], "threshold": best[1]}
    return out


def five_pct_point(spans: pd.DataFrame, thresholds, deltas, timeouts):
    """照着 metrics.py 的 sweep 复刻，取 5% 预算下等待最小的策略点。"""
    hold = spans[spans["label"] == "hold"]
    eot = spans[spans["label"] == "eot"]
    hd = hold["duration"].to_numpy()
    hp = hold["p_eot"].to_numpy()
    ep = eot["p_eot"].to_numpy()
    best = None
    for thr in thresholds:
        hold_fire = np.where(hp > thr, SCORE_POINT, np.inf)
        eot_fire = np.where(ep > thr, SCORE_POINT, np.inf)
        for delta in deltas:
            hmf = np.maximum(delta, hold_fire)
            hfire = np.isfinite(hold_fire)
            model_cutoff = hfire & (hd > hmf + 1e-9)
            emf = np.maximum(delta, eot_fire)
            for timeout in timeouts:
                if timeout + 1e-9 < delta:
                    continue
                cutoff = (hd > timeout + 1e-9) | model_cutoff
                detect = np.isfinite(eot_fire) & (emf <= timeout + 1e-9)
                lat = float(np.where(detect, emf, timeout).mean())
                cr = float(cutoff.mean())
                if cr <= 0.05 + 1e-9 and (best is None or lat < best["latency"]):
                    best = {
                        "latency": lat,
                        "threshold": float(thr),
                        "action_delay": float(delta),
                        "timeout": float(timeout),
                        "cutoff": cr,
                        "detect": float(detect.mean()),
                    }
    return best


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--span-set", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--preds", nargs="+", required=True, help="name=path")
    ap.add_argument("--boot", type=int, default=400)
    args = ap.parse_args()

    spans_by = {}
    for spec in args.preds:
        name, path = spec.split("=", 1)
        spans_by[name] = load_spans(args.span_set, path)

    base = spans_by[list(spans_by)[0]]
    result = {"arrival_ms": ARRIVAL_MS, "extend_ms": EXTEND_MS, "score_point_s": SCORE_POINT}

    # ---- 项 1：线上策略 + 同口径零模型 ----
    item1 = {"zero_model": {}, "online_policy": {}, "span_stats": {}}
    for budget in (0.02, 0.05, 0.10):
        item1["zero_model"][f"{int(budget*100)}pct"] = zero_model_baseline(base, budget)
    item1["span_stats"] = {
        "n_hold": int((base["label"] == "hold").sum()),
        "n_eot": int((base["label"] == "eot").sum()),
        "hold_gt_301ms": int(((base["label"] == "hold") & (base["duration"] > 0.301)).sum()),
        "hold_gt_301ms_frac": float(
            ((base["label"] == "hold") & (base["duration"] > 0.301)).sum() / (base["label"] == "hold").sum()
        ),
        "hold_gt_501ms": int(((base["label"] == "hold") & (base["duration"] > 0.501)).sum()),
        "hold_gt_501ms_frac": float(
            ((base["label"] == "hold") & (base["duration"] > 0.501)).sum() / (base["label"] == "hold").sum()
        ),
    }
    for name, sp in spans_by.items():
        lat, cut, det = policy_online(sp, threshold=0.5)
        lat70, cut70, _ = policy_online(sp, threshold=0.7)
        item1["online_policy"][name] = {
            "thr0.5": {"latency_s": lat, "cutoff": cut, **det},
            "thr0.7": {"latency_s": lat70, "cutoff": cut70},
        }
    item1["no_judge"] = {
        "latency_s": ARRIVAL_MS / 1000.0,
        "cutoff": float((base.loc[base["label"] == "hold", "duration"] > 0.301).mean()),
    }
    result["item1_online_vs_zero"] = item1

    # ---- 项 2：max_hold_span_duration 敏感性 ----
    # ⚠️ 只筛 **hold**：`eot_harness.metrics.span_table_from_predictions` 里
    # 条件是 `(label != "hold") | hold_in_range`，即 eot 永远保留、不参与时长过滤。
    # 早先这里写成 `sp[duration <= cap]` 把 eot 一起筛掉了（344 → 196 → 90），
    # 那一版结论已作废并换成了「线上形状 + 延迟预算」的口径，不必重跑。
    thresholds = np.round(np.arange(0.02, 0.99, 0.01), 4)
    deltas = np.round(np.arange(0.2, 1.01, 0.1), 2)
    timeouts = np.round(np.arange(1.0, 3.51, 0.5), 2)
    item2 = {}
    for cap in (5.0, 1.5, 1.0):
        row = {}
        for name, sp in spans_by.items():
            keep = (sp["label"] != "hold") | (sp["duration"] <= cap + 1e-9)
            sub = sp[keep]
            pt = five_pct_point(sub, thresholds, deltas, timeouts)
            row[name] = {
                "n_hold": int((sub["label"] == "hold").sum()),
                "n_eot": int((sub["label"] == "eot").sum()),
                "five_pct_latency": None if pt is None else pt["latency"],
                "zero_model": zero_model_baseline(sub, 0.05)["delay_ms"] / 1000.0,
            }
        item2[f"max_hold_{cap}"] = row
    result["item2_max_hold_sensitivity"] = item2

    # ---- 项 3：配对 bootstrap ----
    rng = np.random.default_rng(20261118)
    ids = sorted({(r.id, r.span_index) for r in base.itertuples(index=False)})
    idx = {k: i for i, k in enumerate(ids)}
    item3 = {}
    for name, sp in spans_by.items():
        key = list(zip(sp["id"], sp["span_index"]))
        pos = np.array([idx[k] for k in key])
        n_ids = len(ids)
        boots = {"five_pct": [], "zero": [], "diff": []}
        delta_acc = {float(d): [] for d in deltas}
        # 预先把每个 span 的 (label, dur, p) 排成按 id 索引的数组
        lab = sp["label"].to_numpy()
        dur = sp["duration"].to_numpy()
        pv = sp["p_eot"].to_numpy()
        order = np.argsort(pos)
        pos_s, lab_s, dur_s, pv_s = pos[order], lab[order], dur[order], pv[order]
        starts = np.searchsorted(pos_s, np.arange(n_ids), side="left")
        ends = np.searchsorted(pos_s, np.arange(n_ids), side="right")
        for _ in range(args.boot):
            pick = rng.integers(0, n_ids, n_ids)
            sel = np.concatenate([np.arange(starts[i], ends[i]) for i in pick])
            sub = pd.DataFrame({"label": lab_s[sel], "duration": dur_s[sel], "p_eot": pv_s[sel]})
            if (sub["label"] == "hold").sum() == 0 or (sub["label"] == "eot").sum() == 0:
                continue
            pt = five_pct_point(sub, thresholds, deltas, timeouts)
            z = zero_model_baseline(sub, 0.05)["delay_ms"] / 1000.0
            boots["zero"].append(z)
            if pt is not None:
                boots["five_pct"].append(pt["latency"])
                boots["diff"].append(z - pt["latency"])  # 配对：同一份重采样的优势
            d = sweep_delta(sub, thresholds, deltas)
            for k, v in d.items():
                delta_acc[k].append(v["detect"])
        def ci(v, lo=2.5, hi=97.5):
            v = np.asarray([x for x in v if x == x], dtype=float)
            return [float(np.percentile(v, lo)), float(np.percentile(v, hi))] if v.size else None
        pt = five_pct_point(sp, thresholds, deltas, timeouts)
        item3[name] = {
            "point": pt,
            "five_pct_ci": ci(boots["five_pct"]),
            "zero_ci": ci(boots["zero"]),
            "advantage_ci_paired": ci(boots["diff"]),
            "advantage_point": (zero_model_baseline(sp, 0.05)["delay_ms"] / 1000.0
                                - (pt["latency"] if pt else float("nan"))),
            "n_boot": len(boots["five_pct"]),
            "n_boot_infeasible": int(sum(1 for x in boots["five_pct"] if x != x)),
            "delta_detect": {str(k): ci(v) for k, v in delta_acc.items()},
            "delta_point": sweep_delta(sp, thresholds, deltas),
        }
    result["item3_bootstrap"] = item3

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2, default=float)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=float))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
