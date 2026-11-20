/**
 * CosyVoice provider 的**不联网**契约测试。
 *
 * 首包延迟要真连服务端才能测（见 `scripts/probe-cosyvoice.mjs`），这里只钉住
 * 那些「改坏了不会立刻报错、但会让线上声音不对」的东西。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import { COSYVOICE_SAMPLE_RATE, CosyVoiceError, EMOTION_INSTRUCTIONS, EMOTION_PROSODY, cosyVoiceTts, isSilentChunk, splitStreamBatch, trimLeadingSilence, streamBatchReady } from '../src/cosyvoice.ts';
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
async function fakeCosyVoice(options: { finishDelayMs?: number; frames?: Buffer[] } = {}): Promise<{
  url: string;
  /** 每条连接收到的 continue-task 文本，按连接建立顺序 */
  texts: string[][];
  /** 每条连接收到的 run-task 次数，按连接建立顺序（预开省没省就看它） */
  runs: number[];
  close: () => Promise<void>;
}> {
  const texts: string[][] = [];
  const runs: number[] = [];
  const loud = Buffer.alloc(4800);
  for (let i = 0; i < loud.length; i += 2) {
    loud.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i);
  }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => { wss.once('listening', resolve); });
  wss.on('connection', (socket) => {
    const mine: string[] = [];
    texts.push(mine);
    runs.push(0);
    const myRuns = runs.length - 1;
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data)) as {
        header: { action: string; task_id: string };
        payload: { input: { text?: string } };
      };
      const reply = (event: string): void => {
        socket.send(JSON.stringify({ header: { event, task_id: msg.header.task_id } }));
      };
      if (msg.header.action === 'run-task') {
        runs[myRuns] = (runs[myRuns] ?? 0) + 1;
        reply('task-started');
      }
      if (msg.header.action === 'continue-task') {
        mine.push(msg.payload.input.text ?? '');
        for (const frame of options.frames ?? [loud]) socket.send(frame);
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
    runs,
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
    // 第一批已经在「有正文」时就送了（不再等 10 字），所以按拼起来判断，
    // 不假定分成几批 —— 要钉的是「一个字都不丢」和「标签没被念出来」
    assert.equal(server.texts.flat().join(''), '在，哥。');
    for (const batch of server.texts.flat()) {
      assert.ok(!batch.includes('平静'), `情绪标签进了 TTS：${batch}`);
      assert.ok(!batch.includes('[') && !batch.includes(']'), `方括号进了 TTS：${batch}`);
    }
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

test('预开：流式合成认领那条 task，不再发第二个 run-task', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  const tasks: { prewarmed: boolean; setup_ms: number }[] = [];
  try {
    const tts = cosyVoiceTts({
      apiKey: 'sk-test',
      url: server.url,
      // 预开只在 prosody 模式做：instruction 模式的语气是开 task 时定死的，
      // 而定稿时还不知道这一轮是什么情绪
      useInstruction: false,
      onTask: (info) => { tasks.push({ prewarmed: info.prewarmed, setup_ms: info.setup_ms }); },
    });
    tts.prewarm?.();
    // 给预开一点时间（真机上是 66 ms 量级）
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queue = new TokenQueue();
    queue.push('这一句要够长才会当成一批送出去。');
    queue.close();
    let bytes = 0;
    for await (const chunk of tts.synthesizeStream!(queue)) bytes += chunk.length;
    assert.ok(bytes > 0, '应当出声');
    assert.deepEqual(server.runs, [1], 'run-task 只该发一次 —— 第二次就是预热没生效');
    assert.equal(server.texts.flat().join(''), '这一句要够长才会当成一批送出去。');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.prewarmed, true, '这一趟应当是认领预开的 task');
    // 建立时间仍是**真实开销**（从当初发 run-task 算起），只是它落在模型出字之前了
    assert.ok(tasks[0]!.setup_ms >= 0, `建立耗时不该缺仪表：${tasks[0]!.setup_ms}`);
  } finally {
    await server.close();
  }
});

