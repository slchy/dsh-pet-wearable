/**
 * 线协议客户端：自报 `audioIn: 'pcm16'`，直接把解码好的 PCM 送给云端。
 *
 * 和 `tools/fake-phone.ts` 的区别：那个是 **mSBC** 的最小实现（要真眼镜/真 mSBC 流），
 * 这里送 PCM —— 回放真机录音、或用手机录到的声音做测试时，本来就没有 mSBC 可编。
 *
 * 两种模式：
 *
 * **① 向量回放（主用）** —— 把某场真机会话的 `uplink.pcm` 原速重放一遍：
 * ```
 *   node scripts/replay/client.mjs --vector ~/miai-archive/<session> \
 *     --host 127.0.0.1 --port 63993 --tls --token <hex> --device <id> [--turns 3]
 * ```
 * 音频是**真机真录**（真实口音、真实噪声、真实停顿），所以它同时验 ASR 准确率
 * 和延迟；而且同一份向量可以反复喂，改一次代码跑一次，逐段对比。
 *
 * **② 单段/多段 PCM（备用）** —— 手机喇叭播、麦克风录那套 E2E 用它：
 * ```
 *   node scripts/replay/client.mjs --pcm a.pcm[,b.pcm] ...
 * ```
 *
 * `--json` 里的标记是**客户端侧**的：音频起止、每轮首个下行字节。服务端的
 * `tts.first` 只表示"开始往连接写"，不包含手机侧播放。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';

const HEADER = 5;
const UP = { Audio: 1, Image: 2, Wake: 3, Ping: 4, Status: 5, Hello: 6, Event: 7, CaptureImage: 8 };
const DOWN = { Audio: 1, Control: 2, Call: 3, Welcome: 4, Pong: 5 };

/** 上行一块 20 ms（16 kHz / mono / 16 bit = 640 B），与实时节奏一致 */
const CHUNK_BYTES = 640;
const CHUNK_MS = 20;

