/**
 * 探针：CosyVoice 流式首包 —— 「首批文本长度」与首块时间的关系（含预热）。
 *
 * 动机见 `live-text.ts` 的 `LIVE_TOKEN_THRESHOLD = 20`：模型前 20 个 token 一个字
 * 都不放给 TTS，所以降低门槛之前必须先知道「TTS 拿到几个字才肯出声」。
 *
 * 计时口径：
 *   t0 = 首批文本**实际送进** synthesizeStream 的时刻（不含建连 / run-task）
 *   t1 = 首个非空音频块到达
 * 另外报「全部结束」，用来看后半段有没有被首批拖住。
 *
 * 预热一次，避免把冷 TLS 算进来。
 *
 * 跑法：node bench/latency/probe-cosyvoice-firstbatch.mts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const line of readFileSync(resolve(import.meta.dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m !== null && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { cosyVoiceTts } = await import(new URL('../../src/cosyvoice.ts', import.meta.url).href);
const tts = cosyVoiceTts({});
const rate = tts.sampleRate;

const SENTENCE = '收到，测试正常，我在这边听着呢。';

async function* oneShot(text: string): AsyncGenerator<string> {
  yield text;
}

async function probe(n: number, restDelayMs: number): Promise<void> {
  const chars = [...SENTENCE];
  const first = chars.slice(0, n).join('');
  const rest = chars.slice(n);

  let firstSentAt = 0;
  let firstChunkAt = -1;
  let firstBytes = 0;
  let chunks = 0;
  let bytes = 0;

  async function* feed(): AsyncGenerator<string> {
    firstSentAt = Date.now();
    yield first;
    for (const ch of rest) {
      if (restDelayMs > 0) await new Promise<void>((r) => { setTimeout(r, restDelayMs); });
      yield ch;
    }
  }

  for await (const chunk of tts.synthesizeStream(feed())) {
    if (chunk.length === 0) continue;
    chunks += 1;
    bytes += chunk.length;
    if (firstChunkAt < 0) {
      firstChunkAt = Date.now();
      firstBytes = chunk.length;
    }
  }
  console.log(
    `  首批 ${String(n).padStart(2)} 字 → 首块 ${String(firstChunkAt - firstSentAt).padStart(4)} ms  `
    + `(${(firstBytes / 2 / rate * 1000).toFixed(0)} ms 音频, 共 ${chunks} 块)  `
    + `全部 ${String(Date.now() - firstSentAt).padStart(4)} ms / ${(bytes / 2 / rate).toFixed(2)} s`,
  );
}

console.log(`测试句（${[...SENTENCE].length} 字）：${SENTENCE}`);
console.log(`下行 ${rate} Hz`);
console.log(`model=${process.env['COSYVOICE_MODEL'] ?? '(默认)'}\n`);

console.log('预热中…');
for await (const _ of tts.synthesizeStream(oneShot('预热一下。'))) { void _; }
console.log('预热完成\n');

for (const delay of [0, 40]) {
  console.log(`== 后续文本：${delay === 0 ? '一次性补齐' : `每字 ${delay} ms`} ==`);
  for (const n of [2, 3, 4, 6, 8, 10, 13]) {
    await probe(n, delay);
  }
  console.log('');
}
process.exit(0);


