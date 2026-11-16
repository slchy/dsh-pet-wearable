# 状态机一览

以**当前代码**为准（2026-11-17）。旧记录见 [ADR-0001](adr/0001-app-layer-and-pet.md)
与 [ADR-0002](adr/0002-virtual-time-simulator.md)；两者与本文件冲突的地方已在各自文件里
标注取代关系。

这份文档回答四个问题：每台机器有哪些状态、什么事件推动它、转移条件是什么、
**谁持有它、谁驱动它**。最后一节是一条对话从开口到播完的完整时序。

## 0 唯一真相

同一件事只允许有一个模块持有；其他模块通过下面这些入口**读**，不复制。

| 事实 | 唯一持有者 | 读法 |
|---|---|---|
| 话筒归谁 | `AppSession.floor`（`FloorArbiter.owner`） | `floor.busy` / `floor.owner`；宠物经 `PetWorld.floorBusy` 与 `floorTaken` 输入得知 |
| 当前轮次 | `DialogFsm`（`ticket()` → `{no, gen}`） | 上游取消、迟到回调一律拿票据比对（`isStale` / `isCurrent`） |
| 播放进度 | `TurnRunner`（`playedSeen` + 设备 `played` 回执） | 决策「这一轮算说完了吗」只在 `TurnRunner` 内部；`DialogFsm` 只收 `audioDone(ticket)` 这一个结论 |
| 判停中的文本 | `UtteranceAssembler`（`pending`） | 上层只在 `accept` 时拿到整句，拿不到半句 |
| 快车道闸门 | `FrontedAgent.innerMode`（`pass` / `buffer` / `drop`） | dsh 的流式增量按闸门决定直通、缓冲还是丢弃 |
| 宠物状态 | `PetSession.state`（`PetState`） | 纯函数 `brain.step` 产出；执行器无判断 |

> 「话筒」这条有三个历史坑，都已经收进 `FloorArbiter`：①`user` 不可抢占，所以
> `userFinal()` 里直接 `claim('reply')` 永远失败，话筒会卡死在 `user`（改用
> `handoff('user','reply')`）；②`AppSession.speaker` 曾是一份影子状态，与仲裁器重复；
> ③`syncFloor()` 曾试图「同步」两者，但它只是恒等式，什么都没做。②③已删除。

## 1 DialogFsm —— 一轮对话的生命周期

**持有**：`SessionCore.fsm`（`src/session-core.ts` 构造）。
**驱动**：`SessionCore`（ASR 整句、插话、模型要求结束）与 `TurnRunner`
（开轮、首块音频、音频结束）。

### 状态

| 状态 | 含义 |
|---|---|
| `listening` | 话筒在手，等用户说话 |
| `awaiting_shot` | 已答应「拍张高清的」，等图到手再开这一轮 |
| `thinking` | 一轮已开，等上游（dsh / 快车道）出结果 |
| `speaking` | 首块音频已下发，正在播 |
| `ending` | 要收尾了（模型说了再见），本轮播完就关 |
| `closed` | 吸收态：连接已断，任何迟到回调都不得把状态拉回去 |

### 事件与转移

| 事件 | 从 | 到 | 条件 / 副作用 |
|---|---|---|---|
| `beginTurn()` | `listening`、`awaiting_shot` | `thinking` | `no += 1`，发新票据；在 `ending`/`closed` 时返回 `null`，调用方放弃这一轮 |
| `beginAwaitShot()` | `listening` | `awaiting_shot` | 不在 `listening` 时返回 `null` |
| `abortAwaitShot()` | `awaiting_shot` | `listening` | 代次不变 |
| `audioStarted(t)` | `thinking` | `speaking` | 票据过期/不是当前轮则忽略 |
| `audioDone(t)` | `thinking`、`speaking` | `endAfterSpeech ? ending : listening` | 迟到票据按 `{no, gen}` 丢弃 |
| `requestEnd()` | `listening`、`awaiting_shot` | `ending` | 在 `speaking`/`thinking` 只置标志，让告别语播完 |
| `bargeIn(why)` | **仅** `speaking` | `listening` | `gen += 1`（作废排队轮次）→ 通知 `onInvalidate('bargeIn')` |
| `close()` | 任意 | `closed` | 通知 `onInvalidate('closed')` |

