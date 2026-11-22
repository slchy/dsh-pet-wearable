# omni 一体化车道

> **状态：现行。** 本文描述的是**已上线并在真机跑过的形态**，不是设计草案。
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
3. `seal()` 必须与 `stt.commit()` **同一行**发出（[voice-session.ts:669](../../src/voice-session.ts)）——
   差几行，②那段等待就会被算成 omni 的耗时，整个口径作废。

好在封段归我们控：`commitAfterMs` 默认 20 ms，`utterance-assembler.ts` 零改动。

### 1.2 pipe 形态的固有代价

`create` 一发出去就收不回来。并段轮（用户句中停顿）必然先答了前半句，只能 `cancel` ——
此时 omni 的服务端上下文里躺着「前半句 → 被砍掉一半的助手回复 → 后半句」。

**这是买那 165 ms 付出的价格，不是实现缺陷。** 缓解手段见 §十二。

---

## 二、分层

五层，每层只对下一层负责。

```text
┌─ 5  装配层   main.ts              环境闸 / STT 兼容闸 / 启动自检
├─ 4  宿主层   voice-session.ts     挂点、连接生命周期
│              fronted-agent.ts     认领、记账、压投机
│              turn-runner.ts       播放、打断、转交
├─ 3  车道层   omni-shadow.ts       willServe / claim / discard / explain
├─ 2  段层     omni-shadow.ts       mute 状态机、ring、pipe 封段
└─ 1  传输层   omni-shadow.ts       WS、握手、事件流、计时、usage
```

2/3/1 三层在同一个文件里（[omni-shadow.ts](../../src/omni-shadow.ts)，850 行），
但它们**互不知道对方的存在**：传输层不知道有「段」，段层不知道有「车道」，
车道层不知道有 `TurnRunner`。分开文件会更"干净"，但这条通路的时序是全耦合的，
拆开只会让「一次改动要跳三个文件」——所以刻意留在一个文件里，靠注释分节。

---

## 三、车道层：三个方法的契约

```ts
interface FastLaneAudioLane {
  willServe(): boolean;               // 纯读
  claim(): AgentAudioAnswer | null;   // 认领，一份只给一个消费者
  discard(): void;                    // 不采纳，立刻 cancel
  explain?(): Record<string, unknown>;// 只进档案，不参与决策
}
```

**为什么车道层不含「要不要用」的判断**：它有两个调用方——
`turn-runner`（决定要不要开流式 TTS）和 `fronted-agent`（决定要不要认领）。
两处判据必须完全一致，所以都走 `textEligible()` + `willServe()`。
一处放松就会「文本路预跑过、omni 也答了」，同一个问题付两次钱。

### 3.1 `AgentAudioAnswer` 的 `chunks` 是 async generator

```ts
readonly chunks: AsyncIterable<Buffer>;
readonly sampleRate: number;
transcript(): string;
delegateReason?(): DelegateReason | null;
```

不是数组、不是 `Promise`。两个原因：

- **认领时首块通常还没到**（认领在定稿 ~220 ms，首块 600–760 ms），所以必须能等。
- **判停延拍时认领会晚到 700–870 ms**，那时首块**已经发过来了**。
  所以 `resp.audio` 从 `seal()` 那一刻就开始攒，不等认领（[omni-shadow.ts:446](../../src/omni-shadow.ts)）。
  不缓冲的版本会吞掉句首一两个字。

### 3.2 `transcript()` 是活 getter，不是 `Promise<string>`

被打断时 `Promise` 永远不 resolve，而**当前值正好是「已经播出去的那部分」**——
`said` 审计、记忆回写、打断续话要的就是它。

所以 `reply()` 返回的是活 getter（[fronted-agent.ts:1224](../../src/fronted-agent.ts)）：

```ts
return {
  get text() { return live(); },
  get speech() { return live(); },
  audio,
  path: 'omni',
};
```

**契约：轮末使用（`said` 审计、记忆回写）必须在音频流 drain 之后读。** 这不是疏忽。

---

## 四、段层：三条硬约束（全是踩出来的）

### 4.1 封段之后必须闭嘴

能量门 `holdMs` 默认 **2000 ms**，`commitMs` 默认 **20 ms**。
所以 `seal()` 之后还有 ~1980 ms 的**静音**会继续从 `onSpeech` 流进来。

无条件转发 = 每轮白灌两秒静音，既计费（Manual 模式静音不免费），
又会让下一轮 `restart()` 把这段残留 commit 成一条空白用户消息。

