/**
 * 连接接管的所有权语义（Wave 3-B）。
 *
 * 要钉住的是**弱网重连**那条路径上三个静默失效：
 *
 * 1. 新连接接管之后，旧连接的迟到 `onClose()` **不许**去清共享槽
 *    （`attachAudioLane` / `setAnnouncer` / `setTaskReporter` / `setAudit` /
 *    `ToolControl` / 回执钩子）。
 *    清掉的后果是「重连之后它不主动说话、不播报、MCP 拍照 503」，而且一条日志都没有。
 * 2. 控制口是**服务级**的：一条连接建一个会在重连时 `EADDRINUSE`，旧 server 还会
 *    把 MCP 的请求路由给已经死掉的连接。
 * 3. `DialogRuntime.dispose()` 摘回执钩子要看所有权（`isActiveOwner`）。
 *
 * 第 1 条直接驱动两条 `VoiceConnection`（不起真 socket，`conn.end()` 与对端断开
 * 在现实中本来就是异步的，测试里手动触发那一次迟到的 `onClose`）；
 * 第 2 条跑真的 `runVoiceServer`（单连接模式：连接一断监听就收尾，端口必须能复用）。
 */
import assert from 'node:assert/strict';
import { connect, createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { SystemClock } from '../src/app/clock.ts';
import { DialogRuntime } from '../src/app/dialog.ts';
import { resolveDeviceLink, type DeviceCapabilities } from '../src/devices/index.ts';
import type { DialogState } from '../src/dialog-fsm.ts';
import { UpstreamFrameType } from '../src/frame.ts';
import {
  cannedStt,
  silentTts,
  type AgentProvider,
  type AgentReplyView,
  type TtsProvider,
} from '../src/providers.ts';
import { startToolControl } from '../src/tool-control.ts';
import type { Connection, ConnectionHandlers, DownlinkSink } from '../src/transport.ts';
import {
  runVoiceServer,
  VoiceConnection,
  type VoiceService,
  type VoiceSessionOptions,
} from '../src/voice-session.ts';

// ---------------------------------------------------------------- 通用桩件

/** 1 ms 的音频（24 kHz、16 bit）—— 只要够触发合成，不占真实时间 */
const TINY_PCM = Buffer.alloc(48, 1);

const TTS: TtsProvider = {
  name: 'fake',
  sampleRate: 24_000,
  async* synthesize() { yield TINY_PCM; },
};

const DOWNLINK: DownlinkSink = { sendAudio: () => {}, sendControl: () => {} };

const V1_CAPS: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: {},
  presence: false,
  power: false,
  summon: false,
  listenStart: false,
  played: false,
  ignorePhrases: [],
};

/** A：只有「看一眼」；B：多了高清与电量。两者的 `/capabilities` 能分辨是谁在接管 */
const CAPS_A: DeviceCapabilities = {
  audioIn: 'pcm16',
  capture: { glance: { needsUser: false } },
  presence: false,
  power: false,
  summon: false,
  listenStart: false,
  played: false,
  ignorePhrases: [],
};

const CAPS_B: DeviceCapabilities = {
  ...CAPS_A,
  capture: { glance: { needsUser: false }, detail: { needsUser: true } },
  power: true,
};

function makeOptions(agent: AgentProvider): VoiceSessionOptions {
  return {
    port: 0,
    host: '127.0.0.1',
    ffmpegPath: 'ffmpeg',
    agent,
    stt: cannedStt(),
    tts: silentTts(24_000),
    gate: { thresholdDbfs: -40, holdMs: 200, prerollMs: 100 },
    playbackTailMs: 0,
    archiveDir: '',
    archiveMaxMb: 1,
    archiveKeep: 1,
    photoDir: '',
    controlPort: 0,
    photoTimeoutMs: 5_000,
    imageQuestion: '这张图里有什么？',
  };
}

interface FakeConnection {
  readonly conn: Connection;
  /** 模拟对端断开 —— 触发 `VoiceConnection.onClose` */
  readonly close: () => void;
  /** 这条连接被主动 `end()` 过几次 */
  readonly ended: () => number;
}

