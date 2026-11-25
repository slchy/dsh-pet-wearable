/**
 * dsh 插件入口（web 兼容层）。
 *
 * 两条对外形态，里层语音栈是同一份：
 *
 * - **host / auto**：挂到宿主 `webServer` 的 `/dsh-voice/*` 与 `/dsh-voice/ws`，
 *   不另开端口。`agent: dsh` 且宿主有 `sessionController` 时走进程内
 *   `InProcessDshAgent`。
 * - **standalone**（以及 auto 等不到 `webServer`）：原来的 `startWebBridge`，
 *   浏览器 ⇄ WS ⇄ 本进程的桥 ⇄ TCP 127.0.0.1 ⇄ 本进程内的语音栈。`demo/` 仍走这条。
 *
 * 语音栈就是包① 那一套（`src/voice/` 是它的副本，由 `scripts/sync-voice.mjs`
 * 生成、不进 git），装配**直接复用包① 导出的那两个函数**
 * （`assemblePipelinePlan` / `assembleStreamingAgent`）—— 与 CLI 是同一份装配代码，
 * 两边不会漂。
 *
 * 与「独立进程」形态不同的三处，都是有意的：
 *
 * - **端口**：内部语音栈绑 `0`，靠 `onListening` 拿真实端口；同一个回调里的
 *   `stop()` 也是唯一的停机入口（多设备模式下没有任何事件会结束 `runVoiceServer`，
 *   没有它，卸载插件时监听与控制口都关不掉）。
 * - **TLS**：只在 `startWebBridge` 终结，证书读本插件自己的 `tls.keyPath/certPath`。
 *   里层是 127.0.0.1 的**明文** TCP —— 桥连内网走 `net.connect`，套上 TLS 连不上。
 *   host 模式不启桥，也不做这道对外绑定检查。
 * - **配置错误抛异常**：`loadTls` / `loadAuthenticator` 在 CLI 里是 `process.exit(2)`，
 *   这里跑在 dsh 进程内，退出会把宿主一起带走。
 */
import type { IncomingMessage } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context, Logger } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { startWebBridge, type WebBridge } from './bridge.ts'
import {
  ASSETS_PREFIX,
  WS_UPGRADE_PATH,
  appendDesktopWidgetInjection,
  mountVoiceHost,
  type HostMountHandle,
  type HostWebServer,
} from './host-mount.ts'
import { HostSecurityGuard, type ConnectionFence } from './host-security.ts'
import { InProcessDshAgent, type HostSessionController } from './in-process-agent.ts'
import {
  assemblePipelinePlan,
  assembleStreamingAgent,
  buildAgent,
  buildStt,
  buildTts,
  createAuditSlot,
  loadAuthenticator,
  loadDotEnv,
  loadStaticAsrCorpus,
  resolveAsrLanguage,
  type AssembledStreamingPipeline,
} from './voice/main.ts'
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './voice/announce-store.ts'
import { checkBindSafety, isLoopbackHost } from './voice/bind-policy.ts'
import { DEFAULT_KEEPALIVE_MS, installHttpAgent } from './voice/http-agent.ts'
import { expiryWarning } from './voice/tls-cert.ts'
import { buildVoiceRuntimeConfig } from './voice/voice-config.ts'
import {
  KEEPALIVE_PROMPT,
  newActivityState,
  startKeepalive,
  systemClock,
} from './voice/keepalive.ts'
import { MemoryFile } from './voice/memory-file.ts'
import { semanticEndpoint } from './voice/semantic-endpoint.ts'
import { TurnJudge } from './voice/turn-judge.ts'
import { envNumber, envString } from './voice/util.ts'
import { runVoiceServer, UPSTREAM_SAMPLE_RATE } from './voice/voice-session.ts'
import type { AgentProvider } from './voice/providers.ts'
import type { DshSession } from './voice/session.ts'

export const name = 'voice-web'

/** auto 模式等多久看 `webServer` 会不会出现。到点没有就退回独立桥。 */
const HOST_DISCOVERY_MS = 1_500
/** host 模式下等 `sessionController` 就绪的兜底上限；超时才退回子进程 dsh。 */
const SESSION_CONTROLLER_WAIT_MS = 5_000

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
 * ALIYUN_* 走环境变量，与 CLI 同一套凭据来源 —— 不在插件配置里重复一遍，
 * 免得同一份密钥有两个地方要改。
 */
function sttCreds(): {
  akId: string
  akSecret: string
  appkey: string
  region: string
  maxSentenceSilenceMs: number
  vocabularyId?: string
} {
  // 热词表 ID 留空就不下发该字段（传不存在的 ID 会被服务端静默忽略，不报错）
  const vocabularyId = process.env['ALIYUN_VOCAB_ID'] ?? ''
  return {
    akId: process.env['ALIYUN_AK_ID'] ?? '',
    akSecret: process.env['ALIYUN_AK_SECRET'] ?? '',
    appkey: process.env['ALIYUN_APPKEY'] ?? '',
    region: process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai',
    maxSentenceSilenceMs: Number(process.env['MIAI_SENTENCE_SILENCE'] ?? 200),
    ...(vocabularyId === '' ? {} : { vocabularyId }),
  }
}

/**
 * 桥的 TLS：读插件配置里的文件，**不看 `MIAI_TLS_KEY`/`MIAI_TLS_CERT`**。
 *
 * 那两个环境变量是「独立进程直接对外监听」用的；插件对外的是桥，证书归插件配置。
 * 里层语音栈永远明文（见文件头）。
 */
