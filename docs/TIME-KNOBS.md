# 时间参数总表

> **这是生成物，别手改。** 重新生成：`python scripts/time-knobs.py --write`；
> `tests/time-knobs.test.ts` 会断言这份文件与源码一致。
>
> 为什么要有这张表：项目里既有「配置写 20 ms、实际门槛 75 ms」这种**口径错位**，
> 也有「模型变快后同一条等待从免费变成纯成本」这种**遮盖关系变化**。两件事
> 都只能靠「时钟」和「被谁遮住」两列看出来。

## 一、环境变量（`.env` 可调）

共 28 项。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `QWEN_ASR_VAD_SILENCE_MS` | 200 | wall（服务端） | `src/main.ts:104` | 无（已关：`turn_detection: null`，端点由 `VOICE_COMMIT_MS` 控） | — |
| `MIAI_HTTP_KEEPALIVE_MS` | DEFAULT_KEEPALIVE_MS | wall（连接空闲） | `src/main.ts:476` | 无（不产生延迟，只在超过服务端空闲时导致失败） | — |
| `FAST_LANE_TIMEOUT_MS` | 1200 | wall | `src/main.ts:610` | 模型段（它就是那一轮的上限） | FAST_LANE > 0 时固定；超时转 dsh |
| `KEEPALIVE_MINUTES` | 180 | wall | `src/main.ts:669` | 无关首声（不在停嘴→出声路径上） | — |
| `SEMANTIC_END_TAG_TIMEOUT_MS` | 400 | wall | `src/main.ts:840` | 同上（它只决定这一次判定放弃得多早，不单独产生等待） | — |
| `TURN_JUDGE_QUIET_MS` | 0 | wall | `src/main.ts:933` | 模型段 | — |
| `TURN_JUDGE_EXTEND_MS` | 200 | wall | `src/main.ts:942` | 模型段（模型 >200 ms 时几乎全遮住；模型变快后变成纯成本） | TURN_JUDGE_MAX_EXT 拍 / WAIT_BUDGET_MS 预算 / MAX_OPEN_SILENCE_MS |
| `TURN_JUDGE_TRIM_MS` | 20 | audio | `src/main.ts:956` | 判停侧车输入预处理（不额外等） | — |
| `TURN_JUDGE_WAIT_BUDGET_MS` | 200 | wall | `src/main.ts:967` | 同上 —— 200 是按「模型段 ~184 ms」定的，模型变慢要重算 | — |
| `TURN_JUDGE_SEQUENCE_BUDGET_MS` | 1200 | wall | `src/main.ts:971` | 模型段（只对数字/字母/「然后」这类句尾生效） | TURN_JUDGE_MAX_OPEN_SILENCE_MS |
| `TURN_JUDGE_MAX_OPEN_SILENCE_MS` | 650 | audio | `src/main.ts:977` | 无（它自己是上限） | — |
| `SEMANTIC_END_TAG_BUDGET_MS` | 300) } | wall | `src/main.ts:983` | 静候窗（`VOICE_OPEN_QUIET_MS` 200–300 ms）—— 判停请求在定稿时已发出，等不到就按「说完了」放行 | — |
| `VOICE_HOLD_MS` | 2000 | wall | `src/main.ts:986` | 无（它决定 `gate.close` 何时落，① 的起点；配大了 ① 会被算小） | — |
| `VOICE_PREROLL_MS` | 800 | audio | `src/main.ts:987` | 无（它是滑窗长度，不加延迟） | — |
| `VOICE_PAUSE_DETECT_MS` | 200 | wall | `src/main.ts:989` | ASR 解出句之前（提前起跑，不额外等） | — |
| `VOICE_SPECULATE_MS` | 100 | wall | `src/main.ts:991` | 同上（投机与 ASR 并行） | — |
| `VOICE_COMMIT_MS` | 20（仅 qwen-realtime） | wall→audio（见下方备注） | `src/main.ts:996` | 无 —— 它就是封段的那一刻，实际门槛被上行包长盖住 | 实际门槛 = 一整个上行包（75 ms），配置值被它盖住 |
| `VOICE_STT_COMMIT_MS` | 150（仅 qwen-realtime） | wall→audio（同 VOICE_COMMIT_MS，见下方备注） | `src/main.ts:1001` | 无（150 ms 仍早于判停的 200–300 ms 静音门槛，解码与判停那一拍重叠） | — |
| `VOICE_OPEN_QUIET_MS` | 300 | audio | `src/main.ts:1007` | ASR 已出句、等静音够了才开轮（**这段是纯等待**） | — |
| `VOICE_OPEN_QUIET_SHORT_MS` | 200 | audio | `src/main.ts:1008` | 同上（p ≥ 0.8 时走这条） | — |
| `MIAI_PHOTO_TIMEOUT_MS` | 60000 | wall | `src/main.ts:1041` | 无关首声（不在停嘴→出声路径上） | — |
| `MIAI_HQ_ARM_TIMEOUT_MS` | 15000 | wall | `src/main.ts:1048` | 无关首声（不在停嘴→出声路径上） | — |
| `MIAI_IDLE_TIMEOUT_MS` | 45000 | wall | `src/main.ts:1053` | 无关首声（不在停嘴→出声路径上） | — |
| `PET_GREET_AWAY_MS` | DEFAULT_PET_TIMING.greetAfterAwayMs | wall | `src/main.ts:1059` | 无关首声（不在停嘴→出声路径上） | — |
| `PET_CHATTER_IDLE_MS` | DEFAULT_PET_TIMING.chatterAfterIdleMs | wall | `src/main.ts:1060` | 无关首声（不在停嘴→出声路径上） | — |
| `PET_MIC_OPEN_TIMEOUT_MS` | 1500 | wall | `src/main.ts:1062` | 无关首声（不在停嘴→出声路径上） | — |
| `PET_LISTEN_MS` | DEFAULT_PROACTIVE.listenMs | wall | `src/main.ts:1064` | 无关首声（不在停嘴→出声路径上） | — |
| `PET_TICK_MS` | 3000 | wall | `src/main.ts:1065` | 无关首声（不在停嘴→出声路径上） | — |

