/**
 * 话筒仲裁：**一份真相**。
 *
 * 这一组测试钉的是 ADR-0001 §6 那张表，以及「谁持有话筒状态」这件事：
 *
 * - 状态只有一份（`AppSession.floor`），`AppSession` 里不再有 `speaker` 影子变量
 * - `user → reply` 是**移交**，不是抢占（`reply` 抢不动 `user`）
 * - `announce` 抢不动 `reply`；`reply` **可以**接过 `announce`
 *   （前台应答要接管被掐断的播报。原先没有用例锁「reply 不抢 announce」，
 *   那条反例会让思考期的话筒被播报 finally 放成 `null`）
 * - 用户一开口一定拿回话筒（`user` 可以抢任何人）
 * - 宠物开 / 关两种配置都要能仲裁 `user` / `reply` / `announce`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppSession } from '../src/app/session.ts';
import { EVENTS } from '../src/events.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';
import { capabilitiesOf } from '../src/pet/sim/world.ts';
import type { AgentPort, DevicePort, Voice } from '../src/pet/brain/types.ts';

/** 够用的空实现：仲裁测试不碰这些端口。 */
function stubs(): { voice: Voice; device: DevicePort; agent: AgentPort } {
  const voice: Voice = {
    speak: async () => 'done',
    stop: () => {},
  } as unknown as Voice;
  const device: DevicePort = {
    call: async () => ({ ok: true }),
  } as unknown as DevicePort;
  const agent: AgentPort = {
    reply: async () => ({ speech: '', emotion: 'calm' }),
  } as unknown as AgentPort;
  return { voice, device, agent };
}

