/**
 * `driver.ts` 必须调用同一份运行时配置，不能再自抄一套默认值。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('driver.ts 调用同一份配置，不再自抄默认值', () => {
  const driver = readFileSync(new URL('../src/driver.ts', import.meta.url), 'utf8');

  assert.match(driver, /buildVoiceRuntimeConfig\(/u);
  assert.match(driver, /micGain:\s*1/u);
  assert.match(driver, /controlPort:\s*0/u);
  assert.match(driver, /isLoopbackHost\(config\.host\)/u);
  assert.match(driver, /installHttpAgent\(/u);
  assert.match(driver, /expiryWarning\(cert\)/u);
  assert.match(driver, /loadStaticAsrCorpus\(memoryFile\.hotwordHints\(\)/u);
  assert.match(driver, /resolveAsrLanguage\(process\.env\)/u);
  assert.match(driver, /memorySummary:\s*\(\)\s*=>\s*memoryFile\.summary\(\)/u);
  assert.match(driver, /\.then\(\(code\) => \{[\s\S]*reject\(/u);
  assert.equal(/config\.host !== '127\.0\.0\.1'/u.test(driver), false);
  assert.equal(/SEMANTIC_END_TAG_BUDGET_MS',\s*300/u.test(driver), false);
  assert.equal(/30_000/u.test(driver), false);
});
