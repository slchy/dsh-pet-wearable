# 阿里云实时语音识别（NLS SpeechTranscriber）实测

> 实测时间：2026-11-05
> 网关：`wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1`
> 复现脚本：`cloud/scripts/aliyun-probe.mjs`、`cloud/scripts/nls-check.mjs`
> 客户端实现：`cloud/src/aliyun-asr.ts`
>
> **本文只记录实测到的事实。** 官方示例来源：
> `aliyun/alibabacloud-nls-nodejs-sdk/lib/st.js`（`SpeechTranscription`）。

---

## 1. 结论速览

| 项 | 结果 |
|---|---|
| 上行是否流式 | **是**（WebSocket 持续推 PCM16） |
| 是否返回中间结果 | **是**（`TranscriptionResultChanged`，边说边出字） |
| 判停 | **服务端做**，每句发 `SentenceEnd`，带 `index` 与音频 `time` |
| 采样率 / 声道 | 16000 Hz / 单声道 / PCM16 小端（与我们 mSBC 解码后一致） |
| 地域 | 华东2（上海）`cn-shanghai`；Token 与网关必须同地域 |
| 计费 | 3.5 元/小时（商用），**按音频时长，静音也算** |

**关键价值：判停不必再猜。** 本地 silero VAD + 双阈值 + 语义预判那套可以退役。

---

## 2. 连接与鉴权

```text
1. POST https://nls-meta.{region}.aliyuncs.com/   (RPC 签名，Action=CreateToken)
   → { Token: { Id, ExpireTime } }        有效期 24 h，需缓存
2. wss://nls-gateway-{region}.aliyuncs.com/ws/v1?token={Id}
3. 发 StartTranscription → 收 TranscriptionStarted
4. 持续发二进制 PCM 帧
5. 发 StopTranscription → 收 TranscriptionCompleted
```

> 官方 SDK 用 `X-NLS-Token` header 传 token；Node 内置 `WebSocket`
> 不支持自定义 header，实测 **URL query 同样可用**。

---

## 3. 五个协议坑（全部实测撞出来的）

按踩坑顺序排列，每个都真实发生过：

| # | 症状 | 真因 |
|---|---|---|
| 1 | `Gateway:MESSAGE_INVALID:Invalid message id 'afd1a494-...'` | `message_id` **不能带连字符**，必须是 32 位纯十六进制（`uuidv4().split("-").join("")`） |
| 2 | `Gateway:MESSAGE_INVALID:Invalid task id 'null'` | header 缺 **`task_id`**，它由**客户端生成**（也是 32 位 hex），StopTranscription 要复用同一个 |
| 3 | `Gateway:MESSAGE_INVALID:Missing message name!` | header 缺 **`name`**（`StartTranscription` / `StopTranscription`） |
| 4 | 补了 `name` 仍报同一条错 | **缺顶层 `context` 字段**。服务端解析不下去时回的是误导性错误，不指向 context |
| 5 | Stop 时 `Missing message namespace!` | `namespace` 每个请求都要带（`SpeechTranscriber`） |

**正确形状**（StartTranscription）：

```json
{
  "header": {
    "appkey": "...",
    "message_id": "<32位hex>",
    "task_id": "<32位hex，客户端生成>",
    "namespace": "SpeechTranscriber",
    "name": "StartTranscription"
  },
  "payload": {
    "format": "pcm",
    "sample_rate": 16000,
    "enable_intermediate_result": true,
    "enable_punctuation_prediction": true,
    "enable_inverse_text_normalization": true,
    "max_sentence_silence": 500
  },
  "context": { "sdk": { "name": "nls-nodejs-sdk", "version": "0.0.1", "language": "nodejs" } }
}
```

> 第 4 条最坑：`context` 缺失导致的报错完全指错方向，曾为此多排查四轮。

---

## 4. 连接生命周期：IDLE_TIMEOUT

```
Gateway:IDLE_TIMEOUT:Websocket session is idle for too long time,
                     the last directive is 'StartTranscription'!
close code = 4404 (40000004)
```

**触发条件**：连接上没有「有效活动」。实测结论：

- 停止推音频 → 超时
- **推纯静音 → 依然超时**（静音不算活动）

**因此不能用「推静音保活」**。TTS 播放期间的正确做法是：

```text
本轮收到 SentenceEnd
  → asrClient.close()        立即挂断（这段本来就不该识别）
  → agent + TTS
  → asrClient.resume()       只解 dropping 标志，不主动建连
  → 下一次 feed() 懒连接      有音频才连，避免空连接又超时
```

**懒连接必须防并发**：`connect()` 首次要 `await CreateToken`（约 1 s），
这段时间 `ws` 仍是 null。只判 `!ws` 会让每个音频 chunk 都发起一次连接，
实测瞬间刷出十几个并发连接互相打架。必须用独立的 `connecting` 标志，
且在 `await` **之前**同步置位。

---

## 5. 判停与半双工

