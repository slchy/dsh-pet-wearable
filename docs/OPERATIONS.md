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
node src/main.ts --listen 8766 --stt aliyun --tts mimo --agent dsh
  └─ dsh --profile sdk --patch <patch.yml>      ← stdio JSON-RPC，一辈子跟着父进程
     ├─ mcp/mcp-camera.mjs
     └─ mcp/mcp-session.mjs
```

两个要点：

- **`dsh` 没有 daemon 模式**。它的"常驻"完全来自父进程不杀它。要它活多久，就管好父进程。
- **`--dsh-sdk` 才能挂 MCP 工具**。不带这个标志的 headless 模式不接 `--patch`，工具根本
  不注册，模型只会回"工具不可用"。

常驻用一个 systemd 单元就够（`Restart=always`、`RestartSec=3`），`WorkingDirectory`
指向仓库/部署目录，凭据放 `.env` 且**不进同步范围**。

## 鉴权与 TLS

**先看判据**：非本机地址必须同时具备 token 与 TLS，否则不监听（退出码 2）。
判据在 [`src/bind-policy.ts`](../src/bind-policy.ts)，`transport.ts` 与 `driver.ts` 共用；
`tests/bind-policy.test.ts` 钉矩阵，`tests/transport-bind.test.ts` 断言拒绝时端口没被占。

独立进程形态下这几项走环境变量：

| 环境变量 | 作用 |
|---|---|
| `MIAI_TLS_KEY` / `MIAI_TLS_CERT` | 给了就走 TLS（另一条路径是明文 TCP，同一份代码）。**只给一个会启动即失败** —— 静默降级成明文会让人以为已经加密了 |
| `MIAI_TOKENS` | 指向 `token` 或 `token:deviceId` 一行的文件；配了就要求首帧 `Hello` |
| `--host` | 缺省 `127.0.0.1`；上公网由部署方显式给 `0.0.0.0`（**且必须配齐上面两项**） |

自签证书：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 \
  -subj '/CN=miai-local' -addext 'subjectAltName=IP:127.0.0.1'
MIAI_TLS_KEY=key.pem MIAI_TLS_CERT=cert.pem node src/main.ts --listen 8768
node tools/fake-phone.ts --port 8768 --sbc tmp/voice.sbc --tls --ca cert.pem
```

客户端把 CA 打进包再严格校验，等价于证书 pinning —— 不需要自研应用层加密。

**公网可及就必须要鉴权。** 没有 `MIAI_TOKENS` 等于谁都能往这个端口推音频。配了之后，
`Hello` 里不带 token 会收到 `Control: auth_required` 并被断开。

## 本机控制口

连接建立后，进程在 `--listen + 2` 端口开一个只绑本机的 HTTP 口（`PHOTO_CTL_PORT` 可覆盖）：

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
node scripts/latency-report.ts <会话目录>        # 逐轮"用户说完 → 听到第一个字"分解
node scripts/latency-report.ts <root> --all     # 每个会话各出一份
```

纯读，不改档案。分段口径与缺仪表语义见 [`src/latency-report.ts`](../src/latency-report.ts)。

## 待补播

后台任务完成时如果没有连接，那句话会落到 `~/.voice-agent/announce.jsonl`
（`MIAI_ANNOUNCE_FILE` 可改，条数上限 `MIAI_ANNOUNCE_MAX` 默认 20），下次连上第一条就补播。
语义是**至少一次**：崩溃在播放中途会重复播一句，比丢一句好。

## 播放时长是估算

`turn-runner` 用 `audioSeconds + playbackTailMs` 之后 sleep 轮询，服务器不知道设备真正播到
哪。"它什么时候觉得自己说完了"建在这个估算上。改成真回执之前，任何依赖"设备已播完"的
时序（比如紧接着挂断）都要按估算的误差留余量。
