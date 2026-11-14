/**
 * 设备 token：生成、强度、文件、热读、配对串。
 *
 * 这些用例防的是同一类事故 —— **“配了 token”但等于没配**：
 * 值太弱、贴错成眼镜 token、写了 `token:deviceId` 却没真绑定、
 * 吊销了但进程还在拿旧表放行。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { decodePairing, encodePairing, maskToken } from '../src/pairing.ts';
import {
  appendToken,
  classifyToken,
  generateToken,
  parseTokenFile,
  readTokenFile,
  revokeTokens,
  sameToken,
  TokenGate,
  TOKEN_BYTES,
  tokenFilePath,
  writeTokenFile,
} from '../src/tokens.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshpet-tokens-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateToken：长度对、是 hex、两次不一样', () => {
  const a = generateToken();
  const b = generateToken();
  assert.equal(a.length, TOKEN_BYTES * 2);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
  assert.equal(classifyToken(a), null);
});

test('classifyToken：弱值与眼镜 token 都要认出来', () => {
  assert.equal(classifyToken(''), 'has-space');
  assert.equal(classifyToken('123'), 'too-short');
  assert.equal(classifyToken('a'.repeat(31)), 'too-short');
  // 纯 hex 按字节算：32 位 hex = 16 字节，不够
  assert.equal(classifyToken('a'.repeat(32)), 'looks-like-glasses-token');
  assert.equal(classifyToken('a'.repeat(64)), null);
  // 非 hex 按字符算
  assert.equal(classifyToken('x'.repeat(32)), null);
  assert.equal(classifyToken(`${'a'.repeat(32)}:${'b'.repeat(32)}`), 'has-colon');
  assert.equal(classifyToken(`${'a'.repeat(32)} ${'b'.repeat(32)}`), 'has-space');
});

test('parseTokenFile：注释与空行跳过，坏行进 bad 而不是静默丢弃', () => {
  const good = 'a'.repeat(64);
  const text = [
    '# 注释',
    '',
    `${good}:pixel-9`,
    good,
    '123',
    `${'b'.repeat(32)}:iphone`,
  ].join('\n');

  const { entries, bad } = parseTokenFile(text);
  assert.deepEqual(entries.map((e) => e.deviceId), ['pixel-9', null]);
  assert.equal(entries[0]!.token, good);
  // 同一个 token 写两遍也算两条 —— 去重不是解析层的事
  assert.equal(entries[1]!.token, good);
  assert.deepEqual(bad.map((b) => b.problem), ['too-short', 'looks-like-glasses-token']);
});

test('appendToken：追加不覆盖，重复 deviceId 拒绝', () => {
  const file = join(tempDir(), 'tokens.txt');
  const first = appendToken(file, 'pixel-9');
  const second = appendToken(file, 'iphone-x');

  const { entries } = readTokenFile(file);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.deviceId), ['pixel-9', 'iphone-x']);
  assert.notEqual(first.token, second.token);

  assert.throws(() => appendToken(file, 'pixel-9'), /已经有 token/);
  // 拒绝的时候不能顺带把文件改了
  assert.equal(readTokenFile(file).entries.length, 2);
});

test('appendToken：文件不存在时新建', () => {
  const file = join(tempDir(), 'nested', 'deep', 'tokens.txt');
  const { token } = appendToken(file, null);
  assert.equal(readTokenFile(file).entries[0]!.token, token);
});

test('revokeTokens：按 deviceId 与按 token 都能删，删不到就报错', () => {
  const file = join(tempDir(), 'tokens.txt');
  const a = appendToken(file, 'pixel-9');
  const b = appendToken(file, 'iphone-x');

  assert.equal(revokeTokens(file, { deviceId: 'pixel-9' }).removed.length, 1);
  assert.deepEqual(readTokenFile(file).entries.map((e) => e.deviceId), ['iphone-x']);

  assert.equal(revokeTokens(file, { token: b.token }).removed.length, 1);
  assert.equal(readTokenFile(file).entries.length, 0);

  assert.throws(() => revokeTokens(file, { deviceId: 'nobody' }), /没找到匹配/);
  // a 已经被吊销，文件里不该再有它
  assert.equal(readTokenFile(file).entries.some((e) => e.token === a.token), false);
});

test('sameToken：等值/不等值，长度不同也不抛', () => {
  const t = generateToken();
  assert.equal(sameToken(t, t), true);
  assert.equal(sameToken(t, generateToken()), false);
  assert.equal(sameToken(t, `${t}x`), false);
  assert.equal(sameToken('', ''), true);
});

test('TokenGate：正确的 token 通过，错的不过', () => {
  const file = join(tempDir(), 'tokens.txt');
  const { token } = appendToken(file, null);
  const logs: string[] = [];
  const gate = new TokenGate(file, (l) => { logs.push(l); });

  assert.notEqual(gate.match(token, 'whatever'), null);
  assert.equal(gate.match(generateToken(), 'whatever'), null);
  assert.equal(gate.match('', 'whatever'), null);
});

test('TokenGate：token:deviceId 写了就真绑定', () => {
  const file = join(tempDir(), 'tokens.txt');
  const { token } = appendToken(file, 'pixel-9');
  const logs: string[] = [];
  const gate = new TokenGate(file, (l) => { logs.push(l); });

  assert.notEqual(gate.match(token, 'pixel-9'), null);
  // token 对但设备不对：必须拒，否则那一列只是注释
  assert.equal(gate.match(token, 'someone-else'), null);
  assert.equal(gate.match(token, undefined), null);
  assert.ok(logs.some((l) => l.includes('deviceId 不匹配')));
});

test('TokenGate：文件变了就重读 —— 吊销不必重启进程', () => {
  const file = join(tempDir(), 'tokens.txt');
  const { token } = appendToken(file, 'pixel-9');
  const gate = new TokenGate(file, () => {});
  assert.notEqual(gate.match(token, 'pixel-9'), null);

  // 绕过 appendToken 直接重写文件，模拟运维手工吊销
  writeTokenFile(file, []);
  assert.equal(gate.match(token, 'pixel-9'), null, '吊销后旧 token 必须立即失效');

  // 再发一个，同一个 gate 也要认
  const fresh = appendToken(file, 'pixel-9');
  assert.notEqual(gate.match(fresh.token, 'pixel-9'), null);
});

test('TokenGate：文件读不到就拒绝一切（fail closed）', () => {
  const file = join(tempDir(), 'missing.txt');
  const logs: string[] = [];
  const gate = new TokenGate(file, (l) => { logs.push(l); });
  assert.equal(gate.match('anything', undefined), null);
  assert.equal(gate.size, 0);
  // 只抱怨一次，不要每条连接都刷屏
  const complaints = logs.filter((l) => l.includes('读不到')).length;
  gate.match('anything', undefined);
  gate.match('anything', undefined);
  assert.equal(logs.filter((l) => l.includes('读不到')).length, complaints);
});

test('tokenFilePath：显式参数 > MIAI_TOKENS > 默认', () => {
  const saved = process.env['MIAI_TOKENS'];
  try {
    process.env['MIAI_TOKENS'] = join(tempDir(), 'from-env.txt');
    assert.ok(tokenFilePath().endsWith('from-env.txt'));
    assert.ok(tokenFilePath('/tmp/explicit.txt').replace(/\\/g, '/').endsWith('explicit.txt'));

    delete process.env['MIAI_TOKENS'];
    assert.ok(tokenFilePath().endsWith('tokens.txt'));
  } finally {
    if (saved === undefined) {
      delete process.env['MIAI_TOKENS'];
    } else {
      process.env['MIAI_TOKENS'] = saved;
    }
  }
});

test('配对串：往返一致，坏串给出原因', () => {
  const token = generateToken();
  const text = encodePairing({ host: '203.0.113.10', port: 8766, tls: true, token, deviceId: 'pixel-9' });
  assert.ok(text.startsWith('dshpet://pair?'));

  const back = decodePairing(text);
  assert.equal(back.ok, true);
  assert.deepEqual(back.ok && back.pairing, {
    host: '203.0.113.10',
    port: 8766,
    tls: true,
    token,
    deviceId: 'pixel-9',
  });

  assert.equal(decodePairing('https://example.com').ok, false);
  assert.equal(decodePairing('dshpet://pair?port=8766&token=x').ok, false);
  assert.equal(decodePairing('dshpet://pair?host=h&port=0&token=x').ok, false);
  assert.equal(decodePairing('dshpet://pair?host=h&port=8766').ok, false);
});

test('配对串：token 里的特殊字符不会被 URL 编码搞坏', () => {
  const token = 'a+b/c=d&e%f'.padEnd(32, 'x');
  const back = decodePairing(encodePairing({ host: 'h', port: 1, tls: false, token, deviceId: null }));
  assert.equal(back.ok && back.pairing.token, token);
});

test('maskToken：长得不像真值', () => {
  const token = generateToken();
  const masked = maskToken(token);
  assert.ok(!masked.includes(token.slice(4, -4)));
  assert.ok(masked.startsWith(token.slice(0, 4)));
});

test('文件里放弱 token：解析能报出来（启动时会据此拒绝）', () => {
  const file = join(tempDir(), 'weak.txt');
  writeFileSync(file, '123\n', 'utf8');
  const { entries, bad } = readTokenFile(file);
  assert.equal(entries.length, 0);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.problem, 'too-short');
});
