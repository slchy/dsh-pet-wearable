# 协作约定

## 开工先读运维记录（如果本机有的话）

**部署形态、密钥与环境变量在哪、设备怎么装 App、协议三层、bench 与生产怎么共存 ——
这些事实记在 `docs/OPS-RECORD.md`。**

那份文件**已经移出版本库并写进 `.gitignore`**：它含真实主机、证书与设备信息，
只作为**本机私有运维台账**存在。所以：

- 本机有这份文件 —— 先读它。里面是**核对过的事实清单**（末尾写了怎么重新核对），
  不是设计文档；
- 本机没有 —— 不要去找、也不要从别处猜，直接以 `src/` 与 `docs/` 的现行内容为准。

别靠上下文记忆：本项目多次出现「把 bench 的临时做法当历史协议」「以为密钥在本机」
这类错误，每次都浪费一轮。

## 生产级手段：先说，再动手

**自动化 / 自愈 / 监控这类"生产级"的东西，加之前先讨论，不要直接实现。**

包括但不限于：

- 自动回滚、自动重试、自动降级、故障转移
- 健康检查端点、指标上报、告警规则
- 定时清理、备份策略、自动轮转

理由：这个项目基本是一个人维护，**代码越多维护量越大**。而"出事了手动处理一次"
经常比养一套自动化更便宜 —— 自动化的代价不只是写它的那几十行，还有它出错时要查的
新路径、它引入的新状态（备份目录、锁文件、幂等标记），以及半年后忘了它存在时的困惑。

具体流程：先说明它解决什么问题、不做的后果是什么、大概多少代码，由人决定值不值得。
**已经写好的不必拆**；新加的先问。

这是**软限制** —— 具体情况具体分析。真正会静默出错、且无法手动补救的地方
（比如"数据被覆盖了才知道"），该自动化还是要自动化，说清楚就行。

## 远程执行：脚本一律 Base64 传，不要内联引号/管道

**在 PowerShell 里给 `ssh` 拼内联命令是本项目最常见的自伤**：`|`、`>`、`"`、`'`、
`$`、中文标点会被本地 shell 先解析一遍，结果是「命令被拆成两半」「重定向跑到本地」
「bash 收到半截后一直等输入（ssh 挂着不动，看起来像远端卡死）」。

踩过三次：`grep -E "a|b"`、`sed -i "s#…#…#; s#…#…#"`、`$(ls | head -1)`，
每次都浪费十几分钟去查「是不是服务挂了」。

**做法**（本地拼 → Base64 → 远端解码执行）：

```powershell
$script = @'
pkill -f 8766
grep -nE 'TTS|流式' /tmp/x.log | head -5
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
ssh -i $k user@host "echo $b64 | base64 -d | bash -s"
```

要点：

- Base64 只含 `A-Za-z0-9+/=`，**本地和远端都不会再解析任何符号**，引号/管道/中文随便写
- 长脚本照此办理；需要参数的用 `bash -s -- arg1 arg2`
- 密码学意义上这不是加密，只是**免转义**：不要把密钥塞进命令行（那会进 shell 历史与进程列表）
- 判断「远端卡死」前先看是不是本地命令没拼对：`ssh` 立刻返回 `command not found`
  并跟着一串「半截命令」就是这类问题

## 人设提示词只有一份

**改「米馍」的身份、性格、说话方式、干活策略 —— 去 [mcp/profile.cordis.yml](mcp/profile.cordis.yml)
的 `personaPrefix`，不要在 `src/agent.ts` 里加。**

理由：那份文件会被装成 `~/.dsh/profiles/sdk/cordis.patch.yml`，由 dsh 作为**系统提示词**
注入。放系统层比每轮拼进用户消息服从度更高，内容不变时还能稳定命中前缀缓存。
两份长文本迟早漂移，只留一份就没得漂。

