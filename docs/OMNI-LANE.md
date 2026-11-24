# omni 一体化车道

> **状态：现行。** 管道开关、扁平前台和单泵按仓库里的 `VOICE_PIPELINE=live` 实现写
> （§二、§三、§六、§十、§十二）。§零的同场数字、§五的协议事实、以及各节里的探针结论
> 保持原测量，不改写成新拓扑的成绩。
> 初版设计稿（S0，只量不发声）与本形态的偏差集中在 §十二，别拿旧稿子对账。

## 零、一句话

把「封段 → 首块音频」整段交给 `qwen3.8-omni-flash-realtime`：**声音进、声音出**，
一次 WS 往返替掉我们自己的 `①b 定稿 + ② 开轮 + ③ 文本模型 + TTS 首块`。

真机同场同口径（`gate.close` 停嘴 → 首块到达服务器）：

| 场次 | omni p50 / p90 | 级联 p50 / p90 |
|:---|:---:|:---:|
| `20261122-174217` | **716 / 758**（n=5） | 880 / 1285（n=10） |
| `20261122-174823` | **776 / 932**（n=15） | 976 / 1883（n=6） |

**p50 省 164–200 ms，p90 省 527–951 ms。** p90 才是它真正值钱的地方。

---

## 一、它替代的是哪一段

```text
我们：停嘴 ─①a─▶ 封段 ─①b─▶ 定稿 ─②+③─▶ 首块
                                  └── 835 ──┘        ← omni 替掉的是这一段

omni：     封段 ────── 670 ──────▶ 首块
```

### 1.1 挂载点必须是「封段」，不能是「定稿」

实测（`tmp/omni-probe/late-create.cjs`，9 个样本）：**`response.create` 每推迟 1 ms，
首块就晚 1 ms**。推迟 241 ms（等判停出结论）首块从 664 掉到 887，而我们级联是 835。

> **`create` 的决策预算只有 ~171 ms。**

这条决定了三件事：

1. `commit` 与 `response.create` 必须**连发**（pipe 形态），不能等 `committed` 回执。
2. 挂载点是 `onCommit`（我们自己发封段的时刻），不是 `onSentence`。
3. `seal()` 必须在**车道封段**（`VOICE_COMMIT_MS`，默认 20 ms）那一刻发出
   （[voice-session.ts](../src/voice-session.ts) 的 `onCommit`）。**ASR 封段已经拆成
   另一条闸**（`VOICE_STT_COMMIT_MS`，默认 150 ms）：那条闸才发 `stt.commit()`。
   两者不再是同一行，档案里用 `asr.commit.lane_seq` 配对 —— 序号不能混用，
   混了之后「omni 的 `audio_ms` 从哪一刻起算」就说不清，整个口径作废。

好在两条闸都归我们控：`VOICE_COMMIT_MS` 默认 20 ms，`utterance-assembler.ts` 零改动。

### 1.2 pipe 形态的固有代价

`create` 一发出去就收不回来。并段轮（用户句中停顿）必然先答了前半句，只能 `cancel` ——
此时 omni 的服务端上下文里躺着「前半句 → 被砍掉一半的助手回复 → 后半句」。

**这是买那 165 ms 付出的价格，不是实现缺陷。** 缓解手段见 §十二。

---

## 二、分层

启动期先在 [`pipeline-mode.ts`](../src/pipeline-mode.ts) 把这次会话收成**一条**管道：
`VOICE_PIPELINE=live` 或 `cascade`（未写时才按旧的 `OMNI_SHADOW` / `OMNI_ANSWER` 推断，
细则见 [OPERATIONS.md](./OPERATIONS.md)）。同一次会话里两条严格互斥。

显式 `live`，以及推断出来的 `live`，都把 `useCascadeFastLane` 固定为 false、
`cascadeKey` 固定为空串。前台是 [`LiveOrchestrator`](../src/pipelines/live-orchestrator.ts)，
文本快车道的 `FastLlmClient` / `PrefetchSlot` 只出现在 `cascade` 那条管道里。
逐轮从 live 换到文本快车道没有代码路径。

```text
┌─ 5  装配层   pipeline-mode.ts     VOICE_PIPELINE=live | cascade
│              main.ts              环境闸 / STT 兼容闸 / 启动自检
├─ 4  宿主层   voice-session.ts     挂点、连接生命周期、后台汇报交进空窗
│              pipelines/live-orchestrator.ts
│                                    Pure Live 唯一前台（toEngine → LiveVoiceEngine）
│              background-task-bus.ts
│                                    tool_call / early_rule / 识图 / 静默记忆 / dsh 自有后台
│              turn-runner.ts       run() 只消费 FastVoiceEngine.respond()
│              app/dialog.ts        播报空窗（listening + FloorArbiter + 800 ms 静音）
├─ 3  车道层   omni-shadow.ts       willServe / claim / speakFromText / discard / injectAnswer
├─ 2  段层     omni-shadow.ts       mute 状态机、ring、pipe 封段
└─ 1  传输层   omni-shadow.ts       WS、握手、事件流、计时、usage
```

`cascade` 是另一次启动才装上的管道（[`pipelines/cascade-agent.ts`](../src/pipelines/cascade-agent.ts)）：
短闲聊走 `FastLlmClient`，投机在 `PrefetchSlot`，出话引擎是 `CascadeVoiceEngine`。
那条管道里 `routeTurn()` 的 `live` 档恒为 off，不认领 omni 音频。
`OMNI_SHADOW=1` 且 `OMNI_ANSWER=off` 时，cascade 仍可以挂一条只读影子，只测量、不发声。

2/3/1 三层在同一个文件里（[omni-shadow.ts](../src/omni-shadow.ts)），
但它们**互不知道对方的存在**：传输层不知道有「段」，段层不知道有「车道」，
车道层不知道有 `TurnRunner`。分开文件会更"干净"，但这条通路的时序是全耦合的，
拆开只会让「一次改动要跳三个文件」——所以刻意留在一个文件里，靠注释分节。

[`src/engines/live-voice-engine.ts`](../src/engines/live-voice-engine.ts)
把 `FastLaneAudioLane`（生产上是 `OmniShadow`）适配成 `FastVoiceEngine`。
内核和 `TurnRunner.run()` 只认 `respond()` 吐出的 `EngineEvent`。
`LiveOrchestrator.toEngine()` 包在这层外面：识图、早规则、`tool_call`、静默记忆从这里
进 [`BackgroundTaskBus`](../src/background-task-bus.ts)，前台轮不等它们。
`cascade` 的流式合成失败退回整段，发生在 `CascadeVoiceEngine.respond()` 里面；
延迟埋点（`tts.first`、`turn.end` 的 `dsh_ms` / `audio_s`）留在 `TurnRunner`，引擎只报事实。

---

## 三、车道层契约

> **硬约束：`live` 会话里，车道接得住的前台轮由 omni 答。**
> `willServe()` 的判据是**宽**的（宁可等，也不放）。为假时
> `LiveOrchestrator` 同步问 dsh，再用本层 TTS 把那句说出来（`fallbackDsh`，
> `turn.end` 的 `path=dsh`）。这是整条车道接不上时的兜底，和 `cascade` 管道的
> 文本快车道是两次启动里的两种形态，同一次会话不会从一条换到另一条。
>
> 旧档案里 `agent.lane` 仍用 [`fsm-trace.ts`](../src/fsm-trace.ts) 的 `isLaneFallback()` 读：
> `why === 'live-down'`（路由自己说车道挂了），或者
> `has_lane === true && lane_ok === false && lane !== 'dsh'`（车道挂着却没接住）。
> **这个数应当是 0**，§12.4 列了剩余路径。Pure Live 的 `LiveOrchestrator` 不打
> `agent.lane`，同一件事看 `turn.end.path`。
>
> `text_ok` 这一栏**已经没了**：路由搬进 `routeTurn()` 之后，`agent.lane` 报的是
> `{has_lane, lane_ok, ok, lane, why}` 加 `explain()` 摊开的排障字段。旧的
> `lane_ok:false && text_ok:true` 只剩审计器对老会话的向后兼容，别拿它当现行判据。

前台仍是这三个方法。后台汇报走同一条连接上的 `speakFromText`，空闲条件与 §4.2 是同一条。

```ts
interface FastLaneAudioLane {
  willServe(): boolean;               // 纯读
  claim(): AgentAudioAnswer | null;   // 认领，一份只给一个消费者
  discard(): void;                    // 这一轮不采纳：cancel + 删半句
  interrupt?(): void;                 // 播到一半被打断：cancel 但保留
  injectAnswer?(userText: string, said: string, kind?: InjectKind): void;  // 回注（kind = 听没听到）
  explain?(): Record<string, unknown>;// 只进档案，不参与决策
  canSpeakBackground?(): boolean;     // ready、无在途回复、无排队封段、dirtyBytes === 0、serve 不是 off
  speakFromText?(                  // 空窗：user 文本 + response.create，忙则返回 null
    prompt: string,
    meta?: { taskId?: string; query?: string },
  ): AgentAudioAnswer | null;
  cancelBackgroundSpeech?(): void;    // 只掐 origin === 'announce'
}
```

