# 状态机对齐：改了什么

任务：`dsh-pet-wearable` 状态机对齐（2026-11-16 → 11-17）。约束是**不改外部协议**
（帧格式、wire v1/v2）、**不改快车道判定逻辑和 prompt**，每步单独提交。

每一步的当前状态见 [state-machines](state-machines.md)。

## 总览

| 步 | 提交 | 内容 | 测试 |
|---|---|---|---|
| 0 | `765bf76` | 修测试基线：`tests/` 纳入 `tsc` | 491 绿 |
| 1 | `6aca2b1` | 话筒只有一份真相 | 502 绿 |
| 2 | `9c06156` | 当前轮只有一个代次 | 506 绿 |
| 3 | `27725c6` | 播完以设备为准 | 509 绿 |
| 4 | `290a1ad` | 投机的前置条件 | 509 绿 |
| 夹带 | `2c796f3` | 验收时撞到的崩溃：被掐的那一轮以 reject 收场 | 510 绿 |
| 5 | 本次 | 文档 | — |

## 第 0 步：测试基线

`src/fronted-agent.ts` 的首字超时器 `.unref()` 已在前一步去掉（提交 `a49fa05`）：
Node 22 的 test runner 看到「唯一待办是一个不保活的定时器」就判定 promise 永远悬着，
把它当 `cancelledByParent`，一次连坐 21 项。本地 Node 24 复现不了 —— **涉及定时器/事件循环的
改动必须在服务器 Node 22 上再跑一遍**。

本步把 `tests/**/*.ts` 纳入 `tsc --noEmit`，暴露 6 处测试自身的类型错误，逐个修好。

## 第 1 步：话筒只有一份真相

**改了什么**

- `FloorArbiter.handoff(from, to)`：不走抢占表，只要求当前确实是 `from`。
- `AppSession` 持有 `floor` 并注入 `PetSession`；`onDialogState(state)` 把 FSM 状态映射成占用/释放；
  `userFinal()` 用 `handoff('user', 'reply')`（原先是 `claim('reply')`，而 `user` 不可抢占，
  所以那次申请**永远是 false**，话筒卡死在 `user`）。
- 宠物关闭（`proactive == null`）时也建 `FloorArbiter`，至少覆盖 `user`/`reply`/`announce`。

**删掉的状态**：`AppSession.speaker`（与仲裁器重复的影子状态）、`syncFloor()`
（「同步」两份状态，实际是恒等式空转）、`turnBusy()`。

**新增测试**（`tests/floor-arbiter.test.ts`，11 项）：`user → reply` 移交成功；`announce`
不抢 `reply`；用户插话一定拿回话筒；宠物开/关两种配置各跑一遍状态映射。

## 第 2 步：当前轮只有一个代次

**改了什么**

- `TurnContext{ticket}` 贯通 `AgentProvider.reply(user, image, note, turn?)`，
  新增可选 `cancelTurn?(ticket?)`。
- `DialogFsm.onInvalidate(cb)`：`bargeIn()` 与 `close()` 是**唯一**两处上游取消触发点。
- `TurnRunner` 订阅它 → `agent.cancelTurn(ticket)`；插话、快车道胜出、连接结束走同一条管道。
- `DshSession.activeTicket` 比对 `{no, gen}`，迟到的取消按代次丢弃（曾经打死过 harness：
  快模型比 dsh 慢时，取消打到了下一轮头上）。

**删掉的状态**：`FrontedAgent.innerCancelled` / `innerDone` 两个布尔 → `currentGen` / `cancelledGen`
（局部票据闭包，不读字段）。

**新增测试**（`tests/turn-ticket.test.ts`，3 项）：插话后上游收到 cancel；迟到的取消不会杀掉
下一轮；快车道胜出 + 用户插话同时发生时不乱。

## 第 3 步：播完以设备为准

**改了什么**

- `TurnRunner.deviceReportsPlayed`（来自 `caps.played`）+ `devicePlayed()`：设备声明了
  `played` 能力时，`speaking → listening` 由下行回执驱动；估算时长退化成**上限**（兜底）。
- 没声明的设备（v1）保持按估算时长的原逻辑，行为不变。

**真机推翻了一次假设**（11-17 01:46 的真机日志）：那个 v2 设备确实上报 `played`，但它在
**最后一批字节收到**时就回执 —— 4.58 s 的音频 1 s 就报播完，九轮全是这样，间隔与音频长度
无关。按它收尾会让尾音还在放、状态已经回到 `listening`，那段播放里的插话不再算插话。
现在改成：**估算时长是下限，设备回执只能延后**（上限 = 估算 + 3 s，兜「事件永远不来」）。
估算与 played 的先后两种情形都有测试。

