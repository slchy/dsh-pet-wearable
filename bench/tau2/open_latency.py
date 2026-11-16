"""验证「τ² 任务让模型开口更晚」这个说法：按答复长度分桶看 turn.start→tts.first。

真机档案和 bench 档案都有 `turn.start` / `tts.first` / `turn.end`，口径一致，能直接比。
`turn.end.audio_s` 是这一轮**说出来的音频时长**，当作答复长度的代理。
"""
from __future__ import annotations

import json
import pathlib
import statistics

ROOT = pathlib.Path.home() / "miai-archive"
#: 真机向量回放的档案单独存放（`--pin` 钉住的那些），布局和 archive 一样
VECTORS = pathlib.Path.home() / "miai-vectors"


def load(path: pathlib.Path) -> list[dict]:
    out = []
    for line in (path / "events.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return sorted(out, key=lambda ev: ev.get("t") or 0)


def is_bench(events: list[dict]) -> bool:
    return any(ev.get("ev") == "device.link" and ev.get("label") == "tau2-bench" for ev in events)


def turns(events: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for ev in events:
        if ev.get("ev") == "turn.start":
            rows.append({"turn": ev.get("t"), "user_len": ev.get("text_len")})
        elif ev.get("ev") == "tts.first" and rows and "tts" not in rows[-1]:
            rows[-1]["tts"] = ev.get("t")
        elif ev.get("ev") == "turn.end" and rows and "audio_s" not in rows[-1]:
            rows[-1]["audio_s"] = ev.get("audio_s")
            rows[-1]["dsh_ms"] = ev.get("dsh_ms")
    out = []
    for row in rows:
        if "tts" in row and "turn" in row:
            row["open_ms"] = row["tts"] - row["turn"]
            out.append(row)
    return out


def main() -> int:
    groups: dict[str, list[dict]] = {"真机": [], "bench": []}
    for root in (ROOT, VECTORS):
        if not root.exists():
            continue
        for path in root.iterdir():
            if not (path / "events.jsonl").exists():
                continue
            events = load(path)
            if not events:
                continue
            key = "bench" if is_bench(events) else "真机"
            groups[key].extend(turns(events))

    def p(values: list[float], q: float) -> int:
        values = sorted(values)
        k = max(0, min(len(values) - 1, int(round(q / 100 * (len(values) - 1)))))
        return int(values[k])

    for name, rows in groups.items():
        rows = [r for r in rows if isinstance(r.get("audio_s"), (int, float))]
        if not rows:
            print(f"{name}: 无数据")
            continue
        opens = [r["open_ms"] for r in rows]
        audios = [r["audio_s"] for r in rows]
        print(
            f"\n[{name}] n={len(rows)}  开跑→TTS首块 p50={p(opens,50)} p90={p(opens,90)}  "
            f"答复时长 p50={statistics.median(audios):.1f}s"
        )
        for lo, hi, label in ((0, 1.5, "答复<1.5s"), (1.5, 4.0, "1.5-4s"), (4.0, 999, "答复>4s")):
            bucket = [r["open_ms"] for r in rows if lo <= r["audio_s"] < hi]
            if bucket:
                print(f"    {label:10s} n={len(bucket):<3d} p50={p(bucket,50):>5d}  p90={p(bucket,90):>5d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
