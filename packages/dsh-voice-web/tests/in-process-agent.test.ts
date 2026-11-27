/**
 * InProcessDshAgent：固定会话、流式增量、取消 / 换绑 / 放手、列表过滤。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanForSpeech, parseEmotion } from '../src/voice/emotion.ts';
import {
  InProcessDshAgent,
  type HostPromptPart,
  type HostSessionController,
  type HostSessionFollowFrame,
  type HostSessionSummary,
} from '../src/in-process-agent.ts';

const WORK = 'C:/voice-work';
const OPTS = { timeout: 5_000 };

const EMPTY = { text: '', speech: '', emotion: 'calm', path: 'dsh' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveOut: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveOut = resolve;
  });
  return { promise, resolve: () => { resolveOut(); } };
}

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('条件没有在 2s 内成立');
    await delay(5);
  }
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve(); }, { once: true });
  });
}

function followFrames(
  frames: readonly HostSessionFollowFrame[],
  signal: AbortSignal,
  hold?: Promise<void>,
): AsyncIterable<HostSessionFollowFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      const first = frames[0];
      if (first !== undefined) yield first;
      if (hold !== undefined) {
        await Promise.race([hold, whenAborted(signal)]);
        if (signal.aborted) return;
      }
      for (let i = 1; i < frames.length; i += 1) {
        if (signal.aborted) return;
        const frame = frames[i];
        if (frame !== undefined) yield frame;
      }
    },
  };
}

/** 按相对毫秒排期的 follow 脚本，用来让看门狗真的到期。 */
function scheduledFrames(
  steps: ReadonlyArray<{ at: number; frame: HostSessionFollowFrame }>,
  signal: AbortSignal,
): AsyncIterable<HostSessionFollowFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      const started = Date.now();
      for (const step of steps) {
        if (signal.aborted) return;
        const wait = step.at - (Date.now() - started);
        if (wait > 0) await Promise.race([delay(wait), whenAborted(signal)]);
        if (signal.aborted) return;
        yield step.frame;
      }
    },
  };
}

function plainFrames(text: string, cursor = 1): HostSessionFollowFrame[] {
  return [
    { type: 'snapshot', cursor, records: [], hasMore: false },
    {
      type: 'assistant-stream',
      frame: { type: 'chunk', chunk: { type: 'text-delta', text } },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: cursor + 1,
        data: { message: { content: [{ type: 'text', text }] } },
      },
    },
    {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: cursor + 2,
        data: { turn: 1, reason: { kind: 'stop' } },
      },
    },
  ];
}

function eventFrame(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  sessionId = 'sess-1',
): HostSessionFollowFrame {
  return { type: 'event', event: { type, seq, sessionId, data } };
}

function assistantFrame(seq: number, text: string): HostSessionFollowFrame {
  return eventFrame(seq, 'assistant/message', {
    message: { content: [{ type: 'text', text }] },
  });
}

/**
 * 边跑边 push 的 follow 流。常驻自发轮看门狗是长寿的，测试没法预先写死帧序：
 * 先推 snapshot 让它进入「已开流」，之后按用例把轮次一段段推进来。
 */
class LiveFollow {
  private readonly frames: HostSessionFollowFrame[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private sawAbort = false;

  get closed(): boolean {
    return this.ended;
  }

  get aborted(): boolean {
    return this.sawAbort;
  }

  push(frame: HostSessionFollowFrame): void {
    this.frames.push(frame);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  stream(signal: AbortSignal): AsyncIterable<HostSessionFollowFrame> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal.aborted) {
            if (self.frames.length === 0) {
              await Promise.race([
                new Promise<void>((resolve) => { self.wake = resolve; }),
                whenAborted(signal),
              ]);
              continue;
            }
            const frame = self.frames.shift();
            if (frame !== undefined) yield frame;
          }
        } finally {
          self.ended = true;
          self.sawAbort = signal.aborted;
        }
      },
    };
  }
}

class MockController implements HostSessionController {
  readonly creates: Array<{ cwd?: string; sessionId?: string; agentPreset?: string }> = [];
  readonly prompts: Array<{
    requestId: string;
    sessionId: string;
    mode: 'queue' | 'steer';
    content: readonly HostPromptPart[];
  }> = [];
  readonly cancels: Array<{ sessionId: string }> = [];
  readonly order: string[] = [];
  readonly follows: string[] = [];
  items: HostSessionSummary[] = [];

  private readonly scripts: Array<(signal: AbortSignal) => AsyncIterable<HostSessionFollowFrame>> = [];
  private created = 0;

  enqueue(frames: readonly HostSessionFollowFrame[], hold?: Promise<void>): void {
    this.scripts.push((signal) => followFrames(frames, signal, hold));
  }

  enqueueScript(script: (signal: AbortSignal) => AsyncIterable<HostSessionFollowFrame>): void {
    this.scripts.push(script);
  }

  list(
    _request: Record<string, never>,
    _signal: AbortSignal,
  ): Promise<{ readonly items: readonly HostSessionSummary[] }> {
    return Promise.resolve({ items: this.items });
  }

  create(
    request: { readonly cwd?: string; readonly sessionId?: string; readonly agentPreset?: string },
  ): Promise<{ readonly sessionId: string }> {
    this.creates.push({ ...request });
    this.created += 1;
    const sessionId = request.sessionId ?? `sess-${this.created}`;
    return Promise.resolve({ sessionId });
  }

  prompt(
    request: {
      readonly requestId: string;
      readonly sessionId: string;
      readonly mode: 'queue' | 'steer';
      readonly content: readonly HostPromptPart[];
      readonly clientTimeZone?: string;
    },
    _signal: AbortSignal,
  ): Promise<{ readonly accepted: true }> {
    this.order.push('prompt');
    this.prompts.push({
      requestId: request.requestId,
      sessionId: request.sessionId,
      mode: request.mode,
      content: request.content,
    });
    return Promise.resolve({ accepted: true });
  }

