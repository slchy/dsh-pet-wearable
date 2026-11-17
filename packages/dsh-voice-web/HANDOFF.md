# dsh-voice-web 交接

写给接手 web 端运维的人。**这不是设计文档**，是"现在到哪一步了、哪里会踩"的实况。

最后更新：2026-11-17，交接时的状态。

---

## 1. 这是什么

`dsh-pet-wearable` 的 web 兼容层：浏览器 ⇄ WS ⇄ 本进程的桥 ⇄ TCP 回环 ⇄ 本进程内的语音栈。

```
浏览器页面（麦克风 / 扬声器）
   │  WS 二进制帧，一条消息一段字节
   ▼
bridge.ts（同端口既发页面也升级 WS）
   │  net.connect(127.0.0.1)
   ▼
语音栈（src/voice/ 是仓根 src/ 的副本，由 scripts/sync-voice.mjs 生成）
```

桥**不解析协议** —— 上行 WS 消息原样写进 TCP，下行 TCP chunk 原样当一条 WS 消息发回。两端的 `FrameDecoder` 各自按 `[type:u8][len:u32 LE][payload]` 重新切帧，所以消息边界无所谓。

## 2. 怎么装、怎么起

```bash
# 仓根
npm install
npm run build -w dsh-voice-web        # 同步语音栈 + 编译 lib/ + 打包页面

# 装进一个独立的 dsh profile（不要装进 sdk —— 会递归 spawn 自己）
dsh plugin --profile voice add -w link:C:/dsh-pet-wearable/packages/dsh-voice-web

# 起
cd C:\dsh-pet-wearable
dsh --profile voice
```

启动成功会打出这些行（**这就是判断"线接没接上"的唯一凭据**）：

```
可替换件 STT=aliyun:cn-shanghai  TTS=cosyvoice（24000 Hz）
快车道    投机=开（宿主支持 session/cancel，命中时可作废在途那一轮）
快车道    开（短句闲聊直答，其余交给 dsh；FAST_LANE=0 关闭）  model=qwen-flash
记忆      C:\dsh-pet-wearable\MEMORY.md（0 条，快车道只读）
保活      空闲 180 分钟发一次前缀保活（KEEPALIVE_MINUTES=0 关闭）
WS 桥监听 ws://127.0.0.1:8767
页面     http://127.0.0.1:8767/
```

浏览器打开 `http://127.0.0.1:8767/`。**必须戴耳机。**

## 3. 配置必须与生产对齐

生产（`systemctl cat miai-harness`）：

```
ExecStart=/usr/local/bin/node /home/slchy/miai-cloud/src/main.ts --listen 63993 --host 0.0.0.0 \
  --stt aliyun --tts cosyvoice --agent dsh --dsh-sdk --work-dir /home/slchy/voice-workspace
```

生产 `.env` 里与链路有关的：

```
FAST_LANE_MODEL=qwen-flash
FAST_LANE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DSH_PATCH=/home/slchy/miai-cloud/mcp/camera.yml
```

**本地必须照抄这三项。** 配成 `tts: mimo` 或快车道 `deepseek-chat`，测出来的延迟就不是生产那个数字了 —— TTS 首块 330 ms、快车道首字 290 ms 这些结论全是 cosyvoice + qwen-flash 测的。

本地 `~/.dsh/profiles/voice/cordis.patch.yml` 现在是对齐过的（`stt: aliyun` / `tts: cosyvoice` / `workDir: C:/dsh-pet-wearable`）。

## 4. 凭据

在 `C:\dsh-pet-wearable\.env`（**不入库**，`.gitignore` 有；ACL 只给当前用户）。从服务器 `~/miai-cloud/.env` 拷过来的键：

```
ALIYUN_AK_ID / ALIYUN_AK_SECRET / ALIYUN_APPKEY / ALIYUN_NLS_REGION   → stt: aliyun
DASHSCOPE_API_KEY                                                     → tts: cosyvoice
FAST_LANE_API_KEY / FAST_LANE_MODEL / FAST_LANE_BASE_URL               → 快车道
DSH_PATCH
```

`MIMO_API_KEY` 也在里面，但那是 `tts: mimo` 才用，与生产不一致。

**dsh 会自己读调用目录的 `.env`**（经 `@deepseek-ai/dsh-launch-environment`），所以插件不需要额外做。`assembly.ts` 的 `loadDotEnv()` 只是别的宿主上用的兜底，正常情况下返回 0、不打那行。

## 5. 已完成 / 已验证