function opt(argv, flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

function frame(type, payload) {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const argv = process.argv.slice(2);
const host = opt(argv, '--host', '127.0.0.1');
const port = Number(opt(argv, '--port', '63993'));
const token = opt(argv, '--token', '');
/**
 * 要说的那几段 PCM，逗号分隔。**一条连接连说多段**是刻意的：
 * 判停侧车（python + ONNX）跟着连接一起建，只有一条连接里的第 2 轮起才是"热"的。
 * 想量真实稳态延迟就必须这么跑，否则每次都量到冷启动。
 */
const pcmPaths = opt(argv, '--pcm', '').split(',').filter((p) => p !== '');
/** 向量回放：一个会话档案目录（含 `uplink.pcm` + `events.jsonl`） */
const vectorDir = opt(argv, '--vector', '');
const outPath = opt(argv, '--out', '');
const jsonPath = opt(argv, '--json', '');
const rate = Number(opt(argv, '--rate', '16000'));
const tailMs = Number(opt(argv, '--tail', '9000'));
const device = opt(argv, '--device', 'e2e-phone');
const useTls = argv.includes('--tls');

if (pcmPaths.length === 0 && vectorDir === '') {
  console.error('需要 --pcm <一段 PCM16 16k mono>[,第二段…] 或 --vector <会话档案目录>');
  process.exit(2);
}

const users = pcmPaths.map((p) => readFileSync(p));
const perTurn = [];

/**
 * 向量回放参数：读源档案，切出每一轮的**说话片段**。
 *
 * `--mode utterance`（默认）：一轮一轮放，每轮只放用户说话那一段，等回复念完再放
 * 下一轮。这是**回归对比**要的形态 —— 源档案里每轮对应回放里一轮，①②③ 才能逐条比。
 *
 * `--mode stream`：把整段上行原速重放。它更接近"重演一场会话"，但**不可逐轮对账**：
 * 回复变快之后，原本"用户插话打断播报"的那句会变成"干净的新一轮"，轮次结构跟着变。
 *
 * 切法：从 `gate.open.t - prerollMs`（能量门开之前的预卷）到
 * `gate.close.t - gapMs`（真正停嘴的时刻，不减去 2 s 的 hold）+ 300 ms 尾巴。
 */
const vector = vectorDir === ''
  ? null
  : (() => {
    const pcm = readFileSync(`${vectorDir}/uplink.pcm`);
    const events = readFileSync(`${vectorDir}/events.jsonl`, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const mode = opt(argv, '--mode', 'utterance');
    const BYTES_PER_MS = 32; // 16 kHz × 2 B

    const events_of = (name) => events.filter((e) => e.ev === name);
    const opens = events_of('gate.open');
    const closes = events_of('gate.close');
    const sentences = events_of('asr.sentence');

    /** 每句话的 [起, 止] 毫秒：**从上一次结束处接到这一句结束** */
    //
    // 为什么不是"只切说话那一段"：判停器看的是最近这一整段波形。真机当时它手上有
    // 会话开始到当下的全部音频；只给说话前那点静音，它判"说完了"的概率会偏低 ——
    // 实测同一句话 ② 在 149 和 627 之间跳（多等一拍）。从这里接着上一段放，
    // 前导音频就是源档案里的原样，判据才可比。
    const segments = [];
    let closeIdx = 0;
    let cursor = 0;
    for (const open of opens) {
      while (closeIdx < closes.length && closes[closeIdx].t < open.t) {
        closeIdx += 1;
      }
      const close = closes[closeIdx];
      if (close === undefined) {
        break;
      }
      closeIdx += 1;
      // 尾巴给足 800 ms：判停器靠句尾静音判断说完，切在字上同样会多等一拍。
      // 这段落在 `gapMs`（约 2 s）的静音里，不会把下一句带进来。
      const stopMs = Math.min(pcm.length / BYTES_PER_MS, close.t - (close.gapMs ?? 0) + 800);
      if (stopMs > cursor) {
        segments.push({ startMs: cursor, stopMs });
        cursor = stopMs;
      }
    }

    const wantTurns = Number(opt(argv, '--turns', String(segments.length)));
    const totalMs = Math.round(pcm.length / 2 / rate);
    const stopMs = mode === 'stream'
      ? Math.min(totalMs, (events_of('turn.end')[Math.min(wantTurns, events_of('turn.end').length) - 1]?.t ?? totalMs) + 2000)
      : totalMs;
    return {
      pcm,
      mode,
      totalMs,
      stopMs,
      turns: Math.min(wantTurns, Math.max(1, segments.length)),
      segments: mode === 'utterance' ? segments.slice(0, wantTurns) : [],
      sentences: sentences.length,
    };
  })();

const marks = {
  pcmBytes: vector === null ? users.reduce((n, b) => n + b.length, 0) : vector.stopMs * 32,
  rounds: vector === null ? users.length : vector.turns,
  mode: vector === null ? 'pcm' : 'vector',
  control: [],
  calls: [],
  welcomeAt: null,
};
const t0 = Date.now();

const capabilities = {
  audioIn: 'pcm16',
  capture: {},
  presence: false,
  power: false,
  summon: false,
  listenStart: false,
  played: false,
  ignorePhrases: [],
};

const sock = useTls
  ? tlsConnect({ host, port, rejectUnauthorized: false }, onConnect)
  : (await import('node:net')).connect({ host, port }, onConnect);

let buffered = Buffer.alloc(0);
const downChunks = [];
/** 最近一次收到下行音频的时刻，用来判断"这一轮说完了" */
let lastDownAt = 0;

function onConnect() {
  console.log(`已连接 ${useTls ? 'tls' : 'tcp'}://${host}:${port}`);
  sock.write(frame(UP.Hello, Buffer.from(JSON.stringify({
    proto: 2,
    deviceId: device,
    ...(token === '' ? {} : { token }),
    capabilities,
  }), 'utf8')));
}

sock.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= HEADER) {
    const type = buffered.readUInt8(0);
    const len = buffered.readUInt32LE(1);
    if (buffered.length < HEADER + len) break;
    const payload = buffered.subarray(HEADER, HEADER + len);
    buffered = buffered.subarray(HEADER + len);
    if (type === DOWN.Welcome) {
      marks.welcomeAt = Date.now() - t0;
      console.log(`← Welcome ${payload.toString('utf8').slice(0, 120)}`);
    } else if (type === DOWN.Audio) {
      const cur = perTurn[perTurn.length - 1];
      if (cur !== undefined) {
        if (cur.firstDownAt === null) {
          cur.firstDownAt = Date.now() - t0;
          console.log(`← 第 ${perTurn.length} 轮首个下行音频 ${cur.firstDownAt} ms（${payload.length} B）`);
        }
        cur.downBytes += payload.length;
      } else if (marks.firstDownAt === null || marks.firstDownAt === undefined) {
        // 向量回放：客户端不知道轮次边界（那一轮由服务端划分），只记全局首块
        marks.firstDownAt = Date.now() - t0;
        console.log(`← 首个下行音频 ${marks.firstDownAt} ms（${payload.length} B）`);
      }
      lastDownAt = Date.now();
      downChunks.push(Buffer.from(payload));
    } else if (type === DOWN.Control) {
      const text = payload.toString('utf8');
      marks.control.push(text);
      console.log(`← Control ${text}`);
    } else if (type === DOWN.Call) {
      const text = payload.toString('utf8');
      marks.calls.push(text);
      console.log(`← Call ${text}`);
    } else if (type === DOWN.Pong) {
      // 心跳回声，忽略
    } else {
      console.log(`← 未知帧 type=${type} len=${len}`);
    }
  }
});

