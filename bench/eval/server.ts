/**
 * 隔离评测沙盒服务端：用生产同一套装配（`assemblePipelinePlan` + `assembleStreamingAgent` + `runVoiceServer`）
 * 监听本地回环口，**绝不碰生产端口、生产 MEMORY.md、生产会话档案与 systemd 服务**。
 *
 * 两种后台模式：
 * - 默认（记录型 stub `dsh`）：100% 走真实 `LiveOrchestrator` / `BackgroundTaskBus` / `OmniShadow` /
 *   `QwenRealtimeAsr` / `TurnJudge` / `SemanticEndpoint`，只把最底层 `dshAgent.reply()` 换成
 *   可观测记录桩，全量把 `query` / `note` / `bg-reports` 落盘，方便精确量化路由与跨轨上下文。
 * - `--real-dsh`：接入隔离 `workDir` 下的真实 `DshSession`（用于端到端抽检 `remember` 与工具链）。
 *
 * 用法：
 *   node bench/eval/server.ts --env-file <部署路径>/.env --port 18766 --pipeline live --out-dir /tmp/miai-eval/run1
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { VoiceAgent } from '../../src/agent.ts';
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from '../../src/announce-store.ts';
import { cosyVoiceTts, DEFAULT_COSYVOICE_EMOTION_MODE } from '../../src/cosyvoice.ts';
import { EVENTS } from '../../src/events.ts';
import { DEFAULT_KEEPALIVE_MS, installHttpAgent } from '../../src/http-agent.ts';
import { newActivityState } from '../../src/keepalive.ts';
import {
  assemblePipelinePlan,
  assembleStreamingAgent,
  createAuditSlot,
  formatCurrentDateContext,
  isMainModule,
  loadStaticAsrCorpus,
  resolveAsrLanguage,
} from '../../src/main.ts';
import { MemoryFile } from '../../src/memory-file.ts';
import { omniTts } from '../../src/omni-tts.ts';
import {
  cannedStt,
  silentTts,
  type AgentImage,
  type AgentProvider,
  type AgentReplyView,
  type SttProvider,
  type TtsProvider,
  type TurnContext,
} from '../../src/providers.ts';
import { qwenRealtimeStt } from '../../src/qwen-realtime-asr.ts';
import { semanticEndpoint } from '../../src/semantic-endpoint.ts';
import { DshSession } from '../../src/session.ts';
import { sampleSocket } from '../../src/socket-stats.ts';
import { TurnJudge } from '../../src/turn-judge.ts';
import { envNumber, envString, sleep } from '../../src/util.ts';
import { buildVoiceRuntimeConfig } from '../../src/voice-config.ts';
import { runVoiceServer, UPSTREAM_SAMPLE_RATE } from '../../src/voice-session.ts';
import type { BgReportRecord, DshCallRecord, EvalCase, EvalManifest } from './types.ts';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? fallback) : fallback;
}

function loadEnvFile(path: string): void {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，。、！？；：,.!?;:"'“”‘’《》【】()（）\-—]/gu, '');
}

/** 字符 bigram 相似度，用于把 `dsh` 收到的改写/原话匹配到清单里的预设 stub 答复 */
function matchManifestCase(query: string, cases: readonly EvalCase[]): EvalCase | null {
  const qNorm = normalize(query);
  if (qNorm === '') return null;
  let best: { item: EvalCase; score: number } | null = null;
  for (const item of cases) {
    if (item.stubReply === undefined) continue;
    const tNorm = normalize(item.text);
    if (qNorm.includes(tNorm) || tNorm.includes(qNorm)) {
      return item;
    }
    let hits = 0;
    const total = Math.max(1, tNorm.length - 1);
    for (let i = 0; i + 1 < tNorm.length; i += 1) {
      if (qNorm.includes(tNorm.slice(i, i + 2))) hits += 1;
    }
    const score = hits / total;
    if (score >= 0.35 && (best === null || score > best.score)) {
      best = { item, score };
    }
  }
  return best?.item ?? null;
}

