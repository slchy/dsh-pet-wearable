/**
 * 证书到期提醒的判据。
 *
 * 为什么值得测：这个提醒只在**快到期的某一天**才出现在启动日志里，平时看不见。
 * 阈值写反（比如把 30 天当成 3 天）不会有任何症状，直到证书过期、所有客户端
 * 同时连不上那一刻 —— 而那正是它本该提前喊出来的场景。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CERT_URGENT_DAYS, CERT_WARN_DAYS, certExpiry, expiryWarning, warningFor } from '../src/tls-cert.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T00:00:00.000Z');

/** 造一个「距今 days 天到期」的时间戳。 */
function inDays(days: number): number {
  return NOW + days * DAY;
}

test('还剩很久：不占日志', () => {
  assert.equal(warningFor(inDays(CERT_WARN_DAYS + 1), NOW), null);
  assert.equal(warningFor(inDays(365), NOW), null);
});

test('30 天以内：提醒轮换', () => {
  const lines = warningFor(inDays(CERT_WARN_DAYS), NOW);
  assert.ok(lines);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /2026-12-15/);
  assert.match(lines[0] ?? '', new RegExp(`还剩 ${CERT_WARN_DAYS} 天`));
});

test('7 天以内：升级成紧急，说明后果', () => {
  const lines = warningFor(inDays(CERT_URGENT_DAYS), NOW);
  assert.ok(lines);
  assert.match(lines[0] ?? '', /^⚠/);
  assert.match(lines[0] ?? '', /所有客户端会同时连不上/);
});

test('已过期：明确说「每次握手都会失败」，而不是只说一句过期', () => {
  const lines = warningFor(inDays(-1), NOW);
  assert.ok(lines);
  assert.match(lines[0] ?? '', /已经过期/);
  // 关键：说清症状。只说"过期"会让人以为是小事
  assert.match(lines.join('\n'), /每一次 TLS 握手都会失败/);
});

test('正好到期那一刻算过期（不是「还剩 0 天」）', () => {
  const lines = warningFor(NOW, NOW);
  assert.ok(lines);
  assert.match(lines[0] ?? '', /已经过期/);
});

test('读不懂的输入不抛异常，只是不给提醒', () => {
  // 证书坏了由 TLS 握手自己报错，这里不该再抛一层
  assert.equal(certExpiry('not a cert'), null);
  assert.equal(expiryWarning(Buffer.from('garbage')), null);
});
