# 云端语音后端架构设计与实现

> 本文描述本仓 `src/`（手机 ↔ 大模型 的自建后端）的分层、类职责、并发模型、状态机、
> 数据流、错误模型与扩展点。接线细节与部署见 [README.md](../README.md)；
> 本文只讲**实现怎么摆**。
>
> **对账基准**：`src/` 当前代码 + `npm test`（部署运行时，见 §8）全绿。
> **注意**：这棵树早年放在 `cloud/src`、编排类叫 `aliyun-session`；现在路径是 `src/`，
> 编排类是 `VoiceConnection`（`src/voice-session.ts`）。文中已按现行名字改写，
> 见到旧名按这个对应关系读。文档与代码冲突时以代码为准。

---

## 1. 分层与模块

```text
┌──────────────────────────────────────────────────────────────────────┐
│ main.ts          装配：CLI / 环境 → pipeline-mode → provider → 服务    │
│                  VOICE_PIPELINE=live | cascade（启动期显式二选一）      │
├──────────────────────────────────────────────────────────────────────┤
│ voice-session.ts 一条连接的**编排**（VoiceConnection）：把下面各层接起来，│
│                  自身不含判定                                          │
├──────────────┬──────────────┬───────────────┬────────────────────────┤
│ 传输与协议    │ 上行处理      │ 应用层         │ 判定 / 路由 / 执行      │
│ transport    │ uplink-…     │ AppSession    │ kernel（纯 step）       │
│ frame        │ energy-gate  │  FloorArbiter │ kernel-runtime          │
│              │ silence-…    │ DialogRuntime │ dialog-fsm（薄门面）     │
│              │ assembler    │  一轮串行队列   │ causal                  │
│              │ turn-judge   │  播报空窗 800ms │ turn-router（routeTurn）│
│              │              │               │ conversation-ledger     │
│              │              │               │ turn-runner 单泵        │
│              │              │               │   → FastVoiceEngine     │
├──────────────┴──────────────┴───────────────┴────────────────────────┤
│ 主管道（会话内互斥，pipeline-mode.ts 启动期选定）：                      │
│  live    pipelines/live-orchestrator + background-task-bus            │
│          Omni 单前台 + 异步 dsh；空窗 speakFromText 同嗓子汇报          │
│  cascade pipelines/cascade-agent                                      │
│          FastLlmClient + PrefetchSlot + dsh 投机 + CosyVoice 流式      │
│          （routeTurn 的 live 恒为 off，不接 Omni）                      │
│ 引擎     engines/live-voice-engine · cascade-voice-engine             │
│          · agent-engine-adapter（未注入引擎时收成同一条 respond()）      │
│ 可替换   omni-shadow · dsh（session.ts）· qwen-realtime-asr / aliyun  │
│          cosyvoice / omni-tts / mimo · turn-judge                     │
├──────────────────────────────────────────────────────────────────────┤
│ 旁路：archive · announce-store · photo-inbox · tool-control（服务级）  │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.1 依赖与隔离

```text
main.ts ──▶ pipeline-mode（纯函数：VOICE_PIPELINE=live | cascade）
        └──▶ voice-session ──┬──▶ transport ──▶ frame
                            ├──▶ uplink-pipeline ──┬──▶ energy-gate
                            │                      ├──▶ silence-triggers
                            │                      └──▶ utterance-assembler ──▶ turn-judge
                            ├──▶ app/session（AppSession / FloorArbiter）
                            ├──▶ app/dialog（DialogRuntime）──▶ session-core ──▶ dialog-fsm
                            │         │                                           └──▶ kernel-runtime ──▶ kernel ──▶ causal
                            │         └──▶ turn-runner（单泵，只消费 FastVoiceEngine.respond）
                            │                    ├──▶ 注入的引擎
                            │                    │      live：pipelines/live-orchestrator.toEngine
                            │                    │            └── engines/live-voice-engine ──▶ omni-shadow
                            │                    │            └── background-task-bus ──▶ dsh（异步，不抢前台）
                            │                    │      cascade：pipelines/cascade-agent.toEngine
                            │                    │            └── fast-llm-client + prefetch-slot
                            │                    │            └── dsh 投机 ──▶ cosyvoice 流式
                            │                    └──▶ 未注入引擎：engines/agent-engine-adapter
                            │                          （{ agent, tts } → 同一条 respond()）
                            ├──▶ turn-router（routeTurn：这一轮先由谁答）
                            ├──▶ conversation-ledger（账本：上一轮谁答的 / 少听没少听）
                            ├──▶ photo-inbox
                            ├──▶ archive / announce-store
                            └──▶ tool-control（进程级常驻，随连接热切换 handlers）

live 的空窗汇报不进 respond()：
  BackgroundTaskBus.onReport
    → voice-session.setTaskReporter → DialogRuntime.flushAnnounce
         （相位 listening，且距上次人声 ≥ 800 ms）
    → LiveOrchestrator.speakBackgroundReport
         ├─ speakFromText → TurnRunner.speakAudioAnswer
         │    （与 speakCanned 共用取消令牌、残句、speechChain）
         ├─ defer：车道忙或还不能说，排回队首
         └─ fallback：逐字，或前台开不了口 → speakCanned