```text
seal()        → muted = true
feed(!voiced) → 只进 ring（150 ms 上限），一个字节都不发
feed(voiced)  → muted = false，先补 ring 再追加
```

`voiced` 必须由**能量门给**（`EnergyGateDecision.voiced`），不能自己按能量重算——
两处门限一漂移就会开始丢字或灌静音，而且从数据上分不出来。
这是唯一一条跨层数据约定，`onSpeech(pcm, voiced)` 一路透传。

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
（[omni-shadow.ts:545](../../src/omni-shadow.ts)）。这条错误也不计入协议错误计数。

### 4.4 不自动重连

`broken` 是终态。影子挂了就等于这次实验结束——少一个半夜自己重连、
把账单和口径都搅乱的东西。落一条 `{skipped:'broken', why}` 事件，人看见了再决定。

### 4.5 `restart()` 的四件事，顺序有讲究

1. 上一份还在生成 → **立刻 cancel**。用户说话有 2–3 s，够它干净收尾；
   等到 `seal()` 才 cancel 就把 ~80 ms 压在关键路径上。
2. 丢掉待发的 `pending`（句子还在继续，组装器会重新 `seal()`）。
3. 有残留就 `commit` 掉但**不发 create**——空缓冲 commit 会回
   `maybe no invalid audio stream`。
4. 解除闭嘴、推预卷。

---

## 五、协议事实（实测，勿照文档猜）

| 事实 | 实测结果 | 影响 |
|:---|:---|:---|
| 握手 | `session.created → session.update → session.updated` ≈ **1.3 s** | 与设备握手并行，不占关键路径 |
| `cancel` 往返 | → `response.done` **79–96 ms** | 尽量挪到用户说话期间 |
| 忙时 `create` | 报 `already has an active response`，**永久丢失** | 必须先 cancel 再排队 |
| `created` 前 `cancel` | 报 `Cannot cancel response before response.created` | `cancelPending` |
| 50 ms 短音频 `commit` | **不报错**（空转写、`completed`） | 但会造空白用户消息，所以看 `dirtyBytes` |
| `conversation.item.delete` | **有效**（三次复现，省 13–39 token） | 洗脏历史可用，**尚未接入** |
| `conversation.item.create` | 注入 112 字 → 下一轮 `in_tokens` 只多 **5** | 回注 dsh 文本**不可行**（只存不用） |
| `conversation.item.truncate` | 6 s 无 ack 无 error | **不支持** |
| 上下文上限 | ~**6600 token** 处服务端自动截断（6617→4387） | 漂移有界 |
| 长尾 | 一簇落在 1785–2130 ≈ 1×RTO(2040) | 疑为链路重传，不是厂商慢 |

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

---

## 六、宿主层：三处，各管一件事

### 6.1 `voice-session.ts` — 挂点与生命周期

三个回调各挂一行：

```text
onCommit     → archive(asr.commit) → stt.commit() → omni.seal(seq, silenceMs)
onSpeechOpen → assembler.resetAudio → stt.feed → omni.restart(preroll)
onSpeech     → stt.feed → omni.feed(pcm, voiced)
```

**连接按设备连接创建和销毁**（`start()` 里 `omni.start()` + `attachAudioLane(omni)`，
`onClose()` 里 `attachAudioLane(null)` 再 `omni.stop()`）。
不能在进程启动时建连——服务空跑几十分钟后 WS 早就空闲断链了。

`commitSeq` 是关键：**同一个值写进 `asr.commit` 和 `omni.shadow` 两处**。
真机有二次封段、咳嗽误触发、打断轮，没有 join key 三轮之后就错位了。

### 6.2 `fronted-agent.ts` — 认领与记账

**为什么复用它而不是另起旁路**：快车道的记忆就是 `FrontedAgent.pending` + `remember()`
（`keepTurns` / `overcap` / 给 dsh 带的上下文全长在那里）。旁路一旦绕开它，
omni 答过的轮次就不进历史，下一轮委派给 dsh 就**失忆**。

三件事：

| 位置 | 做什么 |
|:---|:---|
| `isPrefetchable()` | `audioLane?.willServe() === true → return false`。**压住旧车道的投机**，不压就每轮双倍烧 LLM 钱 |
| `reply()` 认领块 | `claim()` → 返回带活 getter 的 `AgentReplyView` |
| `delegate()` | 第一件事是 `audioLane?.discard()`，不让影子在后台把废音频生成完 |
| `noteServedTurn()` | 把 omni 实际播出的 `(userText, said)` 写回 `pending` —— **「记忆就来了」的全部内容** |

