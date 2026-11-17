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
import re
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
# 合成素材单独一个库：**真机和 TTS/装置造出来的东西不能混**。
# 两边的数字没有可比性（合成音没有真实口音、噪声、停顿，ASR 的 partial 也短得多），
# 混在一个库里就会出现「拿合成回放当基准，还以为是真机」—— 已经踩过。
REMOTE_SYNTH = "~/miai-vectors-synth"
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


def source_kind(name: str) -> str:
    """这份素材是谁的：`real`（真机 mSBC 上行）还是 `synth`（bench 适配器 / TTS 合成）。

    判据看 `meta.json`：**真机一定是 mSBC**（`uplinkCodec=msbc`、`uplink.sbc` 非空、
    `remote` 是公网或内网地址）；bench 适配器没有 mSBC 编码器，走 PCM16 + 回环地址。

    为什么非要分：两边的数字没有可比性 —— 合成音没有真实口音、噪声、停顿，ASR 的
    partial 也短得多（实测短句只出 1–2 个字，够不到投机门槛）。混在一起就会出现
    「拿合成回放当基准，还写进文档说这是真机」—— 已经踩过。
    """
    txt = ssh(
        f'for f in {REMOTE_VECTORS}/{name}/meta.json {REMOTE_SYNTH}/{name}/meta.json '
        f'{REMOTE_ARCHIVE}/{name}/meta.json; do if [ -f "$f" ]; then cat "$f"; break; fi; done'
    ).strip()
    if not txt:
        raise SystemExit(f"没有 {name} 的 meta.json（先用 --list 看看）")
    try:
        meta = json.loads(txt)
    except json.JSONDecodeError:
        raise SystemExit(f"{name} 的 meta.json 读不了")
    if str(meta.get("uplinkCodec") or "") == "msbc":
        return "real"
    return "synth"


def vectors_dir(kind: str) -> str:
    return REMOTE_VECTORS if kind == "real" else REMOTE_SYNTH


def list_vectors(kind: str = "real") -> list[str]:
    out = ssh(f"ls -t {vectors_dir(kind)} 2>/dev/null || true")
    return [line.strip() for line in out.splitlines() if line.strip()]


def pin_vector(name: str, kind: str) -> str:
    """把一场档案固定进**对应来源**的向量库（已有就跳过），返回库里的路径。"""
    root = vectors_dir(kind)
    if name in list_vectors(kind):
        return f"{root}/{name}"
    if name not in list_archives():
        raise SystemExit(f"档案里没有 {name}（先用 --list 看看）")
    ssh(
        f"mkdir -p {root} && cp -r {REMOTE_ARCHIVE}/{name} {root}/{name} "
        f"&& ls -l {root}/{name}"
    )
    print(f"  已钉进{'真机' if kind == 'real' else '合成'}向量库：{root}/{name}")
    return f"{root}/{name}"


def token_and_device() -> tuple[str, str]:
    line = ssh("head -1 ~/miai-cloud/tokens.txt").strip()
    token, _, device = line.partition(":")
    return token.strip(), device.strip()


# ---------------------------------------------------------------- 自起 harness
#
# 回放**不再打生产 63993**：那条连接也会在生产档案目录里生成一份档案，而
# `MIAI_ARCHIVE_KEEP` 只留最近 20 个 —— 每回放一场就挤掉一份真实设备档案
# （实测：21 个目录里 13 个是回放/bench 场）。这里起一个只服务本次回放的实例，
# 档案、记忆、会话指针、播报队列全部关在自己目录里。
#
# 不隔离的后果逐条列在 `bench/tau2/run_voice.py::bench_env` 里，两边同一套规矩。


def spawn_harness(port: int, bench_dir: str, repo: str) -> None:
    """在服务器上起一个隔离的 harness，等到端口可连为止。"""
    print(f"\n起隔离 harness：端口 {port}，目录 {bench_dir}（不碰生产 63993）")
    ssh(
        "set -e; "
        f"cd {repo}; "
        "set -a; . .env; set +a; "
        f"mkdir -p {bench_dir}/archive; "
        f"export MIAI_ARCHIVE_DIR={bench_dir}/archive; "
        f"export MEMORY_FILE={bench_dir}/fastlane-memory.md; "
        f"export VOICE_AGENT_SESSION={bench_dir}/session.json; "
        f"export PHOTO_DIR={bench_dir}/photos; "
        "export MIAI_ANNOUNCE_FILE=; "
        # 额外配置（A/B 实验用）：`MIAI_BENCH_ENV="K1=V1;K2=V2"`，只放行 KEY=VALUE 与分号，
        # 免得把任意 shell 塞进这条 ssh 命令里。
        f"{extra_env()} "
        # 收掉上一场：**按端口认进程，别用 `pkill -f '--listen <port>'`** ——
        # 这条 ssh 命令自己的命令行里就含那串字，pkill 会把当前 shell 一起杀掉，
        # 表现是「启动脚本悄悄什么都没做」（实测踩过）。
        f"{kill_on_port(port)}; "
        f": > {bench_dir}/harness.log; "
        # 参数照抄生产的 ExecStart（`--agent dsh --dsh-sdk` 是必须的：流式识别
        # 收到 SentenceEnd 就要接一轮对话，没 agent 直接退出）；`--stt/--tts`
        # 走 .env 里的 MIAI_*，不在这里重复一遍配置
        f"setsid node src/main.ts --listen {port} --host 127.0.0.1 --agent dsh --dsh-sdk "
        f"--work-dir {bench_dir}/workspace >> {bench_dir}/harness.log 2>&1 & "
        f"for i in $(seq 1 90); do ss -ltn 2>/dev/null | grep -q ':{port} ' && exit 0; sleep 1; done; "
        f"tail -20 {bench_dir}/harness.log; exit 1",
        timeout=150,
    )
    print("harness 已就绪")


