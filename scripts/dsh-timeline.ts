/**
 * 把 miai 会话档案和 dsh 自己的 session log 拼到**同一条时间轴**上。
 *
 * ```bash
 * node scripts/dsh-timeline.ts <会话目录>
 * node scripts/dsh-timeline.ts <会话目录> --dsh-root ~/.dsh/sessions --verbose
 * ```
 *
 * <h2>为什么需要它</h2>
 *
 * `latency-report.ts` 能算出「③ agent+TTS 首块」有多久，但**拆不开**：那几秒是
 * 一步推理、六步推理，还是中间调了三次工具，从我们的档案里看不出来 —— 我们只
 * 知道 agent 什么时候开始、什么时候给出文本。
 *
 * dsh 自己把整个会话写成了 `session.v4.jsonl.zstd`（每条带毫秒 `time`、`seq`），
 * 里面有 `turn/start`、`step/start|end`、`tool/call|result`、`assistant/message`
 * （含 reasoning 原文）。所以不给自己插桩，**把两份日志按绝对时间对齐**就够。
 *
 * <h2>时间基准</h2>
 *
 * - 我们的档案：`meta.json` 的 `startedAt`（ISO）+ `events.jsonl` 的相对 `t`
 * - dsh：每条事件的 `time`（ epoch ms ）
 *
 * 两边都折算成「距 `startedAt` 多少毫秒」。`turn.end` 里若带了 `dsh_session`，
 * 直接按 id 找；没有就挑时间上重叠最多、且轮次数对得上的那个。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { EVENTS } from '../src/events.ts';

interface OurEvent {
  readonly t: number;
  readonly ev: string;
  readonly dsh_session?: unknown;
  readonly [key: string]: unknown;
}

interface DshEvent {
  readonly type: string;
  readonly time?: number;
  readonly seq?: number;
  readonly data?: Record<string, unknown>;
}

/** 一行统一时间轴。`src` 区分来源，`ms` 是距会话开始的毫秒数。 */
interface Row {
  readonly ms: number;
  readonly src: 'miai' | 'dsh';
  readonly label: string;
  readonly detail: string;
  /** miai 的 turn 序号（用于把 dsh 的 step 归到具体某一轮） */
  readonly turn?: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** 找 zstd 命令；找不到返回 null（Windows 上常见）。 */
let zstdCli: string | null | undefined;
function findZstd(): string | null {
  if (zstdCli !== undefined) {
    return zstdCli;
  }
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    zstdCli = 'zstd';
  } catch {
    zstdCli = null;
  }
  return zstdCli;
}

/** zstd 帧的魔数；dsh 每追加一批就写一帧，所以文件里会有多个。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 数文件里有几个 zstd 帧头。偶尔会把压缩数据里碰巧出现的字节算进去，宁可误报。 */
function countFrames(buf: Buffer): number {
  let n = 0;
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) {
    n += 1;
    i = buf.indexOf(ZSTD_MAGIC, i + ZSTD_MAGIC.length);
  }
  return n;
}

/**
 * 解压 dsh 的会话档案。
 *
 * **必须优先用命令行**：`.jsonl.zstd` 是**多帧**的（dsh 每追加一批就写一帧），
 * 而 Node 的 `zstdDecompressSync` 和 `createZstdDecompress` 都**只解第一帧**。
 * 实测一份 10814 字节的档案用内置 API 只解出 158 字节（就一条 `session` 事件），
 * 后面所有 step/tool 全丢，而且不报错 —— 报告会显示"agent 里什么都没干"。
 *
 * 没有命令行时按帧头判断：多帧就明确报错，绝不静默截断（这也和大小无关，
 * 两帧的小档案一样会丢数据）。
 */
function readZstd(path: string): string {
  const cli = findZstd();
  if (cli !== null) {
    return execFileSync(cli, ['-dc', path], { maxBuffer: 256 << 20 }).toString('utf8');
  }
  const raw = readFileSync(path);
  const frames = countFrames(raw);
  if (frames > 1) {
    throw new Error(
      `这份档案有 ${frames} 个 zstd 帧（dsh 追加写法的产物）。`
      + 'Node 内置 API 只解第一帧，会静默丢掉后面所有 step/tool；装个 zstd 命令再跑。',
    );
  }
  return zstdDecompressSync(raw).toString('utf8');
}

function parseDsh(text: string): DshEvent[] {
  const out: DshEvent[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    try {
      out.push(JSON.parse(s) as DshEvent);
    } catch {
      // 半行就算了
    }
  }
  return out;
}

