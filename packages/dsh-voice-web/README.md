# dsh-voice-web

`dsh-pet-wearable` 的 web 兼容层：WebSocket 桥 + 浏览器侧采集与播放，语音栈复用 `dsh-pet-wearable`。

## 状态

**能跑**（`npm install && npm run build` 之后）。`apply()` 会在插件进程内起一份语音栈（内部端口由系统挑），再把 WS 桥接上去，卸载时两边一起收掉。

装配**不是抄一份**：管道判据与热路径装配直接用包① 导出的
`assemblePipelinePlan()` / `assembleStreamingAgent()`（都在 `src/main.ts`），
所以 `VOICE_PIPELINE=live|cascade`、快车道、omni 车道、后台汇报、投机这些行为
与 CLI 逐字同一套代码。`scripts/sync-voice.mjs` 每次构建都会重新同步，漂不了。

与「独立进程」形态**有意不同**的四处：

| 项 | 独立进程 | 本插件 | 为什么 |
|---|---|---|---|
| 内层监听端口 | `--listen` 固定 | `0`，靠 `onListening` 拿真实端口 | 省掉「固定端口会不会撞」这条隐式约定 |
| 停机 | 连接结束 / 进程退出 | `onListening().stop()` | 多标签页要 `serve: true`，而这种模式下**没有任何事件会结束** `runVoiceServer`；没有 `stop()`，卸载插件时监听与控制口都关不掉（泄漏） |
| TLS | 语音栈自己终结 | 只在 `startWebBridge` 终结，证书读插件自己的 `tls.keyPath/certPath` | 桥用 `net.connect` 连回环，里层套 TLS 根本连不上 |
| 配置错误 | `process.exit(2)` | 抛异常 | 跑在 dsh 进程里，退出会把宿主一起带走 |

包名已被 `0.0.0-stage` 占住（那个空占位没有 `main`，`import` 会失败）；本仓库的版本尚未发布。

## dsh web / Desktop 浮动语音桌宠挂件（Gemini 娘）

`mode` 默认 `auto`。profile 里有 `webServer`（`dsh web`、Desktop）时，插件挂到宿主的 `/dsh-voice/*` 与 `/dsh-voice/ws`，不另开 `:8767`。启动时若 `webServer` 还没出现，会再等大约 1.5 秒；仍没有就退回独立桥，`demo/` 的打开方式不变。沿用 `:8767` 与 `demo/` 时，把 `mode` 设为 `standalone`。`host` 则一直等到 `webServer` 再挂载。

一条命令把本机这份源码装进 `web` profile（路径换成仓库里 `packages/dsh-voice-web` 的绝对路径）：

```bash
dsh plugin --profile web add link:<abs-path-to-packages/dsh-voice-web>
```

挂件有两条注入通道，各写各的、各自去重：

- Desktop 壳不经过 `tapIndex`。`apply()` 一进来（还没跑 `ctx.effect` / `ctx.inject`）就听 `webserver/index-inject`，往表里追加一段内联引导，由它自己插入 `<script src="/dsh-voice/widget.js">`。脚本 404 时引导把标记清掉，不把桌面壳的启动打失败。
- 网页 index 走 `tapIndex`，在 `</body>` 前插同一支脚本。

`/dsh-voice/ws` 与页面同源。二进制帧原样进出语音栈（上下行音频）；文本帧只带界面事件（相位、字幕、情绪），不写进 TCP。`agent: dsh` 且宿主有 `sessionController` 时用 `InProcessDshAgent`，会话钉在一条上：`sessionId` 非空就用配置里的 id，并盖过 `~/.dsh/.dsh-voice-pet.json`；留空则沿用那个文件里上次选中的 id。`agent: dsh-subprocess` 始终拉起原来的 `dsh` 子进程。没有 `sessionController` 时，`dsh` 也退回子进程。

