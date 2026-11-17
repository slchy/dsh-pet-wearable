# 运维记录

**这是一份「已经核对过的事实清单」，不是设计文档。** 每个 agent / 接手的人开工前先读这一节，
别靠上下文记忆——本项目已经出现过多次「把 bench 的临时做法当成历史协议」这类错误。

最后核对：**2026-11-17**（服务器实测，命令见文末「怎么重新核对」）。

2026-11-17 这次核对的具体结果（免得下次又从零猜）：
服务 `active`，启动于 2026-11-18 00:19:02 CST，`NRestarts=0`；生产代码 = `dda6418`（§2.2）；
7 天内 **0 轮**真实对话；7 天内 2 次 `流式 ✗ 合成失败: Please ensure input text is valid.`
（有兜底，回退整段合成，但那一轮首块会变慢）；`~/miai-archive` 21 份 / 256 K；
`~/miai-vectors` **空**、`~/miai-vectors-synth` 3 份；另有 1 次
`✗ 帧长异常 1330205776（上限 65536）` —— 有非协议数据打到 63993，服务拒了，但暴露面值得留意。

> 约定：真实主机地址与密钥**不写进文档**，只写它们在哪里。需要时去读对应文件。

---

## 1. 两个仓、两个包 —— 是**两张表**，别当成一张

### 1.1 两个 **git 仓**

| 仓 | 管什么 | 关键路径 |
|---|---|---|
| `dsh-pet-wearable`（云端） | harness（STT / 判停 / TTS / dsh 驱动）、**bench** | `src/`、`mcp/`、`bench/`、`docs/` |
| `Miaiglassses2grokbot`（客户端） | 眼镜侧 protobuf、App（Kotlin）、配对、**部署入口** | `sdk/`、`client/`、`scripts/` |

- **bench 在 `dsh-pet-wearable/bench/`**，不在客户端仓。
- **部署脚本一个都不在云端仓**：`deploy_cloud.py` 在
  `Miaiglassses2grokbot/scripts/`（`HOST` / `KEY` / `REMOTE` 都在里面）。
  在云端仓里找它是找不到的 —— 已经因为这个误判过「不知道生产在哪台机器」。
- 客户端侧的 Gradle App 在 `sdk/sample`（Kotlin/Compose）。`client/` 下的 Java
  （`Session.java` / `MainStream.java` 等）是**旧 app_process 管线**，已被取代 ——
  查「现在怎么连云端」不要去那儿找答案。

### 1.2 两个 **npm 包**（都是 dsh 插件，平级，互不依赖）

| 包 | 位置 | 插件名 | 内容 | 依赖对方 |
|---|---|---|---|---|
| `dsh-pet-wearable` | **仓根**（仓名同时是包名） | `pet-wearable` | 协议层 + 语音栈 | 无 |
| `dsh-voice-web` | `packages/dsh-voice-web/` | `voice-web` | **语音栈副本** + web 兼容（WS 桥 + 浏览器端） | 无 |

- **包② 不是包① 的子组件**，它是另一个独立插件；能自包含是因为
  `packages/dsh-voice-web/src/voice/` 里有一份**同步副本**（`scripts/sync-voice.mjs`
  从仓根 `src/` 复制，**不进 git**，`prepack` / `typecheck` 自动刷新）。
  这是当初刻意选的「不依赖、复制一份」，代价是两边依赖清单要手动对齐。
- 混这两张表最常见的后果：以为 `dsh-voice-web` 是 `dsh-pet-wearable` 的一部分，
  于是找不到它的部署路径 / 以为改仓根 `src/` 等于改了包②（**不会**，要重跑 sync）。

## 2. 服务器

| 项 | 事实 |
|---|---|
| 主机与私钥 | `Miaiglassses2grokbot/scripts/deploy_cloud.py` 里的 `HOST` / `KEY` |
| 部署目录 | `~/miai-cloud`（`src/`、`mcp/`、`.env`、`tokens.txt`、`smart_turn/`、`models/`） |
| 常驻 | systemd `miai-harness`，`Restart=always`，监听 **63993**（TLS + token） |
| 前端 | **无**（不跑 `node src/main.ts` 手工进程，除非排查） |
| 重启影响 | `systemctl restart miai-harness` 会加载 `~/miai-cloud/src` 的**当前代码** |