`willServeAudio()` 必须与 `reply()` 内部判据完全一致，所以都走 `textEligible()`。
`textEligible()` 复用 `isFastCandidate()`（只挡形态：空串 / >14 字 / 阿拉伯数字）
+ 记忆类 + 攒满上限。

### 6.3 `turn-runner.ts` — 播放与转交

```ts
const omniTurn = agent.willServeAudio?.(text) === true;   // 必须在起流式 TTS 之前

if (reply.audio !== undefined) {
  audioRate = reply.audio.sampleRate;          // 不做假设，按回答走
  for await (const chunk of reply.audio.chunks) { emit(chunk); }
  speech = reply.speech;                       // drain 之后才完整
  agent.noteServedTurn?.(text, speech);
  const why = reply.audio.delegateReason?.() ?? null;
  if (why !== null) {
    reply = await agent.reply(text, image, note, {
      forceDelegate: why,
      receiptSpoken: speech.trim() !== '',     // 已经出过声就不再叠回执
    });
  }
}
```

**`willServeAudio()` 必须在起流式 TTS 之前问**：那一步会真开一个合成 task，
而 omni 轮没文本可送，服务端拒空文本，整轮退化成兜底（比不走 omni 还慢）。

### 6.4 `keepalive.ts` — 装配层最大的坑

`trackActivity()` 用**对象字面量**包装 `AgentProvider`，每个可选能力都必须显式转发。
漏一个就是**静默降级、不报错**。

线上踩过整整一晚：`attachAudioLane` / `willServeAudio` / `noteServedTurn` 三个漏转发，
表现是「omni 一次都不接管」而日志里一条错误都没有。

防复发：`tests/keepalive.test.ts` 有一条「透传**全部**可选能力」的清单测试，
`main.ts` 启动打 `装配 agent=Object attach=function will=function`。

---

## 七、事件契约

### 7.1 `omni.shadow`（一份 seal 一条）

```json
{
  "seq": 2,                // 与 asr.commit 共用的 join key
  "warmup": false,         // 连接后第一份，分析时排除
  "seal_s": 2.27,          // restart→seal 推了多少音频（秒）
  "silence_ms": 66,        // 封段时距最后一个有声帧多久（与 asr.commit 同值）
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
{ "has_lane": true, "lane_ok": false, "text_ok": true, "ok": false,
  "serve": "clip", "state": "busy", "has_resp": true,
  "cancelled": false, "claimed": false, "turn_seqs": 2 }
```

**为什么需要**：`willServe()` 是个布尔，false 的时候看不出是「没开」「没 response」
「被取消了」还是「并段轮被 clip 档挡掉」——四种的修法完全不同，而线上没法打日志重放。

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

---

## 九、成本

| 项 | 单轮量 | 出处 |
|:---|:---|:---|
| 输入音频 | `seal_s × 7` token（3 s 话 ≈ 21） | 官方公式 |
| 输入文本 | **1102** 起（挂 tools），每轮 +~40 | 150 轮实测 |
| 输出音频 | `out_s × 12.5`（2.6 s ≈ 33） | 实测 `out_audio_tok` |
| 累积重算 | 历史每轮音频+文本都进下一轮输入 | 到 ~6600 tok 自动截断 |

**挂 tools 本身抬高基线约 400 token/轮**（713 → 1102），但 150 轮实测首块没变慢。
关掉的方式是把 `OMNI_ANSWER` 设 `off`——此时 `sendSessionUpdate()` 不挂 `tools`。

`OMNI_SHADOW` 未设 = **不建连、零成本**。

---

## 十、最脆的一处：工具描述

两次踩坑，代价都是**整轮零音频**：

| 写法 | 结果 |
|:---|:---|
| `description: '…查询实时信息…'` | 「他还写过哪些作品？」被 3/3 判成工具调用 |
| 提示词加「需要转交就调工具」 | 闲聊 3/3 被逼调用 |
| **只写「实际动手 / 读设备数据 / 长期记忆」** | **9/9 正常** |

**决定权在 `description`，不在提示词。** `instructions` 里任何关于「要不要调工具」的
暗示都会把闲聊推向调用。见 [omni-shadow.ts:66](../../src/omni-shadow.ts) 的注释与
[omni-shadow.ts:584](../../src/omni-shadow.ts) 的警告。

---

## 十一、明确不做

