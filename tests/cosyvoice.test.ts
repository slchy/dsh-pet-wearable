/**
 * CosyVoice provider 的**不联网**契约测试。
 *
 * 首包延迟要真连服务端才能测（见 `scripts/probe-cosyvoice.mjs`），这里只钉住
 * 那些「改坏了不会立刻报错、但会让线上声音不对」的东西。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import { COSYVOICE_SAMPLE_RATE, CosyVoiceError, EMOTION_INSTRUCTIONS, EMOTION_PROSODY, cosyVoiceTts, isSilentChunk, splitStreamBatch } from '../src/cosyvoice.ts';
import { EMOTIONS, type Emotion } from '../src/emotion.ts';
import { TokenQueue } from '../src/token-queue.ts';

const KEYS = Object.keys(EMOTIONS) as Emotion[];

test('每个情绪都有 rate/pitch，且没多没少', () => {
  assert.deepEqual(Object.keys(EMOTION_PROSODY).sort(), [...KEYS].sort());
});

test('每个情绪都有自由指令，且没多没少', () => {
  assert.deepEqual(Object.keys(EMOTION_INSTRUCTIONS).sort(), [...KEYS].sort());
});

test('指令都用阿里云认的单一情感句式，且以句号结尾', () => {
  const VALUES = new Set(['neutral', 'happy', 'surprised', 'angry', 'sad', 'fearful', 'disgusted']);
  for (const key of KEYS) {
    const text = EMOTION_INSTRUCTIONS[key];
    const m = /^你说话的情感是([a-z]+)。$/.exec(text);
    assert.ok(m, `${key} 的指令不是「你说话的情感是X。」句式：${text}`);
    const value = m[1];
    assert.ok(typeof value === 'string', `${key} 的指令里没抓到情感值：${text}`);
    assert.ok(VALUES.has(value), `${key} 用了不认识的情感值 ${value}`);
  }
});

test('委屈是最慢最沉的，得意比开心更高更急', () => {
  const ordered = [...KEYS].sort((a, b) => EMOTION_PROSODY[a].rate - EMOTION_PROSODY[b].rate);
  assert.equal(ordered.at(0), 'sulk');
  // 平静必须是 1.0：它是「没有情绪」的基准，偏离了会让中性回复也变调
  assert.equal(EMOTION_PROSODY.calm.rate, 1);
  assert.equal(EMOTION_PROSODY.calm.pitch, 1);
  // 得意和开心都用 happy 这条指令，靠 rate/pitch 拉开：得意要更高更急
  assert.ok(EMOTION_PROSODY.proud.rate > EMOTION_PROSODY.happy.rate);
  assert.ok(EMOTION_PROSODY.proud.pitch > EMOTION_PROSODY.happy.pitch);
  // 担心应该是往下压的，不能反而更急
  assert.ok(EMOTION_PROSODY.worried.rate < EMOTION_PROSODY.calm.rate);
  assert.ok(EMOTION_PROSODY.worried.pitch < EMOTION_PROSODY.calm.pitch);
});

test('得意和开心共用同一条指令，所以必须靠 rate/pitch 区分开', () => {
  assert.equal(EMOTION_INSTRUCTIONS.proud, EMOTION_INSTRUCTIONS.happy);
  assert.notDeepEqual(EMOTION_PROSODY.proud, EMOTION_PROSODY.happy);
});

test('rate/pitch 都落在阿里云的合法区间（0.5–2 / 0.5–2）', () => {
  for (const key of KEYS) {
    const { rate, pitch } = EMOTION_PROSODY[key];
    assert.ok(rate >= 0.5 && rate <= 2, `${key} rate=${rate}`);
    assert.ok(pitch >= 0.5 && pitch <= 2, `${key} pitch=${pitch}`);
  }
});

test('缺 API key 时立刻报错，不要等到第一句话才发现', () => {
  assert.throws(() => cosyVoiceTts({ apiKey: '' }), CosyVoiceError);
});

test('provider 声明自己的采样率（24 kHz，和 MiMo 一致，宿主不用改）', () => {
  const tts = cosyVoiceTts({ apiKey: 'sk-test', voice: 'longanhuan' });
  assert.equal(tts.sampleRate, COSYVOICE_SAMPLE_RATE);
  assert.equal(tts.sampleRate, 24_000);
  assert.match(tts.name, /^cosyvoice:/);
});

test('静音块判定：数字静音算静音，正常说话不算', () => {
  // 全零
  assert.equal(isSilentChunk(Buffer.alloc(8000)), true);
  // ±1 LSB 的底噪（CosyVoice 句尾就是这种，实测 -113…-93 dBFS）
  const dither = Buffer.alloc(8000);
  for (let i = 0; i < dither.length; i += 2) {
    dither.writeInt16LE(i % 4 === 0 ? 1 : -1, i);
  }
  assert.equal(isSilentChunk(dither), true);
  // 正常说话（满量程约 10%）
  const speech = Buffer.alloc(8000);
  for (let i = 0; i < speech.length; i += 2) {
    speech.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i);
  }
  assert.equal(isSilentChunk(speech), false);
  // 很轻的气声（约 -60 dBFS）也得留住，那是语音不是静音
  const breath = Buffer.alloc(8000);
  for (let i = 0; i < breath.length; i += 2) {
    breath.writeInt16LE(Math.round(33 * Math.sin(i / 20)), i);
  }
  assert.equal(isSilentChunk(breath), false);
});

// ------------------------------------------------------------------ 流式（假服务端，不联网）

/**
 * 假的 CosyVoice：只实现协议里时序相关的那几步。
 *
 *   run-task      → task-started
 *   continue-task → 记下文本，回一块有声 PCM
 *   finish-task   → task-finished（可以拖一会儿，模拟「音频还没出完」）
 */
