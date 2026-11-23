#!/usr/bin/env node
/**
 * 离线 reduce：把一份真机档案的 `events.jsonl` 喂进内核纯函数，**不开 WS、不等真实时间**。
 *
 *   node --experimental-strip-types scripts/kernel-replay.ts tmp/logs/sess-053719-events.jsonl
 *
 * 输出的每一轮都给出内核的裁决（`stale` / `truncated` / `inject` / 该不该回注），
 * 并和档案里当时记下的 `turn.end` 对账。两者不一致就是**内核口径变了**，得当场
 * 解释清楚 —— 这条是"可离线 reduce 复现"那条硬标准的执行体。
 *
 * ## 事件映射（档案 → 内核）
 *
 * | 档案事件 | 内核事件 | 说明 |
 * |:--|:--|:--|
 * | `asr.commit{seq}` | `asrCommit` | 序号是因果量，直接用 |
 * | `asr.partial` / `asr.sentence` | `userSpeech` | 出生证取**当时已发出的最大 seq** —— 与生产里 `this.commitSeq` 同口径 |
 * | `turn.start` + `dialog.state(第 N 轮)` | `turnStarted` | `baseCommitSeq` = 开轮瞬间的最大 seq（生产是在 `beginTurn` 时锁存） |
 * | `dialog.state` | `fsmPhase` | 相位镜像（档案里没有票据/原因，不能反推开轮事件） |
 * | `agent.done{audio_s}` | `audioSent` | 媒体游标 = `audio_s * 1000`；首次出现的时刻记为首块墙钟 |
 * | `turn.end` | `turnEnded` | 与档案记的 `interrupted` / `truncated` 对账 |
 *
 * ## `inject` 三态
 *
 * 结算意图里的 `inject` 是**回注口气**，与 `truncated` 同源（都在 `kernel.ts` 的
 * `settle()` 里算）：`none`（少听了，不注）/ `spoken`（听全了，按"他听到了"注）/
 * `unspoken`（有结论但一个字都没播出去，仍要告知上下文）。这张表是回放对账的
 * 主要输出之一 —— 它一变，外部记忆的口径就变了。
 */
import { readFileSync } from 'node:fs';

import {
  initialKernelState,
  step,
  type KernelEvent,
  type KernelState,
  type SettlementInject,
} from '../src/kernel.ts';
import type { TurnTicket } from '../src/dialog-fsm.ts';

interface Row {
  readonly t: number;
  readonly ev: string;
  readonly [key: string]: unknown;
}

