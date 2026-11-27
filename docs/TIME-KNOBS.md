# 时间参数总表

> **这是生成物，别手改。** 重新生成：`python scripts/time-knobs.py --write`；
> `tests/time-knobs.test.ts` 会断言这份文件与源码一致。
>
> 为什么要有这张表：项目里既有「眼镜 mSBC + 手动端点下，配置写 20 ms、
> 实际门槛是一整个上行包」这种**口径错位**，
> 也有「模型变快后同一条等待从免费变成纯成本」这种**遮盖关系变化**。两件事
> 都只能靠「时钟」和「被谁遮住」两列看出来。

## 一、一级运行旋钮（.env 公开可调）

共 13 项。扫描认 `envNumber` 与 `envNum`。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `KEEPALIVE_MINUTES` | 180 | wall | `src/main.ts:425` | 无关首声（不在停嘴→出声路径上） | — |
| `FAST_LANE_TIMEOUT_MS` | 1200 | wall | `src/runtime/pipeline-assembly.ts:365` | 模型段（它就是那一轮的上限） | FAST_LANE > 0 时固定；超时转 dsh |
| `VOICE_COMMIT_MS` | 20（仅 手动端点） | wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms） | `src/voice-config.ts:459` | 无 —— 它就是封段的那一刻，实际门槛被上行包长盖住 | 眼镜 mSBC + 手动端点下实际门槛 = 一整个上行包（75 ms）；浏览器 20 ms PCM 帧可按帧触发；服务端 VAD / 非手动端点 STT 归 0 |
| `VOICE_STT_COMMIT_MS` | 150（glasses）/ 320（browser） | wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms） | `src/voice-config.ts:460` | 无（150 ms 仍早于判停的 200–300 ms 静音门槛，解码与判停那一拍重叠） | — |
| `VOICE_OPEN_QUIET_MS` | 300 | wall | `src/voice-config.ts:461` | ASR 已出句、等静音够了才开轮（**这段是纯等待**） | — |
| `TURN_JUDGE_MAX_OPEN_SILENCE_MS` | 650 | wall | `src/voice-config.ts:465` | 无（它自己是上限） | — |
| `TURN_JUDGE_EXTEND_MS` | 200 | wall | `src/voice-config.ts:492` | 模型段（模型 >200 ms 时几乎全遮住；模型变快后变成纯成本） | TURN_JUDGE_MAX_EXT=2 拍 / WAIT_BUDGET_MS=200（普通句一拍满即触顶，第 2 拍仅留给 <200 ms 静音闸门、语义 more 豁免或序列句）/ MAX_OPEN_SILENCE_MS |
| `TURN_JUDGE_WAIT_BUDGET_MS` | 200 | wall | `src/voice-config.ts:509` | 同上 —— 200 是按「模型段 ~184 ms」定的，模型变慢要重算 | — |
| `TURN_JUDGE_SEQUENCE_BUDGET_MS` | 1200 | wall | `src/voice-config.ts:513` | 模型段（只对数字/字母/「然后」这类句尾生效） | 声学静音受 TURN_JUDGE_MAX_OPEN_SILENCE_MS 封顶；语义 more 豁免后受 DEFAULT_GATE_HOLD_MS（2000 ms）封顶 |
| `SEMANTIC_END_TAG_BUDGET_MS` | 400 | wall | `src/voice-config.ts:520` | 静候窗（`VOICE_OPEN_QUIET_MS` 200–300 ms）—— 判停请求在定稿时已发出，等不到就按「说完了」放行；同时作为超时上限（`semanticTimeoutMs` 与预算同一值）。Pure Live 默认关闭，`SEMANTIC_END_TAG=1` 才开 | — |
| `MIAI_CONFIRM_TIMEOUT_MS` | DEFAULT_CONFIRM_TIMEOUT_MS | wall | `src/voice-config.ts:525` | 无关首声（不在停嘴→出声路径上） | — |
| `MIAI_PHOTO_TIMEOUT_MS` | 60000 | wall | `src/voice-config.ts:536` | 无关首声（不在停嘴→出声路径上） | — |
| `MIAI_IDLE_TIMEOUT_MS` | 45000 | wall | `src/voice-config.ts:537` | 无关首声（不在停嘴→出声路径上） | — |

