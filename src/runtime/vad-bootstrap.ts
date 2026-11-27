/**
 * 三端共用的 Silero 模型定位与启动加载。
 *
 * 找不到模型、或显式关掉神经 VAD 时返回 `null`，调用方继续用能量门。
 * 加载失败同样退回，不阻断进程启动。本文件不引用 CLI 入口。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SharedSpeechVad } from '../vad.ts';
import { defaultModelCacheDir, ensureOnnxModel } from './model-assets.ts';

const MODEL_FILE = 'silero_vad.onnx';

/**
 * 神经 VAD 模型路径。
 *
 * `VOICE_VAD_MODEL` 非空时原样返回（可以是相对路径，存在性由调用方再查）。
 * 否则按 `VOICE_MODELS_DIR`、cwd、仓根 `src/runtime/`、插件包内 `models/`、
 * 插件回到仓根 `models/`、`~/.voice-agent/models/` 的顺序找第一个存在的文件。
 */
export function resolveVadModelPath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = env['VOICE_VAD_MODEL']?.trim();
  if (configured) return configured;
  const candidates: string[] = [];
  const modelsDir = env['VOICE_MODELS_DIR']?.trim();
  if (modelsDir) candidates.push(join(modelsDir, MODEL_FILE));
  candidates.push(
    join(process.cwd(), 'models', MODEL_FILE),
    fileURLToPath(new URL(`../../models/${MODEL_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../../models/${MODEL_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../../models/${MODEL_FILE}`, import.meta.url)),
    join(defaultModelCacheDir(env), MODEL_FILE),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 启动时加载一份共享 Silero v5。
 *
 * `VOICE_VAD=energy|0|off|false` 直接用能量门。其余值（含缺省 `auto`）先找本地模型，
 * 未显式指定路径且本地缺失时尝试首次自动下载并校验 SHA-256；失败只打一行日志并返回 `null`。
 */
export async function loadSharedVad(
  env: Readonly<Record<string, string | undefined>>,
  report: (line: string) => void,
): Promise<SharedSpeechVad | null> {
  const mode = (env['VOICE_VAD'] ?? 'auto').trim().toLowerCase();
  if (mode === 'energy' || mode === '0' || mode === 'off' || mode === 'false') {
    report(`VAD      能量门（VOICE_VAD=${mode}，神经 VAD 已关闭）`);
    return null;
  }

  const explicit = Boolean(env['VOICE_VAD_MODEL']?.trim());
  let modelPath = resolveVadModelPath(env);
  if ((modelPath === null || !existsSync(modelPath)) && !explicit) {
    modelPath = await ensureOnnxModel('silero-vad', env, report);
  }
  if (modelPath === null || !existsSync(modelPath)) {
    report(
      `VAD      退回能量门（未找到 ${MODEL_FILE}，可放入 ${defaultModelCacheDir(env)} 或设 VOICE_VAD_MODEL）`,
    );
    return null;
  }

  const started = Date.now();
  let model: SharedSpeechVad | null = null;
  try {
    const { SileroVadModel, WINDOW } = await import('../vad.ts');
    model = await SileroVadModel.load(modelPath);
    const warmup = model.createStream();
    await warmup.process(new Float32Array(WINDOW));
    warmup.reset();
    const elapsedMs = Date.now() - started;
    report(`VAD      Silero v5 神经 VAD 已就绪（${elapsedMs} ms，${modelPath}）`);
    return model;
  } catch (err) {
    await model?.dispose?.();
    const detail = err instanceof Error ? err.message : String(err);
    report(`VAD      退回能量门（Silero v5 加载失败：${detail}）`);
    return null;
  }
}