```

`src/` 是**严格无环**的：箭头只有一个方向（`app/dialog` → `session-core` →
`dialog-fsm` → `kernel-runtime` → `kernel` → `causal`）。`dialog-fsm` 只是
`kernel-runtime` 之上的薄门面，相位只读 `runtime.state.dialog`。`SessionCore`
另从 `kernel` 取 `isPreTurnCommit` 这一个谓词，方向相同，不成环。

两条主管道互不引用。`cascade-agent` 不引用 `omni-shadow`、`live-orchestrator`、
`background-task-bus`；`live-orchestrator` 不引用 `fast-llm-client`、
`prefetch-slot`、`cascade-agent`。空窗播放是 `voice-session` 把
`TurnRunner.speakAudioAnswer` 当回调递进 `speakBackgroundReport`，管道不反向
依赖 `turn-runner`。`pipeline-mode.ts` 零 import，只产出一份 `PipelinePlan`。

四条硬边界，都是"能单测"换来的：

| 边界 | 规则 | 为什么 |
|---|---|---|
| `providers.ts` | **只放接口**，不 import 任何具体实现 | 换 STT / TTS / Agent 不改编排代码 |
| `voice-config.ts` · `pipeline-mode.ts` · `session-core.ts` · `dialog-fsm.ts` · `kernel.ts` · `kernel-runtime.ts` · `causal.ts` · `turn-router.ts` · `emotion.ts` · `hq-intent.ts` · `wake-word.ts` · `backchannel.ts` | 纯函数 / 纯状态机 / 纯类型，**不碰 socket、定时器、子进程** | 最容易出错的判断（插话算不算数、听到多少、这句要不要成轮、这一轮交给谁、这一会话走哪条主管道）用单测钉住，不必起连接；`kernel.ts` 还要求无 `await`（同一串事件在任何机器上 reduce 出同一结果）。`pipeline-mode.ts` 与 `voice-config.ts` 都不读 `process.env` |
| `transport.ts` · `frame.ts` | 不认识任何业务语义 | 改心跳不该动对话代码 |
| `pcm.ts` · `util.ts` | 无依赖的纯函数 | 谁都能引，不产生环 |

`voice-session.ts` 是唯一"什么都摸"的地方：它持有连接、定时器、子进程和工具口，
但**不做判断** —— 相位与结算在 `kernel.ts`，效果由 `session-core.ts` 判，
它只把各层的结论翻译成动作。开麦相位 `MicPhase` 只经 `enterMic` 迁移（见 §4.4）。
生产把能量门的 `voiceDebounceFrames` 设为 2。

---

## 2. 模块与类职责

### 2.1 传输与协议

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `frame.ts` | 分帧 `[type:u8][len:u32 LE][payload]`，头 5 B，单帧上限 32 MB；只做编解码，I/O 由调用方给 | `FrameDecoder` / `FrameWriter` / `UpstreamFrameType` / `DownstreamFrameType` |
| `transport.ts` | accept、首帧 `Hello` 鉴权、心跳应答、**空闲看门狗（默认 45 s）**、下行三件套 | `runTransport` / `Connection` / `DownlinkSink` / `parseHello` |

`DownlinkSink` 只有三个方法（`sendAudio` / `sendControl` / `close`），所以
`turn-runner`、`tool-control` 这些上层模块不需要知道对端是 socket 还是别的传输。

### 2.2 上行处理

| 文件 | 职责 | 关键点 |
|---|---|---|
| `uplink-pipeline.ts` | 上行解码：`msbc`（子进程 `ffmpeg`）或设备自报的 `pcm16` → 放大 → 能量门 → 有声段交 STT；另有**原始 PCM 旁路**与**电平表** | `onRawPcm` 给的是**放大前**的字节（档案要能重算增益） |
| `energy-gate.ts` | 「这块音频要不要推给 STT」的状态机 + 预卷缓冲。`silenceMs` 是封段 / 投机 / 判停共用的那一份静音累计；预卷以 `PrerollFrame`（`pcm` + 门内标好的 `voiced`）交出，下游不再自己跑 `pcm16PeakDbfs` | 生产（`voice-session.ts`）传 `voiceDebounceFrames: 2`，与静音触发器的两帧去抖对齐：单帧尖峰不把 `silenceMs` 打回 0，也不因此重开一段。缺省仍是 1（老单测）。没声音就**不建 STT 连接**：ASR 网关对"没听到有效语音"的连接 10 s 就判空闲超时 |
| `silence-triggers.ts` | 同一次静音喂四路**期限差一个数量级**的消费者：投机 100 ms / 判停预跑 200 ms / omni 车道封段 20 ms / ASR 封段 150 ms（后两路是客户端封段的默认；`QWEN_ASR_TURN_DETECTION=vad` 时为 0，见 `voice-config.ts`） | 四者各有自己的 `firedAt`，不是一个布尔「静音了没有」；闸只比时刻（`lastVoicedAt`），不持状态 |
| `utterance-assembler.ts` | 句子 → 一轮话语：按 TurnJudge 概率或固定窗口判停；判停请求**与静默窗重叠**提前发出 | ASR 的句号是**句子**边界，不是**轮次**边界；问号结尾不等于说完了。提前算的那份结果带两条有效性条件（还是同一句、算完之后没再收到中间结果），不成立就现算一遍 —— 拿过期结果定稿就是抢话 |
| `barge-voicing.ts` | 声学插话闸：定稿后无新有声帧时拦住同一截缓冲的重复解码幻觉 | 同步校验时钟同源（`CLOCK_MISMATCH_MS`） |
| `turn-judge.ts` | 常驻 Python 侧车的客户端：`[u32 len][int16 PCM]` 问、`[f64 概率]` 答 | 进程常驻、模型只加载一次；不可用时退回固定窗口 |
| `vad.ts` | silero-vad v5 封装（可选判停后端） | 输入是 `[1,576]`（512 + 64 点上下文）、值域 `[-1,1]`，阈值 0.4 |
| `wake-word.ts` · `backchannel.ts` · `hq-intent.ts` | 三条**领域规则**：唤醒词 / 纯应答噪声 / 要看细节的措辞 | 唤醒词词表（`ignorePhrases`）与「要不要自动拍细节」（`detail` 意图）都来自设备能力（见 §2.3）；v1 基线下前者空表、后者不启用，三条规则都只是"已知的机械事实"，交给模型判断反而更贵更不准 |

### 2.3 设备原语（`src/devices/`）

原语只收插件**两个环真正消费**的东西：对话环（上行音频 → 判停 → agent → 下行音频 → 插话即停）
和宠物环（佩戴 / 电量 / 招呼 → 时机 → 主动开口与「看你所看」→ 开麦听回应）。
设备怎么做到（P2P、相册、快门、蓝牙会话、显示屏、更多手势）归手机端或用户自己的适配器。
回声消除不是原语：主流智能眼镜都在端侧做 AEC。

| 方向 | 内容 |
|---|---|
| 下行操作 `DeviceCall` | `audio.stop` `listen.start{maxMs}` `listen.stop` `capture{id,intent,deadlineMs}` `capture.cancel{id}` `session.end` |
| 上行事件 `DeviceEvent` | `presence` `power` `summon` `played` `capture.waiting{id,say?}` `capture.failed{id,code,say?}` |
| 能力 `DeviceCapabilities` | `audioIn`、各拍照意图的 `needsUser`、五个上报 / 开麦开关、`ignorePhrases`；设备在 `Hello` 里自报 |

拍照按**用途**分意图：`glance`（看一眼）/ `detail`（看清细节），不按分辨率分。
每个意图只带一个 `needsUser`：要不要用户在设备上动手。它决定兜底时长，也决定
能不能**主动**拍 —— 要人按快门的档不能用于主动拍照。失败码 5 个
（`unsupported` `busy` `timeout` `cancelled` `failed`）；只有设备知道的原因
（没按快门、相册通道没建起来）放在 `say` 里，插件照念，不必认识每台设备的失败原因。

| 文件 | 职责 |
|---|---|
| `primitives.ts` | 原语类型、`captureMode()` / `canCaptureUnprompted()` / `supportsCall()`、`parseCapabilities()`（`Hello.capabilities`） |
| `wire-v1.ts` | v1 垫片：`V1_BASELINE` + `V1Session`（原语 ↔ 控制串 / 状态帧，并判「这帧图属于哪个请求」） |
| `xiaomi.ts` | 小米 v1 手机的默认能力与代说的话（真机验证） |
| `wire-v2.ts` | v2 线协议：`negotiateV2()`、`Call` / `Event` / `CaptureImage` 的编解码 |
| `index.ts` | 出口；`resolveDeviceLink()`：`Hello` 自报合法能力就走 v2，否则按型号提示走 v1 |

判定核只读能力，不认型号：「能不能自动拍细节」= `captureMode(caps, 'detail') !== null`，
要不要等人 = 它的 `needsUser`。执行层每次下发前用 `supportsCall()` 挡一次，
序列化交给 `V1Session.encode()`；`Control` / `Status` 的字面量不出现在业务代码里。
上行编码来自 `caps.audioIn`。

加一台设备 = 设备侧在 `Hello` 里自报能力（雷鸟 X3 Pro 的写法见
[`devices/RAYNEO-X3-PRO.md`](devices/RAYNEO-X3-PRO.md)）；插件不加文件，**协议动词不增加**。
`--device` 型号提示只为不会自报的 v1 手机存在，手机端改说新协议后随 `wire-v1.ts` / `xiaomi.ts` 一起删。

连接时先握手再干活（`voice-session.ts` 的 `handshake()`）：配了鉴权就等 `Hello`；
没配时等 1 秒，`Hello` 先到用它，别的帧先到或等满就按 v1 走，那一帧原样补交不丢。
`resolveDeviceLink()` 判版本：v2 就回 `Welcome` 并用 `Call` / `Event` 帧，否则走 v1 垫片。
`proto:2` 但能力不合法 → **不回 `Welcome`**，设备退回 v1，不拒绝连接。

`src/pet/` 这一侧只剩主动开口的判定与仿真（`brain/`、`pet-timing.ts`、`proactive.ts`、
`sim/`）。v0 的设备端口（`battery-cache` / `device-host` / `ports`）**已删除** ——
电量与佩戴现在是 `AppSession` 的设备事件输入，不再有第二个轮询/托管通道。

### 2.4 识别与合成（可替换实现）

| 文件 | 职责 | 约束 |
|---|---|---|
| `aliyun-asr.ts` | 阿里云 NLS 实时识别客户端（WebSocket） | 消息 id / task id 必须是 32 位纯十六进制；连接由能量门按需拉起 |
| `qwen-realtime-asr.ts` | DashScope realtime 识别客户端。默认 `manual`：端点由我们控。`QWEN_ASR_TURN_DETECTION=vad` 改由服务端 VAD 判句，客户端封段旋钮见 `voice-config.ts` | `turn_detection: null` 时服务端不判句，由宿主在静音到点时发 `input_audio_buffer.commit`；`silence_duration_ms` 地板是 200 ms（回执接受更小值但不生效）；协议**没有** `clear`，打断只能 commit 后丢结果；空缓冲 commit 会被拒，必须有脏标记。显式 `--stt qwen-realtime`（或 `MIAI_STT`）才启用；留空走旧链路（`legacy-pipeline`） |
| `mimo.ts` | MiMo 的 ASR 与 TTS（SSE 流式） | 上行 16 kHz、下行 **24 kHz**；TTS 是"聊天式"：风格进 `user`、正文进 `assistant`。`--tts` 留空时的默认实现 |
| `cosyvoice.ts` | 阿里云 CosyVoice 流式合成（DashScope WebSocket，一条连接复用跑多个 task） | 默认情绪模式 `prosody`（`DEFAULT_COSYVOICE_EMOTION_MODE`）；系统音色 + v3-flash 首包 ~350 ms。`instruction` 只给复刻/设计音色吃，首包多 ~90 ms，系统音色配它会 428 |
| `omni-tts.ts` | 把 omni 当**朗读机**：文本 → PCM16，走一条专用 realtime 连接 | 逐字忠实度实测 100%，但语速 4.0–4.4 字/秒、首块 629–781 ms、按输出 token 计费；只在显式 `--tts omni` 时用 |
| `agent.ts` | `VoiceAgent`：拼本轮输入 → 模型 → 剥情绪标签 → 清洗成可朗读文本 → 播报出口。`cleanForSpeech` 的实现在 `emotion.ts`，这里 `export { cleanForSpeech }` 再导出，兼容旧导入 | **人设提示词不在这里**，在 `mcp/profile.cordis.yml` 的 `personaPrefix`，由 dsh 当系统提示词注入（见 AGENTS.md）。清洗是必须的：TTS 会把 markdown 原样念出来。`cosyvoice.ts` 直接从 `emotion.ts` 取 `cleanForSpeech`，不再反向依赖 `agent.ts`。清洗还去掉两类**看不见**的脏东西：零宽字符及其 HTML 实体（`&#8203;` 字面送进去会被念成符号）、以及两个中日韩字符之间的空格（那不是停顿标记，只会让合成器塞一个假停顿；英文 / 数字 / 代码段两侧的空格有语义，不动） |
| `session.ts` | `DshSession`：把文本交给 agent 进程（NDJSON），续会话、取 usage、接住**自发轮次**。主轮相位是 `DshTurnPhase`（`idle` / `prompting_rpc` / `awaiting_idle` / `detached_running`），`isBusy()` 只看它。`procGen` 给每次 spawn 加一代，旧进程晚到的退出不能碰新进程。`openSessionId` 记住本进程已经打开的会话，同一个 id 只 `resume` 一次。`tailSwallow`（`none` / `awaiting_old_turn_start` / `awaiting_old_idle`）吞上一轮没有轮号的 `idle` 尾巴 | 单轮等待上限 60 s（`DEFAULT_TIMEOUT_MS`）；超出必须抛错**并说出来**，不许静默 |