票据 `{no, gen}` 是**唯一的轮次令牌**：`no` 每轮 +1，用来丢上一轮迟到的回调；
`gen` 只在插话时 +1，用来作废还排着队的轮次。`onInvalidate` 是**上游取消的唯一触发点**
——`TurnRunner` 订阅它并调 `agent.cancelTurn(ticket)`，所以「插话」「快车道胜出后掐掉慢车道」
「连接结束」走的是同一条取消管道。

```mermaid
stateDiagram-v2
    [*] --> listening
    listening --> awaiting_shot : beginAwaitShot()
    awaiting_shot --> listening : abortAwaitShot()
    listening --> thinking : beginTurn()
    awaiting_shot --> thinking : beginTurn()
    thinking --> speaking : audioStarted(t)
    speaking --> listening : audioDone(t) / bargeIn()
    thinking --> listening : audioDone(t)
    thinking --> ending : audioDone(t) [endAfterSpeech]
    speaking --> ending : audioDone(t) [endAfterSpeech]
    listening --> ending : requestEnd()
    awaiting_shot --> ending : requestEnd()
    ending --> [*]
    listening --> closed : close()
    thinking --> closed : close()
    speaking --> closed : close()
    awaiting_shot --> closed : close()
```

## 2 FloorArbiter —— 话筒

**持有**：`AppSession.floor`（`src/app/session.ts`），无论宠物开不开都建。
**驱动**：`AppSession.onDialogState(state)`（生产）、`turnStart()`/`turnEnd()`（模拟器与直接调用方）、
`PetSession`（宠物经端口申请，不直接仲裁）。

状态就是「谁占着」：`null | user | reply | announce | pet | reflex`。

| 占用者 | 可被谁抢 |
|---|---|
| `user` | 无（用户永远优先） |
| `reply` | `user` |
| `announce` | `user`、敲击（应用层转成 `reflex`/`dismiss`） |
| `pet` | `user`、敲击；`announce` 不抢（等它播完） |
| `reflex` | 任何人 |

| 事件 | 条件 | 结果 |
|---|---|---|
| `acquire(who)` | 空着，或已是同一个人 | 拿到，`true` |
| `acquire(who)` | 按上表可抢 | 换人，`true` |
| `acquire(who)` | 不可抢 | `false`，调用方按 `floorTaken` 处理 |
| `handoff(from, to)` | 当前确实是 `from` | 直接换成 `to`，**不走抢占表** |
| `release(who)` | 当前是 `who` | 清空；不是则 `false` |

`handoff` 存在的唯一理由：`user` 不可抢占，而一轮结束时话筒必须从 `user` 交到 `reply`。
没有它就只能靠影子状态糊过去，那正是被删掉的 `speaker`。

FSM 状态到话筒的映射（`AppSession.onDialogState`）：

| FSM 状态 | 话筒 |
|---|---|
| `thinking` | `reply`（从 `user` 移交） |
| `speaking` | `reply`（整段播放都算应答在说话） |
| `listening` / `ending` / `closed` | 释放 `reply` |
| `awaiting_shot` | 不动（用户随时可以说话，话筒本来就该空着） |

```mermaid
stateDiagram-v2
    [*] --> 空闲
    空闲 --> user : acquire(user)
    空闲 --> reply : acquire(reply)
    空闲 --> pet : acquire(pet)
    空闲 --> announce : acquire(announce)
    空闲 --> reflex : acquire(reflex)
    user --> reply : handoff(user, reply)
    user --> 空闲 : release(user)
    reply --> user : acquire(user)
    reply --> 空闲 : release(reply)
    announce --> user : acquire(user)
    announce --> reflex : acquire(reflex)
    announce --> 空闲 : release(announce)
    pet --> user : acquire(user)
    pet --> reflex : acquire(reflex)
    pet --> 空闲 : release(pet)
    reflex --> user : acquire(user)
    reflex --> reply : acquire(reply)
    reflex --> pet : acquire(pet)
    reflex --> announce : acquire(announce)
    reflex --> 空闲 : release(reflex)
```

## 3 PetBrain —— 主动开口

**持有**：`PetSession.state`（`PetState`，不可变，`brain.step(state, input)` 换成新值）。
**驱动**：设备事件与定时器经 `PetSession` 归一成 `PetInput`；`PetExecutor` 只执行
状态机产出的命令，不做判断。