/** 把一个 dsh 事件压成一行可读文本。 */
function describeDsh(e: DshEvent): { label: string; detail: string } | null {
  const d = e.data ?? {};
  switch (e.type) {
    case 'turn/start':
      return { label: 'turn/start', detail: `turn ${String(d['turn'] ?? '?')}` };
    case 'turn/end':
      return { label: 'turn/end', detail: JSON.stringify(d['reason'] ?? {}) };
    case 'step/start':
      return { label: 'step/start', detail: `#${String(d['step'] ?? '?')}` };
    case 'step/end':
      return { label: 'step/end', detail: `#${String(d['step'] ?? '?')}` };
    case 'tool/call': {
      // 参数只留前 70 字：够认出干了什么，又不至于把整段 bash 刷屏
      const args = typeof d['arguments'] === 'string' ? d['arguments'] : JSON.stringify(d['arguments'] ?? '');
      return { label: `tool ${String(d['name'] ?? '?')}`, detail: args.replace(/\s+/g, ' ').slice(0, 70) };
    }
    case 'tool/result': {
      const ok = d['isError'] === true ? 'ERROR' : 'ok';
      const body = typeof d['result'] === 'string' ? d['result'] : JSON.stringify(d['result'] ?? '');
      return { label: 'tool/result', detail: `${ok} ${body.replace(/\s+/g, ' ').slice(0, 60)}` };
    }
    case 'assistant/message': {
      const msg = d['message'] as { content?: ReadonlyArray<Record<string, unknown>> } | undefined;
      const parts = (msg?.content ?? []).map((c) =>
        c['type'] === 'reasoning'
          ? `[想]${String(c['text'] ?? '').replace(/\s+/g, ' ').slice(0, 40)}`
          : `[说]${String(c['text'] ?? '').replace(/\s+/g, ' ').slice(0, 40)}`);
      return { label: 'assistant', detail: `step ${String(d['step'] ?? '?')} ${parts.join(' ')}`.slice(0, 110) };
    }
    case 'user/message': {
      const content = d['content'] as ReadonlyArray<Record<string, unknown>> | undefined;
      const text = (content ?? []).map((c) => String(c['text'] ?? '')).join(' ');
      return { label: 'user/message', detail: text.replace(/\s+/g, ' ').slice(0, 70) };
    }
    default:
      return null;
  }
}

/**
 * 挑出和这份档案对应的 dsh 会话。
 *
 * 优先用 `turn.end` 里的 `dsh_session`；没有就按时间重叠挑 —— 会话开始时刻必须在
 * 档案的存活区间内，且轮次数对得上。
 */
