import os, sys, json
import numpy as np, onnxruntime as ort
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eot"))
from whisper_features import compute_whisper_log_mel_features as F

M = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "smart-turn-v3.2-cpu.onnx")
s = ort.InferenceSession(M, sess_options=ort.SessionOptions())
print("inputs :", [(i.name, i.shape) for i in s.get_inputs()])
print("outputs:", [(o.name, o.shape, o.type) for o in s.get_outputs()])

RATE = 16000
pcm = open(sys.argv[1], "rb").read()
def run(end_ms):
    a = np.frombuffer(pcm[: int(end_ms * RATE / 1000) * 2], dtype="<i2").astype(np.float32) / 32768.0
    a = a[-RATE * 8:]
    if a.size < RATE * 8:
        a = np.pad(a, (0, RATE * 8 - a.size))
    f = F(a, do_normalize=True)
    outs = s.run(None, {"input_features": np.expand_dims(f, axis=0)})
    return [np.asarray(o).reshape(-1).tolist() for o in outs]

for ms, label in [(28500, "说话中"), (30000, "说完+0.3s"), (30750, "说完+1.0s"), (31500, "说完+1.8s")]:
    print(f"{label:10s} end={ms}  outs={run(ms)}")

