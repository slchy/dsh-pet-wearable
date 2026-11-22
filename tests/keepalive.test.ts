/**
 * 保活循环的**判断**：什么时候该发、什么时候不该发。
 *
 * 全部跑在假时钟上 —— 真等三小时的测试没人会跑，也没人敢改。
 * 这些断言防的是三件真会出的事：
 *  1. 有活儿在飞的时候插一脚（那条消息会混进用户正在说的那一轮）；
 *  2. ping 抛错以后每个 tick 重试一次，把日志刷满；
 *  3. `setAnnouncer` 包丢了 —— 后台任务汇报从此播不出来，而且**不报错**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KEEPALIVE_PROMPT,
  newActivityState,
  startKeepalive,
  trackActivity,
  type KeepaliveClock,
} from '../src/keepalive.ts';
import type { AgentProvider, AgentReplyView } from '../src/providers.ts';

/** 手动推进的时钟。 */
class FakeClock implements KeepaliveClock {
  private t = 0;
  private seq = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.seq;
    this.seq += 1;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = due.at;
      due.fn();
      // 让 ping 的 finally 排到队，再判下一拍
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    this.t = target;
  }
}

const MINUTE = 60_000;

function harness(options: { busy?: boolean; fail?: boolean } = {}) {
  const clock = new FakeClock();
  let last = 0;
  let busy = options.busy ?? false;
  let pings = 0;
  const logs: string[] = [];
  const stop = startKeepalive({
    clock,
    intervalMs: 180 * MINUTE,
    tickMs: MINUTE,
    idleFor: () => clock.now() - last,
    isBusy: () => busy,
    ping: async () => {
      pings += 1;
      if (options.fail) throw new Error('上游 500');
      last = clock.now();
    },
    log: (line) => { logs.push(line); },
  });
  return {
    clock,
    logs,
    stop,
    pingCount: () => pings,
    touch: () => { last = clock.now(); },
    setBusy: (value: boolean) => { busy = value; },
  };
}

test('空闲没到阈值就不发', async () => {
  const h = harness();
  await h.clock.advance(179 * MINUTE);
  assert.equal(h.pingCount(), 0);
  h.stop();
});

test('空闲超过阈值发一次，然后按周期再来', async () => {
  const h = harness();
  await h.clock.advance(181 * MINUTE);
  assert.equal(h.pingCount(), 1, '过了 180 分钟应当发一次');
  await h.clock.advance(178 * MINUTE);
  assert.equal(h.pingCount(), 1, '不到下一个周期不该再发');
  await h.clock.advance(5 * MINUTE);
  assert.equal(h.pingCount(), 2);
  h.stop();
});

test('有活儿在飞时跳过', async () => {
  const h = harness({ busy: true });
  await h.clock.advance(300 * MINUTE);
  assert.equal(h.pingCount(), 0, '用户在说话时绝不插队');
  h.setBusy(false);
  await h.clock.advance(2 * MINUTE);
  assert.equal(h.pingCount(), 1, '忙完这一拍就该补上');
  h.stop();
});

test('ping 失败不会每个 tick 重试', async () => {
  const h = harness({ fail: true });
  await h.clock.advance(185 * MINUTE);
  assert.equal(h.pingCount(), 1);
  await h.clock.advance(2 * MINUTE);
  assert.equal(h.pingCount(), 1, '失败后要等下一个完整周期，否则日志会被刷满');
  assert.ok(h.logs.some((line) => line.includes('上游 500')), '失败要有日志');
  h.stop();
});

test('intervalMs <= 0 等于关闭', async () => {
  const clock = new FakeClock();
  let pings = 0;
  const stop = startKeepalive({
    clock,
    intervalMs: 0,
    tickMs: MINUTE,
    idleFor: () => clock.now(),
    isBusy: () => false,
    ping: async () => { pings += 1; },
  });
  await clock.advance(24 * 60 * MINUTE);
  assert.equal(pings, 0);
  stop();
});

test('停止以后不再触发', async () => {
  const h = harness();
  h.stop();
  await h.clock.advance(300 * MINUTE);
  assert.equal(h.pingCount(), 0);
});