## 二、路径布尔开关（会改变时刻或路径）

共 6 项。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `COSYVOICE_PREWARM` | 1 | —（开关） | `src/cosyvoice.ts:1284` | 直接省首声（Cascade 路径：定稿→开轮间提前建 TTS task，把建连/开流藏进判停等待；关掉首块多付冷开开销；Pure Live 不走 CosyVoice） | — |
| `FAST_LANE_SPECULATE` | 1 | —（开关） | `src/main.ts:445` | 直接省首声（Cascade 路径：快模型与 dsh 并行投机，把委派轮的快车道判定藏进 dsh 首字里；关掉退回串行，委派轮白等一次判定；Pure Live 不走） | — |
| `PET_PROACTIVE` | 0 | —（开关） | `src/main.ts:863` | 无关首声（控制宠物主动开口，不在用户停嘴→出声路径上） | — |
| `FAST_LANE_DELEGATE` | 0 | —（开关） | `src/runtime/pipeline-assembly.ts:355` | 直接改路径（Cascade 路径：0=纯聊天模型直答不委派；1=短句直答、复杂任务委派 dsh，开启后委派轮走慢车道；Pure Live 不走） | — |
| `FAST_LANE_PREFETCH` | 1 | —（开关） | `src/runtime/pipeline-assembly.ts:369` | 直接省首声（Cascade 路径：ASR 定稿即提前起跑快模型，与判停静候窗重叠；关掉退回开轮才发请求，直接增加首声延迟；Pure Live 不走） | — |
| `FAST_LANE_PARTIAL_SPECULATE` | 1 | —（开关） | `src/runtime/pipeline-assembly.ts:370` | 直接省首声（Cascade 路径：在 ASR 定稿前 100 ms 用中间结果提前发快模型，给提前合成音频腾窗口；关掉丢失这段重叠窗口；Pure Live 不走） | — |

## 三、二级热路径内部常量（写死代码，受不变量约束）

