# ADR-0001 应用层与宠物层

- 状态：**部分被取代**（2026-11-17）—— 状态机与话筒的**现状**以
  [state-machines](../state-machines.md) 为准；本文件保留决策当时的过程与理由
- 已被取代的部分：§6 话筒仲裁（`user → reply` 是**移交** `handoff()`，不是抢占；
  `AppSession` 的 `speaker` 影子状态与 `syncFloor()` 已删除）、§9 与现状的差异表（当年是
  「待改」，现在已改完）
- 仍然有效：§2 决策总览的分层、§4 宠物层结构、§5 宠物状态机、§7 敲击、§8 模拟器
- 修订：2026-11-14 增加 `listen` 阶段，先开麦、等到首帧上行音频再开口（§5.4–§5.6、§6、§8）
- 范围：`AliyunConnection` 里的应用逻辑拆分、宠物层结构、离线模拟
- 不在范围：线协议（v1/v2 握手、帧格式）、真机联调

## 1 背景

应用逻辑（对话判定、拍照、播报、主动开口）和通讯层（socket、ffmpeg、STT/TTS）接在同一个
`AliyunConnection` 里，并直接读真实时间（`turn-runner.ts` 有 12 处 `Date.now()`/`sleep()`）。
后果：验证"安静 20 分钟后搭话"要真等 20 分钟、要插着设备。AI 没法自动跑。

宠物层现在是几块散件：`PetTiming`（判时机）、`planProactive`（定做法）、`tickPet()`/`runProactive()`
（执行，散在连接里），主动开口没有生命周期，也没有结果记录。

## 2 决策总览

1. 应用层 `PetSession` 只依赖四个端口，生产和模拟各实现一份，**不为模拟分叉逻辑**。
2. 宠物层 = 纯状态机 `PetBrain` + 无判断的执行器 `PetExecutor`。状态机只产出**意图**。
3. 状态机分三层：顶层模式、主动开口（engagement）的阶段子机、阶段 × 打断的决断表。
   扩展点全部是**登记表**，加东西不改状态机内核，漏填由编译器报错。
4. 读不到佩戴状态（`wearing !== true`，含 `null` 和设备不报佩戴）就**不主动开口**。

## 3 分层与端口

```text
应用层 PetSession   SessionCore、PhotoInbox、FloorArbiter、PetBrain、PetExecutor、播报队列
──────── 端口 ────────
Clock    now(): number          单调毫秒，量时长
         localHour(): number    本地墙钟小时，判深夜
         after(ms, fn): Cancel
Voice    speak(text, emotion, signal) → Promise<'done' | 'cut'>
Device   call(DeviceCall): void
Agent    ask(text, image | null, source) → Promise<AgentReply>
──────── 适配层 ────────
生产  AliyunConnection：transport + wire v1/v2 + 上行音频流水线 + STT/TTS
模拟  SimHost：虚拟时钟 + 脚本设备 + 文本级 Voice + 脚本 agent
```

- 应用层输入只有：`userPartial`、`userFinal(text)`、`DeviceEvent`、图片到达、`micOpened`、连接关闭。
  `micOpened` 由适配层产出：发出 `listen.start` 之后收到的第一帧上行 `Audio`。
  判停、合句、能量门依赖音频，留在适配层。
- "播没播完"由 `Voice` 决定。生产先按时长估算，以后换 `played` 事件；模拟按字数推进虚拟时钟。
- `source` 取 `{kind:'user'}` 或 `{kind:'pet', reason}`。agent 适配器负责映射到 dsh
  （现阶段 `pet` 映射成 `user`，正文保留"系统提示"那半句；见 §9）。
- 应用层**禁止**直接调 `Date.now()`、`performance.now()`、`new Date()`、`setTimeout`。

## 4 宠物层结构

```text
DeviceEvent / 用户动静 / 话筒 / tick ──► PetBrain.step(state, input) ──► { state', intents[] }
                                              ▲                              │
                                              └──── PhaseResult（输入） ◄── PetExecutor
```

