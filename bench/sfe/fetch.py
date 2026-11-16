#!/usr/bin/env python3
"""下载 SpeechFCEval 的中文子集（数据在 HF，评测脚本的仓库已经 404）。

    python scripts/bench/sfe/fetch.py                 # 三个中文子集
    python scripts/bench/sfe/fetch.py --subset SpeechFC_SmartInteract
    python scripts/bench/sfe/fetch.py --limit 20      # 每个子集只下前 20 条，试跑用

数据：`FunAudioLLM/SpeechFCEval`（apache-2.0）。中文三个子集加起来 964 条：

| 子集 | 条数 | 音频 | 测什么 |
|---|---|---|---|
| `SpeechFC_SmartInteract` | 668 | TTS | 54 个工具里选对 + 参数对 |
| `SpeechFC_ACEBench_Single` | 208 | **真人** | 单选 / 原子 / 相似 API 混淆 |
| `SpeechFC_ACEBench_Parallel` | 88 | **真人** | 一次调用多个函数 |

为什么走 HTTP 而不是 `git clone`：HF 的 wav 是 LFS 对象，服务器上没有 git-lfs；
`/datasets/<id>/resolve/main/<path>` 这个端点会把 LFS 内容透明地吐出来。

下载到 `~/miai-bench/data/<subset>/`：`metadata.jsonl` + `wav/*.wav`。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DATASET = "FunAudioLLM/SpeechFCEval"
# 服务器在 HK，hf-mirror 比 huggingface.co 稳（实测后者超时）
MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"]
ROOT = Path(os.environ.get("MIAI_BENCH_DIR", Path.home() / "miai-bench"))

CHINESE = [
    "SpeechFC_SmartInteract",
    "SpeechFC_ACEBench_Single",
    "SpeechFC_ACEBench_Parallel",
]


def base_url() -> str:
    for m in MIRRORS:
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10",
             f"{m}/api/datasets/{DATASET}"],
            capture_output=True, text=True,
        )
        if (r.stdout or "").strip() == "200":
            return m
    raise SystemExit("两个镜像都连不上")


def fetch(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["curl", "-sS", "-L", "--max-time", "120", "--retry", "2", "-o", str(dest), url],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        print(f"  ✗ {dest.name}: {(r.stderr or '').strip()[:120]}")
        dest.unlink(missing_ok=True)
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subset", default="", help="只下一个子集")
    ap.add_argument("--limit", type=int, default=0, help="每个子集只下前 N 条")
    args = ap.parse_args()

    base = base_url()
    print(f"镜像 {base}")
    subsets = [args.subset] if args.subset else CHINESE

    for subset in subsets:
        dest_dir = ROOT / "data" / subset
        dest_dir.mkdir(parents=True, exist_ok=True)
        meta = dest_dir / "metadata.jsonl"
        url = f"{base}/datasets/{DATASET}/resolve/main/{subset}/metadata.jsonl"
        if not fetch(url, meta):
            print(f"✗ {subset} 的 metadata 下不下来")
            continue

        rows = [json.loads(line) for line in meta.read_text(encoding="utf-8").splitlines() if line.strip()]
        if args.limit > 0:
            rows = rows[: args.limit]
        print(f"\n{subset}  {len(rows)} 条（metadata 共 {sum(1 for _ in meta.open(encoding='utf-8'))} 行）")

        wavs = [r["file_name"] for r in rows]
        ok = 0
        for i, rel in enumerate(wavs, 1):
            if fetch(f"{base}/datasets/{DATASET}/resolve/main/{subset}/{rel}", dest_dir / rel):
                ok += 1
            if i % 25 == 0 or i == len(wavs):
                print(f"  {i}/{len(wavs)} 已下 {ok}")
        print(f"  ✓ {subset}: {ok}/{len(wavs)} 个 wav")

    print(f"\n数据在 {ROOT / 'data'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
