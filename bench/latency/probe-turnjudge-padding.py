#!/usr/bin/env python3
"""判停概率 vs **喂给模型的窗口**（含正/负样本对照）。

## 为什么

`p` 一直被当噪声：一句完整问句在停嘴那一刻只有 0.02–0.07，同一句两次回放 0.549 vs
0.189。先把「模型不行」排除掉，再问「我们喂进去的是不是模型训练时那种东西」。

官方参考实现（`pipecat-ai/smart-turn` 的 `inference.py` + `audio_utils.py`）：

    audio = truncate_audio_to_last_n_seconds(audio, 8)   # 不足 8 s 在**开头**补零
    inputs = WhisperFeatureExtractor(chunk_length=8)(audio, do_normalize=True, ...)

pipecat 线上（`BaseSmartTurn.analyze_end_of_turn`）取的窗口也是**按这一句裁的**：

    start = speech_start - (pre_speech_ms + vad_start_secs*1000)   # pre_speech_ms 默认 500
    end   = 缓冲区最后一个样本（= 现在）

而我们的 `UtteranceAssembler` 喂的是 `recentChunks`：**连续 8 s 上行**
（`ASSEMBLER_RECENT_SECONDS = 8`，`addAudio` 每帧都收，不看能量门）。

## 对齐（踩过的坑）

**不要拿事件里的墙上时间 `t` 去切 PCM**：`uplink.pcm` 只包含设备真的推上来的帧，
播放期间设备停推，所以 PCM 时间轴比墙上时钟**越来越慢**（这份档案末尾差 −3.8 s）。
每个事件自带 `at.pcm` / `at.down`（字节偏移），一律用它。

## 三种窗口 × 正负样本

| 模式 | 窗口 |
|---|---|
| `roll` | 连续上行的最近 8 s（= 现状） |
| `scoped-front` | `[语音起点 − 500 ms, 语音末 + N]`，不足 8 s **前面**补零（= 上游） |
| `scoped-back` | 同上但**后面**补零（= `server.py` 现在的补法） |

- **正样本**：窗口结束在「最后一个有声样本 + N ms」
- **负样本**：窗口结束在这一句的 30% / 50% / 70% 处（话还没说完）

    python bench/latency/probe-turnjudge-padding.py <events.jsonl> <uplink.pcm> \
        --tails 0,100,200,300,400,800 --mid 0.3,0.5,0.7

要在**有模型和 onnxruntime 的机器**上跑（服务器 `~/miai-cloud/.venv/bin/python`）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "turn_judge"))
from whisper_features import compute_whisper_log_mel_features  # noqa: E402

RATE = 16_000
BYTES_PER_MS = RATE // 1000 * 2  # 32
WINDOW = RATE * 8
PRE_SPEECH_MS = 500


def load(model: str) -> "ort.InferenceSession":
    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model, sess_options=so)


def _p(session, audio: np.ndarray, norm: str = "wave") -> float:
    """norm='wave' = 现在这条链（归一化波形）；'mel' = 归一化 log-mel。"""
    if norm == "wave":
        feats = compute_whisper_log_mel_features(audio, do_normalize=True)
    else:
        feats = compute_whisper_log_mel_features(audio, do_normalize=False)
        feats = ((feats - feats.mean()) / np.sqrt(feats.var() + 1e-7)).astype(np.float32)
    out = session.run(None, {"input_features": np.expand_dims(feats, axis=0)})
    return float(np.asarray(out[0]).reshape(-1)[0])


def fit(audio: np.ndarray, pad: str) -> np.ndarray:
    if audio.size > WINDOW:
        return audio[-WINDOW:]
    if audio.size < WINDOW:
        n = WINDOW - audio.size
        return np.pad(audio, (n, 0) if pad == "front" else (0, n), mode="constant")
    return audio


def to_float(buf: bytes) -> np.ndarray:
    return np.frombuffer(buf, dtype="<i2").astype(np.float32) / 32768.0


def last_voice_byte(pcm: bytes, upto: int, threshold: int) -> int:
    audio = np.frombuffer(pcm[:upto], dtype="<i2").astype(np.int32)
    loud = np.nonzero(np.abs(audio) > threshold)[0]
    return 0 if loud.size == 0 else int(loud[-1]) * 2


def window(pcm: bytes, mode: str, lo: int, hi: int) -> np.ndarray:
    hi = min(hi, len(pcm)) & ~1
    lo = lo & ~1
    if mode == "roll":
        return fit(to_float(pcm[max(0, hi - WINDOW * 2):hi]), "back")
    return fit(to_float(pcm[lo:hi]), "front" if mode == "scoped-front" else "back")


def collect_turns(events: list[dict]):
    """每轮：{sentence, gate}。**选**用墙上时间，**切**用 at.pcm（见模块注释的坑）。"""
    sentences = [e for e in events if e["ev"] == "asr.sentence"]
    opens = [e for e in events if e["ev"] == "gate.open"]
    turns = []
    used: set[int] = set()
    for start in (e for e in events if e["ev"] == "turn.start"):
        idx = None
        for j in range(len(sentences) - 1, -1, -1):
            if sentences[j]["t"] <= start["t"] and j not in used:
                idx = j
                break
        if idx is None:
            continue
        used.add(idx)
        sent = sentences[idx]
        sent_pcm = (sent.get("at") or {}).get("pcm", 0)
        gate = next((o for o in reversed(opens)
                     if (o.get("at") or {}).get("pcm", 0) <= sent_pcm), None)
        turns.append((sent, gate))
    return turns


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("events")
    ap.add_argument("pcm")
    ap.add_argument("--dbfs", type=float, default=-60.0)
    ap.add_argument("--tails", default="0,100,200,300,400,600,800")
    ap.add_argument("--mid", default="", help="例如 0.3,0.5,0.7：句内切一刀当负样本")
    ap.add_argument("--norm", default="wave", choices=("wave", "mel"))
    ap.add_argument("--modes", default="roll,scoped-front,scoped-back")
    ap.add_argument("--model", default=os.environ.get(
        "TURN_JUDGE_MODEL",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models",
                     "smart-turn-v3.2-cpu.onnx"),
    ))
    args = ap.parse_args(argv[1:])

    session = load(args.model)
    pcm = open(args.pcm, "rb").read()
    events = [json.loads(x) for x in open(args.events, encoding="utf-8") if x.strip()]
    turns = collect_turns(events)
    threshold = int(32768 * 10 ** (args.dbfs / 20))
    mid = [float(x) for x in args.mid.split(",") if x.strip()]
    tails = [int(x) for x in args.tails.split(",")]

    for mode in args.modes.split(","):
        print(f"\n== {mode} ==")
        if mid:
            print("正/负  轮  语音ms  时长ms  " + "".join(f"{('句内%d%%' % (f * 100)):>9}" for f in mid))
            poses = []
            for i, (sent, gate) in enumerate(turns):
                sent_pcm = (sent.get("at") or {}).get("pcm", 0)
                voice = last_voice_byte(pcm, sent_pcm, threshold)
                sstart = ((gate.get("at") or {}).get("pcm", voice) - (gate or {}).get("prerollMs", 0) * BYTES_PER_MS) if gate else voice - 1000 * BYTES_PER_MS
                lo = max(0, sstart - PRE_SPEECH_MS * BYTES_PER_MS)
                cells = []
                for f in mid:
                    cut = int(sstart + (voice - sstart) * f)
                    cells.append(_p(session, window(pcm, mode, lo, cut), args.norm))
                poses.append(_p(session, window(pcm, mode, lo, voice + 200 * BYTES_PER_MS), args.norm))
                print(f"  负  {i + 1:2d}  {voice / BYTES_PER_MS:6.0f}  {(sent_pcm - voice) / BYTES_PER_MS:6.0f}  "
                      + "".join(f"{c:9.2f}" for c in cells))
            print("  正  " + "  ".join(f"{v:.2f}" for v in poses) + "   ← 语音末 +200 ms")
            continue

        print("轮  语音ms  时长ms  " + "".join(f"{('+%d' % n):>7}" for n in tails) + "   文本")
        for i, (sent, gate) in enumerate(turns):
            sent_pcm = (sent.get("at") or {}).get("pcm", 0)
            voice = last_voice_byte(pcm, sent_pcm, threshold)
            sstart = ((gate.get("at") or {}).get("pcm", voice) - (gate or {}).get("prerollMs", 0) * BYTES_PER_MS) if gate else voice - 1000 * BYTES_PER_MS
            lo = max(0, sstart - PRE_SPEECH_MS * BYTES_PER_MS)
            cells = [_p(session, window(pcm, mode, lo, voice + n * BYTES_PER_MS), args.norm) for n in tails]
            text = json.dumps((sent.get("text") or "")[:14], ensure_ascii=False)
            print(f"{i + 1:2d}  {voice / BYTES_PER_MS:6.0f}  {(sent_pcm - voice) / BYTES_PER_MS:6.0f}  "
                  + "".join(f"{c:7.2f}" for c in cells) + f"   {text}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