async function fakeCosyVoice(options: { finishDelayMs?: number } = {}): Promise<{
  url: string;
  /** 每条连接收到的 continue-task 文本，按连接建立顺序 */
  texts: string[][];
  close: () => Promise<void>;
}> {
  const texts: string[][] = [];
  const loud = Buffer.alloc(4800);
  for (let i = 0; i < loud.length; i += 2) {
    loud.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i);
  }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => { wss.once('listening', resolve); });
  wss.on('connection', (socket) => {
    const mine: string[] = [];
    texts.push(mine);
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data)) as {
        header: { action: string; task_id: string };
        payload: { input: { text?: string } };
      };
      const reply = (event: string): void => {
        socket.send(JSON.stringify({ header: { event, task_id: msg.header.task_id } }));
      };
      if (msg.header.action === 'run-task') reply('task-started');
      if (msg.header.action === 'continue-task') {
        mine.push(msg.payload.input.text ?? '');
        socket.send(loud);
      }
      if (msg.header.action === 'finish-task') {
        const delay = options.finishDelayMs ?? 0;
        if (delay === 0) {
          reply('task-finished');
        } else {
          setTimeout(() => {
            if (socket.readyState === socket.OPEN) reply('task-finished');
          }, delay);
        }
      }
    });
  });
  const address = wss.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    texts,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => { wss.close(() => { resolve(); }); });
    },
  };
}

test('流式：不足一批的短答也要送出去，且开头的情绪标签不进 TTS', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    const queue = new TokenQueue();
    // 真机日志里的那条 7 token 短答：整段不到 STREAM_BATCH_CHARS，只走尾批
    for (const token of ['[', '平静', ']', '在', '，', '哥', '。']) queue.push(token);
    queue.close();
    let bytes = 0;
    for await (const chunk of tts.synthesizeStream!(queue)) bytes += chunk.length;
    assert.ok(bytes > 0, '应当出声');
    assert.deepEqual(server.texts, [['在，哥。']]);
  } finally {
    await server.close();
  }
});

test('流式：调用方中途退出（插话）之后，下一个 task 不能撞上「连接正忙」', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  const first = new TokenQueue();
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    // 第一轮：拿到首块就走。此刻模型还在生成（队列没 close），task 还挂在连接上
    first.push('这一句要够长才会当成一批送出去。');
    for await (const chunk of tts.synthesizeStream!(first)) {
      assert.ok(chunk.length > 0);
      break;
    }
    // 第二轮紧跟着来（实测间隔 0.46 s，上一个 task 远没收尾）
    const second = new TokenQueue();
    second.push('第二轮。');
    second.close();
    let bytes = 0;
    for await (const chunk of tts.synthesizeStream!(second)) bytes += chunk.length;
    assert.ok(bytes > 0, '第二轮应当正常出声');
    assert.deepEqual(server.texts.at(-1), ['第二轮。']);
  } finally {
    first.close();
    await server.close();
  }
});

