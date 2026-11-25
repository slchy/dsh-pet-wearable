/**
 * 宿主栅栏：回环判定、自检、写保护、以及失败关闭的栅栏委托。
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { Duplex } from 'node:stream';

import { HostSecurityGuard, isLoopbackHostname } from '../src/host-security.ts';

function request(
  method: string,
  headers: Record<string, string | string[] | undefined>,
): IncomingMessage {
  return { method, headers } as IncomingMessage;
}

function response(): ServerResponse & { ended: boolean } {
  const res = {
    statusCode: 200,
    statusMessage: '',
    ended: false,
    end() {
      this.ended = true;
      return this;
    },
  };
  return res as unknown as ServerResponse & { ended: boolean };
}

function upgradeSocket(): {
  readonly text: () => string;
  readonly destroyed: () => boolean;
  readonly events: () => readonly string[];
  readonly duplex: Duplex;
} {
  let written = '';
  let destroyed = false;
  const events: string[] = [];
  const duplex = {
    write(chunk: string | Uint8Array) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      written += text;
      events.push('write');
      return true;
    },
    destroy() {
      destroyed = true;
      events.push('destroy');
      return this;
    },
  } as unknown as Duplex;
  return {
    text: () => written,
    destroyed: () => destroyed,
    events: () => events,
    duplex,
  };
}

test('isLoopbackHostname 只认 localhost、*.localhost、::1 和四段 127/8', () => {
  const valid = ['localhost', 'foo.localhost', '127.0.0.1', '127.255.0.1', '::1', '[::1]'];
  for (const hostname of valid) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }

  const invalid = ['127.0.0.1.evil.com', '127.300.0.1', '192.168.1.1', 'evil.com', ''];
  for (const hostname of invalid) {
    assert.equal(isLoopbackHostname(hostname), false, hostname);
  }

  assert.equal(isLoopbackHostname('Foo.LocalHost'), true);
  assert.equal(isLoopbackHostname('127.00.0.1'), false);
  assert.equal(isLoopbackHostname('127.1'), false);
  assert.equal(isLoopbackHostname('0x7f.0.0.1'), false);
  assert.equal(isLoopbackHostname('2130706433'), false);
});

test('回环 GET 放行；坏 Host、跨站和不一致的 Origin 一律 403', () => {
  const guard = new HostSecurityGuard();

  assert.equal(guard.rejectionCode(request('GET', { host: 'localhost' })), null);
  assert.equal(guard.rejectionCode(request('GET', { host: 'foo.localhost' })), null);
  assert.equal(guard.rejectionCode(request('GET', { host: '127.0.0.1' })), null);
  assert.equal(guard.rejectionCode(request('GET', { host: '127.255.0.1:8787' })), null);
  assert.equal(guard.rejectionCode(request('GET', { host: '[::1]' })), null);

  assert.equal(guard.rejectionCode(request('GET', {})), 403);
  assert.equal(guard.rejectionCode(request('GET', { host: '' })), 403);
  assert.equal(guard.rejectionCode(request('GET', { host: 'bad host' })), 403);
  assert.equal(guard.rejectionCode(request('GET', { host: 'user@127.0.0.1' })), 403);
  assert.equal(guard.rejectionCode(request('GET', { host: '127.0.0.1/admin' })), 403);
  assert.equal(guard.rejectionCode(request('GET', { host: '127.999.0.1' })), 403);

  assert.equal(
    guard.rejectionCode(request('GET', { host: 'localhost', 'sec-fetch-site': 'cross-site' })),
    403,
  );
  assert.equal(
    guard.rejectionCode(request('GET', { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' })),
    null,
  );

  assert.equal(
    guard.rejectionCode(request('GET', { host: 'localhost', origin: 'http://evil.example' })),
    403,
  );
  assert.equal(
    guard.rejectionCode(request('GET', {
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
    })),
    null,
  );
  assert.equal(
    guard.rejectionCode(request('GET', { host: 'localhost', origin: 'null' })),
    null,
  );
  assert.equal(
    guard.rejectionCode(request('GET', { host: 'localhost', origin: 'not a url' })),
    403,
  );
});

test('非回环主机：无栅栏且不在 trustedHosts 时拒绝，在名单里放行，有栅栏则交给栅栏', () => {
  assert.equal(
    new HostSecurityGuard().rejectionCode(request('GET', { host: 'app.example:8443' })),
    403,
  );

  const trusted = new HostSecurityGuard({ trustedHosts: ['App.Example:8443'] });
  assert.equal(trusted.rejectionCode(request('GET', { host: 'app.example:8443' })), null);

  const trustedByName = new HostSecurityGuard({ trustedHosts: ['app.example'] });
  assert.equal(trustedByName.rejectionCode(request('GET', { host: 'app.example:9443' })), null);

  let seen = 0;
  const delegated = new HostSecurityGuard({
    getConnectionFence: () => ({
      requestRejection(req) {
        seen += 1;
        assert.equal(req.headers.host, 'app.example');
        return null;
      },
    }),
  });
  assert.equal(delegated.rejectionCode(request('GET', { host: 'app.example' })), null);
  assert.equal(seen, 1);

  assert.equal(
    new HostSecurityGuard().rejectionCode(request('GET', { host: '0x7f.0.0.1' })),
    403,
  );
  assert.equal(
    new HostSecurityGuard().rejectionCode(request('GET', { host: '2130706433' })),
    403,
  );
});

test('POST 在非回环上即使栅栏放行也拒绝，除非列入 adminHosts', () => {
  let seen = 0;
  const warnings: string[] = [];
  const guarded = new HostSecurityGuard({
    getConnectionFence: () => ({
      requestRejection() {
        seen += 1;
        return false;
      },
    }),
    warn(message) {
      warnings.push(message);
    },
  });

  assert.equal(guarded.rejectionCode(request('POST', { host: 'app.example' })), 403);
  assert.equal(seen, 0);
  assert.equal(warnings.length, 1);
  assert.equal(guarded.rejectionCode(request('PUT', { host: 'app.example' })), 403);
  assert.equal(guarded.rejectionCode(request('PATCH', { host: 'app.example' })), 403);
  assert.equal(guarded.rejectionCode(request('DELETE', { host: 'app.example' })), 403);
  assert.equal(warnings.length, 1);
  assert.equal(seen, 0);

  const trustedOnly = new HostSecurityGuard({
    trustedHosts: ['app.example'],
    getConnectionFence: () => ({ requestRejection: () => false }),
  });
  assert.equal(trustedOnly.rejectionCode(request('POST', { host: 'app.example' })), 403);

  const admin = new HostSecurityGuard({
    adminHosts: ['app.example:9443'],
    getConnectionFence: () => ({ requestRejection: () => 401 }),
  });
  assert.equal(admin.rejectionCode(request('POST', { host: 'app.example:9443' })), 401);

  const adminByName = new HostSecurityGuard({
    adminHosts: ['app.example'],
    getConnectionFence: () => ({ requestRejection: () => false }),
  });
  assert.equal(adminByName.rejectionCode(request('POST', { host: 'app.example:9443' })), null);

  assert.equal(
    new HostSecurityGuard().rejectionCode(request('POST', { host: '127.0.0.1' })),
    null,
  );
});

test('栅栏的 401、true 和抛错按失败关闭解释', () => {
  const unauthorized = new HostSecurityGuard({
    getConnectionFence: () => ({ requestRejection: () => 401 }),
  });
  assert.equal(unauthorized.rejectionCode(request('GET', { host: 'app.example' })), 401);
  assert.equal(unauthorized.rejectionCode(request('GET', { host: 'localhost' })), 401);

  const forbidden = new HostSecurityGuard({
    getConnectionFence: () => ({ requestRejection: () => true }),
  });
  assert.equal(forbidden.rejectionCode(request('GET', { host: 'localhost' })), 403);

  for (const verdict of [false, null, undefined] as const) {
    const allowed = new HostSecurityGuard({
      getConnectionFence: () => ({ requestRejection: () => verdict }),
    });
    assert.equal(allowed.rejectionCode(request('GET', { host: 'app.example' })), null, String(verdict));
  }

  const warnings: string[] = [];
  const broken = new HostSecurityGuard({
    getConnectionFence: () => ({
      requestRejection() {
        throw new Error('fence down');
      },
    }),
    warn(message) {
      warnings.push(message);
    },
  });
  assert.equal(broken.rejectionCode(request('GET', { host: 'localhost' })), 403);
  assert.equal(broken.rejectionCode(request('GET', { host: 'localhost' })), 403);
  assert.equal(warnings.length, 1);
  const message = warnings[0];
  assert.ok(message !== undefined && message.length > 0);

  const lookupWarnings: string[] = [];
  const lookupBroken = new HostSecurityGuard({
    getConnectionFence() {
      throw new Error('lookup down');
    },
    warn(message) {
      lookupWarnings.push(message);
    },
  });
  assert.equal(lookupBroken.rejectionCode(request('GET', { host: 'localhost' })), 403);
  assert.equal(lookupWarnings.length, 1);
});

test('自检里的意外异常失败关闭为 403', () => {
  const guard = new HostSecurityGuard();
  const req = {
    method: 'GET',
    get headers() {
      throw new Error('headers exploded');
    },
  } as unknown as IncomingMessage;
  assert.equal(guard.rejectionCode(req), 403);
});

test('rejectIfNeeded 拒绝时写状态码并结束响应，放行时不动响应', () => {
  const guard = new HostSecurityGuard({
    getConnectionFence: () => ({ requestRejection: () => 401 }),
  });

  const rejected = response();
  assert.equal(guard.rejectIfNeeded(request('GET', { host: 'localhost' }), rejected), true);
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.ended, true);

  const allowed = response();
  const open = new HostSecurityGuard();
  assert.equal(open.rejectIfNeeded(request('GET', { host: 'localhost' }), allowed), false);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.ended, false);
});

test('rejectUpgradeIfNeeded 在坏 Origin 上写 HTTP 403 并拆掉套接字', () => {
  const guard = new HostSecurityGuard();
  const socket = upgradeSocket();
  const rejected = guard.rejectUpgradeIfNeeded(
    request('GET', { host: 'localhost', origin: 'https://evil.example' }),
    socket.duplex,
  );
  assert.equal(rejected, true);
  assert.equal(socket.text(), 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  assert.equal(socket.destroyed(), true);
  assert.deepEqual(socket.events(), ['write', 'destroy']);

  const unauthorized = new HostSecurityGuard({
    getConnectionFence: () => ({ requestRejection: () => 401 }),
  });
  const denied = upgradeSocket();
  assert.equal(
    unauthorized.rejectUpgradeIfNeeded(request('GET', { host: 'localhost' }), denied.duplex),
    true,
  );
  assert.equal(denied.text(), 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  assert.equal(denied.destroyed(), true);

  const untouched = upgradeSocket();
  assert.equal(
    guard.rejectUpgradeIfNeeded(request('GET', { host: '[::1]' }), untouched.duplex),
    false,
  );
  assert.equal(untouched.text(), '');
  assert.equal(untouched.destroyed(), false);
});