  cancel(request: { readonly sessionId: string }): { readonly accepted: true } {
    this.cancels.push({ sessionId: request.sessionId });
    return { accepted: true };
  }

  follow(
    request: {
      readonly address: { readonly kind: 'session'; readonly sessionId: string };
      readonly assistantStream?: true;
      readonly maxMessages?: number;
    },
    signal: AbortSignal,
  ): AsyncIterable<HostSessionFollowFrame> {
    this.order.push('follow');
    this.follows.push(request.address.sessionId);
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error(`没有为 ${request.address.sessionId} 准备 follow 脚本`);
    }
    return script(signal);
  }
}

test('未指定 sessionId 时自动创建，之后多轮复用', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  assert.equal(agent.name, 'dsh');
  assert.equal(agent.sessionId, null);
  assert.equal(agent.dshBusy(), false);
  agent.cancelTurn({ no: 1, gen: 1 });
  agent.detachTurn({ no: 1, gen: 1 });

  mock.enqueue(plainFrames('好'));
  mock.enqueue(plainFrames('也好', 10));
  const first = await agent.reply('第一句');
  const second = await agent.reply('第二句', undefined, '接着');

  assert.equal(first.text, '好');
  assert.equal(first.path, 'dsh');
  assert.equal(second.text, '也好');
  assert.equal(agent.sessionId, 'sess-1');
  assert.deepEqual(mock.creates, [{ cwd: WORK }]);
  assert.deepEqual(mock.follows, ['sess-1', 'sess-1']);
  assert.deepEqual(mock.order, ['follow', 'prompt', 'follow', 'prompt']);
  assert.equal(mock.prompts[0]?.sessionId, 'sess-1');
  assert.equal(mock.prompts[1]?.sessionId, 'sess-1');
  assert.equal(mock.prompts[0]?.mode, 'queue');
  assert.equal(mock.prompts[1]?.mode, 'queue');
  assert.equal(mock.prompts[0]?.content[0]?.type, 'text');
  assert.equal(mock.prompts[0]?.content[0] && 'text' in mock.prompts[0].content[0]
    ? mock.prompts[0].content[0].text
    : '', '哥刚才说：\n第一句');
  assert.equal(mock.prompts[1]?.content[0] && 'text' in mock.prompts[1].content[0]
    ? mock.prompts[1].content[0].text
    : '', '（系统注记：接着）\n哥刚才说：\n第二句');
  assert.notEqual(mock.prompts[0]?.requestId, mock.prompts[1]?.requestId);
  assert.equal((mock.prompts[0]?.requestId.length ?? 0) > 0, true);
  assert.equal(agent.dshBusy(), false);
});

test('流式增量进 live sink，解析情绪并清洗 Markdown', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const raw = '[开心]今天 **不错**';
  const cursor = 10;
  const deltas: string[] = [];
  agent.attachLiveSink((delta) => { deltas.push(delta); });
  mock.enqueue([
    { type: 'snapshot', cursor, records: [], hasMore: false },
    {
      type: 'event',
      event: { type: 'turn/end', seq: cursor, data: { turn: 0, reason: { kind: 'stop' } } },
    },
    {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', text: '[开心]' } },
    },
    {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 1, chunk: { type: 'text-delta', text: '今天 **不错**' } },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: cursor + 1,
        data: { message: { content: [{ type: 'text', text: raw }] } },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: cursor,
        data: { message: { content: [{ type: 'text', text: '脏数据' }] } },
      },
    },
    {
      type: 'event',
      event: { type: 'turn/end', seq: cursor + 2, data: { turn: 1, reason: { kind: 'stop' } } },
    },
  ]);

  const view = await agent.reply(
    '今天天气',
    { mimeType: 'image/png', data: 'aGVsbG8=' },
    '带图',
    { ticket: { no: 2, gen: 1 } },
  );

  const parsed = parseEmotion(raw);
  assert.deepEqual(deltas, ['[开心]', '今天 **不错**']);
  assert.equal(view.text, raw);
  assert.equal(view.emotion, 'happy');
  assert.equal(view.emotion, parsed.emotion);
  assert.equal(view.speech, cleanForSpeech(parsed.rest));
  assert.equal(view.speech.includes('*'), false);
  assert.equal(view.speech.includes('['), false);
  assert.equal(view.path, 'dsh');
  assert.equal(typeof view.firstTokenMs, 'number');
  const content = mock.prompts[0]?.content ?? [];
  assert.equal(content[0] && content[0].type === 'text' ? content[0].text : '', '（系统注记：带图）\n哥刚才说：\n今天天气');
  assert.deepEqual(content[1], { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' });
});

test('别名帧用累积流文本收尾', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  mock.enqueue([
    { type: 'snapshot', cursor: 3, records: [], hasMore: false },
    {
      type: 'assistant/stream',
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: '在的' } },
    },
    { type: 'turn/done', seq: 4 },
  ]);
  const view = await agent.reply('在吗');
  assert.equal(view.text, '在的');
  assert.equal(view.speech, '在的');
  assert.equal(view.emotion, 'calm');
  assert.equal(view.path, 'dsh');
});

test('cancelTurn 只在票据匹配时取消', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const hold = deferred();
  mock.enqueue(plainFrames('不会回到这里'), hold.promise);
  const pending = agent.reply('取消我', undefined, undefined, { ticket: { no: 1, gen: 1 } });
  await until(() => mock.prompts.length === 1);
  assert.equal(agent.dshBusy(), true);

  agent.cancelTurn({ no: 1, gen: 2 });
  await delay(30);
  assert.deepEqual(mock.cancels, []);
  assert.equal(agent.dshBusy(), true);

  agent.cancelTurn({ no: 1, gen: 1 });
  assert.deepEqual(mock.cancels, [{ sessionId: 'sess-1' }]);
  assert.deepEqual(await pending, EMPTY);
  assert.equal(agent.dshBusy(), false);
  hold.resolve();
});

