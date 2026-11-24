# 运维

跑起来之后的事：怎么常驻、怎么收鉴权、出问题怎么查。**不含业务逻辑**，那部分见
[CLOUD-ARCHITECTURE.md](./CLOUD-ARCHITECTURE.md)。

## 两种运行形态

| 形态 | 谁在跑 | 什么时候用 |
|---|---|---|
| **插件**（目标形态） | `dsh` 进程内的 `src/driver.ts`，`ctx.agents` 驱动对话 | 生产 |
| **独立进程**（现状） | `node src/main.ts --listen <port>` | 联调、真机验证、插件还没接线的部分 |

独立进程形态目前是唯一能跑通完整语音链路的形态。它自己不起 agent，而是把
`dsh` 当子进程拉起来说话（`--agent dsh`）：

```
node src/main.ts --listen 8766 --stt qwen-realtime --tts cosyvoice --agent dsh
  └─ dsh --profile sdk --patch <patch.yml>      ← stdio JSON-RPC，一辈子跟着父进程
     ├─ mcp/mcp-camera.mjs       拍照
     ├─ mcp/mcp-session.mjs      挂断
     ├─ mcp/mcp-memory.mjs       remember（写 MEMORY.md）
     └─ mcp/mcp-sessions.mjs     搜过去的对话
```

这行是现网组合：`--stt qwen-realtime`（DashScope）＋ `--tts cosyvoice`。
`QWEN_ASR_TURN_DETECTION` 默认 `manual`：端点由我们控，`VOICE_COMMIT_MS` /
`VOICE_STT_COMMIT_MS` / `VOICE_OPEN_QUIET_MS` 才有意义。设成 `vad` 时端点交给服务端，
`src/voice-config.ts` 把 `commitMs` / `sttCommitMs` 收成 0，并且不传开轮静音门槛，
免得客户端和服务器 VAD 各切一次。换回 NLS 写 `--stt aliyun`；
`--tts` 留空会兜底成 `mimo`（不是静音）。

`MEMORY.md` 放在 `--work-dir` 目录下，由 dsh 的 `agent-instructions` **每轮注入**
系统提示词（不用调工具，省一轮往返）；改它会让下一轮前缀缓存失效一次。

**两套主对话形态并存**，用部署侧的环境变量切（两份文件都在仓里，实测后再二选一）：

| `MIAI_AGENT_SHAPE` | 工具面 | 人设 |
|---|---|---|
| `full`（默认） | 主对话握全部工具（bash / 文件 / 工作流都在） | `mcp/profile.cordis.yml` |
| `delegate` | 主对话只留报时/天气/股价、搜资料、拍照、挂断、派人、叫停；跑命令与读写文件交给子代理 | `mcp/profile.delegate.cordis.yml` |

```bash
MIAI_AGENT_SHAPE=delegate python scripts/deploy_cloud.py   # 切到 delegate
python scripts/deploy_cloud.py                             # 不带就回 full
```

`KEEPALIVE_MINUTES`（默认 180，`0` 关闭）：空闲这么久就发一条极短请求把 DeepSeek
的前缀缓存焐热。实测缓存空闲 4.7 小时仍热、23 小时凉，凉了当天第一次开口要多等
1–3 秒。

两个要点：

- **`dsh` 没有 daemon 模式**。它的"常驻"完全来自父进程不杀它。要它活多久，就管好父进程。
- **`--dsh-sdk` 才能挂 MCP 工具**。不带这个标志的 headless 模式不接 `--patch`，工具根本
  不注册，模型只会回"工具不可用"。

常驻用一个 systemd 单元就够（`Restart=always`、`RestartSec=3`），`WorkingDirectory`
指向仓库/部署目录，凭据放 `.env` 且**不进同步范围**。

## 语音主管道

一次进程、一次会话只跑一条语音管道。开关是 `VOICE_PIPELINE`，判据在
[`src/pipeline-mode.ts`](../src/pipeline-mode.ts) 的 `resolveVoicePipeline` /
`resolveVoicePipelineFromEnv`。这两个函数不读 `process.env`，只解释调用方传入的那一份记录。
装配层把返回的 `mode` 传给连接的 `pipelineMode`，并把 `LiveOrchestrator.toEngine()`
或 `CascadeAgent.toEngine()` 交给 `TurnRunner`。