**关键行为**：改完 `src/` 只是把文件传上去，跑的还是内存里的旧代码；要生效必须重启。
排查「我的改动没生效」先看 `systemctl show miai-harness -p ActiveEnterTimestamp`。

### 2.1 `deploy_cloud.py` 到底同步什么

```python
ITEMS = ["src", "mcp", "tools", "tests", "smart_turn", "scripts",
         "package.json", "tsconfig.json", "README.md"]
```

- **`packages/` 不在清单里** → `dsh-voice-web`（以及将来任何 `packages/*`）**走正常部署永远到不了生产**。
  要上生产必须先改这个 `ITEMS`，并想清楚端口 / TLS / 来源白名单。
- `.env`、`docs`、`models`、`node_modules`、`tmp` **一律不同步**。
  `.env` 不同步是故意的：本地那份是调试用的，推上去会盖掉服务器上的真实凭据。
- 目录按**整棵替换**（删了再拷），文件直接覆盖。只用 `scp -r` 是覆盖、不删除，
  本地已删的测试文件会留在服务器上，于是服务器在跑**已经不存在的功能**的断言。
- 重启前有前置检查（`0.0.0.0` 要求 `MIAI_TOKENS` + `MIAI_TLS_KEY` + `MIAI_TLS_CERT` 齐备、
  `tokens.txt` 不许有弱 token 或 32 位 hex），不满足就**拦住不部署** ——
  否则一次部署等于把现网停掉。

### 2.2 生产跑的是哪个版本：只能按内容比对

`~/miai-cloud` **不是 git 仓**（是拷过去的），所以没有 `git log` 可看。

```bash
# 文件清单（2026-11-17 实测 78 个，与 dda6418 逐一对应）
cd ~/miai-cloud/src && find . -name '*.ts' -printf '%P\n' | sort | wc -l
# 特征判定：某次重构有没有上生产
grep -c "from './assembly.ts'" main.ts      # 0 = 抽装配层之前
grep -c onListening voice-session.ts        # 0 = 同上
grep -c VOICE_SPECULATE_MS main.ts          # 1 = dda6418 及之后
```

2026-11-17 核对结果：生产 = **精确等于 `dda6418`**（78 个 `.ts` 与本地该提交逐一对应，`Compare-Object` 零差异）。
也就是说本地之后的所有改动（抽 `assembly.ts`、`onListening`、整个 `packages/dsh-voice-web`）
**都还没上生产**。将来从新 HEAD 部署会把这批核心文件改动带上真机链路，必须重启后实测。

### 2.3 文档漂移：`--tts` 到底是什么

`deploy_cloud.py` 头部注释写的是 `--tts mimo`，而**实际 unit 是 `--tts cosyvoice`**：

```
ExecStart=/usr/local/bin/node /home/slchy/miai-cloud/src/main.ts --listen 63993 --host 0.0.0.0 \
  --stt aliyun --tts cosyvoice --agent dsh --dsh-sdk --work-dir /home/slchy/voice-workspace
```

以 `systemctl cat miai-harness` 为准。**所有延迟数字（TTS 首块 330 ms 等）都是 cosyvoice 测的**，
配成 mimo 测出来的不是同一个东西。

## 3. 密钥与环境变量

**全部在服务器 `~/miai-cloud/.env`，本机没有。** 需要跑任何东西：

```bash
cd ~/miai-cloud && set -a && . ./.env && set +a
```

已确认存在的键（只列名，值不写）：

