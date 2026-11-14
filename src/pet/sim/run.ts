/**
 * `npm run sim`：跑场景；`--explore` 跑随机探索。
 *
 * 零网络、零密钥、零 ffmpeg。退出码非零 = 有失败，可以直接挂进 CI。
 *
 * ```bash
 * npm run sim
 * npm run sim -- --explore --runs 500 --seed 1
 * npm run sim -- --trace out/            # 每个场景的时间线写成 JSONL
 * ```
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIN } from './host.ts';
import { SCENARIOS, runScenario } from './scenarios.ts';
import { DIALOG_SCENARIOS, runDialogScenarios } from './dialog-scenarios.ts';
import { explore, formatRepro } from './explore.ts';

interface Args {
  readonly explore: boolean;
  readonly runs: number;
  readonly seed: number;
  readonly trace: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    const raw = index < 0 ? undefined : argv[index + 1];
    return raw === undefined ? fallback : Number(raw);
  };
  const traceIndex = argv.indexOf('--trace');
  return {
    explore: argv.includes('--explore'),
    runs: value('--runs', 200),
    seed: value('--seed', 1),
    trace: traceIndex < 0 ? null : argv[traceIndex + 1] ?? 'out',
  };
}

const args = parseArgs(process.argv.slice(2));
let failed = 0;

if (args.explore) {
  console.log(`随机探索：${args.runs} 次，seed=${args.seed}，跨度 8h`);
  const failures = await explore({ seed: args.seed, runs: args.runs, horizonMs: 8 * 60 * MIN });
  if (failures.length === 0) {
    console.log(`  ✔ ${args.runs} 次随机运行全部通过`);
  } else {
    failed += failures.length;
    for (const failure of failures) {
      console.log(`  ✘ run=${failure.run} device=${failure.device}`);
      for (const violation of failure.violations) {
        console.log(`      ${violation.rule} t=${violation.at} ${violation.detail}`);
      }
      console.log('    最小复现（可直接粘进 scenarios.ts）：');
      console.log(formatRepro(failure));
    }
  }
} else {
  for (const scenario of SCENARIOS) {
    try {
      const result = await runScenario(scenario);
      console.log(`  ✔ ${scenario.name}`);
      if (args.trace !== null) {
        mkdirSync(args.trace, { recursive: true });
        const file = join(args.trace, `${scenario.name.replace(/[\\/:*?"<>|\s]+/g, '_')}.jsonl`);
        writeFileSync(file, result.world.timeline.map((event) => JSON.stringify(event)).join('\n'));
      }
    } catch (error) {
      failed += 1;
      console.log(`  ✘ ${scenario.name}`);
      for (const line of String((error as Error).message).split('\n')) {
        console.log(`      ${line}`);
      }
    }
  }

  // 对话环（ADR-0002 §10.7）：同样跑在虚拟时间上
  for (const result of await runDialogScenarios()) {
    if (result.ok) {
      console.log(`  ✔ ${result.name}`);
    } else {
      failed += 1;
      console.log(`  ✘ ${result.name}`);
      console.log(`      ${result.error ?? ''}`);
    }
  }

  const total = SCENARIOS.length + DIALOG_SCENARIOS.length;
  console.log(`\n${total - failed}/${total} 个场景通过`);
}

process.exit(failed === 0 ? 0 : 1);
