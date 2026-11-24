/**
 * 快车道引擎的**唯一出口**。
 *
 * - `LiveVoiceEngine`：omni 直出音频
 * - `CascadeVoiceEngine`：LLM → TTS
 * - `AgentEngineAdapter`：把现有 `AgentProvider` 的 omni / stream / pump 收成同一条事件流
 *
 * 别处一律从这里 `import`，不要伸进具体文件。内核只认 `engine-contract.ts` 的
 * `FastVoiceEngine`。`TurnRunner` 仍按三分支直接调 `AgentProvider`，换泵是下一阶段；
 * 适配器先把那三条分支的行为收齐，避免一切过去就静默丢掉流式回落和转交垫话。
 */
export { LiveVoiceEngine, type LiveAudioLane } from './live-voice-engine.ts';
export {
  CascadeVoiceEngine,
  type CascadeAnswer,
  type CascadeEnginePorts,
} from './cascade-voice-engine.ts';
export {
  AgentEngineAdapter,
  type AgentEngineAdapterOptions,
} from './agent-engine-adapter.ts';