- 本地改完要 `npm run install-profile`，否则跑的是没人设的通用 agent；
- 服务器安装脚本不在本公开仓（同步清单与 `tests/deploy-boundary.test.ts` 的允许路径一致）；
- 【情绪标签】那行的八个标签必须与 `src/emotion.ts` 的 `EMOTION_LABELS` 一致，
  `tests/profile-prompt.test.ts` 会卡住不一致。

### 代码层短人设也只写一份

全量系统人设是 `personaPrefix`；但快车道与 omni 这两条**不走 dsh 系统提示词**的
链路，各自只有一个 `instructions` 字段。它们的身份头统一从
[`src/persona.ts`](src/persona.ts) 导出（`PERSONA_NAME` / `OMNI_SHORT_INSTRUCTIONS` /
`FAST_LANE_PERSONA_HEADER`）。`LIVE_BACKEND_TASK_DIRECTIVE` 与 `buildLiveReportPrompt`
也住在同一份 [`src/persona.ts`](src/persona.ts) 里，跟这三个放在一起。
**不要在 `fronted-agent.ts` / `src/omni/shadow.ts` 里手写字面量**。Omni 短人设正文是
`persona.ts` 的 `OMNI_SHORT_INSTRUCTIONS`；唯一工具 `DELEGATE_TOOL` 在
[`src/omni/protocol.ts`](src/omni/protocol.ts)。[`src/omni-shadow.ts`](src/omni-shadow.ts)
只再导出 `OmniShadow`，里面没有第二份提示词。两处抄一份的下场是
「只改了一边，用户听出换了个人」—— 而代码不会报错。

`tests/profile-prompt.test.ts` 守着同源：名字、定位、身份措辞要能被同一个来源解释，
`personaPrefix` 里那八个标签也必须与 `EMOTION_LABELS` 对齐（快车道六种是刻意的既有
行为，见 `persona.ts` 注释，别顺手「修正」成八种）。

## 跨层数据要一路接到底

**一处产生、另一处需要的数据，中间每一层的签名都必须带上它。** 用可选字段
（`emotion?` / `percent?`）传这种数据时尤其小心：漏传**不会报错**，只会静默降级。

同一天里踩了三次，都是同一个形状：

| 数据 | 谁产生 | 在哪断掉 | 现场表现 |
|---|---|---|---|
| 情绪标签 | 模型回复开头 `[开心]` | `providers.ts` 的 `setAnnouncer` 只声明了 `speech` | 后台汇报永远平静语气 |
| 电量 / 佩戴 | 设备上行 `{"kind":"power","percent":77}` | 只喂给宠物环，`agent` 那条路上没有 | 问「眼镜还剩多少电」，答「读不到，没有接口」 |
| 情绪标签（离线） | 同上 | `announceStore` 只存 `text` | 离线攒的播报补播时又变回平静 |
| 「放手」的答复 | `DshSession.onDetachedAnswer` | `DshAgent` **根本没实现 `detachTurn()`**，而 `FrontedAgent` 写的是 `inner.detachTurn?.(ticket)` | 插话后委派轮跑完既没播报也没回注，日志里连一行都不出（上线以来一次没生效） |
| `voiced`（门控后的人声态） | 能量门 | `qwen-realtime-asr` 的 provider 包装写成 `feed:(pcm)=>asr.feed(pcm)` | 尾静音过滤上线一次没生效，幻觉定音照样入库 |

**可选能力的透传已经不再靠手抄**：`src/keepalive.ts` 的 `trackActivity()` 用 `Proxy`
自动转发 `AgentProvider` 上的所有属性，只有 `reply` 被包一层记账 —— 以后新加的可选
方法（甚至运行时才挂上去的）都会自动透传。两条实现细节别改：`Reflect.get` 的第三参
必须是 `target`（私有字段的 getter 会在 receiver 上找不到槽），方法要 `.bind(target)`。