| `VOICE_PIPELINE` | 结果 |
|---|---|
| `live` | omni 直出。前台是 `LiveOrchestrator`，出话泵是 `LiveVoiceEngine`。`FastLlmClient` / `PrefetchSlot` 不加载 |
| `cascade` | 文本快车道 → TTS。前台是 `CascadeAgent`。`OMNI_ANSWER=full` 不会把发声抢回去 |
| 未设置，或只有空白 | 按下面的旧变量推断 |

大小写和首尾空白都认：`LIVE`、` cascade ` 都合法。其它值直接失败，错误原文是
`VOICE_PIPELINE 无效值 "<原文>"：只允许 "live" 或 "cascade"`。

**`live` 启动即失败**（默认严格），避免装成开了其实没声音：

| 缺什么 | 错误 |
|---|---|
| `OMNI_API_KEY` 与 `DASHSCOPE_API_KEY` 都空（只含空白也算空）。`resolveOmniApiKey`（`src/voice-config.ts`）有 `OMNI_API_KEY` 就用它，否则用 `DASHSCOPE_API_KEY`。CLI、Web 插件、评测沙盒同一份 | `VOICE_PIPELINE=live 需要 OMNI_API_KEY 或 DASHSCOPE_API_KEY` |
| 装配层传入的 STT 不是 `qwen-realtime` | `VOICE_PIPELINE=live 需要 --stt qwen-realtime（当前是 <名字>）` |

两样都缺时先报 key。按旧变量**推断**出来的 live 走同一套失败条件。

**没写 `VOICE_PIPELINE` 时：**

| `OMNI_SHADOW` | `OMNI_ANSWER` | 推断 |
|---|---|---|
| `1` | `full` 或 `clip`（凡不是 `off`） | `live` |
| `1` | `off`，或未设（未设按 `off`） | `cascade`，并挂只读探针（见下） |
| 不是精确的 `1` | 任意 | `cascade`，不挂探针 |

**只读探针**（cascade 里量封段→首块，不认领、不发声）：`OMNI_SHADOW=1`、
`OMNI_ANSWER=off`、音频 key 非空，并且 STT 未指定或就是 `qwen-realtime`。
显式 `VOICE_PIPELINE=cascade` 时同样可以这样挂。`OMNI_ANSWER` 写成 `full` / `clip`
时探针不挂，启动说明里会有一句
`显式 VOICE_PIPELINE=cascade：忽略 OMNI_ANSWER，不接管发声`。

`OMNI_SHADOW` 未设 = 不建连、零成本。回滚见 [OMNI-LANE.md](./OMNI-LANE.md) §12.3。

### 嗓子（TTS）不是管道的判据

`VOICE_PIPELINE` 只管「谁对用户出声」，**不校验 `--tts` 与它是否自洽**。两条管道对
`--tts` / `MIAI_TTS` 的用法也不一样：

| 管道 | `--tts` 的角色 |
|:--|:--|
| `live` | **不是主嗓子**。主嗓子是 omni 直出；`--tts` 只用于短回执（`live-orchestrator` 的 `receiptOnly`）、识图应声、取消确认与断线兜底。生产上配 `--tts omni` 是为了让回执与 omni 同音色 |
| `cascade` | **就是主嗓子**。逐句 `tts.synthesizeStream`，流式失败退回整段 `synthesize` |

所以 `VOICE_PIPELINE=cascade` + `MIAI_TTS=omni` 是**合法但没定义过**的组合：omni 朗读
连接是「攒完再念」（逐句要付一次 ~630 ms 握手），而 cascade 换嗓子的本意通常是压低首包。
启动期既不校验也不告警 —— **换管道时记得一起看 `--tts`**。

顺带：延迟数字必须标嗓子。历史上的「TTS 首包 330–400 ms」是 CosyVoice 测的；omni 朗读
连接是另一个量级（首块 630–780 ms），两者不能横比（口径见 [QOS.md](./QOS.md) §1.0）。

## 鉴权与 TLS

**先看判据**：非本机地址必须同时具备 token 与 TLS，否则不监听（退出码 2）。
判据在 [`src/bind-policy.ts`](../src/bind-policy.ts)，`transport.ts` 与 `driver.ts` 共用；
`tests/bind-policy.test.ts` 钉矩阵，`tests/transport-bind.test.ts` 断言拒绝时端口没被占。