```
DEEPSEEK_API_KEY  DASHSCOPE_API_KEY  MIMO_API_KEY
ALIYUN_AK_ID  ALIYUN_AK_SECRET  ALIYUN_APPKEY  ALIYUN_NLS_REGION
DSH_BIN  DSH_PATCH  SMART_TURN_PYTHON  SMART_TURN_SCRIPT
MIAI_ARCHIVE_DIR  MIAI_ARCHIVE_KEEP  MIAI_ARCHIVE_MAX_MB
MIAI_TLS_KEY  MIAI_TLS_CERT  MIAI_TOKENS  MIAI_SERVE
MIAI_STT  MIAI_TTS  MIAI_MIC_GAIN  MIAI_TTS_GAIN  MIAI_LEVEL_LOG
PHOTO_DIR  PHOTO_CTL_URL  PHOTO_CTL_HQ_URL  MIAI_PHOTO_TIMEOUT_MS  SESSION_CTL_URL
PET_PROACTIVE  PET_TICK_MS  PET_GREET_AWAY_MS  PET_CHATTER_IDLE_MS  PET_LISTEN_MS  PET_MIC_OPEN_TIMEOUT_MS
```

`.env` 里**不能**放的东西：`dsh` 会拒绝以 `DSH_BIN` 这类「只有启动环境才能设」的键
出现在 `.env` 里（报 `only the launching environment may set`）。要么 `export`，要么交给
systemd unit。

## 4. 设备 token：两套，别混

| 用途 | 来源 | 形态 |
|---|---|---|
| **云端通道**（App → harness） | 服务器 `~/miai-cloud/tokens.txt`，`npm run pair -- new --device <名字>` | 生成长 token，格式 `token:deviceId` |
| **眼镜 SPP** | 眼镜自身配对 | 32 位 hex，**不是**云端 token |

`tokens.txt` 现有设备：`M2004J7AC`（测试手机）、`pet-test`、`tau2-bench`（bench 专用）。
文件改动**自动重读**，吊销不必重启。

`Hello` 里 `deviceId` 必须与文件里绑定的名字一致，否则报
`token 正确但 deviceId 不匹配（期望 X，收到 Y）` 并拒绝。

**⚠️ App 发的 `deviceId` 是眼镜的蓝牙 MAC**（如 `04:34:C3:4C:D5:E5`），**不是**手机型号。
所以 `tokens.txt` 里必须有一条绑到那个 MAC 的 token；绑到手机名（如 `M2004J7AC`）会一直被拒，
而且报错里 token 是"正确的" —— 很容易误判成别的问题。实测踩过。

同时 App 还会自报 v2 能力：`上行 msbc；拍照 glance/detail(等用户)；上报 presence power summon listenStart played`。

## 5.0 时间基准（三种，别混）

| 来源 | 时区 | 例子 |
|---|---|---|
| 服务器 `journalctl` / `date` | **CST = UTC+8** | `Nov 16 20:14` |
| **档案目录名** | **UTC** | `20261116-121442` = 12:14 UTC = **20:14 CST** |
| 手机 App / 眼镜日志 | CST | `晚上8:14` |
| 开发机（本地终端） | **UTC−8** | `04:42` = 同样是 20:42 CST |

**档案目录名是 UTC**，和 journalctl 差 8 小时。把 `115523` 当成 11:55 CST 读，就会把
19:55 的真机会话错认成中午 —— 我踩过，结论跟着歪。

对齐办法：`date -u -d @$(stat -c %Y <档案>)` 或直接用 `meta.json` 的 `startedAt`（带 `Z`）。
## 5. 档案（archive）

```
MIAI_ARCHIVE_DIR = ~/miai-archive        # 默认；一个会话一个目录
  <时间戳>-<对端>_<端口>/
    meta.json  events.jsonl  uplink.pcm  downlink.pcm  uplink.sbc
```

- `uplink.pcm` 是**放大前**的连续 PCM16 16k，`t` 毫秒 ↔ 字节 = `t*32`（可重算任意增益）
- `downlink.pcm` 是下行 24k
- `MIAI_ARCHIVE_KEEP = 20`，**按数量环形清理，不区分来源**
- 真机向量另存 `~/miai-vectors/`（`--pin` 钉住的，不会被 KEEP 冲掉）

**踩过**：bench 与生产共用 `MIAI_ARCHIVE_DIR`，跑一晚 bench 会把真机档案全部挤掉
（真机档案不可再生）。要隔离就在 bench 那侧把 `MIAI_ARCHIVE_DIR` 指到别的目录，
`bench/tau2/` 下读档案的脚本都按这个变量取路径。

