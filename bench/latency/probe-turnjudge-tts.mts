/**
 * 探针：用 CosyVoice 在**原生 16 kHz** 合成几句已知「说完 / 没说完」的话，
 * 落成裸 PCM16，喂给 TurnJudge 侧车看 p。
 *
 * 为什么需要它：真机上行是 mSBC 解出来的、很轻（−40 dBFS），而档案里的下行是
 * 24 kHz 的 TTS（读成 16 kHz 会慢 1.5 倍）。要判断「模型/特征链对不对」，
 * 需要一段**采样率、电平都干净**的已知答案。
 *
 * 跑法：node --experimental-strip-types bench/latency/probe-turnjudge-tts.mts <输出目录>
 */
const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fs = await import('node:fs');
for (const line of fs.readFileSync(REPO + '.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m !== null && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { cosyVoiceTts } = await import(new URL('../../src/cosyvoice.ts', import.meta.url).href);

const OUT = process.argv[2] ?? '.';
const CASES: Array<[string, string]> = [
  ['complete', '我问你最近看过什么电影？'],
  ['complete2', '我好像，嗯，找不到退货单了。'],
  ['incomplete', '我好像，嗯，'],
];

const tts = cosyVoiceTts({ sampleRate: 16_000 });
fs.mkdirSync(OUT, { recursive: true });
for (const [name, text] of CASES) {
  const chunks: Buffer[] = [];
  for await (const c of tts.synthesize(text)) {
    chunks.push(c);
  }
  const pcm = Buffer.concat(chunks);
  const file = `${OUT}/${name}.pcm`;
  fs.writeFileSync(file, pcm);
  console.log(`${name.padEnd(11)} ${String(Math.round((pcm.length / 2 / 16_000) * 1000)).padStart(5)} ms  ${file}`);
}