test('bindSession 取消旧轮并把后续轮次切到新 id', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const hold = deferred();
  mock.enqueue(plainFrames('旧答复'), hold.promise);
  mock.enqueue(plainFrames('新答复', 4));

  const pending = agent.reply('第一句', undefined, undefined, { ticket: { no: 1, gen: 1 } });
  await until(() => mock.prompts.length === 1);
  assert.equal(mock.prompts[0]?.sessionId, 'sess-1');

  agent.bindSession('sess-2');
  assert.deepEqual(await pending, EMPTY);
  assert.deepEqual(mock.cancels, [{ sessionId: 'sess-1' }]);
  assert.equal(agent.sessionId, 'sess-2');

  const view = await agent.reply('第二句');
  assert.equal(mock.creates.length, 1);
  assert.equal(mock.prompts[1]?.sessionId, 'sess-2');
  assert.deepEqual(mock.follows, ['sess-1', 'sess-2']);
  assert.equal(view.text, '新答复');
  assert.equal(view.path, 'dsh');
  hold.resolve();
});

test('detachTurn 立即放开调用方，答完后交给播报和回注', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const raw = '[开心]查完了 **结果**';
  const hold = deferred();
  const delivered: {
    announced: { speech: string; emotion: string | undefined } | null;
    sunk: { userText: string; answer: string; spoken: boolean } | null;
  } = { announced: null, sunk: null };
  agent.setAnnouncer((speech, emotion) => {
    delivered.announced = { speech, emotion };
  });
  agent.setDetachedAnswerSink((userText, answer, spoken) => {
    delivered.sunk = { userText, answer, spoken };
  });
  mock.enqueue([
    { type: 'snapshot', cursor: 2, records: [], hasMore: false },
    {
      type: 'assistant-stream',
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: raw } },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 3,
        data: { message: { content: [{ type: 'text', text: raw }] } },
      },
    },
    {
      type: 'event',
      event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'stop' } } },
    },
  ], hold.promise);

  const pending = agent.reply('帮我查', undefined, undefined, { ticket: { no: 3, gen: 1 } });
  await until(() => mock.prompts.length === 1);
  agent.detachTurn({ no: 3, gen: 9 });
  const early = await Promise.race([
    pending.then(() => 'settled' as const),
    delay(40).then(() => 'pending' as const),
  ]);
  assert.equal(early, 'pending');
  assert.equal(mock.cancels.length, 0);

  agent.detachTurn({ no: 3, gen: 1 });
  assert.deepEqual(await pending, EMPTY);
  assert.equal(agent.dshBusy(), true);
  assert.equal(delivered.announced === null, true);

  hold.resolve();
  await until(() => delivered.announced !== null && delivered.sunk !== null);
  const heard = delivered.announced;
  const remembered = delivered.sunk;
  assert.ok(heard);
  assert.ok(remembered);
  const parsed = parseEmotion(raw);
  assert.equal(heard.emotion, 'happy');
  assert.equal(heard.speech, cleanForSpeech(parsed.rest));
  assert.equal(heard.speech.includes('*'), false);
  assert.equal(remembered.answer, raw);
  assert.equal(remembered.spoken, true);
  assert.equal(remembered.userText.includes('哥刚才说'), true);
  assert.equal(remembered.userText.includes('帮我查'), true);
  assert.equal(agent.dshBusy(), false);
  assert.equal(mock.cancels.length, 0);
});

test('listSessions 去掉子代理并按 updatedAt 倒序', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  mock.items = [
    { sessionId: 'old', updatedAt: 10 },
    { sessionId: 'child', updatedAt: 90, origin: 'subagent' },
    { sessionId: 'mid', updatedAt: 40 },
    { sessionId: 'new', updatedAt: 70 },
    { sessionId: 'other-child', updatedAt: 100, origin: 'subagent' },
  ];
  const listed = await agent.listSessions();
  assert.deepEqual(listed.map((item) => item.sessionId), ['new', 'mid', 'old']);
  const top = await agent.listSessions(1);
  assert.deepEqual(top.map((item) => item.sessionId), ['new']);
  assert.equal(mock.creates.length, 0);
});

test('构造时的 sessionId 交给 create 收养，撤回不换会话', OPTS, async () => {
  const mock = new MockController();
  const logs: string[] = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    sessionId: 'fixed-9',
    log: (line) => { logs.push(line); },
  });
  assert.equal(agent.sessionId, null);
  assert.equal(await agent.ensureSession(), 'fixed-9');
  assert.equal(await agent.ensureSession(), 'fixed-9');
  assert.deepEqual(mock.creates, [{ cwd: WORK, sessionId: 'fixed-9' }]);
  assert.equal(agent.taskStatus(), '后台任务：现在没有任何后台任务在跑，也没刚结束的。');

  agent.rollbackTurn({ no: 4, gen: 1 });
  assert.equal(agent.takeRollbackOutcome(), 'none');
  assert.equal(agent.takeRollbackOutcome(), 'none');
  assert.equal(agent.sessionId, 'fixed-9');
  assert.equal(logs.some((line) => line.includes('跳过') && line.includes('fork')), true);

  agent.reset();
  assert.equal(agent.sessionId, null);
  mock.enqueue(plainFrames('重置后'));
  const view = await agent.reply('再来');
  assert.equal(view.text, '重置后');
  assert.equal(mock.creates.length, 2);
  assert.equal(mock.creates[1]?.sessionId, undefined);
  assert.notEqual(agent.sessionId, 'fixed-9');
});

test('bindSession(null) 后新建会话，不再跳回启动时的 configuredId', OPTS, async () => {
  const mock = new MockController();
  mock.items = [
    { sessionId: 'sess-init', updatedAt: 50, cwd: 'C:/elsewhere' },
  ];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    sessionId: 'sess-init',
  });
  assert.equal(agent.targetSessionId, 'sess-init');
  assert.equal(await agent.ensureSession(), 'sess-init');
  assert.equal(agent.sessionId, 'sess-init');
  assert.equal(mock.creates.length, 0);

  agent.bindSession(null);
  assert.equal(agent.targetSessionId, null);
  assert.equal(agent.sessionId, null);

  const created = await agent.ensureSession();
  assert.notEqual(created, 'sess-init');
  assert.equal(agent.sessionId, created);
  assert.equal(agent.targetSessionId, created);
  assert.equal(mock.creates.length, 1);
  assert.deepEqual(mock.creates[0], { cwd: WORK });
});

