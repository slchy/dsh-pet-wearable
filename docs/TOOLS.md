# 项目脚本标定

仓库里 `scripts/` `bench/` `tools/` 加起来几十个脚本，每个都只回答一个问题。
这份文件干三件事：

1. **路由**：手上有个问题，该跑哪一个（§1）
2. **口径归属**：一个数字只允许有一个实现，别处必须复用它（§2）
3. **标定值**：跑对了应该看到什么数量级（§12）

## 0. 四条硬规矩

**① `p50` / `p90` 不加限定 = 「闭嘴 → 出声」。** 这是项目级约定，唯一实现是
`src/latency-report.ts` 的 `firstWordMs`（① + ② + ③）。其余一律不许裸叫 p50：

- 单段说全名：「③ p50」「① p90」；或者干脆说「③ 该段中位」
- 模型层（`bench/fast_lane`）只能说「**模型首字** p50」—— 它少了 ASR、判停、TTS 三段
- 真机 mSBC 与 bench PCM16 不可比；只有同一条路径的改前/改后才可比

**② 先查 §1，再动手。** 手搓一个新脚本去算已有的口径，是本仓最常见的自伤 ——
算出来的数字通常还错（§13 第 1 条就是活例）。

**③ 新探针一律放 `bench/`。** `scripts/deploy_cloud.py` 的 `ITEMS` 只同步
`src mcp tools tests turn_judge scripts package.json tsconfig.json README.md`
九项，`bench/` 不在里面。往 `scripts/` 里塞一次性探针，等于把它推上生产服务器。

**④ 每个事实只有一个源，观测工具自动去那儿取，绝不复制。** 复制一份 = 多一份要维护，
而且两份的时钟对不上（dsh 的日志是 epoch ms，我们的档案是相对会话开始的毫秒）。

| 事实 | 唯一源 | 谁去取 |
|---|---|---|
| ①②③④ 分段、停嘴时刻、缺仪表 | 本仓会话档案 `events.jsonl` | `latency-report.ts` |
| 状态轮转、插话有没有停音频 | 同上 | `fsm-trace-check.ts` |
| 一轮内部（step / 工具调用 / reasoning） | **dsh 自己的 session log** | `dsh-timeline.ts` |
| 后台作业 / 子代理的状态转移 | **同上**（`job/registered`、`job/settled`、`subagent/catalog`） | 同上 |

最后一行是重点：**dsh 的日志已经够全了，不要往档案里再抄一遍 `job.*`**。
`dsh-timeline.ts` 靠 `turn.end.dsh_session` 自动定位那份日志，并把两份按同一时间轴摆好
（找不到 id 时退回「时间重叠最多 + 轮次数对得上」的那个）。

一把梭：`node scripts/observe.ts <会话目录>` —— 依次跑分段、审计、dsh 对齐，
头部先列这场会话有哪些源可用。缺源就说缺源、跳过那一段，**不拿别的源里的数顶上**。

---

## 1. 路由表：我要回答什么 → 跑哪个

| 我想知道 | 跑这个 | 读什么 |
|---|---|---|
| **一场会话的全部事实**（分段 + 审计 + dsh 内部） | `scripts/observe.ts <档案目录>` | 三节输出；头部先列有哪些源可用 |
| 一轮卡在哪、用户等了几秒 | `scripts/latency-report.ts <档案目录>` | ①②③ 分段 + 首字 p50/p90 vs 预算 |
| **该治哪一段**（谁占大头、p90 是谁顶上去的） | `scripts/latency-attribution.ts <档案目录>` | 各段份额、③ 内部拆分、超预算轮次逐条 |
| 这条链有没有一处不符合设计 | `scripts/fsm-trace-check.ts <档案>` | 违规列表（退出码 0/1） |
| `dsh` 内部那几秒花在哪 | `scripts/dsh-timeline.ts <会话目录>` | Miai 档案与 dsh session log 同轴 |
| 「开跑→首块」是模型的锅还是 TTS 的锅 | `bench/tau2/reply_breakdown.py` | `dsh_ms` vs `tts_first_ms` |
| 改了一行代码，端到端快了没有 | `bench/replay/run.py`（同一份真机音频） | 同口径前后对比 |
| 不接眼镜、全自动跑几条话术 | `bench/e2e/run.py`（手机当喇叭+话筒） | 说完→首音 / 通过与否 |
| 判停侧车为什么不敢收 | **档案里的 `judge.decide`**（线上就有，最省事）；要离线复算才用 `bench/latency/probe-turnjudge-silence.py` | 每次决定的 `p` + 等待；② 的成因 |
| 换个判停阈值/延长次数会怎样 | `bench/latency/probe-turnjudge-silence.py --curve START:END:STEP` | p 随尾部静音怎么变 |
| CosyVoice 首包多少 / 要几个字才开跑 | `bench/latency/probe-cosyvoice-firstbatch.mts` | 首批字数 × 首块时间 |
| 快车道会不会答错本该交给 `dsh` 的 | `bench/fast_lane/run.ts` | 误拦截率（>0 退出码 1） |
| 换哪家快模型首字更短 | `bench/fast_lane/probe_models.mjs` | 逐模型首 token |
| ASR 握手 40000002 / 权限到底缺哪个 | `scripts/nls-check.mjs` | 各接口交叉验证 |
| 上行音频被切碎了没有 | `scripts/env-dump.py <uplink.pcm>` | 逐窗能量包络 |
| 识别出字速度合理吗（幻觉判据） | `scripts/speed-check.py` | 字/秒（中文 3–5，>8 可疑） |
| 上行 mSBC 损失了多少高频 | `scripts/hf-compare.py` | 对下行 24 kHz 比频谱斜率 |
| 云端链路通不通（不碰真机） | `tools/fake-phone.ts`（v1）/ `tools/fake-v2-device.ts`（v2） | 退出码 0 = 收到下行 Audio |
| τ² 任务跑得好不好 | `bench/tau2/run_voice.py` | reward + 时序审计 |

