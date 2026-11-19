# -*- coding: utf-8 -*-
"""从真机 `uplink.pcm` 量静音段长度分布，判断「封段门槛」定在哪划算。

<hh>为什么需要它</hh>

`VOICE_COMMIT_MS`（默认 20）现在几乎不起作用：`trackSilence` 只在 `addAudio` 时跑，
而设备是 75 ms 一包，**同一个包里尾部的静音帧不参与计时** —— 实际门槛是「一整个包」。
真机 `asr.commit.silence_ms` p50 = 88 ms，而不是 20。

想把门槛改成「按音频时间计」，先要知道两件事：

1. 句内的静音段有多长（降门槛会在词中间封段）；
2. 现在的实际门槛已经封了多少次（对照基线不是零）。

<hh>用法</hh>

```text
python scripts/silence-runs.py --pcm <会话目录>/uplink.pcm \
                              --archive <会话目录>          # 可选：读 asr.commit 做基线对照
                              --packet-ms 75                # 上行包长
                              --gain-db 12                  # 上行增益（-40 dBFS 门限是放大后算的）
```

<hh>两个口径</hh>

- **静音段**：连续帧的 dBFS 低于门限。20 ms 一帧。
- **会封段**：长度 ≥ 门槛的静音段。降门槛不是「多封了几次」，而是「在句内封了几次」——
  句间那些（≥800 ms）本来就要封。
"""
import argparse
import array
import json
import math
import os
import sys

FRAME_MS = 20
RATE = 16000
FRAME_SAMPLES = RATE * FRAME_MS // 1000

# 能量门在日志里是「按放大后算」（`增益 上行 4×（能量门 -40 dBFS，按放大后算）`），
# 而 `uplink.pcm` 是**放大前**的 —— 所以门限要减掉增益。
GATE_DBFS_AFTER_GAIN = -40.0