sock.on('error', (e) => {
  console.error(`✗ ${e.message}`);
});

/** 一块 PCM 的 RMS（16 bit）。用来找「用户真正说完」那一刻。 */
function rmsOf(buf) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
    n += 1;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

/**
 * 掐掉首尾的静音，返回 `[起块, 止块]`（含）。
 *
 * 录音是从"开录"开始算的：前面有 400+ ms 的等待、后面有整整两秒的尾巴。
 * 不掐的话两件事都会错：
 * - 上传时间白等（几秒的静音要按实时节奏送出去）；
 * - 「用户说完 → 听到第一个字」的起点会落在那截尾巴里的**底噪**上（实测
 *   最后一块 RMS 仍 > 250，把延迟多算了 2 秒）。
 *
 * 门限取「峰值的一小截」而不是固定值：手机放在桌上、房间有底噪，绝对阈值
 * 换个房间就不适用。
 */
function voicedRange(pcm) {
  const blocks = [];
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    blocks.push(rmsOf(pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length))));
  }
  const peak = blocks.reduce((m, v) => Math.max(m, v), 0);
  const gate = Math.max(300, peak * 0.08);
  let first = -1;
  let last = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i] > gate) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? [0, blocks.length - 1] : [first, last];
}

/** 说一段：送到"这一轮播完"为止。返回这一轮的标记。 */
async function sayOnce(user, index) {
  const turn = {
    index,
    pcmMs: Math.round((user.length / 2 / rate) * 1000),
    trimmedMs: null,
    lastVoicedAt: null,
    firstDownAt: null,
    downBytes: 0,
  };
  perTurn.push(turn);
  const silence = Buffer.alloc(CHUNK_BYTES);

  const sendChunk = (buf) => {
    sock.write(frame(UP.Audio, buf));
  };

  const [a, b] = voicedRange(user);
  // 前面留 120 ms 预卷：ASR 靠前置能量判断"开始说话"，掐太狠会吃掉第一个声母
  const from = Math.max(0, (a - 6) * CHUNK_BYTES);
  const to = Math.min(user.length, (b + 1) * CHUNK_BYTES);
  turn.trimmedMs = Math.round(((to - from) / 2 / rate) * 1000);
  console.log(`→ [${index}] 掐掉首尾静音：${turn.pcmMs} ms → ${turn.trimmedMs} ms`);

  let off = from;
  while (off < to) {
    const end = Math.min(off + CHUNK_BYTES, to);
    sendChunk(user.subarray(off, end));
    off = end;
    // 只在**有声段**里更新「用户说完」的时刻 —— 尾巴上的底噪不算说话
    if (off >= (b + 1) * CHUNK_BYTES) {
      turn.lastVoicedAt = Date.now() - t0;
    }
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }
  console.log(`→ [${index}] 话音送完，最后一个有声块 ${turn.lastVoicedAt} ms`);

  // 一直送静音，直到这一轮的下行**安静下来**（不再有新的音频块）
  const hardStop = Date.now() + tailMs + 20000;
  let quietSince = 0;
  while (Date.now() < hardStop) {
    sendChunk(silence);
    await new Promise((r) => setTimeout(r, CHUNK_MS));
    if (turn.firstDownAt !== null && lastDownAt > 0 && Date.now() - lastDownAt > 1500) {
      break;
    }
    quietSince = Date.now();
  }
  turn.speechToFirstAudioMs = turn.firstDownAt === null || turn.lastVoicedAt === null
    ? null
    : turn.firstDownAt - turn.lastVoicedAt;
  turn.downMs = Math.round((turn.downBytes / 2 / 24000) * 1000);
  console.log(`→ [${index}] 说完→首音 ${turn.speechToFirstAudioMs} ms，回复 ${turn.downMs} ms`);
  return turn;
}

