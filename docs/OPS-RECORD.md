# 运维记录

**这是一份「已经核对过的事实清单」，不是设计文档。** 每个 agent / 接手的人开工前先读这一节，
别靠上下文记忆——本项目已经出现过多次「把 bench 的临时做法当成历史协议」这类错误。

最后核对：**2026-11-16**（服务器实测，命令见文末「怎么重新核对」）。

> 约定：真实主机地址与密钥**不写进文档**，只写它们在哪里。需要时去读对应文件。

---

## 1. 两个仓，边界不要混

| 仓 | 管什么 | 关键路径 |
|---|---|---|
| `dsh-pet-wearable`（云端） | harness（STT / 判停 / TTS / dsh 驱动）、部署脚本、**bench** | `src/`、`mcp/`、`bench/`、`docs/` |
| `Miaiglassses2grokbot`（客户端） | 眼镜侧 protobuf、App（Kotlin）、配对与部署入口 | `sdk/`、`client/`、`scripts/` |

- **bench 在 `dsh-pet-wearable/bench/`**，不在客户端仓。
- 客户端侧的 Gradle App 在 `sdk/sample`（Kotlin/Compose）。`client/` 下的 Java
  （`Session.java` / `MainStream.java` 等）是**旧 app_process 管线**，已被取代——
  查「现在怎么连云端」不要去那儿找答案。

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

`Hello` 里 `deviceId` 必须与文件里绑定的名字一致，否则 `auth_failed` 且连接直接关闭。

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
# env 键名
grep -oE '^[A-Z_]+' ~/miai-cloud/.env | tr '\n' ' '
# 档案与向量
ls -d ~/miai-archive/*/ | wc -l; ls ~/miai-vectors
# 设备 token 名
awk -F: '{print $2}' ~/miai-cloud/tokens.txt
# 证书有效期与 SAN（到期了要续）
set -a; . ~/miai-cloud/.env; set +a
openssl x509 -in "$MIAI_TLS_CERT" -noout -dates -ext subjectAltName
```

核对完把上面的日期改掉。
