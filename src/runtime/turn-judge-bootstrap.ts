/**
 * 三端共用的声学判停（Smart Turn v3.2）模型定位与启动加载。
 *
 * 与 `vad-bootstrap.ts` 对称：找不到模型、显式关掉、加载或预热失败都返回 `null`，
 * 调用方退回固定合并窗口，**绝不阻断进程启动**。本文件不引用 CLI 入口。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TurnJudge } from '../turn-judge.ts';
import { WHISPER_SAMPLE_RATE } from '../whisper-features.ts';

const MODEL_FILE = 'smart-turn-v3.2-cpu.onnx';

/**
 * 声学判停模型路径。
 *
 * `TURN_JUDGE_MODEL`（兼容旧名 `SMART_TURN_MODEL`）非空时原样返回（可以是相对路径，
 * 存在性由调用方再查）。否则按 cwd、仓根 `src/runtime/`、插件包内 `models/`、
 * 插件回到仓根 `models/` 的顺序找第一个存在的文件。
 */
export function resolveTurnJudgeModelPath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = env['TURN_JUDGE_MODEL']?.trim() || env['SMART_TURN_MODEL']?.trim();
  if (configured) return configured;
  const candidates = [
    join(process.cwd(), 'models', MODEL_FILE),
    fileURLToPath(new URL(`../../models/${MODEL_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../../models/${MODEL_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../../models/${MODEL_FILE}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 启动时加载一份共享 TurnJudge，并预热一次推理。
 *
 * `TURN_JUDGE=0|off|false`（兼容 `SMART_TURN`）直接退回固定合并窗口；其余值
 * （含缺省 `auto`）尝试加载模型。失败只打一行日志并返回 `null`。
 */
export async function loadSharedTurnJudge(
  env: Readonly<Record<string, string | undefined>>,
  report: (line: string) => void,
): Promise<TurnJudge | null> {
  const mode = (env['TURN_JUDGE'] ?? env['SMART_TURN'] ?? 'auto').trim().toLowerCase();
  if (mode === '0' || mode === 'off' || mode === 'false') {
    report(`声学判停  已关闭（TURN_JUDGE=${mode}），退回固定合并窗口`);
    return null;
  }

  const modelPath = resolveTurnJudgeModelPath(env);
  if (modelPath === null || !existsSync(modelPath)) {
    report(
      '声学判停  退回固定合并窗口（未找到 models/smart-turn-v3.2-cpu.onnx，'
      + '可设 TURN_JUDGE_MODEL 指定）',
    );
    return null;
  }

  const judge = new TurnJudge({ modelPath, log: report });
  const startedAt = Date.now();
  try {
    // 低幅正弦而不是全零：全零在 log-mel 里是 −∞ dB，不该拿它当「正常输入」试模型
    const warmup = Buffer.alloc(WHISPER_SAMPLE_RATE * 2);
    for (let i = 0; i < WHISPER_SAMPLE_RATE; i += 1) {
      warmup.writeInt16LE(Math.round(Math.sin(i / 7) * 300), i * 2);
    }
    const p = await judge.predict(warmup);
    if (p >= 0) {
      const elapsedMs = Date.now() - startedAt;
      report(
        `声学判停  Smart Turn v3.2 进程内 ONNX 已就绪（${elapsedMs} ms，`
        + `p=${p.toFixed(3)}，${modelPath}）`,
      );
      return judge;
    }
  } catch {
    // 预热抛错也走下面的统一退回
  }
  judge.stop();
  report('声学判停  退回固定合并窗口（模型加载或预热失败）');
  return null;
}
