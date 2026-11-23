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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function makeSession(
  answer = '查到两台，都在跑。',
  delayMs = 150,
  skipIdle: readonly number[] = [],
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
    program: fakeDsh(dir, answer, delayMs, skipIdle),
    workDir: dir,
    sessionFile: join(dir, 'session.json'),
    mode: 'sdk',
    provider: 'p',
    model: 'm',
    log: (line) => { logs.push(line); },
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