def kill_on_port(port: int) -> str:
    """按监听端口找 PID 并杀掉（不按命令行匹配，避免误杀自己）。"""
    return (
        f"PID=$(ss -ltnp 2>/dev/null | grep ':{port} ' | grep -oP 'pid=\\K[0-9]+' | head -1); "
        "[ -n \"$PID\" ] && kill \"$PID\" 2>/dev/null || true"
    )


def extra_env() -> str:
    """`MIAI_BENCH_ENV="K1=V1;K2=V2"` → `export K1=V1; K2=V2;`，A/B 实验用。

    只放行 `KEY=VALUE` 与分号：这条字符串会拼进 ssh 命令，宽松就等于把 shell 交给环境变量。
    """
    raw = os.environ.get("MIAI_BENCH_ENV", "").strip()
    if not raw:
        return ""
    pairs = [p.strip() for p in raw.split(";") if p.strip()]
    for p in pairs:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:\-/]*", p):
            raise SystemExit(f"MIAI_BENCH_ENV 里有一项不像 KEY=VALUE：{p!r}")
    return "export " + " ".join(p + ";" for p in pairs) + " "


def stop_harness(port: int) -> None:
    """收尾：只杀本次回放起的那个实例（按端口认）。"""
    try:
        ssh(kill_on_port(port), timeout=60)
    except RuntimeError:
        pass  # 收尾失败不该盖住结果


