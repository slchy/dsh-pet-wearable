/**
 * 「放手」的委派轮：答案不能静默丢掉。
 *
 * 真机（`20261122-210720` 第 9、10 轮）：委派轮撞上插话 → `session/cancel` →
 * 那一轮判成 aborted。可是**上游的活儿取消不了** —— 日志里取消之后 2 s，
 * `bash「nproc; free -h」` 才刚结束。所以取消省下的只是最后那一步总结，
 * 丢掉的却是用户唯一能听得到的东西：答案。用户最后把问题重问了一遍。
 *
 * 这一条验的是「放手」这条路：不取消，让它跑完；`ask` 立刻收成空答复（这一轮
 * 已经作废），答案回来时交给 `onAnnounce`（与后台任务结算同一口播报）。
 *
 * 用假的 dsh 进程（stdio JSON-RPC）跑，不碰真模型。
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DshSession } from '../src/session.ts';

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
};

/** 一个只会说一句话的假 dsh；`delayMs` 是 prompt 之后多久才吐答案 */
function fakeDsh(dir: string, answer: string, delayMs: number, skipIdle: readonly number[] = []): string {
  const script = join(dir, 'fake-dsh.mjs');
  writeFileSync(script, `
process.stdin.setEncoding('utf8');
let buf = '';
let turns = 0;
const queue = [];
let busy = false;
const send = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
const event = (sessionId, type, seq, data) => {
  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq, data } } });
};
const status = (sessionId, s) => {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: s } });
};

// 真 dsh 是串行的：排队的 prompt 要等前一轮 turn/end + idle 之后才开
function pump() {
  if (busy || queue.length === 0) return;
  const job = queue.shift();
  busy = true;
  turns += 1;
  const n = turns;
  process.stderr.write('PROMPT ' + n + '\\n');
  status(job.sessionId, 'running');
  event(job.sessionId, 'turn/start', 10 * n, { turn: n });
  setTimeout(() => {
    event(job.sessionId, 'assistant/message', 10 * n + 1, {
      message: { content: [{ type: 'text', text: ${JSON.stringify(answer)} + n }] },
    });
    event(job.sessionId, 'turn/end', 10 * n + 2, { turn: n, reason: { kind: 'completed' } });
    if (!${JSON.stringify(skipIdle)}.includes(n)) {
      status(job.sessionId, 'idle');
    }
    busy = false;
    pump();
  }, ${delayMs});
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    if (method === 'session/prompt') {
      send({ jsonrpc: '2.0', id, result: {} });
      queue.push({ sessionId: params.sessionId });
      pump();
      continue;
    }
    if (method === 'session/fork') {
      send({ jsonrpc: '2.0', id, error: { message: 'session not found' } });
      continue;
    }
    if (method === 'session/cancel') {
      send({ jsonrpc: '2.0', id, result: { accepted: false } });
      continue;
    }
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`);
  // 直接 spawn 一个 .mjs 在 Windows 上不行（没有 shebang 解释器），套一层壳
  if (process.platform === 'win32') {
    const shim = join(dir, 'fake-dsh.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  const shim = join(dir, 'fake-dsh.sh');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function installProgram(dir: string, fileName: string, source: string): string {
  const script = join(dir, fileName);
  writeFileSync(script, source);
  if (process.platform === 'win32') {
    const shim = join(dir, fileName.replace(/\.mjs$/, '.cmd'));
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  const shim = join(dir, fileName.replace(/\.mjs$/, '.sh'));
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function makeSession(
  answer = '查到两台，都在跑。',
  delayMs = 150,
  skipIdle: readonly number[] = [],
  programFor?: (dir: string) => string,
  timeoutMs?: number,
): {
  readonly session: DshSession;
  readonly announced: string[];
  /** 回注记忆的出口：`[用户原话, 答案, 会不会补播]` */
  readonly recalled: Array<[string, string, boolean]>;
  readonly logs: string[];
  readonly dir: string;
  /** 等到假 dsh 真的收到第 n 条 prompt（握手是异步的，等睡固定毫秒不算） */
  waitPrompt: (n?: number) => Promise<void>;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detach-'));
  const logs: string[] = [];
  const session = new DshSession({
    program: (programFor ?? ((d: string) => fakeDsh(d, answer, delayMs, skipIdle)))(dir),
    workDir: dir,
    sessionFile: join(dir, 'session.json'),
    mode: 'sdk',
    provider: 'p',
    model: 'm',
    log: (line) => { logs.push(line); },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const announced: string[] = [];
  session.onAnnounce = (text) => { announced.push(text); };
  /** 回注记忆的出口：`[用户原话, 答案, 会不会补播]` */
  const recalled: Array<[string, string, boolean]> = [];
  session.onDetachedAnswer = (userText, answer, spoken) => {
    recalled.push([userText, answer, spoken]);
  };
  return {
    session,
    announced,
    recalled,
    logs,
    dir,
    waitPrompt: async (n = 1) => {
      const want = `PROMPT ${n}`;
      for (let waited = 0; waited < 15_000; waited += 20) {
        if (logs.some((line) => line.includes(want))) {
          return;
        }
        await wait(20);
      }
      throw new Error(`假 dsh 一直没收到第 ${n} 条 prompt：${JSON.stringify(logs)}`);
    },
    dispose: () => {
      session.stop();
      // 侧通道是个真监听端口：不关掉事件循环不会退，测试进程会一直挂着
      (session as unknown as { liveRelay: { close(): void } | null }).liveRelay?.close();
      // 子进程的 cwd 正是这个目录，Windows 上它没退干净就删不掉 —— 尽力而为
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 留在临时目录里，不影响结论
      }
    },
  };
}

const ticket = { no: 1, gen: 1 };

test('放手：ask 立刻收空答复（不抛、不挂），答案回来走播报', async () => {
  const h = makeSession();
  try {
    const pending = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt(); // 握手是异步的：等这一轮真的进了 dsh，再模拟插话
    h.session.detachTurn(ticket);

    const result = await pending; // 不能挂到超时
    assert.equal(result.text, '', '这一轮已经作废了，不该把答案当成它的');
    assert.equal(result.detached, true, '上层要能分辨「放手」和「真的没答」');

    await wait(400);
    assert.deepEqual(h.announced, ['查到两台，都在跑。1'], '答案必须从播报口出来');
  } finally {
    h.dispose();
  }
});

test('不放手时答案照旧回到 ask，不重复播报', async () => {
  const h = makeSession();
  try {
    const result = await h.session.ask('查一下机器', undefined, { ticket });
    assert.equal(result.text, '查到两台，都在跑。1');
    assert.equal(result.detached, undefined);
    await wait(100);
    assert.deepEqual(h.announced, [], '没放手就是正常一轮，播报口不该响');
  } finally {
    h.dispose();
  }
});

test('放手后又开新一轮：旧答案既不播、也不能串成新一轮的答案', async () => {
  const h = makeSession('答案', 120);
  try {
    const first = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt();
    h.session.detachTurn(ticket);
    await first;

    // 新一轮在旧答案回来之前就开了（生产里就是这样：「对。」自己又开一轮）
    const second = h.session.ask('那别的事了', undefined, { ticket: { no: 2, gen: 1 } });
    assert.equal((await second).text, '答案2', '新一轮拿到的必须是它自己那一轮');

    await wait(300);
    assert.deepEqual(h.announced, [], '已经被新一轮顶掉的旧答案不能再补播一次');
    assert.deepEqual(
      h.recalled,
      [['查一下机器', '答案1', false]],
      '不补播 ≠ 丢掉：用户之后提起这件事，模型得知道答案是什么',
    );
  } finally {
    h.dispose();
  }
});

test('放手后被播报出来的那一轮：`spoken` 为真（回注措辞要照实说"已经念过"）', async () => {
  const h = makeSession();
  try {
    const pending = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt();
    h.session.detachTurn(ticket);
    await pending;
    await wait(400);
    assert.deepEqual(h.announced, ['查到两台，都在跑。1']);
    assert.deepEqual(
      h.recalled,
      [['查一下机器', '查到两台，都在跑。1', true]],
      '播出去了就要让回注口径是"已经用语音念过"',
    );
  } finally {
    h.dispose();
  }
});

test('用户显式下令取消：连**已放手**的那一轮也一起取消，答案不再回注', async () => {
  const h = makeSession('答案', 400);
  try {
    const pending = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt();
    h.session.detachTurn(ticket);
    await pending;

    assert.equal(h.session.isBusy(), true, '放手的轮还在跑，用户说"算了"才有东西可取消');
    // 不带票据：放手的轮没有等待者，票据比对在那里也不成立
    h.session.cancelTurn();
    assert.equal(h.session.isBusy(), false, '取消之后就没有活儿了');

    await wait(600);
    assert.deepEqual(h.recalled, [], '用户说了不要了，答案不该再回注记忆');
    assert.deepEqual(h.announced, [], '也不该补播');
  } finally {
    h.dispose();
  }
});

test('放手那一轮没发 idle（漏发/异常）也不会把答案串到下一轮', async () => {
  // 这正是「用计数器认领 idle」的死法：少一条 idle，后面每一轮都错位一格。
  // 改成按 `turn/end` 的**轮号**认领之后，漏发 idle 只影响「谁来唤醒等待者」，
  // 不会影响「这条答案是哪一轮的」。
  const h = makeSession('答案', 120, [1]);
  try {
    const first = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt();
    h.session.detachTurn(ticket);
    await first;

    const second = h.session.ask('那别的事了', undefined, { ticket: { no: 2, gen: 1 } });
    assert.equal((await second).text, '答案2', '第 2 轮的答案必须是第 2 轮的');

    await wait(200);
    assert.deepEqual(h.announced, [], '放手的旧答案不补播');
  } finally {
    h.dispose();
  }
});

test('票据对不上时放手是空操作（迟到的放手不能摘掉下一轮的等待者）', async () => {
  const h = makeSession('答案。', 120);
  try {
    const pending = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt();
    h.session.detachTurn({ no: 99, gen: 1 });
    const result = await pending;
    assert.equal(result.detached, undefined, '票据过期就不该放手');
    assert.equal(result.text, '答案。1');
  } finally {
    h.dispose();
  }
});

/** 假 dsh：主轮进行中夹带子会话 / 缺 sessionId 的事件。 */
function fakeChildSession(dir: string): string {
  const source = `
process.stdin.setEncoding('utf8');
let buf = '';
const send = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
const event = (sessionId, type, seq, data) => {
  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq, data } } });
};
const status = (sessionId, s) => {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: s } });
};
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    if (method === 'session/prompt') {
      send({ jsonrpc: '2.0', id, result: {} });
      const sessionId = params.sessionId;
      process.stderr.write('PROMPT 1\\n');
      event('child-session', 'assistant/message', 1, {
        message: { content: [{ type: 'text', text: '子会话的答案' }] },
        usage: { inputTokens: 999, outputTokens: 999 },
      });
      status('child-session', 'running');
      status('child-session', 'idle');
      send({
        jsonrpc: '2.0',
        method: 'session.event',
        params: {
          event: {
            type: 'assistant/message',
            seq: 2,
            data: {
              message: { content: [{ type: 'text', text: '没有会话id' }] },
              usage: { inputTokens: 50, outputTokens: 50 },
            },
          },
        },
      });
      send({ jsonrpc: '2.0', method: 'session.status', params: { status: 'idle' } });
      setTimeout(() => {
        status(sessionId, 'running');
        event(sessionId, 'turn/start', 10, { turn: 1 });
        event(sessionId, 'assistant/message', 11, {
          message: { content: [{ type: 'text', text: '主会话的答案' }] },
          usage: { inputTokens: 3, outputTokens: 4 },
        });
        event('child-session', 'assistant/message', 12, {
          message: { content: [{ type: 'text', text: '子会话覆盖' }] },
          usage: { inputTokens: 999, outputTokens: 1 },
        });
        status('child-session', 'idle');
        send({ jsonrpc: '2.0', method: 'session.status', params: { status: 'idle' } });
        event(sessionId, 'turn/end', 13, { turn: 1, reason: { kind: 'completed' } });
        status(sessionId, 'idle');
      }, 250);
      continue;
    }
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;
  return installProgram(dir, 'fake-child.mjs', source);
}

test('子会话的 assistant/message 与 session.status 不进入主轮', async () => {
  const h = makeSession('不用', 0, [], (dir) => fakeChildSession(dir));
  try {
    const result = await h.session.ask('查一下机器', undefined, { ticket });
    assert.equal(result.text, '主会话的答案');
    assert.equal(result.detached, undefined);
    assert.equal(result.usage?.inputTokens, 3, '子会话的 usage 不能折进主轮');
    assert.equal(result.usage?.outputTokens, 4);
    assert.ok(result.durationMs >= 150, `子会话 idle 不应提前结束主轮（${result.durationMs} ms）`);
    assert.deepEqual(h.announced, [], '子会话的 running/idle 不能被当成自发轮播出去');
    assert.equal(h.session.isBusy(), false);
  } finally {
    h.dispose();
  }
});

/** 假 dsh：第一条 prompt 报错，第二条才正常答。 */
function fakePromptError(dir: string): string {
  const source = `
process.stdin.setEncoding('utf8');
let buf = '';
let prompts = 0;
const send = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
const event = (sessionId, type, seq, data) => {
  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq, data } } });
};
const status = (sessionId, s) => {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: s } });
};
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    if (method === 'session/prompt') {
      prompts += 1;
      if (prompts === 1) {
        send({ jsonrpc: '2.0', id, error: { message: 'prompt failed' } });
        continue;
      }
      send({ jsonrpc: '2.0', id, result: {} });
      const sessionId = params.sessionId;
      process.stderr.write('PROMPT ' + prompts + '\\n');
      setTimeout(() => {
        status(sessionId, 'running');
        event(sessionId, 'turn/start', 10, { turn: 1 });
        event(sessionId, 'assistant/message', 11, {
          message: { content: [{ type: 'text', text: '第二次才成功' }] },
        });
        event(sessionId, 'turn/end', 12, { turn: 1, reason: { kind: 'completed' } });
        status(sessionId, 'idle');
      }, 40);
      continue;
    }
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;
  return installProgram(dir, 'fake-prompt-error.mjs', source);
}

