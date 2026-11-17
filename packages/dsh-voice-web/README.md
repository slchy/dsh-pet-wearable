# dsh-voice-web

`dsh-pet-wearable` 的 web 兼容层：WebSocket 桥 + 浏览器侧采集与播放，语音栈复用 `dsh-pet-wearable`。

## 状态

**包名已占（registry 上最新是 `0.0.0-stage` 空占位），本仓库的 `0.0.1` 尚未发布。**

`apply()` 里还没有接线，装上去只会打两行日志。WS 桥和浏览器端代码接进来之前不要启用。等这里真有内容时发布 `0.0.1`，`latest` 会从 `0.0.0-stage` 挪过来。

## 为什么不用 WebRTC

端侧不跑 ASR/TTS/推理，上行只是一段 PCM16，下行是已经合成好的音频块 —— 没有需要媒体栈去协商的东西。走 WS 换来的好处是实现短、日志可读（一帧就是一个 `[type][len][payload]`，可以直接打进时间线），代价是丢掉了浏览器原生的 AEC 与抖动缓冲，回声消除要自己扛。

## 与真机那条链路的关系

| | 真机（`dsh-pet-wearable`） | 浏览器（本包） |
|---|---|---|
| 传输 | TCP + 自定义分帧 | WS 消息（一条消息一帧，或按帧切分） |
| 上行编码 | mSBC（1 字节头 + 60 字节块） | PCM16 裸流，采样率靠握手声明 |
| 下行 | 同协议帧 | 同协议帧，交给 AudioContext 播 |

协议层共用一份，`dsh-pet-wearable` 的 `src/frame.ts` 只依赖 `Writable`，本身就跟运行时无关。

## 链接

- 主页与文档：<https://github.com/slchy/dsh-pet-wearable>
- 语音栈：`dsh-pet-wearable`
