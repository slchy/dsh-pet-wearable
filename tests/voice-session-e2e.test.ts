/**
 * VoiceConnection 的本地回环：真 TCP（127.0.0.1，端口 0），真胶水。
 *
 * 覆盖级联出声、Live 直出、同嗓子后台汇报、因果屏障插话、
 * 控制口 /capabilities /say /end_session，以及静默记忆写入。
 * 每条连接在 finally 里拆掉，避免 node:test 被空闲计时器挂住。
 */
import assert from 'node:assert/strict';
import { Server as HttpServer } from 'node:http';
import { connect, Server as NetServer, type Socket } from 'node:net';
import { describe, test } from 'node:test';

import type { DeviceCapabilities } from '../src/devices/primitives.ts';
import {
  DownstreamFrameType,
  FrameDecoder,
  FrameWriter,
  UpstreamFrameType,
  type DecodedFrame,
} from '../src/frame.ts';
import { LiveOrchestrator } from '../src/pipelines/live-orchestrator.ts';
import { CascadeAgent } from '../src/pipelines/cascade-agent.ts';
import type {
  AgentProvider,
  AgentReplyView,
  SttHandlers,
  SttProvider,
  SttSession,
  TtsProvider,
} from '../src/providers.ts';
import type { RealtimeSocket, RealtimeSocketFactory } from '../src/qwen-realtime-asr.ts';
import {
  runVoiceServer,
  type EndpointDetector,
  type VoiceSessionOptions,
} from '../src/voice-session.ts';

const CAPS: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: { glance: { needsUser: false } },
  presence: true,
  power: true,
  summon: true,
  listenStart: true,
  played: true,
  ignorePhrases: [],
};

const LOUD = loudPcm(640);
const SILENCE = Buffer.alloc(640);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loudPcm(bytes: number): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) {
    pcm.writeInt16LE(16_000, i);
  }
  return pcm;
}

async function waitFor(label: string, pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(`超时：${label}`);
    }
    await delay(5);
  }
}

