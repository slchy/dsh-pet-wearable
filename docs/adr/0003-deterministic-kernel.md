# ADR-0003 确定性内核：三种时间 + 正交区域 + 纯 `step()`

- 状态：已落地并完成收口（2026-11-23）
- 关系：细化 `docs/state-machines.md` §5.9；口径实现在 `src/kernel.ts`、
  `src/kernel-runtime.ts`、`src/causal.ts`、`src/engine-contract.ts`、
  `src/dialog-fsm.ts`、`src/app/dialog.ts`、`src/conversation-ledger.ts`；
  离线执行体是 `scripts/kernel-replay.ts`
- 契约 #5 的换泵与管道互斥：见 [ADR-0004](0004-flattened-pipelines.md)
  （2026-11-23 已接入 `TurnRunner` 生产热路径）

## 1 要解决的问题

真机上反复出现的一类 bug 长得都不像同一件事，事后归因却总是同一条：
**把「物理收到回调的时刻」当成了唯一的时间坐标系。**

| 真机事故 | 表面现象 | 实际成因 |
|:--|:--|:--|
| `20261123-053719` 第 2 轮 | 开轮 72 ms 后到达的转写被当成插话，老轮把自己前半句杀了 | 那段音频的 `commitSeq` **早于**开轮水位线，按到达时间判就反了 |
| 同一场第 5/7 轮 | 凭空多出「幽灵轮」 | 尾静音被服务端解成 `Thank you.`，按到达时间它是"用户说了话" |
| `20261123-051448` 第 5 轮 | 记「听了 2.72 s」，其实只送到 1.7 s | `heard` 用墙钟差算，而声音是**媒体**在走 |
| `20261123-051448` 第 9 轮 | 同一段内容听两遍 | 掐断语义建立在"`audio.stop` 能收回已播内容"这个错误前提上 |
| 播完估算 | 长音频播完后多锁 1.0–1.5 s `speaking` | 拿"流收齐时刻"当播放起点 |

## 2 决策

### 2.1 三把尺子分开，判据按性质选

| 尺子 | 载体 | 回答 | 用在哪 |
|:--|:--|:--|:--|
| 逻辑因果 | `commitSeq`、票据 `{no, gen}`、`baseCommitSeq` | 谁发生在谁之前 | 能不能打断、这份回答归谁 |
| 媒体时间 | 字节数 / 采样率（`at.pcm` / `at.down`） | 声音在声学轴上落到哪 | `heardMs`、`truncated`、续话 |
| 墙钟 | `clock.now()` | 等了多久 | 超时、轮询 |

**铁律**：因果裁决一秒都不看表；进度与超时不用序号。`heard = min(total, elapsed, sentMedia)`
—— 声音播不了比实时快（`elapsed` 是物理上限），也播不了还没送到的东西（媒体游标是上限）。

### 2.2 判定层是纯 Mealy 机

`step(state, event) → [state, effects]`，文件里没有 `await`、没有定时器、没有 socket。
状态转移只产出**声明式意图**（`Effect`），由 `kernel-runtime.ts` 的解释器执行 ——
DashScope 那种「discard 时还没拿到 assistantItemId，必须等 `response.done` 再发
`item.delete`」的协议脏活全部关在适配器里。

为什么必须纯：`TurnRunner` 是一条 `async` 泵，它在 `await` 回执 / dsh / TTS 之间改状态。
真机上踩过它的典型死法——「`await` 回执时插话把状态改了，老协程醒来又覆盖回去」。
`step` 是原子的同步函数，抢占只可能发生在两次 `step` 之间，那时状态已是完整的一份。
（抽内核时它 835 行 / 20 个 `await`；收口后 1147 行 / 27 个，但**判定已经搬走**。）