**车道层仍不含「要不要用」的判断。** `live` 前台不调用 `routeTurn()`。
分支是纯函数 `decideLiveTurn()`（取消、识图、钟点、`live_with_bg_guard`、
`live_direct`、`fallback_dsh`），不派单、不碰车道。`willServe()` 为真走封段认领；
为假但 `canAnswerText()` 还能答就 `answerFromText()`；两条都没有才 `fallbackDsh`。
`TurnRunner` 也不再先问 `willServeAudio()` 再决定开不开流式 TTS —— 出话只有
`respond()` 一条泵。`cascade` 里 `routeTurn()` 的 `live` 档恒为 off，14 字 / key /
历史深度只作用于那条文本窗。omni 吃的是整段音频，那些前提对它没有物理依据。
健康度只留一个布尔，是为了避免「文本路预跑过、omni 也答了」这种同一个问题付两次钱。

### 3.1 `AgentAudioAnswer` 的 `chunks` 是 async generator

```ts
readonly chunks: AsyncIterable<Buffer>;
readonly sampleRate: number;
transcript(): string;
delegateReason?(): DelegateReason | null;
delegateText?(): string | null;   // tool_call 里那句「用户要什么」，转交时当正文
```

不是数组、不是 `Promise`。两个原因：

- **认领时首块通常还没到**（认领在定稿 ~220 ms，首块 600–760 ms），所以必须能等。
- **判停延拍时认领会晚到 700–870 ms**，那时首块**已经发过来了**。
  所以音频从 `seal()` 那一刻就开始攒，不等认领（[`omni-shadow.ts`](../src/omni-shadow.ts)
  的 `response.audio.delta` 分支：先 push 进 `resp.audio` 再唤醒读端）。
  不缓冲的版本会吞掉句首一两个字。

### 3.2 `transcript()` 是活 getter，不是 `Promise<string>`

被打断时 `Promise` 永远不 resolve，而**当前值正好是「已经播出去的那部分」**——
`said` 审计、记忆回写、打断续话要的就是它。

`claim()` 交出来的仍是这个活 getter。`LiveVoiceEngine` 边读音频边把新增的转写打成
`text` 增量，**音频流结束之后**才把 `transcript()` 抄进 `done.speech`。打断时生成器停在
当前值上，`said` 审计拿到的就是已经播出去的部分。

**契约：轮末使用（`said` 审计、记忆回写）必须在音频流 drain 之后读。** 这不是疏忽。

---

## 四、段层：三条硬约束（全是踩出来的）

### 4.1 封段之后必须闭嘴

能量门 `holdMs` 默认 **2000 ms**，`commitMs` 默认 **20 ms**。
所以 `seal()` 之后还有 ~1980 ms 的**静音**会继续从 `onFrame` 流进来。

无条件转发 = 每轮白灌两秒静音，既计费（Manual 模式静音不免费），
又会让下一轮 `restart()` 把这段残留 commit 成一条空白用户消息。

```text
seal()        → muted = true
feed(!voiced) → 只进 ring（150 ms 上限），一个字节都不发
feed(voiced)  → muted = false，先补 ring 再追加
```

`voiced` 必须由**能量门给**（`EnergyGateDecision.voiced`），不能自己按能量重算——
两处门限一漂移就会开始丢字或灌静音，而且从数据上分不出来。
这是唯一一条跨层数据约定：能量门之后只有 `onFrame(frame)` 一个出口，
`frame.pcm` / `frame.voiced` 由 `UplinkPipeline` 一路透传给 `assembler.addFrame` /
`stt.feed` / `omni.feed`。

### 4.2 忙的时候不能 `response.create`

服务端回 `Conversation already has an active response`，而且**那一次 create 永久丢失**。

所以 `seal()` 撞上 busy 时把这份排队（`pending: SealMeta`，只留一份），
先 `cancelCurrent()`，等 `response.done` 到了再补发。

排队时必须用 `pending.bytes` 而不是重读 `dirtyBytes`：那段音频的长度在 `seal()`
时就已经钉下来了，之后到的音频属于**下一段**。

### 4.3 `response.created` 之前不能 `cancel`

服务端回 `Cannot cancel response before response.created`。

委派轮会踩到：`seal()` 之后立刻 `discard()`，此时 `created` 还没到。
所以 `cancelCurrent()` 先置 `cancelPending`，等 `onMessage` 收到 `created` 再补发
（[`OmniShadow.cancelCurrent()`](../src/omni-shadow.ts)）。这条错误也不计入协议错误计数。

### 4.4 不自动重连

`broken` 是终态。影子挂了就等于这次实验结束——少一个半夜自己重连、
把账单和口径都搅乱的东西。落一条 `{skipped:'broken', why}` 事件，人看见了再决定。

`stop()` 与 `break()` 只走 `teardown()`。它清掉在途 `resp` 和排队的 `pending`，
再把状态收到 `broken`（已经是 `broken` 就直接返回）。`willServe()`、
`canAnswerText()`、`canSpeakBackground()` 都先看状态：不是 `ready` 也不是 `busy`
就为 false。建连回调只认当时那只 socket（`this.ws !== ws` 就丢掉）；
`teardown` 把 `this.ws` 置空之后，旧连接的 open / message / close 不再改状态。

### 4.5 `restart()` 的四件事，顺序有讲究

1. 上一份还在生成 → **立刻 cancel**。用户说话有 2–3 s，够它干净收尾；
   等到 `seal()` 才 cancel 就把 ~80 ms 压在关键路径上。
2. 丢掉待发的 `pending`（句子还在继续，组装器会重新 `seal()`）。
3. 有残留就 `commit` 掉但**不发 create**——空缓冲 commit 会回
   `maybe no invalid audio stream`。
4. 解除闭嘴、推预卷。

### 4.6 认领必须能跨过「排队窗口」

`seal()` 撞上忙的时候，做的是「cancel 当前那份 + 把新的排进 `pending`」，而**新的那份
要等旧那份的 `response.done` 才建出来**。实测空窗 **92 ms**。

如果 `willServe()` 只看 `this.resp`，它在这个窗口里会指着一份已经被取消的回复、
判 false —— 于是这一轮退回级联，而 omni 那份 1 s 的回答生成完没人要。
（真机 `20261122-194042` 两轮中招，占 5%。）

所以：

```text
willServe()  手里没有活的，但 pending !== null  ⇒  true（新一份马上来）
claim()      手里没有活的 ⇒  预留（claimReserved），流先挂起
sendSeal()   建好时按预留把 claimed 置上，并把引用记进 claimedResp
```

**`claimedResp` 这个引用是必须的，不是冗余。** `finish()` 一到就把 `this.resp` 置 null，
而异步 generator 的第一个 `next()` 是微任务 —— 如果 response 在消费者开始读之前就
`done` 了，事后去 `this.resp` 里找只会得到 null，表现是这一轮静默等 5 s、零音频。
（这个坑是写测试时撞出来的，第一版就是「事后去找」。）

**并段轮里认领要跟着「真正的那一份」走。** 一句话被 ASR 切成好几段时，每段一次
`seal()`：第一份会被后面的封段取消（`superseded`，同时串上 `next` 指针），
真正那份在 `pending` 里、`done` 之后才建出来。认领如果绑死第一份，这一轮就是
`audio_s = 0`，而真正那份没人要 → 被幽灵清理删掉。真机 `20261122-2243` 第 13、16 轮
丢了 2.16 s 和 6.16 s 两个完整回答。

所以 `claim()` 的读端在「手里这份被顶掉、而且这段还**一个字节都没播出去**」时
顺着 `next` 跟到新那份。两条边界：

- **播过就不跟**：两段回答接在一起（前半句答 A、后半句答 B）比少说一句更难听。
- **只跟同一个 `turnEpoch`**：`restart()` 每次 +1，跨纪元的 `next` 属于下一轮 ——
  跟过去就把人家的答案抢了，`interrupt()` 也会掐错人（`tests/omni-shadow.test.ts`
  的「插话时不许掐掉下一句的回复」钉的就是这条）。

### 4.7 删半句：只能延迟到 `response.done`

`conversation.item.delete` 要 **item id**，而 id 在 `response.done.response.output`
里。`discard()` 的时机（委派轮、同一句的第二次封段）通常连 `response.created`
都还没到，**当场根本发不出去**。

所以分两步：

```text
discard()          → resp.deleteOnDone = true，然后 cancelCurrent()
response.done 到达 → 从 ev.response.output 取 role==='assistant' 的 id
                   → 逐个 conversation.item.delete
```

**只删助手项**：用户那条是这一轮的内容，后面几轮还要指代它。