def read_pcm(path):
    with open(path, 'rb') as f:
        raw = f.read()
    pcm = array.array('h')
    pcm.frombytes(raw[: len(raw) // 2 * 2])
    if sys.byteorder == 'big':
        pcm.byteswap()
    return pcm


def frame_db(pcm):
    """每 20 ms 一帧的 RMS（dBFS）。"""
    out = []
    for i in range(0, len(pcm) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
        acc = 0
        base = i
        for k in range(base, base + FRAME_SAMPLES):
            v = pcm[k] / 32768.0
            acc += v * v
        rms = math.sqrt(acc / FRAME_SAMPLES)
        out.append(20.0 * math.log10(rms) if rms > 1e-9 else -180.0)
    return out


def silence_runs(voiced):
    """连续静音段，单位 ms。返回 [(起帧, 止帧, ms)]。"""
    runs = []
    i = 0
    n = len(voiced)
    while i < n:
        if voiced[i]:
            i += 1
            continue
        j = i
        while j < n and not voiced[j]:
            j += 1
        runs.append((i, j, (j - i) * FRAME_MS))
        i = j
    return runs


def hist(values, buckets, label):
    print(f"\n{label}（n={len(values)}）")
    for lo, hi in buckets:
        n = sum(1 for v in values if lo <= v < hi)
        if n:
            bar = '#' * min(56, n)
            hi_s = f'{hi}' if hi < 10 ** 9 else '∞'
            print(f"  {lo:>4}-{hi_s:>5} ms : {n:>4}  {bar}")


def pct(values, p):
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(round(p * (len(v) - 1))))]


def delay_from_last_voiced(gate_ms, packet_ms):
    """**从「最后一个有声帧被看到」到封段发出**——这就是 `asr.commit.silence_ms`。

    代码判的是 `t - lastVoicedAt >= 门槛`，而 `lastVoicedAt` 是**有声帧所在那个包**
    被处理的时刻。之后每来一个包才求值一次，所以：

        延迟 = ceil(门槛 / 包长) × 包长

    真机实测 `silence_ms` p50 = 68 ms（包长 75、门槛 20）—— 用它校准。
    """
    n = max(1, math.ceil(gate_ms / packet_ms))
    return n * packet_ms


def delay_from_stop_now(gate_ms, packet_ms):
    """**现在**的机制：包内尾部静音不参与计时，所以「等一整个包」是实际门槛。

        silence_ms = ceil(gate/packet) × packet      （gate ≤ packet 时就是 1 个包）
        停嘴→封段  = (packet − offset) + silence_ms

    真机包长 75、门槛 20：模型 75 / 115，实测 `silence_ms` p50 = 68 —— 对得上。
    """
    n = max(1, math.ceil(gate_ms / packet_ms))
    step = max(1, packet_ms // 10)
    stop = sum((packet_ms - o) + n * packet_ms for o in range(0, packet_ms, step)) / len(range(0, packet_ms, step))
    return n * packet_ms, stop


def delay_from_stop_audio_clock(gate_ms, packet_ms):
    """**改成按音频时间计**之后：包内尾部静音也算数。

        停嘴后第 n 个包到达时，累计静音 = n × packet − offset
        需要 ≥ gate  →  n = ceil((gate + offset) / packet)
        停嘴→封段 = n × packet − offset

    小包的包边界是 75 ms 包的**子集**，所以同一门槛下小包只会更早或相同，
    不可能更慢 —— 之前那张表里「25 ms 反而更慢」是公式写错了。
    """
    step = max(1, packet_ms // 10)
    vals = []
    for o in range(0, packet_ms, step):
        n = math.ceil((gate_ms + o) / packet_ms)
        vals.append(n * packet_ms - o)
    return sum(vals) / len(vals)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pcm', required=True)
    ap.add_argument('--archive', default=None, help='会话目录（含 events.jsonl），用来读 asr.commit 做基线')
    ap.add_argument('--packet-ms', type=int, default=75, help='上行包长（真机实测约 75）')
    ap.add_argument('--gain-db', type=float, default=12.0, help='上行增益（4× ≈ 12 dB）')
    ap.add_argument('--commit-ms', type=int, default=20, help='VOICE_COMMIT_MS 配置值')
    args = ap.parse_args()

    thr = GATE_DBFS_AFTER_GAIN - args.gain_db
    pcm = read_pcm(args.pcm)
    db = frame_db(pcm)
    voiced = [x > thr for x in db]
    runs = silence_runs(voiced)
    total_s = len(db) * FRAME_MS / 1000.0
    print(f"文件 {os.path.basename(args.pcm)}  {total_s:.1f}s  {len(db)} 帧")
    print(f"门限 {thr:.1f} dBFS（= {GATE_DBFS_AFTER_GAIN} dBFS 减去 {args.gain_db:.0f} dB 增益）")
    print(f"有声帧 {sum(voiced)}（{100.0*sum(voiced)/max(1,len(voiced)):.0f}%）")

    sil = [r[2] for r in runs]
    inner = [r[2] for r in runs if r[0] > 0 and r[1] < len(db)]
    buckets = ((20, 40), (40, 60), (60, 100), (100, 200), (200, 400), (400, 800), (800, 10 ** 9))
    hist(sil, buckets, '全部静音段')
    hist(inner, buckets, '夹在两段有声之间的静音段（句内候选）')

    print("\n" + "=" * 74)
    print("基线：现在的实际门槛 = 一整个包（包内尾部静音不参与计时）")
    print(f"  静音段 ≥ {args.packet_ms} ms 的：{sum(1 for v in sil if v >= args.packet_ms)} 个"
          f"  —— 这些就是「现在会被封段」的次数")
    if args.archive:
        ev = os.path.join(args.archive, 'events.jsonl')
        try:
            commits = [json.loads(l) for l in open(ev, encoding='utf-8')
                       if l.strip() and '"asr.commit"' in l]
            vals = [c['silence_ms'] for c in commits if isinstance(c.get('silence_ms'), (int, float))]
            if vals:
                print(f"  档案实测 asr.commit：n={len(vals)}  p50 {pct(vals,.5)}  p90 {pct(vals,.9)}"
                      f"  —— 比配置的 {args.commit_ms} 多 {pct(vals,.5)-args.commit_ms} ms")
            else:
                print("  档案里没有 asr.commit（可能是旧代码）")
        except FileNotFoundError:
            print(f"  找不到 {ev}")

    print("\n" + "=" * 74)
    print("模拟：改成「按音频时间计」之后，不同包长 × 门槛的封段次数与延迟")
    print("  （『句内封段』= 长度落在 [门槛, 800) 的那些 —— 800 以上是句间，本来就该封）")
    print("  （`silence_ms` 是代码能看到的；『停嘴→封段』还要加上音频在路上的那段）")
    measured = None
    if args.archive:
        try:
            commits = [json.loads(l) for l in open(os.path.join(args.archive, 'events.jsonl'), encoding='utf-8')
                       if l.strip() and '"asr.commit"' in l]
            v = [c['silence_ms'] for c in commits if isinstance(c.get('silence_ms'), (int, float))]
            measured = pct(v, .5) if v else None
        except FileNotFoundError:
            pass
    print(f"\n  {'包长':>5} {'门槛':>5} {'会封段':>7} {'其中句内':>9} {'停嘴→封段':>10}")
    for gate in (20, 40, 60, 75):
        _, stop_now = delay_from_stop_now(gate, args.packet_ms)
        fires = sum(1 for v in sil if v >= gate)
        inside = sum(1 for v in sil if gate <= v < 800)
        tag = '  ← 现在（包内静音不计）' if gate == args.commit_ms else '  ← 现在（门槛仍等于一个包）'
        print(f"  {args.packet_ms:>5} {gate:>5} {fires:>7} {inside:>9} {stop_now:>8.0f} ms{tag}")
    print()
    for packet in (args.packet_ms, 50, 25):
        for gate in (75, 60, 40):
            fires = sum(1 for v in sil if v >= gate)
            inside = sum(1 for v in sil if gate <= v < 800)
            d = delay_from_stop_audio_clock(gate, packet)
            print(f"  {packet:>5} {gate:>5} {fires:>7} {inside:>9} {d:>8.0f} ms  ← 按音频时间")
        print()
    if measured is not None:
        model, _ = delay_from_stop_now(args.commit_ms, args.packet_ms)
        print(f"  校准：包长 {args.packet_ms}、门槛 {args.commit_ms}（现在的机制）模型给 `silence_ms` "
              f"{model:.0f} ms，档案实测中位 {measured} ms（差 {abs(model-measured):.0f} ms）")


if __name__ == '__main__':
    main()
