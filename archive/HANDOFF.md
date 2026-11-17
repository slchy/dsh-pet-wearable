# 交接文档 — dsh-pet-wearable（**已归档**）

> ⚠️ **这是历史文件，不是现状。**
>
> 2026-11-14 起，设计现状由两份 ADR 定义：
> - [`docs/adr/0001-app-layer-and-pet.md`](../docs/adr/0001-app-layer-and-pet.md) —— 应用层分层、宠物状态机、话筒仲裁
> - [`docs/adr/0002-virtual-time-simulator.md`](../docs/adr/0002-virtual-time-simulator.md) —— 虚拟时间模拟器
>
> 当前状态与用法见 [`README.md`](../README.md)。
>
> 本文件仍有价值的只有三类内容，ADR 没有重复它们：
> 1. **真机结论**（§2：手机能主动拉起语音会话、下行无需会话即可出声等）
> 2. **已证伪的假设**（§2：`Aivs` 字段号、`f1=2` 不可用等）
> 3. **环境与踩过的坑**（§6 / §8）
>
> 「已知缺口」与「建议的下一步」两节**已逐条标注现状**（已做 / 已被否决 / 仍成立），
> 标注日期 2026-11-14。**仍成立的只有缺口 1（快反射无短音素材）和缺口 4（`played` 只记档）。**

---

写给接手这个仓库的 agent 或人。**先读完再动手**，里面有一批已经用真机验证过的结论和
踩过的坑，重复验证它们纯粹是浪费。

---

## 1. 这是什么

**一个住在智能眼镜里的宠物插件，形态上属 dsh 的 "external protocol driver"。**

一句话定位：

> 不是"更好的双工语音助手"，是**"一个和你看着同一个世界、只有你能听见、一直在场的存在"**。

和生态里已有的双工语音插件（`dsh-voice` / `dsh-voice-mode` / `dsh-voice-ai-girlfriend`，
都能打断、都能流式朗读）的区别只有一条，但很硬：

| | 那些插件 | 这个 |
|---|---|---|
| 形态 | 浏览器 / 桌面 | **戴在脸上** |
| 谁开口 | **你**（点麦 / 唤醒词） | **它**（时机状态机决定） |
| 允许无用 | 不必 | **必须**（"哥，那辆车好吵"这种） |

**技术上不新鲜，需求也未验证。** 它的价值在于回答一个问题：**主动开口到底是价值还是噪音。**
如果实测发现是噪音，这个项目就该死，而且死得对。

---

## 2. 现在到哪一步了

### 已真机闭环（别再重复验证）

| 能力 | 证据 |
|---|---|
| **手机能主动拉起语音会话** | 发 `Aivs` id=10 后 **0.62 s** 开始推实时 mSBC，0 上行 `OpenDevice`，实测连续 ≥29.5 s |
| 手机能主动开/停录音 | `Media` id=20，回执也走 id=20；音频落眼镜本地 `AUD_*.ogg`（不是实时流） |
| 佩戴检测 | `System` id=93 查询 + id=79 上报（双通路） |
| 电量 | `System` id=1 查询 + id=97 推送（双通路） |
| 拍照（无需唤醒） | `Aivs` id=4，真机 3/3 出图 |
| 结束语音会话 | `Aivs` id=5 六字段全零（只写 f1 无效） |

### 已证伪（别走回头路）

- **`Aivs` id=10 的容器字段是 `f11`，不是 `f1`。** 字段 1 是 `INSTRUCTION_LIST`。
  按 f1 发会收到 SAR ACK 然后被**完全忽略**（2026-11-14 第一次实验就是这么失败的）。
- **`Aivs` id=5 的 `f1=2`（开始）与静态枚举冲突，不可用。**
- `id=10` **两个方向都是 `f11`**（早先"下行 f1、上行 f11"的说法是把 `WearPacket.f1=14`
  的 type 字段误当成了 `Aivs` 字段号）。
- **小米眼镜的 ADB 封死**，只能靠手机侧 SDK 走 SPP。所以"能装自己的 App"这件事
  只有雷鸟这类开放设备才能做。

### 已定架构：厚 driver（方案 C）