- `PetBrain`：**纯 reducer**，`step(state, input) → {state, intents}`。不读时钟（`now` 在输入里）、
  不调 I/O、不用随机数。以后要随机（让时机不那么机械），随机种子作为输入传入。
- `PetExecutor`：按意图执行副作用，结果作为输入回灌给 `PetBrain`。**执行器不做任何判断**，
  "接下来做什么"全在状态机里。
- 单线程：所有输入进同一个队列，按顺序 `step`。执行器从不直接改状态。
- 每个输入和每个意图都进会话档案（`pet.in` / `pet.out`），离线可逐条重放。

职责边界：宠物层只决定**没人找它的时候要不要开口、怎么开口**。用户说话后的应答归 `SessionCore`，
后台任务汇报归播报队列，提示词措辞归 agent 适配器，音频归适配层，记忆归 dsh 会话。

## 5 状态机

三层，每层一个扩展面：

| 层 | 内容 | 扩展方式 |
|---|---|---|
| L1 顶层 | `idle` / `engaging` | 不扩展。只有两态，加态的需求都应落到 L2/L3 |
| L2 engagement 子机 | 一次主动开口按 `plan: PhaseId[]` 顺序走阶段 | 加触发器、加阶段 |
| L3 决断表 | 阶段 × 结果、阶段 × 打断 → 决断 | 加行、加列，编译器强制填满 |

### 5.1 状态

```ts
interface PetState {
  readonly world: PetWorld;                 // 由输入归约出的事实
  readonly engagement: Engagement | null;   // null ⇔ idle
  readonly fired: ReadonlySet<string>;      // 已触发过的候选键（去重）
  readonly seq: number;                     // engagement 编号
}
interface PetWorld {
  readonly now: number; readonly localHour: number;
  readonly wearing: boolean | null;         // 设备不报佩戴 ⇒ 恒为 null
  readonly donnedAt: number | null; readonly lastAwayMs: number | null;
  readonly battery: number | null;
  readonly lastUserAt: number | null;       // 用户最近一次说话
  readonly lastVoiceAt: number | null;      // 宠物或播报最近一次出声
  readonly floorBusy: boolean; readonly announcePending: boolean;
  readonly caps: DeviceCapabilities;
}
interface Engagement {
  readonly id: string; readonly reason: Reason; readonly key: string;
  readonly plan: readonly PhaseId[]; readonly at: number;  // 当前阶段下标
  readonly step: number;                    // 每进一个阶段 +1，用于丢弃过期结果
  readonly startedAt: number; readonly bag: EngagementBag; // 阶段间传递的数据（图片、回复）
}
```

### 5.2 L1 顶层

| 当前 | 输入 | 守卫 | 下一个 | 意图 |
|---|---|---|---|---|
| `idle` | `tick` | 有候选触发器且全部闸门通过（§5.3） | `engaging` | `phase.enter(plan[0])` |
| `idle` | 其它 | 无 | `idle` | 只更新 `world`，可能产出 `reflex`（§7） |
| `engaging` | `phaseResult` / 打断 | 决断表（§5.5） | `engaging` 或 `idle` | 见决断 |
| 任意 | `closed` | 无 | `idle` | 有 engagement 时记 `aborted` |

`idle → engaging` **只在 `tick` 上发生**，事件输入只更新事实。这样"什么时候开口"只有一个入口，
重放时一眼可查。事件后需要快速反应（戴回打招呼）就让适配层在事件后立刻补一个 `tick`。

### 5.3 触发器登记表（扩展点 A）

```ts
interface Trigger {
  readonly reason: Reason;                         // 'greet' | 'chatter' | 以后加
  readonly priority: number;                       // 同一 tick 多个候选时取大者
  readonly gates: readonly GateId[];               // 引用闸门表，不内联条件
  readonly plan: (w: PetWorld) => readonly PhaseId[];
  candidate(w: PetWorld, fired: ReadonlySet<string>): Candidate | null;
}
interface Candidate { readonly key: string; readonly context: Readonly<Record<string, unknown>> }
```

