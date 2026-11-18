"""消融：把 eot-bench 的音频按**真机链路**走一遍，看 AUC 掉多少。

目的：分离「为什么 bench 上 0.75/0.84，真机只有 0.50/0.53」的两个候选原因

- **A 音频链路**（本脚本测）：真机电平低 20 dB、噪声峰 −69、放大 4 倍、
  尾巴静音裁到 20 ms —— 光这一套能不能把 AUC 打下来？
- **B 内容与标签**（本脚本测不了）：真机上"用户会不会继续"本身是不是音频不可判

## 链路（照抄线上）

1. **降电平到真机量级**：`src/utterance-assembler.ts` 注释里记着
   *"这台设备的语音峰值本身就在 −32…−40"*；bench 音频是正常录音电平，
   先把它按峰值归一化到 **−35 dBFS** 再走后面的步骤。
2. **加重放噪声**：真机噪声峰实测 **−69 dBFS**（同一段注释）。
3. **放大 4 倍**：`MIAI_MIC_GAIN=4`（`pcm16Gain`，带软限幅）。
4. **裁尾巴静音**：`pcm16TrimTrailingSilence(floor = silenceDb − 20 = −60 dBFS, keepMs = 20)`
   —— 线上送进判停器的窗口末尾只剩 **20 ms** 静音，而 bench 的 score_point=0.2
   要求 200 ms。

## 判据

同样的 952 个决策点，只改音频，AUC 变化多少：

- 掉到 0.5 附近 → **音频链路就是主因**，跟模型选型无关
- 基本不变 → 音频链路无罪，问题在内容/标签（B）

用法：
    python bench/eot/degrade_probe.py --span-set <span_set.parquet> --models ours=... scicom=... \
        --out tmp/eot-out-degraded
"""
from __future__ import annotations

import argparse
import glob
import io
import os
import sys

import numpy as np
import pandas as pd

SR = 16_000
SCORE_POINT = 0.2
TARGET_PEAK_DBFS = -35.0   # 真机语音峰值（代码注释实测 −32…−40，取中）
NOISE_DBFS = -69.0         # 真机噪声峰（同一处注释）
MIC_GAIN = 4.0
TRIM_FLOOR_DBFS = -60.0    # silenceDb(-40) − silenceFloorOffsetDb(20)
TRIM_KEEP_MS = 20.0


def db_to_amp(db: float) -> float:
    return 10.0 ** (db / 20.0)


def amp_to_db(a: float) -> float:
    return 20.0 * np.log10(max(a, 1e-12))


def real_device_chain(sig: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """把一个 bench 窗口变成「像从眼镜传上来的」。"""
    peak = float(np.abs(sig).max())
    if peak <= 0:
        return sig
    # 1) 降到真机峰值
    y = sig * (db_to_amp(TARGET_PEAK_DBFS) / peak)
    # 2) 加重放噪声（白噪声，峰值按 NOISE_DBFS）
    noise = rng.standard_normal(y.size).astype(np.float32)
    noise *= db_to_amp(NOISE_DBFS) / max(float(np.abs(noise).max()), 1e-12)
    y = y + noise
    # 3) 放大 4 倍 + 软限幅（pcm16Gain 的做法）
    y = np.clip(y * MIC_GAIN, -1.0, 1.0)
    # 4) 裁尾巴静音到 20 ms：从尾部按 10 ms 帧找最后一个超过 −60 dBFS 的帧
    step = int(SR * 0.010)
    last_voiced = -1
    for end in range(y.size, 0, -step):
        start = max(0, end - step)
        if amp_to_db(float(np.abs(y[start:end]).max())) > TRIM_FLOOR_DBFS:
            last_voiced = end
            break
    if last_voiced > 0:
        cut = min(y.size, last_voiced + int(SR * TRIM_KEEP_MS / 1000.0))
        y = y[:cut]
    return y.astype(np.float32)


def load_spans(path_glob: str) -> pd.DataFrame:
    hits = glob.glob(path_glob, recursive=True)
    if not hits:
        raise SystemExit(f"找不到 span_set：{path_glob}")
    return pd.read_parquet(hits[0])


def load_audio(name: str, split: str) -> dict[str, np.ndarray]:
    import datasets
    import soundfile as sf

    ds = datasets.load_dataset("livekit/eot-bench-data", name=name, split=split)
    ds = ds.cast_column("audio", datasets.Audio(decode=False))
    out = {}
    for r in ds:
        data, sr = sf.read(io.BytesIO(r["audio"]["bytes"]))
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != SR:
            n = int(round(data.size * SR / sr))
            data = np.interp(np.linspace(0, 1, n, endpoint=False),
                             np.linspace(0, 1, data.size, endpoint=False), data)
        out[r["id"]] = data.astype(np.float32)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--span-set", required=True)
    ap.add_argument("--models", nargs="+", required=True, help="name=module:Class")
    ap.add_argument("--name", default="zh")
    ap.add_argument("--split", default="validation")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    spans = load_spans(args.span_set)
    usable = spans[spans["duration"] >= SCORE_POINT - 1e-9].reset_index(drop=True)
    audio = load_audio(args.name, args.split)
    rng = np.random.default_rng(20261118)

    adapters = {}
    for spec in args.models:
        name, _, target = spec.partition("=")
        mod, _, cls = target.partition(":")
        __import__(mod)
        adapters[name] = getattr(sys.modules[mod], cls)()

    rows = []
    for i, r in enumerate(usable.itertuples(index=False)):
        sig = audio.get(r.id)
        if sig is None:
            continue
        end = int(round((r.start + SCORE_POINT) * SR))
        if end <= 0:
            continue
        raw_win = sig[:end]
        deg = real_device_chain(raw_win, rng)
        rec = {"id": r.id, "language": r.language, "span_index": int(r.span_index),
               "label": r.label, "len_before_s": round(raw_win.size / SR, 2),
               "len_after_s": round(deg.size / SR, 2)}
        for name, ad in adapters.items():
            rec[name] = float(ad.predict_batch([{"audio": {"array": deg, "sampling_rate": SR}}])[0])
        rows.append(rec)
        if (i + 1) % 200 == 0:
            print(f"  {i+1}/{len(usable)}", flush=True)

    df = pd.DataFrame(rows)
    print(f"\n走完真机链路 {len(df)} 个窗口")
    print(f"裁尾后长度：中位 {df.len_after_s.median():.2f} s（原中位 {df.len_before_s.median():.2f} s）")
    print(f"窗尾静音：原 ~200 ms → 现在 ~{TRIM_KEEP_MS:.0f} ms")

    from sklearn.metrics import roc_auc_score, roc_curve
    y = (df["label"] == "eot").to_numpy()
    print(f"\n{'模型':<10}{'真机链路 AUC':>14}{'TPR@5%':>10}{'TPR@10%':>10}")
    for name in adapters:
        p = df[name].to_numpy()
        auc = roc_auc_score(y, p)
        fpr, tpr, _ = roc_curve(y, p)
        def tpr_at(b):
            j = np.searchsorted(fpr, b, side="right") - 1
            return tpr[max(j, 0)]
        print(f"{name:<10}{auc:>14.4f}{tpr_at(0.05)*100:>9.1f}%{tpr_at(0.10)*100:>9.1f}%")

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        df.to_parquet(os.path.join(args.out, "degraded_scores.parquet"), index=False)
        print(f"\n写入 {args.out}/degraded_scores.parquet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