```
眼镜 ──mSBC/SPP──► 手机（纯管道）──TCP 5 字节帧──► [本仓库 = dsh 插件]
                                                      ├─ 语音栈（STT/TTS/判停/打断）
                                                      ├─ 对话决策（session-core / fsm）
                                                      ├─ 宠物（时机 / 情绪）
                                                      └─ agent 桥（ctx.agents）
                                                            │
                                                            ▼
                                                      dsh 进程（同进程内）
```

**语音全部进插件**（`src/` 现在那 6 000 多行），不是独立进程。

- 好处：单进程，少一跳，能直接用 `ctx.agents` / `ctx.schedule`
- 代价：**插件崩溃 = dsh 崩溃**，所以所有异步入口必须 `try/catch` 到日志
- 代价：改代码要重启 dsh —— 但**参数不必**：dsh 的 Config 支持 `configure()` 运行时热更新
  （官方 `speech-to-text` 的做法："the running instance reads the updated values
  **without remounting**"）

---

## 3. 目录

```
src/
  driver.ts          ← 插件入口（待写）：name / inject / Config / apply
  main.ts            ← 现有 CLI 装配，独立运行用（plugin 形态下退居为调试入口）
  transport.ts       ← TCP 5 字节帧 [type:u8][len:u32 LE][payload]
  frame.ts           ← 分帧编解码
  uplink-pipeline.ts ← mSBC → ffmpeg 子进程 → 能量门
  energy-gate.ts     ← 没声音就不建 STT 连接（有预卷缓冲）
  utterance-assembler.ts ← 句子 → 一轮话语（按 TurnJudge 概率判停）
  turn-judge.ts      ← 判停 sidecar 客户端（`turn_judge/` 那个 Python 服务）
  vad.ts             ← silero-vad 封装
  aliyun-asr.ts      ← 阿里云 NLS 实时识别
  mimo.ts            ← MiMo ASR / TTS（SSE 流式，下行 24 kHz）
  agent.ts           ← VoiceAgent：人设提示词 + 情绪标签 + cleanForSpeech
  session.ts         ← DshSession：现在用 `dsh headless` 子进程 + NDJSON（**将被 driver 取代**）
  session-core.ts    ← 纯决策：16 事件 → 9 效果
  dialog-fsm.ts      ← 对话相位机 + 票据（打断靠它作废）
  emotion.ts         ← 5 情绪标签 → TTS 风格串
  announce-store.ts  ← 离线待补播队列（至少一次语义）
  archive.ts         ← 一条连接一个目录，落 mSBC/PCM/事件时间线
  latency-report.ts  ← events.jsonl → 逐轮延迟分解（纯函数）
  pet/               ← 宠物核心
    ports.ts         ← 宿主设备接口（通用性边界）
    pet-timing.ts    ← 时机状态机（什么时候开口）
tests/               ← `node --test tests/*.test.ts`
turn_judge/          ← Python 判停 sidecar
mcp/                 ← take_photo 等 MCP 工具
models/              ← silero_vad.onnx
```

---

## 4. 下一步该做什么

### 4.1 先写 `src/driver.ts`（骨架对齐官方 `acp`）

官方 `packages/acp/acp` 是文档点名的 protocol driver worked example，1 172 行。照这个形状：

```ts
export const name = 'pet-wearable'
export const inject = ['agents', 'sessions', 'sessionPersistence']
export interface PetConfig { /* 判停阈值、音色、时机参数…全部可热更新 */ }
export const Config: Schema<PetConfig> = Schema.object({ /* … */ })
export function apply(ctx: Context, config: PetConfig): void {
  // 1. apply 里捕获注入的服务（handlers 在注入作用域外执行）
  // 2. 起自己的 TCP 监听（现在的 transport.ts）
  // 3. 每连接 ctx.agents.create({ sessionId, meta:{cwd}, agentOptions, setup })
  // 4. 上行 ASR 文本 → agent.followup(createUserMessage({content, source:{kind:'user'}}))
  // 5. ctx.on('session/event') → TTS → sendAudio
  // 6. ctx.effect(() => quiesce, 'pet.wire')   ← 幂等，先同步 cancel 再 await dispose
}
```

四条从 acp 抄来的纪律：

| 纪律 | 为什么 |
|---|---|
| apply 里捕获服务 | handler 在注入作用域外跑，懒读会拿到 undefined |
| **归属用引用比较** | `owns(agent) { return this.agent === agent }`，防同 id 冒充 |
| quiesce 幂等 | `if (quiescing) return quiescing` |
| 先同步 cancel 再 await dispose | 否则已排队的 prompt 会拖住关闭 |

### 4.2 然后按这个顺序

1. `src/driver.ts` + `src/agent-bridge.ts` —— 把 `session.ts` 的 NDJSON 换成 `ctx.agents`
2. `Config` 化：判停阈值 / TTS 音色 / `pet-timing` 的参数全部做成可热更新
3. `device/` 目录：把 `transport.ts` 收成 `device/xiaomi/`，`registry.ts` 一行注册
   —— **判据：新增一台设备 ≤ 2 个文件**
4. `pet-timing` 接进 `session-core` 的事件循环（它现在还没接线）

### 4.3 验收标准（比任何延迟指标都重要）

**你愿意第二天再戴上它。**

不是 p90 延迟、不是 ASR 准确率。这是需求未验证的项目，唯一要紧的数据就是佩戴时长。

---

## 5. 必须守的纪律

这几条都是真金白银踩出来的，破例会退回原点：

1. **不许猜字段号。** `COMMAND-MAP.md` §6.4 记录过"命令 id 与 protobuf 字段号无公式关系"，
   已被推翻三次。任何字段号都要有反编译出处或真机字节。2026-11-14 就因为信了代码注释里
   一句错话（"下行用 f1"），白跑一次实验 —— 而权威表里明写着 11。
2. **有真机证据才写 ✅。** 没验证的写 🔍，别写 ✅。矩阵底部的合计表也是代码检查的一部分。
3. **`null` 不等于 `false`。** 拿不到佩戴状态 ≠ 没戴，拿不到电量 ≠ 没电。
   不拿默认值冒充已知值。这条在 `pet/ports.ts` 和 `latency-report.ts` 里都落实了。
4. **负结果同样要记。** 已排除的假设清单比结论本身值钱。
5. **别为"感觉"层面的东西造证据系统。** 活人感/可爱与否，盲测比指标准。

---

## 6. 环境

### 小米眼镜（当前唯一能跑的设备）

| 项 | 值 |
|---|---|
| 设备 | Xiaomi AI Glasses o95 / M2442G1，配对名 `Xiaomi AI Glasses D5E5` |
| 手机 | M2004J7AC，无线调试 |
| adb 地址 | **每次随机**，用 `adb mdns services` 取 `_adb-tls-connect._tcp` 那条 |
| 调试 App | `io.github.slchy.glasses2grok.sample`（在**另一个仓库**里，见 §7） |
| 日志 tag | `MiaiglassSample` |

发帧不用改代码，`--es probe "type,id,hex"` 就能发（多帧用 `;`，但**设备侧 shell 会吃掉
`;`**，必须用设备侧单引号包住整串）。

### 雷鸟（未买，但能力面已查清）

- X3 Pro：骁龙 AR1 Gen1、76 g、3–5 h、`isWearing()` 一行、3 麦 + 2 扬声器
- **能装自己的 APK**，`AudioRecord` 想开就开，不需要任何"拉起"命令
- 官方开发文档：`https://rayneo-en.gitbook.io/rayneo-devdoc/`（`llms.txt` 有全量索引）