### 2.5 决策层（纯逻辑）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `kernel.ts` | **判定层**：`step(state, event) → [state, effects]` 的纯 Mealy 机，四个正交区域（input/dialog/playback/ledger）。`step()` 只做因果屏障、吸收态守门与按区域路由，真正的转移拆在 `stepInput` / `stepPlayback` / `stepDialog` 三个窄函数里（每个只读自己那一区）。相位、听到多少、少听没少听、回注口气（`inject: 'spoken' \| 'unspoken' \| 'none'`）都在这里；**唯一的因果屏障** `isPreTurnCommit` 也从这里导出 | `KernelState` / `KernelEvent` / `Effect` / `SettlementInject` / `step` / `reduceKernel` / `isPreTurnCommit` |
| `kernel-runtime.ts` | 内核解释器：持有**唯一一份** `KernelState`，把 `Effect` 翻译成动作（端口由装配层注入）。`DialogRuntime` 用 `attachPorts()` 绑好生产 `KernelPorts`；`DialogFsm` / `TurnRunner` 的所有事件都走 `dispatchAndApply()`，4 种内核意图（`stopDeviceAudio` / `invalidateTurn` / `abortEngine` / `settleTurn`）**只执行一次** | `KernelRuntime` / `KernelPorts` / `KernelSettlement` / `applyEffects` |
| `dialog-fsm.ts` | **薄门面**：把方法调用翻译成 `KernelEvent`、只读 `runtime.state.dialog`；不再自己持有 `turn` / `gen` | `DialogFsm` / `TurnTicket` / `DialogState` |
| `causal.ts` | 逻辑因果屏障：旧段 vs 新话、票据过期。**一秒都不看表**，只比序号 | `isPreTurnSegment` / `isStaleTicket` |
| `turn-router.ts` | 路由：`routeTurn(text, ctx)` 判这一轮**先由谁答**（`live` / `cascade` / `dsh`）。判据与引擎实现无关 | `routeTurn` / `Lane` / `isCancelRequest` |
| `conversation-ledger.ts` | 对话账本：只记**已经结束**的轮次（谁答的、少听没少听），路由的话题粘性与回注都读它。结算由 `KernelPorts.settleTurn` 把后验的 `truncated` 与 `endedAtMs` 按**精确的** `{no, gen}` 票据回写（`reconcileOutcome`）；`DialogRuntime` 建连时用 `agent.lastLedgerLane()` 播种 `initialKernelState` 的 `lastLane` —— 重连也不丢「上一轮谁答的」 | `ConversationLedger` / `LedgerTurn` |
| `session-core.ts` | 事件 → 效果：收听 / 识图 / 自助结束 / 挂断都在这里判。插话的 `audio.stop` / `invalidateTurn` / `abortEngine` **不再由这里发** —— 内核在 `bargeIn` 上声明、经 `KernelPorts` 执行唯一一份；`commitSeq` 从这里一路传进 `kernel.ts::isPreTurnCommit`（定稿与中间结果共用同一个谓词） | `SessionCore` / `CoreEvent` / `CoreEffect` |
| `emotion.ts` | 情绪标签 → 规范化 key → TTS 风格串。`cleanForSpeech` 定义在这里，打断早先 `cosyvoice → agent` 的反向依赖；`agent.ts` 再导出同名，旧导入不用改 | `EMOTION_LABELS`（标签的单一事实来源）/ `parseEmotion` / `asEmotion` / `cleanForSpeech` |
| `engine-contract.ts` | 四层类型契约。`FastVoiceEngine.respond()` 是 `TurnRunner` 的唯一出话泵；`live` 与 `cascade` 只在这个接口后面不同 | `AudioFrame` / `AsrSyncState` / `TurnInput` / `TurnOutcome` / `outcomeOf` / `FastVoiceEngine` / `EngineEvent` |
| `voice-config.ts` | CLI、Web 插件、评测沙盒共用的语音运行时配置。纯函数：只读传入的 `env`，不碰 `process.env` | `buildVoiceRuntimeConfig` / `resolveOmniApiKey` / `DEFAULT_IMAGE_QUESTION`。三个入口是 `src/main.ts`、`packages/dsh-voice-web/src/driver.ts`（同步副本 `./voice/voice-config.ts`）、`bench/eval/server.ts`。`qwen-realtime` 且 `QWEN_ASR_TURN_DETECTION` 不是 `vad` 时才由客户端封段；设成 `vad`，或 STT 不是 `qwen-realtime`，就把 `commitMs` / `sttCommitMs` 收成 0，并且不传 `openQuietMs` / `openQuietShortMs`（`VOICE_COMMIT_MS` / `VOICE_STT_COMMIT_MS` / `VOICE_OPEN_QUIET_MS` 不再生效），避免客户端再 `commit()` 和服务器 VAD 各切一次。`resolveOmniApiKey`：`OMNI_API_KEY` 优先，否则 `DASHSCOPE_API_KEY`，只含空白当没配 |
| `pipeline-mode.ts` | 启动期主管道选择。纯函数：不读 `process.env`、不做 IO。装配层把环境收成 `ResolvePipelineInput` 再进来；`resolveVoicePipelineFromEnv` 只看调用方传入的 `env` | `VoicePipelineMode`（`'live' \| 'cascade'`）/ `PipelinePlan` / `resolveVoicePipeline` / `resolveVoicePipelineFromEnv`。显式 `VOICE_PIPELINE` 优先，别的字符串直接抛错。没写时：`OMNI_SHADOW=1` 且 `OMNI_ANSWER` 不是 `off` 推断为 `live`，否则 `cascade`。`live` 且 `strict !== false`：omni key（`resolveOmniApiKey`：`OMNI_API_KEY`，否则 `DASHSCOPE_API_KEY`）为空就抛错；传了 `sttName` 且不是 `qwen-realtime` 也抛错。`live` 计划里 `useOmniPlayback` 为 true、`useCascadeFastLane` 为 false、`cascadeKey` 为空；若快车道 key 还在且没被 `FAST_LANE=0` 关掉，`notes` 记一行「不加载文本级联」。`cascade` 计划里 `useOmniPlayback` 为 false；显式 cascade 且影子开着、answer 不是 `off` 时，`notes` 记一行「忽略 `OMNI_ANSWER`，不接管发声」。`useOmniProbeOnly`：影子开、answer 为 `off`、omni key 非空、STT 未指定或是 `qwen-realtime`。`useCascadeFastLane`：`FAST_LANE` 不是 `0` 且快车道 key（`FAST_LANE_API_KEY ?? DEEPSEEK_API_KEY`）非空 |
| `persona.ts` | 代码层短人设唯一导出源，与 `mcp/profile.cordis.yml` 的 `personaPrefix` 分工。omni 用 `OMNI_SHORT_INSTRUCTIONS`；级联快车道用 `FAST_LANE_PERSONA_HEADER`；Pure Live 的后台注记与空窗提示用 `LIVE_BACKEND_TASK_DIRECTIVE` / `buildLiveReportPrompt` | `PERSONA_NAME` / `OMNI_SHORT_INSTRUCTIONS` / `FAST_LANE_PERSONA_HEADER` / `LIVE_BACKEND_TASK_DIRECTIVE` / `buildLiveReportPrompt` |
| `providers.ts` | `SttProvider` / `TtsProvider` / `AgentProvider` 三个契约 + 测试替身 | `cannedStt` / `silentTts` / `echoAgent` |

