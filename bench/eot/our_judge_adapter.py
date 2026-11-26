"""把本项目线上用的判停器接成 eot-bench 适配器（numpy + onnxruntime，不需要 torch）。

与 `smart_turn_adapter.py` 的差别只有两处：

1. 模型文件用本仓的 **CPU 导出**（`models/smart-turn-v3.2-cpu.onnx`），不是 HF 上的 GPU 版；
   两者是同一个 v3.2，数值应接近，但**不是同一次导出**。
2. 特征提取用 `bench/eot/whisper_features.py`（pipecat vendor 的 numpy 实现），
   等价于 `transformers.WhisperFeatureExtractor(chunk_length=8)`，跳过 torch。

窗口约定与官方一致：取**最近 8 秒**、右对齐、**前面补零**（`np.pad(audio, (pad, 0))`）。
"""
from __future__ import annotations

import os
import sys

import numpy as np

_REPO = os.environ.get("MIAI_REPO", os.path.expanduser("~/miai-cloud"))
_MODEL = os.environ.get("MIAI_TURN_JUDGE_MODEL", os.path.join(_REPO, "models", "smart-turn-v3.2-cpu.onnx"))
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from whisper_features import compute_whisper_log_mel_features  # noqa: E402

SAMPLE_RATE = 16_000
MAX_SAMPLES = SAMPLE_RATE * 8


def _resample_linear(arr: np.ndarray, orig: int, new: int) -> np.ndarray:
    if orig == new or arr.size == 0:
        return arr.astype(np.float32)
    n = int(round(arr.size * new / orig))
    x_old = np.linspace(0.0, 1.0, arr.size, endpoint=False)
    x_new = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(x_new, x_old, arr).astype(np.float32)


class OurJudgeAdapter:
    adapter_id = "miai/turn-judge-v3.2-cpu-8dbd3b7c"
    display_name = "TurnJudge v3.2 (ours, CPU)"
    score_point = 0.2

    def __init__(self) -> None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 2
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(_MODEL, sess_options=so)

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
            feats.append(compute_whisper_log_mel_features(arr, do_normalize=True))
        inputs = np.stack(feats).astype(np.float32)
        out = self.session.run(None, {"input_features": inputs})[0]
        return [float(p) for p in np.asarray(out).reshape(-1)]