## 二、布尔开关（会改变时刻或路径）

共 5 项。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `COSYVOICE_PREWARM` | 1 | —（开关） | `src/cosyvoice.ts:1115` | 无关首声（不在停嘴→出声路径上） | — |
| `FAST_LANE_SPECULATE` | 1 | —（开关） | `src/main.ts:582` | 无关首声（不在停嘴→出声路径上） | — |
| `FAST_LANE_PREFETCH` | 1 | —（开关） | `src/main.ts:622` | 无关首声（不在停嘴→出声路径上） | — |
| `FAST_LANE_PARTIAL_SPECULATE` | 1 | —（开关） | `src/main.ts:624` | 无关首声（不在停嘴→出声路径上） | — |
| `PET_PROACTIVE` | 0 | —（开关） | `src/main.ts:900` | 无关首声（不在停嘴→出声路径上） | — |

## 三、硬编码常量（改要动代码）

共 33 项。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `TAIL_TTL_MS` | 120000 | wall | `src/app/dialog.ts:41` | 无关首声（不在停嘴→出声路径上） | — |
| `ANNOUNCE_QUIET_MS` | 800 | wall | `src/app/dialog.ts:50` | 无关首声（不在停嘴→出声路径上） | — |
| `CLOCK_MISMATCH_MS` | 1e9 | —（判据） | `src/barge-voicing.ts:52` | 无（纯判据：只用来发现两把时钟接错，不放慢任何东西） | — |
| `STALL_PROBE_MS` | 600 | wall | `src/cosyvoice.ts:235` | 无（纯诊断看门狗：正常轮首块 ~350 ms 就拆掉，不产生任何等待） | — |
| `PREWARM_TTL_MS` | 3000 | wall | `src/cosyvoice.ts:364` | 定稿→开轮之间（正常 0–600 ms，用不完） | — |
| `TRUNCATED_EPSILON_MS` | 300 | —（判据） | `src/engine-contract.ts:108` | 无（纯判据：轮末判「用户少听了没有」，不产生任何等待） | — |
| `DEFAULT_MAX_TURN_MS` | 45000 | wall | `src/fsm-trace.ts:69` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_MAX_STOP_TO_FIRST_MS` | 15000 | wall | `src/fsm-trace.ts:70` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_BARGE_STOP_WITHIN_MS` | 500 | wall | `src/fsm-trace.ts:71` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_KEEPALIVE_MS` | 50000 | wall（连接空闲） | `src/http-agent.ts:27` | 无关首声（不在停嘴→出声路径上） | — |
| `WAITED_THRESHOLD_MS` | 100 | —（统计判据） | `src/latency-report.ts:185` | 无（报告分组门槛，不参与调度） | — |
| `FIRST_WORD_BUDGET_MS` | 1200 | wall | `src/latency-report.ts:598` | 无（它是报警线，不约束任何环节） | — |
| `SLOW_TURN_MS` | 1500 | —（统计判据） | `src/latency-report.ts:601` | 无（报告里的「慢轮」门槛） | — |
| `RESOLUTION_MS` | 25 | wall | `src/loop-lag.ts:29` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_SENTENCE_SILENCE_MS` | 200 | audio | `src/main.ts:400` | 无关首声（不在停嘴→出声路径上） | — |
| `ABANDON_TIMEOUT_MS` | 3000 | wall | `src/omni-tts.ts:113` | 无关首声（只在「上一条合成已作废」时出现；正常轮等到 done 就走，不进这个循环） | — |
| `DEFAULT_POLL_MS` | 60000 | wall | `src/pet/battery-cache.ts:20` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_CAPTURE_TIMEOUT_MS` | 20000 | wall | `src/photo-inbox.ts:38` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_CONFIRM_TIMEOUT_MS` | 40000 | wall | `src/photo-inbox.ts:45` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_TIMEOUT_MS` | 400 | wall | `src/semantic-endpoint.ts:48` | 无关首声（不在停嘴→出声路径上） | — |
| `CANCEL_GRACE_MS` | 2000 | wall | `src/session.ts:57` | 无关首声（不在停嘴→出声路径上） | — |
| `FORK_TIMEOUT_MS` | 2000 | wall | `src/session.ts:66` | 无关首声（不在停嘴→出声路径上） | — |
| `SUPERSEDED_TTL_MS` | 7 * 24 * 60 * 60 * 1_000 | wall | `src/session.ts:182` | 无关首声（不在停嘴→出声路径上） | — |
| `RECENT_MS` | 120000 | wall | `src/task-board.ts:44` | 无关首声（不在停嘴→出声路径上） | — |
| `PLAYBACK_POLL_MS` | 100 | wall | `src/turn-runner.ts:39` | 设备播报期间（轮询，不加延迟） | — |
| `PLAYED_GRACE_MS` | 3000 | wall | `src/turn-runner.ts:47` | 无关首声（不在停嘴→出声路径上） | — |
| `OMNI_DELEGATE_MAX_SPOKEN_MS` | 800 | wall | `src/turn-runner.ts:56` | 无（判据：超过它就不再把 dsh 的答案拼在后面） | — |
| `ASSEMBLER_FALLBACK_WINDOW_MS` | 600 | wall | `src/voice-session.ts:109` | ASR 出句之后（兜底，正常不触发） | — |
| `ASSEMBLER_PREDICT_LEAD_MS` | 65 | audio | `src/voice-session.ts:122` | ASR 出句之前 | — |
| `INITIAL_LISTEN_MS` | 60000 | wall | `src/voice-session.ts:131` | 无关首声（不在停嘴→出声路径上） | — |
| `CAPTURE_GRACE_MS` | 1500 | wall | `src/voice-session.ts:142` | 无关首声（不在停嘴→出声路径上） | — |
| `ASSEMBLER_TRAILING_TRIM_MS` | 20 | audio | `src/voice-session.ts:160` | 判停侧车输入预处理（不额外等） | — |
| `HANDSHAKE_WAIT_MS` | 1000 | wall | `src/voice-session.ts:404` | 无关首声（不在停嘴→出声路径上） | — |

## 四、还没标注的

这些不是遗漏登记，是**还没查清**。填之前不要凭直觉写 —— 「时钟」写错
比空着更糟，因为空着会被当成待办、写错会被当成结论。

- 缺「时钟」：（无）
- 缺「被谁遮住」：（无）

## 五、两条从这张表里读出来的结论

**1. `VOICE_COMMIT_MS` 的配置值从来没生效过。**

它比的是墙上时间（`t - lastVoicedAt`），而**同一个包里尾部的静音帧不参与计时**。
上行是 75 ms 一包，于是实际门槛是「一整个包的静音」—— 配置 20 和 40 的差别只在
包边界上。这解释了为什么「40 改 20 省 20 ms」那条结论也是错的。

**2. 判停的等待（`TURN_JUDGE_*`）现在是纯成本。**

它原本被模型段（300–570 ms）遮住；保活修好、模型段回到 ~184 ms 之后，「被谁遮住」
那一条就不再成立。所以 `WAIT_BUDGET_MS` 从 400 收到 200 —— 数字要跟着被遮住的
那个环节一起重算，不能一次定死。