test('选中其他会话后再 bindSession(null)，新建时不跳回启动 id', OPTS, async () => {
  const mock = new MockController();
  mock.items = [
    { sessionId: 'sess-init', updatedAt: 50 },
  ];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    sessionId: 'sess-init',
  });
  agent.bindSession('sess-other');
  assert.equal(agent.sessionId, 'sess-other');
  assert.equal(agent.targetSessionId, 'sess-other');

  agent.bindSession(null);
  assert.equal(agent.targetSessionId, null);
  assert.equal(agent.sessionId, null);

  const created = await agent.ensureSession();
  assert.notEqual(created, 'sess-init');
  assert.notEqual(created, 'sess-other');
  assert.equal(mock.creates.length, 1);
  assert.deepEqual(mock.creates[0], { cwd: WORK });
});

test('尚未绑定时 bindSession(null) 也立刻丢掉启动 id', OPTS, async () => {
  const mock = new MockController();
  mock.items = [
    { sessionId: 'sess-init', updatedAt: 50 },
  ];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    sessionId: 'sess-init',
  });
  assert.equal(agent.targetSessionId, 'sess-init');
  agent.bindSession(null);
  assert.equal(agent.targetSessionId, null);
  assert.equal(agent.sessionId, null);

  const created = await agent.ensureSession();
  assert.notEqual(created, 'sess-init');
  assert.equal(agent.sessionId, created);
  assert.equal(mock.creates.length, 1);
  assert.equal(mock.creates[0]?.sessionId, undefined);
});

test('在途 open 被换绑作废后，过期 id 不会写回', OPTS, async () => {
  const mock = new MockController();
  mock.items = [
    { sessionId: 'sess-init', updatedAt: 50 },
  ];
  const gate = deferred();
  const controller: HostSessionController = {
    list: (request, signal) => gate.promise.then(() => mock.list(request, signal)),
    create: (request) => mock.create(request),
    prompt: (request, signal) => mock.prompt(request, signal),
    cancel: (request) => mock.cancel(request),
    follow: (request, signal) => mock.follow(request, signal),
  };
  const agent = new InProcessDshAgent({
    controller,
    workDir: WORK,
    sessionId: 'sess-init',
  });
  const pending = agent.ensureSession();
  const rejected = assert.rejects(pending);
  agent.bindSession(null);
  assert.equal(agent.targetSessionId, null);
  assert.equal(agent.sessionId, null);
  gate.resolve();
  await rejected;
  assert.equal(agent.sessionId, null);
  assert.equal(agent.targetSessionId, null);
  assert.equal(mock.creates.length, 0);

  const created = await agent.ensureSession();
  assert.notEqual(created, 'sess-init');
  assert.equal(mock.creates.length, 1);
  assert.equal(mock.creates[0]?.sessionId, undefined);
});

test('构造时传入已存在的跨目录会话直接采用，不误调 create', OPTS, async () => {
  const mock = new MockController();
  mock.items = [
    { sessionId: 'existing-web-1', updatedAt: 100, cwd: 'C:/tmpWorkspace' },
  ];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    sessionId: 'existing-web-1',
  });
  assert.equal(agent.sessionId, null);
  assert.equal(agent.targetSessionId, 'existing-web-1');

  mock.enqueue(plainFrames('直接续接成功'));
  const view = await agent.reply('继续刚才的');

  assert.equal(agent.sessionId, 'existing-web-1');
  assert.equal(agent.targetSessionId, 'existing-web-1');
  assert.equal(mock.creates.length, 0);
  assert.deepEqual(mock.follows, ['existing-web-1']);
  assert.equal(mock.prompts[0]?.sessionId, 'existing-web-1');
  assert.equal(view.text, '直接续接成功');
});

test('长编译 job 在跑时不会被空闲看门狗误杀', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    idleTimeoutMs: 60,
  });
  const cursor = 10;
  mock.enqueueScript((signal) => scheduledFrames([
    { at: 0, frame: { type: 'snapshot', cursor, records: [], hasMore: false } },
    {
      at: 5,
      frame: {
        type: 'event',
        event: {
          type: 'job/registered',
          seq: cursor + 1,
          sessionId: 'sess-1',
          data: { jobId: 'j1', kind: 'pwsh', label: 'npm run build' },
        },
      },
    },
    {
      at: 150,
      frame: {
        type: 'event',
        event: {
          type: 'job/settled',
          seq: cursor + 2,
          sessionId: 'sess-1',
          data: { jobId: 'j1' },
        },
      },
    },
    {
      at: 160,
      frame: {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: cursor + 3,
          sessionId: 'sess-1',
          data: { message: { content: [{ type: 'text', text: '编译通过' }] } },
        },
      },
    },
    {
      at: 170,
      frame: {
        type: 'event',
        event: {
          type: 'turn/end',
          seq: cursor + 4,
          sessionId: 'sess-1',
          data: { turn: 1, reason: { kind: 'stop' } },
        },
      },
    },
  ], signal));

  const view = await agent.reply('跑个编译');
  assert.equal(view.text, '编译通过');
  assert.equal(view.path, 'dsh');
  assert.deepEqual(mock.cancels, []);
});