这就是为什么长期路线在雷鸟：**小米上是"设备租用"，只能拉它允许你拉的。**

---

## 7. 另一个仓库

`C:\Miaiglassses2grokbot` 是**研究线**，本仓库是从它的 `cloud/` 用 `git subtree split`
提取出来的（51 个 commit 的历史都在）。那边保留：

- `sdk/` —— 小米眼镜 Kotlin SDK（SPP 解析、握手、门面）
- `docs/` —— A–AW 解析笔记（mSBC 帧率、能量门阈值、判停策略的来源）
- 手机端调试 App（`sdk/sample`，即上面那个 `io.github.slchy.glasses2grok.sample`）

**两侧零代码依赖，只通过线协议通信。** 手机端推音频，本仓库是云端 + 插件。

需要改设备侧（协议、SDK、App）时去那个仓库；需要改语音/对话/宠物时在本仓库。

---

## 8. 已知的坑

| 坑 | 说明 |
|---|---|
| PowerShell + 中文 | `@'…'@ \| python -` 管道会被 OEM 编码破坏，要写文件 |
| git commit 中文 | 用 `git commit -F <文件>`，别用 `-m`（引号会被拆） |
| `ffmpeg` 路径 | `harness.py` 里硬编码了一个仓库外路径，迁移后要改成可配置 |
| `session.ts` 的 180 s 上限 | 超时必须抛错**并说出来**，不许静默 |
| TTS 会把 markdown 念出来 | 所有下行文本必须过 `cleanForSpeech` |
| 播放时长是估算 | `turn-runner` 用 `audioSeconds + playbackTailMs` 之后 sleep 轮询，服务器不知道设备真正播到哪。"它什么时候觉得自己说完了"建在这个估算上 |

