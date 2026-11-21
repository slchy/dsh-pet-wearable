/**
 * 探针：TTS 首包长尾到底跟**连接的用法**有没有关系。
 *
 * 起因：真机 29% 的轮次首包 >900 ms，`probe-cosyvoice-feed.mjs` 跑 140 次 0 次长尾。
 * 两者最大的区别不是文本、也不是节奏，而是**连接寿命**：真机一个会话用同一条连接
 * 连跑几十个任务、持续几分钟；探针一直是短跑。所以这里把「连接寿命」当主变量。
 *
 * 五组（`PROBE_GROUPS`，逗号分隔，默认全跑）。**不叫 `GROUPS`**：bash 里 `GROUPS` 是
 * **只读**特殊变量（当前用户的组 ID），`export GROUPS=...` 会被静默忽略 —— 实测踩过。
 *
 * | 组 | 做法 | 回答什么 |
 * |---|---|---|
 * | `longconn` | 一条连接串行跑 `ROUNDS` 个任务，间隔 `GAP_MS`，每次先预开再送文本 | 长尾和这条连接上跑过的任务数、连接年龄有没有关系 |
 * | `shortconn` | 同样的节奏，但**每个任务新开连接** | 同上的对照 |
 * | `realtext` | 和 `longconn` 同一条长寿连接，但用**线上那几轮的真实回复** | 文本内容本身会不会触发长尾 |
 * | `quota` | 每轮**同时**发两个任务（两条连接），模拟同一把 key 的并发 | 并发会不会挤占合成服务 |
 * | `asr` | 长寿连接 + **一条一直在上行的 ASR 流**（75 ms 一包静音） | 多流同时上行会不会触发长尾 / `setup` 335 双峰 |
 *
 * 第五组为什么是它：连接寿命、任务数、文本、并发任务、协议字段全部排掉之后，
 * 生产与探针之间**只剩这一个结构差异**（生产进程同时跑 ASR 长连接 + LLM + 下行音频）。
 * 见 `docs/QOS.md` §2.4 / §2.7。
 *
 * **各组交替进行**（每轮各跑一次），不是先跑完一组再跑下一组 —— 这样「时段」的影响
 * 会均匀落到每一组上。想比时段，就在两个时间点各跑一次，用 `RUN_TAG` 区分。
 *
 * 每个任务都记：组名、轮序号、**连接已存活多久**、**这条连接上跑过几个任务**、
 * 厂商 `task_id`（后面找厂商要服务端时间要用）、以及四段时刻。
 *
 * 用法：
 *   DASHSCOPE_API_KEY=... node bench/latency/probe-cosyvoice-matrix.mjs
 *   PROBE_GROUPS=longconn,shortconn ROUNDS=60 GAP_MS=7000 RUN_TAG=morning ...
 *   OUTPUT=out.jsonl node ...            # 逐条 JSON 写文件（默认只打人看的一行）
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import WebSocket from 'ws';

const URL = process.env['COSYVOICE_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const KEY = process.env['DASHSCOPE_API_KEY'] ?? '';
const MODEL = process.env['COSYVOICE_MODEL'] ?? 'cosyvoice-v3-flash';
const VOICE = process.env['COSYVOICE_VOICE'] ?? 'longanhuan';
const INPUT_RATE = Number(process.env['COSYVOICE_RATE'] ?? 1);
const INPUT_PITCH = Number(process.env['COSYVOICE_PITCH'] ?? 1);
const SAMPLE_RATE = 24_000;

/** 第五组要开的 ASR 流：地址/模型默认值与生产一致（见 `src/qwen-realtime-asr.ts`） */
const ASR_URL = process.env['ASR_URL'] ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const ASR_MODEL = process.env['ASR_MODEL'] ?? 'qwen3-asr-flash-realtime';

