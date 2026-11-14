/**
 * 长思考回执：什么时候说、什么时候必须立刻闭嘴。
 *
 * 真机现场（05:17:23–05:17:26）：
 *
 * ```text
 * 句 1  "退一下。"                ← thinking 开始
 * 句 2  "退休。"                  ← 用户又说了一句
 * 回执    1.2 s 还没出声 → 先说一句「嗯，我看看。」
 * 旁白    "嗯，我看看。" 1.76 s   ← 用户正在说话，它还在念
 * ```
 *
 * 两件事都得钉住：回执到点才说（不能抢在模型前面），用户一开口就必须停
 * （不能盖着用户说）。这里用真实的 `TurnRunner` + 虚拟时钟跑，不靠人工推算。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DialogFsm } from '../src/dialog-fsm.ts';
import type { AgentProvider, TtsProvider } from '../src/providers.ts';
import type { DownlinkSink } from '../src/transport.ts';
import { TurnRunner } from '../src/turn-runner.ts';
import { VirtualClock } from '../src/pet/sim/clock.ts';

class RecordingDownlink implements DownlinkSink {
  readonly at: number[] = [];
  private readonly clock: VirtualClock;
  constructor(clock: VirtualClock) {
    this.clock = clock;
  }
  sendAudio(pcm: Buffer): void {
    this.at.push(this.clock.now());
  }
  sendControl(): void {}
  get chunks(): number {
    return this.at.length;
  }
}

/** TTS：一块 100 ms 音频，中间隔 400 ms 才给下一块（模拟流式合成）。 */
function slowTts(clock: VirtualClock): TtsProvider {
  return {
    name: 'test',
    sampleRate: 16_000,
    async *synthesize(): AsyncIterable<Buffer> {
      for (let i = 0; i < 4; i += 1) {
        if (i > 0) {
          await new Promise<void>((resolve) => { clock.after(400, resolve); });
        }
        yield Buffer.alloc(3_200);
      }
    },
  };
}

interface Harness {
  readonly clock: VirtualClock;
  readonly runner: TurnRunner;
  readonly downlink: RecordingDownlink;
  readonly askedAt: number[];
}

function harness(options: { agentLatencyMs: number }): Harness {
  const clock = new VirtualClock(0, 12);
  const downlink = new RecordingDownlink(clock);
  const askedAt: number[] = [];
  const agent: AgentProvider = {
    name: 'test',
    reply: () => new Promise((resolve) => {
      askedAt.push(clock.now());
      clock.after(options.agentLatencyMs, () => {
        resolve({ text: '好。', speech: '好。' });
      });
    }),
  };
  const runner = new TurnRunner({
    clock,
    agent,
    tts: slowTts(clock),
    downlink,
    fsm: new DialogFsm(() => {}),
    playbackTailMs: 0,
    ack: { afterMs: 1_000, text: '嗯，我看看。' },
    onTurnFinished: () => {},
    log: () => {},
  });
  return { clock, runner, downlink, askedAt };
}

test('模型慢：到点先给回执', async () => {
  const { clock, runner, downlink } = harness({ agentLatencyMs: 5_000 });
  void runner.run('跑个长任务');
  await clock.runUntil(1_500);

  assert.ok(downlink.chunks > 0, '1.5 s 时应当已经有回执音频');
  assert.equal(downlink.at[0], 1_000, `回执该在 1 s 到点就发，实际 ${downlink.at[0]}`);
});

test('用户开口：回执立刻停，剩下的不再下发', async () => {
  const { clock, runner, downlink } = harness({ agentLatencyMs: 5_000 });
  void runner.run('跑个长任务');
  await clock.runUntil(1_500);
  const before = downlink.chunks;
  assert.ok(before >= 1 && before < 4, `回执应当只念了一部分（共 4 块），实际 ${before} 块`);

  runner.cancelAck();
  await clock.runUntil(3_000);
  assert.equal(downlink.chunks, before, '收回执之后不该再有回执音频');
});

test('模型很快：不说回执（不耽误正式回答）', async () => {
  const { clock, runner, downlink } = harness({ agentLatencyMs: 400 });
  void runner.run('你好');
  await clock.runUntil(4_000);

  // 第一个块应当是正式回答（在 1 s 之前就开始），而不是 1 s 到点的回执
  assert.ok(downlink.chunks > 0, '应当有正式回答的音频');
  assert.equal(
    downlink.at.some((at) => at === 1_000),
    false,
    `不该有 1 s 到点的回执，实际下发时刻：${JSON.stringify(downlink.at)}`,
  );
});