## 6. 设备与 App

| 项 | 事实 |
|---|---|
| 测试手机 | `<设备地址>:33685`（M2004J7AC，Android 12，Magisk root 可用） |
| App 位置 | **`sdk/sample`**（Gradle 项目），包名 `st.moe.mimoe` |
| 构建 | `cd sdk && .\gradlew.bat :sample:assembleDebug` |
| 安装 | `adb -s <serial> install -r sample\build\outputs\apk\debug\miMoe-debug.apk` |
| ~~旧管线~~ | `scripts/ci/build_android.py --push` 只编 `client/` 的 Java，**不用于新 App** |

**云端通道现在要在 App 里手填**（设置 → 云端语音通道：主机 / 端口 / TLS / 云端 token / CA PEM）。
**留空 = 不建云端通道**，日志会打「云端通道未配置……本次只做本地设备控制」——这是有意的，
不是 bug（避免 harness 没起时每 1→15 s 退避重连刷屏）。

MIUI 会拦 `adb install`（`INSTALL_FAILED_USER_RESTRICTED`），用 `su -c 'pm install -r -g'`。

## 7. 协议三层（不要混）

| 层 | 内容 | 变了吗 |
|---|---|---|
| 眼镜 ↔ 手机 | protobuf（`Wear` / `Mass` / `Sar` / `Aivs` / `L1`） | 实现换过，**字节一样**（有真机回放夹具对账） |
| 手机 ↔ harness | `[type:u8][len:u32 LE][payload]`，**5 字节头** | 帧头**从没变过**；v2 只**新增**帧类型 |
| harness ↔ 模型 | — | 与客户端无关 |

v2 新增：`Hello` / `Welcome` / `Call` / `Event` / `CaptureImage`。
`Hello` 字段：真机发 `{proto:2, deviceId, token, capabilities, resumed?}`；`resumed:true`
是自动重连时带的，云端据此跳过主动开麦。

## 8. bench 与生产同机共存

| 项 | 做法 |
|---|---|
| 端口 | bench 用 **8766**，生产用 63993，互不影响 |
| dsh 工作目录 | bench 用 `/tmp/tau2-bench-work`（生产是 `~/voice-workspace`） |
| 会话指针 | bench 用 `VOICE_AGENT_SESSION=/tmp/tau2-bench-work.session.json`，每场清空 |
| 档案 | **还没隔离**（见 §5），是已知隐患 |
| 播报队列 | bench 侧关掉离线播报，避免同样落进 `~/.voice-agent/` |

**会话文件必须放在 workDir 之外**（沙箱允许 agent 写 workDir 内的一切）。
默认路径不能改，只加 `VOICE_AGENT_SESSION` 覆盖 —— 改默认值会让生产换文件。

## 9. 编排与观测

| 想知道 | 去看 |
|---|---|
| 真机上行电平 / 增益够不够 | 档案的 `uplink.pcm`（放大前，可重算） |
| 一轮多长、卡在哪 | `bench/tau2/segment_split.py`（①说完→ASR ②ASR→开跑 ③开跑→模型开口 ④模型开口→TTS首块 ⑤TTS首块→客户端） |
| 线上服务 | `journalctl -u miai-harness` |
| TTS 握手明细 | `COSYVOICE_TRACE=1`（打「建立 / 首包」两段） |

**跨路径不可比**：真机上行是 mSBC（570 B / 75 ms），bench adapter 是 PCM16（640 B / 20 ms）。
**同一条路径改前 vs 改后**才可比。

### 9.1 上下文膨胀：dsh 已经自带四层，别再写一套

`~/.dsh/profiles/sdk/cordis.patch.yml` + base 里已经挂好，核对命令见文末：