`SessionCore` 的输入事件产出 **6 种效果**，效果由编排层执行：

```text
效果            含义
assemble        把文本交给一轮（含旁听反馈 / 唤醒词过滤之后）
turn            开跑一轮（携带票据）
capture         要一张图（CaptureRequest: id + intent + needsUser），进"等图"相位
call            一个设备操作（capture.cancel / listen.stop / 取消拍照时停掉提示音 audio.stop）
end             说完了就挂断
drop            丢弃这句话（纯噪声）
```

> **插话那一路的 `audio.stop` 不在这 6 种里**：它由内核在 `bargeIn` 上以
> `stopDeviceAudio` 意图声明，经 `KernelPorts` 执行 —— `SessionCore` 不再另发一份
> `call:audio.stop`（否则同一次插话会发两遍）。谁执行、执行几次，见 §2.5 的
> `kernel-runtime.ts` 与下文 §2.6 的热路径边界。

判定核只产出 `DeviceCall`；`stop` / `stop_capture` / `take_photo_hq` 这些
**v1 字符串只存在于 `wire-v1.ts` 的翻译里**，业务层不再直接拼控制串。

### 2.6 执行层

| 文件 | 职责 | 关键点 |
|---|---|---|
| `turn-runner.ts` | 跑完一轮。`run()` 只消费 `FastVoiceEngine.respond()`：按 `EngineEvent` 下发、埋点，把事实（`audioSent` / `devicePlayed` / `ticketInvalidated` / `turnEnded`）喂给共享内核。**它不算账**，结算数字与「该不该回注」都取内核的 `settleTurn` 意图 | 构造时收下 `engine`；没给则用 `AgentEngineAdapter` 把 `{ agent, tts }` 收成同一条 `respond()`，因此 `run()` 里只有一条泵。旁白 `speakCanned` 与实时音频 `speakAudioAnswer` 共用 `canned` 取消令牌、`cannedResidue` 和 `speechChain`：`cancelCanned()` 对两条路径同一套掐断与半句残句（一个字都没发出去不记残句）。延迟埋点（`tts.first` / `turn.end` 的 `dsh_ms` / `audio_s`）留在本类，引擎只报 `meta` 事实。委派短回执走 `speakReceipt`（文案缓存；进 `speaking` / `receiptOnly`，真答案首块一到即顶掉并 `audio.stop`） |
| `engines/live-voice-engine.ts` | Live 引擎：把 `FastLaneAudioLane`（生产是 `OmniShadow`）适配成 `FastVoiceEngine`。车道能服务时，`LiveOrchestrator.playLive` 把这一轮交给它的 `respond()` | 转发上行帧、把 `claim()` 的活流包成 `EngineEvent`、按内核放弃在途投机。`claim()` 拿到的是活流，等下一块必须和中止信号赛跑。取消确认、识图短回执、断线兜底不走这一层，由编排层自己合成。`mode` 为 `'live'` |
| `engines/cascade-voice-engine.ts` | 端口版级联引擎。`ask` 的增量一出来就送 `synthesizeStream`（首包与模型生成重叠）；流式失败、或一个音频块都没有但清洗后的 `speech` 非空时，退回整段 `synthesize` | 只依赖四个端口（问 / 合成 / 转发上行 / 报告放弃投机），不 import 具体 agent。与 `CascadeAgent.toEngine()` 同一份 `FastVoiceEngine` 契约。`mode` 为 `'cascade'` |
| `engines/agent-engine-adapter.ts` | 调用方没注入引擎时，把现有 `AgentProvider` + `TtsProvider` 收成一条 `FastVoiceEngine` 事件流。`TurnRunner` 在构造函数里包这一层 | `mode` 固定 `'cascade'`（「问 agent 再出音频」的泵）；某一轮实际走了 omni 直出时，路径写在 `meta.path` 上。带图不问 `willServeAudio`、omni 轮事先不开流式 TTS、流式失败退回整段、多步增量用 `spokenFromStream` 对账、omni 转交 dsh 时垫话留住，都收在 `respond()` 里 |
| `engines/stream-utils.ts` | 流式引擎的公共件。Live / Cascade / 适配器以前各抄一份队列、中止门和「念出去的全文」 | `EventQueue`（文本和音频同一条到达顺序）/ `createAbortGate`（已中止立刻兑现且不挂监听；调用方在 `finally` 里 `cancel()` 摘掉监听）/ `spokenFromStream`（按全部增量剥情绪标签再 `cleanForSpeech`；多步时不能只拿最后一步的 `reply.speech`） |
| `pipelines/live-orchestrator.ts` | `VOICE_PIPELINE=live` 的唯一前台。热路径是 `toEngine()`（`mode: 'live'`）：omni 一副嗓子；`reply()` 留给保活和无音频调用方 | 工具调用、识图、早规则、静默记忆进 `BackgroundTaskBus`；dsh 自己的 `run_in_background` / 子代理经 `ingestExternalAnnouncement` 进同一条总线。空窗 `speakBackgroundReport`：`verbatim` 返回 `'fallback'`；车道缺失或没有 `speakFromText` 也是 `'fallback'`；`canSpeakBackground()` 为假或 `speakFromText` 返回 null 则 `'defer'`；开口后 0 字节且不是被打断，同样 `'fallback'`。能说则把 `buildLiveReportPrompt` 交给 `speakFromText`，音频由调用方的 `playAudio`（生产是 `TurnRunner.speakAudioAnswer`）播出。用户先开口、空窗还没到时，`flushUnspoken` 按 `'unspoken'` 回注，每个任务只注一次。omni 接不上（没车道，或 `willServe()` 为假）时才同步问 dsh，再用本层 TTS 把那句说出来。插话只停前台这一句，不取消已经答应的后台任务；显式「别查了」才 `cancelAll` |
| `background-task-bus.ts` | Pure Live 的后台任务总线。`dispatch` 收本轮交给 dsh 的查询，`ingestExternalAnnouncement` 收 dsh 自己跑完的播报，两条路都收成 `BackgroundTaskReport`，由唯一前台决定什么时候说 | 来源：`tool_call` / `early_rule` / `image` / `memory_silent` / `dsh_background`。工人循环一次只跑一个 `runner.execute`；循环晚一个微任务才取队列，同一同步回合里先到的 `early_rule` 和后到的 `tool_call` 合成一次调用。状态只许 `queued → running \| cancelled`、`running → completed \| failed \| cancelled`。终态之后 runner 才回来的结果丢掉。`memory_silent` 与 `silent: true` 不播报；`cancelAll` 默认也不动它们。队列上限默认 16（只数还在排队的）。同一 `turnNo` 的要播报任务去重，排队中的 `tool_call` 可以升级查询。端口、订单号、代码路径、`[VERBATIM]`、超长正文走 `verbatim`（`summary` 截到 160 个码点，全文在 `verbatim`）。`dispose` 停掉还往这条连接上送的汇报并 abort 信号，不调用 `cancelRunning`：在途 dsh 可以自己跑完，结果留给离线补播 |
| `pipelines/cascade-agent.ts` | `VOICE_PIPELINE=cascade` 的唯一 agent。热路径是 `toEngine(tts)`：`reply()` 的文本增量直接送 `tts.synthesizeStream`，流式失败再退回整段 `synthesize`；没有 `synthesizeStream` 时用 `SentencePump` 逐句合成 | `FastLlmClient`（对冲、两段超时、`[[DELEGATE]]` 早退）+ `PrefetchSlot`（定稿前预跑与中间结果投机）+ dsh 投机（快模型与 dsh 同时起跑，快车道赢了就按 `cancelMode` 取消在途那一轮）。`routeTurn` 的 `live` 恒为 `'off'`，类上没有 `attachAudioLane` / `willServeAudio` / `speakFromText` 这一组方法。短闲聊走快模型，其余交给内层 dsh。`AbortSignal` 立刻停流并 `cancelTurn` + `dropPrefetch('barge_in')` |
| `fronted-agent.ts` | 把级联文本和 omni 车道收在同一个 `AgentProvider` 装饰器里：`willServeAudio()` / `reply()` 都问 `routeTurn()`，认领 omni、投机双轨、记账 | 扁平主管道按启动期拆开，会话内只装其中一条：`live` 用 `LiveOrchestrator`，`cascade` 用 `CascadeAgent` |
| `fast-llm-client.ts` | 文本快车道请求端（HTTP 对冲 / 首字与整句两段超时 / SSE 暗号 `[[DELEGATE]]` 早退） | `CascadeAgent` 的快模型客户端 |
| `prefetch-slot.ts` | 判停前预跑与中间结果投机的单槽，以及 `acceptsSpeculation` 认领闸 | `CascadeAgent` 在定稿前与中间结果上共用这一槽 |
| `omni-shadow.ts` | omni 音频直出车道的传输 / 段 / 车道三层实现（同文件分节）。`VOICE_PIPELINE=live` 时挂上并发声；`cascade` 且 answer 为 `off` 时可以只做测速影子（`serve: 'off'`，`start()` 照跑，不挂车道） | `willServe` / `claim` / `discard` / `injectAnswer` / `speakFromText` / `canSpeakBackground` / `cancelBackgroundSpeech`。`speakFromText` 只在服务端没有在途 response、本地也没有未提交用户音频时开口，否则返回 null。三条硬约束见 [`OMNI-LANE.md`](OMNI-LANE.md) |
| `interrupted-tail.ts` | 按**已播时长**切出「被打断、没说出口」的那一段，交给下一轮当上下文 | 速率是标定值（实测 4.8 字/秒），切点优先落回上一处标点；一次性，隔一轮就丢 |
| `photo-inbox.ts` | 「请设备拍一张」变成可等待 / 可超时 / 可取消的请求（见 §4.3） | 两种使用者：工具口等人取图；设备自己按快门时没人等就转成一轮识图 |
| `spontaneous.ts` | 判定**没人催的轮次**（后台作业结算后自己开的一轮） | 有等待者的轮次不算；只认 `running → idle` 且没有 prompt 在飞 |

