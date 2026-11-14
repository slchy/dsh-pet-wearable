# dsh-pet-wearable

住在智能眼镜里的 dsh 插件：**它不会被唤醒词叫起来，而是按自己的时机开口。**

|  | 常见的双工语音插件 | 这个 |
|---|---|---|
| 谁决定何时说话 | 用户（点麦 / 唤醒词） | 插件（时机状态机） |
| 允许说"没用"的话 | 否 | 是 |

## 现在能不能用

`0.0.x` 是骨架版本：能被 dsh 正常加载、能读配置，但**还不通设备、不驱动对话**。

| | 状态 |
|---|---|
| dsh 插件入口（`name` / `inject` / `Config` / `apply`） | 可用 |
| 配置项 | 可用，见下 |
| 语音链路（mSBC → STT → 判停 → TTS → 打断） | 代码齐全，目前只通过独立进程形态跑（`src/main.ts`） |
| 设备会话（拉起眼镜语音、拍照、佩戴 / 电量） | 手机端已跑通，插件侧未接线 |
| 主动开口（时机 / 阶段 / 打断 / 结局） | 已按 [ADR-0001](./docs/adr/0001-app-layer-and-pet.md) 实现并接进对话连接，`npm run sim` 可离线跑全套场景 |

## 装进 dsh

```bash
dsh plugin --profile <profile> add dsh-pet-wearable
```

或在 profile 的 `cordis.patch.yml` 里显式插入：

```yaml
- insert:
    - id: pet-wearable
      name: dsh-pet-wearable
      config:
        port: 8766
        voice: Chloe
```

patch 的语义要记住：裸条目是**按 id 覆盖**已有节点，**新增**节点必须写在 `insert:` 下，
否则报 `entry not found`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `8766` | 手机连上来的 TCP 端口 |
| `device` | `''` | v1 手机的型号提示（如 `xiaomi-glasses`）。新协议设备在握手时自报能力，不用填；留空 = v1 基线 |
| `voice` | `Chloe` | TTS 音色 |
| `turnThreshold` | `0.5` | 判停阈值。调高更不容易被判为"说完了" |
| `proactive.greetAfterAwayMs` | `300000` | 离场超过多久，重戴时才打招呼 |
| `proactive.chatterAfterIdleMs` | `1200000` | 安静多久后可以主动搭话 |
| `proactive.minProactiveGapMs` | `600000` | 两次主动开口的最小间隔 |
| `proactive.quietFromHour` | `23` | 深夜起点（本地小时，含） |
| `proactive.quietToHour` | `7` | 深夜终点（本地小时，不含） |
| `proactive.lowBatteryPercent` | `20` | 低于此电量就不主动开口；读不到电量时不受限 |

**改配置现在会重建插件**：dsh 的 loader 对非 `volatile()` 字段走完整的 dispose → `apply`，
监听会关闭、连接会断。把这些参数标成 `volatile()`（热读、不重建）是待办事项。

`proactive` 的默认值一律偏向"宁可少说"。想让它更活泼，调 `chatterAfterIdleMs`，
**不要加新规则** —— 规则越多越难解释它为什么沉默。

## 外部依赖

| 依赖 | 必需 | 用途 |
|---|---|---|
| Node.js ≥ 22.18 | 是 | 原生跑 `.ts`（type stripping）。`dsh` 本身也要求 |
| `ffmpeg` | 是 | mSBC → PCM 解码 |
| 阿里云 NLS | 否 | 实时识别。不给密钥就用 `--stt canned` 跑离线链路 |
| MiMo | 否 | TTS / ASR。不给密钥就用 `--tts silent` |
| `smart_turn/` Python 侧车 | 否 | 判停模型。缺失时退回能量门 + 静音时长 |
| `models/silero_vad.onnx` | 否 | 本地 VAD（惰性加载；文件不在就跳过） |

## 开发

```bash
npm install
npm run typecheck
npm test                            # node --test tests/*.test.ts
npm run sim                         # 宠物主动开口的离线场景（零网络 / 零密钥 / 零 ffmpeg）
npm run sim -- --explore --runs 500 # 随机探索：找不变量违反并收缩成最小复现
npm run sim -- --trace out/         # 把每个场景的时间线写成 JSONL

# 不需要任何密钥：canned 识别 + 静音合成 + echo agent
node src/main.ts --listen 8766 --stt canned --tts silent --agent echo

# 另一个终端：最小客户端，推一段 mSBC
node tools/fake-phone.ts --port 8766 --sbc tmp/voice.sbc
```

手机侧先 `adb reverse tcp:8766 tcp:8766`。

### 三个可替换件

| 开关 | 取值 | 说明 |
|---|---|---|
| `--stt` | `aliyun` `noop` `canned` `<模块路径>` | 上行识别，每次连接开一个会话 |
| `--tts` | `mimo` `silent` `<模块路径>` | 下行合成，采样率由实现自己声明 |
| `--agent` | `dsh` `echo` `none` `<模块路径>` | 裸 `--agent` 等价 `dsh` |

`<模块路径>` 指向一个导出工厂的文件（契约在 `src/providers.ts`）：

```ts
// my-stt.ts
import type { SttProvider } from '../src/providers.ts';
export function stt(): SttProvider {
  return { name: 'my-stt', open: (h) => ({ feed: h.onSentence, hangup() {}, close() {} }) };
}
```

### 设备能力

`src/devices/` 只定义插件两个环（对话环 / 宠物环）要用的原语：6 个下行操作、6 个上行事件、
一份能力声明。设备在 `Hello` 里自报能力，插件不认型号；P2P、相册、快门、手势细节这类
设备侧实现归手机端或你自己的适配器。新增一台设备 = 设备侧自报能力，插件零改动
（雷鸟 X3 Pro 的写法见 [docs/devices/RAYNEO-X3-PRO.md](./docs/devices/RAYNEO-X3-PRO.md)）。

`--device` / `PET_DEVICE` 只是给**不会自报的 v1 手机**补默认能力（`xiaomi-glasses`）；
不给就走 v1 基线。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/adr/0001-app-layer-and-pet.md](./docs/adr/0001-app-layer-and-pet.md) | **应用层与宠物层**：端口、状态机、三张登记表、模拟器、实施顺序 |
| [docs/adr/0002-virtual-time-simulator.md](./docs/adr/0002-virtual-time-simulator.md) | **虚拟时间模拟器**：单一调度器、假件、声明式场景、三层判定、随机探索 |
| [docs/CLOUD-ARCHITECTURE.md](./docs/CLOUD-ARCHITECTURE.md) | 分层、类职责、并发模型、状态机、扩展点 |
| [docs/device-protocol.md](./docs/device-protocol.md) | 线协议：帧格式、控制串、状态帧、拍照时间预算（写手机端的人看） |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | 部署形态、鉴权与 TLS、原始档案、延迟报告、待补播 |
| [docs/ALIYUN-ASR-PROBED.md](./docs/ALIYUN-ASR-PROBED.md) | 阿里云实时识别实测 |
| [docs/MIMO-API-PROBED.md](./docs/MIMO-API-PROBED.md) | MiMo 接口实测 |
| [docs/STT-TTS-REALTIME-QUESTIONS.md](./docs/STT-TTS-REALTIME-QUESTIONS.md) | 实时性问题的排查记录 |

设备侧（手机 App、眼镜 SDK）不在本仓库：本仓库只消费上面的线协议。

## 明确不做

- **像素 / 动画 / 形象** —— 这条路已有成熟项目在做
- **多设备同时在线** —— 一副眼镜一个会话
- **为"感觉"造证据系统** —— 活人感靠盲测，不靠指标

## 许可

MIT
