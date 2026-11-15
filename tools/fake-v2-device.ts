/**
 * 假 **v2** 设备：验证「主动拍照（CaptureImage）」与「电量上报」两条链路。
 *
 * 和 `fake-phone.ts` 的区别：那个是 v1（只有 Audio/Image/Status 那几个老帧），
 * 这里说的是 v2 —— `Hello` 自报 `proto:2`，上行用 `Event`(7) 与 `CaptureImage`(8)。
 *
 * 用法：
 *   node tools/fake-v2-device.ts --host <服务器地址> --port 63993 --tls \
 *     --token <hex> --device pet-test [--percent 15] [--capture-wait 30000]
 *
 * 它做的事：
 *   1. 发 `Hello`（capabilities 里 `capture.glance` 与 `power` 都为真）
 *   2. 收到 `Welcome` 后发 `presence:true`、`power:<percent>`
 *   3. 收到 `Call{op:'capture'}` 就回 `CaptureImage`（**原样回 id**）
 *   4. 全程把收到的每一帧打出来，退出码 0 = 收到了 capture 请求并能回图
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const HEADER = 5;
const UP = { Audio: 1, Image: 2, Wake: 3, Ping: 4, Status: 5, Hello: 6, Event: 7, CaptureImage: 8 } as const;
const DOWN = { Audio: 1, Control: 2, Call: 3, Welcome: 4, Pong: 5 } as const;

function opt(argv: string[], flag: string, def: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? def) : def;
}

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** `[idLen:u8][id:UTF-8][JPEG]` —— 与云端 `parseV2CaptureImage` 对齐 */
function captureImageFrame(id: string, jpeg: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'utf8');
  const payload = Buffer.concat([Buffer.from([idBytes.length]), idBytes, jpeg]);
  return frame(UP.CaptureImage, payload);
}

const argv = process.argv.slice(2);
const host = opt(argv, '--host', '127.0.0.1');
const port = Number(opt(argv, '--port', '63993'));
const token = opt(argv, '--token', '');
const device = opt(argv, '--device', 'pet-test');
const percent = Number(opt(argv, '--percent', '15'));
const captureWaitMs = Number(opt(argv, '--capture-wait', '30000'));
const useTls = argv.includes('--tls');

/** 一小段合法 JPEG 头 + 填充（内容不重要，云端只存字节） */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(2048, 0x11)]);

const capabilities = {
  audioIn: 'msbc',
  capture: { glance: { needsUser: false } },
  presence: true,
  power: true,
  summon: false,
  listenStart: true,
  played: false,
  ignorePhrases: [],
};

let welcomed = false;
let capturedId: string | null = null;
let sentImage = false;
let buffer = Buffer.alloc(0);

const sock: Socket = useTls
  ? tlsConnect({ host, port, rejectUnauthorized: false }, onConnect)
  : netConnect({ host, port }, onConnect);

function onConnect(): void {
  console.log(`已连接 ${useTls ? 'tls' : 'tcp'}://${host}:${port}`);
  const hello = JSON.stringify({ proto: 2, deviceId: device, ...(token === '' ? {} : { token }), capabilities });
  sock.write(frame(UP.Hello, Buffer.from(hello, 'utf8')));
  console.log('已发送 Hello（capture.glance + power 均为真）');
}

sock.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= HEADER) {
    const type = buffer.readUInt8(0);
    const len = buffer.readUInt32LE(1);
    if (buffer.length < HEADER + len) break;
    const payload = buffer.subarray(HEADER, HEADER + len);
    buffer = buffer.subarray(HEADER + len);
    onFrame(type, payload);
  }
});

sock.on('error', (e: Error) => {
  console.error(`连接出错：${e.message}`);
  process.exit(1);
});

function onFrame(type: number, payload: Buffer): void {
  if (type === DOWN.Welcome) {
    welcomed = true;
    console.log(`← Welcome ${payload.toString('utf8')}`);
    // 佩戴 + 电量：电量给个低值，用来验证宠物「低电量不主动开口」那条闸门
    sock.write(frame(UP.Event, Buffer.from(JSON.stringify({ kind: 'presence', wearing: true }), 'utf8')));
    sock.write(frame(UP.Event, Buffer.from(
      JSON.stringify({ kind: 'power', percent, charging: false }), 'utf8',
    )));
    console.log(`→ presence:true  power:${percent}%（不充电）`);
    return;
  }
  if (type === DOWN.Call) {
    let call: Record<string, unknown>;
    try {
      call = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    } catch {
      console.log(`← Call（解析失败）${payload.toString('utf8').slice(0, 80)}`);
      return;
    }
    console.log(`← Call ${JSON.stringify(call)}`);
    if (call['op'] === 'capture') {
      const id = typeof call['id'] === 'string' ? call['id'] : '';
      if (id === '') {
        console.log('✗ capture 没带 id —— 回不了图');
        return;
      }
      capturedId = id;
      // 模拟拍照耗时 400 ms
      setTimeout(() => {
        sock.write(captureImageFrame(id, JPEG));
        sentImage = true;
        console.log(`→ CaptureImage id=${id}  ${JPEG.length} 字节`);
      }, 400);
    }
    return;
  }
  if (type === DOWN.Audio) return; // 下行音频帧很多，不打印
  if (type === DOWN.Control) {
    // 控制串是 UTF-8 文本：`stop` / `end_session` / `auth_required` / `take_photo` …
    console.log(`← Control ${JSON.stringify(payload.toString('utf8'))}`);
    return;
  }
  console.log(`← 帧 type=${type}（${payload.length} B）`);
}

setTimeout(() => {
  console.log('\n=== 小结 ===');
  console.log(`Welcome      ${welcomed ? '收到' : '未收到'}`);
  console.log(`capture 请求 ${capturedId === null ? '未收到' : capturedId}`);
  console.log(`回图         ${sentImage ? '已发' : '未发'}`);
  try { sock.destroy(); } catch { /* 已断 */ }
  process.exit(welcomed && sentImage ? 0 : 2);
}, captureWaitMs);