> **出话热路径：一条泵**
>
> `TurnRunner.run()` 只 `for await` `FastVoiceEngine.respond()`。垫话、流式失败退回整段、
> 双轨投机都在对应的引擎与管道里。逐轮延迟埋点（`tts.first` / `turn.end` 的
> `dsh_ms` / `audio_s`）留在 `TurnRunner`：引擎用 `meta` 报事实，记账与结算不进引擎。
> `tests/fast-voice-engine.test.ts` 按契约验过 `LiveVoiceEngine` 与 `CascadeVoiceEngine`
> 的事件同构。
>
> | 启动期 | 注入的 `FastVoiceEngine` | 出声 |
> |---|---|---|
> | `VOICE_PIPELINE=live` | `LiveOrchestrator.toEngine()`（`mode: 'live'`）。对话音频经 `LiveVoiceEngine` 认领 `OmniShadow` | Omni 直出。后台结论在 `DialogRuntime.flushAnnounce` 的空窗（相位 `listening`，且距上次人声 ≥ `ANNOUNCE_QUIET_MS` = 800 ms）经 `speakFromText` → `speakAudioAnswer`。`verbatim`、没有 `speakFromText`、或开口后 0 字节且未被打断，返回 `'fallback'`，改走 `speakCanned`，念完再 `injectAnswer(..., 'spoken')`。车道正忙或 `speakFromText` 返回 null 则 `'defer'`，排回队首等下一个空窗 |
> | `VOICE_PIPELINE=cascade` | `CascadeAgent.toEngine(tts)`（内部 `CascadeTurnEngine`，`mode: 'cascade'`） | `FastLlmClient` 的增量与 CosyVoice `synthesizeStream` 重叠。流式抛错退回 `synthesize(reply.speech, reply.emotion)`。这条管道的 `routeTurn({ live: 'off' })`，不挂 Omni 发声 |
> | 调用方没给 `engine` | `TurnRunner` 自己 `new AgentEngineAdapter({ agent, tts, ... })` | 同一条 `respond()`。模拟器与只传 `{ agent, tts }` 的装配走这里 |
>
> 内核端口 `abortEngine`：`DialogRuntime` 在 `engine` 在场时只调
> `engine.abortSpeculation`（cascade 内部 `dropPrefetch`，live 内部 `abortLane`），
> 同一次中止不打到 agent 上第二遍。引擎缺席时才落到 `agent.dropPrefetch`。
>
> 确定性内核（`kernel.ts`）+ 端口执行（`KernelRuntime.attachPorts` /
> `dispatchAndApply`）、唯一因果屏障（`isPreTurnCommit` + `commitSeq` 透传）、
> 账本同源回写（`settleTurn` → `reconcileTurnOutcome`）与这一条泵在同一条热路径上。
> 「换引擎零改内核」靠的就是 `FastVoiceEngine`：两条管道只在 `respond()` 后面不同。

> **主对话不再跑命令，慢活全在子代理里。**
> `mcp/camera.yml` 把 bash / job / 文件读写 / 搜索遍历 / 工作流这些工具从主对话
> **整个关掉**，子代理挂 `preset-voice-deep`（`dsh-agent-preset`）拿回全套。
> 主对话只剩报时间/天气/股价、搜资料、拍照、挂断、派人、叫停 —— 语音是同步的，
> 主对话一被占住就等于失聪，所以「当场拿不到结果」的活根本不该由它开头。
> 子代理的 bash 走根组合的 `bash-sandbox`（base 默认 60 s），派出去时主对话说一句
> 「我去办」就结束这一轮，跑完 dsh 自己开新一轮汇报。
> 所以**不要**在应用层用关键词猜"用户是不是在问进度"：那种匹配既漏（「你查好了吗」）
> 又误伤（「退一下」被当成在查东西），真机已经踩过两次。

### 2.7 旁路与运维

| 文件 | 职责 | 语义 |
|---|---|---|
| `archive.ts` | 一条连接一个目录：`meta.json` / `events.jsonl` / `uplink.sbc` / `uplink.pcm` / `downlink.pcm` | 事件带三路字节偏移；`writeSync` 落盘，进程被中断也不丢已收字节 |
| `announce-store.ts` | 离线待补播队列（JSONL，上限 20） | **至少一次**：`drain()` 即取走，崩溃在播放中途会重播一句（重复比丢好） |
| `tool-control.ts` | 本机 HTTP 控制口（`127.0.0.1`），给 MCP 工具进程回调 | **进程/服务级常驻**：一个进程只开一个控制口，设备重连只 `setHandlers` 热切换（带所有权令牌，旧连接的迟到断开摘不掉新连接）；`close()` 只在进程退出时调，且必须 `closeAllConnections()` |
| `scripts/calibrate.ts` · `legacy-pipeline.ts` | 阈值标定脚本、旧的回放链路（silero-vad + MiMo） | `calibrate` 已从 `src/` 迁到 `scripts/`；`legacy-pipeline` 只在 `--replay` / 无 `--stt` 的旧监听分支里**按需 `await import()`** —— 生产 `--stt` 启动的依赖图里没有 `onnxruntime-node` / silero-vad |
| `latency-report.ts` | **纯函数**：`events.jsonl` → 逐轮「用户说完 → 听到第一个字」分解（①判停+ASR / ②排队 / ③agent+TTS / ④播放） | 分段口径写在文件头；`null` 表示缺仪表而**不是 0**，且逐轮记下缺哪个时刻（`missing`）——缺 `tts.first` 多半是旧档案，缺 `gate.close` 多半是主动播报 |