---

## 2. 口径归属：一个数字只有一个实现

**档案分段（① ② ③ ④）**

| | |
|---|---|
| 唯一实现 | [`src/latency-report.ts`](../src/latency-report.ts) 的 `computeTurns()` |
| CLI | `node --experimental-strip-types scripts/latency-report.ts <档案目录> [--all]` |
| 测试 | [`tests/latency-report.test.ts`](../tests/latency-report.test.ts) |

```text
gate.close ──①──▶ asr.sentence ──②──▶ turn.start ──③──▶ tts.first ──④──▶ turn.end
```

- ① `silenceToAsr` = `asr.sentence.t − (gate.close.t − gapMs)`
  **别直接减 `gate.close.t`。** 能量门要等 `gapMs`（真机 2.0–2.1 s）走满才记，
  而 `asr.sentence` 常常记在它**之前** 300–400 ms。
- ② `asrToTurn` 定稿 → 开跑（同进程排队 / 等判停收口）
- ③ `turnToAudio` 开跑 → 首块音频。**含 `dsh` 模型首字**，不是纯 TTS
- ④ `playbackMs` 播放，不算延迟
- `firstWordMs = ①+②+③` = **闭嘴→出声** = 项目 p50/p90 指的那个数，预算 `FIRST_WORD_BUDGET_MS = 1200`

P90 用**线性插值**（`percentile()`），不是最近秩 —— 两者在 6 个样本上能差 40 ms。
所以别在别处重写一遍统计（`summarize()` 是唯一实现）。

**状态轮转与时序审计**

| | |
|---|---|
| 唯一实现 | [`src/fsm-trace.ts`](../src/fsm-trace.ts) 的 `checkTrace()` |
| CLI | `node --experimental-strip-types scripts/fsm-trace-check.ts <events.jsonl｜档案目录> [...]`（`--json` 给脚本吃） |
| 测试 | [`tests/fsm-trace.test.ts`](../tests/fsm-trace.test.ts) |
| 预算 | 单轮 `45 s`、停嘴→首块 `15 s`、插话后 `audio.stop` 必须落在 `±500 ms` |

状态白名单直接照抄 `DialogFsm` 的调用点。加一条转移必须同时改
`ALLOWED` 和它的测试 —— 目前 `speaking → thinking` 只有 `receiptEnded()`
一个来源（委派轮回执出声，见 `DialogFsm` 顶部约束 1）。

**`dsh` 内部耗时**

| | |
|---|---|
| 唯一实现 | [`scripts/dsh-timeline.ts`](../scripts/dsh-timeline.ts) |
| CLI | `node --experimental-strip-types scripts/dsh-timeline.ts <会话目录> [--dsh-root ~/.dsh/sessions] [--verbose]` |

**τ² 侧的分段**（`bench/tau2/segment_split.py`）是**另一套实现**，因为它多一段
客户端首帧、锚点是客户端打点而不是 `gate.close`。两套不能混着比。

---

## 3. 延迟与分段

| 脚本 | 作用 |
|---|---|
| `scripts/observe.ts` | **单入口**：分段 + 审计 + dsh 对齐，头部列出这场会话有哪些事实源可用 |
| `scripts/latency-report.ts` | 档案 → 逐轮 ①②③④（**分段口径的唯一实现**） |
| `scripts/fsm-trace-check.ts` | 档案 → 状态轮转违规 |
| `scripts/dsh-timeline.ts` | Miai 档案 × dsh session log 同轴对齐（**一轮内部/工具/作业的唯一源**） |
| `bench/tau2/segment_split.py` | 客户端打点 + 档案，五段（含 ⑤TTS首块→客户端首帧） |
| `bench/tau2/lat_summary.py` | 合并 `/tmp/tau2-lat-*.json` 出 p50/p90/p95，折真机体感 |
| `bench/tau2/reply_breakdown.py` | ③ 拆成模型侧 `dsh_ms` 与 TTS 握手 `tts_first_ms` |
| `bench/tau2/open_latency.py` | 按答复长度分桶看「τ² 任务是不是让模型开口更晚」 |
| `bench/latency/probe-single-turn.mjs` | 起生产形态服务端跑一整轮，读档案 —— 本地没有判停侧车，②只作参考 |
| `bench/latency/analyze-real-archive.mjs` | 真机档案速览（含「等关门」列）。**只用于看 ②，段口径以 `latency-report.ts` 为准** |

`bench/latency/` 下其余四个是 TTS 专项探针（见 §6），两个 `probe-turnjudge-*` 见 §5。

## 4. 真机回放与端到端

| 脚本 | 作用 |
|---|---|
| `bench/replay/run.py` | 把某场真机会话的上行音频原速重放，逐轮对比。`--list` 列可回放的场次，`--archive <名字>` 指定 |
| `bench/replay/client.mjs` | 线协议客户端，自报 `pcm16` 直接送解码后 PCM（回放没有 mSBC 可编） |
| `bench/e2e/run.py` | 真机全自动：**不接眼镜**，手机当喇叭和话筒 |
| `bench/e2e/synth.mjs` | 在服务器上用线上同一条 TTS 合成「用户会说的话」 |
| `bench/e2e/mictap/build.py` | 打 MicTap APK（手机录 PCM 用；`app_process` 那条路会被 audioserver 静音） |

**为什么优先 `replay` 而不是 `e2e`**：`replay` 输入是同一份音频，跨次可比；
`e2e` 每轮内容不同，只能看"通不通"。

