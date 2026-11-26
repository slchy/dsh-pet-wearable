/**
 * `FastVoiceEngine` 的跨实现契约：**同一个泵接口，五条实现必须同构**。
 *
 * 参数化覆盖：
 *  1. `LiveVoiceEngine`（omni 直出）
 *  2. `CascadeVoiceEngine`（LLM → TTS 的端口版）
 *  3. `CascadeTurnEngine`（`new CascadeAgent(...).toEngine(tts)`，生产级联引擎）
 *  4. `AgentEngineAdapter`（旧装配兜底）
 *  5. `LiveOrchestrator` 的 `toEngine()`（生产 Pure Live 引擎）
 *
 * 每个实现都跑同一组断言：预先 abort 零事件、中途 abort 不再产事件、正常通路
 * 同构（合法词汇 + done 收尾 + 音频非空）、`abortSpeculation` 幂等、以及
 * 「第一轮中止后第二轮不串残留」。
 *
 * 全部用假车道 / 假 TTS / 假 agent，零网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineEvent, FastVoiceEngine, TurnInput } from '../../src/engine-contract.ts';
import { AgentEngineAdapter } from '../../src/engines/agent-engine-adapter.ts';
import { CascadeVoiceEngine } from '../../src/engines/cascade-voice-engine.ts';
import { LiveVoiceEngine } from '../../src/engines/live-voice-engine.ts';
import { CascadeAgent } from '../../src/pipelines/cascade-agent.ts';
import { LiveOrchestrator } from '../../src/pipelines/live-orchestrator.ts';
import { silentTts, type AgentProvider, type TtsProvider } from '../../src/providers.ts';

const TURN: TurnInput = {
  text: '你好呀',
  no: 1,
  baseCommitSeq: 0,
  startedAtMs: 0,
  hasImage: false,
};

const VOCABULARY = new Set(['audio', 'text', 'delegate', 'meta', 'done']);

interface Rig {
  readonly engine: FastVoiceEngine;
  /** 第二轮换成干净的输入，并停止阻塞（中止测试用） */
  setRound(round: number): void;
  /** 放开当前所有阻塞中的音频源（中止后调用，别让生成器挂着） */
  release(): void;
}

interface EngineCase {
  readonly name: string;
  /** `blocking=true` 时，第一块音频之前/之后会挂住，直到 `release()` */
  make(blocking: boolean): Rig;
}

function makeHold(): { wait(): Promise<void>; release(): void } {
  let releases: Array<() => void> = [];
  return {
    wait: () => new Promise<void>((resolve) => { releases.push(resolve); }),
    release: () => {
      const waiters = releases;
      releases = [];
      for (const wake of waiters) wake();
    },
  };
}

function collect(source: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  return (async () => {
    for await (const event of source) out.push(event);
    return out;
  })();
}

function lastDone(events: readonly EngineEvent[]): Extract<EngineEvent, { type: 'done' }> {
  const last = events[events.length - 1];
  assert.ok(last !== undefined && last.type === 'done', '最后一条必须是 done');
  return last;
}

function audioOf(events: readonly EngineEvent[]): Buffer[] {
  return events
    .filter((event): event is Extract<EngineEvent, { type: 'audio' }> => event.type === 'audio')
    .map((event) => event.pcm);
}

/** 一条会按 round 变换音频字节的 TTS；`blocking` 时第一块之后挂住 */
function roundTts(
  round: () => number,
  blocked: () => boolean,
  hold: ReturnType<typeof makeHold>,
): TtsProvider {
  return {
    name: 'contract-tts',
    sampleRate: 24_000,
    async* synthesize() {
      yield Buffer.from([round()]);
      if (blocked()) await hold.wait();
      yield Buffer.from([round()]);
    },
    async* synthesizeStream(chunks) {
      for await (const chunk of chunks) {
        void chunk;
        yield Buffer.from([round()]);
      }
    },
  };
}

/** 只有整段 `synthesize` 的 TTS：强制 `CascadeTurnEngine` / 适配器走逐句泵 */
function roundWholeTts(
  round: () => number,
  blocked: () => boolean,
  hold: ReturnType<typeof makeHold>,
): TtsProvider {
  return {
    name: 'contract-whole-tts',
    sampleRate: 24_000,
    async* synthesize() {
      yield Buffer.from([round()]);
      if (blocked()) await hold.wait();
      yield Buffer.from([round()]);
    },
  };
}