仍然要守的是**别的包装层**：任何自己实现 `AgentProvider` 再转发的模块，都得逐项透传。
`tests/wiring-floor-cancel.test.ts` 卡"生产装配真的接上了"这条。

排查套路：`grep` 数据名，把**每一个**出现点列出来，逐个问「这里是传进来了，还是只是
在这里定义 / 打印 / 存档」。只在定义处和终点出现、中间跳过的，就是断点。

## 判据放哪儿：三种时间 + 一个家

**全双工链路上的"灵异 bug"几乎都是把「物理到达时刻」当成了因果顺序。** 判据按性质选尺子：

- **因果**（打断算不算数、这份回答归谁）→ 只比序号：`commitSeq` / 票据 `{no, gen}`。
  唯一的家是 [`src/causal.ts`](src/causal.ts)。**一秒都不看表。**
- **播放进度**（听到多少、少听没少听）→ 只用媒体时间（字节 / 采样率）。
  唯一的家是 [`src/engine-contract.ts`](src/engine-contract.ts) 的 `outcomeOf()`。
- **超时**（等多久算超时、轮询间隔）→ 才用墙钟 `clock.now()`。

**同一件事不许有两个算法**：`TurnRunner` 曾经自己算一遍 `heard`/`truncated`，
与 `outcomeOf` 各一份，改一处就漂。现在它只喂事实（`audioSent` / `devicePlayed` /
`ticketInvalidated` / `turnEnded`），结算只取 [`src/kernel.ts`](src/kernel.ts) 的意图。

相位的家也在这里：`DialogFsm` 已收口成 [`src/kernel.ts`](src/kernel.ts) +
[`src/kernel-runtime.ts`](src/kernel-runtime.ts) 的**薄门面** —— 它只把方法调用翻译成
`KernelEvent`、只读 `runtime.state.dialog`，自己不再持有 `turn` / `gen`。回注口径
（`inject: 'spoken' | 'unspoken' | 'none'`）与因果屏障也唯一归口在 `kernel.ts`，
执行层照单执行，不许按 `audioBytes` 再判一遍。

- 内核 `Effect`（`stopDeviceAudio` / `invalidateTurn` / `abortEngine` / `settleTurn`）
  由 `DialogRuntime` 通过 `KernelRuntime.attachPorts()` + `dispatchAndApply()` 唯一执行，
  **不在 `SessionCore` 里另发一份 `call:audio.stop`**。
- 因果旧段拦截唯一归口在 `kernel.ts::isPreTurnCommit`（`commitSeq` 经 `SessionCore`
  一路传进 `bargeIn`），**不在 `voice-session.ts` 保留前置副本**（`fromPreTurnSegment` 已删）。
- `TurnRunner` 已收成**一条统一引擎泵**：`run()` 只消费 `FastVoiceEngine.respond`
  （`LiveVoiceEngine` / `CascadeVoiceEngine` / 旧装配兜底的 `AgentEngineAdapter`）。
  启动期用 `VOICE_PIPELINE=live | cascade` 显式二选一
  （[`src/pipeline-mode.ts`](src/pipeline-mode.ts)），会话内严格互斥 ——
  Pure Live 是 `LiveOrchestrator` + `BackgroundTaskBus`，Pure Cascade 是 `CascadeAgent`。
- 账本同源与 `step()` 结构：`KernelPorts.settleTurn` 按 `{no, gen}` 票据回写
  `FrontedAgent` 的 `ConversationLedger`（`reconcileTurnOutcome` / `reconcileOutcome`），
  重连由 `agent.lastLedgerLane()` 播种 `initialKernelState`；`kernel.ts` 的 `step()`
  已按区域拆为 `stepInput` / `stepPlayback` / `stepDialog`。

改判定先看 [ADR-0003](docs/adr/0003-deterministic-kernel.md) 与 `state-machines.md` §5.9。

## 示例不要用真实地址

**用法注释、文档示例、测试里不要出现真实的 IP / 主机名 / 服务器路径。**
用 `<服务器地址>`、`<部署路径>` 这类占位符。

