/**
 * `scripts/dsh-timeline.ts` 的单测：钉住「两份日志怎么按绝对时间对齐」。
 *
 * 为什么要测它：这个脚本不产出任何线上行为，只产出**判断依据**。一旦对齐算错，
 * 「③ agent 段到底花在哪」这个结论就会指向错误的优化方向，而且错得很像对的。
 *
 * 用合成数据而不是真实档案：dsh 的会话档案几十分钟就被轮转掉，拿真样本写测试
 * 迟早变成跳过。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'dsh-timeline.ts');

/** 档案的绝对起点；dsh 事件的 `time` 都以它为基准编出来。 */
const T0 = Date.parse('2026-11-15T10:00:00.000Z');

interface OurEvent {
  t: number;
  ev: string;
  [key: string]: unknown;
}

/** 造一套「我们的档案 + dsh 会话」，返回会话目录与 dsh 根目录。 */
function fixture(
  ourEvents: OurEvent[],
  dshEvents: Array<Record<string, unknown>>,
  sessionCreatedAtMs: number = T0,
): {
  dir: string;
  dshRoot: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-timeline-'));
  const dir = join(root, 'session');
  const dshRoot = join(root, 'dsh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    startedAt: new Date(T0).toISOString(),
    gateHoldMs: 2000,
  }));
  writeFileSync(join(dir, 'events.jsonl'), `${ourEvents.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const sid = 'sess-abc';
  const ws = join(dshRoot, '--home-me-workspace--', sid);
  mkdirSync(ws, { recursive: true });
  const lines = [
    { type: 'session', version: 4, id: sid, createdAt: sessionCreatedAtMs, time: sessionCreatedAtMs },
    ...dshEvents,
  ].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(ws, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${lines}\n`, 'utf8')));

  return {
    dir,
    dshRoot,
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

function run(dir: string, dshRoot: string, extra: readonly string[] = []): string {
  return execFileSync(
    process.execPath,
    [SCRIPT, dir, '--dsh-root', dshRoot, ...extra],
    { encoding: 'utf8' },
  );
}

/** dsh 事件的 `time` 用「距 T0 的毫秒」编，省得每处手算绝对时间。 */
function at(ms: number, type: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, time: T0 + ms, data };
}

test('按 dsh_session 精确配对，两边事件落在同一条时间轴上', () => {
  const our: OurEvent[] = [
    { t: 1000, ev: 'turn.start', text_len: 3 },
    { t: 6000, ev: 'tts.first', ms: 3800 },
    { t: 6100, ev: 'turn.end', dsh_session: 'sess-abc', dsh_ms: 5000 },
  ];
  const dsh = [
    at(1050, 'turn/start', { turn: 1 }),
    at(1060, 'user/message', { content: [{ type: 'text', text: '在吗' }] }),
    at(1200, 'step/start', { step: 1 }),
    at(2000, 'tool/call', { name: 'bash', arguments: '{"command":"ls"}' }),
    at(3000, 'tool/result', { result: 'ok' }),
    at(4000, 'step/end', { step: 1 }),
    at(5800, 'turn/end', { reason: { kind: 'completed' } }),
  ];
  const f = fixture(our, dsh);
  try {
    const out = run(f.dir, f.dshRoot);
    assert.match(out, /dsh 会话：sess-abc/, '要按 turn.end 里的 dsh_session 找到会话');
    // 对齐后的相对时刻：dsh 的 1050 应显示成 1050（与我们的 t 同一个基准）
    assert.match(out, /^\s+1050\s+dsh\s+· turn\/start/m);
    assert.match(out, /^\s+2000\s+dsh\s+· tool bash\s+\{"command":"ls"\}/m);
    assert.match(out, /^\s+1000\s+miai\s+turn\.start/m);
  } finally {
    f.cleanup();
  }
});