/** 可观测记录型 stub `dshAgent`：落盘每次调用的完整 `userText` + `note`，并按清单返回可控结果 */
export function createRecordingStubDsh(options: {
  readonly cases: readonly EvalCase[];
  readonly callsFile: string;
  readonly log: (line: string) => void;
}): AgentProvider {
  let seq = 0;
  return {
    name: 'eval-stub-dsh',
    async reply(
      userText: string,
      image?: AgentImage,
      note?: string,
      _turn?: TurnContext,
    ): Promise<AgentReplyView> {
      seq += 1;
      const matched = matchManifestCase(userText, options.cases);
      const delayMs = matched?.stubDelayMs ?? 300;
      await sleep(delayMs);
      const speech = matched?.stubReply ?? `已处理：${userText.slice(0, 40)}`;
      const record: DshCallRecord = {
        seq,
        ts: Date.now(),
        userText,
        note: note ?? '',
        hasImage: image !== undefined,
        returnedSpeech: speech,
        matchedCaseId: matched?.id ?? null,
      };
      appendFileSync(options.callsFile, `${JSON.stringify(record)}\n`, 'utf8');
      options.log(
        `  [eval-dsh#${seq}] matched=${record.matchedCaseId ?? 'none'} q=${JSON.stringify(userText.slice(0, 40))}`,
      );
      return { text: speech, speech, emotion: 'calm' };
    },
    cancelTurn(): void {
      // stub 取消空操作
    },
    setAnnouncer(): void {
      // 由 LiveOrchestrator 接入总线
    },
    setDetachedAnswerSink(): void {
      // 兼容 cascade
    },
    detachTurn(): void {
      // 兼容 cascade
    },
  };
}

async function buildEvalStt(
  spec: string,
  log: (line: string) => void,
  corpusText: string,
  language: string | undefined,
): Promise<SttProvider> {
  if (spec === 'canned') return cannedStt();
  if (spec === 'qwen-realtime') {
    const apiKey = (process.env['DASHSCOPE_API_KEY'] ?? '').trim();
    if (!apiKey) throw new Error('STT=qwen-realtime 需要 DASHSCOPE_API_KEY');
    const turnDetection = process.env['QWEN_ASR_TURN_DETECTION'] === 'vad' ? 'vad' : 'manual';
    return qwenRealtimeStt(
      {
        apiKey,
        ...(process.env['QWEN_ASR_URL'] ? { url: process.env['QWEN_ASR_URL'] } : {}),
        ...(process.env['QWEN_ASR_MODEL'] ? { model: process.env['QWEN_ASR_MODEL'] } : {}),
        turnDetection,
        corpusText,
        language,
      },
      (line) => { log(`  [asr] ${line}`); },
    );
  }
  throw new Error(`评测服务端暂只支持 --stt qwen-realtime|canned，收到 ${spec}`);
}

async function buildEvalTts(
  spec: string,
  auditEmit: (name: string, data: Record<string, unknown>) => void,
  log: (line: string) => void,
): Promise<TtsProvider> {
  if (spec === 'silent') return silentTts(24_000);
  if (spec === 'omni') {
    const apiKey = (process.env['DASHSCOPE_API_KEY'] ?? '').trim();
    if (!apiKey) throw new Error('TTS=omni 需要 DASHSCOPE_API_KEY');
    return omniTts({
      apiKey,
      model: process.env['OMNI_SHADOW_MODEL'],
      log,
    });
  }
  if (spec === 'cosyvoice') {
    const apiKey = (process.env['DASHSCOPE_API_KEY'] ?? '').trim();
    if (!apiKey) throw new Error('TTS=cosyvoice 需要 DASHSCOPE_API_KEY');
    return cosyVoiceTts({
      apiKey,
      url: process.env['COSYVOICE_URL'],
      model: process.env['COSYVOICE_MODEL'],
      voice: process.env['COSYVOICE_VOICE'],
      useInstruction:
        (process.env['COSYVOICE_EMOTION_MODE'] ?? DEFAULT_COSYVOICE_EMOTION_MODE) === 'instruction',
      onTask: (info) => { auditEmit(EVENTS.ttsTask, { ...info }); },
      onDone: (info) => { auditEmit(EVENTS.ttsDone, { ...info }); },
      onStall: (info) => {
        void sampleSocket(info.local_port).then((socket) => {
          auditEmit(EVENTS.ttsStall, { ...info, socket });
        });
      },
    });
  }
  throw new Error(`评测服务端暂只支持 --tts omni|cosyvoice|silent，收到 ${spec}`);
}

