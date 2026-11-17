#!/usr/bin/env python3
"""判停概率 vs 尾部静音长度。

## 为什么

真机日志里，一句完整问句的判停是这样走的（`journalctl -u miai-harness`）：

    0.917 → 刚收到中间结果（3 ms 前），还有下文，再等 400 ms
    0.083 → 没说完，再等 400 ms
    0.034 → 没说完，再等 400 ms
    0.018 → 没说完，再等 400 ms
    0.008 → 没说完，再等 400 ms
    0.009 → 没说完，再等 400 ms
    0.008 → 收下这一轮          ← 能量门关了，没得等了

每重试一次 `UtteranceAssembler` 就把 `recentChunks` 整块重新喂一遍，那块音频
只会变长。要知道多出来的那段静音对 `p` 做了什么，得把「内容」固定住只改尾巴。

## 这个脚本验什么

拿档案里真实的 `uplink.pcm`：

1. 按「定稿时刻 + k×400 ms」逐拍取**真实快照**，看 `p` 怎么变（复现线上）
2. 固定住语音段，**人为补 N ms 数字静音**，看 `p` 随 N 怎么变（分离变量）

    python bench/latency/probe-smartturn-silence.py <uplink.pcm> <定稿时刻ms> [--step 400]

`定稿时刻` 用档案里那条 `asr.sentence` 的 `t`（相对会话开始的毫秒）；
PCM 与 `t` 的对应关系就是 `at.pcm`（`t=2` 时 `pcm=0`）。

要在**有模型和 onnxruntime 的机器**上跑（服务器 `~/miai-cloud/.venv/bin/python`）。
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort

# 侧车用的是自带的特征提取，直接复用，别重写
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "smart_turn"))
from whisper_features import compute_whisper_log_mel_features  # noqa: E402

RATE = 16_000
WINDOW_SAMPLES = RATE * 8  # 模型固定吃 8 秒，官方约定：前面补零、末尾对齐
SAMPLE_BYTES = 2


def load(model: str) -> "ort.InferenceSession":
    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model, sess_options=so)


def predict(session: "ort.InferenceSession", pcm: bytes) -> float:
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size > WINDOW_SAMPLES:
        audio = audio[-WINDOW_SAMPLES:]
    if audio.size < WINDOW_SAMPLES:
        audio = np.pad(audio, (0, WINDOW_SAMPLES - audio.size), mode="constant")
    feats = compute_whisper_log_mel_features(audio, do_normalize=True)
    out = session.run(None, {"input_features": np.expand_dims(feats, axis=0)})
    return float(np.asarray(out[0]).reshape(-1)[0])


def last_voice_end(pcm: bytes, threshold: int) -> int:
    """最后一个「有声」样本的下标（含）。"""
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.int32)
    loud = np.nonzero(np.abs(audio) > threshold)[0]
    return 0 if loud.size == 0 else int(loud[-1])


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcm")
    ap.add_argument("sentence_ms", type=float, nargs="?", help="档案里 asr.sentence 的 t")
    ap.add_argument("--events", help="给 events.jsonl 就逐轮跑（忽略 sentence_ms）")
    ap.add_argument("--curve", help="START:END:STEP（ms），扫 p 随快照末尾的变化")
    ap.add_argument("--step", type=int, default=400, help="每拍等多久（SMART_TURN_EXTEND_MS）")
    ap.add_argument("--taps", type=int, default=7, help="最多拍几次（SMART_TURN_MAX_EXT）")
    ap.add_argument("--dbfs", type=float, default=-60.0, help="判「有声」的门限")
    ap.add_argument("--model", default=os.environ.get(
        "SMART_TURN_MODEL",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "smart-turn-v3.2-cpu.onnx"),
    ))
    args = ap.parse_args(argv[1:])

    session = load(args.model)
    pcm = open(args.pcm, "rb").read()
    total_ms = len(pcm) / SAMPLE_BYTES / RATE * 1000
    threshold = int(32768 * 10 ** (args.dbfs / 20))

    if args.events is not None:
        return by_turn(session, pcm, args.events, threshold, args.dbfs)

    if args.curve is not None:
        start_ms, end_ms, step_ms = (float(x) for x in args.curve.split(":"))
        cut = start_ms
        print("快照末尾ms   p")
        while cut <= end_ms:
            end = int(cut * RATE / 1000) * SAMPLE_BYTES
            print(f"{cut:10.0f}  {predict(session, pcm[:end]):8.3f}")
            cut += step_ms
        return 0

    if args.sentence_ms is None:
        ap.error("要么给 sentence_ms，要么给 --events / --curve")
    voice_end = last_voice_end(pcm[: int(args.sentence_ms * RATE / 1000) * SAMPLE_BYTES], threshold)
    voice_ms = voice_end / RATE * 1000
    print(f"上行 {total_ms:.0f} ms，定稿在 {args.sentence_ms:.0f} ms；"
          f"按 {args.dbfs:.0f} dBFS 判，最后有声样本在 {voice_ms:.0f} ms"
          f"（= 句尾前静音 {args.sentence_ms - voice_ms:.0f} ms）\n")

    print("## 1. 真实快照（复现线上那条日志）")
    print("拍  快照末尾ms   p")
    for k in range(args.taps + 1):
        end_ms = args.sentence_ms + k * args.step
        end = int(end_ms * RATE / 1000) * SAMPLE_BYTES
        print(f"{k:2d}  {end_ms:10.0f}  {predict(session, pcm[:end]):8.3f}")

    print("\n## 2. 固定语音段，只改尾部补多少数字静音")
    speech = pcm[: (voice_end + 1) * SAMPLE_BYTES]
    print("补静音ms   p")
    for keep in (0, 50, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2000, 2400):
        pad = bytes(keep * RATE // 1000 * SAMPLE_BYTES)
        print(f"{keep:8d}  {predict(session, speech + pad):8.3f}")
    return 0


def by_turn(session, pcm: bytes, events_path: str, threshold: int, dbfs: float) -> int:
    """逐轮：真实停嘴时刻的 p，和「这一轮多长/多短」放一起看。"""
    import json

    events = [json.loads(x) for x in open(events_path, encoding="utf-8") if x.strip()]
    sentences = [e for e in events if e["ev"] == "asr.sentence"]
    closes = [e for e in events if e["ev"] == "gate.close"]
    starts = [e for e in events if e["ev"] == "turn.start"]

    print(f"判「有声」门限 {dbfs:.0f} dBFS\n")
    print("轮  语音起ms  真实停嘴ms  语音时长ms  停嘴处 p  +300ms p  ②观测ms  文本")
    claimed: set[int] = set()
    for i, start in enumerate(starts):
        mine = None
        for j in range(len(sentences) - 1, -1, -1):
            if sentences[j]["t"] <= start["t"] and j not in claimed:
                mine = sentences[j]
                claimed.add(j)
                break
        if mine is None:
            continue
        close = next((c for c in closes if c["t"] >= mine["t"] and c["t"] - mine["t"] < 5000), None)
        if close is None:
            print(f"{i + 1:2d}  {'—':>8}  {'—':>10}  {'—':>10}  {'—':>8}  {'—':>8}  "
                  f"{start['t'] - mine['t']:8.0f}  {json.dumps(mine.get('text', '')[:20], ensure_ascii=False)}")
            continue
        stop_ms = close["t"] - close.get("gapMs", 0)
        stop_byte = int(stop_ms * RATE / 1000) * SAMPLE_BYTES
        voice_end = last_voice_end(pcm[: int(mine["t"] * RATE / 1000) * SAMPLE_BYTES], threshold)
        voice_ms = voice_end / RATE * 1000
        p_at = predict(session, pcm[:stop_byte])
        p_300 = predict(session, pcm[: stop_byte + 300 * RATE // 1000 * SAMPLE_BYTES])
        print(f"{i + 1:2d}  {voice_ms:8.0f}  {stop_ms:10.0f}  {stop_ms - voice_ms:10.0f}  "
              f"{p_at:8.3f}  {p_300:8.3f}  {start['t'] - mine['t']:8.0f}  "
              f"{json.dumps((mine.get('text') or '')[:20], ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