挂件画 10 个表情，说话时按底轴 RMS 摇摆，按压有回弹，松手吸附到边缘，点击区域按不透明像素的凸包算。

| 配置 | 含义 |
|---|---|
| `mode` | `auto`（默认）/ `host` / `standalone` |
| `sessionId` | 固定的 dsh 会话。空字符串表示用 `~/.dsh/.dsh-voice-pet.json` |
| `DSHV_TRUSTED_HOSTS` | 宿主连接栅栏不可用时，额外允许的 Host，逗号分隔 |
| `DSHV_ADMIN_HOSTS` | 非回环写请求额外允许的 Host，逗号分隔 |

代码、配置与文档是 MIT。`assets/pet/**` 的表情图不在 MIT 许可内，也不授予再许可，只供本插件运行时使用。界限和清单在 [`PROVENANCE.md`](./PROVENANCE.md)。

## 源码地图

宿主逻辑位于 `src/host-*.ts`，桌宠界面位于 `src/browser/pet-*.ts`，进程内 `dsh` 代理位于 `src/in-process-agent.ts`（`InProcessDshAgent`）。

```text
src/driver.ts              apply()：宿主相位、桌面注入，再把语音栈交给 boot
src/driver-policy.ts       HostPhase / StackPhase / VoiceBackendState，纯转移
src/boot-voice-stack.ts    与 CLI 同一套装配；这里调用 loadSharedVad
src/standalone-bridge.ts   mode=standalone 的独立桥
src/host-lifecycle.ts      发现 webServer、会话 id、mountHostPlugin
src/host-mount.ts          /dsh-voice/* 与 index 注入
src/host-security.ts       连接栅栏
src/in-process-agent.ts    InProcessDshAgent
src/bridge.ts              WS ↔ 本机 TCP
src/browser/client.ts      VoiceClient（ClientPhase）
src/browser/capture.ts     采集
src/browser/playback.ts    播放
src/browser/frames.ts      分帧
src/browser/pet-widget.ts  挂件入口
src/browser/pet-ui.ts      界面状态
src/browser/pet-sprites.ts 十张表情
src/browser/pet-talk.ts    说话时的姿态
src/browser/pet-dom.ts pet-styles.ts pet-hit.ts pet-drag.ts
src/browser/pet-geometry.ts pet-prefs.ts pet-session.ts
```

## 语音栈从哪来

`packages/dsh-voice-web/scripts/sync-voice.mjs` 把仓根 `src/` 复制到 `packages/dsh-voice-web/src/voice/`。这份副本**不进 git**，`npm run build`、`typecheck`、`prepack` 都会重跑同步刷新；只排除 `driver.ts`、`fsm-trace.ts`、`latency-report.ts`、`pair.ts`、`pairing.ts`、`pet/sim/`。`package.json` 发布的是编译后的 `lib/`、`assets/`、`cordis.patch.yml` 和 `PROVENANCE.md`（早期冒烟联调用的独立 `demo/` 已归档至仓根 `archive/dsh-voice-web-demo/`，不再随包发布）。

为什么不是软连接：实测 npm 11.16 的 packlist **直接跳过 symlink** —— `files: ["src"]`、显式列 `src/voice`、`src/voice/**` 三种写法打出来的 tarball 里都没有链接目标，本地能跑、发出去是空包。

为什么要复制而不是依赖 `dsh-pet-wearable`：包② 要能在没有包① 的情况下装起来，所以不能只留一个 `dependencies` 指过去。代价是两边的 `package.json` 依赖清单得手动对齐 —— **漏一个就是编译/运行期才炸**（例如 `undici`：包① 的 `http-agent.ts` 直接引它，web 侧少了它连 `lib/` 都编不出来）。

