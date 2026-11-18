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
import type { AgentProvider, AgentReplyView, TtsProvider } from '../src/providers.ts';
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
  run(): Promise<TurnResult | null>;
}

function rig(options: {
  /** 模型吐的增量（每一步的原始文本，按到达顺序） */
  deltas: readonly string[];
  /** `reply()` 的返回；给 Error 就是这一轮模型挂了 */
  reply: AgentReplyView | Error;
  /** 流式合成收完文本后抛这个错 */
  streamError?: Error;
}): Rig {
  const streamed: string[] = [];
  const whole: string[] = [];
  const events: string[] = [];
  /** 事件的载荷（`turn.end` 的 `path` / `delegate` 只能从这里看） */
  const payloads: Array<{ name: string; data: Record<string, unknown> }> = [];
  const logs: string[] = [];
  let sink: ((text: string) => void) | null = null;

  const agent: AgentProvider = {
    name: 'fake',
    reply: async () => {
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
  const runner = new TurnRunner({
    clock,
    agent,
    tts,
    downlink: { sendAudio: () => {}, sendControl: () => {} },
    fsm: new DialogFsm(() => {}),
    playbackTailMs: 0,
    onEvent: (name, data) => {
      events.push(name);
      payloads.push({ name, data: data ?? {} });
    },
    onTurnFinished: () => {},
    onLiveAvailable: (next) => { sink = next; },
    log: (line) => { logs.push(line); },
  });
  return { streamed, whole, events, payloads, logs, run: () => runner.run('你好') };
}

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