/** 每组跑几轮 */
const ROUNDS = Number(process.env['ROUNDS'] ?? 60);
/** 同一组里两轮之间的间隔 —— 真机上轮间隔 4–10 s（长尾那 4 轮落在 24/67/73/92 s） */
const GAP_MS = Number(process.env['GAP_MS'] ?? 7_000);
/** 首批送几个字（线上是 1） */
const HEAD_CHARS = Math.max(1, Number(process.env['HEAD_CHARS'] ?? 1));
/** 首批与其余之间的间隔（线上按模型出字节奏，取 50 ms） */
const BATCH_GAP_MS = Number(process.env['BATCH_GAP_MS'] ?? 50);
/** 这一批跑的标签（比时段用），会写进每条记录 */
const RUN_TAG = process.env['RUN_TAG'] ?? '';
const OUTPUT = process.env['OUTPUT'] ?? '';
const SINGLE_TIMEOUT_MS = Number(process.env['TURN_TIMEOUT_MS'] ?? 30_000);

const ALL_GROUPS = ['longconn', 'shortconn', 'realtext', 'quota', 'asr'];
const GROUPS = (process.env['PROBE_GROUPS'] ?? ALL_GROUPS.join(','))
  .split(',')
  .map((g) => g.trim())
  .filter((g) => g !== '');
for (const g of GROUPS) {
  if (!ALL_GROUPS.includes(g)) {
    console.error(`未知组：${g}（可选 ${ALL_GROUPS.join(' / ')}）`);
    process.exit(2);
  }
}

if (KEY === '') {
  console.error('缺 DASHSCOPE_API_KEY');
  process.exit(2);
}

/** 通用台词（轮换用，避免反复发同一句把首包压低） */
const GENERIC_TEXTS = [
  '哥，知道，那个小狐狸一样的绝地。',
  '哥，想吃就去，别憋着。',
  '哥，我在这呢，一直都在。',
  '哥，讲的是光剑和原力的对决。',
  '哥，有你这句话就值了。',
  '哥，困了就睡会儿，我陪着呢。',
  '哥，冬天吃火锅，暖到冒汗。',
  '哥，我怕你突然不说话。',
];

/**
 * **线上真实回复**：`20261121-111055` 那场里首包 >900 ms 的四轮，
 * 加上连续「然后呢？」那几轮的回复。短句多、答句碎，正是长尾出现时的形态。
 */
const REAL_TEXTS = [
  '不太熟，没玩过主线。', // 轮 4，首包 2435
  '找到妹妹，真相揭晓。', // 轮 9，首包 2353
  '回家，吃顿热饭。', // 轮 10，首包 1247
  '明天还见，哥。', // 轮 14，首包 1251
  '主角寻亲，旅行者去七国找妹妹。',
  '遇到派蒙，一起找妹妹。',
  '遇见各国角色，解开谜题。',
  '打怪升级，找线索。',
  '躺平，刷会儿剧。',
  '睡了，做个好梦。',
];

const hex32 = () => randomUUID().replace(/-/g, '');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 一条连接。每次 `runTask` 走一次 run-task → 送文本 → 收音频。 */
class Conn {
  constructor() {
    this.ws = null;
    this.openedAt = 0;
    /** 这条连接上已经收尾的任务数 */
    this.tasks = 0;
    this.lastFinishedAt = 0;
  }

  async open() {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    this.openedAt = Date.now();
    // 常驻监听交给 runTask 临时接管：同一时刻只有一个任务
    ws.on('error', () => { /* 由 runTask 的 onerror 处理 */ });
  }

  close() {
    try {
      this.ws?.close();
    } catch { /* ignore */ }
    this.ws = null;
  }