| 层 | 插件 | 配置 |
|---|---|---|
| 摘要压缩 | `dsh-compaction-basic` | `thresholdRatio: 0.125`（≈12.5 万 token）、`retainTokens: 30000` |
| 手动 | `dsh-command-compact` | `/compact` |
| 工具结果剪裁 | `dsh-compaction-tool-result-pruner` | `thresholdChars: 8192`，头 4096 / 尾 1024 |
| 图片卸载 | `dsh-compaction-image-offload` | — |
| 大结果外溢 | `dsh-spill-local` + `spill-policy` | `maxInlineTokens: 12500` |

默认 `thresholdRatio` 是 0.8（80 万 token 才动手），真机 212 轮的会话会直接抛
`retainTokens >= thresholdTokens` —— 所以这里改成 0.125。

**压缩是看不见的代价**：撞上它的那一轮会突然慢几秒（压缩本身一次模型调用，溢出还要
「先压缩再重试」）。所以 `agent.ts` 在 `dsh` 那行日志后面加了两个提示：`← 接近压缩阈值`
和 `← 刚压缩过（上一轮 N）`。看到后者就别去查网络了。

### 9.2 宿主层取消：`session/cancel` 是**补丁**给的，升级 dsh 会丢
底座一直有取消能力 —— `agent.cancel({kind:'user'},{keepInbox:true})`，
`dsh-api-session-controller` 里就这一句。问题是 SDK 运行时的 `handleRequest` 是硬编码
switch，没把它放进来；最新的 `@deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5` 里
`cancel` 出现 **0 次**，所以升级解决不了，只能补 6 行。

| 项 | 事实 |
|---|---|
| 补丁位置 | `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js` |
| 怎么打 | `node scripts/patch-sdk-cancel.mjs`（幂等，锚点 `case "shutdown"`） |
| 在不在 | `node scripts/patch-sdk-cancel.mjs --check`（0=在，3=不在） |
| 生效条件 | **重启 miai-harness**：补丁在磁盘上，常驻子进程是旧的 |
| 打丢了会怎样 | 退化成取消不了。客户端收 `-32603` 记一行日志，2000 ms 兜底唤醒在途轮次 |

实测（`deepseek-flash`，`turn/end` 走 `{kind:'aborted',reason:{kind:'user'}}`）：

| 项 | 值 |
|---|---|
| cancel → `status:idle` | **5–7 ms** |
| 已生成的部分 | 落成 `assistant/message` 且带 `"interrupted": true` |
| 取消后下一轮 | 670–901 ms，进程不死、不 resume、会话不丢 |

**和 SIGINT 的区别**：SIGINT 是杀进程（exit 130），下一轮要重启 + resume，多花 ~2 s。
只在「这轮肯定不要了、且一时不会再问」时才划算，默认不用。

## 10. TLS 证书

| 项 | 事实 |
|---|---|
| 位置 | `~/miai-cloud/tls/key.pem` + `cert.pem`（0600），配 `MIAI_TLS_KEY` / `MIAI_TLS_CERT` |
| 类型 | **自签**，`CN=miai-local`，SAN 含 `127.0.0.1` / `localhost` / 公网 IP |
| 有效期 | 2026-11-13 → **2027-02-11**（发证时给的是 90 天；**到期前必须续**） |
| 信任锚 | 客户端 `sdk/sample/src/main/assets/local-ca.pem`（gitignore），**缺失即拒绝连接** |
| 第二张网（可选） | `assets/server-pin.txt` = SPKI SHA-256（base64 无填充），`scripts/gen_server_pin.py` 生成 |

自签证书**本身就是自己的 CA**，所以 App 里的「CA PEM」填的就是 `cert.pem` 全文。

**两个坑**：

1. `scripts/gen_local_ca.py` **默认只发 3 天**（调试用）。随手重跑会让真机 3 天后集体连不上，
   而现象是“突然连不上”，不会想到证书。换证必须显式给长期限。
2. 轮换要**新旧重叠**：`gen_server_pin.py --cert new.pem --append`（新旧都认）→ 发布客户端 →
   收尾只留新的。反过来做 = 换证当天所有客户端同时连不上。
## 11. 远程执行

**一律 Base64 传脚本**，禁止在 ssh 内联命令里写 `|` `>` `"` `$`（本地 shell 先解析，
远端会收到半截命令或 ssh 挂死）。详见 [AGENTS.md](../AGENTS.md)。

