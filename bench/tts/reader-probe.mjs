// omni 朗读机探针：① 长文本会不会只念第一句 ② 放弃一条流之后，下一条会不会收到残留音频
//
// 复刻 `src/omni-tts.ts` 的连接与提示词（同一条实时端点、同一段 instructions），
// 但**保留**线上那个单队列 + `take()` 的读法 —— 缺陷正是从「放弃一条流、队列里
// 还躺着它的 audio.delta」这里长出来的，换个读法就测不出来了。
//
// 用法（需 DASHSCOPE_API_KEY）：
//   node bench/tts/reader-probe.mjs
import WebSocket from 'ws';

const KEY = process.env.DASHSCOPE_API_KEY ?? '';
if (KEY === '') {
  console.error('缺少 DASHSCOPE_API_KEY');
  process.exit(2);
}

const URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + encodeURIComponent('qwen3.8-omni-flash-realtime');
const RATE = 24_000;
const INSTRUCTIONS = '你是一台朗读器。用户给你一段文本，你逐字念出来：'
  + '不许改字、不许漏字、不许解释、不许加任何前缀或结尾语、不许把数字读成汉字。';
const prompt = (text) => `念这段：${text}`;

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` }, maxPayload: 16 << 20 });
const queue = [];
let wake = null;
let ready = false;

const take = (ms) => {
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(null); }, ms);
    wake = (ev) => { clearTimeout(timer); resolve(ev); };
  });
};
const send = (p) => ws.send(JSON.stringify(p));

ws.on('message', (raw) => {
  let ev;
  try { ev = JSON.parse(String(raw)); } catch { return; }
  if (ev.type === 'session.updated') ready = true;
  if (wake !== null) { const w = wake; wake = null; w(ev); return; }
  queue.push(ev);
});

await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
send({
  type: 'session.update',
  session: {
    modalities: ['text', 'audio'],
    instructions: INSTRUCTIONS,
    turn_detection: null,
    audio: {
      input: { format: { type: 'pcm', sample_rate: 16_000, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } },
      output: { format: { type: 'pcm', sample_rate: RATE } },
    },
  },
});
while (!ready) {
  const ev = await take(500);
  if (ev?.type === 'error') throw new Error(String(ev.error?.message ?? ''));
}

async function speak(label, text, { stopAfterMs = 0 } = {}) {
  const startedAt = Date.now();
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt(text) }] } });
  send({ type: 'response.create' });
  let bytes = 0;
  let firstMs = -1;
  let done = false;
  let killed = false;
  const ids = [];
  while (!done) {
    if (stopAfterMs > 0 && Date.now() - startedAt > stopAfterMs) { killed = true; break; }
    const ev = await take(1_000);
    if (ev === null) continue;
    if (ev.type === 'response.output_item.added' && ev.item?.id) ids.push(ev.item.id);
    if (ev.type === 'response.audio.delta') {
      if (firstMs < 0) firstMs = Date.now() - startedAt;
      bytes += Buffer.from(ev.delta ?? '', 'base64').length;
      continue;
    }
    if (ev.type === 'response.done') {
      for (const it of ev.response?.output ?? []) if (it.id) ids.push(it.id);
      done = true;
      continue;
    }
    if (ev.type === 'error') {
      console.log(`${label} ✗ ${String(ev.error?.message ?? '').slice(0, 80)}`);
      done = true;
    }
  }
  const seconds = bytes / 2 / RATE;
  console.log(
    `${label} 首块=${firstMs < 0 ? '—' : `${firstMs}ms`} 字节=${bytes} 时长=${seconds.toFixed(2)}s`
    + `${killed ? '（中途放弃）' : '（自然结束）'} 队列剩余=${queue.length}`,
  );
  for (const id of ids) send({ type: 'conversation.item.delete', item_id: id });
  await new Promise((r) => setTimeout(r, 200));
  return { bytes, seconds, firstMs, killed, queueLeft: queue.length };
}

const LONG = '有点像。一个拿外星海照人的愧疚，一个拿解不开的信号照人的自负，都是人跟自己死磕，不是打怪。';

console.log('— 1 短文本（回执）');
await speak('短', '我看看。');
console.log('— 2 长文本（无情绪标记）');
await speak('长', LONG);
console.log('— 3 长文本（带 [平静] 前缀，线上流式那条就是这样发的）');
await speak('长+标记', `[平静]${LONG}`);
console.log('— 4 同一句再念一次（看重不重复）');
await speak('长#2', LONG);
console.log('— 5 放弃一条长流，隔 1.5 s 再念短文本（看残留会不会漏到下一句）');
await speak('放弃', LONG, { stopAfterMs: 1_500 });
await new Promise((r) => setTimeout(r, 1_500));
await speak('短#2', '我看看。');

ws.close();