**回放的配置是显式的，唯一真相源是向量 `meta.json`**（录那段音频时真生效的 ASR/TTS）。
起 harness 时会先 `. .env`，再用显式 export 盖掉 `MIAI_STT`/`MIAI_TTS` ——
`.env` 里那个 `MIAI_STT=aliyun` 是陈旧值，回放不再依赖它。`MIAI_BENCH_ENV` 只用于
叠加实验自变量，会逐条打进配置表并写进 `out/last.json` 的 `config`；
**跨 ASR 默认拒跑**，必须显式 `--allow-cross-asr`（跨 ASR 时 ① 与逐轮对比都无效）。
详见 `bench/replay/README.md`。

## 5. 判停（TurnJudge 侧车）

| 脚本 | 作用 |
|---|---|
| `bench/latency/probe-turnjudge-padding.py` | **窗口怎么裁才是对的**：正样本（真停嘴）与负样本（句内切一刀）× 三种窗口（连续 8 s 滚动 / 按句裁+前补零 / 按句裁+后补零），逐格给 p。**这是查清「p 为什么是噪声」的那一个** |
| `bench/latency/probe-turnjudge-silence.py` | **p 随尾部静音怎么变**：`--curve START:END:STEP` 扫一条话音，`--events events.jsonl` 逐轮看真实停嘴处的 p。要在有 onnxruntime 的机器上跑（服务器 `~/miai-cloud/.venv/bin/python`） |
| `bench/latency/probe-turnjudge-output.py` | 模型输出到底是什么：形状 `[s6, 1]`、要不要 sigmoid、变长维 `s6` 怎么喂 |
| `bench/latency/probe-realtime-asr-silence.mjs` | DashScope realtime 的 `silence_duration_ms` 收不收各种值（**回执会骗人**，见 `docs/QWEN-REALTIME-ASR-PROBED.md`） |
| `bench/latency/probe-realtime-asr-events.mjs` | 客户端事件探测：`clear` / 空 `commit` / `session.finish` 收不收；`--idle 90` 测空闲超时 |
| `bench/latency/probe-realtime-asr-turn.mjs` | 用真机 `uplink.pcm` 原速重放，量「真停嘴→定稿」；`--manual 40` 走手动 commit，`--gain` 补回放大前的增益 |

**结论（2026-11-17 查清，别再按「p 是噪声」处理）**：p 不是噪声，是**窗口喂错了**。

| 偏差 | 事实 |
|---|---|
| 窗口 | 我们是**连续 8 s 滚动**（短句子里七秒可能是上一轮）；官方是 `speech_start − 500 ms` 到现在的**这一句**。同一句滚动 p=0.26、按句裁 p=0.95 |
| 补零 | `server.py` 补在**末尾**，官方 `np.pad(audio, (padding, 0))` 补在**开头**（语音永远顶到窗口末尾） |
| 尾巴 | 尾巴上的静音会把 p 一路拉低（停嘴处 0.95、+300 ms 0.35、+800 ms 0.04），而 p 正是「要不要再等一拍」的依据 —— 每等一拍判据更差 |

模型、特征提取、ORT 都验过是对的：模型文件与 pipecat 内置的
`smart-turn-v3.2-cpu.onnx` **git blob 相同**；`turn_judge/whisper_features.py` 与上游逐行相同，
输出与 `transformers.WhisperFeatureExtractor(chunk_length=8, do_normalize=True)`
**bit-identical**（maxdiff 0.0）；换 ORT 1.19 与 1.31 结果一致。中文准确率本来就低
（官方 benchmark 85.8%，其余语种 90–97%），所以 p 只当**参考信号**，别做硬判据。

**对齐坑（用档案复算时必踩）**：`uplink.pcm` 只含设备真的推上来的帧，时间轴比墙上钟
**越来越慢**（实测 75 s 差 −0.7 s，末尾 −3.8 s）。切片一律用事件里的 `at.pcm` / `at.down`，
不要用 `t × 32`。另外 **`downlink.pcm` 是 24 kHz**（CosyVoice 原生），按 16 kHz 读会慢 1.5 倍。

### 5.1 两条判停收尾规则（2026-11-17 加，别再「调阈值」绕过去）

1. **文本含汉字时用 `TURN_JUDGE_THRESHOLD_CJK`（0.35），不是全局 0.5。**
   官方 benchmark 里中文是最差一档（85.8%，**漏报 9.26% / 误报 4.95%**）——方向是偏向
   说「没说完」。真机同一场的实测正好两簇分开：

   | 文本 | p | 真相 |
   |---|---:|---|
   | 「嗯，对。」「嗯，那先聊到这里吧，你挂一下。」 | 0.27–0.41 | **说完了** |
   | 「对吗？那句。」（后面还有「台词的经典是…」） | 0.007–0.11 | **没说完** |

   0.5 会把第一簇全判成没说完（各白等 400–800 ms）。0.35 落在两簇之间。
   ⚠️ 样本只有 21 轮，**这是暂定值**：按 `judge.decide` 里的 `p` 和 `threshold` 复盘再定。

2. **「再等一拍」只在等到的东西变了时才有意义。**
   静音期间快照会被裁掉尾巴，所以**字节数不变 = 输入一模一样 = 同一个 p**。真机
   `judge.decide` 里出现过 `0.412 → 0.280 → 0.280`：最后那个 0.280 是拿同一段音频
   重算的，400 ms 纯损失。现在音频和文本都没变就直接收下，只报一条
   `accept`（日志写「音频和文本都没变，不再等」）。

   **为什么不做「按 p 分档等」**（>0.8 立收 / 0.3–0.8 等 1 拍 / <0.3 等 2 拍）：
   p 的大小分不出「用户还在说」和「模型不灵」—— 真机上完整的「经济穿越你知道吗？」
   p=0.01，而没说完的「对吗？那句。」p=0.11。**「用户还在说」的证据是音频/文本变了**，
   不是 p 高低。

### 5.2 下一步方向：灰区用句末韵律仲裁（**未做，等数据**）

