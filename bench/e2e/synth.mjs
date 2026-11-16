/**
 * 在**服务器上**跑：用线上同一条 TTS 合成一段「用户会说的话」。
 *
 *   node synth.mjs "今天心情怎么样" /tmp/e2e-user.pcm
 *   输出：TTS rate=24000 bytes=65920 ms=1373 text=今天心情怎么样
 *
 * 为什么在服务器上合成而不是本地：素材必须是**线上同一条链路**出来的声音，
 * 否则测出来的停顿、语速跟真实用户说话不是一回事。凭据也只在服务器上。
 */
import { writeFileSync } from 'node:fs';
// 这个脚本会被 scp 到目标机上跑，绝对路径靠 MIAI_CLOUD 给（默认占位）
const MIAI_CLOUD = process.env.MIAI_CLOUD ?? '<部署路径>/miai-cloud';
const { cosyVoiceTts } = await import(`${MIAI_CLOUD}/src/cosyvoice.ts`);

const text = process.argv[2] ?? '今天心情怎么样';
const out = process.argv[3] ?? '/tmp/e2e-user.pcm';

const tts = cosyVoiceTts();
const parts = [];
for await (const chunk of tts.synthesize(text, 'calm')) {
  parts.push(chunk);
}
const pcm = Buffer.concat(parts);
writeFileSync(out, pcm);
console.log(
  `TTS rate=${tts.sampleRate} bytes=${pcm.length}`
  + ` ms=${Math.round((pcm.length / 2 / tts.sampleRate) * 1000)} text=${text}`,
);
