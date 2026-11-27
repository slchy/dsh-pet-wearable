/**
 * 可选 ONNX 模型清单、自动下载与 SHA-256 校验单元测试（完全离线，不触网）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_ONNX_MODELS } from '../scripts/fetch-onnx-models.mjs';
import {
  defaultModelCacheDir,
  ensureModelBySpec,
  ensureOnnxModel,
  ONNX_MODELS,
  resolveDownloadUrls,
  sha256Buffer,
  shouldAutoDownloadModels,
  verifyFileSha256,
} from '../src/runtime/model-assets.ts';
import { resolveTurnJudgeModelPath } from '../src/runtime/turn-judge-bootstrap.ts';
import { resolveVadModelPath } from '../src/runtime/vad-bootstrap.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-assets-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('ONNX_MODELS 与 fetch-onnx-models.mjs 及 model-parity.yml 的 SHA-256 逐字节一致', () => {
  const parityYml = readFileSync(join(repoRoot, '.github', 'workflows', 'model-parity.yml'), 'utf8');
  for (const model of RELEASE_ONNX_MODELS) {
    const spec = ONNX_MODELS[model.id];
    assert.equal(spec.filename, model.filename);
    assert.equal(spec.sha256, model.sha256);
    assert.ok(
      parityYml.includes(`${spec.sha256}  models/${spec.filename}`),
      `model-parity.yml 缺少 ${spec.filename} 的 SHA-256`,
    );
  }
});

test('shouldAutoDownloadModels 遵循显式开关并在测试/CI 环境默认关闭', () => {
  assert.equal(shouldAutoDownloadModels({ VOICE_AUTO_DOWNLOAD_MODELS: '0' }), false);
  assert.equal(shouldAutoDownloadModels({ VOICE_AUTO_DOWNLOAD_MODELS: 'off' }), false);
  assert.equal(shouldAutoDownloadModels({ VOICE_AUTO_DOWNLOAD_MODELS: 'false' }), false);
  assert.equal(shouldAutoDownloadModels({ VOICE_AUTO_DOWNLOAD_MODELS: '1' }), true);
  assert.equal(shouldAutoDownloadModels({ VOICE_AUTO_DOWNLOAD_MODELS: 'true' }), true);
  assert.equal(shouldAutoDownloadModels({ CI: 'true' }), false);
  assert.equal(shouldAutoDownloadModels({}), false);
});

test('defaultModelCacheDir 与 resolveDownloadUrls 支持自定义目录与合法镜像前缀', () => {
  assert.equal(
    defaultModelCacheDir({}, '/fake/home'),
    join('/fake/home', '.voice-agent', 'models'),
  );
  assert.equal(
    defaultModelCacheDir({ VOICE_MODELS_DIR: '  /custom/models  ' }, '/fake/home'),
    '/custom/models',
  );

  const spec = ONNX_MODELS['silero-vad'];
  const custom = resolveDownloadUrls(spec, { VOICE_MODEL_BASE_URL: 'https://mirror.example.com/onnx/' });
  assert.equal(custom[0], 'https://mirror.example.com/onnx/silero_vad.onnx');
  assert.ok(custom.includes(spec.urls[0]!));

  // 非法明文 HTTP（非回环）会被忽略，防止被降级劫持
  const insecure = resolveDownloadUrls(spec, { VOICE_MODEL_BASE_URL: 'http://evil.example.com/onnx' });
  assert.equal(insecure[0], spec.urls[0]);

  // 回环 HTTP 放行以便本地测试
  const local = resolveDownloadUrls(spec, { VOICE_MODEL_BASE_URL: 'http://127.0.0.1:9000/onnx' });
  assert.equal(local[0], 'http://127.0.0.1:9000/onnx/silero_vad.onnx');
});

test('resolveVadModelPath 与 resolveTurnJudgeModelPath 优先查显式变量和 VOICE_MODELS_DIR', async () => {
  await withTempDir((dir) => {
    const vadFile = join(dir, 'silero_vad.onnx');
    const tjFile = join(dir, 'smart-turn-v3.2-cpu.onnx');
    writeFileSync(vadFile, Buffer.from('stub-vad'));
    writeFileSync(tjFile, Buffer.from('stub-tj'));

    assert.equal(resolveVadModelPath({ VOICE_MODELS_DIR: dir }), vadFile);
    assert.equal(resolveTurnJudgeModelPath({ VOICE_MODELS_DIR: dir }), tjFile);
    assert.equal(
      resolveVadModelPath({ VOICE_VAD_MODEL: '/explicit/vad.onnx', VOICE_MODELS_DIR: dir }),
      '/explicit/vad.onnx',
    );
    assert.equal(
      resolveTurnJudgeModelPath({ TURN_JUDGE_MODEL: '/explicit/tj.onnx', VOICE_MODELS_DIR: dir }),
      '/explicit/tj.onnx',
    );
  });
});

test('ensureOnnxModel 命中校验通过的本地缓存时不发任何网络请求', async () => {
  await withTempDir(async (dir) => {
    const spec = ONNX_MODELS['silero-vad'];
    const target = join(dir, spec.filename);
    // verifyFileSha256 独立验证正常字节与错误字节
    const sample = new Uint8Array([1, 2, 3, 4]);
    writeFileSync(target, sample);
    assert.equal(verifyFileSha256(target, sha256Buffer(sample)), true);
    assert.equal(verifyFileSha256(target, '0'.repeat(64)), false);

    // 校验不通过且禁用自动下载 → 返回 null 且不触发 fetch
    let calls = 0;
    const logs: string[] = [];
    const result = await ensureOnnxModel(
      'silero-vad',
      { VOICE_MODELS_DIR: dir, VOICE_AUTO_DOWNLOAD_MODELS: '0' },
      (line) => logs.push(line),
      {
        fetchFn: (async () => {
          calls += 1;
          throw new Error('不应调用 fetch');
        }) as typeof fetch,
      },
    );
    assert.equal(result, null);
    assert.equal(calls, 0);
    assert.ok(logs.some((l) => l.includes('校验未通过')));
  });
});

test('ensureOnnxModel 拒绝 SHA-256 篡改并清掉临时文件，全部镜像失败返回 null', async () => {
  await withTempDir(async (dir) => {
    const requested: string[] = [];
    const logs: string[] = [];
    const res = await ensureOnnxModel(
      'silero-vad',
      { VOICE_MODELS_DIR: dir, VOICE_AUTO_DOWNLOAD_MODELS: '1' },
      (line) => logs.push(line),
      {
        fetchFn: (async (url: string | URL | Request) => {
          requested.push(String(url));
          return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
        }) as typeof fetch,
      },
    );
    assert.equal(res, null);
    assert.equal(requested.length, ONNX_MODELS['silero-vad'].urls.length);
    assert.equal(existsSync(join(dir, 'silero_vad.onnx')), false);
    assert.deepEqual(readdirSync(dir), [], '失败后不许残留 .part 临时文件');
    assert.ok(logs.some((l) => l.includes('SHA-256 不匹配')));
  });
});

test('ensureOnnxModel 首镜像 503 后自动切备用镜像（校验通过后原子落盘）', async () => {
  await withTempDir(async (dir) => {
    // 借用本机已有真模型或模拟 503 + 错误哈希链：先验镜像回落顺序
    const requested: string[] = [];
    const logs: string[] = [];
    const result = await ensureOnnxModel(
      'smart-turn',
      {
        VOICE_MODELS_DIR: dir,
        VOICE_AUTO_DOWNLOAD_MODELS: '1',
        VOICE_MODEL_BASE_URL: 'https://primary.example.test/models',
      },
      (line) => logs.push(line),
      {
        fetchFn: (async (url: string | URL | Request) => {
          requested.push(String(url));
          if (requested.length === 1) {
            return new Response('unavailable', { status: 503 });
          }
          return new Response('bad-payload', { status: 200 });
        }) as typeof fetch,
      },
    );
    assert.equal(result, null);
    assert.equal(requested[0], 'https://primary.example.test/models/smart-turn-v3.2-cpu.onnx');
    assert.equal(requested[1], ONNX_MODELS['smart-turn'].urls[0]);
    assert.equal(requested[2], ONNX_MODELS['smart-turn'].urls[1]);
    assert.ok(logs.some((l) => l.includes('HTTP 503')));
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('ensureModelBySpec 首镜像失败切备用镜像，SHA-256 通过后原子落盘且二次调用走零网络缓存', async () => {
  await withTempDir(async (dir) => {
    const payload = new Uint8Array([0x08, 0x09, 0x12, 0x34, 0x56, 0x78]);
    const spec = {
      id: 'silero-vad' as const,
      filename: 'silero_vad.onnx',
      sha256: sha256Buffer(payload),
      urls: [
        'https://mirror1.example.test/silero_vad.onnx',
        'https://mirror2.example.test/silero_vad.onnx',
      ],
      maxBytes: 1024,
    };

    let fetchCount = 0;
    const logs: string[] = [];
    const saved = await ensureModelBySpec(
      spec,
      { VOICE_MODELS_DIR: dir, VOICE_AUTO_DOWNLOAD_MODELS: '1' },
      (line) => logs.push(line),
      {
        fetchFn: (async (url: string | URL | Request) => {
          fetchCount += 1;
          if (String(url).includes('mirror1')) {
            return new Response('boom', { status: 502 });
          }
          return new Response(payload, { status: 200 });
        }) as typeof fetch,
      },
    );

    const expectedPath = join(dir, 'silero_vad.onnx');
    assert.equal(saved, expectedPath);
    assert.equal(fetchCount, 2);
    assert.deepEqual(new Uint8Array(readFileSync(expectedPath)), payload);
    assert.deepEqual(readdirSync(dir), ['silero_vad.onnx']);
    assert.ok(logs.some((l) => l.includes('SHA-256 校验通过')));

    // 第二次调用直接命中本地校验缓存，不再发任何网络请求
    const cached = await ensureModelBySpec(
      spec,
      { VOICE_MODELS_DIR: dir, VOICE_AUTO_DOWNLOAD_MODELS: '1' },
      () => {},
      {
        fetchFn: (async () => {
          fetchCount += 1;
          throw new Error('命中缓存不应再次请求网络');
        }) as typeof fetch,
      },
    );
    assert.equal(cached, expectedPath);
    assert.equal(fetchCount, 2);
  });
});
