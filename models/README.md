# 模型文件（`models/`）

两个 onnx 都是**二进制**，都不进版本库（`.gitignore` 里的 `models/*.onnx`）——
用的时候自己下。

| 文件 | 干什么用 | 许可证 |
|---|---|---|
| `silero_vad.onnx` | 可选 VAD（`--stt aliyun` 这条路不用它） | MIT |
| `smart-turn-v3.2-cpu.onnx` | 判停模型，`turn_judge/` 侧车加载它 | BSD 2-Clause（Daily） |

第三方声明与许可证正文见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。

## silero-vad

`silero_vad.onnx`（2 327 524 字节）**不进版本库**——二进制文件不适合放 git。

### 获取

```bash
curl -L -o models/silero_vad.onnx \
  https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx
```

- **来源**：`snakers4/silero-vad`（MIT 许可）
- **为什么用 jsdelivr**：GitHub raw 和 raw.githubusercontent 在本机实测连不上，jsdelivr 可用
- **部署到 VPS 时**：如果 VPS 也连不上 GitHub，同样用上面的 jsdelivr 地址；或者从本机 `scp`

### 校验

    node -e "const o=require('onnxruntime-node');o.InferenceSession.create('models/silero_vad.onnx').then(s=>console.log(s.inputNames,s.outputNames))"

应输出：

    [ 'input', 'state', 'sr' ] [ 'output', 'stateN' ]

### v5 的两个接口陷阱

见 `src/vad.ts` 顶部注释。简要：

1. 输入是 `[1, 576]` 不是 `[1, 512]` —— 前面 64 个采样点是上一帧的 context
2. 值域是 `[-1, 1]`（int16 / 32768），不是 int16 原始值

喂错了**不会报错**，只会输出恒定 0.0005 左右——看起来像模型坏了。

## Smart Turn v3.2（判停）

`smart-turn-v3.2-cpu.onnx`（8 679 182 字节）—— [turn_judge/](../turn_judge/) 那个 Python
侧车加载它，回答「这一轮说完了吗」。

### 获取

```bash
curl -L -o models/smart-turn-v3.2-cpu.onnx \
  https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx
```

- **来源**：`pipecat-ai/smart-turn-v3`（模型）＋ `pipecat-ai/smart-turn`（训练与推理代码）
- **许可证**：**BSD 2-Clause**，`Copyright (c) 2024–2025, Daily`。
  细节、义务和许可证正文见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) §1 / §4.1
- **训练数据**是另一个许可证：`pipecat-ai/smart-turn-data-v3.1-train`，**CC BY 4.0**。
  我们只用权重，不下载也不分发数据集
- **文件名保留上游原名**（含 `smart-turn`）：这是模型的身份证。本项目自己那一层叫
  `TurnJudge` / `turn_judge/`，两者别混

### 校验

    sha256sum models/smart-turn-v3.2-cpu.onnx
    # 2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f

对不上就是下到了别的版本 —— p 的分布会变，判停阈值得重新标定。

### 输入形状的两个陷阱

1. 固定吃**8 秒**（80×800 的 Whisper log-mel，16 kHz 单声道 PCM16）。
   `turn_judge/server.py` 补零补在**开头**（上游 `np.pad(audio, (N, 0))`），不是末尾
2. 喂**一整句**（从开口前 800 ms 到停嘴），不是连续滚动的 8 秒窗口。
   喂错了 p 会落在 0.2–0.5 之间晃，看着像「模型不灵」，其实是窗口错了 ——
   见 [docs/TOOLS.md](../docs/TOOLS.md) §5
