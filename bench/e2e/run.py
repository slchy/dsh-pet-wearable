#!/usr/bin/env python3
"""真机端到端自动化测试：**不接眼镜**，只用手机当喇叭和话筒。

    python scripts/e2e/run.py              # 跑默认的几条话术
    python scripts/e2e/run.py --only 2,3   # 只跑第 2、3 条

每一轮做的事（全部由脚本自己驱动，无人值守）：

  云端 TTS 生成「用户说的话」
        │ scp + adb push
        ▼
  手机喇叭播出来  ──空气──▶  手机麦克风录下来
        │                        │
        │                        ▼ adb pull
        │              PCM16 16k 当上行喂给云端
        ▼                        │
  手机喇叭播回复  ◀──── 24k PCM ──┘

为什么这么绕：这是**唯一**能在没有眼镜的情况下，把「声学 + ASR + agent + TTS + 下行」
全部串起来跑的办法。中间任何一环假的，测出来的延迟就不作数。

断言（任一不过就是这条失败）：
  1. 下行有音频（`downBytes > 0`）
  2. 云端 ASR 认出的字与播出去的字**足够接近**（字符重叠率，逐条可配）
  3. 有标准答案的用例，回复里必须出现那个答案（`EXPECT_ANSWER`）

产物在 `scripts/e2e/out/<n>-<slug>/`（git 忽略）：
  user.pcm   播出去的那段（云端 TTS，24 kHz）
  mic.pcm    手机录到的（16 kHz，含环境噪声）
  reply.pcm  云端回来的回复（24 kHz）
  marks.json 客户端侧时间标记
  events.jsonl  云端这一轮的档案（`asr.sentence` / `tts.first` / `turn.end`）

## 两个必须先知道的坑

**屏幕必须亮。** `dozing` 状态下 Android 直接把录音轨静音（`setRecordSilenced`），
表现是 `peak=0`、ASR 什么也识别不出来。脚本每条用例前都会 `WAKEUP`。

**麦克风不能用 `app_process` 录。** 录音权限走 `AttributionSource`（包名 + AppOps），
`app_process` 没有包身份 —— 拿 root 也一样被静音。所以有一个 30 行的最小 APK
（`scripts/e2e/mictap/`），首次运行会自动编译安装。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
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
REMOTE_HOME = "~/miai-cloud"
REMOTE_SYNTH = "/tmp/e2e-synth.mjs"
REMOTE_TMP = "/tmp/e2e-user.pcm"
PHONE_TMP = "/data/local/tmp"

#: 手机侧的入口类（jar 里都有；在客户端仓（Miaiglassses2grokbot）用 build_android.py --push 推上去）
JAR = "/data/local/tmp/miai.jar"
MICTAP = "com.miaiglasses.mictap/.TapActivity"

CASES = [
    ("chat", "今天心情怎么样", 0.6),
    ("daily", "说一句鼓励我的话", 0.6),
    # 「十七」会被 ASR 写成「17」：数字玩法不同，重叠率天然低，单独放宽
    ("math", "十七乘二十三等于多少", 0.45),
    ("time", "现在几点了", 0.6),
    # 专门用来触发流式（>20 token）：回答会超过两行字，走分段交付
    ("long", "讲三件你觉得有意思的事情，每件说两句", 0.5),
]

#: 最后一条要断言的「正确答案」片段（只在能机械判定的用例上给）
EXPECT_ANSWER = {
    "math": ("391", "三百九十一"),
}


def sh(argv: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def ssh(cmd: str, timeout: int = 120) -> str:
    """ssh 带重试：连着跑几条用例时偶发连不上（实测一次 `Connection timed out`）。"""
    last = ""
    for attempt in range(3):
        r = sh(["ssh", "-i", str(SSH_KEY), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                REMOTE, cmd], timeout)
        if r.returncode == 0:
            return r.stdout or ""
        last = ((r.stdout or "") + (r.stderr or "")).strip()
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"ssh 失败：{cmd}\n{last}")


def _scp(args: list[str], what: str) -> None:
    last = ""
    for attempt in range(3):
        r = sh(["scp", "-i", str(SSH_KEY), "-q", *args])
        if r.returncode == 0:
            return
        last = ((r.stdout or "") + (r.stderr or "")).strip()
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"scp 失败：{what}\n{last}")


def scp(remote: str, local: Path) -> None:
    """服务器 → 本地。"""
    _scp([remote, str(local)], remote)


def scp_local(local: Path, remote: str) -> None:
    """本地 → 服务器。"""
    _scp([str(local), remote], f"{local} → {remote}")


def adb(*args: str, timeout: int = 120) -> str:
    r = sh(["adb", "-s", serial(), *args], timeout)
    return (r.stdout or "") + (r.stderr or "")


_SERIAL = ""


def serial() -> str:
    global _SERIAL
    if _SERIAL:
        return _SERIAL
    r = sh(["adb", "devices"])
    for line in (r.stdout or "").splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            _SERIAL = parts[0]
            return _SERIAL
    raise SystemExit("adb devices 里没有 device 状态的行")


def token_and_device() -> tuple[str, str]:
    """从服务器读一条绑定过的 token。

    绑定关系（`token:deviceId`）必须一起带上：`TokenGate` 会对不上就拒。
    """
    line = ssh(f"head -1 {REMOTE_HOME}/tokens.txt").strip()
    token, _, device = line.partition(":")
    return token.strip(), device.strip()


def synth(text: str, local: Path) -> dict:
    """云端 TTS 合成「用户说的话」，拉回本地。

    用服务器上的 `cosyvoice.ts`（而不是本地造一段音）：素材必须是**线上同一条
    TTS 链路**出来的，否则测出来的时长/停顿跟真实用户说话不是一回事。
    """
    scp_local(ROOT / "scripts" / "e2e" / "synth.mjs", f"{REMOTE}:{REMOTE_SYNTH}")
    out = ssh(
        f"cd {REMOTE_HOME} && set -a && . ./.env && set +a && "
        # 用 shlex.quote 而不是 json.dumps：后者默认 ensure_ascii=True，会把中文
        # 转成 `\u4eca\u5929`，TTS 就照着念这一串转义 —— 实测念了 11 秒，
        # ASR 回来一段英文乱码。
        f"node {REMOTE_SYNTH} {shlex.quote(text)} {REMOTE_TMP}"
    ).strip()
    scp(f"{REMOTE}:{REMOTE_TMP}", local)
    m = re.search(r"rate=(\d+) bytes=(\d+) ms=(\d+)", out)
    if not m:
        raise RuntimeError(f"合成结果看不懂：{out}")
    return {"rate": int(m.group(1)), "bytes": int(m.group(2)), "ms": int(m.group(3))}


def wake_phone() -> None:
    """屏幕必须亮：**dozing 状态下 Android 会把录音轨静音**（实测 peak 0）。"""
    adb("shell", "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard")


def play(remote_pcm: str, rate: int) -> None:
    adb(
        "shell",
        f"app_process -Djava.class.path={JAR} /system/bin com.miaiglasses.MainPlay {remote_pcm} {rate}",
        timeout=180,
    )


def ensure_mictap() -> None:
    """确认手机上装了 MicTap；没有就现编译现装。

    装不上时手动来一遍（MIUI 会拦 adb install，需要 root 身份）：
        python scripts/e2e/mictap/build.py
        adb push scripts/e2e/mictap/out/mictap.apk /data/local/tmp/
        adb shell su -c 'pm install -r -g /data/local/tmp/mictap.apk'
        adb shell pm grant com.miaiglasses.mictap android.permission.RECORD_AUDIO
    """
    installed = adb("shell", "pm list packages com.miaiglasses.mictap")
    if "com.miaiglasses.mictap" in installed:
        return
    print("    手机上没有 MicTap，先编译安装…")
    r = sh([sys.executable, str(HERE / "mictap" / "build.py")], timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"MicTap 编译失败：\n{(r.stdout or '') + (r.stderr or '')}".strip()[-800:])
    apk = HERE / "mictap" / "out" / "mictap.apk"
    adb("push", str(apk), f"{PHONE_TMP}/mictap.apk")
    # MIUI 的「USB 安装」默认关着，shell 身份装不上（INSTALL_FAILED_USER_RESTRICTED）；
    # root 装完再 pm grant，跳过安装界面
    out = adb("shell", f"su -c 'pm install -r -g {PHONE_TMP}/mictap.apk'")
    if "Success" not in out:
        raise RuntimeError(f"MicTap 安装失败：{out.strip()[-300:]}")
    adb("shell", "pm", "grant", "com.miaiglasses.mictap", "android.permission.RECORD_AUDIO")
    print("    ✓ MicTap 已装并授权")


def newest_archive() -> str:
    return ssh("ls -t ~/miai-archive | head -1").strip()


def server_reply(since_iso: str) -> str | None:
    """从服务端日志里取这一轮的回复正文。

    为什么不从下行 PCM 反推：那要再过一遍 ASR，多一个可变环节；而服务端已经把
    `agent X.XX s "..."` 打出来了 —— 验"答得对不对"用它最直接。
    """
    try:
        out = ssh(
            "journalctl -u miai-harness --since " + shlex.quote(since_iso)
            + " --no-pager 2>/dev/null | grep -a '  agent  ' | tail -1"
        )
    except RuntimeError:
        return None
    m = re.search(r'  agent .*?"(.*)"\s*$', out.strip())
    return m.group(1) if m else None


def parse_events(path: Path) -> dict:
    """从会话档案里取这一轮的关键时刻（与 `latency-report.ts` 同一套口径）。"""
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            events.append(json.loads(line))
    out = {
        "asr": None,
        "tts_first_ms": None,
        "dsh_ms": None,
        "audio_s": None,
    }
    for e in events:
        ev = e.get("ev")
        if ev == "asr.sentence" and out["asr"] is None:
            out["asr"] = e.get("text")
        elif ev == "tts.first":
            out["tts_first_ms"] = e.get("ms")
        elif ev == "turn.end":
            out["dsh_ms"] = e.get("dsh_ms")
            out["audio_s"] = e.get("audio_s")
            out["failed"] = e.get("failed", False)
    return out


def overlap(a: str, b: str) -> float:
    """字符多重集重叠率 —— 不引第三方库的「大概听对了」判据。"""
    from collections import Counter

    ca = Counter(re.sub(r"[^\w\u4e00-\u9fff]", "", a))
    cb = Counter(re.sub(r"[^\w\u4e00-\u9fff]", "", b))
    if not ca or not cb:
        return 0.0
    common = sum((ca & cb).values())
    return common / max(sum(ca.values()), sum(cb.values()))


def run_case(index: int, name: str, text: str, min_match: float, args) -> dict:
    dir_ = OUT / f"{index}-{name}"
    shutil.rmtree(dir_, ignore_errors=True)
    dir_.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"\n=== [{index}/{len(CASES)}] {name}  「{text}」")
    wake_phone()
    case_start = time.strftime("%Y-%m-%d %H:%M:%S")

    user_pcm = dir_ / "user.pcm"
    meta = synth(text, user_pcm)
    print(f"    TTS  {meta['ms']} ms @ {meta['rate']} Hz")
    adb("push", str(user_pcm), f"{PHONE_TMP}/user.pcm")

    # 先开录（提前 450 ms），再把话播出来 —— 录到的就是这个"人"说的话
    duration = meta["ms"] + 2500
    started = time.time()
    adb("logcat", "-c")
    adb("shell", f"am start -n {MICTAP} --ei ms {duration} --ei rate 16000 --ei delay 450")
    time.sleep(0.8)
    play(f"{PHONE_TMP}/user.pcm", meta["rate"])
    played_at = time.time() - started
    print(f"    喇叭 播完（开录后 {played_at:.2f} s）")

    wait_until = started + (duration + 450) / 1000 + 8
    while time.time() < wait_until:
        if "DONE " in adb("logcat", "-d", "-s", "MicTap") or "FAILED " in adb("logcat", "-d", "-s", "MicTap"):
            break
        time.sleep(0.5)
    log = adb("logcat", "-d", "-s", "MicTap")
    m = re.search(r"MIC .*peak=(\d+) rms=(\d+)", log)
    if m is None or "DONE " not in log:
        raise RuntimeError(f"录音失败：\n{log.strip()[-600:]}")
    if int(m.group(1)) < 200:
        raise RuntimeError(f"录到的几乎是静音（peak={m.group(1)}）—— 喇叭音量？麦克风被占？")
    print(f"    麦克风 peak={m.group(1)} rms={m.group(2)}")
    adb(
        "shell",
        "su -c 'cp /data/user/0/com.miaiglasses.mictap/files/mic.pcm "
        f"{PHONE_TMP}/mic.pcm && chmod 666 {PHONE_TMP}/mic.pcm'",
    )
    mic = dir_ / "mic.pcm"
    adb("pull", f"{PHONE_TMP}/mic.pcm", str(mic))

    before = newest_archive()
    reply = dir_ / "reply.pcm"
    marks = dir_ / "marks.json"
    token, device = token_and_device()
    r = sh([
        "node", str(HERE.parent / "replay" / "client.mjs"),
        "--host", HOST, "--port", PORT, "--tls",
        "--token", token, "--device", device,
        "--pcm", str(mic), "--rate", "16000",
        "--out", str(reply), "--json", str(marks), "--tail", "9000",
    ], timeout=180)
    print("    " + "\n    ".join((r.stdout or "").strip().splitlines()[-12:]))
    if r.returncode != 0:
        raise RuntimeError("客户端没拿到下行音频")

    mark_data = json.loads(marks.read_text(encoding="utf-8"))

    # 回复真的送到手机喇叭上播一遍（验"手机听得到"，同时给下一次录音留个痕）
    adb("push", str(reply), f"{PHONE_TMP}/reply.pcm")
    play(f"{PHONE_TMP}/reply.pcm", 24000)

    after = newest_archive()
    if after != before:
        scp(f"{REMOTE}:~/miai-archive/{after}/events.jsonl", dir_ / "events.jsonl")
        ev = parse_events(dir_ / "events.jsonl")
    else:
        ev = {"asr": None, "tts_first_ms": None, "dsh_ms": None, "audio_s": None}

    match = overlap(text, ev["asr"] or "")
    # `client.mjs` 现在按轮记录（一条连接可以连说几段），这里取第一轮
    first_turn = (mark_data.get("perTurn") or [{}])[0]
    speech_to_audio = first_turn.get("speechToFirstAudioMs")
    reply_text = server_reply(case_start)

    wanted = EXPECT_ANSWER.get(name)
    answer_ok = True
    if wanted is not None:
        answer_ok = reply_text is not None and any(w in reply_text for w in wanted)

    row = {
        "case": name,
        "said": text,
        "asr": ev["asr"],
        "match": round(match, 2),
        "reply": reply_text,
        "answer_ok": answer_ok,
        "reply_ms": first_turn.get("downMs"),
        "speech_to_audio_ms": speech_to_audio,
        "tts_first_ms": None if ev["tts_first_ms"] is None else round(ev["tts_first_ms"]),
        "dsh_ms": None if ev["dsh_ms"] is None else round(ev["dsh_ms"]),
        "ok": bool(mark_data.get("downBytes")) and match >= min_match and answer_ok,
    }
    print(f"    ASR 「{ev['asr']}」 重叠 {row['match']}  "
          f"说完→首音 {speech_to_audio} ms  dsh {row['dsh_ms']} ms")
    print(f"    回复 「{reply_text}」")
    if not answer_ok:
        print(f"    ✗ 回复里没有 {wanted}")
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只跑这几条，逗号分隔的序号（1 起）")
    args = ap.parse_args()

    if not SSH_KEY.exists():
        raise SystemExit(f"没有 ssh key：{SSH_KEY}")
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"手机 {serial()}  云端 {HOST}:{PORT}")
    print(f"素材与录音 → {OUT}")
    ensure_mictap()

    picked = range(1, len(CASES) + 1)
    if args.only:
        picked = [int(x) for x in args.only.split(",") if x.strip()]

    rows = []
    failed = 0
    for i in picked:
        name, text, min_match = CASES[i - 1]
        try:
            rows.append(run_case(i, name, text, min_match, args))
        except Exception as e:  # noqa: BLE001 —— 一条失败不该中断整轮
            failed += 1
            print(f"    ✗ {e}")
            rows.append({"case": name, "said": text, "ok": False, "error": str(e)[:200]})

    print("\n\n=== 汇总 ===")
    header = (f"{'用例':<8}{'说完→首音':>10}{'dsh':>8}{'TTS首块':>8}{'回复':>7}"
              f"{'ASR重叠':>8}  结果")
    print(header)
    for r in rows:
        if "error" in r:
            print(f"{r['case']:<8}{'—':>10}{'—':>8}{'—':>8}{'—':>7}{'—':>8}  ✗ {r['error'][:40]}")
            continue
        print(f"{r['case']:<8}"
              f"{str(r['speech_to_audio_ms']):>10}"
              f"{str(r['dsh_ms']):>8}"
              f"{str(r['tts_first_ms']):>8}"
              f"{str(r['reply_ms']):>7}"
              f"{r['match']:>8}"
              f"  {'✓' if r['ok'] else '✗'}")
    (OUT / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(1 for r in rows if r.get("ok"))
    print(f"\n{passed} 通过 / {len(rows) - passed} 失败   明细 → {OUT / 'summary.json'}")
    return 0 if failed == 0 and passed == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
