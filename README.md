# cloud — 眼镜 ⇄ 云端的语音通道

一部手机一条 TCP 连接，上行 mSBC 语音、下行 PCM 语音 + 控制串。STT / TTS / Agent
三件都是**可替换件**，换厂商不用改这里任何代码。

> 状态：私有仓开发中，暂未开源（原因见 `docs/BACKLOG.md` B-004）。

## 跑起来

```bash
cd cloud
npm install

# 1) 什么都不接，纯离线自测（不需要任何密钥，不落盘）
node src/main.ts --listen 8766 --stt canned --tts silent --agent echo

# 2) 另一个终端：最小客户端，发一段 mSBC
node tools/fake-phone.ts --port 8766 --sbc ../tmp/voice.sbc
#    ← Audio ×1  Control=[]  Pong=true

# 3) 生产
export ALIYUN_APPKEY=...            # 阿里云 NLS 实时识别（另有 ALIYUN_AK_ID / ALIYUN_AK_SECRET）
export MIMO_API_KEY=...             # MiMo TTS
node src/main.ts --listen 8765      # 默认 --stt aliyun --tts mimo --agent dsh
```

手机侧先 `adb reverse tcp:8766 tcp:8766`（只监听 `127.0.0.1` 时日志会提示这一行）。

## 三个可替换件

| 开关 | 取值 | 说明 |
|---|---|---|
| `--stt` | `aliyun` `noop` `canned` `<模块路径>` | 上行识别，每次连接开一个会话 |
| `--tts` | `mimo` `silent` `<模块路径>` | 下行合成，采样率由实现自己声明 |
| `--agent` | `dsh` `echo` `none` `<模块路径>` | 裸 `--agent` 等价 `dsh` |

`<模块路径>` 指向一个导出工厂的文件，例如：

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

| 文件 | 只做一件事 |
|---|---|
| `src/transport.ts` | accept、帧编解码、Hello 鉴权、Ping/Pong、空闲看门狗、TLS |
| `src/providers.ts` | STT / TTS / Agent 的接口与内置实现 |
| `src/uplink-pipeline.ts` | mSBC → PCM（ffmpeg）→ 能量门 → 有声段 |
| `src/session-core.ts` | 对话决策：唤醒词/旁听反馈/插话/识图轮 → 产出动作（纯，可单测） |
| `src/photo-inbox.ts` | 拍照请求的等待、超时与落盘 |
| `src/aliyun-session.ts` | 一条连接的接线（不含判定逻辑） |
| `src/turn-runner.ts` | 一轮对话：agent 流式出字 → TTS 流式出音 → 下发 |
| `src/dialog-fsm.ts` | 对话状态机（listening/thinking/speaking/ending + 插话作废） |
| `src/main.ts` | 只做装配与 CLI |

改这些地方的判定不用碰网络：`npm test` 跑 `tests/session-core.test.ts`（纯事件 → 断言动作）。

## 调试口（没有麦克风也能联调）

连接建立后，云端在 `--listen + 2` 端口开一个本机控制口（`PHOTO_CTL_PORT` 可覆盖）：

| 路由 | 作用 |
|---|---|
| `POST /say`（body = 一句话） | 当作「用户说了这句」，走正常轮次 → agent → TTS → 下发 |
| `POST /take_photo` | 让设备拍一张，返回 JPEG |
| `POST /end_session` | 按「说完这句就挂断」处理 |

```bash
curl -X POST --data '你好，介绍一下你自己' http://127.0.0.1:8770/say
```

这条口子只绑本机，是给联调与客户端作者用的；生产部署请别把它暴露出去。

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
node tools/fake-phone.ts --port 8768 --sbc ../tmp/voice.sbc --tls --ca cert.pem
```

客户端把 CA 打进包再严格校验，就等价于证书 pinning —— 不需要自研应用层加密。

## 协议（最小实现见 `tools/fake-phone.ts`）

```
[type:u8][len:u32 LE][payload]

上行  Audio=1 Image=2 Wake=3 Ping=4 Hello=6
下行  Audio=1 Control=2 Pong=5
```

`Hello` 是 JSON（`{proto, deviceId, token}`）；没配鉴权时客户端可以不发。

## 已知限制

- 单设备：一条连接结束后进程退出；多设备要 `runTransport({singleConnection: false})`
- 图片落盘默认关闭（`PHOTO_DIR` 为空），识图轮次仍可用
