"""量两件事：线上开轮时静音到底多长，以及开早了之后用户实际遇到什么。

两件事都只用现有档案 + 现有 `uplink.pcm`，**不碰线上**。口径：

## 量 A：开轮时的静音

对每个 `turn.start`，取它的 `at.pcm`（事件发生时累计收到的上行字节数 → 直接是
`uplink.pcm` 的字节偏移，不需要事件时钟，避免漂移），在 PCM 上**回溯到最后一个
有声帧**，差值就是「开轮那一刻的静音」。

有声判据照抄 `src/utterance-assembler.ts::trackSilence`：20 ms 帧、
`pcm16PeakDbfs > silenceDb`（放大后 −40 dBFS）、连续 2 帧才算有声（去抖）。

## 量 B：开早了之后发生什么

对每个「开轮之后用户又出声」的轮次分三类：

| 类 | 判据 | 用户看到什么 |
|---|---|---|
| **a 出声前被取消/合并** | 用户在 `tts.first` 之前就继续说 | 没听到声音，或者听到的是合并后的完整答复 |
| **b 已出声后被打断** | `tts.first` 早于用户继续说，且 `turn.end.interrupted` | 说到一半被抢 |
| **c 半句当整句答了** | `tts.first` 早于用户继续说，但本轮没被标记打断 | 听了一个完整的（可能答错的）答复，然后用户再补充 |

用法：
    python bench/eot/turn_open_probe.py --arch-root tmp/arch --out tmp/policy-probe/turn_open.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import numpy as np

SR = 16_000
FRAME_MS = 20
FRAME = SR * FRAME_MS // 1000
DEBOUNCE = 2
BYTES_PER_SEC = SR * 2  # 16-bit mono


def frame_peak_dbfs(pcm: np.ndarray) -> np.ndarray:
    n = pcm.size // FRAME
    fr = pcm[: n * FRAME].reshape(n, FRAME).astype(np.float64)
    peak = np.abs(fr).max(axis=1) / 32768.0
    with np.errstate(divide="ignore"):
        return 20.0 * np.log10(np.maximum(peak, 1e-12))


def voiced_mask(dbfs: np.ndarray, floor_db: float) -> np.ndarray:
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


def load_events(path: str) -> list[dict]:
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def text_of(event: dict) -> str:
    value = event.get("text")
    return value if isinstance(value, str) else ""


def analyse_session(dir_path: str, floor_db: float) -> dict:
    ev = load_events(os.path.join(dir_path, "events.jsonl"))
    pcm_path = os.path.join(dir_path, "uplink.pcm")
    raw = np.fromfile(pcm_path, dtype="<i2") if os.path.exists(pcm_path) else np.zeros(0, dtype=np.int16)
    voiced = voiced_mask(frame_peak_dbfs(raw), floor_db) if raw.size else np.zeros(0, dtype=bool)
    total_ms = raw.size / SR * 1000.0

    starts = [e for e in ev if e.get("ev") == "turn.start"]
    tts = [e for e in ev if e.get("ev") == "tts.first"]
    ends = [e for e in ev if e.get("ev") == "turn.end"]
    sents = [e for e in ev if e.get("ev") == "asr.sentence"]
    finals = [e for e in ev if e.get("ev") == "pet.in" and e.get("kind") == "userFinal"]
    decides = [e for e in ev if e.get("ev") == "judge.decide"]

    rows = []
    for i, st in enumerate(starts):
        t0 = st["t"]
        nxt = starts[i + 1]["t"] if i + 1 < len(starts) else float("inf")

        # ---- 量 A ----
        at = st.get("at") or {}
        byte_off = at.get("pcm")
        silence_ms = None
        if isinstance(byte_off, (int, float)) and voiced.size:
            fr = int(min(max(byte_off / (FRAME * 2), 0), voiced.size - 1))
            idx = np.flatnonzero(voiced[: fr + 1])
            if idx.size:
                silence_ms = (fr - int(idx[-1])) * FRAME_MS

        # ---- 量 B ----
        tf = next((e for e in tts if t0 < e["t"] < nxt), None)
        en = next((e for e in ends if t0 < e["t"] < nxt), None)
        # 「用户又出声」必须**紧接**本句，否则只是下一轮对话（实测松窗口会捞到 +6~14 s 的
        # 独立话轮，把它算成"续上半句"会把 c 类灌满假样本）。两个窗口：
        #   开轮后 2.5 s 内 → 用户没被前面的答复挡住，直接继续
        #   本轮结束后 1.2 s 内 → 我们答完一整句，用户立刻补上后半句
        resume_candidates = [
            e for e in sents + finals
            if t0 < e["t"] < nxt and (
                e["t"] - t0 <= 2500
                or (en is not None and 0 <= e["t"] - en["t"] <= 1200)
            )
        ]
        resume = resume_candidates[0] if resume_candidates else None

        outcome = "未继续说"
        if resume is not None and resume["t"] > t0 + 1:
            if tf is None or resume["t"] < tf["t"]:
                outcome = "a 出声前被吸收"
            elif (en or {}).get("interrupted") is True:
                outcome = "b 已出声被打断"
            else:
                outcome = "c 半句当整句答"

        jd = [e for e in decides if t0 - 3000 < e["t"] <= t0]
        rows.append({
            "turn": i + 1,
            "text": text_of(st) or (text_of(en or {})),
            "open_silence_ms": silence_ms,
            "path": (en or {}).get("path"),
            "tts_first_ms": None if tf is None else tf["t"] - t0,
            "resume_after_start_ms": None if resume is None or resume["t"] <= t0 + 1 else resume["t"] - t0,
            "interrupted": (en or {}).get("interrupted"),
            "outcome": outcome,
            "judge_whys": [e.get("why") for e in jd if e.get("action") == "extend"],
        })

    return {
        "session": os.path.basename(dir_path),
        "audio_s": round(total_ms / 1000.0, 1),
        "n_turns": len(starts),
        "rows": rows,
    }


def pct(values, q):
    return None if not values else float(np.percentile(values, q))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch-root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--floor-db", type=float, default=-40.0)
    args = ap.parse_args()

    sessions = [
        analyse_session(d, args.floor_db)
        for d in sorted(glob.glob(os.path.join(args.arch_root, "*")))
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "events.jsonl"))
    ]
    all_rows = [r for s in sessions for r in s["rows"]]

    sil = [r["open_silence_ms"] for r in all_rows if r["open_silence_ms"] is not None]
    out = {
        "floor_db": args.floor_db,
        "n_sessions": len(sessions),
        "n_turns": len(all_rows),
        "measure_a_open_silence": {
            "n": len(sil),
            "p10": pct(sil, 10), "p25": pct(sil, 25), "p50": pct(sil, 50),
            "p75": pct(sil, 75), "p90": pct(sil, 90), "max": None if not sil else max(sil),
            "lt_250": sum(1 for v in sil if v < 250),
            "lt_300": sum(1 for v in sil if v < 300),
            "ge_500": sum(1 for v in sil if v >= 500),
            "ge_800": sum(1 for v in sil if v >= 800),
        },
        "measure_b_outcomes": {},
        "sessions": sessions,
    }
    counts: dict[str, int] = {}
    for r in all_rows:
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
    out["measure_b_outcomes"] = counts

    # 开轮静音 × 结局 交叉表：真正要回答的是「开得早的那些轮，结局是不是更差」
    buckets = [(0, 300), (300, 500), (500, 800), (800, 1200), (1200, 10**9)]
    cross = []
    for lo, hi in buckets:
        sub = [r for r in all_rows if r["open_silence_ms"] is not None and lo <= r["open_silence_ms"] < hi]
        row = {"bucket_ms": f"{lo}-{'∞' if hi > 10000 else hi}", "n": len(sub)}
        for name in ("a 出声前被吸收", "b 已出声被打断", "c 半句当整句答", "未继续说"):
            row[name] = sum(1 for r in sub if r["outcome"] == name)
        bad = row["b 已出声被打断"] + row["c 半句当整句答"]
        row["用户可感知（b+c）"] = bad
        row["可感知率"] = None if not sub else round(bad / len(sub), 3)
        cross.append(row)
    out["measure_c_silence_x_outcome"] = cross

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    pretty = {k: v for k, v in out.items() if k != "sessions"}
    print(json.dumps(pretty, ensure_ascii=False, indent=2))
    print()
    for s in sessions:
        print(f"== {s['session']} ({s['n_turns']} 轮 / {s['audio_s']} s) ==")
        for r in s["rows"]:
            print(
                f"  #{r['turn']:<2} 静音 {str(r['open_silence_ms'] or '-'):>5} ms"
                f"  path {str(r['path']):<5} 出声 {str(r['tts_first_ms'] or '-'):>5}"
                f"  继续说 +{str(r['resume_after_start_ms'] or '-'):>5}"
                f"  {r['outcome']:<12} {r['text'][:22]}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
