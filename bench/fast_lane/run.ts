/**
 * 快车道最小 harness。
 *
 * 只回答三个问题：
 * 1. **误拦截率** —— 该走 dsh 的请求被快车道答了（唯一真正危险的，偶发一次就是答错）
 * 2. **命中率** —— 纯闲聊里有多少真的省下了那 700–1300 ms
 * 3. 两条路径的延迟分布（整句 / 首字）
 *
 *   node bench/fast_lane/run.ts                 # 一次
 *   node bench/fast_lane/run.ts --runs 3        # 每个 case 跑 3 遍，看延迟方差
 *   node bench/fast_lane/run.ts --model deepseek-chat --json out.json
 *   node bench/fast_lane/run.ts --offline       # 假 fetch，只验证 harness 本身
 *
 * 误拦截 > 0 时退出码为 1（可以当门禁用）。需要 `DEEPSEEK_API_KEY`。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { CascadeAgent, isFastCandidate } from '../../src/pipelines/cascade-agent.ts';
import type { AgentProvider } from '../../src/providers.ts';

interface Case {
  readonly text: string;
  readonly label: 'chitchat' | 'task';
  readonly note?: string;
}

/** 一条 case 的判定结果 */
type Verdict = 'fast' | 'local-block' | 'model-delegate' | 'error';

interface Row {
  readonly text: string;
  readonly label: Case['label'];
  readonly verdict: Verdict;
  readonly ms: number;
  readonly firstTokenMs: number;
  /** 该走 dsh 却被快车道答了 —— 唯一算错的 */
  readonly wrong: boolean;
  /** 纯闲聊却交给了 dsh —— 只是没赚到 */
  readonly missed: boolean;
  readonly answer: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1))))] ?? 0;
}

function fakeInner(): { agent: AgentProvider; calls: () => number } {
  let n = 0;
  return {
    agent: {
      name: 'dsh',
      reply: async () => {
        n += 1;
        return { text: '[dsh]', speech: '[dsh]' };
      },
    },
    calls: () => n,
  };
}

/** 假的 SSE 响应：`--offline` 用，验证 harness 自己跑得通 */
function offlineFetch(): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = String((init as { body?: string } | undefined)?.body ?? '');
    const text = body.includes('几点了') || body.includes('下雨') ? '[[DELEGATE]]' : '好的呀。';
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200 });
  }) as typeof fetch;
}

async function runCase(
  item: Case,
  options: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    fetchImpl: typeof fetch;
    timeoutMs: number;
    totalMs: number;
    speculate: boolean;
  },
): Promise<Row> {
  const inner = fakeInner();
  const lines: string[] = [];
  const agent = new CascadeAgent({
    inner: inner.agent,
    apiKey: options.apiKey,
    model: options.model,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    totalMs: options.totalMs,
    speculate: options.speculate,
    // 类默认已是 true，和旧 FrontedAgent 一样。写明是因为本 harness 靠 [[DELEGATE]] 判委派。
    delegateEnabled: true,
    log: (line) => { lines.push(line); },
  });

  const startedAt = Date.now();
  const reply = await agent.reply(item.text);
  const ms = Date.now() - startedAt;
  // 投机模式下 dsh 也会被叫（并行起跑），所以不能再用「inner 有没有被调用」判断胜负，
  // 只能看最后采用的是谁的答复
  const delegated = reply.speech === '[dsh]';

  let verdict: Verdict;
  if (!isFastCandidate(item.text)) {
    verdict = 'local-block';
  } else if (!delegated) {
    verdict = 'fast';
  } else {
    verdict = lines.some((l) => l.includes('✗')) ? 'error' : 'model-delegate';
  }

  return {
    text: item.text,
    label: item.label,
    verdict,
    ms,
    firstTokenMs: delegated ? 0 : (reply.firstTokenMs ?? 0),
    wrong: item.label === 'task' && verdict === 'fast',
    missed: item.label === 'chitchat' && verdict !== 'fast',
    answer: delegated ? '（交给 dsh）' : reply.speech,
  };
}