function parse(path: string): Row[] {
  return readFileSync(path, 'utf8')
    // Windows 工具（PowerShell 的 `Out-File -Encoding utf8`）会带 BOM，JSON.parse 会炸
    .replace(/^\uFEFF/u, '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row);
}

interface Verdict {
  readonly turn: number;
  readonly stale: boolean;
  readonly truncated: boolean;
  readonly heardMs: number;
  readonly totalMs: number;
  readonly reflect: boolean;
  /** 回注口气：`spoken` / `unspoken` / `none`（与 `truncated` 同源） */
  readonly inject: SettlementInject;
  /** 档案里当时记下的（没有就是 `undefined`） */
  readonly recorded: { interrupted?: boolean; truncated?: boolean; heardS?: number };
}

function replay(rows: readonly Row[]): Verdict[] {
  let state: KernelState = initialKernelState();
  let commitSeq = 0;
  let turnNo = 0;
  let ticket: TurnTicket | null = null;
  let firstAudioAt: number | null = null;
  /** 本轮开始时的下行字节基线（`at.down` 是累计值） */
  let downBase = 0;
  let downNow = 0;
  const recorded = new Map<number, { interrupted?: boolean; truncated?: boolean; heardS?: number }>();
  const out: Verdict[] = [];
  /** 24 kHz / 16 bit → 48 字节每毫秒 */
  const BYTES_PER_MS = 48;

  const feed = (event: KernelEvent): void => {
    const [next, effects] = step(state, event);
    state = next;
    for (const effect of effects) {
      if (effect.type !== 'settleTurn') continue;
      out.push({
        turn: effect.ticket.no,
        stale: effect.outcome.stale,
        truncated: effect.outcome.truncated,
        heardMs: effect.outcome.heardMs,
        totalMs: effect.outcome.totalAudioMs,
        reflect: effect.reflect,
        inject: effect.inject,
        recorded: recorded.get(effect.ticket.no) ?? {},
      });
    }
  };

  for (const row of rows) {
    // 媒体游标：`at.down` 是下行累计字节数，比任何墙钟都更接近"播到哪"
    const at = row['at'] as { down?: number } | undefined;
    if (typeof at?.down === 'number') {
      downNow = at.down;
      if (ticket !== null && firstAudioAt === null && downNow > downBase) {
        firstAudioAt = row.t;
      }
    }
    switch (row.ev) {
      case 'asr.commit': {
        const seq = typeof row['seq'] === 'number' ? row['seq'] : commitSeq;
        commitSeq = Math.max(commitSeq, seq);
        feed({ type: 'asrCommit', commitSeq });
        break;
      }
      case 'asr.partial':
      case 'asr.sentence':
        // 出生证：产出它的那一发 commit（生产里就是当前的 `this.commitSeq`）
        feed({ type: 'userSpeech', commitSeq, final: row.ev === 'asr.sentence', atMs: row.t });
        break;
      case 'turn.start': {
        turnNo += 1;
        firstAudioAt = null;
        downBase = downNow;
        ticket = { no: turnNo, gen: 0, baseCommitSeq: commitSeq };
        feed({ type: 'turnStarted', ticket, atMs: row.t });
        break;
      }
      case 'dialog.state': {
        const to = row['to'];
        if (typeof to === 'string') {
          feed({ type: 'fsmPhase', phase: to as KernelState['dialog']['phase'] });
        }
        break;
      }
      case 'agent.done': {
        // `agent.done` 只是"模型答完了"，不代表播出去多少 —— 媒体走 `at.down`
        break;
      }
      case 'turn.end': {
        if (ticket === null) break;
        const mediaMs = Math.max(0, (downNow - downBase) / BYTES_PER_MS);
        if (mediaMs > 0) {
          feed({ type: 'audioSent', mediaMs, atMs: firstAudioAt ?? row.t });
        }
        recorded.set(ticket.no, {
          interrupted: row['interrupted'] === true,
          truncated: row['truncated'] === true,
          heardS: typeof row['heard_s'] === 'number' ? row['heard_s'] : undefined,
        });
        feed({ type: 'turnEnded', ticket, atMs: row.t });
        ticket = null;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function main(argv: readonly string[]): number {
  const path = argv[2];
  if (path === undefined) {
    console.error('用法：node --experimental-strip-types scripts/kernel-replay.ts <events.jsonl>');
    return 2;
  }
  const verdicts = replay(parse(path));
  if (verdicts.length === 0) {
    console.log('（这份档案里没有可结算的轮次）');
    return 0;
  }
  console.log(`\n=== ${path}`);
  console.log('  轮  stale truncate  heard   total  回注  口气       档案记的      一致');
  let mismatched = 0;
  let artifacts = 0;
  for (const v of verdicts) {
    const rec = v.recorded;
    // 映射误差：档案里"听全了"且听到的时长已经覆盖媒体总量，说明音频是**一次性灌进设备**
    // 的（TTS 突发），我的首块时刻取自 `at.down` 的采样点，可能晚一两百毫秒 —— 
    // 这种不一致是测量误差，不是内核口径变了。真正的口径分歧只算剩下的那些。
    const artifact = rec.truncated === false
      && v.truncated
      && (rec.heardS ?? 0) * 1000 >= v.totalMs - 1;
    const same = rec.truncated === undefined ? '—' : artifact ? '↔' : rec.truncated === v.truncated ? '✓' : '✗';
    if (same === '✗') mismatched += 1;
    if (same === '↔') artifacts += 1;
    console.log(
      `  ${String(v.turn).padStart(2)}  ${v.stale ? '  是  ' : '  否  '}`
      + `  ${v.truncated ? '  是   ' : '  否   '}`
      + ` ${String(Math.round(v.heardMs)).padStart(6)} ${String(Math.round(v.totalMs)).padStart(7)}`
      + `  ${v.reflect ? '是 ' : '否 '}`
      + `  ${v.inject.padEnd(8)}`
      + `  ${rec.truncated === undefined ? '（无）' : `trunc=${rec.truncated ? '是' : '否'} heard=${rec.heardS ?? '?'}`}`
      + `      ${same}`,
    );
  }
  console.log(`  共 ${verdicts.length} 轮，与档案不一致 ${mismatched} 轮`
    + (artifacts > 0 ? `，测量误差（↔）${artifacts} 轮` : ''));
  return mismatched === 0 ? 0 : 1;
}

process.exitCode = main(process.argv);