**收口后（2026-11-23）**：`step()` 本身只剩三步 —— 因果屏障 → `closed` 吸收态守门 →
按区域分派，约 25 行。真正的转移拆进 `stepInput` / `stepPlayback` / `stepDialog`
三个窄函数，每个只读自己那一区；事件分组用 `Extract` / `Exclude` 从 `KernelEvent`
**派生**而不是手抄，新增事件时三个 switch 会在编译期报「少了一个 case」，不会悄悄
落进某个 `default`。

### 2.3 四个正交区域，跨区只读快照

`input`（这句说完没 / 解码在不在途）· `dialog`（话筒主权）· `playback`（播到哪）·
`ledger`（谁答过）。硬塞进一个枚举会状态爆炸：这四件事是**同时发生、独立演进**的。

三条交互律：

1. **事件自带出生证**：跨异步边界的请求带上 `commitSeq`/票据，结果回来原样带回。
2. **控制权与物理结算拆权**：`stale`（票据被顶掉，瞬时、离散）归 `dialog`；
   `truncated`（少听了，后验、连续）归 `playback`。真机 `20261123-002440` 第 3 轮
   「19.44 s 正好播完、用户 26 ms 后才开口」就是 stale 但没少听 —— 该回注记忆。
3. **跨区只读快照**：判打断只比 `event.commitSeq > dialog.ticket.baseCommitSeq`。

**收口后（2026-11-23）这三条落在谁身上**：

- **装配与执行**：`DialogRuntime`（`src/app/dialog.ts`）用 `KernelRuntime.attachPorts()`
  绑一次生产 `KernelPorts`；`DialogFsm` 与 `TurnRunner` 的每条事件都走
  `dispatchAndApply()`，四种意图（`stopDeviceAudio` / `invalidateTurn` /
  `abortEngine` / `settleTurn`）**各执行一次** —— `DialogFsm` 不再另发
  `audio.stop`，`SessionCore` 也不再发第二份 `call:audio.stop`。
- **唯一的因果屏障**：`isPreTurnCommit(state, commitSeq)`（`src/kernel.ts`）被内核的
  `isCausallyStale` 与 `SessionCore` 共用；`voice-session.ts` 里的
  `fromPreTurnSegment` / `partialFromPreTurnSegment` 已删除，不再有前置副本。
- **结算快照**：`settleTurn` 带 `inject`（`spoken` / `unspoken` / `none`）、
  `heardMs`、`totalAudioMs`、`lane`、`endedAtMs`；`KernelPorts.settleTurn` 把后验的
  `truncated` 与 `endedAtMs` 按**精确的** `{no, gen}` 票据经 `reconcileOutcome`
  回写 `FrontedAgent` 的 `ConversationLedger`（对不上就一个字段都不动）。重连时
  `initialKernelState` 用 `agent.lastLedgerLane()` 播种 `lastLane` —— 内核可以新建，
  「上一轮谁答的」不能丢。

## 3 备选方案与为什么不选

| 方案 | 为什么不选 |
|:--|:--|
| 继续在 `TurnRunner` 里加判据 | 它是一条 1000+ 行的 `async` 泵（抽内核时 835 行 / 20 个 `await`）；每加一条判据都在同一个协程里与 I/O 交错，重入无法证明，只能靠回放碰 |
| 用时间戳代替序号做因果 | 到达时刻可被网络抖动、服务端重排任意改变（±300 ms 就足以颠倒），序号不可 |
| 把所有相位也搬进内核 | v1 时**刻意推迟**：要动 460 行 `DialogFsm` 与全部调用点，收益只是"少一处真相"，而当时没有对应 bug，风险大于收益。**已收口（2026-11-23）**：`DialogFsm` 现在是 `runtime.state.dialog` 之上的薄门面 —— 只翻译事件、只读快照，第二份相位（`_turn` / `_gen` / `_endAfterSpeech` / `_receiptOnly`）已删除 |
| 不做幂等结算 | 打断当场结算过一次，协程收尾会再报一次；不幂等就把"少听一半"重算成"听了 0 秒、没少听"→ 该吞的答案被回注 |

