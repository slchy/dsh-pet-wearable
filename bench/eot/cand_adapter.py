"""候选判停模型的 eot-bench 适配器（两个现成的、可商用的中文/多语模型）。

- `wavekat/smart-turn-ONNX` 的 `zh/smart-turn-cpu.onnx`（BSD-2，8.4 MB）：
  和我们线上同架构同接口（`input_features` 80×800 → `logits`），只用了 2154 条中文数据微调。
- `Scicom-intl/semantic-vad-eot-whisper-tiny` 的 `onnx/model.int8.onnx`（Apache-2.0，9.6 MB）：
  Whisper-tiny + 分类头，但**不做特征归一化**（`eot_window.json` 里 `do_normalize: false`），
  输出已经是 `probability`（不用 sigmoid）。

两者都和我们的 `our_judge_adapter` 共用 `whisper_features.compute_whisper_log_mel_features`，
唯一差别是 `do_normalize` 和输出后处理 —— 这正是「同架构」这条路能零成本试的原因。
"""
from __future__ import annotations

import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from whisper_features import compute_whisper_log_mel_features  # noqa: E402

SAMPLE_RATE = 16_000
MAX_SAMPLES = SAMPLE_RATE * 8
_DIR = os.path.dirname(os.path.abspath(__file__))


def _resample_linear(arr: np.ndarray, orig: int, new: int) -> np.ndarray:
    if orig == new or arr.size == 0:
        return arr.astype(np.float32)
    n = int(round(arr.size * new / orig))
    x_old = np.linspace(0.0, 1.0, arr.size, endpoint=False)
    x_new = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(x_new, x_old, arr).astype(np.float32)


class _Base:
    score_point = 0.2
    normalize = True
    output = "logits"

    def __init__(self, model_path: str) -> None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 2
        self.session = ort.InferenceSession(model_path, sess_options=so)
        self.input_name = self.session.get_inputs()[0].name

    def supports_language(self, lang_code: str) -> bool:
        return True

    def predict_batch(self, batch):
        feats = []
        for item in batch:
            audio = item.get("audio") or {}
            arr = np.asarray(audio["array"], dtype=np.float32)
            sr = int(audio["sampling_rate"])
            if sr != SAMPLE_RATE:
                arr = _resample_linear(arr, sr, SAMPLE_RATE)
            if arr.size > MAX_SAMPLES:
                arr = arr[-MAX_SAMPLES:]
            elif arr.size < MAX_SAMPLES:
                arr = np.pad(arr, (MAX_SAMPLES - arr.size, 0), mode="constant")
            feats.append(compute_whisper_log_mel_features(arr, do_normalize=self.normalize))
        inputs = np.stack(feats).astype(np.float32)
        out = np.asarray(self.session.run(None, {self.input_name: inputs})[0]).reshape(-1)
        if self.output == "logits":
            out = 1.0 / (1.0 + np.exp(-out))
        return [float(x) for x in out]


class WavekatZhAdapter(_Base):
    adapter_id = "wavekat/smart-turn-zh-onnx-cpu"
    display_name = "WaveKat smart-turn zh (int8, 8.4 MB)"

    def __init__(self) -> None:
        super().__init__(os.environ.get("WAVEKAT_MODEL", os.path.join(_REPO, "tmp", "cand", "wavekat_zh.onnx")))


class ScicomTinyAdapter(_Base):
    adapter_id = "scicom/semantic-vad-eot-whisper-tiny-int8"
    display_name = "Scicom semantic-vad EOT whisper-tiny (int8, 9.6 MB)"
    normalize = False
    output = "probability"

    def __init__(self) -> None:
        super().__init__(os.environ.get("SCICOM_MODEL", os.path.join(_REPO, "tmp", "cand", "scicom_int8.onnx")))