# 交接：v2 线协议与宠物环接线（2026-11-14）

接着 [archive/HANDOFF.md](../archive/HANDOFF.md) 往下写。那份里的真机结论（§2）、纪律（§5）、
环境（§6）和已知的坑（§8）仍然有效，这里不重复。

## 现状

`main` 比 `origin/main` 多 5 个提交，**都没推送**：

| 提交 | 内容 |
|---|---|
| `46abb00` | 旧交接文档与 harness.py 移入 `archive/` |
| `c5de987` | 宠物环：快反射、电量缓存、presence 允许 `null` |
| `a0ebe09` | 设备原语收成最小集，能力自报，v1 降为垫片 |
| `3c3e317` | v2 线协议：只增帧，`Hello` 自报能力，`Welcome` 握手 |
| `4805734` | v2 接进连接；宠物环主动开口 |

`npx tsc --noEmit` 干净，`npm test` 150 个全过。工作区干净。

## 这一轮做了什么

**v2 线协议，向下兼容。** 只新增帧，旧帧含义不变。协议写给手机端的人看：
[docs/device-protocol.md](../docs/device-protocol.md) 的「v2」一节。

- 下行 `Call`(3) / `Welcome`(4)，上行 `Event`(7) / `CaptureImage`(8)
- `Hello{proto:2, capabilities}` 合法 → 回 `Welcome`，之后走 v2
- 不发 `Hello`、`proto:1`、或 `proto:2` 但能力不合法 → 不回 `Welcome`，走 v1 垫片，**不拒绝连接**
- 服务端只在发过 `Welcome` 后才发 `Call`，v1 手机收不到不认识的帧

**握手在建连接之前。** [src/aliyun-session.ts](../src/aliyun-session.ts) 的 `handshake()`：
能力决定上行解码、判定核和收件箱，所以先定版本再构造 `AliyunConnection`。
配了鉴权就等 `Hello`；没配时 `Hello` 先到用它，别的帧先到或等满 1 秒就按 v1 走，
先到的那一帧原样补交。

**宠物环接进对话循环。**

- [src/pet/device-host.ts](../src/pet/device-host.ts)：`DeviceEvent` → 宠物端口的唯一适配器。
  设备没声明的能力，对应端口缺省（不是永远 `null` 的假端口）
- [src/pet/proactive.ts](../src/pet/proactive.ts)：`planProactive()` 决定怎么开口。
  设备能不用人动手拍 `glance`（`canCaptureUnprompted`）才先拍一张；支持 `listen.start` 才在说完后开麦
- `AliyunConnection.tickPet()`：只在 `listening`、串行队列空、没在播报时判时机
- `runProactive()`：拍照期间用户开口了（`utteranceSeq` 变了）就作废这次

## 怎么开

主动开口**默认关**，`PET_PROACTIVE=1` 才开。