标记的规则（两个入口语义不同）：

| 谁调 | 标记 | 为什么 |
|:---|:---|:---|
| `discard()`（这一轮不采纳） | 必删 | 一个字都没播，留着只会污染下一轮 |
| `cancelCurrent()` 且 `!claimed` | 删 | 同一句第二次封段把上一份顶掉，那份答的是半句话 |
| `interrupt()`（播到一半被打断） | **不删** | 用户已经听到了一部分；删掉连那部分也没了 |

### 4.8 委派轮回注：`role` 必须是 `user`

委派轮是 omni 先说一句**回执**（「我查查」）然后把活儿交给 dsh。omni 的服务端历史里
只有「用户问了什么」，**不知道 dsh 答了什么**——这是「缺失」，不是「污染」。

回注的四条约束（前两条来自实测，后两条来自跑起来的教训）：

1. **`role: 'user'`**。`assistant` 角色三种 content type 全都回 `created` + item id，
   但模型当没看见（§5.2）。
2. **带上原问题**。委派轮动辄十几秒，期间用户可能又问了别的，只给答案会让
   后面几轮的指代全乱。
3. **硬截断 200 字**。dsh 的答案动辄几百字，整段塞进去只是烧 token，
   而且它会一直留在上下文里（到 ~6600 token 才被截断）。
4. **等 `ready` 再发**。忙的时候排队（上限 4 条），`response.done` 之后 flush。
   插在一条正在生成的回复中间会让它自己那轮的指代也乱。

宿主按内核 `settleTurn.inject` 的**三态**决定要不要回注、以什么口气回注 ——
判定只有一份，在 [`kernel.ts`](../src/kernel.ts) 的 `settleTurn` 里：

| `inject` | 条件 | 宿主做什么 |
|:---|:---|:---|
| `spoken` | 用户听全了（有声音下发且没少听） | 回注，按「用户听到了」 |
| `unspoken` | 这一轮有结论，但一个字都没播出去 | **仍然回注**（否则下一轮它会照旧编）；只是不标「他听到了」 |
| `none` | `truncated`（用户少听了一段） | 不回注 —— 没听到的东西不该变成 omni 的记忆 |

**不再是旧的 `audioBytes > 0` 硬门槛**：0 字节 ≠ 少听。真机 `20261123-053719`
第 2 轮，dsh 答出了《其主之声》，`audio_s=0.00` 被 `audioBytes > 0` 拦下，
于是 omni 至今不知道书名，第 5 轮把《奇书》当真书名编了 10.4 s。现在内容照注，
只有「少听了一段」才吞。

---

## 五、协议事实（实测，勿照文档猜）

| 事实 | 实测结果 | 影响 |
|:---|:---|:---|
| 握手 | `session.created → session.update → session.updated` ≈ **1.3 s** | 与设备握手并行，不占关键路径 |
| `cancel` 往返 | → `response.done` **79–96 ms** | 尽量挪到用户说话期间 |
| 忙时 `create` | 报 `already has an active response`，**永久丢失** | 必须先 cancel 再排队 |
| 放弃一条流（调用方 `return` 掉生成器） | 服务端**继续推**它的 `response.audio.delta`；单队列读法会把这些字节当成下一句的音频（真机 2026-11-23：4 个字的回执合成出 **506880 B / 10.56 s**、首块 0 ms） | 必须 `response.cancel` + 丢弃到 `response.done` 才放行下一条 —— `omni-tts.ts` 这样修；`bench/tts/reader-probe.mjs` 可复现 |
| `created` 前 `cancel` | 报 `Cannot cancel response before response.created` | `cancelPending` |
| 50 ms 短音频 `commit` | **不报错**（空转写、`completed`） | 但会造空白用户消息，所以看 `dirtyBytes` |
| `conversation.item.delete` | **有效**（三次复现，省 13–39 token） | **已接入**：`discard()` / 未认领的取消在 `response.done` 之后延迟删除助手项（见 §4.7） |
| `conversation.item.create`（**`user` 角色**） | 注入文本 → 下一轮**照做**（3/3） | **回注 dsh 答案可行**，见 §5.2 |
| `conversation.item.create`（`assistant` 角色） | 回 `created` 和 item id，但模型**当没看见** | 伪造自己的历史被拒。**不能拿 token 数判定**，见 §5.2 |
| `conversation.item.truncate` | **静默忽略**：14.5 s 的回答截到 800 ms → 无 ack、无 error（6 s 超时）；追问「你刚才数到几？」照样答「二十」，追问轮 `in_text_tok` 与对照组**一模一样**（769/769） | 不能用。想对齐「用户听到了多少」只剩 delete + `user` 回注（§5.2） |
| 上下文上限 | ~**6600 token** 处服务端自动截断（6617→4387） | 漂移有界 |
| 长尾 | **不是厂商慢**：`cancel_wait_ms` 就是长尾本身（扣掉后 4/5 落回 599–786） | 见 §8.6 |

### 5.1 `session.update` 的关键参数

```ts
modalities: ['text', 'audio'],
turn_detection: null,                    // 端点归我们控，服务端 VAD 既多余又更慢
audio.input.format: { pcm, 16000, s16le, 1ch },   // 必须与 UplinkPipeline 一致
audio.output.format: { pcm, 24000 },
input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },  // 没它就没有 final_ms
...(serve ? { tools: [DELEGATE_TOOL], tool_choice: 'auto' } : {}),
```

`instructions` 里**不能**写任何「要不要调工具」的暗示，见 §十。

### 5.2 `conversation.item.create` 的角色是不对称的（踩过一次误判）

| 角色 | content type | 结果 |
|:---|:---|:---|
| `user` | `input_text` | **生效**：注入「记住：我养的猫叫豆豆。」→ 追问「我的猫叫什么」答「你的猫叫豆豆。」（`in_tokens` 35→64） |
| `assistant` | `text` / `output_text` / `input_text` | **全部无效**：回 `created` 和 item id，`in_tokens` 停在 35，模型答「我不知道你的猫叫什么」 |

**服务端只允许你伪造用户的输入，不允许你伪造自己的输出。** 三种 content type 都一样，
所以这不是格式问题，是角色问题。

这条曾经被误判成「`item.create` 只存不用」：当时的探针用的是 `assistant` 角色，
而且**拿 `in_tokens` 增量（只多 5）当判据**。token 少 ≠ 模型没读 ——
判断一个原语要用**回答内容**，不能用计费。

生产上要回注 dsh 的答案时，把内容包成一条 `user` 角色的文本项即可；
实测在**音频上下文**里同样生效（§12.5 有验证方式），代价约 30–50 token/轮。

---

## 六、宿主层

### 6.1 `voice-session.ts` — 挂点与生命周期

四个挂点，各管一件事：

```text
onCommit(20 ms)     → omni.seal(laneSeq, silenceMs)              // 车道先起跑
onSttCommit(150 ms) → stt.commit() → archive(asr.commit, {seq, lane_seq})
onSpeechOpen        → assembler.resetAudio → stt.feed(预卷逐块) → omni.restart(preroll)
onFrame(frame)      → assembler.addFrame(frame) → stt.feed(pcm, voiced)
                                                → omni.feed(pcm, voiced)
```

**连接按设备连接创建和销毁**（`start()` 里 `omni.start()`，这条连接要发声时再
`attachAudioLane(omni)`，`onClose()` 里 `attachAudioLane(null)` 再 `omni.stop()`）。
不能在进程启动时建连——服务空跑几十分钟后 WS 早就空闲断链了。

`pipelineMode` 决定这条连接上 omni 管不管发声（`VoiceConnection.start`）：

| `pipelineMode` | `serve` | 这条连接 |
|:---|:---|:---|
| `live` | 播放管线（`full`） | `omni.start()`，并且 `attachAudioLane(omni)` |
| 未传 | 不是 `off` | 同上。这是没写 `VOICE_PIPELINE`、靠 `OMNI_ANSWER=full` 推断的旧挂法 |
| 未传或 `cascade` | `off` | `omni.start()` 照跑，不 `attachAudioLane`。只读探针 |
| `cascade` | 即便配了 `full` | 仍不 `attachAudioLane`。显式 cascade 不接管发声 |
| 没配影子 | — | 不建连 |

**两个封段序号已经分拆**：车道封段序号（`omni.shadow.seq`，20 ms 那把闸）与 ASR
封段序号（`asr.commit.seq`，150 ms 那把闸）**不再相等，也不许混用** —— 混了之后
「omni 的 `audio_ms` 从哪一刻起算」就说不清，整份延迟报告偏 130 ms。两份事件靠
`asr.commit.lane_seq` 配对（同 §1.1）：真机有二次封段、咳嗽误触发、打断轮，
没有 join key 三轮之后就错位了。

