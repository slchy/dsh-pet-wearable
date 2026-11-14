# dsh-pet-wearable

**住在智能眼镜里的宠物插件** —— 它会自己开口，不是等你叫。

生态里已经有成熟的双工语音插件（`dsh-voice` / `dsh-voice-mode` / `dsh-voice-ai-girlfriend`，都能流式朗读、都能打断）。这个项目和它们的差别只有一条：

| | 那些插件 | 这个 |
|---|---|---|
| 形态 | 浏览器 / 桌面 | **戴在脸上** |
| 谁开口 | 你（点麦 / 唤醒词） | **它**（时机状态机决定） |
| 允许无用 | 不必 | **必须**（"哥，那辆车好吵"这种） |

技术上不新鲜，需求也未验证。它存在的意义是回答一个问题：**主动开口是价值还是噪音。**
若实测是噪音，这个项目就该死，而且死得对。真正的验收标准只有一条：**你愿意第二天再戴上它** ——
不是 p90 延迟，也不是 ASR 准确率。

## 当前状态

| 能力 | 状态 |
|---|---|
| 手机主动拉起眼镜语音会话 | ✅ 真机：0.62 s 起推实时 mSBC，连续 ≥29.5 s |
| 手机开 / 停录音 | ✅ 回执同 `Media` id=20，音频落眼镜本地 |
| 佩戴检测 / 电量 | ✅ 查询与上报双通路 |
| 拍照（无需唤醒） | ✅ 真机 3/3 出图 |
| 结束语音会话 | ✅ 六字段全零（只写 f1 无效） |
| 语音栈：mSBC → STT → 判停 → agent → TTS | ✅ 真机闭环 |
| 宠物时机状态机 | 🔍 已写（`src/pet/pet-timing.ts`），未接进对话循环 |
| dsh 插件形态 | 🔍 骨架（`src/driver.ts`）：`name` / `inject` / `Config` / `apply` 就位，TCP 监听与 agent 桥待接 |

只看代码、没跑过真机的能力一律标 🔍，不标 ✅。

## 安装

```bash
npm install dsh-pet-wearable
```

`0.0.x` 期间没有稳定 API：装上是能加载的空壳，等 driver 接线完成才真正可用。

## 本地运行

```bash
npm install

# 什么都不接，纯离线自测（不需要任何密钥，不落盘）
node src/main.ts --listen 8766 --stt canned --tts silent --agent echo

# 另一个终端：最小客户端，发一段 mSBC
node tools/fake-phone.ts --port 8766 --sbc tmp/voice.sbc
#    ← Audio ×1  Control=[]  Pong=true

# 生产
export ALIYUN_APPKEY=...            # 阿里云 NLS 实时识别（另有 ALIYUN_AK_ID / ALIYUN_AK_SECRET）
export MIMO_API_KEY=...             # MiMo TTS
node src/main.ts --listen 8766      # 默认 --stt aliyun --tts mimo --agent dsh

npm test                            # node --test tests/*.test.ts
```

手机侧先 `adb reverse tcp:8766 tcp:8766`（只监听 `127.0.0.1` 时日志会提示这一行）。

### 三个可替换件

| 开关 | 取值 | 说明 |
|---|---|---|
| `--stt` | `aliyun` `noop` `canned` `<模块路径>` | 上行识别，每次连接开一个会话 |
| `--tts` | `mimo` `silent` `<模块路径>` | 下行合成，采样率由实现自己声明（MiMo 是 24 kHz） |
| `--agent` | `dsh` `echo` `none` `<模块路径>` | 裸 `--agent` 等价 `dsh` |

`<模块路径>` 指向一个导出工厂的文件：

```ts
// my-stt.ts
import type { SttProvider } from '../src/providers.ts';
export function stt(): SttProvider {
  return { name: 'my-stt', open: (h) => ({ feed: h.onSentence, hangup() {}, close() {} }) };
}
```