仓库是公开的，这类东西一旦进去，清理就得改写历史 —— 而未推送的历史改写、
已推送的历史基本只能"承认它在"。

已经踩过：`tools/fake-v2-device.ts` 的用法示例里写过真实服务器 IP，
`scripts/probe-*.mjs` 里写过 `/home/<user>/...` 绝对路径。

## 优化之前先量噪声

**要优化的幅度常常比外部抖动还小。** 先说清楚代价：本项目为此白干过半天。

实测同一天内的外部变量：

| 变量 | 幅度 | 来源 |
|---|---|---|
| **负载类型** | **305 → 1700 ms（5 倍）** | 真机短问答 vs τ² 长答复+工具 |
| DeepSeek 首 token | **231–731 ms**（同一分钟重复 6 次） | 模型队列抖动 |
| ASR 出句（同一台真机） | 420 ↔ 571 ms | 场次间抖动 |
| TTS 首包（CosyVoice） | 旧口径 287–630 ms | 长文本更慢；**没有证据表明有昼夜规律** |

而我们要压的是 70–200 ms 级别的优化。**不比不知道，一比全是噪声。**

规则：

1. **动手前先做重复测量**：代码不变、10 分钟内、≥5 轮，得到这一时段的**噪声地板**。
   只有超过噪声地板的差异才算改动有效。
2. **A/B 必须同时段交替**（开/关穿插跑），不能"上午改完、晚上测一下"。
3. **判断能力变化看 `min`，判断典型体验看 `p50`**。`min` 几乎不受当时负载影响，
   是"服务端最好状态"的代理；`p50` 会被晚高峰整体推高。
4. **每次测量记录小时**。跨小时/跨天的数不并列比较，除非只比 `min`。
5. 上面那些数是**参考值不是常数**，换机器/换供应商/换区域都要重测。

一条命令拿到噪声地板（同一场里交替开关）：

```bash
# 例：流式 TTS 开/关各 5 轮，同时段
for i in 1 2 3 4 5; do
  TTS_STREAM=1 bash bench/tau2/bench-lat-run.sh 17_zh_identity 40
  TTS_STREAM=0 bash bench/tau2/bench-lat-run.sh 17_zh_identity 40
done
```

### 推论：只做结构性优化，不做参数微调

**外部 API 的抖动是固有属性**（GPU 排队、路由、批次合并），不要试图解释它，要绕过它。

实测对照：

| 组件 | 抖动 | 归属 |
|---|---|---|
| 判停（本地 ONNX） | 151 ↔ 152 ms | 自己机器，几乎不动 |
| DeepSeek 首 token | **231 ↔ 731 ms** | 别人的 GPU |
| ASR 出句 | 420 ↔ 571 ms | 别人的服务 |
| CosyVoice 首包 | 287 ↔ 630 ms | 别人的服务 |

所以值得做的只有两类：

1. **去掉一个等待相位** —— 例如流式合成：原来是「等整段 → 再合成」两个串行相位，
   改成「首个 token 就开始合成」，省下的是 `dsh_ms - TTFT` 这一段**结构性**时间（实测
   −216 ms），不是靠挤压某个 API 的响应。
2. **减少一次往返** —— 例如判停从子进程搬进本进程（已落地）、连接复用。

不值得做：把某个参数调 20 ms、把批次从 10 字降到 8 字、追某一档的 p90。
**那些都在噪声里，测不出来，也没人会感觉到。**
**这条和「观测优于猜」是一对**：那条说"要取证据"，这条说"证据本身也会漂"。
## 观测优于猜

排障和优化优先**取可复算的证据**，而不是对着代码猜：