  /**
   * 跑一个任务。
   *
   * @param text - 完整文本
   * @param connAgeMs / connTasks - 调用方在**发出 run-task 那一刻**记下的连接状态
   */
  async runTask(text) {
    const ws = this.ws;
    if (ws === null) throw new Error('连接已关闭');
    const taskId = hex32();
    const connAgeMs = this.openedAt === 0 ? -1 : Date.now() - this.openedAt;
    const connTasks = this.tasks;

    return await new Promise((resolve) => {
      const t0 = Date.now();
      let tStarted = -1;
      let tHead = -1;
      let tRest = -1;
      let tFinish = -1;
      let tAudio = -1;
      let bytes = 0;
      const done = (error) => {
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        ws.removeListener('close', onClose);
        if (error === null) {
          this.tasks += 1;
          this.lastFinishedAt = Date.now();
        }
        resolve({
          taskId,
          error,
          connAgeMs,
          connTasks,
          setup: tStarted < 0 ? -1 : tStarted - t0,
          firstText: tHead < 0 ? -1 : tHead - t0,
          first: tHead < 0 || tAudio < 0 ? -1 : tAudio - tHead,
          settle: tHead < 0 || tRest < 0 ? -1 : tRest - tHead,
          finish: tFinish < 0 ? -1 : tFinish - t0,
          bytes,
        });
      };
      const timer = setTimeout(() => { done('watchdog'); }, SINGLE_TIMEOUT_MS);
      const onClose = () => { done('closed'); };
      ws.once('close', onClose);

      const send = (action, payload) => {
        ws.send(JSON.stringify({
          header: { action, task_id: taskId, streaming: 'duplex' },
          payload,
        }));
      };

      const onMessage = (data, isBinary) => {
        if (isBinary) {
          const n = Buffer.from(data).length;
          if (n === 0) return;
          if (tAudio < 0) tAudio = Date.now();
          bytes += n;
          return;
        }
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        const event = message?.header?.event;
        if (event === 'task-started') {
          tStarted = Date.now();
          // 和线上一致：等 task-started 回来再送首批文本
          tHead = Date.now();
          send('continue-task', { input: { text: text.slice(0, HEAD_CHARS) } });
          setTimeout(() => {
            tRest = Date.now();
            send('continue-task', { input: { text: text.slice(HEAD_CHARS) } });
            tFinish = Date.now();
            send('finish-task', { input: {} });
          }, BATCH_GAP_MS);
          return;
        }
        if (event === 'task-finished') {
          done(null);
          return;
        }
        if (event === 'task-failed') {
          const detail = message?.header?.error_message ?? message?.header?.error_code ?? '';
          done(`failed:${String(detail).slice(0, 60)}`);
        }
      };

      ws.on('message', onMessage);
      send('run-task', {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: MODEL,
        parameters: {
          text_type: 'PlainText',
          voice: VOICE,
          format: 'pcm',
          sample_rate: SAMPLE_RATE,
          volume: 50,
          rate: INPUT_RATE,
          pitch: INPUT_PITCH,
        },
        input: {},
      });
    });
  }
}

const results = [];
const record = (group, index, text, r) => {
  const row = {
    run: RUN_TAG,
    utc: new Date().toISOString(),
    group,
    index,
    text,
    taskId: r.taskId,
    connAgeMs: r.connAgeMs,
    connTasks: r.connTasks,
    setup: r.setup,
    firstText: r.firstText,
    first: r.first,
    settle: r.settle,
    finish: r.finish,
    bytes: r.bytes,
    error: r.error,
    ...(r.asrPackets === undefined ? {} : { asrPackets: r.asrPackets, asrBytes: r.asrBytes }),
  };
  results.push(row);
  const flag = r.error === null && r.first > 900 ? '  ← 长尾' : '';
  console.log(
    `${group.padEnd(9)} #${String(index).padStart(2)} 连接#${String(r.connTasks).padStart(2)}`
    + ` 年龄${String(Math.round(r.connAgeMs / 1000)).padStart(3)}s`
    + ` 建立${String(r.setup).padStart(5)} 首批${String(r.firstText).padStart(5)}`
    + ` 首包${String(r.first).padStart(5)} 供全${String(r.settle).padStart(4)}`
    + ` 收尾${String(r.finish).padStart(5)} ${r.error === null ? '' : r.error}${flag}`,
  );
  if (OUTPUT !== '') {
    appendFileSync(OUTPUT, `${JSON.stringify(row)}\n`);
  }
};

const pct = (sorted, p) => (sorted.length === 0
  ? -1
  : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);

