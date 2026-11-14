/**
 * 随机探索能发现坏掉的闸门，并把复现收缩到最短。
 *
 * ADR-0002 §3.6 与 §4 的验收：故意改坏一条闸门，固定种子下必须找出违反，
 * 且收缩到 5 步以内。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GATES, PHASES } from '../src/pet/brain/registry.ts';
import { MIN } from '../src/pet/sim/host.ts';
import { explore, formatRepro } from '../src/pet/sim/explore.ts';
import { SCENARIOS, runScenario } from '../src/pet/sim/scenarios.ts';

test('去掉 worn 闸门 → 探索能找出来并收缩到 ≤5 步', async () => {
  const original = GATES.worn;
  // 故意改坏：读不到佩戴也当成戴着
  GATES.worn = () => true;
  try {
    const failures = await explore({ seed: 7, runs: 60, horizonMs: 4 * 60 * MIN });
    assert.ok(failures.length > 0, '应当找出违反');
    const first = failures[0];
    assert.ok(first !== undefined);
    assert.ok(
      first.violations.some((violation) => violation.rule === '⑤'),
      `应当违反 ⑤（没戴就开口），实际：${JSON.stringify(first.violations)}`,
    );
    assert.ok(
      first.minimal.length <= 5,
      `收缩后仍有 ${first.minimal.length} 步：\n${formatRepro(first)}`,
    );
  } finally {
    GATES.worn = original;
  }
});

test('麦比超时还慢时，开口仍按超时触发', async () => {
  const result = await runScenario({
    name: '麦晚开',
    device: 'xiaomi-full',
    params: { micOpenTimeoutMs: 1_500 },
    // 麦 5 s 才开，远晚于 1.5 s 超时
    world: { agent: [{ reply: { text: '哥，那辆车好吵。' } }], micOpenLatencyMs: 5_000 },
    script: [{ at: '+0', do: 'wear', wearing: true }],
    horizon: '+23m',
  });

  const listen = result.world.timeline.find((event) => event.src === 'call' && event.kind === 'listen.start');
  const speak = result.world.timeline.find((event) => event.src === 'voice' && event.kind === 'start');
  assert.ok(listen !== undefined && speak !== undefined);
  const waited = speak.t - listen.t;
  assert.ok(waited >= 1_500, `只等了 ${waited} ms，应当等到 1.5 s 超时`);
  assert.ok(waited < 5_000, `等了 ${waited} ms，不该等麦真的开（5 s）`);
});

test('去掉 await 的 closeMic → 「开麦成功」场景必须失败', async () => {
  const scenario = SCENARIOS.find((item) => item.name === '开麦成功：结局记 micOpened=true，且下发过 listen.stop');
  assert.ok(scenario !== undefined, '缺这条场景');
  const spec = PHASES.await;
  const original = spec.onResult;
  // 故意丢掉 closeMic：麦就不再被关上
  (spec as { onResult: typeof original }).onResult = {
    expired: { kind: 'end', outcome: 'ignored' },
    timeout: { kind: 'end', outcome: 'ignored' },
  };
  try {
    await assert.rejects(
      () => runScenario(scenario),
      /listen\.stop/,
      '不关麦时，场景里"下发过 listen.stop"的断言应当失败',
    );
  } finally {
    (spec as { onResult: typeof original }).onResult = original;
  }
});

test('去掉 minGap 闸门 → 「播报把搭话推后」场景必须失败', async () => {
  const scenario = SCENARIOS.find((item) => item.name === 'minGap：播报把搭话推后到 29 分钟');
  assert.ok(scenario !== undefined, '缺这条场景');
  const original = GATES.minGap;
  GATES.minGap = () => true;
  try {
    await assert.rejects(
      () => runScenario(scenario),
      /29 分钟|minGap/,
      '去掉 minGap 之后这条场景应当失败',
    );
  } finally {
    GATES.minGap = original;
  }
});

test('闸门完好时，固定种子的探索不报违反', async () => {
  const failures = await explore({ seed: 11, runs: 200, horizonMs: 4 * 60 * MIN });
  assert.deepEqual(
    failures.map((failure) => ({ rule: failure.violations[0]?.rule, detail: failure.violations[0]?.detail })),
    [],
    '闸门没改坏就不该有违反',
  );
});
