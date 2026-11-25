/**
 * 判停器归属，以及把一条连接的静音 / 封段回调接到 {@link UtteranceAssembler}。
 *
 * 共享侧车不能在断开时 `stop`：冷启动要重新加载 ONNX。自己创建的那份必须停，
 * 否则进程退不掉。
 */
import { UtteranceAssembler, type JudgeFact } from '../utterance-assembler.ts';
import { DEFAULT_TRAILING_TRIM_MS } from '../voice-config.ts';
import { UPSTREAM_SAMPLE_RATE, type VoiceSessionOptions } from './session-options.ts';

/**
 * 判停器的最小接口（`TurnJudge` 满足它）。
 *
 * 抽成接口只为一件事：**共享与独占的判定要能单测**，不必起 python 侧车。
 */
export interface EndpointDetector {
  predict(pcm: Buffer): Promise<number>;
  stop(): void;
}

/**
 * 决定这条连接用哪个判停器、以及要不要在断开时销毁它。
 *
 * 共享的那份由进程持有（`main.ts` 创建并预热），**连接断开时不能 stop**：
 * 侧车冷启动要重新加载 8.7 MB ONNX（实测 ~300 ms），真机每次重连第一句都要付。
 * 自己创建的那份（单连接命令行 / 测试）必须 stop，否则进程退不掉。
 */
export function resolveEndpointDetector(
  options: { readonly turnJudge?: object; readonly turnJudgeClient?: EndpointDetector },
  create: () => EndpointDetector,
  log: (line: string) => void,
): { readonly client: EndpointDetector | null; readonly owned: boolean } {
  if (options.turnJudgeClient !== undefined) {
    if (options.turnJudge === undefined) {
      log('  判停    ⚠ 给了共享判停器但没有参数表（quietMs 等），会按 0 处理');
    }
    return { client: options.turnJudgeClient, owned: false };
  }
  if (options.turnJudge === undefined) {
    return { client: null, owned: false };
  }
  return { client: create(), owned: true };
}

/**
 * 没有判停器（TurnJudge 关掉）时的固定合并窗口。
 *
 * 旧行为：收到一句 ASR 就再等 600 ms 看有没有下文，没有就定稿。
 */
const ASSEMBLER_FALLBACK_WINDOW_MS = 600;

/**
 * 判停请求提前多久发起（与静候窗 `TURN_JUDGE_QUIET_MS` 重叠）。
 *
 * `asrToTurn` 实测中位 224 ms = 静候窗 150 + 判停器往返约 70 + 派发几毫秒。
 * 提前 65 ms 把请求发出去，那趟往返就藏进静默窗里，中位降到约 150 ms；
 * 而判停器看到的句尾静音只从约 550 ms 缩到约 465 ms —— 静音是它判断
 * 「说完了」的主要证据，砍太多会把「没说完」的比例抬上去，长尾反而更烂。
 *
 * 判停器慢过 85 ms 时只会退化成旧行为，不会更慢：`evaluate` 到点是**等**
 * 那份已经出发的请求，不会重发。
 */
const ASSEMBLER_PREDICT_LEAD_MS = 65;

/**
 * 送给判停器的「最近音频」上限（秒）。
 *
 * 判停器要听到整句话的尾巴才能判「说完了」，8 s 足够覆盖常见的一句话，
 * 又不至于把整段对话都留在内存里。
 */
const ASSEMBLER_RECENT_SECONDS = 8;

/**
 * 能量门上的静音提前量 → 装配器选项。
 *
 * `0` 是「关掉这一路」，必须原样传下去。缺字段（`undefined`）才表示没配置，
 * 由 `SilenceTriggers` 用默认 200 / 100。以前 `<= 0` 把 `0` 删掉，
 * 关闭开关静默失效，变回默认值。
 */
export function assemblerSilenceFromGate(gate: {
  readonly pauseDetectMs?: number;
  readonly speculateMs?: number;
}): { readonly silencePauseMs?: number; readonly speculateMs?: number } {
  return {
    ...(gate.pauseDetectMs !== undefined ? { silencePauseMs: gate.pauseDetectMs } : {}),
    ...(gate.speculateMs !== undefined ? { speculateMs: gate.speculateMs } : {}),
  };
}

