/**
 * 对话环在虚拟时间上跑通（ADR-0002 §10.7）。
 *
 * 这三/四条场景证明：用户说话 → agent → TTS → 下发、播放中被插话、拍照问答、
 * 拍照超时，都不需要设备、不需要网络、不用真等音频播完。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DIALOG_SCENARIOS, runDialogScenarios } from '../src/pet/sim/dialog-scenarios.ts';
import { DialogSim } from '../src/pet/sim/dialog.ts';
import { XIAOMI_GLASSES_CAPABILITIES } from '../src/devices/xiaomi.ts';

test('全部对话场景通过', async () => {
  const results = await runDialogScenarios();
  assert.deepEqual(results.filter((result) => !result.ok), [], '有对话场景失败');
  assert.equal(results.length, DIALOG_SCENARIOS.length);
});

test('ASR 幽灵文本：不打断播放，也不开轮', async () => {
  // 真机 2026-11-23 08:24：`asr.partial "Thank"` 两次打断播放，各丢一整条答案
  // （第 5 轮只念了 0.64 s、第 14 轮刚起播 30 ms 就被 audio.stop 清掉）。
  const caps = {
    ...XIAOMI_GLASSES_CAPABILITIES,
    presence: true,
    power: true,
    summon: true,
    listenStart: true,
  };
  const sim = new DialogSim({ caps, reply: { text: '好的，我来讲讲。' } });
  try {
    await sim.utterance('讲个故事');
    await sim.until(500);
    assert.equal(sim.core.phase, 'speaking', '这一轮应当在播');

    const stopsBefore = sim.calls.filter((call) => call.op === 'audio.stop').length;
    await sim.partial('Thank');
    await sim.partial('Thank you.');
    assert.equal(
      sim.calls.filter((call) => call.op === 'audio.stop').length,
      stopsBefore,
      '幽灵文本不能触发 audio.stop',
    );
    assert.equal(sim.core.phase, 'speaking', '播放不能被打断');

    const askedBefore = sim.asked.length;
    await sim.utterance('Okay.');
    assert.equal(sim.asked.length, askedBefore, '幽灵定稿也不该开一轮');

    // 真插话照旧：这条闸门不能顺手把打断功能一起关掉
    await sim.partial('你看');
    assert.equal(sim.core.phase, 'listening');
    assert.ok(
      sim.calls.filter((call) => call.op === 'audio.stop').length > stopsBefore,
      '真插话必须照常打断',
    );
  } finally {
    await sim.close();
    sim.dispose();
  }
});

test('对话：同一句在虚拟时间里可复现（时间戳稳定）', async () => {
  const caps = {
    ...XIAOMI_GLASSES_CAPABILITIES,
    presence: true,
    power: true,
    summon: true,
    listenStart: true,
  };
  const first = new DialogSim({ caps, reply: { text: '嗯。' } });
  const second = new DialogSim({ caps, reply: { text: '嗯。' } });
  try {
    await first.utterance('你好');
    await first.until(5_000);
    await second.utterance('你好');
    await second.until(5_000);
    assert.deepEqual(first.downlink.sent, second.downlink.sent, '同一输入必须给出同一串下发时刻');
  } finally {
    await first.close();
    first.dispose();
    await second.close();
    second.dispose();
  }
});
