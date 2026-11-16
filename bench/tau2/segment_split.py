"""逐轮拆解：把客户端打点和会话档案按「距连接开始的毫秒」对齐。

每轮拿到四个时刻，段与段相加正好等于客户端感知的总延迟：

    anchor_at  客户端的「说完」（连续 300 ms 静音）
    asr.t      服务端 asr.sentence
    turn.t     turn.start（判停定论、开始处理）
    tts.t      tts.first（TTS 首块就绪）
    first_at   客户端真收到第一帧下行

于是：
    ① anchor→asr     说完→ASR 出句
    ② asr→turn       ASR→开跑
    ③ turn→tts       开跑→TTS 首块（含模型生成）
    ④ tts→first      TTS 首块→客户端首帧（下发 + tick 量化）  ← 之前没量过的那段
"""
from __future__ import annotations

import glob
import json
import pathlib
import statistics

ARCHIVES = pathlib.Path.home() / "miai-archive"


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


def archive_for_port(port: int) -> pathlib.Path | None:
    for meta_path in ARCHIVES.glob("*/meta.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if str(meta.get("remote", "")).endswith(f":{port}"):
            return meta_path.parent
    return None


def segment(events: list[dict], start: int, end: int, name: str) -> int | None:
    for ev in events:
        if ev.get("ev") == name and start <= (ev.get("t") or -1) <= end:
            return ev["t"]
    return None


def main() -> int:
    rows: list[dict] = []
    for path in sorted(glob.glob("/tmp/tau2-lat-*.json")):
        try:
            data = json.loads(pathlib.Path(path).read_text())
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(data, list):
            continue
        for rec in data:
            if not isinstance(rec, dict) or "anchor_at" not in rec:
                continue  # 旧打点没有对齐字段，跳过
            events = None
            arch = archive_for_port(int(rec.get("port") or 0))
            if arch is not None:
                events = load(arch)
            asr = turn = tts = None
            if events is not None:
                asr = segment(events, rec["anchor_at"], rec["first_at"], "asr.sentence")
                turn = segment(events, rec["anchor_at"], rec["first_at"], "turn.start")
                tts = segment(events, rec["anchor_at"], rec["first_at"], "tts.first")
            rows.append({
                "total": rec["first_at"] - rec["anchor_at"],
                "a1": (asr - rec["anchor_at"]) if asr else None,
                "a2": (turn - asr) if (turn and asr) else None,
                "a3": (tts - turn) if (tts and turn) else None,
                "a4": (rec["first_at"] - tts) if tts else None,
                "arch": arch.name if arch else "-",
            })

    if not rows:
        print("没有可对齐的打点（需要跑一次新版本）")
        return 1

    def line(key: str, name: str) -> None:
        values = sorted(r[key] for r in rows if isinstance(r.get(key), int))
        if not values:
            print(f"{name:22s} 无数据")
            return
        k = lambda q: values[max(0, min(len(values) - 1, int(round(q / 100 * (len(values) - 1)))))]  # noqa: E731
        print(f"{name:22s} p50={k(50):>5d}  p90={k(90):>5d}  均={statistics.mean(values):>6.0f}  n={len(values)}")

    print(f"对齐成功 {len(rows)} 轮（按端口匹配到档案 {sum(1 for r in rows if r['arch'] != '-')} 轮）\n")
    line("a1", "① 说完→ASR")
    line("a2", "② ASR→开跑")
    line("a3", "③ 开跑→TTS首块")
    line("a4", "④ TTS首块→客户端")
    line("total", "合计 说完→首帧")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