```bash
node src/main.ts --stt ./my-stt.ts --agent ./my-agent.ts
```

契约在 `src/providers.ts`（三个接口 + 四个调试实现，是抄写范例）。

### MiMo 的音色与风格提示词

MiMo 的 TTS 是聊天式的：**风格提示词进 `user` 消息，要念的文本进 `assistant`**，
模型按"这个助手该用什么语气说这句话"合成 —— 所以语调一半由提示词决定。

```bash
MIMO_TTS_VOICE=Chloe                    # 音色
MIMO_TTS_STYLE='用自然的中文口语说话，像朋友聊天：语气温暖、有起伏，句末自然落下。'
```

同一句话、两种风格的实测（24 kHz PCM）：

| 风格 | 时长 | 峰值 | 基频 σ |
|---|---|---|---|
| `Calm, natural, conversational.`（旧默认） | 3.20 s | −0.6 dBFS | 52.6 Hz |
| 中文口语（新默认） | 3.84 s | −2.3 dBFS | 60.9 Hz |

提示词确实在改变输出：语速慢 20%、基频起伏大 16%、峰值更低（给后续增益留了余量）。
"听起来好不好"只能靠耳朵，但**它有可调项**这件事本身是确定的。

## 数据流

```
TCP ──transport──┬─ Audio ──▶ UplinkPipeline（ffmpeg→PCM→能量门）──▶ SttSession
                 ├─ Image ──▶ PhotoInbox ──┬─ 有人在等：交图
                 │                         └─ 没人等：当成一轮识图
                 └─ Wake  ──▶ 诊断日志

 SttSession.onSentence ──▶ SessionCore ──effects──▶ UtteranceAssembler（判停成句）
                              ▲                          │
                              │                    定稿一句话
                    工具控制口 / 拍照                    ▼
                                         SessionCore ──▶ TurnRunner ──▶ TtsProvider
                                                              │
                                                              └─▶ connection.sendAudio
```

`SessionCore` 是纯函数式的决策核：16 种事件进，9 种效果出，不碰网络、不碰时钟。
判停、打断、识图轮、旁听反馈这些判定都能在 `tests/session-core.test.ts` 里一条条断言。

## 模块职责

| 文件 | 只做一件事 |
|---|---|
| `src/transport.ts` | accept、帧编解码、Hello 鉴权、Ping/Pong、空闲看门狗、TLS |
| `src/frame.ts` | 5 字节帧头的编解码 |
| `src/providers.ts` | STT / TTS / Agent 的接口与内置实现 |
| `src/uplink-pipeline.ts` | mSBC → PCM（ffmpeg）→ 能量门 → 有声段 |
| `src/energy-gate.ts` | 没声音就不建 STT 连接（带预卷缓冲） |
| `src/utterance-assembler.ts` / `src/smart-turn.ts` | 判停；后者的模型在 `smart_turn/` 那个 Python 侧车里 |
| `src/aliyun-asr.ts` / `src/mimo.ts` | 阿里云实时识别 / MiMo ASR + TTS（SSE 流式） |
| `src/session-core.ts` | 对话决策：唤醒词 / 旁听反馈 / 插话 / 识图轮 → 产出动作（纯，可单测） |
| `src/dialog-fsm.ts` | 对话相位机（listening/thinking/speaking/ending）+ 票据，打断靠它作废 |
| `src/turn-runner.ts` | 一轮对话：agent 流式出字 → TTS 流式出音 → 下发 → 等播放结束 |
| `src/session.ts` | 与 dsh 的对接：现在走 `dsh headless` 子进程 + NDJSON，将换成 `ctx.agents` |
| `src/agent.ts` | 人设提示词 + 情绪标签 + `cleanForSpeech` |
| `src/photo-inbox.ts` | 拍照请求的等待、超时、取消与落盘 |
| `src/hq-intent.ts` | "用户要看细节"的措辞判定（不交给模型选工具） |
| `src/backchannel.ts` | 识别"嗯 / 知道了"这类应答噪声，不为它单开一轮 |
| `src/wake-word.ts` | 唤醒词事件的领域规则（ASR 会把"小爱同学"识别成完整句子） |
| `src/spontaneous.ts` / `src/announce-store.ts` | 识别没人催的轮次 / 离线待补播队列（至少一次语义） |
| `src/archive.ts` / `src/latency-report.ts` | 一条连接一份原始档案 / 档案 → 逐轮延迟分解（纯函数） |
| `src/tool-control.ts` | 本机控制口的 HTTP 层：路由、并发保护、超时 |
| `src/pet/` | 宠物核心：时机状态机（`pet-timing.ts`）与宿主端口（`ports.ts`） |
| `src/driver.ts` | dsh 插件入口（骨架） |
| `src/main.ts` | 只做装配与 CLI |

