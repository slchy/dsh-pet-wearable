/**
 * 快车道引擎的**唯一出口**。
 *
 * - `LiveVoiceEngine`：omni 直出音频
 * - `CascadeVoiceEngine`：LLM → TTS
 * - `AgentEngineAdapter`：把现有 `AgentProvider` 的 omni / stream / pump 收成同一条事件流
 *
 * 别处一律从这里 `import` 这三个引擎，不要伸进具体文件。内核只认
 * `engine-contract.ts` 的 `FastVoiceEngine`。`TurnRunner.run()` 只消费
 * `respond()`：生产的 `live` / `cascade` 管道直接注入引擎；只给了
 * `{ agent, tts }` 的旧装配包一层 `AgentEngineAdapter`。
 * 流式队列、中止门、念出去的全文在 `stream-utils.ts`，三条引擎共用一份。
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
