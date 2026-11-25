/**
 * socket 解帧与协议错误计数。不连真服务。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeServerEvent, OmniSocket } from '../src/omni/socket.ts';
import type { RealtimeSocket, ServerEvent } from '../src/omni/types.ts';

class FakeSocket {
  readonly readyState = 1;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(_data: string): void {}

  close(): void {}

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...args: unknown[]) => void);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }
}

test('非法 JSON 安全忽略，合法帧才交给 onEvent', () => {
  assert.equal(decodeServerEvent(Buffer.from('{')), null);
  assert.equal(decodeServerEvent(Buffer.from('not-json')), null);

  const events: ServerEvent[] = [];
  const socket = new OmniSocket(() => {});
  const fake = new FakeSocket();
  socket.connect(fake as unknown as RealtimeSocket, {
    onOpen() {},
    onEvent(ev) {
      events.push(ev);
    },
    onClose() {},
  });
  fake.emit('message', Buffer.from('{'));
  fake.emit('message', Buffer.from(''));
  assert.equal(events.length, 0);
  fake.emit('message', Buffer.from('{"type":"session.updated"}'));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'session.updated');
});

test('before response.created 不计协议错误', () => {
  const socket = new OmniSocket(() => {});
  assert.equal(
    socket.observeProtocolError('Cannot cancel response before response.created'),
    'ignore',
  );
  assert.equal(
    socket.observeProtocolError('again: before response.created'),
    'ignore',
  );
  assert.equal(socket.protocolErrors, 0);
  assert.equal(socket.disposition, 'ok');
});

test('第二次协议错误把 disposition 转成 broken', () => {
  const socket = new OmniSocket(() => {});
  assert.equal(socket.observeProtocolError('Conversation already has an active response'), 'counted');
  assert.equal(socket.disposition, 'ok');
  assert.equal(socket.protocolErrors, 1);
  assert.equal(socket.observeProtocolError('Conversation already has an active response'), 'broken');
  assert.equal(socket.protocolErrors, 2);
  assert.equal(socket.disposition, 'broken');
});