- `key` 用于去重：同一次离场只打一次招呼（`greet:${donnedAt}`），同一段安静只搭一次话
  （`chatter:${idleAnchor}`）。被闸门挡下的候选**不**写入 `fired`，闸门放开后还能触发。
- **闲置计时和最小间隔是两回事，分开算**：
  - 闲置锚点 `idleAnchor = max(lastUserAt, donnedAt)`，只看**用户**的动静（说话、普通敲击、戴回）。
    两者都为 `null` 时没有锚点，不搭话。
  - 宠物和播报出声只更新 `lastVoiceAt`，由 `minGap` 管，**不**重置闲置计时。
  - 宠物搭完一次话、用户没理，锚点不变，键已在 `fired`，所以同一段安静不会搭第二次；
    用户开口或重新戴上才开新的一段。
  - 修订原因：原先锚点里含 `lastVoiceAt`，而搭话门槛（20 min）大于最小间隔（10 min），
    `minGap` 永远挡不住任何东西，不变量 ③ 也不可能被违反（2026-11-14 验收时的变异测试）。
- 闸门是**命名的纯谓词**，单独一张表 `GATES: Record<GateId, (w) => boolean>`，被挡时档案记下闸门名。

| 闸门 | 通过条件 |
|---|---|
| `worn` | `wearing === true`（`null` 或设备不报佩戴都不通过） |
| `floorFree` | `!floorBusy && !announcePending` |
| `notQuietHours` | `localHour` 不在 23–7 |
| `batteryOk` | `battery === null \|\| battery > 20` |
| `minGap` | `lastVoiceAt === null \|\| now - lastVoiceAt >= 10 min` |

| 触发器 | 优先级 | 候选条件 | 闸门 | 计划 |
|---|---|---|---|---|
| `greet` | 20 | 刚戴回，且 `lastAwayMs >= 5 min` | `worn` `floorFree` | `[look?, compose, listen?, speak, await]` |
| `chatter` | 10 | `now - idleAnchor >= 20 min` | 五个全有 | 同上 |

`minGap` 实际起作用的场合是播报：用户安静 19 分钟时播报说完，搭话从第 20 分钟推到第 29 分钟。

打招呼不受深夜、电量、最小间隔限制，这与现在的 `PetTiming` 一致。`look` 只在
`canCaptureUnprompted(caps, 'glance')` 时进入计划；`listen` 只在 `caps.listenStart` 时进入计划。

### 5.4 阶段登记表（扩展点 B）

```ts
interface PhaseSpec<R extends string> {
  readonly id: PhaseId;
  readonly results: readonly R[];          // 本阶段可能报回的结果
  readonly deadlineMs: (w: PetWorld) => number | null;  // null = 无截止
  readonly onResult: Record<R, Verdict>;   // 必须覆盖 results 的每一项
  readonly onInterrupt: Record<Interrupt, Verdict>;  // 必须覆盖每一种打断
}
type Interrupt = 'userActivity' | 'tap' | 'presenceLost' | 'floorTaken';
type Verdict =
  | { kind: 'next' }                        // 进 plan 的下一阶段（plan 末阶段不允许出现，见 §5.6）
  | { kind: 'end'; outcome: Outcome; dismiss?: boolean; closeMic?: boolean };
```

| 阶段 | 执行器做什么 | 结果 | 截止 |
|---|---|---|---|
| `look` | `capture{id, intent:'glance', deadlineMs}` | `got` `none` | `PET_CAPTURE_TIMEOUT_MS`，默认 4 s |
| `compose` | `agent.ask(context, image, {kind:'pet', reason})` | `reply` `declined` `error` | 15 s |
| `listen` | `listen.start{maxMs: 截止 + 估算时长 + 窗口}`，收到 `micOpened` 报 `opened` | `opened` | `PET_MIC_OPEN_TIMEOUT_MS`，默认 1.5 s |
| `speak` | `voice.speak` | `done` `cut` | 无（由 `Voice` 结束） |
| `await` | 什么也不做，只计时 | `expired` | `PET_REPLY_WINDOW_MS`，默认 8 s |

