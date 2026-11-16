/**
 * 打断与续播：**不慎打断不能把信息弄丢**。
 *
 * 三件事各自都会静默出错，而且都只在真机上才感觉得出来：
 *
 *  1. 「嗯」一声就把正在播的后台汇报掐掉 —— 那条信息只播一次，丢了就没了；
 *  2. 真被打断之后，没念完的半句直接消失 —— 用户只听到一半，还以为听完了；
 *  3. 双击「别念了」之后又来补播 —— 用户明确不要听，系统却自己接着说。
 *
 * 全部跑在虚拟时间上（`DialogSim` 用的是生产那一份 `DialogRuntime`）。
 *
 * <h2>为什么用「字节数反而变多」来判断</h2>
 *
 * 模拟器的 TTS 是一次性把整段吐出来的（真机是流式，但**吐得比播得快**），
 * 所以「播到哪儿了」只能按首块到现在的时间算。于是：
 *
 * - 没被打断 → 只合成一遍，字节数 = 基准；
 * - 被打断后补播 → 剩下的那半句**重新合成**一遍，字节数会**超过**基准。
 *
 * 反过来，补播要是没发生，字节数就停在基准 —— 那正是「信息丢了」的样子。
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
    await sim.until(6_000);
    assert.equal(sim.downlink.bytes, full, '没被打断就不该多合成一遍');
  } finally {
    sim.dispose();
  }
});

test('真打断之后，没念完的部分会补播', async () => {
  const full = await baselineBytes();

  const sim = makeSim();
  try {
    sim.announce(REPORT);
    await sim.until(500);
    // `partial` 只表示「用户开口了」，不开新的一轮 —— 单独测续播这条路径
    await sim.partial('等一下');

    // 静默窗口内先别急着补（不然像是在跟用户抢话）
    const atInterrupt = sim.downlink.bytes;
    await sim.until(700);
    assert.equal(sim.downlink.bytes, atInterrupt, '打断之后应当先安静一会儿');

    await sim.until(9_000);
    assert.ok(
      sim.downlink.bytes > full,
      `补播没有发生（${sim.downlink.bytes} 字节，基准 ${full}）—— 后半句丢了`,
    );
  } finally {
    sim.dispose();
  }
});

test('双击「别念了」之后不再补播', async () => {
  const full = await baselineBytes();

  const sim = makeSim();
  try {
    sim.announce(REPORT);
    await sim.until(500);
    sim.runtime.clearAnnounce();
    await sim.until(9_000);
    assert.equal(
      sim.downlink.bytes,
      full,
      '明确要求别念了，就不该自己补播回来',
    );
  } finally {
    sim.dispose();
  }
});

test('同一句被打断太多次就不再补（避免反复骚扰）', async () => {
  const full = await baselineBytes();
  const sim = makeSim();
  try {
    sim.announce(REPORT);
    for (let i = 0; i < 5; i += 1) {
      await sim.until(400);
      await sim.partial('等一下');
    }
    await sim.until(12_000);
    assert.ok(
      sim.downlink.bytes < full * 3,
      `补播次数没有上限（${sim.downlink.bytes} 字节，基准 ${full}）`,
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