function makeApp(
  pet: boolean,
  onEvent?: (name: string, fields: Record<string, unknown>) => void,
): AppSession {
  const { voice, device, agent } = stubs();
  return new AppSession({
    clock: new VirtualClock(12 * 60),
    caps: capabilitiesOf('xiaomi-full'),
    voice,
    device,
    agent,
    pet,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

for (const pet of [true, false]) {
  const label = pet ? '宠物开' : '宠物关';

  test(`${label}：定稿后 user → reply 是移交，不是抢占`, () => {
    const app = makeApp(pet);
    app.userPartial();
    assert.equal(app.floor.owner, 'user', '开口就占话筒');

    app.userFinal('今天几号');
    assert.equal(app.floor.owner, 'reply', 'user 必须能把话筒交给 reply（reply 抢不动 user）');
    app.close();
  });

  test(`${label}：announce 抢不动 reply`, () => {
    const app = makeApp(pet);
    app.userFinal('帮我查一下订单');
    assert.equal(app.floor.owner, 'reply');

    app.announce(true);
    assert.equal(app.floor.owner, 'reply', '正题没说完，旁白只能排队');

    app.turnEnd();
    assert.equal(app.floor.owner, null, '本轮结束话筒该空出来');

    app.announce(true);
    assert.equal(app.floor.owner, 'announce', '空着就该轮到旁白');
    app.announce(false);
    assert.equal(app.floor.owner, null);
    app.close();
  });

  test(`${label}：用户插话一定拿回话筒`, () => {
    const app = makeApp(pet);
    app.announce(true);
    assert.equal(app.floor.owner, 'announce');

    app.userPartial();
    assert.equal(app.floor.owner, 'user', '用户开口要能抢过旁白');

    app.turnEnd();
    app.userFinal('再说一句');
    assert.equal(app.floor.owner, 'reply');
    app.userPartial();
    assert.equal(app.floor.owner, 'user', '说话期间再开口也还是用户的');
    app.close();
  });

  test(`${label}：状态机转移驱动占用与释放`, () => {
    const app = makeApp(pet);
    app.userPartial();
    app.onDialogState('thinking');
    assert.equal(app.floor.owner, 'reply', '开跑就该是应答在说话');

    app.onDialogState('speaking');
    assert.equal(app.floor.owner, 'reply', '整段播放都算应答');

    app.onDialogState('listening');
    assert.equal(app.floor.owner, null, '回到 listening 就该空出来');

    app.onDialogState('awaiting_shot');
    assert.equal(app.floor.owner, null, '等快门时不占话筒');
    app.close();
  });

  test(`${label}：播报占麦时进入 thinking，释放后直到 listening 话筒都是 reply`, () => {
    const app = makeApp(pet);
    // 没有 user 阶段：状态机直接从 announce 进 thinking。
    // 旧实现 claim('reply') 抢不动 announce，finally 一 release 就变成 null。
    app.announce(true);
    assert.equal(app.floor.owner, 'announce');
    app.onDialogState('thinking');
    assert.equal(app.floor.owner, 'reply', 'thinking 必须从 announce 移交到 reply');
    app.announce(false, true);
    assert.equal(app.floor.owner, 'reply', '播报 finally 不能把思考期的话筒放空');
    app.onDialogState('speaking');
    assert.equal(app.floor.owner, 'reply');
    app.announce(true);
    assert.equal(app.floor.owner, 'reply', 'speaking 期间剩下的播报不得抢回话筒');
    if (pet) {
      assert.equal(app.snapshot()?.world.floorOwner, 'reply');
      assert.equal(app.snapshot()?.world.announcePending, true, '还排着队，宠物要让位');
    }
    app.announce(false);
    assert.equal(app.floor.owner, 'reply');
    if (pet) {
      assert.equal(app.snapshot()?.world.announcePending, false);
    }
    app.onDialogState('listening');
    assert.equal(app.floor.owner, null, '整轮回到 listening 才放空');
    app.close();

    // 短句常常只有定稿、没有 partial，话筒还停在 announce 上。
    const again = makeApp(pet);
    again.announce(true);
    again.userFinal('我想问别的');
    assert.equal(again.floor.owner, 'reply', '定稿必须从 announce 移交给 reply');
    again.onDialogState('thinking');
    assert.equal(again.floor.owner, 'reply');
    again.announce(false, true);
    assert.equal(again.floor.owner, 'reply');
    again.onDialogState('speaking');
    assert.equal(again.floor.owner, 'reply');
    again.onDialogState('listening');
    assert.equal(again.floor.owner, null);
    again.close();
  });

  test(`${label}：awaiting_shot 只把 announce 交给 reply，空话筒保持空`, () => {
    const idle = makeApp(pet);
    idle.onDialogState('awaiting_shot');
    assert.equal(idle.floor.owner, null);
    idle.close();

    const busy = makeApp(pet);
    busy.announce(true);
    busy.onDialogState('awaiting_shot');
    assert.equal(busy.floor.owner, 'reply');
    busy.announce(false);
    assert.equal(busy.floor.owner, 'reply', '等快门时释放播报也不能放成 null');
    busy.close();
  });
}

test('没有宠物时仲裁器照样在（不是宠物的附属品）', () => {
  const app = makeApp(false);
  assert.equal(app.pet, null);
  assert.notEqual(app.floor, null);
  app.userPartial();
  assert.equal(app.floor.owner, 'user');
  app.close();
});

test('关闭时清空话筒', () => {
  const app = makeApp(false);
  app.userFinal('你好');
  assert.equal(app.floor.owner, 'reply');
  app.close();
  assert.equal(app.floor.owner, null);
});

test('reply 可以接过 announce；user 仍然只能移交', () => {
  const app = makeApp(false);
  assert.equal(app.floor.acquire('announce'), true);
  assert.equal(
    app.floor.acquire('reply'),
    true,
    '前台应答要能接过被掐断的播报（原先没有用例锁「reply 不抢 announce」）',
  );
  assert.equal(app.floor.owner, 'reply');
  assert.equal(app.floor.acquire('user'), true);
  assert.equal(app.floor.acquire('reply'), false, 'user 不可抢，定稿必须走 handoff');
  assert.equal(app.floor.owner, 'user');
  assert.equal(app.floor.handoff('user', 'reply'), true);
  assert.equal(app.floor.owner, 'reply');
  // pet 仍不让：等它说完
  assert.equal(app.floor.release('reply'), true);
  assert.equal(app.floor.acquire('pet'), true);
  assert.equal(app.floor.acquire('reply'), false);
  assert.equal(app.floor.owner, 'pet');
  app.close();
});

test('宠物开：思考期释放播报，投影里不出现空话筒', () => {
  const leaked: Array<string | null> = [];
  let guard = false;
  const app = makeApp(true, (name, fields) => {
    if (!guard || name !== EVENTS.petIn || fields['kind'] !== 'floor') {
      return;
    }
    const owner = fields['owner'];
    leaked.push(owner === undefined || owner === null ? null : String(owner));
  });
  app.announce(true);
  guard = true;
  app.onDialogState('thinking');
  app.announce(false, true);
  app.onDialogState('speaking');
  app.announce(true);
  app.announce(false);
  assert.equal(app.floor.owner, 'reply');
  assert.equal(
    leaked.includes(null),
    false,
    `思考/播音期话筒投影出现了 null：${JSON.stringify(leaked)}`,
  );
  guard = false;
  app.onDialogState('listening');
  assert.equal(app.floor.owner, null);
  app.close();
});

test('FloorArbiter.handoff：from 不是持有者时不动', () => {
  const app = makeApp(false);
  app.userPartial();
  assert.equal(app.floor.handoff('reply', 'announce'), false, '过期移交必须被丢弃');
  assert.equal(app.floor.owner, 'user');
  assert.equal(app.floor.handoff('user', 'reply'), true);
  assert.equal(app.floor.owner, 'reply');
  app.close();
});
