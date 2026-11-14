/**
 * 场景与模拟器的测试。
 *
 * 每个声明式场景都跑一遍：`runScenario` 内部已经做完「执行 → 收尾 → 查不变量 →
 * 查期望」，这里只负责把它挂进 `node --test`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_PET_PARAMS } from '../src/pet/brain/registry.ts';
import { summarizePetEvent } from '../src/pet/brain/session.ts';
import { SCENARIOS, parseAt, runAllScenarios, runScenario } from '../src/pet/sim/scenarios.ts';
import { checkInvariants } from '../src/pet/sim/timeline.ts';
import { SimWorld, capabilitiesOf } from '../src/pet/sim/world.ts';

for (const scenario of SCENARIOS) {
  test(`场景：${scenario.name}`, async () => {
    await runScenario(scenario);
  });
}

test('全部场景一次性跑完也全过（npm run sim 的路径）', async () => {
  const results = await runAllScenarios();
  assert.deepEqual(results.filter((result) => !result.ok), [], '有场景失败');
  assert.equal(results.length, SCENARIOS.length);
});

test('时间写法：+25m / +3s / +90', () => {
  assert.equal(parseAt('+25m'), 25 * 60_000);
  assert.equal(parseAt('+3s'), 3_000);
  assert.equal(parseAt('+90'), 90);
  assert.equal(parseAt('+90s'), 90_000);
  assert.throws(() => parseAt('25 分钟'), /写法不对/);
});

test('相同脚本跑两次，结局与出声逐条相同（可重放）', async () => {
  const scenario = SCENARIOS.find((item) => item.name === '安静久了主动搭话');
  assert.ok(scenario !== undefined);
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  assert.deepEqual(first.outcomes, second.outcomes);
  assert.deepEqual(
    first.world.voice.spoken.map((line) => ({ text: line.text, at: line.at, result: line.result })),
    second.world.voice.spoken.map((line) => ({ text: line.text, at: line.at, result: line.result })),
  );
});

test('档案里不留 base64：图片只留字节数', () => {
  const image = { mimeType: 'image/jpeg', data: 'x'.repeat(1024) };
  const summarized = summarizePetEvent('pet.out', {
    kind: 'phase.enter',
    phase: 'compose',
    image,
    text: null,
  });
  assert.deepEqual(summarized['image'], { bytes: 1024 });
  assert.ok(!JSON.stringify(summarized).includes('xxxx'), 'JPEG 正文不能进档案');
});

test('不变量能抓住「没戴也开口」', async () => {
  const caps = capabilitiesOf('xiaomi-full');
  const world = new SimWorld({ caps, world: { agent: [{ reply: { text: '嗯。' } }] } });
  try {
    await world.until(0);
    const fake = [
      ...world.timeline,
      { t: 0, wallHour: 12, src: 'pet.out' as const, kind: 'phase.enter', engagementId: 'x', phase: 'compose', reason: 'chatter' },
      { t: 1, wallHour: 12, src: 'pet.out' as const, kind: 'end', id: 'x', outcome: 'ignored', phase: 'compose', reason: 'chatter' },
    ];
    const violations = checkInvariants(fake, { params: DEFAULT_PET_PARAMS, caps });
    assert.ok(violations.some((violation) => violation.rule === '⑤'), '应当报 ⑤');
  } finally {
    world.dispose();
  }
});

test('不变量 ⑪：计划含 listen 时，开口不得早于开麦（或超时）', async () => {
  const caps = capabilitiesOf('xiaomi-full');
  const world = new SimWorld({ caps });
  try {
    await world.until(0);
    const base = [
      ...world.timeline,
      { t: 0, wallHour: 12, src: 'device' as const, kind: 'presence', wearing: true },
      {
        t: 0,
        wallHour: 12,
        src: 'pet.out' as const,
        kind: 'phase.enter',
        engagementId: 'z',
        phase: 'compose',
        reason: 'chatter',
        plan: ['compose', 'listen', 'speak', 'await'],
      },
      { t: 100, wallHour: 12, src: 'call' as const, kind: 'listen.start', op: 'listen.start' },
    ];
    // 开麦 100 ms、超时 1.5 s；300 ms 就开口 → 违反
    const early = [
      ...base,
      { t: 400, wallHour: 12, src: 'voice' as const, kind: 'start', speaker: 'pet', engagementId: 'z', floorOwner: 'pet' },
      { t: 500, wallHour: 12, src: 'voice' as const, kind: 'end', speaker: 'pet', engagementId: 'z', result: 'done' },
      { t: 600, wallHour: 12, src: 'pet.out' as const, kind: 'end', id: 'z', outcome: 'ignored', phase: 'speak', reason: 'chatter' },
    ];
    const violations = checkInvariants(early, { params: DEFAULT_PET_PARAMS, caps });
    assert.ok(violations.some((violation) => violation.rule === '⑪'), '应当报 ⑪');

    // 超出超时之后再开口 → 合规
    const late = [
      ...base,
      { t: 1_700, wallHour: 12, src: 'voice' as const, kind: 'start', speaker: 'pet', engagementId: 'z', floorOwner: 'pet' },
      { t: 1_800, wallHour: 12, src: 'voice' as const, kind: 'end', speaker: 'pet', engagementId: 'z', result: 'done' },
      { t: 1_900, wallHour: 12, src: 'pet.out' as const, kind: 'end', id: 'z', outcome: 'ignored', phase: 'speak', reason: 'chatter' },
    ];
    const ok = checkInvariants(late, { params: DEFAULT_PET_PARAMS, caps });
    assert.deepEqual(ok.filter((violation) => violation.rule === '⑪'), [], '超时后开口不算违反');
  } finally {
    world.dispose();
  }
});

test('不变量能抓住「宠物出声时话筒不在自己手里」', async () => {
  const caps = capabilitiesOf('xiaomi-full');
  const world = new SimWorld({ caps });
  try {
    await world.until(0);
    const fake = [
      ...world.timeline,
      { t: 0, wallHour: 12, src: 'device' as const, kind: 'presence', wearing: true },
      { t: 0, wallHour: 12, src: 'pet.out' as const, kind: 'phase.enter', engagementId: 'y', phase: 'speak', reason: 'chatter' },
      { t: 1, wallHour: 12, src: 'voice' as const, kind: 'start', speaker: 'pet', engagementId: 'y', floorOwner: 'user' },
      { t: 2, wallHour: 12, src: 'voice' as const, kind: 'end', speaker: 'pet', engagementId: 'y', result: 'done' },
      { t: 3, wallHour: 12, src: 'pet.out' as const, kind: 'end', id: 'y', outcome: 'ignored', phase: 'speak', reason: 'chatter' },
    ];
    const violations = checkInvariants(fake, { params: DEFAULT_PET_PARAMS, caps });
    assert.ok(violations.some((violation) => violation.rule === '①'), '应当报 ①');
  } finally {
    world.dispose();
  }
});
