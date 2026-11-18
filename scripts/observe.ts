#!/usr/bin/env node
/**
 * 一条命令看一场会话的**全部事实**，每个数字标出它来自哪个源。
 *
 * ```bash
 * node scripts/observe.ts <会话目录>
 * node scripts/observe.ts <会话目录> --dsh-root <dsh 的 sessions 目录>
 * node scripts/observe.ts <会话目录> --only 分段,模型     # 只跑其中几段
 * ```
 *
 * <h2>为什么要有它</h2>
 *
 * 三条链各有一个权威源，散在三处：
 *
 * | 事实 | 唯一源 | 取数工具 |
 * |---|---|---|
 * | ①②③④ 分段、停嘴时刻、缺仪表 | 本仓会话档案 `events.jsonl` | `latency-report.ts` |
 * | 状态轮转、插话有没有停音频 | 同上 | `fsm-trace-check.ts` |
 * | 一轮内部（step / 工具 / reasoning / 作业 / 子代理） | **dsh 自己的 session log** | `dsh-timeline.ts` |
 * | 模型行为（问了什么 / 答了什么 / 用户听到多少） | 同上 + 快车道的 `agent.*`（它没有 session log） | `said-audit.ts` |
 *
 * 第三条**绝不复制进档案** —— dsh 已经把它写全了（`session.v4.jsonl.zstd`，每条带毫秒
 * `time`）。复制一份过来只会多一份要维护、还会和原件的时钟对不上。所以这里做的
 * 不是搬运，而是**自动去正确的源取数，并按同一时间轴摆好**。
 *
 * 第四条两者都要：`path=dsh` 的回复能在 dsh 的 log 里翻到，但**快车道（qwen-flash）
 * 没有 session log** —— 它的问题/答案只能靠档案里的 `agent.ask` / `agent.done`
 * （见 `docs/TOOLS.md` §12.1）。缺这些字段的老档案会显示「缺仪表」，不当空白。
 *
 * 缺哪个源就说缺哪个，不拿别的源里的数顶上（本项目的地基规矩：缺仪表记 null）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '..');

interface Section {
  readonly key: string;
  readonly title: string;
  readonly script: string;
  readonly args: string[];
  /** 这一段要求哪些源在场；缺了就直接说缺，不往下跑（省得甩一屏 stack） */
  readonly needs: readonly string[];
}

/** 跑一个子工具；失败**不算致命** —— 缺源是正常情况，如实报出来 */
function run(script: string, args: readonly string[]): { ok: boolean; text: string } {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    return { ok: true, text: out.trimEnd() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? '未知错误');
    return { ok: false, text };
  }
}

/** 这场会话有哪些源可用 */
function sources(dir: string): Array<{ name: string; where: string; ok: boolean; note: string }> {
  const events = join(dir, 'events.jsonl');
  const meta = join(dir, 'meta.json');
  let hasDshSession = false;
  if (existsSync(events)) {
    hasDshSession = readFileSync(events, 'utf8').includes('"dsh_session"');
  }
  return [
    {
      name: '会话档案',
      where: events,
      ok: existsSync(events),
      note: existsSync(events) ? `${(statSync(events).size / 1024).toFixed(1)} KB` : '缺（这场没写档案）',
    },
    {
      name: '档案元信息',
      where: meta,
      ok: existsSync(meta),
      note: existsSync(meta) ? '有时间基准 startedAt' : '缺（dsh 对齐要用它）',
    },
    {
      name: 'dsh session log',
      where: '<dsh 的 sessions 目录>/<turn.end.dsh_session>',
      ok: hasDshSession,
      note: hasDshSession
        ? '档案里有 dsh_session，按 id 自动定位'
        : '档案里没有 dsh_session（这一场没走 dsh，或旧格式）',
    },
  ];
}

function main(argv: readonly string[]): number {
  const target = argv.find((a) => !a.startsWith('--'));
  if (target === undefined) {
    console.error('用法: node scripts/observe.ts <会话目录> [--dsh-root <dir>] [--only 分段,审计,dsh,模型]');
    return 2;
  }
  const dir = resolve(target);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`不是目录: ${dir}`);
    return 2;
  }

  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 && argv[onlyAt + 1] !== undefined
    ? new Set(argv[onlyAt + 1]!.split(',').map((s) => s.trim()))
    : null;
  const dshRootAt = argv.indexOf('--dsh-root');
  const dshRoot = dshRootAt >= 0 ? argv[dshRootAt + 1] : undefined;

  const sections: Section[] = [
    {
      key: '分段',
      title: '延迟分段（① 停嘴→定稿 ② 定稿→开轮 ③ 开轮→首块 ④ 播放）',
      script: 'latency-report.ts',
      args: [dir],
      needs: ['events.jsonl'],
    },
    {
      key: '审计',
      title: '状态轮转与插话审计',
      script: 'fsm-trace-check.ts',
      args: [dir],
      needs: ['events.jsonl'],
    },
    {
      key: 'dsh',
      title: 'dsh 侧逐轮拆解（step / 工具 / 作业 / 子代理）',
      script: 'dsh-timeline.ts',
      args: [dir, ...(dshRoot === undefined ? [] : ['--dsh-root', dshRoot])],
      // 对齐要用 meta.json 的 startedAt，还要档案里有 dsh_session
      needs: ['events.jsonl', 'meta.json', 'dsh_session'],
    },
    {
      key: '模型',
      title: '模型行为（用户说了什么 / 被问了什么 / 答了什么 / 听到多少）',
      script: 'said-audit.ts',
      args: [dir],
      needs: ['events.jsonl'],
    },
  ];

  const present = new Set<string>();
  if (existsSync(join(dir, 'events.jsonl'))) present.add('events.jsonl');
  if (existsSync(join(dir, 'meta.json'))) present.add('meta.json');
  const eventsText = present.has('events.jsonl')
    ? readFileSync(join(dir, 'events.jsonl'), 'utf8')
    : '';
  if (eventsText.includes('"dsh_session"')) present.add('dsh_session');

  console.log(`# ${dir}\n`);
  console.log('## 事实源');
  for (const s of sources(dir)) {
    console.log(`  ${s.ok ? '✓' : '✗'} ${s.name.padEnd(16)} ${s.where}`);
    console.log(`    ${s.note}`);
  }

  let hardFail = !present.has('events.jsonl');
  for (const s of sections) {
    if (only !== null && !only.has(s.key)) {
      continue;
    }
    console.log(`\n## ${s.title}`);
    const missing = s.needs.filter((n) => !present.has(n));
    if (missing.length > 0) {
      // 缺源就说缺源。**不从别的源里拿个数顶上** —— 那正是「拿 0 冒充」的变种
      console.log(`  — 跳过：这场会话缺 ${missing.join('、')}`);
      continue;
    }
    const r = run(s.script, s.args);
    if (!r.ok) {
      console.log(`  ✗ 这一段取不到数（${s.script} 失败）`);
      console.log(r.text.split('\n').slice(0, 20).map((l) => `    ${l}`).join('\n'));
      continue;
    }
    // 子工具也会打一行 `# <目录>` 抬头，和上面的标题重复
    const body = r.text.split('\n').filter((l, i) => !(i === 0 && l.startsWith('# ')));
    console.log(body.map((l) => `  ${l}`).join('\n'));
  }

  if (hardFail) {
    console.error('\n没有 events.jsonl —— 这份档案不完整，以上结论都不成立。');
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
