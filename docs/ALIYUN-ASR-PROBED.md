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
