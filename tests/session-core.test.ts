/**
 * `SessionCore` 的单测：只喂事件，断言「产出什么动作」。
 *
 * 这些判断以前散在 socket 回调里，只能靠真机听感验证；现在纯到可以直接断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionCore, type CoreEffect } from '../src/session-core.ts';
import { KernelRuntime } from '../src/kernel-runtime.ts';
import {
  V1_BASELINE,
  XIAOMI_GLASSES_CAPABILITIES,
  type DeviceCapabilities,
} from '../src/devices/index.ts';

/** 自报能力的设备：两档都不用人动手、没有固件唤醒词（例：雷鸟 X3 Pro 的 Hello） */
const SELF_REPORTED: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: { glance: { needsUser: false }, detail: { needsUser: false } },
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
  played: true,
  ignorePhrases: [],
};

function newCore(
  capabilities: DeviceCapabilities = XIAOMI_GLASSES_CAPABILITIES,
): { core: SessionCore; lines: string[] } {
  const lines: string[] = [];
  const core = new SessionCore({
    capabilities,
    imageQuestion: '这张图里有什么？',
    log: (line) => { lines.push(line); },
  });
  return { core, lines };
}

/** 把效果压成「类型:操作」的可读列表，便于断言。 */
function callOps(effects: readonly CoreEffect[]): string[] {
  return effects.map((effect) => (effect.type === 'call' ? `call:${effect.call.op}` : effect.type));
}

/**
 * 带**记账端口**的 core。
 *
 * 插话的副作用（停音频 / 作废 / 放弃投机 / 结算）现在全部由内核声明，`DialogFsm`
 * 走 `dispatchAndApply` 执行 —— 单测要能看见它们真的落到了端口上，而不是只看
 * `CoreEffect`。
 *
 * @param baseCommitSeq 开轮时锁存的因果水位线；不传 = 票据没有因果坐标
 */
function newWiredCore(baseCommitSeq?: number): {
  core: SessionCore;
  lines: string[];
  ports: string[];
} {
  const lines: string[] = [];
  const ports: string[] = [];
  // 装配层（`DialogRuntime`）就是这么做：先建唯一的运行时交给 core，再绑端口
  const runtime = new KernelRuntime();
  const core = new SessionCore({
    capabilities: XIAOMI_GLASSES_CAPABILITIES,
    imageQuestion: '这张图里有什么？',
    log: (line) => { lines.push(line); },
    runtime,
    ...(baseCommitSeq === undefined
      ? {}
      : { ticketContext: { baseCommitSeq: () => baseCommitSeq } }),
  });
  core.runtime.attachPorts({
    stopDeviceAudio: () => { ports.push('stopDeviceAudio'); },
    invalidateTurn: (ticket, reason) => {
      ports.push(`invalidateTurn:${reason}:${ticket.no}/${ticket.gen}`);
    },
    abortEngine: (reason) => { ports.push(`abortEngine:${reason}`); },
    settleTurn: (turn) => { ports.push(`settleTurn:${turn.ticket.no}/${turn.ticket.gen}`); },
  });
  return { core, lines, ports };
}

/** 打断时内核必须落地的四件事，顺序就是 `bargeInTransition` 的声明顺序 */
const BARGE_IN_PORTS = [
  'stopDeviceAudio',
  'invalidateTurn:bargeIn:1/0',
  'abortEngine:barge_in',
  'settleTurn:1/0',
];

/** 把会话推到 speaking：开一轮 + 首块音频。 */
function toSpeaking(core: SessionCore): void {
  const ticket = core.fsm.beginTurn();
  assert.ok(ticket);
  core.fsm.audioStarted(ticket);
  assert.equal(core.phase, 'speaking');
}

test('唤醒词：不过成句合并', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '小爱同学。' }), [
    { type: 'drop', why: 'wake-word' },
  ]);
});

test('正常一句话：交给合并器', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '今天天气怎么样' }), [
    { type: 'assemble', text: '今天天气怎么样' },
  ]);
});

test('旁听反馈：不成轮', () => {
  const { core } = newCore();
  assert.deepEqual(core.dispatch({ type: 'utterance', text: '嗯嗯，我知道了我知道了。' }), [
    { type: 'drop', why: 'backchannel' },
  ]);
  assert.equal(core.turn, 0);
});

test('定稿一句话：开一轮并带上票据', () => {
  const { core } = newCore();
  const effects = core.dispatch({ type: 'utterance', text: '帮我看看这个' });
  assert.equal(effects.length, 1);
  assert.equal(effects[0]?.type, 'turn');
  assert.equal(effects[0]?.type === 'turn' && effects[0].text, '帮我看看这个');
});