- ❌ 不自动重连、不做指数退避、不做降级（§4.4）
- ❌ 不做 omni 与级联的 hedge —— 两条腿的**文本和音色都不同**，
  先到先播会说出半句 A 半句 B
- ❌ 不用 `conversation.item.create` 回注 dsh 的文本答案 —— 实测**只存不用**（112 字仅 +5 token）
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
| 不播 omni 音频 | `OMNI_ANSWER=off\|clip\|full` | 量的目的就是接管 |
| 不进 `AgentProvider` 契约 | `AgentReplyView.audio` + `FastLaneAudioLane` | 播放要经过编排层 |
| 不碰 `TurnRunner` | 有独立播放分支 + tool_call 转交 | 同上 |
| `seed(ms)` / `feed(pcm)` | `seal(seq, silenceMs)` / `feed(pcm, voiced)` | join key + 闭嘴口径 |
| `dirty` 布尔 | `dirtyBytes` + `muted` + ring(150 ms) | 修「seal 后 2 s 静音灌进去」 |
| `pendingSeal = 1` | `pending: SealMeta`（带 bytes/seq/silence） | 排队时要钉住字节数 |
| `restart()` 只 commit 残留 | 先 cancel busy 再 commit | 否则下一轮被上一轮拖慢 |
| `start()` 末尾「预热 seal」 | **无**：`session.updated` 即 `ready` | 假 seal 会白花钱 + 往第 0 轮塞脏历史 |
| 事件字段 `extended` | 内部 `turnSeqs` + `flushed_ms` | 并段判据改成段数 |
| 事件字段 `feed_bytes` | `local_port` + `dropped_ms` | 排障用 `ss -ti` 更直接 |
| 无 `created_ms` | 无（`created` 只是内部布尔） | 没用到 |
| `~380 行`，`fronted-agent.ts` 零改动 | 850 + 3 处改动 | 记忆复用 `pending` |
| 写在 `QOS.md` 里 | 独立本文 + `QOS.md` 附录一行 | 篇幅 |

### 12.1 当前空档

1. **脏历史没洗**：`conversation.item.delete` 验证有效但未接入 `discard()`。
   委派轮和并段轮在 omni 服务端历史里会留「被砍断的半截回复」。
2. **`clip` 档拒并段轮**，导致约 1/4 轮走级联（第 2 场 7/26）。
3. **两副嗓子**：omni 轮与级联轮音色不同（omni 是 Tina，级联是龙安欢）。
4. **`✗ ASR: maybe no invalid audio stream`** 偶发，归属未确认（疑为既有问题，
   不是 omni —— 分属两条 WS）。

### 12.2 升级路径

```text
现在    OMNI_ANSWER=clip    单段轮由 omni 答，并段轮退回级联
  ↓     接 conversation.item.delete 进 discard()
下一档  OMNI_ANSWER=full    并段轮也由 omni 答，接管率 → ~100%
  ↓     实测两副嗓子是否可接受
目标    级联退成 dsh 通道 + 兜底
```

**升级前必须复验**：委派轮之后 omni 上下文有没有假记忆（`delete` 未接时必然有）、
并段轮的续接是否出错、实际听感是否接受两副嗓子。

### 12.3 回滚（一直可用）

```bash
cd <部署路径> && sed -i 's/^OMNI_ANSWER=.*/OMNI_ANSWER=off/' .env && sudo -n systemctl restart miai-harness
```

`off` 仍保留影子测量，只是不发声。

---

## 十三、测试

`tests/omni-shadow.test.ts`（假 socket 走 `RealtimeSocketFactory` 注入点）：

| # | 用例 |
|:--|:---|
| 1 | 正常一轮：字段齐全，`audio_ms` = 假服务端里定的延迟 |
| 2 | `connecting` / `broken` 时 `seal()` → 不 send，`skipped` 正确 |
| 3 | `created` 前 `cancel` → 记 `cancelPending`，`created` 到了才补发 |
| 4 | `busy` 时第二次 `seal()` → 先 cancel，`done` 之后才发第二组 commit+create |
| 5 | `restart()` 时 `muted` + ring → 静音不进 WS，有声才恢复 |
| 6 | `serve='off'` → `willServe()` 恒 false |

`tests/fast-lane-audio-lane.test.ts`（7 条）：认领、`discard`、`textEligible` 一致性。
`tests/turn-runner-stream.test.ts`（9 条）：播放分支、打断、tool_call 转交。
`tests/keepalive.test.ts`：「透传**全部**可选能力」清单——防 §6.4 复发。