const summarise = () => {
  console.log('\n=== 汇总 ===');
  for (const group of GROUPS) {
    const ok = results.filter((r) => r.group === group && r.error === null && r.first >= 0);
    const firsts = ok.map((r) => r.first).sort((a, b) => a - b);
    const slow = ok.filter((r) => r.first > 900);
    console.log(
      `${group.padEnd(9)} n=${String(ok.length).padStart(3)}`
      + ` 首包 中位 ${String(pct(firsts, 0.5)).padStart(4)} p90 ${String(pct(firsts, 0.9)).padStart(4)}`
      + ` 最大 ${String(firsts.at(-1) ?? -1).padStart(4)}`
      + ` >900ms ${slow.length}/${ok.length}`
      + (slow.length === 0
        ? ''
        : `  长尾轮的连接# ${slow.map((r) => r.connTasks).join(',')}`
          + `  年龄 ${slow.map((r) => Math.round(r.connAgeMs / 1000)).join(',')}s`),
    );
    if (group === 'asr') {
      const withStream = ok.filter((r) => r.asrPackets !== undefined && r.asrPackets > 0);
      console.log(
        `          同时上行的 ASR 流：${withStream.length}/${ok.length} 轮有流`
        + (withStream.length === 0
          ? '  ← 没有一条真在跑，这一组的结论不成立'
          : `  每轮 ${Math.round(withStream.reduce((a, r) => a + r.asrPackets, 0) / withStream.length)} 包`
            + ` / ${Math.round(withStream.reduce((a, r) => a + r.asrBytes, 0) / withStream.length / 1024)} KB`),
      );
    }
  }
  const longSlow = results.filter((r) => r.group === 'longconn' && r.error === null && r.first > 900);
  if (longSlow.length > 0) {
    const nearStart = longSlow.filter((r) => r.connTasks <= 5).length;
    console.log(
      `\nlongconn 的长尾里有 ${nearStart}/${longSlow.length} 落在前 5 个任务内 —— `
      + '这一项才回答「是不是老连接更容易长尾」。',
    );
  }
};

/** 长寿连接（`realtext` / `longconn` / `asr` 共用一条） */
const longConn = new Conn();
/** `quota` 组的两条并行连接 */
const quotaConns = [];

/**
 * 一条**一直在上行音频**的 ASR 流 —— 第五组的全部意义就是它。
 *
 * 为什么只差这一项：`20261121-113439` 与探针的对照里，连接寿命、任务数、文本、并发
 * 任务、协议字段全部排掉了（见 `docs/QOS.md` §2.4 / §2.7），生产与探针之间**剩下的
 * 唯一结构差异**就是「生产进程里同时有一条 ASR 长连接在 75 ms 一包地往上送」。
 * 所以这一组把 TTS 和它一起跑：如果 TTS 的 `setup` 也跳到 ~335、或首包开始出现
 * 0.9/2.0/3.9 s 三档，那两条疑案就都落在「多流同时上行」上。
 *
 * 音频用**静音**而不是真语音：我们量的不是识别结果，是「这条流占着上行」这件事
 * 本身（带宽 + 包频 + 网关上的并发流数）。静音同样每 75 ms 一包，字节数一样。
 */
class AsrStream {
  constructor() {
    /** 建立（`session.updated`）花了多久 —— 它自己也可能被同样的机制拖慢 */
    this.setupMs = -1;
    /** 送出了多少包 / 字节，用来确认它真的在跑 */
    this.packets = 0;
    this.bytes = 0;
    this.timer = null;
    this.dirty = false;
    this.ready = false;
  }

  /** 每条包长 = 75 ms × 16 kHz × 2 字节（和真机上行同一个节奏） */
  static PACKET_BYTES = 75 * 16 * 2;