| 想知道 | 去看 |
|---|---|
| **全部（推荐从这里开始）** | `scripts/observe.ts <会话档案>` —— 事实源清单 + 分段 + 审计 + dsh 对齐 |
| 一轮多久、卡在哪 | `scripts/latency-report.ts <会话档案>` |
| agent 那几秒花在哪一步 | `scripts/dsh-timeline.ts <会话档案>`（对齐 dsh 自己的会话日志） |
| 原始音频 / 电平 | 会话档案目录（`uplink.pcm` 是**放大前**的） |
| 线上发生了什么 | `journalctl -u miai-harness` |

工具清单、字段级说明、以及每个数字的**事实源归属**在 [docs/TOOLS.md](docs/TOOLS.md)。
三条硬规矩：

1. **裸说 `p50` / `p90` 只有一个意思**：闭嘴 → 出声。单段必须带名字（「② p50」），
   模型层必须说「模型首字 p50」，两者不许相减、不许并列进同一张表。
2. **一个事实只有一个源**：分段/状态/插话归本仓档案，step/工具/reasoning/job 归 dsh
   自己的 session log（`turn.end.dsh_session` 指过去），不复制、不转录。
3. **不要在这里加第二套统计**：分段唯一实现在 `src/latency-report.ts` 的
   `computeTurns()`，统计唯一实现在 `summarize()`。

`events.jsonl` 里的时间线是唯一能复算的东西 —— 改动前后要能比快慢，所以仪表
（`gate.close` / `asr.sentence` / `tts.first` / `turn.end`）缺了要记 `null`，
**不拿 0 冒充**，否则历史基线会被静默伪造。

## 部署边界与测试归属

根目录 `tests/*.test.ts` **只能引用部署清单里的路径**。清单与 `scripts/deploy_cloud.py` 的 `ITEMS` 对齐：`src/`、`mcp/`、`tools/`、`tests/`、`scripts/`，以及 `package.json`、`tsconfig.json`、`README.md`、`docs/TIME-KNOBS.md`。`tests/deploy-boundary.test.ts` 静态检查越界引用。`bench/` 与 `packages/` 不在清单里，写进根测试后服务器自检会模块找不到。

测试按归属拆开：

- 云端运行时：`tests/*.test.ts`，`npm test`（与部署自检同一批）
- bench：`bench/eval/*.test.ts` 与 `bench/replay/*.test.ts`，`npm run test:bench`
- web 包：`packages/dsh-voice-web/tests/*.test.ts`，`npm run test:web`

本地一次验完跑 `npm run test:all`。

## 三端运行配置唯一真相源

CLI（`src/main.ts`）、Web 插件（`packages/dsh-voice-web/src/driver.ts`）、评测服务（`bench/eval/server.ts`）共用 `src/voice-config.ts`。运行时默认值只从 `buildVoiceRuntimeConfig`、`resolveOmniApiKey`、`DEFAULT_IMAGE_QUESTION` 取；三端差异只走 `overrides`。入口里再抄一套默认，改一处就会漂。

## 上行人声：Silero v5 在热路径上，能量门是退路

生产与 Web 插件都经 [`src/runtime/vad-bootstrap.ts`](src/runtime/vad-bootstrap.ts) 的 `loadSharedVad()` 加载一份共享 `SileroVadModel`（[`src/vad.ts`](src/vad.ts)）。Web 侧是 `boot-voice-stack.ts` 调用同步副本里的同一函数。每条连接 `createStream()` 拿自己的 `SileroVadStream`，LSTM 状态不跨连接共享。

