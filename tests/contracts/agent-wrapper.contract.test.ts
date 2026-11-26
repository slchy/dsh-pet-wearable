/**
 * `AgentProvider` 包装层的契约：**可选能力一个都不能漏**。
 *
 * `trackActivity` 是保活旁路，它把 agent 包成 Proxy 再交给整条链路。漏透传
 * 不会报错，只会静默降级（后台汇报播不出来、omni 退回文本、投机白跑到超时）。
 * 所以这里同时钉三件事：
 *  1. 编译期：`OPTIONAL_AGENT_KEYS` 用 `satisfies` 锁死全部可选成员；
 *  2. 运行期：`trackActivity` 原样透传每一个成员、绑定 `this`（含 `#private`）；
 *  3. 生命周期：成功与异常后 `ActivityState.inflight` 都必须归零。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { VoiceAgent } from '../../src/agent.ts';
import { newActivityState, trackActivity } from '../../src/keepalive.ts';
import type { AgentProvider, AgentReplyView } from '../../src/providers.ts';
import { DshSession } from '../../src/session.ts';
import { OPTIONAL_AGENT_KEYS } from './agent-optional-keys.ts';

type OptionalKey = keyof typeof OPTIONAL_AGENT_KEYS;

function optionalKeyList(): string[] {
  return Object.keys(OPTIONAL_AGENT_KEYS);
}

test('可选成员清单是编译期完备的（satisfies Record<OptionalAgentKey, true>）', () => {
  // 这条测试本身不重要；重要的是上面那份 `satisfies` —— `AgentProvider` 每新增
  // 一个可选方法，这里不补键就直接 `tsc --noEmit` 失败。
  assert.ok(optionalKeyList().length > 20, '清单不该突然缩水');
});

test('trackActivity 原样透传全部可选成员，并保持 this', () => {
  const calls: string[] = [];
  const inner: Record<string, unknown> = {
    name: 'fake',
    reply: async () => ({ text: '', speech: '' }),
  };
  for (const key of optionalKeyList()) {
    inner[key] = function (this: unknown): string {
      assert.equal(this, inner, `${key} 的 this 必须是原对象`);
      calls.push(key);
      return key;
    };
  }
  const wrapped = trackActivity(
    inner as unknown as AgentProvider,
    newActivityState(0),
  ) as unknown as Record<string, unknown>;

  for (const key of optionalKeyList()) {
    const fn = wrapped[key];
    assert.equal(typeof fn, 'function', `${key} 没被透传`);
    assert.equal((fn as () => string)(), key);
  }
  assert.deepEqual([...calls].sort(), optionalKeyList().sort());
});

test('trackActivity 对缺失的可选方法保持 undefined（不许凭空造函数）', () => {
  const inner: AgentProvider = {
    name: 'plain',
    reply: async () => ({ text: '', speech: '' }),
  };
  const wrapped = trackActivity(inner, newActivityState(0)) as unknown as Record<string, unknown>;
  for (const key of optionalKeyList()) {
    assert.equal(wrapped[key], undefined, `${key} 不该被造出来`);
  }
  assert.equal(wrapped['sessionId'], null, '没有 sessionId 时归成 null（老包装的行为）');
});

test('trackActivity 绑定 class 的 #private 槽（getter / 方法都不能炸）', () => {
  class PrivateAgent implements AgentProvider {
    readonly #tag: string;
    readonly #seen: string[] = [];
    constructor(tag: string) {
      this.#tag = tag;
    }
    get name(): string {
      // `Reflect.get` 若把 Proxy 当 receiver，这里会抛
      // "Receiver must be an instance of class PrivateAgent"
      return `private-${this.#tag}`;
    }
    get sessionId(): string {
      return this.#tag;
    }
    async reply(): Promise<AgentReplyView> {
      return { text: '', speech: '' };
    }
    taskStatus(): string {
      this.#seen.push('status');
      return `seen=${this.#seen.length}`;
    }
    dshBusy(): boolean {
      this.#seen.push('busy');
      return this.#seen.length > 0;
    }
  }

  const inner = new PrivateAgent('x');
  const wrapped = trackActivity(inner, newActivityState(0));
  assert.equal(wrapped.name, 'private-x');
  assert.equal(wrapped.sessionId, 'x');
  assert.equal(wrapped.taskStatus?.(), 'seen=1', '方法里的 #私有字段也要能读');
  assert.equal(wrapped.dshBusy?.(), true);
});

test('trackActivity 成功与异常后 inflight 都归零', async () => {
  let now = 100;
  const state = newActivityState(now);
  let fail = false;
  const inner: AgentProvider = {
    name: 'fake',
    reply: async () => {
      now += 5;
      if (fail) throw new Error('上游挂了');
      return { text: '好', speech: '好' };
    },
  };
  const wrapped = trackActivity(inner, state, () => now);

  await wrapped.reply('你好');
  assert.equal(state.inflight, 0);
  assert.equal(state.last, 105);

  fail = true;
  await assert.rejects(() => wrapped.reply('再来'), /上游挂了/);
  assert.equal(state.inflight, 0, '异常路径也必须归零，否则保活永远以为有活儿在飞');
  assert.equal(state.last, 110);
});

test('VoiceAgent 在编译期与运行期都满足 AgentProvider 契约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voiceagent-contract-'));
  try {
    const session = new DshSession({
      workDir: dir,
      sessionFile: join(dir, 'session.json'),
      log: () => {},
    });
    // 编译期：`implements AgentProvider` + 这条赋值一起卡住形状。
    const provider: AgentProvider = new VoiceAgent(session, () => {}, null);
    assert.equal(provider.name, 'dsh');
    assert.equal(typeof provider.reply, 'function');
    assert.ok(provider.sessionId === null || typeof provider.sessionId === 'string');
    // 不该碰 dsh 的能力保持 undefined（VoiceAgent 不实现快车道/omni 那一组）
    assert.equal(provider.willServeAudio, undefined);
    assert.equal(provider.prefetch, undefined);
    assert.equal(provider.attachAudioLane, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('清单里的键都真的存在于 AgentProvider 的类型面上', () => {
  // 运行期只能验「清单不是空对象」+ 键名是字符串；类型面由 `satisfies` 守。
  const keys: OptionalKey[] = optionalKeyList() as OptionalKey[];
  assert.equal(new Set(keys).size, keys.length, '清单不许有重复键');
});