### token 从哪来

**不来自任何外部系统，也不该复用眼镜的 token。** 由部署方在初始化时现场生成：

```bash
npm run pair -- new --device pixel-9 --host 203.0.113.10 --port 8766 --tls
# → 写入 tokens.txt，并打印 dshpet://pair?... 配对串
```

实现见 [`src/tokens.ts`](../src/tokens.ts)（生成 / 强度 / 文件 / 比对）与
[`src/pair.ts`](../src/pair.ts)（CLI）。四条要记住的行为：

| 行为 | 为什么 |
|---|---|
| **追加不覆盖** | 重新生成只影响新设备，不会把已配对的全部踢下线 |
| **弱 token 拒绝启动** | `< 32 字节` 报错并指向 `pair new`。`^[0-9a-f]{32}$` 额外判成「这是眼镜的 token」 |
| **文件变化自动重读** | 吊销不必重启。`TokenGate` 按 mtime 判，读不到就拒绝一切（fail closed） |
| **`token:deviceId` 真绑定** | `Hello.deviceId` 对不上也拒。否则那一列只是注释 |

### 宠物环（主动开口）

**默认关。** `AppSession` **总是构造**（它持有话筒仲裁 `FloorArbiter`，对话环自己要用）；
关掉的只是 `PetSession`（`PET_PROACTIVE=1` 才建）—— 也就是「不会主动开口」。
类名是 `VoiceConnection`（`src/voice-session.ts`），没有 `aliyun-session.ts` 这个文件。启动日志会明说：

```
宠物环   开（主动开口）：心跳每 3000 ms，离场 300000 ms 后重戴会打招呼
宠物环   关（PET_PROACTIVE≠1）：只跑对话环，不会主动开口
```

开着的时候，每次输入/意图都会打一行，**「它为什么不出声」要能当场读出来**：

```
宠物 ← 心跳  [闲置]
宠物 ·  心跳后仍不出声  [闲置]
宠物 ← 佩戴=戴上  [闲置]
宠物 → 进入 look（计划 look→compose→speak，截止 4000 ms，不占话筒）
宠物 → 收尾：greet / spoke
```

`[闲置]` / `[look #1]` 是当前 `engagement` 的阶段。心跳即便什么都不做也留一行 ——
它是唯一"没反应也照跑"的输入，不写就又回到"分不清没跑还是没想说"。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PET_PROACTIVE` | 未设（关） | `1` = 装宠物环 |
| `PET_TICK_MS` | `3000` | 心跳间隔。`src/main.ts` 的缺省（`envNumber('PET_TICK_MS', 3_000)`）；调用方没传 `tickMs` 时 `AppSession` 自己用 `30000` |
| `PET_GREET_AWAY_MS` | `300000` | 离场多久后重戴会打招呼 |
| `PET_CHATTER_IDLE_MS` | `1200000` | 安静多久后可以主动搭话 |
| `PET_LISTEN_MS` | 见 `DEFAULT_PET_PARAMS.listenMs` | 说完后开麦听回应多久。常量在 `src/pet/brain/registry.ts`（现为 `8000`）。`src/main.ts` 用 `envNumber('PET_LISTEN_MS', DEFAULT_PET_PARAMS.listenMs)` 送进主动开口 |
| `PET_MIC_OPEN_TIMEOUT_MS` | `1500` | 开麦到首帧上行的截止 |

> 注意 `presence`（佩戴）不是所有设备都报。v1 基线没有佩戴源，`greet` 这条触发不了，
> 能观察到的第一条通常是 `chatter`（安静够久）。

**已建立的连接不会因吊销而断开** —— 吊销影响新连接；要立刻清场就重启进程。

### 独立进程形态的环境变量

| 环境变量 | 作用 |
|---|---|
| `MIAI_TLS_KEY` / `MIAI_TLS_CERT` | 给了就走 TLS（另一条路径是明文 TCP，同一份代码）。**只给一个会启动即失败** —— 静默降级成明文会让人以为已经加密了 |
| `MIAI_TOKENS` | 指向 `token` 或 `token:deviceId` 一行的文件；配了就要求首帧 `Hello` |
| `QWEN_ASR_TURN_DETECTION` | `manual`（默认）或 `vad`。`vad` 时 `src/voice-config.ts` 把客户端 `commitMs` / `sttCommitMs` 收成 0，并且不传 `openQuietMs`，于是 `VOICE_COMMIT_MS` / `VOICE_STT_COMMIT_MS` / `VOICE_OPEN_QUIET_MS` 不再生效，避免和服务器 VAD 各切一次。服务端静音窗是 `QWEN_ASR_VAD_SILENCE_MS`（默认 `200`，下限 200） |
| `OMNI_API_KEY` | omni 车道的 key。`resolveOmniApiKey`（`src/voice-config.ts`）优先用它，空则落到 `DASHSCOPE_API_KEY`（只含空白当没配）。CLI（`src/main.ts`）、Web 插件、评测沙盒（`bench/eval/server.ts` 经 `assemblePipelinePlan`）同一份 |
| `--host` | 缺省 `127.0.0.1`；上公网由部署方显式给 `0.0.0.0`（**且必须配齐 `MIAI_TLS_*` 与 `MIAI_TOKENS`**） |

自签证书：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 \
  -subj '/CN=miai-local' -addext 'subjectAltName=IP:127.0.0.1'
MIAI_TLS_KEY=key.pem MIAI_TLS_CERT=cert.pem node src/main.ts --listen 8768
node tools/fake-phone.ts --port 8768 --sbc tmp/voice.sbc --tls --ca cert.pem
```

