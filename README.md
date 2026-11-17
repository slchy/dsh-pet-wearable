# dsh-pet-wearable

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-500%2B%20passing-success.svg)](#开发与测试)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**面向智能穿戴设备（眼镜 / 耳机 / 手机）的云端全双工语音 Agent，基于 `dsh` (DeepSeek Harness)。**

穿戴端仅负责低功耗的音频采集、播放、拍照与传感器状态上报，ASR（语音识别）、语义判停、大模型推理与 TTS（语音合成）全部在云端闭环完成。具备极致低延迟的双轨交互、全双工随时打断、有节制的主动开口感知，以及基于能力协商的硬件无关设计。

---

## 💡 核心特性

- ⚡ **快慢双轨投机推理（Fast Lane + dsh）**
  - **快车道直答**：日常闲聊与短句通过快模型直接响应，端到端首字延迟 ~1.2s（模型 TTFT ~260ms）。
  - **深思与多步工具**：任务、事实查询、图文问答由 `dsh` 执行多步推理与 Subagent 调度。
  - **投机并发与委派回执**：双轨并行起跑，若快车道超时或判定需转交，则先下发自然回执（如「我看看。」）填补等待空白，答案就绪后即刻平滑顶掉回执。
- 🎙️ **真正的全双工与自然打断（Full-Duplex & Barge-In）**
  - 采用上行能量门（-40 dBFS）+ 语义判停（Smart Turn），无需唤醒词即可自适应停顿切句。
  - 用户开口即打断：流式 ASR 一旦捕捉到新发言（语气词除外），立即下发 `audio.stop` 终止下行音频，并取消正在执行的上游推理与排队轮次。
- 🐾 **伴生感与适度主动开口（"Pet" 理念）**
  - 摆脱传统语音工具「叫了才应」的被动模式，提供具备低存在感的数字伴生形态。
  - 基于佩戴状态、电量、深夜时段、安静时长及发言间隔构建多维时机状态机，在适当时机受控地主动搭话；低电量或深夜时段自动抑制。
- 🔌 **硬件解耦与能力协商（Hardware Agnostic）**
  - 定义标准上行事件与下行控制原语，在 `Hello` 握手阶段动态协商设备能力（如免手拍、能量上报、佩戴检测等）。
  - 能力缺失时自动平滑降级，接入新硬件（如[雷鸟 X3 Pro](./docs/devices/RAYNEO-X3-PRO.md)等智能眼镜）无需改动核心代码。
- 🧪 **零密钥本地闭环与可测性**
  - 内置 `canned` 识别、`silent` 合成与 `echo` Agent，无需真实硬件或 API Key 即可本地跑通全链路。
  - 提供纯虚拟时间模拟器（`npm run sim`），支持状态空间探索与因果回溯，全仓 500+ 测试用例保障时序稳定性。

---

## 🏛️ 系统架构

```
端侧（智能眼镜 / 耳机 / 手机）              云端（本仓 src/）
  AudioRecord / AudioTrack  ────────►  TLS 连接（帧 · 鉴权 · 心跳）
  Camera / 佩戴 / 电量 / 触摸  ─────►          │
                                               ▼
                               能量门 → ASR → 语义判停（UtteranceAssembler）
                                               │ 整句 / 定稿
                                               ▼
                               DialogFsm（话筒票据 · 轮次仲裁）
                                               │
                                 ┌─────────────┴─────────────┐
                                 ▼                           ▼
                         快车道 FrontedAgent          dsh（工具 / 后台 Job / 子代理）
                           短句闲聊极速响应              复杂推理、事实检索、多模态
                                 └─────────────┬─────────────┘
                                               ▼
                                    TTS（CosyVoice）→ PCM 流式下发
```

### 核心设计原则

1. **设备无关**：`src/devices/` 仅定义 6 个标准下行操作、6 个上行事件及能力声明字典，所有型号特性均由握手协议协商。
2. **组件可插拔**：STT、TTS 与 Agent 均遵循工厂契约（[src/providers.ts](./src/providers.ts)）注入，无密钥时平滑降级至本地 Mock 实现。
3. **严格的抢占式话筒仲裁（Floor Arbiter）**：
   话筒状态由 `AppSession.floor` 统一管理，遵循明确的抢占规则：
   - `user`：拥有最高优先级，随时可抢占任何播报（打断）。
   - `reply`：正常对话回复，可被 `user` 打断。
   - `announce` / `pet`：后台任务播报与主动开口，不抢占正题，正题结束且环境安静后方可开口。
   - `reflex`：最低优先级反馈，可被其他角色抢占。

---

## 🚀 快速开始

### 前提条件

- **Node.js** >= 22.18.0
- （可选）接入真实硬件时需安装 `ffmpeg`（用于 mSBC 解码）

### 1. 零密钥本地跑通（5 秒闭环验证）

使用内置的离线 Mock 组件，无需连接真机或配置任何 API 密钥即可启动完整服务：

```bash
# 安装依赖
npm install

# 启动服务（监听 8766 端口，全 Mock 链路）
node src/main.ts --listen 8766 --stt canned --tts silent --agent echo
```

在另一终端运行测试客户端模拟穿戴设备推流：

```bash
node tools/fake-phone.ts --port 8766 --sbc tmp/voice.sbc
```

### 2. 虚拟时间逻辑仿真（主动开口探索）

无需网络与外部依赖，通过纯虚拟时间验证主动开口时机状态机与因果不变式：

```bash
npm run sim                          # 运行预设声明式场景
npm run sim -- --explore --runs 500  # 随机状态空间探索（验证断言）
npm run sim -- --trace out/          # 导出完整 JSONL 格式时序轨迹
```

### 3. 连接真实硬件与生产模型

1. 配置环境变量（复制并编辑配置）：
   ```bash
   cp .env.example .env
   ```
2. 安装 `dsh` 人设 Profile 补丁（若使用 `dsh`）：
   ```bash
   npm run install-profile
   ```
3. 启动全功能服务：
   ```bash
   node src/main.ts --listen 8766
   ```

---

## 📊 性能表现与端到端延迟

### 延迟衡量口径

> **[!IMPORTANT]**
> 本项目提及的 `p50` / `p90` **不加限定时一律指「闭嘴 → 出声」**（端到端完整链路）：
> 即 **用户说完最后一个字（能量门关闭）→ 穿戴端听到首个字声音**。
> 计算公式：`firstWordMs` = ① ASR 判句与识别 + ② 语义判停收敛 + ③ 模型 TTFT + ④ TTS 首包解码。

### 基准实测数据（真机与向量回放）

| 链路分支 | 闭嘴→出声 (p50) | 模型首字 (TTFT) | 场景说明 |
|:---|:---:|:---:|:---|
| **快车道（短句闲聊直答）** | **~1.2s – 1.4s** | ~260 ms | 闲聊场景高频命中，端到端极速出声 |
| **投机委派链路（含回执）** | **~1.9s** | - | 快慢双轨投机，未决时回执填空并无缝接续 |
| **`dsh` 复杂推理 / 工具调用** | **~2.8s** | ~600 ms+ | 涉及多步思考、网络检索或 Subagent 调度 |

### 核心延迟优化技术

- **判停前起跑（Prefetch）**：ASR 识别定稿瞬间即预先发起推理请求，不再等待判停静默期结束，开轮至模型首字缩减 ~220ms。
- **中间结果投机（Partial Speculation）**：能量门检测到静音时刻立即拿最新 partial 发起请求，覆盖率达标时直接认领。
- **TTS 首包静音裁剪**：对合成音频首包执行 5ms 窗口能量裁切，下行开头无效静音从 146ms 降至 11ms。
- **判停窗口按句裁 + 尾巴裁静音**：判停只喂**这一句**（不是连续 8 秒滚动），零补在开头、尾部静音只留 100ms —— 与训练时的切法一致。同一句的 p 从 0.45 升到 0.93，`出句→开轮` 从 1.9s 降到 2ms（同向量回放）。见 [docs/TOOLS.md](./docs/TOOLS.md) §5。
- **判停预算优化**：压缩静候窗口（默认 0ms），对疑似未完成语义设置单独等待预算（`SMART_TURN_MAX_UNSURE`），兼顾防抢话与切句灵敏度。

*详细压测方法、复现向量与工具见 [bench/replay/README.md](./bench/replay/README.md) 与 [docs/TOOLS.md](./docs/TOOLS.md)。*

---

## ⚙️ 配置说明

系统支持两种部署形态：**独立进程模式**与 **`dsh` (Cordis) 插件模式**。

### 1. 独立进程模式（`src/main.ts`）

通过命令行参数或环境变量进行配置：

| 配置分类 | 环境变量 / 参数 | 默认值 | 说明 |
|:---|:---|:---:|:---|
| **基础服务** | `--listen` / `PORT` | `8766` | 监听端口 |
| | `MIAI_TOKENS` | - | 设备鉴权 Token 列表（逗号分隔） |
| | `MIAI_TLS_KEY` / `_CERT` | - | TLS 证书与私钥路径（公网接入必选） |
| **快车道** | `FAST_LANE_MODEL` | - | 快车道使用的轻量模型名称 |
| | `FAST_LANE_TIMEOUT_MS` | `1200` | 快车道首字超时阈值（超时自动转交 dsh） |
| | `FAST_LANE_PREFETCH` | `1` | 是否开启判停前预跑 |
| | `FAST_LANE_SPECULATE` | `1` | 是否开启双轨投机并发 |
| **语义判停** | `SMART_TURN_THRESHOLD` | `0.5` | 语义说完概率阈值（低于此值判定未说完） |
| | `SMART_TURN_THRESHOLD_CJK` | `0.35` | 文本含汉字时用的阈值（中文漏报率高于误报率，见 [docs/TOOLS.md](./docs/TOOLS.md) §5） |
| | `SMART_TURN_QUIET_MS` | `0` | 定稿后额外静候时长（ms） |
| | `SMART_TURN_PARTIAL_GRACE_MS`| `150` | 音频停止但 ASR 仍出字时的防抢话等待 |
| | `SMART_TURN_MAX_UNSURE` | `2` | 判停未决时的最大延拍次数 |
| | `SMART_TURN_TRIM_MS` | `100` | 判停快照尾部最多保留多少静音（ms），其余裁掉 |
| **主动开口** | `PET_PROACTIVE` | `0` | 是否开启主动开口（`1` 开启） |
| | `VOICE_HOLD_MS` | `2000` | 能量门判定静音至关门的维持时间 |

### 2. `dsh` 插件模式（`driver.ts`）

作为 Cordis 插件加载时的配置 Schema：

| 配置项 | 默认值 | 说明 |
|:---|:---:|:---|
| `port` | `8766` | 穿戴设备接入监听端口 |
| `host` | `127.0.0.1` | 监听地址（监听非本机必须同时启用 TLS 与鉴权） |
| `tls.keyPath` / `certPath` | `''` | TLS 证书路径 |
| `auth.tokenFile` | `''` | 设备鉴权 Token 文件路径（通过 `npm run pair -- new` 生成） |
| `turnThreshold` | `0.5` | 语义判停置信度阈值 |
| `proactive.*` | 详见代码 | 主动开口参数（闲置阈值、低电量保护、深夜静默时段等） |

---

## 🛠️ 运维与诊断工具

项目内置了完备的可复算排查与状态审计工具矩阵：

```bash
# 1. 运行单元测试
npm test

# 2. 静态类型检查
npm run typecheck

# 3. 会话归档全量诊断（事实源清单 + 分段耗时 + 审计）
node --experimental-strip-types scripts/observe.ts <档案目录>

# 4. 状态机流转与时序合规审计（检查是否有违规跳状态或漏发 audio.stop）
node --experimental-strip-types scripts/fsm-trace-check.ts <档案目录>

# 5. 生成设备配对 Token
npm run pair -- new
```

> **[!TIP]**
> 全量脚本路由表、口径归属与字段详细定义，请参考 [docs/TOOLS.md](./docs/TOOLS.md)。

---

## 📚 详细文档导航

| 领域 | 核心文档 | 内容概览 |
|:---|:---|:---|
| **状态机与流转** | [state-machines.md](./docs/state-machines.md) | 六大核心状态机（DialogFsm、FloorArbiter 等）时序与真相表 |
| **工具与度量** | [TOOLS.md](./docs/TOOLS.md) | 观测工具矩阵、延迟口径唯一定义与排障路由表 |
| **云端架构** | [CLOUD-ARCHITECTURE.md](./docs/CLOUD-ARCHITECTURE.md) | 云端核心模块分层、并发模型与接口契约 |
| **硬件协议** | [device-protocol.md](./docs/device-protocol.md) | 穿戴端线协议规范（帧结构、控制指令、上行状态帧） |
| **运维实践** | [OPERATIONS.md](./docs/OPERATIONS.md) | 生产部署指南、TLS 配置与证书轮换 |
| | [OPS-RECORD.md](./docs/OPS-RECORD.md) | 运维踩坑记录、双仓事实与排障手记 |
| **架构决策 (ADR)** | [ADR-0001: App Layer & Pet](./docs/adr/0001-app-layer-and-pet.md) | 应用层架构、话筒仲裁与主动开口机制演进 |
| | [ADR-0002: Simulator](./docs/adr/0002-virtual-time-simulator.md) | 虚拟时间模拟器设计与因果测试理念 |
| **设备适配** | [RAYNEO-X3-PRO.md](./docs/devices/RAYNEO-X3-PRO.md) | 雷鸟 X3 Pro 智能眼镜真机接入实践参考 |

---

## 🚫 明确边界（Out of Scope）

为了保持项目的专注度与高性能，以下内容明确不属于本项目的开发范畴：

1. **不做视觉/动画形象**：不开发桌面像素风组件、3D 形象或虚拟主播动画；专注底层语音、交互与意图响应。
2. **不支持单会话多设备并发**：严格遵循「一副穿戴设备绑定一个独立会话」的模型。
3. **不构建主观拟人评分体系**：拟人感以真实用户盲测体验为准，拒绝脱离场景的形式化指标。

---

## 📄 开源协议

本项目采用 [MIT License](./LICENSE) 开源。