| 项 | 证据 |
|---|---|
| 桥收发 + 页面同端口托管 | `GET /` 200 / `GET /main.js` 200 / `GET /../package.json` 404 |
| 路径穿越防护 | 规范化后校验前缀，实测 404 |
| v2 握手 | 服务端日志 `设备 xxx（v2）：上行 pcm16` |
| 一轮完整对话 | `listening → thinking → speaking`，下行 24000 B |
| 快车道接线 | `认领预跑（已经跑了 623 ms）` / `376 ms 首字` |
| 打断取消 | `session/cancel 可用` + 轮末 `取消在途请求` |
| 卸载干净 | `fiber.dispose()` 后两个端口都释放 |
| 真实 AI 回复 | 接快车道前首块 6.3 s → 接后 0.66 s |

## 6. 没验证 / 已知缺口

- **真麦克风、真扬声器没测过。** 所有"能说话"的验证都是脚本伪造上行（正弦波或 TTS 合成音）。页面上的麦克风采集、AudioWorklet 降采样、播放排队都没有在真实浏览器里跑过。
- **回声余量没测过。** 页面上有「测回声余量」按钮，但没在真机扬声器+麦克风下跑出过数字。
- **Safari 没测过。** `addModule(blobURL)` 在 Safari 上历史上有问题，可能要给真实文件路径。
- **多标签页没测过。** 每个连接一份完整的 `VoiceConnection`，开三个页面就是三份。
- 页面顶部写了"请戴耳机"，但**没有做任何强制或检测** —— `enumerateDevices()` 拿不到可靠的"当前输出是不是耳机"。这条只能靠人。

## 7. 踩过的坑（照抄结论，别重走）

| 坑 | 现象 | 结论 |
|---|---|---|
| `exports` 指向 `.ts` | `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | Node 不对 `node_modules` 里的 TS 剥类型。必须 `tsc` 编译到 `lib/`，靠 `rewriteRelativeImportExtensions` 把 `./x.ts` 重写成 `./x.js` |
| 仓里放软连接 | `npm pack` 打出来的 tarball 里链接目标**整个消失** | npm 11.16 的 packlist 直接跳过 symlink，三种 `files` 写法都不行。改用 `scripts/sync-voice.mjs` 复制 + `.gitignore` |
| 插件只调 `buildAgent` | 每句等完整 dsh，首块 6.3 s | `main.ts` 在 `buildAgent` 之后还接 `FrontedAgent`（快车道）+ `keepalive` + `trackActivity` + 记忆。现抽进 `assembly.ts` 的 `wireAgent()`，两个调用方共用 |
| `logger.info` 看不见 | 插件日志一条不显示 | dsh 里 logger 的输出读不到。运维要看的行一律 `console.log` |
| `apply()` 里 `console.log` | 插件加载阶段打印不出来 | 那时 stdout 还没接管。要打就放进 `ctx.effect` |
| Windows `spawn('dsh')` | `spawn dsh ENOENT` | npm 的 `.ps1`/`.cmd` 垫片不是可执行映像。`DSH_BIN` 指向 `dsh.cmd`（已设成用户级） |
| 没有 `session/cancel` | 投机被强制关闭，打断白等 2 s | 跑 `node scripts/patch-sdk-cancel.mjs`（幂等，有 `.orig` 备份）。**升级 dsh 后要重跑** |
| 两个 voice 进程 | 新进程绑不上 8767，日志是空的 | 旧进程占着端口。起之前先 `Get-CimInstance Win32_Process` 找 `--profile voice` 全停掉 |
| 装进 `sdk` profile | 递归：插件 spawn `dsh --profile sdk`，那个又加载插件 | 绝对不要装进 `sdk` |
| `tts: silent` | 下行全零，耳机自检测不出东西 | 数字静音不是"能听见"。验证音频必须用真 TTS |

## 8. AEC 的决定

**不做回声消除，要求戴耳机。** 理由：

- 整条语音栈假定端侧已做 AEC（`src/devices/primitives.ts` 明写），服务端没有任何回波抑制，打断判据是绝对能量门 `VOICE_PEAK_DBFS`（默认 −40 dBFS）。
- 戴耳机之后声学回声路径根本不存在，浏览器自带的 `echoCancellation: true` 只是兜底。
- 外放时残余电平取决于音量、房间、浏览器 AEC 质量，**调门限治不了**；真做自适应滤波是另一个量级的活。

页面顶部有硬提示。**这条是使用前提，不是建议。**

## 9. 交接时没收尾的

- 本地 `dsh --profile voice` 是**前台进程**，没有做成常驻/开机自启。
- `_loop.mjs`（TTS 合成 → 当上行喂回去的闭环脚本）是临时验证件，已删。
- 生产端本节不覆盖 —— 见 `docs/OPS-RECORD.md` 与服务器 `~/miai-cloud`。