/**
 * 装配器回调里还要碰连接上别的对象的那几处。
 *
 * `onCommit` / `onSttCommit` 的序号在 `AsrFront`，`awaitDecode` 要等 `stt` 赋完值，
 * 所以闭包留在协调器，这里只负责「什么条件下把它们挂上去」。
 */
export interface AssemblerWirePorts {
  readonly options: VoiceSessionOptions;
  readonly turnJudge: EndpointDetector | null;
  readonly now: () => number;
  readonly log: (line: string) => void;
  onJudge(fact: JudgeFact): void;
  onCommit(silenceMs: number): void;
  onSttCommit(silenceMs: number): void;
  onUtterance(text: string): void;
  awaitDecode(): Promise<void> | null;
}

/** 按这条连接的判停参数和能量门，造出装配器并绑上封段 / 定稿回调。 */
export function wireAssembler(ports: AssemblerWirePorts): UtteranceAssembler {
  const options = ports.options;
  const turnJudgeOptions = options.turnJudge;
  const turnJudge = ports.turnJudge;
  const maxOpenSilenceMs = turnJudgeOptions?.maxOpenSilenceMs ?? options.gate.maxOpenSilenceMs;
  return new UtteranceAssembler({
    quietMs: turnJudgeOptions?.quietMs ?? 0,
    extendMs: turnJudgeOptions?.extendMs ?? 0,
    maxExtensions: turnJudgeOptions?.maxExtensions ?? 0,
    ...(turnJudgeOptions?.maxUnsureExtensions === undefined
      ? {}
      : { maxUnsureExtensions: turnJudgeOptions.maxUnsureExtensions }),
    fallbackWindowMs: ASSEMBLER_FALLBACK_WINDOW_MS,
    threshold: turnJudgeOptions?.threshold ?? 1,
    ...(turnJudgeOptions?.thresholdCjk === undefined
      ? {}
      : { thresholdCjk: turnJudgeOptions.thresholdCjk }),
    ...(turnJudgeOptions?.waitBudgetMs === undefined
      ? {}
      : { waitBudgetMs: turnJudgeOptions.waitBudgetMs }),
    ...(turnJudgeOptions?.waitBudgetSequenceMs === undefined
      ? {}
      : { waitBudgetSequenceMs: turnJudgeOptions.waitBudgetSequenceMs }),
    ...(maxOpenSilenceMs === undefined ? {} : { maxOpenSilenceMs }),
    ...(options.semantic === undefined
      ? {}
      : {
        semanticEndpoint: (text: string) => options.semantic!.judge(text),
        ...(options.semanticBudgetMs === undefined
          ? {}
          : { semanticBudgetMs: options.semanticBudgetMs }),
      }),
    recentMaxBytes: UPSTREAM_SAMPLE_RATE * 2 * ASSEMBLER_RECENT_SECONDS,
    // 尾巴上多的静音会把 p 拉低（停嘴处 0.95 → +300 ms 0.35），而 p 正是
    // 「要不要再等一拍」的依据 —— 不裁就是「每多等一拍，判据更差」。
    trailingTrimMs: turnJudgeOptions?.trailingTrimMs ?? DEFAULT_TRAILING_TRIM_MS,
    // 判停的每次决定都落档：`② 定稿→开轮` 在档案里一直是黑盒，1 ms 和 2400 ms
    // 都可以是这个数，不看 p 分不清「判停不敢收」和「排队」。
    onJudge: (fact) => { ports.onJudge(fact); },
    predict: turnJudge === null
      ? undefined
      : (pcm: Buffer) => turnJudge.predict(pcm),
    // 只在有判停器时才有意义（没有判停器就走固定窗口，没有往返可叠）
    ...(turnJudge === null ? {} : { predictAtMs: ASSEMBLER_PREDICT_LEAD_MS }),
    // 静音一到就把判停跑掉，和 ASR 那 200 ms 静音窗并行 —— 出句时概率已经算好。
    // 门槛用能量门那个（同一路放大后的波形、同一套设备标定）。
    silenceDb: options.gate.thresholdDbfs,
    // **必须与本连接的 `clock` 同一把尺**。默认是 `Date.now()`（≈1.76e12），
    // 而 `SystemClock` 是进程启动后的单调毫秒（≈2e4）—— 接错的那一版闸恒放行且毫无日志。
    now: ports.now,
    // `0` 原样透传（关闭预判停 / 投机）。删掉字段会让 SilenceTriggers 用回 200 / 100。
    ...assemblerSilenceFromGate(options.gate),
    // 端点归我们把控的 ASR（qwen realtime）：静音到点就封段，解码那 ~260 ms
    // 与判停那一拍并行跑。`commitMs` 为 0 就不接（NLS 自己判句，别插嘴）。
    ...(options.gate.commitMs === undefined || options.gate.commitMs <= 0
      ? {}
      : {
        commitAfterMs: options.gate.commitMs,
        onCommit: (silenceMs: number) => { ports.onCommit(silenceMs); },
        // ASR 那一路**晚一点**再切（见 `sttCommitMs`）：车道要的是「这半句结束」，
        // ASR 要的是「这一句结束」，两者的最优值差一个数量级。
        ...(options.gate.sttCommitMs === undefined || options.gate.sttCommitMs <= 0
          ? {}
          : {
            sttCommitAfterMs: options.gate.sttCommitMs,
            onSttCommit: (silenceMs: number) => { ports.onSttCommit(silenceMs); },
          }),
      }),
    // 开轮门槛：提交早 → 定稿也早，可能人还在说。定稿到达时看「截至此刻的
    // 连续静音」，不够就等 —— 那本来就不该开轮。
    ...(options.gate.openQuietMs === undefined || options.gate.openQuietMs <= 0
      ? {}
      : {
        openQuietMs: options.gate.openQuietMs,
        ...(options.gate.openQuietShortMs === undefined
          ? {}
          : { openQuietShortMs: options.gate.openQuietShortMs }),
      }),
    onUtterance: (text) => { ports.onUtterance(text); },
    // 句子定稿那一刻就让快车道起跑，把判停那一拍从关键路径上挪走。
    // 判停若并了下一段，组装器会拿更长的文本再调一次；认领时按文本比对。
    onSentence: (text) => {
      // 预热**只跟快车道起跑走**，不跟「这一轮会不会答」走。
      //
      // 因为委派轮一定先出回执（`RECEIPTS`），而回执和正式回答共用同一条 TTS 连接
      // —— 连接上一次只有一个 task，预热会被回执认领掉。测试过「定稿无条件预热」：
      // 委派轮里 `stream:false prewarmed:true`（回执）紧跟着
      // `stream:true prewarmed:false`（正式回答），白开一条 task。
      // 试过把回执预合成进缓存来腾出预热，代价是设备刚连上就要占 TTS 约 2 秒，
      // 与用户第一句话抢连接 —— 为 66 ms 不值得，已回滚（`5500c47`）。
      //
      // ⚠️ `prefetch` 只许调**一次**：以前这里还多一行无条件的 `prefetch(text)`，
      // 每句定稿要发两趟（命中缓存那趟不算，但没命中就是重复请求）。
      if (options.agent.prefetch?.(text) === true) options.tts.prewarm?.();
    },
    // 中间结果投机：比定稿再往前提。文本是猜的，定稿确认是前缀才认领 ——
    // 认不了就作废，退回上面那条路，等于没做。
    // 返回 false（没投出去）时组装器不会记「这段语音已投机」，下一个静音 tick
    // 还会再问一次 —— 否则「静音 100 ms 时只凑到 2 个字」就等于整轮放弃。
    onPartial: (text) => options.agent.speculatePartial?.(text) ?? false,
    // 开轮前先等 ASR 那段解完（见 `UtteranceAssemblerOptions.awaitDecode`）。
    // 闭包里取 `stt`：它在 `wireAssembler` 返回之后才赋值，构造期不能摸。
    awaitDecode: () => ports.awaitDecode(),
    log: ports.log,
  });
}