function loadBridgeTls(config: VoiceWebConfig): { key: Buffer; cert: Buffer } | undefined {
  if (config.tls.keyPath === '') {
    return undefined
  }
  try {
    const cert = readFileSync(config.tls.certPath)
    for (const line of expiryWarning(cert) ?? []) {
      console.warn(`  ${line}`)
    }
    return {
      key: readFileSync(config.tls.keyPath),
      cert,
    }
  } catch (error) {
    throw new Error(`voice-web: TLS 证书读不到（${(error as Error).message}）`);
  }
}

/**
 * 投机的前置条件：宿主得能取消在途那一轮。
 *
 * 与 CLI 同一条判据 —— 没有 `session/cancel` 时，快车道命中会在 dsh 那边留下一轮
 * 「用户没听过的回答」（白花钱 + 幽灵历史），所以探测失败就退回串行。
 */
async function resolveSpeculate(
  session: DshSession,
  report: (line: string) => void,
): Promise<boolean> {
  if (process.env['FAST_LANE_SPECULATE'] === '0') {
    return false;
  }
  const canCancel = await session.probeCancelSupport(20_000);
  report(canCancel
    ? '快车道    投机=开（宿主支持 session/cancel，命中时可作废在途那一轮）'
    : '快车道    投机=关 → 退回串行（宿主没有 session/cancel，作废不了在途那一轮）');
  return canCancel;
}

/**
 * 独立桥才检查对外绑定。host 模式不听 `config.host`，配错了也不该挡住桌宠挂载。
 * 半套 TLS 在 `apply()` 入口另判，两种模式都算配置错误。
 */
function assertStandaloneBridge(config: VoiceWebConfig): void {
  if (!isLoopbackHost(config.host) && config.origins.length === 0) {
    throw new Error('voice-web: 监听非本机地址时必须配 origins（允许的页面来源），否则任何网页都能连上来')
  }
}

/** 上次在挂件里选中的会话。`config.sessionId` 非空时不用这份。 */
function dshHomeDir(): string {
  return process.env['DSH_HOME'] || join(homedir(), '.dsh')
}

function petSessionFile(): string {
  return join(dshHomeDir(), '.dsh-voice-pet.json')
}

/**
 * 补读 `~/.dsh/.env`（不覆盖已有环境变量）：`dsh web` / Desktop 的 `cwd`
 * 往往不是语音仓目录，把 STT/TTS 凭据放在 `~/.dsh/.env` 即可在任意目录生效。
 */
function loadDshHomeDotEnv(): number {
  const file = join(dshHomeDir(), '.env')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
      count += 1
    }
  }
  return count
}

function loadPersistedSessionId(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(petSessionFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const sessionId = (parsed as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string') return null
    const trimmed = sessionId.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  }
}

function persistSessionId(sessionId: string | null): void {
  try {
    const file = petSessionFile()
    mkdirSync(dirname(file), { recursive: true })
    const body: { sessionId: string | null } = { sessionId }
    writeFileSync(file, JSON.stringify(body), 'utf8')
  } catch {
    // 指针写失败不影响这一轮对话。
  }
}

/**
 * `ctx.on` 的类型只列了 cordis 内置事件。宿主事件走这个结构调用，
 * 这样不必依赖 `@deepseek-ai/dsh-host-webserver` 的类型补丁。
 */
function onHostEvent(
  ctx: Context,
  name: string,
  listener: (...args: unknown[]) => void,
): () => void {
  const host = ctx as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): (() => boolean) | void
  }
  const dispose = host.on(name, listener)
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}

/**
 * 服务可能还没 inject。`ctx.get` 缺服务时返回空；直读属性在代理上会抛
 * 「without inject」，这里接住，调用方把空当成「还没有」。
 */
function readHostService(ctx: Context, name: string): unknown {
  const bag = ctx as unknown as Record<string, unknown>
  try {
    const viaGet = ctx.get?.(name) ?? bag[name]
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    // 直读未注入的服务会抛。下面再试一次只读属性，仍失败就当没有。
  }
  try {
    return bag[name]
  } catch {
    return undefined
  }
}

function isHostWebServer(value: unknown): value is HostWebServer {
  if (typeof value !== 'object' || value === null) return false
  const server = value as {
    register?: unknown
    registerUpgrade?: unknown
    tapIndex?: unknown
  }
  return typeof server.register === 'function'
    && typeof server.registerUpgrade === 'function'
    && typeof server.tapIndex === 'function'
}

function readWebServer(ctx: Context): HostWebServer | null {
  const value = readHostService(ctx, 'webServer')
  return isHostWebServer(value) ? value : null
}

function readSessionController(ctx: Context): HostSessionController | null {
  const value = readHostService(ctx, 'sessionController')
  if (typeof value !== 'object' || value === null) return null
  const controller = value as Partial<HostSessionController>
  if (typeof controller.list !== 'function') return null
  if (typeof controller.create !== 'function') return null
  if (typeof controller.prompt !== 'function') return null
  if (typeof controller.cancel !== 'function') return null
  if (typeof controller.follow !== 'function') return null
  return value as HostSessionController
}

function resolveConnectionFence(ctx: Context): ConnectionFence | null {
  const connection = readHostService(ctx, 'connection')
  if (typeof connection !== 'object' || connection === null) return null
  const requestRejection = (connection as { requestRejection?: unknown }).requestRejection
  if (typeof requestRejection !== 'function') return null
  const call = requestRejection as (this: unknown, req: IncomingMessage) => unknown
  return {
    requestRejection(req) {
      const code = call.call(connection, req)
      if (typeof code === 'number' || typeof code === 'boolean' || code === null || code === undefined) {
        return code
      }
      return 403
    },
  }
}

