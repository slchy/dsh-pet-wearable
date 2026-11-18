# 判停模型的中文基准（eot-bench）

> 2026-11-18 跑。上游 [livekit/eot-bench](https://github.com/livekit/eot-bench)（Apache-2.0），
> 数据集 `livekit/eot-bench-data` 的中文子集（config `zh`，`min_silence=100ms`）：
> **1099 个静音 span**（755 个句中停顿 `hold` + 344 个真实句尾 `eot`），按 100 ms 网格展开成 9441 个打分点。
> span 数取自 `span_set.parquet`；早先写的 952/608 是数错了，以这里为准。
> 适配器与跑法见 [bench/eot/README.md](../bench/eot/README.md)。

## 1. 结果（5% 误切预算，按等待时长排序）

| 模型 | AUC | AP | 5% 等待 | 10% 等待 | 超时率 | 检出率 |
|---|---:|---:|---:|---:|---:|---:|
| LiveKit Turn Detector v1.1（云 API） | 0.923 | 0.841 | **0.741 s** | 0.481 s | 15.7% | 84.3% |
| LiveKit mini（本地推理） | 0.874 | 0.775 | 0.835 s | 0.620 s | 16.9% | 83.1% |
| Soniox（流式 STT） | 0.866 | 0.765 | 0.886 s | 0.548 s | 20.6% | 79.4% |
| **★ 本项目（TurnJudge v3.2，CPU 导出）** | **0.754** | **0.588** | **0.918 s** | 0.655 s | 16.9% | 83.1% |
| ultraVAD | 0.776 | 0.591 | 0.926 s | 0.688 s | 18.0% | 82.0% |
| OpenAI gpt-realtime-2 | 0.914 | 0.800 | 0.941 s | 0.666 s | 6.1% | 93.9% |
| VAP | 0.946 | 0.911 | 0.941 s | 0.689 s | 21.5% | 78.5% |
| SmartTurn v3.2（官方 GPU 导出） | 0.745 | 0.582 | 0.959 s | 0.679 s | 22.7% | 77.3% |
| Gradium | 0.900 | 0.782 | 1.012 s | 0.748 s | 2.3% | 97.7% |

「5% 等待」= 在误切率 ≤5% 的预算下，用户说完到系统允许响应之间还要等多久。
它是**策略层指标**（基准会一起扫 `threshold` / `action_delay` / `timeout` 三个旋钮），
**不是本项目的 ①「停嘴→出句」**，两者不能混着引用。

## 2. 三条结论

1. **适配器验证通过**：我们 0.754 / 0.588，官方同模型（GPU 导出）0.745 / 0.582 ——
   同一量级，说明 numpy 特征路径与 `transformers.WhisperFeatureExtractor` 等价。
2. **我们的窗预处理只值 +0.009 AUC / −41 ms**：按句裁窗、尾部裁 20 ms、零补在前，
   这些在回放里救过 p（0.45 → 0.93），但在这个基准上只换来 41 ms。
   **窗已经调到头了**，继续抠没有意义。
3. **真正的短板是模型**：SmartTurn v3.2 在中文是倒数第二档。
   **LiveKit mini** 本地推理、AUC 0.874、5% 等待 0.835 s —— 比我们快 83 ms、
   排序能力强 0.12，看着是单点收益最大的一刀，但**许可不允许我们这样用**（见 §6）。

## 3. 顺带得到的标定数据

同一份标注能直接给 `T_open`（开轮静音门槛）定值。zh 子集里：

| `T_open` | 句中停顿会被放过 | 真实句尾被推迟 |
|---|---:|---:|
| 200 ms | 80.5% | 0.0% |
| **300 ms** | **56.8%** | **1.2%** |
| 400 ms | 41.2% | 1.7% |
| 500 ms | 28.7% | 4.7% |
| 600 ms | 18.4% | 8.1% |
| 700 ms | 13.1% | 10.8% |
| 800 ms | 9.8% | 15.1% |

「放过」= 该段静音 ≥ `T_open`（我们会在这儿开轮）；「推迟」= 该段静音 < `T_open`（要补等差额）。
复算口径：`span_set.parquet` 的 `duration`，hold 755 个 / eot 344 个。

背景分布（同源，`duration` 分位）：hold **p50 300 / p75 500 / p90 700 / p95 1000 ms**，
eot **p50 1383 / p90 2529 ms** —— 句中停顿和真实句尾在时长上**重叠得很厉害**，
所以 300 ms 才只能放过一半多一点，再往上调就开始误伤句尾。

300 ms 是甜点（= 线上默认 `VOICE_OPEN_QUIET_MS`）。这张表同时说明
**单靠静音窗永远分不开**（300 ms 时仍有 57% 的句中停顿会通过），
真正做区分的是判停的 p —— 这正是「提交/开轮分离 + p 联动」结构的依据。

## 4. 口径与未验证项

- 我们用的是 **CPU 导出**，官方是 GPU 导出：同一版 v3.2，不是同一次导出。
- 只跑了**中文**一个语言；其他 13 个语言未测。
- 基准是「人-智能体任务型对话」，和眼镜场景（短指令、近距离、噪声更强）不完全同分布。
- 本项目的预处理还包含判停侧的「尾部静音只留 20 ms」等约定，与基准的因果切片一致，
  但没有单独做消融。

## 5. 谁吃音频、谁吃文本（别把「语义侧」对错槽位）

榜单这 9 个条目按输入模态分三类。要替换我们现在的判停器，只能换**同一类**的：

| 输入 | 条目 |
|---|---|
| **纯音频** | SmartTurn v3.2（官方 GPU 导出）、**LiveKit Turn Detector v1.1-mini**、VAP、**本项目 TurnJudge**、Gradium / Soniox（厂商 STT 自带的端点判断，音频进去、什么时候判停由厂商内部决定） |
| **音频 + 上一句助手回复** | LiveKit Turn Detector v1.1（云，`turn-detector-v1.1` 网关）、ultraVAD |
| **纯文本** | **本榜没有** |

两个容易搞错的地方：

1. **mini 不在「语义侧」**：`livekit_turn_detector_mini_adapter.py` 里它的输入只有
   「最近 **2.0 s** 音频 + `turn_samples`（本轮已经说了多长）」，**没有文本通道**。
   它和我们现在的 Smart Turn v3.2 是同一个槽位（声学/韵律）。
2. **我们的「语义判停」其实是声学的**：`src/turn-judge.ts` 喂的是 Whisper log-mel，
   侧车协议只传 PCM。「语义」是历史叫法，别按字面理解 —— 真要看文本，得另接一路。

文本模型在这套基准里虽然能跑（`livekit_text_adapter.py`，`livekit/turn-detector`
的 qwen 系 ONNX），但上游已标 **deprecated**，且跑出来的数字**不能直接用**：
`io.py::build_messages` 是用数据集自带的**词级真值**按 `transcript_lag=0.5 s` 截出来的
「用户说了什么」，不是 ASR 输出。也就是说文本模型在基准里拿到的是**干净字幕**，
我们线上拿到的是带错字、无标点的流式 partial。

## 6. LiveKit mini 的形态：试过了，不能这么用

查了它的发行物（`livekit-local-inference` 0.3.2，PyPI 上的元数据 + wheel 内容），结论是
**技术上能接，许可上不行**。

**形态**（不是 ONNX，是一个编译好的原生扩展，权重烤在里面）：

| 项 | 事实 |
|---|---|
| 发行物 | `livekit-local-inference` 0.3.2，每版本 **30 个 wheel**：5 平台 × cp310–cp315，**没有 sdist** |
| 体积 | cp312 manylinux x86_64 **90.0 MB**、win_amd64 90.2 MB；wheel 里就一个 `_native.cpXXX-*.pyd`（94.6 MB 解压后） |
| 依赖 | **不声明任何依赖**：不用 torch、不用 onnxruntime，自带推理运行时 |
| 内存 | `init_eot()` 文档原话「eagerly init the EOT model singleton (**~315 MB**)」—— 我们现在的 Smart Turn ONNX 是 8.7 MB |
| API | `EOT().predict(pcm: int16 ndarray ≤ 32000, turn_samples)` → float；**< 1760 采样（0.11 s）直接返回 0.0**；`predict` 会释放 GIL |
| 顺带 | 同一个 wheel 里还有一个**流式 VAD**（`VAD()`，512 采样/32 ms 一块，每实例持有 LSTM 状态 + `reset()`） |
| 阈值 | 导出 `EOT_THRESHOLDS`：**按语言的推荐阈值**，是给这套权重标定过的（我们用不上） |

**许可**：代码 Apache-2.0，权重是 `LicenseRef-LiveKit-Model`（专有 Model License）。
第 3.b 条「Limitation on Use」写得很明确：

> (i) not to use any LiveKit Models **on a standalone basis or with any frameworks
> other than LiveKit Agents**；(ii) **not to use** any LiveKit Materials or any output
> from, or results of using, LiveKit Models **to improve or otherwise develop any other
> models** that are not LiveKit Models.

我们是自建的 Node 语音链路（`dsh-pet-wearable`），不是 LiveKit Agents，所以
**把 mini 换成我们的 TurnJudge 属于「standalone basis」**；(ii) 还意味着连「拿它的输出去调我们的
模型」也不行。榜上那些数字是基准方跑出来的公开结果，引用没问题，但模型本身我们装不得。

**所以上一轮「单点收益最大的一刀」这个结论作废。** 剩下的口子只有三个，都得花钱：

1. 向 LiveKit 要一份**允许 standalone 的商用授权**（他们 Model License 是这么设计的）。
2. **自己训**：`eot-bench-data` 本身是 Apache-2.0，许可上允许拿来训练；
   Smart Turn v3.2 权重是 BSD-2，也有公开的训练代码。这是「花时间不花钱」的那条。
3. **换框架**（把链路迁到 LiveKit Agents）—— 对我们现在是倒退，不考虑。
