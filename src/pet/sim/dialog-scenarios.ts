/**
 * 对话环的场景：用户说话 → agent → TTS → 下发 → 插话，全部在虚拟时间上。
 *
 * 对应 ADR-0002 §10.7。**零网络、零密钥、零 ffmpeg、不用真等音频播完。**
 */
import assert from 'node:assert/strict';

import { XIAOMI_GLASSES_CAPABILITIES } from '../../devices/xiaomi.ts';
import { DialogSim, type DialogSimOptions } from '../sim/dialog.ts';

export interface DialogScenario {
  readonly name: string;
  /** 这个场景要用特别的 sim 配置时给（不给自己用默认的） */
  readonly sim?: Partial<DialogSimOptions>;
  readonly run: (sim: DialogSim) => Promise<void>;
}

const CAPS = {
  ...XIAOMI_GLASSES_CAPABILITIES,
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
};

/** 一小段假 JPEG（只要非空，内容不影响判定）。 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

export const DIALOG_SCENARIOS: readonly DialogScenario[] = [
  {
    name: '对话：用户说完 → agent → TTS → 下发',
    async run(sim) {
      await sim.utterance('你好');
      await sim.until(10_000);

      assert.equal(sim.asked.length, 1, 'agent 应当被问过一次');
      assert.equal(sim.asked[0]?.text, '你好');
      assert.ok(sim.audioBytes > 0, '应当有下行音频');
      assert.equal(sim.core.turn, 1, '应当跑完一轮');
      assert.equal(sim.turnsStarted, 1, '一轮只该开始一次');
      assert.equal(sim.turnsEnded, sim.turnsStarted, '每一轮都要收尾（否则话筒永远被占着）');
    },
  },
  {
    name: '对话：播放中用户插话 → 立刻 stop',
    async run(sim) {
      await sim.utterance('讲个长一点的故事');
      // 播放还没结束时插话（音频约 2.5 s，500 ms 处打断）
      await sim.until(500);
      await sim.partial('等等');
      await sim.until(10_000);

      assert.ok(
        sim.calls.some((call) => call.op === 'audio.stop'),
        `应当下发 audio.stop，实际：${JSON.stringify(sim.calls)}`,
      );
      assert.equal(sim.core.turn, 1, '被插话之后不该再开新的一轮');
    },
  },
  {
    name: '对话：要看清细节 → 拍照 → 图交给 agent',
    async run(sim) {
      await sim.utterance('帮我看看这张纸上写的什么细节');
      await sim.flush();
      // 状态机应当发了一次 capture
      assert.ok(
        sim.calls.some((call) => call.op === 'capture'),
        `应当下发 capture，实际：${JSON.stringify(sim.calls)}`,
      );
      const capture = sim.calls.find((call) => call.op === 'capture');
      assert.ok(capture !== undefined && capture.op === 'capture');

      // 设备回图（在兜底超时之前）
      await sim.captureResult(capture.id, JPEG);
      await sim.until(20_000);

      const withImage = sim.asked.filter((ask) => ask.image);
      assert.equal(withImage.length, 1, '带图的那一轮应当交给 agent');
      assert.ok(sim.audioBytes > 0, '应当有下行音频');
    },
  },
  {
    name: '对话：拍照超时 → 不卡死，照常收尾',
    async run(sim) {
      await sim.utterance('帮我看看这张纸上写的什么细节');
      await sim.flush();
      // 不回图，让它自己超时
      await sim.until(sooner(sim));
      assert.ok(sim.photos !== undefined);
      // 超时后状态机回到可听状态，不会永远卡在 awaiting_shot
      assert.notEqual(sim.core.phase, 'awaiting_shot', '超时后不该还卡在等图');
    },
  },
  {
    name: '对话：播报排队 → 等本轮说完才播，且先开麦',
    async run(sim) {
      await sim.utterance('讲个长一点的故事');
      // 播放到一半：后台任务汇报来了，不能抢话
      await sim.until(500);
      sim.announce('后台任务跑完了');
      await sim.flush();
      assert.equal(
        sim.calls.some((call) => call.op === 'listen.start'),
        false,
        `本轮还没说完，播报不该开口（也不该开麦）：${JSON.stringify(sim.calls)}`,
      );
      assert.equal(
        sim.calls.some((call) => call.op === 'audio.stop'),
        false,
        '播报不该打断本轮',
      );

      await sim.until(20_000);
      const openAt = sim.calls.findIndex((call) => call.op === 'listen.start');
      assert.ok(openAt >= 0, `本轮结束后播报应当先开麦：${JSON.stringify(sim.calls)}`);
      const stopAt = sim.calls.findIndex((call, index) => index > openAt && call.op === 'listen.stop');
      assert.ok(stopAt > openAt, '播完之后应当关麦');
    },
  },
  {
    name: '对话：长思考 → 先给一句回执，再出正式回答',
    sim: {
      reply: { latencyMs: 5_000, text: '跑完了，一共三条。' },
      ack: { afterMs: 1_000, text: '嗯，我看看。' },
    },
    async run(sim) {
      await sim.utterance('去跑三条命令');
      await sim.until(1_400);
      // 1.4 s 时 dsh 还没回来：应当已经有一句回执播出去了
      assert.ok(
        sim.downlink.sent.some((chunk) => chunk.at >= 1_000 && chunk.at <= 1_400),
        `1 s 时该有回执音频，实际下发时刻：${JSON.stringify(sim.downlink.sent.map((c) => c.at))}`,
      );
      assert.equal(sim.core.phase, 'thinking', '回执照旁白走，不该改动状态机');

      await sim.until(12_000);
      assert.ok(
        sim.downlink.sent.some((chunk) => chunk.at >= 5_000),
        '正式回答应当在 dsh 返回后下发（回执不能把它顶掉）',
      );
      assert.equal(sim.core.turn, 1, '一轮就是一问一答，回执不算新的一轮');
    },
  },
  {
    name: '对话：回答被打断 → 下一轮带上「没说完的那段」',
    sim: {
      reply: { text: '这件事我分成三点来说，第一点是先看清楚需求，第二点是确认边界条件。' },
    },
    async run(sim) {
      await sim.utterance('你解释一下');
      // 播到一半插话（这句约 6 s 音频，2.5 s 处打断：前面两点已经念出来了）
      await sim.until(2_500);
      await sim.partial('等等');
      await sim.until(4_000);

      await sim.utterance('你刚才想说什么');
      await sim.until(12_000);

      const last = sim.asked.at(-1);
      assert.ok(last !== undefined, '应当问过 agent');
      assert.ok(
        last.note !== undefined && last.note.includes('打断'),
        `第二轮应当带上被打断的注记，实际：${JSON.stringify(last.note ?? null)}`,
      );
      assert.ok(
        last.note?.includes('第二点') === true,
        `注记里该有没念出口的部分（第二点），实际：${last.note ?? ''}`,
      );
    },
  },
];

/** 找一个比兜底超时更晚的时刻。 */
function sooner(sim: DialogSim): number {
  return sim.clock.now() + 60_000;
}

/** 跑全部对话场景。 */
export async function runDialogScenarios(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const scenario of DIALOG_SCENARIOS) {
    const sim = new DialogSim({
      caps: CAPS,
      reply: { text: '嗯，看到了。' },
      ...scenario.sim,
    });
    try {
      await scenario.run(sim);
      results.push({ name: scenario.name, ok: true });
    } catch (error) {
      results.push({ name: scenario.name, ok: false, error: (error as Error).message });
    } finally {
      await sim.close();
      sim.dispose();
    }
  }
  return results;
}
