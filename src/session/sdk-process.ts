/**
 * sdk 常驻进程：8 个传输槽、握手、JSON-RPC，以及按 `procGen` 隔开的退出。
 *
 * 解析出的通知原样交回门面。这里不解释 `turn/start`。
 * 旧一代的 `close` / `error` / 强杀定时器看见代次变了就返回，不碰新进程的 pending。
 */
import { spawn } from 'node:child_process';

import { SingleFlight } from '../single-flight.ts';
import { DshError, type JsonRpcNotice } from './types.ts';

export interface DshSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['pipe', 'pipe', 'pipe'];
  readonly windowsHide: boolean;
}

/** 测试注入的假进程和真实 `ChildProcess` 都要有的那几个口。 */
export interface DshChild {
  stdin: {
    writable: boolean;
    write: (chunk: string) => void;
    end: (data: string, encoding: 'utf8') => void;
    on: (event: 'error', listener: () => void) => void;
  } | null;
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null;
  stderr: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type DshSpawn = (
  command: string,
  args: readonly string[],
  options: DshSpawnOptions,
) => DshChild;

export interface SdkHost {
  /** 握手前收掉残留进程。实现应调用 {@link SdkProcess.stop}。 */
  requestStop(): void;
  clearTurns(): void;
  /** 当前这一代退出：清打开的会话、清轮次、叫醒还在等 idle 的人。 */
  onGenerationClosed(): void;
  ensureLive(): Promise<void>;
  livePort(): number | null;
  onForkProbed(supported: boolean): void;
  collectSuperseded(): void;
  handleLine(note: JsonRpcNotice): void;
}

/**
 * 起一个可能是 npm shim 的 program。
 *
 * Windows 上 `.cmd` / `.bat` 不是可执行映像，直接 spawn 会 `EINVAL`；
 * 用 `COMSPEC /c` 启动。`livePort !== null` 时只写进**这个子进程**的环境，
 * 不改 `process.env`。
 */
export function launchDshChild(input: {
  program: string;
  workDir: string;
  args: readonly string[];
  livePort: number | null;
  spawn?: DshSpawn;
}): DshChild {
  const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(input.program);
  const argv = isShim ? ['/c', input.program, ...input.args] : [...input.args];
  const command = isShim ? (process.env['COMSPEC'] ?? 'cmd.exe') : input.program;
  const env = input.livePort === null
    ? process.env
    : { ...process.env, VOICE_LIVE_PORT: String(input.livePort) };
  const options: DshSpawnOptions = {
    cwd: input.workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  if (input.spawn !== undefined) return input.spawn(command, argv, options);
  return spawn(command, argv, options) as unknown as DshChild;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class SdkProcess {
  private readonly program: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly patch: string | undefined;
  private readonly provider: string;
  private readonly model: string;
  private readonly log: (line: string) => void;
  private readonly host: SdkHost;
  private readonly spawnImpl: DshSpawn | undefined;
  /** `stop` 之后多久强杀。默认 2 s；单测可以缩短。不是新的顶层时间常量。 */
  private readonly killAfter: number;

  private proc: DshChild | null = null;
  private procGen = 0;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private sdkReady = false;
  private cancelSupport: boolean | null = null;
  private exitReason: string | null = null;
  private readonly handshaking = new SingleFlight<void>();

  constructor(opts: {
    program: string;
    workDir: string;
    timeoutMs: number;
    patch?: string;
    provider: string;
    model: string;
    log: (line: string) => void;
    host: SdkHost;
    spawn?: DshSpawn;
    killAfter?: number;
  }) {
    this.program = opts.program;
    this.workDir = opts.workDir;
    this.timeoutMs = opts.timeoutMs;
    this.patch = opts.patch;
    this.provider = opts.provider;
    this.model = opts.model;
    this.log = opts.log;
    this.host = opts.host;
    this.spawnImpl = opts.spawn;
    this.killAfter = opts.killAfter ?? 2_000;
  }

  get ready(): boolean {
    return this.sdkReady;
  }

  get hasProc(): boolean {
    return this.proc !== null;
  }

  get generation(): number {
    return this.procGen;
  }

  get cancelSupported(): boolean | null {
    return this.cancelSupport;
  }

  noteCancelSupported(): void {
    this.cancelSupport = true;
  }

  get exitError(): string | null {
    return this.exitReason;
  }

  clearExitError(): void {
    this.exitReason = null;
  }

  takeExitError(): string | null {
    const reason = this.exitReason;
    this.exitReason = null;
    return reason;
  }

  /** 懒启动。并发调用等同一次握手，不各自起进程。 */
  ensure(): Promise<void> {
    if (this.proc !== null && this.sdkReady) return Promise.resolve();
    return this.handshaking.run(() => this.handshake());
  }

  /**
   * 把一个已经造好的子进程登记成新的一代。
   * 握手在 spawn 成功后走这里；单测直接把假进程装上来，不必跑 initialize。
   */
  arm(proc: DshChild): number {
    this.procGen += 1;
    const myGen = this.procGen;
    this.proc = proc;
    this.wire(proc, myGen);
    return myGen;
  }

  spawnProgram(args: readonly string[], livePort: number | null = null): DshChild {
    return launchDshChild({
      program: this.program,
      workDir: this.workDir,
      args,
      livePort,
      spawn: this.spawnImpl,
    });
  }

  /** 关掉常驻进程。没有进程时返回 false，调用方不要据此清掉别的状态。 */
  stop(): boolean {
    const proc = this.proc;
    if (proc === null) return false;
    const myGen = this.procGen;
    this.proc = null;
    this.sdkReady = false;
    try {
      proc.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: {} })}\n`,
      );
    } catch {
      // 已经退了
    }
    // 给 shutdown 一点时间优雅退出，超时就强杀。
    // 代次已经往前走（新的 spawn 起来了）就绝不能再杀：定时器抓住的是这一代。
    setTimeout(() => {
      if (myGen !== this.procGen) return;
      try {
        proc.kill();
      } catch {
        // 已经退了
      }
    }, this.killAfter).unref?.();
    return true;
  }

  /** `SIGINT` 给 dsh 子进程（等同 TUI 里 Ctrl-C）。进程会退出，下一轮要重启。 */
  interrupt(): void {
    const proc = this.proc;
    if (proc === null) return;
    this.log('  取消    SIGINT（进程会退出，下一轮要重启）');
    try {
      proc.kill('SIGINT');
    } catch {
      // 已经退了
    }
  }

  rpc(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (stdin === null || stdin === undefined || !stdin.writable) {
        reject(new DshError(`sdk 未就绪，无法调用 ${method}`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DshError(`${method} 超时（${timeoutMs} ms）`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });

      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private async handshake(): Promise<void> {
    if (this.proc !== null) this.host.requestStop();
    // 流式侧通道要在 spawn 之前就绪：端口靠 VOICE_LIVE_PORT 传给子进程。
    await this.host.ensureLive();
    // stop 已经清过一轮。proc 本来就是 null 时这里再清一次，然后才 bump 代次。
    this.host.clearTurns();
    const proc = this.spawnProgram(
      ['--profile', 'sdk', ...(this.patch !== undefined && this.patch !== '' ? ['--patch', this.patch] : [])],
      this.host.livePort(),
    );
    this.arm(proc);

    // 首次握手要加载 profile 与工具树，比普通请求慢，单独放宽
    await this.rpc('initialize', {
      cwd: this.workDir,
      provider: this.provider,
      model: this.model,
    }, 120_000);
    this.sdkReady = true;
    this.log(`[sdk] 已就绪 provider=${this.provider} model=${this.model}`);
    this.cancelSupport = await this.probeCancel();
    this.log(this.cancelSupport
      ? '  取消    session/cancel 可用（打断只作废下游输出，不动上游调用）'
      : '  取消    ✗ 宿主运行时没有 session/cancel —— 跑一次 scripts/patch-sdk-cancel.mjs');
    const forkOk = await this.probeFork();
    this.host.onForkProbed(forkOk);
    this.log(forkOk
      ? '  回溯    session/fork 可用（快车道赢了而 dsh 已答完时，把那一轮切掉）'
      : '  回溯    ✗ 宿主运行时没有 session/fork —— 跑一次 scripts/patch-sdk-fork.mjs');
    this.host.collectSuperseded();
  }

  /**
   * 探一下宿主运行时认不认 `session/fork`。
   *
   * 认的话传一个不存在的 id 会回「会话找不到」，不认才回 `unknown ... runtime method`。
   */
  private async probeFork(): Promise<boolean> {
    try {
      await this.rpc('session/fork', { sessionId: '__probe__' }, 5_000);
      return true;
    } catch (error) {
      return !(error as Error).message.includes('unknown');
    }
  }

  /**
   * 探一下宿主运行时认不认 `session/cancel`。
   *
   * 认的话传一个不存在的 id 会回 `{accepted:false}`；不认则回 unknown method。
   */
  private async probeCancel(): Promise<boolean> {
    try {
      await this.rpc('session/cancel', { sessionId: '__probe__' }, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  private wire(proc: DshChild, myGen: number): void {
    proc.stdout?.on('data', (chunk: Buffer) => { this.handleData(chunk); });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      // SDK profile 把诊断写 stderr，stdout 专用于协议帧
      if (text !== '') this.log(`[sdk] ${text.slice(0, 200)}`);
    });
    proc.on('error', (error: Error) => {
      if (myGen !== this.procGen) return;
      this.log(`[sdk] 启动失败：${error.message}`);
      this.sdkReady = false;
      if (this.proc === proc) this.proc = null;
    });
    proc.on('close', (code: number | null) => {
      // 旧一代晚到的退出：不 reject 新 pending，不写新的 exitError，也不杀新进程。
      if (myGen !== this.procGen) return;
      this.sdkReady = false;
      if (this.proc === proc) this.proc = null;
      for (const slot of this.pending.values()) {
        slot.reject(new DshError(`sdk 进程退出（code=${code}）`));
      }
      this.pending.clear();
      this.exitReason = `sdk 进程退出（code=${code}）`;
      this.host.onGenerationClosed();
      this.log(`[sdk] 进程退出 code=${code}`);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
      if (line !== '') this.dispatchLine(line);
    }
  }

  /** 响应在这里结算。通知不解释，交回门面。 */
  private dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg['id'];
    const method = msg['method'];
    if (typeof id === 'number' && method === undefined) {
      const slot = this.pending.get(id);
      if (slot === undefined) return;
      this.pending.delete(id);
      const err = msg['error'];
      if (err) slot.reject(new DshError(`JSON-RPC 错误：${JSON.stringify(err).slice(0, 300)}`));
      else slot.resolve(msg['result']);
      return;
    }
    if (typeof method !== 'string') return;
    const params = msg['params'];
    if (params === null || typeof params !== 'object') return;
    this.host.handleLine({ method, params: params as Record<string, unknown> });
  }
}
