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
  /** 测试里要能主动插话（`interrupted` / `truncated` 的差别只有它能造出来） */
  readonly fsm: DialogFsm;
  run(): Promise<TurnResult | null>;
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
  /** 这一轮会不会走 omni（宿主据此不启流式 TTS） */
  willServe?: boolean;
}): Rig & { served: Array<[string, string]> } {
  const streamed: string[] = [];
  const whole: string[] = [];
  const events: string[] = [];
  /** 事件的载荷（`turn.end` 的 `path` / `delegate` 只能从这里看） */
  const payloads: Array<{ name: string; data: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const served: Array<[string, string]> = [];
  let sink: ((text: string) => void) | null = null;

  let calls = 0;
  const agent: AgentProvider = {
    name: 'fake',
    willServeAudio: () => options.willServe === true,
    noteServedTurn: (userText, said) => { served.push([userText, said]); },
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
        if (options.streamError === undefined) yield LOUD;
      }
      if (options.streamError !== undefined) throw options.streamError;
    },
  };
  const fsm = new DialogFsm(() => {});
  const runner = new TurnRunner({
    clock,
    agent,
    tts,
    downlink: { sendAudio: () => {}, sendControl: () => {} },
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
  return { streamed, whole, events, payloads, logs, served, fsm, run: () => runner.run('你好') };
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
});

test('omni 发 tool_call：就地切 dsh，dsh 的文本走整段合成', async () => {
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
