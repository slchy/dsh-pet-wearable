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
 * 生成、不进 git），装配直接调用 `voice/runtime/` 里与 CLI 相同的函数
 * （`assemblePipelinePlan` / `assembleStreamingAgent` 等），不经过 CLI 入口，
 * 两边不会漂。相位、宿主生命周期、独立桥和语音栈分居旁边四个模块。
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

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import {
  nextHostPhase,
  type HostPhase,
  type VoiceWebConfig,
} from './driver-policy.ts'
import { mountHostPlugin, onHostEvent, readWebServer } from './host-lifecycle.ts'
import { appendDesktopWidgetInjection, type HostWebServer } from './host-mount.ts'
import { assertStandaloneBridge, bootStandalone } from './standalone-bridge.ts'

export {
  formatArchiveBanner,
  getVoicePort,
  isDshBackedAgent,
  nextHostPhase,
  pureLiveVadConflict,
  reduceStackPhase,
  resolveArchiveDir,
  resolveHostVoiceBackendView,
  shouldEnableSemanticEndpoint,
  shouldUsePureLiveAudio,
} from './driver-policy.ts'

export type {
  HostPhase,
  HostVoiceBackendView,
  StackEvent,
  StackPhase,
  StackTransition,
  VoiceBackendState,
  VoiceWebConfig,
} from './driver-policy.ts'

export const name = 'voice-web'

/** auto 模式等多久看 `webServer` 会不会出现。到点没有就退回独立桥。 */
const HOST_DISCOVERY_MS = 1_500

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

export default { name, Config, apply }