function parseHostList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
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

export const Config: Schema<VoiceWebConfig> = Schema.object({
  mode: Schema.union(['auto', 'host', 'standalone']).default('auto').description('auto：有 webServer 就挂进宿主，否则独立端口；host：只挂 /dsh-voice；standalone：原来的桥'),
  sessionId: Schema.string().default('').description('固定的 dsh sessionId；非空时覆盖 ~/.dsh/.dsh-voice-pet.json'),
  port: Schema.natural().max(65535).default(8767).description('浏览器连的 WS 端口'),
  host: Schema.string().default('127.0.0.1').description('监听地址；非本机地址要求 TLS 与来源白名单同时配齐'),
  origins: Schema.array(Schema.string()).default([]).description('允许的页面来源，如 https://<域名>；留空只放同源'),
  servePage: Schema.boolean().default(true).description('是否在同一端口把页面发出去（关掉就只提供 WS）'),
  tls: Schema.object({
    keyPath: Schema.string().default('').description('TLS 私钥路径'),
    certPath: Schema.string().default('').description('TLS 证书路径'),
  }),
  stt: Schema.string().default('aliyun').description('上行识别实现：aliyun / qwen-realtime / canned / <模块路径>'),
  tts: Schema.string().default('cosyvoice').description('下行合成实现：cosyvoice / omni / mimo / silent / <模块路径>'),
  agent: Schema.string().default('dsh').description('接话的 agent：dsh / dsh-subprocess / echo / none'),
  workDir: Schema.string().default('').description('dsh 工作目录；留空 = 当前目录'),
  device: Schema.string().default('').description('v1 手机的型号提示；浏览器用不到'),
})

export function apply(ctx: Context, config: VoiceWebConfig): void {
  const logger = ctx.logger('voice-web')

  // 半套证书两种模式都是配置错误。host / origins 的对外检查只在真的启独立桥时做。
  if ((config.tls.keyPath === '') !== (config.tls.certPath === '')) {
    throw new Error('voice-web: tls.keyPath 与 tls.certPath 必须成对给，只给一半等于把连接降级成明文')
  }
  if (config.mode === 'standalone') {
    assertStandaloneBridge(config)
  }

  // 桌面壳的 index 不走 tapIndex，而且收集注入可能发生在本插件的 effect 之前。
  // 监听必须同步挂上，并且排在任何 ctx.effect / ctx.inject 前面。
  if (config.mode !== 'standalone') {
    const disposeInject = onHostEvent(ctx, 'webserver/index-inject', (table) => {
      appendDesktopWidgetInjection(table)
    })
    ctx.effect(() => () => {
      disposeInject()
    })
  }

  if (config.mode === 'standalone') {
    ctx.effect(() => bootStandalone(ctx, config, logger), 'voice-web')
    return
  }

  // host / auto：通过 Cordis 原生 `inject(['webServer'])` 同步抢先挂载 UI（立绘、脚本、
  // 状态与 tapIndex），绝不等 STT/TTS 凭据或语音栈预热完成——否则缺凭据或冷启动慢时
  // 浏览器压根看不到桌宠，还可能错过首屏 index.html 注入。
  if (config.mode === 'host') {
    let hostPhase: HostPhase = 'discovering'
    ctx.inject(['webServer'], (hostCtx) => {
      const server = readWebServer(hostCtx)
      if (server === null) {
        throw new Error('voice-web: host 模式需要 webServer')
      }
      const next = nextHostPhase(hostPhase, 'host')
      if (next === hostPhase) return
      hostPhase = next
      mountHostPlugin(hostCtx, config, logger, server)
    })
    ctx.effect(() => () => {
      hostPhase = nextHostPhase(hostPhase, 'stopped')
    })
    return
  }

  // auto：发现定时器与 `webServer` 注入抢同一相位。先进 standalone 的，晚到的注入直接丢掉。
  let hostPhase: HostPhase = 'discovering'
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let standaloneRelease: (() => Promise<void>) | null = null

  const clearDiscoveryTimer = (): void => {
    if (discoveryTimer !== undefined) {
      clearTimeout(discoveryTimer)
      discoveryTimer = undefined
    }
  }

  const enterHost = (hostCtx: Context, server: HostWebServer): void => {
    const next = nextHostPhase(hostPhase, 'host')
    if (next === hostPhase) return
    hostPhase = next
    clearDiscoveryTimer()
    mountHostPlugin(hostCtx, config, logger, server)
  }

  const enterStandalone = (): void => {
    const next = nextHostPhase(hostPhase, 'standalone')
    if (next === hostPhase) return
    hostPhase = next
    clearDiscoveryTimer()
    logger.info('未发现 webServer，退回独立端口')
    void bootStandalone(ctx, config, logger).then((release) => {
      if (hostPhase === 'stopped') {
        void release()
        return
      }
      standaloneRelease = release
    }, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error(`独立端口启动失败: ${detail}`)
    })
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const server = readWebServer(hostCtx)
    if (server === null) return
    enterHost(hostCtx, server)
  })

  ctx.effect(() => {
    if (hostPhase === 'discovering') {
      discoveryTimer = setTimeout(() => {
        discoveryTimer = undefined
        if (hostPhase !== 'discovering') return
        const server = readWebServer(ctx)
        if (server !== null) {
          enterHost(ctx, server)
          return
        }
        enterStandalone()
      }, HOST_DISCOVERY_MS)
    }
    return async () => {
      hostPhase = nextHostPhase(hostPhase, 'stopped')
      clearDiscoveryTimer()
      const release = standaloneRelease
      standaloneRelease = null
      if (release !== null) await release()
    }
  }, 'voice-web-auto-fallback')
}

