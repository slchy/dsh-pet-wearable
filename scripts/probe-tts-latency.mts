/**
 * 探针：MiMo TTS 的首包延迟里，有多少是「重新建连」。
 *
 * 每次合成都是一次新的 `fetch`，而 undici 默认 keep-alive 只有 4 秒 ——
 * 两轮对话间隔通常十几秒，等于每次都要重新 TLS 握手。如果真是这样，
 * 隔 1 秒连续两次会比隔 15 秒快出一截。
 *
 * 跑法（服务器上）：
 *   set -a; . ~/miai-cloud/.env; set +a
 *   node /tmp/tts-probe.mts
 */
import { ttsStream } from '<部署路径>/miai-cloud/src/mimo.ts';

async function firstChunkMs(text: string, voice: string): Promise<number> {
  const started = Date.now();
  for await (const chunk of ttsStream(text, voice)) {
    if (chunk.length > 0) return Date.now() - started;
  }
  return -1;
}

const VOICE = process.env['MIMO_TTS_VOICE'] || 'Chloe';
const SENTENCE = '哥，这件事我查了一下，大概是这样。';

console.log('--- 冷启动（进程刚起，没有任何连接）---');
console.log(`冷 1: ${await firstChunkMs(SENTENCE, VOICE)} ms`);

console.log('--- 间隔 1 秒（连接应当还活着）---');
await new Promise((r) => { setTimeout(r, 1000); });
console.log(`热 1: ${await firstChunkMs(SENTENCE, VOICE)} ms`);

console.log('--- 间隔 15 秒（模拟两轮对话之间的空档）---');
await new Promise((r) => { setTimeout(r, 15_000); });
console.log(`冷 2: ${await firstChunkMs(SENTENCE, VOICE)} ms`);

console.log('--- 紧接一次（连接又热了）---');
console.log(`热 2: ${await firstChunkMs(SENTENCE, VOICE)} ms`);

process.exit(0);
