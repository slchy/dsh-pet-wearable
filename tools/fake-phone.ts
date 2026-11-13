/**
 * 假手机：最小客户端，用来验证云端链路而不碰真机。
 *
 * 它同时是**协议的最小实现**（将来开源时给客户端作者当参照）：
 *   [type:u8][len:u32 LE][payload]
 *   Hello(6) -> Ping(4)/Pong(5) -> Audio(1) / Image(2) / Wake(3)
 *
 * 用法：
 *   node tools/fake-phone.ts --port 8766 --sbc ../../tmp/voice_1793904904745.sbc \
 *     [--token <hex>] [--host 127.0.0.1] [--frames 400] [--tls [--ca cert.pem]]
 *
 * `--tls` 不给 `--ca` 时跳过证书校验（本地自签图省事）；给了 `--ca` 就严格校验 ——
 * 这也是「自签 CA 打进客户端 = 天然 pinning」在测试里的样子。
 *
 * 退出码 0 表示：连上、发完、收到了下行 Audio（或至少 Pong/Control）。
 */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const FRAME_HEADER_BYTES = 5;
const UP = { Audio: 1, Image: 2, Wake: 3, Ping: 4, Hello: 6 } as const;
const DOWN = { Audio: 1, Control: 2, Pong: 5 } as const;

function opt(argv: string[], flag: string, def: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? def) : def;
}

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const argv = process.argv.slice(2);
const host = opt(argv, '--host', '127.0.0.1');
const port = Number(opt(argv, '--port', '8766'));
const sbcPath = opt(argv, '--sbc', '');
const token = opt(argv, '--token', '');
const frameLimit = Number(opt(argv, '--frames', '400'));
const useTls = argv.includes('--tls');
const caPath = opt(argv, '--ca', '');

let gotAudio = 0;
const gotControl: string[] = [];
let gotPong = false;
let buffered = Buffer.alloc(0);

function onData(chunk: Buffer): void {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= FRAME_HEADER_BYTES) {
    const type = buffered.readUInt8(0);
    const len = buffered.readUInt32LE(1);
    if (buffered.length < FRAME_HEADER_BYTES + len) {
      return;
    }
    const payload = buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len);
    buffered = buffered.subarray(FRAME_HEADER_BYTES + len);
    if (type === DOWN.Audio) {
      gotAudio += 1;
    } else if (type === DOWN.Control) {
      gotControl.push(payload.toString('utf8'));
    } else if (type === DOWN.Pong) {
      gotPong = true;
    }
  }
}

async function onReady(): Promise<void> {
  console.log(`✓ 已连接 ${useTls ? 'tls' : 'tcp'}://${host}:${port}`);

  if (token) {
    const hello = Buffer.from(JSON.stringify({ proto: 1, deviceId: 'fake-phone', token }), 'utf8');
    socket.write(frame(UP.Hello, hello));
    console.log('→ Hello');
  }

  socket.write(frame(UP.Ping, Buffer.alloc(0)));
  socket.write(frame(UP.Wake, Buffer.from('fake-transaction\nfake-request', 'utf8')));

  if (sbcPath !== '') {
    const sbc = readFileSync(sbcPath);
    const CHUNK = 570; // 10 × 57 B mSBC
    let sent = 0;
    for (let off = 0; off < sbc.length && sent < frameLimit; off += CHUNK) {
      socket.write(frame(UP.Audio, sbc.subarray(off, off + CHUNK)));
      sent += 1;
      await new Promise((r) => setTimeout(r, 20));
    }
    console.log(`→ Audio ×${sent}（${sbc.length} B mSBC）`);
  }

  // 再等一会儿，让一轮跑完（TTS 是流式下发的）
  setTimeout(() => {
    console.log(`← Audio ×${gotAudio}  Control=[${gotControl.join(', ')}]  Pong=${gotPong}`);
    socket.end();
    const ok = gotAudio > 0 || gotPong || gotControl.length > 0;
    process.exit(ok ? 0 : 1);
  }, 6000);
}

const socket: Socket = useTls
  ? tlsConnect(
    {
      host,
      port,
      rejectUnauthorized: caPath !== '',
      servername: undefined, // 连的是 IP：证书里写 SAN=IP，别拿 IP 当域名比对
      ...(caPath !== '' ? { ca: readFileSync(caPath) } : {}),
    },
    () => { void onReady(); },
  ) as unknown as Socket
  : connect(port, host, () => { void onReady(); });

socket.on('data', onData);
socket.on('error', (e: Error) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