**目标**：判停 p 落在**灰区（0.35–0.5）**时——也就是现在会白等一拍的那批——用本地声学
特征仲裁，不再问一次模型（零延迟、零成本、不新增链路）。

**为什么值得**：中文句末的边界信号是真实存在的，而模型恰恰在中文上最弱（官方 85.8%，
929 条中文样本 vs 英文 7,820）。可靠的信号是**句末延长**、**末字能量衰减**和
**句末气声化**；**F0 方向不能用来判「说完」**（汉语语调只改调域/调阶，特指问和陈述同形，
「句末升 = 问句」不成立）。

**已有的证据**（`bench/latency/probe-prosody.py`，两份真机向量 23 句）：

| 特征 | 结论 |
|---|---|
| 末字能量斜率 | ✅ 方向对。12/14 负斜率；两个「真没说完」的都是**正**斜率（+148 / +324 dB/秒） |
| 末段延长 | 粗代理能算，但 10 ms 帧太粗，需要更好的音节切分 |
| F0 斜率 / 跨度 | ❌ 40 ms 自相关在短句、−40 dBFS、句末 creak 上会乱给（见过 906 / −485 半音每秒）。要用就换 pyworld / REAPER |

**卡在哪**：**负样本只有 3 例**。任何阈值在这个样本量上都是碰运气 —— 我们这两天已经
踩过一次（`trailingTrimMs` 100→20，离线扫描说好、真机复现不出来）。

**开工顺序**（前两步不依赖新录音）：

1. 写「自动捞负样本」。**先分清两类，别混成一个标签**（查过两份档案，都能捞）：
   - **合并类**：同一轮里 `asr.sentence` 的 `index=2`，它前一句当时**没被关掉** →
     说明那一刻 p 低是**对的**。实测有 3 例（a1 的「嗯。」/「对吗？那句。」，a2 的
     「我问你最近看过什么电影？」）。这类用来**防阈值调太低**。
   - **切错类**：`turn.end.interrupted=true` 且这一轮很短、紧接着又起了一轮 →
     这才是真正的误判（a1 轮 7 就是：判停给 0.007 却花光预算强收，半句成轮、
     刚出声就被后半句打断）。这类用来**定阈值**。
   产出 `(文本, 音频区间, 标签, 类别)` 表。
2. 换真 pitch tracker，把三个特征在**同一批**样本上重算，看 AUC；
   到这一步才知道韵律到底能不能用。
3. 攒够 15–20 个**切错类**负样本之后再标定阈值 —— 在那之前**不要动生产**。

## 6. TTS / 下行

| 脚本 | 作用 |
|---|---|
| `scripts/probe-cosyvoice.mjs` | CosyVoice 首包拆解（DashScope `api-ws/v1/inference`） |
| `scripts/probe-cosyvoice-warm.mjs` | 同一连接连跑 N 个 task，看稳态首包 |
| `scripts/probe-aliyun-tts.mjs` | NLS `SpeechSynthesizer` 首包（另一家，换供应商时比） |
| `scripts/probe-tts-latency.mts` | 首包里有多少是「重新建连」（undici keep-alive 4 s） |
| `bench/latency/probe-cosyvoice-firstbatch.mts` | **首批几个字才开跑** |
| `bench/latency/probe-cosyvoice-taskid.mjs` | 回执里有没有 `task_id`（决定能不能分槽） |
| `bench/latency/probe-cosyvoice-two-tasks.mjs` | 同连接连跑两个 task 什么时候能开第二个 |
| `bench/latency/probe-token-cadence.mts` | 流式模型第 8 / 第 20 个 token 各要多久 |

注意 `scripts/` 下这四个是**历史探针**，跑起来要 `.env` 里的 `ALIYUN_*` /
`DASHSCOPE_API_KEY`。新写的放 `bench/latency/`。

## 7. ASR / 上行音频

| 脚本 | 作用 |
|---|---|
| `scripts/aliyun-probe.mjs` | NLS 实时识别连通性（喂 pcm/sbc，`--rate` 改采样率） |
| `scripts/nls-check.mjs` | 权限交叉验证（握手 40000002 时定位是权限还是别的） |
| `scripts/probe-nls-vocab.mjs` | `customization_id` / `vocabulary_id` 真被解码时用了吗 |
| `scripts/asr-ab.mjs` | 同一段音频 16 kHz vs 8 kHz 识别对比 |
| `scripts/env-dump.py` | 逐窗能量包络：非语音段是不是数字静音、语音段有没有碎片 |
| `scripts/speed-check.py` | 字/秒（判断"音频问题 vs 模型幻觉"最硬的定量指标） |
| `scripts/hf-compare.py` | 上行 mSBC 对下行 24 kHz 的频谱斜率 |
| `scripts/sbc-sync-test.py` | ffmpeg 解 mSBC 是否依赖 syncword（HFP 用 0xAD 不是 0x9C） |
| `scripts/push-sbc.mjs` | 把 mSBC 按实时速率推给本地 harness，收下行 |

## 8. 快车道

| 脚本 | 作用 |
|---|---|
| `bench/fast_lane/run.ts` | 误拦截率 / 命中率 / 两条路径延迟。`--runs N` 看方差，`--offline` 假 fetch 只验 harness |
| `bench/fast_lane/probe_models.mjs` | 逐供应商量首 token |
| `bench/fast_lane/cases.json` | 用例（`chitchat` / `task`） |

误拦截 > 0 → 退出码 1，可以当门禁用。

