/**
 * 一条连接的编排入口。
 *
 * 实现在 `src/voice/`。这里只再导出公开符号，外部 import 路径保持不变。
 */
export {
  UPSTREAM_SAMPLE_RATE,
} from './voice/session-options.ts';
export type {
  VoiceServerOptions,
  VoiceService,
  VoiceSessionOptions,
} from './voice/session-options.ts';

export {
  assemblerSilenceFromGate,
  resolveEndpointDetector,
} from './voice/endpoint-wire.ts';
export type { EndpointDetector } from './voice/endpoint-wire.ts';

export {
  announceListenMs,
  shouldWakeOnReady,
} from './voice/mic-phase.ts';
export type { MicPhase } from './voice/mic-phase.ts';

export { mergePowerReading } from './voice/device-io.ts';

export { VoiceConnection } from './voice/connection.ts';

export { runVoiceServer } from './voice/server.ts';
