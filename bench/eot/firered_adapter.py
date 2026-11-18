"""把 FireRedChat turn-detector 接成 eot-bench 适配器（纯文本、BERT-base int8）。

模型：https://huggingface.co/FireRedTeam/FireRedChat-turn-detector （Apache-2.0）

和 `livekit_text_adapter.py` 的区别是**输入格式**：FireRed 的官方用法是直接喂一段
纯文本（`"这是一句没有标点的文本"`），不是 Qwen 的 chat 模板；分词走 `tokenizer.json`
（`tokenizers` 库，不需要 `transformers`）。

它与本项目的关系：我们线上是**纯声学**判停器（Smart Turn v3.2），这个是**纯文本**的。
两者不是替换关系 —— 文本模型必须等 ASR 定稿，声学模型可以在定稿前就出分。
这份适配器只用来回答一个问题：**中文上文本判停到底比声学的强多少**。

用法（先按 README 下模型）：

    python -m eot_harness predict \
      --path livekit/eot-bench-data --name zh --split validation \
      --adapter eot_harness.firered_adapter:FireRedAdapter \
      --output-dir tmp/eot-out-firered
"""
from __future__ import annotations

import os
import re

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

_DIR = os.environ.get("FIRERED_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "tmp", "firered"))
_MODEL = os.environ.get("FIRERED_MODEL", os.path.join(_DIR, "chinese_q8.onnx"))
_TOKENIZER = os.environ.get("FIRERED_TOKENIZER", os.path.join(_DIR, "tokenizer.json"))
MAX_LENGTH = 128

_CJK = r"\u4e00-\u9fff"
_PUNCT = re.compile(r"[\s。.,，!！?？、~～…\-—:：;；\"'“”‘’()（）\[\]]+")


def _clean(text: str, *, strip_punct: bool) -> str:
    """把 eot-bench 的词表拼回来：中文词之间不要留空格，标点可选剥掉。

    基准的 `messages` 是「词 + 空格」拼的（`我 想 问 一 下`），直接喂给中文 BERT
    会多出一堆空格 token；FireRed 自己的例子也是无标点文本，所以默认两边都处理。
    """
    if strip_punct:
        text = _PUNCT.sub("", text)
    else:
        text = re.sub(r"\s+", " ", text).strip()
    # 中日韩字符之间的空格去掉（英文词之间的保留）
    return re.sub(rf"(?<=[{_CJK}])\s+(?=[{_CJK}])", "", text)


class FireRedAdapter:
    adapter_id = "firered/fireredchat-turn-detector-zh-int8-0.1.0"
    display_name = "FireRedChat turn-detector (zh, int8)"
    score_point = 0.2

    def __init__(self, *, model_path: str = _MODEL, strip_punct: bool = True, use_context: bool = False) -> None:
        self.model_path = model_path
        self.strip_punct = strip_punct
        self.use_context = use_context
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 2
        self.session = ort.InferenceSession(model_path, sess_options=so)
        self.tokenizer = Tokenizer.from_file(_TOKENIZER)
        self.tokenizer.enable_truncation(max_length=MAX_LENGTH, direction="left")

    def supports_language(self, lang_code: str) -> bool:
        return str(lang_code).lower() in {"zh", "en"}

    def _build_text(self, messages) -> str:
        parts = []
        for message in messages or []:
            role = str(message.get("role") or "")
            content = str(message.get("content") or "")
            if not content:
                continue
            # 默认只判最后一句用户话（FireRed 的训练形状）；use_context 时带上助手那句
            if role == "user" or (self.use_context and role == "assistant"):
                parts.append(content)
            elif not self.use_context:
                parts = [] if role == "assistant" else parts
        return _clean(" ".join(parts), strip_punct=self.strip_punct)

    def predict_batch(self, batch):
        texts = [self._build_text(item.get("messages") or []) for item in batch]
        encodings = [self.tokenizer.encode(text or " ") for text in texts]
        width = max(len(e.ids) for e in encodings)
        input_ids = np.zeros((len(encodings), width), dtype=np.int64)
        attention = np.zeros_like(input_ids)
        for i, encoding in enumerate(encodings):
            ids = encoding.ids
            input_ids[i, : len(ids)] = ids
            attention[i, : len(ids)] = 1
        logits = self.session.run(None, {"input_ids": input_ids, "attention_mask": attention})[0]
        shifted = np.exp(logits - logits.max(axis=1, keepdims=True))
        probs = shifted / shifted.sum(axis=1, keepdims=True)
        return [float(row[-1]) for row in probs]
