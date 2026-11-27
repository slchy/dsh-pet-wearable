/**
 * dsh 宿主服务发现、权限栅栏、持久化 sessionId，以及桌宠 UI 的同步挂载。
 *
 * UI 先挂上；语音栈等到 sessionController，或超过兜底时限再启动。
 * 缺凭据只把后端标成失败，不拆已经挂上的桌宠。
 */
import type { IncomingMessage } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context, Logger } from '@deepseek-ai/cordis'

import { bootVoiceStack, type HostVoiceRuntime } from './boot-voice-stack.ts'
import {
  getVoicePort,
  reduceStackPhase,
  resolveHostVoiceBackendView,
  type StackPhase,
  type VoiceWebConfig,
} from './driver-policy.ts'
import { readDotEnvFile, upsertDotEnvFile } from './env-store.ts'
import {
  ASSETS_PREFIX,
  WS_UPGRADE_PATH,
  mountVoiceHost,
  type HostPetState,
  type HostWebServer,
} from './host-mount.ts'
import { HostSecurityGuard, type ConnectionFence } from './host-security.ts'
import {
  InProcessDshAgent,
  type HostJobController,
  type HostSessionController,
} from './in-process-agent.ts'
import { fetchAvailableModels } from './model-catalog.ts'
import {
  applyVoiceProfile,
  buildEnvUpdatesFromConfigRequest,
  buildResetToDefaultEnvUpdates,
  buildVoiceConfigSnapshot,
} from './voice-config-apply.ts'
import type { VoiceConfigUpdateRequest } from './voice-overrides.ts'
import { loadDotEnv } from './voice/runtime/env-bootstrap.ts'

/** host 模式下等 `sessionController` 就绪的兜底上限；超时才退回子进程 dsh。 */
const SESSION_CONTROLLER_WAIT_MS = 5_000

/** 上次在挂件里选中的会话。`config.sessionId` 非空时不用这份。 */
export function dshHomeDir(): string {
  return process.env['DSH_HOME'] || join(homedir(), '.dsh')
}

function petSessionFile(): string {
  return join(dshHomeDir(), '.dsh-voice-pet.json')
}

export function dshHomeEnvFile(): string {
  return join(dshHomeDir(), '.env')
}

function dshHomeEnvHint(): string {
  return process.env['DSH_HOME'] ? join(process.env['DSH_HOME'], '.env') : '~/.dsh/.env'
}

/**
 * 补读 `~/.dsh/.env`（不覆盖已有环境变量）：`dsh web` / Desktop 的 `cwd`
 * 往往不是语音仓目录，把 STT/TTS 凭据放在 `~/.dsh/.env` 即可在任意目录生效。
 */
export function loadDshHomeDotEnv(): number {
  const entries = readDotEnvFile(dshHomeEnvFile())
  let count = 0
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
      count += 1
    }
  }
  return count
}

export function loadPersistedSessionId(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(petSessionFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const raw = (parsed as { sessionId?: unknown }).sessionId
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  } catch {
    return null
  }
}

function persistSessionId(sessionId: string | null): void {
  try {
    const file = petSessionFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ sessionId }, null, 2), 'utf8')
  } catch {
    // 持久化失败不影响当前会话运行。
  }
}

/**
 * `ctx.on` 的类型只列了 cordis 内置事件。宿主事件走这个结构调用，
 * 这样不必依赖 `@deepseek-ai/dsh-host-webserver` 的类型补丁。
 */