- 截止由**执行器**计时，到点报回 `timeout`。`timeout` 是每个阶段隐含的结果，`onResult` 也必须覆盖它。
- 每次进入阶段 `step + 1`，执行器报结果时带上 `step`。`step` 不等于当前值的结果直接丢弃，
  所以晚到的照片、晚到的 agent 回复不会串进下一阶段或下一次 engagement。
- `declined`：回复为空，或是约定的跳过标记（由 agent 适配器识别，状态机只看结果名）。
- `listen` 排在 `compose` 之后：agent 想话最长 15 s，这段时间不该开着麦。
  小米拉起会话实测约 0.62 s 出首帧上行（`Aivs` id=10），1.5 s 是留出的余量。
- `listen` 只决定"能不能被插话"，不决定"能不能说"：超时照样开口，结局里记 `micOpened: false`。
  小米没有会话时也能出声，宁可听不见插话，也不能沉默。
- `micOpened` 以首帧上行音频为准，不用手机回执。`Queued` 和 SAR ACK 只证明命令进了队列或到了传输层，
  不证明设备在采集。
- `look` 维持 4 s 截止，不与 `listen` 合并压缩：主动开口没有人在等，压短只会让带图开口的比例变低。

### 5.5 决断表（L3）

结果列：

| 阶段 | 结果 → 决断 |
|---|---|
| `look` | `got` / `none` / `timeout` → `next`（`none` 和 `timeout` 时 `bag.image = null`） |
| `compose` | `reply` → `next`；`declined` → `end(declined)`；`error` / `timeout` → `end(failed)` |
| `listen` | `opened` / `timeout` → `next`（`timeout` 时记 `micOpened: false`） |
| `speak` | `done` → `next`；`cut` → `end(engaged)` |
| `await` | `expired` / `timeout` → `end(ignored)` |

打断列：

| 阶段 | `userActivity` | `tap` | `presenceLost` | `floorTaken` |
|---|---|---|---|---|
| `look` | `end(abandoned)` | `end(abandoned)` | `end(abandoned)` | `end(abandoned)` |
| `compose` | `end(abandoned)` | `end(abandoned)` | `end(abandoned)` | `end(abandoned)` |
| `listen` | `end(abandoned)` | `end(abandoned, closeMic)` | `end(abandoned, closeMic)` | `end(abandoned)` |
| `speak` | `end(engaged)` | `end(dismissed, dismiss, closeMic)` | `end(aborted, dismiss, closeMic)` | `end(aborted)` |
| `await` | `end(engaged)` | `end(dismissed, closeMic)` | `end(aborted, closeMic)` | `end(engaged)` |

结果列里 `await` 的 `expired` / `timeout` 同样带 `closeMic`。

`closeMic` 表示执行器发 `listen.stop`，只在本次 engagement 发过 `listen.start` 时生效。
用户开口（`userActivity`、`cut`、`floorTaken`）的格子都**不**关麦：用户正在这个会话里说话，
会话交给对话层继续。`listen` 里用户先开口按 `abandoned` 算，因为宠物还没出声。

`await` 里的 `floorTaken` 只可能是用户通过其他入口发起了对话（唤醒词、长按），所以按 `engaged` 算。
`speak` 里的 `floorTaken` 是被更高优先级的人抢了话筒，按 `aborted` 算。

**完整性在编译期保证**：`onResult` 和 `onInterrupt` 是 `Record`，加一个阶段、结果或打断，
没填的格子直接是类型错误。另配一个单元测试遍历整张表，断言每格都是合法决断。

### 5.6 结局与计划校验

```ts
type Outcome = 'engaged' | 'ignored' | 'dismissed' | 'declined' | 'abandoned' | 'failed' | 'aborted';
```

| 结局 | 含义 | 算不算出过声（更新 `lastVoiceAt`） |
|---|---|---|
| `engaged` | 用户在播放中或回应窗口内开口 | 算 |
| `ignored` | 说完了，窗口内没人理 | 算 |
| `dismissed` | 被敲击打断 | 算 |
| `declined` | 模型选择不说 | 不算，但候选键写入 `fired` |
| `abandoned` | 出声前用户已有动静 | 不算，候选键不写入 `fired` |
| `failed` | agent 出错或超时 | 不算，候选键写入 `fired`（不重试，免得反复撞错） |
| `aborted` | 摘下、断线、话筒被抢 | 已出声则算 |