interface HostVoiceRuntime {
  backend: VoiceBackendState
  inProcessAgent: InProcessDshAgent | null
  dshSession: DshSession | null
  hostMount: HostMountHandle | null
}

/**
 * 宿主模式两段启动：
 * 1. **同步段**（本函数内立刻完成）：挂载 `/dsh-voice/widget.js`、精灵白名单、`/dsh-voice/state`、
 *    `/dsh-voice/session`、`/dsh-voice/ws` 与 `tapIndex`，保证桌宠 UI 零竞态立即可见；
 * 2. **异步段**（`hostCtx.effect`）：启动内环语音栈。若缺少 STT/TTS 凭据只把 `backend`
 *    收成 `failed` 供气泡提示，绝不拆掉已经挂载的桌宠 UI。
 */
function mountHostPlugin(
  ctx: Context,
  config: VoiceWebConfig,
  logger: Logger,
  hostServer: HostWebServer,
): void {
  const report = (line: string): void => { console.log(line) }
  const workDir = config.workDir === '' ? process.cwd() : config.workDir

  const state: HostVoiceRuntime = {
    backend: { status: 'starting' },
    inProcessAgent: null,
    dshSession: null,
    hostMount: null,
  }

  const ensureInProcessAgent = (): InProcessDshAgent | null => {
    if (state.inProcessAgent !== null) return state.inProcessAgent
    if (config.agent !== 'dsh') return null
    const controller = readSessionController(ctx)
    if (controller === null) return null
    const configured = config.sessionId.trim()
    const effectiveSessionId = configured !== ''
      ? configured
      : loadPersistedSessionId() ?? undefined
    state.inProcessAgent = new InProcessDshAgent({
      controller,
      workDir,
      sessionId: effectiveSessionId,
      log: report,
      announceStore: null,
    })
    return state.inProcessAgent
  }

  const security = new HostSecurityGuard({
    getConnectionFence: () => resolveConnectionFence(ctx),
    trustedHosts: parseHostList(process.env['DSHV_TRUSTED_HOSTS']),
    adminHosts: parseHostList(process.env['DSHV_ADMIN_HOSTS']),
    warn: (msg) => {
      logger.warn(msg)
      report(msg)
    },
  })

  const hostMount = mountVoiceHost({
    webServer: hostServer,
    voicePort: () => getVoicePort(state.backend),
    getVoiceError: () => resolveHostVoiceBackendView(state.backend).voiceError,
    widgetJsPath: join(import.meta.dirname, 'widget.js'),
    assetsDir: join(import.meta.dirname, '..', 'assets', 'pet'),
    security,
    getState: async () => {
      const view = resolveHostVoiceBackendView(state.backend)
      const inProc = ensureInProcessAgent()
      return {
        ok: true,
        pipelineMode: view.pipelineMode,
        boundSessionId: inProc?.targetSessionId ?? state.dshSession?.currentSessionId ?? null,
        sessions: inProc ? await inProc.listSessions() : [],
        wsPath: WS_UPGRADE_PATH,
        assetsPrefix: ASSETS_PREFIX,
        voiceReady: view.voiceReady,
        voiceError: view.voiceError,
      }
    },
    onSelectSession: async (nextId) => {
      const inProc = ensureInProcessAgent()
      if (inProc === null) {
        return { sessionId: state.dshSession?.currentSessionId ?? null }
      }
      if (nextId === null) {
        inProc.bindSession(null)
        const id = await inProc.ensureSession()
        persistSessionId(id)
        return { sessionId: id }
      }
      inProc.bindSession(nextId)
      persistSessionId(nextId)
      return { sessionId: nextId }
    },
    log: report,
  })
  state.hostMount = hostMount
  logger.info('桌宠 UI 已同步挂载到宿主 /dsh-voice/*')

  ctx.effect(() => () => hostMount.close(), 'voice-web-host-ui')

  const bootStackWithGuard = async (bootCtx: Context): Promise<() => Promise<void>> => {
    try {
      return await bootVoiceStack(bootCtx, config, logger, state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      state.backend = { status: 'failed', reason: detail }
      logger.warn(`语音后端未就绪（桌宠 UI 保持可用）：${detail}`)
      console.warn(`[voice-web] 语音后端未就绪（桌宠 UI 仍可用，配置 ~/.dsh/.env 后重载生效）：${detail}`)
      return async () => {}
    }
  }

  if (config.agent !== 'dsh') {
    ctx.effect(() => bootStackWithGuard(ctx), 'voice-web-host-stack')
    return
  }

  // `dsh web` 里 `webServer` 往往早于 `sessionController` 就绪；如果此刻就启语音栈，
  // `readSessionController(ctx)` 会拿到 null 从而退回无头子进程 `dsh`，菜单切会话彻底脱节。
  // 等 `sessionController` 注入后再起进程内代理；仅在无该服务的精简宿主上超时退回子进程。
  // 控制器路径与超时路径共用一个相位：只 boot 一次，release 只留一份。
  let stackPhase: StackPhase = { kind: 'waiting' }
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined

  const clearFallbackTimer = (): void => {
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer)
      fallbackTimer = undefined
    }
  }

  const stopStack = async (): Promise<void> => {
    clearFallbackTimer()
    const next = reduceStackPhase(stackPhase, { type: 'stop' })
    stackPhase = next.phase
    if (next.releaseNow !== null) await next.releaseNow()
  }

  const startBoot = (source: 'controller' | 'timeout', bootCtx: Context): void => {
    const next = reduceStackPhase(stackPhase, { type: 'boot', source })
    if (next.phase === stackPhase) return
    stackPhase = next.phase
    clearFallbackTimer()
    void bootStackWithGuard(bootCtx).then((release) => {
      const done = reduceStackPhase(stackPhase, { type: 'booted', release })
      stackPhase = done.phase
      if (done.releaseNow !== null) void done.releaseNow()
    }, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error(`语音栈启动失败: ${detail}`)
      const stopped = reduceStackPhase(stackPhase, { type: 'stop' })
      stackPhase = stopped.phase
      if (stopped.releaseNow !== null) void stopped.releaseNow()
    })
  }

  ctx.inject(['sessionController'], (scCtx) => {
    if (stackPhase.kind !== 'waiting') return
    startBoot('controller', scCtx)
    // 效果体立刻执行；返回的才是卸载。写成立刻调用会把刚启动的栈停掉。
    scCtx.effect(() => () => stopStack(), 'voice-web-host-stack')
  })

  ctx.effect(() => {
    if (stackPhase.kind === 'waiting') {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined
        if (stackPhase.kind !== 'waiting') return
        logger.warn(`等待 sessionController 超过 ${SESSION_CONTROLLER_WAIT_MS} ms，退回子进程 dsh`)
        startBoot('timeout', ctx)
      }, SESSION_CONTROLLER_WAIT_MS)
      fallbackTimer.unref?.()
    }
    return () => stopStack()
  }, 'voice-web-host-stack-fallback')
}

