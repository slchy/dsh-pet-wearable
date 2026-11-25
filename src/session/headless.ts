/**
 * 一次性 `dsh headless --json -`。每轮一个进程，NDJSON 从 stdout 收回来。
 *
 * `spawn` 可以注入，单测不必真的拉起 dsh。带图片直接拒绝：这条 stdin 只收纯文本。
 */
import { DshError, type AskResult, type ImageAttachment } from './types.ts';
import { parseEvents } from './parse-events.ts';
import { launchDshChild, type DshChild, type DshSpawn } from './sdk-process.ts';

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class HeadlessRunner {
  private readonly program: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly spawn: DshSpawn | undefined;

  constructor(opts: {
    program: string;
    workDir: string;
    timeoutMs: number;
    spawn?: DshSpawn;
  }) {
    this.program = opts.program;
    this.workDir = opts.workDir;
    this.timeoutMs = opts.timeoutMs;
    this.spawn = opts.spawn;
  }

  /**
   * 跑一轮 headless。会话指针的读写留在门面：这里只负责起进程和解析。
   * `image` 有值就抛，不 spawn。
   */
  async run(text: string, sessionId: string | null, image?: ImageAttachment): Promise<AskResult> {
    if (image !== undefined) {
      throw new DshError('headless 模式的 stdin 只收纯文本，带图片请用 --dsh-sdk');
    }
    const args = [
      'headless',
      '--json',
      ...(sessionId !== null ? ['--session-id', sessionId] : []),
      '-',
    ];
    const started = Date.now();
    const outcome = await this.exec(args, text);
    const parsed = parseEvents(outcome.stdout);

    if (outcome.timedOut) {
      throw new DshError(`dsh 超时（${this.timeoutMs} ms）`);
    }
    if (outcome.code !== 0) {
      const tail = outcome.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      throw new DshError(`dsh 退出码 ${outcome.code}${tail === '' ? '' : `：${tail}`}`);
    }

    const answer = (parsed.final ?? parsed.streamed).trim();
    if (answer === '') throw new DshError('dsh 没有返回任何文本');

    return {
      text: answer,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      durationMs: Date.now() - started,
      resumed: sessionId !== null,
    };
  }

  exec(args: readonly string[], input: string): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve, reject) => {
      let child: DshChild;
      try {
        child = launchDshChild({
          program: this.program,
          workDir: this.workDir,
          args,
          livePort: null,
          spawn: this.spawn,
        });
      } catch (error) {
        reject(new DshError(`无法启动 ${this.program}：${(error as Error).message}`));
        return;
      }

      const stdout = child.stdout;
      const stderr = child.stderr;
      const stdin = child.stdin;
      if (stdout === null || stderr === null || stdin === null) {
        reject(new DshError(`无法启动 ${this.program}：stdio 未建立`));
        return;
      }

      let out = '';
      let err = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经退了
        }
      }, this.timeoutMs);

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: out, stderr: err, timedOut });
      };

      stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DshError(`dsh 启动失败：${error.message}`));
      });
      child.on('close', (code: number | null) => { finish(code ?? -1); });

      stdin.on('error', () => {
        // dsh 提前退出时写 stdin 会 EPIPE，忽略
      });
      stdin.end(input, 'utf8');
    });
  }
}
