/**
 * 云端 harness：设备音频流 → 解码 → 判停 → 一轮 → TTS → 下发。
 *
 * STT / TTS / agent 都是**注入的**（见 `providers.ts`），这里只做装配：
 * 按 `--stt` / `--tts` / `--agent` 选实现，其余全是编排。
 *
 *   node src/main.ts --listen 8766                                  # 真供应商
 *   node src/main.ts --listen 8766 --stt canned --tts silent --agent echo   # 零密钥
 *
 * 旧路径（`--replay`、本地 silero-vad、MiMo ASR）见 `legacy-pipeline.ts`。
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VoiceAgent } from './agent.ts';
import { AnnounceStore, DEFAULT_ANNOUNCE_MAX } from './announce-store.ts';
import { DEFAULT_CONFIRM_TIMEOUT_MS } from './photo-inbox.ts';
import { AssemblyError, buildAgent, buildStt, buildTts, loadAuthenticator, loadDotEnv, loadTls, openAnnounceStore, wireAgent, type AgentBundle } from './assembly.ts';
import { runVoiceServer, UPSTREAM_SAMPLE_RATE } from './voice-session.ts';
import { SmartTurn } from './smart-turn.ts';
import { DEVICE_MODELS, describeCapabilities, resolveV1Device } from './devices/index.ts';
import { DEFAULT_PET_TIMING } from './pet/pet-timing.ts';
import { DEFAULT_PROACTIVE } from './pet/proactive.ts';
import { Pipeline, type ReplyMode } from './legacy-pipeline.ts';
import type { AgentProvider } from './providers.ts';
import type { DshSession } from './session.ts';
import { sleep } from './util.ts';
/**
 * 启动期配置错误：说清楚是哪一项、该怎么改，然后退出。
 *
 * 装配在 `assembly.ts`，那里抛 `AssemblyError` 而**不是** `process.exit` ——
 * 同一份装配也跑在 dsh 插件里，插件把宿主进程一起带走是不行的。
 * 退出只发生在 CLI 这一层。
 */
function fail(message: string): never {
  console.error(`\n启动失败：${message}\n`);
  process.exit(2);
}

/** 把装配层的异常转成「打一行说明 + 退出码 2」，与抽出去之前的行为一致。 */
function assemble<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof AssemblyError) {
      fail(error.message);
    }
    throw error;
  }
}

async function assembleAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AssemblyError) {
      fail(error.message);
    }
    throw error;
  }
}

// ------------------------------------------------------------------ 入口
async function runReplay(path: string, pipe: Pipeline, gapMs: number): Promise<number> {
  const data = readFileSync(path);
  console.log(`回放 ${path}  ${data.length} 字节  ${((data.length / 57) * 7.5 / 1000).toFixed(2)} s`);
  console.log(`块 570 B，间隔 ${gapMs} ms\n`);

  const CHUNK = 570;
  for (let off = 0; off < data.length; off += CHUNK) {
    if (pipe.isFinished) {
      console.log(`（已判停，停止回放于 ${off} / ${data.length} 字节）`);
      break;
    }
    pipe.feed(data.subarray(off, off + CHUNK));
    if (gapMs > 0) await sleep(gapMs);
  }

  pipe.closeInput();
  await Promise.race([pipe.wait(), sleep(30_000)]);
  return 0;
}