export function onHostEvent(
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

export function readWebServer(ctx: Context): HostWebServer | null {
  const value = readHostService(ctx, 'webServer')
  return isHostWebServer(value) ? value : null
}

export function readSessionController(ctx: Context): HostSessionController | null {
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

/**
 * 后台作业控制器：用户说「别查了」时要把还在跑的 `job`（`run_in_background: true`）
 * 真的停掉。精简宿主不一定注入这个服务 —— 缺了只影响取消得干不干净，不影响对话。
 */
export function readJobController(ctx: Context): HostJobController | null {
  const value = readHostService(ctx, 'jobController')
  if (typeof value !== 'object' || value === null) return null
  const controller = value as Partial<HostJobController>
  if (typeof controller.kill !== 'function') return null
  return value as HostJobController
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

/**
 * 宿主模式两段启动：
 * 1. **同步段**（本函数内立刻完成）：挂载 `/dsh-voice/widget.js`、精灵白名单、`/dsh-voice/state`、
 *    `/dsh-voice/session`、`/dsh-voice/ws` 与 `tapIndex`，保证桌宠 UI 零竞态立即可见；
 * 2. **异步段**（`hostCtx.effect`）：启动内环语音栈。若缺少 STT/TTS 凭据只把 `backend`
 *    收成 `failed` 供气泡提示，绝不拆掉已经挂载的桌宠 UI。
 */
export function mountHostPlugin(
  ctx: Context,
  config: VoiceWebConfig,
  logger: Logger,
  hostServer: HostWebServer,
): void {
  const report = (line: string): void => { console.log(line) }
  const workDir = config.workDir === '' ? process.cwd() : config.workDir

  // 同步补读一次 .env，确保桌宠 UI 首次 GET /dsh-voice/state 就能拿到准确的缺省优化方案视图。
  loadDotEnv()
  loadDshHomeDotEnv()

  const state: HostVoiceRuntime = {
    backend: { status: 'starting' },
    activeSummary: null,
    inProcessAgent: null,
    dshSession: null,
    hostMount: null,
  }

  let reloading = false
  let unmounted = false
  let activeBootCtx: Context = ctx
  let reloadQueue: Promise<void> = Promise.resolve()

  const readMergedVoiceEnv = (): Record<string, string | undefined> => ({
    ...process.env,
    ...readDotEnvFile(dshHomeEnvFile()),
  })

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

  const buildState = async (): Promise<HostPetState> => {
    const view = resolveHostVoiceBackendView(state.backend)
    const inProc = ensureInProcessAgent()
    const mergedEnv = readMergedVoiceEnv()
    const preview = applyVoiceProfile(mergedEnv, config)
    const voiceConfig = buildVoiceConfigSnapshot({
      env: mergedEnv,
      activePipeline: view.pipelineMode,
      activeSummary: state.activeSummary ?? preview.summary,
      envFileHint: dshHomeEnvHint(),
      reloading,
    })
    return {
      ok: true,
      pipelineMode: view.pipelineMode,
      boundSessionId: inProc?.targetSessionId ?? state.dshSession?.currentSessionId ?? null,
      sessions: inProc ? await inProc.listSessions() : [],
      wsPath: WS_UPGRADE_PATH,
      assetsPrefix: ASSETS_PREFIX,
      voiceReady: view.voiceReady,
      voiceError: view.voiceError,
      voiceConfig,
    }
  }

  let releaseDirectStack: (() => Promise<void>) | null = null
  let stopManagedStack: () => Promise<void> = async () => {}
  let restartManagedStack: () => Promise<void> = async () => {}

  const applyAndReloadConfig = async (
    req: { readonly reset: true } | { readonly reset: false; readonly value: VoiceConfigUpdateRequest },
  ): Promise<HostPetState> => {
    const updates = req.reset
      ? buildResetToDefaultEnvUpdates()
      : buildEnvUpdatesFromConfigRequest(req.value)
    upsertDotEnvFile(dshHomeEnvFile(), updates)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    const run = async (): Promise<void> => {
      if (unmounted) return
      reloading = true
      try {
        const bound = state.inProcessAgent?.targetSessionId
        if (bound !== undefined && bound !== null && config.sessionId.trim() === '') {
          persistSessionId(bound)
        }
        state.backend = { status: 'starting' }
        state.activeSummary = null
        await restartManagedStack()
      } finally {
        reloading = false
      }
    }
    const chained = reloadQueue.then(run, run)
    reloadQueue = chained
    await chained
    return buildState()
  }

  const hostMount = mountVoiceHost({
    webServer: hostServer,
    voicePort: () => getVoicePort(state.backend),
    getVoiceError: () => resolveHostVoiceBackendView(state.backend).voiceError,
    widgetJsPath: join(import.meta.dirname, 'widget.js'),
    assetsDir: join(import.meta.dirname, '..', 'assets', 'pet'),
    security,
    getState: buildState,
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
    onUpdateConfig: applyAndReloadConfig,
    onFetchModels: (req) => fetchAvailableModels(req, readMergedVoiceEnv()),
    log: report,
  })
  state.hostMount = hostMount
  logger.info('桌宠 UI 已同步挂载到宿主 /dsh-voice/*')

  ctx.effect(() => () => {
    unmounted = true
    return hostMount.close()
  }, 'voice-web-host-ui')

  const bootStackWithGuard = async (bootCtx: Context): Promise<() => Promise<void>> => {
    try {
      return await bootVoiceStack(bootCtx, config, logger, state)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      state.backend = { status: 'failed', reason: detail }
      state.activeSummary = null
      logger.warn(`语音后端未就绪（桌宠 UI 保持可用）：${detail}`)
      console.warn(`[voice-web] 语音后端未就绪（桌宠 UI 仍可用，配置 ~/.dsh/.env 后重载生效）：${detail}`)
      return async () => {}
    }
  }

  if (config.agent !== 'dsh') {
    restartManagedStack = async () => {
      const prev = releaseDirectStack
      releaseDirectStack = null
      if (prev !== null) await prev()
      if (unmounted) return
      const nextRelease = await bootStackWithGuard(ctx)
      if (unmounted) {
        await nextRelease()
        return
      }
      releaseDirectStack = nextRelease
    }
    ctx.effect(() => {
      void restartManagedStack()
      return async () => {
        unmounted = true
        const prev = releaseDirectStack
        releaseDirectStack = null
        if (prev !== null) await prev()
      }
    }, 'voice-web-host-stack')
    return
  }

  // `dsh web` 里 `webServer` 往往早于 `sessionController` 就绪；如果此刻就启语音栈，
  // `readSessionController(ctx)` 会拿到 null 从而退回无头子进程 `dsh`，菜单切会话彻底脱节。
  // 等 `sessionController` 注入后再起进程内代理；仅在无该服务的精简宿主上超时退回子进程。
  // 控制器路径与超时路径共用一个相位：只 boot 一次，release 只留一份。
  let stackPhase: StackPhase = { kind: 'waiting' }
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  let inflightBoot: Promise<void> | null = null

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
  stopManagedStack = stopStack

  const startBoot = (source: 'controller' | 'timeout', bootCtx: Context): Promise<void> => {
    activeBootCtx = bootCtx
    const next = reduceStackPhase(stackPhase, { type: 'boot', source })
    if (next.phase === stackPhase) return inflightBoot ?? Promise.resolve()
    stackPhase = next.phase
    clearFallbackTimer()
    const p = bootStackWithGuard(bootCtx).then((release) => {
      const done = reduceStackPhase(stackPhase, { type: 'booted', release })
      stackPhase = done.phase
      if (done.releaseNow !== null) return done.releaseNow()
      return undefined
    }, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error(`语音栈启动失败: ${detail}`)
      const stopped = reduceStackPhase(stackPhase, { type: 'stop' })
      stackPhase = stopped.phase
      if (stopped.releaseNow !== null) return stopped.releaseNow()
      return undefined
    }).finally(() => {
      if (inflightBoot === p) inflightBoot = null
    })
    inflightBoot = p
    return p
  }

  restartManagedStack = async () => {
    if (inflightBoot !== null) {
      await stopStack()
      await inflightBoot
    } else {
      await stopStack()
    }
    if (unmounted) return
    stackPhase = { kind: 'waiting' }
    await startBoot('controller', activeBootCtx)
  }

  ctx.inject(['sessionController'], (scCtx) => {
    activeBootCtx = scCtx
    if (stackPhase.kind !== 'waiting') return
    void startBoot('controller', scCtx)
    // 效果体立刻执行；返回的才是卸载。写成立刻调用会把刚启动的栈停掉。
    scCtx.effect(() => () => {
      unmounted = true
      return stopManagedStack()
    }, 'voice-web-host-stack')
  })

  ctx.effect(() => {
    if (stackPhase.kind === 'waiting') {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined
        if (stackPhase.kind !== 'waiting') return
        logger.warn(`等待 sessionController 超过 ${SESSION_CONTROLLER_WAIT_MS} ms，退回子进程 dsh`)
        void startBoot('timeout', ctx)
      }, SESSION_CONTROLLER_WAIT_MS)
      fallbackTimer.unref?.()
    }
    return () => {
      unmounted = true
      return stopManagedStack()
    }
  }, 'voice-web-host-stack-fallback')
}
