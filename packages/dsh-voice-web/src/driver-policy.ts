/**
 * 宿主相位、语音后端视图、语音栈释放、Pure Live 改写和档案目录。
 *
 * 不读宿主服务，也不启动进程。判据只留这一份，调用方照着执行。
 */
import { join } from 'node:path'

/**
 * `auto` 发现宿主的互斥相位。只有 `discovering` 能进 `host` 或 `standalone`；
 * 卸载从任意相位进 `stopped`。晚到的 `webServer` 不能把已经退回独立桥的进程再挂一次。
 */
export type HostPhase = 'discovering' | 'host' | 'standalone' | 'stopped'

export function nextHostPhase(
  phase: HostPhase,
  event: 'host' | 'standalone' | 'stopped',
): HostPhase {
  if (event === 'stopped') return 'stopped'
  if (phase !== 'discovering') return phase
  return event
}

/**
 * 语音后端只有这一份状态。面板上的 `voiceReady` / `voiceError` / `pipelineMode`
 * 都从这里派生，避免端口、错误、管道三字段各写各的，停机后还留着 `live`。
 */
export type VoiceBackendState =
  | { readonly status: 'starting' }
  | { readonly status: 'ready'; readonly port: number; readonly mode: 'live' | 'cascade' | 'direct' }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'stopped' }

export interface HostVoiceBackendView {
  readonly voiceReady: boolean
  readonly voiceError: string | null
  readonly pipelineMode: string
  readonly port: number | null
}

export function getVoicePort(backend: VoiceBackendState): number | null {
  return backend.status === 'ready' ? backend.port : null
}

export function resolveHostVoiceBackendView(backend: VoiceBackendState): HostVoiceBackendView {
  const port = getVoicePort(backend)
  if (backend.status === 'ready') {
    return { voiceReady: true, voiceError: null, pipelineMode: backend.mode, port }
  }
  if (backend.status === 'failed') {
    return { voiceReady: false, voiceError: backend.reason, pipelineMode: 'unavailable', port }
  }
  if (backend.status === 'starting') {
    return { voiceReady: false, voiceError: '语音后端正在启动…', pipelineMode: 'starting', port }
  }
  return { voiceReady: false, voiceError: null, pipelineMode: 'stopped', port }
}

/**
 * 宿主语音栈只启动一次。`booting` 期间若已 `stopped`，boot 返回的那份 `release`
 * 必须立刻执行，不能揣在已经卸载的相位上。
 */
export type StackPhase =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'booting'; readonly source: 'controller' | 'timeout' }
  | { readonly kind: 'up'; readonly release: () => Promise<void> }
  | { readonly kind: 'stopped' }

export type StackEvent =
  | { readonly type: 'boot'; readonly source: 'controller' | 'timeout' }
  | { readonly type: 'booted'; readonly release: () => Promise<void> }
  | { readonly type: 'stop' }

export interface StackTransition {
  readonly phase: StackPhase
  /** 非空：调用方现在就要执行，相位里不再留第二份。 */
  readonly releaseNow: (() => Promise<void>) | null
}

export function reduceStackPhase(phase: StackPhase, event: StackEvent): StackTransition {
  if (event.type === 'stop') {
    if (phase.kind === 'up') {
      return { phase: { kind: 'stopped' }, releaseNow: phase.release }
    }
    return { phase: { kind: 'stopped' }, releaseNow: null }
  }
  if (event.type === 'boot') {
    if (phase.kind !== 'waiting') return { phase, releaseNow: null }
    return { phase: { kind: 'booting', source: event.source }, releaseNow: null }
  }
  if (phase.kind === 'booting') {
    return { phase: { kind: 'up', release: event.release }, releaseNow: null }
  }
  return { phase, releaseNow: event.release }
}

/** `dsh` 与 `dsh-subprocess` 才走主管道；`echo` / `none` 没有快车道，也不能改成 silent TTS。 */
export function isDshBackedAgent(agent: string): boolean {
  return agent === 'dsh' || agent === 'dsh-subprocess'
}

/**
 * Pure Live 把外部 TTS 换成 24 kHz 静音占位，只留 Omni 一副嗓子。
 * 服务端 VAD（`QWEN_ASR_TURN_DETECTION=vad`）时客户端 `commitMs` 为 0，
 * 再改 silent 就整路没声音。未设置按 manual。
 */
