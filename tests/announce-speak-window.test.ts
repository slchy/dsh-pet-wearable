/**
 * 「任务完成时用户恰好在说话」的两个窗口。
 *
 * `flushAnnounce` 出声之前只查一次静默窗口，但写出第一个字节之前还有两段异步：
 * - 开麦（`awaitMicOpen`，最长 1.5 s）—— 而且用户**已经在说**的时候麦是立刻开的，
 *   也就是最该让路的时候反而最快开口；那一刻 `speakCanned` 还没建，`cancelCanned`
 *   是空操作，所以开口后也掐不住
 * - 首块合成（~300 ms）—— 这一段能掐住（`canned` 已建），但一个字都没发出去时
 *   不能把整段记成「念了一半」
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SystemClock } from '../src/app/clock.ts';
import { DialogRuntime } from '../src/app/dialog.ts';
import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import type { AgentProvider, TtsProvider } from '../src/providers.ts';
import type { DownlinkSink } from '../src/transport.ts';

const REPORT = '后台汇报：订票成功了，三张。';

function caps(listenStart: boolean): DeviceCapabilities {
  return {
    audioIn: 'pcm16',
    capture: {},
    presence: false,
    power: false,
    summon: false,
    listenStart,
    played: false,
    ignorePhrases: [],
  };
}

interface Rig {
  readonly runtime: DialogRuntime;
  readonly sent: number[];
  readonly logs: string[];
  readonly heard: () => number;
  dispose: () => void;
}

/** `awaitMicMs`：开麦要多久才回「麦开了」（0 = 立刻） */
function rig(listenStart: boolean, awaitMicMs: number): Rig {
  const sent: number[] = [];
  const logs: string[] = [];
  const downlink: DownlinkSink = {
    sendAudio: (chunk) => { sent.push(chunk.length); },
    sendControl: () => {},
  };
  const agent: AgentProvider = {
    name: 'fake',
    reply: async () => ({ text: '好', speech: '好' }),
  };
  const tts: TtsProvider = {
    name: 'fake',
    sampleRate: 24_000,
    async* synthesize() { yield Buffer.alloc(48_000, 1); },
    async* synthesizeStream() { yield Buffer.alloc(48_000, 1); },
  };
  const runtime = new DialogRuntime({
    clock: new SystemClock(),
    caps: caps(listenStart),
    agent,
    tts,
    downlink,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
      ...(listenStart
        ? {
          announceMic: {
            listenStart: true,
            micOpenTimeoutMs: 1_500,
            listenMs: 3_000,
            call: () => {},
            awaitMicOpen: () => new Promise<boolean>((resolve) => {
              setTimeout(() => { resolve(true); }, awaitMicMs);
            }),
          },
        }
        : {}),
    },
    log: (line) => { logs.push(line); },
  });
  return {
    runtime,
    sent,
    logs,
    heard: () => sent.length,
    dispose: () => { runtime.dispose(); },
  };
}

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
};

test('开麦期间用户说了一整句：不念，排回队首，安静之后照播', async () => {
  const r = rig(true, 300);
  try {
    r.runtime.enqueueAnnounce(REPORT);
    await wait(60);
    // 开麦窗口里他真的说了一句完整的话
    r.runtime.dispatch({ type: 'sentence', text: '我想问个别的事' });
    await wait(600);

    assert.equal(r.heard(), 0, '用户已经开口，播报不该压过去');
    assert.ok(
      r.logs.some((line) => line.includes('排回队首')),
      `该有一条「排回队首」的日志，实际：${JSON.stringify(r.logs)}`,
    );

    // 安静下来之后（超过 ANNOUNCE_QUIET_MS）这条汇报还得播出来，不能丢
    await wait(1_200);
    assert.ok(r.heard() > 0, '被推迟的那条必须还能播出来');
  } finally {
    r.dispose();
  }
});

test('开麦期间只有 partial：不算「说了一句」，照常播', async () => {
  const r = rig(true, 300);
  try {
    r.runtime.enqueueAnnounce(REPORT);
    await wait(60);
    // 一个语气词级别的中间结果 —— 把他当成「在说话」会把汇报一直推后
    r.runtime.dispatch({ type: 'partial', text: '嗯' });
    await wait(600);

    assert.ok(r.heard() > 0, '只有 partial 时不该让路');
  } finally {
    r.dispose();
  }
});

test('合成首块期间被掐、一个字都没发出去：不记残句', async () => {
  // 首块合成要 200 ms（真机 ~281 ms）—— 这段窗口里 `canned` 已经建了，
  // 掐得断，但一个字节都还没下发。这时「剩 N 字没念完」是假的：用户什么都没听到。
  const sent: number[] = [];
  const logs: string[] = [];
  const runtime = new DialogRuntime({
    clock: new SystemClock(),
    caps: caps(false),
    agent: { name: 'fake', reply: async () => ({ text: '好', speech: '好' }) },
    tts: {
      name: 'slow',
      sampleRate: 24_000,
      async* synthesize() {
        await wait(200);
        yield Buffer.alloc(48_000, 1);
      },
      async* synthesizeStream() {
        await wait(200);
        yield Buffer.alloc(48_000, 1);
      },
    },
    downlink: {
      sendAudio: (chunk) => { sent.push(chunk.length); },
      sendControl: () => {},
    },
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    env: { call: () => true, assemble: () => {}, end: () => {} },
    log: (line) => { logs.push(line); },
  });
  try {
    runtime.enqueueAnnounce(REPORT);
    await wait(80); // 合成中
    runtime.dispatch({ type: 'partial', text: '等一下' });
    await wait(300);

    assert.equal(sent.length, 0, '掐断生效：一个字节都不该下发');
    // 残句会被 `interruptCanned` 立刻取走塞进下一轮的注记，所以看日志：
    // 一个字都没发出去时不能出现「剩 N 字没念完」
    assert.ok(
      !logs.some((line) => line.includes('没念完')),
      `一个字都没念出去就不能算「念了一半」，实际日志：${JSON.stringify(logs)}`,
    );
    assert.equal(runtime.runner.takeCannedResidue(), null, '残句缓冲也要是空的');
  } finally {
    runtime.dispose();
  }
});