每次 engagement 结束**恰好**产出一条 `pet.outcome{id, reason, outcome, phase, durations, micOpened?}`。
`micOpened` 只在计划含 `listen` 时出现。

计划校验（`validatePlan`，启动时对每个触发器跑一遍所有能力组合）：
- 计划非空，最后一个阶段的所有决断都是 `end`；
- `speak` 必须在计划里，而且排在 `compose` 之后；
- `listen` 若在计划里，必须紧挨在 `speak` 之前；
- 阶段不重复。

### 5.7 加东西要动哪里

| 要加 | 改动 | 不用改 |
|---|---|---|
| 新触发器（如"到点提醒""电量低告知"） | `TRIGGERS` 加一项；如有新条件，`GATES` 加一项 | reducer、阶段、执行器 |
| 新闸门（如"会议中不打扰"） | `GATES` 加一项，相关触发器的 `gates` 引用它 | 其它一切 |
| 新阶段（如 `cue`：开口前先播提示音） | `PHASES` 加一项，执行器加一个处理函数，相关 `plan` 插入 | reducer、其它阶段 |
| 新打断源（如"手机来电"） | `Interrupt` 加一项，编译器列出所有要补的格子 | reducer |
| 新结局 | `Outcome` 加一项，补 §5.6 的出声规则 | 其它一切 |
| 新输入事实 | `PetWorld` 加字段，在 `reduceWorld` 里归约 | 触发器只在用到时读 |

reducer 内核（取候选、过闸门、推进阶段、落结局）在这些扩展中**不变**。
需要改内核时说明扩展面设计错了，应先回到本 ADR 修订。

## 6 话筒仲裁 `FloorArbiter`

> **已被 [state-machines §2](../state-machines.md) 取代**（2026-11-17）。当年的表里
> `user` 「定稿后转给 `reply`」写得对，但实现是 `claim('reply')` —— `user` 不可抢占，
> 所以那次申请永远是 `false`，话筒卡在 `user` 上；`AppSession.speaker` 这份影子状态又
> 遮住了这个错误。现在是一条 `handoff(from, to)` 原语，`AppSession` 不再有影子状态，
> 占用/释放完全由 `DialogFsm` 的状态转移驱动。

宠物只申请，不仲裁。仲裁在应用层，宠物通过 `world.floorBusy` 和 `floorTaken` 打断得知结果。

| 占用者 | 何时占用 | 可被谁抢 |
|---|---|---|
| `user` | 第一个 partial 到达；定稿后转给 `reply` | 无 |
| `reply` | 对话层应答 | `user` |
| `announce` | 后台任务汇报 | `user`、敲击 |
| `pet` | engagement 的 `listen` 与 `speak` 阶段 | `user`、敲击、`announce` 不抢（等它播完） |
| `reflex` | 快反射短音 | 任何人 |

- `look` 和 `compose` 阶段**不占**话筒，进 `listen`（计划里没有就是 `speak`）时申请。申请失败按 `floorTaken` 处理。
- 设备 `listenStart` 时，播报也先发 `listen.start`、等 `micOpened`（同样 1.5 s 截止，超时照播）再开口，
  这样播报一开口就能被插话。播报不在宠物状态机里，这一步由播报队列自己做。
- 播报说完会更新 `lastVoiceAt`：播报本身不受最小间隔约束，但经 `minGap` 把下一次搭话推迟到
  播报后 10 分钟；它不重置闲置计时（§5.3）。

## 7 敲击

| 状态 | `summon` | 结果 |
|---|---|---|
| `opensSession: true`（小米长按） | 宠物层不处理 | 交给对话层 |
| engagement 在 `listen` | 打断 `tap` | 关麦，`abandoned` |
| engagement 在 `speak` | 打断 `tap` | 停播、关麦，`dismissed` |
| 播报在播 | 宠物层产出 `dismiss` | 停播报，记 `announce.dismissed` |
| 其它 | 宠物层产出 `reflex{cue:'here'}` | 无素材时只记日志 |