/** 业务层只碰 `Connection` 的这几个成员，所以假连接只要把它们演对 */
function fakeConnection(remote: string): FakeConnection {
  let handlers: ConnectionHandlers | null = null;
  let ended = 0;
  const conn = {
    remote,
    isClosed: false,
    bind: (next: ConnectionHandlers) => { handlers = next; },
    sendAudio: () => {},
    sendControl: () => {},
    sendCall: () => {},
    sendWelcome: () => {},
    end: () => { ended += 1; },
  } as unknown as Connection;
  return {
    conn,
    close: () => { handlers?.onClose('socket closed'); },
    ended: () => ended,
  };
}

/**
 * 记下所有**共享槽**上的动作。
 *
 * 断言方式是「旧连接收尾期间这条日志必须没有新增」—— 而不是看槽里最后的值：
 * 后者会被新连接后来居上覆盖，看不出「旧连接摘过一次」。
 */
function fakeAgent(): { readonly agent: AgentProvider; readonly log: string[] } {
  const log: string[] = [];
  const agent: AgentProvider = {
    name: 'fake',
    reply: async (): Promise<AgentReplyView> => ({ text: '嗯。', speech: '嗯。' }),
    attachAudioLane: (lane) => { log.push(lane === null ? 'lane:null' : 'lane:set'); },
    setAnnouncer: (cb) => { log.push(cb === null ? 'announcer:null' : 'announcer:set'); },
    setDelegateHook: (cb) => { log.push(cb === null ? 'hook:null' : 'hook:set'); },
  };
  return { agent, log };
}

type AuditSink = (name: string, data: Record<string, unknown>) => void;

/**
 * 审计槽：与 `main.ts` 的 `createAuditSlot` 同一套令牌语义。
 *
 * 单测里必须**照抄这条语义**，不然「旧连接带令牌摘自己」这个改动就测不出来 ——
 * 无脑清空的那种槽会让断言碰巧通过，也碰巧在线上丢事件。
 */
function fakeAudit(): {
  readonly set: NonNullable<VoiceSessionOptions['setAudit']>;
  readonly current: () => AuditSink | null;
} {
  let current: AuditSink | null = null;
  return {
    set: (sink, expected) => {
      if (sink === null && expected !== undefined) {
        if (current === expected) {
          current = null;
        }
        return;
      }
      current = sink;
    },
    current: () => current,
  };
}

async function capabilitiesAt(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
    if (!res.ok) {
      return null;
    }
    return await res.json() as Record<string, unknown>;
  } catch {
    // 端口还没起来 / 已经关了：都算「读不到」
    return null;
  }
}

/**
 * 等控制口真的在监听。
 *
 * `ToolControl.port` 读的是 `server.address()`，传 0 时在 `listening` 之前拿到的是
 * `null` → 回落成 0。生产端口是固定值，只有测试会传 0，所以这一步留在测试里。
 */
async function listeningPort(control: { readonly port: number }): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && control.port === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return control.port;
}

