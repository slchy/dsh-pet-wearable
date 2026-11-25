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