/**
 * 向量回放：把真机录音原速重放。
 *
 * 时间轴用**绝对时刻**推进（`t0v + 已发字节/32`）而不是每次 `sleep(20)`：
 * `setTimeout` 的实际间隔只会偏长，累加两分钟就差出几百毫秒，而这一遍要量的
 * 正是毫秒级延迟。
 */
async function replayVector() {
  // 等 ASR 把自己的连接建好（服务端日志 `[asr] 已就绪` 实测在 Hello 之后约 1 s）。
  // 不等就会把第一句直接喂给还没连上的识别器 —— 表现是"第一轮永远识别不出来"。
  await new Promise((r) => setTimeout(r, 1200));
  const silence = Buffer.alloc(CHUNK_BYTES);

  if (vector.mode === 'utterance') {
    // 一轮一轮：只放用户说话那一段，等这一轮的下行安静下来再放下一轮
    for (let i = 0; i < vector.segments.length; i += 1) {
      const seg = vector.segments[i];
      const slice = vector.pcm.subarray(seg.startMs * 32, seg.stopMs * 32);
      console.log(`→ [${i + 1}/${vector.segments.length}] ${seg.startMs}–${seg.stopMs} ms（${slice.length} B）`);
      const turn = { index: i + 1, pcmMs: slice.length / 32, trimmedMs: slice.length / 32, lastVoicedAt: null, firstDownAt: null, downBytes: 0 };
      perTurn.push(turn);

      // 每段前面垫 300 ms 静音：能量门要靠"前面安静、这里突然有声"才开门
      for (let k = 0; k < 300 / CHUNK_MS; k += 1) {
        sock.write(frame(UP.Audio, silence));
        await new Promise((r) => setTimeout(r, CHUNK_MS));
      }

      const startedAt = Date.now();
      let sent = 0;
      while (sent < slice.length) {
        const end = Math.min(sent + CHUNK_BYTES, slice.length);
        const due = startedAt + sent / 32;
        const wait = due - Date.now();
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, wait));
        }
        sock.write(frame(UP.Audio, slice.subarray(sent, end)));
        sent = end;
      }
      turn.lastVoicedAt = Date.now() - t0;
      turn.voicedEndAt = Date.now();
      console.log(`   [${i + 1}] 说完，等回复…`);

      // 等到下行安静下来（这一轮播完）。
      //
      // 45 s 是**服务端自己的规则**（`fsm-trace` 里「一轮不许挂超过 45 s」）。
      // 之前这里是 25 s，而 dsh 偶发 21–27 s 才答完（实测 `dsh 27.04 s`）——
      // 客户端先放弃、把下一轮音频送了进去，服务端那轮还挂着，于是
      // `turn.end` 丢失、后面的轮次全部错位，看起来像「回放跑两趟就卡死」。
      const hardStop = Date.now() + 45000;
      // 连首块都没有的轮次不用等满 45 s：8 s 没下行就按「这一轮哑了」记一笔再推进
      const muteIfSilentMs = 8000;
      while (Date.now() < hardStop) {
        sock.write(frame(UP.Audio, silence));
        await new Promise((r) => setTimeout(r, CHUNK_MS));
        if (turn.firstDownAt !== null && lastDownAt > 0 && Date.now() - lastDownAt > 1500) {
          break;
        }
        if (turn.firstDownAt === null && Date.now() - turn.voicedEndAt > muteIfSilentMs) {
          turn.noDownlink = true;
          console.log(`   [${i + 1}] 无下行 ${muteIfSilentMs} ms，判哑，推进下一轮`);
          break;
        }
      }
      turn.speechToFirstAudioMs = turn.firstDownAt === null || turn.lastVoicedAt === null
        ? null
        : turn.firstDownAt - turn.lastVoicedAt;
      turn.downMs = Math.round((turn.downBytes / 2 / 24000) * 1000);

      /**
       * 再等到**这一轮真的播完**才放下一句。
       *
       * 只等「下行安静 1.5 s」不够：下行一停，服务端状态机还停在 `speaking`
       * （它按音频时长估算播完时刻），这时下一句的音频进去就会被当成插话 →
       * `audio.stop` → **回放凭空制造了一次打断**。
       *
       * 真机上用户是听得见的，不会在播完前那一刻开口；回放却会提前 1.5 s 推进。
       * 实测代价：一次假打断之后，某些轮次会再也开不出来（`turn.start` 停住，
       * 但 `asr.sentence` 继续来）—— 17 轮只跑出 4 轮。同一形态在 31 例真机档案里
       * **全部恢复**，所以那是回放的假象，不是线上 bug。
       */
      if (turn.firstDownAt !== null) {
        const playEndAt = turn.firstDownAt + turn.downMs + 500;
        if (Date.now() < playEndAt) {
          while (Date.now() < playEndAt) {
            sock.write(frame(UP.Audio, silence));
            await new Promise((r) => setTimeout(r, CHUNK_MS));
          }
        }
      }
      console.log(`   [${i + 1}] 说完→首音 ${turn.speechToFirstAudioMs} ms，回复 ${turn.downMs} ms`);
    }
    return;
  }

  console.log(`→ 整段回放 ${vector.stopMs} ms / 源 ${vector.totalMs} ms`);
  const pcm = vector.pcm;
  const stopBytes = Math.min(pcm.length, vector.stopMs * 32);
  const startedAt = Date.now();
  let sent = 0;
  while (sent < stopBytes) {
    const end = Math.min(sent + CHUNK_BYTES, stopBytes);
    const due = startedAt + sent / 32;
    const wait = due - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    sock.write(frame(UP.Audio, pcm.subarray(sent, end)));
    sent = end;
  }
  console.log(`→ 向量送完，实际用时 ${Date.now() - startedAt} ms（源长 ${Math.round(stopBytes / 32)} ms）`);

  // 尾巴：最后一句的回复还没念完，别急着断（服务端 `turn.end` 也是按字节估的）
  const until = Date.now() + tailMs;
  while (Date.now() < until) {
    sock.write(frame(UP.Audio, silence));
    await new Promise((r) => setTimeout(r, CHUNK_MS));
    if (lastDownAt > 0 && Date.now() - lastDownAt > 2500) {
      break;
    }
  }
}