/** 轮询到控制口给出期望的能力（或超时，把最后一次结果交回去让断言说话） */
async function waitForCaps(
  port: number,
  expected: DeviceCapabilities | null,
  timeoutMs = 3_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = await capabilitiesAt(port);
    if (expected === null ? last === null : isDeepStrictEqual(last, expected)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

// ---------------------------------------------------------------- 1. 接管与所有权

test('新连接接管：旧连接的迟到收尾不许清掉新连接的车道 / 播报 / 审计 / 控制口', async () => {
  const { agent, log } = fakeAgent();
  const audit = fakeAudit();
  const control = startToolControl({ port: 0, photoTimeoutMs: 1_000, handlers: null });
  const controlPort = await listeningPort(control);
  const service: VoiceService = { control, activeSlot: { current: null } };
  const options: VoiceSessionOptions = { ...makeOptions(agent), setAudit: audit.set };
  const linkA = resolveDeviceLink({ proto: 2, deviceId: 'dev-a', capabilities: CAPS_A });
  const linkB = resolveDeviceLink({ proto: 2, deviceId: 'dev-b', capabilities: CAPS_B });
  const a = fakeConnection('dev-a:1');
  const b = fakeConnection('dev-b:1');
  try {
    // 第一条连接：与 `handshake` 同一套动作（建连接 → 占槽 → start）
    const connA = new VoiceConnection(a.conn, options, linkA, service);
    service.activeSlot.current = connA;
    connA.start();
    assert.deepEqual(await waitForCaps(control.port, CAPS_A), CAPS_A);
    const sinkA = audit.current();
    assert.ok(sinkA !== null, '连上时审计出口应当挂到这条连接的档案上');

    // 第二条连接接管（`handshake` 里那三行的等价形态）
    const connB = new VoiceConnection(b.conn, options, linkB, service);
    const previous = service.activeSlot.current;
    assert.equal(previous, connA, '槽里应当还是第一条连接');
    previous?.evict();
    service.activeSlot.current = connB;
    connB.start();

    assert.equal(a.ended(), 1, '新连接接管时旧连接必须被主动断开');
    assert.equal(b.ended(), 0, '新连接自己不该被断');
    assert.deepEqual(await waitForCaps(control.port, CAPS_B), CAPS_B, '控制口应当已经切到新连接');
    const sinkB = audit.current();
    assert.notEqual(sinkB, sinkA, '审计出口应当换成新连接那一份');

    // 旧连接的**迟到**收尾：线上这是常态（弱网重连时旧 socket 往往后关）
    const before = log.length;
    a.close();
    assert.deepEqual(
      log.slice(before),
      [],
      '旧连接不许摘共享槽：车道 / 播报器 / 回执钩子都归新连接',
    );
    assert.equal(audit.current(), sinkB, '旧连接不许把新连接的审计出口摘掉');
    assert.deepEqual(
      await waitForCaps(control.port, CAPS_B),
      CAPS_B,
      '旧连接不许清掉新连接的控制口 handlers',
    );
    assert.equal(service.activeSlot.current, connB, '旧连接不许清空活跃槽');

    // 当前那条正常收尾：三个共享槽都要摘回 null，控制口回落到「没有设备」
    // （顺序不钉：`app.dispose()` 会顺带把回执钩子摘掉，它排在播报器之前）
    b.close();
    assert.deepEqual(
      log.slice(before).sort(),
      ['announcer:null', 'hook:null', 'lane:null'],
      '当前连接收尾时三个共享槽都要摘',
    );
    assert.equal(audit.current(), null, '当前连接收尾要摘掉自己的审计出口');
    assert.equal(await waitForCaps(control.port, null), null, '没有设备时控制口应当回 503');
    assert.equal(service.activeSlot.current, null, '收尾之后活跃槽应当是空的');
  } finally {
    control.close();
  }
});

// ---------------------------------------------------------------- 2. 服务级控制口

/** 挑一个当前没人用的端口，然后放掉 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

/** 这个端口现在能不能绑上 —— 能绑说明监听真的收了 */
async function isFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.on('error', () => { resolve(false); });
    probe.listen(port, '127.0.0.1', () => { probe.close(() => { resolve(true); }); });
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await check();
}

function helloFrame(deviceId: string, caps: DeviceCapabilities): Buffer {
  const payload = Buffer.from(JSON.stringify({ proto: 2, deviceId, capabilities: caps }), 'utf8');
  const header = Buffer.alloc(5);
  header[0] = UpstreamFrameType.Hello;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function connectClient(port: number, hello: Buffer): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => { resolve(); });
    socket.once('error', reject);
  });
  socket.write(hello);
  return socket;
}