共 19 项。写死在代码里，不进 `.env`；单配置关系由 `validateVoiceTiming` 守，`--check` 对齐同一套并补上跨模块默认值。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `SEMANTIC_MORE_MIN_WAIT_MS` | 350 | wall | `src/assembler/semantic-gate.ts:58` | 普通静音上限下语义 `more` 的单拍下限（受 `TURN_JUDGE_MAX_OPEN_SILENCE_MS - quietNow` 与短碎片上限夹住） | — |
| `SEMANTIC_MORE_SEQUENCE_WAIT_MS` | 550 | wall | `src/assembler/semantic-gate.ts:64` | 序列预算大于普通静音上限时语义 `more` 的单拍等待（受 `TURN_JUDGE_SEQUENCE_BUDGET_MS - quietNow` 夹住） | — |
| `PREWARM_TTL_MS` | 3000 | wall | `src/cosyvoice.ts:414` | 定稿→开轮之间（正常 0–600 ms，用不完） | — |
| `DEFAULT_RING_MS` | 150 | audio | `src/omni/protocol.ts:60` | 无（Omni 影子旁路静音期环形预卷长度，防软起音被裁，不加延迟） | — |
| `VAD_FRAME_MS` | 32 | audio | `src/uplink-pipeline.ts:16` | 无（神经 VAD 的帧长，时间戳按它倒推，不加额外等待） | — |
| `DEFAULT_DECODE_WAIT_MS` | 240 | wall | `src/utterance-assembler.ts:378` | 开轮前硬等在途 ASR 解码收尾上限（直接计入首声；超时按当前文本放行） | — |
| `DEFAULT_SHORT_FRAGMENT_WAIT_MS` | 400 | wall | `src/utterance-assembler.ts:384` | 短碎片与语义 more 的单拍兜底上限（实际受 `TURN_JUDGE_WAIT_BUDGET_MS` / `TURN_JUDGE_MAX_OPEN_SILENCE_MS` 夹住） | — |
| `DEFAULT_SHORT_FRAGMENT_WINDOW_MS` | 1200 | wall | `src/utterance-assembler.ts:387` | 距上一轮收下多久内的极短句算碎片（时间邻接判据，命中后触发短碎片等待） | — |
| `ASSEMBLER_FALLBACK_WINDOW_MS` | 600 | wall | `src/voice/endpoint-wire.ts:51` | 仅在无判停器且未设开轮静音门槛（服务端 VAD / NLS）时生效；手动端点配了 `VOICE_OPEN_QUIET_MS` 时不再盲等 600 ms | — |
| `ASSEMBLER_PREDICT_LEAD_MS` | 65 | wall | `src/voice/endpoint-wire.ts:64` | ASR 出句之前 | — |
| `DEFAULT_GATE_HOLD_MS` | 2000 | wall | `src/voice-config.ts:38` | 无（决定 gate.close 何时落，① 的起点；必须大于封段与开轮静音天花板） | — |
| `DEFAULT_GATE_PREROLL_MS` | 800 | audio | `src/voice-config.ts:40` | 无（它是滑窗长度，不加延迟） | — |
| `DEFAULT_MIN_SPEECH_MS` | 120 | audio | `src/voice-config.ts:45` | 无（单段有效有声不足 120 ms 不封段、不投机、不预跑；够了才进入静音门槛，不加额外等待） | — |
| `DEFAULT_ASR_PREROLL_MS` | 320 | audio | `src/voice-config.ts:50` | 无（开门时 ASR/Omni 只吃预卷尾部；TurnJudge 仍用完整 DEFAULT_GATE_PREROLL_MS，不加延迟） | — |
| `DEFAULT_PAUSE_DETECT_MS` | 200 | wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms） | `src/voice-config.ts:52` | ASR 解出句之前（提前起跑，不额外等） | — |
| `DEFAULT_SPECULATE_MS` | 100 | wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms） | `src/voice-config.ts:57` | ASR 解出句之前（Cascade 投机与 ASR 并行；Pure Live 自动归 0） | — |
| `DEFAULT_TRAILING_TRIM_MS` | 20 | audio | `src/voice-config.ts:59` | 声学判停输入预处理（不额外等） | — |
| `DEFAULT_GLASSES_STT_COMMIT_MS` | 150 | wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms） | `src/voice-config.ts:61` | 无（glasses 档案的 VOICE_STT_COMMIT_MS 默认值，仍早于 200–300 ms 开轮静音门槛） | — |
| `DEFAULT_BROWSER_STT_COMMIT_MS` | 320 | wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms） | `src/voice-config.ts:63` | 无（browser 档案的 VOICE_STT_COMMIT_MS 默认值，浏览器开 AGC 后放宽防词中切断） | — |

## 四、三级看门狗、运维超时与离线诊断阈值（无关首声热路径）

共 36 项。不在停嘴→出声路径上，改它们不动首声。

| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |
|:---|:---:|:---|:---|:---|:---|
| `TAIL_TTL_MS` | 120000 | wall | `src/app/dialog.ts:44` | 无关首声（不在停嘴→出声路径上） | — |
| `ANNOUNCE_QUIET_MS` | 800 | wall | `src/app/dialog.ts:53` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_SEMANTIC_BUDGET_MS` | 300 | wall | `src/assembler/semantic-gate.ts:70` | 模块兜底默认（生产由 `SEMANTIC_END_TAG_BUDGET_MS` 覆写；仅直接调 `UtteranceAssembler` 未传 `semanticBudgetMs` 时生效） | — |
| `CLOCK_MISMATCH_MS` | 1e9 | —（判据） | `src/barge-voicing.ts:52` | 无（纯判据：只用来发现两把时钟接错，不放慢任何东西） | — |
| `STALL_PROBE_MS` | 600 | wall | `src/cosyvoice.ts:252` | 无（纯诊断看门狗：正常轮首块 ~350 ms 就拆掉，不产生任何等待） | — |
| `TRUNCATED_EPSILON_MS` | 300 | —（判据） | `src/engine-contract.ts:161` | 无（纯判据：轮末判「用户少听了没有」，不产生任何等待） | — |
| `DEFAULT_MAX_TURN_MS` | 45000 | wall | `src/fsm-trace.ts:71` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_MAX_STOP_TO_FIRST_MS` | 15000 | wall | `src/fsm-trace.ts:72` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_BARGE_STOP_WITHIN_MS` | 500 | wall | `src/fsm-trace.ts:73` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_KEEPALIVE_MS` | 50000 | wall（连接空闲） | `src/http-agent.ts:27` | 无关首声（不产生延迟，只在超过服务端空闲时导致连接失效） | — |
| `WAITED_THRESHOLD_MS` | 100 | —（统计判据） | `src/latency-report.ts:210` | 无（报告分组门槛，不参与调度） | — |
| `FIRST_WORD_BUDGET_MS` | 1200 | wall | `src/latency-report.ts:717` | 无（它是报警线，不约束任何环节） | — |
| `SLOW_TURN_MS` | 1500 | —（统计判据） | `src/latency-report.ts:720` | 无（报告里的「慢轮」门槛） | — |
| `RESOLUTION_MS` | 25 | wall | `src/loop-lag.ts:29` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_SENTENCE_SILENCE_MS` | 200 | audio（服务端） | `src/main.ts:201` | 仅旧 NLS 路径（`--stt aliyun`）：服务端判句纯静音等待；`qwen-realtime` 与 Pure Live 不用 | — |
| `DEFAULT_PET_TICK_MS` | 3000 | wall | `src/main.ts:204` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_PET_MIC_OPEN_TIMEOUT_MS` | 1500 | wall | `src/main.ts:206` | 无关首声（不在停嘴→出声路径上） | — |
| `ABANDON_TIMEOUT_MS` | 3000 | wall | `src/omni-tts.ts:129` | 无关首声（只在「上一条合成已作废」时出现；正常轮等到 done 就走，不进这个循环） | — |
| `DEFAULT_CAPTURE_TIMEOUT_MS` | 20000 | wall | `src/photo-inbox.ts:38` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_CONFIRM_TIMEOUT_MS` | 40000 | wall | `src/photo-inbox.ts:45` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_DECODE_TIMEOUT_MS` | 8000 | wall | `src/qwen-realtime-asr.ts:48` | 无关首声（纯防卡死看门狗：正常 ASR 定稿 ~200 ms 即拆掉，只在服务端丢回包时触发解锁） | — |
| `REFINE_TIMEOUT_MS` | 3500 | wall | `src/runtime/asr-refine.ts:21` | 无关首声（仅异步委派 dsh 前的整句精转超时；前台 Omni 应声不等待它，超时安全回退流式初转） | — |
| `REFINE_MIN_DURATION_MS` | 200 | audio（门控） | `src/runtime/asr-refine.ts:22` | 无（纯判据：整句 PCM 不足 200 ms 跳过精转，不加任何延迟） | — |
| `DEFAULT_TIMEOUT_MS` | 25000 | wall | `src/runtime/model-assets.ts:63` | 模块兜底默认（生产由 `SEMANTIC_END_TAG_BUDGET_MS` 覆写；仅直接调 `semanticEndpoint` 未传 `timeoutMs` 时生效） | — |
| `SUPERSEDED_TTL_MS` | 7 * 24 * 60 * 60 * 1_000 | wall | `src/session/superseded.ts:10` | 无关首声（不在停嘴→出声路径上） | — |
| `CANCEL_GRACE_MS` | 2000 | wall | `src/session.ts:84` | 无关首声（不在停嘴→出声路径上） | — |
| `FORK_TIMEOUT_MS` | 2000 | wall | `src/session.ts:93` | 无关首声（不在停嘴→出声路径上） | — |
| `RECENT_MS` | 120000 | wall | `src/task-board.ts:44` | 无关首声（不在停嘴→出声路径上） | — |
| `PLAYBACK_POLL_MS` | 100 | wall | `src/turn-runner.ts:68` | 设备播报期间（轮询，不加延迟） | — |
| `PLAYED_GRACE_MS` | 3000 | wall | `src/turn-runner.ts:76` | 无关首声（不在停嘴→出声路径上） | — |
| `SPEAKING_WATCHDOG_MIN_MS` | 350 | wall | `src/utterance-assembler.ts:393` | 无关首声（`speaking_more` 断流兜底定时器最短等待；持续说话期间每帧刷新，仅彻底停帧时防卡死） | — |
| `SPEAKING_WATCHDOG_MARGIN_MS` | 100 | wall | `src/utterance-assembler.ts:399` | 无关首声（`speaking_more` 断流兜底相对静默/延长门槛的余量，确保晚于正常静音收口） | — |
| `HANDSHAKE_WAIT_MS` | 1000 | wall | `src/voice/handshake.ts:21` | 无关首声（不在停嘴→出声路径上） | — |
| `INITIAL_LISTEN_MS` | 60000 | wall | `src/voice/mic-phase.ts:22` | 无关首声（不在停嘴→出声路径上） | — |
| `CAPTURE_GRACE_MS` | 1500 | wall | `src/voice/mic-phase.ts:33` | 无关首声（不在停嘴→出声路径上） | — |
| `DEFAULT_PLAYBACK_TAIL_MS` | 600 | wall | `src/voice-config.ts:35` | 无关首声（播完后等扬声器尾音散尽，防回声） | — |