test('插话只在 speaking 成立', () => {
  const { core, ports } = newWiredCore();
  // listening：不算插话
  assert.deepEqual(core.dispatch({ type: 'partial', text: '等一下' }), []);
  assert.deepEqual(ports, [], '不在 speaking 时内核一条意图都不发');

  toSpeaking(core);
  assert.deepEqual(
    callOps(core.dispatch({ type: 'partial', text: '等一下' })),
    [],
    '停播由内核意图执行，CoreEffect 里不再有一份 audio.stop',
  );
  assert.deepEqual(ports, BARGE_IN_PORTS, '打断的四件事真的落到了 KernelPorts');
  assert.equal(core.phase, 'listening');
});

test('太短的中间结果不触发插话', () => {
  const { core } = newCore();
  toSpeaking(core);
  assert.deepEqual(core.dispatch({ type: 'partial', text: '嗯' }), []);
  assert.equal(core.phase, 'speaking');
});

test('播报中的定稿也要打断 —— 短促插话常常只有定稿、没有中间结果', () => {
  const { core, ports } = newWiredCore();
  toSpeaking(core);
  // 真机日志：「句 3 "退休。"」在 speaking 里到达，只派发 assemble 不打断，
  // 于是要等到下一句的部分结果才停 —— 表现为"有时候打断要等好几秒"。
  const effects = core.dispatch({ type: 'sentence', text: '退下' });
  assert.deepEqual(callOps(effects), ['assemble'], '定稿只进合并器；停播是内核意图的事');
  assert.deepEqual(ports, BARGE_IN_PORTS, '定稿打断的副作用同样只由内核执行一次');
  assert.equal(core.phase, 'listening');
});

test('旁听反馈的定稿不打断播放 —— 和中间结果同一套判据', () => {
  const { core } = newCore();
  toSpeaking(core);
  // 真机日志：21:17:45 `插话「嗯。」→ 代次 4`，把正在播的回复打断了；
  // 而同一个「嗯」作为中间结果什么都没做。ASR 加不加句号不该改变行为。
  const effects = core.dispatch({ type: 'sentence', text: '嗯。' });
  assert.deepEqual(callOps(effects), ['assemble'], '只攒进一轮，不停播');
  assert.equal(core.phase, 'speaking', '仍在播报');
});

test('不在播报时，定稿照常只是攒进一轮（不要多打一枪停止）', () => {  const { core } = newCore();
  // listening 状态：没有音频在放，"停播"是空动作
  assert.deepEqual(callOps(core.dispatch({ type: 'sentence', text: '帮我看看这个' })), ['assemble']);
});

// ------------------------------------------------- 单一因果屏障（commitSeq 一路到底）

test('因果屏障：开轮前录的中间结果不打断（speaking）', () => {
  const { core, ports } = newWiredCore(2);
  toSpeaking(core);
  // commitSeq=2 就是开轮时锁存的水位线：这段音频全部录在开轮之前，
  // 它只可能是判停抢跑后补回来的后半句，不是用户在插话。
  assert.deepEqual(core.dispatch({ type: 'partial', text: '等一下', commitSeq: 2 }), [
    { type: 'drop', why: 'pre-turn' },
  ]);
  assert.equal(core.phase, 'speaking', '旧段不构成插话');
  assert.deepEqual(ports, [], '一条内核意图都不该发（更不许停音频）');
});

test('因果屏障：开轮前录的中间结果也不开轮（thinking）', () => {
  const { core, ports } = newWiredCore(2);
  assert.ok(core.fsm.beginTurn());
  assert.equal(core.phase, 'thinking');
  assert.deepEqual(core.dispatch({ type: 'partial', text: '等一下', commitSeq: 1 }), [
    { type: 'drop', why: 'pre-turn' },
  ]);
  assert.equal(core.phase, 'thinking', '相位不动');
  assert.deepEqual(ports, []);
});

test('因果屏障：开轮前录的定稿不打断、也不交给合并器（speaking）', () => {
  const { core, ports } = newWiredCore(2);
  toSpeaking(core);
  const effects = core.dispatch({ type: 'sentence', text: '后半句', commitSeq: 2 });
  assert.deepEqual(effects, [{ type: 'drop', why: 'pre-turn' }], '不返回 assemble');
  assert.equal(core.phase, 'speaking', '相位不动');
  assert.deepEqual(ports, [], '一条内核意图都不该发');
});

test('因果屏障：开轮前录的定稿也不开轮（thinking）', () => {
  const { core, ports } = newWiredCore(2);
  assert.ok(core.fsm.beginTurn());
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '后半句', commitSeq: 2 }), [
    { type: 'drop', why: 'pre-turn' },
  ]);
  assert.equal(core.phase, 'thinking');
  assert.deepEqual(ports, []);
});

