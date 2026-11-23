/**
 * `src/main.ts` 装配层的回归：纯函数判据 + 两条「源码里不许再出现」的形态约束。
 *
 * 这一层出错的样子全是**静默**的：
 * - 少造一个 `FrontedAgent`，omni 车道整晚不接管（日志里只有「快车道 关」）；
 * - 审计槽位被旧连接摘掉，档案里从此没有任何 `agent.*` / `tts.*`；
 * - 顶层 `import` 回 `legacy-pipeline.ts`，每次启动多付 VAD/ONNX 的加载钱。
 *
 * 所以这里不测行为链（那些在别的文件里），只钉住「装配判据」和「依赖形态」。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  createAuditSlot,
  shouldCreateFrontedAgent,
  type AuditSink,
} from '../src/main.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN_TS = fileURLToPath(new URL('../src/main.ts', import.meta.url));

// ---------------------------------------------------------------- 审计槽位

test('审计槽位：旧连接收尾不能摘掉新连接的出口', () => {
  const slot = createAuditSlot();
  const seenA: string[] = [];
  const seenB: string[] = [];
  const sinkA: AuditSink = (name) => { seenA.push(name); };
  const sinkB: AuditSink = (name) => { seenB.push(name); };

  // 连接 A 建连
  const uninstallA = slot.register(sinkA);
  assert.equal(slot.peek(), sinkA);
  slot.emit('agent.request', {});
  assert.deepEqual(seenA, ['agent.request']);

  // 连接 B 后来居上（设备重连 / 两台设备）
  const uninstallB = slot.register(sinkB);
  assert.equal(slot.peek(), sinkB);
  slot.emit('tts.task', {});
  assert.deepEqual(seenA, ['agent.request'], 'B 挂上之后 A 不该再收到事件');
  assert.deepEqual(seenB, ['tts.task']);

  // A 的 close 晚到：它只能摘自己那一份，B 的出口必须完好
  uninstallA();
  assert.equal(slot.peek(), sinkB, '旧连接把新连接的档案出口摘掉了 —— 之后所有事件静默丢失');
  slot.emit('agent.done', {});
  assert.deepEqual(seenB, ['tts.task', 'agent.done']);

  uninstallB();
  assert.equal(slot.peek(), null);
  // 没人接时 emit 不能炸
  slot.emit('agent.done', {});
});

test('审计槽位：1 参 set 保持老语义（覆盖 / 清空），expected 不匹配时不动', () => {
  const slot = createAuditSlot();
  const sinkA: AuditSink = () => {};
  const sinkB: AuditSink = () => {};

  slot.set(sinkA);
  assert.equal(slot.peek(), sinkA);
  slot.set(sinkB);
  assert.equal(slot.peek(), sinkB);
  slot.set(null);
  assert.equal(slot.peek(), null);

  // 拿着别人的令牌摘不动
  slot.set(sinkA);
  slot.set(null, sinkB);
  assert.equal(slot.peek(), sinkA, 'expected 不是当前持有者，不该清空');
  slot.set(null, sinkA);
  assert.equal(slot.peek(), null);
});

test('审计槽位：接收方抛错不把调用方带下水', () => {
  const slot = createAuditSlot();
  slot.set(() => { throw new Error('档案刚好在关'); });
  assert.doesNotThrow(() => { slot.emit('tts.done', {}); });
});

// ---------------------------------------------------------------- 装配判据

test('shouldCreateFrontedAgent：没有 qwen-flash key 也要为 omni 造装饰器', () => {
  // 没有 key、omni 会启用 —— 必须造，但级联文本模型关（否则会拿空 key 去发请求）
  const noKey = shouldCreateFrontedAgent({ fastOff: false, fastKey: '', omniEnabled: true });
  assert.equal(noKey.create, true, 'omni 会启用时必须造 FrontedAgent（车道挂点只在这上面）');
  assert.equal(noKey.cascadeKey, '', '没有 key 时 apiKey 必须是空串：routeTurn 才会跳过 cascade');
  assert.equal(noKey.why, 'omni-only');

  // FAST_LANE=0 + omni：同一个结论
  const switchedOff = shouldCreateFrontedAgent({ fastOff: true, fastKey: 'sk-test', omniEnabled: true });
  assert.equal(switchedOff.create, true);
  assert.equal(switchedOff.cascadeKey, '', 'FAST_LANE=0 只关文本快车道，不该把 key 带进去');
  assert.equal(switchedOff.why, 'omni-only');

  // 有 key：级联照旧，key 原样透传
  const cascade = shouldCreateFrontedAgent({ fastOff: false, fastKey: 'sk-test', omniEnabled: false });
  assert.equal(cascade.create, true);
  assert.equal(cascade.cascadeKey, 'sk-test');
  assert.equal(cascade.why, 'cascade');

  // 两条车道都不通：不造（保持旧行为，纯 VoiceAgent）
  assert.equal(
    shouldCreateFrontedAgent({ fastOff: false, fastKey: '', omniEnabled: false }).create,
    false,
  );
  assert.equal(
    shouldCreateFrontedAgent({ fastOff: true, fastKey: 'sk-test', omniEnabled: false }).create,
    false,
  );
  assert.equal(
    shouldCreateFrontedAgent({ fastOff: true, fastKey: '', omniEnabled: false }).why,
    'off',
  );
  assert.equal(
    shouldCreateFrontedAgent({ fastOff: false, fastKey: '', omniEnabled: false }).why,
    'no-key',
  );
});

// ---------------------------------------------------------------- 依赖形态

test('main.ts 只在末尾按需加载 legacy-pipeline（顶层不许值导入）', () => {
  const source = readFileSync(MAIN_TS, 'utf8');

  // 值导入（含 `import { type X }` 这种混合写法）会把 silero-vad / onnxruntime-node
  // 一起拉进每次启动；只允许 `import type`。
  const valueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]\.\/legacy-pipeline\.ts['"]/mu;
  assert.equal(
    valueImport.test(source),
    false,
    'src/main.ts 顶层又值导入了 legacy-pipeline.ts —— 生产 --stt 启动会白白加载 VAD/ONNX',
  );

  const typeImport = /^\s*import\s+type\b[^\n]*from\s+['"]\.\/legacy-pipeline\.ts['"]/mu;
  assert.equal(typeImport.test(source), true, '类型仍然需要（runReplay / runListen 的签名）');

  assert.match(
    source,
    /await import\(\s*['"]\.\/legacy-pipeline\.ts['"]\s*\)/u,
    '末尾的 --replay / 旧监听分支必须自己 await import 出来',
  );
});

test('情绪模式默认值只有一处（cosyvoice.ts 的常量）', () => {
  const source = readFileSync(MAIN_TS, 'utf8');
  assert.match(
    source,
    /DEFAULT_COSYVOICE_EMOTION_MODE/u,
    'main.ts 又自己写死了默认情绪模式 —— 两处默认值迟早漂移',
  );
  // 老写法：直接与字面量比较，等于把默认值复制了一份
  const drifted = /process\.env\['COSYVOICE_EMOTION_MODE'\]\s*===\s*'instruction'/u;
  assert.equal(drifted.test(source), false, '必须 `?? DEFAULT_COSYVOICE_EMOTION_MODE` 之后再比');
});

// ---------------------------------------------------------------- 入口自检

test('`node src/main.ts` 无参仍是「打印用法 + 退出码 2」（isMainModule 守卫没把入口关掉）', () => {
  const status = spawnSync(process.execPath, [MAIN_TS], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(status.error, undefined, `子进程起不来：${status.error?.message ?? ''}`);
  assert.equal(status.status, 2, `无参运行的退出码应当是 2，实际 ${String(status.status)}`);
  assert.match(status.stderr, /用法/u, '应当打印用法（docs/CLOUD-ARCHITECTURE.md §8 的启动自检）');
});