test('session/prompt 抛错后 isBusy() 归 false，下一轮还能问', async () => {
  const h = makeSession('不用', 0, [], (dir) => fakePromptError(dir));
  try {
    await assert.rejects(
      () => h.session.ask('第一次', undefined, { ticket }),
      /prompt failed/,
    );
    assert.equal(h.session.isBusy(), false, 'RPC 失败不能把主轮锁在忙');
    const result = await h.session.ask('第二次', undefined, { ticket: { no: 2, gen: 1 } });
    assert.equal(result.text, '第二次才成功');
    assert.equal(result.detached, undefined);
    assert.equal(h.session.isBusy(), false);
  } finally {
    h.dispose();
  }
});

test('过期票据在 activeTicket 已清空时不能放手', async () => {
  const h = makeSession('答案', 80, [], undefined, 2_500);
  try {
    const done = await h.session.ask('查一下机器', undefined, { ticket });
    assert.equal(done.text, '答案1');
    assert.equal(done.detached, undefined);
    assert.equal(h.session.isBusy(), false);
    h.session.detachTurn(ticket);
    assert.ok(
      h.logs.some((line) => line.includes('票据过期')),
      'activeTicket === null 时带票据的放手必须丢掉',
    );
    assert.equal(h.session.isBusy(), false);
    const next = await h.session.ask('下一句', undefined, { ticket: { no: 2, gen: 1 } });
    assert.equal(next.detached, undefined, '过期放手不能把下一轮标成 detached');
    assert.equal(next.text, '答案2');
    assert.deepEqual(h.announced, []);
    assert.equal(h.session.isBusy(), false);
  } finally {
    h.dispose();
  }
});