test('因果屏障：开轮后的新中间结果构成插话（speaking）', () => {
  const { core, ports } = newWiredCore(2);
  toSpeaking(core);
  assert.deepEqual(core.dispatch({ type: 'partial', text: '等一下', commitSeq: 3 }), []);
  assert.deepEqual(ports, BARGE_IN_PORTS, '四件事都真的执行了');
  assert.equal(core.phase, 'listening');
  assert.equal(core.fsm.gen, 1, '代次 +1：排队中的轮次从此作废');
});

test('因果屏障：开轮后的新定稿既打断又进合并器（speaking）', () => {
  const { core, ports } = newWiredCore(2);
  toSpeaking(core);
  const effects = core.dispatch({ type: 'sentence', text: '退下', commitSeq: 3 });
  assert.deepEqual(callOps(effects), ['assemble']);
  assert.deepEqual(ports, BARGE_IN_PORTS);
  assert.equal(core.phase, 'listening');
});

test('因果屏障：服务端 VAD 不给 commitSeq 时放行（宁可放过一次插话）', () => {
  const partial = newWiredCore(2);
  toSpeaking(partial.core);
  assert.deepEqual(partial.core.dispatch({ type: 'partial', text: '等一下' }), []);
  assert.deepEqual(partial.ports, BARGE_IN_PORTS, '没有出生证就不猜，照常打断');
  assert.equal(partial.core.phase, 'listening');

  const sentence = newWiredCore(2);
  toSpeaking(sentence.core);
  assert.deepEqual(callOps(sentence.core.dispatch({ type: 'sentence', text: '退下' })), ['assemble']);
  assert.deepEqual(sentence.ports, BARGE_IN_PORTS);
  assert.equal(sentence.core.phase, 'listening');
});

test('没人等的图：起一轮识图', () => {
  const { core } = newCore();
  const effects = core.dispatch({ type: 'image', jpeg: Buffer.from([1, 2, 3]) });
  assert.equal(effects.length, 1);
  const effect = effects[0];
  assert.ok(effect && effect.type === 'turn');
  assert.equal(effect.text, '这张图里有什么？');
  assert.equal(effect.image?.mimeType, 'image/jpeg');
  assert.equal(effect.image?.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('模型要求结束：告别语播完才挂断', () => {
  const { core } = newCore();
  toSpeaking(core);
  assert.deepEqual(callOps(core.dispatch({ type: 'endRequested' })), ['call:listen.stop']); // 先停采集
  const ticket = core.fsm.ticket();
  core.fsm.audioDone(ticket);
  assert.equal(core.phase, 'ending');
  assert.deepEqual(callOps(core.dispatch({ type: 'turnFinished' })), ['end']);
});

test('空闲时要求结束：停采集 + 立刻挂断', () => {
  const { core } = newCore();
  assert.deepEqual(callOps(core.dispatch({ type: 'endRequested' })), [
    'call:listen.stop',
    'end',
  ]);
  assert.equal(core.phase, 'ending');
});

test('收尾后到达的识别结果不再开新一轮', () => {
  const { core } = newCore();
  toSpeaking(core);
  core.dispatch({ type: 'endRequested' });
  assert.deepEqual(core.dispatch({ type: 'utterance', text: '等等我还有事' }), [
    { type: 'drop', why: 'ending' },
  ]);
});

test('连接结束是吸收态', () => {
  const { core } = newCore();
  core.dispatch({ type: 'closed' });
  assert.equal(core.phase, 'closed');
  core.dispatch({ type: 'endRequested' });
  assert.equal(core.phase, 'closed');
});

// ---------------------------------------------------------------- 高清照流程

test('说「看清细节」：要一张 detail，进 awaiting_shot，不直接开轮', () => {
  const { core } = newCore();
  const effects = core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  assert.deepEqual(effects.map((e) => e.type), ['capture']);
  const capture = effects[0];
  assert.ok(capture && capture.type === 'capture');
  assert.equal(capture.request.intent, 'detail');
  assert.equal(capture.request.needsUser, true);
  assert.equal(typeof capture.request.id, 'string');
  assert.equal(core.phase, 'awaiting_shot');
  // 还没开轮：等图期间说话不该被票据挡住
  assert.equal(core.turn, 0);
});

test('拿到高清图：开一轮，图挂在 text 后面一起交给模型', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  const jpeg = Buffer.from([1, 2, 3]);
  const effects = core.dispatch({ type: 'shotResult', ok: true, jpeg });
  assert.equal(effects.length, 1);
  const turn = effects[0];
  assert.equal(turn?.type, 'turn');
  assert.ok(turn?.type === 'turn' && turn.text.startsWith('看看上面写的什么字'));
  assert.ok(turn?.type === 'turn' && turn.text.includes('不要再调用拍照工具'));
  assert.equal(turn?.type === 'turn' && turn.image?.mimeType, 'image/jpeg');
  assert.equal(turn?.type === 'turn' && turn.image?.data, jpeg.toString('base64'));
});

test('没拿到高清图：照常开一轮，并转述设备给的原因', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  const effects = core.dispatch({
    type: 'shotResult',
    ok: false,
    failure: { code: 'timeout', say: '需要先按一下眼镜上的快门' },
  });
  const turn = effects[0];
  assert.equal(turn?.type, 'turn');
  assert.equal(turn?.type === 'turn' && turn.image, undefined);
  assert.ok(turn?.type === 'turn' && turn.text.includes('按一下眼镜上的快门'));
});

test('没拿到高清图且设备没给原因：只报 code，不猜原因', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  const turn = core.dispatch({ type: 'shotResult', ok: false, failure: { code: 'failed' } })[0];
  assert.ok(turn?.type === 'turn' && turn.text.includes('failed'));
  assert.ok(turn?.type === 'turn' && !turn.text.includes('快门'));
});