test('整段合成：调用方中途退出（旁白被取消 / 兜底时插话）之后，下一个 task 也不能撞上「连接正忙」', { timeout: 5000 }, async () => {
  // 服务端收完文本后还要 300 ms 才出完音频 —— 调用方在这期间走了
  const server = await fakeCosyVoice({ finishDelayMs: 300 });
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    for await (const chunk of tts.synthesize('第一句。')) {
      assert.ok(chunk.length > 0);
      break;
    }
    let bytes = 0;
    for await (const chunk of tts.synthesize('第二句。')) bytes += chunk.length;
    assert.ok(bytes > 0, '第二句应当正常出声');
    assert.deepEqual(server.texts, [['第一句。'], ['第二句。']], '半截 task 的连接要弃掉，第二句走新连接');
  } finally {
    await server.close();
  }
});

test('整段合成：正常念完的连接要复用（弃连接只发生在中途退出时）', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    for (const text of ['第一句。', '第二句。']) {
      let bytes = 0;
      for await (const chunk of tts.synthesize(text)) bytes += chunk.length;
      assert.ok(bytes > 0);
    }
    assert.deepEqual(server.texts, [['第一句。', '第二句。']], '两句应当落在同一条连接上 —— 首包那 ~170 ms 就省在这');
  } finally {
    await server.close();
  }
});

test('分批：数字不切开，数字前面的字不多等', () => {
  // 真机日志里的那一刀：「这单已经是六」｜「四一室了，不用再改。」
  assert.deepEqual(splitStreamBatch('这单已经是六'), { send: '这单已经是', keep: '六' });
  // 批尾不是数字：整批送
  assert.deepEqual(splitStreamBatch('四一室了，不用再改。'), { send: '四一室了，不用再改。', keep: '' });
  // 字母 + 中文数字的编号（中间有空格）算一串
  assert.deepEqual(splitStreamBatch('你看，是 W 八六'), { send: '你看，是 ', keep: 'W 八六' });
  // 阿拉伯数字同理
  assert.deepEqual(splitStreamBatch('订单尾号是 64'), { send: '订单尾号是 ', keep: '64' });
  // 金额：数字和量词交替，整串算一个数（真机日志：「…九十四块九毛」｜「六，退回去…」）
  assert.deepEqual(
    splitStreamBatch('椅子三千四百九十四块九毛'),
    { send: '椅子', keep: '三千四百九十四块九毛' },
  );
  // 量词前面不是数字就不算：「具体点」不是数
  assert.deepEqual(splitStreamBatch('你说具体点'), { send: '你说具体点', keep: '' });
  // 一长串字母数字后面跟标点：不能卡住（嵌套量词的写法在这里会指数级回溯）
  const long = `${'a1'.repeat(40)}。`;
  assert.deepEqual(splitStreamBatch(long), { send: long, keep: '' });
  // 整批都是数字：先不送，再等等
  assert.deepEqual(splitStreamBatch('W八六六五八八一'), { send: '', keep: 'W八六六五八八一' });
  // 但不能无限等：长编号里没有更好的切点，超过余量照送
  assert.deepEqual(
    splitStreamBatch('W八六六五八八一二三四五六七八九'),
    { send: 'W八六六五八八一二三四五六七八九', keep: '' },
  );
});

test('流式：批次边界落在数字中间时，数字整个留到下一批', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    const queue = new TokenQueue();
    for (const token of ['[平静]', '这单', '已经', '是', '六', '四一', '室', '了，', '不用再改。']) queue.push(token);
    queue.close();
    let bytes = 0;
    for await (const chunk of tts.synthesizeStream!(queue)) bytes += chunk.length;
    assert.ok(bytes > 0);
    const sent = server.texts[0] ?? [];
    assert.equal(sent.join(''), '这单已经是六四一室了，不用再改。', '不丢字、不重字');
    assert.ok(
      sent.some((batch) => batch.includes('六四一室')),
      `「六四一室」必须落在同一批里，实际 ${JSON.stringify(sent)}`,
    );
  } finally {
    await server.close();
  }
});
