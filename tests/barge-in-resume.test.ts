/**
 * 打断与善后：**不慎打断不能把信息弄丢，也不能硬塞回去**。
 *
 * 三件事各自都会静默出错，而且都只在真机上才感觉得出来：
 *
 *  1. 「嗯」一声就把正在播的后台汇报掐掉 —— 那条信息只播一次，丢了就没了；
 *  2. 真被打断之后，没念完的那半句直接消失 —— 用户只听到一半还以为听完了；
 *  3. 系统自作主张把剩下的补播一遍 —— 用户可能已经在问别的事，那一句就是插嘴。
 *
 * 所以定下来的规矩是：**掐断时留底，补不补由下一轮的模型判断**（它知道哥刚才
 * 问的是什么，系统不知道）。这里钉的就是这条：留底进注记、不自动重播、
 * 双击之后连注记都不留。
 *
 * 全部跑在虚拟时间上（`DialogSim` 用的是生产那一份 `DialogRuntime`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { XIAOMI_GLASSES_CAPABILITIES } from '../src/devices/xiaomi.ts';
import { DialogSim } from '../src/pet/sim/dialog.ts';

const CAPS = { ...XIAOMI_GLASSES_CAPABILITIES, listenStart: true };

/** 17 字 × 200 ms ≈ 3.4 s 音频，够在中途插一句。 */
const REPORT = '任务跑完了，一共八百三十三个文件。';

function makeSim(): DialogSim {
  return new DialogSim({ caps: CAPS, ttsMsPerChar: 200, micOpenAfterMs: 50 });
}

/** 不打断、完整播一遍，作为对照组。 */
async function baselineBytes(): Promise<number> {
  const sim = makeSim();
  try {
    sim.announce(REPORT);
    await sim.until(6_000);
    return sim.downlink.bytes;
  } finally {
    sim.dispose();
  }
}

test('「嗯」一声不算打断：不重新合成，也不留残句', async () => {
  const full = await baselineBytes();
  assert.ok(full > 0, '对照组得先有声音');

  const sim = makeSim();
  try {
    sim.announce(REPORT);
    await sim.until(500);
    await sim.partial('嗯');

    assert.equal(
      sim.runtime.runner.takeCannedResidue(),
      null,
      '语气词不该把旁白掐断 —— 掐了就得重新合成，等于白念一遍',
    );
    assert.equal(
      sim.calls.filter((call) => call.op === 'audio.stop').length,
      0,
      '语气词不能发 audio.stop',
    );
    await sim.until(6_000);
    assert.equal(sim.downlink.bytes, full, '没被打断就不该多合成一遍');
  } finally {
    sim.dispose();
  }
});

test('真打断之后：不自动重播，但把没念完的部分交给下一轮的模型', async () => {
  const full = await baselineBytes();

  const sim = makeSim();
  try {
    sim.announce(REPORT);
    // 念到 2 秒左右再打断：这时前几句他已经听到了，剩下的才算「没听到的部分」。
    // （更早打断的话剩下的是整段 —— 模拟器的 TTS 是一次性吐完的，但真机是流式，
    //   `cancelCanned` 取「已下发」和「已过时间」的较小值，所以进度按时间走。）
    await sim.until(2_000);
    await sim.partial('等一下');
    assert.equal(
      sim.calls.filter((call) => call.op === 'audio.stop').length,
      1,
      '播报中插话必须立刻下发 audio.stop 清空设备/浏览器播放缓冲',
    );

    await sim.until(9_000);
    assert.equal(
      sim.downlink.bytes,
      full,
      '系统不该自己补播 —— 哥可能已经在问别的事',
    );

    // 下一轮：模型应当拿到「刚才那半句他没听到」这条注记
    await sim.utterance('刚才说什么');
    const note = sim.asked.at(-1)?.note ?? '';
    assert.ok(note.includes('没听到'), `注记里要写清他没听到，实际「${note}」`);
    assert.ok(
      note.includes('八百三十三'),
      `注记里要带上没念完的那半句，实际「${note}」`,
    );
    assert.ok(
      !note.includes('任务跑完了'),
      `已经念过的开头不该再发一遍（模型会从头重念），实际「${note}」`,
    );
  } finally {
    sim.dispose();
  }
});

test('双击「别念了」之后，连注记都不留', async () => {
  const full = await baselineBytes();

  const sim = makeSim();
  try {
    sim.announce(REPORT);
    await sim.until(500);
    sim.runtime.clearAnnounce();
    assert.equal(
      sim.calls.filter((call) => call.op === 'audio.stop').length,
      1,
      '双击关播报必须下发 audio.stop',
    );
    await sim.until(9_000);
    assert.equal(sim.downlink.bytes, full, '明确要求别念了，就不该自己补播回来');

    await sim.utterance('好的');
    const note = sim.asked.at(-1)?.note ?? '';
    assert.ok(
      !note.includes('没听到'),
      `已经明确不要听了，不该再拿这个去问模型，实际「${note}」`,
    );
  } finally {
    sim.dispose();
  }
});

test('反复打断不会攒成一串补播', async () => {
  const full = await baselineBytes();
  const sim = makeSim();
  try {
    sim.announce(REPORT);
    for (let i = 0; i < 5; i += 1) {
      await sim.until(400);
      await sim.partial('等一下');
    }
    await sim.until(12_000);
    assert.equal(
      sim.downlink.bytes,
      full,
      '补播交给模型之后，系统这边一次都不该多发',
    );
  } finally {
    sim.dispose();
  }
});

test('剩余文本是原文的后缀，不会从头重念', async () => {
  const sim = makeSim();
  try {
    const speaking = sim.runtime.runner.speakCanned('一二三四五六七八九十');
    await sim.until(800);
    sim.runtime.runner.cancelCanned();
    const residue = sim.runtime.runner.takeCannedResidue();
    // 必须先推进时钟，旁白的播放等待才会结束
    await sim.until(4_000);
    await speaking;

    assert.ok(residue, '被打断的旁白要留底');
    assert.ok(
      '一二三四五六七八九十'.includes(residue.text.replace(/\s+/g, '')),
      `剩下的应当只是后半段，实际「${residue.text}」`,
    );
    assert.equal(
      sim.runtime.runner.takeCannedResidue(),
      null,
      '取一次就没了，不能补两遍',
    );
  } finally {
    sim.dispose();
  }
});