**判据只有形态（2026-11-19 起）**：`isFastCandidate()` 挡空、超 `FAST_LANE_MAX_CHARS`、含阿拉伯数字，
**不判语义**。要转交就由模型在流里输出 `[[DELEGATE]]`（`abandon()` 接 dsh）。
`cases.json` 里 `task` 那组用例验的是「模型会不会自己说 `[[DELEGATE]]`」，不是「词表挡不挡得住」——
测试里的 fake fetch 返回 `[[DELEGATE]]` 来触发委派。为什么删词表：
「你看过星球大战没？」「为什么？」这类闲聊因为含「看」「为什么」被一票判成任务，
真机 92 轮里 25 轮白走 `dsh`，账见 `LATENCY-CLOSURE.md` §7。

## 9. `dsh` / agent 侧

| 脚本 | 作用 |
|---|---|
| `scripts/probe-dsh-events.mjs` | 把 SDK 的所有 JSON-RPC 通知原样打出来 |
| `scripts/probe-stream-shape.mjs` | 长回答时 `assistant/message` 推几次（能不能做流式 TTS 的决定性证据） |
| `scripts/probe-api-speed.sh` | 裸 DeepSeek API 的 TTFT + token/s（判断慢在模型还是 dsh 层） |
| `scripts/probe-announce.mjs` | 「后台 job 结算 → 播报」这条链路走不走得通 |
| `scripts/patch-sdk-cancel.mjs` | 给 dsh SDK 补 `session/cancel`（`--check` 返回 0 = 已打） |
| `scripts/patch-sdk-fork.mjs` | 给 dsh SDK 补 `session/fork`（双轨撤回用；`--check` 返回 0 = 已打） |
| `bench/latency/probe-dsh-fork.mjs` | 验 fork 能不能用、切点取在哪才干净（起真 dsh，跑两轮再切掉第二轮） |
| `bench/eot/our_judge_adapter.py` | 把线上判停器接到公开基准 `livekit/eot-bench` 上（numpy + onnxruntime，不装 torch）；跑法见 `bench/eot/README.md`，结果见 `docs/EOT-BENCH-RESULTS.md` |
| `scripts/said-audit.ts` | **审计模型行为**：把每轮「用户说了什么 → 被问了什么（全量 messages）→ 模型答了什么 → 用户听到多少」摆成时间线。快车道没有 session log，只能靠 `agent.*` + `turn.end.said`；老档案会显示「缺仪表」而不是空白 |
| `bench/eot/policy_replay.py` | 在真机 `judge.decide` 轨迹上**确定性重放**新的判停策略，出「② old→new / 定稿→首声 / 误切逐条清点」。改判停逻辑后的验收就靠它，结果见 `docs/EOT-SUPPLEMENT.md` §10 |
| `bench/eot/turn_open_probe.py` | 量「开轮时静音多长」和「开早了之后发生什么」（结局 a/b/c 三分类） |
| `bench/eot/judge_extend_probe.py` | 数每一次 `extend` 到底救到没有（窗口内用户有没有重新出声） |
| `bench/eot/paired_replay.py` / `degrade_probe.py` | 判停模型的**唯一有效评估口径**（真机配对重放）+ 把 bench 音频走真机链路的消融（分离「音频链路」与「问题定义」） |
| `scripts/install-profile-patch.mjs` | 把人设 patch 装进本机 dsh sdk profile（`npm run install-profile`） |

## 10. τ²-bench

| 脚本 | 作用 |
|---|---|
| `bench/tau2/run_voice.py` | 跑一题中文语音 τ²（被测方是 dsh，顾客是 Qwen realtime） |
| `bench/tau2/harness_adapter.py` | 把 dsh 语音链路伪装成一台设备给 τ² |
| `bench/tau2/bridge_server.py` | 把 τ² `Environment` 暴露成本地 HTTP，给 MCP 工具回程 |
| `bench/tau2/mcp-tau2.mjs` | stdio MCP 代理，工具名 `mcp__tau2__<tool>` |
| `bench/tau2/bench-lat-run.sh` | 跑一场 bench 后出「说完→首字节」p50/p90/p95 |
| `bench/tau2/smoke_bridge.py` | 工具桥三段自测（建环境 / HTTP / MCP 代理） |
| `bench/tau2/smoke_user.py` | 顾客能不能开口、能不能收音频与转写 |
| `bench/tau2/probe_qwen.py` | 裸看 Qwen realtime 事件流（`session.update` 有没有被吃） |
| `bench/tau2/qwen_realtime_user.py` | τ² 的模拟顾客（端到端全双工） |
| `bench/sfe/fetch.py` | 下 SpeechFCEval 中文子集 |

## 11. 设备模拟 / 运维

| 脚本 | 作用 |
|---|---|
| `tools/fake-phone.ts` | 假 v1 手机，也是协议的最小实现（开源时给客户端作者当参照） |
| `tools/fake-v2-device.ts` | 假 v2 设备：`CaptureImage` / 电量上报。`--host <服务器地址> --port <端口> --tls --token <hex>` |
| `scripts/watch-tune.sh` | 两端日志同时抓、按时间对齐（本机或能 ssh 到 `<服务器地址>`） |
| `scripts/env-dump.py` | 见 §7 |

`npm run` 入口只有六个：`start` / `pair` / `sim` / `typecheck` / `test` / `install-profile`。
其余一律直接 `node <路径>`。`.ts` / `.mts` 在 Node ≥ 22.18 上直接跑（类型擦除已默认开，
本机 v24）；老版本要加 `--experimental-strip-types`，几个 .ts 脚本的头部注释里带着它，
加上也无害。

---

## 12. 标定值（跑对了应该看到什么）

**真机实测（2026-11-17，`v2` 设备，两场共 12 轮；档案目录名见 §12.1 的字段说明）**：

> 这里是**两场 12 轮**的样本；README「标定原始记录」用的是**另一份 13 轮同向量**
> （`…_46019`），数字不同属正常，别把两套混着引用。

> **这张表里只有「闭嘴→出声」那行的 p50/p90 是项目口径**，其余都是单段中位，
> 只用来定位，不能引用成 p50。