服务端把连续语音切句，每句一个 `SentenceEnd`：

```
… 你觉得deep sk怎么样？      ← index=1
… 嗯。                        ← index=2
… 你觉得呢？                  ← index=3
… 闭嘴。                      ← index=4
```

对比本地 VAD（同一段音频切成一块 14.14 s）：服务端切分粒度细得多。

**副作用**：填充词也会独立成句（「嗯。」「嗯，那么。」），会触发一整轮问答。
如需过滤，应在 `onSentence` 里去掉语气词后判断剩余长度。

**半双工**：没有 AEC，TTS 播放时眼镜扬声器会被自己的麦克风收进去。
当前实现是播放期间挂断识别连接，代价是播放期间用户说话会被丢弃。

---

## 6. 成本换算

```
3.5 元/小时 ≈ 0.058 元/分钟
```

| 用量 | 月成本 |
|---|---|
| 每天 10 分钟 | ≈ 17.5 元 |
| 每天 1 小时 | ≈ 105 元 |

**按音频时长计费，静音也算** —— 这也是「播放期间挂断」的一个附带收益：
不为无人说话的时间付费。

---

## 7. 与 MiMo ASR 的对比

| | MiMo `mimo-v2.5-asr` | 阿里云 SpeechTranscriber |
|---|---|---|
| 输入 | 整段 base64 文件（wav/mp3） | **持续推 PCM 帧** |
| 输出 | SSE 文本 delta（整段传完后才出字） | **中间结果实时出字** |
| 判停 | 客户端自己猜 | **服务端 `SentenceEnd`** |
| 首字延迟 | ≈ 说话时长 + 上传 + 0.72 s | 与说话时长无关（边说边出） |
| 结算 | 见 `MIMO-API-PROBED.md` | 3.5 元/小时 |

**结论**：MiMo 适合「一段录好音频批量转写」，不适合实时对话；
实时对话必须用流式接口。

---

## 8. 未验证项

| 项 | 状态 |
|---|---|
| `max_sentence_silence` 的实际取值区间与效果 | 已传 500 ms，**效果未定量对比** |
| 单连接最长存活时长 | 未测（当前靠挂断/重连规避） |
| 并发上限（试用期 2 路） | 单设备场景够用，未压测 |
| `ControlTranscription` 能否用于保活 | 未验证 |
| 断线重连后的上下文是否延续 | 未验证 |

---

## 9. 识别准确率归因（2026-11-16 真机实测）

> 样本：一轮连续对话，上行 248.3 s / 下行 102.1 s，16 句 `SentenceEnd`。
> 复现脚本：`scripts/speed-check.py`（语音充足度）、`scripts/env-dump.py`（能量包络）、
> `scripts/hf-compare.py`（上下行频谱）、`scripts/asr-ab.mjs`（采样率对照）。

### 9.1 三句话结论

1. **不是音频质量的问题。** 链路干净：无削波、无异常噪声、频响到 7.8 kHz 仍在 −40 dB 以上，
   双讲期间近端语音也没有被吃掉（每句语速全部落在 3.65–6.67 字/秒的正常区间）。
2. **不是解码问题。** mSBC 帧首字节恒为 `0xAD`（即 ffmpeg 的 `MSBC_SYNC_WORD`），
   57 字节/帧正好对应 16 kHz / 15 blocks / 8 subbands / bitpool 26 / MONO 的标准 mSBC 参数
   （`4 + 4 + ceil(15×26/8) = 57`）。把首字节改写成 `0x9C` 后 ffmpeg 当场解码失败，
   反证现有解码路径是对的。
3. **错在同音替换与领域词，属于「声学置信度低 + 语言模型先验接管」。** 关键反例：
   同一轮里最长的 31 字句子「你打印一下文件目录，并且告诉我这台机器上面有没有什么
   比较值得注意的文件。」**零错误**——音频若真有缺陷，不可能只错短词而放过长句。
   机制见 §9.5：同一段音频换个连接状态就会给出**不同但都错**的答案。

### 9.2 错误清单与归类

| 识别结果 | 实际说的 | 错误类型 |
|---|---|---|
| 你把对话**卦的断**一会儿子**弹你跑完了** | 你把对话**挂断**一会**儿，等你跑完了** | 连读吞音 + 插入幻词 |
| 我说你去**省级**代码 | 我说你去**审计**代码 | 同音词（shěnjì → shěngjí） |
| 你是**生气带**吗 | 你是**审计了**吗 | 同音词（shěnjì le → shēngqì dài） |
| 小米公司的**数值** | 小米公司的**市值** | 近音词（shìzhí → shùzhí） |
| 我让你去看**大一码**写的怎么样 | 我让你去看**代码**写的怎么样 | 近音词（dàimǎ → dàyīmǎ） |
| **6399CF** | 63993 | 字母数字混淆 |

失败模式高度一致：**声母或韵母相近处被语言模型先验改写**，而非信号丢失。

