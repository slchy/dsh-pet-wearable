# dsh-voice-web

<div align="center">

[![npm version](https://img.shields.io/npm/v/dsh-voice-web.svg)](https://www.npmjs.com/package/dsh-voice-web)
[![CI](https://github.com/slchy/dsh-pet-wearable/actions/workflows/ci.yml/badge.svg)](https://github.com/slchy/dsh-pet-wearable/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/slchy/dsh-pet-wearable/blob/main/LICENSE)

**面向 `dsh web` / Desktop 的全双工语音桌宠插件（[`dsh-pet-wearable`](https://github.com/slchy/dsh-pet-wearable) 官方 Web 兼容包）**

[快速安装](#快速安装) • [核心特性](#核心特性) • [配置与语音面板](#配置与语音面板) • [使用硬约束](#使用硬约束) • [与主项目的关系](#与主项目的关系) • [本地开发与许可](#本地开发与许可)

</div>

---

`dsh-voice-web` 把 [`dsh-pet-wearable`](https://github.com/slchy/dsh-pet-wearable) 的云端全双工语音栈直接封装为即插即用的 `dsh` 插件：包含 WebSocket ↔ 本机语音栈桥接、浏览器侧 16 kHz / 24 kHz 音频采集与流式播放，以及挂在 `dsh web` / Desktop 页面上的 **Gemini 娘** 浮动语音桌宠挂件。

## 快速安装

环境要求：**Node.js >= 22.18.0**（与 `dsh` 宿主同进程运行）。

### 1. 作为 `dsh` 插件安装（推荐）

```bash
dsh plugin --profile web add dsh-voice-web
```

或者作为普通 npm 包安装到自定义宿主项目：

```bash
npm install dsh-voice-web
```

### 2. 配置密钥并启动

默认模式只需要一个 DashScope API Key（可写在 `.env` 中，也可以启动后直接在桌宠设置面板填写并保存）：

```bash
# .env（默认模式最小配置）
DASHSCOPE_API_KEY=your_api_key_here
```

启动 `dsh web` 或 Desktop 后，插件在默认的 `mode: "auto"` 下会自动挂载到宿主的 `/dsh-voice/*` 与 `/dsh-voice/ws`（无需另开端口）；点击右下角桌宠或展开面板即可开麦对话。

---

## 核心特性

- **与主项目同源的双管道语音栈**：构建时同步主仓 `src/` 语音栈并预编译进 `lib/`，直接复用 `assemblePipelinePlan()` / `assembleStreamingAgent()`；**Pure Live**（Omni 单前台 + 进程内无头 `dsh` 异步后台）与 **Pure Cascade**（ASR → 判停 → 级联模型 → 流式 TTS）与独立服务端逐字一致。
- **前端三档语音引擎面板**：内置「默认 / Live / 级联」三档模式切换——默认仅需一个 `DASHSCOPE_API_KEY`；切到 `Live` 或 `级联` 后可自由填写任意 OpenAI 兼容或 Realtime 的 Base URL 与 API Key、实时拉取 `/models` 可用列表，原子写回 `.env` 且前端仅脱敏回显。
- **全双工即时打断与进程内 ONNX**：支持 Silero v5 神经 VAD 与 Smart Turn v3.2 声学判停（进程内 ONNX，缺模型自动退回能量门 / 固定窗口，不阻断启动）；用户开口后服务端下发 `Call {"op":"audio.stop"}`，浏览器立即停播清空队列。
- **Gemini 娘浮动桌宠与程序合成动态音效**：支持 10 套情绪立绘、说话底轴 RMS 摇摆、边缘吸附与不透明像素凸包命中；内置纯 Web Audio 三层程序合成动态音效（Starlight Pluck + Twin Spark，覆盖开麦 / 关麦 / 打断 / 深思回执 / 主动搭话 / 低电困倦 6 种情境，带静音与复古星芒开关，零 WAV 素材依赖）。
- **零外部代理的同源宿主挂载**：同时覆盖网页 `tapIndex` 注入与 Desktop 壳 `webserver/index-inject` 通道；有 `sessionController` 时默认走进程内 `InProcessDshAgent`，无缝绑定当前会话并同步会话标题。

---

## 配置与语音面板

### 插件配置项（`cordis.patch.yml`）

| 配置项 | 默认值 | 说明 |
| --- | :---: | --- |
| `mode` | `auto` | `auto`（优先挂入宿主 `webServer`，超时回退独立桥）/ `host`（等待宿主）/ `standalone`（独立 WS 桥） |
| `sessionId` | `""` | 固定绑定的 dsh 会话 ID；留空时沿用 `~/.dsh/.dsh-voice-pet.json` 中上次选中的会话 |
| `agent` | `dsh` | `dsh`（宿主内优先 `InProcessDshAgent`，否则回退子进程）/ `dsh-subprocess` / `echo` |
| `port` / `host` | `8767` / `127.0.0.1` | 仅 `standalone` 独立桥监听使用 |
| `stt` / `tts` | 随环境 | 可覆盖为 `canned` / `silent` 做无密钥本地联调 |

### 常用环境变量

| 环境变量 | 默认值 | 说明 |
| --- | :---: | --- |
| `DASHSCOPE_API_KEY` | - | 默认模式唯一必填项；可在桌宠前端面板填写并自动写入 `.env` |
| `VOICE_PIPELINE` | 推断 | `live` 或 `cascade`（也可通过前端面板三档模式保存生效） |
| `VOICE_VAD` / `VOICE_VAD_MODEL` | `auto` | 神经 VAD 开关与 `silero_vad.onnx` 路径；缺模型自动降级能量门 |
| `TURN_JUDGE` / `TURN_JUDGE_MODEL` | `auto` | Smart Turn v3.2 进程内 ONNX 声学判停开关与模型路径 |
| `MIAI_ARCHIVE_DIR` | `~/.voice-agent/archives` | 会话音频与事件归档目录；显式设为空串关闭 |
| `DSHV_TRUSTED_HOSTS` | - | 宿主连接栅栏不可用时，逗号分隔的额外放行 Host |
| `DSHV_ADMIN_HOSTS` | - | 非回环写请求（`/dsh-voice/config`、切换会话等）额外放行的 Host |

> **子进程模式提示**：仅当显式使用 `agent: dsh-subprocess` 时，需要在启动 shell 中导出 `DSH_BIN` 与 `DSH_PATCH`（`dsh` 禁止把它们写进 `.env`）。宿主内的默认 `InProcessDshAgent` 模式无需此步骤。

---

## 使用硬约束

| 约束 | 说明 |
| --- | --- |
| **要求戴耳机** | 整个语音栈假定端侧无声学回声，打断按绝对能量门 `VOICE_PEAK_DBFS`（默认 `-30 dBFS`，浏览器增益 `1×`）判定；外放会把助手自己的声音当成用户开口导致连续自打断。 |
| **安全上下文** | 浏览器必须通过 `https://` 或 `http://localhost` / `http://127.0.0.1` 访问，否则 `navigator.mediaDevices` 为 `undefined`。 |
| **用户手势** | `AudioContext.resume()` 与 `getUserMedia()` 均在点击事件调用栈内触发，以满足 Safari / 移动端音频策略。 |
| **宿主安全栅栏** | 非本机绑定拒绝无 TLS 暴露；跨域与坏 `Origin` 一律 `403`；非回环写操作默认失败关闭。 |
| **打断语义** | 浏览器客户端遵循 v2 协议，监听 `Call {"op":"audio.stop"}` 清空播放队列（`Control: end_session` 用于礼貌收尾）。 |

---

## 与主项目的关系

本包维护在 monorepo [`slchy/dsh-pet-wearable`](https://github.com/slchy/dsh-pet-wearable) 的 `packages/dsh-voice-web/` 目录下：

| 维度 | 穿戴端独立进程（`dsh-pet-wearable`） | 浏览器桌宠插件（`dsh-voice-web`） |
| --- | --- | --- |
| 传输链路 | 设备 TCP + 自定义帧（mSBC / PCM） | 浏览器同源 WS ↔ 桥 ↔ 本机回环 TCP（PCM16 16 kHz 上行 / 24 kHz 下行） |
| 监听与停机 | 固定 `--listen` 端口；进程退出停机 | 内层端口 `0`（随机口），插件卸载时通过 `onListening().stop()` 完整回收 |
| TLS 终结 | 语音栈自身终结 | 仅在宿主或独立桥外层终结，内层走本机回环明文 TCP |
| 配置错误策略 | 退出进程（`exit 2`） | 抛出异常，绝不拖垮 `dsh` 宿主进程 |

延伸阅读（指向主仓库文档）：

- [主项目 README](https://github.com/slchy/dsh-pet-wearable#readme)
- [云端架构与模块分层（CLOUD-ARCHITECTURE.md）](https://github.com/slchy/dsh-pet-wearable/blob/main/docs/CLOUD-ARCHITECTURE.md)
- [延迟口径与 QoS 原则（QOS.md）](https://github.com/slchy/dsh-pet-wearable/blob/main/docs/QOS.md)
- [Omni 音频车道实测手册（OMNI-LANE.md）](https://github.com/slchy/dsh-pet-wearable/blob/main/docs/OMNI-LANE.md)
- [发版与部署指南（CD.md）](https://github.com/slchy/dsh-pet-wearable/blob/main/docs/CD.md)

---

## 本地开发与许可

### 从主仓源码联调

```bash
# 在主仓根目录先安装，再安装并构建本包
cd packages/dsh-voice-web
npm install
npm run typecheck   # 先执行 sync:voice，再分别检查 Node 与浏览器类型
npm run build       # 编译 lib/、打包 lib/browser.mjs 与 lib/widget.js
npm test            # 运行全部 104 项插件与桌宠单元测试
```

将本地源码直接链接进 `dsh`（路径替换为本机绝对路径）：

```bash
dsh plugin --profile web add link:<abs-path-to-packages/dsh-voice-web>
```

### 零密钥离线联调

新建独立 profile（配置 `stt: canned`、`tts: silent`、`agent: echo`）即可走通完整 `apply()` → `runVoiceServer` → WS 桥 → v2 握手链路，无需任何云端 API Key：

```yaml
- insert:
    - id: voice-web
      name: dsh-voice-web
      config:
        mode: standalone
        port: 8791
        host: 127.0.0.1
        stt: canned
        tts: silent
        agent: echo
```

### 许可边界

- **代码、配置与文档**：基于 [MIT License](https://github.com/slchy/dsh-pet-wearable/blob/main/LICENSE) 开源（随包附带 `LICENSE`）。
- **桌宠立绘素材（`assets/pet/**`）**：不在 MIT 许可范围内，也不授予再许可，仅限随本插件运行时使用。详细来源与使用边界见随包发布的 [`PROVENANCE.md`](https://github.com/slchy/dsh-pet-wearable/blob/main/packages/dsh-voice-web/PROVENANCE.md)。
