/**
 * TurnJudge 客户端：常驻的 Python 侧车，回答「这一轮说完了吗」。
 *
 * 模型是 pipecat 的 Smart Turn v3.2（`models/smart-turn-v3.2-cpu.onnx`）——
 * 文件名与模型名都保留上游原名，方便对账；「TurnJudge」是本项目这一层封装的名字。
 *
 * 为什么不是一个纯 TS 实现：模型输入是 Whisper 风格 log-mel（80×800），
 * 要先做 400 点 rFFT（400 = 2^4×5^2，非 2 的幂）。官方那份 numpy 实现
 * 是自包含的，直接复用比在 TS 里手写混合基 FFT 可靠。
 *
 * 协议：请求 `[u32 len][int16 PCM]`，响应 `[f64 概率]`，都是小端。
 * 进程常驻，模型只加载一次。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface TurnJudgeOptions {
  /** 带 onnxruntime 的 python，通常是项目里的 .venv */
  python: string;
  /** server.py 路径 */
  script: string;
  log?: (line: string) => void;
}

export class TurnJudge {
  private readonly opts: TurnJudgeOptions;
  private readonly log: (line: string) => void;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rbuf: Buffer = Buffer.alloc(0);
  /** 串行化：侧车一次只处理一条请求 */
  private chain: Promise<unknown> = Promise.resolve();
  private pending: ((p: number) => void) | null = null;
  /**
   * 超时后侧车仍可能补来那一发的 8 字节 `f64`。
   * 当时 `pending` 已经清掉，这个迟到包必须先丢掉，不能配给下一发。
   */
  private discardNext = 0;

  constructor(opts: TurnJudgeOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  private ensure(): void {
    if (this.proc) return;
    const proc = spawn(this.opts.python, [this.opts.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    proc.stdout.on('data', (d: Buffer) => {
      this.rbuf = this.rbuf.length === 0 ? d : Buffer.concat([this.rbuf, d]);
      while (this.rbuf.length >= 8) {
        const prob = this.rbuf.readDoubleLE(0);
        this.rbuf = this.rbuf.subarray(8);
        if (this.discardNext > 0) {
          this.discardNext -= 1;
          continue;
        }
        const r = this.pending;
        this.pending = null;
        r?.(prob);
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      // 侧车自己已经打了 `[turn-judge]` 前缀，这里不再加一层
      if (s) this.log(s.slice(0, 200));
    });
    proc.on('exit', (code) => {
      this.log(`[turn-judge] 侧车退出 code=${code}，下次调用会重新拉起`);
      this.proc = null;
      // 进程没了，迟到的那一发也不会再来。留下的 discard 计数会吞掉新进程的第一包。
      this.discardNext = 0;
      this.rbuf = Buffer.alloc(0);
      const r = this.pending;
      this.pending = null;
      r?.(-1);
    });
  }

  /**
   * 判断这段音频之后「用户说完了吗」。
   *
   * @param pcm 16 kHz 单声道 PCM16，建议给整轮（截最近 8 秒）
   * @returns 概率 0..1；侧车故障时返回 -1（调用方应退回保守策略）
   */
  async predict(pcm: Buffer): Promise<number> {
    const run = async (): Promise<number> => {
      if (pcm.length === 0) return -1;
      this.ensure();
      const proc = this.proc;
      if (!proc) return -1;
      const head = Buffer.allocUnsafe(4);
      head.writeUInt32LE(pcm.length, 0);
      const done = new Promise<number>((resolve) => {
        this.pending = resolve;
        setTimeout(() => {
          if (this.pending === resolve) {
            this.pending = null;
            this.discardNext += 1;
            resolve(-1);
          }
        }, 5000).unref?.();
      });
      proc.stdin.write(head);
      proc.stdin.write(pcm);
      return await done;
    };

    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return await next;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    try {
      p?.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }
}
