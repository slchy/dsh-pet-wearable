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

> **硬约束：omni 开着的时候，快车道的每一轮都必须由它答。**
> 一轮退回级联，用户就会在同一段对话里听到两副嗓子。所以下面对 `willServe()`
> 的判据是**宽**的（宁可等，也不放），而任何 `lane_ok:false && text_ok:true`
> 的 `agent.lane` 都是缺陷，要清零。§12.4 列了剩余路径。

```ts
interface FastLaneAudioLane {
  willServe(): boolean;               // 纯读
  claim(): AgentAudioAnswer | null;   // 认领，一份只给一个消费者
  discard(): void;                    // 这一轮不采纳：cancel + 删半句
  interrupt?(): void;                 // 播到一半被打断：cancel 但保留
  injectAnswer?(user: string, said: string): void;  // 委派轮回注
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
| `interrupt()`（播到一半被打断） | **不删** | 用户已经听到了一部分；删掉就和快车道 `pending` 里记的半句对不上 |

### 4.8 委派轮回注：`role` 必须是 `user`

委派轮是 omni 先答了个开头、被掐掉交给 dsh。omni 的服务端历史里只有
「用户问了什么」，**不知道 dsh 答了什么**——这是「缺失」，不是「污染」。

回注的四条约束（前两条来自实测，后两条来自跑起来的教训）：

1. **`role: 'user'`**。`assistant` 角色三种 content type 全都回 `created` + item id，
   但模型当没看见（§5.2）。
2. **带上原问题**。委派轮动辄十几秒，期间用户可能又问了别的，只给答案会让
   后面几轮的指代全乱。
3. **硬截断 200 字**。dsh 的答案动辄几百字，整段塞进去只是烧 token，
   而且它会一直留在上下文里（到 ~6600 token 才被截断）。
4. **等 `ready` 再发**。忙的时候排队（上限 4 条），`response.done` 之后 flush。
   插在一条正在生成的回复中间会让它自己那轮的指代也乱。

宿主只在**这一轮真的播完了**时调 `injectAnsweredTurn`（`turn-runner` 的
`replyPath === 'dsh' && !interrupted && audioBytes > 0`）。被打断的正文不回注——
用户没听到的东西不该变成 omni 的记忆。

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
| `conversation.item.create`（**`user` 角色**） | 注入文本 → 下一轮**照做**（3/3） | **回注 dsh 答案可行**，见 §5.2 |
| `conversation.item.create`（`assistant` 角色） | 回 `created` 和 item id，但模型**当没看见** | 伪造自己的历史被拒。**不能拿 token 数判定**，见 §5.2 |
| `conversation.item.truncate` | 6 s 无 ack 无 error | **不支持** |
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
  "serve": "full", "state": "busy", "has_resp": true,
  "cancelled": false, "claimed": false, "turn_seqs": 2 }
```

**为什么需要**：`willServe()` 是个布尔，false 的时候看不出是「没开」「没 response」
「被取消了」还是「文本闸拒了」——这几种的修法完全不同，而线上没法打日志重放。

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
关掉的方式是把 `OMNI_ANSWER` 设 `off`——此时 `sendSessionUpdate()` 不挂 `tools`。

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
[omni-shadow.ts:66](../../src/omni-shadow.ts) 的注释、`LEAD_IN_CLAUSE` 的实测记录，
以及 [omni-shadow.ts:584](../../src/omni-shadow.ts) 的警告。

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
| 不播 omni 音频 | `OMNI_ANSWER=off\|full` | 量的目的就是接管 |
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
| `~380 行`，`fronted-agent.ts` 零改动 | 850 + 4 处改动 | 记忆复用 `pending` |
| 无「删半句」 | `discard()` 标 `deleteOnDone`，`done` 到了才删（见 §4.6） | 那会儿才有 item id |
| 无「回注」 | `injectAnswer()`：`user` 角色 + 带原问题 + 硬截断 + 等 `ready`（见 §4.8） | 委派轮 omni 会失忆 |
| 写在 `QOS.md` 里 | 独立本文 + `QOS.md` 附录一行 | 篇幅 |

### 12.1 当前空档

1. **两副嗓子**：omni 轮与级联轮音色不同（omni 是 Tina，级联是龙安欢）。
   全量之后降成「委派轮偶尔切」（dsh 链路在 S5 之前仍是 CosyVoice），不是完全消失。
2. **tool_call 自委派从未在真机触发过**：两场 `delegate` 只有 1 个 `task`
   （本地 `isFastCandidate` 拦的）。代码与单测都在，缺一次真机验证。
3. **`✗ ASR: maybe no invalid audio stream`** 偶发，归属未确认（疑为既有问题，
   不是 omni —— 分属两条 WS）。
4. **上下文双轨**：omni 的服务端历史与 `FrontedAgent.pending` 各记一份，
   靠 `noteServedTurn` / `injectAnsweredTurn` 两个口子保持一致。这是 pipe 形态的
   固有代价，不是缺陷。

### 12.2 已解决的（留作来由）

| 曾经的空档 | 怎么解决的 |
|:---|:---|
| 并段轮被 `clip` 拒（约 27% 轮走级联） | **砍掉 `clip`**：探针实测并段轮回答质量 5/5 与单段轮无差别；真正担心的「掐半句」22 轮里只 3 次、全是用户自己插话 |
| 半句留在服务端历史 | `discard()` 标 `deleteOnDone` → `response.done` 拿到 item id 再删（§4.6） |
| 委派轮 omni 失忆 | `user` 角色 `item.create` 回注（§4.7） |
| 插话时 omni 的 response 没人掐 | `cancelTurn` → `interrupt()`（§4.5） |

### 12.3 回滚（一直可用）

```bash
cd <部署路径> && sed -i 's/^OMNI_ANSWER=.*/OMNI_ANSWER=off/' .env && sudo -n systemctl restart miai-harness
```

`off` 仍保留影子测量，只是不发声。

### 12.4 硬约束之下还剩哪些「退回级联」的路径

判据统一用档案：`agent.lane` 里 **`lane_ok:false && text_ok:true`** —— 这表示
不是文本闸把这一轮判给了 dsh，而是车道自己没接住。**这个数应当是 0。**

| 路径 | 现在 | 说明 |
|:---|:---|:---|
| 排队窗口（92 ms） | **已修**（§4.6） | 曾经 2/38 |
| `state === 'connecting'` | 未处理 | 握手 1.3 s。此时 `seal()` 直接 `skipped`，音频**从来没发出去**，事后补不回来 —— 真要修得把整句 PCM 缓冲到 `ready`。三场 90 轮里出现 0 次 |
| `state === 'broken'` | 只能是整场退回 | 车道挂了以后每一轮都没 omni。这是**整场**退回纯级联，不是逐轮抖动；`break()` 落一条 `{skipped:'broken', why}` |
| 本轮已被 `interrupt()` | 不需要答 | 用户插话已经把这一轮作废了，不存在"该答没答" |
| `image !== undefined` | 不算 | 带图的轮次本来就要视觉模型，omni 这档接不了 |

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