test('trackActivity 记录在飞数与最后活动时间', async () => {
  let now = 1_000;
  // 用持有对象而不是裸变量：TS 的控制流会把「只在回调里被赋值」的 let 收窄成 null，
  // 于是 `release?.()` 报 "never has no call signatures"
  const gate: { release?: () => void } = {};
  const inner: AgentProvider = {
    name: 'fake',
    sessionId: 'session-x',
    reply: async (): Promise<AgentReplyView> => {
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return { text: '[平静]好' } as AgentReplyView;
    },
  };
  const state = newActivityState(now);
  const wrapped = trackActivity(inner, state, () => now);

  assert.equal(wrapped.name, 'fake');
  assert.equal(wrapped.sessionId, 'session-x');

  const pending = wrapped.reply('你好');
  assert.equal(state.inflight, 1, '发出去了就算在飞');
  now = 5_000;
  gate.release?.();
  await pending;
  assert.equal(state.inflight, 0);
  assert.equal(state.last, 5_000, '结束时刻要记下来');
});

test('trackActivity 原样透传 setAnnouncer', () => {
  const calls: string[] = [];
  const inner: AgentProvider = {
    name: 'fake',
    reply: async () => ({ text: '' }) as AgentReplyView,
    setAnnouncer: (cb) => { calls.push(cb === null ? 'null' : 'set'); },
  };
  const wrapped = trackActivity(inner, newActivityState(0));
  assert.ok(wrapped.setAnnouncer, '漏了它，后台汇报就再也播不出来');
  wrapped.setAnnouncer?.(() => {});
  assert.deepEqual(calls, ['set']);

  const plain: AgentProvider = { name: 'plain', reply: async () => ({ text: '' }) as AgentReplyView };
  assert.equal(trackActivity(plain, newActivityState(0)).setAnnouncer, undefined);
});

test('trackActivity 原样透传 attachLiveSink', () => {
  const calls: string[] = [];
  const inner: AgentProvider = {
    name: 'fake',
    reply: async () => ({ text: '' }) as AgentReplyView,
    attachLiveSink: (sink) => { calls.push(sink === null ? 'null' : 'set'); },
  };
  const wrapped = trackActivity(inner, newActivityState(0));
  assert.ok(wrapped.attachLiveSink, '漏了它，流式增量没人接，每轮都退回整段合成');
  wrapped.attachLiveSink?.(() => {});
  wrapped.attachLiveSink?.(null);
  assert.deepEqual(calls, ['set', 'null']);

  const plain: AgentProvider = { name: 'plain', reply: async () => ({ text: '' }) as AgentReplyView };
  assert.equal(trackActivity(plain, newActivityState(0)).attachLiveSink, undefined);
});

test('保活输入不像用户的话', () => {
  assert.ok(!KEEPALIVE_PROMPT.includes('？'), '别写成一问一答，模型会当成真实对话去回应');
});

test('trackActivity 透传**全部**可选能力（漏一个就是静默降级，不报错）', () => {
  // 这个列表就是 `AgentProvider` 上的可选能力清单。
  // 加新能力时**这里也要加**——否则线上表现是"那个功能就是不生效"，从现象看不出来。
  // （2026-11-23：`attachAudioLane` / `willServeAudio` / `noteServedTurn` 漏了，
  //  omni 一晚上 4 轮全部静默退回文本快车道。）
  const optional = [
    'setAnnouncer',
    'attachLiveSink',
    'cancelTurn',
    'setDelegateHook',
    'interruptTurn',
    'taskStatus',
    'prefetch',
    'speculatePartial',
    'attachAudioLane',
    'willServeAudio',
    'noteServedTurn',
    // 委派轮回注：漏了 → omni 永远不知道 dsh 答了什么，下一轮顺着追问就答非所问。
    // 同样是**静默**的：没有它 omni 照样能答，只是答的内容是错的。
    'injectAnsweredTurn',
  ] as const;

  const inner = { name: 'fake', reply: async () => ({ text: '', speech: '' }) } as Record<string, unknown>;
  for (const key of optional) {
    inner[key] = () => {};
  }
  const wrapped = trackActivity(inner as never, newActivityState(0)) as unknown as Record<string, unknown>;
  const missing = optional.filter((key) => typeof wrapped[key] !== 'function');
  assert.deepEqual(missing, [], `这些可选能力没被透传：${missing.join(', ')}`);
});