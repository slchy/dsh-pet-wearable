"""真机音频上的配对重放：同一段 `uplink.pcm` 喂两个判停模型。

回答的问题：Scicom tiny 在 **eot-bench 干净切片** 上比现役强（AUC 0.840 vs 0.754），
但它在真机音频上是不是也强？真机是 mSBC 解码、增益 4 倍放大、噪声底不同的音频，
而 Scicom 已知"尾部静音一长分数就塌"，说明它对输入分布敏感。

## 口径

喂给模型的窗口 = **线上真正喂的那一段**：

```
pcm[ : lastVoicedSample + 200ms ]
```

`lastVoicedSample` 来自线上同一套判法（20 ms 帧、`gateDbfs` 换算到放大前、2 帧去抖），
200 ms 是 `TURN_JUDGE_PAUSE_DETECT_MS` —— 线上一到 200 ms 静音就先算一次判停。

## 对照的真值

`turn_open_probe.py` 那套：开轮后 **≤1500 ms** 用户又出声 = 这个停顿其实没说完。

用法：
    python bench/eot/paired_replay.py --arch-root tmp/arch --models ours=... scicom=... --out x.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np

SR = 16_000
FRAME_MS = 20
FRAME = SR * FRAME_MS // 1000
DEBOUNCE = 2
PRE_DETECT_MS = 200.0


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


def windows_from_session(dir_path: str):
    ev = load_events(os.path.join(dir_path, "events.jsonl"))
    floor, gain = -40.0, 1.0
    meta_path = os.path.join(dir_path, "meta.json")
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path, encoding="utf-8"))
        if isinstance(meta.get("gateDbfs"), (int, float)):
            floor = float(meta["gateDbfs"])
        if isinstance(meta.get("micGain"), (int, float)) and meta["micGain"] > 0:
            gain = float(meta["micGain"])
    floor_pre = floor - 20.0 * np.log10(gain)

    pcm_path = os.path.join(dir_path, "uplink.pcm")
    if not os.path.exists(pcm_path):
        return []
    raw = np.fromfile(pcm_path, dtype="<i2")
    voiced = voiced_mask(frame_peak_dbfs(raw), floor_pre)

    starts = [e for e in ev if e.get("ev") == "turn.start"]
    tts = [e for e in ev if e.get("ev") == "tts.first"]
    sents = [e for e in ev if e.get("ev") == "asr.sentence"]
    finals = [e for e in ev if e.get("ev") == "pet.in" and e.get("kind") == "userFinal"]

    out = []
    for i, st in enumerate(starts):
        at = (st.get("at") or {}).get("pcm")
        if not isinstance(at, (int, float)) or not voiced.size:
            continue
        fr = int(min(max(at / (FRAME * 2), 0), voiced.size - 1))
        idx = np.flatnonzero(voiced[: fr + 1])
        if not idx.size:
            continue
        last_voiced = int(idx[-1])
        end = min(raw.size, int(last_voiced * FRAME + PRE_DETECT_MS / FRAME_MS * FRAME))
        window = raw[:end].astype(np.float32) / 32768.0
        if window.size < SR // 2:
            continue
        t0 = st["t"]
        nxt = starts[i + 1]["t"] if i + 1 < len(starts) else float("inf")
        nxt = min(nxt, t0 + 1500)
        continued = any(t0 < e["t"] <= nxt for e in sents + finals)
        out.append({
            "session": os.path.basename(dir_path),
            "turn": i + 1,
            "silence_ms": int((fr - last_voiced) * FRAME_MS),
            "window_s": round(window.size / SR, 2),
            "continued": bool(continued),
            "audio": window,
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch-root", required=True)
    ap.add_argument("--models", nargs="+", required=True, help="name=module:Class")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    wins = []
    for d in sorted(glob.glob(os.path.join(args.arch_root, "*"))):
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "events.jsonl")):
            wins.extend(windows_from_session(d))
    print(f"真机窗口 {len(wins)} 个（{len({w['session'] for w in wins})} 场），"
          f"其中「用户接着说」{sum(w['continued'] for w in wins)} 个")

    adapters = {}
    for spec in args.models:
        name, _, target = spec.partition("=")
        mod_name, _, cls = target.partition(":")
        __import__(mod_name)
        adapters[name] = getattr(sys.modules[mod_name], cls)()

    for name, ad in adapters.items():
        for w in wins:
            w[name] = float(ad.predict_batch([{"audio": {"array": w["audio"], "sampling_rate": SR}}])[0])

    names = list(adapters)
    print()
    print("轮次           静音ms  接着说  " + "  ".join(f"{n:>8}" for n in names))
    for w in wins:
        print(f"{w['session'][:14]} #{w['turn']:<2} {w['silence_ms']:>7}  {str(w['continued']):<5}  "
              + "  ".join(f"{w[n]:>8.3f}" for n in names))

    print()
    print("=== 按「开轮」判据看：p ≥ 阈值 就开轮 ===")
    print("（真值「接着说」= 这个停顿其实没说完，此时开轮就是误切）")
    print(f"{'模型':<10}{'阈值':>6}{'开轮数':>7}{'误切':>6}{'误切率':>8}{'漏开':>6}")
    for name in names:
        for thr in (0.3, 0.5, 0.7, 0.8):
            opened = [w for w in wins if w[name] >= thr]
            bad = [w for w in opened if w["continued"]]
            missed = [w for w in wins if w["continued"] and w[name] < thr]
            print(f"{name:<10}{thr:>6.1f}{len(opened):>7}{len(bad):>6}"
                  f"{(len(bad)/len(opened)*100 if opened else 0):>7.0f}%{len(missed):>6}")

    if args.out:
        slim = [{k: v for k, v in w.items() if k != "audio"} for w in wins]
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"n": len(slim), "rows": slim}, fh, ensure_ascii=False, indent=2)
        print(f"\n写入 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