**最值得注意的是「审计」**：它在同一轮里出现两次，两次都错，而且错法不同
（→「省级」、→「生气带」）。同一个词反复错、错得不重样，说明这不是偶发的信号
损伤，而是声学模型在这个词的发音上本身就站不稳——正是热词表要对症的地方。

### 9.3 决定性对照：拿 TTS 的完美音频喂同一个 ASR

下行是 MiMo 合成的 24 kHz 语音——无麦克风、无 mSBC、无网络损伤，是这条链路的音质上界。
把它降到 16 kHz 后送进同一个 NLS 连接：

```text
16 kHz：跑的就是我mi cloud语音服务识别…哥说的应该是市值吧      ← "市值" 正确
        当前工作目录是空的，加目录里东西不少                    ← "家目录" 错
        有 mi cloud、mi AR cafe、mii on photos                  ← 英文/路径名全崩
 8 kHz：米IA cloud、米IAR cafe、米IO po s、wife agent、harf      ← 明显更差
```

两个结论：

- **连完美音频都在专有名词上出错**，所以这些错误与上行音频无关。
  真人说的「市值」错、TTS 说的「市值」对，只是口音与频谱细节的边际影响，不是主因。
- **16 kHz 显著优于 8 kHz**（8 kHz 把一句切成两倍多的碎片）。当前 `sample_rate: 16000`
  的配置是对的，不要再往下降。

### 9.4 别指望热词表：实测阿里云实时识别不吃任何词表

原计划是把「审计」「市值」「代码」这类高频错词塞进热词表。**实测这条路走不通**：

| 探测 | 结果 |
|---|---|
| `nls-meta` 上调 `CreateAsrCustomization` / `ListAsrCustomizations` | `404 InvalidAction`，该域名只提供 `CreateToken`（错误里的 `product=nls-cloud-meta` 印证） |
| `nls-slp` 上调同名接口 | 端点**存在**（`product=nls-slp`），但试了 5 个 `Version` 全是 `InvalidVersion`，拿不到可用签名 |
| `StartTranscription` 的 `payload` 加 `customization_id` = 假值 | 照样 `TranscriptionStarted` |
| 加 `vocabulary_id` = 假值，**并真的推音频** | 三组转录结果**逐字相同** |

最后一条是关键：词表通常到解码时才查，只看 `TranscriptionStarted` 不算数。
真推了 8 秒含「审计」的音频后，`baseline` / 带 `customization_id` / 带 `vocabulary_id`
三组输出**完全一致**，服务端对这两个字段都是静默忽略。

官方 SDK（`aliyun/alibabacloud-nls-nodejs-sdk` 的 `lib/st.js`）也印证这点：
`defaultStartParams()` 只有 format / sample_rate / 三个 enable 开关，`payload` 原样透传，
根本没有热词相关字段。热词能力在**一句话识别**和**录音文件识别**里，实时识别这条产品线没有。

### 9.5 真正的机制：声学置信度低，最后由语言模型拍板

把同一段音频换不同方式重放，得到**不同但都错**的结果：

```text
在线（真实长连接）：  你去调研一下小米公司的数值怎么样？
离线重放同一段：      你去调研一下小米公司的数据怎么样？
正确答案：            …的市值…
```

两次都没出现「市值」。更直接的对照是「审计」那一句：

```text
在线（连接已跑了 190 秒）：我说你去省级代码。     ← 错
离线（干净新连接）：        我说你去审计代码。     ← 对
```

而 1x 实时推送与 4x 快推的重放结果**完全相同**，所以差异不来自推送速度，
而是来自连接上累积的上下文——**当声学证据本身模棱两可时，语言模型的先验会接管，
并在不同上下文下给出不同答案。**

这也解释了为什么 31 字的长句反而全对：长句里每个词的声学冗余多；
而「市值」「审计」这种 2 字词一旦声母韵母接近，就只能靠 LM 猜。

### 9.6 还能做什么

| 方向 | 评价 |
|---|---|
| 热词表 | **已证伪**，实时识别不支持 |
| 保持 16 kHz | 已验证优于 8 kHz，务必别降 |
| 换 ASR 供应商 | 唯一能实质提升的路，前提是对方实时接口支持热词 |
| agent 侧上下文纠错 | 不依赖供应商：用上一轮对话把「数值/数据」改回「市值」。代价是多一次模型调用，或写进提示词 |
| 说话侧习惯 | 2 字专有名词（市值、审计）建议放慢或补全成「那个市值」「审计代码」；这类词对任何声学模型都难 |

### 9.7 顺带修正：全双工确实成立

旧版本（§5）写的是「没有 AEC，播放期间挂断识别连接」。本轮实测推翻了这个前提：
TTS 仍在播放的 193.5–194.3 s 期间，上行电平一路掉到 −80 dBFS，说明扬声器声音没有
回灌进麦克风；而同一时段内用户说话处（192.76–193.34 s）稳定在 −12 dBFS。
**双讲期间近端语音既没被回声盖住，也没被回声消除误伤。**
