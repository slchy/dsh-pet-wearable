# dsh-voice-web

`dsh-pet-wearable` 的 web 兼容层：WebSocket 桥 + 浏览器侧采集与播放，语音栈复用 `dsh-pet-wearable`。

## 状态

**能跑。** `apply()` 会在插件进程内起一份语音栈（内部端口由系统挑），再把 WS 桥接上去，卸载时两边一起收掉。

包名已被 `0.0.0-stage` 占住（那个空占位没有 `main`，`import` 会失败）；本仓库的版本尚未发布。

## 语音栈从哪来

`src/voice/` 是仓根 `src/` 的副本，由 `scripts/sync-voice.mjs` 生成，**不进 git**。`typecheck` 和 `prepack` 都会先跑一次同步。

为什么不是软连接：实测 npm 11.16 的 packlist **直接跳过 symlink** —— `files: ["src"]`、显式列 `src/voice`、`src/voice/**` 三种写法打出来的 tarball 里都没有链接目标，本地能跑、发出去是空包。

为什么要复制而不是依赖 `dsh-pet-wearable`：包② 要能在没有包① 的情况下装起来，所以不能只留一个 `dependencies` 指过去。代价是两边的 `package.json` 依赖清单得手动对齐。

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
npm run build              # 同步语音栈 + 编译 lib/ + 打包页面
```

`dsh --profile <装了本插件的 profile>` 启动后终端会打出：

```
web       http://127.0.0.1:8767/   ← 浏览器打开这个地址
```

页面上：一个开始/结束按钮、麦克风电平条、立即静音（空格也行）、日志折叠块。

页面里的 WS 地址由 `location` 推出（同端口、`https` → `wss`），换机器换端口都不用改代码。

## 浏览器这边的硬约束

| 约束 | 说明 |
|---|---|
| **安全上下文** | 必须 `https://` 或 `http://localhost` / `http://127.0.0.1`。用 `http://<局域网 IP>` 打开时 `navigator.mediaDevices` **是 undefined**，连权限弹窗都不会出 |
| **用户手势** | `AudioContext.resume()` 与 `getUserMedia` 都要在点击的调用栈里，否则 iOS Safari 上采集静默不出数据 |
| **权限** | 嵌 iframe 时页面要带 `Permissions-Policy: microphone=(self)` |

## 回声（AEC）现状

整个语音栈**假定端侧已做 AEC**（见 `src/devices/primitives.ts`），服务端没有任何回波抑制，打断判据是绝对能量门 `VOICE_PEAK_DBFS`（默认 −40 dBFS）。

浏览器这边只有 `echoCancellation: true` 这一层。Chrome 桌面版给的是 WebRTC AEC3，但残余电平在真实外放条件下是**未知的**，而门限是按真机标定的。

### 用页面上的「测回声余量」把它测出来

点一下按钮，页面会：静默 1.2 s 取底噪 → 从**采集/播放共用的那个 `AudioContext`** 放 3 s 测试信号 → 全程记录上行峰值 → 给出对门限的余量。

测试信号是白噪经一阶低通塑到语音频段、再套 3.2 Hz 音节包络 —— 不用正弦（稳态单音对自适应滤波器最好打，量出来偏乐观），也不用恒定电平噪声（真实语音有起伏，AEC 在起伏处最容易露馅）。

| 余量 | 判定 |
|---|---|
| ≥ 15 dB | 够用，外放不会被自己打断 |
| 0–15 dB | 偏紧，音量再大就误触发 → 播放期抬门限 |
| < 0 dB | 会自激 → 必须做播放期抬门限或半双工 |

测量期间请保持安静：页面无法区分「回波」和「用户在说话」，你出声会把结果抬高。

注意两点局限：页面算的是**浏览器 AEC 之后**的电平，服务端还会再乘 `MIAI_MIC_GAIN`（默认 1×，为 1 时两者一致）；另外它量的是默认 `echoCancellation: true` 的状态，没有做「关掉 AEC 再测一遍」的对照。

## 链接

- 主页与文档：<https://github.com/slchy/dsh-pet-wearable>
- 语音栈：仓根就是包 `dsh-pet-wearable`
