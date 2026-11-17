#!/usr/bin/env python3
"""句末韵律：中文「说完了」到底有没有可测的声学信号？

## 背景

跨语言研究里最稳的边界线索是**句末延长（final lengthening）**和**末字能量衰减**；
中文还多两条：F0 的下倾 / 边界调，以及句末常见的气声化（creak）。

如果这些信号在我们自己的上行音频里还活着，那它比 smart-turn 的 p 更便宜、更本地
—— 至少可以当灰区（p 落在 0.35–0.5）的仲裁者，不用再问一次模型。

## 这个脚本算什么

对每一句（用档案里的 `at.pcm` 对齐）：

| 列 | 含义 |
|---|---|
| `句长` | 有声总时长（ms） |
| `末段` | **最后一个连续有声段**的长度（ms）—— 句末延长的粗代理 |
| `末段比` | `末段 / 各有声段长度的中位` —— >1.5 像拖尾 |
| `F0斜率` | 最后 300 ms 的基频走向（半音/秒）；负 = 降 |
| `能量斜率` | 最后 200 ms 的能量走向（dB/秒）；负 = 衰减 |
| `F0跨` | 这一句的 F0 动态范围（半音） |

F0 用 40 ms 窗 / 10 ms 步的自相关估（60–400 Hz），只取有声帧。

## 坑

- **切片用 `at.pcm`，不要用 `t × 32`**：`uplink.pcm` 只含设备真推上来的帧，时间轴比
  墙上钟越来越慢（实测 75 s 差 −0.7 s）。
- 「有声」用 −45 dBFS（比开门门限 −40 更低，免得把轻声尾音当静音 —— 这正是
  `pcm16TrimTrailingSilence` 那条坑）。
- 负样本（真没说完）在档案里极少，**这个脚本只给描述性数字，不替代标注数据**。

## 已知局限（2026-11-17 实测后补）

- **`能量斜率` 可用**：14 句里有 12 句是负的（末字衰减），而两个「真没说完」的都是
  **正的**（+148 / +324 dB/秒，能量到切点还在涨）—— 方向和理论一致。
- **`F0斜率` / `F0跨` 现在不可信**：40 ms 自相关在短句、低电平（上行 −40 dBFS）、
  以及句末气声化（creak，周期性差）上会乱给（实测出现过 906 / −485 半音每秒）。
  要用 F0 就得换真 pitch tracker（pyworld / REAPER），别用这份。

    python bench/latency/probe-prosody.py <events.jsonl> <uplink.pcm>
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np

RATE = 16_000
BYTES_PER_MS = RATE // 1000 * 2  # 32
FRAME_MS = 10
FRAME = RATE * FRAME_MS // 1000


def frame_db(audio: np.ndarray) -> np.ndarray:
    n = audio.size // FRAME * FRAME
    if n == 0:
        return np.zeros(0)
    frames = audio[:n].reshape(-1, FRAME)
    rms = np.sqrt((frames ** 2).mean(axis=1)) + 1e-12
    return 20 * np.log10(rms)


def voiced_runs(db: np.ndarray, floor: float) -> list[tuple[int, int]]:
    """返回 [(起帧, 止帧)] —— 连续超过门限的帧段（允许 1 帧空隙）。"""
    loud = db > floor
    runs: list[tuple[int, int]] = []
    start = None
    for i, on in enumerate(loud):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i + 1 < loud.size and loud[i + 1]:   # 1 帧的空隙不算断
                continue
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, loud.size))
    return [(a, b) for a, b in runs if b - a >= 2]


def pitch_track(audio: np.ndarray, floor: float) -> tuple[np.ndarray, np.ndarray]:
    """自相关估 F0。返回 (f0_hz, 帧中心秒)，只保留有声帧。"""
    win, hop = int(RATE * 0.040), int(RATE * 0.010)
    f0s, ts = [], []
    for start in range(0, max(1, audio.size - win), hop):
        seg = audio[start:start + win]
        if seg.size < win:
            break
        if 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12) < floor:
            continue
        seg = seg - seg.mean()
        corr = np.correlate(seg, seg, mode="full")[win - 1:]
        if corr[0] <= 0:
            continue
        corr = corr / corr[0]
        lo, hi = int(RATE / 400), int(RATE / 60)
        if hi >= corr.size:
            continue
        band = corr[lo:hi]
        if band.size == 0:
            continue
        lag = lo + int(np.argmax(band))
        if corr[lag] < 0.3:
            continue
        f0s.append(RATE / lag)
        ts.append((start + win / 2) / RATE)
    return np.array(f0s), np.array(ts)


def slope(xs: np.ndarray, ys: np.ndarray) -> float:
    if xs.size < 3:
        return float("nan")
    x = xs - xs.mean()
    denom = (x ** 2).sum()
    return float("nan") if denom == 0 else float((x * (ys - ys.mean())).sum() / denom)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("events")
    ap.add_argument("pcm")
    ap.add_argument("--dbfs", type=float, default=-45.0)
    args = ap.parse_args(argv[1:])

    audio = np.frombuffer(open(args.pcm, "rb").read(), dtype="<i2").astype(np.float32) / 32768.0
    events = [json.loads(x) for x in open(args.events, encoding="utf-8") if x.strip()]
    sentences = [e for e in events if e["ev"] == "asr.sentence"]
    opens = [e for e in events if e["ev"] == "gate.open"]

    print(f"门限 {args.dbfs:.0f} dBFS；末段 = 最后一个连续有声段；F0 用 40 ms 自相关窗\n")
    print("文本                     句长  末段 末段比  F0斜率  能量斜率  F0跨")
    for s in sentences:
        end_bytes = (s.get("at") or {}).get("pcm", 0)
        if end_bytes <= 0:
            continue
        gate = next((o for o in reversed(opens)
                     if (o.get("at") or {}).get("pcm", 0) <= end_bytes), None)
        start_bytes = 0
        if gate is not None:
            start_bytes = max(0, gate["at"]["pcm"] - gate.get("prerollMs", 0) * BYTES_PER_MS)
        seg = audio[start_bytes // 2: end_bytes // 2]
        if seg.size < RATE // 5:
            continue
        db = frame_db(seg)
        runs = voiced_runs(db, args.dbfs)
        if not runs:
            print(f"{s.get('text', '')[:20]:<22} （没有有声段）")
            continue
        lens = np.array([(b - a) * FRAME_MS for a, b in runs], dtype=float)
        last = lens[-1]
        ratio = last / float(np.median(lens)) if lens.size > 1 else float("nan")

        f0, ts = pitch_track(seg, args.dbfs)
        f0_slope = energy_slope = f0_range = float("nan")
        if f0.size >= 4:
            tail = ts >= (ts.max() - 0.30)
            if tail.sum() >= 3:
                f0_slope = slope(ts[tail], 12 * np.log2(f0[tail] / 100.0))    # 半音/秒
            f0_range = 12 * float(np.log2(np.percentile(f0, 95) / max(1e-6, np.percentile(f0, 5))))
        if db.size >= 5:
            n = min(20, db.size)
            energy_slope = slope(np.arange(n) * 0.010, db[-n:])               # dB/秒

        print(f"{s.get('text', '')[:20]:<22} {lens.sum():5.0f} {last:5.0f} {ratio:5.2f} "
              f"{f0_slope:8.1f} {energy_slope:9.1f} {f0_range:5.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