| **闭嘴→出声** | **p50** | **p90** | 取值 |
|---|---:|---:|---|
| 真机 **快车道**（qwen-flash）轮 | **1253** | **2490** | 901 / 1154 / 1253 / 1791 / 2956（n=5） |
| 真机 **`dsh`** 轮 | **2896** | **3652** | 1516 / 2835 / 2896 / 3598 / 3688（n=5） |
| 预算 | 1200 | 1200 | |

两组各段中位：

| | ① 说完→定稿 | ② 定稿→开轮 | ③ 开轮→首块 |
|---|---:|---:|---:|
| 快车道（n=6） | 384 | 64 | 562 |
| `dsh`（n=6） | 330 | 1470 | 1238 |

**别把 ② 的差别算到「换模型」头上** —— 这两个 ② 是**样本巧合**，不是路径差异：

- 快车道那 6 句里 4 句判停当场收下（②= 5/6/53/75），2 句等到门关（②= 950/2115）
- `dsh` 那 6 句里 4 句等到门关（②= 1466/1474/1889/1900），2 句当场收（②= 1/75）
- 逐轮对得上：`② ≈ 等关门`。`②` 是**判停侧车敢不敢收**，和走哪条无关

真正由路径决定的是 ③：`dsh` 的 ③ 再拆是模型首字 **888** + TTS **~300**；
快车道是 qwen-flash 首字 **~300** + TTS **~260**。

所以**端到端的地板不在模型**：② 的跨度是 `5–2115 ms`，比换模型省下的 ~200 ms 大一个数量级。

读法（**这三条比数字本身重要**）：

1. **③ 里 80% 是模型首字**（`dsh` 组），不是 TTS。看到 ③ 大先去 `reply_breakdown.py`
   分锅，别直接怀疑 TTS —— TTS 首包一直稳在 300 ms 上下。
2. **换 qwen-flash 在端到端上看不出来**：它只动 ③（模型首字 ~500 → ~300），
   而 ③ 只占端到端的三成多。`p50 1253` 对 baseline（`bench/replay` 8 场 21 轮）
   的 `1408` 是 −155 ms，和噪声一个量级；而 `p90 2490` 对 `1652` 反而更差，
   因为这次的 5 个样本里有一次 `② = 2115`。**n=5 不支撑任何显著性结论。**
3. **② 大不等于排队，也不等于走慢车道**：它就是判停侧车不敢收，一直等到能量门
   走满 2 s 静音才被迫开轮（判停 p 值只有 0.025–0.356；而「还在吗？」p=0.94，
   ②只有 6 ms）。用 `analyze-real-archive.mjs` 的「等关门」列一看就知道。
   **要压端到端先压 ②**，换模型省下的 200 ms 会被它的方差（5–2115）淹掉。

**② 压过两刀**——同向量回放（`…_51313`）：

| 改了什么 | 闭嘴→出声 p50 | p90 |
|---|---:|---:|
| 起点：`unsure` 与其他三种延长共用 7 拍 | 2888 | 3273 |
| `MAX_UNSURE=2`（`7577c04`） | 1915 | 2344 |
| **+ 窗口按句裁 / 补零在前 / 裁尾巴静音（`f96ef1d`）** | **约 1630** | — |

第二刀是**结构性的**：`judge.decide` 里前几句的 p 从 `0.45 / 0.31` 变成
`0.93 / 0.81`，`② 定稿→开轮` 从 `1889 / 1900` 掉到 `1 / 2 ms` —— 不是少等几拍，
而是第一次问就已经是「说完了」。剩下的时间全在 ③（模型首字 + TTS）。