`PetState` 四个字段：`world`（时钟、在戴、离场、话筒忙不忙、最近记录）、`engagement`
（当前这次主动开口，`null` = 没在开口）、`fired`（已触发候选的去重键）、`seq`（编号）。

主动开口是一个**阶段子机**：`look`（看一眼）→ `compose`（想说什么）→ `listen`（开麦等首帧）
→ `speak`（说）→ `await`（等回话）。每个阶段都有隐含的 `timeout`，报回结局用 `next`/`end`。

| 层 | 内容 |
|---|---|
| L1 顶层 | 戴上了吗、话筒空不空、够不够久 → 这次要不要开口 |
| L2 阶段子机 | 上面五段，每段登记「什么输入、什么结局」 |
| L3 决断表 | 阶段 × 打断（用户开口、敲击、话筒被占、离场）→ 继续 / 跳过 / 结束 |

```mermaid
stateDiagram-v2
    [*] --> 闲置
    闲置 --> 看一眼 : 候选触发（戴上、久无对话、话筒空闲）
    看一眼 --> 想说什么 : 图到手 / 不需要图
    想说什么 --> 开麦 : 想说的话要等回应
    想说什么 --> 说话 : 有话说
    开麦 --> 说话 : 首帧上行（用户在）
    开麦 --> 结束 : 超时没等到人
    说话 --> 等回话 : 说完
    说话 --> 结束 : 被用户打断 / 话筒被抢
    等回话 --> 结束 : 回话结束 / 超时
    看一眼 --> 结束 : 用户开口
    想说什么 --> 结束 : 用户开口
    结束 --> 闲置
```

## 4 UtteranceAssembler —— 判停

**持有**：`voice-session` 的 `assembler`（`src/utterance-assembler.ts`）。
**驱动**：ASR 中间结果 / 整句（`push`）、预测器（`smart-turn`）、定时器。

| 状态 | 含义 |
|---|---|
| `idle` | 没有待判文本 |
| `pending` | 攒着一段文本，定时器在等（等预测器或等下文） |
| `settled` | 已定稿：整句交给了上层，下一句重新从 `idle` 开始 |

| 事件 | 条件 | 结果 |
|---|---|---|
| `push(text)` | 任意 | 追加到 `pending`，重置定时器 |
| 定时器到期 → `evaluate()` | 预测器说「说完」且不满足「等下文」 | `accept`：整句交给上层 |
| 同上 | 结尾像没说完（数字、井号、连词…）或刚收到中间结果 | `extend`：再等 `extendMs`（默认 400 ms），最多 `maxExtensions` 次 |
| 同上 | 预测器不在 | `predictor-unavailable`：按固定时长兜底 |

「再等一拍」是这里唯一的延迟来源，**与状态机无关**：回放里同一句话的
「② 判停→开轮」在 151 ms 和 625 ms 之间跳，就是这一拍要不要等。

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> pending : push(text)
    pending --> pending : push(text) / 重置定时器
    pending --> pending : evaluate() → extend（再等 400 ms）
    pending --> settled : evaluate() → accept
    settled --> idle : 下一句
```

## 5 FrontedAgent 快车道

**持有**：`FrontedAgent.innerMode`（`pass` / `buffer` / `drop`）+ 本地对话窗口。
**驱动**：`TurnRunner` 调 `agent.reply(text, …, {ticket})`；内部先做**本地判据**，再决定
问不问快模型。

| 状态 | 含义 |
|---|---|
| 判定 | 任务类、超长、带图、像长期事实 → 直接 `delegate` 给 dsh，**不问快模型** |
| 投机起跑 | `speculate` 开：dsh 与快模型同时起跑，dsh 的增量先缓冲（`innerMode=buffer`） |
| 快模型流式 | 只看到开头两个字就能判暗号；`[[DELEGATE]]` 判为委派 |
| 胜出 | `commit`：`innerMode=drop`、掐掉在途 dsh（`cancelTurn`）、把这一轮记进窗口 |
| 让路 | `abandon`：放掉缓冲的 dsh 增量（`innerMode=pass`），转用 dsh 的结果 |

| 事件 | 结果 |
|---|---|
| 首字到达 | 立刻掐掉在途 dsh（不为等它整段答完而拖首字） |
| 暗号 `[[DELEGATE]]` 出现 | 一个字都不推给 TTS，转 `abandon` |
| 超时（首字 1200 ms / 整句 2800 ms） | `abandon`，照实报「交给 dsh」 |
| 空答复（清洗后没有可念的文本） | `abandon`，不能哑 |
| 第一句就说完了 | `commit` |

```mermaid
stateDiagram-v2
    [*] --> 判定
    判定 --> delegate : 任务类/带图/像长期事实
    判定 --> 投机起跑 : 闲聊候选且 speculate
    判定 --> 快模型流式 : 闲聊候选且不投机
    投机起跑 --> 快模型流式 : 第一个字
    快模型流式 --> commit : 首字已推出（掐掉 dsh）
    快模型流式 --> abandon : 暗号 / 超时 / 空答复 / 报错
    commit --> [*]
    abandon --> [*]
    delegate --> [*]