客户端把 CA 打进包再严格校验，等价于证书 pinning —— 不需要自研应用层加密。

### 证书到期与轮换

服务端**不会因为证书过期而停止启动**：它照常监听，只是每一次 TLS 握手都会失败，
客户端只看到「连不上」。所以到期这件事必须在还能用的时候喊出来：

- `loadTls()` 读证书的 `notAfter`（[`src/tls-cert.ts`](../src/tls-cert.ts)），
  **剩 30 天**起在启动日志里提醒，**剩 7 天**升级成紧急，**过期后**明确写出
  「每一次 TLS 握手都会失败」以及换证书的命令。
- 判据是纯数字逻辑，`tests/tls-cert.test.ts` 钉住了阈值（这类提醒平时看不见，
  写反了不会有任何症状，直到过期当天）。

轮换顺序（**先加新的，再撤旧的**，反过来就是换证当天所有客户端同时连不上）：

```bash
# 1. 新证书与旧证书**并存**：服务端可以只配一张，所以这一步改的是客户端
#    （老仓 scripts/gen_server_pin.py --append，把新公钥追加进 server-pin.txt）
# 2. 发布带新旧两个 pin 的客户端，等旧客户端退场
# 3. 服务端换证书文件，重启（同一把私钥的话客户端 pin 不用动）
# 4. 客户端收尾：只留新 pin
```

自签模式下**换证书必须同步换客户端的 `local-ca.pem`** —— pin 只钉公钥，
不提供 CA 锚。仅续期、复用同一把私钥时，pin 不变。

证书文件权限应当是 `600`：`chmod 600 key.pem cert.pem`。

**公网可及就必须要鉴权。** 没有 `MIAI_TOKENS` 等于谁都能往这个端口推音频。配了之后，
`Hello` 里不带 token 会收到 `Control: auth_required` 并被断开。

## 本机控制口

**控制口是服务级的**：进程起来时建一次（`--listen + 2`，`PHOTO_CTL_PORT` 可覆盖，只绑
`127.0.0.1`），到进程退出才 `close()`。设备重连**不重开端口**，靠热切换 handlers：

- 连接上来 → `setHandlers(handlers, token)` 接管路由；
- 连接断开 → `setHandlers(null, 自己)` 摘回「没有设备」，**必须带令牌** —— 旧连接迟到的
  收尾不许把已经接管的新连接清掉（弱网重连时「旧断开晚于新接管」是常态）；
- 早先「每条连接建一个」的写法会在重连时 `EADDRINUSE`，而且还在监听的旧 server 会把
  `/say`、`/take_photo` 路由给**上一条已经关闭的连接** —— 现场表现是「手机重连一次之后，
  MCP 拍照就全都没反应了」（原委见 [`src/tool-control.ts`](../src/tool-control.ts) 顶部）。