async function runListen(port: number, pipe: Pipeline): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server = createServer((sock) => {
      console.log(`已连接 ${sock.remoteAddress}:${sock.remotePort}\n`);
      let total = 0;
      let turns = 0;

      // 下行音频直接写回同一条连接：手机边收边播。
      pipe.setSink({
        write: (chunk: Buffer) => {
          if (!sock.destroyed) sock.write(chunk);
        },
        // 多轮：一轮结束**不发 EOF**，连接保持，手机端到 listenMs 自己断。
        end: () => {},
      });

      sock.on('data', (d: Buffer) => {
        total += d.length;
        pipe.feed(d);
      });

      // 轮次循环：一轮结束 → 等回复播完 → 重置 → 继续听
      const loop = async (): Promise<void> => {
        for (;;) {
          await pipe.wait();
          turns += 1;
          if (sock.destroyed) break;

          // 必须等回复播完再恢复收音：否则眼镜扬声器的声音会被自己的
          // 麦克风收进去，下一轮开头就变成「听到自己说话」。
          // 云端拿不到 AudioTrack 的真实播放进度，用音频时长 + 固定余量估算。
          const waitMs = pipe.replyDurationMs + 600;
          console.log(`\n--- 第 ${turns} 轮结束，${(waitMs / 1000).toFixed(1)} s 后继续听 ---`);
          await sleep(waitMs);
          if (sock.destroyed) break;

          pipe.reset();
          console.log('--- 继续听 ---\n');
        }
      };
      void loop();

      sock.on('close', () => {
        console.log(`\n连接结束，共收 ${total} 字节，${turns} 轮`);
        pipe.closeInput();
        server.close();
        resolve(0);
      });

      sock.on('error', (e: Error) => {
        console.error('socket 错误: ' + e.message);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`监听 127.0.0.1:${port}（多轮）`);
      console.log(`手机侧先执行： adb reverse tcp:${port} tcp:${port}\n`);
    });
  });
}

/**
 * 唤醒词。单独成句时**不是一轮对话**，直接丢掉。
 *
 * 实测：「小爱同学。」和「我眼前的是什么？」会被服务端拆成两个 SentenceEnd，
 * 第二个才是真正的命令。Smart Turn 对「小爱同学。」给 0.957（它确实是完整的一句话），
 * 所以模型治不了这个，只能靠这条领域规则。
 */
/**
 * 服务端判句所需静音（`max_sentence_silence`）。
 *
 * 800 → 400 → 200：这一段是**纯等待**，用户说完要干等这么久才拿到 `SentenceEnd`。
 * 同机实测 400 与 200 差 294 ms（① 中位 640 → 346），比流式 TTS 的收益还大。
 *
 * 试过 120（2026-11-17，当日回放）：**反而更慢** —— ① 中位 400 → 960。切得太碎，
 * ASR 在用户换气处就断言句，判停器随后再等一截把后半句并回来，最后一句定稿反倒
 * 更晚。数字在 README 的回放对比表里，别再凭直觉往下砍。
 *
 * 敢砍到 200 是因为下游补了一层：`max_sentence_silence` 计的是**收到的音频里的静音**，
 * 说话人在数字组之间的换气（实测 200–400 ms）会被当成句尾，实测把
 * 「#W8665881」切成两句。切早了本身不致命 —— 句段由判停器合并
 * （`UtteranceAssembler` 把连续几句拼成一轮），`unfinishedWaitMs` 再专门兜
 * 「结尾是数字/井号/连词」那一类。
 *
 * 另有一条硬约束：上行能量门的 `holdMs`（默认 2000）必须远大于这个值，否则
 * 客户端停推之后服务端再也攒不到静音，句尾永远不来 —— 见
 * `docs/ALIYUN-ASR-PROBED.md` §5.1。
 */
const DEFAULT_SENTENCE_SILENCE_MS = 200;

/**
 * Smart Turn 判为「没说完」时再多等多久。
 *
 * 700 → 400：日志里「没说完，再等 700 ms」出现得极密，一轮叠 2–3 次就是
 * 1.4–2.1 秒的纯等待。400 仍够覆盖正常换气，且 `maxExtensions` 会给上限。
 */
const SMART_TURN_EXTEND_MS = Number(process.env['SMART_TURN_EXTEND_MS'] ?? 400);

/** 读一个数字型环境变量，非法值退回默认 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}


/**
 * `MIAI_LOG_TS=1`：给每一行日志加一个进程启动以来的毫秒时间戳。
 *
 * 只在排查时开 —— 平时日志的格式有人 grep，加前缀会连累所有既有脚本。
 * 有了它能一次把「本轮开始 → 首字 → 送批 → 首包 → 下行首块」对齐到毫秒，
 * 否则只能拿几个孤立的分段数互相猜（③ 里就有 300–400 ms 一直是这么猜没的）。
 */