延迟分解依赖时间线仪表：`gate.close`（停嘴）、`asr.sentence`（定稿）、`tts.first`（首块）、
`turn.end`（收尾，失败也写并带 `failed: true`）。它们经 `TurnRunnerOptions.onEvent` 注入，
`voice-session` 把它接到 `archive.event()` —— 传输层与 `TurnRunner` 都不认识档案。
缺仪表时记 `null`，**不拿 0 冒充**（否则历史基线会被静默伪造）。

跑法：

```bash
node --experimental-strip-types scripts/latency-report.ts <会话目录>
node --experimental-strip-types scripts/observe.ts <会话目录>
```

---

## 3. 并发与生命周期

```text
Node 事件循环（单线程）
 ├─ 每条连接
 │    ├─ transport.Connection      帧解码/编码 + 空闲看门狗
 │    └─ VoiceConnection          编排对象，随连接生灭（含档案、回合票据、omni 车道）
 ├─ 服务级（随进程）
 │    └─ ToolControl              本机 HTTP 控制口，设备重连只热切换 handlers
 ├─ 子进程
 │    ├─ ffmpeg            每连接一个：mSBC → PCM16 16 kHz
 │    ├─ turn-judge(.py)   进程级常驻：判停概率
 │    └─ dsh               会话级常驻：NDJSON over stdin/stdout
 └─ 本机 HTTP：控制口 127.0.0.1:<port>（MCP 工具进程回调）
```

1. **单线程判定**：所有业务判断在事件循环里同步执行，没有锁，也没有跨线程共享状态；
   异步只出现在 I/O 边界（`await` TTS 流、`await` 一轮结束、`await` 子进程输出）。
2. **每连接一套对话对象**：换连接 = 换 `Connection` / `VoiceConnection` / 档案目录 /
   回合票据 / omni 车道，上一连接的尾巴不会混进下一连接。
3. **一条下行**：`TurnRunner.speechChain` 把"旁白"和"本轮回答"排队，避免两段 PCM 交织。
4. **故意同步的写**：`archive.ts` 用 `writeSync`。进程可能在任意时刻被 Ctrl-C 或
   被 OOM 杀掉，异步写会丢掉最后几秒 —— 而正是那几秒最需要。
5. **控制口是服务级、连接是单活**：一个进程只开一个 `ToolControl`；设备重连时用它
   的 `setHandlers` 热切换（**不重开端口**，否则 keep-alive 旧连接会占着端口导致
   `EADDRINUSE`，并把 `/say`、`take_photo` 路由给上一条已关闭的连接）。同一时间只
   服务一台设备：新连接握手完成就 `evict()` 旧的 —— 手机重启后旧连接常常还挂着，
   两条同时跑会让 ASR / TTS / 播报互相抢。
6. **子进程失败不重试**：`ffmpeg` 死了只影响这条连接的上行；实例在下一条连接重建。
   `turn-judge` 不可用时判停退回固定窗口；`dsh` 失败则这一轮报错（见 §6）。

---

## 4. 状态机

### 4.1 对话相位（`DialogFsm`）

```text
                 ┌──────────────▶ listening ◀──────────────┐
                 │                    │                    │
        一轮结束 / 被打断放弃            │ utterance           │ 等快门超时 / 拍完
                 │                    ▼                    │
                 │                thinking ──▶ speaking ────┤
                 │                    │             │      │
                 │          要看细节   │             │ 说完了│
                 │                    ▼             ▼      │
                 └──────────────── awaiting_shot ──▶ ending ┘
                                      │
                                 close() ──▶ closed（终态）
```

- 相位只有 6 个：`listening / awaiting_shot / thinking / speaking / ending / closed`。
  真相在 `kernel.ts` 的 `dialog` 区域；`DialogFsm` 只是它的**薄门面**（翻译事件、
  读 `runtime.state.dialog`），自己不存第二份。
- `speaking` 的含义是**有声音在播**，不只是「答案的首块音频已下发」——委派轮那句回执
  （「我看看。」）也占这个相位（`receiptStarted()` / `receiptEnded()` 进出，内部用
  `receiptOnly` 区分，真答案首块一到就被顶掉）。否则用户听完回执再开口，会被当成
  同一句的下文合并、而不是插话。
- 每轮发一张票据 `TurnTicket{no, gen, baseCommitSeq?, startedAtMs?}`：`no` 判"还是不是
  这一轮"，`gen` 判"是否已被插话作废"，`baseCommitSeq` 是**开轮瞬间锁存的因果水位线**。
  打断只是**作废票据**，不靠布尔量四处透传 —— 这是把「五个互相牵制的布尔量」换成
  一个状态机的直接原因。
- `awaiting_shot` 是高清照独有的相位：这期间既不算"在听"也不算"在说"，
  所以插话、超时、取消各有明确落点。

### 4.2 上行闸门（`EnergyGate`）

```text
closed ──峰值越门──▶ open（推流 + 预卷补发 + hold 计时）
  ▲                    │
  └──hold 到期且静音────┘
```

三种事实（开着 / 该关 / 有预卷）必须同时正确，所以做成状态机而不是三个布尔量：
漏同步一次的表现是"门开着但没喂音频"，不崩，只是 ASR 一直不出字。

门限作用在**放大后**的波形上（`--gain` 与门限是同一个坐标系）。这条曾经踩过坑：
早期按放大前的电平算门限，增益开得越大、门限被同步抬高，小声说话照样推不开。

生产传 `voiceDebounceFrames: 2`：连续两块过门限才算有声，单帧尖峰不把 `silenceMs` 打回 0。
开门时的预卷是 `PrerollFrame`（同一条门限标好 `voiced`），下游直接喂，不再按能量重算。
`silenceMs` 是封段、投机、判停共用的那一份静音累计。

### 4.3 拍照（`PhotoInbox`）

```text
request({id, intent, needsUser}) ── capture ──▶ WAIT ◀── deliver(id, jpeg)：id 对上就交付
                                                  │
        capture.waiting{say} ── 照念提示（只一次） ┤
        capture.failed{code,say} ── 立刻收尾 ─────┤
        cancel() ── needsUser 时下发 capture.cancel ┤
        兜底超时（20 s / needsUser 40 s）── timeout ┘
```

收件箱只认原语和图的归属 id。分段计时（等设备建好通道 / 等用户按快门）是**设备侧**的事：
设备自己先超时并在 `capture.failed.say` 里说原因，插件只有一个兜底总时长。
**分叉点是意图上的 `needsUser`，不是第二个动词**：小米的 `detail` 为 true，
自报能力的雷鸟为 false；执行层看到的都只是一次 `capture`。

图属于哪个请求由线协议层判。v1 没有请求 id，`V1Session.image()` 按规则补，认领顺序
固定为「公告的高清 → 取消后的迟到图 → 在途 `glance` 的第一帧」：v1 按序处理命令，
旧请求的回图一定先于新请求到达，所以先认领旧请求的；宁可让新请求超时，也不把旧图当新图交。
`hq_image` 公告之后那一帧归 `detail`；在途的 `glance` 认领第一帧，**认领即结束**（一趟只回一帧）；
等快门期间相机顺手回的低清图不属于任何请求（收件箱吃掉）；取消 `detail` 后迟到的那一帧
归已作废的 id（同样吃掉，不回落成识图轮），这个残留会一直留到那一帧到达或设备报 `hq_failed`。

### 4.4 开麦相位（`MicPhase`，`voice-session.ts`）

一条连接的开麦相位是 `idle` → `watching`（宽限期内看设备是不是已经在采集）或
`opening`（`listen.start` 已经发出，等首帧）→ `open`（看到有效上行）→ `closed`。
只许 `VoiceConnection.enterMic` 迁移；`closed` 是吸收态。`listen.start` 只有字节
真的交出去才进 `opening`，发送失败不会把相位留在「正在开」。`listen.stop` 成功且
还在等首帧时，从 `opening` 回到 `idle`。

---

## 5. 数据流

### 5.1 线协议

```text
[type:u8][length:u32 LE][payload]
```

| 上行（手机 → 云端） | 值 | payload |
|---|---|---|
| Audio | 1 | `msbc` 原始字节，或设备在 `Hello.capabilities.audioIn` 自报 `pcm16` 后直接给 PCM16 16 kHz 单声道（不做二次编码） |
| Image | 2 | JPEG |
| Wake | 3 | 唤醒事件的 ID（诊断用） |
| Ping | 4 | 空；服务端回 Pong |
| Status | 5 | UTF-8 JSON 状态事件（`hq_armed` / `hq_image` / `hq_failed`） |
| Hello | 6 | 首帧身份：`{"proto":1\|2,"deviceId":…,"token":…,"capabilities":…}` |