```

`commit` 之后 dsh 那一轮**一定**要接住 rejection：它被掐时经常以「清洗后没有可朗读的
内容」收场，而 `commit`/`abandon` 挂得比「掐」晚，中间这段窗口里没人接就是进程级未捕获
（线上真挂过一次，见 [fsm-align-report](fsm-align-report.md)）。

## 6 一轮对话的完整时序

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户（设备）
    participant A as UtteranceAssembler
    participant SC as SessionCore
    participant FSM as DialogFsm
    participant AS as AppSession/FloorArbiter
    participant TR as TurnRunner
    participant FA as FrontedAgent
    participant D as dsh
    participant T as TTS

    U->>A: 上行音频 → ASR 中间结果/整句
    A->>A: 判停（可能要「再等一拍」）
    A->>SC: accept（整句）
    SC->>FSM: bargeIn()? 仅 speaking 成立
    SC->>FSM: beginTurn() → ticket{no, gen}
    SC->>AS: onDialogState('thinking')
    AS->>AS: handoff(user → reply)
    SC->>TR: run(text, ticket)
    TR->>FA: reply(text, …, {ticket})
    par 投机双轨
        FA->>D: 同一句话同时发出
        D-->>FA: 流式增量（缓冲，不推 TTS）
    and
        FA->>FA: 快模型判定
    end
    alt 快车道胜出
        FA->>D: cancelTurn(ticket)（掐掉在途那一轮）
        FA-->>TR: 快车道的答复
    else 交给 dsh
        FA-->>TR: 放掉缓冲 + dsh 的答复
    end
    TR->>FSM: audioStarted(ticket) → speaking
    TR->>T: 逐句/整段合成
    T-->>U: 首块音频
    TR->>TR: 播放进度（设备 played 回执 或 时长估算）
    TR->>FSM: audioDone(ticket) → listening
    TR->>AS: onDialogState('listening')
    AS->>AS: release(reply)
```

### 分支 A：用户插话

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant SC as SessionCore
    participant FSM as DialogFsm
    participant TR as TurnRunner
    participant D as dsh

    U->>SC: 说话（speaking 期间）
    SC->>FSM: bargeIn(text)
    FSM->>FSM: gen += 1 → listening
    FSM->>TR: onInvalidate('bargeIn')
    TR->>D: cancelTurn(ticket)
    Note over D: 迟到的增量按 {no, gen} 丢弃<br/>下一轮的票据不会被打到
    TR-->>SC: 本轮结束（playedSeconds 记已播部分）
    SC->>FSM: beginTurn() → 新票据（gen 已 +1）
```

### 分支 B：快车道胜出

```mermaid
sequenceDiagram
    autonumber
    participant TR as TurnRunner
    participant FA as FrontedAgent
    participant D as dsh
    participant T as TTS

    TR->>FA: reply(text, …, {ticket})
    FA->>D: 投机起跑
    FA->>FA: 快模型推出第一个字
    FA->>D: cancelTurn(ticket)
    FA->>FA: innerMode = drop（丢掉 dsh 的缓冲增量）
    FA-->>TR: 快车道的整句
    TR->>T: 合成并下发
    D-->>FA: rejection（被掐后没文本）／或已作废
    Note over FA: 起跑时就挂了 catch<br/>迟到的结局不会带走进程
```