神经 VAD 不在插件里另写一份查找。`boot-voice-stack.ts` 调同步过来的
`voice/runtime/vad-bootstrap.ts`（仓根是 `src/runtime/vad-bootstrap.ts`）。
`VOICE_VAD` 缺省 `auto`；`VOICE_VAD_MODEL` 非空就用那个路径。
否则按 cwd，以及相对该文件的 `../../models`、`../../../models`、`../../../../../models`
找 `silero_vad.onnx`。仓根开发时更深的那一档回到仓库 `models/`。
文件不在 git 里（仓根 `.gitignore` 的 `models/*.onnx`）。找不到或加载失败就退回能量门，插件照常起来。
接上的日志是 `VAD Silero v5 神经 VAD 已就绪`。最短人声 120 ms 与 ASR 预卷 320 ms 由仓根 `voice-config.ts` 的常量 `DEFAULT_MIN_SPEECH_MS` / `DEFAULT_ASR_PREROLL_MS` 控制。

声学判停（TurnJudge）同理：`boot-voice-stack.ts` 调同步过来的
`voice/runtime/turn-judge-bootstrap.ts` 的 `loadSharedTurnJudge()`，模型
`models/smart-turn-v3.2-cpu.onnx`（`TURN_JUDGE_MODEL`，兼容旧名 `SMART_TURN_MODEL`），
进程内 ONNX 推理，**不需要 Python**。找不到模型时退回固定合并窗口，插件照常起来；
接上的日志是 `声学判停  Smart Turn v3.2 进程内 ONNX 已就绪`。

`npm test` 当前 **77** 项，都在 `tests/*.test.ts`（桥、帧、宿主挂载与安全、进程内 agent、桌宠几何 / 拖拽 / 表情 / 姿态）。
语音栈行为的测试在仓根 `src/` 同步之前的那一份上跑，不在这 77 项里。

## 为什么不用 WebRTC

端侧不跑 ASR/TTS/推理，上行只是一段 PCM16，下行是已经合成好的音频块 —— 没有需要媒体栈去协商的东西。走 WS 换来的好处是实现短、日志可读（一帧就是一个 `[type][len][payload]`，可以直接打进时间线），代价是丢掉了浏览器原生的 AEC 与抖动缓冲。

桥本身**不解析协议**：一条 WS 消息对一段 TCP 字节，两端的 `FrameDecoder` 各自重新切帧，所以消息边界无所谓。

## 与真机那条链路的关系

| | 真机（`dsh-pet-wearable`） | 浏览器（本包） |
|---|---|---|
| 传输 | TCP + 自定义分帧 | WS → 桥 → 本机 TCP |
| 上行编码 | mSBC（1 字节头 + 60 字节块） | PCM16 裸流，16 kHz |
| 下行 | 同协议帧 | 同协议帧，24 kHz，交给 AudioContext |

## 本地跑 demo

不用另外起静态服务器 —— 桥把页面和 WS 发在**同一个端口**，所以：同源（不用配 `origins` 白名单），而且 `http://127.0.0.1` 本身就是安全上下文（`getUserMedia` 才有）。

```bash
npm install                # 本包是独立包（仓根没有 workspaces），依赖要在本目录装
npm run build              # 同步语音栈 + 编译 lib/ + 打包页面
npm run typecheck          # 不产出文件，只验类型
npm test                   # sync:voice，再 node --test tests/*.test.ts（77 项：桥、宿主、进程内 agent、桌宠；语音栈行为以仓根 src/ 的测试为准）
```

`prepublishOnly` 跑 `typecheck && test`。

`npx tsc --noEmit` 单跑不等于 typecheck：`npm run typecheck` 会先 `sync:voice`，
副本没同步时缺模块的报错（`Cannot find module './voice/turn-judge.ts'`）才是真的。
离线验收一把梭：`typecheck` → `build` → `npm pack --dry-run`（后者确认 tarball 里
`lib/driver.js`、`lib/voice/main.js`、`lib/widget.js`、`assets/pet/*.webp` 都在，且不含已归档的 `demo/`）。

`dsh --profile <装了本插件的 profile>` 启动后终端会打出：

