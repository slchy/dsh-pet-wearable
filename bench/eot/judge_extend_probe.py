"""数判停的延后到底救了几次：每次 `extend` 期间，用户是不是真的又出声了。

判停每喊一次「等一下」都会花掉 `waitMs`。这次等待**有价值**当且仅当用户在等待窗口内
真的重新出声了 —— 那说明「还没说完」的判断是对的。窗口内没出声，就是白等。

两种命中判据，分开报：

- **有声命中**：等待窗口内出现新的有声帧（`peak > silenceDb 换算到放大前`、2 帧去抖）。
  对应线上 `lastVoicedAt` 被推进。这是**线上真正触发等待的条件**。
- **新文本命中**：窗口内来了新的 `asr.partial` / `asr.sentence` / `userFinal`。
  更严 —— 用户不只是出了个声，还产出了新字。

## 时间轴

`judge.decide` 带 `at.pcm`（事件时刻累计收到的上行字节），等待窗口直接在 PCM 上取
`[pcm0, pcm0 + waitMs × 32 字节)`（16 kHz/16-bit = 32 B/ms）。**不经过事件钟**，
避免「两个时钟相差 1.7–2.2 s」那个坑。

用法：
    python bench/eot/judge_extend_probe.py --arch-root tmp/arch --out tmp/policy-probe/extends.json
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
BYTES_PER_MS = SR * 2 / 1000.0  # 32 B/ms
DEBOUNCE = 2


def frame_peak_dbfs(pcm: np.ndarray) -> np.ndarray:
    n = pcm.size // FRAME
    fr = pcm[: n * FRAME].reshape(n, FRAME).astype(np.float64)
    peak = np.abs(fr).max(axis=1) / 32768.0
    with np.errstate(divide="ignore"):
        return 20.0 * np.log10(np.maximum(peak, 1e-12))


def voiced_mask(dbfs: np.ndarray, floor_db: float) -> np.ndarray:
    raw = dbfs > floor_db
    out = np.zeros_like(raw)
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
        out[i] = state
    return out


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


def analyse(dir_path: str) -> dict:
    ev = load_events(os.path.join(dir_path, "events.jsonl"))
    floor = -40.0
    gain = 1.0
    meta_path = os.path.join(dir_path, "meta.json")
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path, encoding="utf-8"))
        if isinstance(meta.get("gateDbfs"), (int, float)):
            floor = float(meta["gateDbfs"])
        if isinstance(meta.get("micGain"), (int, float)) and meta["micGain"] > 0:
            gain = float(meta["micGain"])
    floor_pre = floor - 20.0 * np.log10(gain)

    pcm_path = os.path.join(dir_path, "uplink.pcm")
    raw = np.fromfile(pcm_path, dtype="<i2") if os.path.exists(pcm_path) else np.zeros(0, dtype=np.int16)
    voiced = voiced_mask(frame_peak_dbfs(raw), floor_pre) if raw.size else np.zeros(0, dtype=bool)

    text_events = [e for e in ev if e.get("ev") in ("asr.partial", "asr.sentence")
                   or (e.get("ev") == "pet.in" and e.get("kind") == "userFinal")]

    rows = []
    for e in ev:
        if e.get("ev") != "judge.decide" or e.get("action") != "extend":
            continue
        wait = e.get("waitMs")
        at = (e.get("at") or {}).get("pcm")
        if not isinstance(wait, (int, float)) or wait <= 0:
            continue
        row = {
            "t": e["t"],
            "why": e.get("why"),
            "p": e.get("p"),
            "wait_ms": wait,
            "voiced_hit": None,
            "text_hit": None,
            "n_text_events": 0,
        }
        if isinstance(at, (int, float)) and voiced.size:
            f0 = int(at / (FRAME * 2))
            f1 = int((at + wait * BYTES_PER_MS) / (FRAME * 2))
            f0 = max(0, min(f0, voiced.size - 1))
            f1 = max(f0, min(f1, voiced.size))
            row["voiced_hit"] = bool(voiced[f0 + 1: f1 + 1].any()) if f1 > f0 else False
        in_win = [x for x in text_events if e["t"] < x["t"] <= e["t"] + wait]
        row["text_hit"] = bool(in_win)
        row["n_text_events"] = len(in_win)
        rows.append(row)
    return {"session": os.path.basename(dir_path), "gain": gain, "floor_pre_gain": round(floor_pre, 2),
            "n_extends": len(rows), "rows": rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch-root", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    sessions = [analyse(d) for d in sorted(glob.glob(os.path.join(args.arch_root, "*")))
                if os.path.isdir(d) and os.path.exists(os.path.join(d, "events.jsonl"))]
    rows = [(s["session"], r) for s in sessions for r in s["rows"]]

    by_why: dict[str, dict] = {}
    for _, r in rows:
        k = r["why"] or "?"
        d = by_why.setdefault(k, {"n": 0, "voiced_hit": 0, "text_hit": 0, "wait_sum": 0})
        d["n"] += 1
        d["voiced_hit"] += int(bool(r["voiced_hit"]))
        d["text_hit"] += int(bool(r["text_hit"]))
        d["wait_sum"] += int(r["wait_ms"])

    out = {
        "n_sessions": len(sessions),
        "n_extends": len(rows),
        "by_why": by_why,
        "sessions": sessions,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    print(f"{'why':<12} {'n':>4} {'有声中':>7} {'新文本中':>8} {'总等待ms':>9} {'命中率(有声)':>12}")
    for k, d in sorted(by_why.items(), key=lambda kv: -kv[1]["n"]):
        rate = d["voiced_hit"] / d["n"] * 100
        print(f"{k:<12} {d['n']:>4} {d['voiced_hit']:>7} {d['text_hit']:>8} {d['wait_sum']:>9} {rate:>11.0f}%")
    tot = sum(d["n"] for d in by_why.values())
    hit = sum(d["voiced_hit"] for d in by_why.values())
    txt = sum(d["text_hit"] for d in by_why.values())
    wait = sum(d["wait_sum"] for d in by_why.values())
    print(f"{'合计':<12} {tot:>4} {hit:>7} {txt:>8} {wait:>9} {(hit/tot*100 if tot else 0):>11.0f}%")
    print()
    for s in sessions:
        if not s["rows"]:
            continue
        print(f"== {s['session'][:15]}  {s['n_extends']} 次 extend ==")
        for r in s["rows"]:
            flag = "救到" if r["voiced_hit"] else "白等"
            print(f"  t={r['t']:>7} {str(r['why']):<10} p={r['p']:<6} wait={str(r['wait_ms']):>4}"
                  f"  有声={str(r['voiced_hit']):<5} 新文本={str(r['text_hit']):<5} {flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
