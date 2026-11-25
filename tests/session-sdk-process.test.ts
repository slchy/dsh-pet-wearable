/**
 * 传输代次：旧进程的 close / 强杀不能碰到新一代的 pending、exitError 和进程。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  SdkProcess,
  type DshChild,
  type DshSpawn,
  type SdkHost,
} from '../src/session/sdk-process.ts';

class FakeProc extends EventEmitter {
  readonly stdin = {
    writable: true,
    write: (_chunk: string): void => {},
    end: (_data: string, _encoding: 'utf8'): void => {},
    on: (_event: 'error', _listener: () => void): void => {},
  };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

function asChild(proc: FakeProc): DshChild {
  return proc as unknown as DshChild;
}

function host(partial: Partial<SdkHost> = {}): SdkHost {
  return {
    requestStop: () => {},
    clearTurns: () => {},
    onGenerationClosed: () => {},
    ensureLive: () => Promise.resolve(),
    livePort: () => null,
    onForkProbed: () => {},
    collectSuperseded: () => {},
    handleLine: () => {},
    ...partial,
  };
}

function processFor(opts: {
  host?: SdkHost;
  spawn?: DshSpawn;
  killAfter?: number;
}): SdkProcess {
  return new SdkProcess({
    program: 'dsh',
    workDir: 'C:\\tmp\\sdk-proc',
    timeoutMs: 1_000,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    log: () => {},
    host: opts.host ?? host(),
    spawn: opts.spawn,
    killAfter: opts.killAfter,
  });
}

test('旧进程 close 不 reject 新 pending、不写 exitError、不杀新进程', async () => {
  let generationsClosed = 0;
  const sdk = processFor({
    host: host({ onGenerationClosed: () => { generationsClosed += 1; } }),
  });
  const old = new FakeProc();
  const neu = new FakeProc();
  sdk.arm(asChild(old));
  sdk.arm(asChild(neu));

  let rejected = false;
  const pending = sdk.rpc('session/prompt', { text: '新的' }, 80);
  pending.then(() => {}, () => { rejected = true; });

  old.emit('close', 1);
  await Promise.resolve();
  assert.equal(rejected, false);
  assert.equal(sdk.exitError, null);
  assert.equal(generationsClosed, 0);
  assert.deepEqual(neu.signals, []);
  assert.deepEqual(old.signals, []);

  await assert.rejects(pending, /session\/prompt 超时/);
});

test('同一代 close 会失败在途请求并记下 exitError', async () => {
  let generationsClosed = 0;
  const sdk = processFor({
    host: host({ onGenerationClosed: () => { generationsClosed += 1; } }),
  });
  const proc = new FakeProc();
  sdk.arm(asChild(proc));
  const pending = sdk.rpc('session/prompt', {}, 2_000);
  proc.emit('close', 9);
  await assert.rejects(pending, /sdk 进程退出（code=9）/);
  assert.match(sdk.exitError ?? '', /code=9/);
  assert.equal(generationsClosed, 1);
  assert.deepEqual(proc.signals, []);
});

test('代次往前走之后，stop 的强杀不会打到新进程', async () => {
  const sdk = processFor({ killAfter: 15 });
  const old = new FakeProc();
  const neu = new FakeProc();
  sdk.arm(asChild(old));
  assert.equal(sdk.stop(), true);
  sdk.arm(asChild(neu));
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.deepEqual(neu.signals, [], '新进程不能被上一代的强杀定时器碰到');
  assert.deepEqual(old.signals, [], '代次变了，连旧进程也不再 kill');
});

test('VOICE_LIVE_PORT 只写进这一次 spawn 的环境', () => {
  const seen: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const sdk = processFor({
    spawn: (command, args, options) => {
      seen.push({ command, args, env: options.env });
      return asChild(new FakeProc());
    },
  });
  const before = process.env['VOICE_LIVE_PORT'];
  sdk.spawnProgram(['--profile', 'sdk'], 4321);
  assert.equal(seen[0]?.env['VOICE_LIVE_PORT'], '4321');
  assert.equal(process.env['VOICE_LIVE_PORT'], before, '不能写回宿主的 process.env');

  sdk.spawnProgram(['--version'], null);
  assert.equal(seen[1]?.env, process.env, '没端口时原样继承，不复制一份');

  const shim = new SdkProcess({
    program: 'C:\\tools\\dsh.cmd',
    workDir: 'C:\\tmp\\sdk-proc',
    timeoutMs: 1_000,
    provider: 'p',
    model: 'm',
    log: () => {},
    host: host(),
    spawn: (command, args) => {
      seen.push({ command, args, env: process.env });
      return asChild(new FakeProc());
    },
  });
  shim.spawnProgram(['--version'], null);
  const last = seen[2];
  if (process.platform === 'win32') {
    assert.equal(last?.command, process.env['COMSPEC'] ?? 'cmd.exe');
    assert.deepEqual(last?.args, ['/c', 'C:\\tools\\dsh.cmd', '--version']);
  } else {
    assert.equal(last?.command, 'C:\\tools\\dsh.cmd');
    assert.deepEqual(last?.args, ['--version']);
  }
});