**曾推迟、现已落地（2026-11-23）**：契约 #5（`FastVoiceEngine`）已经接进 `TurnRunner`
的生产热路径。`VOICE_PIPELINE=live` 注入 `LiveVoiceEngine`（`LiveOrchestrator.toEngine()`
里的 omni 音频），`VOICE_PIPELINE=cascade` 注入同一条 `respond()` 上的
`CascadeVoiceEngine` 契约（生产泵是 `CascadeAgent.toEngine()`）。`run()` 不再内部分
`omni` / `stream` / `pump`。逐轮延迟埋点（`tts.first` / `turn.end` 的 `dsh_ms` /
`audio_s`）仍留在泵外：引擎只报事实。决策正文见
[ADR-0004](0004-flattened-pipelines.md)。

## 4 验收（三条硬标准）

| 标准 | 怎么验 | 结果 |
|:--|:--|:--|
| 可离线 reduce 复现 | `scripts/kernel-replay.ts <events.jsonl>`：不开 WS、不等真实时间，逐轮与档案 `turn.end` 对账 | `053719` 5/5、`051448` 8/8、`20261123-081139` 13/13，零分歧（1 轮标测量误差） |
| 乱序不变性 | `tests/kernel.test.ts`：打乱到达顺序、插入 `gate`/`devicePlayed`、同一条插话重复到达 | 意图一字不差；重复到达只作废一次 |
| 换引擎零改内核 | 同一串事件按 live / cascade 两种节奏喂进去 | 状态与意图完全相同，**只有首块墙钟不同**（延迟指标，不是状态） |

**初版落地记录**：`npm test` 827/827；`fsm-trace-check` 对 13 轮真机回放 **✓ 没有违规**；
同一向量的「停嘴→首块」中位数 884 → 805 → 728 ms（依次为改内核前 / 内核落地 / 结算接入后），
差异主要是 STT 与 dsh 的 run-to-run 抖动，可归因于改动的部分是**没有引入新的 `await`**。

**收口后全量验收（2026-11-23）**：

| 门 | 结果 |
|:--|:--|
| `npm test` | **890/890**（当日实测；比初版 827 多出来的部分在 `tests/kernel.test.ts` 27 条、`tests/kernel-effects-wiring.test.ts` 4 条、`tests/fast-voice-engine.test.ts` 14 条、`tests/main-wiring.test.ts` 7 条、`tests/voice-session-reconnect.test.ts` 4 条；同一天删掉的 `battery-cache` / `device-host` 两套宠物测试是反向的一笔，所以不能拿总数跟旧记录直接横比） |
| `tests/fsm-verify.ts` | 36 个配置 / 330 条转移，全部不变量通过 |
| `npm run sim` | **40/40** |
| 依赖图 | `src/` 96 个模块**零环**（含 type-only import 也无环） |

## 5 影响

- 新增 `src/kernel.ts`、`src/kernel-runtime.ts`、`src/causal.ts`、`scripts/kernel-replay.ts`。
- `TurnRunner` 不再自己算 `heard`/`truncated`/`reflect`，只喂事实、取意图。
- `TurnRunner.run()` 只消费 `FastVoiceEngine.respond()`。`omni` / `stream` / `pump`
  三分支已离开生产热路径，见 [ADR-0004](0004-flattened-pipelines.md)。
- 加 `AgentProvider` 新的可选能力时，不再需要手工改转发表：`keepalive.trackActivity`
  已改成 `Proxy` + `WeakMap`，所有可选能力（`dropPrefetch` / `reconcileTurnOutcome` /
  `lastLedgerLane` / `detachTurn` 等，含以后新加的、运行时才挂上去的）自动透传
  （`tests/keepalive.test.ts` 钉住 `proxy.prefetch === proxy.prefetch` 与私有字段的
  `this`）。**但自己实现 `AgentProvider` 再转发的包装层仍要逐项透传** ——
  `tests/wiring-floor-cancel.test.ts` 卡的是"生产装配真的接上了"这条。
