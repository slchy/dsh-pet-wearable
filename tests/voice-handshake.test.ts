/**
 * 握手：没配鉴权就等 1 s 降到 v1；Hello 先到则清掉这只定时器，不再决第二次。
 * 空白记忆不写进影子的静态上下文。
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { DeviceLink } from '../src/devices/index.ts';
import type { Connection, ConnectionHandlers } from '../src/transport.ts';
import {
  HANDSHAKE_WAIT_MS,
  handshake,
  omniStaticContext,
} from '../src/voice/handshake.ts';
import type { VoiceConnection } from '../src/voice/connection.ts';
import type { VoiceService, VoiceSessionOptions } from '../src/voice/session-options.ts';

const FULL_CAPS = {
  audioIn: 'pcm16',
  capture: { glance: { needsUser: false } },
  presence: true,
  power: true,
  summon: false,
  listenStart: true,
  played: false,
  ignorePhrases: [],
};

interface StartCall {
  readonly first: { type: number; payload: Buffer } | undefined;
  readonly resumed: boolean;
}

interface Made {
  readonly link: DeviceLink;
  readonly starts: StartCall[];
  readonly evicts: () => number;
}

function fakeConn(): {
  readonly conn: Connection;
  readonly welcomes: string[];
  handlers(): ConnectionHandlers | null;
} {
  let handlers: ConnectionHandlers | null = null;
  const welcomes: string[] = [];
  const conn = {
    remote: 'dev:1',
    isClosed: false,
    bind: (next: ConnectionHandlers) => { handlers = next; },
    sendWelcome: (text: string) => { welcomes.push(text); },
    sendAudio: () => {},
    sendControl: () => {},
    sendCall: () => {},
    end: () => {},
  } as unknown as Connection;
  return { conn, welcomes, handlers: () => handlers };
}

function service(): VoiceService {
  return {
    control: null as unknown as VoiceService['control'],
    activeSlot: { current: null },
  };
}

test('无鉴权等满 1 s 降级 v1', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fake = fakeConn();
    const slot = service();
    const made: Made[] = [];
    handshake(fake.conn, {} as VoiceSessionOptions, slot, (_conn, _options, link) => {
      const starts: StartCall[] = [];
      let evicts = 0;
      made.push({ link, starts, evicts: () => evicts });
      return {
        evict: () => { evicts += 1; },
        start: (first?: StartCall['first'], resumed = false) => {
          starts.push({ first, resumed });
        },
      } as unknown as VoiceConnection;
    });
    assert.equal(made.length, 0);
    mock.timers.tick(HANDSHAKE_WAIT_MS - 1);
    assert.equal(made.length, 0, '差 1 ms 还不能降级');
    mock.timers.tick(1);
    assert.equal(made.length, 1);
    assert.equal(made[0]?.link.proto, 1);
    assert.equal(fake.welcomes.length, 0, 'v1 不回 Welcome');
    assert.equal(made[0]?.starts.length, 1);
    assert.equal(made[0]?.starts[0]?.resumed, false);
    assert.equal(slot.activeSlot.current !== null, true);
  } finally {
    mock.timers.reset();
  }
});

test('Hello 先到立即清定时器且不二次协商', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const mockedClear = global.clearTimeout;
  let clears = 0;
  global.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    clears += 1;
    return mockedClear(handle);
  }) as typeof clearTimeout;
  try {
    const fake = fakeConn();
    const slot = service();
    const made: Made[] = [];
    handshake(fake.conn, {} as VoiceSessionOptions, slot, (_conn, _options, link) => {
      const starts: StartCall[] = [];
      made.push({ link, starts, evicts: () => 0 });
      return {
        evict: () => {},
        start: (first?: StartCall['first'], resumed = false) => {
          starts.push({ first, resumed });
        },
      } as unknown as VoiceConnection;
    });
    fake.handlers()?.onHello?.({
      proto: 2,
      deviceId: 'glasses',
      capabilities: FULL_CAPS,
    });
    assert.equal(made.length, 1);
    assert.equal(made[0]?.link.proto, 2);
    assert.equal(fake.welcomes.length, 1);
    assert.ok(clears >= 1, 'Hello 到达必须 clearTimeout，不能把 1 s 定时器留着');
    const starts = made[0]?.starts.length ?? 0;
    fake.handlers()?.onHello?.({ proto: 2, deviceId: 'glasses', capabilities: FULL_CAPS });
    mock.timers.tick(HANDSHAKE_WAIT_MS + 500);
    assert.equal(made.length, 1, '第二次 Hello 和到期回调都不能再协商');
    assert.equal(made[0]?.starts.length, starts);
    assert.equal(fake.welcomes.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('空白记忆不传给 omniStaticContext', () => {
  let clocks = 0;
  const clock = (): string => {
    clocks += 1;
    return '2026-11-25';
  };
  const blank = omniStaticContext({
    apiKey: 'k',
    memoryContext: '   ',
    asrCorpusText: '',
    asrLanguage: '\n',
    clockContext: clock,
  });
  assert.equal(clocks, 0, '日期函数要留给影子自己调用');
  assert.equal(blank.clockContext, clock);
  assert.equal('memoryContext' in blank, false);
  assert.equal('asrCorpusText' in blank, false);
  assert.equal('asrLanguage' in blank, false);

  let reads = 0;
  const fromFn = omniStaticContext({
    apiKey: 'k',
    memoryContext: () => {
      reads += 1;
      return '  ';
    },
  });
  assert.equal(reads, 1);
  assert.equal('memoryContext' in fromFn, false);
});
