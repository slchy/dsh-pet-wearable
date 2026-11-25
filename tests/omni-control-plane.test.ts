/**
 * 控制面：五步冲刷顺序、删除去重、动态事实单槽、发声队列满丢最早。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ControlPlane, type ControlGate } from '../src/omni/control-plane.ts';
import { buildSessionUpdate, composeInstructions } from '../src/omni/protocol.ts';
import { blankPending } from '../src/omni/response.ts';
import type { QueuedSpeech } from '../src/omni/types.ts';

const META = { seq: 0, silenceMs: 0, anchor: 0, bytes: 0, flushedMs: 0 };

function speech(promptText: string, kind: 'ack' | 'announce' = 'announce'): QueuedSpeech {
  return {
    promptText,
    kind,
    resp: blankPending(META, 'announce', 0),
    cancelled: false,
  };
}

function harness(initial: ControlGate = { state: 'busy', hasResp: true, socketOpen: true }) {
  const sent: Array<Record<string, unknown>> = [];
  const aborted: string[] = [];
  let gate = initial;
  const plane = new ControlPlane({
    send: (payload) => {
      sent.push(payload as Record<string, unknown>);
    },
    log: () => {},
    sessionUpdate: (dynamicContext) => buildSessionUpdate({
      instructions: composeInstructions({ dynamicContext }),
      serve: true,
    }),
    gate: () => gate,
    onAbortQueued: (entry) => {
      aborted.push(entry.promptText);
    },
  });
  return {
    sent,
    aborted,
    plane,
    setGate(next: ControlGate) {
      gate = next;
    },
  };
}

test('flushReady 按孤儿、删除、工具回执、整份 session、回注的顺序冲刷', () => {
  const h = harness();
  h.plane.rememberOrphan({ assistant: ['asst'], user: 'user1' });
  h.plane.deleteItems(['d1', '', 'd1']);
  h.plane.sendFunctionCallOutput('call_q', '回执');
  h.plane.updateDynamicContext('第一');
  h.plane.updateDynamicContext('最后');
  h.plane.pushInject('（系统旁注：答）');
  assert.equal(h.sent.length, 0, '没回到 ready 时一步都不发');
  assert.deepEqual([...h.plane.pendingDeletes], ['d1']);
  assert.equal(h.plane.dynamicContext, '最后');

  h.setGate({ state: 'ready', hasResp: false, socketOpen: true });
  h.plane.flushReady();

  const labels = h.sent.map((frame) => {
    if (frame['type'] === 'conversation.item.delete') return `delete:${String(frame['item_id'])}`;
    const item = frame['item'] as { type?: string; call_id?: string } | undefined;
    if (item?.type === 'function_call_output') return `output:${item.call_id ?? ''}`;
    if (frame['type'] === 'session.update') return 'session.update';
    if (frame['type'] === 'conversation.item.create') return 'inject';
    return String(frame['type']);
  });
  assert.deepEqual(labels, [
    'delete:asst',
    'delete:user1',
    'delete:d1',
    'output:call_q',
    'session.update',
    'inject',
  ]);

  const update = h.sent.find((frame) => frame['type'] === 'session.update');
  const session = update?.['session'] as {
    instructions?: string;
    turn_detection?: null;
    tools?: Array<{ name?: string }>;
  };
  assert.equal(session.turn_detection, null);
  assert.equal(session.tools?.length, 1);
  assert.equal(session.tools?.[0]?.name, 'delegate_to_assistant');
  assert.match(session.instructions ?? '', /最后$/);
  assert.equal((session.instructions ?? '').includes('第一'), false);
  assert.equal(h.plane.dynamicContextDirty, false);
  assert.equal(h.plane.sentDynamicContext, '最后');
});

test('动态事实与已发送内容相同就不再发整份 session', () => {
  const h = harness({ state: 'ready', hasResp: false, socketOpen: true });
  h.plane.updateDynamicContext('  事实A  ');
  h.plane.updateDynamicContext('事实A');
  h.plane.updateDynamicContext('  事实A');
  assert.equal(h.sent.length, 1);
  const session = h.sent[0]?.['session'] as { instructions?: string; turn_detection?: null; tools?: unknown[] };
  assert.match(session.instructions ?? '', /\n\n事实A$/);
  assert.equal(session.turn_detection, null);
  assert.equal(session.tools?.length, 1);
});

test('发声队列满时丢掉最早一条，一次只占一个槽', () => {
  const h = harness({ state: 'busy', hasResp: true, socketOpen: true });
  for (let i = 0; i < 9; i += 1) {
    h.plane.enqueue(speech(`p${i}`));
  }
  assert.deepEqual(h.aborted, ['p0']);
  assert.equal(h.plane.speechQueue.length, 8);
  assert.equal(h.plane.speechQueue[0]?.promptText, 'p1');
  assert.equal(h.plane.speechQueue[7]?.promptText, 'p8');

  h.setGate({ state: 'ready', hasResp: false, socketOpen: true });
  h.plane.clearSpeech();
  h.plane.enqueue(speech('汇报', 'announce'));
  h.plane.enqueue(speech('补句', 'ack'));
  assert.equal(h.plane.takeSpeech(32, false), null);
  assert.equal(h.plane.speechQueue[0]?.promptText, '汇报');

  const announced = h.plane.takeSpeech(0, false);
  assert.equal(announced?.promptText, '汇报');
  assert.equal(h.plane.speechQueue.length, 1);

  h.setGate({ state: 'ready', hasResp: true, socketOpen: true });
  assert.equal(h.plane.takeSpeech(0, false), null, '占槽后不能连发第二条 response.create');

  h.setGate({ state: 'ready', hasResp: false, socketOpen: true });
  const acked = h.plane.takeSpeech(999, false);
  assert.equal(acked?.promptText, '补句');
});
