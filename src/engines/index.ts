/**
 * 快车道引擎的**唯一出口**：Live（omni 直出音频）与 Cascade（LLM → TTS）。
 *
 * 别处一律从这里 `import`，不要伸进具体文件 —— 换实现、加第三种模式都只改这一行。
 * 内核只认 `engine-contract.ts` 的 `FastVoiceEngine`，这两个类只是它的两份实现。
 *
 * **状态：就绪契约实现**，目前由 `tests/fast-voice-engine.test.ts` 覆盖，
 * **尚未切入 `TurnRunner` 生产热路径**（那里仍按 `omni` / `stream` / `pump` 三分支
 * 调 `AgentProvider`）；阶段边界与理由见 `engine-contract.ts` 顶部的「当前阶段边界」。
 */
export { LiveVoiceEngine, type LiveAudioLane } from './live-voice-engine.ts';
export {
  CascadeVoiceEngine,
  type CascadeAnswer,
  type CascadeEnginePorts,
} from './cascade-voice-engine.ts';