## 8 模拟器

- 场景是 TypeScript：带时间点的事件脚本 + 期望。虚拟时钟驱动，"20 分钟"几毫秒跑完。
- 两种模式：脚本 agent 进 `npm test`；`--agent dsh` 的真模型模式不进 CI，只用于评估开口质量。
- 每个场景自动检查：
  1. 话筒不空闲时宠物不出声；
  2. 同时最多一个 engagement；
  3. 两次出声（含播报）间隔不少于 `minProactiveGapMs`，播报本身不受约束；
  4. 深夜、低电量时不搭话，打招呼不受此限；
  5. `wearing !== true` 时不主动开口；
  6. `abandoned` 的 engagement 一个音节都不出；
  7. 每个 `id` 恰好一条结局记录；
  8. `look` 不超过截止时间，超时开口时 `bag.image` 为 `null`；
  9. 主动开口的那一轮 `source.kind === 'pet'`；
  10. 相同输入序列，`step` 的输出序列相同；
  11. 计划含 `listen` 时，宠物开口不早于本次 engagement 的 `listen` 出结果（`opened` 或 `timeout`）。
- 另外：把会话档案里的 `pet.in` 重放一遍，`pet.out` 必须逐条一致。

## 9 与现状的差异

> **已完成**（2026-11-17）。下表是当年的差距清单，现在逐条都改完了，实测口径见
> [fsm-align-report](../fsm-align-report.md)；各台机器的当前状态见
> [state-machines](../state-machines.md)。

| 现状 | 本 ADR |
|---|---|
| `PetTiming.tick` 把 `wearing === null` 当在场 | `worn` 闸门要求 `wearing === true`，读不到就不主动开口 |
| 开口前发 `listen.start`，不等结果 | 计划含 `listen` 时，等首帧上行或 1.5 s 截止再开口 |
| 主动开口没有生命周期，只有 `proactiveBusy` 布尔 | engagement 子机 + 七种结局 |
| 提示词在 `proactive.ts` 的 `proactivePrompt()` | 宠物层只传结构化 `context`，措辞归 agent 适配器 |
| 话筒判定散在 `tickPet()` 的四个条件里 | `FloorArbiter` 一处 |
| 时钟直读 `new Date().getHours()` | `Clock` 端口 |
| 播完靠 `Date.now()` 估算，散在 `turn-runner.ts` | `Voice` 端口，估算收进生产实现 |

## 10 实现顺序

1. 定义端口与 `PetState`/`PetIntent`/`PhaseResult` 类型；
2. `PetBrain` reducer + 触发器、闸门、阶段三张表，对照现有 `PetTiming` 行为写重放测试
   （除 `wearing === null` 外行为不变）；
3. `validatePlan` 与决断表完整性测试；
4. `PetExecutor` + `FloorArbiter`，把 `tickPet()`/`runProactive()` 的逻辑搬进来；
5. `SimHost` 与第一个场景（安静久了搭话），`npm run sim` 零网络、零密钥、零 ffmpeg；
6. 其余场景：打招呼、拍照超时、插话、敲击打断、播报让位、深夜、低电量、读不到佩戴；
7. `AliyunConnection` 退化为适配层，只剩接线。

## 11 否决的方案

- **中途 v1→v2 升级**：上行解码、判定核、收件箱在建连接时按能力定死，升级要重建它们。
  不在本 ADR 范围，记录于此以免被重新提出。
- **宠物层自己存记忆或心情**：记忆归 dsh 会话，情绪由模型逐句给（`src/emotion.ts`），
  再存一份必然两边不一致。
- **执行器里写分支判断**：判断一旦散进执行器，状态机就不再是单一事实来源，重放失效。
- **被忽略后自动拉长间隔**：先只记录结局，看 `engaged` 比例再决定是否加规则。
  规则越多越难解释它为什么沉默（`pet-timing.ts` 的注释已有此警告）。