第三刀（中文阈值 0.35 + 「没变就不等」）在**另一份更新的真机向量**上验的
（`20261117-221010-…_46019`，13 轮，2026-11-17 22:10 真机）。
**完整回放日志（两次、逐轮、含状态审计）贴在 [README 的「标定原始记录」](../README.md#标定原始记录可复算) 里** ——
那里是标定数据的落地处，本节只放结论：

| 同一份向量 | qwen（fast）p50 | dsh p50 | 全部 p50 |
|---|---:|---:|---:|
| 真机源档案（改前） | 1417（n=6） | 1671（n=6） | 1629 |
| 同向量回放·第 1 次 | 1151（n=7） | 1476（n=5） | 1171 |
| **同向量回放·第 2 次（标定记录）** | **1011（n=5）** | **1500（n=7）** | **1298** |

两次跑的差别全在 ③（服务端抖动 ±400 ms）和快慢比例（快模型偶尔自己回 `[[DELEGATE]]`），
所以**看量级不看单次**。

直接效应全在 ②：三句短应答（「嗯，对。」×2、「嗯，那先聊到这里吧，你挂一下。」）
原来各等 944–956 ms，现在 **475 / 3 / 2 ms**（第 1 次是 479 / 3 / 1，可复现）；
而「对吗？那句。」（用户确实还在说）仍然等 1020 ms —— 那是**该等**的。

### 12.1 档案里能查什么（字段级）

**这张表是「观测工具」的另一半**：脚本给段号，字段给原因。写新脚本前先看这里有没有现成字段，
不要再从 console 日志里 grep。

| 事件 | 关键字段 | 能回答什么 |
|---|---|---|
| `gate.open` / `gate.close` | `gapMs` | 真实停嘴时刻 = `gate.close.t − gapMs`（**别直接减 `t`**） |
| `asr.partial` / `asr.sentence` | `text`、`index`、`at.pcm` | ASR 逐字对比；`at.pcm` 是音频里的字节偏移，离线复算判停要用 |
| `turn.start` | `text_len`、`image` | 这一轮进来的文字长度（并句后会更长） |
| **`judge.decide`** | `p`、`waitMs`、`action`、`why`、**`whyAccept`**、**`threshold`**、`silenceMs`、`waitedMs`、`budgetMs` | **② 的成因**：判停每次给的概率 + 还要等多久。`action` = `accept`/`extend`/`error`；`why` = `silence`/`short`/`unsure`（`grace`/`unfinished` 已在 `ed87bc7` 删除，旧档案里还会有）；`whyAccept=cap` = 静音到了统一上限（`TURN_JUDGE_MAX_OPEN_SILENCE_MS`）而放行；`threshold` 是这次用的阈值（中文 0.35 / 其他 0.5），没有它分不清「换语言了」还是「p 变了」 |
| `llm.first` | `ms` | 模型首字 |
| `tts.first` | `ms` | TTS 首块（③ 的终点） |
| **`tts.task`** | `setup_ms`、`feed_ms`、`first_ms`、`stream`、`prewarmed` | **TTS 那一段拆三截**，常开（不是调试探针）：`setup_ms` = run-task → task-started（还没轮到我们 / 进程被卡）；`feed_ms` = task-started → 首批文本送出（**我们这侧**没供上字，等模型吐字 / 等攒够批）；`first_ms` = 首批文本送出 → 首块音频（服务端合成）。三截慢起来长得一样、治法完全不同 —— 见 `OPS-RECORD.md` §12.8.1。`feed_ms` 是 2026-11-19 加的：那之前出现「首包 1690 ms」时只能归到「服务端」这一层，再也下不去。非流式（`stream=false`，回执那条）没有分批送字，`feed_ms = -1`。一轮里可能不止一条（回执 + 回答），**回答那条在最后** |
| **`dialog.state`** | `from`、`to`、**`why`** | **为什么进这个状态**。`why` 里写着「回执出声（可打断）」还是「首块音频已下发」—— 没有它，`thinking → speaking` 分不出是回执还是答案（差约 1 s） |
| **`turn.end`** | `interrupted`、`audio_s`、`heard_s`、`dsh_ms`、`tts_first_ms`、`dsh_session`、**`path`**、**`delegate`**、**`said`**、`said_chars`、**`loop_max_ms`**、**`loop_p99_ms`** | `path` = `fast`/`dsh`：**这一轮谁答的**；`delegate` = `task`/`answer`/`memory`/`overcap`/`delegate`/`timeout`/`empty`/`error`：**为什么交给 dsh**；`dsh_session` 用来定位 dsh 的 session log；**`said` = 这一轮实际念出去的文本**（已剥情绪标签、多步时含全部增量；回执不算）—— 审计「抢话之后模型有没有接上」靠它，因为快车道（qwen-flash）**没有 session log**，dsh 那侧另有 `assistant/message` 可对；**`loop_max_ms` = 这一轮里事件循环被占住的最大时长**——它跟着 TTS 尖峰一起大，说明是**我们自己被卡住**，不是厂商慢 |
| `call.send` | `json` | 下行原语（`audio.stop` / `listen.stop` …） |
| `device.played` | — | v2 设备「真播完」回执 |
| `announce` / `announce.replay` | `len`、`emotion` / `count` | 后台汇报要播 / 补播了几条 |
| **`agent.ask`** | `kind`（`prefetch`/`spec`/`live`）、`model`、`hedge`、`text`、**`msgs`** | **快车道问了什么**：`msgs` 是**全量** messages（system + 历史窗 + 当前句），不截断 |
| **`agent.done`** | `ok`、`ms`、`first_token_ms`、**`raw`**、`opened`、`delegated` / 失败时 `err` | **模型答了什么**：`raw` 是原文（含情绪标签、可能被 `[[DELEGATE]]` 早退）；`opened` = 有没有已经推给 TTS（推过就撤不回） |
| **`agent.drop`** / **`agent.claim`** | `why` / `ok` + `ran_for_ms` | 预跑为什么作废、有没有被认领 —— **预跑不一定变成一轮**，只有这两条能看见被丢掉的那几趟 |
| **`receipt`** | `text`、`chars` | 委派轮先说的那句「嗯，我想想」，它不在 `turn.end.said` 里 |

> **为什么 `agent.*` 单独一组**：预跑/投机可能在 `turn.start` **之前**就被作废（换一句、
> 判停并段、插话），那些请求已经发出去、模型也已经答了，但永远不会走到 `turn.end`。
> 不单独落，就只剩 console 里截断的 120 字 —— 而快车道**没有 session log**。

`turn.end` 的一行实例：

```
{"interrupted":false,"audio_s":5.0,"heard_s":5.0,"said":"在呢，刚看了一下。","said_chars":8,
 "dsh_ms":714,"tts_first_ms":666,"path":"dsh","delegate":"task","dsh_session":"session-…"}
```

**为什么必须由 agent 报 `path`**：`dsh_ms` 分不出来。快车道预跑被认领的轮次是 ~0，
qwen 现场回的是 200–660，`dsh` 是 885–1342 —— **三段有重叠**（「还在吗？」343 ms 是快车道，
「我怎么说？」662 ms 是 `dsh`）。而「本地闸挡住」和「快车道自己让位」在 console 日志里
长得一模一样，只有 `delegate` 能分开。

**为什么要 `said`**：`path=dsh` 的回复还能去 dsh 的 `session.v4.jsonl.zstd` 里翻
`assistant/message`（`dsh-timeline.ts` 已经会按 `dsh_session` 对齐）；**快车道没有这份东西**，
只有 console 里截断的前 120 字。而 `isFastCandidate()` 只挡 ASCII 数字 —— 中文数字
（「幺三八」）、短碎片、闲聊全都走快车道，正好是最需要审模型行为的那一批。

### 12.2 还是缺口（别假装有）

| 缺什么 | 现在只能 |
|---|---|
| **回执的时长 / 首块** | 回执的**文本**已有（`receipt` 事件带 `text` + `chars`），但**时长和首块**仍只有 console 的 `回执 … 0.65 s（首块 330ms）` 那一行 |
| TTS 这条流走的是流式还是整段回退 | 看 console 的 `流式 分支=…` / `流式 ✗ 合成失败…` |
| 判停 `predict` 那一趟往返的耗时 | 看 console 的 `判停 侧车预热 … ms`（只有预热有数） |
| 作业 / 子代理的状态转移 | **不要往档案里抄** —— dsh 的 session log 已经写全，用 `dsh-timeline.ts` 去取 |

前三条要补的话，各自是一个 `onEvent` 调用；**先问值不值**（新增字段 = 档案变长 + 一套要维护的读法）。

> **已经补上的（2026-11-18，`5c96bf6` + `e1c3d6a`）**：模型行为这一层不再算缺口 ——
> `agent.ask`（全量 messages）、`agent.done`（原文）、`agent.drop` / `agent.claim`（被丢掉的预跑）、
> `turn.end.said`（实际播出的话）、`receipt`（回执文本），读法是 `scripts/said-audit.ts`。
> 见上面 §12.1 的事件表和那个工具的说明。

**TTS 服务端**（CosyVoice）：task 建立 50–62 ms，首包 275–440 ms，
**服务端要 ~8 个字符才开跑**（2 字要 901 ms），首批音频恒定 22 ms / 1040 B @ 24 kHz。

**快车道模型首字**（`qwen-flash`，`--runs 3`，n=39，生产参数 `--timeout 1200`）：
**p50 284 / p90 359 ms**；整句 p50 409 / p90 475；误拦截 0/30；闲聊命中 39/39。
这是**模型首字**，不是闭嘴→出声。

---


### 12.3 ASR 端点自控（实验路径，⚠️ **尚未全量验证**，2026-11-18）

`MIAI_STT=qwen-realtime`：关掉服务端 VAD（`turn_detection: null`），由宿主在静音到点发
`commit`（`VOICE_COMMIT_MS`，默认 40），开轮另设静音门槛（`VOICE_OPEN_QUIET_MS`）。

同一份向量（`…_46019`）只动这一段：

| 配置 | ① 停嘴→出句 中位 |
|:---|:---:|
| NLS（现网） | 372（真机源）/ 400（回放） |
| qwen realtime，commit 40 + 门槛 300/200 | **254 – 302**（4 次回放） |

**别把 §12 的端到端 p50 套到这条路径上**：`②`/`③` 的单次回放方差有 1 s 以上，
4 次样本还定不出端到端数字。按账推算是 **0.95 – 1.05 s**，但那是推算，不是标定值。

四个配置的逐轮对比、拆句计数、以及「门槛取 400/250 会过度合并」的反例，见
[QWEN-REALTIME-ASR-PROBED.md](./QWEN-REALTIME-ASR-PROBED.md)。

### 12.4 判停模型的中文基准（eot-bench，2026-11-18）

判停器接到公开基准 [livekit/eot-bench](https://github.com/livekit/eot-bench) 的中文子集上跑过一轮：
本项目 AUC **0.754**、5% 误切预算下等待 **0.918 s**；官方同模型（GPU 导出）0.745 / 0.959 s。

**这是策略层指标**（基准一起扫 `threshold` / `action_delay` / `timeout`），
**不是本项目的 ①**，别混着引用。

结论：窗预处理只值 +0.009 AUC / −41 ms（**已到顶**），短板是模型本身。
完整表与口径见 [EOT-BENCH-RESULTS.md](./EOT-BENCH-RESULTS.md)（§6 是 mini 的形态与许可），
复现见 [bench/eot/README.md](../bench/eot/README.md)。

**mini 是纯音频模型**（最近 2.0 s + 本轮已说长度），和我们现在的 Smart Turn 同一个槽位，
不在「语义侧」；榜单里只有 LiveKit v1.1（云）和 ultraVAD 吃「上一句助手回复」，
没有任何纯文本条目 —— 按输入模态的分类见 [EOT-BENCH-RESULTS.md](./EOT-BENCH-RESULTS.md) §5。
mini 的 AUC 是 0.874 / 0.835 s，但**许可不允许我们这样用**：它是编译好的原生扩展
（`livekit-local-inference`，90 MB wheel + 315 MB 常驻），权重走专有的
`LicenseRef-LiveKit-Model`，只能在 LiveKit Agents 框架内使用。

## 13. 踩过的坑（别重现）

1. **手搓分段脚本**（`bench/latency/analyze-real-archive.mjs` 第一版）：
   轮次配对用了 `Array.find`，它给的是**最靠前**的那条定稿，于是第 2 轮配到第 1 轮的
   句子，② 算出 `63543 ms`；`gate.close` 还往**前**找（实际它记在 `asr.sentence`
   之后），① 全废。→ 档案分段只准用 `latency-report.ts`。
2. **事件名猜错**：`probe-single-turn.mjs` 找 `event`/`type`/`e`，档案里是 `ev`，
   于是 ①②③ 全印成 `—`，看着像"没仪表"，其实仪表齐全。
3. **偶数样本中位**：`s[n/2]` 在 6 个样本时取第 4 个，系统性偏高（2835 vs 2313）。
   偶数要取中间两个的均值。
4. **两个口径的中位数相减得不到"开销"**（`lat_summary.py` 的教训）：曾经用
   bench 2010 − 真机 1400 反推出 500 ms 的固定开销，那 600 ms 其实是 τ² 任务答复更长。
5. **跨路径不可比**：真机上行是 mSBC（570 B / 75 ms），bench adapter 是 PCM16
   （640 B / 20 ms）。同一条路径的改前/改后才可比。
6. **快车道的 ③ 和 `dsh` 的 ③ 不能混**：前者是 `qwen-flash` 首字，后者是
   `deepseek-flash` 一整轮 agent（含工具往返）。
