/**
 * 独立桥：对外的是 startWebBridge，里层语音栈仍是本机明文 TCP。
 *
 * 只有这条路径检查监听地址和桥证书。host 模式不听 config.host。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Logger } from '@deepseek-ai/cordis'

import { startWebBridge, type WebBridge } from './bridge.ts'
import { bootVoiceStack, type HostVoiceRuntime } from './boot-voice-stack.ts'
import { getVoicePort, type VoiceWebConfig } from './driver-policy.ts'
import { checkBindSafety, isLoopbackHost } from './voice/bind-policy.ts'
import { loadAuthenticator } from './voice/runtime/env-bootstrap.ts'
import { expiryWarning } from './voice/tls-cert.ts'

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
 * 独立桥才检查对外绑定。host 模式不听 `config.host`，配错了也不该挡住桌宠挂载。
 * 半套 TLS 在 `apply()` 入口另判，两种模式都算配置错误。
 */
export function assertStandaloneBridge(config: VoiceWebConfig): void {
  if (!isLoopbackHost(config.host) && config.origins.length === 0) {
    throw new Error('voice-web: 监听非本机地址时必须配 origins（允许的页面来源），否则任何网页都能连上来')
  }
}

export async function bootStandalone(
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