test('拍照被取消：不生成回答轮', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  assert.deepEqual(
    core.dispatch({ type: 'shotResult', ok: false, failure: { code: 'cancelled' } }),
    [{ type: 'drop', why: 'shot-cancelled' }],
  );
});

test('等快门时又改主意：取消拍照、打断旁白，再开新一轮', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  const effects = core.dispatch({ type: 'utterance', text: '算了，今天天气怎么样' });
  assert.deepEqual(callOps(effects), ['call:capture.cancel', 'call:audio.stop', 'turn']);
  assert.equal(core.phase, 'listening');
});

test('等快门时又要高清：取消旧的，重新等', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  const effects = core.dispatch({ type: 'utterance', text: '算了，凑近看清楚点' });
  assert.deepEqual(callOps(effects), ['call:capture.cancel', 'call:audio.stop', 'capture']);
  assert.equal(core.phase, 'awaiting_shot');
});

test('等快门时收尾：取消拍照 + 停采集 + 立刻挂断', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  const effects = core.dispatch({ type: 'endRequested' });
  assert.deepEqual(
    callOps(effects),
    ['call:capture.cancel', 'call:audio.stop', 'call:listen.stop', 'end'],
  );
  assert.equal(core.phase, 'ending');
});

test('拍照结果迟到：没有待处理的句子就丢弃', () => {
  const { core } = newCore();
  const effects = core.dispatch({ type: 'shotResult', ok: true, jpeg: Buffer.from([1]) });
  assert.deepEqual(effects, [{ type: 'drop', why: 'shot-stale' }]);
  assert.equal(core.phase, 'listening');
});

test('等高清图期间收到低清回图：丢掉，不另起一轮', () => {
  const { core } = newCore();
  core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  assert.deepEqual(core.dispatch({ type: 'image', jpeg: Buffer.from([1]) }), [
    { type: 'drop', why: 'spp-during-shot' },
  ]);
  assert.equal(core.phase, 'awaiting_shot');
});

// ---------------------------------------------------------------- 能力决定行为

test('v1 基线：唤醒词不过滤（忽略短语来自能力）', () => {
  const { core } = newCore(V1_BASELINE);
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '小爱同学。' }), [
    { type: 'assemble', text: '小爱同学。' },
  ]);
});

test('v1 基线：没有 detail 意图，「看清细节」照常开一轮', () => {
  const { core } = newCore(V1_BASELINE);
  const effects = core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  assert.deepEqual(effects.map((e) => e.type), ['turn']);
  assert.equal(core.phase, 'listening');
});

test('自报 detail 不用人动手：直接拍', () => {
  const { core, lines } = newCore(SELF_REPORTED);
  const effects = core.dispatch({ type: 'utterance', text: '看看上面写的什么字' });
  assert.deepEqual(effects.map((e) => e.type), ['capture']);
  const capture = effects[0];
  assert.ok(capture && capture.type === 'capture');
  assert.equal(capture.request.intent, 'detail');
  assert.equal(capture.request.needsUser, false);
  assert.equal(core.phase, 'awaiting_shot');
  assert.ok(lines.some((line) => line.includes('直接拍')));
});

test('自报没有忽略短语：「小爱同学」不会被丢弃', () => {
  const { core } = newCore(SELF_REPORTED);
  assert.deepEqual(core.dispatch({ type: 'sentence', text: '小爱同学。' }), [
    { type: 'assemble', text: '小爱同学。' },
  ]);
});
