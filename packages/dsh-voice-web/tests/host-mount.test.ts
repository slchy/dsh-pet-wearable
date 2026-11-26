/**
 * 宿主挂载：桌面/网页双通道注入、精灵白名单、写保护，以及 WS 文本与 TCP 二进制分轨。
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WebSocket, type RawData } from 'ws';

import { HostSecurityGuard } from '../src/host-security.ts';
import {
  ASSETS_PREFIX,
  CONFIG_PATH,
  DESKTOP_WIDGET_ROW_TEXT,
  MODELS_PATH,
  PET_SPRITE_NAMES,
  SESSION_PATH,
  STATE_PATH,
  WIDGET_SCRIPT_PATH,
  WS_UPGRADE_PATH,
  appendDesktopWidgetInjection,
  injectWidgetIntoHtml,
  mountVoiceHost,
  type HostMountHandle,
  type HostMountOptions,
  type HostPetState,
  type HostWebRoute,
  type HostWebServer,
  type HostWebUpgradeRoute,
} from '../src/host-mount.ts';
import {
  maskApiKey,
  type FetchModelsRequest,
  type VoiceConfigUpdateRequest,
} from '../src/voice-overrides.ts';

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup();
    } catch {
      // 失败用例的收尾不能挡住其余测试。
    }
  }
});

test('桌面注入只追加一次，HTML 注入在 </body> 前且幂等', () => {
  assert.equal(WIDGET_SCRIPT_PATH, '/dsh-voice/widget.js');
  assert.equal(WS_UPGRADE_PATH, '/dsh-voice/ws');
  assert.equal(ASSETS_PREFIX, '/dsh-voice/assets');
  assert.equal(STATE_PATH, '/dsh-voice/state');
  assert.equal(SESSION_PATH, '/dsh-voice/session');
  assert.deepEqual(PET_SPRITE_NAMES, [
    'calm',
    'speaking',
    'listening',
    'happy',
    'proud',
    'surprised',
    'worried',
    'sulk',
    'angry',
    'disgust',
  ]);
  assert.equal(DESKTOP_WIDGET_ROW_TEXT.includes('script-src'), false);
  assert.equal(DESKTOP_WIDGET_ROW_TEXT.includes('__DSH_VOICE_PET_BOOTED__'), true);

  const table: unknown[] = [];
  appendDesktopWidgetInjection(table);
  appendDesktopWidgetInjection(table);
  assert.equal(table.length, 1);
  assert.deepEqual(table[0], {
    kind: 'script',
    placement: 'body',
    text: DESKTOP_WIDGET_ROW_TEXT,
  });

  const legacySrc: unknown[] = [{
    kind: 'script-src',
    placement: 'body',
    src: '/dsh-voice/widget.js',
  }];
  appendDesktopWidgetInjection(legacySrc);
  assert.equal(legacySrc.length, 1);

  const legacyQuery: unknown[] = [{
    kind: 'script-src',
    placement: 'head',
    src: '/dsh-voice/widget.js?v=1',
  }];
  appendDesktopWidgetInjection(legacyQuery);
  assert.equal(legacyQuery.length, 1);

  const legacyScript: unknown[] = [{
    kind: 'script',
    placement: 'head',
    text: 'load("/dsh-voice/widget.js")',
  }];
  appendDesktopWidgetInjection(legacyScript);
  assert.equal(legacyScript.length, 1);

  const unrelated: unknown[] = [{ kind: 'script', placement: 'head', text: 'console.log(1)' }];
  appendDesktopWidgetInjection(unrelated);
  assert.equal(unrelated.length, 2);
  assert.deepEqual(unrelated[1], {
    kind: 'script',
    placement: 'body',
    text: DESKTOP_WIDGET_ROW_TEXT,
  });

  const preload: unknown[] = [{ kind: 'script-preload', src: '/dsh-voice/widget.js' }];
  appendDesktopWidgetInjection(preload);
  assert.equal(preload.length, 2);

  assert.doesNotThrow(() => {
    appendDesktopWidgetInjection(undefined);
    appendDesktopWidgetInjection(null);
    appendDesktopWidgetInjection('nope');
    appendDesktopWidgetInjection({ push(): void { throw new Error('not an array'); } });
  });

  const html = '<html><body><p>hi</p></body></html>';
  const once = injectWidgetIntoHtml(html);
  assert.equal(
    once,
    '<html><body><p>hi</p><script defer src="/dsh-voice/widget.js"></script></body></html>',
  );
  assert.equal(injectWidgetIntoHtml(once), once);
  assert.equal(
    injectWidgetIntoHtml('<p>already /dsh-voice/widget.js</p></body>'),
    '<p>already /dsh-voice/widget.js</p></body>',
  );
  assert.equal(
    injectWidgetIntoHtml('<p>x</p>'),
    '<p>x</p><script defer src="/dsh-voice/widget.js"></script>',
  );
});

test('widget、精灵白名单和状态', { timeout: 15_000 }, async () => {
  const fixture = await startFixture({
    getState: () => ({
      ok: true,
      pipelineMode: 'cascade',
      boundSessionId: 's-1',
      sessions: [{ id: 's-1' }],
      wsPath: WS_UPGRADE_PATH,
      assetsPrefix: ASSETS_PREFIX,
    }),
  });
  try {
    assert.deepEqual(fixture.routeKeys().sort(), [
      'exact /dsh-voice/config',
      'exact /dsh-voice/models',
      'exact /dsh-voice/session',
      'exact /dsh-voice/state',
      'exact /dsh-voice/widget.js',
      'prefix /dsh-voice/assets',
    ]);
    assert.deepEqual(fixture.upgradePaths(), [WS_UPGRADE_PATH]);
    assert.equal(
      fixture.applyTaps('<html><body></body></html>'),
      '<html><body><script defer src="/dsh-voice/widget.js"></script></body></html>',
    );

    const first = await httpCall(fixture.port, 'GET', '/dsh-voice/widget.js?t=1');
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.body.toString('utf8'), 'console.log("v1")\n');

    const v2At = new Date('2020-01-01T00:00:02Z');
    writeFileSync(fixture.widgetPath, 'console.log("v2")\n');
    utimesSync(fixture.widgetPath, v2At, v2At);
    const second = await httpCall(fixture.port, 'GET', WIDGET_SCRIPT_PATH);
    assert.equal(second.status, 200);
    assert.equal(second.body.toString('utf8'), 'console.log("v2")\n');

    unlinkSync(fixture.widgetPath);
    const missing = await httpCall(fixture.port, 'GET', WIDGET_SCRIPT_PATH);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(missing.body.toString('utf8'), /dsh-voice widget unavailable/);

    const calm = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/calm.webp');
    assert.equal(calm.status, 200);
    assert.equal(calm.headers['content-type'], 'image/webp');
    assert.equal(calm.headers['cache-control'], 'public, max-age=3600');
    assert.deepEqual(calm.body, fixture.calmBytes);

    const queried = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/calm.webp?v=1');
    assert.equal(queried.status, 200);
    assert.deepEqual(queried.body, fixture.calmBytes);

    const png = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/happy.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.headers['cache-control'], 'public, max-age=3600');
    assert.equal(png.body.toString('utf8'), 'PNG-HAPPY');

    const leaked = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/secret.webp');
    assert.equal(leaked.status, 404);
    assert.equal(leaked.body.toString('utf8'), 'not found');

    const unknown = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/nope.webp');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.toString('utf8'), 'not found');

    const nested = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/calm/calm.webp');
    assert.equal(nested.status, 404);
    assert.equal(nested.body.toString('utf8'), 'not found');

    const encoded = await httpCall(fixture.port, 'GET', '/dsh-voice/assets/%2e%2e/secret');
    assert.equal(encoded.status, 404);
    assert.equal(encoded.body.toString('utf8'), 'not found');

    const traversal = await rawRequest(
      fixture.port,
      'GET /dsh-voice/assets/../secret HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
    );
    assert.equal(traversal.status, 404);
    assert.equal(traversal.raw.includes('TOP-SECRET'), false);
    assert.equal(traversal.raw.includes('not found'), true);

    const state = await httpCall(fixture.port, 'GET', STATE_PATH);
    assert.equal(state.status, 200);
    assert.equal(state.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(state.headers['cache-control'], 'no-store');
    const parsed = JSON.parse(state.body.toString('utf8')) as HostPetState;
    assert.deepEqual(parsed, {
      ok: true,
      pipelineMode: 'cascade',
      boundSessionId: 's-1',
      sessions: [{ id: 's-1' }],
      wsPath: WS_UPGRADE_PATH,
      assetsPrefix: ASSETS_PREFIX,
    });
  } finally {
    await fixture.stop();
  }
});

test('POST /dsh-voice/config 与 /dsh-voice/models：安全栅栏、防注入、脱敏回显与模型拉取', { timeout: 15_000 }, async () => {
  const configCalls: Array<{ reset: true } | { reset: false; value: VoiceConfigUpdateRequest }> = [];
  const modelCalls: FetchModelsRequest[] = [];
  let mode: 'default' | 'live' | 'cascade' = 'default';
  let dashKey = '';
  let liveBaseUrl = '';
  let liveKey = '';
  let liveModel = '';
  const makeState = (): HostPetState => ({
    ok: true,
    pipelineMode: mode === 'cascade' ? 'cascade' : 'live',
    boundSessionId: null,
    sessions: [],
    wsPath: WS_UPGRADE_PATH,
    assetsPrefix: ASSETS_PREFIX,
    voiceReady: true,
    voiceError: null,
    voiceConfig: {
      mode,
      defaultMode: {
        apiKeyMasked: maskApiKey(dashKey),
        hasApiKey: dashKey !== '',
      },
      live: {
        baseUrl: liveBaseUrl,
        apiKeyMasked: maskApiKey(liveKey),
        hasApiKey: liveKey !== '',
        model: liveModel,
        asrModel: '',
      },
      cascade: {
        sttBaseUrl: '',
        sttApiKeyMasked: null,
        hasSttApiKey: false,
        sttModel: '',
        ttsReuseStt: false,
        ttsBaseUrl: '',
        ttsApiKeyMasked: null,
        hasTtsApiKey: false,
        ttsModel: '',
        ttsVoice: '',
      },
      active: {
        mode,
        pipeline: mode === 'cascade' ? 'cascade' : 'live',
        detail: mode === 'default' ? '默认优化' : `${mode} · ${liveModel}`,
      },
      envFileHint: '~/.dsh/.env',
      reloading: false,
    },
  });
  const fixture = await startFixture({
    getState: makeState,
    onUpdateConfig(req) {
      configCalls.push(req);
      if (req.reset) {
        mode = 'default';
      } else {
        mode = req.value.mode;
        if (req.value.defaultMode?.apiKey !== undefined) dashKey = req.value.defaultMode.apiKey;
        if (req.value.live?.baseUrl !== undefined) liveBaseUrl = req.value.live.baseUrl;
        if (req.value.live?.apiKey !== undefined) liveKey = req.value.live.apiKey;
        if (req.value.live?.model !== undefined) liveModel = req.value.live.model;
      }
      return makeState();
    },
    onFetchModels(req) {
      modelCalls.push(req);
      return {
        ok: true,
        endpoint: 'https://relay.example.com/v1/models',
        models: [
          { id: 'gpt-realtime', ownedBy: 'openai' },
          { id: 'gpt-4o-mini-transcribe', ownedBy: 'openai' },
        ],
      };
    },
  });
  try {
    // 非 POST 返回 405
    assert.equal((await httpCall(fixture.port, 'GET', CONFIG_PATH)).status, 405);
    assert.equal((await httpCall(fixture.port, 'GET', MODELS_PATH)).status, 405);

    // 非回环 Host 写请求拒绝
    const remoteBody = JSON.stringify({ mode: 'cascade' });
    const remote = await httpCall(fixture.port, 'POST', CONFIG_PATH, {
      headers: {
        host: 'evil.example',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(remoteBody)),
      },
      body: remoteBody,
    });
    assert.equal(remote.status, 403);
    assert.equal(configCalls.length, 0);

    // 换行 .env 注入与非法 URL 协议拒绝（400）
    const injectBody = JSON.stringify({ mode: 'default', defaultMode: { apiKey: 'sk-a\nINJECT=1' } });
    const rejected = await httpCall(fixture.port, 'POST', CONFIG_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(injectBody)),
      },
      body: injectBody,
    });
    assert.equal(rejected.status, 400);
    assert.equal(configCalls.length, 0);

    // 写入自定义 Live Base URL + API Key，回传脱敏密钥且不含明文
    const rawSecret = 'sk-live-supersecret-4321';
    const custom = JSON.stringify({
      mode: 'live',
      live: {
        baseUrl: 'https://relay.example.com/v1',
        apiKey: rawSecret,
        model: 'gpt-realtime',
      },
    });
    const ok = await httpCall(fixture.port, 'POST', CONFIG_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(custom)),
      },
      body: custom,
    });
    assert.equal(ok.status, 200);
    const rawRespText = ok.body.toString('utf8');
    assert.equal(rawRespText.includes(rawSecret), false);
    const body = JSON.parse(rawRespText) as { ok: boolean; state: HostPetState };
    assert.equal(body.ok, true);
    assert.equal(body.state.voiceConfig?.mode, 'live');
    assert.equal(body.state.voiceConfig?.live.apiKeyMasked, 'sk-liv****4321');
    assert.equal(configCalls.length, 1);

    // 拉取可用模型表（/dsh-voice/models）
    const fetchBody = JSON.stringify({ slot: 'live', baseUrl: 'https://relay.example.com/v1' });
    const fetched = await httpCall(fixture.port, 'POST', MODELS_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(fetchBody)),
      },
      body: fetchBody,
    });
    assert.equal(fetched.status, 200);
    const fetchedJson = JSON.parse(fetched.body.toString('utf8')) as {
      ok: boolean;
      endpoint: string;
      models: Array<{ id: string }>;
    };
    assert.equal(fetchedJson.ok, true);
    assert.equal(fetchedJson.models[0]?.id, 'gpt-realtime');
    assert.equal(modelCalls.length, 1);

    // 非回环 POST /dsh-voice/models 也受安全栅栏拦截
    const remoteModels = await httpCall(fixture.port, 'POST', MODELS_PATH, {
      headers: {
        host: 'evil.example',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(fetchBody)),
      },
      body: fetchBody,
    });
    assert.equal(remoteModels.status, 403);

    // 切回默认优化方案
    const resetBody = JSON.stringify({ reset: true });
    const resetRes = await httpCall(fixture.port, 'POST', CONFIG_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(resetBody)),
      },
      body: resetBody,
    });
    assert.equal(resetRes.status, 200);
    const resetParsed = JSON.parse(resetRes.body.toString('utf8')) as { ok: boolean; state: HostPetState };
    assert.equal(resetParsed.state.voiceConfig?.mode, 'default');
  } finally {
    await fixture.stop();
  }
});

test('跨站与非回环写被拒绝，回环 POST 能改会话', { timeout: 15_000 }, async () => {
  const calls: Array<string | null> = [];
  let bound: string | null = null;
  const fixture = await startFixture({
    onSelectSession(sessionId) {
      calls.push(sessionId);
      bound = sessionId === null ? 's-new' : sessionId;
      return { sessionId: bound };
    },
    getState: () => ({
      ok: true,
      pipelineMode: 'live',
      boundSessionId: bound,
      sessions: [],
      wsPath: WS_UPGRADE_PATH,
      assetsPrefix: ASSETS_PREFIX,
    }),
  });
  try {
    const cross = await httpCall(fixture.port, 'GET', WIDGET_SCRIPT_PATH, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(cross.status, 403);
    assert.equal(calls.length, 0);

    const upgrade = await rejectedUpgrade(fixture.port, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(upgrade, 403);
    assert.equal(fixture.connections.length, 0);

    const hijack = JSON.stringify({ sessionId: 'hijack' });
    const remote = await httpCall(fixture.port, 'POST', SESSION_PATH, {
      headers: {
        host: 'app.example',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(hijack)),
      },
      body: hijack,
    });
    assert.equal(remote.status, 403);
    assert.equal(bound, null);
    assert.equal(calls.length, 0);

    const selected = JSON.stringify({ sessionId: 's-1' });
    const ok = await httpCall(fixture.port, 'POST', SESSION_PATH, {
      headers: {
        host: '127.0.0.1',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(selected)),
      },
      body: selected,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(ok.body.toString('utf8')), { ok: true, sessionId: 's-1' });
    assert.deepEqual(calls, ['s-1']);
    assert.equal(bound, 's-1');

    const state = await httpCall(fixture.port, 'GET', STATE_PATH);
    assert.deepEqual(JSON.parse(state.body.toString('utf8')), {
      ok: true,
      pipelineMode: 'live',
      boundSessionId: 's-1',
      sessions: [],
      wsPath: WS_UPGRADE_PATH,
      assetsPrefix: ASSETS_PREFIX,
    });

    const created = JSON.stringify({ action: 'create' });
    const create = await httpCall(fixture.port, 'POST', SESSION_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(created)),
      },
      body: created,
    });
    assert.equal(create.status, 200);
    assert.deepEqual(JSON.parse(create.body.toString('utf8')), { ok: true, sessionId: 's-new' });
    assert.deepEqual(calls, ['s-1', null]);

    const bad = await httpCall(fixture.port, 'POST', SESSION_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
      },
      body: '{',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(calls, ['s-1', null]);

    const huge = ' '.repeat((16 * 1024) + 1);
    const oversize = await httpCall(fixture.port, 'POST', SESSION_PATH, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(huge)),
      },
      body: huge,
    });
    assert.equal(oversize.status, 413);
    assert.deepEqual(calls, ['s-1', null]);

    const method = await httpCall(fixture.port, 'GET', SESSION_PATH);
    assert.equal(method.status, 405);
    assert.deepEqual(calls, ['s-1', null]);
  } finally {
    await fixture.stop();
  }
});

test('二进制帧走 TCP 回环，界面事件走同一条 WS 的文本帧', { timeout: 15_000 }, async () => {
  const fixture = await startFixture();
  try {
    const first = await openClient(fixture);
    const second = await openClient(fixture);
    const bin1 = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x80]);
    const bin2 = Buffer.from([0x7f, 0x00, 0x10, 0x20, 0x30]);

    first.ws.send('ignore-me', { binary: false });
    const echoed = first.inbox.next();
    first.ws.send(bin1, { binary: true });
    const echo = await echoed;
    assert.equal(echo.isBinary, true);
    assert.deepEqual(echo.data, bin1);
    assert.equal(second.inbox.size, 0);
    assert.deepEqual(first.socket.bytes(), bin1);

    const event = { type: 'asr' as const, text: '你好', final: true };
    const text1 = first.inbox.next();
    const text2 = second.inbox.next();
    fixture.handle.broadcastUi(event);
    const left = await text1;
    const right = await text2;
    assert.equal(left.isBinary, false);
    assert.equal(right.isBinary, false);
    assert.equal(left.data.toString('utf8'), JSON.stringify(event));
    assert.deepEqual(JSON.parse(right.data.toString('utf8')), event);
    assert.deepEqual(first.socket.bytes(), bin1);
    assert.equal(second.socket.bytes().length, 0);

    const echoed2 = first.inbox.next();
    first.ws.send(bin2, { binary: true });
    const echo2 = await echoed2;
    assert.equal(echo2.isBinary, true);
    assert.deepEqual(echo2.data, bin2);
    assert.equal(second.inbox.size, 0);
    assert.deepEqual(first.socket.bytes(), Buffer.concat([bin1, bin2]));
    assert.equal(second.socket.bytes().length, 0);
  } finally {
    await fixture.stop();
  }
});

test('close 摘掉路由和 tap，并关掉 WS 与 TCP', { timeout: 15_000 }, async () => {
  const fixture = await startFixture();
  try {
    const client = await openClient(fixture);
    assert.equal(fixture.routeKeys().length > 0, true);
    assert.equal(
      fixture.applyTaps('<body></body>') !== '<body></body>',
      true,
    );

    const wsClosed = onceClose(client.ws);
    const tcpClosed = onceClose(client.socket.socket);
    await fixture.handle.close();
    await wsClosed;
    await tcpClosed;

    const widget = await httpCall(fixture.port, 'GET', WIDGET_SCRIPT_PATH);
    assert.equal(widget.status, 404);
    assert.equal(widget.body.toString('utf8'), 'no route');
    assert.equal(fixture.applyTaps('<body></body>'), '<body></body>');
    assert.deepEqual(fixture.routeKeys(), []);
    assert.deepEqual(fixture.upgradePaths(), []);

    const again = await rejectedUpgrade(fixture.port, {});
    assert.equal(again, 404);
    await fixture.handle.close();
  } finally {
    await fixture.stop({ closeHandle: false });
  }
});

test('voicePort 尚未就绪时 UI/精灵照常提供，WS 以 4503 礼貌回报原因', { timeout: 15_000 }, async () => {
  let activePort: number | null = null;
  let errorText: string | null = 'DASHSCOPE_API_KEY 未设置';
  const fixture = await startFixture({
    voicePort: () => activePort,
    getVoiceError: () => errorText,
  });
  try {
    const widget = await httpCall(fixture.port, 'GET', WIDGET_SCRIPT_PATH);
    assert.equal(widget.status, 200);
    const sprite = await httpCall(fixture.port, 'GET', `${ASSETS_PREFIX}/calm.webp`);
    assert.equal(sprite.status, 200);

    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}${WS_UPGRADE_PATH}`, {
        headers: { Origin: `http://127.0.0.1:${fixture.port}` },
      });
      ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
      ws.once('error', reject);
    });
    assert.equal(closed.code, 4503);
    assert.match(closed.reason, /DASHSCOPE_API_KEY/);

    activePort = fixture.tcpPort;
    errorText = null;
    const live = await openClient(fixture);
    const payload = Buffer.from([1, 2, 3, 4]);
    const echoed = live.inbox.next();
    live.ws.send(payload, { binary: true });
    const back = await echoed;
    assert.equal(back.isBinary, true);
    assert.deepEqual(back.data, payload);
  } finally {
    await fixture.stop();
  }
});

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

interface TrackedSocket {
  readonly socket: Socket;
  readonly chunks: Buffer[];
  bytes(): Buffer;
}

interface InboxMessage {
  readonly data: Buffer;
  readonly isBinary: boolean;
}

class Inbox {
  readonly #messages: InboxMessage[] = [];
  readonly #waiters: Array<(message: InboxMessage) => void> = [];

  get size(): number {
    return this.#messages.length;
  }

  push(data: Buffer, isBinary: boolean): void {
    const message = { data, isBinary };
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(message);
    else this.#messages.push(message);
  }

  next(): Promise<InboxMessage> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('等待 WS 消息超时'));
      }, 3000);
      this.#waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

interface Client {
  readonly ws: WebSocket;
  readonly inbox: Inbox;
  readonly socket: TrackedSocket;
}

interface Fixture {
  readonly port: number;
  readonly tcpPort: number;
  readonly widgetPath: string;
  readonly calmBytes: Buffer;
  readonly handle: HostMountHandle;
  readonly connections: readonly TrackedSocket[];
  routeKeys(): string[];
  upgradePaths(): readonly string[];
  applyTaps(html: string): string;
  stop(options?: { readonly closeHandle?: boolean }): Promise<void>;
}

async function startFixture(partial?: {
  readonly voicePort?: HostMountOptions['voicePort'];
  readonly getVoiceError?: HostMountOptions['getVoiceError'];
  readonly onSelectSession?: HostMountOptions['onSelectSession'];
  readonly onUpdateConfig?: HostMountOptions['onUpdateConfig'];
  readonly onFetchModels?: HostMountOptions['onFetchModels'];
  readonly getState?: HostMountOptions['getState'];
}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-host-'));
  const widgetPath = join(dir, 'widget.js');
  const assetsDir = join(dir, 'pet');
  const calmBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x01]);
  mkdirSync(assetsDir);
  writeFileSync(widgetPath, 'console.log("v1")\n');
  utimesSync(widgetPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  writeFileSync(join(dir, 'secret'), 'TOP-SECRET');
  writeFileSync(join(assetsDir, 'secret.webp'), 'LEAKED-SPRITE');
  writeFileSync(join(assetsDir, 'calm.webp'), calmBytes);
  writeFileSync(join(assetsDir, 'happy.png'), 'PNG-HAPPY');

  const httpServer = createHttpServer();
  const tcpServer = createTcpServer();
  const connections: TrackedSocket[] = [];
  tcpServer.on('connection', (socket) => {
    const tracked: TrackedSocket = {
      socket,
      chunks: [],
      bytes() {
        return Buffer.concat(this.chunks);
      },
    };
    connections.push(tracked);
    socket.on('data', (chunk: Buffer) => {
      tracked.chunks.push(Buffer.from(chunk));
      socket.write(chunk);
    });
    socket.on('error', () => {
      // 对端拆连接时会有 ECONNRESET。
    });
  });

  const host = createHostAdapter(httpServer);
  let httpPort = 0;
  let handle: HostMountHandle | undefined;
  let stopped = false;
  const stop = async (options?: { readonly closeHandle?: boolean }): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (options?.closeHandle !== false && handle !== undefined) {
      await handle.close();
    }
    await closeServer(httpServer);
    await closeServer(tcpServer);
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(stop);

  let tcpPort = 0;
  try {
    httpPort = await listen(httpServer);
    tcpPort = await listen(tcpServer);
    let bound: string | null = null;
    handle = mountVoiceHost({
      webServer: host.webServer,
      voicePort: partial?.voicePort ?? tcpPort,
      ...(partial?.getVoiceError === undefined ? {} : { getVoiceError: partial.getVoiceError }),
      widgetJsPath: widgetPath,
      assetsDir,
      security: new HostSecurityGuard({ warn() {} }),
      getState: partial?.getState ?? ((): HostPetState => ({
        ok: true,
        pipelineMode: 'cascade',
        boundSessionId: bound,
        sessions: [],
        wsPath: WS_UPGRADE_PATH,
        assetsPrefix: ASSETS_PREFIX,
      })),
      onSelectSession: partial?.onSelectSession ?? ((sessionId) => {
        bound = sessionId;
        return { sessionId };
      }),
      ...(partial?.onUpdateConfig === undefined ? {} : { onUpdateConfig: partial.onUpdateConfig }),
      ...(partial?.onFetchModels === undefined ? {} : { onFetchModels: partial.onFetchModels }),
      log() {},
    });
  } catch (error) {
    await stop();
    throw error;
  }

  const mounted = handle;
  if (mounted === undefined) {
    throw new Error('mount 没有返回句柄');
  }
  return {
    port: httpPort,
    tcpPort,
    widgetPath,
    calmBytes,
    handle: mounted,
    connections,
    routeKeys: () => host.routeKeys(),
    upgradePaths: () => host.upgradePaths(),
    applyTaps: (html) => host.applyTaps(html),
    stop,
  };
}

function createHostAdapter(server: HttpServer): {
  readonly webServer: HostWebServer;
  routeKeys(): string[];
  upgradePaths(): readonly string[];
  applyTaps(html: string): string;
} {
  const exact = new Map<string, HostWebRoute['handler']>();
  const prefixes: HostWebRoute[] = [];
  const upgrades = new Map<string, HostWebUpgradeRoute['handler']>();
  const taps: Array<(html: string) => string> = [];

  const onRequest = (req: IncomingMessage, res: import('node:http').ServerResponse): void => {
    const path = requestPath(req.url);
    const exactHandler = exact.get(path);
    const handler = exactHandler ?? matchPrefix(path, prefixes);
    if (handler === undefined) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(Buffer.byteLength('no route')),
      });
      res.end('no route');
      return;
    }
    try {
      const result = handler(req, res);
      void Promise.resolve(result).catch(() => {
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 500;
          res.end();
        }
      });
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const handler = upgrades.get(requestPath(req.url));
    if (handler === undefined) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 8\r\n\r\nno route');
      socket.destroy();
      return;
    }
    void Promise.resolve(handler(req, socket, head)).catch(() => {
      socket.destroy();
    });
  };

  server.on('request', onRequest);
  server.on('upgrade', onUpgrade);

  return {
    webServer: {
      register(route) {
        if (route.kind === 'exact') {
          exact.set(route.path, route.handler);
          return () => {
            if (exact.get(route.path) === route.handler) exact.delete(route.path);
          };
        }
        prefixes.push(route);
        return () => {
          const index = prefixes.indexOf(route);
          if (index !== -1) prefixes.splice(index, 1);
        };
      },
      registerUpgrade(route) {
        upgrades.set(route.path, route.handler);
        return () => {
          if (upgrades.get(route.path) === route.handler) upgrades.delete(route.path);
        };
      },
      tapIndex(transform) {
        taps.push(transform);
        return () => {
          const index = taps.indexOf(transform);
          if (index !== -1) taps.splice(index, 1);
        };
      },
    },
    routeKeys() {
      const keys = [...exact.keys()].map((path) => `exact ${path}`);
      for (const route of prefixes) keys.push(`prefix ${route.path}`);
      return keys;
    },
    upgradePaths() {
      return [...upgrades.keys()];
    },
    applyTaps(html) {
      let out = html;
      for (const tap of taps) out = tap(out);
      return out;
    },
  };
}

function matchPrefix(path: string, routes: readonly HostWebRoute[]): HostWebRoute['handler'] | undefined {
  let best: HostWebRoute | undefined;
  for (const route of routes) {
    if (path === route.path || path.startsWith(`${route.path}/`)) {
      if (best === undefined || route.path.length > best.path.length) best = route;
    }
  }
  return best?.handler;
}

function requestPath(url: string | undefined): string {
  const raw = url ?? '/';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

function httpCall(
  port: number,
  method: string,
  path: string,
  options?: { readonly headers?: Record<string, string>; readonly body?: string | Buffer },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: options?.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.setTimeout(3000, () => {
      req.destroy(new Error(`HTTP 超时 ${method} ${path}`));
    });
    req.on('error', reject);
    if (options?.body !== undefined) req.end(options.body);
    else req.end();
  });
}

function rawRequest(port: number, head: string): Promise<{ readonly status: number; readonly raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(head);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('原始 HTTP 超时'));
    }, 3000);
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1] ?? '0');
      resolve({ status, raw });
    });
  });
}

function rejectedUpgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('升级超时'));
    }, 3000);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_UPGRADE_PATH}`, { headers });
    ws.on('error', () => {
      // unexpected-response 之后库还会再打一次 error。
    });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error('升级不该成功'));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      res.resume();
      resolve(status);
    });
  });
}

async function openClient(fixture: Fixture): Promise<Client> {
  const index = fixture.connections.length;
  const inbox = new Inbox();
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}${WS_UPGRADE_PATH}`);
  ws.on('error', () => {
    // 成功路径上不该出错；出错会让 open 的 Promise 拒绝。
  });
  ws.on('message', (data: RawData, isBinary: boolean) => {
    inbox.push(rawToBuffer(data), isBinary);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('WS 打开超时'));
    }, 3000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const deadline = Date.now() + 3000;
  while (fixture.connections.length <= index) {
    if (Date.now() > deadline) throw new Error('语音栈 TCP 没有连上');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  const socket = fixture.connections[index];
  if (socket === undefined) throw new Error('缺少 TCP 连接');
  return { ws, inbox, socket };
}

function onceClose(emitter: { once(event: 'close', listener: () => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('等待关闭超时'));
    }, 3000);
    emitter.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function listen(server: HttpServer | TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error); };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('没有分到端口'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: HttpServer | TcpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const force = server as { closeAllConnections?: () => void };
    if (typeof force.closeAllConnections === 'function') force.closeAllConnections();
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