test('多步活动不断续命，不会被空闲看门狗误杀', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    idleTimeoutMs: 60,
  });
  const cursor = 20;
  const event = (
    at: number,
    type: string,
    seq: number,
    data: Record<string, unknown>,
  ): { at: number; frame: HostSessionFollowFrame } => ({
    at,
    frame: { type: 'event', event: { type, seq, sessionId: 'sess-1', data } },
  });
  mock.enqueueScript((signal) => scheduledFrames([
    { at: 0, frame: { type: 'snapshot', cursor, records: [], hasMore: false } },
    event(35, 'step/start', cursor + 1, { stepId: 's1' }),
    event(70, 'tool/call', cursor + 2, { tool: 'grep' }),
    {
      at: 105,
      frame: {
        type: 'assistant-stream',
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: '还在跑' } },
      },
    },
    event(140, 'step/start', cursor + 3, { stepId: 's2' }),
    event(175, 'assistant/message', cursor + 4, {
      message: { content: [{ type: 'text', text: '多步完成' }] },
    }),
    event(200, 'turn/end', cursor + 5, { turn: 7, reason: { kind: 'stop' } }),
  ], signal));

  const view = await agent.reply('一步一步来');
  assert.equal(view.text, '多步完成');
  assert.deepEqual(mock.cancels, []);
});

test('真正卡死才超时，并同步取消宿主那一轮', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    idleTimeoutMs: 50,
  });
  const hold = deferred();
  mock.enqueue(plainFrames('不会回到这里'), hold.promise);

  await assert.rejects(agent.reply('卡住不动'), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.match((error as Error).message, /空闲超时/);
    return true;
  });
  assert.deepEqual(mock.cancels, [{ sessionId: 'sess-1' }]);
  hold.resolve();
});

test('宿主侧 turn/end aborted 抛 AbortError，不播报也不回注', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const announced: string[] = [];
  const sunk: string[] = [];
  agent.setAnnouncer((speech) => { announced.push(speech); });
  agent.setDetachedAnswerSink((userText) => { sunk.push(userText); });
  mock.enqueue([
    { type: 'snapshot', cursor: 1, records: [], hasMore: false },
    {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: 2,
        data: { turn: 29, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      },
    },
  ]);

  await assert.rejects(agent.reply('跑一下'), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).name, 'AbortError');
    assert.equal((error as { code?: unknown }).code, 'TURN_ABORTED');
    return true;
  });
  assert.deepEqual(announced, []);
  assert.deepEqual(sunk, []);
  assert.equal(agent.dshBusy(), false);
});

test('队列模式忽略旧轮的 turn/end，不把上一轮收尾当本轮结束', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const cursor = 30;
  mock.enqueue([
    {
      type: 'snapshot',
      cursor,
      status: 'running',
      records: [],
      hasMore: false,
    },
    {
      type: 'event',
      event: { type: 'turn/end', seq: cursor + 1, data: { turn: 4, reason: { kind: 'stop' } } },
    },
    {
      type: 'event',
      event: { type: 'turn/start', seq: cursor + 2, data: { turn: 5 } },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: cursor + 3,
        data: { message: { content: [{ type: 'text', text: '本轮答案' }] } },
      },
    },
    {
      type: 'event',
      event: { type: 'turn/end', seq: cursor + 4, data: { turn: 5, reason: { kind: 'stop' } } },
    },
  ]);

  const view = await agent.reply('排队的问题');
  assert.equal(view.text, '本轮答案');
  assert.equal(view.speech, '本轮答案');
});

test('subagent + [ASYNC] 立即释放主对话，子代理仍记在后台任务里', OPTS, async () => {
  const mock = new MockController();
  const logs: string[] = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    log: (line) => { logs.push(line); },
  });
  const cursor = 1;
  mock.enqueue([
    { type: 'snapshot', cursor, records: [], hasMore: false },
    eventFrame(cursor + 1, 'subagent/catalog', { childId: 'child-1', label: '查天气' }),
    assistantFrame(cursor + 2, '[得意][ASYNC]'),
    eventFrame(cursor + 3, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]);

  const view = await agent.reply('帮我查天气');

  // 关键：不能因为「清洗后没有可朗读的内容」抛错，也不能把空答复交给上游当终态。
  assert.equal(view.asyncDispatched, true);
  assert.equal(view.text, '');
  assert.equal(view.speech, '');
  assert.equal(view.emotion, 'proud');
  assert.equal(view.path, 'dsh');
  assert.equal(agent.dshBusy(), false);
  assert.equal(logs.some((line) => line.includes('已异步派发后台')), true);

  // 正常 completed 的 turn/end 不能把没回结果的子代理忘掉 —— 看门狗靠它续命。
  const status = agent.taskStatus();
  assert.equal(status.includes('子代理「查天气」'), true);
  assert.equal(status.includes('还没回结果'), true);
});

test('未结算的 job/registered 也算异步派发，哪怕正文只有一句“已启动”', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const cursor = 5;
  mock.enqueue([
    { type: 'snapshot', cursor, records: [], hasMore: false },
    eventFrame(cursor + 1, 'job/registered', { jobId: 'j1', kind: 'pwsh', label: 'npm run build' }),
    assistantFrame(cursor + 2, '已启动后台任务'),
    eventFrame(cursor + 3, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
  ]);

  const view = await agent.reply('跑个构建');

  assert.equal(view.asyncDispatched, true);
  assert.equal(view.speech, '');
  assert.equal(agent.dshBusy(), false);
  const status = agent.taskStatus();
  assert.equal(status.includes('pwsh「npm run build」'), true);
  assert.equal(status.includes('已跑'), true);
});

test('job 在同轮内 register 又 settle 时照常返回正文', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });
  const cursor = 20;
  mock.enqueue([
    { type: 'snapshot', cursor, records: [], hasMore: false },
    eventFrame(cursor + 1, 'job/registered', { jobId: 'j1', kind: 'pwsh', label: 'npm run build' }),
    eventFrame(cursor + 2, 'job/settled', { jobId: 'j1' }),
    assistantFrame(cursor + 3, '[开心]编译通过'),
    eventFrame(cursor + 4, 'turn/end', { turn: 3, reason: { kind: 'stop' } }),
  ]);

  const view = await agent.reply('跑个编译');

  assert.equal(view.asyncDispatched, undefined);
  assert.equal(view.text, '[开心]编译通过');
  assert.equal(view.speech, '编译通过');
  assert.equal(view.emotion, 'happy');
  const status = agent.taskStatus();
  assert.equal(status.includes('在跑 1 个'), false);
  assert.equal(status.includes('刚结束'), true);
});

