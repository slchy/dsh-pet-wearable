#!/usr/bin/env python3
"""真机向量回放：把**某场真机会话录下的上行音频**原速重放一遍，逐轮对比。

    python scripts/replay/run.py                       # 拿最新一场真机会话，回放前 3 轮
    python scripts/replay/run.py --archive 20261116-005927-182.135.0.22_10021 --turns 0
    python scripts/replay/run.py --list                # 列出可回放的会话

## 为什么是它，而不是 E2E

档案里每一场真机会话都留着：

| 文件 | 内容 |
|---|---|
| `uplink.pcm` | 解码后的 PCM16 16 kHz，**放大前**，从连接建立起连续写 |
| `events.jsonl` | 每个时刻：`gate.open` / `gate.close` / `asr.sentence` / `turn.start` / `tts.first` / `turn.end` |

所以「用户说了什么」是**真机真录**的（真实口音、真实噪声、真实停顿），而且
**同一份向量可以反复喂**：改一次代码跑一次，逐段对比，不受说话人当天状态影响。
E2E（手机喇叭 + 麦克风）只在没有历史录音、或者要验声学通路时才用得上。

## 它量什么

每个时刻都在**服务端档案**里，客户端只负责按原速送音频。逐轮给出：

- **①** 停嘴 → ASR 定稿（ASR 服务端静音窗 + 网关往返）
- **②** ASR 定稿 → 开轮（判停器 + 判停决策）
- **③** 开轮 → 首块音频（dsh + 上游首 token + TTS 首包）
- **ASR 文本**：与源档案是否逐字一致

默认连 `127.0.0.1`（在服务器上跑），把广域网的抖动从测量里摘出去；要比线上
真实延迟就用 `--host <服务器地址>` 走公网。

## 副作用

回放会**真的跑完这些轮次**，dsh 会话里会多出这些对话（和真人说了一遍一样）。
跑完想清干净就换一个 `session.json`：
`~/voice-agent/session.json` 删掉即可开新会话。
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "out"

HOST = os.environ.get("MIAI_HOST", "127.0.0.1")
PORT = os.environ.get("MIAI_PORT", "63993")
SSH_KEY = Path(os.environ.get("MIAI_SSH_KEY", "~/.ssh/id_ed25519")).expanduser()
REMOTE = f'{os.environ.get("MIAI_SSH_USER", "root")}@{HOST}'
REMOTE_ARCHIVE = "~/miai-archive"
# 向量库：**回放的输入必须钉在这里**，不能直接用 `~/miai-archive`。
#
# 原因很实际：回放本身会产生新档案，而 `MIAI_ARCHIVE_KEEP=20` 会滚动删除。
# 踩过一次 —— 回放一场真机会话把唯一那份 12 轮向量挤掉了，工具吃掉了自己的输入。
# 所以第一次用到某场档案时先 `cp -r` 进向量库，之后永远从向量库读。
REMOTE_VECTORS = "~/miai-vectors"
REMOTE_CLIENT = "/tmp/miai-replay-client.mjs"


def sh(argv: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def ssh(cmd: str, timeout: int = 300) -> str:
    last = ""
    for attempt in range(3):
        r = sh(["ssh", "-i", str(SSH_KEY), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                REMOTE, cmd], timeout)
        if r.returncode == 0:
            return r.stdout or ""
        last = ((r.stdout or "") + (r.stderr or "")).strip()
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"ssh 失败：{cmd}\n{last}")


def scp_down(remote: str, local: Path) -> None:
    last = ""
    for attempt in range(3):
        r = sh(["scp", "-i", str(SSH_KEY), "-q", remote, str(local)])
        if r.returncode == 0:
            return
        last = ((r.stdout or "") + (r.stderr or "")).strip()
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"scp 失败：{remote}\n{last}")


def scp_up(local: Path, remote: str) -> None:
    last = ""
    for attempt in range(3):
        r = sh(["scp", "-i", str(SSH_KEY), "-q", str(local), remote])
        if r.returncode == 0:
            return
        last = ((r.stdout or "") + (r.stderr or "")).strip()
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"scp 失败：{local} → {remote}\n{last}")


def list_archives() -> list[str]:
    out = ssh(f"ls -t {REMOTE_ARCHIVE}")
    return [line.strip() for line in out.splitlines() if line.strip()]


def list_vectors() -> list[str]:
    out = ssh(f"ls -t {REMOTE_VECTORS} 2>/dev/null || true")
    return [line.strip() for line in out.splitlines() if line.strip()]


def pin_vector(name: str) -> str:
    """把一场档案固定进向量库（已有就跳过），返回向量库里的路径。"""
    if name in list_vectors():
        return f"{REMOTE_VECTORS}/{name}"
    if name not in list_archives():
        raise SystemExit(f"向量库和档案里都没有 {name}（先用 --list 看看）")
    ssh(
        f"mkdir -p {REMOTE_VECTORS} && cp -r {REMOTE_ARCHIVE}/{name} {REMOTE_VECTORS}/{name} "
        f"&& ls -l {REMOTE_VECTORS}/{name}"
    )
    print(f"  已钉进向量库：{REMOTE_VECTORS}/{name}")
    return f"{REMOTE_VECTORS}/{name}"


def token_and_device() -> tuple[str, str]:
    line = ssh("head -1 ~/miai-cloud/tokens.txt").strip()
    token, _, device = line.partition(":")
    return token.strip(), device.strip()


def parse(path: Path) -> list[dict]:
    """把事件流折成逐轮：①/②/③ + ASR 文本（与 `latency-report.ts` 同一套口径）。"""
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    starts = [i for i, e in enumerate(events) if e.get("ev") == "turn.start"]
    out: list[dict] = []
    for n, at in enumerate(starts):
        prev = starts[n - 1] if n else -1
        nxt = starts[n + 1] if n + 1 < len(starts) else len(events)
        asr = tts = gate = None
        for i in range(at - 1, prev, -1):
            if events[i].get("ev") == "asr.sentence":
                asr = i
                break
        for i in range(at, nxt):
            if events[i].get("ev") == "tts.first":
                tts = i
                break
        for i in range(asr if asr is not None else at, nxt):
            if events[i].get("ev") == "gate.close":
                gate = i
                break
        stop = None
        if gate is not None:
            g = events[gate]
            stop = g["t"] - (g.get("gapMs") or 0)
        out.append({
            "turn": n + 1,
            "asr": events[asr].get("text") if asr is not None else None,
            "a1": (events[asr]["t"] - stop) if (asr is not None and stop is not None) else None,
            "a2": (events[at]["t"] - events[asr]["t"]) if asr is not None else None,
            "a3": (events[tts]["t"] - events[at]["t"]) if tts is not None else None,
            "total": (events[tts]["t"] - stop) if (tts is not None and stop is not None) else None,
        })
    return out


def cell(v) -> str:
    return "—" if v is None else str(round(v))


def pct(values: list, p: float) -> str:
    """线性插值分位数（与 `latency-report.ts` 一致，不用最近秩法）。"""
    kept = sorted(v for v in values if v is not None)
    if not kept:
        return "—"
    k = (len(kept) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(kept) - 1)
    return str(round(kept[lo] + (kept[hi] - kept[lo]) * (k - lo)))


def show(title: str, rows: list[dict]) -> None:
    print(f"\n{title}  （{len(rows)} 轮）")
    print(f"  {'轮':>3} {'① 停嘴→ASR':>12} {'② →开轮':>9} {'③ →首块':>8} {'合计':>7}   ASR")
    for r in rows:
        print(f"  {r['turn']:>3} {cell(r['a1']):>12} {cell(r['a2']):>9} {cell(r['a3']):>8}"
              f" {cell(r['total']):>7}   {(r['asr'] or '')[:26]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default="", help="会话档案名（不给就用最新一场）")
    ap.add_argument("--turns", type=int, default=3, help="回放前几轮（0 = 全部）")
    ap.add_argument("--mode", default="utterance", choices=["utterance", "stream"],
                    help="utterance=一轮一轮（可逐轮对账，默认）；stream=整段原速重放（验打断）")
    ap.add_argument("--list", action="store_true", help="只列出可回放的会话")
    ap.add_argument("--pin", action="store_true", help="只把 --archive 钉进向量库，不回放")
    ap.add_argument("--host", default="127.0.0.1",
                    help="127.0.0.1 = 在服务器本机连（摘掉公网抖动）；填服务器地址则走公网")
    ap.add_argument("--repeat", type=int, default=1,
                    help="重复几次取分布（② 是双峰的：不延长 ≈150ms、延长一拍 ≈620ms，"
                         "单次跑只能看到其中一个峰）")
    ap.add_argument("--port", default=PORT)
    ap.add_argument("--no-tls", action="store_true")
    args = ap.parse_args()

    if not SSH_KEY.exists():
        raise SystemExit(f"没有 ssh key：{SSH_KEY}")

    archives = list_archives()
    vectors = list_vectors()
    if args.list:
        print(f"向量库 {REMOTE_VECTORS}（{len(vectors)} 份，回放只从这里读）")
        for name in vectors:
            print(f"  ✓ {name}")
        print(f"\n档案 {REMOTE_ARCHIVE}（{len(archives)} 份，会被滚动删除）")
        for name in archives:
            mark = "  ✓" if name in vectors else "   "
            print(f"{mark} {name}")
        return 0
    if not archives and not vectors:
        raise SystemExit("服务器上没有任何档案")

    source = args.archive or (vectors[0] if vectors else archives[0])
    print(f"源档案 {source}  （向量库 {len(vectors)} 份 / 档案 {len(archives)} 份）")

    if args.pin:
        pin_vector(source)
        return 0
    vector_path = pin_vector(source) if source not in vectors else f"{REMOTE_VECTORS}/{source}"

    OUT.mkdir(parents=True, exist_ok=True)
    src_events = OUT / f"source-{source}.jsonl"
    scp_down(f"{REMOTE}:{vector_path}/events.jsonl", src_events)
    before = parse(src_events)
    show("【源】真机当时", before)

    turns = args.turns if args.turns > 0 else len(before)
    scp_up(HERE / "client.mjs", f"{REMOTE}:{REMOTE_CLIENT}")
    token, device = token_and_device()
    tls = "" if args.no_tls else "--tls"
    # 在服务器上跑：`127.0.0.1` 时音频不出机器，①/③ 里没有公网往返
    cmd = (
        f"node {REMOTE_CLIENT} --vector {vector_path} --mode {args.mode} "
        f"--host {shlex.quote(args.host)} --port {shlex.quote(str(args.port))} {tls} "
        f"--token {shlex.quote(token)} --device {shlex.quote(device)} "
        f"--turns {turns}"
    )
    print(f"\n回放 {turns} 轮 → {args.host}:{args.port} …（源长度决定耗时，约 {turns * 6} s 起）")

    runs: list[list[dict]] = []
    for rep in range(max(1, args.repeat)):
        before_list = list_archives()
        out = ssh(cmd, timeout=600)
        if args.repeat > 1:
            print(f"\n--- 第 {rep + 1}/{args.repeat} 次 ---")
        print("  " + "\n  ".join(out.strip().splitlines()[-4:]))

        # 新档案 = 这次连接产生的（不在跑之前的列表里，且不是源档案）
        candidates = [n for n in list_archives() if n not in before_list and n != source]
        if not candidates:
            raise SystemExit("没找到本次回放的档案 —— 连接可能没建立")
        fresh = candidates[0]
        new_events = OUT / f"replay-{fresh}.jsonl"
        scp_down(f"{REMOTE}:{REMOTE_ARCHIVE}/{fresh}/events.jsonl", new_events)
        rows = parse(new_events)
        runs.append(rows)
        last = fresh

    after = runs[-1]
    show("【回放】这次", after)

    if not after:
        raise SystemExit("回放没有产生任何一轮 —— 音频没被识别？")

    print("\n=== 逐轮对比 ===")
    print(f"  {'轮':>3} {'①源→新':>14} {'②源→新':>14} {'③源→新':>14}  ASR")
    same = 0
    for i in range(min(len(before), len(after))):
        s, n = before[i], after[i]
        mark = "✓" if s["asr"] == n["asr"] else "✗"
        if s["asr"] == n["asr"]:
            same += 1
        print(f"  {i + 1:>3} {cell(s['a1']) + '→' + cell(n['a1']):>14}"
              f" {cell(s['a2']) + '→' + cell(n['a2']):>14}"
              f" {cell(s['a3']) + '→' + cell(n['a3']):>14}  {mark} {(n['asr'] or '')[:24]}")
    print(f"\nASR 逐字一致 {same}/{min(len(before), len(after))} 轮"
          f"（源 {len(before)} 轮 / 回放 {len(after)} 轮）")

    if args.repeat > 1:
        print(f"\n=== {args.repeat} 次的分布 ===")
        for key, label in (("a1", "①"), ("a2", "②"), ("a3", "③")):
            src = [r[key] for r in before if r[key] is not None]
            new = [r[key] for rows in runs for r in rows if r[key] is not None]
            print(f"  {label}  源 p50 {pct(src, 0.5)} p90 {pct(src, 0.9)}"
                  f"   |  回放 n={len(new)} p50 {pct(new, 0.5)} p90 {pct(new, 0.9)}")

    (OUT / "last.json").write_text(
        json.dumps({"source": source, "replay": last, "before": before, "runs": runs},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"明细 → {OUT / 'last.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
