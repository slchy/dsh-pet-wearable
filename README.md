# dsh-pet-wearable

**住在智能眼镜里的宠物插件** —— 它会自己开口，不是等你叫。

> 完整交接见 [HANDOFF.md](./HANDOFF.md)。**动手前先读那份。**
> 旧版云端 harness 的说明留在 [README.cloud.md](./README.cloud.md)（线协议、provider 契约、
> 调试口那些细节还在用）。

## 一分钟说明

生态里已经有成熟的「双工语音插件」（`dsh-voice` / `dsh-voice-mode` / `dsh-voice-ai-girlfriend`，
都能流式朗读、都能打断）。这个项目的差别只有一条：

| | 那些插件 | 这个 |
|---|---|---|
| 形态 | 浏览器 / 桌面 | **戴在脸上** |
| 谁开口 | 你（点麦 / 唤醒词） | **它**（时机状态机） |
| 允许无用 | 不必 | **必须** |

**技术上不新鲜，需求也未验证。** 它存在的意义是回答一个问题：**主动开口是价值还是噪音。**
如果实测是噪音，这个项目就该死 —— 而且死得对。

## 当前状态：开发早期

- 语音栈（STT/TTS/判停/打断/档案）已在真机上跑通
- 手机**能主动拉起**眼镜的语音会话（0.62 s，已验证）
- 宠物时机状态机已写（`src/pet/pet-timing.ts`），**尚未接线**
- **`src/driver.ts` 只有骨架**：`name` / `inject` / `Config` / `apply` 就位，
  `Config` 覆盖端口、音色、判停阈值和时机参数；TCP 监听和 agent 桥还没接

## 装上它

```bash
npm install dsh-pet-wearable
```

`0.0.x` 期间 API 不稳定，装了就只是个能加载的空壳 —— 等 driver 接线完成再用。

## 跑起来（仓库内开发）

```bash
npm install

# 什么都不接，纯离线自测（不需要密钥）
node src/main.ts --listen 8766 --stt canned --tts silent --agent echo

# 生产
export ALIYUN_APPKEY=... MIMO_API_KEY=...
node src/main.ts --listen 8766

npm test
```

## 目录

```
src/
  transport.ts / frame.ts                  线协议（TCP 5 字节帧）
  uplink-pipeline.ts                       mSBC → ffmpeg → 能量门
  energy-gate.ts                           没声音就不建 STT 连接
  utterance-assembler.ts / smart-turn.ts   判停
  aliyun-asr.ts / mimo.ts                  STT / TTS
  session-core.ts / dialog-fsm.ts          对话决策（纯逻辑）
  agent.ts                                 人设 + 情绪标签 + cleanForSpeech
  pet/                                     宠物核心（时机 / 宿主端口）
  driver.ts                                dsh 插件入口（骨架：Config 已就位）
smart_turn/                                Python 判停 sidecar
tests/                                     node --test tests/*.test.ts
```

## 明确不做

- **像素 / 动画 / 形象** —— 这条路已有 7 200 星的项目在做
- **多设备同时在线** —— 一副眼镜一个会话
- **为"感觉"造证据系统** —— 活人感靠盲测，不靠指标