function pickDshSession(
  root: string,
  wanted: string | null,
  startedAtMs: number,
  endedAtMs: number,
  turnCount: number,
): { id: string; events: DshEvent[] } | null {
  const candidates: Array<{ id: string; events: DshEvent[]; score: number }> = [];
  // 解压失败不能一律当"这个会话不相关"跳过：「没有 zstd 命令」会把所有会话
  // 都跳过，最后报「未找到」，看起来像没配对，实际是工具缺依赖。
  const errors: Error[] = [];
  let workspaces: string[];
  try {
    workspaces = readdirSync(root);
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    const wsDir = join(root, ws);
    let ids: string[];
    try {
      if (!statSync(wsDir).isDirectory()) {
        continue;
      }
      ids = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (wanted !== null && id !== wanted) {
        continue;
      }
      const file = join(wsDir, id, 'session.v4.jsonl.zstd');
      let events: DshEvent[];
      try {
        events = parseDsh(readZstd(file));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push(e as Error);
        }
        continue;
      }
      const created = events.find((e) => e.type === 'session')?.time
        ?? events.find((e) => typeof e.time === 'number')?.time
        ?? 0;
      const turns = events.filter((e) => e.type === 'turn/start').length;
      if (wanted !== null) {
        return { id, events };
      }
      // 时间要落在档案区间内（±2 s 容忍），轮次数越接近越优先
      if (created < startedAtMs - 2000 || created > endedAtMs + 2000) {
        continue;
      }
      candidates.push({ id, events, score: Math.abs(turns - turnCount) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (best === undefined) {
    // 一个都没配上，但解压时出过错 —— 把那个错抛出去，别让人以为是「没配对」
    if (errors.length > 0) {
      throw errors[0];
    }
    return null;
  }
  return { id: best.id, events: best.events };
}

function main(argv: readonly string[]): number {
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('用法: node scripts/dsh-timeline.ts <会话目录> [--dsh-root <dir>] [--verbose]');
    return 2;
  }
  const rootFlag = argv.indexOf('--dsh-root');
  const dshRoot = rootFlag >= 0 ? (argv[rootFlag + 1] ?? '') : join(homedir(), '.dsh', 'sessions');
  const verbose = argv.includes('--verbose');

  const meta = readJson<{ startedAt?: string; gateHoldMs?: number }>(join(dir, 'meta.json'));
  const startedAtMs = meta.startedAt === undefined ? NaN : Date.parse(meta.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    console.error('meta.json 里没有可用的 startedAt，无法对齐时间轴');
    return 2;
  }

  const ourEvents: OurEvent[] = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as OurEvent];
      } catch {
        return [];
      }
    });

  const lastT = ourEvents.reduce((m, e) => Math.max(m, e.t), 0);
  const turnEnds = ourEvents.filter((e) => e.ev === EVENTS.turnEnd);
  const wanted = turnEnds.map((e) => e.dsh_session).find((v) => typeof v === 'string');
  const turnCount = ourEvents.filter((e) => e.ev === EVENTS.turnStart).length;

  const dsh = pickDshSession(
    dshRoot,
    typeof wanted === 'string' ? wanted : null,
    startedAtMs,
    startedAtMs + lastT,
    turnCount,
  );

  const rows: Row[] = [];
  // miai 侧：turn 序号靠 turn.start 递增，好给 dsh 的 step 归轮
  let turnNo = 0;
  for (const e of ourEvents) {
    if (e.ev === EVENTS.turnStart) {
      turnNo += 1;
    }
    const skip = new Set<string>([EVENTS.asrPartial, EVENTS.petIn]);
    if (!verbose && skip.has(e.ev)) {
      continue;
    }
    const detail = JSON.stringify(
      Object.fromEntries(Object.entries(e).filter(([k]) => !['t', 'ev', 'at'].includes(k))),
    );
    rows.push({
      ms: e.t,
      src: 'miai',
      label: e.ev,
      detail: detail === '{}' ? '' : detail.slice(0, 80),
      turn: turnNo > 0 ? turnNo : undefined,
    });
  }

  if (dsh !== null) {
    for (const e of dsh.events) {
      if (typeof e.time !== 'number') {
        continue;
      }
      const d = describeDsh(e);
      if (d === null) {
        continue;
      }
      const ms = e.time - startedAtMs;
      if (ms < -2000 || ms > lastT + 2000) {
        continue;
      }
      rows.push({ ms, src: 'dsh', label: d.label, detail: d.detail });
    }
  }

  rows.sort((a, b) => a.ms - b.ms);

  const head = dsh === null
    ? `dsh 会话：未找到（用 --dsh-root 指定，或这一轮的 turn.end 里没有 dsh_session）`
    : `dsh 会话：${dsh.id}`;
  console.log(`# ${dir}\n# ${head}\n`);
  console.log(`${'ms'.padStart(7)}  ${'源'.padEnd(5)}${'事件'.padEnd(22)}详情`);
  for (const r of rows) {
    const mark = r.src === 'miai' ? '  ' : '· ';
    console.log(
      `${String(Math.round(r.ms)).padStart(7)}  ${r.src.padEnd(5)}${mark}${r.label.padEnd(20)}${r.detail}`,
    );
  }

  // 逐轮拆 ③：正是这个脚本存在的理由
  if (dsh !== null) {
    console.log('\n=== 每轮的 agent 内部（对应 miai 的 turn.start → tts.first）');
    const dshRows = rows.filter((r) => r.src === 'dsh' && typeof r.ms === 'number');
    const starts = ourEvents.filter((e) => e.ev === EVENTS.turnStart);
    const firsts = ourEvents.filter((e) => e.ev === EVENTS.ttsFirst);
    console.log(`${'轮'.padStart(3)}  ${'agent 段'.padStart(10)}  ${'步数'.padStart(4)}  ${'工具'.padStart(4)}  工具名`);
    for (let i = 0; i < starts.length; i += 1) {
      const from = starts[i]?.t ?? 0;
      const to = firsts[i]?.t ?? from;
      const inside = dshRows.filter((r) => r.ms >= from && r.ms <= to);
      const steps = inside.filter((r) => r.label === 'step/start').length;
      const tools = inside.filter((r) => r.label.startsWith('tool '));
      const names = [...new Set(tools.map((t) => t.label.slice(5)))].join(',');
      console.log(
        `${String(i + 1).padStart(3)}  ${String(Math.round(to - from)).padStart(10)}  `
        + `${String(steps).padStart(4)}  ${String(tools.length).padStart(4)}  ${names}`,
      );
    }
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