| 变量 | 默认 | 含义 |
|---|---|---|
| `PET_TICK_MS` | 30000 | 多久判一次时机 |
| `PET_LISTEN_MS` | 8000 | 说完后开麦多久（设备支持 `listen.start` 才生效） |
| `PET_GREET_AWAY_MS` | 300000 | 摘下超过多久，戴回时打招呼 |
| `PET_CHATTER_IDLE_MS` | 1200000 | 安静多久后搭话 |

其余时机参数（两次开口最小间隔 10 分钟、23–7 点不搭话、电量 ≤20% 不搭话）只能改
`DEFAULT_PET_TIMING`。深夜判定用进程本地时区，VPS 上要设 `TZ`。

## 两台设备上会发生什么

| | 小米（v1，型号提示 `xiaomi-glasses`） | 雷鸟 X3 Pro（v2 自报） |
|---|---|---|
| 戴回打招呼 | 没有：v1 手机不转发佩戴 | 有 |
| 安静久了搭话 | 有 | 有 |
| 开口前先拍一张 | 有：`glance` 不用人动手，走 `take_photo` | 有 |
| 说完自动开麦 | 没有：v1 表达不了 `listen.start` | 有 |
| 敲击 | 没有：v1 手机不转发 | 只记日志（见缺口 1） |

两列都**没跑过完整的宠物流程**：小米那列受 v1 手机端能力所限，雷鸟那列只按官方文档推断、
设备侧适配器还不存在。

**但「小米能不能出声」已经真机验证：能。**

2026-11-14 实测：**不唤醒、不建语音会话**，直接 `AudioTrack` 播一段 PCM → 眼镜有声。
所以小米上主动开口**不需要先改手机端**。

`A2DP` 是独立的蓝牙音频 profile，**与 SPP 语音会话无关** —— 手机和眼镜只要连着 A2DP（配对后
一直连着），随时可以往它推 PCM，不需要 `Aivs` 会话、不需要唤醒、不需要 SPP 上任何一帧。
三处互证（另一仓 `docs/application/product/ARCHITECTURE.md`）：

```text
L65   K2["A2DP<br/>下行音频唯一路径"]
L84   P5 -->|"A2DP，绕过 SPP"| K2
L305  | 下行音频 | — | — | — | — | A2DP，不经 SPP | — |
```

**上下行前置条件不同，但可以同时跑 —— 这条早就验证过。**

| 方向 | 通道 | 前置条件 |
|---|---|---|
| 上行（听） | SPP 语音会话 | 必须被拉起（`Aivs` id=10，实测 0.62 s 后开始推流） |
| 下行（说） | A2DP | 无 —— 连着就能播 |

「开麦之后下行还从 A2DP 出声吗」= **会**。三层独立证据（老仓）：

- **官方**：官方 App 完整会话 = 上行 SPP `MASS_VOICE` + 下行 TTS 走 A2DP，
  **全程零 SCO 事件**（`ADR-001-AUDIO-CHANNEL-SPLIT.md` §1）
- **机制**：SCO 由「通话」建立，唤醒词与 `Aivs` 会话都不会拉起它（同 ADR §4）
- **自研**：`VoiceLink` 同一个类里两个方向同时跑（`UP_AUDIO` L103 / `DOWN_AUDIO → player.write()` L285）

第三层就是日常——每次对话都是上行 mSBC + 下行 PCM 同时，会话全程开着。**不是推断，是在用。**

由此定一条编排不变量：**要正式发言时，先 `requestWakeUp()` 再播** —— 这样"在说话但听不见"
的状态不存在，用户随时可插话。唯一成本是电量（麦克风 + 7.6 kB/s 上行），不涉及链路风险。

快反射短音（"嗯？""在呢"，<200 ms）**不开麦**，纯 A2DP：省电、少一步，而这么短的一句
被插话没有意义。

## 没验证的

单元测试覆盖了 v2 编解码、`resolveDeviceLink`、`DeviceEventHost`、`planProactive`。
**`aliyun-session.ts` 里的接线一行都没跑过**：握手、1 秒回落、补交首帧、`Welcome`、
`Event` / `CaptureImage` 分发、定时判断、主动开口。

