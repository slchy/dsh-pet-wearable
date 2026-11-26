/**
 * `scripts/secret-scan.mjs` 的纯函数单测。
 *
 * **不跑 git**：这份测试也会在部署服务器上跑，那里没有 `.git`。
 * 只验证规则本身（哪些路径/内容该拦、哪些该放）。
 *
 * 夹具里的「密钥」和「公网 IP」全部在运行时拼出来 —— 否则这份测试文件自己
 * 就会被扫描器命中，仓库永远绿不了。断言也顺带证明返回值不回显原文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isForbiddenTrackedPath, scanFileContent } from '../scripts/secret-scan.mjs';

const fakeSk = `sk-${'A'.repeat(24)}`;
const fakeProjectSk = `sk-proj-${'b'.repeat(24)}`;
const fakeGoogle = `AIza${'C'.repeat(33)}`;
const fakeGithub = `ghp_${'D'.repeat(36)}`;
const fakeGithubPat = `github_pat_${'E'.repeat(36)}`;
const fakeAliyun = `LTAI${'F'.repeat(20)}`;
const fakePrivateKey = `-----BEGIN ${'RSA '}PRIVATE KEY-----`;
const fakePublicIp = [8, 8, 8, 8].join('.');
const fakeApnicIp = [1, 2, 3, 4].join('.');

test('isForbiddenTrackedPath 拦截凭据、证书与模型权重', () => {
  const blocked = [
    '.env',
    '.env.local',
    'sub/.env',
    'tokens.txt',
    'docs/OPS-RECORD.md',
    'tls/server.key',
    'tls/server.pem',
    'certs/client.crt',
    'certs/store.p12',
    'certs/android.jks',
    'models/silero_vad.onnx',
    'models\\silero_vad.onnx',
  ];
  for (const path of blocked) {
    assert.notEqual(isForbiddenTrackedPath(path), null, path);
  }
});

test('isForbiddenTrackedPath 放行模板与普通源码', () => {
  const allowed = [
    '.env.example',
    'cert.pem.example',
    'tls/server.key.example',
    'src/main.ts',
    'models/README.md',
    'tests/secret-scan.test.ts',
  ];
  for (const path of allowed) {
    assert.equal(isForbiddenTrackedPath(path), null, path);
  }
});

test('scanFileContent 命中各类高置信度密钥形态并给出行号', () => {
  const content = [
    'const ok = 1;',
    fakePrivateKey,
    `const a = '${fakeSk}';`,
    `const b = '${fakeProjectSk}';`,
    `const c = '${fakeGoogle}';`,
    `const d = '${fakeGithub}';`,
    `const e = '${fakeGithubPat}';`,
    `const f = '${fakeAliyun}';`,
  ].join('\n');

  const findings = scanFileContent('fixture.ts', content);
  const rules = new Set(findings.map((finding) => finding.rule));
  assert.ok(rules.has('private-key'));
  assert.ok(rules.has('openai-or-dashscope-key'));
  assert.ok(rules.has('google-api-key'));
  assert.ok(rules.has('github-token'));
  assert.ok(rules.has('aliyun-access-key'));

  const privateKey = findings.find((finding) => finding.rule === 'private-key');
  assert.equal(privateKey?.line, 2);
  assert.equal(privateKey?.file, 'fixture.ts');
});

test('scanFileContent 只报告真实公网 IPv4', () => {
  const findings = scanFileContent(
    'fixture.md',
    [`host ${fakePublicIp}:443`, `cdn ${fakeApnicIp}:80`, '版本 1.2.3.4.5 不是地址'].join('\n'),
  );
  const ipFindings = findings.filter((finding) => finding.rule === 'public-ipv4');
  assert.deepEqual(
    ipFindings.map((finding) => finding.line),
    [1, 2],
  );
});

test('scanFileContent 放行回环、私网、链路本地、CGNAT 与文档段', () => {
  const content = [
    'listen 127.0.0.1:8080',
    'bind 0.0.0.0',
    'lan 192.168.1.10',
    'vpc 10.0.0.1',
    'vpc 172.16.0.1',
    'vpc 172.31.255.254',
    'link 169.254.1.1',
    'cgnat 100.64.0.1',
    'doc 203.0.113.10',
    'doc 198.51.100.5',
    'doc 192.0.2.20',
    'placeholder sk-leaked-from-process',
  ].join('\n');
  assert.deepEqual(scanFileContent('fixture.md', content), []);
});

test('scanFileContent 跳过 lockfile 里的四段版本号', () => {
  const content = `{"resolved":"${fakeApnicIp}"}`;
  assert.deepEqual(scanFileContent('package-lock.json', content), []);
  assert.equal(scanFileContent('other.json', content).length, 1);
});

test('返回值不回显命中的密钥或 IP 原文', () => {
  const secrets = [fakeSk, fakeProjectSk, fakeGoogle, fakeGithub, fakeAliyun, fakePublicIp];
  const content = secrets.map((secret) => `value: ${secret}`).join('\n');
  const serialized = JSON.stringify(scanFileContent('fixture.ts', content));
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, '返回值泄漏了命中原文');
  }
});
