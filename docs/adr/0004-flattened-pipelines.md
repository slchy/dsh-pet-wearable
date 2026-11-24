# ADR-0004 扁平管道：启动期互斥、单泵、Pure Live 只留一副嗓子

- 状态：已落地（2026-11-23）
- 关系：把 [ADR-0003](0003-deterministic-kernel.md) 的契约 #5 接进生产热路径；
  机器细节在 [state-machines](../state-machines.md) §5.7、§5.9
- 实现：`src/pipeline-mode.ts`、`src/turn-runner.ts`、`src/engine-contract.ts`、
  `src/pipelines/live-orchestrator.ts`、`src/pipelines/cascade-agent.ts`、
  `src/engines/live-voice-engine.ts`、`src/engines/cascade-voice-engine.ts`、
  `src/background-task-bus.ts`、`src/omni-shadow.ts`、`src/app/dialog.ts`

## 1 背景

Live 是一条黑盒音频会话：模型自己听、自己说、自己决定什么时候 `tool_call`。
Cascade 是客户端控的文本加 TTS：快车道、投机、流式合成、整段回落都在我们这边。
这两条曾经塞进同一个 `FrontedAgent`，再由 `TurnRunner` 用 `omni` / `stream` / `pump`
三条分支把音频送下去。

上面又叠了两个会说话的前端。omni 维持一份服务端对话，dsh 主会话维持另一份，
而 dsh 自己的工具、`run_in_background` 和子代理已经是异步的。结果是三件同时发生
的事：

| 现象 | 从哪来 |
|:--|:--|
| 上下文裂成两半 | 一边听过的话，另一边的历史里没有；委派、插话、后台完成各写各的 |
| 同一段对话两副嗓子 | 该 omni 答的轮退回级联，或后台结论用另一条 TTS 插进来 |
| 配置组合爆炸 | `OMNI_SHADOW`、`OMNI_ANSWER`、`FAST_LANE` 可以同时为真，装配层得猜「这条会话到底谁在说话」 |

内核已经把因果、播放、结算收成一台纯 `step()`（ADR-0003）。剩下的分裂在泵和人格，
不在判定层。

## 2 决策

### 2.1 启动期互斥，底座共用

`VOICE_PIPELINE=live | cascade` 在进程启动时二选一，会话内不混跑
（`src/pipeline-mode.ts`）。没写这个变量时，才用旧的 `OMNI_SHADOW` /
`OMNI_ANSWER` 推断；显式值优先，非法值直接失败。

两条管道共用同一套确定性内核、设备端口和宠物 / 话筒底座。换的是谁对用户出声：

| 模式 | 前台 | 明确不加载的东西 |
|:--|:--|:--|
| `live` | omni 一副嗓子（`LiveOrchestrator`） | 文本快车道（`FastLlmClient` / `PrefetchSlot`）。缺音频 key，或 STT 不是 `qwen-realtime`，启动失败，不静默装成「开了 live、其实没声音」 |
| `cascade` | 文本快车道 → TTS（`CascadeAgent`） | omni 接管发声。显式 cascade 时忽略 `OMNI_ANSWER`。影子只在 `OMNI_ANSWER=off` 且 key 与 STT 都齐时做只读探针 |

### 2.2 `TurnRunner` 只剩一条泵

`TurnRunner.run()` 只 `for await` `FastVoiceEngine.respond()`。`omni` / `stream` /
`pump` 不再出现在这个文件里。构造时定下引擎，一轮中间不换。

| 装配 | 注入的泵 |
|:--|:--|
| `VOICE_PIPELINE=live` | `LiveOrchestrator.toEngine()`。omni 音频经 `LiveVoiceEngine` |
| `VOICE_PIPELINE=cascade` | `CascadeAgent.toEngine()`，实现 `FastVoiceEngine`。`CascadeVoiceEngine` 是同一契约的端口化实现，契约测试走它 |
| 只给了 `{ agent, tts }` 的旧装配 / 模拟器 | `AgentEngineAdapter` 收成同一条 `respond()` |

内核仍只认 `EngineEvent`。逐轮延迟埋点（`tts.first` / `turn.end` 的 `dsh_ms` /
`audio_s`）留在 `TurnRunner`：引擎报事实，记账不进引擎。「换引擎零改内核」因此
同时是「换引擎零改泵」。

### 2.3 扁平 Pure Live：后台执行，前台一副嗓子

`live` 里 dsh 不再是第二个对话者。它是无头执行器。下列来源都收成
`BackgroundTaskReport`，由唯一前台决定什么时候说：

| 来源 | 怎么进来 |
|:--|:--|
| `tool_call` | omni 自己决定转交。同一 `turnNo` 上若 `early_rule` 还在排队，用这条查询升级，只打一次 dsh |
| `early_rule` | 本地动作动词，omni 健康时提前派。与上面的 `tool_call` 按 `turnNo` 去重 |
| `image` | 识图。omni 没看见图，先丢在途音频，应一声之后把图交给 dsh |
| `memory_silent` | 像长期事实的话。后台记，不播报，默认也不被「别查了」取消 |
| `dsh_background` | dsh 自己的 `onAnnounce`（`run_in_background` / 子代理）。不进工人队列，直接变成同一形状的汇报 |