test('逐轮拆解：step 数与工具名归到对应那一轮', () => {
  const our: OurEvent[] = [
    { t: 1000, ev: 'turn.start' },
    { t: 5000, ev: 'tts.first' },
    { t: 5100, ev: 'turn.end', dsh_session: 'sess-abc' },
    { t: 20000, ev: 'turn.start' },
    { t: 26000, ev: 'tts.first' },
    { t: 26100, ev: 'turn.end', dsh_session: 'sess-abc' },
  ];
  const dsh = [
    at(1000, 'step/start', { step: 1 }),
    at(1500, 'tool/call', { name: 'bash', arguments: '{}' }),
    at(1600, 'tool/call', { name: 'bash', arguments: '{}' }),
    at(1800, 'step/end', { step: 1 }),
    at(2000, 'step/start', { step: 2 }),
    at(2500, 'step/end', { step: 2 }),
    at(20000, 'step/start', { step: 3 }),
    at(22000, 'tool/call', { name: 'subagent', arguments: '{}' }),
    at(25000, 'step/end', { step: 3 }),
  ];
  const f = fixture(our, dsh);
  try {
    const out = run(f.dir, f.dshRoot);
    const summary = out.split('=== 每轮的 agent 内部')[1] ?? '';
    // 第 1 轮：4000 ms、2 步、2 次 bash
    assert.match(summary, /^\s+1\s+4000\s+2\s+2\s+bash$/m);
    // 第 2 轮：6000 ms、1 步、1 次 subagent
    assert.match(summary, /^\s+2\s+6000\s+1\s+1\s+subagent$/m);
  } finally {
    f.cleanup();
  }
});

test('没有 dsh_session 时按时间重叠挑会话，不硬凑不重叠的', () => {
  const our: OurEvent[] = [
    { t: 1000, ev: 'turn.start' },
    { t: 2000, ev: 'tts.first' },
    { t: 2100, ev: 'turn.end' }, // 故意不写 dsh_session
  ];
  const dsh = [
    at(1100, 'turn/start', { turn: 1 }),
    at(1500, 'step/start', { step: 1 }),
  ];
  const f = fixture(our, dsh);
  try {
    const out = run(f.dir, f.dshRoot);
    assert.match(out, /dsh 会话：sess-abc/, 'archive 区间内开始的会话应当被挑中');
  } finally {
    f.cleanup();
  }
});

test('多帧 zstd：要么全解，要么明确报错，绝不静默只给第一帧', () => {
  const our: OurEvent[] = [
    { t: 1000, ev: 'turn.start' },
    { t: 5000, ev: 'tts.first' },
    { t: 5100, ev: 'turn.end', dsh_session: 'sess-abc' },
  ];
  const root = mkdtempSync(join(tmpdir(), 'dsh-timeline-multi-'));
  try {
    const dir = join(root, 'session');
    const dshRoot = join(root, 'dsh');
    const ws = join(dshRoot, '--home-me-workspace--', 'sess-abc');
    mkdirSync(dir, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ startedAt: new Date(T0).toISOString() }));
    writeFileSync(join(dir, 'events.jsonl'), `${our.map((e) => JSON.stringify(e)).join('\n')}\n`);

    // dsh 真实写法的模拟：**两帧**拼在一起，第二帧里才是 tool/call
    const frame1 = `${JSON.stringify({ type: 'session', id: 'sess-abc', version: 4, createdAt: T0, time: T0 })}\n`;
    const frame2 = `${JSON.stringify(at(1500, 'tool/call', { name: 'bash', arguments: '{}' }))}\n`;
    writeFileSync(
      join(ws, 'session.v4.jsonl.zstd'),
      Buffer.concat([
        zstdCompressSync(Buffer.from(frame1, 'utf8')),
        zstdCompressSync(Buffer.from(frame2, 'utf8')),
      ]),
    );

    let out: string;
    try {
      out = run(dir, dshRoot);
    } catch (e) {
      // 没有 zstd 命令时（Windows）必须**明确报错**，而不是安静地只给第一帧
      const msg = `${(e as { stdout?: string }).stdout ?? ''}${(e as Error).message}`;
      assert.match(msg, /zstd 帧|多帧/);
      return;
    }
    // 有 zstd 命令（Linux/CI）：两帧都要解出来，tool/call 必须在里面
    assert.match(out, /tool bash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('会话在档案区间之外时不配对，如实说找不到', () => {
  const our: OurEvent[] = [
    { t: 1000, ev: 'turn.start' },
    { t: 2000, ev: 'tts.first' },
    { t: 2100, ev: 'turn.end' },
  ];
  // dsh 会话比档案早一小时开始 —— 不是同一次
  const dsh = [{ type: 'turn/start', time: T0 - 3600_000, data: { turn: 1 } }];
  const f = fixture(our, dsh, T0 - 3600_000);
  try {
    const out = run(f.dir, f.dshRoot);
    assert.match(out, /dsh 会话：未找到/);
    // 未配对时不该出现任何 dsh 行
    assert.doesNotMatch(out, /^\s+-?\d+\s+dsh\s/m);
  } finally {
    f.cleanup();
  }
});