后台完成不另开一条嗓子。`setTaskReporter` 接到 `onTaskReport`，把
`BackgroundTaskReport` 放进 `DialogRuntime.enqueueAnnounce`。`speakAnnounce` 把
`TurnRunner.speakAudioAnswer` 交给 `LiveOrchestrator.speakBackgroundReport`。
插话或双击走 `cancelAnnounce` → `OmniShadow.cancelBackgroundSpeech()`，只掐
`origin === 'announce'` 的那份回复。

### 6.2 `live-orchestrator.ts` + `background-task-bus.ts` — 唯一前台与后台

`VOICE_PIPELINE=live` 的前台是 [`LiveOrchestrator`](../src/pipelines/live-orchestrator.ts)。
出声的轮次走 `toEngine().respond()`，`reply()` 只留给保活和无音频调用方。
前台人格只有 omni 这一副嗓子。dsh 是无头执行端：工具、识图、记忆写入，以及 dsh 自己的
`run_in_background` / 子代理，都经 [`BackgroundTaskBus`](../src/background-task-bus.ts)
回到同一条 omni 会话里说。`FastLlmClient` / `PrefetchSlot` 不在这条管道里。

`respond()` 按这个顺序做：

1. `flushUnspoken()`。空窗还没到、用户已经开口时，把还没念的结论以
   `injectAnswer(..., 'unspoken')` 回注一次，免得下一轮 omni 被问「跑完没」时现编。
2. 纯函数 `decideLiveTurn()` 定这一支，只走一条：取消 → 识图 → 钟点 →
   `live_with_bg_guard` / `live_direct` → `fallback_dsh`。
3. 不是取消、也不是识图，并且 `looksMemorable`：`dispatch({ source: 'memory_silent', silent: true })`。
   成功和失败都不播报，也不挡住前台（§零 的 716–776 ms，委派垫话的
   `response.done` 约 700–960 ms，见 §10.1）。

各支：

- **取消**（`isCancelRequest` 且总线上还有要汇报的任务）：`cancelAll`，丢掉在途 omni 音频，
  说「好，不查了。」已经在跑的 `memory_silent` 默认留着。
- **识图**：丢掉 omni 在途音频（图是 dsh 看的，omni 没看见）。车道还能交接
  （`willServe()` 或 `canSpeakBackground()`）就把图异步派进总线（`source: 'image'`），
  前台只说「我看看。」并带 `nonBlocking`。车道接不上才同步问 dsh，再用本层 TTS 念出来。
- **钟点**（`isClockTimeRequest`）：车道还能答就立刻 `early_rule`，前台只应一声「我查查。」
  接不上才 `fallbackDsh`。这条不进 `live_with_bg_guard`，因为 Omni 会直接编时间。
- **`live_with_bg_guard`**：要查外部或要动手，并且车道还能开口（`willServe()`，或至少
  `answerFromText` 在场）。**进 Omni 之前不派单**。`finishLive()` 一见到 `delegate` 就立刻
  `dispatch({ source: 'tool_call' })`，查询用 `rewrittenQuery` 再附上用户原话。
  整段结束仍没有 `delegate`，才用原话补一笔 `early_rule`。中止，或 `dispose()`
  已经置上 `disposed`，都不再派。工人因此不会拿着 ASR 原话先跑完，再和改写查询各答一次。
- **`live_direct`**：同样进 Omni，但不挂这道后台守卫。封段认领和文本直答都没有，才
  `fallbackDsh`（账本记 `dsh`）。

`tool_call` 出在 `delegate` 事件上。封段认领和 `answerFromText` 都进同一条
`finishLive()`。编排器打上 `meta.nonBlocking`，垫话播完这一轮就结束。
omni 一个采样都没吐时，用本层 TTS 补一句「我查查。」避免对着静音干等。

总线的规矩：

| 规矩 | 行为 |
|:---|:---|
| 同一 `turnNo` | 要播报的任务去重，只执行一次。还在 `queued` 的 `early_rule` 会被后到的 `tool_call` 换成工具里的查询；已经 `running` 或 `completed` 的保持原查询，不再开第二次 |
| 编排器时序 | `live_with_bg_guard` 不在进 Omni 之前派 `early_rule`。`tool_call` 在 `finishLive()` 当场派改写查询；整段没有 `delegate` 才补 `early_rule`。两条不会各跑一遍 |
| 同一同步回合 | 若两条 `dispatch` 发生在同一次同步调用里、工人还没取队列，微任务会把它们合成一次 `execute`（先升级再跑） |
| 工人 | 一次只跑一个 `execute`，避免单会话 dsh RPC 叠在一起 |
| `memory_silent` | 不参与 `turnNo` 去重，不产生 `BackgroundTaskReport`。`cancelAll` 默认不停它 |
| dsh 自己的 `onAnnounce` | 构造时把 `inner.setAnnouncer` 接到 `ingestExternalAnnouncement`，收成 `source: 'dsh_background'`。那边已经跑完，不再进执行队列 |
| 插话 | `abortSpeculation('barge_in')` 只 `interrupt()` 前台 omni。已经派出去的后台任务继续跑 |
| 显式取消 | `cancelAll('user_cancel')` 停掉要播报的排队任务和正在跑的那条。迟到结果丢掉 |

完成的 `BackgroundTaskReport` 交给 `setTaskReporter`。没人接时才退回 `setAnnouncer(summary)`。

账本在编排器自己的 `ConversationLedger`：omni 答完（含垫话）记 `live`，同步兜底记 `dsh`。
记下时 `truncated` 先按 false，内核结算经 `reconcileTurnOutcome({no, gen})` 改成真实结果。
`lastLedgerLane()` 原样读账本上一轮：omni 记 `live`，`fallbackDsh` 记过 `dsh` 之后这里返回 `dsh`。
还没答过、或只有 `pet`，是 `null`。垫话轮记的是垫话本身；结论稍后由
`speakFromText` 进 omni 的服务端历史，或由逐字 TTS 用 `inject: 'spoken'` 补进去。

`needsVerbatimRead()` 决定这份结论能不能交给全双工自己说。下面任一为真，报告带上
`verbatim`（清洗后的全文）和截到 160 个码点的 `summary`：

- 显式 `[VERBATIM]` / `【VERBATIM】`
- 连续 5 位及以上数字、IPv4、代码路径、订单号形态（1–4 个大写字母接至少 4 位数字）
- 正文超过 180 个码点

普通短句（天气、闹钟）不带 `verbatim`，交给 omni 用一两句口语说。全双工会改词、漏读数字
（§十一），所以必须逐字的内容改走 TTS。

**空窗里怎么说出来**（`speakBackgroundReport` + `DialogRuntime.flushAnnounce`）：

话筒在 `AppSession` 的 `FloorArbiter` 上。`announce` 抢不走 `reply`（正题没说完不插播）。
`DialogRuntime` 只在相位回到 `listening`、并且距上次用户出声满 `ANNOUNCE_QUIET_MS`
（800 ms）时才从队列取出汇报。取出之后：

| 条件 | 结果 |
|:---|:---|
| 报告带 `verbatim` | 不调用 `speakFromText`。`TurnRunner.speakCanned` 用 TTS 逐字念原文。念完且没被打断时，`noteFallbackAnnounceSpoken` 以 `injectAnswer(..., 'spoken')` 把原文注进 omni，不再出第二声 |
| `canSpeakBackground()` 为假，或 `speakFromText` 返回 null | `'defer'`：条目排回队首，等下一个 800 ms 空窗。忙着发 `response.create` 会被服务端丢掉（§4.2） |
| 可以开口 | `buildLiveReportPrompt`（[`persona.ts`](../src/persona.ts)）写成一条 user 文本。`OmniShadow.speakFromText` 连发 `conversation.item.create` + `response.create`，音频由 `TurnRunner.speakAudioAnswer` 下发。同一副嗓子，上下文自然接着。`playAudio` 确认这一条是 `spoken` 之后才 `markInjected` |
| 开口前 0 字节，且不是被打断 | `'fallback'`：还没 `markInjected`，改走 TTS，并按 `'spoken'` 回注。提前标记会让这次回注被吞掉 |
| TTS 被打断 | 不按 `'spoken'` 回注 |

`dispose()` 之后 `speakBackgroundReport` 直接 `'defer'`，在途的 `finishLive` 也不再补派。

`canSpeakBackground()` 为真要同时满足：`ready`、没有在途回复、没有排队封段、
`dirtyBytes === 0`，并且 `serve` 不是 off。`canAnswerText()` 同样只认 `ready`
（`serve` 不是 off、没有在途回复、没有排队封段），但不看 `dirtyBytes`。
`willServe()` 更宽：状态是 `ready` 或 `busy`，`serve` 不是 off，手里有活回复，或者 `pending` 里还排着一份。

DashScope 上「dangling `tool_call`（不回 `function_call_output`）之后，
`item.create`（`user`）+ `response.create` 还能不能出声、还记不记得」用
[`scripts/probe-omni-inject-speak.mjs`](../scripts/probe-omni-inject-speak.mjs)
在真连接上验，见 §12.5。