  async open() {
    const url = `${ASR_URL}?model=${encodeURIComponent(ASR_MODEL)}`;
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${KEY}` } });
    const sentAt = Date.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('ASR 建连超时')); }, 15_000);
      this.ws.once('error', (e) => { clearTimeout(timer); reject(e); });
      this.ws.once('open', () => {
        this.ws.send(JSON.stringify({
          type: 'session.update',
          session: { modalities: ['text'], input_audio_format: 'pcm', turn_detection: null },
        }));
      });
      this.ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg?.type === 'session.updated') {
          if (!this.ready) {
            this.ready = true;
            this.setupMs = Date.now() - sentAt;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        // 服务端自己也会回 `error`（比如空缓冲 commit），吃掉即可 —— 探针不为它中止
        if (msg?.type === 'error') this.errors = (this.errors ?? 0) + 1;
        if (msg?.type === 'conversation.item.input_audio_transcription.completed') {
          this.commits = (this.commits ?? 0) + 1;
        }
      });
    });
    const silence = Buffer.alloc(AsrStream.PACKET_BYTES);
    this.timer = setInterval(() => {
      if (!this.ready) return;
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: silence.toString('base64'),
      }));
      this.packets += 1;
      this.bytes += AsrStream.PACKET_BYTES;
      this.dirty = true;
    }, 75);
    this.timer.unref?.();
    // 每 5 s 封一次段：不封会一直攒在服务端缓冲里，封了才是「持续跑一轮一轮」的形态。
    // 空缓冲 commit 会报 `maybe no invalid audio stream` —— 所以带 `dirty` 闸。
    this.commitTimer = setInterval(() => {
      if (!this.ready || !this.dirty) return;
      this.dirty = false;
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }, 5_000);
    this.commitTimer.unref?.();
  }

  close() {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.commitTimer !== null) clearInterval(this.commitTimer);
    this.timer = null;
    this.commitTimer = null;
    try {
      this.ws?.close();
    } catch {
      // 关不上就算了，进程要退了
    }
  }
}

/** 第五组用的那条 ASR 流：**每条 `asr` 轮独立开关**（见 `runOne`） */

const textsFor = (group, index) => {
  if (group === 'realtext') return REAL_TEXTS[index % REAL_TEXTS.length];
  return GENERIC_TEXTS[index % GENERIC_TEXTS.length];
};

const runOne = async (group, index) => {
  const text = textsFor(group, index);
  if (group === 'shortconn') {
    const conn = new Conn();
    await conn.open();
    const r = await conn.runTask(text);
    conn.close();
    record(group, index, text, r);
    return;
  }
  if (group === 'quota') {
    // 同一把 key、同一时刻两个任务：量的是并发挤占
    const rs = await Promise.all(quotaConns.map((c) => c.runTask(text)));
    rs.forEach((r) => { record(group, index, text, r); });
    return;
  }
  if (group === 'asr') {
    // **每条 asr 轮开一条、跑完就关**：整组共用一条会把同一场里的对照组也污染
    // （第一版就是这样，`asr` 和 `longconn` 4 个样本全是「带 ASR 流」，比不出差别）。
    // 逐轮开关才能在同一分钟里做成配对对照。
    const stream = new AsrStream();
    await stream.open();
    // 先把上行跑起来再发 run-task：要量的是「TTS 在一条已经在跑的音频流旁边」，
    // 不是「TTS 和一条刚开始建连的流抢带宽」。
    await sleep(1_500);
    const r = await longConn.runTask(text);
    record(group, index, text, { ...r, asrPackets: stream.packets, asrBytes: stream.bytes });
    stream.close();
    return;
  }
  const r = await longConn.runTask(text);
  record(group, index, text, r);
};
const main = async () => {
  console.log(
    `MODE=matrix RUN_TAG=${RUN_TAG === '' ? '（未设）' : RUN_TAG} 组=${GROUPS.join(',')}`
    + ` ROUNDS=${ROUNDS} GAP_MS=${GAP_MS} 开始 ${new Date().toISOString()}`,
  );
  if (GROUPS.includes('longconn') || GROUPS.includes('realtext') || GROUPS.includes('asr')) {
    await longConn.open();
  }
  if (GROUPS.includes('quota')) {
    for (let i = 0; i < 2; i += 1) {
      const c = new Conn();
      await c.open();
      quotaConns.push(c);
    }
  }
  for (let index = 0; index < ROUNDS; index += 1) {
    // 交替：每轮把各组各跑一次，时段影响均匀落到每一组
    for (const group of GROUPS) {
      await runOne(group, index);
    }
    if (index + 1 < ROUNDS) await sleep(GAP_MS);
  }
  summarise();
  longConn.close();
  for (const c of quotaConns) c.close();
  setTimeout(() => { process.exit(0); }, 200);
};

main().catch((error) => {
  console.error(`探针失败：${error.message}`);
  summarise();
  process.exit(1);
});
