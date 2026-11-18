"""从真机会话档案的 uplink.pcm 量「停顿分布」与「开轮后用户接着说」的比例。

用的**不是**近似规则，而是照抄 src/utterance-assembler.ts::trackSilence 的判法：

- 20 ms 帧，`pcm16PeakDbfs(chunk) > silenceDb`（放大后，出厂 −40 dBFS）算有声；
- 去抖：连续 **2** 帧有声才推进 `lastVoicedAt`（单帧不动）；
- `commitAfterMs = 40`：静音 40 ms 就封段，ASR 解码 ~261 ms，所以定稿到达时静音 ≈ 301 ms；
- 开轮闸门 `openQuietMs = 300`（p ≥ 0.8 时 200）→ 301 ≥ 300 恒满足，闸门不花时间；
- 真刹车只有一条：`p < threshold` 时再加一拍 `extendMs = 200`。

由此得到两个能直接和 eot-bench 对齐的量：

1. **hold 分布**：所有「说完又接着说」的停顿；bench 的 hold 应与之同分布，
   否则 bench 的工作点搬不过来。
2. **误切开轮率**：停顿长过开轮时刻、且用户其实还要继续 → 就是 bench 的 `cutoff_rate`。

用法：
    python real_pause_stats.py --pcm <uplink.pcm> [--events <events.jsonl>] --out <json>
"""
from __future__ import annotations

import argparse
import json

import numpy as np

SR = 16_000
FRAME_MS = 20
FRAME = SR * FRAME_MS // 1000  # 320 采样
DEBOUNCE = 2


def frame_peak_dbfs(pcm: np.ndarray) -> np.ndarray:
    n = pcm.size // FRAME
    fr = pcm[: n * FRAME].reshape(n, FRAME).astype(np.float64)
    peak = np.abs(fr).max(axis=1) / 32768.0
    with np.errstate(divide="ignore"):
        return 20.0 * np.log10(np.maximum(peak, 1e-12))


def voiced_mask(dbfs: np.ndarray, floor_db: float) -> np.ndarray:
    """去抖后的「有声」掩码：单帧有声不改变状态，连续 2 帧才认。"""
    raw = dbfs > floor_db
    voiced = np.zeros_like(raw)
    run = 0
    state = False
    for i, v in enumerate(raw):
        if v:
            run += 1
            if run >= DEBOUNCE:
                state = True
        else:
            run = 0
            state = False
        voiced[i] = state
    return voiced


