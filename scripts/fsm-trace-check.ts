#!/usr/bin/env node
/**
 * 审计一份（或多份）会话档案的时序与状态轮转。
 *
 *   node --experimental-strip-types scripts/fsm-trace-check.ts <events.jsonl | 档案目录> [...]
 *   node --experimental-strip-types scripts/fsm-trace-check.ts --json <事件文件>   # 给脚本吃
 *
 * 退出码：0 = 没有违规；1 = 有违规；2 = 用法/读文件出错。
 *
 * 只看**时序与状态轮转**，不看任务做没做成（τ² 的 reward 是另一回事）。
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { checkTrace, parseTrace, type TraceEvent } from '../src/fsm-trace.ts';

function load(path: string): { label: string; events: TraceEvent[] } {
  const st = statSync(path);
  if (st.isDirectory()) {
    const file = join(path, 'events.jsonl');
    return { label: path, events: parseTrace(readFileSync(file, 'utf8')) };
  }
  return { label: path, events: parseTrace(readFileSync(path, 'utf8')) };
}

function fmt(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

function main(argv: readonly string[]): number {
  const wantJson = argv.includes('--json');
  const paths = argv.filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('用法：fsm-trace-check.ts [--json] <events.jsonl | 档案目录> [...]');
    return 2;
  }

  let failed = 0;
  const report: Array<Record<string, unknown>> = [];
  for (const path of paths) {
    let loaded: { label: string; events: TraceEvent[] };
    try {
      loaded = load(path);
    } catch (error) {
      console.error(`✗ 读不了 ${path}：${(error as Error).message}`);
      return 2;
    }
    const result = checkTrace(loaded.events);
    if (result.violations.length > 0) {
      failed += 1;
    }
    report.push({ label: loaded.label, ...result });

    if (!wantJson) {
      const name = loaded.label.split(/[\\/]/).filter((s) => s !== '').pop() ?? loaded.label;
      console.log(`\n=== ${name}  轮次 ${result.turns.length}  状态事件 ${result.states}`);
      if (result.turns.length > 0) {
        console.log('  #  停嘴→首块  出句→开轮  开轮→首块  中断');
        for (const t of result.turns) {
          console.log(
            `  ${String(t.no).padStart(2)} ${fmt(t.stopToFirstMs).padStart(8)} ${fmt(t.sentenceToTurnMs).padStart(9)}`
            + ` ${fmt(t.turnToFirstMs).padStart(9)}  ${t.interrupted ? '是' : ''}`,
          );
        }
      }
      if (result.skipped.length > 0) {
        console.log(`  跳过（缺仪表）：${result.skipped.join(' / ')}`);
      }
      if (result.violations.length === 0) {
        console.log('  ✓ 没有违规');
      } else {
        for (const v of result.violations) {
          console.log(`  ✗ [${v.rule}] @${v.at} ${v.detail}`);
        }
      }
    }
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  }
  return failed > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