改判定不用碰网络：`npm test` 跑的全是纯事件 → 断言动作。

## 调试口（没有麦克风也能联调）

连接建立后，进程在 `--listen + 2` 端口开一个本机控制口（`PHOTO_CTL_PORT` 可覆盖）：

| 路由 | 作用 |
|---|---|
| `POST /say`（body = 一句话） | 当作"用户说了这句"，走正常轮次 → agent → TTS → 下发 |
| `POST /take_photo` | 让设备拍一张，返回 JPEG |
| `POST /end_session` | 按"说完这句就挂断"处理 |

```bash
curl -X POST --data '你好，介绍一下你自己' http://127.0.0.1:8770/say
```

这条口子只绑本机，是给联调和客户端作者用的；部署到公网时别把它暴露出去。

## 线协议

```
[type:u8][len:u32 LE][payload]

上行  Audio=1 Image=2 Wake=3 Ping=4 Hello=6
下行  Audio=1 Control=2 Pong=5
```

`Hello` 是 JSON（`{proto, deviceId, token}`）；没配鉴权时客户端可以不发。
最小实现见 `tools/fake-phone.ts`。

### 下行控制串（`Control=2` 的 payload）

| 串 | 什么时候发 | 客户端该做什么 |
|---|---|---|
| `stop` | 用户插话，云端判定这一轮作废 | 立刻停止播放并清空播放队列 |
| `stop_capture` | 模型调了"退出"工具 | **立刻停止麦克风采集**（SDK：`endVoiceSession()`），但别断开蓝牙会话 —— 告别语还要靠它播完 |
| `take_photo` | 模型调了拍照工具 | 让眼镜拍一张并回 `Image` 帧（SPP，1 s，576×432） |
| `take_photo_hq` | 会话里有人要看细节 | 走协作式高清：建 P2P → 回 `hq_armed` → **等用户按快门** → 回 `hq_image` + `Image` |
| `hq_cancel` | 云端不再需要那张高清图 | 立刻解散 P2P（别占着），回 `hq_failed`（`reason=cancelled`） |
| `end_session` | 云端认为会话该结束了 | 收尾并断开 |
| `auth_required` / `auth_failed` | 鉴权失败 | 检查 token，别重试同一份凭据 |

`stop_capture` 补得比较晚：在那之前模型一调退出工具，眼镜会继续采集到整段告别语播完
（实测多采 2–5 秒），既费电又容易把周围对话喂进 ASR。

### 上行状态帧（`Status=5` 的 payload，UTF-8 JSON）

高清照必须由**人按下快门**才落盘（程序化快门不写相册），所以这条链路上有几十秒是"等用户"。
没有状态帧时，手机早就放弃了，云端还在干等总超时。三个事件：

| 事件 | 字段 | 云端动作 |
|---|---|---|
| `hq_armed` | `fresh`（`"true"` 表示相机里已有新图） | 结束"等就绪"，开始"等快门"；`fresh=false` 时播一句"请按一下眼镜上的快门" |
| `hq_image` | — | 紧接着的 `Image` 帧算**高清原图**（不是 SPP 低清回图） |
| `hq_failed` | `reason`：`no_shutter` / `p2p` / `join` / `connect` / `arm` / `download` / `decode` / `send` / `cancelled` | 立刻结束等待，把原因翻成一句可执行的话给模型 |

