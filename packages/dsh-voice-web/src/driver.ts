/**
 * dsh 插件入口（web 兼容层）。
 *
 * 一条链：浏览器 ⇄ WS ⇄ 本进程的桥 ⇄ TCP 127.0.0.1 ⇄ 本进程内的语音栈。
 * 语音栈就是包① 那一套（`src/voice/` 是它的副本，由 `scripts/sync-runtime.mjs`
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
 * - **配置错误抛异常**：`loadTls` / `loadAuthenticator` 在 CLI 里是 `process.exit(2)`，
 *   这里跑在 dsh 进程内，退出会把宿主一起带走。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

import { startWebBridge, type WebBridge } from './bridge.ts'
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
import type { DshSession } from './voice/session.ts'

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
  /** 上行识别：`aliyun` / `qwen-realtime` / `canned` / `<模块路径>` */
  stt: string
  /** 下行合成：`cosyvoice` / `omni` / `mimo` / `silent` / `<模块路径>` */
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
  stt: Schema.string().default('aliyun').description('上行识别实现：aliyun / qwen-realtime / canned / <模块路径>'),
  tts: Schema.string().default('cosyvoice').description('下行合成实现：cosyvoice / omni / mimo / silent / <模块路径>'),
  agent: Schema.string().default('dsh').description('接话的 agent：dsh / echo / none'),
  workDir: Schema.string().default('').description('dsh 工作目录；留空 = 当前目录'),
  device: Schema.string().default('').description('v1 手机的型号提示；浏览器用不到'),
})