async function bootStandalone(
  ctx: Context,
  config: VoiceWebConfig,
  logger: Logger,
): Promise<() => Promise<void>> {
  assertStandaloneBridge(config)
  const state: HostVoiceRuntime = {
    backend: { status: 'starting' },
    inProcessAgent: null,
    dshSession: null,
    hostMount: null,
  }
  let bridge: WebBridge | null = null
  const releaseStack = await bootVoiceStack(ctx, config, logger, state)
  try {
    const report = (line: string): void => { console.log(line) }
    const tls = loadBridgeTls(config)
    const authenticate = loadAuthenticator(report)
    const safety = checkBindSafety({
      host: config.host,
      hasTls: tls !== undefined,
      hasAuth: authenticate !== undefined,
    })
    if (!safety.ok) {
      throw new Error(`voice-web: ${safety.message}`)
    }
    const listening = getVoicePort(state.backend)
    if (listening === null) {
      throw new Error('语音栈没有起来，桥不接')
    }
    bridge = await startWebBridge({
      port: config.port,
      host: config.host,
      voicePort: listening,
      ...(tls === undefined ? {} : { tls }),
      origins: config.origins,
      // 编译产物在 lib/，页面在包根的 demo/ —— 两者都随包发布
      webDir: config.servePage ? join(import.meta.dirname, '..', 'demo') : '',
      log: report,
    })
    logger.info(`就绪：浏览器 → :${bridge.port} → 语音栈 127.0.0.1:${listening}`)
    if (config.servePage) {
      const scheme = tls === undefined ? 'http' : 'https'
      const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
      console.log(`\nweb       ${scheme}://${shown}:${bridge.port}/   ← 浏览器打开这个地址\n`)
    }
  } catch (error) {
    await bridge?.close()
    await releaseStack()
    throw error
  }
  return async () => {
    await bridge?.close()
    await releaseStack()
  }
}