`cascade` 的账仍是 `CascadeAgent` 自己的 `ConversationLedger`（文本快车道的
`keepTurns` / 投机都在那边）。`FrontedAgent.pending` 是更早那层装配的账；
live 会话不靠它记 omni 答过的轮次。

### 6.3 `turn-runner.ts` — 一条泵

`run()` 只消费 `FastVoiceEngine.respond()`。`live` 注入 `LiveOrchestrator.toEngine()`
（里面是 `LiveVoiceEngine`），`cascade` 注入 `CascadeAgent.toEngine()`。
只给了 `{ agent, tts }` 的旧装配由 `AgentEngineAdapter` 收成同一条 `respond()`，
泵里仍然只有一个 `for await`。

| 事件 | 泵做什么 |
|:---|:---|
| `meta` | 记下 `path` / `delegate` / `firstTokenMs` / `firstSynthAtMs`。`nonBlocking === true` 表示后台已经派单，垫话播完就收轮，这一轮不调用 `noteServedTurn` |
| `audio` | 按事件自带的 `sampleRate` 下发。首块记 `tts.first`。媒体游标只在这一轮还占着播放区时喂给内核 |
| `text` | 拼进 `speech` |
| `delegate` | 标记已转交 |
| `done` | `speech` 取 `done.speech`，缺省用 `fullText` |

结算仍只喂事实（`audioSent` / `devicePlayed` / `ticketInvalidated` / `turnEnded`），
回注口气只认内核的 `settlement.inject`。`path === 'dsh'` 且 `inject !== 'none'` 时
`injectAnsweredTurn`。`path === 'omni'`、没有 `delegate`、也不是 `nonBlocking` 时才
`noteServedTurn`。垫话轮记两遍会让账本以为「上一轮是 live 把正文答完了」，所以
`nonBlocking` 的那一轮跳过 `noteServedTurn`；垫话本身由 `LiveOrchestrator.remember` 记下。
延迟埋点（`tts.first`、`turn.end` 的 `dsh_ms` / `audio_s`）留在本类，引擎只报事实。

后台汇报不进 `run()`。`speakAudioAnswer` 与 `speakCanned` 共用 `speechChain`、同一枚
`cancelCanned` 令牌和残句记录。`DialogRuntime` 的 `speakAnnounce` 把这个方法交给
`speakFromText` 返回的 `AgentAudioAnswer`。

采样率按回答走，泵不做「omni 一定是 24 kHz」的假设。live 引擎认领的是 omni 自己的音频；
cascade 引擎在自己的 `respond()` 里把文本送去合成。

### 6.4 `keepalive.ts` — 装配层最大的坑

`trackActivity()` 现在用 **`Proxy`** 包装 `AgentProvider`：除 `reply` 被包一层记账外，
**所有属性自动转发**（包括以后新加的可选能力、甚至运行时才挂上去的）。加能力不用再手抄
一行。两条实现细节别改：`Reflect.get` 的第三参必须是 `target`（私有字段 getter 在
`receiver` 上找不到槽），方法要 `.bind(target)`（宿主会拿下来再调）。

当年它是**对象字面量**包装，每项都得显式转发。线上踩过整整一晚：
`attachAudioLane` / `willServeAudio` / `noteServedTurn` 三个漏转发，表现是
「omni 一次都不接管」而日志里一条错误都没有。

`setTaskReporter`、`cancelBackgroundTasks` 这类后来加上的可选方法同样走这条 Proxy。
自己实现 `AgentProvider` 再逐项转发的包装层，漏一项仍然是静默降级。

防复发：`tests/keepalive.test.ts` 仍有一条「透传**全部**可选能力」的清单测试，
`main.ts` 启动打 `装配 agent=… attach=function will=function`。

---

## 七、事件契约

### 7.1 `omni.shadow`（一份 seal 一条）

```json
{
  "seq": 2,                // 车道封段序号；ASR 侧在 asr.commit.lane_seq 里引用（两个序号不再相等）
  "warmup": false,         // 连接后第一份，分析时排除
  "seal_s": 2.27,          // restart→seal 推了多少音频（秒）
  "silence_ms": 66,        // 封段时距最后一个有声帧多久（与 asr.commit 同一把尺）
  "ack_ms": 88,            // → input_audio_buffer.committed
  "final_ms": 262,         // → 转写定稿
  "text_ms": 365,          // → 首条响应文本
  "audio_ms": 655,         // ★ 主指标：封段 → 首块音频
  "cancel_wait_ms": 0,     // 撞 busy 时等 done 的时长（已含在 audio_ms 里，单列出来看）
  "out_s": 2.64,           // 输出音频时长
  "status": "completed",
  "cancelled": false,
  "flushed_ms": 0,         // restart() 时顺手 commit 掉的残留
  "in_audio_tok": 35,
  "in_text_tok": 1138,
  "out_audio_tok": 33,
  "local_port": 34936,     // 长尾时用 `ss -ti` 区分厂商慢 / 公网丢包
  "dropped_ms": 0          // 可选：被 ring 丢掉的音频
}
```

没参战时只有 `{seq, skipped:'broken'|'idle'|'connecting', why?}`。

### 7.2 `agent.lane`（每次 `willServeAudio()` 一条）

```json
{ "has_lane": true, "lane_ok": false, "ok": false, "lane": "cascade", "why": "live-down",
  "serve": "full", "state": "busy", "has_resp": true, "pending": false,
  "cancelled": false, "claimed": false, "turn_seqs": 2 }
```

前五栏是路由的判据快照（`has_lane` / `lane_ok` / `ok` / `lane` / `why`，来自
`willServeAudio()` + `routeTurn()`）；后面是 `explain()` 摊开的车道内部状态，
**只进档案、不参与决策**。Pure Live 的 `LiveOrchestrator` 不打这一条，看 `turn.end.path`
（`omni` / `dsh`）。这一事件留给仍调用 `willServeAudio()` 的级联与旧装配。

**为什么需要**：`willServe()` 是个布尔，false 的时候看不出是「没开」「没 response」
「被取消了」还是「路由判给了 dsh」——这几种的修法完全不同，而线上没法打日志重放。
`why === 'live-down'` 正是 §3 那条违约判据的来源。

---

## 八、判读口径

### 8.1 两个口径都不许裸叫 p50/p90

本项目约定（见 `QOS.md`）：**p50/p90 不加限定一律指 `firstWordMs` = `gate.close` 停嘴 → `tts.first`**。

而 `omni.shadow.audio_ms` 的起点是 **`seal()`**，不含 ①a（停嘴→封段，真机 68–91 ms）。
所以：

```text
omni 的端到端 = ①a + audio_ms        ← 与 firstWordMs 同口径
omni 的「封段→首块」= audio_ms       ← 只能叫全名
```

拿 `audio_ms` 直接跟 `firstWordMs` 比是错的，会**低估 omni 约 70–90 ms**。

### 8.2 不能跨车道求 p50

`fast` 与 `omni` 是两个量，混在一起得到的是混合分布，回答不了「omni 多快」。
`latency-report.ts --standard` 的「按车道」表就是为这个准备的，直接跑它：

```bash
node scripts/latency-report.ts <会话目录> --standard
```

### 8.3 并段轮不能混进「胜率」

`commitCount > 1` 的轮次两边做的不是同一件事：

- 级联在第一次 `commit` 后被 `TurnJudge` 拦住，等第二段说完才整体回答。
- omni 在第一次 `commit` 时就已经 `create` 了，第二次 `commit` 要走 `cancel`。

所以并段轮的 `cancel_wait_ms`、续接是否出错、取消带来的 token 浪费要**单列一张表**。

### 8.4 真机分段（第 1 场，中位）

| 段 | omni | 级联 |
|:---|:--:|:--:|
| ① 停嘴→定稿 | 273 | 273 |
| ①a 停嘴→封段 | 68 | 67 |
| ①b 封段→定稿 | 209 | 209 |
| ② 定稿→开跑 | 18 | 20 |
| ③ agent + TTS 首块 | **479** | **669** |

`①` 两边一模一样（同一套 ASR / 判停前端，omni 没碰），**全部收益在 ③**。
`omni audio_ms ≈ ①b + ③`（209+479=688 ≈ 实测 690）——**①b 被藏在 omni 生成期里了**，
这是它真正的结构性好处。

### 8.5 用户实际听到的

服务器首块 + **A2DP ≈ 200 ms**（SBC/AAC 典型 150–250 ms，取中心）。
A2DP 是常数，**Δ 不变**，但它放大长尾的观感：级联 p90 服务器侧 1285–1883，
加 A2DP 就是 **1.5–2.1 秒**，用户能明确感到卡；omni p90 收在 **0.96–1.13 秒**。

（`device.played` **不能**用来算这个：它是**播完回执**，实测「收到最后一批字节就回执」。）