汇报进入 `DialogRuntime` 的播报队列。`FloorArbiter` 的安静窗先成立：相位回到
`listening`（`reply` 已释放，`announce` 抢不动 `reply`），并且用户连续静音满
800 ms。然后才问 `OmniShadow.canSpeakBackground()` —— `ready`、没有在途
response、也没有还没 commit 的用户音频。过了就 `speakFromText()`，用同一副嗓子说。

三态：

| 结果 | 含义 |
|:--|:--|
| `spoken` | omni 把结论说了。读端只绑 `origin: 'announce'` 那一份，不跟着用户的 `next` 走；用户的 `claim()` 也不拿这份音频 |
| `defer` | 前台正忙。条目排回队首，等下一个空窗 |
| `fallback` | 必须逐字的数字、标识、路径、超长正文，或 omni 开口失败。走旁白 TTS，念完后静默 `injectAnswer(..., 'spoken')`，不再说第二遍 |

插话不取消已经派出去的后台任务。只有 `isCancelRequest`（整句就是「算了 / 别查了 /
取消」）才 `cancelAll`。取消之后 runner 才回来的结果直接丢掉，不再变成汇报。
播到 0 字节就被掐掉的 announce：`deleteOnDone` 只删助手项，留下那条 user 事实旁注。

## 3 不选的做法

| 方案 | 为什么不选 |
|:--|:--|
| 继续在一个 `FrontedAgent` 里按轮切换 Live / Cascade | 切换点就是两副嗓子和两份历史的来源。每加一个开关，组合数乘一次 |
| 后台完成仍由 dsh 主会话直接出声 | dsh 已经异步，再让它当第二前端，完成时刻和用户正在说的话对不上，上下文也写不回 omni |
| 精确数字也交给 omni 转述 | 转述会改端口、单号和长报告。这类正文走逐字 TTS，事实再静默回注 |
| 把插话当成取消 | 插话是「我先说别的」。取消在跑的查询会把用户还没听到的结论扔掉 |

## 4 后果

- 一次会话只有一副前台嗓子。`live` 不加载文本快车道；显式 `cascade` 不让
  `OMNI_ANSWER` 接管发声。
- 内核与设备 / 宠物底座不动。两条管道的差别关在 `FastVoiceEngine` 后面。
- dsh 在 `live` 里的完成品统一成 `BackgroundTaskReport`。说不说、何时说、用不用
  逐字，由播报空窗和 `needsVerbatimRead` 决定，不由执行器决定。
- 插话与「别查了」拆开。前者留下在途任务和（0 字节时）user 事实项；后者停掉要播报
  的任务并抑制迟到结果。静默记忆两边都不被顺手取消。
- 代价是两条管道各自要有测试，但它们不再组合。启动期对非法模式和
  「live 却没有声音」直接失败。

## 5 验收

联网探针 `scripts/probe-omni-inject-speak.mjs` 只在调用方执行、且环境里有音频
Realtime 的 key 时才开口。没有 key 不建连。同一条连接上三轮：用户要求查设备数据
并观察 `tool_call`（故意不回函数结果）；回到空闲后立刻
`conversation.item.create` + `response.create`，量注入后能不能出声；再追问刚才的
事实，看模型还记不记得。脚本不带本仓库以外的地址。

单元与集成（虚拟时钟，不睡墙钟）：

| 套件 | 钉住什么 |
|:--|:--|
| `tests/pipeline-mode.test.ts` | `live` / `cascade` 互斥、非法值失败、缺 key 失败、显式 cascade 忽略 `OMNI_ANSWER` 接管 |
| `tests/fast-voice-engine.test.ts` | `LiveVoiceEngine` / `CascadeVoiceEngine` 都只从 `respond()` 吐 `EngineEvent` |
| `tests/background-task-bus.test.ts` | 每任务转移、`early_rule` 与 `tool_call` 去重并升级查询、静默优先让路、取消后迟到结果不发、逐字稿 |
| `tests/live-orchestrator.test.ts` | 单泵 omni、非阻塞 `tool_call`、插话不取消后台、「别查了」才取消、`spoken` / `defer` / `fallback` |
| `tests/dialog-live-announce.test.ts` | `flushAnnounce` 的三态、`defer` 排回队首、逐字绕过 `speakFromText`、插话调用 `cancelAnnounce` |
| `tests/cascade-agent.test.ts` | 纯级联不选 live、快车道与 dsh 回落、委派轮的放手和显式取消 |
| `tests/pipeline-integration.test.ts` | 真实 `DialogRuntime` + 内核 + `TurnRunner` 单泵。Live：同一副嗓子汇报、插话不取消 dsh、忙时 defer、逐字 TTS 加 spoken 回注。Cascade：没有 omni 车道 |
