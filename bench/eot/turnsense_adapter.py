"""TurnSense 1.1（int8）的 eot-bench 适配器。

上游：<https://github.com/Bairong-Xdynamics/TurnSense>（Apache-2.0）
权重：<https://huggingface.co/brgroup/TurnSense/tree/main/TurnSense1.1>
      `model_int8.onnx` 216 MB + `am.mvn` 11 KB（1.0 那套是 49.8 MB，见 README）

## 和我们的适配器有三处不同，都不是笔误

1. **前端不是 Whisper**：Kaldi fbank（80 mel / 25 ms 窗 / 10 ms 移 / hamming）
   → LFR(7,6) 拼接 → CMVN。所以不能复用 `whisper_features.py`，特征形状是
   `[T, 560]`（80×7）而不是 `[80, 800]`。
2. **三分类**：输出 `logits [N, 3]`（complete / incomplete / invalid）。
   eot-bench 要单值，这里取 `P(complete)`。**`invalid` 那一类在这个口径里被丢掉**，
   所以「咳嗽/噪声」在本 bench 上不会被单独识别 —— 这是口径限制，不是模型缺陷。
3. **不补零**：上游 `load_audio()` 只做尾部截断（8 s），短音频保持原长，
   由 `feat_lengths` 告诉模型真实长度。这里照做，不像我们的适配器那样左补零
   —— 补零经过 CMVN 后不再是"静音"，会引入训练时没见过的帧。

实测 8 s 窗、1 inter / 2 intra 线程：**p50 342 ms**（我们现役 65 ms，5.3 倍）。
"""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.environ.get("MIAI_REPO", os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_DIR = os.environ.get("TURNSENSE_DIR", os.path.join(_REPO, "tmp", "turnsense"))
ONNX_PATH = os.environ.get("TURNSENSE_ONNX", os.path.join(_DIR, "model_int8.onnx"))
CMVN_PATH = os.environ.get("TURNSENSE_CMVN", os.path.join(_DIR, "am.mvn"))

SAMPLE_RATE = 16_000
MAX_SAMPLES = SAMPLE_RATE * 8
LABELS = ("complete", "incomplete", "invalid")


class TurnsenseFrontend:
    """Kaldi fbank + LFR + CMVN。

    逐行对应上游 `frontend/audio_frontend.py`（Apache-2.0，
    见 `THIRD-PARTY-NOTICES.md`）。vendored 进来是为了让 bench 不依赖
    一份外部检出；要改这里请先对照上游。
    """

    def __init__(self, cmvn_file: str, fs: int = SAMPLE_RATE, n_mels: int = 80,
                 frame_length: int = 25, frame_shift: int = 10, lfr_m: int = 7, lfr_n: int = 6) -> None:
        import kaldi_native_fbank as knf

        opts = knf.FbankOptions()
        opts.frame_opts.samp_freq = fs
        opts.frame_opts.dither = 0.0
        opts.frame_opts.window_type = "hamming"
        opts.frame_opts.frame_shift_ms = float(frame_shift)
        opts.frame_opts.frame_length_ms = float(frame_length)
        opts.mel_opts.num_bins = n_mels
        opts.energy_floor = 0
        opts.frame_opts.snip_edges = True
        opts.mel_opts.debug_mel = False
        self._knf = knf
        self.opts = opts
        self.n_mels = n_mels
        self.lfr_m = lfr_m
        self.lfr_n = lfr_n
        self.cmvn = self._load_cmvn(cmvn_file)

    @staticmethod
    def _load_cmvn(path: str) -> np.ndarray:
        means: list[str] = []
        vars_: list[str] = []
        lines = open(path, encoding="utf-8").read().splitlines()
        for i, line in enumerate(lines):
            item = line.split()
            if not item:
                continue
            if item[0] == "<AddShift>":
                nxt = lines[i + 1].split()
                if nxt and nxt[0] == "<LearnRateCoef>":
                    means = list(nxt[3:-1])
            elif item[0] == "<Rescale>":
                nxt = lines[i + 1].split()
                if nxt and nxt[0] == "<LearnRateCoef>":
                    vars_ = list(nxt[3:-1])
        return np.array([np.array(means).astype(np.float64), np.array(vars_).astype(np.float64)])

    def _fbank(self, waveform: np.ndarray) -> np.ndarray:
        wav = (waveform.astype(np.float32) * (1 << 15))
        fn = self._knf.OnlineFbank(self.opts)
        fn.accept_waveform(self.opts.frame_opts.samp_freq, wav.tolist())
        n = fn.num_frames_ready
        mat = np.empty([n, self.opts.mel_opts.num_bins], dtype=np.float32)
        for i in range(n):
            mat[i, :] = fn.get_frame(i)
        return mat

    def _lfr(self, inputs: np.ndarray) -> np.ndarray:
        lfr_m, lfr_n = self.lfr_m, self.lfr_n
        out = []
        t = inputs.shape[0]
        t_lfr = int(np.ceil(t / lfr_n))
        left_pad = np.tile(inputs[0], ((lfr_m - 1) // 2, 1))
        inputs = np.vstack((left_pad, inputs))
        t = t + (lfr_m - 1) // 2
        for i in range(t_lfr):
            if lfr_m <= t - i * lfr_n:
                out.append(inputs[i * lfr_n: i * lfr_n + lfr_m].reshape(1, -1))
            else:
                num_pad = lfr_m - (t - i * lfr_n)
                frame = inputs[i * lfr_n:].reshape(-1)
                for _ in range(num_pad):
                    frame = np.hstack((frame, inputs[-1]))
                out.append(frame.reshape(1, -1))
        return np.vstack(out).astype(np.float32)

    def extract(self, waveform: np.ndarray) -> tuple[np.ndarray, int]:
        feat = self._fbank(waveform)
        feat = self._lfr(feat) if (self.lfr_m != 1 or self.lfr_n != 1) else feat
        dim = feat.shape[1]
        feat = (feat + np.tile(self.cmvn[0:1, :dim], (feat.shape[0], 1))) * np.tile(
            self.cmvn[1:2, :dim], (feat.shape[0], 1)
        )
        return feat.astype(np.float32), feat.shape[0]


class TurnsenseV11Adapter:
    adapter_id = "bairong/turnsense-1.1-int8"
    display_name = "TurnSense 1.1 int8 (216 MB, kaldi fbank+LFR+CMVN)"

    def __init__(self) -> None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        # bench 是吞吐型（逐点串行），用物理核数跑；线上延迟要另按 2 线程量
        # ——1.1 在 2 线程下 352 ms、6 线程 273 ms，1.0 分别是 93 / 86 ms。
        so.intra_op_num_threads = int(os.environ.get("TURNSENSE_THREADS", "6"))
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(ONNX_PATH, sess_options=so, providers=["CPUExecutionProvider"])
        names = {i.name for i in self.session.get_inputs()}
        if not {"feats", "feat_lengths"} <= names:
            raise RuntimeError(f"ONNX 输入不匹配，实际为 {sorted(names)}")
        self.frontend = TurnsenseFrontend(CMVN_PATH)
        self.score_point = 0.2

    def supports_language(self, lang_code: str) -> bool:
        return True

    def _one(self, item: dict) -> float:
        audio = item.get("audio") or {}
        arr = np.asarray(audio["array"], dtype=np.float32)
        sr = int(audio["sampling_rate"])
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        if sr != SAMPLE_RATE:
            n = int(round(arr.size * SAMPLE_RATE / sr))
            arr = np.interp(
                np.linspace(0, 1, n, endpoint=False),
                np.linspace(0, 1, arr.size, endpoint=False),
                arr,
            ).astype(np.float32)
        # 照上游 load_audio：只尾截到 8 s，不补零
        if arr.size > MAX_SAMPLES:
            arr = arr[-MAX_SAMPLES:]
        if arr.size == 0:
            return 0.0
        feats, flen = self.frontend.extract(arr)
        logits = self.session.run(
            None,
            {
                "feats": np.ascontiguousarray(feats[None, ...], dtype=np.float32),
                "feat_lengths": np.array([flen], dtype=np.int64),
            },
        )[0][0]
        # 上游 `process_predictions` 的判据：**输出可能已经是 softmax 概率**
        # （三数和 = 1、都在 [0,1]），这时不能再 softmax 一次 —— 会把分数挤到
        # 1/3 附近，AUC 直接崩。实测两版 int8 输出都是概率（sum = 1.000000）。
        out = np.asarray(logits, dtype=np.float64).reshape(-1)
        row = out.sum()
        if np.all(out >= 0.0) and np.all(out <= 1.0) and abs(row - 1.0) <= 1e-4:
            p = out
        else:
            z = out - out.max()
            e = np.exp(z)
            p = e / e.sum()
        return float(p[LABELS.index("complete")])

    def predict_batch(self, batch: list[dict]) -> list[float]:
        return [self._one(item) for item in batch]