test('常驻看门狗只念自发轮：网页输入、语音 prompt、[ASYNC] 全部跳过', OPTS, async () => {
  const mock = new MockController();
  const watcher = new LiveFollow();
  const announced: Array<{ speech: string; emotion: string | undefined }> = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    watchSpontaneous: true,
  });
  agent.setAnnouncer((speech, emotion) => { announced.push({ speech, emotion }); });

  // 常驻看门狗在 ensureSession 里先开流，所以它的脚本要排在回复脚本前面。
  mock.enqueueScript((signal) => watcher.stream(signal));
  mock.enqueue(plainFrames('在的', 1));
  const first = await agent.reply('在吗');
  assert.equal(first.text, '在的');
  assert.equal(mock.follows.length, 2);
  watcher.push({ type: 'snapshot', cursor: 100, records: [], hasMore: false });
  await delay(10);

  // 1) 子代理跑完：dsh 自己开一轮，结果要念出来。
  watcher.push(eventFrame(101, 'turn/start', { turn: 3 }));
  watcher.push(eventFrame(102, 'user/message', {
    message: { content: [{ type: 'text', text: '[subagent-settled]' }] },
    source: { kind: 'subagent-settled', senderSessionId: 'child-1' },
  }));
  watcher.push(assistantFrame(103, '[开心]后台**跑完**了'));
  watcher.push(eventFrame(104, 'turn/end', { turn: 3, reason: { kind: 'stop' } }));
  await until(() => announced.length === 1);
  assert.equal(announced[0]?.speech, '后台跑完了');
  assert.equal(announced[0]?.emotion, 'happy');

  // 2) 后台 job 结算：同样是自发轮。
  watcher.push(eventFrame(105, 'turn/start', { turn: 4 }));
  watcher.push(eventFrame(106, 'user/message', {
    source: { kind: 'tool-jobs' },
  }));
  watcher.push(assistantFrame(107, '任务都结束了'));
  watcher.push(eventFrame(108, 'turn/end', { turn: 4, reason: { kind: 'stop' } }));
  await until(() => announced.length === 2);
  assert.equal(announced[1]?.speech, '任务都结束了');

  // 3) 用户在网页里打字：不许抢话。
  watcher.push(eventFrame(109, 'turn/start', { turn: 5 }));
  watcher.push(eventFrame(110, 'user/message', {
    source: { kind: 'user', rpcId: 'web-rpc-9' },
  }));
  watcher.push(assistantFrame(111, '网页里的答复'));
  watcher.push(eventFrame(112, 'turn/end', { turn: 5, reason: { kind: 'stop' } }));
  await delay(40);
  assert.equal(announced.length, 2);

  // 4) 我们自己 prompt 的轮（rpcId 在语音侧登记过）：正文已经由 reply() 出口念过。
  mock.enqueue(plainFrames('第二句', 200));
  const second = agent.reply('再问一句');
  await until(() => mock.prompts.length === 2);
  const ourRpcId = mock.prompts[1]?.requestId;
  assert.equal(typeof ourRpcId, 'string');
  watcher.push(eventFrame(201, 'turn/start', { turn: 6 }));
  watcher.push(eventFrame(202, 'user/message', {
    source: { kind: 'user', rpcId: ourRpcId },
  }));
  watcher.push(assistantFrame(203, '第二句'));
  watcher.push(eventFrame(204, 'turn/end', { turn: 6, reason: { kind: 'stop' } }));
  assert.equal((await second).text, '第二句');
  await delay(40);
  assert.equal(announced.length, 2);

  // 5) 自发轮自己又派了活：这一轮只是转手，不是结果。
  watcher.push(eventFrame(205, 'turn/start', { turn: 7 }));
  watcher.push(eventFrame(206, 'user/message', { source: { kind: 'tool-jobs' } }));
  watcher.push(eventFrame(207, 'job/registered', { jobId: 'j7', kind: 'pwsh', label: '慢任务' }));
  watcher.push(assistantFrame(208, '已开始后台任务'));
  watcher.push(eventFrame(209, 'turn/end', { turn: 7, reason: { kind: 'stop' } }));

  // 6) 纯 [ASYNC] 的自发轮也不念。
  watcher.push(eventFrame(210, 'turn/start', { turn: 8 }));
  watcher.push(eventFrame(211, 'user/message', { source: { kind: 'tool-jobs' } }));
  watcher.push(assistantFrame(212, '[平静][ASYNC]'));
  watcher.push(eventFrame(213, 'turn/end', { turn: 8, reason: { kind: 'stop' } }));
  await delay(60);
  assert.equal(announced.length, 2);

  agent.dispose();
});

test('无票据 cancelTurn 在主轮空闲时也停掉子代理和后台 job', OPTS, async () => {
  const mock = new MockController();
  const kills: Array<{ sessionId: string; jobId: string }> = [];
  const logs: string[] = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    log: (line) => { logs.push(line); },
    jobController: {
      kill(request) {
        kills.push({ sessionId: request.sessionId, jobId: request.jobId });
        return { accepted: true };
      },
    },
  });
  const cursor = 1;
  mock.enqueue([
    { type: 'snapshot', cursor, records: [], hasMore: false },
    eventFrame(cursor + 1, 'subagent/catalog', { childId: 'child-9', label: '深挖资料' }),
    eventFrame(cursor + 2, 'job/registered', { jobId: 'j9', kind: 'pwsh', label: 'grep 日志' }),
    assistantFrame(cursor + 3, '[平静][ASYNC]'),
    eventFrame(cursor + 4, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]);

  const view = await agent.reply('去查一下');
  assert.equal(view.asyncDispatched, true);
  assert.equal(agent.dshBusy(), false);
  assert.deepEqual(mock.cancels, []);

  agent.cancelTurn();

  assert.deepEqual(mock.cancels, [{ sessionId: 'child-9' }]);
  assert.deepEqual(kills, [{ sessionId: 'sess-1', jobId: 'j9' }]);
  assert.equal(agent.taskStatus(), '后台任务：现在没有任何后台任务在跑，也没刚结束的。');
  assert.equal(logs.some((line) => line.includes('已停掉 1 个子代理、1 个后台任务')), true);
  assert.equal(logs.some((line) => line.includes('主对话空闲')), true);
});