async function main(): Promise<number> {
  const cases = JSON.parse(
    readFileSync(new URL('./cases.json', import.meta.url), 'utf8'),
  ) as Case[];
  const runs = Number(arg('runs', '1'));
  const model = arg('model', 'deepseek-chat') ?? 'deepseek-chat';
  // 首字超时可扫：拿命中率与「委派代价」两条曲线一起看，才知道该卡在哪
  const timeoutMs = Number(arg('timeout', '700'));
  const totalMs = Number(arg('total', '2800'));
  /** `--serial`：关掉投机，退回「先等快模型判定」 */
  const speculate = !process.argv.includes('--serial');
  const offline = process.argv.includes('--offline');
  // `--key-env` / `--base-url`：同一份用例可以打**任意 OpenAI 兼容**的供应商，
  // 换快模型时才有可比数据（不然只能拍脑袋）
  const keyEnv = arg('key-env', 'DEEPSEEK_API_KEY') as string;
  const baseUrl = arg('base-url');
  const apiKey = offline ? 'offline' : (process.env[keyEnv] ?? '').trim();

  if (apiKey === '') {
    console.error(`缺 ${keyEnv}（或在服务器上跑，或用 --offline 只验 harness）`);
    return 2;
  }

  const fetchImpl = offline ? offlineFetch() : fetch;
  const rows: Row[] = [];
  for (const item of cases) {
    for (let i = 0; i < runs; i += 1) {
      rows.push(await runCase(item, {
      apiKey,
      model,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      fetchImpl,
      timeoutMs,
      totalMs,
      speculate,
    }));
    }
  }

  const mark = (row: Row): string => {
    if (row.wrong) {
      return '✗ 误拦截';
    }
    if (row.verdict === 'local-block') {
      return row.missed ? '· 漏' : '✓ 本地挡';
    }
    if (row.missed) {
      // 漏要分清是「模型判委派」还是「超时/报错」—— 后者是 harness 自己的锅，
      // 第一版就因为把两者混在一起，10 条闲聊被 700 ms 硬超时掐断却看不出来
      return row.verdict === 'error' ? '· 漏(超时)' : '· 漏(委派)';
    }
    return row.verdict === 'fast' ? '✓ 快车道' : '✓ 委派';
  };

  console.log(`\n模型 ${model}${baseUrl === undefined ? '' : ` @ ${baseUrl}`}  每个 case ${runs} 遍  首字超时 ${timeoutMs} ms  `
    + `投机 ${speculate ? '开' : '关'}  共 ${rows.length} 条\n`);
  for (const row of rows) {
    console.log(
      `${mark(row).padEnd(10)} ${String(row.ms).padStart(5)} ms  `
      + `首字${String(row.firstTokenMs).padStart(5)}  `
      + `${row.label.padEnd(8)} ${JSON.stringify(row.text)}  → ${row.answer}`,
    );
  }

  const chitchat = rows.filter((r) => r.label === 'chitchat');
  const task = rows.filter((r) => r.label === 'task');
  const fastRows = rows.filter((r) => r.verdict === 'fast');
  const wrong = rows.filter((r) => r.wrong).length;
  // 「漏」只能按闲聊行算 —— 任务行委派是**正确**行为，混进来会得出「漏 6」这种
  // 看着吓人却不知所指的数字（第一版就是这么错的）
  const missedRows = chitchat.filter((r) => r.missed);
  const missLocal = missedRows.filter((r) => r.verdict === 'local-block').length;
  const missModel = missedRows.filter((r) => r.verdict === 'model-delegate').length;
  const missError = missedRows.filter((r) => r.verdict === 'error').length;
  const timeouts = rows.filter((r) => r.verdict === 'error').length;

  console.log('\n—— 汇总 ——');
  console.log(`  误拦截      ${wrong} / ${task.length} 条任务请求${wrong === 0 ? '（0 = 门禁通过）' : '  ← 必须为 0'}`);
  console.log(`  闲聊命中    ${chitchat.length - missedRows.length} / ${chitchat.length}`
    + `（漏 ${missedRows.length}：本地挡 ${missLocal}、模型判委派 ${missModel}、超时 ${missError}）`);
  if (fastRows.length > 0) {
    const whole = fastRows.map((r) => r.ms);
    const first = fastRows.map((r) => r.firstTokenMs);
    console.log(`  快车道整句  p50 ${percentile(whole, 50)} ms  p90 ${percentile(whole, 90)} ms  n=${whole.length}`);
    console.log(`  快车道首字  p50 ${percentile(first, 50)} ms  p90 ${percentile(first, 90)} ms`);
  }
  const delegateRows = rows.filter((r) => r.verdict === 'model-delegate');
  if (delegateRows.length > 0) {
    const cost = delegateRows.map((r) => r.ms);
    console.log(`  让位判定    p50 ${percentile(cost, 50)} ms`
      + (speculate ? '（投机：dsh 同时起跑，这段不落在它身上）' : '（串行：dsh 要等这段）'));
  }
  console.log('  对照 dsh  真机 TTFT p50 690 ms / dsh_ms 792–2067 ms（14 轮）');

  const jsonOut = arg('json');
  if (jsonOut !== undefined) {
    writeFileSync(jsonOut, JSON.stringify({ model, runs, rows }, null, 2));
    console.log(`\n已写入 ${jsonOut}`);
  }
  return wrong === 0 ? 0 : 1;
}

process.exitCode = await main();