const CASES: readonly EngineCase[] = [
  {
    name: 'LiveVoiceEngine',
    make(blocking): Rig {
      let round = 1;
      let blocked = blocking;
      const hold = makeHold();
      const lane = {
        willServe: () => true,
        claim: () => ({
          sampleRate: 24_000,
          transcript: () => `第${round}句`,
          chunks: (async function* generate() {
            if (blocked) await hold.wait();
            yield Buffer.from([round]);
            yield Buffer.from([round]);
          })(),
          delegateReason: () => null,
        }),
        discard: () => {},
        interrupt: () => {},
      };
      return {
        engine: new LiveVoiceEngine(lane),
        setRound(next) { round = next; blocked = false; },
        release: hold.release,
      };
    },
  },
  {
    name: 'CascadeVoiceEngine',
    make(blocking): Rig {
      let round = 1;
      let blocked = blocking;
      const hold = makeHold();
      const tts = roundTts(() => round, () => blocked, hold);
      const engine = new CascadeVoiceEngine({
        isReady: () => true,
        tts,
        ask: async (_turn, emit) => {
          emit(`第${round}句`);
          if (blocked) await hold.wait();
          return { text: `第${round}句`, speech: `第${round}句` };
        },
      });
      return {
        engine,
        setRound(next) { round = next; blocked = false; },
        release: hold.release,
      };
    },
  },
  {
    name: 'CascadeTurnEngine',
    make(blocking): Rig {
      let round = 1;
      let blocked = blocking;
      const hold = makeHold();
      const tts = roundWholeTts(() => round, () => blocked, hold);
      const inner: AgentProvider = {
        name: 'inner',
        reply: async () => ({ text: `第${round}句`, speech: `第${round}句` }),
      };
      const agent = new CascadeAgent({
        inner,
        apiKey: '',
        log: () => {},
        now: () => 1000,
      });
      return {
        engine: agent.toEngine(tts),
        setRound(next) { round = next; blocked = false; },
        release: hold.release,
      };
    },
  },
  {
    name: 'AgentEngineAdapter',
    make(blocking): Rig {
      let round = 1;
      let blocked = blocking;
      const hold = makeHold();
      const tts = roundWholeTts(() => round, () => blocked, hold);
      const inner: AgentProvider = {
        name: 'inner',
        reply: async () => ({ text: `第${round}句`, speech: `第${round}句` }),
      };
      const engine = new AgentEngineAdapter({
        agent: inner,
        tts,
        clock: () => 1000,
        log: () => {},
      });
      return {
        engine,
        setRound(next) { round = next; blocked = false; },
        release: hold.release,
      };
    },
  },
  {
    name: 'LiveOrchestrator',
    make(blocking): Rig {
      let round = 1;
      let blocked = blocking;
      const hold = makeHold();
      const inner: AgentProvider = {
        name: 'inner',
        reply: async () => ({ text: 'dsh 兜底', speech: 'dsh 兜底' }),
      };
      const lane = {
        willServe: () => true,
        claim: () => ({
          sampleRate: 24_000,
          transcript: () => `第${round}句`,
          chunks: (async function* generate() {
            if (blocked) await hold.wait();
            yield Buffer.from([round]);
            yield Buffer.from([round]);
          })(),
          delegateReason: () => null,
        }),
        discard: () => {},
        interrupt: () => {},
        feed: () => {},
      };
      const host = new LiveOrchestrator({
        inner,
        tts: silentTts(24_000),
        log: () => {},
      });
      host.attachAudioLane(lane);
      return {
        engine: host.toEngine(),
        setRound(next) { round = next; blocked = false; },
        release: hold.release,
      };
    },
  },
];

for (const entry of CASES) {
  test(`${entry.name}：预先 abort 产出 0 条事件并正常结束`, async () => {
    const rig = entry.make(false);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(rig.engine.respond(TURN, controller.signal));
    assert.deepEqual(events, []);
  });

  test(`${entry.name}：正常通路同构（合法词汇、done 收尾、有音频）`, async () => {
    const rig = entry.make(false);
    const events = await collect(rig.engine.respond(TURN, new AbortController().signal));

    for (const event of events) {
      assert.ok(VOCABULARY.has(event.type), `不认识的事件类型：${event.type}`);
    }
    const done = lastDone(events);
    assert.ok(done.fullText.trim() !== '', 'fullText 不能为空');
    const audio = audioOf(events);
    assert.ok(audio.length > 0, '正常通路必须产出音频');
    assert.ok(audio.every((chunk) => chunk.length > 0), '音频块长度必须 > 0');
  });

  test(`${entry.name}：流中途 abort 后不再产出任何事件`, async () => {
    const rig = entry.make(true);
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => { rig.release(); }, { once: true });

    const events: EngineEvent[] = [];
    for await (const event of rig.engine.respond(TURN, controller.signal)) {
      events.push(event);
      controller.abort();
    }
    assert.equal(events.length, 1, `abort 之后不许再产出事件（收到：${events.map((e) => e.type).join(',')}）`);
  });

  test(`${entry.name}：abortSpeculation 幂等且不抛错`, () => {
    const rig = entry.make(false);
    for (let i = 0; i < 3; i += 1) {
      assert.doesNotThrow(() => { rig.engine.abortSpeculation('barge_in'); });
      assert.doesNotThrow(() => { rig.engine.abortSpeculation('delegated'); });
      assert.doesNotThrow(() => { rig.engine.abortSpeculation('superseded'); });
    }
  });

  test(`${entry.name}：第一轮中止后第二轮拿到自己的干净回答`, async () => {
    const rig = entry.make(true);
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => { rig.release(); }, { once: true });

    let first = true;
    for await (const event of rig.engine.respond(TURN, controller.signal)) {
      if (first) {
        first = false;
        controller.abort();
      }
    }

    rig.setRound(2);
    const second = await collect(rig.engine.respond(
      { ...TURN, no: 2 },
      new AbortController().signal,
    ));
    const done = lastDone(second);
    assert.ok(done.fullText.includes('第2句'), `第二轮拿到了：${done.fullText}`);
    assert.ok(!done.fullText.includes('第1句'), '第一轮的文本不许串进来');

    const audio = audioOf(second);
    assert.ok(audio.length > 0);
    assert.ok(
      audio.every((chunk) => chunk.length === 1 && chunk[0] === 2),
      `第二轮音频必须是自己的：${audio.map((chunk) => [...chunk].join('')).join(' | ')}`,
    );
  });
}