test('dispose 会干净地掐掉常驻看门狗，不再重连', OPTS, async () => {
  const mock = new MockController();
  const watcher = new LiveFollow();
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    watchSpontaneous: true,
  });
  mock.enqueueScript((signal) => watcher.stream(signal));

  assert.equal(await agent.ensureSession(), 'sess-1');
  assert.deepEqual(mock.follows, ['sess-1']);
  watcher.push({ type: 'snapshot', cursor: 1, records: [], hasMore: false });
  await delay(10);
  assert.equal(watcher.aborted, false);

  agent.dispose();
  await until(() => watcher.closed);
  assert.equal(watcher.aborted, true);

  // 500 ms 后重连窗口过去，仍然只有最初那一条 follow —— 没有留下定时器。
  await delay(700);
  assert.deepEqual(mock.follows, ['sess-1']);
  assert.equal(watcher.closed, true);
  agent.dispose();
});

// ---------------------------------------------------------------- asyncTargetId / 结算去重

test('send_message 复用子代理时返回 asyncTargetId：JSON 字符串与对象参数都认', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });

  mock.enqueue([
    { type: 'snapshot', cursor: 1, records: [], hasMore: false },
    eventFrame(2, 'tool/call', {
      name: 'send_message',
      arguments: '{"agent_id":"sub-9","message":"继续卷二"}',
    }),
    assistantFrame(3, '[平静][ASYNC]'),
    eventFrame(4, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]);
  const first = await agent.reply('继续卷二');
  assert.equal(first.asyncDispatched, true);
  assert.equal(first.asyncTargetId, 'sub-9');

  mock.enqueue([
    { type: 'snapshot', cursor: 10, records: [], hasMore: false },
    eventFrame(11, 'tool/call', {
      name: 'send_message',
      arguments: { agentId: 'sub-10' },
    }),
    assistantFrame(12, '[平静][ASYNC]'),
    eventFrame(13, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
  ]);
  const second = await agent.reply('继续卷三');
  assert.equal(second.asyncDispatched, true);
  assert.equal(second.asyncTargetId, 'sub-10');
});

test('subagent/catalog 与 job/registered 也把目标 id 带进 asyncTargetId', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });

  mock.enqueue([
    { type: 'snapshot', cursor: 1, records: [], hasMore: false },
    eventFrame(2, 'subagent/catalog', { childId: 'child-7', label: '查天气' }),
    assistantFrame(3, '[平静][ASYNC]'),
    eventFrame(4, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]);
  const child = await agent.reply('查天气');
  assert.equal(child.asyncDispatched, true);
  assert.equal(child.asyncTargetId, 'child-7');

  mock.enqueue([
    { type: 'snapshot', cursor: 10, records: [], hasMore: false },
    eventFrame(11, 'job/registered', { jobId: 'j-1', kind: 'pwsh', label: 'npm run build' }),
    assistantFrame(12, '已启动后台任务'),
    eventFrame(13, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
  ]);
  const job = await agent.reply('跑个构建');
  assert.equal(job.asyncDispatched, true);
  assert.equal(job.asyncTargetId, 'j-1');
});

test('agent-message 播报后同子代理的 subagent-settled 被静默抑制，只播一次并带 targetId', OPTS, async () => {
  const mock = new MockController();
  const watcher = new LiveFollow();
  const announced: Array<{ speech: string; emotion: string | undefined; targetId: string | undefined }> = [];
  const logs: string[] = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    watchSpontaneous: true,
    log: (line) => { logs.push(line); },
  });
  agent.setAnnouncer((speech, emotion, meta) => {
    announced.push({ speech, emotion, targetId: meta?.targetId });
  });

  mock.enqueueScript((signal) => watcher.stream(signal));
  mock.enqueue(plainFrames('在的', 1));
  await agent.reply('在吗');
  watcher.push({ type: 'snapshot', cursor: 100, records: [], hasMore: false });
  await delay(10);

  // 第一波：可续写子代理的 agent-message，正常播报。
  watcher.push(eventFrame(101, 'turn/start', { turn: 2 }));
  watcher.push(eventFrame(102, 'user/message', {
    message: { content: [{ type: 'text', text: '卷一结论' }] },
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-1' },
  }));
  watcher.push(assistantFrame(103, '[开心]卷一结论'));
  watcher.push(eventFrame(104, 'turn/end', { turn: 2, reason: { kind: 'stop' } }));
  await until(() => announced.length === 1);
  assert.deepEqual(announced[0], { speech: '卷一结论', emotion: 'happy', targetId: 'child-1' });

  // 300 ms 后的 subagent-settled：同源同内容，不许再念一遍。
  watcher.push(eventFrame(105, 'turn/start', { turn: 3 }));
  watcher.push(eventFrame(106, 'user/message', {
    message: { content: [{ type: 'text', text: '卷一结论' }] },
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-1' },
  }));
  watcher.push(assistantFrame(107, '[开心]卷一结论'));
  watcher.push(eventFrame(108, 'turn/end', { turn: 3, reason: { kind: 'stop' } }));
  await delay(60);
  assert.equal(announced.length, 1, '重复的结算通知不得二次播报');
  assert.equal(logs.some((line) => line.includes('跳过同子代理重复结算通知')), true);

  agent.dispose();
});