`hq_image` 这条公告不能省：等高清图时用户按快门会让相机同时回一张 SPP 低清图，
没有公告就只能按到达顺序猜 —— 实测把 17 KB 的糊图当成原图交付过。

### 高清照的时间预算

| 段 | 典型 | 兜底（手机侧 / 云端侧） |
|---|---|---|
| 建组 + 入组 + 连相册 | 5.4 s | 15 s / — |
| 提示语 | 1.5 s | — |
| 等用户按快门 + LLHDR + 落盘 | 5–9 s | 20 s / 25 s |
| 下载 8 MB + 缩图 + 上行 1.1 MB | 2 s | 20 + 10 + 5 s / — |

可调：`MIAI_HQ_ARM_TIMEOUT_MS`（默认 15000）、`MIAI_HQ_SHUTTER_TIMEOUT_MS`（默认 25000）。
手机侧放弃得更早（20 s）并主动上报，所以正常情况下永远是**手机的原因先到**，
云端那 25 s 只是"手机也没消息"的兜底。

## 接公网

| 环境变量 | 作用 |
|---|---|
| `MIAI_TLS_KEY` / `MIAI_TLS_CERT` | 给了就走 TLS（另一条路径是明文 TCP，同一份代码） |
| `MIAI_TOKENS` | 指向 `token` 或 `token:deviceId` 一行的文件；配了就要求首帧 `Hello` |
| `--host` | 缺省 `127.0.0.1`，上公网由部署方显式给 `0.0.0.0` |
| `DSH_BIN` | agent 可执行文件；Windows 上指向 npm 的 `dsh.cmd` 即可（内部用 `cmd /c` 启动 shim） |

自签证书实测：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 \
  -subj '/CN=miai-local' -addext 'subjectAltName=IP:127.0.0.1'
MIAI_TLS_KEY=key.pem MIAI_TLS_CERT=cert.pem node src/main.ts --listen 8768
node tools/fake-phone.ts --port 8768 --sbc tmp/voice.sbc --tls --ca cert.pem
```

客户端把 CA 打进包再严格校验，就等价于证书 pinning —— 不需要自研应用层加密。

**公网可及就必须要鉴权**：没有 `MIAI_TOKENS` 等于谁都能往云上推音频。加了之后，
客户端 `Hello` 里不带 token 会收到 `Control: auth_required` 并被断开。

### 端口踩过的坑

`8765` 从公网连不通，现象很怪：TCP 能建立，TLS 一发数据就被断开，服务器上 `tcpdump`
抓不到任何到达的包 —— 卡在云厂商的安全组，不在主机（`iptables` 全 ACCEPT、`ufw` inactive）。
换端口前先在目标机器上抓一次包，别先怀疑自己的代码。

控制口跟着 `--listen + 2` 走，但 `mcp/` 里那两个工具脚本是**写死 URL 的**，换了端口不改它们，
模型就会说"挂断的工具现在不可用了"：

```ini
PHOTO_CTL_PORT=63995                                 # 进程监听哪个控制口
PHOTO_CTL_URL=http://127.0.0.1:63995/take_photo       # mcp-camera.mjs 读这个
SESSION_CTL_URL=http://127.0.0.1:63995/end_session    # mcp-session.mjs 读这个
```

### agent 用 `--dsh-sdk`

不带 `--dsh-sdk` 的 headless 模式不接 `--patch`，MCP 工具根本不会注册，模型只能回
"工具不可用"。带上才会用 `DSH_PATCH` 里的 `mcp/camera.yml` 挂上 `take_photo` / `end_session`，
顺带省掉每次重启进程的开销。

## 后台任务与完成播报

长任务**不需要自己造任务队列** —— dsh 自带：

```text
模型调 bash {run_in_background: true}
  → job/registered，工具立刻返回        （实测 2.8 s）
  → 模型回一句"我让后台去办了"→ turn 结束（实测 3.6 s，主对话就自由了）
  → 若干秒后 job/settled
  → dsh 自己开一轮把结果说出来           （没有 session/prompt）