### 8.6 长尾就是 `cancel_wait`，别绕开它找别的原因

真机第 2 场，把 `cancel_wait_ms` 从 `audio_ms` 里减掉：

| seq | `seal_s` | `cancel_wait` | `audio_ms` | 净生成 |
|:--:|:--:|:--:|:--:|:--:|
| 8 | 0.45 | 88 | 687 | 599 |
| 22 | 0.38 | 319 | 961 | **642** |
| 33 | 0.23 | 282 | 982 | **700** |
| 25 | 0.23 | 133 | 919 | **786** |
| 29 | 0.30 | 282 | 1180 | 898 |

**净生成全部落回正常区间（603–844）**。所以 p90 = 932 里那 280–320 ms
不是厂商慢、不是链路重传，是**等上一条 response 取消**。

它清一色出现在 `seal_s < 0.5` 的短段上，且这些段的相邻 commit 只隔 233–534 ms ——
即**同一句里的第二次封段**（能量门还开着，assembler 又 commit 了一次），
上一份 response 还在跑，`seal()` 撞 busy 只能排队。

> 曾经把这个现象归因成「短段本身造成长尾」，是**因果看反**：
> 短段只是把它暴露出来的场景，代价是 `cancel_wait` 本身。

---

## 九、成本

| 项 | 单轮量 | 出处 |
|:---|:---|:---|
| 输入音频 | `seal_s × 7` token（3 s 话 ≈ 21） | 官方公式 |
| 输入文本 | **1102** 起（挂 tools），每轮 +~40 | 150 轮实测 |
| 输出音频 | `out_s × 12.5`（2.6 s ≈ 33） | 实测 `out_audio_tok` |
| 累积重算 | 历史每轮音频+文本都进下一轮输入 | 到 ~6600 tok 自动截断 |

**挂 tools 本身抬高基线约 400 token/轮**（713 → 1102），但 150 轮实测首块没变慢。
`serve=off` 时 `sendSessionUpdate()` 不挂 `tools`，基线回到不挂工具的那一档。
发声开关见 §12.3：显式 `VOICE_PIPELINE=live` 不以 `OMNI_ANSWER` 收声。

`OMNI_SHADOW` 未设 = **不建连、零成本**。

---

## 十、最脆的一处：工具描述

`description` 是这个车道里唯一一句**改一个字就整轮报废**的东西：

| 写法 | 结果 |
|:---|:---|
| `description: '…查询实时信息…'` | 「他还写过哪些作品？」被 3/3 判成工具调用 |
| 提示词加「需要转交就调工具」 | 闲聊 3/3 被逼调用 |
| **只写「实际动手 / 读设备数据 / 长期记忆」** | **9/9 正常** |
| 再加「调用之前先用一句话应一声（八个字以内）」 | **6/6 委派轮先出声**（1.4–2.3 s）再叠 `tool_call` |

**决定权在 `description`，不在提示词。** `instructions` 里任何关于「要不要调工具」的
暗示都会把闲聊推向调用；而「调之前先说一句」这句**只有挂在 `description` 上才生效**
（换到 `instructions`：实测 2/2 仍是 0 ms 音频，白写）。见
[`omni-shadow.ts`](../src/omni-shadow.ts) 的 `DELEGATE_TOOL` 注释、
`LEAD_IN_CLAUSE` 的实测记录，以及 `DEFAULT_INSTRUCTIONS` 顶部的警告。

### 10.1 委派轮那一声（垫话）

dsh 要 10 s 上下，中间必须有人应一声。**这个声音只能由 omni 自己出**：另起一条
TTS 链路合成回执，就是两句不同的嗓子接在一起，而且还多一条连接、多一次合成。

所以这里不走「预录回执」，走 `tool_call` 同轮出声（`tmp/omni-probe/tool-leadin*.mjs`，
真服务 24 格）：

| 写法 | 委派轮音频 |
|:---|:---|
| 现状（描述里不提应声） | **0 ms**（整轮哑着等 dsh） |
| 应声写进 `instructions` | 0 ms / 0 ms |
| 应声写进 `description`（八个字以内） | 1.36 / 1.84 / 1.92 / 2.32 s（4/4） |
| 同一条，收得更紧（六个字 + 「不要说要查什么」） | **2/4 掉回 0 ms** —— 收紧会把应声整个压没 |

线序是 `function_call_arguments.delta`（~500 ms）→ `audio.delta`（~650 ms）→
`response.done`（~700–960 ms），**两者收在同一个 done 里**。所以读端照常把音频读完、
读完再看 `delegateReason()`，两边都不缺 —— 这一条由
`tests/omni-shadow.test.ts` 的「工具调用之后才到的音频也要播」钉住。

另外两件事也顺手验了：闲聊轮不会被这段描述带偏（3/3 不调工具）；
`tool_call` 之后我们从不回 `function_call_output`（dsh 的答案另走 `injectAnswer` 注入），
这条 dangling call 不影响下一轮（3/3 照常回答、不重复调工具）。

Pure Live 把这条 dangling call 当成生产路径：不回 `function_call_output`。
`tool_call` 进 `BackgroundTaskBus`，前台在垫话的 `response.done`（约 700–960 ms）收轮，
不把 dsh 的十几秒堵在这一回合里。结论稍后在空窗里用 `speakFromText` 说，协议形状与
上面的注入相同：`conversation.item.create`（`role: 'user'`）紧接着 `response.create`。
真连接复现是 [`scripts/probe-omni-inject-speak.mjs`](../scripts/probe-omni-inject-speak.mjs)
（§12.5）：同一条连接上先留下 dangling `tool_call`，再测这次注入出不出声、下一轮记不记得。

### 10.2 委派轮：垫话留下，正文等空窗，绝不掐断重说

**omni 在 `tool_call` 之前说的那句就是回执**，原样留在这一轮里。
Pure Live 不在同一轮后面再合成 dsh 的正文：`tool_call` 进总线，垫话的
`response.done`（约 700–960 ms）收轮，结论回到 §6.2 的空窗，由同一副 omni 嗓子说。
必须逐字的内容走 TTS（§十一：全双工会改词、漏读数字）。
`TurnRunner` 里那条「已经说了多少」的阈值判断与 `audio.stop` 截断**已经删掉**
（曾经的 `OMNI_DELEGATE_MAX_SPOKEN_MS=800`）。

为什么：`audio.stop` 只清得掉设备**还没播**的缓冲，用户已经听到的那几秒追不回来。
所以「掐断 → dsh 从头再说一遍」在机制上**必然**是同一段内容听两遍 —— 真机
（`20261123-072301`）第 8/9 轮：omni 先念 2.2 s / 3.4 s，掐断之后 dsh 又从头说了
13.52 s / 10.40 s，中间还夹 4.25 s 静音。反过来"检测到说了正文就不转交"则把答案丢了。

「回执要短、别先讲答案」是**提示词纪律**，而且写在哪很关键：`omni-shadow.ts` 里两条
clause 都挂在**工具描述**上（`LEAD_IN_CLAUSE` = 八个字以内应一声、
`NO_PREVIEW_CLAUSE` = 应声之后不要先讲答案）。放进 `instructions` 实测拿到 **0 ms 应声**，
等于没写；把长度收得更紧（"六个字以内"）也会让应声整个消失（4/4 → 2/4）。
所以在代码里**不用阈值判**：判了就得二选一（掐断重说 / 干脆不转交），两种都难看。
超过 3 s 只记一行日志当仪表，不参与决定。

### 10.3 委派轮撞上插话：后台继续跑；只有显式下令才取消

dsh 是**异步**的：`session/cancel` 只作废下游输出，上游的活儿照跑。真机
（`20261122-210720`）第 9、10 轮两轮委派都撞上了插话 —— 两次都发 `session/cancel`，
dsh 那一步总结被判 aborted，用户一个字没听到，最后得重问一遍。**取消并没有省下那 10 秒**
（`bash` 在取消之后 2 s 才结束），省下的只是总结。

Pure Live 的规矩：

| 用户干了什么 | 处理 | 为什么 |
|:--|:--|:--|
| **插话**（说别的事） | `interrupt()` 前台 omni。总线上已经派出去的任务继续跑 | 回执等于**承诺了答案**。`cancelTurn` 只取消同步兜底那一次 `inner.reply`，不取消总线 |
| 用户已经在说下一句，结论还没念 | **不补播**。`flushUnspoken` 以 `injectAnswer(..., 'unspoken')` 回注一次 | 补播会打断他；不回注的话下一轮 omni 会现编 |
| 空窗到了（`listening` + `FloorArbiter` 上 `reply` 已放开 + 静音 800 ms） | 同一副嗓子说结论；`needsVerbatimRead` 为真时走 TTS，并以 `'spoken'` 静默回注 | 见 §6.2 |
| 用户**显式下令取消**（「算了 / 别查了 / 取消」，`turn-router.isCancelRequest()`）且确有要汇报的任务 | `cancelAll('user_cancel')`。迟到结果丢掉。前台说「好，不查了。」`memory_silent` 默认不停 | 「不要了」才是真的不要了 |

