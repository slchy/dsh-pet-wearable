/**
 * headless 执行器：假 spawn 验证 NDJSON、非 0 退出、超时强杀、带图拒绝。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { HeadlessRunner } from '../src/session/headless.ts';
import type { DshChild, DshSpawn } from '../src/session/sdk-process.ts';
import { DshError } from '../src/session/types.ts';

class FakeChild extends EventEmitter {
  readonly stdin = {
    writable: true,
    write: (_chunk: string): void => {},
    end: (data: string, _encoding: 'utf8'): void => { this.input = data; },
    on: (_event: 'error', _listener: () => void): void => {},
  };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  input = '';
  signals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.emit('close', null);
    return true;
  }
}

function later(setup: (child: FakeChild) => void): { spawn: DshSpawn; child: () => FakeChild } {
  let current: FakeChild | null = null;
  const spawn: DshSpawn = () => {
    const child = new FakeChild();
    current = child;
    setImmediate(() => { setup(child); });
    return child as unknown as DshChild;
  };
  return { spawn, child: () => current ?? new FakeChild() };
}

test('NDJSON 解析出会话、文本和带缓存的上下文', async () => {
  const ndjson = [
    '{"type":"session","sessionId":"session-h"}',
    '{"type":"text","text":"你"}',
    '{"type":"final","text":"你好"}',
    '{"type":"status","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":5}}',
  ].join('\n');
  const fake = later((child) => {
    child.stdout.emit('data', Buffer.from(`${ndjson}\n`));
    child.emit('close', 0);
  });
  const runner = new HeadlessRunner({
    program: 'dsh',
    workDir: 'C:\\tmp\\headless',
    timeoutMs: 1_000,
    spawn: fake.spawn,
  });
  const result = await runner.run('你好', 'session-old');
  assert.equal(result.text, '你好');
  assert.equal(result.sessionId, 'session-h');
  assert.equal(result.resumed, true);
  assert.equal(result.usage?.contextTokens, 15);
  assert.equal(fake.child().input, '你好');
});

test('非 0 退出码带上 stderr 尾部', async () => {
  const fake = later((child) => {
    child.stderr.emit('data', Buffer.from('一行\n两行\n三行\n四行\n'));
    child.emit('close', 3);
  });
  const runner = new HeadlessRunner({
    program: 'dsh',
    workDir: 'C:\\tmp\\headless',
    timeoutMs: 1_000,
    spawn: fake.spawn,
  });
  await assert.rejects(
    runner.run('hi', null),
    (error: unknown) => error instanceof DshError && error.message === 'dsh 退出码 3：两行 | 三行 | 四行',
  );
});

test('超时后 SIGKILL，并按超时收场', async () => {
  const child = new FakeChild();
  const spawn: DshSpawn = () => child as unknown as DshChild;
  const runner = new HeadlessRunner({
    program: 'dsh',
    workDir: 'C:\\tmp\\headless',
    timeoutMs: 30,
    spawn,
  });
  await assert.rejects(runner.run('卡住', null), /dsh 超时（30 ms）/);
  assert.deepEqual(child.signals, ['SIGKILL']);
});

test('带图直接拒绝，不起进程', async () => {
  let calls = 0;
  const spawn: DshSpawn = () => {
    calls += 1;
    throw new Error('不该 spawn');
  };
  const runner = new HeadlessRunner({
    program: 'dsh',
    workDir: 'C:\\tmp\\headless',
    timeoutMs: 1_000,
    spawn,
  });
  await assert.rejects(
    runner.run('看图', null, { mimeType: 'image/png', data: 'aaaa' }),
    (error: unknown) => error instanceof DshError
      && error.message === 'headless 模式的 stdin 只收纯文本，带图片请用 --dsh-sdk',
  );
  assert.equal(calls, 0);
});
