"""把「开跑→TTS首块」拆成两截：模型侧（dsh_ms）与 TTS 握手（tts_first_ms）。

`turn.end` 里两个字段正好是这两段的官方口径：
  dsh_ms        agent.reply() 全程（= 模型从开跑到整段说完，含所有 step 与工具往返）
  tts_first_ms  TTS 请求发出 → 首块音频

如果 dsh_ms 占大头，说明「晚」是因为**整段生成**（TTS 等全文）；如果 tts_first_ms
占大头，说明是 TTS 握手/首包。工具调用会体现在 dsh_ms 里，且与答复长度弱相关。
"""
from __future__ import annotations

import json
import pathlib
import statistics

ROOTS = (pathlib.Path.home() / "miai-archive", pathlib.Path.home() / "miai-vectors")


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
    return out


def main() -> int:
    rows: list[dict] = []
    for root in ROOTS:
        if not root.exists():
            continue
        for path in root.iterdir():
            if not (path / "events.jsonl").exists():
                continue
            bench = False
            for ev in load(path):
                if ev.get("ev") == "device.link" and ev.get("label") == "tau2-bench":
                    bench = True
                if ev.get("ev") == "turn.end":
                    dsh = ev.get("dsh_ms")
                    tts = ev.get("tts_first_ms")
                    if isinstance(dsh, (int, float)) and isinstance(tts, (int, float)):
                        rows.append({"dsh": dsh, "tts": tts, "audio_s": ev.get("audio_s") or 0, "bench": bench})

    def p(values: list[float], q: float) -> int:
        values = sorted(values)
        k = max(0, min(len(values) - 1, int(round(q / 100 * (len(values) - 1)))))
        return int(values[k])

    for label, want in (("全部", None), ("bench", True), ("真机", False)):
        sub = [r for r in rows if want is None or r["bench"] is want]
        if not sub:
            continue
        dsh = [r["dsh"] for r in sub]
        tts = [r["tts"] for r in sub]
        print(
            f"\n[{label}] n={len(sub)}"
            f"  dsh_ms p50={p(dsh,50)} p90={p(dsh,90)}"
            f"  |  tts_first_ms p50={p(tts,50)} p90={p(tts,90)}"
            f"  |  合计 p50={p([a+b for a,b in zip(dsh,tts)],50)}"
        )
        for lo, hi, name in ((0, 1.5, "<1.5s"), (1.5, 4.0, "1.5-4s"), (4.0, 999, ">4s")):
            bucket = [r["dsh"] for r in sub if lo <= r["audio_s"] < hi]
            if bucket:
                print(f"    {name:8s} n={len(bucket):<3d} dsh_ms p50={p(bucket,50):>5d}  "
                      f"均={statistics.mean(bucket):>6.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