> **旧装配曾经漏了一整条路**：`FrontedAgent` 里写的是 `this.inner.detachTurn?.(ticket)`，
> 而 `DshAgent` **从来没有实现 `detachTurn()`** —— 可选调用遇到 `undefined` 静默空转。
> 于是"插话后委派轮跑完还能听到答案 / 答案会回注记忆"一次都没生效过，日志里连一行都不出。
> `keepalive.trackActivity` 现在用 `Proxy` 自动透传（`detachTurn` / `dshBusy` /
> `setDetachedAnswerSink` 都在里面），但**别的自实现包装层**仍要逐项转发；
> `tests/wiring-floor-cancel.test.ts` 卡"生产装配真的接上了"。

---

## 十一、明确不做

- ❌ 不自动重连、不做指数退避、不做降级（§4.4）
- ❌ 不做 omni 与级联的 hedge —— 两条腿的**文本和音色都不同**，
  先到先播会说出半句 A 半句 B
- ❌ 不用 `conversation.item.create` 的 **`assistant` 角色** —— 回 `created` 但不进上下文（伪造自己的历史被拒）
- ❌ 不用 omni 当纯 TTS 念 dsh 的答案 —— 原生音频模型会擅自改词、漏读数字、
  自己加「好的，结果如下」。真要做必须先测逐字忠实度
- ❌ 不做 S5（回执预渲染 PCM）—— 收益 66 ms，代价是设备刚连上就占 TTS 约 2 秒
  与用户第一句话抢连接，已回滚过（`5500c47`）

---

## 十二、与初版设计的偏差（S0 稿 → 现形态）

初版设计稿写的是「只量、不发声、不碰 `TurnRunner`、不进 `AgentProvider`」。
实现走完六个提交之后偏差如下——**以本节为准，不要拿旧稿子对账**：

| S0 稿 | 现形态 | 为什么改 |
|:---|:---|:---|
| 不播 omni 音频 | 未写 `VOICE_PIPELINE` 时 `OMNI_ANSWER=off` 只量、`full`/`clip` 推断成 live；显式 `live`/`cascade` 以开关为准 | 量的目的就是接管，但接管必须是一次启动里的一条管道 |
| 不进 `AgentProvider` 契约 | `FastVoiceEngine.respond()` + `FastLaneAudioLane` | 播放要经过编排层；内核只认事件流 |
| 不碰 `TurnRunner` | `run()` 只消费 `FastVoiceEngine.respond()`；后台结论另走 `speakAudioAnswer` | 前台与后台汇报都从这一条泵出去，转交不再在泵里等 dsh |
| `seed(ms)` / `feed(pcm)` | `seal(seq, silenceMs)` / `feed(pcm, voiced)` | join key + 闭嘴口径 |
| `dirty` 布尔 | `dirtyBytes` + `muted` + ring(150 ms) | 修「seal 后 2 s 静音灌进去」 |
| `pendingSeal = 1` | `pending: SealMeta`（带 bytes/seq/silence） | 排队时要钉住字节数 |
| `restart()` 只 commit 残留 | 先 cancel busy 再 commit | 否则下一轮被上一轮拖慢 |
| `start()` 末尾「预热 seal」 | **无**：`session.updated` 即 `ready` | 假 seal 会白花钱 + 往第 0 轮塞脏历史 |
| 事件字段 `extended` | 内部 `turnSeqs` + `flushed_ms` | 并段判据改成段数 |
| 事件字段 `feed_bytes` | `local_port` + `dropped_ms` | 排障用 `ss -ti` 更直接 |
| 无 `created_ms` | 无（`created` 只是内部布尔） | 没用到 |
| `~380 行`，`fronted-agent.ts` 零改动 | 850 + 4 处改动 | 记忆复用 `pending` |
| 无「删半句」 | `discard()` 标 `deleteOnDone`，`done` 到了才删（见 §4.7） | 那会儿才有 item id |
| 无「回注」 | `injectAnswer()`：`user` 角色 + 带原问题 + 硬截断 + 等 `ready`（见 §4.8） | 委派轮 omni 会失忆 |
| 委派在前台等 dsh 再合成 | `tool_call` / `early_rule` / 识图进 `BackgroundTaskBus`，空窗用 `speakFromText` | 前台轮停在垫话的约 700 ms，不堵在 dsh 上 |
| 快车道与 omni 逐轮混选 | `VOICE_PIPELINE` 启动期二选一。`live` 的 `useCascadeFastLane` 恒为 false | 同一次会话里没有文本投机可以接住「车道挂了」 |
| 写在 `QOS.md` 里 | 独立本文 + `QOS.md` 附录一行 | 篇幅 |

### 12.1 当前空档

1. **两副嗓子**：omni 是 Tina，级联 TTS 是龙安欢。`live` 会话里前台和空窗汇报都是 omni。
   本层 TTS 仍负责三处：零音频时的「我查查。」/「我看看。」/「好，不查了。」、
   `needsVerbatimRead` 的逐字稿、以及车道接不上时的 `fallbackDsh`。
   早先全量之后曾降成「委派轮偶尔切」（dsh 链路在 S5 之前仍是 CosyVoice）。
2. **tool_call 自委派从未在真机触发过**：两场 `delegate` 只有 1 个 `task`
   （当时是本地 `isFastCandidate` 的 14 字闸拦的；那条闸现在只作用于级联）。
   代码路径已改成非阻塞总线，协议侧用 `scripts/probe-omni-inject-speak.mjs` 验
   dangling `tool_call` 之后的注入出声。真机上模型会不会发出 `tool_call`，仍缺一场。
3. **`✗ ASR: maybe no invalid audio stream`** 偶发，归属未确认（疑为既有问题，
   不是 omni —— 分属两条 WS）。
4. **上下文双轨**：omni 的服务端历史与 `LiveOrchestrator` 的 `ConversationLedger` 各记一份。
   对齐的口子是 `remember` / `reconcileTurnOutcome`、`speakFromText`（汇报本身进会话）、
   以及 `injectAnswer` 的 `spoken` / `unspoken`。`CascadeAgent` 与更早的
   `FrontedAgent.pending` 是级联那本账。这是 pipe 形态的固有代价。

### 12.2 已解决的（留作来由）

| 曾经的空档 | 怎么解决的 |
|:---|:---|
| 并段轮被 `clip` 拒（约 27% 轮走级联） | **砍掉 `clip`**：探针实测并段轮回答质量 5/5 与单段轮无差别；真正担心的「掐半句」22 轮里只 3 次、全是用户自己插话 |
| 半句留在服务端历史 | `discard()` 标 `deleteOnDone` → `response.done` 拿到 item id 再删（§4.7） |
| 委派轮 omni 失忆 | `user` 角色 `item.create` 回注（§4.8） |
| 插话时 omni 的 response 没人掐 | `cancelTurn` → `interrupt()`（§4.7 / §6.2） |

### 12.3 回滚（一直可用）

显式管道改回级联。`OMNI_ANSWER=full` 不会把 omni 的发声抢回去：

```bash
cd <部署路径> && sed -i 's/^VOICE_PIPELINE=.*/VOICE_PIPELINE=cascade/' .env && sudo -n systemctl restart miai-harness
```

没写 `VOICE_PIPELINE` 的旧部署，把 `OMNI_ANSWER` 设成 `off` 就是只量不发声（影子还在）：

```bash
cd <部署路径> && sed -i 's/^OMNI_ANSWER=.*/OMNI_ANSWER=off/' .env && sudo -n systemctl restart miai-harness
```

显式 `cascade` 下要继续只读测量：`OMNI_SHADOW=1` 且 `OMNI_ANSWER=off`（还要有音频 key，
STT 是 `qwen-realtime`）。`OMNI_ANSWER=full` 在这条管道上既不发声，也不挂探针。

### 12.4 硬约束之下，车道没接住时还剩哪些路径

旧档案看 `agent.lane`：**`why === 'live-down'`**，或者
**`has_lane === true && lane_ok === false && lane !== 'dsh'`**
（[`fsm-trace.ts`](../src/fsm-trace.ts) 的 `isLaneFallback()`）。这表示车道自己没接住。
**这个数应当是 0。** Pure Live 会话看 `turn.end.path`：`omni` 是前台，`dsh` 是
`fallbackDsh`（同步问 dsh，再用本层 TTS 念）。那一次兜底仍在同一次 `live` 启动里，
不会把进程换成 `VOICE_PIPELINE=cascade`，也不会装上 `FastLlmClient`。