- `VOICE_VAD=energy|0|off|false`、找不到 `models/silero_vad.onnx`（或 `VOICE_VAD_MODEL` 指到的文件）、加载抛错：返回 `null`，继续用能量门。**不许因此拒绝启动**。`src/main.ts` 顶层不静态 `import` `onnxruntime-node`。
- 有模型时 [`src/uplink-pipeline.ts`](src/uplink-pipeline.ts) 把放大后的 PCM 切成 `VAD_FRAME_MS = 32`（512 个采样）再推理。队列严格串行：同一个 `SpeechVadStream.process` 不能重叠。
- 概率进 [`src/energy-gate.ts`](src/energy-gate.ts)：起音 `0.45`、维持 `0.30`，峰值还得高于 `-62 dBFS`。`speaking` 且本段还没确认人声时，起音改 `0.65`，去抖取 `max(voiceDebounceFrames, speakingDebounceFrames)`，后者缺省 4。
- 封段门槛在 [`src/silence-triggers.ts`](src/silence-triggers.ts)：`minSpeechMs` 缺省 `DEFAULT_MIN_SPEECH_MS = 120`。不够 120 ms 的碎声不封段、不投机、不预跑。
- 预卷分层在 [`src/voice/connection.ts`](src/voice/connection.ts)：TurnJudge 吃满 `DEFAULT_GATE_PREROLL_MS`（800 ms）；ASR 与 Omni 只补尾部 `DEFAULT_ASR_PREROLL_MS`（320 ms）。
- [`scripts/calibrate.ts`](scripts/calibrate.ts) 仍是离线标定（旧的单会话 `SileroVad`、10 个阈值）。它的 0.4 标定观察点不要写回能量门的 `0.45/0.30`。

## Pure Live 的前台事实只有 `live-session-store`

[`src/pipelines/live-session-store.ts`](src/pipelines/live-session-store.ts) 的 `reduceLiveSession` 是唯一数据面：前台轮次、后台任务、已经投影给 Omni 的那一槽 `lastSnapshot`。编排器只执行它吐出的意图：

- `sync_omni_snapshot` → `updateDynamicContext`。快照字符串没变就不发。控制面只留最新一份，发出去的是整份 `session.update`。
- `send_tool_output` → `sendFunctionCallOutput`。
- `delete_omni_items` → `deleteItems`，清掉未核实的助手项。

真车道实现了 `updateDynamicContext` 时，后台结论只进这一槽。`injectAnswer` 只留给没有这个方法的旧假车道。真车道上再把同一结论旁注进下一轮，Omni 会同时看到两份事实。

后台正文开头的 `[原意: …]` / `【原意：…】` 由 [`src/background-task-bus.ts`](src/background-task-bus.ts) 的 `parseCanonicalUserTag` 剥掉，写进 `canonicalUser`，再投影进快照。标签留在要朗读的正文里会被念出来。

## 守卫轮：没标委派，首块音频一字节都不外放

`decideLiveTurn` 给出 `live_with_bg_guard` 时（要动手，或 `isRealtimeFactRequest` 命中的实时事实），[`src/pipelines/live-orchestrator.ts`](src/pipelines/live-orchestrator.ts) 在第一块 `audio` 出去之前看 `delegateReason()`。还是空的就 `discard`，用用户原话走 `early_rule`，再排队一句短应声。这时已经交出的音频字节数必须仍是 0。整段 0 音频且仍没有 `delegate` 时，同样补原话并应一声。

这几处要一起改，拆开就会漏声或漏拦：

- [`src/omni/shadow.ts`](src/omni/shadow.ts) 在 `response.output_item.added` 看到 `function_call` 立刻标 `delegate`（真服务上工具比首块音频早约 150 ms）。没人认领的回复停在 `readyResp`。同句再封段只删助手项，用户音频留下，下一句才连用户项一起删。
- 专名、动手、长期记忆的领域边界写在 [`src/omni/protocol.ts`](src/omni/protocol.ts) 的 `DELEGATE_TOOL`，不写进 `instructions`。没调工具、也没被实时事实守卫接走时，[`detectSubjectHallucination`](src/pipelines/entity-divergence.ts) 只在听写与答复专名零重叠时派后台复核；注记要求第一行写 `[原意: 纠正后的用户原话]`。
- [`src/turn-router.ts`](src/turn-router.ts) 的 `isConditionalWeatherAside` 把「如果……的话就……」这类条件假设排除出天气守卫。假设后面又显式问天气，仍然要查。
