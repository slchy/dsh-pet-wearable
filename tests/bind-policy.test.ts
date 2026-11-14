/**
 * 监听地址的安全闸。
 *
 * 这条判据的失败模式是「安安静静地开了个公网明文免鉴权端口」—— 没人会注意到，
 * 所以矩阵要钉得密一些，边界（空串 / 通配 / 半配 TLS）都要有。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBindSafety, isLoopbackHost } from '../src/bind-policy.ts';

test('isLoopbackHost：只有真正的本机地址算本机', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LocalHost', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(host), true, `${host} 应当算本机`);
  }
  for (const host of ['', '   ', '0.0.0.0', '::', '[::]', '*', '192.168.1.10', '10.0.0.5', 'example.com', '::2']) {
    assert.equal(isLoopbackHost(host), false, `${host} 不该算本机`);
  }
});

test('本机地址不需要 token / TLS', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const r = checkBindSafety({ host, hasTls: false, hasAuth: false });
    assert.equal(r.ok, true, `${host} 应当放行`);
    assert.equal(r.ok && r.loopback, true);
  }
});

test('非本机地址：token 与 TLS 缺一不可', () => {
  const cases: Array<[boolean, boolean, string[]]> = [
    [false, false, ['token', 'tls']],
    [true, false, ['tls']],
    [false, true, ['token']],
    [true, true, []],
  ];
  for (const [hasAuth, hasTls, missing] of cases) {
    const r = checkBindSafety({ host: '0.0.0.0', hasTls, hasAuth });
    assert.equal(r.ok, missing.length === 0, `hasAuth=${hasAuth} hasTls=${hasTls}`);
    if (!r.ok) {
      assert.deepEqual([...r.missing].sort(), [...missing].sort());
      // 拒绝时给出的说明必须能照着改：点名缺什么、怎么补
      for (const item of missing) {
        assert.match(r.message, new RegExp(item === 'token' ? 'MIAI_TOKENS' : 'MIAI_TLS_KEY'));
      }
      assert.match(r.message, /拒绝监听/);
    }
  }
});

test('空 host 按全网卡处理（fail-closed）', () => {
  const r = checkBindSafety({ host: '', hasTls: true, hasAuth: true });
  // 两样都齐了才放行；只要缺一样就必须拒 —— 不能因为「没填」就当本机
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.loopback, false);
  assert.equal(checkBindSafety({ host: '', hasTls: false, hasAuth: false }).ok, false);
});

test('具体网卡地址与 TLS+token 齐备时放行', () => {
  const r = checkBindSafety({ host: '192.168.1.10', hasTls: true, hasAuth: true });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.loopback, false);
});

test('拒绝文案给出两条可照做的出路', () => {
  const r = checkBindSafety({ host: '0.0.0.0', hasTls: false, hasAuth: false });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /127\.0\.0\.1/);
    assert.match(r.message, /adb reverse/);
    assert.match(r.message, /反向代理/);
  }
});
