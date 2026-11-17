/**
 * 通用小工具。没有依赖，谁都可以引。
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * 读一个环境变量，**新名优先、旧名兜底**。
 *
 * 判停器原来叫 `SMART_TURN_*`，2026-11-18 改名 `TURN_JUDGE_*`。生产的 `.env`
 * 与 systemd 单元里可能还留着旧名，读的时候认一次，免得改名当天就把判停关掉了。
 * 代码里只出现新名。
 */
export function envString(name: string): string | undefined {
  const legacy = name.replace(/^TURN_JUDGE/, 'SMART_TURN');
  return process.env[name] ?? process.env[legacy];
}

/** 读一个数字型环境变量，非法值退回默认 */
export function envNumber(name: string, fallback: number): number {
  const raw = envString(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** PCM16 小端单声道峰值电平（dBFS）。用来判「这段到底有没有人声」。 */
export function peakDbfs(pcm: Buffer): number {
  let peak = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i += 1) {
    const v = pcm.readInt16LE(i << 1);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak === 0 ? -120 : 20 * Math.log10(peak / 32768);
}