test('服务级控制口：两条连接先后连入不重开端口，收尾后端口释放', async () => {
  const voicePort = await freePort();
  const controlPort = await freePort();
  const { agent } = fakeAgent();
  const base = makeOptions(agent);
  const logged: string[] = [];
  const realLog = console.log;

  console.log = (...args: unknown[]) => { logged.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    // 第一段连接
    const first = runVoiceServer({ ...base, port: voicePort, controlPort, serve: false });
    const client1 = await connectClient(voicePort, helloFrame('dev-1', CAPS_A));
    assert.deepEqual(
      await waitForCaps(controlPort, CAPS_A),
      CAPS_A,
      '连接建立后，服务级控制口应当能读到这台设备的能力',
    );
    client1.end();
    assert.equal(await first, 0, '单连接模式下断开就应当收尾');

    // `runVoiceServer` 的 `finally` 必须把控制口一起关掉：端口不释放，
    // 下一次连接 / 下一次启动就 EADDRINUSE（这正是「每条连接建一个」的老毛病）
    assert.ok(await waitUntil(() => isFree(controlPort)), '控制口没有被释放');
    assert.ok(await waitUntil(() => isFree(voicePort)), '监听口没有被释放');

    // 第二段连接：同一对端口还能起来，说明上一轮真的收干净了
    const second = runVoiceServer({ ...base, port: voicePort, controlPort, serve: false });
    const client2 = await connectClient(voicePort, helloFrame('dev-2', CAPS_B));
    assert.deepEqual(
      await waitForCaps(controlPort, CAPS_B),
      CAPS_B,
      '第二条连接的控制口必须是新起的那个（旧 server 没关就绑不上，读到的会是 null）',
    );
    client2.end();
    assert.equal(await second, 0);
    assert.ok(
      !logged.join('\n').includes('EADDRINUSE'),
      `控制口不该 EADDRINUSE：\n${logged.join('\n')}`,
    );
  } finally {
    console.log = realLog;
  }
});

// ---------------------------------------------------------------- 3. DialogRuntime.dispose

function dialogRuntime(
  agent: AgentProvider,
  overrides: { isActiveOwner?: () => boolean; onDialogState?: (state: DialogState) => void } = {},
): DialogRuntime {
  return new DialogRuntime({
    clock: new SystemClock(),
    caps: V1_CAPS,
    agent,
    tts: TTS,
    downlink: DOWNLINK,
    imageQuestion: '',
    photoDir: '',
    photoTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    playbackTailMs: 0,
    ...(overrides.isActiveOwner === undefined ? {} : { isActiveOwner: overrides.isActiveOwner }),
    env: {
      call: () => true,
      assemble: () => {},
      end: () => {},
      ...(overrides.onDialogState === undefined ? {} : { onDialogState: overrides.onDialogState }),
    },
    log: () => {},
  });
}

test('DialogRuntime.dispose 只摘自己的回执钩子', () => {
  const hooks: unknown[] = [];
  const agent: AgentProvider = {
    name: 'fake',
    reply: async (): Promise<AgentReplyView> => ({ text: '', speech: '' }),
    setDelegateHook: (cb) => { hooks.push(cb); },
  };

  const stale = dialogRuntime(agent, { isActiveOwner: () => false });
  assert.equal(typeof hooks.at(-1), 'function', '构造时应当把回执钩子挂到 agent 上');
  stale.dispose();
  assert.equal(typeof hooks.at(-1), 'function', '不是当前所有者 → 旧连接的 dispose 不许摘别人的钩子');
  assert.equal(hooks.length, 1, '旧连接的 dispose 不该再碰 agent 上的钩子');

  const owner = dialogRuntime(agent);
  assert.equal(typeof hooks.at(-1), 'function', '新连接构造时应当重新挂上自己的钩子');
  owner.dispose();
  assert.equal(hooks.at(-1), null, '自己是当前所有者 → dispose 必须把钩子摘掉');
});

