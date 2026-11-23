/**
 * `TurnRunner` 的「边生成边合成」分支：增量进去，音频出来。
 *
 * 这条路出过的事都是**静默**的 —— 增量没接上、流式失败、多步轮次只记最后一步 ——
 * 每一个现场都只表现为"慢了一点"或"续话续错了段"，日志里不报错。所以用假 agent +
 * 假 TTS 把它钉住，不联网、不起进程。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Cancel, Clock } from '../src/app/clock.ts';
import { DialogFsm } from '../src/dialog-fsm.ts';
import type { AgentProvider, AgentReplyView, DelegateReason, TtsProvider } from '../src/providers.ts';
import type { ImageAttachment } from '../src/session.ts';
import { TurnRunner, type TurnResult } from '../src/turn-runner.ts';

/** 10 ms 的有声 PCM：够触发「首块」，又不会让播放等待拖慢测试 */
const LOUD = Buffer.alloc(480, 1);

/** 真时间的时钟（定时器不 unref：测试进程得等它） */
const clock: Clock = {
  now: () => performance.now(),
  localHour: () => 12,
  after: (ms, fn): Cancel => {
    const timer = setTimeout(fn, ms);
    return () => { clearTimeout(timer); };
  },
  every: (ms, fn): Cancel => {
    const timer = setInterval(fn, ms);
    return () => { clearInterval(timer); };
  },
};

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

interface Rig {
  /** 流式那条路收到的文本块 */
  readonly streamed: string[];
  /** 整段合成那条路收到的文本 */
  readonly whole: string[];
  readonly events: string[];
  /** 事件的载荷，`turn.end.path` / `delegate` 只能从这里看 */
  readonly payloads: Array<{ name: string; data: Record<string, unknown> }>;
  readonly logs: string[];
  /** 下发给设备的指令（udio.stop 这类） */
  readonly deviceCalls: Array<{ op?: string }>;
  /** 回注给音频车道的答案（`injectAnsweredTurn` 的三参） */
  readonly injected: Array<[string, string, string | undefined]>;
  /** 写进账本的 `truncated`（`noteServedTurn` 的第三参，`undefined` = 没传） */
  readonly servedTruncated: Array<boolean | undefined>;
  /** `willServeAudio` 被问过几次（带图轮次不该问） */
  readonly willServeCalls: number;
  /** 测试里要能主动插话（`interrupted` / `truncated` 的差别只有它能造出来） */
  readonly fsm: DialogFsm;
  /** 最后一块音频吐出的时刻（`chunkDelayMs` 造流式耗时后用它算「多锁了多久」） */
  readonly lastChunkAt: number;
  run(image?: ImageAttachment): Promise<TurnResult | null>;
}

