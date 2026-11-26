# eot-bench 适配器（用线上判停器跑公开基准）

把本项目的判停器接到 [livekit/eot-bench](https://github.com/livekit/eot-bench) 上。
结果与结论见 [docs/EOT-BENCH-RESULTS.md](../../docs/EOT-BENCH-RESULTS.md)。

## 为什么不用官方的 SmartTurn 适配器

官方那个 `eot_harness.smart_turn_adapter:SmartTurnAudioAdapter` 在加载时 `import torch`
（为了 CUDA 库加载顺序）+ `transformers` 的 `WhisperFeatureExtractor`，装起来接近 1 GB。
本仓库已经有等价的 numpy 实现（`bench/eot/whisper_features.py`，源自 pipecat vendor），
所以这里的适配器只用 **numpy + onnxruntime**。

与官方适配器的差异（引用数字时要写进去）：

| | 官方 | 本适配器 |
|---|---|---|
| 模型文件 | `pipecat-ai/smart-turn-v3` 的 **GPU** 导出 | 本仓 `models/smart-turn-v3.2-cpu.onnx`（**CPU** 导出） |
| 特征 | `transformers.WhisperFeatureExtractor(chunk_length=8)` | `bench/eot/whisper_features.py`（等价实现） |
| 窗口 | 最近 8 s、右对齐、**前面补零** | 同 |

## 跑法

> 下面是 bash 版（Linux / Git Bash）。**实测是在 Windows 上跑的**，把
> `~/eot-venv/bin/` 换成 `tmp\eotenv\Scripts\`、`cp` 换成 `copy`、环境变量用 `set`
> 即可；venv 加 `--system-site-packages` 可以直接复用系统里已有的 numpy / onnxruntime。

```bash
# 1) 上游（一次性）
git clone --depth 1 https://github.com/livekit/eot-bench ~/eot-bench

# 2) 依赖（只需要这些；不要装 torch）
python -m venv ~/eot-venv --system-site-packages
~/eot-venv/bin/pip install pyarrow soundfile datasets scikit-learn python-dotenv websockets onnxruntime

# 3) 把适配器放进去
cp bench/eot/our_judge_adapter.py ~/eot-bench/eot_harness/

# 4) 打分（--name zh 只跑中文；9441 个打分点，普通 CPU 约 13 分钟）
cd ~/eot-bench
MIAI_REPO=<本仓路径> ~/eot-venv/bin/python -m eot_harness predict \
  --path livekit/eot-bench-data --name zh --split validation \
  --adapter eot_harness.our_judge_adapter:OurJudgeAdapter \
  --output-dir ~/eot-out

# 5) 出指标
~/eot-venv/bin/python -m eot_harness compute-metrics \
  --predictions ~/eot-out/livekit__eot-bench-data__validation__min_silence_100ms/zh/our_judge_adapter__*/predictions.parquet \
  --output-dir ~/eot-metrics
```

## 两个坑

1. **生产服务器上跑不了**：那台机器到 `huggingface.co` 直接超时、到 PyPI 约 29 KB/s，
   `datasets` 装不动也下不动。本机（Windows）装完再跑才通。上游仓和 venv 都放在
   `tmp/`（已被 gitignore），跑完可以整个删掉。
2. **模型不在本仓**：`models/smart-turn-v3.2-cpu.onnx` 不进 git，从部署机 scp 回来。
   `MIAI_REPO` 指到仓根即可，适配器按 `$MIAI_REPO/models/...` 找。