async function pump() {
  await new Promise((r) => setTimeout(r, 120)); // 等 Welcome
  for (let i = 0; i < users.length; i += 1) {
    await sayOnce(users[i], i + 1);
  }
}

function finish() {
  const reply = Buffer.concat(downChunks);
  if (outPath !== '') {
    writeFileSync(outPath, reply);
  }
  marks.perTurn = perTurn;
  marks.downBytes = reply.length;
  marks.downMs = Math.round((reply.length / 2 / 24000) * 1000);
  console.log(JSON.stringify({
    rounds: marks.rounds,
    perTurn: perTurn.map((t) => ({
      index: t.index,
      trimmedMs: t.trimmedMs,
      speechToFirstAudioMs: t.speechToFirstAudioMs,
      replyMs: t.downMs,
    })),
    downBytes: marks.downBytes,
    control: marks.control,
    calls: marks.calls,
  }, null, 2));
  if (jsonPath !== '') {
    writeFileSync(jsonPath, JSON.stringify(marks, null, 2));
  }
  if (vector === null) {
    const any = perTurn.some((t) => t.firstDownAt !== null);
    process.exit(any ? 0 : 1);
  }
  process.exit(marks.downBytes > 0 ? 0 : 1);
}

sock.on('close', () => {
  console.log('连接已关闭');
  finish();
});

if (vector === null) {
  await pump();
} else {
  await replayVector();
}
setTimeout(finish, 1500);