export function apply(ctx: Context, config: VoiceWebConfig): void {
  const logger = ctx.logger('voice-web')

  // 配置一写错就在加载时报，不等浏览器连上来才发现
  if ((config.tls.keyPath === '') !== (config.tls.certPath === '')) {
    throw new Error('voice-web: tls.keyPath 与 tls.certPath 必须成对给，只给一半等于把连接降级成明文')
  }
  // 非本机地址必须明说来源：wss 下浏览器不替服务端拦跨站页面，
  // 一个任意网页就能接上来推流。同源兜底在这里不够用。
  if (!isLoopbackHost(config.host) && config.origins.length === 0) {
    throw new Error('voice-web: 监听非本机地址时必须配 origins（允许的页面来源），否则任何网页都能连上来')
  }

  ctx.effect(async () => {
    let bridge: WebBridge | null = null
    // 用对象持有 stop：赋值发生在 `onListening` 回调里，普通 `let` 会被 TS
    // 的控制流分析窄化成永远 null
    const voice: { stop: (() => void) | null } = { stop: null }
    let dshSession: DshSession | null = null
    let turnJudge: TurnJudge | null = null
    let streaming: AssembledStreamingPipeline | null = null
    let stopKeepalive: () => void = () => {}

    try {
      // 运维看的是这一路：与 CLI 一致打到 stdout。`logger` 的输出在 dsh 里看不到，
      // 而「管道是哪条」「快车道开没开」「判停接没接上」必须能一眼确认。
      const report = (line: string): void => { console.log(line) }

      // `process.cwd()/.env`。dsh 自己会经 `@deepseek-ai/dsh-launch-environment`
      // 把调用目录的 `.env` 合并进 `process.env`，所以这里通常返回 0；留着是因为
      // 别的宿主不一定这么做，而"配了密钥却说没配"很难查。
      // 必须在 `buildStt` / `buildTts` **之前** —— 那两个函数直接读 process.env。
      const loaded = loadDotEnv()
      if (loaded > 0) {
        report(`凭据    ${process.cwd()}\\.env（${loaded} 项）`)
      }
      const keepAliveMs = envNumber('MIAI_HTTP_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS)
      installHttpAgent(keepAliveMs)
      report(`HTTP     连接保活 ${keepAliveMs} ms（默认 4 秒会让每轮重新握手）`)

      // 审计出口自己造一份：`createAuditSlot()` 是每个宿主一份，不共用包① 的全局槽。
      // TTS provider 与流式装配都往这里写，`setAudit` 再把「当前连接」的档案挂上来。
      const auditSlot = createAuditSlot()
      const audit = (event: string, data: Record<string, unknown>): void => {
        auditSlot.emit(event, data)
      }

      const tls = loadBridgeTls(config)
      const authenticate = loadAuthenticator(report)
      // 鉴权是「配了才有」，所以这条判据必须拿到 `authenticate` 之后才能算 ——
      // 以前无条件写 `hasAuth: true`，等于在非本机地址上假装有鉴权。
      const safety = checkBindSafety({
        host: config.host,
        hasTls: tls !== undefined,
        hasAuth: authenticate !== undefined,
      })
      if (!safety.ok) {
        throw new Error(`voice-web: ${safety.message}`)
      }

      const workDir = config.workDir === '' ? process.cwd() : config.workDir
      const memoryPath = process.env['MEMORY_FILE'] ?? join(workDir, 'MEMORY.md')
      const memoryFile = new MemoryFile(memoryPath)
      const corpusText = loadStaticAsrCorpus(memoryFile.hotwordHints(), process.env)
      const language = resolveAsrLanguage(process.env)
      const stt = await buildStt(config.stt, { ...sttCreds(), corpusText, language })
      const tts = await buildTts(config.tts, audit)
      report(`可替换件 STT=${stt.name}  TTS=${tts.name}（${tts.sampleRate} Hz）`)
      // 与 CLI 同一个队列：任务结果离线时先存着，重连后补播
      const announceStore = AnnounceStore.open({
        file: process.env['MIAI_ANNOUNCE_FILE'] ?? join(homedir(), '.voice-agent', 'announce.jsonl'),
        maxItems: envNumber('MIAI_ANNOUNCE_MAX', DEFAULT_ANNOUNCE_MAX),
        log: report,
      })

      const bundle = await buildAgent(
        config.agent,
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
      if (bundle.agent === null) {
        throw new Error(`agent=${config.agent} 没有产出 agent，语音栈起来也没人接话`)
      }
      const baseAgent = bundle.agent
      let agent = baseAgent

      /**
       * 主管道。判据、强校验、`live` 的 `qwen-realtime` 前提全在包① 的纯函数里 ——
       * 这里只传「当前选的 STT 叫什么」。
       *
       * 非 dsh（`echo` / `none`）不装管道：与 CLI 一致，那两条路本来就没有快车道。
       */
      const plan = config.agent === 'dsh'
        ? assemblePipelinePlan(process.env, { sttName: config.stt, strict: true })
        : null

      if (plan !== null) {
        report(
          `管道      ${plan.mode === 'live' ? 'Pure Live（Omni 单前台 + dsh 纯异步后台）' : 'Pure Cascade（ASR + 级联快车道/dsh + TTS）'}`
          + `${plan.explicit ? ' [VOICE_PIPELINE]' : ' [兼容推断]'}`,
        )
        for (const note of plan.notes) {
          report(`          ${note}`)
        }

        const session = dshSession
        if (session === null) {
          throw new Error('管道装配需要 dsh 会话，但 agent 不是 dsh')
        }
        const activity = newActivityState(Date.now())

        // 投机只在级联 + 真有快车道时才问；live 不加载文本快车道，问了也没用
        const speculate = plan.mode === 'cascade' && plan.useCascadeFastLane
          ? await resolveSpeculate(session, report)
          : false

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
          taskStatus: () => session.taskStatus(),
          audit,
          speculate,
          announceStore,
          log: report,
          memorySummary: () => memoryFile.summary(),
          asrCorpusText: corpusText,
          asrLanguage: language,
        })
        agent = streaming.agent
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
                await baseAgent.reply(KEEPALIVE_PROMPT)
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
        sttSpec: config.stt,
        turnJudgeEnabled,
        turnJudgePython,
        turnJudgeScript,
        semanticEnabled,
        overrides: { micGain: 1, controlPort: 0 },
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

      // 语音栈先起：端口 0 → `onListening` 报出真实端口，再把桥接上去。
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
          archiveDir: process.env['MIAI_ARCHIVE_DIR'] ?? '',
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
      turnJudge?.stop()
      streaming?.dispose()
      stopKeepalive()
      dshSession?.stop()
      throw new Error(`voice-web: ${(error as Error).message}`)
    }

    return async () => {
      // 先断桥：它的 TCP 客户端一断，语音栈那边每条连接的看门狗就停了。
      // 再 `stop()`：关监听、断掉残留连接、`runVoiceServer` 的 finally 关控制口 ——
      // 这才是 dsh 卸载/重载插件时不泄漏的原因。
      await bridge?.close()
      voice.stop?.()
      turnJudge?.stop()
      streaming?.dispose()
      stopKeepalive()
      dshSession?.stop()
    }
  }, 'voice-web')
}