function installLogClock(): void {
  if (process.env['MIAI_LOG_TS'] !== '1') {
    return;
  }
  const origin = performance.now();
  const raw = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    raw(`+${(performance.now() - origin).toFixed(0).padStart(6, '0')}ms`, ...args);
  };
}

async function main(): Promise<void> {
  installLogClock();
  loadDotEnv();
  const argv = process.argv.slice(2);

  const opt = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? def) : def;
  };

  const replay = opt('--replay', '');
  const listen = Number(opt('--listen', '0'));
  const ffmpeg = opt('--ffmpeg', 'ffmpeg');
  const gapMs = Number(opt('--gap-ms', '20'));
  const workDir = opt('--work-dir', join(homedir(), 'voice-workspace'));
  /** 冒烟用：把一张本地图片交给 dsh，打印它的描述后退出 */
  const askImage = opt('--ask-image', '');
  /**
   * 设备型号。**入参激活**：给了才启用该设备的专属优化，空串走通用路径
   * （见 `src/devices/`）。`MIAI_DEVICE` 是旧名字，继续认。
   */
  const deviceSpec = opt('--device', process.env['PET_DEVICE'] ?? process.env['MIAI_DEVICE'] ?? '');

  // ---- 三个可替换件：都能按名字选内置实现，或给一个模块路径
  const sttSpec = opt('--stt', process.env['MIAI_STT'] ?? '');
  const ttsSpec = opt('--tts', process.env['MIAI_TTS'] ?? '');
  /**
   * Agent 选型：`--agent dsh|echo|none|<path>`。
   * 裸 `--agent`（后面不跟值）等价 `dsh`，`--echo` 是旧写法，继续支持。
   */
  const agentSpec = ((): string => {
    if (argv.includes('--echo')) return 'echo';
    const i = argv.indexOf('--agent');
    if (i < 0) return process.env['MIAI_AGENT'] ?? 'none';
    const next = argv[i + 1];
    return next !== undefined && !next.startsWith('--') ? next : 'dsh';
  })();

  const mode: ReplyMode = agentSpec === 'dsh'
    ? 'agent'
    : agentSpec === 'echo' ? 'echo' : 'none';

  if (!replay && !listen && !askImage) {
    console.error('用法: node src/main.ts --replay <file.sbc> | --listen <port> | --ask-image <file>');
    console.error('  --host <addr>   监听地址（默认 127.0.0.1）。非本机地址必须同时配');
    console.error('                  MIAI_TOKENS 与 MIAI_TLS_KEY/MIAI_TLS_CERT，否则拒绝启动');
    console.error('  可替换件: --stt aliyun|noop|canned|<path>  --tts cosyvoice|mimo|silent|<path>');
    console.error('            --agent dsh|echo|none|<path>（裸 --agent 等价 dsh）');
    console.error(`  设备:     --device ${DEVICE_MODELS.join('|')}（v1 手机的型号提示；不给 = v1 基线）`);
    console.error('  其他:     [--work-dir <dir>] [--ffmpeg <path>] [--gap-ms 20]');
    console.error('            [--vocab-id <id>] 业务专属热词表 ID（控制台项目热词无需配置）');
    process.exit(2);
  }

  let agent: AgentProvider | null = null;
  let dshSession: DshSession | null = null;
  const announceStore = openAnnounceStore((line) => { console.log(line); });
  try {
    ({ agent, dsh: dshSession } = await buildAgent(agentSpec, {
      workDir,
      useSdk: argv.includes('--dsh-sdk'),
      provider: opt('--provider', 'deepseek-official'),
      model: opt('--model', 'deepseek-flash'),
      log: (line) => { console.log(line); },
    }, announceStore));
  } catch (error) {
    console.error(`agent 装配失败: ${(error as Error).message}`);
    process.exit(2);
  }
  if (dshSession) {
    console.log(`agent     dsh  workDir=${workDir}  dsh=${process.env['DSH_BIN'] ?? 'dsh'}  mode=${argv.includes('--dsh-sdk') ? 'sdk' : 'headless'}`);
    console.log(`会话      ${dshSession.currentSessionId ?? '（新会话）'}`);
  } else if (agent) {
    console.log(`agent     ${agent.name}`);
  }

  /**
   * 快车道 / 保活 / 记忆 / 活动跟踪。
   *
   * 为什么单独一个函数：同一套接线插件那边也要用。第一版插件只调了 `buildAgent`，
   * 整个快车道漏在外面 —— 语音栈照样跑，但每句都退化成等完整 dsh。
   */
  let stopKeepalive: () => void = () => {};
  if (agent !== null) {
    const wired = await wireAgent({
      agent,
      dsh: dshSession,
      workDir,
      announceStore,
      log: (line) => { console.log(line); },
    });
    agent = wired.agent;
    stopKeepalive = wired.stop;
    process.on('exit', () => { stopKeepalive(); });
  }

  // ---------------------------------------------------------------- 图片 -> dsh 冒烟
  if (askImage) {
    if (!agent) {
      console.error('--ask-image 需要 --agent（图片只能交给 dsh 看）');
      process.exit(2);
    }
    const buf = readFileSync(askImage);
    const ext = askImage.toLowerCase().split('.').pop() ?? '';
    const mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
          : 'image/jpeg';
    console.log(`图片    ${askImage}  ${buf.length} B  ${mime}`);
    const t0 = Date.now();
    const r = await agent.reply('这张图里有什么？用一两句话口语化描述。', {
      mimeType: mime,
      data: buf.toString('base64'),
    });
    console.log(`dsh     ${((Date.now() - t0) / 1000).toFixed(2)} s`);
    console.log(`回答    ${JSON.stringify(r.text)}`);
    dshSession?.stop();
    process.exit(0);
  }

  // ---------------------------------------------------------------- 流式分支
  // `--stt` 显式给了就走流式路径；`--asr aliyun` 是旧写法，继续认。
  const asrBackend = opt('--asr', 'mimo');
  const resolvedStt = sttSpec === '' ? (asrBackend === 'aliyun' ? 'aliyun' : '') : sttSpec;
  if (resolvedStt !== '') {
    if (!listen) {
      console.error('流式识别只支持 --listen（没有 --replay 语义）');
      process.exit(2);
    }
    if (!agent) {
      console.error('流式识别需要一个 agent（收到 SentenceEnd 就要接一轮对话）');
      process.exit(2);
    }
    const akId = process.env['ALIYUN_AK_ID'] ?? '';
    const akSecret = process.env['ALIYUN_AK_SECRET'] ?? '';
    const appkey = process.env['ALIYUN_APPKEY'] ?? '';
    const region = process.env['ALIYUN_NLS_REGION'] ?? 'cn-shanghai';
    if (resolvedStt === 'aliyun' && (!akId || !akSecret || !appkey)) {
      console.error('STT=aliyun 需要 ALIYUN_AK_ID / ALIYUN_AK_SECRET / ALIYUN_APPKEY');
      process.exit(2);
    }
    const sentenceSilenceMs = Number(
      opt('--sentence-silence', String(DEFAULT_SENTENCE_SILENCE_MS)),
    );
    // 热词表 ID 留空就不下发该字段（传不存在的 ID 会被服务端静默忽略，不报错）
    const vocabularyId = opt('--vocab-id', process.env['ALIYUN_VOCAB_ID'] ?? '');
    // 只有阿里云实现关心 region/appkey；换成别的实现时别把无关信息印出来
    const sttBanner = resolvedStt === 'aliyun'
      ? `region=${region}  appkey=${appkey.slice(0, 4)}****  silence=${sentenceSilenceMs} ms`
        + (vocabularyId ? `  vocab=${vocabularyId}` : '  vocab=(未配置)')
      : '(外部/内置实现，无需凭据)';
    console.log(`STT      ${resolvedStt}  ${sttBanner}\n`);

    const stt = await assembleAsync(() => buildStt(resolvedStt, {
      akId,
      akSecret,
      appkey,
      region,
      maxSentenceSilenceMs: sentenceSilenceMs,
      ...(vocabularyId ? { vocabularyId } : {}),
    }));
    const tts = await assembleAsync(() => buildTts(ttsSpec === '' ? 'mimo' : ttsSpec));
    console.log(`可替换件 STT=${stt.name}  TTS=${tts.name}（${tts.sampleRate} Hz）\n`);

    const smartTurnPython = process.env['SMART_TURN_PYTHON'] ?? '';
    const smartTurnScript = process.env['SMART_TURN_SCRIPT'] ?? '';
    const smartTurnEnabled = process.env['SMART_TURN'] !== '0'
      && smartTurnPython !== '' && smartTurnScript !== '';

    /**
     * 判停器侧车：**进程级一份，跨连接常驻**。
     *
     * 以前每条连接建一个、断开就 `stop()`。侧车是 python + 8.7 MB ONNX，冷启动
     * 实测 ~300 ms —— 真机每次重连（网络抖动 / 服务重启 / 重开 App）第一句都要
     * 付这一刀，而它刚好落在「用户说完 → 开一轮」里。常驻之后只有进程启动付一次。
     *
     * 预热：先用 1 s 静音跑一次推理把模型加载进来，别让第一次真说话的那轮承担。
     */
    const smartTurnClient = smartTurnEnabled
      ? new SmartTurn({
        python: smartTurnPython,
        script: smartTurnScript,
        log: (line) => { console.log(`  ${line}`); },
      })
      : null;
    if (smartTurnClient !== null) {
      // 低幅正弦而不是全零：全零在 log-mel 里是 −∞ dB，不该拿它当"正常输入"试模型
      const warmup = Buffer.alloc(UPSTREAM_SAMPLE_RATE * 2);
      for (let i = 0; i < warmup.length / 2; i += 1) {
        warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2);
      }
      const startedAt = Date.now();
      const p = await smartTurnClient.predict(warmup);
      console.log(
        `判停    侧车预热 ${Date.now() - startedAt} ms（p=${p.toFixed(3)}）`
        + '，之后所有连接共用这一份\n',
      );
      process.on('exit', () => { smartTurnClient.stop(); });
    }

    // 增益先算好并打出来：调音时最想知道「现在到底是几倍、门限在哪」
    const ttsGain = envNumber('MIAI_TTS_GAIN', envNumber('TTS_GAIN', 1));
    const micGain = envNumber('MIAI_MIC_GAIN', envNumber('MIC_GAIN', 1));
    /**
     * 能量门限（按**放大后**算）。
     *
     * 实测（M2004J7AC、增益 4×、家里安静房间，84 个 2 s 窗口）：
     * 底噪峰值集中在 −60…−51 dBFS（p10 −58.3、p50 −53.7），
     * 说话时在 −20…0 dBFS，中间几乎空着。
     *
     * 原来取 −58：**低于底噪**，门一直开着 → 噪声当语音推给 ASR →
     * 服务端判「无有效语音」踢连接 → 6 分钟里建连 45 次、同时存活 4 条。
     * 取 −40：比最响的底噪高 10 dB，比最轻的说话低 10 dB。
     */
    const peakDbfs = envNumber('VOICE_PEAK_DBFS', -40);
    console.log(
      `增益    上行 ${micGain}×（能量门 ${peakDbfs} dBFS，按放大后算）  下行 ${ttsGain}×\n`,
    );

    // 横幅只能先打 v1 的默认能力：真正走哪个版本要等连接时的 `Hello` 自报
    const device = resolveV1Device(deviceSpec);
    console.log(`设备     ${device.label}（v1 默认，v2 设备在 Hello 里自报能力）：${describeCapabilities(device.capabilities)}\n`);

    // 宠物环开没开必须说出来。不说的话，「它一直不说话」分不清是
    // 「判断了但决定不说」还是「这一层根本没装」（见 archive/HANDOFF.md 的教训）
    const proactiveOn = process.env['PET_PROACTIVE'] === '1';
    console.log(
      proactiveOn
        ? '宠物环   开（主动开口）：心跳每 '
          + `${envNumber('PET_TICK_MS', 30_000)} ms，离场 ${envNumber('PET_GREET_AWAY_MS', DEFAULT_PET_TIMING.greetAfterAwayMs)} ms 后重戴会打招呼\n`
        : '宠物环   关（PET_PROACTIVE≠1）：只跑对话环，不会主动开口\n',
    );

    const code = await runVoiceServer({
      port: listen,
      host: opt('--host', '127.0.0.1'),
      device: deviceSpec,
      ffmpegPath: ffmpeg,
      agent,
      stt,
      tts,
      smartTurn: smartTurnEnabled
        ? {
          pythonPath: smartTurnPython,
          scriptPath: smartTurnScript,
          // 句子定稿后先静候这么久再问 Smart Turn。350 → 150 → 80 → 40 → 0：
          // 有了「静音一到就预跑判停」（`VOICE_PAUSE_DETECT_MS`），`SentenceEnd` 到达时
          // 概率早就算好了，这段静候只是白等 —— 回放实测 ② 从 113 → 41 ms，
          // 把这里归零后只剩取缓存的那一下。
          quietMs: envNumber('SMART_TURN_QUIET_MS', 0),
          extendMs: SMART_TURN_EXTEND_MS,
          // 延长次数上限。3 → 7：业界（LiveKit `max_delay` 2.5–3 s、Pipecat
          // SmartTurn `stop_secs` 3 s、Deepgram `eot_timeout_ms` 5 s）都留 2.5 秒以上
          // 的兜底，而我们原来只有 3×400=1.2 s —— 触发点比人家快、兜底却只有一半，
          // 用户说半句停下来想一下就会被强制收下。7×400 ≈ 2.8 s，对齐业界。
          maxExtensions: envNumber('SMART_TURN_MAX_EXT', 7),
          threshold: envNumber('SMART_TURN_THRESHOLD', 0.5),
          // 结尾像「还有下文」（数字串/井号/连词）时再多等一拍。见
          // `looksUnfinished`：`max_sentence_silence` 压到 200 之后，
          // 数字组之间的换气会被当句尾，订单号被切成两句。
          unfinishedWaitMs: envNumber('SMART_TURN_UNFINISHED_MS', 250),
          // 判停器说「说完了」之后，若这么久内还收到过中间结果，就再等一拍
          // （防「音频停了、ASR 还在出字」的抢话）。真机上这段**几乎每轮都触发**，
          // 一次 400 ms 直接进了首字延迟 —— 150 仍能挡住正常 partial 间隔，
          // 回放实测（同为 6 轮）2 段从 622–625 ms 降到 150–152 ms。
          partialGraceMs: envNumber('SMART_TURN_PARTIAL_GRACE_MS', 150),
        }
        : undefined,
      ...(smartTurnClient === null ? {} : { smartTurnClient }),
      gate: {
        thresholdDbfs: peakDbfs,
        holdMs: envNumber('VOICE_HOLD_MS', 2000),
        prerollMs: envNumber('VOICE_PREROLL_MS', 800),
        // 静音多久就提前跑判停（和 ASR 的 max_sentence_silence 对齐）；0 = 关闭
        pauseDetectMs: envNumber('VOICE_PAUSE_DETECT_MS', 200),
    // 投机要比判停早：它的用途是给「提前合成音频」腾窗口，不是省自己的时间
    speculateMs: envNumber('VOICE_SPECULATE_MS', 100),
      },
      playbackTailMs: 600,
      /**
       * 下行增益。**默认应当是 1.0**：MiMo 的输出已经是满刻度（实测峰值 −0.5 dBFS），
       * 任何 >1 的增益都会把元音峰值压进软限幅 —— ×3 时波峰因数从 14.7 dB 掉到
       * 7.3 dB，听感是"扁、闷、语调怪"。要更响请调手机媒体音量，不要加这里。
       */
      ttsGain,
      /**
       * 上行增益。眼镜 mic 电平低，4.0 时小声说话才能推开能量门
       * （门限 `VOICE_PEAK_DBFS` 按**放大后**的电平算，见 `uplink-pipeline.ts`）。
       */
      micGain,
      // 调音用：`MIAI_LEVEL_LOG=2000` 每 2 s 打一行上行峰值（0 = 关）
      levelLogMs: envNumber('MIAI_LEVEL_LOG', 0),
      /**
       * 原始档案目录（空 = 不存）。一条连接一个目录，存原始 mSBC、放大前的 PCM、
       * 下行 PCM 和事件时间线 —— 出问题后能完整重放，见 `archive.ts`。
       * 旧的 `DUMP_DIR`（按轮次存、只覆盖播放期）已被它取代。
       */
      archiveDir: process.env['MIAI_ARCHIVE_DIR'] ?? '',
      archiveMaxMb: envNumber('MIAI_ARCHIVE_MAX_MB', 80),
      archiveKeep: envNumber('MIAI_ARCHIVE_KEEP', 20),
      photoDir: process.env['PHOTO_DIR'] ?? '',
      // 默认避开 `--listen` 自己，否则两条监听撞端口（EADDRINUSE）
      controlPort: envNumber('PHOTO_CTL_PORT', listen + 2),
      // 高清链路要等手机建 P2P + 设备写相册，20 s 可能不够（`MIAI_PHOTO_TIMEOUT_MS` 可调）
      photoTimeoutMs: envNumber('MIAI_PHOTO_TIMEOUT_MS', 20_000),
      // 要人动手的拍照只设一个兜底总时长（分段计时归设备）。
      // 兼容旧的两段变量：给了就相加
      confirmTimeoutMs: process.env['MIAI_CONFIRM_TIMEOUT_MS'] !== undefined
        || (process.env['MIAI_HQ_ARM_TIMEOUT_MS'] === undefined
          && process.env['MIAI_HQ_SHUTTER_TIMEOUT_MS'] === undefined)
        ? envNumber('MIAI_CONFIRM_TIMEOUT_MS', DEFAULT_CONFIRM_TIMEOUT_MS)
        : envNumber('MIAI_HQ_ARM_TIMEOUT_MS', 15_000) + envNumber('MIAI_HQ_SHUTTER_TIMEOUT_MS', 25_000),
      imageQuestion: '这张图里有什么？用一两句话口语化描述。',
      announceStore,
      tls: assemble(() => loadTls()),
      authenticate: assemble(() => loadAuthenticator((line) => { console.log(line); })),
      idleTimeoutMs: envNumber('MIAI_IDLE_TIMEOUT_MS', 45_000),
      serve: argv.includes('--serve') || process.env['MIAI_SERVE'] === '1',
      // 主动开口默认关：开着它会自己说话，得人明确要
      proactive: proactiveOn
        ? {
          params: {
            greetAfterAwayMs: envNumber('PET_GREET_AWAY_MS', DEFAULT_PET_TIMING.greetAfterAwayMs),
            chatterAfterIdleMs: envNumber('PET_CHATTER_IDLE_MS', DEFAULT_PET_TIMING.chatterAfterIdleMs),
            // 开麦到首帧上行音频的截止。小米实测 0.62 s，给到 1.5 s
            micOpenTimeoutMs: envNumber('PET_MIC_OPEN_TIMEOUT_MS', 1500),
          },
          listenMs: envNumber('PET_LISTEN_MS', DEFAULT_PROACTIVE.listenMs),
          tickMs: envNumber('PET_TICK_MS', 30_000),
        }
        : null,
    });
    dshSession?.stop();
    process.exit(code);
  }

  const pipe = new Pipeline(ffmpeg, mode, agent);
  await sleep(200);       // 等 VAD 初始化

  const code = replay
    ? await runReplay(replay, pipe, gapMs)
    : await runListen(listen, pipe);

  // 常驻进程要显式关，否则 node 会因为子进程 stdin 仍打开而不退出
  dshSession?.stop();
  process.exit(code);
}

void main();