---

## 怎么重新核对

```bash
# 服务与启动时间
systemctl is-active miai-harness; systemctl show miai-harness -p ActiveEnterTimestamp --value
# 生产跑的是哪个版本（~/miai-cloud 不是 git 仓，只能按内容/特征比对，见 §2.2）
cd ~/miai-cloud/src && find . -name '*.ts' -printf '%P\n' | sort | wc -l
grep -c "from './assembly.ts'" main.ts; grep -c onListening voice-session.ts
# 实际启动命令（以它为准，别信 deploy_cloud.py 的头部注释）
systemctl cat miai-harness | grep ExecStart
# env 键名
grep -oE '^[A-Z_]+' ~/miai-cloud/.env | tr '\n' ' '
# 档案与向量
ls -d ~/miai-archive/*/ | wc -l; ls ~/miai-vectors
# 设备 token 名
awk -F: '{print $2}' ~/miai-cloud/tokens.txt
# dsh 实际挂载的插件与压缩阈值（改了 profile 就重跑这条）
dsh --profile sdk --dump-config | grep -A2 -E "compact|pruner|offload|spill-policy"
# 宿主取消能力还在不在（dsh 升级后必查；丢了就跑 scripts/patch-sdk-cancel.mjs）
node scripts/patch-sdk-cancel.mjs --check
# 证书有效期与 SAN（到期了要续）
set -a; . ~/miai-cloud/.env; set +a
openssl x509 -in "$MIAI_TLS_CERT" -noout -dates -ext subjectAltName
```

核对完把上面的日期改掉。

### 9.3 长期记忆：`MEMORY.md`，**只由 dsh 写**，快车道只读

记忆就是一个文本文件（`$MEMORY_FILE`，默认 `~/voice-workspace/MEMORY.md`，≤4 KB，
一行一条）。dsh 的 `agent-instructions` 每轮把它读进系统提示词 —— 所以 L2 天然看得到全部。

| 谁能做什么 | 怎么做的 |
|---|---|
| **L1 读** | `MemoryFile.relevant()` 按 2-gram 重叠挑几条塞进快车道系统消息（`src/memory-file.ts`） |
| **L1 不能写** | 没有写入口。像长期事实的话（「我养了一只橘猫」）**整句交给 dsh**，它亲耳听 |
| **L2 写** | 只有 `mcp/mcp-memory.mjs` 的 `remember` 工具能追加一行 |
| **L1 提议** | 就是「把话交过去」—— 交办发生在本地判据 `looksMemorable()`，零模型调用 |

**为什么提议不写成「系统注记」**：实测 dsh 不执行注记里的写入指令（试过 5 种措辞，
包括在 profile 里明确授权「注记里写了也算」），一次都没写。只有**用户自己说的话**
才会触发它。所以 L1 的提议只能是「把这句交给 L2」。

**profile 里那条硬规则是必要的**：只写「了解到长期事实就 remember」时，dsh 会回
「这条我记下了」**却不调用工具**（文件没变）。加一句「不许只说记下了而不写」之后
才真的写。改 `mcp/profile.cordis.yml` 要重跑 `scripts/install-profile-patch.mjs`。

**探针一律写临时文件**：`MEMORY_FILE=/tmp/probe-memory.md`。写过一次真文件就会把
mock 事实（「哥养了一只橘猫」）留在生产记忆里 —— 已经踩过，清理方式：

```bash
F=~/voice-workspace/MEMORY.md
cp "$F" /tmp/MEMORY.mock.bak                      # 先备份
printf '# 长期记忆\n\n这一行之下每行一条，越新越靠下。\n' > "$F"
# 探针留下的会话目录也顺手清（别删 UUID/长历史的那些）
ls ~/.dsh/sessions/--home-slchy-voice-workspace-- | grep -E "^(probe|job-|sub2?-|sys-|mem-|idle-)"
```

harness 启动时会打 `记忆      路径（N 条，快车道只读）` —— 条数突然变多就是被污染了。