## 五、还没标注的

这些不是遗漏登记，是**还没查清**。填之前不要凭直觉写 —— 「时钟」写错
比空着更糟，因为空着会被当成待办、写错会被当成结论。

- 缺「时钟」：（无）
- 缺「被谁遮住」：（无）

## 六、从这张表里读出来的结论

**1. `VOICE_COMMIT_MS` 的「20 ms 失效」只在眼镜 mSBC + 手动端点下成立。**

眼镜上行 75 ms 一包，同一个包尾部的静音不计入 `frame.silenceMs`，
所以配置 20 与 40 只在包边界上有差别，实际门槛是一整个上行包。
浏览器端是 20 ms PCM 帧，20 ms 可以按帧触发。
`QWEN_ASR_TURN_DETECTION=vad`，或 STT 不是 `qwen-realtime` 时，`commitMs` 直接归 0。

**2. 判停等待（`TURN_JUDGE_*`）现在是纯成本，且普通句上 `MAX_EXT=2` 已被 `WAIT_BUDGET_MS=200` 压成单拍。**

当前 `WAIT_BUDGET_MS`（200）与 `EXTEND_MS`（200）相等。
普通句走完一拍完整的声学延长，预算就耗尽；这段等待不再被模型段盖住，等满就是纯成本。
第 2 拍只在三类情况触发：静音闸门先等了不到 200 ms；
语义判停明确回 `more`（`unsureAteBudget()` 豁免）；
序列句改走 `WAIT_BUDGET_SEQUENCE_MS=1200`。

**3. 总表按三层旋钮 + 独立开关节共四张表组织（合计 74 项），双检口径对齐。**

四张表是：一级 `.env` 公开可调的运行旋钮；路径布尔开关；
二级热路径内部常量；三级看门狗、运维超时与离线诊断阈值。
合计 74 项，这个数由扫描结果填上，不在文里写死。

`validateVoiceTiming` 守全部单配置运行时不变量，非法组合进不了会话。
`--check` 对齐同一套，并额外守跨模块源码默认值
（`PREWARM_TTL_MS` / `DEFAULT_KEEPALIVE_MS` / `SEMANTIC_MORE_*_WAIT_MS`）。
改了一个数让另一条门槛够不着，这里也会红。
