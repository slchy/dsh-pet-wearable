#!/usr/bin/env python3
"""云端 harness：接收手机推来的 mSBC → 解码 → VAD 判停 → ASR。

    python cloud/harness.py --port 8765

手机侧（另一个终端）：

    adb -s <内网地址>:5555 reverse tcp:8765 tcp:8765

为什么要放云端
--------------
mSBC 解码需要 SBC 解码器，手机端没有（官方用的是 native 库，拿不到）。
而 ffmpeg + webrtcvad 在 PC 上现成可用，且这是**唯一**能在嘈杂环境可靠工作的组合。

手机只需把字节原样推过来，保持「只做管道」。

协议
----
极简：客户端连上后发 raw mSBC 字节流，服务端自己找帧边界。
判停由服务端决定，不依赖客户端的任何信号。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / "tmp"

FFMPEG = Path(
    r"C:\TRPG-Harness\.venv\Lib\site-packages\imageio_ffmpeg\binaries"
    r"\ffmpeg-win-x86_64-v9.0.2.exe"
)

SAMPLE_RATE = 16_000
FRAME_MS = 30
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2      # 960

SILENCE_END_MS = 1_500          # 连续静音多久判停
MIN_SPEECH_MS = 300             # 至少说过这么久才算一轮有效

API_URL = "https://api.xiaomimimo.com/v1/chat/completions"
ASR_MODEL = "mimo-v2.5-asr"


# ---------------------------------------------------------------- ASR
def wav_wrap(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    block = 2
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * block, block, 16)
    header += b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def asr(pcm: bytes) -> tuple[str, float]:
    key = os.environ.get("MIMO_API_KEY", "").strip()
    if not key:
        return "(未设置 MIMO_API_KEY)", 0.0

    b64 = base64.b64encode(wav_wrap(pcm)).decode("ascii")
    body = {
        "model": ASR_MODEL,
        "messages": [{"role": "user", "content": [{
            "type": "input_audio",
            "input_audio": {"data": "data:audio/wav;base64," + b64},
        }]}],
        "asr_options": {"language": "auto"},
        "stream": False,
    }
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode(), method="POST")
    req.add_header("api-key", key)
    req.add_header("Content-Type", "application/json")

    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            obj = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return f"(HTTP {e.code}) {e.read().decode('utf-8', 'replace')[:200]}", 0.0
    except Exception as e:
        return f"({type(e).__name__}) {e}", 0.0

    text = ""
    for ch in obj.get("choices") or []:
        content = (ch.get("message") or {}).get("content")
        if isinstance(content, str):
            text += content
    return text.strip(), time.monotonic() - t0


# ---------------------------------------------------------------- 单连接
def handle(conn: socket.socket, addr, vad_mode: int) -> None:
    peer = f"{addr[0]}:{addr[1]}"
    print(f"\n[conn] 来自 {peer}")
    t0 = time.monotonic()

    ff = subprocess.Popen(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error",
         "-f", "sbc", "-i", "pipe:0",
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    vad = webrtcvad.Vad(vad_mode)
    stop = threading.Event()

    def pump() -> None:
        """socket → ffmpeg stdin。ffmpeg 边收边解，输出走另一个线程。"""
        try:
            while not stop.is_set():
                chunk = conn.recv(8192)
                if not chunk:
                    break
                ff.stdin.write(chunk)
                ff.stdin.flush()
        except Exception:
            pass
        finally:
            try:
                ff.stdin.close()
            except Exception:
                pass

    threading.Thread(target=pump, daemon=True).start()

    pcm = bytearray()
    has_speech = False
    speech_frames = 0
    silence_frames = 0
    end_at: float | None = None

    while True:
        buf = ff.stdout.read(FRAME_BYTES)
        if not buf or len(buf) < FRAME_BYTES:
            break
        pcm.extend(buf)
        if vad.is_speech(buf, SAMPLE_RATE):
            has_speech = True
            speech_frames += 1
            silence_frames = 0
        else:
            silence_frames += 1
            if has_speech and silence_frames * FRAME_MS >= SILENCE_END_MS:
                end_at = time.monotonic() - t0
                break

    stop.set()
    try:
        conn.close()
    except Exception:
        pass
    try:
        ff.kill()
    except Exception:
        pass

    speech_ms = speech_frames * FRAME_MS
    total_s = len(pcm) / (SAMPLE_RATE * 2)

    if end_at is not None:
        print(f"[vad] 判停 @ {end_at:.2f}s（静音 {SILENCE_END_MS} ms）")
    else:
        print("[vad] 流结束未判停（客户端先断了）")
    print(f"[vad] 语音 {speech_ms} ms / 缓冲 {total_s:.2f}s")

    if speech_ms < MIN_SPEECH_MS:
        print("[vad] 有效语音太短，跳过 ASR")
        return

    # 去掉尾部静音：只送最后一个语音帧之后的一小段
    keep = max(0, len(pcm) - (SILENCE_END_MS + 300) * (SAMPLE_RATE * 2 // 1000))
    keep -= keep % FRAME_BYTES
    audio = bytes(pcm[keep:])
    print(f"[asr] 送识别 {len(audio) / (SAMPLE_RATE * 2):.2f}s ...")

    text, cost = asr(audio)
    print(f"[asr] {cost:.2f}s  「{text}」")

    TMP.mkdir(exist_ok=True)
    name = TMP / f"cloud_{int(t0 * 1000)}.wav"
    with wave.open(str(name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(audio)
    print(f"[asr] 存盘 {name.name}")
    print(f"ASR_TEXT={text}")


# ---------------------------------------------------------------- 服务
def serve(port: int, vad_mode: int) -> int:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("127.0.0.1", port))
    except OSError as e:
        print(f"[cloud] 绑定 {port} 失败: {e}")
        return 1
    srv.listen(4)

    print(f"[cloud] 监听 127.0.0.1:{port}  vad_mode={vad_mode} "
          f"判停静音={SILENCE_END_MS}ms")
    print("[cloud] 手机侧需先执行: adb -s <serial> reverse tcp:%d tcp:%d" % (port, port))

    try:
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=handle, args=(conn, addr, vad_mode),
                             daemon=True).start()
    except KeyboardInterrupt:
        print("\n[cloud] 退出")
    finally:
        srv.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--vad-mode", type=int, default=2, choices=[0, 1, 2, 3],
                    help="0 最宽松，3 最激进")
    args = ap.parse_args()

    try:
        import webrtcvad  # noqa: F401
    except ImportError:
        print("[cloud] 缺少 webrtcvad：python -m pip install webrtcvad-wheels")
        return 1

    return serve(args.port, args.vad_mode)


if __name__ == "__main__":
    sys.exit(main())