| 路径 | 现在 | 说明 |
|:---|:---|:---|
| 逐轮 live → 文本快车道 | **结构上没有** | `live` 计划 `useCascadeFastLane=false`、`cascadeKey=''`。`LiveOrchestrator` 不引用 `FastLlmClient` / `PrefetchSlot` |
| 排队窗口（92 ms） | **已修**（§4.6） | 曾经 2/38 |
| `state === 'connecting'` | 未处理 | 握手 1.3 s。此时 `seal()` 直接 `skipped`，音频**从来没发出去**，事后补不回来 —— 真要修得把整句 PCM 缓冲到 `ready`。三场 90 轮里出现 0 次 |
| `state === 'broken'` | 本会话内 `fallbackDsh` | 车道挂了以后 `willServe()` 为假，每一轮同步问 dsh 再用本层 TTS 说。`break()` 落一条 `{skipped:'broken', why}`。这是整场兜底，不是逐轮抖动，也不是换成 cascade 管道 |
| 本轮已被 `interrupt()` | 不需要答 | 用户插话已经把这一轮作废了，不存在"该答没答"。已派的后台任务继续跑（§10.3） |
| 带图，车道还能交接 | 异步 `image` 任务 + 「我看看。」 | omni 没看见图，图交给 dsh；前台只垫一句，`nonBlocking` |
| 带图，车道接不上 | `fallbackDsh` | 同步问 dsh，再用本层 TTS 念 |

想彻底消灭 `connecting` 那一条，只有「缓冲整句 PCM，`ready` 后补发 commit+create」——
约和 V2 重发同量级的工作。**在三场 90 轮实测 0 次之前不值得做。**

### 12.5 协议原语怎么验（别用 token 数判）

四个原语的判定方法，以及各自**踩过的误判**：

| 原语 | 正确判法 | 误判 |
|:---|:---|:---|
| `item.delete` | 删掉后追问答不答得出 | 早期用 `in_tokens` 增量，得出「删了更糟」的假象 |
| `item.create` | **看回答内容**（注入「以后回答首字必须是『喵』」→ 3/3 照做） | 用 token 增量 + `assistant` 角色，得出「只存不用」 |
| `truncate` | 发出去看有没有 ack/error | — |
| `input_audio_buffer.clear` | 发出去看有没有 error | — |

**通用教训**：一个原语`回成功`只说明请求格式对，`token 数`只说明计价方式，
**都与「模型读没读」无关**。要验「模型读没读」就只能看它会不会照做。

探针在 `tmp/omni-probe/`（gitignore）：`barge-in.cjs`（并段三方案 / delete 语义）、
`inject.cjs`（四种注入形状）、`inject-audio.cjs`（生产形状：音频上下文 + delete + 回注）、
`transcribe-clips.cjs`（先确认素材说的是什么）。

空窗汇报（dangling `tool_call` → `conversation.item.create` 的 `user` 项 + `response.create`）
的在线复现是 [`scripts/probe-omni-inject-speak.mjs`](../scripts/probe-omni-inject-speak.mjs)。
同一条 DashScope Realtime 连接跑三轮：第 1 轮观察 `tool_call` 并且不回
`function_call_output`；第 2 轮在 ready 之后立刻注入并要音频（`injectAndSpeak`）；
第 3 轮追问，看转写里还在不在第 2 轮注入的事实。`session.update` 的 instructions 与
`DELEGATE_TOOL` 和 `src/persona.ts`、`src/omni-shadow.ts` 逐字一致。没有
`DASHSCOPE_API_KEY` 时退出码 2，不发起连接。用法见 [OPERATIONS.md](./OPERATIONS.md) 的诊断探针。

---

## 十三、测试

`tests/omni-shadow.test.ts`（44 条，假 socket 走 `RealtimeSocketFactory` 注入点；
下表只列最早的一批代表用例。后加的覆盖 `canSpeakBackground` / `speakFromText` /
`cancelBackgroundSpeech`：忙或有脏音频时返回 null，空闲时先刷排队回注再开汇报）：

| # | 用例 |
|:--|:---|
| 1 | 正常一轮：字段齐全，`audio_ms` = 假服务端里定的延迟 |
| 2 | `connecting` / `broken` 时 `seal()` → 不 send，`skipped` 正确 |
| 3 | `created` 前 `cancel` → 记 `cancelPending`，`created` 到了才补发 |
| 4 | `busy` 时第二次 `seal()` → 先 cancel，`done` 之后才发第二组 commit+create |
| 5 | `restart()` 时 `muted` + ring → 静音不进 WS，有声才恢复 |
| 6 | `serve='off'` → `willServe()` 恒 false |

`tests/fast-lane-audio-lane.test.ts`（15 条）：认领、`discard`、`willServeAudio` 与
`reply()` 的 `routeTurn()` 一致性、>14 字 / 无 qwen-flash key 也照样走 omni、
账本记真实 `truncated`；补充 `reconcileTurnOutcome` 按 `{no, gen}` 票据精确回写与
`lastLedgerLane()`。
`tests/turn-runner-stream.test.ts`（22 条）：单泵播放、打断、垫话保留
（**不许 `audio.stop` 掐断**）；共享内核结算、`settleTurn.inject` 三态；
注入 `LiveVoiceEngine` / `CascadeVoiceEngine` 时仍是同一个 `for await`；
`speakAudioAnswer` 与 `cancelCanned` 共用播报链。
`tests/kernel.test.ts`（27 条）：旧段不产意图、乱序不变性、控制面/物理面拆权、
媒体尺子、换引擎零改内核、`step` 纯性、重复结算幂等；补充 `isPreTurnCommit`、
`stepInput` / `stepPlayback` / `stepDialog`、`KernelSettlement` 端口执行。
`tests/kernel-effects-wiring.test.ts`（4 条）：生产 `DialogRuntime.attachPorts()`
单次执行、摘端口反证、因果屏障、`ConversationLedger` 合一与重连播种。
`tests/fast-voice-engine.test.ts`（28 条）：`LiveVoiceEngine` / `CascadeVoiceEngine`
契约同构，加上 `AgentEngineAdapter` 把旧的 omni / 流式 / 整段回落收成同一条 `respond()`。
`tests/pipeline-mode.test.ts`（33 条）：显式 `live`/`cascade`、非法值失败、
`live` 缺 key 或缺 `qwen-realtime` 时失败、推断 live 同样不留快车道 key、
`OMNI_SHADOW=1` + `OMNI_ANSWER=off` 在 cascade 下挂只读探针。
`tests/live-orchestrator.test.ts`（13 条）：前台只播 omni；`tool_call` 不阻塞；
同一 `turnNo` 的 `early_rule` 与 `tool_call` 只打一次 dsh；`memory_silent` 零汇报；
`speakBackgroundReport` 的 `defer` / `fallback` / `spoken`。
`tests/background-task-bus.test.ts`（16 条）：去重升级、静默任务不播、
`needsVerbatimRead`、外部 `onAnnounce` 收成 `dsh_background`、一次只跑一个 `execute`。
`tests/cascade-agent.test.ts`（11 条）：`cascade` 里 `live` 档不会被选中，快车道与投机仍在。
`tests/pipeline-integration.test.ts`（7 条）：live 单泵出声且 `FastLlmClient` 不参与；
空窗后同一副 omni 嗓子汇报；忙时 `defer`；逐字走 TTS 并按 `spoken` 回注。
`tests/dialog-live-announce.test.ts`（8 条）：`spoken` / `defer` 排回队首 /
`verbatim` 与 `fallback` 走 TTS 并通知 `onFallbackAnnounceSpoken`。
`tests/detached-answer.test.ts`（7 条）：放手那一轮——`ask` 立刻收空答复、答案转播报、
被新题顶掉时**不补播但回注记忆**、显式取消连已放手的轮一起取消。
`tests/keepalive.test.ts`（14 条）：含 `dropPrefetch` / `reconcileTurnOutcome` /
`lastLedgerLane` 等全量可选能力 Proxy 透传清单——防 §6.4 复发。

离线 55 轮评测在 `bench/eval/`（`npm test` 的 glob 只收 `tests/*.test.ts`，
这套用 `npm run test:bench`）：

| 文件 | 做什么 |
|:---|:---|
| `manifest.json` | eval-v1，55 轮 |
| `server.ts` | 隔离沙盒，生产装配，stub dsh |
| `runner.ts` | 按 v2 `pcm16` 原速推流 |
| `score.ts` | 准确率 + 延迟护栏。延迟只调用 `latency-report.ts` 的 `computeTurns()` / `summarize()`。`--compare` 对两份汇总 |
| `score.test.ts` | 打分口径（同目录还有 `server-wiring.test.ts`） |

Wave A+B 快照是 `bench/eval/baseline/20261124-live-v1-wave-ab.json`
（`gitHead` `2ddf08b`）：S1 F1 **96.0%**、双答冲突 **0**；S2 忽略数字 ITN **100%**；
S3-M1 **4/4**、S3-M2 **1/1**、S3-M3 **2/2**、S3-M4 **2/2**；S4 完整短句 **4/4**。