`--serve`（或 `MIAI_SERVE=1`）下允许多条连接并存，但**同一时间只有一个活跃连接**：新连接
完成鉴权就 `evict()` 掉旧的（断开旧 TCP，共享槽整体交给新连接；旧连接迟到的收尾只收自己
的 TTS / ASR / 档案，不许再动控制口与播报）。

| 路由 | 作用 |
|---|---|
| `POST /say`（body = 一句话） | 当作"用户说了这句"，走正常轮次 → agent → TTS → 下发 |
| `POST /take_photo` | 让设备拍一张，返回 JPEG |
| `POST /end_session` | 按"说完这句就挂断"处理 |

```bash
curl -X POST --data '你好，介绍一下你自己' http://127.0.0.1:8770/say
```

**安全面**：这条口子没有鉴权，本机任何进程都能往里塞话。只绑 `127.0.0.1`、别转发出去。
插件形态里它应该被删掉 —— 直接给 agent 注册工具（`ctx.tools.register`）比绕 HTTP 更窄。

`mcp/` 里那两个脚本读 `PHOTO_CTL_URL` / `SESSION_CTL_URL`，端口变了要一起改，
否则模型会说"挂断的工具现在不可用了"。

## 事后排障：原始档案

出问题之后不能靠猜。`MIAI_ARCHIVE_DIR` 一开，**每条连接**都留一份完整档案：

```text
<root>/<时间戳>-<对端地址>_<端口>/
  meta.json      当时的增益、门限、采样率、provider、模型（档案必须自解释）
  events.jsonl   时间线，每条都带三条流当时的字节偏移
  uplink.sbc     手机发来的原始 mSBC，未解码（可换增益重新解码）
  uplink.pcm     解码后 PCM16 16 kHz，**放大前**（可任意重算增益/门限）
  downlink.pcm   下行 TTS PCM16 24 kHz
```

```bash
MIAI_ARCHIVE_DIR=/var/lib/miai/archive   # 空 = 关（默认）
MIAI_ARCHIVE_MAX_MB=80                   # 单段上限，到顶另起 `…--2`
MIAI_ARCHIVE_KEEP=20                     # 保留多少个会话目录
```

**为什么必须留"放大前"的 PCM**：像"小声说话识别不出来"这种问题，事后必须能在不同增益 /
门限下重放判断，而不是拿已经放大的波形去猜原始电平。旧的 `DUMP_DIR`（`up/down_<turn>.pcm`）
已被取代 —— 那套只覆盖播放期，恰好漏掉"用户说话但没成句"，而且同名文件会被下一条连接覆盖。

## 延迟报告

```bash
node scripts/observe.ts <会话目录>               # 一把梭：事实源清单 + 分段 + 审计 + dsh 对齐 + 模型行为
node scripts/latency-report.ts <会话目录>        # 逐轮"用户说完 → 听到第一个字"分解
node scripts/latency-report.ts <root> --all     # 每个会话各出一份
node scripts/said-audit.ts <会话目录>            # 逐轮「用户说了什么 → 被问了什么 → 答了什么 → 听到多少」
```

纯读，不改档案。`p50` / `p90` 在本项目**只有一个意思**：闭嘴 → 出声（用户停止说话到第一块
音频下发），别拿它和单段数字并列。分段口径与缺仪表语义见
[`src/latency-report.ts`](../src/latency-report.ts)，字段级说明见
[TOOLS.md](TOOLS.md) §12.1。

## 诊断探针

[`scripts/probe-omni-inject-speak.mjs`](../scripts/probe-omni-inject-speak.mjs)
在一条 DashScope Realtime 连接上检查 Pure Live 的空窗汇报：dangling `tool_call`
（故意不回 `function_call_output`）之后，`conversation.item.create`（`role: user`）
紧接着 `response.create` 还能不能出声，以及下一轮还记不记得注入的事实。
这就是 `OmniShadow.speakFromText` 的在线复现。`session.update` 的 instructions
与工具描述和 `src/persona.ts`、`src/omni-shadow.ts` 逐字一致。口径见
[OMNI-LANE.md](./OMNI-LANE.md) §10.1 与 §12.5。

```bash
DASHSCOPE_API_KEY=<key> node scripts/probe-omni-inject-speak.mjs
```

没有 key 时打印用法并以退出码 2 结束，不发起连接。三轮共用一条连接：