def runs(mask: np.ndarray):
    """返回 [(start_idx, end_idx_exclusive, value)]"""
    out = []
    if mask.size == 0:
        return out
    cur = mask[0]
    start = 0
    for i in range(1, mask.size):
        if mask[i] != cur:
            out.append((start, i, bool(cur)))
            cur = mask[i]
            start = i
    out.append((start, mask.size, bool(cur)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pcm", required=True)
    ap.add_argument("--events")
    ap.add_argument("--out", required=True)
    ap.add_argument("--floor-db", type=float, default=-40.0)
    ap.add_argument("--arrival-ms", type=float, default=301.0)
    ap.add_argument("--extend-ms", type=float, default=200.0)
    args = ap.parse_args()

    raw = np.fromfile(args.pcm, dtype="<i2")
    dbfs = frame_peak_dbfs(raw)
    voiced = voiced_mask(dbfs, args.floor_db)
    segs = runs(voiced)

    # 一次「开口」的窗口直接用 `at.pcm`（上行字节偏移）确定，避免事件时钟与音频
    # 之间的漂移：`gate.open`/`gate.close` 各自记了当时的累计字节数。
    offset_s = 0.0
    windows = []
    if args.events:
        ev_all = [json.loads(l) for l in open(args.events, encoding="utf-8")]
        opens = [e for e in ev_all if e.get("ev") == "gate.open" and e.get("at", {}).get("pcm")]
        closes = [e for e in ev_all if e.get("ev") == "gate.close" and e.get("at", {}).get("pcm")]
        for o in opens:
            c = next((x for x in closes if x["t"] > o["t"]), None)
            if c is None:
                continue
            lo = o["at"]["pcm"] / 32000.0 * 1000.0
            hi = c["at"]["pcm"] / 32000.0 * 1000.0
            if hi > lo:
                windows.append((lo, hi))

    def window_of(ms: float):
        for lo, hi in windows:
            if lo <= ms <= hi:
                return (lo, hi)
        return None

    pauses = []  # (start_ms, dur_ms, followed_by_speech)
    for i, (s, e, v) in enumerate(segs):
        if v:
            continue
        dur_ms = (e - s) * FRAME_MS
        start_ms = s * FRAME_MS
        followed = i + 1 < len(segs) and segs[i + 1][2]
        win = window_of(start_ms + dur_ms / 2)
        pauses.append({
            "start_ms": start_ms,
            "dur_ms": dur_ms,
            "followed": followed,
            "window": win,
            # 同一窗口内、两侧都有声 → 句中停顿（hold）
            "intra_utterance": bool(followed and win is not None),
            # 同一窗口内、后面没声 → 这一轮的收尾静音（eot）
            "terminal": bool(not followed and win is not None),
        })

    # 与 bench 对齐：bench 的 min_silence=100 ms，更短的静音不进 span
    MIN_PAUSE_MS = 100.0
    hold_all = [p for p in pauses if p["intra_utterance"]]
    hold_in = [p for p in hold_all if p["dur_ms"] >= MIN_PAUSE_MS]
    holds = np.array([p["dur_ms"] for p in hold_in])

    # 每轮收尾静音：窗口内最后一帧有声之后，到**下一次有声**（或音频结束）的时长。
    # 这才是线上真正等待的「句尾静音」，与离线 span 里的 eot duration（录音截断）不是一回事。
    terminal = []
    for lo, hi in windows:
        lo_i, hi_i = int(lo / FRAME_MS), int(hi / FRAME_MS)
        inside = [k for k, (s, e, v) in enumerate(segs) if v and s < hi_i and e > lo_i]
        if not inside:
            continue
        last = inside[-1]
        end_ms = segs[last][1] * FRAME_MS
        t = segs[last][1]
        while t < voiced.size and not voiced[t]:
            t += 1
        dur = (t - segs[last][1]) * FRAME_MS
        terminal.append({"start_ms": end_ms, "dur_ms": float(dur),
                         "until_next_utterance": bool(t < voiced.size)})
    eots = np.array([p["dur_ms"] for p in terminal])

    def pct(a, q):
        return None if a.size == 0 else float(np.percentile(a, q))

    def cut_at(fire_ms):
        if holds.size == 0:
            return None
        return float((holds > fire_ms + 1e-9).sum() / holds.size)

    out = {
        "pcm_seconds": float(raw.size / SR),
        "floor_db": args.floor_db,
        "clock_offset_s": offset_s,
        "n_gate_windows": len(windows),
        "min_pause_ms": MIN_PAUSE_MS,
        "n_pauses": len(pauses),
        "n_holds_intra_utterance": len(hold_all),
        "n_holds_ge100ms": int(holds.size),
        "n_eot": int(eots.size),
        "hold_ms": {
            "p50": pct(holds, 50), "p75": pct(holds, 75), "p90": pct(holds, 90), "p95": pct(holds, 95),
            "max": None if holds.size == 0 else float(holds.max()),
            "gt_301": None if holds.size == 0 else int((holds > 301).sum()),
        },
        "eot_ms": {"p50": pct(eots, 50), "p90": pct(eots, 90), "max": None if eots.size == 0 else float(eots.max()),
                   "note": "窗口内最后一帧有声 → 下一次有声；含用户思考时间，非录音截断"},
        "hold_cdf": {
            "le_100": float((holds <= 100).mean()) if holds.size else None,
            "le_200": float((holds <= 200).mean()) if holds.size else None,
            "le_300": float((holds <= 300).mean()) if holds.size else None,
            "le_500": float((holds <= 500).mean()) if holds.size else None,
            "le_800": float((holds <= 800).mean()) if holds.size else None,
            "le_1000": float((holds <= 1000).mean()) if holds.size else None,
        },
        "false_open_rate": {
            "no_judge_fire_301ms": cut_at(args.arrival_ms),
            "fire_501ms": cut_at(args.arrival_ms + args.extend_ms),
        },
        "pauses": pauses,
    }

    if args.events:
        ev = [json.loads(l) for l in open(args.events, encoding="utf-8")]
        turns = [e for e in ev if e.get("ev") == "turn.end"]
        inter = [bool(t.get("interrupted")) for t in turns if "interrupted" in t]
        ps = [e["p"] for e in ev if e.get("ev") == "judge.decide" and e.get("p", -1) >= 0]
        acts = {}
        for e in ev:
            if e.get("ev") == "judge.decide":
                acts[e.get("action")] = acts.get(e.get("action"), 0) + 1
        waits = [e.get("waitMs", 0) for e in ev if e.get("ev") == "judge.decide"]
        out["events"] = {
            "n_turns": len(turns),
            "interrupted": {"n": int(sum(inter)), "of": len(inter),
                            "rate": None if not inter else float(np.mean(inter))},
            "judge_actions": acts,
            "judge_total_wait_ms": float(sum(waits)),
            "judge_mean_wait_per_decision_ms": None if not waits else float(np.mean(waits)),
            "judge_p": None if not ps else {
                "n": len(ps), "p10": float(np.percentile(ps, 10)), "p50": float(np.percentile(ps, 50)),
                "p90": float(np.percentile(ps, 90)),
                "frac_lt_0.35": float(np.mean(np.array(ps) < 0.35)),
                "frac_lt_0.2": float(np.mean(np.array(ps) < 0.2)),
            },
        }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    p = {k: v for k, v in out.items() if k != "pauses"}
    print(json.dumps(p, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