| 下行（云端 → 手机） | 值 | payload |
|---|---|---|
| Audio | 1 | PCM16 24 kHz 单声道 |
| Control | 2 | UTF-8 控制串：`take_photo` / `take_photo_hq` / `hq_cancel` / `stop` / `stop_capture` / `auth_*` |
| Pong | 5 | 空 |

- **首帧必须是 `Hello`**：鉴权不通过就发一条 `auth_required` / `auth_failed` 控制串再断开。
- 空闲看门狗 45 s：这么久没收到**任何字节**就断开（手机侧有心跳，正常不会触发）。
- 单帧上限 32 MB，超了直接断：高清图约 1 MB，留两个数量级余量。

### 5.2 一次完整对话

```text
手机                    云端
 │  Audio（msbc / pcm16）▶│ frame ─▶ 解码 ─▶ 放大 ─▶ 能量门
 │                       │                                │ 越门
 │                       │                                ▼
 │                       │        utterance-assembler（TurnJudge 判停 + 静音四路触发）
 │                       │                                │ 定稿
 │                       │                                ▼
 │                       │      SessionCore → kernel.beginTurn（票据）→ TurnRunner
 │                       │                                │
 │                       │      单泵：engine.respond(TurnInput)
 │                       │        ├─ live     LiveOrchestrator
 │                       │        │             └─ LiveVoiceEngine → OmniShadow 直出
 │                       │        │             要办事：BackgroundTaskBus 异步交给 dsh
 │                       │        └─ cascade  CascadeAgent
 │                       │                    ├─ FastLlmClient（短闲聊，可与 dsh 投机）
 │                       │                    └─ 其余同步问 dsh
 │                       │                    文本增量 → CosyVoice synthesizeStream
 │                       │                                │ EngineEvent.audio
 │                       │                                ▼
 │  ◀──────── Audio ─────│              逐块下发，边收边放
 │                       │                                │
 │  （播完）              │        turnEnded → kernel 结算 → listening
 │                       │
 │                       │  live 后台结论（不占这一轮的票据）：
 │                       │    空窗 speakFromText → speakAudioAnswer
 │                       │    与 speakCanned 共用取消 / 残句 / speechChain
```

**现行语音栈**（启动期 `VOICE_PIPELINE` 二选一，会话内不混跑）：

| 层 | 选型 |
|---|---|
| 主管道 | `live`：`LiveOrchestrator` + `OmniShadow` 一副嗓子，dsh 经 `BackgroundTaskBus` 异步。`cascade`：`CascadeAgent`（`FastLlmClient` + `PrefetchSlot` + dsh 投机 + CosyVoice 流式），`routeTurn` 的 `live` 恒为 `'off'` |
| STT | `qwen-realtime`（默认端点由我们控，`turn_detection: null`；`QWEN_ASR_TURN_DETECTION=vad` 改由服务端判句，客户端封段旋钮见 `voice-config.ts`）或 `aliyun`（NLS）。`live` 要求 `--stt qwen-realtime` |
| TTS | `cosyvoice`（流式，系统音色）。`cascade` 的正文走它。`live` 的前台不走它；短回执、`verbatim` 回落、omni 断线兜底才用。`--tts omni` 是把 omni 当朗读机，只在显式指定时用 |
| 慢车道 | `dsh`（`DshSession`，headless 或 `--dsh-sdk`）。`live` 里异步、不占前台；`cascade` 里与快模型同时起跑，快车道赢了就取消在途那一轮 |

`--tts` 留空时代码回落到 `mimo`；那只是兜底，不是线上栈。

一次历史实测（`--stt aliyun --tts mimo --agent dsh`）：

```text
agent    3.28 s   续会话  tokens=205/52  cache=23168
TTS首块  1.04 s
回放     230400 字节  4.80 s
```

首块延迟是端到端体感的关键：TTS 边收边下发，所以"开始出声"只等首块，
不用等整段合成完。

### 5.3 打断与旁路

| 场景 | 路径 |
|---|---|
| 用户插话 | `voice-session.ts` 透传 `commitSeq` → `SessionCore` 经 `kernel.ts::isPreTurnCommit` 拦截开轮前旧段 → `DialogFsm.bargeIn(why, commitSeq)` → `KernelRuntime.dispatchAndApply()` 经 `DialogRuntime` 绑定的 `KernelPorts` 唯一执行 `stopDeviceAudio` + `invalidateTurn` + `abortEngine('barge_in')` + 当场 `settleTurn`（并按 `{no, gen}` 回写 `ConversationLedger`） |
| 系统旁白（"请按一下快门"） | `TurnRunner.speakCanned` —— **不属于任何一轮**，不改状态机，只借同一条下行。`speakAudioAnswer` 与它共用 `canned` 取消令牌、`cannedResidue`、`speechChain` |
| dsh 自发播报 | `SpontaneousTurn` 放行后走 `onAnnounce`。`live`：`LiveOrchestrator` 收进 `BackgroundTaskBus.ingestExternalAnnouncement`，再经 `setTaskReporter` 进空窗，`speakFromText` → `speakAudioAnswer`。`cascade`：`setAnnouncer` 原样转到内层，`enqueueAnnounce` → `speakCanned`。没连接进 `announce-store` |
| live 前台派出去的任务 | `BackgroundTaskBus.dispatch`（`early_rule` / `tool_call` / `image` / `memory_silent`）。要播报的完成后走同一条空窗。`memory_silent` 写完不播。用户说「别查了」只取消要播报的任务 |
| 离线补播 | 下一条连接 `start()` 时 `drain()`，播完即取走 |
| 原始档案 | 上行原始字节 / 放大前 PCM / 下行 PCM / 事件时间线同时写入，事后可完整重放 |

### 5.4 双轨投机的撤回（快车道赢了，但 dsh 已经答完）

这一节是 `VOICE_PIPELINE=cascade`：`CascadeAgent` 让快模型与 dsh 同时起跑，快车道赢了就把已经写进 dsh 会话的那一轮收回去。`live` 不跑这套双轨。dsh 在 `BackgroundTaskBus` 里排队，结论等空窗由 omni 说。

双轨是「快车道答、dsh 同时起跑」。快车道赢了就 `session/cancel` 掐掉 dsh 那一轮 ——
但取消有竞态：dsh 只要 0.6–0.9 s，判停延拍把快车道拖到 950 ms 时它**已经答完**，
`assistant/message` 就永久留在 dsh 的会话历史里（3 天实测 23 次取消里 12 次是这样）。

用户听到的是快车道的答案，所以那一轮对 dsh 来说是**幽灵**：下一次续会话它会以为
「我答过这句」，而我们补上下文时还会给出另一个答案。

dsh 的会话日志是 **append-only**，事件词表里没有任何回退/截断类型（见
`dsh-session/known-event-types.js`），唯一能让历史变短的公开原语是 **`session/fork`**：
从某个 seq 切一段前缀长出一个新会话。做法：

| 步 | 做什么 |
|---|---|
| 1 | 快车道 `commit()` 时盯住输掉的 dsh promise；**resolve**（答完了）才记撤回，reject（被取消了）什么都不用做 |
| 2 | 切点 = 那一轮 `turn/start` **之前**那条 `agent/inbox/spliced`（把话塞进收件箱）的 seq − 1。切在 `turn/start − 1` 会把这句话复制进新会话的收件箱、被**重放一遍**（探针实测：幽灵句出现 2 次） |
| 3 | 下一轮 `askSdk` 发 prompt **之前**调 `session/fork`，拿到新 session id → 换指针 + 写进 `session.json`。不占热路径，也不和正在跑的轮次交叉 |
| 4 | 连续多轮只留**最早**那个切点，fork 一次全退掉；票据对不上（迟到 resolve）直接丢弃 |

`session/fork` 不在 SDK 的 RPC 表里（只有 cancel/prompt/resume/wait），靠
`scripts/patch-sdk-fork.mjs` 补进去 —— **升级 dsh 之后 cancel/fork 两个补丁都要重跑**，
启动日志里各有一行探针会告诉你还在不在（`取消 … 可用` / `回溯 … 可用`）。

失败不抛：撤回是锦上添花，fork 不可用就照旧续原会话（历史里多一条幽灵轮，
用户听到的东西不受影响）。**但失败时上下文会自相矛盾**（dsh 历史里有它的答案、
补上下文又给另一个），所以失败那一轮要把话说明白：补上下文的前缀从
「没有经过你的会话」换成「你已经答完了，但用户没听到你的回答」。

