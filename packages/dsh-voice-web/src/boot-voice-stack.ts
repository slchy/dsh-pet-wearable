/**
 * 启动里层语音栈。
 *
 * 直接调用 voice/runtime/ 里与 CLI 相同的装配函数：工厂、环境、审计槽、
 * 管道装配、ASR 上下文。插件不经过 CLI 入口，配置错误只抛异常。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Logger } from '@deepseek-ai/cordis'

import {
  formatArchiveBanner,
  isDshBackedAgent,
  pureLiveVadConflict,
  resolveArchiveDir,
  shouldEnableSemanticEndpoint,
  shouldUsePureLiveAudio,
  type VoiceBackendState,
  type VoiceWebConfig,
} from './driver-policy.ts'
import {
  dshHomeDir,
  loadDshHomeDotEnv,
  loadPersistedSessionId,
  readSessionController,
} from './host-lifecycle.ts'
import type { HostMountHandle } from './host-mount.ts'
import { InProcessDshAgent } from './in-process-agent.ts'
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './voice/announce-store.ts'
import { DEFAULT_KEEPALIVE_MS, installHttpAgent } from './voice/http-agent.ts'
import {
  KEEPALIVE_PROMPT,
  newActivityState,
  startKeepalive,
  systemClock,
} from './voice/keepalive.ts'
import { MemoryFile } from './voice/memory-file.ts'
import type { AgentProvider } from './voice/providers.ts'
import { loadStaticAsrCorpus, resolveAsrLanguage } from './voice/runtime/asr-context.ts'
import { createAuditSlot } from './voice/runtime/audit-slot.ts'
import { loadAuthenticator, loadDotEnv } from './voice/runtime/env-bootstrap.ts'
import { loadSharedVad } from './voice/runtime/vad-bootstrap.ts'
import {
  assemblePipelinePlan,
  assembleStreamingAgent,
  type AssembledStreamingPipeline,
} from './voice/runtime/pipeline-assembly.ts'
import { buildAgent, buildStt, buildTts } from './voice/runtime/providers-factory.ts'
import { loadSharedTurnJudge } from './voice/runtime/turn-judge-bootstrap.ts'
import { semanticEndpoint } from './voice/semantic-endpoint.ts'
import type { DshSession } from './voice/session.ts'
import { envNumber, envString } from './voice/util.ts'
import { buildVoiceRuntimeConfig } from './voice/voice-config.ts'
import { runVoiceServer } from './voice/voice-session.ts'

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

export interface HostVoiceRuntime {
  backend: VoiceBackendState
  inProcessAgent: InProcessDshAgent | null
  dshSession: DshSession | null
  hostMount: HostMountHandle | null
}

export async function bootVoiceStack(
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
  let turnJudge: Awaited<ReturnType<typeof loadSharedTurnJudge>> = null
  let streaming: AssembledStreamingPipeline | null = null
  let stopKeepalive: () => void = () => {}
  let released = false
  let sharedVad: Awaited<ReturnType<typeof loadSharedVad>> = null

  const releaseVoice = async (): Promise<void> => {
    if (released) return
    released = true
    state.backend = { status: 'stopped' }
    if (state.inProcessAgent === inProcessAgent) state.inProcessAgent = null
    if (state.dshSession === dshSession) state.dshSession = null
    const steps: Array<() => Promise<void> | void> = [
      () => { voice.stop?.() },
      () => sharedVad?.dispose?.(),
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
    installHttpAgent(DEFAULT_KEEPALIVE_MS)
    report(`HTTP     连接保活 ${DEFAULT_KEEPALIVE_MS} ms（默认 4 秒会让每轮重新握手）`)
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
    // 浏览器档案 micGain: 1 / peakDbfs: -34 / sttCommitMs: 320 / controlPort: 0
    // 已收进 `src/voice-config.ts` 的 `DEVICE_TIMING_PROFILES.browser`。
    // 显式 `.env` 仍自动覆盖档案默认。
    //
    // 声学判停（Smart Turn v3.2）进程内一份、跨连接常驻；必须在
    // `buildVoiceRuntimeConfig` 之前加载 —— 参数表要带上实际模型路径。
    const turnJudgeClient = await loadSharedTurnJudge(process.env, report)
    const turnJudgeEnabled = turnJudgeClient !== null
    const semanticKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim()
    const semanticEnabled = shouldEnableSemanticEndpoint({
      pipelineMode: plan?.mode ?? null,
      envFlag: envString('SEMANTIC_END_TAG'),
      hasApiKey: semanticKey !== '',
    })
    const runtime = buildVoiceRuntimeConfig({
      env: process.env,
      profile: 'browser',
      ...(plan === null ? {} : { pipelineMode: plan.mode }),
      sttSpec: effectiveStt,
      turnJudgeEnabled,
      ...(turnJudgeClient === null ? {} : { turnJudgeModelPath: turnJudgeClient.modelPath }),
      semanticEnabled,
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

    turnJudge = turnJudgeClient

    sharedVad = await loadSharedVad(process.env, report)

    // 语音栈先起：端口 0 → `onListening` 报出真实端口，再把桥或宿主挂载接上去。
    // `runVoiceServer` 若在 `onListening` 之前就返回或抛错（端口冲突、绑定失败），
    // 必须 reject，否则这个 Promise 永远等不到。
    const voicePort = await new Promise<number>((resolve, reject) => {
      runVoiceServer({
        port: 0,
        host: '127.0.0.1',
        ...(sharedVad === null ? {} : { vad: sharedVad }),
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
        ...(streaming?.shouldSkipAnnounce === undefined
          ? {}
          : { shouldSkipAnnounce: streaming.shouldSkipAnnounce }),
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
        // 里层明文：桥用 `net.connect` 连进来，套上 TLS 连不上
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