**新增测试**（`tests/playback-played.test.ts`，4 项）：回执早于估算不能提前收尾；
回执晚于估算要等设备；没有 `played` 的兜底；事件丢了不挂死。

## 第 4 步：投机的前置条件

**改了什么**

- `DshSession.probeCancelSupport(timeoutMs)`：启动时探一次 `session/cancel` 是否可用。
- `main.ts`：不可用就自动退回串行快车道，并打一条日志说明原因；可用时打
  `投机=开（宿主支持 session/cancel，命中时可作废在途那一轮）`。
- 共享对话日志只在 `docs/design/shared-conversation-log.md` 留一页草稿，不实现。

## 夹带：验收时撞到的崩溃（`2c796f3`）

回放第一次跑就把生产打挂了：快车道推出第一个字 → 立刻 `session/cancel` 掐掉在途的 dsh 那一轮
→ 取消后 dsh 没有可念的文本，`VoiceAgent.reply` 抛「清洗后没有可朗读的内容」→
**这一轮的 promise 已经没人 await**（`commit`/`abandon` 挂得比「掐」晚）→ 未捕获 rejection
→ harness 以 `status=1` 退出，systemd 重启。

修法：投机起跑那一刻就 `dsh.catch(() => undefined)`。派生出来的是另一个 promise，
`await dsh` 该抛的还是抛，`commit`/`abandon` 分支行为不变。

新增测试（`tests/fronted-agent.test.ts` 1 项）：慢车道被取消后立刻 reject，快车道用
`slowSse` 拖长到取消之后才说完 —— **改前整份测试以未捕获 rejection 退出**，改后 510 全绿。

## 验收数据

环境：服务器 Node 22.21.1，生产参数（`timeout=1200`、`silence=200 ms`）。

### `bench/fast_lane`（真 API，`--runs 3`）

| | 改前 | 改后第 1 次 | 改后第 2 次 |
|---|---|---|---|
| 误拦截 | 0/30 | 0/30 | 0/30 |
| 命中 | 39/39 | 39/39 | 39/39 |
| 首字 p50 / p90 | 546 / 695 | 579 / 805 | 500 / 709 |

两次的差就是同一份代码的噪声（第 2 次比改前更快），判据与 prompt 未改。

### `bench/replay`（同一段真机音频回放，各段对比）

| 轮 | ① 停嘴→ASR | ② 判停→开轮 | ③ →首块 | 合计 |
|---|---|---|---|---|
| 1 | 572→385 | 152→625 | 1863→1376 | 2587→2387 |
| 2 | 589→324 | 151→149 | 1583→1276 | 2323→1749 |
| 3 | — | 151→151 | 1610→825 | — |
| 4 | 551→— | 150→623 | 1323→919 | 2024→— |

ASR 逐字一致 4/4 轮。

**② 那两行 625 不是回退**：② 量的是 `turn.start − asr.sentence`，即判停收敛的等待，
在状态机之前。同一句话（第 3 轮）两次回放分别是 624 和 151 —— 是判停「再等一拍」
（[`UtteranceAssembler`](state-machines.md) 的 400 ms 等下文）要不要触发，与本次改动无关；
它不触发时 ② 就是 149–151，和改前完全一样，说明状态机本身不引入可测延迟。
③ 与合计每一轮都更快。

## 没做完 / 没做的

| 项 | 原因 |
|---|---|
| 共享对话日志（快车道 ↔ dsh） | 按任务要求只留设计草稿：[shared-conversation-log](design/shared-conversation-log.md) |
| 真机 `played` 回执验证 | 现有设备在 Hello 里都报「上报 无」，没法声明 `played` 能力；代码路径有单测，真机未验 |
| 回放多会话对照 | 向量库只有 1 份（`~/miai-vectors/`），只能对同一段音频前后比 |
| ADR-0002（虚拟时钟） | 本次没有触碰模拟器的时钟语义，未改 |
| 「定时器改动必须在 Node 22 复跑」写进 `AGENTS.md` | 属流程约定，等拍板 |

## 已知口径问题

- `bench/replay` 的默认 ssh key 名在公开仓脱敏时被改写，跑之前要用
  `MIAI_SSH_KEY` / `MIAI_HOST` / `MIAI_SSH_USER` 覆盖成真实环境的值。
- 回放打的是生产端口。第一次就跑出了上面那个崩溃 —— 它既是事故也是收获：
  这条路径只有真流量才走得到。
