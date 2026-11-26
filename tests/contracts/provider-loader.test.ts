/**
 * 插件加载器（`--stt <path>` 等）的**启动期形状校验**。
 *
 * 裸 cast 的代价：插件少写一个 `open()` / `name`，进程照样起来，第一通电话
 * 才发现「连上了但永远不出字」。这里把形状检查钉在加载那一刻，错误文本必须
 * 带上插件路径和字段名，现场一眼能看出是谁写错。
 *
 * 动态模块全部写在临时目录里，零网络、零真实 provider。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  buildAgent,
  buildStt,
  buildTts,
  validateAgentProvider,
  validateSttProvider,
  validateTtsProvider,
} from '../../src/runtime/providers-factory.ts';

const dir = mkdtempSync(join(tmpdir(), 'provider-loader-'));
after(() => { rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function writeModule(source: string): string {
  seq += 1;
  const file = join(dir, `plugin-${seq}.mjs`);
  writeFileSync(file, source, 'utf8');
  return file;
}

const STT_CREDS = {
  akId: '',
  akSecret: '',
  appkey: '',
  region: 'cn-shanghai',
  maxSentenceSilenceMs: 200,
};

const DSH = {
  workDir: dir,
  useSdk: false,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  log: () => {},
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertShapeError(fn: () => unknown, parts: readonly string[]): void {
  assert.throws(fn, (error: unknown) => {
    const message = messageOf(error);
    return parts.every((part) => message.includes(part));
  });
}

async function assertRejectsShape(
  fn: () => Promise<unknown>,
  parts: readonly string[],
): Promise<void> {
  await assert.rejects(fn, (error: unknown) => {
    const message = messageOf(error);
    return parts.every((part) => message.includes(part));
  });
}

// ------------------------------------------------------------------ validators

test('validateSttProvider：合法对象原样返回，非对象 / 缺 name / 缺 open 都拒绝', () => {
  const good = {
    name: 'plug',
    open: () => ({ feed: () => {}, hangup: () => {}, close: () => {} }),
  };
  assert.equal(validateSttProvider(good, 'spec-stt'), good);

  for (const bad of [null, 1, 'x', [], undefined]) {
    assertShapeError(() => validateSttProvider(bad, 'spec-stt'), ['spec-stt', 'STT', '对象']);
  }
  assertShapeError(() => validateSttProvider({ name: '', open: () => {} }, 'spec-stt'), ['spec-stt', 'name']);
  assertShapeError(() => validateSttProvider({ name: 'x' }, 'spec-stt'), ['spec-stt', 'open']);
});

test('validateTtsProvider：sampleRate 必须正有限，可选方法存在时必须是函数', () => {
  const good = {
    name: 'plug',
    sampleRate: 24_000,
    synthesize: async function* () { /* 空实现 */ },
  };
  assert.equal(validateTtsProvider(good, 'spec-tts'), good);

  for (const sampleRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '24000', undefined]) {
    assertShapeError(
      () => validateTtsProvider({ name: 'x', sampleRate, synthesize: () => {} }, 'spec-tts'),
      ['spec-tts', 'sampleRate'],
    );
  }
  assertShapeError(() => validateTtsProvider({ name: 'x', sampleRate: 1 }, 'spec-tts'), ['synthesize']);
  for (const key of ['synthesizeStream', 'warm', 'prewarm', 'close'] as const) {
    assertShapeError(
      () => validateTtsProvider({
        name: 'x',
        sampleRate: 1,
        synthesize: () => {},
        [key]: 'bad',
      }, 'spec-tts'),
      ['spec-tts', key],
    );
  }
  // 可选方法缺失是合法的
  assert.doesNotThrow(() => validateTtsProvider({ name: 'x', sampleRate: 1, synthesize: () => {} }, 'x'));
});

test('validateAgentProvider：name + reply 缺一不可', () => {
  const good = { name: 'plug', reply: async () => ({ text: '', speech: '' }) };
  assert.equal(validateAgentProvider(good, 'spec-agent'), good);
  for (const bad of [null, 42, [], 'x']) {
    assertShapeError(() => validateAgentProvider(bad, 'spec-agent'), ['spec-agent', 'Agent', '对象']);
  }
  assertShapeError(() => validateAgentProvider({ name: 'x' }, 'spec-agent'), ['reply']);
});

