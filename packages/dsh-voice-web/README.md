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

```bash
npm run typecheck          # 含同步语音栈
npm run demo:build         # esbuild 打包 demo/main.ts
```

然后把 `demo/index.html` 放到任意静态服务器上打开（原生 ESM 不认 `.ts`，必须走打包产物）。

## 链接

- 主页与文档：<https://github.com/slchy/dsh-pet-wearable>
- 语音栈：仓根就是包 `dsh-pet-wearable`