def bench_archives(bench_dir: str) -> list[str]:
    out = ssh(f"ls -1dt {bench_dir}/archive/*/ 2>/dev/null | head -50 || true")
    return [Path(line.strip().rstrip("/")).name for line in out.splitlines() if line.strip()]




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
    ap.add_argument("--spawn", dest="spawn", action="store_true", default=True,
                    help="自己起一个**只服务本次回放**的 harness（默认）；不动生产 63993")
    ap.add_argument("--no-spawn", dest="spawn", action="store_false",
                    help="连已有的 harness（原来的行为，会往生产档案目录里写）")
    ap.add_argument("--bench-port", type=int, default=8767, help="自起 harness 的端口")
    ap.add_argument("--bench-dir", default="/tmp/miai-replay", help="自起 harness 的工作目录（含档案）")
    ap.add_argument("--repo", default="$HOME/miai-cloud", help="服务器上本仓的路径")
    ap.add_argument("--pcm", default="",
                    help="改用**服务器上**的 PCM16 16k 文件（逗号分隔，每个算一轮）代替向量回放。"
                         "用来验造出来的音频，比如「一句话被切成两段」——配方见 README")
    args = ap.parse_args()

    if not SSH_KEY.exists():
        raise SystemExit(f"没有 ssh key：{SSH_KEY}")

    archives = list_archives()
    real_vectors = list_vectors("real")
    synth_vectors = list_vectors("synth")
    pcm_paths = [p.strip() for p in args.pcm.split(',') if p.strip()]
    if args.list:
        for kind, root, names in (
            ("真机", REMOTE_VECTORS, real_vectors),
            ("合成", REMOTE_SYNTH, synth_vectors),
        ):
            print(f"{kind}向量库 {root}（{len(names)} 份）")
            for name in names:
                print(f"  ✓ {name}")
        print(f"\n档案 {REMOTE_ARCHIVE}（{len(archives)} 份，会被滚动删除；"
              f"末尾标 real/synth 的是来源）")
        for name in archives:
            try:
                kind = "real" if source_kind(name) == "real" else "synth"
            except SystemExit:
                kind = "?"
            print(f"   [{kind:5}] {name}")
        return 0
    if not archives and not pcm_paths:
        raise SystemExit("服务器上没有任何档案")

    if pcm_paths:
        # 造出来的音频（`--pcm`）：没有源档案可对账，只出审计和这一场的时序
        source = "(pcm)"
        before: list[dict] = []
        vector_path = ""
        print("--pcm 模式：造出来的音频，**不是真机素材**，结果不能混进真机基准")
    else:
        # 不给 --archive 时只从**真机**库里挑；空就说清楚，绝不自作主张退到合成库
        if args.archive:
            source = args.archive
            kind = source_kind(source)
        elif real_vectors:
            source = real_vectors[0]
            kind = "real"
        else:
            raise SystemExit(
                f"真机向量库 {REMOTE_VECTORS} 是空的。\n"
                f"  合成库 {REMOTE_SYNTH} 里有 {len(synth_vectors)} 份，要跑得显式指定："
                f"--archive <名字>\n"
                f"  真机素材要靠真设备说话录出来（`MIAI_ARCHIVE_KEEP` 会滚掉，记得 --pin）"
            )
        label = "真机 mSBC" if kind == "real" else "合成/回放（PCM16，**不能当基准**）"
        print(f"源档案 {source}   来源={label}")

        if args.pin:
            pin_vector(source, kind)
            return 0
        vector_path = pin_vector(source, kind)

        OUT.mkdir(parents=True, exist_ok=True)
        src_events = OUT / f"source-{source}.jsonl"
        scp_down(f"{REMOTE}:{vector_path}/events.jsonl", src_events)
        before = parse(src_events)
        show("【源】真机当时", before)

    # 回放默认**自己起一个隔离 harness**：不打生产端口，档案也不会挤掉真实设备的
    if args.spawn:
        spawn_harness(args.bench_port, args.bench_dir, args.repo)
        host, port = "127.0.0.1", str(args.bench_port)
        # 生产的 .env 里配了 TLS 证书，隔离实例沿用同一套（客户端本来就是 127.0.0.1 连）
        tls = "" if args.no_tls else "--tls"
        archive_root = f"{args.bench_dir}/archive"
    else:
        host, port, tls = args.host, str(args.port), "" if args.no_tls else "--tls"
        archive_root = REMOTE_ARCHIVE

    turns = args.turns if args.turns > 0 else len(before)
    scp_up(HERE / "client.mjs", f"{REMOTE}:{REMOTE_CLIENT}")
    token, device = token_and_device()
    if pcm_paths:
        target = f"--pcm {shlex.quote(','.join(pcm_paths))}"
        turns = len(pcm_paths)
    else:
        target = f"--vector {vector_path} --mode {args.mode}"
    # 在服务器上跑：`127.0.0.1` 时音频不出机器，①/③ 里没有公网往返
    cmd = (
        f"node {REMOTE_CLIENT} {target} "
        f"--host {shlex.quote(host)} --port {shlex.quote(port)} {tls} "
        f"--token {shlex.quote(token)} --device {shlex.quote(device)} "
        f"--turns {turns}"
    )
    print(f"\n回放 {turns} 轮 → {host}:{port} …（源长度决定耗时，约 {turns * 6} s 起）")

    runs: list[list[dict]] = []
    last = ""
    try:
        for rep in range(max(1, args.repeat)):
            before_list = bench_archives(args.bench_dir) if args.spawn else list_archives()
            out = ssh(cmd, timeout=600)
            if args.repeat > 1:
                print(f"\n--- 第 {rep + 1}/{args.repeat} 次 ---")
            print("  " + "\n  ".join(out.strip().splitlines()[-4:]))

            # 新档案 = 这次连接产生的（不在跑之前的列表里，且不是源档案）
            now = bench_archives(args.bench_dir) if args.spawn else list_archives()
            candidates = [n for n in now if n not in before_list and n != source]
            if not candidates:
                raise SystemExit("没找到本次回放的档案 —— 连接可能没建立")
            fresh = candidates[0]
            new_events = OUT / f"replay-{fresh}.jsonl"
            scp_down(f"{REMOTE}:{archive_root}/{fresh}/events.jsonl", new_events)
            rows = parse(new_events)
            runs.append(rows)
            last = fresh
    finally:
        if args.spawn:
            stop_harness(args.bench_port)

    after = runs[-1]
    show("【回放】这次", after)

    if not after:
        raise SystemExit("回放没有产生任何一轮 —— 音频没被识别？")

    # 时序与状态轮转审计：这一场的**主要出口**。任务做没做成先不管，
    # 这条链（停嘴 → 出句 → 开轮 → 首块 → 播完）和状态轮转必须自洽。
    # `|| true`：有违规时审计器退出码是 1，但我们要的是把报告打出来。
    audit = ssh(
        f"cd {args.repo} && node --experimental-strip-types scripts/fsm-trace-check.ts "
        f"{archive_root}/{last} || true",
        timeout=120,
    )
    print("\n=== 时序 / 状态审计（回放这一场）")
    print(audit.rstrip())

    print("\n=== 逐轮对比 ===")
    if not before:
        print("  （`--pcm` 模式没有源档案可比：看上面审计与 `last.json` 的 runs）")
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
          f"（源 {len(before)} 轮 / 回放 {len(after)} 轮）" if before
          else f"\n回放 {len(after)} 轮（`--pcm` 模式，无源可比）")

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