```

以前这最后一轮会被**静默丢掉**（只在 prompt 期间挂 `onIdle`，自发轮次没有等待者）。
现在 `src/spontaneous.ts` 识别它，交给 `VoiceAgent.onAnnounce` 清洗成可朗读文本，
再由旁白通道播出来。实测：

```text
03:46:50  agent   "已经派到后台了，我这就回来，不等它跑完。"   2.12 s
03:46:58  状态    speaking → listening
03:47:19  [sdk]   后台任务结算 → agent 自发开了一轮（不是我们催的）
03:47:21  后台    任务完成 → 播报 "后台那条已经跑完了，输出 bg30-done，一切正常。"
03:47:23  旁白    ... 5.12 s
```

三个前提：

- **提示词要点明**：不提醒的话模型会自己调 `job_output{wait:true}` 干等（实测等满 20 s）。
  `agent.ts` 的 `VOICE_SYSTEM` 里已写明"派出去、立刻回、不要等"。
- **播报不占轮次**：走旁白通道，用户正在说话或正在听播报时排队，回到 listening 再放 ——
  抢话比晚两秒更烦人。
- **断线不丢**：任务完成时如果没有连接，那句话落到 `~/.voice-agent/announce.jsonl`
  （`MIAI_ANNOUNCE_FILE` 可改，条数上限 `MIAI_ANNOUNCE_MAX` 默认 20），下次连上第一条就补播。
  语义是**至少一次**：崩溃在播放中途会重复播一句，比丢一句好。

## 事后排障：原始档案

出问题之后不能靠猜。`MIAI_ARCHIVE_DIR` 一开，**每条连接**都留一份完整档案：

```text
<root>/20261114-031530-203.0.113.20_2421/
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

看延迟：

```bash
node scripts/latency-report.ts <会话目录>        # 逐轮"用户说完 → 听到第一个字"分解
node scripts/latency-report.ts <root> --all     # 每个会话各出一份
```

**为什么必须留"放大前"的 PCM**：像"小声说话识别不出来"这种问题，事后必须能在不同增益/门限下
重放判断，而不是拿已经放大的波形去猜原始电平。旧的 `DUMP_DIR`（`up/down_<turn>.pcm`）已被取代 ——
那套只覆盖播放期，恰好漏掉"用户说话但没成句"，而且同名文件会被下一条连接覆盖。

## 已知限制

- **单设备**：一条连接结束后进程退出；多设备要 `runTransport({singleConnection: false})`
- **一副眼镜一个会话**：同时在线不是目标
- **图片落盘默认关闭**（`PHOTO_DIR` 为空），识图轮次仍可用
- **播放时长是估算**：`turn-runner` 用 `audioSeconds + playbackTailMs` 之后 sleep 轮询，
  服务器不知道设备真正播到哪。"它什么时候觉得自己说完了"建在这个估算上
- **`session.ts` 有 180 s 上限**：超时必须抛错并说出来，不许静默

## 明确不做

- **像素 / 动画 / 形象** —— 这条路已有 7 200 星的项目在做
- **为"感觉"造证据系统** —— 活人感靠盲测，不靠指标
- **多设备同时在线** —— 一副眼镜一个会话

## 相关仓库

`C:\Miaiglassses2grokbot` 是研究线：小米眼镜 Kotlin SDK（SPP 逆向、握手、门面）、A–AW 逆向笔记、
手机端调试 App，以及设备侧的实验记录。两侧**零代码依赖**，只通过上面的线协议通信 ——
改设备侧去那边，改语音/对话/宠物在这边。

## 许可

MIT。