[tools/fake-phone.ts](../tools/fake-phone.ts) 只会说 v1（`Hello` 写死 `proto:1`），测不了 v2。

## 已知缺口

1. **快反射没有短音素材。** `onTap` 给出 `reflect` 后只记日志，不出声
2. **主动开口的提示走「用户消息」通道。** `proactivePrompt()` 那句「（系统提示，不是用户说的话：…）」
   会作为用户消息进 dsh 会话历史 —— 这是用**内容**去补**元数据**的缺。

   **答案（源码核对，`packages/llm/llm/src/message.ts:100-135`）**：

   应用层已经落地了这个决定，且比这里的建议更进一步：
   [ADR-0001 §3](../docs/adr/0001-app-layer-and-pet.md) 定义 `source` 取
   `{kind:'user'}` 或 `{kind:'pet', reason}`，由 **agent 适配器**负责映射到 dsh
   （现阶段 `pet` 映射成 `user`，正文保留"系统提示"那半句）。也就是说：应用层有了真正的
   `pet` 来源，dsh 侧仍是安全的 `user`。下面这段保留作为该决定的依据。

   ```ts
   interface MessageSourceMap {
     user: { kind: 'user' }
     model: ModelMessageSource        // { kind: 'model', ...providerMetadata }
     tool: ToolMessageSource          // { kind: 'tool', callId }
     'system-prompt': { kind: 'system-prompt' }
   }
   ```

   注释原文两句是关键：

   > Merge-extensible sum type — **each producer declares its own `kind` in its own
   > module; there is no shared catch-all `plugin` kind.**
   > … user messages carry any producer's kind, and **consumers fall through unknown kinds.**

   所以按风险排：

   - **`source: { kind: 'user' }`** —— 官方唯一用过的写法（`packages/acp/acp/src/session.ts:268`）。
     **先这样做**，零风险。
   - **声明合并一个新 kind**（`{ kind: 'pet', reason: 'greet' \| 'chatter' }`）—— 类型上是设计意图，
     语义最正。风险点：`known-event-types.ts` 的白名单只针对未知 **event type**（靠 `ignorable`
     标记），对 `source.kind` 没有白名单，而注释明说 "fall through unknown kinds"，所以**应该**
     安全。**留到 v0.1 之后再上**，现在别拿它冒险。
   - **靠 content 里那句话区分** —— 就是现状，最差。

   **落地动作（已被 ADR 覆盖，此处保留当时的推理）**：原建议是「填 `source: { kind: 'user' }`，
   把括号里那半句删掉」。ADR-0001 §3 决定**不删那半句** —— 应用层发出 `{kind:'pet'}`，
   到 dsh 边界才降成 `{kind:'user'}`，正文里那句话因此仍有信息量（它告诉模型这不是用户打的字）。
3. ~~主动拍照最多等 20 秒才开口~~ **已做**。`PetParams.captureTimeoutMs = 4_000`，只作用于
   `look` 阶段（`brain/registry.ts` 的 `deadlineMs: (p) => p.captureTimeoutMs`），
   超时结果是 `none` → **不带图照常开口**（`onResult` 注释：「别假装看见了」）。
   实测证据：`sim/scenarios.ts` 的「晚到的图不进 agent（look 超时后才回）」——
   `captureLatencyMs: 6_000` 晚于 4 s 截止，图确实被挡在 agent 之外。

   当时的建议是 3000–5000 ms，取 4 s 属于这个区间。
4. **`played` 事件只记档。** `TurnRunner` 仍按音频时长估算播完时刻，`listen.start` 也是在估算的播完之后发
5. ~~v2 设备必须先发 `Hello`~~ **已缓解**，但方式不是我建议的升级：`handshake()`
   （`src/aliyun-session.ts`）在定版本前留了一个窗口 ——
   - 配了鉴权：连接层保证 `Hello` 先到，直接等它
   - 没配鉴权：先到的是别的帧、或等满 `HANDSHAKE_WAIT_MS = 1000` → 按 v1 走，
     **那一帧原样转交，不丢**

   所以"音频比 `Hello` 早到就永久降级"只在不鉴权 + 首帧比 `Hello` 早 1 s 以上时才成立。
   剩下的 `proto:2` 但能力不合法 → **降级不拒绝**（`resolveDeviceLink` 注释明写
   "向下兼容优先"），只打一行日志、不回 `Welcome`。