function rig(options: {
  /** 模型吐的增量（每一步的原始文本，按到达顺序） */
  deltas: readonly string[];
  /** `reply()` 的返回；给 Error 就是这一轮模型挂了 */
  reply: AgentReplyView | Error;
  /** 流式合成收完文本后抛这个错 */
  streamError?: Error;
  /** omni 直出：给了音频就让第一次 `reply()` 返回 audio 视图 */
  audio?: readonly string[];
  /** omni 决定转交 dsh（`tool_call`） */
  omniDelegate?: DelegateReason;
  /** 转交之后 dsh 永不回话：用来验「本轮作废就不再等它」 */
  delegateHang?: boolean;
  /** 流式合成每块之间隔这么久：用来造「吐音频本身耗时」的场景 */
  chunkDelayMs?: number;
  /** 这一轮会不会走 omni（宿主据此不启流式 TTS） */
  willServe?: boolean;
}): Rig & { served: Array<[string, string]> } {
  const streamed: string[] = [];
  const whole: string[] = [];
  const events: string[] = [];
  /** 事件的载荷（`turn.end` 的 `path` / `delegate` 只能从这里看） */
  const payloads: Array<{ name: string; data: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const deviceCalls: Array<{ op?: string }> = [];
  const served: Array<[string, string]> = [];
  const injected: Array<[string, string, string | undefined]> = [];
  const servedTruncated: Array<boolean | undefined> = [];
  let willServeCalls = 0;
  let sink: ((text: string) => void) | null = null;
  /** 最后一块音频吐出的时刻（验「播完之后还要多锁多久」用） */
  let lastChunkAt = 0;

  let calls = 0;
  const agent: AgentProvider = {
    name: 'fake',
    willServeAudio: () => {
      willServeCalls += 1;
      return options.willServe === true;
    },
    noteServedTurn: (userText, said, truncated) => {
      served.push([userText, said]);
      servedTruncated.push(truncated);
    },
    injectAnsweredTurn: (userText, said, kind) => { injected.push([userText, said, kind]); },
    reply: async () => {
      calls += 1;
      if (calls === 1 && options.audio !== undefined) {
        let said = '';
        const chunks = options.audio;
        return {
          get text(): string { return said; },
          get speech(): string { return said; },
          path: 'omni',
          audio: {
            sampleRate: 24_000,
            transcript: () => said,
            delegateReason: () => options.omniDelegate ?? null,
            chunks: (async function* generate() {
              for (const text of chunks) {
                said += text;
                yield LOUD;
              }
            })(),
          },
        };
      }
      if (calls === 2 && options.delegateHang === true) {
        // 模拟 dsh 的软取消：`session/cancel` 发出去之后那边要几秒才回，甚至不回
        return new Promise<AgentReplyView>(() => { /* 永不 resolve */ });
      }
      for (const delta of options.deltas) {
        sink?.(delta);
        await tick();
      }
      if (options.reply instanceof Error) throw options.reply;
      return options.reply;
    },
  };
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async* synthesize(text) {
      whole.push(text);
      yield LOUD;
    },
    async* synthesizeStream(chunks) {
      for await (const chunk of chunks) {
        streamed.push(chunk);
        if (options.chunkDelayMs !== undefined && options.chunkDelayMs > 0) {
          await sleep(options.chunkDelayMs);
        }
        if (options.streamError === undefined) {
          lastChunkAt = Date.now();
          yield LOUD;
        }
      }
      if (options.streamError !== undefined) throw options.streamError;
    },
  };
  // `now` 必须给：插话当场由内核结算（`bargeIn` 里的 `atMs` 来自宿主上下文），
  // 缺了它 `atMs` 是 0，`heardMs` 会被算成 0 —— 那与真机装配的行为不同。
  const fsm = new DialogFsm(() => {}, { now: () => clock.now() });
  const runner = new TurnRunner({
    clock,
    agent,
    tts,
    downlink: { sendAudio: () => {}, sendControl: () => {} },
    sendCall: (call) => { deviceCalls.push(call as { op?: string }); },
    fsm,
    playbackTailMs: 0,
    onEvent: (name, data) => {
      events.push(name);
      payloads.push({ name, data: data ?? {} });
    },
    onTurnFinished: () => {},
    onLiveAvailable: (next) => { sink = next; },
    log: (line) => { logs.push(line); },
  });
  return {
    streamed, whole, events, payloads, logs, served, fsm, deviceCalls, injected, servedTruncated,
    get lastChunkAt(): number { return lastChunkAt; },
    get willServeCalls(): number { return willServeCalls; },
    run: (image?: ImageAttachment) => runner.run('你好', image),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 起一轮，`atMs` 之后插话 —— 用来造「音频发完了、用户才开口」的边界 */
async function runWithBargeIn(atMs: number) {
  const r = rig({
    deltas: Array.from({ length: 60 }, () => '念'),   // 60 块 × 10 ms = 0.6 s 音频
    reply: { text: '念'.repeat(120), speech: '念'.repeat(120) },
  });
  const running = r.run();
  await sleep(atMs);
  r.fsm.bargeIn('插话');
  const result = await running;
  const end = r.payloads.find((p) => p.name === 'turn.end');
  return { result, end };
}

test('turn.end：插话落在音频中段 → interrupted 与 truncated 都为真', async () => {
  const { result, end } = await runWithBargeIn(120);
  assert.ok(result);
  assert.equal(result.interrupted, true);
  assert.equal(end?.data.truncated, true, '0.12 s 就停了，0.6 s 的答案少听了');
});

test('turn.end：插话落在尾音之后 → interrupted 仍为真，但 truncated 为假', async () => {
  // `interrupted` 是控制面（票据作废），不能因为"其实听全了"改判 ——
  // 老轮一旦以为自己没作废，就会去动新一轮的 FSM。
  const { result, end } = await runWithBargeIn(500);
  assert.ok(result);
  assert.equal(result.interrupted, true, '票据确实被作废了');
  assert.equal(end?.data.truncated, false, '只剩 0.1 s 没听到，不算少听');
});

test('流式：增量一路送到 TTS，出声，不走整段合成', async () => {
  const r = rig({
    deltas: ['[平静]', '在，', '哥。'],
    reply: { text: '[平静]在，哥。', speech: '在，哥。' },
  });
  const result = await r.run();

  assert.ok(result, '这一轮应当成功');
  assert.deepEqual(r.streamed, ['[平静]', '在，', '哥。'], '每个增量都要到 TTS —— 漏了就是 sink 没接上');
  assert.deepEqual(r.whole, [], '流式成功就不该再整段合成一遍');
  assert.ok(result.audioBytes > 0);
  assert.ok(r.events.includes('tts.first'), '首块仪表不能缺');
  assert.equal(result.speech, '在，哥。');
});

test('流式多步：speech 是实际念过的全部，不只是最后一步', async () => {
  // 模型先说一句、调工具、再说一句：两句都会念，但 reply 只带最后一步
  const r = rig({
    deltas: ['[平静]哦，是六四一四。', '我改一下。', '[平静]改好了，', '现在送到六四一四室。'],
    reply: { text: '[平静]改好了，现在送到六四一四室。', speech: '改好了，现在送到六四一四室。' },
  });
  const result = await r.run();

  assert.ok(result);
  assert.equal(
    result.speech,
    '哦，是六四一四。我改一下。改好了，现在送到六四一四室。',
    '打断续话按已播时长在 speech 上切：只给最后一步，切出来的是错的段落',
  );
});

test('流式失败：退回整段合成，speech 回到 reply.speech', async () => {
  const r = rig({
    deltas: [],
    reply: { text: '[平静]在，哥。', speech: '在，哥。' },
    streamError: new Error('Please ensure input text is valid.'),
  });
  const result = await r.run();

  assert.ok(result, '流式挂了也不能哑');
  assert.deepEqual(r.whole, ['在，哥。']);
  assert.ok(result.audioBytes > 0);
  assert.equal(result.speech, '在，哥。');
  assert.ok(r.logs.some((line) => line.includes('退回整段合成')), '兜底必须留痕，否则只表现为"慢了一点"');
});

test('模型挂了、流式也跟着失败：这一轮失败，但不能留下没人接的 rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const r = rig({
      deltas: [],
      reply: new Error('模型挂了'),
      streamError: new Error('Please ensure input text is valid.'),
    });
    const result = await r.run();
    // rejection 是在微任务队列清空后才上报的，多让几拍
    await tick();
    await tick();

    assert.equal(result, null);
    assert.deepEqual(unhandled, [], '没人接的 rejection 是进程级错误：一轮失败会让整个 harness 退出');
    assert.ok(r.events.includes('turn.end'), '失败也要留一条 turn.end');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('turn.end 记下这一轮是谁答的：path=fast', async () => {
  // 编排层分不出「预跑被认领」和「qwen 现场回」—— 两者的 dsh_ms 都可能只有几十毫秒
  // （真机：`还在吗？` 343 ms 是快车道，`我怎么说？` 662 ms 是 dsh）。只能由 agent 报。
  const r = rig({ deltas: ['[平静]在呢。'], reply: { text: '[平静]在呢。', speech: '在呢。', path: 'fast' } });
  await r.run();
  const end = r.payloads.filter((p) => p.name === 'turn.end').at(-1);
  assert.ok(end, '该有一条 turn.end');
  assert.equal(end.data['path'], 'fast', `实际：${JSON.stringify(end.data)}`);
  assert.equal(end.data['delegate'], undefined, '快车道胜出的轮次不该有 delegate');
});

test('turn.end 记下实际念出去的文本：快车道没有 session log，这是它唯一的口供', async () => {
  // dsh 那侧另有 `session.v4.jsonl.zstd` 的 `assistant/message` 可对；快车道
  // （qwen-flash）什么都不落盘，只说进 console 的前 120 字。而「抢话之后模型有没有
  // 接上上下文」只能靠这条审 —— 情绪标签必须已经剥掉，记的是播出去的话。
  const r = rig({ deltas: ['[平静]在呢。'], reply: { text: '[平静]在呢。', speech: '在呢。', path: 'fast' } });
  await r.run();
  const end = r.payloads.filter((p) => p.name === 'turn.end').at(-1);
  assert.ok(end, '该有一条 turn.end');
  assert.equal(end.data['said'], '在呢。', `实际：${JSON.stringify(end.data)}`);
  assert.equal(end.data['said_chars'], 3);
});

test('turn.end 记下交给 dsh 的原因：本地闸(task) 与模型让位(delegate) 分得开', async () => {
  const r = rig({
    deltas: [],
    reply: { text: '[平静]好的。', speech: '好的。', path: 'dsh', delegate: 'task' },
  });
  await r.run();
  const end = r.payloads.filter((p) => p.name === 'turn.end').at(-1);
  assert.ok(end, '该有一条 turn.end');
  assert.equal(end.data['path'], 'dsh');
  assert.equal(
    end.data['delegate'],
    'task',
    '本地判据挡住的轮次记 task；快模型自己让位记 delegate —— 两者在日志里长得一样，只能靠这个分',
  );
});

test('omni 直出：不启流式 TTS、音频原样下行、path=omni、播完回写记忆', async () => {
  const r = rig({
    deltas: [],
    reply: { text: '不该走到这里', speech: '不该走到这里' },
    willServe: true,
    audio: ['我在', '呢。'],
  });
  const result = await r.run();

  assert.ok(result);
  assert.equal(r.payloads.find((p) => p.name === 'turn.end')?.data['path'], 'omni');
  assert.deepEqual(r.streamed, [], 'omni 轮没有文本可送，流式 TTS 一个 chunk 都不该收');
  assert.deepEqual(r.whole, [], '也不该退回整段合成');
  assert.ok(result.audioBytes > 0, '音频必须真的下发');
  assert.equal(result.speech, '我在呢。', 'drain 之后才是完整的一句');
  assert.deepEqual(r.served, [['你好', '我在呢。']], '播完必须回写，否则跨车道失忆');
  assert.deepEqual(r.servedTruncated, [false], '听全了，账本要收真实的那一个值（不是缺省的 undefined）');
});

test('omni 自己答完但被打断：账本收到的是真实 truncated', async () => {
  // 这个值只有结算时才知道（内核的媒体游标），以前在两参调用里直接缺省成 false ——
  // 账本于是永远以为用户听全了，路由和回注都按它判。
  const r = rig({
    deltas: [],
    reply: { text: '不该走到这里', speech: '不该走到这里' },
    willServe: true,
    audio: Array.from({ length: 200 }, () => '念'), // 2 s 垫话，先全部下发再插话
  });
  const running = r.run();
  for (
    let i = 0;
    i < 400 && r.fsm.runtime.state.playback.sentMediaMs < 2_000;
    i += 1
  ) {
    await sleep(5);
  }
  r.fsm.bargeIn('插话');
  await running;

  assert.deepEqual(r.servedTruncated, [true], `实际：${JSON.stringify(r.servedTruncated)}`);
});

test('播放等待以首块为基准：吐完最后一块之后不该再补等一整段音频', async () => {
  // 真机 2026-11-23 05:14：6.16 s 的 omni 音频要 1.0 s 才吐完，设备这 1 s 里已经在播；
  // 旧公式从「吐完的时刻」起算，播完之后又多锁了整整 1.05 s 的 speaking。
  const r = rig({
    deltas: Array.from({ length: 10 }, () => '念'),
    reply: { text: '念'.repeat(20), speech: '念'.repeat(20) },
    chunkDelayMs: 10, // 10 块 × 10 ms = 100 ms 才吐完；音频本身也是 100 ms
  });
  const result = await r.run();
  const tail = Date.now() - r.lastChunkAt;

  assert.ok(result);
  // 容差必须**大于一个轮询间隔**：等待循环每 `PLAYBACK_POLL_MS`（100 ms）才看一次表，
  // 所以「刚好到点」和「下一拍才到」都是正常结果 —— 容差取 60 时，服务器上
  // 定时器晚几毫秒就必然越界（旧代码在同一台机上也是 106 ms，不是回归）。
  // 这条断言要证的是「别再补等一整段音频（100 ms）」，不是「轮询精度」。
  assert.ok(
    tail < 180,
    `最后一块吐完之后又多锁了 ${tail} ms（音频本身才 100 ms）—— 基准要取首块时刻`,
  );
});

test('转交后被插话：不再等 dsh 的答案，立刻收轮', async () => {
  // 真机 2026-11-23 第 5 轮白等 2.5 s；`235949` 回放第 6 轮 3.2 s —— 这段里串行链
  // 卡着，下一轮的「出句→开轮」从源 187 ms 涨到 1304 ms。
  const r = rig({
    deltas: [],
    reply: { text: '行，我这就给你细说。', speech: '行，我这就给你细说。' },
    audio: ['行，我这就给你细说。'],
    omniDelegate: 'delegate',
    delegateHang: true,
  });
  const running = r.run();
  // 等 omni 那份音频出完、进入转交（`speaking` 是它已经出声的证据）
  for (let i = 0; i < 50 && r.fsm.state !== 'speaking'; i += 1) {
    await sleep(10);
  }
  await sleep(50);

  const bargedAt = Date.now();
  r.fsm.bargeIn('插话');
  const result = await running;

  assert.ok(result, '这一轮照样要有结果，只是提前收');
  assert.equal(result.interrupted, true);
  assert.ok(Date.now() - bargedAt < 1_000, `作废后还等了 ${Date.now() - bargedAt} ms`);
  assert.ok(r.logs.some((line) => line.includes('不再等 dsh')), '要留痕，否则只表现为"快了一点"');
  assert.equal(result.speech, '行，我这就给你细说。', '`said` 仍是垫话，不是没念的 dsh 答案');
});

test('omni 念了一段回执才发 tool_call：回执保留，dsh 的答案接在后面', async () => {
  // 真机 2026-11-23 15:2x 第 8/9 轮：omni 先念 2.2 s / 3.4 s，代码掐断重来，
  // 于是同一段内容听两遍（还夹 4.25 s 静音）。`audio.stop` 只清得掉设备**还没播**的
  // 缓冲，已经听到的追不回来 —— 掐断重说永远比"接在后面"更差。
  //
  // 现在的处置：omni 说的那句就是**回执**，留着；dsh 的答案接在后面。
  // "回执要短"靠提示词纪律（`omni-shadow.ts` 的 `DEFAULT_INSTRUCTIONS`），
  // 不在这里用阈值判 —— 判了就得二选一，"掐断重说"和"干脆不转交"两种都难看。
  const r = rig({
    deltas: [],
    reply: { text: '慢车道答复。', speech: '慢车道答复。', path: 'dsh' },
    audio: Array.from({ length: 160 }, () => '念'), // 160 × 10 ms = 1.6 s 回执
    omniDelegate: 'delegate',
    // 真机这一轮走的就是 omni：宿主据此不启流式 TTS，垫在后头的 dsh 答案才有泵可用
    willServe: true,
  });
  const result = await r.run();
  const end = r.payloads.find((p) => p.name === 'turn.end');

  assert.ok(result);
  assert.ok(
    r.logs.some((line) => line.includes('回执 → 转交 dsh')),
    '要留痕，否则"保留回执"这件事在档案里看不见',
  );
  assert.ok(
    !r.deviceCalls.some((call) => call.op === 'audio.stop'),
    '不许掐断：掐断之后 dsh 从头再说一遍就是同一段听两遍',
  );
  assert.equal(end?.data.path, 'dsh', '这一轮最终是 dsh 答的');
  assert.deepEqual(
    r.whole,
    ['慢车道答复。'],
    '回执已经原样下行过，dsh 的答案只能补在后面，不能被回执替换',
  );
});
test('omni 发 tool_call 且一个字都没出声：dsh 的答案走 TTS 念出来', async () => {
  const r = rig({
    deltas: [],
    reply: { text: '慢车道答复。', speech: '慢车道答复。', path: 'dsh' },
    willServe: true,
    audio: [], // 零音频：纯函数调用
    omniDelegate: 'delegate',
  });
  const result = await r.run();

  assert.ok(result);
  assert.equal(r.payloads.find((p) => p.name === 'turn.end')?.data['path'], 'dsh', '第二轮应当由 dsh 作答');
  assert.deepEqual(r.whole, ['慢车道答复。'], 'omni 没出声，dsh 的答案得走 TTS 念出来');
});

// ---------------------------------------------------------------- Wave 3-A 收口
//
// 这一组钉的是「只有一份内核、只有一份结算」：
// 以前 `TurnRunner` 私存一份 `KernelState`，相位在 FSM、账本在私货；插话当场结算
// 过的那一轮它看不见，协程跑到尾巴拿空播放区重算，于是"少听了一段"被算成"听全了"，
// 该吞的答案被回注。下面每一条都只在"共用同一个 runtime"时才成立。

test('与 DialogFsm 共用同一个内核：一轮跑完后账本里有**真实**结算', async () => {
  const r = rig({
    deltas: ['[平静]在呢。'],
    reply: { text: '[平静]在呢。', speech: '在呢。', path: 'fast' },
  });
  const result = await r.run();

  assert.ok(result);
  // 私有副本的账本永远是 `null` —— 这一轮喂过什么，只有共享的那个实例知道
  const ledger = r.fsm.runtime.state.ledger;
  assert.equal(ledger.lastSettled?.ticket.no, 1, `实际：${JSON.stringify(ledger)}`);
  assert.equal(ledger.lastSettled?.ticket.gen, 0);
  assert.equal(ledger.lastOutcome?.totalAudioMs, 10, '媒体游标要落在共享内核里（1 块 10 ms）');
  assert.equal(ledger.lastSettled?.inject, 'spoken', '听全了 → 按「他听到了」记');
  assert.equal(ledger.lastLane, 'cascade', '快车道在核心里叫 cascade');
});

test('dsh 轮次严格按内核 settlement.inject 回注：spoken / unspoken / none', async () => {
  // (a) 听全了 → spoken
  const full = rig({
    deltas: ['慢车道答复。'],
    reply: { text: '慢车道答复。', speech: '慢车道答复。', path: 'dsh' },
  });
  await full.run();
  assert.deepEqual(
    full.injected,
    [['你好', '慢车道答复。', 'spoken']],
    `听全了就该按「用户听到了」注；实际：${JSON.stringify(full.injected)}`,
  );

  // (b) 有结论但一个字都没播出去 → unspoken（真机 `20261123-053719` 第 2 轮：
  //     dsh 答出了书名，`audio_s=0.00`，不注的话下一轮它会把同一件事再编一遍）
  const silent = rig({
    deltas: [], // 流式口一个增量都没来 → 一个字节也没合成
    reply: { text: '其主之声。', speech: '其主之声。', path: 'dsh' },
  });
  await silent.run();
  assert.deepEqual(
    silent.injected,
    [['你好', '其主之声。', 'unspoken']],
    `没播出去也要注（口气是 unspoken）；实际：${JSON.stringify(silent.injected)}`,
  );

  // (c) 播了一半被打断 → none（用户少听了一段，不注）。
  //     音频要**先全部下发**再插话：抢在合成期插话只能说明「后面那段还没送出去」，
  //     媒体游标（唯一可信的尺子）会说"没少听"。所以先等内核的游标到 2 s，再开口。
  const cut = rig({
    deltas: Array.from({ length: 200 }, () => '念'),
    reply: { text: '念'.repeat(400), speech: '念'.repeat(400), path: 'dsh' },
  });
  const running = cut.run();
  for (
    let i = 0;
    i < 400 && cut.fsm.runtime.state.playback.sentMediaMs < 2_000;
    i += 1
  ) {
    await sleep(5);
  }
  cut.fsm.bargeIn('插话');
  const result = await running;
  assert.ok(result);
  assert.equal(result.interrupted, true);
  assert.deepEqual(
    cut.injected,
    [],
    `少听了一段就不注 —— 用户没听到的东西不该变成 omni 的记忆；实际：${JSON.stringify(cut.injected)}`,
  );
});

test('omni 转交 dsh：dsh 的增量走流式合成，不退化成整段', async () => {
  const r = rig({
    deltas: ['慢车道', '答复。'],
    reply: { text: '慢车道答复。', speech: '慢车道答复。', path: 'dsh' },
    audio: ['行，我这就查。'], // omni 的垫话：第一段
    omniDelegate: 'delegate',
    willServe: true,
  });
  const result = await r.run();

  assert.ok(result);
  assert.deepEqual(
    r.streamed,
    ['慢车道', '答复。'],
    'dsh 的增量必须接到 TTS 的流式口 —— 不接就只能等整段回来再合成（静音 5–20 s）',
  );
  assert.deepEqual(r.whole, [], '流式成功就不该再整段合成一遍');
  assert.equal(result.speech, '慢车道答复。');
  assert.equal(r.payloads.find((p) => p.name === 'turn.end')?.data['path'], 'dsh');
});

test('带图的轮次不走 omni：流式 TTS 照常开', async () => {
  // 带图那一轮一定走 dsh（omni 吃的是音频流，没有图片通道）。若还去问
  // `willServeAudio`，路由只看健康度会答「能」，于是流式 TTS 被关掉、
  // dsh 的答案只能整段合成 —— 带图那一轮白白慢好几秒。
  const r = rig({
    deltas: ['[平静]我看了，', '是只猫。'],
    reply: { text: '[平静]我看了，是只猫。', speech: '我看了，是只猫。', path: 'dsh' },
    willServe: true,
  });
  const result = await r.run({ mimeType: 'image/jpeg', data: 'AAAA' });

  assert.ok(result);
  assert.equal(r.willServeCalls, 0, '带图轮次连问都不该问');
  assert.deepEqual(r.streamed, ['[平静]我看了，', '是只猫。'], '流式 TTS 要照常收增量');
  assert.deepEqual(r.whole, [], '没走 omni 就不该退化成整段合成');
  assert.equal(r.payloads.find((p) => p.name === 'turn.end')?.data['path'], 'dsh');
});