test('预开：整段合成也认领同一条 task', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  const prewarmed: boolean[] = [];
  try {
    const tts = cosyVoiceTts({
      apiKey: 'sk-test',
      url: server.url,
      useInstruction: false,
      onTask: (info) => { prewarmed.push(info.prewarmed); },
    });
    tts.prewarm?.();
    await new Promise((resolve) => setTimeout(resolve, 150));
    let bytes = 0;
    for await (const chunk of tts.synthesize('在，哥。')) bytes += chunk.length;
    assert.ok(bytes > 0, '应当出声');
    assert.deepEqual(server.runs, [1]);
    assert.deepEqual(prewarmed, [true]);
  } finally {
    await server.close();
  }
});

test('预开：一直没人认领就到点弃连接（空 task 不能 finish-task）', { timeout: 12000 }, async () => {
  const server = await fakeCosyVoice();
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url, useInstruction: false });
    tts.prewarm?.();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(server.runs, [1], '预开应当已经发出 run-task');
    // TTL 3 s：到点没人要，只能弃连接（发 finish-task 会让服务端判非法并弄死连接）
    await new Promise((resolve) => setTimeout(resolve, 3200));
    let bytes = 0;
    for await (const chunk of tts.synthesize('在，哥。')) bytes += chunk.length;
    assert.ok(bytes > 0, '弃连接之后下一句仍要能出声');
    assert.deepEqual(server.texts, [[], ['在，哥。']], '预开那条连接被弃，第二句走新连接');
  } finally {
    await server.close();
  }
});

test('预开：instruction 模式不预热（语气是开 task 时定死的）', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url, useInstruction: true });
    tts.prewarm?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(server.texts, [], '一条连接都不该建起来');
    let bytes = 0;
    for await (const chunk of tts.synthesize('在，哥。')) bytes += chunk.length;
    assert.ok(bytes > 0);
    assert.deepEqual(server.runs, [1]);
  } finally {
    await server.close();
  }
});

test('预开：参数等价的情绪（happy / calm 都是 1.00）共用一条 task，不弃连接', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  const tasks: { prewarmed: boolean }[] = [];
  try {
    const tts = cosyVoiceTts({
      apiKey: 'sk-test',
      url: server.url,
      useInstruction: false,
      onTask: (i) => { tasks.push({ prewarmed: i.prewarmed }); },
    });
    tts.prewarm?.();   // 用 calm 预开
    await new Promise((resolve) => setTimeout(resolve, 150));
    let bytes = 0;
    for await (const chunk of tts.synthesize('在，哥。', 'happy')) bytes += chunk.length;
    assert.ok(bytes > 0, '应当出声');
    assert.deepEqual(server.texts, [['在，哥。']], 'happy 与 calm 参数相同 → 复用同一条连接，别弃');
    assert.deepEqual(tasks, [{ prewarmed: true }], '这一趟应当认领预开');
  } finally {
    await server.close();
  }
});

test('预开：这一轮语气和预开的不一样就不认领（宁可多花一次握手，也别把语气压平）', { timeout: 5000 }, async () => {
  const server = await fakeCosyVoice();
  const tasks: { prefix: string; prewarmed: boolean }[] = [];
  try {
    const tts = cosyVoiceTts({
      apiKey: 'sk-test',
      url: server.url,
      useInstruction: false,
      onTask: (info) => { tasks.push({ prefix: info.stream ? 'stream' : 'whole', prewarmed: info.prewarmed }); },
    });
    tts.prewarm?.();   // 预开用 calm（rate/pitch 1.00）
    await new Promise((resolve) => setTimeout(resolve, 150));
    let bytes = 0;
    for await (const chunk of tts.synthesize('在，哥。', 'sulk')) bytes += chunk.length;
    assert.ok(bytes > 0, '应当出声');
    assert.deepEqual(tasks, [{ prefix: 'whole', prewarmed: false }], '这条不能算认领预开');
    assert.deepEqual(server.texts, [[], ['在，哥。']], '语气对不上 → 弃连接重来');
  } finally {
    await server.close();
  }
});