// ------------------------------------------------------------------ dynamic loading

test('buildStt：合法插件加载成功；缺工厂 / 返回 null / 缺 name / 缺 open 都报清楚', async () => {
  const ok = writeModule(`
    export function stt() {
      return { name: 'plug-stt', open() { return { feed() {}, hangup() {}, close() {} }; } };
    }
  `);
  const provider = await buildStt(ok, STT_CREDS);
  assert.equal(provider.name, 'plug-stt');

  const noFactory = writeModule('export const other = 1;');
  await assertRejectsShape(() => buildStt(noFactory, STT_CREDS), [noFactory, 'stt']);

  const nullFactory = writeModule('export function stt() { return null; }');
  await assertRejectsShape(() => buildStt(nullFactory, STT_CREDS), [nullFactory, '对象']);

  const noName = writeModule('export function stt() { return { open() {} }; }');
  await assertRejectsShape(() => buildStt(noName, STT_CREDS), [noName, 'name']);

  const noOpen = writeModule("export function stt() { return { name: 'x' }; }");
  await assertRejectsShape(() => buildStt(noOpen, STT_CREDS), [noOpen, 'open']);
});

test('buildTts：合法插件加载成功；缺字段 / 非法 sampleRate / 非法可选方法都报清楚', async () => {
  const ok = writeModule(`
    export function tts() {
      return {
        name: 'plug-tts',
        sampleRate: 24000,
        synthesize: async function* () {},
        close() {},
      };
    }
  `);
  const provider = await buildTts(ok);
  assert.equal(provider.name, 'plug-tts');
  assert.equal(provider.sampleRate, 24_000);

  const noFactory = writeModule('export const other = 1;');
  await assertRejectsShape(() => buildTts(noFactory), [noFactory, 'tts']);

  const raw = writeModule("export function tts() { return 'not-a-provider'; }");
  await assertRejectsShape(() => buildTts(raw), [raw, '对象']);

  const noName = writeModule('export function tts() { return { sampleRate: 1, synthesize() {} }; }');
  await assertRejectsShape(() => buildTts(noName), [noName, 'name']);

  const noSynth = writeModule("export function tts() { return { name: 'x', sampleRate: 1 }; }");
  await assertRejectsShape(() => buildTts(noSynth), [noSynth, 'synthesize']);

  for (const value of ['0', '-1', 'NaN']) {
    const file = writeModule(`
      export function tts() {
        return { name: 'x', sampleRate: ${value}, synthesize: async function* () {} };
      }
    `);
    await assertRejectsShape(() => buildTts(file), [file, 'sampleRate']);
  }

  const badOptional = writeModule(`
    export function tts() {
      return {
        name: 'x',
        sampleRate: 24000,
        synthesize: async function* () {},
        synthesizeStream: 'bad',
      };
    }
  `);
  await assertRejectsShape(() => buildTts(badOptional), [badOptional, 'synthesizeStream', '函数']);
});

test('buildAgent：合法插件加载成功；缺工厂 / 缺 reply / 返回原始值都报清楚', async () => {
  const ok = writeModule(`
    export function agent() {
      return { name: 'plug-agent', reply: async () => ({ text: '', speech: '' }) };
    }
  `);
  const bundle = await buildAgent(ok, DSH, null);
  assert.equal(bundle.agent?.name, 'plug-agent');
  assert.equal(bundle.dsh, null);

  const noFactory = writeModule('export const other = 1;');
  await assertRejectsShape(() => buildAgent(noFactory, DSH, null), [noFactory, 'agent']);

  const noReply = writeModule("export function agent() { return { name: 'x' }; }");
  await assertRejectsShape(() => buildAgent(noReply, DSH, null), [noReply, 'reply']);

  const raw = writeModule("export function agent() { return 123; }");
  await assertRejectsShape(() => buildAgent(raw, DSH, null), [raw, '对象']);
});