test('重连接管：旧连接的迟到收尾不许清掉新连接的 setTaskReporter', async () => {
  const log: string[] = [];
  let reporter: unknown = null;
  const agent: AgentProvider = {
    name: 'fake',
    reply: async (): Promise<AgentReplyView> => ({ text: '嗯。', speech: '嗯。' }),
    attachAudioLane: (lane) => { log.push(lane === null ? 'lane:null' : 'lane:set'); },
    setAnnouncer: (cb) => { log.push(cb === null ? 'announcer:null' : 'announcer:set'); },
    setDelegateHook: (cb) => { log.push(cb === null ? 'hook:null' : 'hook:set'); },
    setTaskReporter: (cb) => {
      reporter = cb;
      log.push(cb === null ? 'reporter:null' : 'reporter:set');
    },
  };
  const control = startToolControl({ port: 0, photoTimeoutMs: 1_000, handlers: null });
  await listeningPort(control);
  const service: VoiceService = { control, activeSlot: { current: null } };
  const options = makeOptions(agent);
  const linkA = resolveDeviceLink({ proto: 2, deviceId: 'dev-a', capabilities: CAPS_A });
  const linkB = resolveDeviceLink({ proto: 2, deviceId: 'dev-b', capabilities: CAPS_B });
  const a = fakeConnection('dev-a:1');
  const b = fakeConnection('dev-b:1');
  try {
    const connA = new VoiceConnection(a.conn, options, linkA, service);
    service.activeSlot.current = connA;
    connA.start();
    const reporterA = reporter;
    assert.equal(typeof reporterA, 'function', '第一条连接应当挂上自己的 setTaskReporter');

    const connB = new VoiceConnection(b.conn, options, linkB, service);
    service.activeSlot.current?.evict();
    service.activeSlot.current = connB;
    connB.start();
    const reporterB = reporter;
    assert.equal(typeof reporterB, 'function', '新连接应当换上自己的 setTaskReporter');
    assert.notEqual(reporterB, reporterA, '两条连接的 reporter 不能是同一个闭包');

    const before = log.length;
    a.close();
    assert.equal(reporter, reporterB, '旧连接的迟到收尾不许把新连接的 setTaskReporter 清成 null');
    assert.deepEqual(log.slice(before), [], '旧连接不许再写车道 / 播报器 / 回执钩子 / setTaskReporter');
    assert.equal(service.activeSlot.current, connB, '旧连接不许清空活跃槽');

    b.close();
    assert.equal(reporter, null, '当前连接收尾要摘掉自己的 setTaskReporter');
    assert.ok(
      log.slice(before).includes('reporter:null'),
      '当前连接收尾应当调用 setTaskReporter(null)',
    );
  } finally {
    control.close();
  }
});

test('cascade 只读影子：pipelineMode=cascade 且 serve=off 时不得把探针挂到 agent', async () => {
  const lanes: unknown[] = [];
  const agent: AgentProvider = {
    name: 'fake',
    reply: async (): Promise<AgentReplyView> => ({ text: '', speech: '' }),
    attachAudioLane: (lane) => { lanes.push(lane); },
  };
  const control = startToolControl({ port: 0, photoTimeoutMs: 1_000, handlers: null });
  await listeningPort(control);
  const service: VoiceService = { control, activeSlot: { current: null } };
  const options: VoiceSessionOptions = {
    ...makeOptions(agent),
    pipelineMode: 'cascade',
    omniShadow: { apiKey: 'probe-key', serve: 'off' },
  };
  const link = resolveDeviceLink({ proto: 2, deviceId: 'dev-probe', capabilities: CAPS_A });
  const fake = fakeConnection('dev-probe:1');
  const conn = new VoiceConnection(fake.conn, options, link, service);
  service.activeSlot.current = conn;
  try {
    conn.start();
    assert.deepEqual(
      lanes,
      [],
      '只读探针与 agent 互斥：启动期间不得调用 attachAudioLane',
    );
  } finally {
    fake.close();
    control.close();
  }
  assert.deepEqual(
    lanes.filter((lane) => lane !== null),
    [],
    '整段生命周期都不得把探针交给 attachAudioLane',
  );
});

test('状态机被直接驱动（不经过 dispatch）也要通知 onDialogState', () => {
  const states: DialogState[] = [];
  const runtime = dialogRuntime(
    { name: 'fake', reply: async () => ({ text: '', speech: '' }) },
    { onDialogState: (state) => { states.push(state); } },
  );
  try {
    // 生产上 `SessionCore` 会直接调 `fsm.requestEnd()` / `abortAwaitShot()`；
    // 只在 `dispatch()` 结尾通知的话，这类转移一条都到不了 AppSession。
    runtime.core.fsm.requestEnd();
    assert.deepEqual(states, ['ending'], '状态机转移必须驱动 onDialogState');
  } finally {
    runtime.dispose();
  }
});