test('分批门槛：第一批只要有正文就送，短答不再等整段', () => {
  // 快车道的回答常常不到 10 个字；按 10 字门槛，它们要等到 queue.close()
  // （整段生成结束）才开始合成，「边生成边合成」对短答完全不成立。
  // 首批只送一个字（线上 `COSYVOICE_FIRST_BATCH_CHARS=1`，也是这里的默认）。
  // 注意**只送 1 个字时服务端不开始合成**，要等后续文本到齐才动 —— 探针实测：
  // 隔 2 s 送其余 → 首包 2328 ms；隔 50 ms → 371 ms。所以这一项省的是「等第 2 个
  // token」那 20–35 ms，不是省合成。
  assert.equal(streamBatchReady('行', true), true, '第一批有正文就送（默认 1 字）');
  assert.equal(streamBatchReady('行啊', true), true, '两个字当然也送');
  assert.equal(streamBatchReady('行啊', false), false, '后续批次仍按 10 字攒');
  assert.equal(streamBatchReady('一二三四五六七八九十', false), true);
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

test('句首静音一个字节都不发出去（用户听到的第一个字不该往后拖）', { timeout: 5000 }, async () => {
  // CosyVoice 第一块就是 ~167 ms 数字静音（实测）。原来「攒着等有声块再补发」
  // 会把这段先推给设备 —— 协议上首块时间没变，但用户听到声音的时刻往后拖了 167 ms。
  const silence = Buffer.alloc(4800);                       // 100 ms @ 24 kHz 全零
  const loud = Buffer.alloc(4800);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i);

  const server = await fakeCosyVoice({ frames: [silence, silence, loud, silence, loud] });
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    const queue = new TokenQueue();
    queue.push('这一句要够长才会当成一批送出去。');
    queue.close();

    const got: Buffer[] = [];
    for await (const chunk of tts.synthesizeStream!(queue)) got.push(chunk);

    assert.equal(got.length, 3, '句首两块静音不能出现，句间那块要留');
    assert.equal(isSilentChunk(got[0]!), false, '第一块必须是有声的');
    assert.equal(isSilentChunk(got[1]!), true, '句间停顿要保留');
    assert.equal(isSilentChunk(got[2]!), false);
  } finally {
    await server.close();
  }
});

test('第一块横跨「静音 + 起音」时，块内也要裁掉开头的静音', { timeout: 5000 }, async () => {
  // 服务端一块可能 167 ms：前 120 ms 是 −90 dBFS，后面直接跳到 −15 dBFS。
  // 按整块判 `isSilentChunk` 会被语音拉高，静音就跟着推给设备了。
  const sr = COSYVOICE_SAMPLE_RATE;
  const silence = Buffer.alloc(Math.round(sr * 2 * 0.12));          // 120 ms 数字静音
  const loud = Buffer.alloc(Math.round(sr * 2 * 0.05));
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(Math.round(6000 * Math.sin(i / 20)), i);
  const mixed = Buffer.concat([silence, loud]);

  const server = await fakeCosyVoice({ frames: [mixed, loud] });
  try {
    const tts = cosyVoiceTts({ apiKey: 'sk-test', url: server.url });
    const queue = new TokenQueue();
    queue.push('这一句要够长才会当成一批送出去。');
    queue.close();
    const got: Buffer[] = [];
    for await (const chunk of tts.synthesizeStream!(queue)) got.push(chunk);
    // 第一块应该只剩「起音前 10 ms + 有声那 50 ms」
    const expect = Math.round(sr * 2 * 0.06);
    assert.ok(got[0]!.length <= expect, `第一块还剩 ${got[0]!.length} B，静音没裁干净`);
    assert.equal(isSilentChunk(got[0]!), false);
  } finally {
    await server.close();
  }
});

test('整块都很轻时不裁（宁可多播，也别削掉轻声开头）', () => {
  const sr = COSYVOICE_SAMPLE_RATE;
  const soft = Buffer.alloc(Math.round(sr * 2 * 0.1));
  for (let i = 0; i < soft.length; i += 2) soft.writeInt16LE(Math.round(30 * Math.sin(i / 10)), i);
  assert.equal(trimLeadingSilence(soft, sr).length, soft.length);
});
