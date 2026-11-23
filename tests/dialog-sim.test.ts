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
