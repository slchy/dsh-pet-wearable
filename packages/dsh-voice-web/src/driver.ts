/**
 * dsh 插件入口（web 兼容层）。
 *
 * 一条链：浏览器 ⇄ WS ⇄ 本进程的桥 ⇄ TCP 127.0.0.1 ⇄ 本进程内的语音栈。
 * 语音栈就是包① 那一套（`src/voice/` 是它的副本，由 `scripts/sync-voice.mjs`
 * 生成、不进 git），装配走与 CLI 共用的 `assembly.ts` —— 两边不会漂。
 *
 * 为什么不是子进程：装配抽出来之后进程内起栈不需要复制任何代码，卸载时还能
 * 整块收掉，不用管僵尸子进程与信号转发。
 *
 * 语音栈的内部端口用 `0`（系统挑空闲口），拿到真实端口再把桥接上 ——
 * 省掉「固定端口会不会撞」这条隐式约定。
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

import { startWebBridge, type WebBridge } from './bridge.ts'
import { AssemblyError, buildAgent, buildStt, buildTts, loadAuthenticator, loadTls } from './voice/assembly.ts'
import { checkBindSafety } from './voice/bind-policy.ts'
import { SmartTurn } from './voice/smart-turn.ts'
import { runVoiceServer, UPSTREAM_SAMPLE_RATE } from './voice/voice-session.ts'
import type { AgentProvider } from './voice/providers.ts'
import type { DshSession } from './voice/session.ts'

/** 与 `main.ts` 的 `envNumber` 同义：环境变量给了就用，没给用默认 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export const name = 'voice-web'

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
} {
  return {
    akId: process.env['ALIYUN_AK_ID'] ?? '',
    akSecret: process.env['ALIYUN_AK_SECRET'] ?? '',
    appkey: process.env['ALIYUN_APPKEY'] ?? '',
    region: process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai',
    maxSentenceSilenceMs: Number(process.env['MIAI_SENTENCE_SILENCE'] ?? 200),
  }
}

export interface VoiceWebConfig {
  /** 浏览器连的端口 */
  port: number
  /** 浏览器连的地址。非本机地址要求 `tls` 与 `origins` 同时配齐 */
  host: string
  /** 允许的页面来源。留空 = 只放同源（非浏览器客户端不带 Origin，仍放行） */
  origins: string[]
  /** 是否在同一个端口把页面发出去。关掉就只提供 WS */
  servePage: boolean
  tls: {
    /** TLS 私钥路径。与 `certPath` 要么都给，要么都不给 */
    keyPath: string
    /** TLS 证书路径 */
    certPath: string
  }
  /** 上行识别：`aliyun`（真厂商）/ `canned`（零密钥冒烟）/ `<模块路径>` */
  stt: string
  /** 下行合成：`mimo` / `cosyvoice` / `silent` / `<模块路径>` */
  tts: string
  /** 接话的 agent：`dsh` / `echo` / `none` */
  agent: string
  /** dsh 的工作目录。`agent: 'dsh'` 时才有意义；留空用当前目录 */
  workDir: string
  /** v1 手机的型号提示（见 `src/voice/devices/`）。浏览器自报 v2 能力，用不到它 */
  device: string
}

export const Config: Schema<VoiceWebConfig> = Schema.object({
  port: Schema.natural().max(65535).default(8767).description('浏览器连的 WS 端口'),
  host: Schema.string().default('127.0.0.1').description('监听地址；非本机地址要求 TLS 与来源白名单同时配齐'),
  origins: Schema.array(Schema.string()).default([]).description('允许的页面来源，如 https://<域名>；留空只放同源'),
  servePage: Schema.boolean().default(true).description('是否在同一端口把页面发出去（关掉就只提供 WS）'),
  tls: Schema.object({
    keyPath: Schema.string().default('').description('TLS 私钥路径'),
    certPath: Schema.string().default('').description('TLS 证书路径'),
  }),
  stt: Schema.string().default('aliyun').description('上行识别实现：aliyun / canned / <模块路径>'),
  tts: Schema.string().default('mimo').description('下行合成实现：mimo / cosyvoice / silent / <模块路径>'),
  agent: Schema.string().default('dsh').description('接话的 agent：dsh / echo / none'),
  workDir: Schema.string().default('').description('dsh 工作目录；留空 = 当前目录'),
  device: Schema.string().default('').description('v1 手机的型号提示；浏览器用不到'),
})

