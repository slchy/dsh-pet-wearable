# 交接文档 — dsh-pet-wearable

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
  utterance-assembler.ts ← 句子 → 一轮话语（按 Smart Turn 概率判停）
  smart-turn.ts      ← 判停 sidecar 客户端（`smart_turn/` 那个 Python 服务）
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
smart_turn/          ← Python 判停 sidecar
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