```
web       http://127.0.0.1:8767/   ← 浏览器打开这个地址
```

页面上：一个开始/结束按钮、麦克风电平条、立即静音（空格也行）、日志折叠块。

页面里的 WS 地址由 `location` 推出（同端口、`https` → `wss`），换机器换端口都不用改代码。

### 启动前必须 `export` 的两个键

`DSH_BIN` 与 `DSH_PATCH` **不能写进 `.env`** —— dsh 会拒绝启动：

```
dsh: .env sets "DSH_PATCH", which only the launching environment may set
```

在起进程的那个 shell 里 export（每次新开终端都要重来一次，这正是它不该进 `.env` 的原因）：

```powershell
$env:DSH_BIN  = 'C:\Users\<你>\AppData\Roaming\npm\dsh.cmd'   # 指向 .cmd 垫片，不是 .ps1
$env:DSH_PATCH = '<仓库路径>/mcp/camera.yml'
dsh --profile voice
```

少了 `DSH_BIN` 的症状是 `[sdk] 启动失败：spawn dsh ENOENT`（快车道还在，但每句都退化成等完整 dsh）；少了 `DSH_PATCH` 则起不来。

## 打断：v2 发的是 `Call`，不是 `Control`

服务端对 v1 设备发 `Control: stop`，对 **v2 设备（浏览器就是 v2）发的是 `Call {"op":"audio.stop"}`** —— 见 `src/voice/devices/wire-v1.ts`（仓根 `src/devices/wire-v1.ts` 的同步副本）里那个 `audio.stop → 'stop'` 的翻译，v1 才有这一层。语义写在 `src/voice/devices/primitives.ts`（仓根 `src/devices/primitives.ts` 的同步副本）：*「立刻停止播放并清空播放队列（插话）」*。

所以浏览器客户端必须自己认 `audio.stop` 去 `playback.stop()`。只处理 `Control: stop` 的后果很隐蔽：***一切都正常，只是用户插话之后，已经排进队列的回答还会继续播完***。

`Control: end_session` 仍然走 `Control`（收尾），两条路都处理。

**本地「立即静音」只清本地队列**：服务端不知道你按了按钮（上游没有取消原语），同一轮的后续音频还会继续下发，于是过一百毫秒左右又响起来。真正让服务端停下来的是**你开口说话** —— 打断是服务端听出来的，不是按钮告诉它的。

## 浏览器这边的硬约束

| 约束 | 说明 |
|---|---|
| **安全上下文** | 必须 `https://` 或 `http://localhost` / `http://127.0.0.1`。用 `http://<局域网 IP>` 打开时 `navigator.mediaDevices` **是 undefined**，连权限弹窗都不会出 |
| **用户手势** | `AudioContext.resume()` 与 `getUserMedia` 都要在点击的调用栈里，否则 iOS Safari 上采集静默不出数据 |
| **权限** | 嵌 iframe 时页面要带 `Permissions-Policy: microphone=(self)` |
| **戴耳机** | 这条链路不做回声消除，外放会被自己的声音触发。见下文「回声」 |
| **客户端生命周期** | `createVoiceClient` 用显式 `ClientPhase` 与 `startGen`，收口只走一次 `teardown()`。并发 `close` 不会把还在 `await` 上的麦克风漏开 |
| **桥的绑定与路径** | `bridge.ts` 复用 `checkBindSafety`：非本机没有 TLS 就拒绝启动，并且要配 `origins`。畸形百分号编码（如 `GET /%`）返回 HTTP 400 |

## 回声：要求戴耳机，不做回声消除

整个语音栈**假定声学回声不存在**（见 `src/devices/primitives.ts`：真机眼镜在端侧做 AEC，插件不再重复做），服务端没有任何回波抑制，打断判据是绝对能量门 `VOICE_PEAK_DBFS`（默认 **−30 dBFS**）。`driver.ts` 与仓根 `src/main.ts` 都经 `buildVoiceRuntimeConfig` 读同一份 `voice/voice-config.ts`（本包同步在 `src/voice/voice-config.ts`，仓根是 `src/voice-config.ts`）。浏览器只显式覆盖 `micGain: 1`、`controlPort: 0`。