test('子代理没发 agent-message 直接 subagent-settled（失败退出）时仍播报一次', OPTS, async () => {
  const mock = new MockController();
  const watcher = new LiveFollow();
  const announced: Array<{ speech: string; targetId: string | undefined }> = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    watchSpontaneous: true,
  });
  agent.setAnnouncer((speech, _emotion, meta) => {
    announced.push({ speech, targetId: meta?.targetId });
  });

  mock.enqueueScript((signal) => watcher.stream(signal));
  mock.enqueue(plainFrames('在的', 1));
  await agent.reply('在吗');
  watcher.push({ type: 'snapshot', cursor: 100, records: [], hasMore: false });
  await delay(10);

  watcher.push(eventFrame(101, 'turn/start', { turn: 2 }));
  watcher.push(eventFrame(102, 'user/message', {
    message: { content: [{ type: 'text', text: '子代理没跑成' }] },
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-2' },
  }));
  watcher.push(assistantFrame(103, '[担心]子代理没跑成'));
  watcher.push(eventFrame(104, 'turn/end', { turn: 2, reason: { kind: 'stop' } }));
  await until(() => announced.length === 1);
  assert.equal(announced[0]?.speech, '子代理没跑成');
  assert.equal(announced[0]?.targetId, 'child-2');

  agent.dispose();
});

test('第一波播报后再次 send_message 唤醒同一子代理，第二波结算不被去重误杀', OPTS, async () => {
  const mock = new MockController();
  const watcher = new LiveFollow();
  const announced: Array<{ speech: string; targetId: string | undefined }> = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    watchSpontaneous: true,
  });
  agent.setAnnouncer((speech, _emotion, meta) => {
    announced.push({ speech, targetId: meta?.targetId });
  });

  mock.enqueueScript((signal) => watcher.stream(signal));
  mock.enqueue(plainFrames('在的', 1));
  await agent.reply('在吗');
  watcher.push({ type: 'snapshot', cursor: 100, records: [], hasMore: false });
  await delay(10);

  // 第一波 agent-message：播报后去重记录仍留着（第一波没有补 settled）。
  watcher.push(eventFrame(101, 'turn/start', { turn: 2 }));
  watcher.push(eventFrame(102, 'user/message', {
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-1' },
  }));
  watcher.push(assistantFrame(103, '卷一查完了'));
  watcher.push(eventFrame(104, 'turn/end', { turn: 2, reason: { kind: 'stop' } }));
  await until(() => announced.length === 1);

  // 第二波：send_message 重新唤醒同一个子代理，应清掉上一波的去重记录。
  watcher.push(eventFrame(105, 'turn/start', { turn: 3 }));
  watcher.push(eventFrame(106, 'tool/call', {
    name: 'send_message',
    arguments: '{"agent_id":"child-1","message":"继续卷二"}',
  }));
  watcher.push(assistantFrame(107, '[平静][ASYNC]'));
  watcher.push(eventFrame(108, 'turn/end', { turn: 3, reason: { kind: 'stop' } }));
  await delay(40);

  // 第二波直接以 subagent-settled 结束：仍要播报。
  watcher.push(eventFrame(109, 'turn/start', { turn: 4 }));
  watcher.push(eventFrame(110, 'user/message', {
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-1' },
  }));
  watcher.push(assistantFrame(111, '卷二也查完了'));
  watcher.push(eventFrame(112, 'turn/end', { turn: 4, reason: { kind: 'stop' } }));
  await until(() => announced.length === 2);
  assert.equal(announced[1]?.speech, '卷二也查完了');
  assert.equal(announced[1]?.targetId, 'child-1');

  agent.dispose();
});

test('tool-jobs 回调轮用 tool/call(job_output) 的 job_id 作为 meta.targetId', OPTS, async () => {
  const mock = new MockController();
  const watcher = new LiveFollow();
  const announced: Array<{ speech: string; targetId: string | undefined }> = [];
  const agent = new InProcessDshAgent({
    controller: mock,
    workDir: WORK,
    watchSpontaneous: true,
  });
  agent.setAnnouncer((speech, _emotion, meta) => {
    announced.push({ speech, targetId: meta?.targetId });
  });

  mock.enqueueScript((signal) => watcher.stream(signal));
  mock.enqueue(plainFrames('在的', 1));
  await agent.reply('在吗');
  watcher.push({ type: 'snapshot', cursor: 100, records: [], hasMore: false });
  await delay(10);

  watcher.push(eventFrame(101, 'turn/start', { turn: 2 }));
  watcher.push(eventFrame(102, 'user/message', { source: { kind: 'tool-jobs' } }));
  watcher.push(eventFrame(103, 'tool/call', {
    name: 'job_output',
    arguments: '{"job_id":"job-42"}',
  }));
  watcher.push(assistantFrame(104, '构建好了'));
  watcher.push(eventFrame(105, 'turn/end', { turn: 2, reason: { kind: 'stop' } }));
  await until(() => announced.length === 1);
  assert.equal(announced[0]?.speech, '构建好了');
  assert.equal(announced[0]?.targetId, 'job-42');

  agent.dispose();
});

test('send_message 唤醒的子代理可被无票据 cancelTurn 取消', OPTS, async () => {
  const mock = new MockController();
  const agent = new InProcessDshAgent({ controller: mock, workDir: WORK });

  mock.enqueue([
    { type: 'snapshot', cursor: 1, records: [], hasMore: false },
    eventFrame(2, 'tool/call', {
      name: 'send_message',
      arguments: { agent_id: 'child-cont' },
    }),
    assistantFrame(3, '[平静][ASYNC]'),
    eventFrame(4, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]);
  const view = await agent.reply('继续卷一');
  assert.equal(view.asyncDispatched, true);
  assert.equal(view.asyncTargetId, 'child-cont');
  assert.deepEqual(mock.cancels, []);

  agent.cancelTurn();

  assert.deepEqual(mock.cancels, [{ sessionId: 'child-cont' }]);
  assert.equal(agent.taskStatus(), '后台任务：现在没有任何后台任务在跑，也没刚结束的。');
});