export function shouldUsePureLiveAudio(input: {
  readonly dshBacked: boolean
  readonly wantsLive: boolean
  readonly hasOmniKey: boolean
  readonly turnDetection: string | undefined
}): boolean {
  if (!input.dshBacked || !input.wantsLive || !input.hasOmniKey) return false
  const turn = (input.turnDetection ?? 'manual').trim().toLowerCase()
  return turn !== 'vad'
}

/**
 * 显式 `VOICE_PIPELINE=live` 又开了服务端 VAD：不能静默改成哑巴。
 * 返回的句子用于启动日志；调用方应拒绝把这条栈拉起来。
 */
export function pureLiveVadConflict(input: {
  readonly dshBacked: boolean
  readonly voicePipeline: string | undefined
  readonly turnDetection: string | undefined
}): string | null {
  if (!input.dshBacked) return null
  if ((input.voicePipeline ?? '').trim().toLowerCase() !== 'live') return null
  if ((input.turnDetection ?? 'manual').trim().toLowerCase() !== 'vad') return null
  return '拒绝 VOICE_PIPELINE=live：QWEN_ASR_TURN_DETECTION=vad 会关掉客户端封段（commitMs=0）。不会把 TTS 改成 silent，请改回 manual，否则 Pure Live 没有出声。'
}

/**
 * 未设置 `MIAI_ARCHIVE_DIR` 时落到 `~/.voice-agent/archives`。
 * 显式空字符串仍是关闭：用 `??`，不用 `||`。
 */
export function resolveArchiveDir(configured: string | undefined, homeDir: string): string {
  return configured ?? join(homeDir, '.voice-agent', 'archives')
}

export function formatArchiveBanner(archiveDir: string): string {
  if (archiveDir === '') return '档案 关闭'
  return `档案 ${archiveDir}`
}

/**
 * Pure Live 默认关语义判停：没写 `SEMANTIC_END_TAG` 时只有显式 `1` 才开。
 * Cascade 与直连非 dsh（`pipelineMode === null`）沿用旧默认，只有 `0` 才关。
 * 没有 key 一律关。
 */
export function shouldEnableSemanticEndpoint(input: {
  readonly pipelineMode: 'live' | 'cascade' | null
  readonly envFlag: string | undefined
  readonly hasApiKey: boolean
}): boolean {
  if (!input.hasApiKey) return false
  const flag = input.envFlag?.trim()
  if (input.pipelineMode === 'live') {
    return flag === '1'
  }
  return flag !== '0'
}

export interface VoiceWebConfig {
  /**
   * `auto`：宿主已有或启动过程中出现 `webServer` 就挂进去，否则独立端口。
   * `host`：只挂 `ctx.webServer`（`/dsh-voice/*` 与 `/dsh-voice/ws`），不另开端口。
   * `standalone`：原来的 `startWebBridge`，监听 `host:port`。
   */
  mode: 'auto' | 'host' | 'standalone'
  /**
   * 非空时作为 `InProcessDshAgent` 的固定 sessionId，盖过
   * `~/.dsh/.dsh-voice-pet.json` 里上次选中的那条。
   */
  sessionId: string
  /** 浏览器连的端口。只在 standalone（以及 auto 退回独立桥）时使用 */
  port: number
  /** 浏览器连的地址。非本机地址要求 `tls` 与 `origins` 同时配齐。只约束独立桥 */
  host: string
  /** 允许的页面来源。留空 = 只放同源（非浏览器客户端不带 Origin，仍放行） */
  origins: string[]
  /** 是否在同一个端口把页面发出去。关掉就只提供 WS。只约束独立桥 */
  servePage: boolean
  tls: {
    /** TLS 私钥路径。与 `certPath` 要么都给，要么都不给 */
    keyPath: string
    /** TLS 证书路径 */
    certPath: string
  }
  /** 上行识别：`aliyun` / `qwen-realtime` / `canned` / `<模块路径>` */
  stt: string
  /** 下行合成：`cosyvoice` / `omni` / `mimo` / `silent` / `<模块路径>` */
  tts: string
  /**
   * 接话的 agent：`dsh` | `dsh-subprocess` | `echo` | `none`。
   *
   * `dsh` 且宿主有 `sessionController` 时用进程内 `InProcessDshAgent`；
   * 没有控制器时退回 `buildAgent('dsh')`。`dsh-subprocess` 始终走子进程。
   */
  agent: string
  /** dsh 的工作目录。`agent: 'dsh'` 时才有意义；留空用当前目录 */
  workDir: string
  /** v1 手机的型号提示（见 `src/voice/devices/`）。浏览器自报 v2 能力，用不到它 */
  device: string
}