**门限与上行增益必须成对看**：门限按**放大后**的电平算。独立进程默认 `MIAI_MIC_GAIN=4`（眼镜 mic 电平低），web 插件默认 **1×** —— 浏览器侧 `getUserMedia` 已经开了 `autoGainControl`，再乘 4 会顶到削波。改其中一个就得回头量另一个。

浏览器这边只有 `echoCancellation: true` 兜一层。**这个项目的决定是：要求戴耳机，不建回波抑制。** 戴耳机之后声学回声路径根本不存在，AEC 只是兜底；外放时残余电平取决于音量、房间、以及浏览器 AEC 的质量，靠调门限是治不了的，而真做自适应滤波是另一个量级的活。

页面顶部因此有一条硬提示。这不是"建议"，是使用前提 —— 外放时它会把自己的声音当成用户开口，然后一直打断自己。

**为什么不自动检测耳机**：`navigator.mediaDevices.enumerateDevices()` 拿不到可靠的"当前输出是不是耳机"（很多系统把耳机和扬声器报成同一个 sink，iOS 更是完全不给），所以只能靠提示 + 下面这项自检。

### 自检：确认耳机真的生效

页面上的「测回声余量」：静默 1.2 s 取底噪 → 从**采集/播放共用的那个 `AudioContext`** 放 3 s 测试信号 → 全程记录上行峰值 → 给出对门限的余量。

测试信号是白噪经一阶低通塑到语音频段、再套 3.2 Hz 音节包络 —— 不用正弦（稳态单音对自适应滤波器最好打，量出来偏乐观），也不用恒定电平噪声（真实语音有起伏，AEC 在起伏处最容易露馅）。

| 余量 | 含义 |
|---|---|
| ≥ 25 dB | 耳机生效了 |
| 10–25 dB | 勉强够，可能漏音或戴得不严 |
| < 10 dB | 大概率没戴耳机，这个状态下会被自己的声音触发 |

测量期间请保持安静：页面无法区分「回波」和「你在说话」，你出声会把结果抬高。

用 `tts: silent` 时测不出东西 —— 下行是数字静音，没有可回的声音。

## 离线跑起来（不需要任何密钥）

验「线接没接上」不必先配厂商：`canned`（固定识别结果）+ `silent`（静音下行）+ `echo`
只走本地回环，装配路径与生产完全相同（同一个 `apply()`、同一条 `runVoiceServer`）。

新建一个独立 profile，别动 `voice` 那个：

```bash
dsh plugin --profile voicetest add -w link:<仓库路径>/packages/dsh-voice-web
```

`~/.dsh/profiles/voicetest/cordis.patch.yml`：

```yaml
- insert:
    - id: voice-web
      name: dsh-voice-web
      config:
        port: 8791
        host: 127.0.0.1
        stt: canned
        tts: silent
        agent: echo
        workDir: <仓库路径>
```

`dsh --profile voicetest` 之后应当看到：

```
可替换件 STT=canned  TTS=silent（24000 Hz）
监听 tcp://127.0.0.1:<随机口>（不鉴权）
WS 桥监听 ws://127.0.0.1:8791
web       http://127.0.0.1:8791/   ← 浏览器打开这个地址
```

内层是**随机口**、外层是配置里的 8791 —— 这就是 `onListening` 在起作用。
页面 200 / `main.js` 200 / `/../package.json` 404，再加一条 v2 握手
（收到 `Welcome {"proto":2}`）就说明桥与协议都对上了。

## 链接

- 主页与文档：<https://github.com/slchy/dsh-pet-wearable>
- 语音栈：仓根就是包 `dsh-pet-wearable`
