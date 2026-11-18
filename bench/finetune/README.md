# 微调 Smart Turn v3（中文为主）

目标：把中文在训练集里的占比从 ~2.7% 拉上来（中文真样本只有 ~7k 条），看
eot-bench 中文子集上的 AUC 是否从 **0.754** 往上走。

- 代码：[pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)（BSD-2）
- 数据：[`smart-turn-data-v3.2-train`](https://huggingface.co/datasets/pipecat-ai/smart-turn-data-v3.2-train)
  270,946 条 / 41.4 GB，**CC-BY-4.0**；测试集 `-v3.2-test` 31,527 条 / 4.84 GB
- 模型：8M 参数 = Whisper-tiny encoder（`openai/whisper-tiny` 起跑）+ attention pooling + 3 层 MLP
- 上游超参（`train.py::CONFIG`）：LR 5e-5、**4 epoch**、batch 384、warmup 0.2、ONNX opset 18 + int8 静态量化

## 机器怎么租

| 项 | 要求 | 说明 |
|---|---|---|
| GPU | ≥ 16 GB 显存（A10 / 3090 / 4090 / A100 都行） | 8M 模型 + 8 s 音频，batch 384 完全放得下；没有多卡需求 |
| 磁盘 | **≥ 120 GB** | 原始数据 41.4 GB + HF 缓存 + 重采样副本（`save_to_disk` 会复制音频字节） |
| 网络 | **能直连 huggingface.co** | 这条最容易被漏掉。国内机器经常连不上，开租前先 `curl -sI https://huggingface.co`；连不上就先在本机下好再传 |
| 系统 | Linux + NVIDIA 驱动（`nvidia-smi` 正常） | `requirements.txt` 里的 `torch==2.9.0` 从 PyPI 装就是 CUDA 版 |

## 装环境

```bash
git clone --depth 1 https://github.com/pipecat-ai/smart-turn && cd smart-turn
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
apt-get update && apt-get install -y ffmpeg     # torchcodec 需要 ffmpeg 的共享库
# 不要装 modal：modal_metrics 检测到 import 失败会自动降级成 no-op
```

## 三个必改点（不改就跑不起来）

1. **`CONFIG` 里的数据集路径是上游内部的**，公开仓里那两行指向
   `/data/datasets/smart-turn-v3.3-alpha1-*`，直接跑会在 `load_from_disk` 上崩：

   ```bash
   sed -i 's|"datasets_training": \[.*\]|"datasets_training": ["pipecat-ai/smart-turn-data-v3.2-train"]|' train.py
   sed -i 's|"datasets_test": \[.*\]|"datasets_test": ["pipecat-ai/smart-turn-data-v3.2-test"]|' train.py
   ```

   （`load_dataset_at()` 里以 `/` 开头走 `load_from_disk`，否则走 `load_dataset`。）

2. **`do_training_run()` 硬要求 `WANDB_API_KEY`**，没有就 `raise`。不联网跑：

   ```bash
   export WANDB_API_KEY=dummy WANDB_MODE=offline
   ```

3. **小数据集要调 `eval_steps`**：默认 500。中文混合集只有几万条时一整个 epoch 才
   ~150 步，等于全程不 eval。跑混合集时把 `CONFIG["eval_steps"]`（和 `save_steps`）
   改成 100。

## 跑法

```bash
# ① 基线复现：先确认「同一份数据 + 同一份代码」能跑通并拿到自己的权重
export WANDB_API_KEY=dummy WANDB_MODE=offline
python train_local.py --training-run-name base-v32 --output-dir ./out

# ② 中文加权：先重采样，再把 CONFIG 指到本地目录（以 / 开头）
python <本仓路径>/bench/finetune/prep_zh_mix.py --zh-repeat 3 --other-per-lang 1500 --out /data/zh-mix
sed -i 's|"datasets_training": \[.*\]|"datasets_training": ["/data/zh-mix"]|' train.py
python train_local.py --training-run-name zh-mix-v1 --output-dir ./out

# ③ 量化（int8 静态，标定集 1024 条，从训练集里分层抽）+ 用上游自己的 bench 出个表
python train_local.py --quantize out/zh-mix-v1/final_model/exports/model_fp32.onnx
python train_local.py --benchmark out/zh-mix-v1/final_model/exports
```

耗时量级（含 41.4 GB 下载）：基线 **1.5–3 h**，中文混合集（~5 万条）**20–40 min**。
下载本身 100 MB/s 下约 7 min，20 MB/s 下约 35 min。

## 要带回来的东西

```
out/<run>/final_model/                     # PyTorch 权重（下次热启动用，~35 MB）
out/<run>/final_model/exports/model_fp32.onnx
out/<run>/final_model/exports/*.onnx       # int8 量化后的那个才是线上格式
out/<run>/final_model/exports/benchmarks/  # 上游自己的评测表
```

## 回来之后在这边验

```bash
# 形状对不对：输入名必须是 input_features，输出是单值 logits
python -c "import onnxruntime as ort; s=ort.InferenceSession('模型.onnx'); print([i.name for i in s.get_inputs()])"

# 替掉 models/smart-turn-v3.2-cpu.onnx（留一份旧的，出问题能一键回退），然后跑基准
# 复现步骤见 bench/eot/README.md；对账基线：AUC 0.754 / 5% 等待 0.918 s
```

**上线判据不是 AUC**，是「有声拆句率不升」——见
[docs/EOT-BENCH-RESULTS.md](../../docs/EOT-BENCH-RESULTS.md) 与真机回放回归。

## 别做的事

- **别把 eot-bench 中文子集（344 轮）或真机档案喂进训练**。它们是唯一的对外验证集，
  污染了以后所有数字都不能再引用。
- 别拿 `smart-turn-data-v3.2-test` 调参再报它的分数。