test('放手之后过期票据取消不了；不带票据的人工取消仍然可以', async () => {
  const h = makeSession('答案', 400);
  try {
    const pending = h.session.ask('查一下机器', undefined, { ticket });
    await h.waitPrompt();
    h.session.detachTurn(ticket);
    await pending;
    assert.equal(h.session.isBusy(), true, '放手的轮还在跑');
    h.session.cancelTurn({ no: 99, gen: 7 });
    assert.equal(h.session.isBusy(), true, 'activeTicket === null 时过期票据不能取消已放手的轮');
    h.session.cancelTurn();
    assert.equal(h.session.isBusy(), false);
    await wait(600);
    assert.deepEqual(h.recalled, [], '用户说了不要了，答案不该再回注记忆');
    assert.deepEqual(h.announced, []);
  } finally {
    h.dispose();
  }
});

/**
 * 假 dsh：第一轮正常结束，接着自己开一轮但扣住 idle。
 * 第二条 prompt 先把那条旧 idle 吐出来，再过一会儿才开真正的新轮。
 */
function fakeSpontaneousIdle(dir: string): string {
  const source = `
process.stdin.setEncoding('utf8');
let buf = '';
let prompts = 0;
const send = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
const event = (sessionId, type, seq, data) => {
  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq, data } } });
};
const status = (sessionId, s) => {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: s } });
};
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    if (method === 'session/prompt') {
      prompts += 1;
      send({ jsonrpc: '2.0', id, result: {} });
      const sessionId = params.sessionId;
      const n = prompts;
      process.stderr.write('PROMPT ' + n + '\\n');
      if (n === 1) {
        setTimeout(() => {
          status(sessionId, 'running');
          event(sessionId, 'turn/start', 10, { turn: 1 });
          event(sessionId, 'assistant/message', 11, {
            message: { content: [{ type: 'text', text: '第一轮' }] },
          });
          event(sessionId, 'turn/end', 12, { turn: 1, reason: { kind: 'completed' } });
          status(sessionId, 'idle');
          setTimeout(() => {
            status(sessionId, 'running');
            event(sessionId, 'turn/start', 20, { turn: 2 });
            event(sessionId, 'assistant/message', 21, {
              message: { content: [{ type: 'text', text: '后台汇报' }] },
            });
            process.stderr.write('SPONTANEOUS\\n');
          }, 30);
        }, 40);
        continue;
      }
      status(sessionId, 'idle');
      setTimeout(() => {
        status(sessionId, 'running');
        event(sessionId, 'turn/start', 30, { turn: 3 });
        event(sessionId, 'assistant/message', 31, {
          message: { content: [{ type: 'text', text: '第二轮' }] },
        });
        event(sessionId, 'turn/end', 32, { turn: 3, reason: { kind: 'completed' } });
        status(sessionId, 'idle');
      }, 200);
      continue;
    }
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;
  return installProgram(dir, 'fake-spontaneous.mjs', source);
}

test('旧自发轮的 idle 不能提前结束新的 ask', async () => {
  const h = makeSession('不用', 0, [], (dir) => fakeSpontaneousIdle(dir), 4_000);
  try {
    const first = await h.session.ask('第一句', undefined, { ticket });
    assert.equal(first.text, '第一轮');
    for (let waited = 0; waited < 5_000; waited += 20) {
      if (h.logs.some((line) => line.includes('自发开了一轮'))) {
        break;
      }
      await wait(20);
    }
    assert.ok(
      h.logs.some((line) => line.includes('自发开了一轮')),
      `自发轮没有开始：${JSON.stringify(h.logs)}`,
    );
    const second = await h.session.ask('第二句', undefined, { ticket: { no: 2, gen: 1 } });
    assert.equal(second.text, '第二轮', '旧自发 idle 不能把新一轮收成空答复或旧汇报');
    assert.equal(second.detached, undefined);
    assert.deepEqual(h.announced, [], '被新一轮接走的自发 idle 不该再播一次');
    assert.equal(h.session.isBusy(), false);
  } finally {
    h.dispose();
  }
});

/**
 * 假 dsh：第一条进程答完就停在那儿等 shutdown。
 * 测试写 `second-life` 之后拉起的进程会把答案扣住，直到 `release-answer`。
 * 旧进程收到 shutdown 后轮询 `kill-old`，退出前写 `old-exiting`。
 */
function fakeRestart(dir: string): string {
  const source = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(dir)};
process.stdin.setEncoding('utf8');
let buf = '';
const send = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
const event = (sessionId, type, seq, data) => {
  send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq, data } } });
};
const status = (sessionId, s) => {
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: s } });
};
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    if (method === 'shutdown') {
      const timer = setInterval(() => {
        if (!existsSync(join(dir, 'kill-old'))) return;
        clearInterval(timer);
        try { writeFileSync(join(dir, 'old-exiting'), '1'); } catch { /* 测试目录还在 */ }
        process.exit(0);
      }, 15);
      continue;
    }
    if (method === 'session/prompt') {
      send({ jsonrpc: '2.0', id, result: {} });
      const sessionId = params.sessionId;
      process.stderr.write('PROMPT\\n');
      const deliver = () => {
        status(sessionId, 'running');
        event(sessionId, 'turn/start', 10, { turn: 1 });
        event(sessionId, 'assistant/message', 11, {
          message: { content: [{ type: 'text', text: '新进程的答复' }] },
        });
        event(sessionId, 'turn/end', 12, { turn: 1, reason: { kind: 'completed' } });
        status(sessionId, 'idle');
      };
      if (!existsSync(join(dir, 'second-life'))) {
        setTimeout(deliver, 40);
      } else {
        const timer = setInterval(() => {
          if (!existsSync(join(dir, 'release-answer'))) return;
          clearInterval(timer);
          deliver();
        }, 15);
      }
      continue;
    }
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;
  return installProgram(dir, 'fake-restart.mjs', source);
}

test('旧进程 close 不杀死新进程的 RPC，也不提前结束新一轮', async () => {
  const h = makeSession('不用', 0, [], (dir) => fakeRestart(dir));
  try {
    const first = await h.session.ask('第一问', undefined, { ticket });
    assert.equal(first.text, '新进程的答复');
    writeFileSync(join(h.dir, 'second-life'), '1');
    const prompts = (): number => h.logs.filter((line) => line.includes('PROMPT')).length;
    const before = prompts();
    h.session.stop();
    let done = false;
    let failure: string | null = null;
    const pending = h.session.ask('第二问', undefined, { ticket: { no: 2, gen: 1 } }).then(
      (result) => {
        done = true;
        return result;
      },
      (error: Error) => {
        done = true;
        failure = error.message;
        return null;
      },
    );
    for (let waited = 0; waited < 15_000 && prompts() <= before; waited += 20) {
      await wait(20);
    }
    assert.ok(prompts() > before, `新进程没收到 prompt：${JSON.stringify(h.logs)}`);
    writeFileSync(join(h.dir, 'kill-old'), '1');
    for (let waited = 0; waited < 5_000 && !existsSync(join(h.dir, 'old-exiting')); waited += 20) {
      await wait(20);
    }
    assert.equal(existsSync(join(h.dir, 'old-exiting')), true, '旧进程应该已经退出');
    await wait(200);
    assert.equal(
      done,
      false,
      failure === null
        ? '旧进程退出时新一轮不该已经结束'
        : `旧进程 close 误伤了新一轮：${failure}`,
    );
    writeFileSync(join(h.dir, 'release-answer'), '1');
    const result = await pending;
    assert.ok(result, failure ?? '新一轮没有答复');
    assert.equal(result?.text, '新进程的答复');
    assert.equal(failure, null);
    assert.equal(h.session.isBusy(), false);
  } finally {
    try { writeFileSync(join(h.dir, 'kill-old'), '1'); } catch { /* 目录可能已经收掉 */ }
    try { writeFileSync(join(h.dir, 'release-answer'), '1'); } catch { /* 同上 */ }
    h.dispose();
  }
});