export function apply(ctx: Context, config: VoiceWebConfig): void {
  const logger = ctx.logger('voice-web')

  // 配置一写错就在加载时报，不等浏览器连上来才发现
  const hasTls = config.tls.keyPath !== '' && config.tls.certPath !== ''
  if (!hasTls && (config.tls.keyPath !== '' || config.tls.certPath !== '')) {
    throw new Error('voice-web: tls.keyPath 与 tls.certPath 必须成对给，只给一半等于把连接降级成明文')
  }
  const safety = checkBindSafety({ host: config.host, hasTls, hasAuth: true })
  if (!safety.ok) {
    throw new Error(`voice-web: ${safety.message}`)
  }
  // 非本机地址必须明说来源：wss 下浏览器不替服务端拦跨站页面，
  // 一个任意网页就能接上来推流。同源兜底在这里不够用。
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.origins.length === 0) {
    throw new Error('voice-web: 监听非本机地址时必须配 origins（允许的页面来源），否则任何网页都能连上来')
  }

  ctx.effect(async () => {
    let bridge: WebBridge | null = null
    // 用对象持有 stop：赋值发生在 `onListening` 回调里，普通 `let` 会被 TS
    // 的控制流分析窄化成永远 null
    const voice: { stop: (() => void) | null } = { stop: null }
    let dshSession: DshSession | null = null
    let smartTurn: SmartTurn | null = null

    try {
      const report = (line: string): void => { logger.info(line) }
      const tls = loadTls(report)
      const authenticate = loadAuthenticator(report)
      const stt = await buildStt(config.stt, sttCreds())
      const tts = await buildTts(config.tts)
      const bundle = await buildAgent(
        config.agent,
        {
          workDir: config.workDir === '' ? process.cwd() : config.workDir,
          useSdk: process.env['MIAI_DSH_SDK'] === '1',
          provider: process.env['MIAI_DSH_PROVIDER'] ?? 'deepseek-official',
          model: process.env['MIAI_DSH_MODEL'] ?? 'deepseek-flash',
          log: report,
        },
        null,
      )
      dshSession = bundle.dsh
      const agent = bundle.agent
      if (agent === null) {
        throw new Error(`agent=${config.agent} 没有产出 agent，语音栈起来也没人接话`)
      }

      // 判停侧车与 CLI 同一套环境变量。少了它 web 会退回固定合并窗口，
      // 判停明显变差 —— 那不是"兼容性差异"，是功能缺失。
      const smartTurnPython = process.env['SMART_TURN_PYTHON'] ?? ''
      const smartTurnScript = process.env['SMART_TURN_SCRIPT'] ?? ''
      const smartTurnEnabled = process.env['SMART_TURN'] !== '0'
        && smartTurnPython !== '' && smartTurnScript !== ''
      const smartTurnClient = smartTurnEnabled
        ? new SmartTurn({
          python: smartTurnPython,
          script: smartTurnScript,
          log: report,
        })
        : null
      if (smartTurnClient !== null) {
        // 低幅正弦而不是全零：全零在 log-mel 里是 −∞ dB，不该拿它当"正常输入"试模型
        const warmup = Buffer.alloc(UPSTREAM_SAMPLE_RATE * 2)
        for (let i = 0; i < warmup.length / 2; i += 1) {
          warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2)
        }
        const startedAt = Date.now()
        const p = await smartTurnClient.predict(warmup)
        logger.info(`判停侧车预热 ${Date.now() - startedAt} ms（p=${p.toFixed(3)}）`)
      }
      smartTurn = smartTurnClient

      // 语音栈先起：端口 0 → 等它报出真实端口，再把桥接上去
      const voicePort = await new Promise<number>((resolve) => {
        void runVoiceServer({
          port: 0,
          host: '127.0.0.1',
          device: config.device,
          ffmpegPath: process.env['MIAI_FFMPEG'] ?? 'ffmpeg',
          agent,
          stt,
          tts,
          ...(smartTurnClient === null ? {} : {
            smartTurn: {
              pythonPath: smartTurnPython,
              scriptPath: smartTurnScript,
              quietMs: envNumber('SMART_TURN_QUIET_MS', 0),
              extendMs: envNumber('SMART_TURN_EXTEND_MS', 400),
              maxExtensions: envNumber('SMART_TURN_MAX_EXT', 7),
              threshold: envNumber('SMART_TURN_THRESHOLD', 0.5),
              unfinishedWaitMs: envNumber('SMART_TURN_UNFINISHED_MS', 250),
              partialGraceMs: envNumber('SMART_TURN_PARTIAL_GRACE_MS', 150),
            },
            smartTurnClient,
          }),
          gate: {
            thresholdDbfs: envNumber('VOICE_PEAK_DBFS', -40),
            holdMs: envNumber('VOICE_HOLD_MS', 2000),
            prerollMs: envNumber('VOICE_PREROLL_MS', 800),
            pauseDetectMs: envNumber('VOICE_PAUSE_DETECT_MS', 200),
            speculateMs: envNumber('VOICE_SPECULATE_MS', 100),
          },
          playbackTailMs: 600,
          micGain: envNumber('MIAI_MIC_GAIN', 1),
          ttsGain: envNumber('MIAI_TTS_GAIN', 1),
          levelLogMs: envNumber('MIAI_LEVEL_LOG', 0),
          archiveDir: process.env['MIAI_ARCHIVE_DIR'] ?? '',
          archiveMaxMb: envNumber('MIAI_ARCHIVE_MAX_MB', 80),
          archiveKeep: envNumber('MIAI_ARCHIVE_KEEP', 20),
          photoDir: process.env['PHOTO_DIR'] ?? '',
          // 内部端口是 0（系统随机），控制口交给系统另挑一个 —— 浏览器没有拍照，
          // 这个口不会有真实流量，但不能省：类型上是必填，且留空会撞端口
          controlPort: envNumber('PHOTO_CTL_PORT', 0),
          photoTimeoutMs: envNumber('MIAI_PHOTO_TIMEOUT_MS', 20_000),
          confirmTimeoutMs: envNumber('MIAI_CONFIRM_TIMEOUT_MS', 30_000),
          imageQuestion: '这张图里有什么？用一两句话口语化描述。',
          tls,
          authenticate,
          idleTimeoutMs: envNumber('MIAI_IDLE_TIMEOUT_MS', 45_000),
          serve: true,
          onListening: (info) => {
            voice.stop = info.stop
            resolve(info.port)
          },
        })
          .then((code) => { logger.info(`语音栈退出 ${code}`) })
          .catch((error: unknown) => {
            logger.error(`语音栈启动失败: ${(error as Error).message}`)
            resolve(0)
          })
      })
      if (voicePort === 0) {
        throw new Error('语音栈没有起来，桥不接')
      }

      bridge = await startWebBridge({
        port: config.port,
        host: config.host,
        voicePort,
        ...(tls === undefined ? {} : { tls }),
        origins: config.origins,
        // 编译产物在 lib/，页面在包根的 demo/ —— 两者都随包发布
        webDir: config.servePage ? join(import.meta.dirname, '..', 'demo') : '',
        log: report,
      })
      logger.info(`就绪：浏览器 → :${bridge.port} → 语音栈 127.0.0.1:${voicePort}`)
      if (config.servePage) {
        // 这行走 console 而不是 logger：logger 的输出去处看不到，
        // 而「去哪个地址打开」是人唯一必须知道的一条
        const scheme = tls === undefined ? 'http' : 'https'
        const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
        console.log(`\nweb       ${scheme}://${shown}:${bridge.port}/   ← 浏览器打开这个地址\n`)
      }
    } catch (error) {
      // 装配半途失败时把已经起来的收掉，不留「只有桥没有栈」的状态
      await bridge?.close()
      voice.stop?.()
      smartTurn?.stop()
      dshSession?.stop()
      if (error instanceof AssemblyError) {
        throw new Error(`voice-web: ${error.message}`)
      }
      throw error
    }

    return async () => {
      // 先断桥：它的 TCP 客户端一断，语音栈那边每条连接的看门狗就停了，
      // 之后 `server.close()` 才真的能在没有活动连接的情况下收尾。
      await bridge?.close()
      voice.stop?.()
      smartTurn?.stop()
      dshSession?.stop()
    }
  }, 'voice-web')
}