function sse(tokens: readonly string[]): Response {
  const body = tokens
    .map((token) => `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface OmniMsg {
  readonly type: string;
}

/** 测试用 realtime 套接字。生产工厂不会走到这里。 */
class FakeSocket implements RealtimeSocket {
  readyState = 0;
  readonly sent: OmniMsg[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as OmniMsg);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...args: unknown[]) => void);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }

  count(type: string): number {
    return this.sent.reduce((sum, msg) => sum + (msg.type === type ? 1 : 0), 0);
  }

  textIncludes(needle: string): boolean {
    return this.sent.some((msg) => JSON.stringify(msg).includes(needle));
  }
}

class V2Client {
  readonly calls: Array<Record<string, unknown>> = [];
  readonly controls: string[] = [];
  welcome = false;
  closed = false;
  readonly socket: Socket;
  private readonly audio: Buffer[] = [];
  private readonly decoder = new FrameDecoder((message) => {
    throw new Error(message);
  });
  private readonly writer: FrameWriter;

  constructor(socket: Socket) {
    this.socket = socket;
    this.writer = new FrameWriter(socket);
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        this.take(frame);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  static connect(port: number): Promise<V2Client> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const client = new V2Client(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('连接语音口超时'));
      }, 1_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(client);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private take(frame: DecodedFrame): void {
    if (frame.type === DownstreamFrameType.Welcome) {
      this.welcome = true;
      return;
    }
    if (frame.type === DownstreamFrameType.Audio) {
      this.audio.push(Buffer.from(frame.payload));
      return;
    }
    if (frame.type === DownstreamFrameType.Call) {
      const call = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
      this.calls.push(call);
      if (call['op'] === 'listen.start') {
        this.sendPcm(SILENCE);
      }
      return;
    }
    if (frame.type === DownstreamFrameType.Control) {
      this.controls.push(frame.payload.toString('utf8'));
    }
  }

  sendHello(): void {
    this.writer.writeText(UpstreamFrameType.Hello, JSON.stringify({
      proto: 2,
      deviceId: 'e2e',
      token: 't',
      capabilities: CAPS,
    }));
  }

  sendPcm(pcm: Buffer): void {
    this.writer.write(UpstreamFrameType.Audio, pcm);
  }

  sendEvent(event: Record<string, unknown>): void {
    this.writer.writeText(UpstreamFrameType.Event, JSON.stringify(event));
  }

  sendPlayed(): void {
    this.sendEvent({ kind: 'played' });
  }

  audioBytes(): number {
    return this.audio.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  hasBytes(sample: Buffer): boolean {
    return Buffer.concat(this.audio).includes(sample);
  }

  countOp(op: string): number {
    return this.calls.reduce((sum, call) => sum + (call['op'] === op ? 1 : 0), 0);
  }
}

/** 只在宿主真的 `commit()` 且队列里有句子时占号，空封段不推水位。 */
class ScriptedStt implements SttProvider {
  readonly name = 'scripted';
  seq = 0;
  private readonly queued: string[] = [];
  private handlers: SttHandlers | null = null;

  open(handlers: SttHandlers): SttSession {
    this.handlers = handlers;
    return {
      feed: () => {},
      hangup: () => {},
      close: () => {},
      commit: () => { this.commitNext(); },
      commitSeq: () => this.seq,
    };
  }

  push(text: string): void {
    this.queued.push(text);
  }

  injectSentence(text: string, index: number, commitSeq: number): void {
    this.handlers?.onSentence(text, index, commitSeq);
  }

  injectPartial(text: string, commitSeq: number): void {
    this.handlers?.onPartial?.(text, commitSeq);
  }

  private commitNext(): void {
    const text = this.queued.shift();
    if (text === undefined || this.handlers === null) {
      return;
    }
    this.seq += 1;
    const seq = this.seq;
    this.handlers.onPartial?.(text, seq);
    this.handlers.onSentence(text, 0, seq);
  }
}

interface DshCall {
  readonly text: string;
  readonly note: string | undefined;
}

function makeDsh(
  reply: (text: string, note: string | undefined) => Promise<AgentReplyView>,
): { readonly agent: AgentProvider; readonly calls: DshCall[] } {
  const calls: DshCall[] = [];
  const agent: AgentProvider = {
    name: 'dsh',
    async reply(text, _image, note) {
      calls.push({ text, note });
      return await reply(text, note);
    },
    setAnnouncer() {},
    cancelTurn() {},
  };
  return { agent, calls };
}

function makeTts(texts: string[], slow: boolean): TtsProvider {
  return {
    name: 'e2e-tts',
    sampleRate: 24_000,
    async *synthesize(text: string): AsyncGenerator<Buffer> {
      texts.push(text);
      yield Buffer.alloc(96, 0x55);
      if (!slow) {
        return;
      }
      for (let i = 0; i < 15; i += 1) {
        await delay(40);
        yield Buffer.alloc(96, 0x55);
      }
    },
  };
}

const fetchImpl: typeof fetch = async () => sse(['在呀。']);

const JUDGE: EndpointDetector = {
  predict: async () => 0.99,
  stop() {},
};

function sessionOptions(
  agent: AgentProvider,
  stt: SttProvider,
  tts: TtsProvider,
  extra: Partial<VoiceSessionOptions> = {},
): VoiceSessionOptions {
  return {
    port: 0,
    controlPort: 0,
    host: '127.0.0.1',
    ffmpegPath: 'ffmpeg',
    agent,
    stt,
    tts,
    gate: {
      thresholdDbfs: -40,
      holdMs: 80,
      prerollMs: 0,
      commitMs: 20,
      sttCommitMs: 40,
      openQuietMs: 0,
    },
    playbackTailMs: 10,
    archiveDir: '',
    archiveMaxMb: 1,
    archiveKeep: 1,
    photoDir: '',
    photoTimeoutMs: 1_000,
    imageQuestion: '这是什么',
    turnJudge: {
      pythonPath: 'python',
      scriptPath: 'turn-judge.py',
      quietMs: 0,
      extendMs: 0,
      maxExtensions: 0,
      threshold: 0.5,
    },
    turnJudgeClient: JUDGE,
    ...extra,
  };
}

interface PortSpy {
  readonly ports: { control: number; voice: number };
  restore(): void;
}

function installPortSpy(): PortSpy {
  const ports = { control: 0, voice: 0 };
  const proto = NetServer.prototype;
  const orig = proto.listen;
  proto.listen = function (this: NetServer, ...args: unknown[]): NetServer {
    this.once('listening', () => {
      const addr = this.address();
      if (addr === null || typeof addr === 'string') {
        return;
      }
      if (this instanceof HttpServer) {
        ports.control = addr.port;
      } else {
        ports.voice = addr.port;
      }
    });
    return Reflect.apply(orig, this, args) as NetServer;
  } as typeof proto.listen;
  return {
    ports,
    restore() {
      proto.listen = orig;
    },
  };
}

interface Running {
  readonly done: Promise<number>;
  readonly client: V2Client;
  readonly controlPort: number;
  stop(): Promise<number>;
}

async function boot(options: VoiceSessionOptions): Promise<Running> {
  const spy = installPortSpy();
  const done = runVoiceServer(options);
  try {
    await waitFor('监听端口', () => spy.ports.control !== 0 && spy.ports.voice !== 0, 2_000);
    const client = await V2Client.connect(spy.ports.voice);
    client.sendHello();
    await waitFor('Welcome', () => client.welcome, 1_000);
    const controlPort = spy.ports.control;
    return {
      done,
      client,
      controlPort,
      async stop() {
        if (!client.socket.destroyed) {
          client.socket.destroy();
        }
        const code = await Promise.race([
          done,
          delay(2_000).then(() => -1),
        ]);
        if (code === -1) {
          throw new Error('runVoiceServer 没有退出');
        }
        return code;
      },
    };
  } catch (error) {
    if (spy.ports.voice !== 0) {
      const socket = connect({ host: '127.0.0.1', port: spy.ports.voice });
      socket.once('connect', () => { socket.destroy(); });
      socket.once('error', () => { socket.destroy(); });
    }
    await Promise.race([done.then(() => undefined), delay(1_500)]);
    throw error;
  } finally {
    spy.restore();
  }
}

/**
 * 大声帧让能量门打开，尾部静音跨过 20 ms / 40 ms，
 * 让真的 SilenceTriggers 封段并请 STT commit。
 */
async function userSays(stt: ScriptedStt, client: V2Client, text: string): Promise<void> {
  const before = stt.seq;
  stt.push(text);
  for (let i = 0; i < 4; i += 1) {
    client.sendPcm(LOUD);
  }
  await delay(20);
  await delay(55);
  client.sendPcm(SILENCE);
  await waitFor(`commit ${text}`, () => stt.seq > before, 800);
}

async function httpText(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, body: await res.text() };
}

function wireCascade(
  dsh: AgentProvider,
  tts: TtsProvider,
  stt: SttProvider,
): VoiceSessionOptions {
  const cascade = new CascadeAgent({
    inner: dsh,
    apiKey: 'test-key',
    fetchImpl,
    speculate: false,
    prefetch: false,
    partialSpeculate: false,
    delegateEnabled: false,
    hedge: 1,
    log: () => {},
  });
  return sessionOptions(cascade, stt, tts, {
    pipelineMode: 'cascade',
    engine: cascade.toEngine(tts),
  });
}

function wireLive(
  dsh: AgentProvider,
  tts: TtsProvider,
  stt: SttProvider,
  factory: RealtimeSocketFactory,
): VoiceSessionOptions {
  const live = new LiveOrchestrator({ inner: dsh, tts, log: () => {} });
  return sessionOptions(live, stt, tts, {
    pipelineMode: 'live',
    engine: live.toEngine(),
    omniShadow: { apiKey: 'test-key', serve: 'full', socketFactory: factory },
    speakAnnounce: (item, play) => live.speakBackgroundReport(item, play),
    cancelAnnounce: () => { live.cancelBackgroundSpeech(); },
    onFallbackAnnounceSpoken: (item, interrupted) => {
      live.noteFallbackAnnounceSpoken({
        speech: item.speech,
        ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
        ...(item.query === undefined ? {} : { query: item.query }),
      }, interrupted);
    },
  });
}

function readyOmni(socket: FakeSocket): void {
  socket.open();
  socket.message({ type: 'session.updated' });
}

/** 等真封段发出 response.create，再回音频；TCP 上看到字节之后才 response.done。 */
async function fulfillUserTurn(
  socket: FakeSocket,
  client: V2Client,
  audio: Buffer,
  beforeDone?: () => void,
): Promise<void> {
  const before = socket.count('response.create');
  await waitFor('response.create', () => socket.count('response.create') > before, 1_000);
  beforeDone?.();
  socket.message({ type: 'response.audio_transcript.delta', delta: '在呢。' });
  socket.message({ type: 'response.audio.delta', delta: audio.toString('base64') });
  const mark = client.audioBytes();
  await waitFor('下行 PCM', () => client.audioBytes() >= mark + audio.length, 1_500);
  socket.message({ type: 'response.done', response: { status: 'completed' } });
}

describe('VoiceConnection 本地回环', { concurrency: false }, () => {
  test('级联：真上行出声，电量与佩戴进 dsh 注记，played 接进 TurnRunner', async () => {
    const stt = new ScriptedStt();
    const ttsTexts: string[] = [];
    const dsh = makeDsh(async () => ({ text: '还剩百分之七十七。', speech: '还剩百分之七十七。' }));
    const session = await boot(wireCascade(dsh.agent, makeTts(ttsTexts, false), stt));
    try {
      session.client.sendEvent({ kind: 'power', percent: 77 });
      session.client.sendEvent({ kind: 'presence', wearing: true });
      session.client.sendPcm(SILENCE);
      await userSays(stt, session.client, '你好呀');
      await waitFor('级联下行', () => session.client.audioBytes() > 0, 1_500);
      assert.equal(dsh.calls.length, 0, '招呼走快车道，不应叫 dsh');
      assert.ok(ttsTexts.length > 0);
      session.client.sendPlayed();
      await delay(400);
      await userSays(stt, session.client, '帮我查一下电量');
      await waitFor('dsh', () => dsh.calls.length === 1, 1_500);
      const note = dsh.calls[0]?.note ?? '';
      assert.ok(note.includes('电量 77%'), note);
      assert.ok(note.includes('戴着'), note);
      assert.equal(session.client.countOp('audio.stop'), 0, 'played 没接上时第二句会打断');
      session.client.sendPlayed();
      await delay(200);
    } finally {
      await session.stop();
    }
  });

  test('Live：封段后同一条假 WS 的 24 kHz PCM 下行，dsh 与 TTS 都不参与', async () => {
    const stt = new ScriptedStt();
    const ttsTexts: string[] = [];
    const dsh = makeDsh(async () => ({ text: '不该出现', speech: '不该出现' }));
    const box: { socket: FakeSocket | null } = { socket: null };
    const session = await boot(wireLive(
      dsh.agent,
      makeTts(ttsTexts, false),
      stt,
      () => {
        const created = new FakeSocket();
        box.socket = created;
        return created;
      },
    ));
    try {
      const socket = box.socket;
      if (socket === null) {
        throw new Error('omni socket 没建出来');
      }
      readyOmni(socket);
      session.client.sendPcm(SILENCE);
      const audio = Buffer.alloc(960, 0x11);
      const turn = fulfillUserTurn(socket, session.client, audio);
      await userSays(stt, session.client, '你好呀');
      await turn;
      assert.ok(session.client.hasBytes(audio), '下行应是 omni 的 24 kHz PCM');
      assert.equal(dsh.calls.length, 0);
      assert.deepEqual(ttsTexts, []);
      assert.ok(socket.count('input_audio_buffer.commit') >= 1);
      assert.ok(socket.count('response.create') >= 1);
      session.client.sendPlayed();
      await delay(200);
    } finally {
      await session.stop();
    }
  });

  test('Live tool_call：先出垫音，空窗后同一条 WS 念后台结果，TTS 不参与', async () => {
    const stt = new ScriptedStt();
    const ttsTexts: string[] = [];
    const lead = Buffer.alloc(960, 0x33);
    const report = Buffer.alloc(960, 0x22);
    let leadSeen = false;
    let downlink: V2Client | null = null;
    const dsh = makeDsh(async () => {
      leadSeen = downlink?.hasBytes(lead) === true;
      await delay(80);
      return { text: '外面在下雨', speech: '外面在下雨' };
    });
    const box: { socket: FakeSocket | null } = { socket: null };
    const session = await boot(wireLive(
      dsh.agent,
      makeTts(ttsTexts, false),
      stt,
      () => {
        const created = new FakeSocket();
        box.socket = created;
        return created;
      },
    ));
    try {
      const socket = box.socket;
      if (socket === null) {
        throw new Error('omni socket 没建出来');
      }
      downlink = session.client;
      readyOmni(socket);
      session.client.sendPcm(SILENCE);
      const user = fulfillUserTurn(socket, session.client, lead, () => {
        socket.message({
          type: 'response.function_call_arguments.done',
          arguments: JSON.stringify({ request: '今天有什么新闻', reason: '需要外部信息' }),
        });
      });
      const background = (async () => {
        await waitFor(
          '后台 response.create',
          () => socket.count('response.create') >= 2,
          2_500,
        );
        await waitFor('汇报提示', () => socket.textIncludes('外面在下雨'), 1_000);
        socket.message({ type: 'response.audio_transcript.delta', delta: '下雨了。' });
        socket.message({ type: 'response.audio.delta', delta: report.toString('base64') });
        await waitFor('汇报 PCM', () => session.client.hasBytes(report), 1_500);
        socket.message({ type: 'response.done', response: { status: 'completed' } });
      })();
      await userSays(stt, session.client, '今天有什么新闻');
      await user;
      await waitFor('dsh 开工', () => dsh.calls.length === 1, 1_000);
      assert.equal(leadSeen, true, '垫音应在 dsh 返回前已经下行');
      assert.ok(session.client.hasBytes(lead));
      session.client.sendPlayed();
      await background;
      assert.equal(dsh.calls.length, 1);
      assert.ok(dsh.calls[0]?.text.includes('今天有什么新闻'));
      assert.deepEqual(ttsTexts, []);
    } finally {
      await session.stop();
    }
  });

  test('插话：开轮前的 commitSeq 不发 audio.stop，新的 partial 立刻停播', async () => {
    const stt = new ScriptedStt();
    const ttsTexts: string[] = [];
    const dsh = makeDsh(async () => ({ text: '在呀。', speech: '在呀。' }));
    const session = await boot(wireCascade(dsh.agent, makeTts(ttsTexts, true), stt));
    try {
      session.client.sendPcm(SILENCE);
      await userSays(stt, session.client, '你好呀');
      await waitFor('正在出声', () => session.client.audioBytes() > 0, 1_500);
      const base = stt.seq;
      stt.injectSentence('旧残片', 1, base);
      await delay(40);
      assert.equal(session.client.countOp('audio.stop'), 0);
      for (let i = 0; i < 4; i += 1) {
        session.client.sendPcm(LOUD);
      }
      await delay(30);
      stt.injectPartial('等一下', base + 1);
      await waitFor('audio.stop', () => session.client.countOp('audio.stop') >= 1, 200);
    } finally {
      await session.stop();
    }
  });

  test('ToolControl：/capabilities、/say 下行、/end_session 收尾', async () => {
    const stt = new ScriptedStt();
    const ttsTexts: string[] = [];
    const dsh = makeDsh(async () => ({ text: '在呀。', speech: '在呀。' }));
    const session = await boot(wireCascade(dsh.agent, makeTts(ttsTexts, false), stt));
    try {
      session.client.sendPcm(SILENCE);
      const caps = await httpText(session.controlPort, 'GET', '/capabilities');
      assert.equal(caps.status, 200);
      assert.deepEqual(JSON.parse(caps.body), CAPS);
      const say = await httpText(session.controlPort, 'POST', '/say', '你好呀');
      assert.equal(say.status, 200);
      await waitFor('/say 下行', () => session.client.audioBytes() > 0, 1_500);
      session.client.sendPlayed();
      await delay(300);
      const end = await httpText(session.controlPort, 'POST', '/end_session');
      assert.equal(end.status, 200);
      await waitFor('end_session', () => session.client.controls.includes('end_session'), 1_500);
      await waitFor('连接关闭', () => session.client.closed, 1_500);
      assert.ok(session.client.countOp('listen.stop') >= 1);
      const code = await session.stop();
      assert.equal(code, 0);
    } finally {
      await session.stop();
    }
  });

  test('Live：值得记住的话立刻答，dsh 静默写入且不再播报', async () => {
    const stt = new ScriptedStt();
    const ttsTexts: string[] = [];
    const line = '我最喜欢吃辣椒炒肉';
    const dsh = makeDsh(async (text) => {
      await delay(40);
      return { text, speech: text };
    });
    const box: { socket: FakeSocket | null } = { socket: null };
    const session = await boot(wireLive(
      dsh.agent,
      makeTts(ttsTexts, false),
      stt,
      () => {
        const created = new FakeSocket();
        box.socket = created;
        return created;
      },
    ));
    try {
      const socket = box.socket;
      if (socket === null) {
        throw new Error('omni socket 没建出来');
      }
      readyOmni(socket);
      session.client.sendPcm(SILENCE);
      const audio = Buffer.alloc(960, 0x44);
      const turn = fulfillUserTurn(socket, session.client, audio);
      await userSays(stt, session.client, line);
      await turn;
      session.client.sendPlayed();
      const heard = session.client.audioBytes();
      await delay(1_000);
      assert.equal(dsh.calls.length, 1);
      assert.equal(dsh.calls[0]?.text, line);
      assert.deepEqual(ttsTexts, []);
      assert.equal(session.client.audioBytes(), heard);
      assert.equal(session.client.countOp('listen.start'), 0);
    } finally {
      await session.stop();
    }
  });
});