async function main(): Promise<void> {
  const envFile = arg('env-file', '');
  if (envFile) loadEnvFile(resolve(envFile));

  const port = Number(arg('port', '18766'));
  const pipeline = arg('pipeline', 'live');
  const sttSpec = arg('stt', process.env['MIAI_STT'] ?? 'qwen-realtime');
  const ttsSpec = arg('tts', process.env['MIAI_TTS'] ?? 'omni');
  const manifestPath = resolve(arg('manifest', 'bench/eval/manifest.json'));
  const outDir = resolve(arg('out-dir', 'bench/eval/out/server'));
  const realDsh = process.argv.includes('--real-dsh');
  const noTurnJudge = process.argv.includes('--no-turn-judge');
  const noSemantic = process.argv.includes('--no-semantic');

  mkdirSync(outDir, { recursive: true });
  const archiveDir = join(outDir, 'archives');
  const workDir = join(outDir, 'workspace');
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvalManifest;
  const allCases = manifest.sessions.flatMap((s) => s.cases);

  // 隔离长期记忆：写进沙盒 workDir/MEMORY.md（与生产一致，真实 dsh 的 agent-instructions 也能读到）
  const memoryPath = join(workDir, 'MEMORY.md');
  writeFileSync(memoryPath, `# Eval Seed Memory\n\n${manifest.memorySeed.join('\n')}\n`, 'utf8');
  const memoryFile = new MemoryFile(memoryPath);

  // 隔离离线播报队列
  const announceFile = join(outDir, 'announce.jsonl');
  const announceStore = AnnounceStore.open({
    file: announceFile,
    maxItems: DEFAULT_ANNOUNCE_MAX,
    log: (line) => { console.log(line); },
  });

  const dshCallsFile = join(outDir, 'dsh-calls.jsonl');
  const bgReportsFile = join(outDir, 'bg-reports.jsonl');
  writeFileSync(dshCallsFile, '', 'utf8');
  writeFileSync(bgReportsFile, '', 'utf8');

  const env: Record<string, string | undefined> = {
    ...process.env,
    VOICE_PIPELINE: pipeline,
    MEMORY_FILE: memoryPath,
    MIAI_ARCHIVE_DIR: archiveDir,
    MIAI_ANNOUNCE_FILE: announceFile,
  };

  // 与生产同一对旋钮：QWEN_ASR_CORPUS=0 清空静态热词，QWEN_ASR_LANGUAGE=auto|off|'' 不锁语言。
  const corpusText = loadStaticAsrCorpus(memoryFile.hotwordHints(), env);
  const language = resolveAsrLanguage(env);

  installHttpAgent(DEFAULT_KEEPALIVE_MS);

  const auditSlot = createAuditSlot();
  const log = (line: string): void => { console.log(line); };

  const plan = assemblePipelinePlan(env, { sttName: sttSpec, strict: true });
  log(`[eval-server] pipeline=${plan.mode} stt=${sttSpec} tts=${ttsSpec} backend=${realDsh ? 'real-dsh' : 'stub'} port=${port}`);
  log(`[eval-server] corpus=${corpusText.length} chars  lang=${language ?? 'auto'}  memSummary=${memoryFile.summary().length} chars`);

  const stt = await buildEvalStt(sttSpec, log, corpusText, language);
  const tts = await buildEvalTts(ttsSpec, (name, data) => { auditSlot.emit(name, data); }, log);

  let dshSession: DshSession | null = null;
  let dshAgent: AgentProvider;
  if (realDsh) {
    dshSession = new DshSession({
      workDir,
      program: process.env['DSH_BIN'],
      mode: 'sdk',
      patch: process.env['DSH_PATCH'],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      log: (l) => { log(`  [dsh] ${l}`); },
    });
    const inner: AgentProvider = new VoiceAgent(dshSession, log, announceStore);
    // 包一层记录实际发给真实 dsh 的每次调用
    let seq = 0;
    dshAgent = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'reply') {
          return async (userText: string, image?: AgentImage, note?: string, turn?: TurnContext) => {
            seq += 1;
            const res = await target.reply(userText, image, note, turn);
            const rec: DshCallRecord = {
              seq,
              ts: Date.now(),
              userText,
              note: note ?? '',
              hasImage: image !== undefined,
              returnedSpeech: res.speech,
              matchedCaseId: null,
            };
            appendFileSync(dshCallsFile, `${JSON.stringify(rec)}\n`, 'utf8');
            return res;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  } else {
    dshAgent = createRecordingStubDsh({ cases: allCases, callsFile: dshCallsFile, log });
  }

  const activity = newActivityState(Date.now());
  const streaming = assembleStreamingAgent({
    plan,
    env,
    dshAgent,
    tts,
    activity,
    memory: (text) => memoryFile.relevant(text).join('\n'),
    taskStatus: () => dshSession?.taskStatus() ?? '',
    audit: (name, data) => { auditSlot.emit(name, data); },
    speculate: false,
    announceStore,
    log,
    memorySummary: () => memoryFile.summary(),
    clockContext: () => formatCurrentDateContext(),
    asrCorpusText: corpusText,
    asrLanguage: language,
  });

  // 包一层只读观测后台汇报：完整记录 Omni 空窗播报与逐字 TTS fallback 的文本与结果
  const recordBg = (rec: BgReportRecord): void => {
    appendFileSync(bgReportsFile, `${JSON.stringify(rec)}\n`, 'utf8');
  };
  const wrappedSpeakAnnounce = streaming.speakAnnounce === undefined
    ? undefined
    : async (
      item: Parameters<NonNullable<typeof streaming.speakAnnounce>>[0],
      playAudio: Parameters<NonNullable<typeof streaming.speakAnnounce>>[1],
    ): Promise<'spoken' | 'defer' | 'fallback'> => {
      let played: { spokenBytes: number; interrupted: boolean; transcript: string } | null = null;
      const result = await streaming.speakAnnounce!(item, async (answer) => {
        const res = await playAudio(answer);
        played = { ...res };
        return res;
      });
      recordBg({
        ts: Date.now(),
        kind: 'omni_attempt',
        taskId: item.taskId,
        query: item.query,
        speech: item.speech,
        verbatim: item.verbatim,
        result,
        ...(played === null ? {} : {
          spokenBytes: (played as { spokenBytes: number }).spokenBytes,
          interrupted: (played as { interrupted: boolean }).interrupted,
          transcript: (played as { transcript: string }).transcript,
        }),
      });
      return result;
    };
  const wrappedFallbackSpoken = streaming.onFallbackAnnounceSpoken === undefined
    ? undefined
    : (
      item: Parameters<NonNullable<typeof streaming.onFallbackAnnounceSpoken>>[0],
      interrupted: boolean,
    ): void => {
      recordBg({
        ts: Date.now(),
        kind: 'fallback_spoken',
        taskId: item.taskId,
        query: item.query,
        speech: item.speech,
        verbatim: item.verbatim,
        interrupted,
      });
      streaming.onFallbackAnnounceSpoken!(item, interrupted);
    };

  // 判停侧车：与生产 `main.ts` 参数保持 100% 一致
  const turnJudgePython = envString('TURN_JUDGE_PYTHON') ?? '';
  const turnJudgeScript = envString('TURN_JUDGE_SCRIPT') ?? '';
  const turnJudgeEnabled = !noTurnJudge
    && envString('TURN_JUDGE') !== '0'
    && turnJudgePython !== ''
    && turnJudgeScript !== ''
    && existsSync(turnJudgeScript);
  const turnJudgeClient = turnJudgeEnabled
    ? new TurnJudge({
      python: turnJudgePython,
      script: turnJudgeScript,
      log: (line) => { log(`  ${line}`); },
    })
    : null;
  if (turnJudgeClient !== null) {
    const warmup = Buffer.alloc(UPSTREAM_SAMPLE_RATE * 2);
    for (let i = 0; i < warmup.length / 2; i += 1) {
      warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2);
    }
    const t0 = Date.now();
    const p = await turnJudgeClient.predict(warmup);
    log(`[eval-server] 判停侧车预热 ${Date.now() - t0} ms（p=${p.toFixed(3)}）`);
  }

  const semanticKey = (env['FAST_LANE_API_KEY'] ?? env['DEEPSEEK_API_KEY'] ?? '').trim();
  const semanticEnabled = !noSemantic
    && (plan.mode === 'live'
      ? envString('SEMANTIC_END_TAG') === '1'
      : envString('SEMANTIC_END_TAG') !== '0')
    && semanticKey !== '';
  // 与 CLI 同一套默认值。沙盒只显式加长空闲、放大档案、缩短拍照等待。
  const voice = buildVoiceRuntimeConfig({
    env,
    sttSpec,
    pipelineMode: plan.mode,
    turnJudgeEnabled,
    turnJudgePython,
    turnJudgeScript,
    semanticEnabled,
    overrides: {
      idleTimeoutMs: 120_000,
      archiveMaxMb: 200,
      archiveKeep: 100,
      photoTimeoutMs: 20_000,
    },
  });
  const semantic = semanticEnabled
    ? semanticEndpoint({
      apiKey: semanticKey,
      ...(env['FAST_LANE_MODEL'] === undefined ? {} : { model: env['FAST_LANE_MODEL'] }),
      ...(env['FAST_LANE_BASE_URL'] === undefined ? {} : { baseUrl: env['FAST_LANE_BASE_URL'] }),
      timeoutMs: voice.semanticTimeoutMs,
      log,
    })
    : null;

  const cleanup = (): void => {
    turnJudgeClient?.stop();
    streaming.dispose();
    dshSession?.stop();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  const code = await runVoiceServer({
    port,
    host: '127.0.0.1',
    ffmpegPath: env['MIAI_FFMPEG'] ?? 'ffmpeg',
    agent: streaming.agent,
    stt,
    tts,
    pipelineMode: plan.mode,
    ...(streaming.engine === undefined ? {} : { engine: streaming.engine }),
    ...(wrappedSpeakAnnounce === undefined
      ? {}
      : {
        speakAnnounce: wrappedSpeakAnnounce,
        cancelAnnounce: streaming.cancelAnnounce,
        onFallbackAnnounceSpoken: wrappedFallbackSpoken,
      }),
    ...(streaming.omniShadow === undefined ? {} : { omniShadow: streaming.omniShadow }),
    ...(voice.turnJudge === undefined ? {} : { turnJudge: voice.turnJudge }),
    ...(turnJudgeClient === null ? {} : { turnJudgeClient }),
    ...(semantic === null
      ? {}
      : { semantic, semanticBudgetMs: voice.semanticBudgetMs }),
    gate: voice.gate,
    playbackTailMs: voice.playbackTailMs,
    ttsGain: envNumber('MIAI_TTS_GAIN', 1),
    micGain: voice.micGain,
    levelLogMs: 0,
    archiveDir,
    archiveMaxMb: voice.archiveMaxMb,
    archiveKeep: voice.archiveKeep,
    setAudit: (sink, expected) => { auditSlot.set(sink, expected); },
    photoDir: '',
    controlPort: 0,
    photoTimeoutMs: voice.photoTimeoutMs,
    confirmTimeoutMs: voice.confirmTimeoutMs,
    imageQuestion: voice.imageQuestion,
    announceStore,
    idleTimeoutMs: voice.idleTimeoutMs,
    serve: true,
  });
  cleanup();
  process.exit(code);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[eval-server] 失败: ${(err as Error).message}`);
    process.exit(1);
  });
}
