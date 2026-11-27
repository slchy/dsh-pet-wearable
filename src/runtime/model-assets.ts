/**
 * 可选 ONNX 模型清单与首次启动自动下载（强制 SHA-256 校验）。
 *
 * 两个模型均为二进制权重，不进 git、不打进 npm 包，避免 npm tarball 膨胀 11 MB。
 * 查找顺序优先使用本地文件（显式环境变量 / `VOICE_MODELS_DIR` / `models/` /
 * `~/.voice-agent/models/`）；若全部缺失且允许自动下载，则按镜像顺序拉取到
 * `~/.voice-agent/models/`，先写临时文件并校验 SHA-256，校验通过才原子重命名。
 * 任何网络或校验失败都只打一行日志并返回 `null`，绝不阻断主进程启动。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OnnxModelId = 'silero-vad' | 'smart-turn';

export interface OnnxModelSpec {
  readonly id: OnnxModelId;
  readonly filename: string;
  readonly sha256: string;
  readonly urls: readonly string[];
  readonly maxBytes: number;
}

const RELEASE_DOWNLOAD_BASE =
  'https://github.com/slchy/dsh-pet-wearable/releases/latest/download';

/**
 * 与 `.github/workflows/model-parity.yml`、`models/README.md` 逐字节对齐的单一真相源。
 * 变更模型版本时只改这里并同步更新 CI 校验。
 */
export const ONNX_MODELS: Readonly<Record<OnnxModelId, OnnxModelSpec>> = {
  'silero-vad': {
    id: 'silero-vad',
    filename: 'silero_vad.onnx',
    sha256: 'f6f4407b41e05e277e7f5cfd9b9ae957b1dfe763c6076a934734c0b448e09b31',
    urls: [
      `${RELEASE_DOWNLOAD_BASE}/silero_vad.onnx`,
      'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx',
    ],
    maxBytes: 16 * 1024 * 1024,
  },
  'smart-turn': {
    id: 'smart-turn',
    filename: 'smart-turn-v3.2-cpu.onnx',
    sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
    urls: [
      `${RELEASE_DOWNLOAD_BASE}/smart-turn-v3.2-cpu.onnx`,
      'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx',
    ],
    maxBytes: 32 * 1024 * 1024,
  },
};

const DEFAULT_TIMEOUT_MS = 25_000;

/** npm 安装态与本地运行的持久化模型缓存目录（与 `~/.voice-agent/archives` 同级）。 */
export function defaultModelCacheDir(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string = homedir(),
): string {
  const configured = env['VOICE_MODELS_DIR']?.trim();
  if (configured) return configured;
  return join(homeDir, '.voice-agent', 'models');
}

/**
 * 是否允许首次启动自动下载模型。
 *
 * - 显式 `VOICE_AUTO_DOWNLOAD_MODELS=0|off|false|no` 始终关闭；
 * - 显式 `1|on|true|yes` 始终开启；
 * - 默认：单测（`NODE_TEST_CONTEXT`）与 CI 下关闭，避免离线单测触网；真实运行态开启。
 */
export function shouldAutoDownloadModels(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env['VOICE_AUTO_DOWNLOAD_MODELS']?.trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return true;
  if (
    env['NODE_TEST_CONTEXT']
    || env['CI']
    || process.env['NODE_TEST_CONTEXT']
    || process.env['CI']
  ) {
    return false;
  }
  return true;
}

function isAllowedDownloadUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === 'https:') return true;
    if (
      parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 构造本次下载尝试的有序 URL 列表（`VOICE_MODEL_BASE_URL` 优先，非法协议忽略）。 */
export function resolveDownloadUrls(
  spec: OnnxModelSpec,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const customBase = env['VOICE_MODEL_BASE_URL']?.trim().replace(/\/+$/u, '');
  const list: string[] = [];
  if (customBase) {
    const candidate = `${customBase}/${spec.filename}`;
    if (isAllowedDownloadUrl(candidate)) {
      list.push(candidate);
    }
  }
  for (const url of spec.urls) {
    if (!list.includes(url)) list.push(url);
  }
  return list;
}

export function sha256Buffer(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function verifyFileSha256(filePath: string, expectedSha256: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const actual = sha256Buffer(readFileSync(filePath));
    return actual === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

export interface EnsureModelOptions {
  readonly homeDir?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

async function fetchBoundedBytes(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchFn(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentLen = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLen) && contentLen > maxBytes) {
      throw new Error(`响应超过上限（${contentLen} > ${maxBytes}）`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new Error('空响应');
    }
    if (buf.byteLength > maxBytes) {
      throw new Error(`文件超过上限（${buf.byteLength} > ${maxBytes}）`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按给定规格拉取单个模型到缓存目录并做 SHA-256 校验 + 原子落盘（返回最终路径或 null）。
 */
export async function ensureModelBySpec(
  spec: OnnxModelSpec,
  env: Readonly<Record<string, string | undefined>>,
  report: (line: string) => void,
  options: EnsureModelOptions = {},
): Promise<string | null> {
  const cacheDir = defaultModelCacheDir(env, options.homeDir);
  const targetPath = join(cacheDir, spec.filename);

  if (existsSync(targetPath)) {
    try {
      const size = statSync(targetPath).size;
      if (size > 0 && size <= spec.maxBytes && verifyFileSha256(targetPath, spec.sha256)) {
        return targetPath;
      }
      report(`模型      缓存 ${targetPath} 校验未通过，重新获取`);
    } catch {
      // 读取失败则尝试重新下载
    }
  }

  if (!shouldAutoDownloadModels(env)) {
    return null;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const urls = resolveDownloadUrls(spec, env);

  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report(`模型      无法创建缓存目录 ${cacheDir}（${msg}），跳过自动下载`);
    return null;
  }

  report(`模型      首次启动自动下载 ${spec.filename} → ${cacheDir}`);
  const errors: string[] = [];

  for (const url of urls) {
    const tmpPath = join(
      cacheDir,
      `${spec.filename}.part.${process.pid}.${randomBytes(4).toString('hex')}`,
    );
    try {
      const bytes = await fetchBoundedBytes(url, spec.maxBytes, timeoutMs, fetchFn);
      const actual = sha256Buffer(bytes);
      if (actual !== spec.sha256) {
        throw new Error(`SHA-256 不匹配（got ${actual.slice(0, 12)}…）`);
      }
      writeFileSync(tmpPath, bytes);
      renameSync(tmpPath, targetPath);
      report(`模型      已就位 ${targetPath}（SHA-256 校验通过）`);
      return targetPath;
    } catch (err) {
      rmSync(tmpPath, { force: true });
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${new URL(url).host}: ${msg}`);
    }
  }

  report(
    `模型      自动下载 ${spec.filename} 失败（${errors.join('；')}），`
    + `可从 GitHub Releases 手动放入 ${cacheDir}`,
  );
  return null;
}

/**
 * 保证指定模型就位并通过 SHA-256 校验，否则返回 `null`（绝不抛错阻断启动）。
 */
export async function ensureOnnxModel(
  id: OnnxModelId,
  env: Readonly<Record<string, string | undefined>>,
  report: (line: string) => void,
  options: EnsureModelOptions = {},
): Promise<string | null> {
  return ensureModelBySpec(ONNX_MODELS[id], env, report, options);
}