async function bootVoiceStack(
  ctx: Context,
  config: VoiceWebConfig,
  logger: Logger,
  state: HostVoiceRuntime,
): Promise<() => Promise<void>> {
  // 用对象持有 stop：赋值发生在 `onListening` 回调里，普通 `let` 会被 TS
  // 的控制流分析窄化成永远 null
  const voice: { stop: (() => void) | null } = { stop: null }
  let dshSession: DshSession | null = null
  let inProcessAgent: InProcessDshAgent | null = null
  let turnJudge: TurnJudge | null = null
  let streaming: AssembledStreamingPipeline | null = null
  let stopKeepalive: () => void = () => {}
  let released = false

  const releaseVoice = async (): Promise<void> => {
    if (released) return
    released = true
    state.backend = { status: 'stopped' }
    if (state.inProcessAgent === inProcessAgent) state.inProcessAgent = null
    if (state.dshSession === dshSession) state.dshSession = null
    const steps: Array<() => Promise<void> | void> = [
      () => { voice.stop?.() },
      () => { turnJudge?.stop() },
      () => { streaming?.dispose() },
      () => { stopKeepalive() },
      () => { inProcessAgent?.dispose() },
      () => { dshSession?.stop() },
    ]
    for (const step of steps) {
      try {
        await step()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`voice-web: 收尾失败（${detail}）`)
      }
    }
  }

  try {
    // 运维看的是这一路：与 CLI 一致打到 stdout。`logger` 的输出在 dsh 里看不到，
    // 而「管道是哪条」「快车道开没开」「判停接没接上」必须能一眼确认。
    const report = (line: string): void => { console.log(line) }

    // `process.cwd()/.env` 优先，再补读 `~/.dsh/.env`（不覆盖已有变量）。
    // 必须在 `buildStt` / `buildTts` **之前** —— 那两个函数直接读 process.env。
    const loaded = loadDotEnv()
    if (loaded > 0) {
      report(`凭据    ${process.cwd()}\\.env（${loaded} 项）`)
    }
    const homeLoaded = loadDshHomeDotEnv()
    if (homeLoaded > 0) {
      report(`凭据    ${join(dshHomeDir(), '.env')}（${homeLoaded} 项）`)
    }
    const keepAliveMs = envNumber('MIAI_HTTP_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS)
    installHttpAgent(keepAliveMs)
    report(`HTTP     连接保活 ${keepAliveMs} ms（默认 4 秒会让每轮重新握手）`)
    const archiveDir = resolveArchiveDir(process.env['MIAI_ARCHIVE_DIR'], homedir())
    report(formatArchiveBanner(archiveDir))

    // 审计出口自己造一份：`createAuditSlot()` 是每个宿主一份，不共用包① 的全局槽。
    // TTS provider 与流式装配都往这里写，`setAudit` 再把「当前连接」的档案挂上来。
    const auditSlot = createAuditSlot()
    const audit = (event: string, data: Record<string, unknown>): void => {
      auditSlot.emit(event, data)
    }

    const authenticate = loadAuthenticator(report)

    const workDir = config.workDir === '' ? process.cwd() : config.workDir
    // MEMORY.md 只存长期语义事实，默认锚定 ~/.dsh/MEMORY.md，不随工作目录漂移、不写单轮对话。
    const memoryPath = process.env['MEMORY_FILE'] ?? join(dshHomeDir(), 'MEMORY.md')
    const memoryFile = new MemoryFile(memoryPath)
    // `qwen3-asr-flash-realtime` 在弱音/静音封段时会把 `corpus.text` 原样复读成用户转写，
    // 直接污染对话与 dsh 会话。Web 插件默认不注静态热词，仅当显式设 `QWEN_ASR_CORPUS=1` 时启用。
    const corpusText = process.env['QWEN_ASR_CORPUS'] === '1'
      ? loadStaticAsrCorpus(memoryFile.hotwordHints(), process.env)
      : ''
    const language = resolveAsrLanguage(process.env)
    // Pure Live（VOICE_PIPELINE=live 或 OMNI_ANSWER=full|clip）才把默认 STT 换成
    // qwen-realtime，并把外部 TTS 换成静音占位。echo/none 没有这条管道；
    // 服务端 VAD 时客户端不封段，改 silent 会直接变哑巴。
    const inferredPlan = assemblePipelinePlan(process.env, { sttName: 'qwen-realtime', strict: false })
    const wantsLive = inferredPlan.mode === 'live'
    const hasOmniKey = (process.env['OMNI_API_KEY'] ?? process.env['DASHSCOPE_API_KEY'] ?? '').trim() !== ''
    const dshBacked = isDshBackedAgent(config.agent)
    const liveVadConflict = pureLiveVadConflict({
      dshBacked,
      voicePipeline: process.env['VOICE_PIPELINE'],
      turnDetection: process.env['QWEN_ASR_TURN_DETECTION'],
    })
    if (liveVadConflict !== null) {
      report(liveVadConflict)
      logger.warn(liveVadConflict)
      throw new Error(liveVadConflict)
    }
    const usePureLiveAudio = shouldUsePureLiveAudio({
      dshBacked,
      wantsLive,
      hasOmniKey,
      turnDetection: process.env['QWEN_ASR_TURN_DETECTION'],
    })
    const effectiveStt = usePureLiveAudio ? 'qwen-realtime' : config.stt
    const effectiveTts = usePureLiveAudio ? 'silent' : config.tts
    const stt = await buildStt(effectiveStt, { ...sttCreds(), corpusText, language })
    const tts = await buildTts(effectiveTts, audit)
    report(`可替换件 STT=${stt.name}  TTS=${tts.name}（${tts.sampleRate} Hz）`)
    // 与 CLI 同一个队列：任务结果离线时先存着，重连后补播
    const announceStore = AnnounceStore.open({
      file: process.env['MIAI_ANNOUNCE_FILE'] ?? join(homedir(), '.voice-agent', 'announce.jsonl'),
      maxItems: envNumber('MIAI_ANNOUNCE_MAX', DEFAULT_ANNOUNCE_MAX),
      log: report,
    })

    const sessionController = readSessionController(ctx)
    const useInProcess = config.agent === 'dsh' && sessionController !== null
    let baseAgent: AgentProvider
    if (useInProcess) {
      const configured = config.sessionId.trim()
      const effectiveSessionId = state.inProcessAgent?.sessionId
        ?? (configured !== '' ? configured : loadPersistedSessionId() ?? undefined)
      state.inProcessAgent?.dispose()
      inProcessAgent = new InProcessDshAgent({
        controller: sessionController,
        workDir,
        sessionId: effectiveSessionId,
        log: report,
        announceStore,
      })
      state.inProcessAgent = inProcessAgent
      baseAgent = inProcessAgent
      report(effectiveSessionId === undefined
        ? 'agent    进程内 dsh（sessionController）'
        : `agent    进程内 dsh（sessionController）固定 ${effectiveSessionId}`)
    } else {
      const bundle = await buildAgent(
        config.agent === 'dsh-subprocess' ? 'dsh' : config.agent,
        {
          workDir,
          useSdk: process.env['MIAI_DSH_SDK'] === '1',
          provider: process.env['MIAI_DSH_PROVIDER'] ?? 'deepseek-official',
          model: process.env['MIAI_DSH_MODEL'] ?? 'deepseek-flash',
          log: report,
        },
        announceStore,
      )
      dshSession = bundle.dsh
      state.dshSession = dshSession
      if (bundle.agent === null) {
        throw new Error(`agent=${config.agent} 没有产出 agent，语音栈起来也没人接话`)
      }
      baseAgent = bundle.agent
    }

    /**
     * 主管道。判据、强校验、`live` 的 `qwen-realtime` 前提全在包① 的纯函数里 ——
     * 这里只传「当前选的 STT 叫什么」。
     *
     * 非 dsh（`echo` / `none`）不装管道：与 CLI 一致，那两条路本来就没有快车道。
     * `dsh-subprocess` 与进程内 dsh 都算 dsh（`dshBacked` 在选 STT/TTS 时已经算过）。
     */
    const plan = dshBacked
      ? assemblePipelinePlan(process.env, { sttName: effectiveStt, strict: true })
      : null

    if (plan !== null) {
      report(
        `管道      ${plan.mode === 'live' ? 'Pure Live（Omni 单前台 + dsh 纯异步后台）' : 'Pure Cascade（ASR + 级联快车道/dsh + TTS）'}`
        + `${plan.explicit ? ' [VOICE_PIPELINE]' : ' [兼容推断]'}`,
      )
      for (const note of plan.notes) {
        report(`          ${note}`)
      }

      const activity = newActivityState(Date.now())
      const liveAgent = inProcessAgent
      let speculate = false
      let taskStatus: () => string
      if (liveAgent !== null) {
        // 进程内 cancelTurn 不用再探测 session/cancel。
        speculate = plan.mode === 'cascade' && plan.useCascadeFastLane && process.env['FAST_LANE_SPECULATE'] !== '0'
        if (plan.mode === 'cascade' && plan.useCascadeFastLane) {
          report(speculate
            ? '快车道    投机=开（进程内 cancelTurn，命中时可作废在途那一轮）'
            : '快车道    投机=关（FAST_LANE_SPECULATE=0）')
        }
        taskStatus = () => liveAgent.taskStatus()
      } else {
        if (dshSession === null) {
          throw new Error('管道装配需要 dsh 会话，但 agent 不是 dsh')
        }
        const session = dshSession
        speculate = plan.mode === 'cascade' && plan.useCascadeFastLane
          ? await resolveSpeculate(session, report)
          : false
        taskStatus = () => session.taskStatus()
      }

      // 热路径引擎 / omni 影子 / 后台汇报出口都在这一句里，与 CLI 逐字同一套 ——
      // 少了它，语音栈照样能跑，但每句都退化成「等完整 dsh」。
      streaming = assembleStreamingAgent({
        plan,
        env: process.env,
        dshAgent: baseAgent,
        tts,
        activity,
        // 直播编排要一整段；级联在 assembleStreamingAgent 里再拆回逐条。
        memory: (text) => memoryFile.relevant(text).join('\n'),
        taskStatus,
        audit,
        speculate,
        announceStore,
        log: report,
        memorySummary: () => memoryFile.summary(),
        asrCorpusText: corpusText,
        asrLanguage: language,
      })
      const agentForKeepalive = baseAgent
      baseAgent = streaming.agent
      report(`记忆      ${memoryPath}（${memoryFile.entries().length} 条，快车道只读）`)

      // 前缀保活：与 CLI 一样**直连 dsh**，不经过快车道/直播编排 ——
      // 走编排层会被短句认领，dsh 根本没被叫到，前缀照样凉。
      const keepaliveMinutes = envNumber('KEEPALIVE_MINUTES', 180)
      if (keepaliveMinutes > 0) {
        stopKeepalive = startKeepalive({
          clock: systemClock,
          intervalMs: keepaliveMinutes * 60_000,
          idleFor: () => Date.now() - activity.last,
          isBusy: () => activity.inflight > 0,
          ping: async () => {
            activity.inflight += 1
            try {
              await agentForKeepalive.reply(KEEPALIVE_PROMPT)
            } finally {
              activity.inflight -= 1
              activity.last = Date.now()
            }
          },
          log: report,
        })
        report(`保活      空闲 ${keepaliveMinutes} 分钟发一次前缀保活（KEEPALIVE_MINUTES=0 关闭）`)
      }
    }

    const agent = streaming?.agent ?? baseAgent

    // 门限、判停、端点、超时与 CLI 同一份（`voice-config.ts`）。
    // 浏览器只盖两处：上行增益 1×（getUserMedia 已开 AGC），控制口 0（没有固定偏移）。
    const turnJudgePython = envString('TURN_JUDGE_PYTHON') ?? ''
    const turnJudgeScript = envString('TURN_JUDGE_SCRIPT') ?? ''
    const turnJudgeEnabled = envString('TURN_JUDGE') !== '0'
      && turnJudgePython !== '' && turnJudgeScript !== ''
    const semanticKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim()
    const semanticEnabled = envString('SEMANTIC_END_TAG') !== '0' && semanticKey !== ''
    const runtime = buildVoiceRuntimeConfig({
      env: process.env,
      sttSpec: effectiveStt,
      turnJudgeEnabled,
      turnJudgePython,
      turnJudgeScript,
      semanticEnabled,
      // 浏览器 `micGain: 1` 比眼镜 4× 低；-30 dBFS + 150 ms 容易词中切碎，-38 又会把键盘/呼吸声
      // 送进解码器。仅在未显式配置环境变量时给折中值 -34 dBFS / 320 ms。
      overrides: {
        micGain: 1,
        controlPort: 0,
        ...(process.env['VOICE_PEAK_DBFS'] === undefined ? { peakDbfs: -34 } : {}),
        ...(process.env['VOICE_STT_COMMIT_MS'] === undefined ? { sttCommitMs: 320 } : {}),
      },
    })
    const semantic = semanticEnabled
      ? semanticEndpoint({
        apiKey: semanticKey,
        ...(process.env['FAST_LANE_MODEL'] === undefined
          ? {}
          : { model: process.env['FAST_LANE_MODEL'] }),
        ...(process.env['FAST_LANE_BASE_URL'] === undefined
          ? {}
          : { baseUrl: process.env['FAST_LANE_BASE_URL'] }),
        timeoutMs: runtime.semanticTimeoutMs,
        log: report,
      })
      : null

    const turnJudgeClient = turnJudgeEnabled
      ? new TurnJudge({ python: turnJudgePython, script: turnJudgeScript, log: report })
      : null
    if (turnJudgeClient !== null) {
      // 低幅正弦而不是全零：全零在 log-mel 里是 −∞ dB，不该拿它当"正常输入"试模型
      const warmup = Buffer.alloc(UPSTREAM_SAMPLE_RATE * 2)
      for (let i = 0; i < warmup.length / 2; i += 1) {
        warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2)
      }
      const startedAt = Date.now()
      const p = await turnJudgeClient.predict(warmup)
      report(`判停    侧车预热 ${Date.now() - startedAt} ms（p=${p.toFixed(3)}），之后所有连接共用这一份`)
    }
    turnJudge = turnJudgeClient

    // 语音栈先起：端口 0 → `onListening` 报出真实端口，再把桥或宿主挂载接上去。
    // `runVoiceServer` 若在 `onListening` 之前就返回或抛错（端口冲突、绑定失败），
    // 必须 reject，否则这个 Promise 永远等不到。
    const voicePort = await new Promise<number>((resolve, reject) => {
      runVoiceServer({
        port: 0,
        host: '127.0.0.1',
        device: config.device,
        ffmpegPath: process.env['MIAI_FFMPEG'] ?? 'ffmpeg',
        agent,
        stt,
        tts,
        ...(plan === null ? {} : { pipelineMode: plan.mode }),
        ...(streaming?.engine === undefined ? {} : { engine: streaming.engine }),
        ...(streaming?.speakAnnounce === undefined
          ? {}
          : {
            speakAnnounce: streaming.speakAnnounce,
            cancelAnnounce: streaming.cancelAnnounce,
            onFallbackAnnounceSpoken: streaming.onFallbackAnnounceSpoken,
          }),
        // omni 影子旁路：默认不传 = 这条连接不会去连 DashScope，零成本
        ...(streaming?.omniShadow === undefined ? {} : { omniShadow: streaming.omniShadow }),
        ...(turnJudgeClient === null || runtime.turnJudge === undefined
          ? {}
          : { turnJudge: runtime.turnJudge, turnJudgeClient }),
        ...(semantic === null
          ? {}
          : { semantic, semanticBudgetMs: runtime.semanticBudgetMs }),
        gate: runtime.gate,
        playbackTailMs: runtime.playbackTailMs,
        ttsGain: envNumber('MIAI_TTS_GAIN', envNumber('TTS_GAIN', 1)),
        micGain: runtime.micGain,
        levelLogMs: envNumber('MIAI_LEVEL_LOG', 0),
        archiveDir,
        archiveMaxMb: runtime.archiveMaxMb,
        archiveKeep: runtime.archiveKeep,
        // 连接建立/断开时把审计（快车道 + TTS 两段）接到这条档案上。
        // 两参都转发：槽位靠 `expected` 做所有权守卫（旧连接收尾摘不掉新连接的）。
        setAudit: (sink, expected) => { auditSlot.set(sink, expected) },
        photoDir: process.env['PHOTO_DIR'] ?? '',
        // 浏览器没有拍照。0 = 系统挑空闲口（里层端口本身就是 0，没有固定偏移）。
        controlPort: runtime.controlPort,
        photoTimeoutMs: runtime.photoTimeoutMs,
        confirmTimeoutMs: runtime.confirmTimeoutMs,
        imageQuestion: runtime.imageQuestion,
        announceStore,
        // 里层明文：桥用 `net.connect` 连进来（见文件头）
        authenticate,
        idleTimeoutMs: runtime.idleTimeoutMs,
        // 多标签页 = 多条连接；同时也是「必须靠 onListening().stop() 收尾」的原因
        serve: true,
        onUiEvent: (ev) => { state.hostMount?.broadcastUi(ev) },
        onListening: (info) => {
          voice.stop = info.stop
          resolve(info.port)
        },
      }).then((code) => {
        logger.info(`语音栈退出 ${code}`)
        reject(new Error(`语音栈在开始监听前就退出了（code=${code}）`))
      }, (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`语音栈启动失败: ${message}`)
        reject(error instanceof Error ? error : new Error(message))
      })
    })
    if (voicePort === 0) {
      throw new Error('语音栈没有起来，桥不接')
    }

    state.backend = {
      status: 'ready',
      port: voicePort,
      mode: plan === null ? 'direct' : plan.mode,
    }
    if (state.hostMount !== null) {
      logger.info(`就绪：宿主 /dsh-voice/ws → 语音栈 127.0.0.1:${voicePort}`)
    }
  } catch (error) {
    // 装配半途失败时把已经起来的收掉，不留「只有桥没有栈」的状态
    try {
      await releaseVoice()
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      console.warn(`voice-web: 收尾失败（${detail}）`)
    }
    throw new Error(`voice-web: ${(error as Error).message}`)
  }

  return releaseVoice
}

export default { name, Config, apply }
