#!/usr/bin/env node
/**
 * 拉取两个可选 ONNX 模型并强制校验 SHA-256（供 GitHub Release 附件与本地预拉取复用）。
 *
 * 用法：
 *   node scripts/fetch-onnx-models.mjs --out-dir dist-models
 *   node scripts/fetch-onnx-models.mjs --out-dir models --upstream-only
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ONNX_MODELS = [
  {
    id: 'silero-vad',
    filename: 'silero_vad.onnx',
    sha256: 'f6f4407b41e05e277e7f5cfd9b9ae957b1dfe763c6076a934734c0b448e09b31',
    upstreamUrls: [
      'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx',
      'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx',
    ],
  },
  {
    id: 'smart-turn',
    filename: 'smart-turn-v3.2-cpu.onnx',
    sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
    upstreamUrls: [
      'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx',
    ],
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const outIdx = argv.indexOf('--out-dir');
  return {
    outDir: outIdx === -1 ? 'models' : argv[outIdx + 1],
  };
}

async function fetchOne(model, outDir) {
  const target = join(outDir, model.filename);
  if (existsSync(target) && sha256(readFileSync(target)) === model.sha256) {
    process.stdout.write(`已有且 SHA-256 一致：${target}\n`);
    return target;
  }

  const errors = [];
  for (const url of model.upstreamUrls) {
    const tmp = join(outDir, `${model.filename}.part.${process.pid}.${randomBytes(4).toString('hex')}`);
    try {
      process.stdout.write(`下载 ${model.filename} ← ${url}\n`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== model.sha256) {
        throw new Error(`SHA-256 不匹配：got ${actual}`);
      }
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
      process.stdout.write(`校验通过：${target}（${bytes.byteLength} B）\n`);
      return target;
    } catch (err) {
      rmSync(tmp, { force: true });
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`下载 ${model.filename} 失败：\n  ${errors.join('\n  ')}`);
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const absDir = resolve(outDir);
  mkdirSync(absDir, { recursive: true });
  for (const model of RELEASE_ONNX_MODELS) {
    await fetchOne(model, absDir);
  }
}

const entry = process.argv[1];
if (entry && resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((err) => {
    process.stderr.write(`fetch-onnx-models: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