### 5.5 透明化会话的生命周期

fork 之后**旧会话还在磁盘上**（`~/.dsh/sessions/<workspace>/<id>`，我们只是不再引用它）。
留 7 天再删 —— 万一切点或 fork 出了问题，它是唯一能回看的现场。

| 时机 | 动作 |
|---|---|
| fork 成功 | 把旧会话记进 `<会话指针同目录>/superseded.jsonl`，顺手做一次过期清理 |
| harness 启动 | 再清一次 |

**不做定时器**：清理挂在「启动」和「每次 fork 之后」这两个本来就会发生的事件上 ——
少一个进程、少一份状态。代价是常年不重启又从不 fork 的机器不会清，但那种机器也不会
产生新的待清理项。

删之前三重校验：路径必须在 `~/.dsh/sessions/` 下、目录名必须正好是那个 session id、
**正在用的 id 绝不删**。清单里的坏记录（缺字段 / 越界路径 / 目录名不符）直接丢弃 ——
一条坏行不该指向一次 `rm -rf`。

---

## 6. 错误模型

| 级别 | 例子 | 处理 |
|---|---|---|
| 连接级 | 鉴权失败、空闲 45 s、单帧超 32 MB | 发控制串后断开；不影响其它连接 |
| 回合级 | agent 一轮超过 60 s、清洗后可朗读内容为空 | 抛错并由编排层**说出来**（"我这轮没跑完"），不许静默 |
| 能力级 | 拍照失败（`CaptureErrorCode` 五个值：`unsupported` / `busy` / `timeout` / `cancelled` / `failed`）、STT 无结果 | 变成一句人话或一次明确的工具错误码 |
| 实现级 | TTS HTTP 非 2xx、SSE 断流、`ffmpeg` 退出 | 记日志；该段能力本轮失效，连接继续 |

三条硬规则：

1. **超时要说出来**。早期实现里超时只打一行日志，用户听到的是彻底安静 ——
   和"没听见"无法区分。现在超时必须产出一句话。
2. **状态帧坏掉不能断连接**。`Status` 帧 JSON 解析失败只记日志（否则一次脏字节会踢掉整条会话）。
3. **重试只在一处**。连接重试由手机侧负责；云端不做重连，一条连接就是一条连接。

---

## 7. 对外三个面

### 7.1 命令行与环境变量

```bash
node src/main.ts --listen 8766 --stt qwen-realtime --tts cosyvoice --agent dsh
node src/main.ts --replay ../tmp/voice.sbc          # 离线回放一段 mSBC
```

可配 `--stt aliyun` 走 NLS，`--tts` 留空回落 `mimo`。

| 参数 | 作用 |
|---|---|
| `--listen` / `--host` / `--serve` | 监听端口 / 绑定地址（默认 `127.0.0.1`）/ 常驻：一条连接结束后继续等下一条（同一时间仍只服务一台设备，新连接接管时旧连接被主动断开） |
| `--stt` | `aliyun` / `qwen-realtime` / `canned`（回放固定一句）/ `noop` / `none` |
| `--tts` | `cosyvoice` / `omni` / `mimo` / `silent`（只算时长，不出声） |
| `--agent` | `dsh` / `echo` / `none`；`--dsh-sdk` 走 SDK 会话而不是 headless |
| `--replay` | 离线回放，不监听端口 |
| `--ffmpeg` / `--gap-ms` · `--sentence-silence` | 解码器路径 / 解帧间隔 / 判停静音阈值 |
| `--vocab-id` | 业务专属热词表 ID（POP API 建的那种）；控制台配的项目热词与 Appkey 绑定，无需此项 |
| `--work-dir` · `--ask-image` | agent 工作目录 · 单图提问 |

调优类几乎都有对应环境变量（`MIAI_*`：增益、电平表、档案、补播、TTS 音色与风格、
两段超时、空闲上限、鉴权 token 表）。主管道是 `VOICE_PIPELINE=live|cascade`
（`src/pipeline-mode.ts`，见 §1 与 §2.5）。没写这个变量时，按 `OMNI_SHADOW` 与
`OMNI_ANSWER` 推断。`FAST_LANE=0` 只关掉级联文本模型；`live` 计划里文本快车道本来就不加载。
增益、门限、判停、端点、超时和识图提问的默认值只有一处：`src/voice-config.ts` 的
`buildVoiceRuntimeConfig`（`src/main.ts`、Web 插件、`bench/eval/server.ts` 共用）。
`QWEN_ASR_TURN_DETECTION=vad` 时客户端 `commitMs` / `sttCommitMs` 为 0，开轮静音门槛不传。

### 7.2 控制口（HTTP，仅本机）

`ToolControl` 是服务级常驻（随服务启动建一次，设备重连时通过带所有权令牌的 `setHandlers` 热切换，不反复开关端口）。

| 路由 | 用途 |
|---|---|
| `POST /say` | 把一段文本当成用户输入（没有麦克风也能验证整条链） |
| `POST /control` | 原样下发一条控制串（调试用） |
| `POST /take_photo` / `POST /take_photo_hq` | 请求拍照并等图（低清 / 协作式高清） |
| `POST /end_session` | 说完这句就挂断 |

并发保护：同一时刻只允许一个拍照请求在途（第二个返回 409），请求带自己的超时。

### 7.3 MCP 工具（给 agent 用）

`mcp/` 下两个桥接进程把上面两个面包装成 agent 工具：`take_photo` / `take_photo_hq`
（相机）与 `end_session`（会话）。它们是 dsh spawn 的独立进程，只能通过控制口的 URL
与 harness 通信 —— 这也是控制口必须存在的原因。

---

## 8. 测试与持续集成

| 层 | 手段 |
|---|---|
| 部署运行时（`npm test`） | `node --test tests/*.test.ts`。`tests/deploy-boundary.test.ts` 守边界：这些测试只能引用部署清单里的路径（`src`、`mcp`、`tools`、`tests`、`turn_judge`、`scripts`，以及 `package.json` / `tsconfig.json` / `README.md` / `docs/TIME-KNOBS.md`）。`bench/` 与 `packages/` 不在清单里 |
| 全量（`npm run test:all`） | `npm test`，再加 `npm run test:bench`（`bench/eval/*.test.ts`、`bench/replay/*.test.ts`）和 `npm run test:web` |
| 端到端（无真机） | `tools/fake-phone.ts`：假手机，可发 mSBC、收下行、按剧本触发高清照三条分支 |
| 类型安全 | `tsc --noEmit` + **strip-only 语法检查**：Node 的类型擦除不支持参数属性这类写法，`tsc` 查不出，必须静态挑一遍 |
| 启动自检 | 无参数跑 `node src/main.ts` 应当打印用法并以 2 退出 —— 用它当"整张依赖图能加载"的冒烟 |
| 跨端常量 | 控制串 / 状态帧事件 / 失败原因 / 帧类型 / 下行采样率都与手机侧做**双方源码比对**，改一边忘另一边会红 |
| 导出 | 导出树再跑一次构建与加载，且敏感值扫描必须零命中 |

---

## 9. 明确没做的

1. **多租户**：一个进程只服务一台设备（单活：新连接接管时旧连接被主动断开），
   控制口是服务级、随连接热切换 handlers；没有 token 之外的租户隔离。
2. **云端重连**：断开就是断开，重连是手机侧的事。
3. **会话状态持久化**：只有 agent 自己的 session id 与待补播队列落盘，对话相位不落盘 ——
   进程重启后是"一条新连接"，不是"接着上次"。
4. **用户 / 权限模型**：鉴权 token 表**已支持热更新**（`TokenGate` 每次比对前重读文件，
   改完不用重启），但只有"这台的 token 对不对"，没有角色、配额、审计。
5. **上行不做重采样 / 转码**：`msbc` 交 `ffmpeg` 解码，`pcm16` 直接收；手机必须按
   `Hello.capabilities.audioIn` 自报的能力原样转发设备的字节。
6. **判停依赖侧车**：想用 TurnJudge 就得有 Python 与模型文件；不想装就用固定窗口，
   代价是判停更钝。
7. **不支持多路并发下行**：一条连接一条音频流；单活接管意味着两台手机同时连时，
   只有后连的那台在服务。
8. **没有端到端加密之外的私有协议**：就是 TLS/TCP + 明文帧，安全边界完全靠 TLS 与 token。