1. 用户让查设备数据。看有没有 `tool_call`，并且不回 `function_call_output`。
2. 回到 ready 后立刻 `conversation.item.create` + `response.create`，量 `audio_ms`、输出字节、转写、协议错误、有没有再次委派。
3. 追问第 2 轮注入的事实，看转写里还在不在。

可选环境变量：`OMNI_MODEL`（默认 `qwen3.8-omni-flash-realtime`）、`OMNI_PROBE_PCM`
（16 kHz / s16le / 单声道裸 PCM，用来代替第 1 轮的文本）。脚本不 import `.ts`，只用已安装的 `ws`。

## 待补播

后台任务完成时如果没有连接，那句话会落到 `~/.voice-agent/announce.jsonl`
（`MIAI_ANNOUNCE_FILE` 可改，条数上限 `MIAI_ANNOUNCE_MAX` 默认 20），下次连上第一条就补播。
语义是**至少一次**：崩溃在播放中途会重复播一句，比丢一句好。

## 播放进度：估算 + 设备回执

设备在 `Hello` 里声明了 `played` 能力时，`turn-runner` 等设备的回执再离开 `speaking`；
**估算是下限，回执只能延后**（真机上见过设备在「最后一批字节收到」就回执，比真实播完早
1–3 s，按它收尾会把尾音那段插话窗口关掉）。没有这个能力的设备仍按时长估算
（`audioSeconds + playbackTailMs`）。

回执（委派轮那句「我看看。」）虽然也占 `speaking`，但**不走这条**：它只要播完就
`receiptEnded()` 回到 `thinking`，不等设备回执（`audioDone` 在 `receiptOnly` 为真时直接
忽略）。这个字段在共享内核 [`src/kernel.ts`](../src/kernel.ts) 的 `dialog` 区域里，
`DialogFsm` 现在只是 `KernelRuntime` 的薄门面，读的是 `runtime.state.dialog.receiptOnly`。

两种情况的上限都是「估算 + 余量」，事件丢了不会把一轮挂死。改这块之前先看
`src/turn-runner.ts` 里等待环的注释。

## 上行增益与能量门（成对调，别单动一个）

`MIAI_MIC_GAIN` 和 `VOICE_PEAK_DBFS` 是**一对**：门限按**放大后**的电平算
（`uplink-pipeline.ts`），所以改增益必须同步改门限，否则「用户开口」的触发点会平移。

标定口径：**放大前**的门限 = `VOICE_PEAK_DBFS − 20·log10(MIAI_MIC_GAIN)`。
这个值才是「多大声算开口」，换增益时保持它不变。

**代码默认值不是现网值**：三端共用 `src/voice-config.ts`，默认上行 `4×`、门限 `−30` dBFS
（放大前 −42.0 dBFS）。`src/main.ts` 与 `bench/eval/server.ts` 不再自写这份默认。
web 插件 `packages/dsh-voice-web/src/driver.ts` 只把增益盖成 `1×`（浏览器已开 AGC），
门限仍是这份 `−30`（放大前 −30.0 dBFS）。现网 `.env` 用的是下面这对
`2 / −46`（放大前仍是 −52.0 dBFS）—— 别把源码默认值当成线上配置。

2026-11-23 从 `4 / −40`（放大前 −52.0 dBFS）改成 `2 / −46`（放大前 −52.0 dBFS）：

| | 改前 | 改后 |
|:---|:---|:---|
| 增益 | 4×（+12 dB） | 2×（+6 dB） |
| 门限（放大后） | −40 dBFS | −46 dBFS |
| 触发点（放大前） | −52.0 dBFS | −52.0 dBFS（不变） |
| 真机峰值落点 | **+5.4 … +0.5 dBFS → 每场都硬削波** | −0.6 … −5.5 dBFS |

起因：7 份真机档案的**放大前**峰值是 −6.6 … −11.5 dBFS，乘 4 之后全部越过 0 dBFS，
日志里 `电平 峰值` 频繁报 `-0.0 dBFS`。削波发生在辅音和重音上，mSBC 窄带下
生僻词/书名识别率会雪崩（`20261123-051448` 第 6 轮把《其主之声》听成《基础之森》）。

`电平 峰值` 报的是**放大后**。再出现 `-0.0` 就说明还有人声比这批更响，
下一档是 `1.5 / −48.5`（放大前同样是 −52.0）。