6. ~~README「现在能不能用」一表过时~~ **已更新**：状态表现在写「语音链路仅独立进程可跑；
   主动开口已按 ADR-0001 实现且 `npm run sim` 可离线跑」。

## 建议的下一步

> ⚠️ 本节写于 ADR 之前。**2/3 已答、4 已否决、5 已做；1 只剩工具侧。**
> 保留只为记录当时的判断顺序。
> 真正待办的清单见 [`README.md`](../README.md) 与 ADR-0001 §11。

1. ~~给 `fake-phone.ts` 加 `--v2`~~ **协议侧已做，工具侧仍未做**：
   - v2 线协议在 `src/devices/wire-v2.ts`（`negotiateV2` / `encodeV2Call` / `parseV2Event` /
     `parseV2CaptureImage`），由 `src/devices/index.ts` 接入 `handshake()`；有单测
   - **`v2-generic` 能力档在模拟器里是跑通的**（`sim/world.ts` 的 `capabilitiesOf`，
     场景「v2 设备也能跑：能力集换成通用档」）。但它只替换**能力集**，
     不经过 `wire-v2.ts` 的编解码 —— 模拟器在应用层之下，看不到线协议
   - `tools/fake-phone.ts` **还在**，L116 仍写死 `proto: 1`，和进程内模拟器是两件
     不同的东西（真 TCP + 真帧 vs 进程内虚拟时间）
   - 所以真正缺的只有一件：**v2 线协议的端到端覆盖**（握手 → 编解码 → 事件往返）
2. ~~问用户：小米在没有语音会话时能否下行播放~~ **已答**（见上「两台设备上会发生什么」）：
   A2DP 与 SPP 语音会话无关，随时可播。剩下只有真机确认那一步。
3. ~~主动开口改用 dsh 的 MessageSource（字段问用户）~~ **已答**（见缺口 2）：
   应用层用 `{kind:'pet'}`，到 dsh 边界映射成 `{kind:'user'}`。
4. ~~缺口 5 允许 v1→v2 升级~~ **已否决，且原问题已另行缓解**（见缺口 5）：
   `handshake()` 有 1 s 的 `Hello` 等待窗口并转交首帧，代价远低于重建对象图。
   升级本身被 [ADR-0001 §11](../docs/adr/0001-app-layer-and-pet.md) 否决 ——
   上行解码、判定核、收件箱在建连接时按能力定死。
5. ~~更新 README 状态表~~ **已更新**；推送仍按「和用户协作」等用户开口。

## 和用户协作

- 用中文沟通
- 只在本仓库目录内读写，不读仓库外路径；需要外部信息直接问用户
- 提交和推送都等用户开口
- 中文提交信息用 `git commit -F`（旧交接 §8）

## 补记的来源（2026-11-14）

缺口 2 的 MessageSource 字段与本文件「小米能不能出声」一节，不是猜的，来自两处源码核对：

| 结论 | 出处 |
|---|---|
| `MessageSourceMap` 的形状与「消费者会 fall through 未知 kind」 | `deepseek-ai/deepseek-harness` 的 `packages/llm/llm/src/message.ts:100-135` |
| 官方先用 `{ kind: 'user' }` | `packages/acp/acp/src/session.ts:268` |
| A2DP 是下行唯一路径且绕过 SPP | 老仓 `docs/application/product/ARCHITECTURE.md` L65 / L84 / L305 |
| **下行无需语音会话即可出声** | **真机 2026-11-14**（`AudioTrack` 播 PCM → 有声，不唤醒、不建会话） |
| **上下行可同时**（含开麦时下行仍走 A2DP） | 老仓 `ADR-001-AUDIO-CHANNEL-SPLIT.md` §1（官方全程零 SCO）、§4（SCO 不会被拉起）+ `VoiceLink.kt` 双向环 |

前两条来自公开仓库，可随时复核；其余是另一仓的真机结论，均已落地成文档。
